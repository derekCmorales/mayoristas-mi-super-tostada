import { describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  auditLog,
  domainEvents,
  factura,
  facturaAjuste,
  pedido,
  pedidoItem,
  usuario,
} from "@misupertostada/db";
import {
  TIPO_EVENTO_FACTURA_AJUSTADA,
  ZONA_NEGOCIO,
  permisosPlantilla,
  type Clock,
  type RecalcularPreciosResultado,
} from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { DomainEventWriter } from "../shared/domain-event.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { PedidoEvents } from "../shared/panel-events";
import { crearOrgDePrueba, openTestDb, postgresListo } from "../../test/db";
import type { Actor } from "../identity/actor";
import { ProductosService } from "../catalog/productos.service";
import { ClientesService } from "../catalog/clientes.service";
import { ClienteProductoService } from "../catalog/cliente-producto.service";
import { CierreService } from "../fulfillment/cierre.service";
import { HojaService } from "../fulfillment/hoja.service";
import { EntregaService } from "../fulfillment/entrega.service";
import { FacturaService } from "../receivables/factura.service";
import { AbonoService } from "../receivables/abono.service";
import { PagoService } from "../receivables/pago.service";
import { PedidoService } from "./pedido.service";
import { PedidoPreciosService } from "./pedido-precios.service";
import { DomainException } from "../shared/domain.exception";
import type { FacturaAjuste } from "../receivables/factura-ajuste";

const listo = await postgresListo();

/** Lo que el panel manda al aplicar: los pedidos que el usuario vio. */
function esperadoDe(previa: RecalcularPreciosResultado) {
  return previa.pedidos
    .filter((p) => !p.omitido)
    .map((p) => ({
      pedidoId: p.pedidoId,
      totalDespuesCentavos: p.totalDespuesCentavos,
    }));
}

function instanteGT(isoLocal: string): Date {
  const dt = DateTime.fromISO(isoLocal, { zone: ZONA_NEGOCIO });
  if (!dt.isValid) throw new Error(`instante inválido: ${isoLocal}`);
  return dt.toJSDate();
}

async function fixture() {
  const clock: Clock = { now: () => instanteGT("2026-08-20T22:00:00") };
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const outboxWriter = new OutboxWriter(db);
  const domainEventsWriter = new DomainEventWriter(db);
  const calendar = new BusinessCalendarService(db, clock);
  const events = new PedidoEvents();
  const productos = new ProductosService(db, audit, events);
  const clientes = new ClientesService(db, audit);
  const ligas = new ClienteProductoService(db, audit, clientes, events);
  const pedidos = new PedidoService(db, audit, outboxWriter, calendar, events);
  const cierre = new CierreService(
    db,
    audit,
    outboxWriter,
    domainEventsWriter,
    calendar,
    new HojaService(db, calendar),
    events,
  );
  const facturas = new FacturaService(
    db,
    audit,
    outboxWriter,
    calendar,
    events,
    domainEventsWriter,
  );
  const entregas = new EntregaService(
    db,
    audit,
    domainEventsWriter,
    calendar,
    events,
    facturas,
  );
  const pagos = new PagoService(
    new AbonoService(db, audit, calendar, events, facturas),
  );
  const precios = new PedidoPreciosService(db, audit, calendar, events, facturas);

  const org = await crearOrgDePrueba(db, "org-precios-");

  async function alta(rol: Actor["rol"]): Promise<Actor> {
    const [row] = await db
      .insert(usuario)
      .values({
        organizacionId: org!.id,
        username: `${rol.toLowerCase()}-${crypto.randomUUID().slice(0, 8)}`,
        rol,
        activo: true,
      })
      .returning();
    return {
      usuarioId: row!.id,
      organizacionId: org!.id,
      username: row!.username,
      rol,
      permisos: permisosPlantilla(rol),
      sesionId: crypto.randomUUID(),
      ip: "127.0.0.1",
      userAgent: "test-precios",
    };
  }

  const jefe = await alta("ADMIN_JEFE");
  const tienda = await alta("TIENDA");
  const reparto = await alta("REPARTO");

  async function producto(precioBaseCentavos: number | null) {
    const prod = await productos.crear(
      {
        sku: `T-${crypto.randomUUID().slice(0, 6)}`,
        nombreCanonico: "Tortillas #16",
        familia: "TORTILLA",
        unidadMedida: "LIBRA",
        puntoCarga: "DEMOCRACIA",
      },
      jefe,
    );
    if (precioBaseCentavos !== null) {
      await productos.editar(prod.id, { precioBaseCentavos }, jefe);
    }
    return prod;
  }

  async function restaurante() {
    return clientes.crear(
      { nombre: `Rest ${crypto.randomUUID().slice(0, 6)}` },
      jefe,
    );
  }

  async function precioDeLinea(pedidoId: string, productoId: string) {
    const [row] = await db
      .select()
      .from(pedidoItem)
      .where(
        and(
          eq(pedidoItem.pedidoId, pedidoId),
          eq(pedidoItem.productoId, productoId),
        ),
      );
    return row?.precioUnitarioCentavos;
  }

  /** Igual al real, salvo que el ajuste de `pedidoId` choca con un abono. */
  function preciosConAbonoEnCarrera(pedidoId: string) {
    const conCarrera: FacturaAjuste = {
      vistaDePedido: (tx, id) => facturas.vistaDePedido(tx, id),
      ajustarEnTx: (tx, input) => {
        if (input.pedidoId === pedidoId) {
          throw new DomainException("AJUSTE_BAJO_ABONADO", "abono en carrera", 409);
        }
        return facturas.ajustarEnTx(tx, input);
      },
    };
    return new PedidoPreciosService(db, audit, calendar, events, conCarrera);
  }

  return {
    client,
    db,
    preciosConAbonoEnCarrera,
    jefe,
    tienda,
    reparto,
    productos,
    ligas,
    pedidos,
    cierre,
    entregas,
    pagos,
    facturas,
    precios,
    producto,
    restaurante,
    precioDeLinea,
  };
}

