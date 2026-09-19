import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { DateTime } from "luxon";
import {
  abono,
  asset,
  auditLog,
  clienteBono,
  diaOperacion,
  factura,
  organizacion,
  outbox,
  pago,
  pedido,
  pedidoItem,
  producto,
  usuario,
  ventanaSemanal,
} from "@misupertostada/db";
import {
  MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
  MENSAJE_PORTAL_NO_ENCONTRADO,
  WEEKDAYS_ISO,
  ZONA_NEGOCIO,
  fixedClock,
  instanteAIso,
  permisosEfectivos,
  type Clock,
} from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { AssetsService } from "../shared/storage/assets.service";
import { AssetVariantsJob } from "../shared/storage/variants.job";
import { FakeStorageAdapter } from "../shared/storage/fake.storage";
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
import { PortalTokenService } from "./portal-token.service";
import { crearPortalService } from "../../test/portal-fixture";
import { PedidoEvents } from "./pedido-events";
import { PedidoService } from "./pedido.service";
import { ConfiguracionService } from "../shared/configuracion.service";
import { AbonoService } from "../receivables/abono.service";
import { FacturaService } from "../receivables/factura.service";

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

async function fixture(clock: Clock) {
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const outboxWriter = new OutboxWriter(db);
  const calendar = new BusinessCalendarService(db, clock);
  const events = new PedidoEvents();
  const productos = new ProductosService(db, audit, events);
  const clientes = new ClientesService(db, audit);
  const ligas = new ClienteProductoService(db, audit, clientes, events);
  const bonos = new ClienteBonoService(db, audit, clientes, events);
  const tokens = new PortalTokenService(db);
  const pedidos = new PedidoService(db, audit, outboxWriter, calendar, events);
  const storage = new FakeStorageAdapter();
  const variants = new AssetVariantsJob(db, storage);
  const assets = new AssetsService(db, storage, variants);
  const facturas = new FacturaService(db, audit, outboxWriter, calendar, events);
  const abonos = new AbonoService(db, audit, calendar, events, facturas);
  const portal = crearPortalService({
    db,
    audit,
    calendar,
    pedidos,
    assets,
    abonos,
  });
  const cfg = new ConfiguracionService(db, audit, calendar);

  const org = await crearOrgDePrueba(db, "org-e2-");

  const username = `jefe-${crypto.randomUUID().slice(0, 8)}`;
  const [jefe] = await db
    .insert(usuario)
    .values({
      organizacionId: org!.id,
      username,
      rol: "ADMIN_JEFE",
      activo: true,
    })
    .returning({ id: usuario.id });

  const actor: Actor = {
    usuarioId: jefe!.id,
    organizacionId: org!.id,
    username,
    rol: "ADMIN_JEFE",
    permisos: permisosEfectivos("ADMIN_JEFE"),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: "test",
  };

  return {
    client,
    db,
    actor,
    orgId: org!.id,
    productos,
    clientes,
    ligas,
    bonos,
    tokens,
    pedidos,
    portal,
    calendar,
    cfg,
    assets,
    storage,
  };
}

const meta = { ip: "10.0.0.2", userAgent: "Mozilla/5.0 portal-test" };


