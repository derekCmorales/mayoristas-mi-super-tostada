import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  asset,
  auditLog,
  abono,
  cliente,
  clienteBono,
  factura,
  outbox,
  organizacion,
  pago,
  pedido,
  pedidoItem,
  usuario,
} from "@misupertostada/db";
import {
  TIPO_EVENTO_LIMITE_CREDITO,
  ZONA_NEGOCIO,
  permisosPlantilla,
  type Clock,
} from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { DomainEventWriter } from "../shared/domain-event.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { PedidoEvents } from "../shared/panel-events";
import {
  crearOrgDePrueba,
  openTestDb,
  postgresListo,
} from "../../test/db";
import type { Actor } from "../identity/actor";
import { ProductosService } from "../catalog/productos.service";
import { ClientesService } from "../catalog/clientes.service";
import { ClienteProductoService } from "../catalog/cliente-producto.service";
import { ClienteBonoService } from "../catalog/cliente-bono.service";
import { PedidoService } from "../ordering/pedido.service";
import { crearPortalService } from "../../test/portal-fixture";
import { CierreService } from "../fulfillment/cierre.service";
import { HojaService } from "../fulfillment/hoja.service";
import { EntregaService } from "../fulfillment/entrega.service";
import { FacturaService } from "./factura.service";
import { AbonoService } from "./abono.service";
import { PagoService } from "./pago.service";
import { CarteraService } from "./cartera.service";
import { AssetsService } from "../shared/storage/assets.service";
import { AssetVariantsJob } from "../shared/storage/variants.job";
import { FakeStorageAdapter } from "../shared/storage/fake.storage";

const listo = await postgresListo();

function instanteGT(isoLocal: string): Date {
  const dt = DateTime.fromISO(isoLocal, { zone: ZONA_NEGOCIO });
  if (!dt.isValid) throw new Error(`instante inválido: ${isoLocal}`);
  return dt.toJSDate();
}

function relojControlado(inicial: Date): Clock & { set(d: Date): void } {
  let actual = inicial;
  return {
    now: () => actual,
    set: (d: Date) => {
      actual = d;
    },
  };
}

function actorDe(
  row: { id: string; username: string; rol: Actor["rol"] },
  orgId: string,
  ua: string,
): Actor {
  return {
    usuarioId: row.id,
    organizacionId: orgId,
    username: row.username,
    rol: row.rol,
    permisos: permisosPlantilla(row.rol),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: ua,
  };
}

async function fixture(clock: Clock) {
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const outboxWriter = new OutboxWriter(db);
  const domainEventsWriter = new DomainEventWriter(db);
  const calendar = new BusinessCalendarService(db, clock);
  const events = new PedidoEvents();
  const productos = new ProductosService(db, audit, events);
  const clientes = new ClientesService(db, audit);
  const ligas = new ClienteProductoService(db, audit, clientes, events);
  const bonos = new ClienteBonoService(db, audit, clientes, events);
  const pedidos = new PedidoService(db, audit, outboxWriter, calendar, events);
  const hoja = new HojaService(db, calendar);
  const cierre = new CierreService(
    db,
    audit,
    outboxWriter,
    domainEventsWriter,
    calendar,
    hoja,
    events,
  );
  const facturas = new FacturaService(db, audit, outboxWriter, calendar, events);
  const abonos = new AbonoService(db, audit, calendar, events, facturas);
  const entregas = new EntregaService(
    db,
    audit,
    domainEventsWriter,
    calendar,
    events,
    facturas,
  );
  const pagos = new PagoService(abonos);
  const cartera = new CarteraService(db, calendar);
  const storage = new FakeStorageAdapter();
  const assets = new AssetsService(db, storage, new AssetVariantsJob(db, storage));
  const portal = crearPortalService({
    db,
    audit,
    calendar,
    pedidos,
    assets,
    abonos,
  });

  const org = await crearOrgDePrueba(db, "org-e5-");

  async function alta(
    rol: Actor["rol"],
    prefijo: string,
  ): Promise<{ row: { id: string; username: string; rol: Actor["rol"] }; actor: Actor }> {
    const username = `${prefijo}-${crypto.randomUUID().slice(0, 8)}`;
    const [row] = await db
      .insert(usuario)
      .values({
        organizacionId: org!.id,
        username,
        rol,
        activo: true,
      })
      .returning({ id: usuario.id, username: usuario.username, rol: usuario.rol });
    return {
      row: row!,
      actor: actorDe(row!, org!.id, `test-${prefijo}`),
    };
  }

  const jefe = await alta("ADMIN_JEFE", "cristian");
  const alex = await alta("PRODUCCION", "alex");
  const carla = await alta("TIENDA", "carla");
  const tony = await alta("REPARTO", "tony");

  return {
    client,
    db,
    clock,
    orgId: org!.id,
    actor: jefe.actor,
    actorProduccion: alex.actor,
    actorTienda: carla.actor,
    actorReparto: tony.actor,
    productos,
    clientes,
    ligas,
    bonos,
    pedidos,
    cierre,
    entregas,
    facturas,
    pagos,
    cartera,
    portal,
    abonos,
    assets,
    events,
  };
}