describe.skipIf(!listo)("corrección de precios de pedidos", () => {
  test("el incidente de octubre: catálogo reseteado, pedidos tomados, se recalcula el día con el precio bueno", async () => {
    const f = await fixture();
    try {
      // El deploy dejó el catálogo en Q12.50; el precio real es Q15.00.
      const prod = await f.producto(1250);
      const entregado = await f.restaurante();
      const pendiente = await f.restaurante();
      const pA = await f.pedidos.crearManual(
        { clienteId: entregado.id, items: [{ productoId: prod.id, cantidad: 50 }] },
        f.jefe,
      );
      const pB = await f.pedidos.crearManual(
        { clienteId: pendiente.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.jefe,
      );
      await f.cierre.cerrar({ fechaOperacion: pA.fechaOperacion }, f.jefe);
      const ea = await f.entregas.entregar(
        { idempotencyKey: crypto.randomUUID(), pedidoId: pA.id },
        f.reparto,
      );
      expect(ea.factura.montoCentavos).toBe(62500);
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `abono-${crypto.randomUUID()}`,
          clienteId: entregado.id,
          montoCentavos: 10000,
          metodo: "EFECTIVO",
        },
        f.reparto,
      );
      await f.facturas.capturarDte(
        ea.factura.id,
        { numeroDte: `DTE-${crypto.randomUUID().slice(0, 8)}` },
        f.jefe,
      );

      // Cristian corrige el catálogo. Por sí solo no toca los pedidos (§2.2).
      await f.productos.editar(prod.id, { precioBaseCentavos: 1500 }, f.jefe);
      expect(await f.precioDeLinea(pA.id, prod.id)).toBe(1250);
      const detalle = await f.pedidos.obtener(pB.id, f.jefe);
      expect(detalle.items[0]?.precioUnitarioCentavos).toBe(1250);
      expect(detalle.items[0]?.precioCatalogoCentavos).toBe(1500);

      const motivo = "Deploy regresó los precios de fábrica";
      const previa = await f.precios.recalcular(
        { fechaOperacion: pA.fechaOperacion },
        f.jefe,
      );
      expect(previa.aplicado).toBe(false);
      expect(previa.pedidos).toHaveLength(2);
      const vistaA = previa.pedidos.find((p) => p.pedidoId === pA.id)!;
      expect(vistaA.totalAntesCentavos).toBe(62500);
      expect(vistaA.totalDespuesCentavos).toBe(75000);
      expect(vistaA.ajustaFactura).toBe(true);
      expect(vistaA.numeroDte).toMatch(/^DTE-/);
      const vistaB = previa.pedidos.find((p) => p.pedidoId === pB.id)!;
      expect(vistaB.ajustaFactura).toBe(false);
      expect(vistaB.totalDespuesCentavos).toBe(15000);
      // La vista previa no escribe.
      expect(await f.precioDeLinea(pB.id, prod.id)).toBe(1250);

      const r = await f.precios.recalcular(
        {
          fechaOperacion: pA.fechaOperacion,
          motivo,
          aplicar: true,
          esperado: esperadoDe(previa),
        },
        f.jefe,
      );
      expect(r.aplicado).toBe(true);
      expect(await f.precioDeLinea(pA.id, prod.id)).toBe(1500);
      expect(await f.precioDeLinea(pB.id, prod.id)).toBe(1500);

      const [fac] = await f.db
        .select()
        .from(factura)
        .where(eq(factura.id, ea.factura.id));
      expect(fac?.montoCentavos).toBe(75000);
      const ajustes = await f.db
        .select()
        .from(facturaAjuste)
        .where(eq(facturaAjuste.facturaId, ea.factura.id));
      expect(ajustes).toHaveLength(1);
      expect(ajustes[0]).toMatchObject({
        montoAnteriorCentavos: 62500,
        montoNuevoCentavos: 75000,
        motivo,
        registradoPor: f.jefe.usuarioId,
      });
      const facturaTrasAjuste = await f.facturas.presentar(ea.factura.id);
      expect(facturaTrasAjuste.saldoCentavos).toBe(65000);

      const eventos = await f.db
        .select()
        .from(domainEvents)
        .where(eq(domainEvents.tipo, TIPO_EVENTO_FACTURA_AJUSTADA));
      expect(
        eventos.some(
          (e) => (e.payload as { facturaId?: string }).facturaId === ea.factura.id,
        ),
      ).toBe(true);
      const logs = await f.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entidadId, pB.id),
            eq(auditLog.accion, "pedidos.ajustar_precios"),
          ),
        );
      expect(logs).toHaveLength(1);
      expect(logs[0]?.actorId).toBe(f.jefe.usuarioId);
      expect(logs[0]?.despues).toMatchObject({ motivo, origen: "CATALOGO" });

      // El pedido que faltaba entregar ya factura con el precio bueno.
      const eb = await f.entregas.entregar(
        { idempotencyKey: crypto.randomUUID(), pedidoId: pB.id },
        f.reparto,
      );
      expect(eb.factura.montoCentavos).toBe(15000);

      // Repetirlo no hace nada: ya cuadra con el catálogo.
      const otraVez = await f.precios.recalcular(
        { fechaOperacion: pA.fechaOperacion, motivo, aplicar: true, esperado: [] },
        f.jefe,
      );
      expect(otraVez.pedidos).toHaveLength(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("un abono que entra a media corrida deja ese pedido intacto y aplica los demás", async () => {
    const f = await fixture();
    try {
      const prod = await f.producto(1000);
      const a = await f.restaurante();
      const b = await f.restaurante();
      const pA = await f.pedidos.crearManual(
        { clienteId: a.id, items: [{ productoId: prod.id, cantidad: 3 }] },
        f.jefe,
      );
      const pB = await f.pedidos.crearManual(
        { clienteId: b.id, items: [{ productoId: prod.id, cantidad: 4 }] },
        f.jefe,
      );
      await f.cierre.cerrar({ fechaOperacion: pA.fechaOperacion }, f.jefe);
      for (const p of [pA, pB]) {
        await f.entregas.entregar(
          { idempotencyKey: crypto.randomUUID(), pedidoId: p.id },
          f.reparto,
        );
      }
      await f.productos.editar(prod.id, { precioBaseCentavos: 1100 }, f.jefe);

      const servicio = f.preciosConAbonoEnCarrera(pA.id);
      const previa = await servicio.recalcular(
        { fechaOperacion: pA.fechaOperacion },
        f.jefe,
      );
      expect(previa.pedidos).toHaveLength(2);
      const r = await servicio.recalcular(
        {
          fechaOperacion: pA.fechaOperacion,
          motivo: "lista",
          aplicar: true,
          esperado: esperadoDe(previa),
        },
        f.jefe,
      );
      expect(r.pedidos.find((p) => p.pedidoId === pA.id)?.omitido).toBeTruthy();
      expect(r.pedidos.find((p) => p.pedidoId === pB.id)?.omitido).toBeNull();
      // El savepoint deshizo también la línea de A, no solo su factura.
      expect(await f.precioDeLinea(pA.id, prod.id)).toBe(1000);
      expect(await f.precioDeLinea(pB.id, prod.id)).toBe(1100);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("una edición de cantidades que corre junto a una corrección no la pisa", async () => {
    const f = await fixture();
    try {
      const prod = await f.producto(1250);
      const cli = await f.restaurante();
      const p = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 5 }] },
        f.jefe,
      );

      // Conexiones propias: el pool de tests es de una sola, y con él las dos
      // transacciones nunca correrían a la vez.
      const otra = openTestDb();
      const sondeo = openTestDb();
      // Una corrección en curso: tiene el pedido bloqueado y ya cambió el precio.
      let soltar!: () => void;
      const suelta = new Promise<void>((r) => {
        soltar = r;
      });
      let bloqueado!: () => void;
      const yaBloqueo = new Promise<void>((r) => {
        bloqueado = r;
      });
      const correccion = otra.db.transaction(async (tx) => {
        await tx.select().from(pedido).where(eq(pedido.id, p.id)).for("update");
        await tx
          .update(pedidoItem)
          .set({ precioUnitarioCentavos: 1500 })
          .where(eq(pedidoItem.pedidoId, p.id));
        bloqueado();
        await suelta;
      });
      await yaBloqueo;

      const edicion = f.pedidos.editarItems(
        p.id,
        { items: [{ productoId: prod.id, cantidad: 6 }] },
        f.tienda,
      );
      // Suelta solo cuando la edición ya está esperando un lock: así leyó (o
      // intentó leer) las líneas mientras la corrección seguía abierta.
      for (let i = 0; i < 100; i++) {
        const [fila] = await sondeo.db.execute<{ n: number }>(sql`
          select count(*)::int as n from pg_stat_activity
          where datname = current_database()
            and wait_event_type = 'Lock'
            and (query ilike '%pedido_item%' or query ilike '%"pedido"%')
        `);
        if (Number(fila?.n ?? 0) > 0) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      soltar();
      await correccion;
      const editado = await edicion;

      await otra.client.end({ timeout: 1 });
      await sondeo.client.end({ timeout: 1 });

      expect(editado.items[0]).toMatchObject({
        cantidad: 6,
        precioUnitarioCentavos: 1500,
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("no baja una factura por debajo de lo ya abonado", async () => {
    const f = await fixture();
    try {
      const prod = await f.producto(1500);
      const cli = await f.restaurante();
      const p = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.jefe,
      );
      await f.cierre.cerrar({ fechaOperacion: p.fechaOperacion }, f.jefe);
      const e = await f.entregas.entregar(
        { idempotencyKey: crypto.randomUUID(), pedidoId: p.id },
        f.reparto,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `abono-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 15000,
          metodo: "EFECTIVO",
        },
        f.reparto,
      );

      await f.productos.editar(prod.id, { precioBaseCentavos: 1000 }, f.jefe);
      const previa = await f.precios.recalcular(
        { fechaOperacion: p.fechaOperacion, motivo: "baja" },
        f.jefe,
      );
      expect(previa.pedidos[0]?.omitido).toBeTruthy();

      await expect(
        f.precios.ajustar(
          p.id,
          {
            motivo: "baja",
            items: [{ productoId: prod.id, precioUnitarioCentavos: 1000 }],
          },
          f.jefe,
        ),
      ).rejects.toMatchObject({ code: "AJUSTE_BAJO_ABONADO", httpStatus: 409 });

      const aplicado = await f.precios.recalcular(
        {
          fechaOperacion: p.fechaOperacion,
          motivo: "baja",
          aplicar: true,
          esperado: esperadoDe(previa),
        },
        f.jefe,
      );
      expect(aplicado.pedidos[0]?.omitido).toBeTruthy();
      expect(await f.precioDeLinea(p.id, prod.id)).toBe(1500);
      const [fac] = await f.db
        .select()
        .from(factura)
        .where(eq(factura.id, e.factura.id));
      expect(fac?.montoCentavos).toBe(15000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ajustar un pedido a mano exige precios.cambiar y no toca devoluciones ni cantidades", async () => {
    const f = await fixture();
    try {
      const prod = await f.producto(1250);
      const cli = await f.restaurante();
      const p = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 8 }] },
        f.jefe,
      );
      const body = {
        motivo: "precio acordado",
        items: [{ productoId: prod.id, precioUnitarioCentavos: 1100 }],
      };
      await expect(f.precios.ajustar(p.id, body, f.tienda)).rejects.toMatchObject({
        code: "PERMISO_DENEGADO",
        httpStatus: 403,
      });
      await expect(
        f.precios.recalcular(
          { fechaOperacion: p.fechaOperacion, motivo: "x" },
          f.tienda,
        ),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO" });
      await expect(
        f.precios.recalcular(
          { fechaOperacion: p.fechaOperacion, aplicar: true },
          f.jefe,
        ),
      ).rejects.toMatchObject({ httpStatus: 400 });

      const otro = await f.producto(900);
      await expect(
        f.precios.ajustar(
          p.id,
          {
            motivo: "x",
            items: [{ productoId: otro.id, precioUnitarioCentavos: 1 }],
          },
          f.jefe,
        ),
      ).rejects.toMatchObject({ code: "VALIDACION" });

      const d = await f.precios.ajustar(p.id, body, f.jefe);
      expect(d.items[0]?.precioUnitarioCentavos).toBe(1100);
      expect(d.items[0]?.cantidad).toBe(8);
      expect(d.totalCentavos).toBe(8800);
      expect(d.historial[0]?.accion).toBe("pedidos.ajustar_precios");

      // Un precio negociado a mano no es un snapshot mal nacido: el
      // recálculo del día lo respeta y lo reporta.
      const previa = await f.precios.recalcular(
        { fechaOperacion: p.fechaOperacion },
        f.jefe,
      );
      expect(previa.pedidos).toHaveLength(0);
      expect(await f.precioDeLinea(p.id, prod.id)).toBe(1100);

      // Si el catálogo además cambia, la línea a mano sigue intacta y se cuenta.
      const otraLinea = await f.producto(500);
      const conDos = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [
            { productoId: prod.id, cantidad: 1, precioUnitarioCentavos: 1000 },
            { productoId: otraLinea.id, cantidad: 2 },
          ],
        },
        f.jefe,
      );
      await f.productos.editar(otraLinea.id, { precioBaseCentavos: 600 }, f.jefe);
      const previa2 = await f.precios.recalcular(
        { fechaOperacion: p.fechaOperacion },
        f.jefe,
      );
      const vista = previa2.pedidos.find((x) => x.pedidoId === conDos.id)!;
      expect(vista.cambios.map((c) => c.productoId)).toEqual([otraLinea.id]);
      expect(vista.lineasManuales).toBe(1);

      // Aplicar con una vista previa vieja no escribe nada.
      await expect(
        f.precios.recalcular(
          {
            fechaOperacion: p.fechaOperacion,
            motivo: "x",
            aplicar: true,
            esperado: [{ pedidoId: conDos.id, totalDespuesCentavos: 1 }],
          },
          f.jefe,
        ),
      ).rejects.toMatchObject({ code: "VISTA_PREVIA_VENCIDA", httpStatus: 409 });
      expect(await f.precioDeLinea(conDos.id, otraLinea.id)).toBe(500);

      await f.precios.recalcular(
        {
          fechaOperacion: p.fechaOperacion,
          motivo: "lista nueva",
          aplicar: true,
          esperado: esperadoDe(previa2),
        },
        f.jefe,
      );
      expect(await f.precioDeLinea(conDos.id, otraLinea.id)).toBe(600);
      expect(await f.precioDeLinea(conDos.id, prod.id)).toBe(1000);

      // Corregir a mano AL precio de catálogo lo vuelve recalculable.
      await f.precios.ajustar(
        p.id,
        {
          motivo: "regresa a lista",
          items: [{ productoId: prod.id, precioUnitarioCentavos: 1250 }],
        },
        f.jefe,
      );
      await f.productos.editar(prod.id, { precioBaseCentavos: 1300 }, f.jefe);
      const previa3 = await f.precios.recalcular(
        { fechaOperacion: p.fechaOperacion },
        f.jefe,
      );
      expect(previa3.pedidos.map((x) => x.pedidoId)).toContain(p.id);
      expect(previa3.pedidos.map((x) => x.pedidoId)).not.toContain(conDos.id);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("captura manual con precio a mano: vale para ese pedido, no toca el catálogo, exige permiso si cambia", async () => {
    const f = await fixture();
    try {
      const prod = await f.producto(1250);
      const sinPrecio = await f.producto(null);
      const cli = await f.restaurante();

      // Carla captura pero no cambia precios.
      await expect(
        f.pedidos.crearManual(
          {
            clienteId: cli.id,
            items: [{ productoId: prod.id, cantidad: 5, precioUnitarioCentavos: 1300 }],
          },
          f.tienda,
        ),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO", httpStatus: 403 });
      // Mandar el mismo precio del catálogo no cuenta como cambio.
      const deCarla = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [{ productoId: prod.id, cantidad: 5, precioUnitarioCentavos: 1250 }],
        },
        f.tienda,
      );
      expect(deCarla.items[0]?.precioUnitarioCentavos).toBe(1250);

      const p = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [
            { productoId: prod.id, cantidad: 5, precioUnitarioCentavos: 1300 },
            { productoId: sinPrecio.id, cantidad: 2, precioUnitarioCentavos: 800 },
          ],
        },
        f.jefe,
      );
      const linea = (id: string) => p.items.find((i) => i.productoId === id);
      expect(linea(prod.id)?.precioUnitarioCentavos).toBe(1300);
      expect(linea(prod.id)?.precioCatalogoCentavos).toBe(1250);
      expect(linea(sinPrecio.id)?.precioUnitarioCentavos).toBe(800);
      expect(p.totalCentavos).toBe(5 * 1300 + 2 * 800);
      const captura = p.historial.find((h) => h.accion === "pedidos.capturar");
      expect(JSON.stringify(captura?.despues)).toContain('"porDefectoCentavos":1250');

      // El catálogo del cliente sigue igual: el siguiente pedido toma Q12.50.
      const siguiente = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 1 }] },
        f.jefe,
      );
      expect(siguiente.items[0]?.precioUnitarioCentavos).toBe(1250);

      // Editar cantidades reenviando el snapshot no exige permiso ni lo pisa.
      const editado = await f.pedidos.editarItems(
        p.id,
        {
          items: [
            { productoId: prod.id, cantidad: 7, precioUnitarioCentavos: 1300 },
            { productoId: sinPrecio.id, cantidad: 2, precioUnitarioCentavos: 800 },
          ],
        },
        f.tienda,
      );
      expect(editado.items.find((i) => i.productoId === prod.id)).toMatchObject({
        cantidad: 7,
        precioUnitarioCentavos: 1300,
      });
      // Sin precio en el body, la línea existente conserva su snapshot.
      const sinBody = await f.pedidos.editarItems(
        p.id,
        { items: [{ productoId: prod.id, cantidad: 7 }] },
        f.tienda,
      );
      expect(sinBody.items[0]?.precioUnitarioCentavos).toBe(1300);
      // Cambiar el precio de una línea ya capturada no va por aquí, ni
      // siquiera para el jefe: es «Corregir precios», con motivo.
      for (const actor of [f.tienda, f.jefe]) {
        await expect(
          f.pedidos.editarItems(
            p.id,
            { items: [{ productoId: prod.id, cantidad: 7, precioUnitarioCentavos: 1400 }] },
            actor,
          ),
        ).rejects.toMatchObject({ code: "PRECIO_LINEA_CAPTURADA", httpStatus: 409 });
      }
      expect(await f.precioDeLinea(p.id, prod.id)).toBe(1300);

      // Una corrección de precio sobrevive a la siguiente edición de cantidades.
      await f.precios.ajustar(
        p.id,
        {
          motivo: "acordado",
          items: [{ productoId: prod.id, precioUnitarioCentavos: 1350 }],
        },
        f.jefe,
      );
      const trasEditar = await f.pedidos.editarItems(
        p.id,
        { items: [{ productoId: prod.id, cantidad: 9 }] },
        f.tienda,
      );
      expect(trasEditar.items[0]).toMatchObject({
        cantidad: 9,
        precioUnitarioCentavos: 1350,
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
