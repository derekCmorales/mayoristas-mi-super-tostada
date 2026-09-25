import { describe, expect, test } from "bun:test";
import { DateTime } from "luxon";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  cliente,
  conexionWaba,
  conversacion,
  factura,
  hojaProduccion,
  mensaje,
  organizacion,
  outbox,
  pedido,
  pedidoItem,
  producto,
  usuario,
} from "@misupertostada/db";
import {
  META_ERROR_VENTANA_CERRADA,
  TIPO_EVENTO_VENTANA_CERRADA,
  TIPO_OUTBOX_PEDIDO_CONFIRMADO,
  TIPO_OUTBOX_RECORDATORIO,
  ZONA_NEGOCIO,
  extraerCuerpoPlantilla,
  permisosEfectivos,
  permisosPlantilla,
  renderCuerpoPlantilla,
  type Clock,
} from "@misupertostada/shared";
import {
  crearOrgDePrueba,
  openTestDb,
  postgresListo,
} from "../../test/db";
import type { Actor } from "../identity/actor";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { OutboxProcessor } from "../shared/outbox.processor";
import { OutboxDispatcherRegistry } from "../shared/outbox.dispatcher";
import { BusinessCalendarService } from "../shared/calendar.service";
import { PedidoEvents } from "../shared/panel-events";
import { EncryptionService } from "../shared/crypto";
import { DomainException } from "../shared/domain.exception";
import { FakeWhatsAppAdapter } from "./fake.whatsapp";
import { PlantillaService } from "./plantilla.service";
import { WebhookService, metaInboundPayload, metaStatusPayload, metaTemplateStatusPayload } from "./webhook.service";
import { ConversacionService } from "./conversacion.service";
import { MessagingDispatcher } from "./messaging.dispatcher";
import { InvitacionJob } from "./invitacion.job";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
  process.env.APP_ENCRYPTION_KEY ??= "ab".repeat(32);
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const outboxWriter = new OutboxWriter(db);
  const calendar = new BusinessCalendarService(db, clock);
  const events = new PedidoEvents();
  const enc = new EncryptionService();
  const fake = new FakeWhatsAppAdapter();
  const plantillas = new PlantillaService(db);
  const webhooks = new WebhookService(db, clock, audit, events, plantillas);
  const conversaciones = new ConversacionService(
    db,
    clock,
    fake,
    audit,
    outboxWriter,
    events,
    calendar,
    plantillas,
    webhooks,
  );
  const dispatcher = new MessagingDispatcher(
    db,
    clock,
    fake,
    plantillas,
    webhooks,
    enc,
    audit,
    calendar,
  );
  const registry = new OutboxDispatcherRegistry();
  registry.register(dispatcher);
  const processor = new OutboxProcessor(db, registry);
  const invitaciones = new InvitacionJob(db, clock, calendar, outboxWriter, enc);

  const org = await crearOrgDePrueba(db, "org-e7-");
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
  const actorProd: Actor = {
    ...actor,
    rol: "PRODUCCION",
    permisos: permisosPlantilla("PRODUCCION"),
  };
  await plantillas.ensureFakeSeed(org!.id, clock.now());
  // La BD de test es compartida y nunca se limpia: con 4 dígitos aleatorios
  // los números chocan con clientes de corridas viejas y el webhook entrega la
  // conversación a la organización equivocada. 12 dígitos de UUID no chocan.
  const tel = `502${BigInt(`0x${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`)
    .toString()
    .padStart(12, "0")
    .slice(-12)}`;
  const token = `tok-${crypto.randomUUID()}`;
  const [cli] = await db
    .insert(cliente)
    .values({
      organizacionId: org!.id,
      nombre: `Rest ${crypto.randomUUID().slice(0, 6)}`,
      telefonoWa: `+${tel}`,
      tokenPortalHash: `h-${crypto.randomUUID()}`,
      tokenPortalCifrado: enc.encrypt(token),
      activo: true,
    })
    .returning();
  return {
    client,
    db,
    fake,
    webhooks,
    conversaciones,
    dispatcher,
    processor,
    invitaciones,
    plantillas,
    actor,
    actorProd,
    orgId: org!.id,
    cli: cli!,
    tel,
    token,
    crypto,
  };
}