async function catalogo(
  f: Awaited<ReturnType<typeof fixture>>,
  opts: {
    precioCentavos?: number;
    cantidad?: number;
    limite?: number | null;
    horario?: string | null;
    nombre?: string;
  } = {},
) {
  const precio = opts.precioCentavos ?? 1250;
  const prod = await f.productos.crear(
    {
      sku: `T16-${crypto.randomUUID().slice(0, 6)}`,
      nombreCanonico: "Tortillas #16",
      familia: "TORTILLA",
      unidadMedida: "LIBRA",
      puntoCarga: "DEMOCRACIA",
    },
    f.actor,
  );
  const cli = await f.clientes.crear(
    {
      nombre: opts.nombre ?? `Tabasco ${crypto.randomUUID().slice(0, 6)}`,
      limiteFacturasPendientes: opts.limite,
      horarioEntregaFijo: opts.horario ?? "08:30",
    },
    f.actor,
  );
  await f.ligas.upsert(
    cli.id,
    prod.id,
    { precioCentavos: precio, notaProduccion: "GRUESAS" },
    f.actor,
  );
  const pedidoCreado = await f.pedidos.crearManual(
    {
      clienteId: cli.id,
      items: [{ productoId: prod.id, cantidad: opts.cantidad ?? 50 }],
    },
    f.actor,
  );
  await f.cierre.cerrar(
    { fechaOperacion: pedidoCreado.fechaOperacion },
    f.actor,
  );
  return { prod, cli, pedido: pedidoCreado };
}