describe.skipIf(!listo)("portal E2", () => {
  test("token basura, rotado e inactivo responden el mismo 404 genérico", async () => {
    const f = await fixture(fixedClock(instanteGT("2026-08-20T16:00:00")));
    try {
      const cli = await f.clientes.crear(
        { nombre: `Portal 404 ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);

      const basura = f.tokens.resolver("token-que-no-existe-nunca-jamas");
      await expect(basura).rejects.toMatchObject({
        code: "NO_ENCONTRADO",
        httpStatus: 404,
        message: MENSAJE_PORTAL_NO_ENCONTRADO,
      });

      const { token: segundo } = await f.clientes.rotarTokenPortal(
        cli.id,
        f.actor,
      );
      await expect(f.tokens.resolver(token)).rejects.toMatchObject({
        code: "NO_ENCONTRADO",
        message: MENSAJE_PORTAL_NO_ENCONTRADO,
      });
      const vigente = await f.tokens.resolver(segundo);
      expect(vigente.id).toBe(cli.id);

      await f.clientes.desactivar(cli.id, f.actor);
      await expect(f.tokens.resolver(segundo)).rejects.toMatchObject({
        code: "NO_ENCONTRADO",
        message: MENSAJE_PORTAL_NO_ENCONTRADO,
      });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("apertura audita portal.abrir sin el token crudo", async () => {
    const f = await fixture(fixedClock(instanteGT("2026-08-20T16:00:00")));
    try {
      const cli = await f.clientes.crear(
        { nombre: `Portal audit ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);

      expect(sesion.cliente.nombre).toBe(cli.nombre);
      expect(JSON.stringify(sesion)).not.toContain(token);
      expect(sesion.catalogo.every((p) => !("sku" in p))).toBe(true);
      expect(sesion.catalogo.every((p) => !("puntoCarga" in p))).toBe(true);
      expect(sesion.catalogo.every((p) => "fotoAssetId" in p)).toBe(true);
      expect(sesion.saludo).toBe("tardes");
      expect(sesion.ahoraIso.length).toBeGreaterThanOrEqual(20);
      expect(sesion.ultimoPedido).toBeNull();

      const audits = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entidadId, cli.id));
      const apertura = audits.find((a) => a.accion === "portal.abrir");
      expect(apertura?.actorTipo).toBe("cliente");
      expect(apertura?.actorId).toBe(cli.id);
      expect(apertura?.ip).toBe(meta.ip);
      expect(JSON.stringify(apertura)).not.toContain(token);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("sábado 02:00 con cierre viernes→sábado 06:00 es operación del viernes", async () => {
    const clock = relojControlado(instanteGT("2026-08-22T02:00:00"));
    const f = await fixture(clock);
    try {
      // La organización ya nace con su horario sembrado; aquí solo se cambia
      // el cierre para probar una ventana más larga de lo normal.
      await f.db
        .update(ventanaSemanal)
        .set({ cierre: "00:00" })
        .where(eq(ventanaSemanal.organizacionId, f.orgId));
      await f.db
        .update(ventanaSemanal)
        .set({ cierre: "06:00" })
        .where(
          and(
            eq(ventanaSemanal.organizacionId, f.orgId),
            eq(ventanaSemanal.weekday, 5),
          ),
        );
      const cli = await f.clientes.crear(
        { nombre: `Madrugada ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.abierta).toBe(true);
      expect(sesion.ventana.fechaOperacion).toBe("2026-08-21");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("01:30 del martes: el portal ACEPTA y lo guarda como operación del lunes", async () => {
    // El bug que motivó todo esto: con el cierre a medianoche que traía el
    // fallback, este pedido se rechazaba. Con `ventana_semanal` como única
    // fuente, la madrugada pertenece a la ventana que abrió el lunes.
    const clock = relojControlado(instanteGT("2026-08-25T01:30:00"));
    const f = await fixture(clock);
    try {
      const tortilla = await f.productos.crear(
        {
          sku: `T-MAD-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla de madrugada",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
          precioBaseCentavos: 1000,
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Madrugada ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { alias: "tortilla de madrugada", precioCentavos: 1000 },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.abierta).toBe(true);
      expect(sesion.ventana.fechaOperacion).toBe("2026-08-24");

      const creado = await f.pedidos.upsertPortal(
        clienteRow,
        { items: [{ productoId: tortilla.id, cantidad: 5 }] },
        meta,
      );
      expect(creado.fechaOperacion).toBe("2026-08-24");

      const [fila] = await f.db
        .select()
        .from(pedido)
        .where(eq(pedido.id, creado.id));
      expect(fila?.fechaOperacion).toBe("2026-08-24");
      // Y se reparte el martes, el día de calendario en el que ya estamos.
      expect(fila?.fechaEntrega).toBe("2026-08-25");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ventana lunes→martes 03:00: el pedido de la madrugada se entrega el martes", async () => {
    // 01:30 del martes 25, dentro de la ventana que abrió el lunes 24 a las 15:00.
    const clock = relojControlado(instanteGT("2026-08-25T01:30:00"));
    const f = await fixture(clock);
    try {
      const tortilla = await f.productos.crear(
        {
          sku: `T-ENT-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla de entrega",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
          precioBaseCentavos: 1000,
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Entrega ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { alias: "tortilla de entrega", precioCentavos: 1000 },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.abierta).toBe(true);
      expect(sesion.ventana.fechaOperacion).toBe("2026-08-24");
      expect(sesion.ventana.fechaEntrega).toBe("2026-08-25");

      const confirmado = await f.pedidos.upsertPortal(
        clienteRow,
        { items: [{ productoId: tortilla.id, cantidad: 5 }] },
        meta,
      );
      expect(confirmado.fechaOperacion).toBe("2026-08-24");
      expect(confirmado.fechaEntrega).toBe("2026-08-25");
      expect(confirmado.textoConfirmacion).toContain("Martes 25 de agosto");

      // Congelada: reconfigurar la ventana no reescribe la entrega ya guardada.
      await f.cfg.guardarVentana(
        {
          dias: WEEKDAYS_ISO.map((weekday) => ({
            weekday,
            activa: true,
            apertura: "15:00",
            cierre: "03:00",
            cruzaMedianoche: true,
          })),
        },
        f.actor,
      );
      const [fila] = await f.db
        .select({ fechaEntrega: pedido.fechaEntrega })
        .from(pedido)
        .where(eq(pedido.id, confirmado.id));
      expect(fila?.fechaEntrega).toBe("2026-08-25");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("ventana del sábado con domingo inactivo entrega el lunes", async () => {
    // 02:00 del domingo 23, dentro de la ventana que abrió el sábado 22.
    const clock = relojControlado(instanteGT("2026-08-23T02:00:00"));
    const f = await fixture(clock);
    try {
      const cli = await f.clientes.crear(
        { nombre: `Sábado ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.fechaOperacion).toBe("2026-08-22");
      expect(sesion.ventana.fechaEntrega).toBe("2026-08-24");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("cambiar el cierre en /configuracion mueve calendario y portal a la vez", async () => {
    // 02:00 del jueves: dentro de la ventana que abrió el miércoles y cierra a
    // las 03:00. Si adelantamos el cierre a la 01:00, esa misma ventana pasa a
    // estar cerrada — y las tres superficies tienen que decir lo mismo, porque
    // leen la misma tabla.
    const now = instanteGT("2026-08-20T02:00:00");
    const f = await fixture(fixedClock(now));
    try {
      const cli = await f.clientes.crear(
        { nombre: `Cambio ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const tortilla = await f.productos.crear(
        {
          sku: `T-CFG-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla de configuración",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
          precioBaseCentavos: 1000,
        },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { alias: "tortilla", precioCentavos: 1000 },
        f.actor,
      );

      const antes = await f.portal.abrirSesion(clienteRow, meta);
      expect(antes.ventana.abierta).toBe(true);
      expect(antes.ventana.fechaOperacion).toBe("2026-08-19");

      await f.cfg.guardarVentana(
        {
          dias: WEEKDAYS_ISO.map((weekday) => ({
            weekday,
            activa: weekday !== 7,
            apertura: "15:00",
            cierre: "01:00",
            cruzaMedianoche: true,
          })),
        },
        f.actor,
      );

      // 1. Lo que devuelve /configuracion.
      const leido = await f.cfg.leerVentana(f.orgId);
      expect(leido.dias.every((d) => d.cierre === "01:00")).toBe(true);

      // 2. El motor de calendario, que es lo que ve el badge del panel.
      const cal = await f.calendar.load(f.orgId);
      expect(cal.isVentanaAbierta(now)).toBe(false);
      expect(cal.getHorarioReferencia(now)).toEqual({
        apertura: "15:00",
        cierre: "01:00",
      });

      // 3. El portal, que valida en servidor con el mismo calendario.
      const despues = await f.portal.abrirSesion(clienteRow, meta);
      expect(despues.ventana.abierta).toBe(false);
      await expect(
        f.pedidos.upsertPortal(
          clienteRow,
          { items: [{ productoId: tortilla.id, cantidad: 5 }] },
          meta,
        ),
      ).rejects.toMatchObject({ code: "VENTANA_CERRADA" });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("apagar un weekday recalcula la entrega de las operaciones nuevas", async () => {
    // Jueves 16:00: la operación del jueves entrega el viernes. Si el viernes
    // se apaga, la siguiente operación tiene que saltar al sábado.
    const now = instanteGT("2026-08-20T16:00:00");
    const f = await fixture(fixedClock(now));
    try {
      const calAntes = await f.calendar.load(f.orgId);
      expect(calAntes.getFechaEntrega("2026-08-20")).toBe("2026-08-21");

      await f.cfg.guardarVentana(
        {
          dias: WEEKDAYS_ISO.map((weekday) => ({
            weekday,
            activa: weekday !== 7 && weekday !== 5,
            apertura: "15:00",
            cierre: "03:00",
            cruzaMedianoche: true,
          })),
        },
        f.actor,
      );

      const calDespues = await f.calendar.load(f.orgId);
      expect(calDespues.isDiaNoLaborable("2026-08-21")).toBe(true);
      expect(calDespues.getFechaEntrega("2026-08-20")).toBe("2026-08-22");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("guardar rellena las filas que faltan, sin reabrir el ciclo en curso", async () => {
    // Sin fallback, una organización sin filas tiene la semana apagada. Guardar
    // desde /configuracion tiene que ser suficiente para salir de ahí.
    const now = instanteGT("2026-08-20T16:00:00");
    const f = await fixture(fixedClock(now));
    try {
      await f.db
        .delete(ventanaSemanal)
        .where(eq(ventanaSemanal.organizacionId, f.orgId));
      expect((await f.calendar.load(f.orgId)).isVentanaAbierta(now)).toBe(false);

      // El formulario propone el horario de fábrica; el admin solo confirma.
      const propuesta = await f.cfg.leerVentana(f.orgId);
      expect(propuesta.dias).toHaveLength(7);
      await f.cfg.guardarVentana({ dias: propuesta.dias }, f.actor);

      // El horario queda guardado y visible…
      const cal = await f.calendar.load(f.orgId);
      expect(cal.getHorarioReferencia(now)).toEqual({
        apertura: "15:00",
        cierre: "03:00",
      });
      const [orgRow] = await f.db
        .select({ noAbrirHasta: organizacion.ventanaNoAbrirHasta })
        .from(organizacion)
        .where(eq(organizacion.id, f.orgId));
      // …pero la guarda anti-reapertura se activa: a las 16:00 el ciclo de las
      // 15:00 ya había empezado, así que configurar el horario NO lo reabre.
      expect(orgRow?.noAbrirHasta).not.toBe(null);
      expect(cal.isVentanaAbierta(now)).toBe(false);
      expect(
        (await f.calendar.load(f.orgId, { ignorarSupresion: true }))
          .isVentanaAbierta(now),
      ).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("adelantar apertura a las 11:00 a las 11:30 no abre el portal", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T11:30:00"));
    const f = await fixture(clock);
    try {
      const cli = await f.clientes.crear(
        { nombre: `Horario ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.cfg.guardarVentana(
        {
          dias: WEEKDAYS_ISO.map((weekday) => ({
            weekday,
            activa: weekday !== 7,
            apertura: "11:00",
            cierre: "00:00",
            cruzaMedianoche: true,
          })),
        },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.abierta).toBe(false);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("14:59 rechaza; 15:00 confirma snapshot; edición no duplica pedido ni outbox", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T14:59:00"));
    const f = await fixture(clock);
    try {
      const tortilla = await f.productos.crear(
        {
          sku: `T16-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const nachos = await f.productos.crear(
        {
          sku: `NACH-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Nachos Blancos Grandes",
          familia: "FRITURA",
          unidadMedida: "BOLSA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const sinPrecio = await f.productos.crear(
        {
          sku: `FAJ-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Fajitas Blancas",
          familia: "FRITURA",
          unidadMedida: "BOLSA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        {
          nombre: `Tabasco E2 ${crypto.randomUUID().slice(0, 8)}`,
          horarioEntregaFijo: "08:30",
        },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { alias: "tortilla grande", precioCentavos: 1250, favorito: true },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        nachos.id,
        { alias: "nachos blancos", precioCentavos: 1500 },
        f.actor,
      );

      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      await expect(
        f.pedidos.upsertPortal(
          clienteRow,
          {
            items: [{ productoId: tortilla.id, cantidad: 50 }],
          },
          meta,
        ),
      ).rejects.toMatchObject({ code: "VENTANA_CERRADA", httpStatus: 409 });

      clock.set(instanteGT("2026-08-20T15:00:00"));
      const sesionCerradaAntes = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesionCerradaAntes.ventana.abierta).toBe(true);
      expect(sesionCerradaAntes.ventana.fechaOperacion).toBe("2026-08-20");
      expect(
        sesionCerradaAntes.catalogo.find((p) => p.productoId === tortilla.id)
          ?.alias,
      ).toBe("tortilla grande");
      expect(
        sesionCerradaAntes.catalogo.find((p) => p.productoId === sinPrecio.id)
          ?.pedible,
      ).toBe(false);

      await expect(
        f.pedidos.upsertPortal(
          clienteRow,
          { items: [{ productoId: sinPrecio.id, cantidad: 1 }] },
          meta,
        ),
      ).rejects.toMatchObject({ code: "PRECIO_AUSENTE" });

      const confirmado = await f.pedidos.upsertPortal(
        clienteRow,
        {
          items: [
            { productoId: tortilla.id, cantidad: 50, precioCentavos: 1 },
            { productoId: nachos.id, cantidad: 8 },
          ],
        },
        meta,
      );
      expect(confirmado.estado).toBe("CONFIRMADO");
      expect(confirmado.origen).toBe("PORTAL");
      expect(confirmado.fechaOperacion).toBe("2026-08-20");
      expect(confirmado.totalCentavos).toBe(74500);
      expect(confirmado.items[0]?.precioUnitarioCentavos).toBe(1250);
      expect(JSON.stringify(confirmado)).not.toContain(token);

      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { precioCentavos: 9999 },
        f.actor,
      );
      const sesionTrasAlza = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesionTrasAlza.pedidoAbierto?.totalCentavos).toBe(74500);
      expect(
        sesionTrasAlza.pedidoAbierto?.items.find(
          (i) => i.productoId === tortilla.id,
        )?.precioUnitarioCentavos,
      ).toBe(1250);

      const editado = await f.pedidos.upsertPortal(
        clienteRow,
        {
          items: [
            { productoId: tortilla.id, cantidad: 40 },
            { productoId: nachos.id, cantidad: 8 },
          ],
        },
        meta,
      );
      expect(editado.correlativo).toBe(confirmado.correlativo);
      expect(editado.totalCentavos).toBe(40 * 1250 + 8 * 1500);

      await f.pedidos.anularPortal(clienteRow, meta);
      const sesionTrasAnular = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesionTrasAnular.pedidoAbierto).toBeNull();

      const auditsAnular = await f.db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.entidadId, confirmado.id),
            eq(auditLog.accion, "portal.anular"),
          ),
        );
      expect(auditsAnular).toHaveLength(1);

      const [pedidoAnulado] = await f.db
        .select()
        .from(pedido)
        .where(eq(pedido.id, confirmado.id));
      expect(pedidoAnulado?.estado).toBe("ANULADO");

      await expect(f.pedidos.anularPortal(clienteRow, meta)).rejects.toMatchObject(
        { code: "NO_ENCONTRADO", httpStatus: 404 },
      );

      const pedidosFilas = await f.db
        .select()
        .from(pedido)
        .where(
          and(
            eq(pedido.clienteId, cli.id),
            eq(pedido.fechaOperacion, "2026-08-20"),
            eq(pedido.origen, "PORTAL"),
          ),
        );
      expect(pedidosFilas).toHaveLength(1);

      const outboxFilas = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, "PedidoConfirmado"),
            eq(outbox.destinatarioId, cli.id),
            eq(outbox.fechaOperacion, "2026-08-20"),
          ),
        );
      expect(outboxFilas).toHaveLength(1);

      const audits = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entidadId, pedidosFilas[0]!.id));
      expect(audits.some((a) => a.accion === "portal.confirmar")).toBe(true);
      expect(audits.some((a) => a.accion === "portal.editar")).toBe(true);
      const editar = audits.find((a) => a.accion === "portal.editar");
      expect(editar?.antes).not.toEqual(editar?.despues);

      const items = await f.db
        .select()
        .from(pedidoItem)
        .where(eq(pedidoItem.pedidoId, pedidosFilas[0]!.id));
      expect(items.every((i) => i.cantidadEntregada === i.cantidadPedida)).toBe(
        true,
      );

      const reconfirmado = await f.pedidos.upsertPortal(
        clienteRow,
        { items: [{ productoId: tortilla.id, cantidad: 10 }] },
        meta,
      );
      expect(reconfirmado.correlativo).toBeGreaterThan(confirmado.correlativo);

      // A medianoche la ventana del jueves sigue viva (cierra a las 03:00);
      // hay que pasarse del cierre real para verla cerrada.
      clock.set(instanteGT("2026-08-21T03:00:00"));
      const sesionCerrada = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesionCerrada.ventana.abierta).toBe(false);

      await expect(f.pedidos.anularPortal(clienteRow, meta)).rejects.toMatchObject(
        { code: "VENTANA_CERRADA", httpStatus: 409 },
      );

      await expect(
        f.pedidos.upsertPortal(
          clienteRow,
          { items: [{ productoId: tortilla.id, cantidad: 10 }] },
          meta,
        ),
      ).rejects.toMatchObject({ code: "VENTANA_CERRADA", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("F-205 cuenta facturas: 10000 − 3000 = 7000, una pendiente", async () => {
    const now = instanteGT("2026-08-20T16:00:00");
    const f = await fixture(fixedClock(now));
    try {
      const prod = await f.productos.crear(
        {
          sku: `CUE-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tostadas #16 Blancas",
          familia: "TOSTADA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        {
          nombre: `Cuenta E2 ${crypto.randomUUID().slice(0, 8)}`,
          limiteFacturasPendientes: 4,
        },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        prod.id,
        { precioCentavos: 1000 },
        f.actor,
      );

      const [pedidoPendiente] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 1,
          fechaOperacion: "2026-08-05",
          fechaEntrega: "2026-08-06",
          clienteId: cli.id,
          estado: "ENTREGADO",
          origen: "MANUAL",
        })
        .returning();
      const [pedidoPagado] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 2,
          fechaOperacion: "2026-08-01",
          fechaEntrega: "2026-08-03",
          clienteId: cli.id,
          estado: "ENTREGADO",
          origen: "MANUAL",
        })
        .returning();

      const [facPend] = await f.db
        .insert(factura)
        .values({
          pedidoId: pedidoPendiente!.id,
          numeroDte: `DTE-100-${crypto.randomUUID().slice(0, 8)}`,
          montoCentavos: 10000,
          emitidaAt: instanteGT("2026-08-10T10:00:00"),
        })
        .returning();
      const [abonoPend] = await f.db
        .insert(abono)
        .values({
          clienteId: cli.id,
          montoCentavos: 3000,
          metodo: "EFECTIVO",
          estado: "CONFIRMADO",
          origen: "MANUAL",
          fecha: "2026-08-10",
        })
        .returning();
      await f.db.insert(pago).values({
        abonoId: abonoPend!.id,
        facturaId: facPend!.id,
        montoCentavos: 3000,
        metodo: "EFECTIVO",
        fecha: "2026-08-10",
      });

      const [facPagada] = await f.db
        .insert(factura)
        .values({
          pedidoId: pedidoPagado!.id,
          numeroDte: `DTE-200-${crypto.randomUUID().slice(0, 8)}`,
          montoCentavos: 1000,
          emitidaAt: instanteGT("2026-08-01T10:00:00"),
        })
        .returning();
      const [abonoPagado] = await f.db
        .insert(abono)
        .values({
          clienteId: cli.id,
          montoCentavos: 1000,
          metodo: "TRANSFERENCIA",
          estado: "CONFIRMADO",
          origen: "MANUAL",
          fecha: "2026-08-02",
        })
        .returning();
      await f.db.insert(pago).values({
        abonoId: abonoPagado!.id,
        facturaId: facPagada!.id,
        montoCentavos: 1000,
        metodo: "TRANSFERENCIA",
        fecha: "2026-08-02",
      });

      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const cuenta = await f.portal.cuentaDe(clienteRow);

      expect(cuenta.facturasPendientes).toBe(1);
      expect(cuenta.limiteFacturasPendientes).toBe(4);
      expect(cuenta.saldoCentavos).toBe(7000);
      expect(cuenta.facturas).toHaveLength(1);
      expect(cuenta.facturas[0]?.saldoCentavos).toBe(7000);
      expect(cuenta.facturas[0]?.antiguedadDias).toBe(10);
      expect(cuenta.facturas[0]?.estado).toBe("ABONO_PARCIAL");
      expect(JSON.stringify(cuenta)).not.toMatch(/cancelad/i);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("portal sigue abierto si el reloj corre aunque el día esté CERRADO", async () => {
    // El seed (y un cierre que no apagó el reloj) marcan CERRADO mientras la
    // ventana 15:00–03:00 sigue viva. Se puede pedir, pero el countdown es el
    // del navbar: «día cerrado · abre a las 15:00», no «cierra a las 03:00».
    const clock = relojControlado(instanteGT("2026-08-20T22:00:00"));
    const f = await fixture(clock);
    try {
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
        { nombre: `Cierre ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1250 }, f.actor);
      await f.db.insert(diaOperacion).values({
        organizacionId: f.orgId,
        fechaOperacion: "2026-08-20",
        estado: "CERRADO",
      });
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ventana.abierta).toBe(true);
      expect(sesion.ventana.diaEstado).toBe("CERRADO");
      expect(sesion.ventana.cierraAt).toBeNull();
      expect(sesion.ventana.proximaAperturaAt).toBe(
        instanteAIso(instanteGT("2026-08-21T15:00:00")),
      );
      const creado = await f.pedidos.upsertPortal(
        clienteRow,
        { items: [{ productoId: prod.id, cantidad: 10 }] },
        meta,
      );
      expect(creado.fechaOperacion).toBe("2026-08-20");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("portal sigue abierto cuando el admin reabre el día fuera de horario", async () => {
    // Viernes 09:00: la ventana del jueves ya venció por reloj. El día 20 está
    // REABIERTO, así que el portal debe seguir capturando sobre esa operación
    // —lo mismo que ya deja hacer el panel— en vez de rotular «cerrada».
    const clock = relojControlado(instanteGT("2026-08-21T09:00:00"));
    const f = await fixture(clock);
    try {
      const prod = await f.productos.crear(
        {
          sku: `REAB-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla reapertura",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Reabierto ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(cli.id, prod.id, { precioCentavos: 1250 }, f.actor);
      await f.db.insert(diaOperacion).values({
        organizacionId: f.orgId,
        fechaOperacion: "2026-08-20",
        estado: "REABIERTO",
        motivoReapertura: "corrección de pedidos",
        reabiertoAt: instanteGT("2026-08-21T08:30:00"),
      });

      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);
      const sesion = await f.portal.abrirSesion(clienteRow, meta);

      expect(sesion.ventana.abierta).toBe(true);
      expect(sesion.ventana.fechaOperacion).toBe("2026-08-20");
      expect(sesion.ventana.diaEstado).toBe("REABIERTO");
      // Sin ventana de reloj no hay cuenta atrás de cierre: lo cierra el
      // admin a mano. La próxima apertura sí se manda para que el portal
      // refresque a las 15:00 —el copy de «abre de nuevo» solo se muestra
      // si `abierta` es false.
      expect(sesion.ventana.cierraAt).toBeNull();
      expect(sesion.ventana.proximaAperturaAt).toBe(
        instanteAIso(instanteGT("2026-08-21T15:00:00")),
      );

      const creado = await f.pedidos.upsertPortal(
        clienteRow,
        { items: [{ productoId: prod.id, cantidad: 10 }] },
        meta,
      );
      expect(creado.fechaOperacion).toBe("2026-08-20");

      const [fila] = await f.db
        .select({ fechaOperacion: pedido.fechaOperacion, origen: pedido.origen })
        .from(pedido)
        .where(eq(pedido.id, creado.id));
      expect(fila?.fechaOperacion).toBe("2026-08-20");
      expect(fila?.origen).toBe("PORTAL");

      // Llega la hora programada: el navbar pasa a «ventana abierta» del
      // viernes. El portal tiene que decir lo mismo —no quedarse en el
      // jueves reabierto ni rotular «cerrada».
      clock.set(instanteGT("2026-08-21T15:00:00"));
      const ejes = await f.calendar.ejes(f.orgId);
      const aLasTres = await f.portal.abrirSesion(clienteRow, meta);
      expect(ejes.ventanaAbierta).toBe(true);
      expect(aLasTres.ventana.abierta).toBe(true);
      expect(aLasTres.ventana.fechaOperacion).toBe("2026-08-21");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("historial: MANUAL y ANULADO propios; 404 cruzado; sin notasAdmin ni sku", async () => {
    const f = await fixture(fixedClock(instanteGT("2026-08-20T16:00:00")));
    try {
      const prod = await f.productos.crear(
        {
          sku: `HIS-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla historial",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cliA = await f.clientes.crear(
        { nombre: `Hist A ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const cliB = await f.clientes.crear(
        { nombre: `Hist B ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(cliA.id, prod.id, { precioCentavos: 1000 }, f.actor);

      const [manual] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 101,
          fechaOperacion: "2026-08-10",
          fechaEntrega: "2026-08-11",
          clienteId: cliA.id,
          estado: "CONFIRMADO",
          origen: "MANUAL",
          notasAdmin: "secreto interno",
        })
        .returning();
      await f.db.insert(pedidoItem).values({
        pedidoId: manual!.id,
        productoId: prod.id,
        cantidadPedida: 5,
        cantidadEntregada: 5,
        precioUnitarioCentavos: 1000,
        nombreMostrado: "tortilla",
        unidadMedida: "LIBRA",
      });

      const [anulado] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 102,
          fechaOperacion: "2026-08-11",
          fechaEntrega: "2026-08-12",
          clienteId: cliA.id,
          estado: "ANULADO",
          origen: "PORTAL",
          anuladoAt: instanteGT("2026-08-11T10:00:00"),
          motivoAnulacion: "error",
        })
        .returning();
      await f.db.insert(pedidoItem).values({
        pedidoId: anulado!.id,
        productoId: prod.id,
        cantidadPedida: 2,
        cantidadEntregada: 2,
        precioUnitarioCentavos: 1000,
        nombreMostrado: "tortilla",
        unidadMedida: "LIBRA",
      });

      const [ajeno] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 103,
          fechaOperacion: "2026-08-12",
          fechaEntrega: "2026-08-13",
          clienteId: cliB.id,
          estado: "CONFIRMADO",
          origen: "MANUAL",
        })
        .returning();

      const { token } = await f.clientes.rotarTokenPortal(cliA.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const historial = await f.portal.listarPedidos(clienteRow, meta, {
        limit: 20,
        offset: 0,
      });
      expect(historial.items).toHaveLength(2);
      expect(historial.items.map((i) => i.estado).sort()).toEqual([
        "ANULADO",
        "CONFIRMADO",
      ]);
      expect(historial.items.some((i) => i.origen === "MANUAL")).toBe(true);
      expect(JSON.stringify(historial)).not.toContain("notasAdmin");
      expect(JSON.stringify(historial)).not.toContain("secreto");
      expect(JSON.stringify(historial)).not.toContain("sku");
      expect(JSON.stringify(historial)).not.toContain("puntoCarga");
      expect(JSON.stringify(historial)).not.toContain(token);

      const detalle = await f.portal.obtenerPedido(
        clienteRow,
        manual!.id,
        meta,
      );
      expect(detalle.correlativo).toBe(101);
      expect(detalle.items).toHaveLength(1);
      expect(JSON.stringify(detalle)).not.toContain("notasAdmin");
      expect(JSON.stringify(detalle)).not.toContain("textoConfirmacion");

      await expect(
        f.portal.obtenerPedido(clienteRow, ajeno!.id, meta),
      ).rejects.toMatchObject({
        code: "NO_ENCONTRADO",
        httpStatus: 404,
        message: MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
      });

      const sesion = await f.portal.abrirSesion(clienteRow, meta);
      expect(sesion.ultimoPedido?.id).toBe(anulado!.id);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("asset portal: foto de producto 200; UUID ajeno/otro org 404", async () => {
    const f = await fixture(fixedClock(instanteGT("2026-08-20T16:00:00")));
    try {
      const bytes = Buffer.from("fake-png-bytes");
      const sha = `sha-${crypto.randomUUID()}`;
      await f.storage.put(sha, bytes, "image/png");
      const [assetRow] = await f.db
        .insert(asset)
        .values({
          key: sha,
          bucket: "fake",
          mime: "image/png",
          size: bytes.length,
          ownerType: "producto",
          ownerId: crypto.randomUUID(),
        })
        .returning();

      const prod = await f.productos.crear(
        {
          sku: `FOTO-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Con foto",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
          fotoAssetId: assetRow!.id,
        },
        f.actor,
      );
      expect(prod.fotoAssetId).toBe(assetRow!.id);

      const cli = await f.clientes.crear(
        { nombre: `Foto ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const content = await f.portal.assetContent(
        clienteRow,
        assetRow!.id,
        "thumb",
      );
      expect(content.bytes.equals(bytes)).toBe(true);
      expect(content.mime).toBe("image/png");

      await expect(
        f.portal.assetContent(clienteRow, crypto.randomUUID()),
      ).rejects.toMatchObject({ code: "NO_ENCONTRADO", httpStatus: 404 });

      const orgB = await crearOrgDePrueba(f.db, "org-b-");
      const shaB = `sha-b-${crypto.randomUUID()}`;
      await f.storage.put(shaB, Buffer.from("otro"), "image/png");
      const [assetB] = await f.db
        .insert(asset)
        .values({
          key: shaB,
          bucket: "fake",
          mime: "image/png",
          size: 4,
          ownerType: "producto",
          ownerId: crypto.randomUUID(),
        })
        .returning();
      await f.db.insert(producto).values({
        organizacionId: orgB!.id,
        sku: `OTRO-${crypto.randomUUID().slice(0, 6)}`,
        nombreCanonico: "Ajeno",
        familia: "TORTILLA",
        unidadMedida: "LIBRA",
        puntoCarga: "PLANTA",
        fotoAssetId: assetB!.id,
      });

      await expect(
        f.portal.assetContent(clienteRow, assetB!.id),
      ).rejects.toMatchObject({ code: "NO_ENCONTRADO", httpStatus: 404 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("bono F-105: aplica devolución a precio 0, restaura al anular, rechaza saldo insuficiente", async () => {
    const clock = relojControlado(instanteGT("2026-08-21T16:00:00"));
    const f = await fixture(clock);
    try {
      const tortilla = await f.productos.crear(
        {
          sku: `BONO-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla bono e2e",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
          precioBaseCentavos: 1000,
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Bono E2E ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      await f.ligas.upsert(
        cli.id,
        tortilla.id,
        { alias: "tortilla", precioCentavos: 1000 },
        f.actor,
      );
      const bono = await f.bonos.otorgar(
        cli.id,
        {
          productoId: tortilla.id,
          descripcion: "quebradita",
          cantidad: 2,
        },
        f.actor,
      );
      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      const clienteRow = await f.tokens.resolver(token);

      const pedidoBono = await f.pedidos.upsertPortal(
        clienteRow,
        {
          items: [
            {
              productoId: tortilla.id,
              cantidad: 1,
              esDevolucion: true,
              bonoId: bono.id,
            },
          ],
        },
        meta,
      );
      expect(pedidoBono.totalCentavos).toBe(0);
      expect(pedidoBono.items[0]?.precioUnitarioCentavos).toBe(0);
      expect(pedidoBono.items[0]?.esDevolucion).toBe(true);

      const [bonoRow] = await f.db
        .select()
        .from(clienteBono)
        .where(eq(clienteBono.id, bono.id));
      expect(bonoRow?.cantidadAplicada).toBe(1);

      const mixto = await f.pedidos.upsertPortal(
        clienteRow,
        {
          items: [
            { productoId: tortilla.id, cantidad: 5, esDevolucion: false },
            {
              productoId: tortilla.id,
              cantidad: 1,
              esDevolucion: true,
              bonoId: bono.id,
            },
          ],
        },
        meta,
      );
      expect(mixto.items).toHaveLength(2);
      expect(mixto.totalCentavos).toBe(5000);

      const lineas = await f.db
        .select()
        .from(pedidoItem)
        .where(eq(pedidoItem.pedidoId, mixto.id));
      expect(lineas.filter((l) => l.esDevolucion)).toHaveLength(1);
      expect(lineas.filter((l) => !l.esDevolucion)).toHaveLength(1);

      await expect(
        f.pedidos.upsertPortal(
          clienteRow,
          {
            items: [
              {
                productoId: tortilla.id,
                cantidad: 99,
                esDevolucion: true,
                bonoId: bono.id,
              },
            ],
          },
          meta,
        ),
      ).rejects.toMatchObject({ code: "BONO_INSUFICIENTE", httpStatus: 409 });

      await f.pedidos.anularPortal(clienteRow, meta);
      const [bonoRestaurado] = await f.db
        .select()
        .from(clienteBono)
        .where(eq(clienteBono.id, bono.id));
      expect(bonoRestaurado?.cantidadAplicada).toBe(0);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
