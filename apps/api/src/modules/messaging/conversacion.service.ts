import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq } from "drizzle-orm";
import {
  cliente,
  conversacion,
  mensaje,
  plantillaWa,
} from "@misupertostada/db";
import {
  MENSAJE_PREVIEW_NO_COINCIDE,
  MENSAJE_VENTANA_WA_CERRADA,
  META_ERROR_VENTANA_CERRADA,
  TIPO_OUTBOX_RECORDATORIO,
  conversacionBandejaSchema,
  conversacionDetalleSchema,
  enviarMensajeRequestSchema,
  extraerCuerpoPlantilla,
  instanteAIso,
  mensajePublicoSchema,
  renderCuerpoPlantilla,
  simularInboundRequestSchema,
  tienePermiso,
  validarParametrosPlantilla,
  ventanaWaAbierta,
  type Clock,
  type ConversacionBandeja,
  type ConversacionDetalle,
  type MensajePublico,
  type PlantillaProposito,
} from "@misupertostada/shared";
import { loadEnv } from "../../config/env";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { BusinessCalendarService } from "../shared/calendar.service";
import type { Actor } from "../identity/actor";
import { WHATSAPP_PORT, type WhatsAppPort } from "./whatsapp.port";
import { PlantillaService } from "./plantilla.service";
import { WebhookService } from "./webhook.service";