describe.skipIf(!listo)("E5 cobranza", () => {
  test("F-501 entregar sin ajustar: cantidad = pedida, factura = total, ENTREGADO", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod } = await catalogo(f, { precioCentavos: 1250, cantidad: 50 });
      const r = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      expect(r.estado).toBe("ENTREGADO");
      expect(r.factura.montoCentavos).toBe(62500);
      expect(r.factura.estado).toBe("PENDIENTE");
      const item = r.items.find((i) => i.productoId === prod.id);
      expect(item?.cantidadEntregada).toBe(50);
      expect(item?.cantidadPedida).toBe(50);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-501 bajar 50→40 lb a Q4.50 snapshot: 18000, no 22500; subir catálogo no cambia", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod, cli } = await catalogo(f, {
        precioCentavos: 450,
        cantidad: 50,
      });
      const r = await f.entregas.entregar(
        {
          idempotencyKey: crypto.randomUUID(),
          pedidoId: p.id,
          items: [{ productoId: prod.id, cantidadEntregada: 40 }],
        },
        f.actorReparto,
      );
      expect(r.factura.montoCentavos).toBe(18000);
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 9999 }, f.actor);
      const [fac] = await f.db
        .select()
        .from(factura)
        .where(eq(factura.pedidoId, p.id));
      expect(fac?.montoCentavos).toBe(18000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-501 entregar CONFIRMADO (día no cerrado) → 409 PEDIDO_NO_ENTREGABLE", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `X-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear({ nombre: `Abierto ${crypto.randomUUID().slice(0, 6)}` }, f.actor);
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1250 }, f.actor);
      const p = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      await expect(f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto)).rejects.toMatchObject({
        code: "PEDIDO_NO_ENTREGABLE",
        httpStatus: 409,
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-501 segunda entrega del mismo pedido es 200 idempotente, una sola factura", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod } = await catalogo(f);
      const key = `entrega-retry-${p.id.slice(0, 8)}`;
      const a = await f.entregas.entregar(
        { idempotencyKey: key, pedidoId: p.id, items: [{ productoId: prod.id, cantidadEntregada: 50 }] },
        f.actorReparto,
      );
      const b = await f.entregas.entregar(
        { idempotencyKey: key, pedidoId: p.id, items: [{ productoId: prod.id, cantidadEntregada: 50 }] },
        f.actorReparto,
      );
      expect(a.idempotente).toBe(false);
      expect(b.idempotente).toBe(true);
      expect(b.factura.id).toBe(a.factura.id);
      const facs = await f.db.select().from(factura).where(eq(factura.pedidoId, p.id));
      expect(facs).toHaveLength(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-801 misma key dos veces (cantidades distintas en el retry) → una factura, no duplica", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod } = await catalogo(f, { cantidad: 50 });
      const key = `entrega-offline-${p.id.slice(0, 8)}`;
      const a = await f.entregas.entregar(
        {
          idempotencyKey: key,
          pedidoId: p.id,
          items: [{ productoId: prod.id, cantidadEntregada: 50 }],
        },
        f.actorReparto,
      );
      const b = await f.entregas.entregar(
        {
          idempotencyKey: key,
          pedidoId: p.id,
          items: [{ productoId: prod.id, cantidadEntregada: 40 }],
        },
        f.actorReparto,
      );
      expect(a.idempotente).toBe(false);
      expect(b.idempotente).toBe(true);
      expect(b.factura.id).toBe(a.factura.id);
      expect(b.factura.montoCentavos).toBe(a.factura.montoCentavos);
      const item = b.items.find((i) => i.productoId === prod.id);
      expect(item?.cantidadEntregada).toBe(50);
      const facs = await f.db.select().from(factura).where(eq(factura.pedidoId, p.id));
      expect(facs).toHaveLength(1);
      const audits = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "pedidos.entregar"));
      expect(audits.filter((row) => row.entidadId === p.id)).toHaveLength(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-801 ENTREGADO + key distinta + cantidad distinta → 409", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod } = await catalogo(f, { cantidad: 50 });
      await f.entregas.entregar(
        {
          idempotencyKey: `entrega-primera-${p.id.slice(0, 8)}`,
          pedidoId: p.id,
          items: [{ productoId: prod.id, cantidadEntregada: 50 }],
        },
        f.actorReparto,
      );
      await expect(
        f.entregas.entregar(
          {
            idempotencyKey: `entrega-otra-${p.id.slice(0, 8)}`,
            pedidoId: p.id,
            items: [{ productoId: prod.id, cantidadEntregada: 40 }],
          },
          f.actorReparto,
        ),
      ).rejects.toMatchObject({ code: "PEDIDO_NO_ENTREGABLE", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-801 ENTREGADO + key distinta aunque las cantidades coincidan → 409", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, prod } = await catalogo(f, { cantidad: 50 });
      await f.entregas.entregar(
        {
          idempotencyKey: `entrega-a-${p.id.slice(0, 8)}`,
          pedidoId: p.id,
          items: [{ productoId: prod.id, cantidadEntregada: 50 }],
        },
        f.actorReparto,
      );
      await expect(
        f.entregas.entregar(
          {
            idempotencyKey: `entrega-b-${p.id.slice(0, 8)}`,
            pedidoId: p.id,
            items: [{ productoId: prod.id, cantidadEntregada: 50 }],
          },
          f.actorReparto,
        ),
      ).rejects.toMatchObject({ code: "PEDIDO_NO_ENTREGABLE", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-403 PRODUCCION POST entregar → 403; GET ruta → 200", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const { pedido: p } = await catalogo(f);
      await expect(
        f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorProduccion),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO", httpStatus: 403 });
      // La ruta es del día de calle: el pedido del jueves sale el viernes.
      clock.set(instanteGT("2026-08-21T08:00:00"));
      const ruta = await f.entregas.ruta({}, f.actorProduccion);
      expect(ruta.paradas.length).toBeGreaterThan(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("la ruta sin filtro es el DÍA DE CALLE, no la ventana", async () => {
    // Jueves 20 a las 22:00: la ventana del jueves está abierta y recibe
    // pedidos que salen el viernes. Hoy en la calle no hay nada de eso.
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      await catalogo(f);
      const jueves = await f.entregas.ruta({}, f.actor);
      expect(jueves.fechaEntrega).toBe("2026-08-20");
      expect(jueves.paradas.length).toBe(0);

      // Viernes 21 a las 08:00: se reparte la operación del jueves.
      clock.set(instanteGT("2026-08-21T08:00:00"));
      const manana = await f.entregas.ruta({}, f.actor);
      expect(manana.fechaEntrega).toBe("2026-08-21");
      expect(manana.fechaOperacion).toBe("2026-08-20");
      expect(manana.paradas.length).toBeGreaterThan(0);

      // Viernes 21 a las 15:00: abre la ventana siguiente. La ruta NO salta:
      // Tony sigue en la calle con la misma carga. Ese salto era el bug.
      clock.set(instanteGT("2026-08-21T15:30:00"));
      const tarde = await f.entregas.ruta({}, f.actor);
      expect(tarde.fechaEntrega).toBe("2026-08-21");
      expect(tarde.fechaOperacion).toBe("2026-08-20");
      expect(tarde.paradas.length).toBe(manana.paradas.length);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-502 REPARTO no captura DTE; TIENDA sí; duplicado 409", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `DTE-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cliA = await f.clientes.crear(
        { nombre: `DTE-A ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      const cliB = await f.clientes.crear(
        { nombre: `DTE-B ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      await f.ligas.upsert(cliA.id, prod.id, { precioCentavos: 1250 }, f.actor);
      await f.ligas.upsert(cliB.id, prod.id, { precioCentavos: 1250 }, f.actor);
      const pA = await f.pedidos.crearManual(
        { clienteId: cliA.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      const pB = await f.pedidos.crearManual(
        { clienteId: cliB.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const ea = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pA.id }, f.actorReparto);
      const eb = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pB.id }, f.actorReparto);
      const dte = `DTE-${crypto.randomUUID().slice(0, 8)}`;
      await expect(
        f.facturas.capturarDte(ea.factura.id, { numeroDte: dte }, f.actorReparto),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO", httpStatus: 403 });
      const conDte = await f.facturas.capturarDte(
        ea.factura.id,
        { numeroDte: dte },
        f.actorTienda,
      );
      expect(conDte.numeroDte).toBe(dte);
      await expect(
        f.facturas.capturarDte(eb.factura.id, { numeroDte: dte }, f.actorTienda),
      ).rejects.toMatchObject({ code: "DTE_DUPLICADO", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-503 abono 3000 sobre 10000 → ABONO_PARCIAL; 7000 → PAGADO; portal 0 pendientes", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      expect(e.factura.montoCentavos).toBe(10000);
      const a1 = await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `abono-1-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 3000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      expect(a1.facturas[0]?.estado).toBe("ABONO_PARCIAL");
      expect(a1.facturas[0]?.saldoCentavos).toBe(7000);
      const a2 = await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `abono-2-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 7000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      expect(a2.facturas[0]?.estado).toBe("PAGADO");
      const [cliRow] = await f.db.select().from(cliente).where(eq(cliente.id, cli.id));
      const cuenta = await f.portal.cuentaDe(cliRow!);
      expect(cuenta.facturasPendientes).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-503 abono 10001 → 409 PAGO_EXCEDE_SALDO, cero filas pago", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await expect(
        f.pagos.registrar(
          {
            id: crypto.randomUUID(),
            idempotencyKey: `excede-${crypto.randomUUID()}`,
            clienteId: cli.id,
            montoCentavos: 10001,
            metodo: "EFECTIVO",
          },
          f.actorReparto,
        ),
      ).rejects.toMatchObject({ code: "PAGO_EXCEDE_SALDO", httpStatus: 409 });
      const pagos = await f.db.select().from(pago).where(eq(pago.facturaId, e.factura.id));
      expect(pagos).toHaveLength(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-503 FIFO cliente: 10000 y 5000, pago 12000 → 10000+2000", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `FIFO-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `FIFO ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1000 }, f.actor);
      const p1 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      const p2 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 5 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const e1 = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p1.id }, f.actorReparto);
      const e2 = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p2.id }, f.actorReparto);
      const r = await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `fifo-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 12000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      expect(r.pagos).toHaveLength(2);
      expect(r.pagos.map((x) => x.montoCentavos).sort((a, b) => b - a)).toEqual([
        10000, 2000,
      ]);
      const fac1 = r.facturas.find((x) => x.id === e1.factura.id);
      const fac2 = r.facturas.find((x) => x.id === e2.factura.id);
      expect(fac1?.estado).toBe("PAGADO");
      expect(fac2?.estado).toBe("ABONO_PARCIAL");
      expect(fac2?.abonadoCentavos).toBe(2000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-504 transferencia/cheque sin comprobante 400; efectivo sin foto 200", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await expect(
        f.pagos.registrar(
          {
            id: crypto.randomUUID(),
            idempotencyKey: `tr-${crypto.randomUUID()}`,
            clienteId: cli.id,
            montoCentavos: 1000,
            metodo: "TRANSFERENCIA",
          },
          f.actorReparto,
        ),
      ).rejects.toMatchObject({ code: "VALIDACION", httpStatus: 400 });
      await expect(
        f.pagos.registrar(
          {
            id: crypto.randomUUID(),
            idempotencyKey: `ch-${crypto.randomUUID()}`,
            clienteId: cli.id,
            montoCentavos: 1000,
            metodo: "CHEQUE",
          },
          f.actorReparto,
        ),
      ).rejects.toMatchObject({ code: "VALIDACION", httpStatus: 400 });
      const ok = await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `ef-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 1000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      expect(ok.pagos).toHaveLength(1);

      const chequeId = crypto.randomUUID();
      const [comp] = await f.db
        .insert(asset)
        .values({
          key: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64),
          bucket: "test",
          mime: "image/jpeg",
          size: 12,
          ownerType: "abono",
          ownerId: chequeId,
        })
        .returning({ id: asset.id });
      const cheque = await f.pagos.registrar(
        {
          id: chequeId,
          idempotencyKey: `ch-ok-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 1500,
          metodo: "CHEQUE",
          comprobanteAssetId: comp!.id,
        },
        f.actorReparto,
      );
      expect(cheque.pagos[0]?.comprobanteAssetId).toBe(comp!.id);
      expect(cheque.pagos[0]?.metodo).toBe("CHEQUE");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-503 mismo idempotency_key dos veces → un pago", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      const body = {
        id: crypto.randomUUID(),
        idempotencyKey: `dup-${crypto.randomUUID()}`,
        clienteId: cli.id,
        montoCentavos: 2000,
        metodo: "EFECTIVO" as const,
      };
      const a = await f.pagos.registrar(body, f.actorReparto);
      const b = await f.pagos.registrar({ ...body, id: crypto.randomUUID() }, f.actorReparto);
      expect(a.idempotente).toBe(false);
      expect(b.idempotente).toBe(true);
      expect(b.pagos[0]?.id).toBe(a.pagos[0]?.id);
      const filas = await f.db.select().from(pago).where(eq(pago.facturaId, e.factura.id));
      expect(filas).toHaveLength(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-505 límite 3: cuarta pendiente dispara outbox; quinta mismo día no duplica", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `LIM-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        {
          nombre: `Limite ${crypto.randomUUID().slice(0, 6)}`,
          limiteFacturasPendientes: 3,
        },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1000 }, f.actor);
      const pedidos = [];
      for (let i = 0; i < 5; i++) {
        pedidos.push(
          await f.pedidos.crearManual(
            { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 1 }] },
            f.actor,
          ),
        );
      }
      await f.cierre.cerrar({}, f.actor);
      for (let i = 0; i < 3; i++) {
        await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pedidos[i]!.id }, f.actorReparto);
      }
      const antes = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_EVENTO_LIMITE_CREDITO),
            eq(outbox.destinatarioId, cli.id),
          ),
        );
      expect(antes).toHaveLength(0);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pedidos[3]!.id }, f.actorReparto);
      const media = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_EVENTO_LIMITE_CREDITO),
            eq(outbox.destinatarioId, cli.id),
          ),
        );
      expect(media).toHaveLength(1);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pedidos[4]!.id }, f.actorReparto);
      const despues = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_EVENTO_LIMITE_CREDITO),
            eq(outbox.destinatarioId, cli.id),
          ),
        );
      expect(despues).toHaveLength(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-505 reloj +15 días incluye vencidas; a +14 no", async () => {
    const clock = relojControlado(instanteGT("2026-08-05T16:00:00"));
    const f = await fixture(clock);
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      const dteCap = await f.facturas.capturarDte(e.factura.id, { numeroDte: `V-${crypto.randomUUID().slice(0, 8)}` }, f.actorTienda);
      expect(dteCap.emitidaAt).toBeTruthy();
      expect(dteCap.antiguedadDias).toBe(0);
      clock.set(instanteGT("2026-08-19T16:00:00"));
      const a14 = await f.cartera.listar(f.actor, { estado: "vencidas" });
      expect(a14.items.some((x) => x.id === e.factura.id)).toBe(false);
      clock.set(instanteGT("2026-08-20T16:00:00"));
      const a15 = await f.cartera.listar(f.actor, { estado: "vencidas" });
      expect(a15.items.some((x) => x.id === e.factura.id)).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-505 cuadre: efectivo de Tony + transferencia de Carla; no mezcla ayer", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `ayer-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 1000,
          metodo: "EFECTIVO",
          fecha: "2026-08-19",
        },
        f.actor,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `t1-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 2000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `t2-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 1500,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      const pagoId = crypto.randomUUID();
      const abonoId = crypto.randomUUID();
      const [comp] = await f.db
        .insert(asset)
        .values({
          key: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64),
          bucket: "test",
          mime: "image/jpeg",
          size: 12,
          ownerType: "abono",
          ownerId: abonoId,
        })
        .returning({ id: asset.id });
      await f.pagos.registrar(
        {
          id: abonoId,
          idempotencyKey: `c1-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 3000,
          metodo: "TRANSFERENCIA",
          comprobanteAssetId: comp!.id,
        },
        f.actorTienda,
      );
      const cuadre = await f.cartera.cuadre(f.actor, { fecha: "2026-08-20" });
      expect(cuadre.totalEfectivoCentavos).toBe(3500);
      expect(cuadre.totalTransferenciaCentavos).toBe(3000);
      expect(cuadre.totalChequeCentavos).toBe(0);
      expect(cuadre.totalCentavos).toBe(6500);
      expect(cuadre.pagos.every((x) => x.fecha === "2026-08-20")).toBe(true);
      const tony = cuadre.porActor.find((a) => a.usuarioId === f.actorReparto.usuarioId);
      expect(tony?.efectivoCentavos).toBe(3500);
      expect(tony?.count).toBe(2);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-501 entregar 0 en todas las líneas → factura 0, no cuenta al límite", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `CERO-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        {
          nombre: `Cero ${crypto.randomUUID().slice(0, 6)}`,
          limiteFacturasPendientes: 1,
        },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1250 }, f.actor);
      const p1 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      const p2 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 10 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const cero = await f.entregas.entregar(
        { idempotencyKey: crypto.randomUUID(), pedidoId: p1.id, items: [{ productoId: prod.id, cantidadEntregada: 0 }] },
        f.actorReparto,
      );
      expect(cero.factura.montoCentavos).toBe(0);
      expect(cero.factura.estado).toBe("PAGADO");
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p2.id }, f.actorReparto);
      const alertas = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_EVENTO_LIMITE_CREDITO),
            eq(outbox.destinatarioId, cli.id),
          ),
        );
      expect(alertas).toHaveLength(0);
      const resumen = await f.cartera.resumen(f.actor, {});
      expect(resumen.pendientesCount).toBe(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("el cobro de la cartera sigue la fecha consultada, no el reloj", async () => {
    // Jueves 20 22:00: se captura y cierra la operación del jueves.
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const { pedido: p, cli } = await catalogo(f, {
        precioCentavos: 10000,
        cantidad: 1,
      });
      // Viernes 21: sale a la calle, se entrega y se cobra.
      clock.set(instanteGT("2026-08-21T09:00:00"));
      const e = await f.entregas.entregar(
        { idempotencyKey: crypto.randomUUID(), pedidoId: p.id },
        f.actorReparto,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `cobro-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 10000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );

      // Viernes 16:00: abre la ventana del viernes. El foco salta a esa
      // captura, pero el cobro NO: sigue siendo el del día de calle. Derivarlo
      // del foco mandaba «Cobrado hoy» a Q0 a media tarde y lo dejaba en
      // desacuerdo con el cuadre del día, que siempre usó el eje de día de calendario.
      clock.set(instanteGT("2026-08-21T16:00:00"));
      const tarde = await f.cartera.resumen(f.actor, {});
      expect(tarde.fechaCobro).toBe("2026-08-21");
      expect(tarde.cobradoHoyCentavos).toBe(10000);
      const cuadre = await f.cartera.cuadre(f.actor, {});
      expect(cuadre.fecha).toBe(tarde.fechaCobro!);
      expect(cuadre.totalCentavos).toBe(tarde.cobradoHoyCentavos);

      clock.set(instanteGT("2026-08-21T09:30:00"));
      const mismoDia = await f.cartera.resumen(f.actor, {
        fechaOperacion: "2026-08-20",
      });
      expect(mismoDia.fechaCobro).toBe("2026-08-21");
      expect(mismoDia.cobradoHoyCentavos).toBe(10000);

      // Lunes 24: abrir la operación del jueves NO debe mostrar el cobro de
      // hoy, sino el del día en que esa operación salió a la calle.
      clock.set(instanteGT("2026-08-24T10:00:00"));
      const desdeElLunes = await f.cartera.resumen(f.actor, {
        fechaOperacion: "2026-08-20",
      });
      expect(desdeElLunes.fechaCobro).toBe("2026-08-21");
      expect(desdeElLunes.cobradoHoyCentavos).toBe(10000);

      // Y el resumen sin filtro, ese lunes, no arrastra el cobro del viernes.
      const hoyLunes = await f.cartera.resumen(f.actor, {});
      expect(hoyLunes.cobradoHoyCentavos).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("anular ENTREGADO sigue 409 (regresión E3)", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p } = await catalogo(f);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await expect(
        f.pedidos.anular(p.id, { motivo: "Ya lo llevamos" }, f.actor),
      ).rejects.toMatchObject({ code: "PEDIDO_ENTREGADO", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("audit_log de entrega, DTE y pago con actor distinto", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await f.facturas.capturarDte(
        e.factura.id,
        { numeroDte: `AUD-${crypto.randomUUID().slice(0, 6)}` },
        f.actorTienda,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `aud-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 1000,
          metodo: "EFECTIVO",
        },
        f.actorReparto,
      );
      const entregaAudit = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "pedidos.entregar"));
      expect(entregaAudit.some((a) => a.actorId === f.actorReparto.usuarioId)).toBe(true);
      const dteAudit = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "cobranza.capturar_dte"));
      expect(dteAudit.some((a) => a.actorId === f.actorTienda.usuarioId)).toBe(true);
      const pagoAudit = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "cobranza.registrar_pago"));
      expect(pagoAudit.some((a) => a.actorId === f.actorReparto.usuarioId)).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("portal: transferencia pendiente no baja saldo; confirmar aplica FIFO", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    const meta = { ip: "10.0.0.2", userAgent: "portal-abono-e2e" };
    try {
      const prod = await f.productos.crear(
        {
          sku: `AB-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Portal abono ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 30000 }, f.actor);
      const p1 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 1 }] },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 20000 }, f.actor);
      const p2 = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: prod.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p1.id }, f.actorReparto);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p2.id }, f.actorReparto);

      const abonoId = crypto.randomUUID();
      const [comp] = await f.db
        .insert(asset)
        .values({
          key: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64),
          bucket: "test",
          mime: "image/jpeg",
          size: 12,
          ownerType: "abono",
          ownerId: abonoId,
        })
        .returning({ id: asset.id });

      const reportado = await f.abonos.reportarTransferencia(
        cli.id,
        f.orgId,
        {
          id: abonoId,
          idempotencyKey: `portal-${crypto.randomUUID()}`,
          montoCentavos: 40000,
          descripcion: "Transferencia Banrural ref 123",
          comprobanteAssetId: comp!.id,
        },
        meta,
      );
      expect(reportado.estado).toBe("PENDIENTE");

      const [cliRow] = await f.db.select().from(cliente).where(eq(cliente.id, cli.id));
      const cuentaPend = await f.portal.cuentaDe(cliRow!);
      expect(cuentaPend.saldoCentavos).toBe(50000);
      expect(cuentaPend.transferenciasEnRevisionCentavos).toBe(40000);
      expect(cuentaPend.abonos.some((a) => a.id === abonoId && a.estado === "PENDIENTE")).toBe(
        true,
      );

      const pagosAntes = await f.db.select().from(pago).where(eq(pago.abonoId, abonoId));
      expect(pagosAntes).toHaveLength(0);

      const confirmado = await f.abonos.confirmar(abonoId, f.actor);
      expect(confirmado.pagos).toHaveLength(2);
      expect(confirmado.pagos[0]?.montoCentavos).toBe(30000);
      expect(confirmado.pagos[1]?.montoCentavos).toBe(10000);
      expect(confirmado.pagos?.every((p) => p.comprobanteAssetId === comp!.id)).toBe(
        true,
      );
      expect(confirmado.facturas.find((x) => x.saldoCentavos === 10000)?.estado).toBe(
        "ABONO_PARCIAL",
      );

      const cuentaOk = await f.portal.cuentaDe(cliRow!);
      expect(cuentaOk.saldoCentavos).toBe(10000);
      expect(cuentaOk.transferenciasEnRevisionCentavos).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("portal: rechazar transferencia no crea pagos ni baja saldo", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    const meta = { ip: "10.0.0.2", userAgent: "portal-rechazo-e2e" };
    try {
      const { pedido: p, cli } = await catalogo(f, { precioCentavos: 10000, cantidad: 1 });
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      const abonoId = crypto.randomUUID();
      const [comp] = await f.db
        .insert(asset)
        .values({
          key: `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`.slice(0, 64),
          bucket: "test",
          mime: "image/jpeg",
          size: 12,
          ownerType: "abono",
          ownerId: abonoId,
        })
        .returning({ id: asset.id });
      await f.abonos.reportarTransferencia(
        cli.id,
        f.orgId,
        {
          id: abonoId,
          idempotencyKey: `rech-${crypto.randomUUID()}`,
          montoCentavos: 5000,
          descripcion: "Comprobante ilegible",
          comprobanteAssetId: comp!.id,
        },
        meta,
      );
      await f.abonos.rechazar(abonoId, { motivo: "Monto no coincide" }, f.actor);
      const [row] = await f.db.select().from(abono).where(eq(abono.id, abonoId));
      expect(row?.estado).toBe("RECHAZADO");
      const pagosRows = await f.db.select().from(pago).where(eq(pago.abonoId, abonoId));
      expect(pagosRows).toHaveLength(0);
      const [cliRow] = await f.db.select().from(cliente).where(eq(cliente.id, cli.id));
      const cuenta = await f.portal.cuentaDe(cliRow!);
      expect(cuenta.saldoCentavos).toBe(10000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-105 pedido mixto: factura solo líneas pagadas; devolución 0 restaura bono", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T22:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `BONO-R-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla mixta",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Mixto bono ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1000 }, f.actor);
      const bono = await f.bonos.otorgar(
        cli.id,
        {
          productoId: prod.id,
          descripcion: "quebradita",
          cantidad: 2,
        },
        f.actor,
      );
      const pedidoCreado = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [
            { productoId: prod.id, cantidad: 5, esDevolucion: false },
            {
              productoId: prod.id,
              cantidad: 2,
              esDevolucion: true,
              bonoId: bono.id,
            },
          ],
        },
        f.actor,
      );
      await f.cierre.cerrar(
        { fechaOperacion: pedidoCreado.fechaOperacion },
        f.actor,
      );

      const items = await f.db
        .select()
        .from(pedidoItem)
        .where(eq(pedidoItem.pedidoId, pedidoCreado.id));
      const lineaDev = items.find((i) => i.esDevolucion);
      expect(lineaDev).toBeDefined();

      const entrega = await f.entregas.entregar(
        {
          idempotencyKey: crypto.randomUUID(),
          pedidoId: pedidoCreado.id,
          items: [
            { productoId: prod.id, cantidadEntregada: 5 },
            { itemId: lineaDev!.id, cantidadEntregada: 0 },
          ],
        },
        f.actorReparto,
      );
      expect(entrega.factura.montoCentavos).toBe(5000);

      const [bonoRow] = await f.db
        .select()
        .from(clienteBono)
        .where(eq(clienteBono.id, bono.id));
      expect(bonoRow?.cantidadAplicada).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