describe.skipIf(!listo)("mensajería E7", () => {
  test("webhook duplicado no crea segunda fila; ventana = ts+24h; status delivered", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T16:00:00"));
    const f = await fixture(clock);
    const ts = Math.floor(instanteGT("2026-08-20T21:00:00").getTime() / 1000);
    const wamid = `wamid.${crypto.randomUUID()}`;
    try {
      const payload = metaInboundPayload({
        waMessageId: wamid,
        from: f.tel,
        timestampUnix: ts,
        body: "50 libras de la grande",
      });
      await f.webhooks.ingest(payload, undefined, undefined);
      await f.webhooks.ingest(payload, undefined, undefined);
      const msgs = await f.db
        .select()
        .from(mensaje)
        .where(eq(mensaje.waMessageId, wamid));
      expect(msgs).toHaveLength(1);
      const [conv] = await f.db
        .select()
        .from(conversacion)
        .where(eq(conversacion.clienteId, f.cli.id));
      expect(conv?.ventanaExpiraAt?.toISOString()).toBe(
        new Date((ts + 24 * 60 * 60) * 1000).toISOString(),
      );
      await f.webhooks.ingest(
        metaStatusPayload({ waMessageId: wamid, status: "read" }),
        undefined,
        undefined,
      );
      const [upd] = await f.db
        .select()
        .from(mensaje)
        .where(eq(mensaje.waMessageId, wamid));
      expect(upd?.status).toBe("read");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("número desconocido queda en audit_log y no crea conversación", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T16:00:00")));
    try {
      const wamid = `wamid.${crypto.randomUUID()}`;
      await f.webhooks.inbound({
        waMessageId: wamid,
        from: "50259999999",
        timestampUnix: 1_787_250_000,
        body: "hola",
      });
      const convs = await f.db.select().from(conversacion);
      expect(convs.filter((c) => c.clienteId === f.cli.id)).toHaveLength(0);
      const logs = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "whatsapp.inbound_desconocido"));
      expect(logs.some((l) => l.entidadId === wamid)).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("texto libre con ventana cerrada es 409 / 131047; plantilla APPROVED sí sale", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T16:00:00"));
    const f = await fixture(clock);
    try {
      const conv = await f.webhooks.ensureConversacion(f.cli.id);
      await expect(
        f.conversaciones.enviar(
          conv.id,
          { tipo: "texto", cuerpo: "Hola", cuerpoRenderizado: "Hola" },
          f.actor,
        ),
      ).rejects.toMatchObject({
        code: "VENTANA_WA_CERRADA",
        httpStatus: 409,
      });
      await expect(
        f.conversaciones.enviar(
          conv.id,
          { tipo: "texto", cuerpo: "Hola", cuerpoRenderizado: "Hola" },
          f.actor,
        ),
      ).rejects.toMatchObject({ message: expect.stringContaining("aviso") });
      expect(META_ERROR_VENTANA_CERRADA).toBe("131047");
      expect(f.fake.envios).toHaveLength(0);

      const tpls = await f.plantillas.listar(f.actor);
      const estado = tpls.find((t) => t.proposito === "ESTADO_CUENTA")!;
      const cuerpo = extraerCuerpoPlantilla(estado.componentes);
      const params = ["3", "Q 1,865.00"];
      const renderizado = renderCuerpoPlantilla(cuerpo, params);
      const enviado = await f.conversaciones.enviar(
        conv.id,
        {
          tipo: "plantilla",
          proposito: "ESTADO_CUENTA",
          params,
          cuerpoRenderizado: renderizado,
        },
        f.actor,
      );
      expect(enviado.waMessageId).toStartWith("wamid.fake.");
      expect(f.fake.envios).toHaveLength(1);
      expect(f.fake.envios[0]?.kind).toBe("template");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("preview mismatch y PRODUCCION sin permiso de envío", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T16:00:00")));
    try {
      const conv = await f.webhooks.ensureConversacion(f.cli.id);
      await expect(
        f.conversaciones.enviar(
          conv.id,
          {
            tipo: "plantilla",
            proposito: "CONFIRMACION",
            params: ["1", "Viernes", "Q 1.00"],
            cuerpoRenderizado: "no coincide",
          },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "PREVIEW_NO_COINCIDE", httpStatus: 409 });
      await expect(
        f.conversaciones.enviar(
          conv.id,
          { tipo: "texto", cuerpo: "Hola", cuerpoRenderizado: "Hola" },
          f.actorProd,
        ),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO", httpStatus: 403 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("pausar plantilla del propósito bloquea el envío sin nombre literal en el despacho", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T16:00:00")));
    try {
      const src = readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), "messaging.dispatcher.ts"),
        "utf8",
      );
      expect(src).not.toContain("mst_invitacion_v1");
      expect(src).not.toContain("mst_confirmacion_v1");
      await f.webhooks.ingest(
        metaTemplateStatusPayload({
          name: "mst_confirmacion_v1",
          language: "es",
          event: "PAUSED",
        }),
        undefined,
        undefined,
      );
      const conv = await f.webhooks.ensureConversacion(f.cli.id);
      await expect(
        f.conversaciones.enviar(
          conv.id,
          {
            tipo: "plantilla",
            proposito: "CONFIRMACION",
            params: ["1", "Viernes 21 de agosto", "Q 1.00"],
            cuerpoRenderizado: renderCuerpoPlantilla(
              extraerCuerpoPlantilla(
                (await f.plantillas.listar(f.actor)).find(
                  (t) => t.proposito === "CONFIRMACION",
                )!.componentes,
              ),
              ["1", "Viernes 21 de agosto", "Q 1.00"],
            ),
          },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "PLANTILLA_NO_APROBADA", httpStatus: 409 });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("18:00 GT: una invitación por cliente; segundo tick no duplica; URL usa token descifrado", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T18:00:00"));
    const f = await fixture(clock);
    try {
      const n1 = await f.invitaciones.tick();
      expect(n1).toBeGreaterThanOrEqual(1);
      const n2 = await f.invitaciones.tick();
      expect(n2).toBe(0);
      const [row] = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, "InvitacionDiaria"),
            eq(outbox.destinatarioId, f.cli.id),
          ),
        );
      expect(row).toBeTruthy();
      expect(await f.processor.processRow(row!.id)).toBe("enviado");
      expect(await f.processor.processRow(row!.id)).toBe("ya_enviado");
      const envios = f.fake.envios.filter((e) => e.kind === "template");
      expect(envios.length).toBe(1);
      expect(envios[0]?.buttonParams?.[0]).toContain(f.token);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("PedidoConfirmado despacha una vez; reintento no duplica wa_message_id", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T16:00:00"));
    const f = await fixture(clock);
    try {
      const sku = `E7-${crypto.randomUUID().slice(0, 8)}`;
      const [prodRow] = await f.db
        .insert(producto)
        .values({
          organizacionId: f.orgId,
          sku,
          nombreCanonico: "Tortillas #16",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        })
        .returning({ id: producto.id });
      const [prod] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 9001,
          fechaOperacion: "2026-08-21",
          fechaEntrega: "2026-08-22",
          clienteId: f.cli.id,
          estado: "CONFIRMADO",
          origen: "PORTAL",
        })
        .returning({ id: pedido.id });
      await f.db.insert(pedidoItem).values({
        pedidoId: prod!.id,
        productoId: prodRow!.id,
        cantidadPedida: 10,
        cantidadEntregada: 10,
        precioUnitarioCentavos: 1250,
        nombreMostrado: "Tortillas #16",
        unidadMedida: "LIBRA",
      });
      const inserted = await f.db
        .insert(outbox)
        .values({
          tipo: TIPO_OUTBOX_PEDIDO_CONFIRMADO,
          destinatarioId: f.cli.id,
          fechaOperacion: "2026-08-21",
          payload: {
            pedidoId: prod!.id,
            clienteId: f.cli.id,
            fechaOperacion: "2026-08-21",
          },
        })
        .returning({ id: outbox.id });
      const id = inserted[0]!.id;
      expect(await f.processor.processRow(id)).toBe("enviado");
      expect(await f.processor.processRow(id)).toBe("ya_enviado");
      await f.dispatcher.dispatch(
        (await f.db.select().from(outbox).where(eq(outbox.id, id)))[0]!,
      );
      const wamids = f.fake.envios.map((e) => e.waMessageId);
      expect(new Set(wamids).size).toBe(wamids.length);
      expect(wamids.length).toBe(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("recordatorio de cobro adjunta PDF; copy Pagado nunca Cancelado", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T16:00:00"));
    const f = await fixture(clock);
    try {
      const [ped] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 9002,
          fechaOperacion: "2026-08-21",
          fechaEntrega: "2026-08-22",
          clienteId: f.cli.id,
          estado: "ENTREGADO",
          origen: "MANUAL",
        })
        .returning({ id: pedido.id });
      await f.db.insert(factura).values({
        pedidoId: ped!.id,
        montoCentavos: 186500,
        numeroDte: `DTE-E7-${crypto.randomUUID().slice(0, 8)}`,
      });
      const r = await f.conversaciones.encolarRecordatorio(f.cli.id, f.actor);
      expect(r.encolado).toBe(true);
      const [row] = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_OUTBOX_RECORDATORIO),
            eq(outbox.destinatarioId, f.cli.id),
          ),
        );
      expect(await f.processor.processRow(row!.id)).toBe("enviado");
      expect(f.fake.uploads.length).toBe(1);
      expect(f.fake.envios.some((e) => e.headerDocumentId)).toBe(true);
      const pdfMod = readFileSync(
        join(
          dirname(fileURLToPath(import.meta.url)),
          "../../../../../packages/pdf/src/estado-cuenta-pdf.tsx",
        ),
        "utf8",
      );
      expect(pdfMod).toContain("COPY_PAGO_COMPLETO");
      expect(pdfMod.toLowerCase()).not.toContain("cancelad");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("recerrar el día no manda segundo consolidado", async () => {
    const clock = relojControlado(instanteGT("2026-08-21T00:05:00"));
    const f = await fixture(clock);
    try {
      await f.db
        .update(conexionWaba)
        .set({ waProduccion: "50240000001" })
        .where(eq(conexionWaba.organizacionId, f.orgId));
      await f.db.insert(hojaProduccion).values({
        organizacionId: f.orgId,
        fechaOperacion: "2026-08-21",
        version: 1,
        snapshot: {
          fechaOperacion: "2026-08-21",
          esSabado: false,
          version: 1,
          productos: [],
          clientes: [],
        },
        texto: "PEDIDO PARA VIERNES",
      });
      const first = await f.db
        .insert(outbox)
        .values({
          tipo: TIPO_EVENTO_VENTANA_CERRADA,
          destinatarioId: f.orgId,
          fechaOperacion: "2026-08-21",
          payload: { organizacionId: f.orgId, fechaOperacion: "2026-08-21", version: 1 },
        })
        .returning({ id: outbox.id });
      expect(await f.processor.processRow(first[0]!.id)).toBe("enviado");
      const before = f.fake.envios.length;
      const second = await f.db
        .insert(outbox)
        .values({
          tipo: TIPO_EVENTO_VENTANA_CERRADA,
          destinatarioId: f.orgId,
          fechaOperacion: "2026-08-21",
          payload: { version: 2 },
        })
        .onConflictDoNothing()
        .returning({ id: outbox.id });
      expect(second).toHaveLength(0);
      expect(f.fake.envios.length).toBe(before);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("listar y obtener enriquecen contexto; obtener no re-lista", async () => {
    const clock = relojControlado(instanteGT("2026-08-20T16:00:00"));
    const f = await fixture(clock);
    try {
      const cal = new BusinessCalendarService(f.db, clock);
      const calData = await cal.load(f.orgId);
      const fechaOp = calData.getFechaOperacion(clock.now());
      const [ped] = await f.db
        .insert(pedido)
        .values({
          organizacionId: f.orgId,
          correlativo: 9010,
          fechaOperacion: fechaOp,
          fechaEntrega: calData.getFechaEntrega(fechaOp),
          clienteId: f.cli.id,
          estado: "CONFIRMADO",
          origen: "PORTAL",
        })
        .returning({ id: pedido.id });
      await f.db.insert(factura).values({
        pedidoId: ped!.id,
        montoCentavos: 50000,
        numeroDte: `DTE-CTX-${crypto.randomUUID().slice(0, 8)}`,
      });
      const ts = Math.floor(instanteGT("2026-08-20T21:00:00").getTime() / 1000);
      await f.webhooks.inbound({
        waMessageId: `wamid.${crypto.randomUUID()}`,
        from: f.tel,
        timestampUnix: ts,
        body: "¿Cuánto debo?",
      });
      const bandeja = await f.conversaciones.listar(f.actor);
      const fila = bandeja.find((c) => c.clienteId === f.cli.id)!;
      expect(fila.pedidoNoche?.correlativo).toBe(9010);
      expect(fila.saldoCentavos).toBe(50000);
      expect(fila.facturasPendientes).toBe(1);

      const listarOriginal = f.conversaciones.listar.bind(f.conversaciones);
      let listarCalls = 0;
      f.conversaciones.listar = async (actor) => {
        listarCalls += 1;
        return listarOriginal(actor);
      };
      const detalle = await f.conversaciones.obtener(fila.id, f.actor);
      expect(listarCalls).toBe(0);
      expect(detalle.pedidoNoche?.id).toBe(ped!.id);
      expect(detalle.mensajes.some((m) => m.direction === "INBOUND")).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("recordatorio encola outbox como en cartera", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T16:00:00")));
    try {
      const r = await f.conversaciones.encolarRecordatorio(f.cli.id, f.actor);
      expect(r.encolado).toBe(true);
      const [row] = await f.db
        .select()
        .from(outbox)
        .where(
          and(
            eq(outbox.tipo, TIPO_OUTBOX_RECORDATORIO),
            eq(outbox.destinatarioId, f.cli.id),
          ),
        );
      expect(row).toBeTruthy();
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("audit de envío guarda plantilla y wa_message_id, no el cuerpo", async () => {
    const f = await fixture(relojControlado(instanteGT("2026-08-20T21:00:00")));
    try {
      const ts = Math.floor(instanteGT("2026-08-20T21:00:00").getTime() / 1000);
      await f.webhooks.inbound({
        waMessageId: `wamid.${crypto.randomUUID()}`,
        from: f.tel,
        timestampUnix: ts,
        body: "secreto del cliente",
      });
      const lista = await f.conversaciones.listar(f.actor);
      const conv = lista[0]!;
      const enviado = await f.conversaciones.enviar(
        conv.id,
        { tipo: "texto", cuerpo: "Recibido, gracias", cuerpoRenderizado: "Recibido, gracias" },
        f.actor,
      );
      const logs = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.accion, "mensajeria.enviar"));
      const mio = logs.find((l) => l.entidadId === enviado.id);
      expect(mio).toBeTruthy();
      const despues = JSON.stringify(mio?.despues ?? {});
      expect(despues).toContain(enviado.waMessageId);
      expect(despues).not.toContain("Recibido, gracias");
      expect(despues).not.toContain("secreto del cliente");
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