@Injectable()
export class ConversacionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WHATSAPP_PORT) private readonly wa: WhatsAppPort,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly events: PedidoEvents,
    private readonly calendar: BusinessCalendarService,
    private readonly plantillas: PlantillaService,
    private readonly webhooks: WebhookService,
  ) {}

  async listar(actor: Actor): Promise<ConversacionBandeja[]> {
    const rows = await this.db
      .select()
      .from(conversacion)
      .innerJoin(cliente, eq(cliente.id, conversacion.clienteId))
      .where(eq(cliente.organizacionId, actor.organizacionId));
    const now = this.clock.now();
    const result: ConversacionBandeja[] = [];
    for (const row of rows) {
      const [ultimo] = await this.db
        .select()
        .from(mensaje)
        .where(eq(mensaje.conversacionId, row.conversacion.id))
        .orderBy(desc(mensaje.createdAt))
        .limit(1);
      result.push(
        conversacionBandejaSchema.parse({
          id: row.conversacion.id,
          clienteId: row.cliente.id,
          clienteNombre: row.cliente.nombre,
          telefonoWa: row.cliente.telefonoWa,
          ventanaExpiraAt: row.conversacion.ventanaExpiraAt
            ? instanteAIso(row.conversacion.ventanaExpiraAt)
            : null,
          ventanaAbierta: ventanaWaAbierta(
            row.conversacion.ventanaExpiraAt,
            now,
          ),
          ultimoInboundAt: row.conversacion.ultimoInboundAt
            ? instanteAIso(row.conversacion.ultimoInboundAt)
            : null,
          noLeidos: row.conversacion.noLeidos,
          ultimoCuerpo: ultimo?.bodyRenderizado ?? null,
          ultimoAt: ultimo ? instanteAIso(ultimo.createdAt) : null,
        }),
      );
    }
    result.sort((a, b) => (b.ultimoAt ?? "").localeCompare(a.ultimoAt ?? ""));
    return result;
  }

  async obtener(id: string, actor: Actor): Promise<ConversacionDetalle> {
    const conv = await this.owned(id, actor.organizacionId);
    const msgs = await this.db
      .select()
      .from(mensaje)
      .where(eq(mensaje.conversacionId, conv.conversacion.id))
      .orderBy(mensaje.createdAt);
    const bandeja = (await this.listar(actor)).find((c) => c.id === id);
    if (!bandeja) {
      throw new DomainException("NO_ENCONTRADO", "Conversación no encontrada", 404);
    }
    return conversacionDetalleSchema.parse({
      ...bandeja,
      horarioEntregaFijo: conv.cliente.horarioEntregaFijo,
      mensajes: msgs.map(presentarMensaje),
    });
  }

  async marcarLeidos(id: string, actor: Actor): Promise<ConversacionDetalle> {
    await this.owned(id, actor.organizacionId);
    await this.db
      .update(conversacion)
      .set({ noLeidos: 0 })
      .where(eq(conversacion.id, id));
    return this.obtener(id, actor);
  }

  async enviar(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<MensajePublico> {
    if (!tienePermiso(actor.permisos, "mensajeria.enviar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(enviarMensajeRequestSchema, body);
    const conv = await this.owned(id, actor.organizacionId);
    const to = conv.cliente.telefonoWa;
    if (!to) {
      throw new DomainException(
        "VALIDACION",
        "El cliente no tiene teléfono de WhatsApp",
        400,
      );
    }
    const now = this.clock.now();
    const abierta = ventanaWaAbierta(conv.conversacion.ventanaExpiraAt, now);

    if (input.tipo === "texto") {
      if (!abierta) {
        throw new DomainException(
          "VENTANA_WA_CERRADA",
          MENSAJE_VENTANA_WA_CERRADA,
          409,
        );
      }
      if (input.cuerpoRenderizado !== input.cuerpo) {
        throw new DomainException("PREVIEW_NO_COINCIDE", MENSAJE_PREVIEW_NO_COINCIDE, 409);
      }
      const sent = await this.wa.sendText({
        organizacionId: actor.organizacionId,
        to,
        body: input.cuerpo,
      });
      return this.persistirOutbound({
        conv,
        actor,
        waMessageId: sent.waMessageId,
        tipo: "texto",
        templateName: null,
        bodyRenderizado: input.cuerpo,
        params: null,
      });
    }

    const tpl = input.plantillaId
      ? await this.plantillaPorId(input.plantillaId, actor.organizacionId)
      : await this.plantillas.resolver(
          actor.organizacionId,
          exigidoProposito(input.proposito),
        );
    if (tpl.status !== "APPROVED") {
      throw new DomainException(
        "PLANTILLA_NO_APROBADA",
        "Esa plantilla no está aprobada. Meta puede haberla pausado.",
        409,
      );
    }
    const params = input.params ?? [];
    const validacion = validarParametrosPlantilla(params);
    if (!validacion.ok) {
      throw new DomainException("VALIDACION", validacion.mensaje, 400);
    }
    const cuerpo = extraerCuerpoPlantilla(tpl.componentes);
    const renderizado = renderCuerpoPlantilla(cuerpo, params);
    if (renderizado !== input.cuerpoRenderizado) {
      throw new DomainException("PREVIEW_NO_COINCIDE", MENSAJE_PREVIEW_NO_COINCIDE, 409);
    }
    const sent = await this.wa.sendTemplate({
      organizacionId: actor.organizacionId,
      to,
      name: tpl.name,
      language: tpl.language,
      bodyParams: params,
    });
    return this.persistirOutbound({
      conv,
      actor,
      waMessageId: sent.waMessageId,
      tipo: "plantilla",
      templateName: tpl.name,
      bodyRenderizado: renderizado,
      params,
    });
  }

  async simularInbound(id: string, body: unknown, actor: Actor): Promise<void> {
    if (loadEnv().NODE_ENV === "production") {
      throw new DomainException("NO_DISPONIBLE", "No disponible en producción", 404);
    }
    const input = parseBody(simularInboundRequestSchema, body);
    const conv = await this.owned(id, actor.organizacionId);
    const from = conv.cliente.telefonoWa ?? input.from;
    const ts =
      input.timestamp ??
      Math.floor(this.clock.now().getTime() / 1000);
    await this.webhooks.inbound({
      waMessageId: `wamid.sim.${crypto.randomUUID()}`,
      from,
      timestampUnix: ts,
      body: input.body,
    });
  }

  async encolarRecordatorio(clienteId: string, actor: Actor): Promise<{ encolado: boolean }> {
    if (!tienePermiso(actor.permisos, "mensajeria.enviar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const [cli] = await this.db
      .select()
      .from(cliente)
      .where(
        and(
          eq(cliente.id, clienteId),
          eq(cliente.organizacionId, actor.organizacionId),
        ),
      )
      .limit(1);
    if (!cli) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    const cal = await this.calendar.load();
    const fechaOperacion = cal.getFechaOperacion(this.clock.now());
    const row = await this.outbox.insert({
      tipo: TIPO_OUTBOX_RECORDATORIO,
      destinatarioId: cli.id,
      fechaOperacion,
      payload: { clienteId: cli.id, fechaOperacion },
    });
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "mensajeria.recordatorio",
      entidad: "cliente",
      entidadId: cli.id,
      despues: { fechaOperacion, encolado: Boolean(row) },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { encolado: Boolean(row) };
  }

  async ensureConversacion(clienteId: string) {
    return this.webhooks.ensureConversacion(clienteId);
  }

  private async persistirOutbound(input: {
    conv: Awaited<ReturnType<ConversacionService["owned"]>>;
    actor: Actor;
    waMessageId: string;
    tipo: string;
    templateName: string | null;
    bodyRenderizado: string;
    params: unknown;
  }): Promise<MensajePublico> {
    const [row] = await this.db
      .insert(mensaje)
      .values({
        conversacionId: input.conv.conversacion.id,
        waMessageId: input.waMessageId,
        direction: "OUTBOUND",
        tipo: input.tipo,
        templateName: input.templateName,
        params: input.params,
        bodyRenderizado: input.bodyRenderizado,
        status: "sent",
        enviadoPor: input.actor.usuarioId,
      })
      .returning();
    if (!row) {
      throw new DomainException("VALIDACION", "No se pudo guardar el mensaje", 500);
    }
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: input.actor.usuarioId,
      accion: "mensajeria.enviar",
      entidad: "mensaje",
      entidadId: row.id,
      despues: {
        plantilla: input.templateName,
        waMessageId: input.waMessageId,
        tipo: input.tipo,
      },
      ip: input.actor.ip,
      userAgent: input.actor.userAgent,
    });
    this.events.emit({
      tipo: "mensaje.nuevo",
      organizacionId: input.actor.organizacionId,
      conversacionId: input.conv.conversacion.id,
      mensajeId: row.id,
      clienteId: input.conv.cliente.id,
    });
    return presentarMensaje(row);
  }

  private async plantillaPorId(id: string, orgId: string) {
    const [tpl] = await this.db
      .select()
      .from(plantillaWa)
      .where(and(eq(plantillaWa.id, id), eq(plantillaWa.organizacionId, orgId)))
      .limit(1);
    if (!tpl) {
      throw new DomainException("NO_ENCONTRADO", "Plantilla no encontrada", 404);
    }
    return tpl;
  }

  private async owned(id: string, orgId: string) {
    const [row] = await this.db
      .select()
      .from(conversacion)
      .innerJoin(cliente, eq(cliente.id, conversacion.clienteId))
      .where(and(eq(conversacion.id, id), eq(cliente.organizacionId, orgId)))
      .limit(1);
    if (!row) {
      throw new DomainException("NO_ENCONTRADO", "Conversación no encontrada", 404);
    }
    return row;
  }
}

function presentarMensaje(row: typeof mensaje.$inferSelect): MensajePublico {
  return mensajePublicoSchema.parse({
    id: row.id,
    waMessageId: row.waMessageId,
    direction: row.direction,
    tipo: row.tipo,
    templateName: row.templateName,
    bodyRenderizado: row.bodyRenderizado,
    status: row.status,
    errorCode: row.errorCode,
    createdAt: instanteAIso(row.createdAt),
  });
}

function exigidoProposito(
  proposito: PlantillaProposito | undefined,
): PlantillaProposito {
  if (!proposito) {
    throw new DomainException(
      "VALIDACION",
      "Indique plantilla o propósito",
      400,
    );
  }
  return proposito;
}

void META_ERROR_VENTANA_CERRADA;
