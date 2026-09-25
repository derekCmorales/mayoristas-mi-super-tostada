import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import {
  cliente,
  conversacion,
  factura,
  mensaje,
  pago,
  pedido,
  plantillaProposito,
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
  type PedidoNoche,
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

const abonadoSql = sql<number>`coalesce((
  select sum(${pago.montoCentavos}) from ${pago} where ${pago.facturaId} = ${factura.id}
), 0)::int`;

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
    const now = this.clock.now();
    const cal = await this.calendar.load(actor.organizacionId);
    const fechaOperacionViva = cal.getFechaOperacion(now);

    const rows = await this.db
      .select()
      .from(conversacion)
      .innerJoin(cliente, eq(cliente.id, conversacion.clienteId))
      .where(eq(cliente.organizacionId, actor.organizacionId));

    if (rows.length === 0) return [];

    const convIds = rows.map((r) => r.conversacion.id);
    const clienteIds = rows.map((r) => r.cliente.id);

    const [ultimos, saldos, pedidosNoche] = await Promise.all([
      this.ultimosMensajesPorConversacion(convIds),
      this.saldosPorCliente(clienteIds, actor.organizacionId),
      this.pedidosNochePorCliente(
        clienteIds,
        actor.organizacionId,
        fechaOperacionViva,
      ),
    ]);

    const result = rows.map((row) =>
      this.presentarBandeja({
        row,
        now,
        ultimo: ultimos.get(row.conversacion.id),
        saldo: saldos.get(row.cliente.id) ?? { saldoCentavos: 0, facturasPendientes: 0 },
        pedidoNoche: pedidosNoche.get(row.cliente.id) ?? null,
        fechaOperacionViva,
      }),
    );

    result.sort((a, b) => (b.ultimoAt ?? "").localeCompare(a.ultimoAt ?? ""));
    return result;
  }

  async obtener(id: string, actor: Actor): Promise<ConversacionDetalle> {
    const conv = await this.owned(id, actor.organizacionId);
    const now = this.clock.now();
    const cal = await this.calendar.load(actor.organizacionId);
    const fechaOperacionViva = cal.getFechaOperacion(now);

    const [msgs, ultimo, saldo, pedidoNoche, propositoPorPlantilla] =
      await Promise.all([
        this.db
          .select()
          .from(mensaje)
          .where(eq(mensaje.conversacionId, conv.conversacion.id))
          .orderBy(mensaje.createdAt),
        this.ultimosMensajesPorConversacion([conv.conversacion.id]).then(
          (m) => m.get(conv.conversacion.id),
        ),
        this.saldosPorCliente([conv.cliente.id], actor.organizacionId).then(
          (m) =>
            m.get(conv.cliente.id) ?? {
              saldoCentavos: 0,
              facturasPendientes: 0,
            },
        ),
        this.pedidosNochePorCliente(
          [conv.cliente.id],
          actor.organizacionId,
          fechaOperacionViva,
        ).then((m) => m.get(conv.cliente.id) ?? null),
        this.mapaPropositoPorNombre(actor.organizacionId),
      ]);

    const bandeja = this.presentarBandeja({
      row: conv,
      now,
      ultimo,
      saldo,
      pedidoNoche,
      fechaOperacionViva,
    });

    return conversacionDetalleSchema.parse({
      ...bandeja,
      mensajes: msgs.map((m) =>
        presentarMensaje(m, propositoPorPlantilla.get(m.templateName ?? "")),
      ),
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

  private presentarBandeja(input: {
    row: {
      conversacion: typeof conversacion.$inferSelect;
      cliente: typeof cliente.$inferSelect;
    };
    now: Date;
    ultimo?: { bodyRenderizado: string | null; createdAt: Date };
    saldo: { saldoCentavos: number; facturasPendientes: number };
    pedidoNoche: PedidoNoche | null;
    fechaOperacionViva: string;
  }): ConversacionBandeja {
    const { row, now, ultimo, saldo, pedidoNoche, fechaOperacionViva } = input;
    return conversacionBandejaSchema.parse({
      id: row.conversacion.id,
      clienteId: row.cliente.id,
      clienteNombre: row.cliente.nombre,
      telefonoWa: row.cliente.telefonoWa,
      ventanaExpiraAt: row.conversacion.ventanaExpiraAt
        ? instanteAIso(row.conversacion.ventanaExpiraAt)
        : null,
      ventanaAbierta: ventanaWaAbierta(row.conversacion.ventanaExpiraAt, now),
      ultimoInboundAt: row.conversacion.ultimoInboundAt
        ? instanteAIso(row.conversacion.ultimoInboundAt)
        : null,
      noLeidos: row.conversacion.noLeidos,
      ultimoCuerpo: ultimo?.bodyRenderizado ?? null,
      ultimoAt: ultimo ? instanteAIso(ultimo.createdAt) : null,
      horarioEntregaFijo: row.cliente.horarioEntregaFijo
        ? row.cliente.horarioEntregaFijo.slice(0, 5)
        : null,
      notasPermanentes: row.cliente.notasPermanentes,
      saldoCentavos: saldo.saldoCentavos,
      facturasPendientes: saldo.facturasPendientes,
      pedidoNoche,
      fechaOperacionViva,
    });
  }

  private async ultimosMensajesPorConversacion(
    conversacionIds: string[],
  ): Promise<
    Map<string, { bodyRenderizado: string | null; createdAt: Date }>
  > {
    if (conversacionIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([mensaje.conversacionId], {
        conversacionId: mensaje.conversacionId,
        bodyRenderizado: mensaje.bodyRenderizado,
        createdAt: mensaje.createdAt,
      })
      .from(mensaje)
      .where(inArray(mensaje.conversacionId, conversacionIds))
      .orderBy(mensaje.conversacionId, desc(mensaje.createdAt), desc(mensaje.id));

    const map = new Map<string, { bodyRenderizado: string | null; createdAt: Date }>();
    for (const row of rows) {
      map.set(row.conversacionId, {
        bodyRenderizado: row.bodyRenderizado,
        createdAt: row.createdAt,
      });
    }
    return map;
  }

  private async saldosPorCliente(
    clienteIds: string[],
    organizacionId: string,
  ): Promise<Map<string, { saldoCentavos: number; facturasPendientes: number }>> {
    if (clienteIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        clienteId: pedido.clienteId,
        monto: factura.montoCentavos,
        abonado: abonadoSql,
      })
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(
          inArray(pedido.clienteId, clienteIds),
          eq(pedido.organizacionId, organizacionId),
          sql`${factura.montoCentavos} > ${abonadoSql}`,
        ),
      );

    const map = new Map<string, { saldoCentavos: number; facturasPendientes: number }>();
    for (const id of clienteIds) {
      map.set(id, { saldoCentavos: 0, facturasPendientes: 0 });
    }
    for (const row of rows) {
      const saldo = row.monto - Number(row.abonado);
      const slot = map.get(row.clienteId)!;
      slot.facturasPendientes += 1;
      slot.saldoCentavos += saldo;
    }
    return map;
  }

  private async pedidosNochePorCliente(
    clienteIds: string[],
    organizacionId: string,
    fechaOperacion: string,
  ): Promise<Map<string, PedidoNoche>> {
    if (clienteIds.length === 0) return new Map();

    const rows = await this.db
      .select({
        id: pedido.id,
        clienteId: pedido.clienteId,
        correlativo: pedido.correlativo,
        estado: pedido.estado,
        fechaOperacion: pedido.fechaOperacion,
      })
      .from(pedido)
      .where(
        and(
          inArray(pedido.clienteId, clienteIds),
          eq(pedido.organizacionId, organizacionId),
          eq(pedido.fechaOperacion, fechaOperacion),
          ne(pedido.estado, "ANULADO"),
        ),
      )
      .orderBy(desc(pedido.correlativo));

    const map = new Map<string, PedidoNoche>();
    for (const row of rows) {
      if (map.has(row.clienteId)) continue;
      map.set(row.clienteId, {
        id: row.id,
        correlativo: row.correlativo,
        estado: row.estado,
        fechaOperacion: row.fechaOperacion,
      });
    }
    return map;
  }

  private async mapaPropositoPorNombre(
    organizacionId: string,
  ): Promise<Map<string, PlantillaProposito>> {
    const rows = await this.db
      .select({
        name: plantillaWa.name,
        proposito: plantillaProposito.proposito,
      })
      .from(plantillaProposito)
      .innerJoin(plantillaWa, eq(plantillaWa.id, plantillaProposito.plantillaWaId))
      .where(eq(plantillaProposito.organizacionId, organizacionId));

    const map = new Map<string, PlantillaProposito>();
    for (const row of rows) {
      map.set(row.name, row.proposito as PlantillaProposito);
    }
    return map;
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
    const propositoPorNombre = await this.mapaPropositoPorNombre(
      input.actor.organizacionId,
    );
    return presentarMensaje(
      row,
      propositoPorNombre.get(input.templateName ?? ""),
    );
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

function presentarMensaje(
  row: typeof mensaje.$inferSelect,
  proposito?: PlantillaProposito,
): MensajePublico {
  return mensajePublicoSchema.parse({
    id: row.id,
    waMessageId: row.waMessageId,
    direction: row.direction,
    tipo: row.tipo,
    templateName: row.templateName,
    proposito: proposito ?? null,
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
