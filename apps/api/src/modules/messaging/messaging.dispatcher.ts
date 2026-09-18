import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  cliente,
  conexionWaba,
  factura,
  hojaProduccion,
  mensaje,
  pago,
  pedido,
  pedidoItem,
} from "@misupertostada/db";
import {
  TIPO_EVENTO_VENTANA_CERRADA,
  TIPO_OUTBOX_INVITACION,
  TIPO_OUTBOX_PEDIDO_CONFIRMADO,
  TIPO_OUTBOX_RECORDATORIO,
  estadoFactura,
  extraerCuerpoPlantilla,
  hojaSnapshotSchema,
  instanteAIso,
  paramsConfirmacion,
  paramsConsolidado,
  paramsEstadoCuenta,
  paramsInvitacion,
  renderCuerpoPlantilla,
  validarParametrosPlantilla,
  type Clock,
  type PlantillaProposito,
} from "@misupertostada/shared";
import { renderEstadoCuentaPdf, renderHojaPdf } from "@misupertostada/pdf";
import { loadEnv } from "../../config/env";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import type { OutboxDispatcher, OutboxRow } from "../shared/outbox.dispatcher";
import { AuditWriter } from "../shared/audit.writer";
import { EncryptionService } from "../shared/crypto";
import { BusinessCalendarService } from "../shared/calendar.service";
import { WHATSAPP_PORT, type WhatsAppPort } from "./whatsapp.port";
import { PlantillaService } from "./plantilla.service";
import { WebhookService } from "./webhook.service";
import { antiguedadDiasDe } from "../receivables/factura-presentacion";

const TIPOS = [
  TIPO_OUTBOX_PEDIDO_CONFIRMADO,
  TIPO_OUTBOX_INVITACION,
  TIPO_OUTBOX_RECORDATORIO,
  TIPO_EVENTO_VENTANA_CERRADA,
] as const;

