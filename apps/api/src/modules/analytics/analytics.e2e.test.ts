import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { DateTime } from "luxon";
import { auditLog, organizacion, usuario } from "@misupertostada/db";
import {
  ZONA_NEGOCIO,
  permisosPlantilla,
  type Clock,
} from "@misupertostada/shared";
import { renderQuincenaPdf } from "@misupertostada/pdf";
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
import { PedidoService } from "../ordering/pedido.service";
import { PortalTokenService } from "../ordering/portal-token.service";
import { CierreService } from "../fulfillment/cierre.service";
import { HojaService } from "../fulfillment/hoja.service";
import { EntregaService } from "../fulfillment/entrega.service";
import { FacturaService } from "../receivables/factura.service";
import { AbonoService } from "../receivables/abono.service";
import { PagoService } from "../receivables/pago.service";
import { TableroService } from "./tablero.service";

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
): Actor {
  return {
    usuarioId: row.id,
    organizacionId: orgId,
    username: row.username,
    rol: row.rol,
    permisos: permisosPlantilla(row.rol),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: "test-e6",
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
  const facturas = new FacturaService(db, audit, outboxWriter, calendar, events, domainEventsWriter);
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
  const tablero = new TableroService(db, calendar, audit);

  const org = await crearOrgDePrueba(db, "org-e6-");

  const username = `cristian-${crypto.randomUUID().slice(0, 8)}`;
  const [jefe] = await db
    .insert(usuario)
    .values({
      organizacionId: org!.id,
      username,
      rol: "ADMIN_JEFE",
      activo: true,
    })
    .returning({ id: usuario.id, username: usuario.username, rol: usuario.rol });

  const [tony] = await db
    .insert(usuario)
    .values({
      organizacionId: org!.id,
      username: `tony-${crypto.randomUUID().slice(0, 8)}`,
      rol: "REPARTO",
      activo: true,
    })
    .returning({ id: usuario.id, username: usuario.username, rol: usuario.rol });

  return {
    client,
    db,
    clock,
    orgId: org!.id,
    actor: actorDe(jefe!, org!.id),
    actorReparto: actorDe(tony!, org!.id),
    productos,
    clientes,
    ligas,
    pedidos,
    cierre,
    entregas,
    pagos,
    facturas,
    tablero,
    audit,
  };
}

async function altaProducto(
  f: Awaited<ReturnType<typeof fixture>>,
  opts: {
    nombre?: string;
    familia?: "TORTILLA" | "TOSTADA" | "FRITURA";
    puntoCarga?: "PLANTA" | "DEMOCRACIA";
    unidad?: "LIBRA" | "BOLSA";
  } = {},
) {
  return f.productos.crear(
    {
      sku: `P-${crypto.randomUUID().slice(0, 6)}`,
      nombreCanonico: opts.nombre ?? "Tortillas #16",
      familia: opts.familia ?? "TORTILLA",
      unidadMedida: opts.unidad ?? "LIBRA",
      puntoCarga: opts.puntoCarga ?? "DEMOCRACIA",
    },
    f.actor,
  );
}

async function altaCliente(
  f: Awaited<ReturnType<typeof fixture>>,
  opts: { nombre?: string; limite?: number | null } = {},
) {
  return f.clientes.crear(
    {
      nombre: opts.nombre ?? `Cli ${crypto.randomUUID().slice(0, 6)}`,
      limiteFacturasPendientes: opts.limite,
    },
    f.actor,
  );
}

async function ligar(
  f: Awaited<ReturnType<typeof fixture>>,
  clienteId: string,
  productoId: string,
  precioCentavos: number,
) {
  await f.ligas.upsert(clienteId, productoId, { precioCentavos }, f.actor);
}

describe.skipIf(!listo)("E6 tablero", () => {
  test("F-601 operación: 2 de 3 activos piden; inactivo no aparece", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const a = await altaCliente(f, { nombre: "Tabasco Casa Vieja" });
      const b = await altaCliente(f, { nombre: "14 Avenida" });
      const c = await altaCliente(f, { nombre: "Pura Frescura" });
      const muerto = await altaCliente(f, { nombre: "Cerrado SA" });
      await f.clientes.desactivar(muerto.id, f.actor);
      for (const cli of [a, b, c, muerto]) {
        await ligar(f, cli.id, t16.id, 1250);
      }
      await f.pedidos.crearManual(
        { clienteId: a.id, items: [{ productoId: t16.id, cantidad: 50 }] },
        f.actor,
      );
      await f.pedidos.crearManual(
        { clienteId: b.id, items: [{ productoId: t16.id, cantidad: 20 }] },
        f.actor,
      );

      const op = await f.cierre.resumen(f.actor);
      expect(op.clientesSinPedido.map((x) => x.clienteId).sort()).toEqual(
        [c.id].sort(),
      );
      expect(op.clientesSinPedido.some((x) => x.clienteId === muerto.id)).toBe(
        false,
      );

      const tab = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      expect(tab.operacion.clientesSinPedido.map((x) => x.clienteId)).toEqual([
        c.id,
      ]);
      expect(tab.kpis.clientesAlertaTipo).toBe("SIN_PEDIDO");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("monto de noche usa cantidad_pedida × snapshot; alza de catálogo no lo mueve", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const cli = await altaCliente(f);
      await ligar(f, cli.id, t16.id, 1250);
      await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: t16.id, cantidad: 50 }] },
        f.actor,
      );
      await f.ligas.upsert(cli.id, t16.id, { precioCentavos: 9999 }, f.actor);
      const op = await f.cierre.resumen(f.actor);
      expect(op.montoPedidosCentavos).toBe(62500);
      const tab = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      expect(tab.operacion.montoCentavos).toBe(62500);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ruta: EN_PRODUCCION + ENTREGADO + ANULADO; anulado no suma monto", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const a = await altaCliente(f, { nombre: "A" });
      const b = await altaCliente(f, { nombre: "B" });
      const c = await altaCliente(f, { nombre: "C" });
      for (const cli of [a, b, c]) await ligar(f, cli.id, t16.id, 1000);
      const pa = await f.pedidos.crearManual(
        { clienteId: a.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );
      await f.pedidos.crearManual(
        { clienteId: b.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );
      const pc = await f.pedidos.crearManual(
        { clienteId: c.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );
      await f.pedidos.anular(pc.id, { motivo: "Cliente se equivocó" }, f.actor);
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pa.id }, f.actorReparto);

      const op = await f.cierre.resumen(f.actor);
      expect(op.ruta).toEqual({
        confirmados: 0,
        enProduccion: 1,
        entregados: 1,
        anulados: 1,
      });
      expect(op.montoPedidosCentavos).toBe(20000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("cartera: saldo de facturas con abono < monto; cobrado por pago.fecha del rango", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const cli = await altaCliente(f);
      await ligar(f, cli.id, t16.id, 10000);
      const p = await f.pedidos.crearManual(
        { clienteId: cli.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const e = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `ayer-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 3000,
          metodo: "EFECTIVO",
          fecha: "2026-08-19",
        },
        f.actor,
      );
      await f.pagos.registrar(
        {
          id: crypto.randomUUID(),
          idempotencyKey: `hoy-${crypto.randomUUID()}`,
          clienteId: cli.id,
          montoCentavos: 2000,
          metodo: "EFECTIVO",
          fecha: "2026-08-20",
        },
        f.actor,
      );

      const tab = await f.tablero.consultar(f.actor, {
        periodo: "rango",
        desde: "2026-08-20",
        hasta: "2026-08-20",
      });
      expect(tab.cartera.saldoCentavos).toBe(5000);
      expect(tab.cartera.cobradoEnRango.efectivoCentavos).toBe(2000);
      expect(tab.cartera.cobradoEnRango.transferenciaCentavos).toBe(0);
      expect(tab.cartera.cobradoEnRango.chequeCentavos).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("tramos: 10 días → 8–14; 15 días → 15–30", async () => {
    const clock = relojControlado(instanteGT("2026-08-05T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const viejo = await altaCliente(f, { nombre: "Victorias" });
      const medio = await altaCliente(f, { nombre: "Tabasco" });
      await ligar(f, viejo.id, t16.id, 10000);
      await ligar(f, medio.id, t16.id, 10000);

      const p15 = await f.pedidos.crearManual(
        { clienteId: viejo.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const e15 = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p15.id }, f.actorReparto);
      await f.facturas.capturarDte(
        e15.factura.id,
        { numeroDte: `D15-${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );

      clock.set(instanteGT("2026-08-10T22:00:00"));
      const p10 = await f.pedidos.crearManual(
        { clienteId: medio.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      const e10 = await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p10.id }, f.actorReparto);
      await f.facturas.capturarDte(
        e10.factura.id,
        { numeroDte: `D10-${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );

      clock.set(instanteGT("2026-08-20T22:00:00"));
      const tab = await f.tablero.consultar(f.actor, { periodo: "quincena" });
      const t814 = tab.cartera.tramos.find((t) => t.clave === "8-14");
      const t1530 = tab.cartera.tramos.find((t) => t.clave === "15-30");
      expect(t814?.facturas).toBe(1);
      expect(t814?.saldoCentavos).toBe(10000);
      expect(t1530?.facturas).toBe(1);
      expect(t1530?.saldoCentavos).toBe(10000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ventas: participación suma 10000; comparativo quincena previa", async () => {
    const clock = relojControlado(instanteGT("2026-08-13T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const a = await altaCliente(f, { nombre: "Cliente A" });
      const b = await altaCliente(f, { nombre: "Cliente B" });
      await ligar(f, a.id, t16.id, 2000);
      await ligar(f, b.id, t16.id, 1000);

      const prev = await f.pedidos.crearManual(
        { clienteId: a.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: prev.id }, f.actorReparto);

      clock.set(instanteGT("2026-08-20T22:00:00"));
      const pa = await f.pedidos.crearManual(
        { clienteId: a.id, items: [{ productoId: t16.id, cantidad: 2 }] },
        f.actor,
      );
      const pb = await f.pedidos.crearManual(
        { clienteId: b.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pa.id }, f.actorReparto);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pb.id }, f.actorReparto);

      const tab = await f.tablero.consultar(f.actor, { periodo: "quincena" });
      expect(tab.filtrosAplicados.desde).toBe("2026-08-16");
      expect(tab.filtrosAplicados.hasta).toBe("2026-08-31");
      expect(tab.ventas.totalCentavos).toBe(5000);
      expect(tab.ventas.anterior.desde).toBe("2026-08-01");
      expect(tab.ventas.anterior.hasta).toBe("2026-08-15");
      expect(tab.ventas.anterior.totalCentavos).toBe(2000);
      const sumaPb = tab.ventas.porCliente.reduce((acc, c) => acc + c.puntosBase, 0);
      expect(sumaPb).toBe(10000);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("productos: volumen por nombre_mostrado y punto_carga; ANULADO fuera", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f, {
        nombre: "Tortillas #16",
        puntoCarga: "DEMOCRACIA",
      });
      const nachos = await altaProducto(f, {
        nombre: "Nachos Blancos Grandes",
        familia: "FRITURA",
        unidad: "BOLSA",
        puntoCarga: "PLANTA",
      });
      const cli = await altaCliente(f);
      await ligar(f, cli.id, t16.id, 1250);
      await ligar(f, cli.id, nachos.id, 1500);
      await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [
            { productoId: t16.id, cantidad: 50 },
            { productoId: nachos.id, cantidad: 8 },
          ],
        },
        f.actor,
      );
      const anulado = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [{ productoId: nachos.id, cantidad: 99 }],
        },
        f.actor,
      );
      await f.pedidos.anular(anulado.id, { motivo: "Error de captura" }, f.actor);

      const tab = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      const n = tab.productos.find((p) => p.nombreMostrado.includes("Nachos"));
      const t = tab.productos.find((p) => p.nombreMostrado.includes("Tortilla"));
      expect(n?.cantidad).toBe(8);
      expect(n?.puntoCarga).toBe("PLANTA");
      expect(t?.cantidad).toBe(50);
      expect(t?.puntoCarga).toBe("DEMOCRACIA");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("D6: diario sin 3 hábiles → dejoDePedir; Don Napo 1×/7d → false", async () => {
    const clock = relojControlado(instanteGT("2026-08-13T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const diario = await altaCliente(f, { nombre: "Casa Vieja diario" });
      const napo = await altaCliente(f, { nombre: "Don Napo" });
      await ligar(f, diario.id, t16.id, 1250);
      await ligar(f, napo.id, t16.id, 1250);

      await f.pedidos.crearManual(
        { clienteId: napo.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );

      clock.set(instanteGT("2026-08-14T22:00:00"));
      await f.pedidos.crearManual(
        { clienteId: diario.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );
      clock.set(instanteGT("2026-08-16T22:00:00"));
      await f.pedidos.crearManual(
        { clienteId: diario.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );
      clock.set(instanteGT("2026-08-17T22:00:00"));
      await f.pedidos.crearManual(
        { clienteId: diario.id, items: [{ productoId: t16.id, cantidad: 10 }] },
        f.actor,
      );

      clock.set(instanteGT("2026-08-20T22:00:00"));
      const tab = await f.tablero.consultar(f.actor, { periodo: "quincena" });
      const d = tab.clientes.find((c) => c.clienteId === diario.id);
      const n = tab.clientes.find((c) => c.clienteId === napo.id);
      expect(d?.dejoDePedir).toBe(true);
      expect(n?.dejoDePedir).toBe(false);
      expect(tab.kpis.clientesAlertaTipo).toBe("DEJO_DE_PEDIR");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("adopción: 3 PORTAL + 1 MANUAL → puntosBasePortal 7500", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const tokens = new PortalTokenService(f.db);
      for (let i = 0; i < 3; i++) {
        const cli = await altaCliente(f, { nombre: `Portal ${i}` });
        await ligar(f, cli.id, t16.id, 1250);
        const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
        const row = await tokens.resolver(token);
        await f.pedidos.upsertPortal(
          row,
          { items: [{ productoId: t16.id, cantidad: 5 }] },
          { ip: "10.0.0.1", userAgent: "portal" },
        );
      }
      const manual = await altaCliente(f, { nombre: "Tienda 6" });
      await ligar(f, manual.id, t16.id, 1250);
      await f.pedidos.crearManual(
        { clienteId: manual.id, items: [{ productoId: t16.id, cantidad: 5 }] },
        f.actor,
      );

      const tab = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      expect(tab.adopcion).toEqual({
        portal: 3,
        manual: 1,
        puntosBasePortal: 7500,
      });
      expect(tab.kpis.adopcionPuntosBase).toBe(7500);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ticket: redondeo bancario; sin facturas → 0", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const conFac = await altaCliente(f, { nombre: "Con factura" });
      const sinFac = await altaCliente(f, { nombre: "Sin factura" });
      await ligar(f, conFac.id, t16.id, 10000);
      await ligar(f, sinFac.id, t16.id, 10000);
      const p1 = await f.pedidos.crearManual(
        { clienteId: conFac.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      const p2 = await f.pedidos.crearManual(
        { clienteId: conFac.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.pedidos.crearManual(
        { clienteId: sinFac.id, items: [{ productoId: t16.id, cantidad: 1 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar(
        {
          idempotencyKey: crypto.randomUUID(),
          pedidoId: p1.id,
          items: [{ productoId: t16.id, cantidadEntregada: 1 }],
        },
        f.actorReparto,
      );
      await f.entregas.entregar(
        {
          idempotencyKey: crypto.randomUUID(),
          pedidoId: p2.id,
          items: [{ productoId: t16.id, cantidadEntregada: 0 }],
        },
        f.actorReparto,
      );

      const tab = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      const a = tab.clientes.find((c) => c.clienteId === conFac.id);
      const b = tab.clientes.find((c) => c.clienteId === sinFac.id);
      expect(a?.ticketPromedioCentavos).toBe(5000);
      expect(b?.ticketPromedioCentavos).toBe(0);
      expect(Number.isNaN(b?.ticketPromedioCentavos ?? 1)).toBe(false);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-602 PDF %PDF con rango y filtros; sin puppeteer", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const { buffer: buf, nombreArchivo } = await f.tablero.exportarPdf(
        f.actor,
        { periodo: "quincena", familia: "TORTILLA" },
      );
      expect(buf.subarray(0, 4).toString()).toBe("%PDF");
      expect(nombreArchivo).toBe("cierre-quincena-2026-08-16-2026-08-31.pdf");
      const texto = buf.toString("latin1").replaceAll("\u0000", "");
      expect(texto).toContain("2026-08-16");
      expect(texto).toContain("2026-08-31");
      // El recorte se anuncia con la etiqueta del negocio, no con el enum.
      expect(texto).toContain("Tortilla");
      expect(buf.length).toBeGreaterThan(1_000);

      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "../../../../../packages/pdf/src/quincena-pdf.tsx"),
        "utf8",
      );
      expect(src).not.toMatch(/puppeteer|playwright|chromium/i);
      expect(src).toContain("takumi-pdf");
      expect(typeof renderQuincenaPdf).toBe("function");

      const audits = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "tablero.exportar_pdf"));
      expect(audits.length).toBeGreaterThan(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-602 el reporte sigue al recorte: un día no baja como quincena", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const dia = await f.tablero.exportarPdf(f.actor, {
        periodo: "hoy",
      });
      expect(dia.nombreArchivo).toBe("resumen-dia-2026-08-20.pdf");
      const texto = dia.buffer.toString("latin1").replaceAll("\u0000", "");
      expect(texto).toContain("Resumen del d");
      expect(texto).not.toContain("Cierre de quincena");

      const mes = await f.tablero.exportarPdf(f.actor, { periodo: "mes" });
      expect(mes.nombreArchivo).toBe("cierre-mes-2026-08-01-2026-08-31.pdf");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("query inválida → VALIDACION 400; 23:59 GT del 15 no cambia de quincena", async () => {
    const clock = relojControlado(instanteGT("2026-08-15T23:59:00"));
    const f = await fixture(clock);
    try {
      await expect(
        f.tablero.consultar(f.actor, { desde: "no-es-fecha" }),
      ).rejects.toMatchObject({ code: "VALIDACION", httpStatus: 400 });

      const tab = await f.tablero.consultar(f.actor, {});
      expect(tab.filtrosAplicados.desde).toBe("2026-08-01");
      expect(tab.filtrosAplicados.hasta).toBe("2026-08-15");
      expect(tab.filtrosAplicados.periodo).toBe("quincena");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("familia=TORTILLA recorta ventas/productos; cartera intacta; KPI no aplica", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f, { puntoCarga: "DEMOCRACIA" });
      const nachos = await altaProducto(f, {
        nombre: "Nachos Blancos Grandes",
        familia: "FRITURA",
        unidad: "BOLSA",
        puntoCarga: "PLANTA",
      });
      const cli = await altaCliente(f);
      await ligar(f, cli.id, t16.id, 1000);
      await ligar(f, cli.id, nachos.id, 2000);
      const p = await f.pedidos.crearManual(
        {
          clienteId: cli.id,
          items: [
            { productoId: t16.id, cantidad: 10 },
            { productoId: nachos.id, cantidad: 5 },
          ],
        },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: p.id }, f.actorReparto);

      const full = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      const recorte = await f.tablero.consultar(f.actor, {
        periodo: "hoy",
        familia: "TORTILLA",
      });
      expect(full.ventas.totalCentavos).toBe(20000);
      expect(recorte.ventas.totalCentavos).toBe(10000);
      expect(recorte.productos.every((x) => x.familia === "TORTILLA")).toBe(true);
      expect(recorte.cartera.saldoCentavos).toBe(full.cartera.saldoCentavos);
      expect(recorte.filtrosAplicados.carteraAplica).toBe(false);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("clienteId + origen=PORTAL: serie y KPI coinciden", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const t16 = await altaProducto(f);
      const portal = await altaCliente(f, { nombre: "Portal" });
      const manual = await altaCliente(f, { nombre: "Manual" });
      await ligar(f, portal.id, t16.id, 1000);
      await ligar(f, manual.id, t16.id, 1000);
      const tokens = new PortalTokenService(f.db);
      const { token } = await f.clientes.rotarTokenPortal(portal.id, f.actor);
      const row = await tokens.resolver(token);
      const pp = await f.pedidos.upsertPortal(
        row,
        { items: [{ productoId: t16.id, cantidad: 7 }] },
        { ip: "10.0.0.1", userAgent: "portal" },
      );
      const pm = await f.pedidos.crearManual(
        { clienteId: manual.id, items: [{ productoId: t16.id, cantidad: 3 }] },
        f.actor,
      );
      await f.cierre.cerrar({}, f.actor);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pp.id }, f.actorReparto);
      await f.entregas.entregar({ idempotencyKey: crypto.randomUUID(), pedidoId: pm.id }, f.actorReparto);

      const tab = await f.tablero.consultar(f.actor, {
        periodo: "hoy",
        clienteId: portal.id,
        origen: "PORTAL",
      });
      const sumaSerie = tab.ventas.porDia.reduce((acc, d) => acc + d.montoCentavos, 0);
      expect(tab.kpis.ventasCentavos).toBe(sumaSerie);
      expect(tab.kpis.ventasCentavos).toBe(7000);
      expect(tab.kpis.pedidos).toBe(1);
      expect(tab.kpis.portal).toBe(1);
      expect(tab.kpis.manual).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("preset Hoy: desde=hasta=fecha_operacion y alerta SIN_PEDIDO", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
      const hoy = await f.tablero.consultar(f.actor, { periodo: "hoy" });
      expect(hoy.filtrosAplicados.desde).toBe("2026-08-20");
      expect(hoy.filtrosAplicados.hasta).toBe("2026-08-20");
      expect(hoy.kpis.clientesAlertaTipo).toBe("SIN_PEDIDO");

      const q = await f.tablero.consultar(f.actor, { periodo: "quincena" });
      expect(q.kpis.clientesAlertaTipo).toBe("DEJO_DE_PEDIR");

      const mes = await f.tablero.consultar(f.actor, { periodo: "mes" });
      expect(mes.filtrosAplicados.desde).toBe("2026-08-01");
      expect(mes.filtrosAplicados.hasta).toBe("2026-08-31");
      expect(mes.filtrosAplicados.periodo).toBe("mes");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