@Injectable()
export class MessagingDispatcher implements OutboxDispatcher {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WHATSAPP_PORT) private readonly wa: WhatsAppPort,
    private readonly plantillas: PlantillaService,
    private readonly webhooks: WebhookService,
    private readonly crypto: EncryptionService,
    private readonly audit: AuditWriter,
    private readonly calendar: BusinessCalendarService,
  ) {}

  tipos(): readonly string[] {
    return TIPOS;
  }

  async dispatch(row: OutboxRow): Promise<void> {
    if (await this.yaEnviado(row.id)) return;
    const payload = (row.payload ?? {}) as Record<string, unknown>;
    const clienteId = String(payload.clienteId ?? row.destinatarioId);
    if (row.tipo === TIPO_OUTBOX_PEDIDO_CONFIRMADO) {
      await this.confirmacion(row, clienteId);
    } else if (row.tipo === TIPO_OUTBOX_INVITACION) {
      await this.invitacion(row, clienteId);
    } else if (row.tipo === TIPO_OUTBOX_RECORDATORIO) {
      await this.recordatorio(row, clienteId);
    } else if (row.tipo === TIPO_EVENTO_VENTANA_CERRADA) {
      await this.consolidado(row);
    }
  }

  private async confirmacion(row: OutboxRow, clienteId: string): Promise<void> {
    const cli = await this.cliente(clienteId);
    if (!cli?.telefonoWa) return;
    const pedidoId = String((row.payload as { pedidoId?: string }).pedidoId ?? "");
    const [ped] = await this.db
      .select()
      .from(pedido)
      .where(eq(pedido.id, pedidoId))
      .limit(1);
    if (!ped) return;
    const items = await this.db
      .select()
      .from(pedidoItem)
      .where(eq(pedidoItem.pedidoId, ped.id));
    const total = items.reduce(
      (acc, it) => acc + it.cantidadPedida * it.precioUnitarioCentavos,
      0,
    );
    await this.enviarProposito({
      rowId: row.id,
      orgId: cli.organizacionId,
      clienteId: cli.id,
      to: cli.telefonoWa,
      proposito: "CONFIRMACION",
      params: paramsConfirmacion({
        correlativo: ped.correlativo,
        fechaEntrega: ped.fechaEntrega,
        totalCentavos: total,
        horarioEntregaFijo: cli.horarioEntregaFijo,
      }),
    });
  }

  private async invitacion(row: OutboxRow, clienteId: string): Promise<void> {
    const cli = await this.cliente(clienteId);
    if (!cli?.telefonoWa || !cli.tokenPortalCifrado) return;
    const token = this.crypto.decrypt(cli.tokenPortalCifrado);
    if (!token) return;
    const env = loadEnv();
    const cal = await this.calendar.load(cli.organizacionId);
    await this.enviarProposito({
      rowId: row.id,
      orgId: cli.organizacionId,
      clienteId: cli.id,
      to: cli.telefonoWa,
      proposito: "INVITACION",
      params: paramsInvitacion(cal.getFechaEntrega(row.fechaOperacion)),
      buttonParams: [`${env.WEB_ORIGIN}/p/${token}`],
    });
  }

  private async recordatorio(row: OutboxRow, clienteId: string): Promise<void> {
    const cli = await this.cliente(clienteId);
    if (!cli?.telefonoWa) return;
    const cuenta = await this.cuentaPendiente(cli.id);
    const pdf = await renderEstadoCuentaPdf({
      clienteNombre: cli.nombre,
      generadoAt: instanteAIso(this.clock.now()),
      facturasPendientes: cuenta.facturasPendientes,
      saldoCentavos: cuenta.saldoCentavos,
      facturas: cuenta.facturas,
    });
    const upload = await this.wa.uploadDocument({
      organizacionId: cli.organizacionId,
      bytes: pdf,
      mime: "application/pdf",
      filename: `estado-cuenta.pdf`,
    });
    await this.enviarProposito({
      rowId: row.id,
      orgId: cli.organizacionId,
      clienteId: cli.id,
      to: cli.telefonoWa,
      proposito: "ESTADO_CUENTA",
      params: paramsEstadoCuenta({
        pendientes: cuenta.facturasPendientes,
        saldoCentavos: cuenta.saldoCentavos,
      }),
      headerDocumentId: upload.mediaId,
    });
  }

  private async consolidado(row: OutboxRow): Promise<void> {
    const orgId = row.destinatarioId;
    const [conn] = await this.db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, orgId))
      .limit(1);
    const destinos = [conn?.waProduccion, conn?.waTienda].filter(
      (n): n is string => Boolean(n),
    );
    if (destinos.length === 0) {
      await this.marcarDispatch(row.id, "CONSOLIDADO", null);
      return;
    }
    const hojas = await this.db
      .select()
      .from(hojaProduccion)
      .where(
        and(
          eq(hojaProduccion.organizacionId, orgId),
          eq(hojaProduccion.fechaOperacion, row.fechaOperacion),
        ),
      );
    const hoja = hojas.sort((a, b) => b.version - a.version)[0];
    if (!hoja) {
      await this.marcarDispatch(row.id, "CONSOLIDADO", null);
      return;
    }
    const snapshot = hojaSnapshotSchema.parse(hoja.snapshot);
    const pdf = await renderHojaPdf({
      snapshot,
      texto: hoja.texto,
      version: hoja.version,
      generadoAt: instanteAIso(hoja.generadoAt),
    });
    const upload = await this.wa.uploadDocument({
      organizacionId: orgId,
      bytes: pdf,
      mime: "application/pdf",
      filename: `hoja-${row.fechaOperacion}.pdf`,
    });
    const cal = await this.calendar.load(orgId);
    const params = paramsConsolidado({
      fechaOperacion: row.fechaOperacion,
      fechaEntrega: cal.getFechaEntrega(row.fechaOperacion),
      version: hoja.version,
    });
    for (const to of destinos) {
      await this.enviarProposito({
        rowId: row.id,
        orgId,
        clienteId: null,
        to,
        proposito: "CONSOLIDADO",
        params,
        headerDocumentId: upload.mediaId,
      });
    }
  }

  private async enviarProposito(input: {
    rowId: string;
    orgId: string;
    clienteId: string | null;
    to: string;
    proposito: PlantillaProposito;
    params: string[];
    buttonParams?: string[];
    headerDocumentId?: string;
  }): Promise<void> {
    const validacion = validarParametrosPlantilla([
      ...input.params,
      ...(input.buttonParams ?? []),
    ]);
    if (!validacion.ok) throw new Error(validacion.mensaje);
    const tpl = await this.plantillas.resolver(input.orgId, input.proposito);
    const renderizado = renderCuerpoPlantilla(
      extraerCuerpoPlantilla(tpl.componentes),
      input.params,
    );
    const sent = await this.wa.sendTemplate({
      organizacionId: input.orgId,
      to: input.to,
      name: tpl.name,
      language: tpl.language,
      bodyParams: input.params,
      buttonParams: input.buttonParams,
      headerDocumentId: input.headerDocumentId,
    });
    if (input.clienteId) {
      const conv = await this.webhooks.ensureConversacion(input.clienteId);
      await this.db.insert(mensaje).values({
        conversacionId: conv.id,
        waMessageId: sent.waMessageId,
        direction: "OUTBOUND",
        tipo: "plantilla",
        templateName: tpl.name,
        params: { outboxId: input.rowId, proposito: input.proposito },
        bodyRenderizado: renderizado,
        status: "sent",
      });
    }
    await this.marcarDispatch(input.rowId, input.proposito, sent.waMessageId);
  }

  private async marcarDispatch(
    outboxId: string,
    proposito: string,
    waMessageId: string | null,
  ): Promise<void> {
    await this.audit.insert({
      actorTipo: "sistema",
      actorId: "outbox",
      accion: "mensajeria.dispatch",
      entidad: "outbox",
      entidadId: outboxId,
      despues: { proposito, waMessageId },
    });
  }

  private async yaEnviado(outboxId: string): Promise<boolean> {
    const msgs = await this.db.select().from(mensaje);
    if (
      msgs.some((m) => {
        const params = m.params as { outboxId?: string } | null;
        return params?.outboxId === outboxId && Boolean(m.waMessageId);
      })
    ) {
      return true;
    }
    const [prev] = await this.db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.entidadId, outboxId),
          eq(auditLog.accion, "mensajeria.dispatch"),
        ),
      )
      .limit(1);
    return Boolean(prev);
  }

  private async cliente(id: string) {
    const [row] = await this.db.select().from(cliente).where(eq(cliente.id, id)).limit(1);
    return row ?? null;
  }

  private async cuentaPendiente(clienteId: string) {
    const filas = await this.db
      .select()
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(eq(pedido.clienteId, clienteId));
    const ids = filas.map((f) => f.factura.id);
    const pagos = ids.length
      ? await this.db.select().from(pago).where(inArray(pago.facturaId, ids))
      : [];
    const abonoPor = new Map<string, number>();
    for (const p of pagos) {
      abonoPor.set(p.facturaId, (abonoPor.get(p.facturaId) ?? 0) + p.montoCentavos);
    }
    const cal = await this.calendar.load();
    const now = this.clock.now();
    const facturas = [];
    for (const fila of filas) {
      const fac = fila.factura;
      const abonado = abonoPor.get(fac.id) ?? 0;
      const emitida = fac.emitidaAt ?? fac.createdAt;
      const antiguedadDias = antiguedadDiasDe(cal, emitida, now);
      const estado = estadoFactura({
        montoCentavos: fac.montoCentavos,
        abonadoCentavos: abonado,
        antiguedadDias,
      });
      if (estado === "PAGADO") continue;
      facturas.push({
        numeroDte: fac.numeroDte,
        montoCentavos: fac.montoCentavos,
        abonadoCentavos: abonado,
        saldoCentavos: fac.montoCentavos - abonado,
        estado,
        antiguedadDias,
      });
    }
    return {
      facturasPendientes: facturas.length,
      saldoCentavos: facturas.reduce((acc, f) => acc + f.saldoCentavos, 0),
      facturas,
    };
  }
}
