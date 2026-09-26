import { Inject, Injectable } from "@nestjs/common";
import { eq, sql } from "drizzle-orm";
import { cliente, conversacion, mensaje } from "@misupertostada/db";
import {
  normalizarTelefonoWa,
  ventanaExpiraAtDesdeWebhook,
} from "@misupertostada/shared";
import { loadEnv } from "../../config/env";
import { DRIZZLE, CLOCK } from "../shared/tokens";
import type { Clock } from "@misupertostada/shared";
import type { AppDatabase } from "../shared/database.module";
import { PedidoEvents } from "../shared/panel-events";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import { PlantillaService } from "./plantilla.service";
import { verificarFirmaMeta } from "./graph.whatsapp";

type MetaChangeValue = {
  messages?: Array<{
    id: string;
    from: string;
    timestamp: string;
    type?: string;
    text?: { body?: string };
    button?: { text?: string; payload?: string };
  }>;
  statuses?: Array<{
    id: string;
    status: string;
    errors?: Array<{ code?: number }>;
  }>;
  message_template_name?: string;
  message_template_language?: string;
  message_template_id?: number | string;
  event?: string;
  reason?: string;
};

export type MetaPayload = {
  object?: string;
  entry?: Array<{
    /** WABA que origina el evento: separa tenants en un tech provider. */
    id?: string;
    changes?: Array<{ field?: string; value?: MetaChangeValue }>;
  }>;
};

@Injectable()
export class WebhookService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly audit: AuditWriter,
    private readonly events: PedidoEvents,
    private readonly plantillas: PlantillaService,
  ) {}

  verify(
    mode: string | undefined,
    token: string | undefined,
    challenge: string | undefined,
  ): string {
    const env = loadEnv();
    if (mode !== "subscribe" || !challenge) {
      throw new DomainException("VALIDACION", "Challenge inválido", 403);
    }
    if (env.META_VERIFY_TOKEN && token !== env.META_VERIFY_TOKEN) {
      throw new DomainException("VALIDACION", "Verify token inválido", 403);
    }
    return challenge;
  }

  async ingest(
    body: unknown,
    rawBody: Buffer | undefined,
    signature: string | undefined,
  ): Promise<void> {
    const env = loadEnv();
    if (env.NODE_ENV === "production" && env.META_APP_SECRET) {
      if (
        !rawBody ||
        !verificarFirmaMeta(rawBody, signature, env.META_APP_SECRET)
      ) {
        throw new DomainException("VALIDACION", "Firma de webhook inválida", 403);
      }
    }
    const payload = (body ?? {}) as MetaPayload;
    for (const entry of payload.entry ?? []) {
      for (const change of entry.changes ?? []) {
        if (change.field === "message_template_status_update") {
          const value = change.value;
          if (value?.message_template_name && value.event) {
            await this.plantillas.actualizarStatus(
              value.message_template_name,
              value.message_template_language ?? "es",
              value.event,
              this.clock.now(),
              {
                wabaId: entry.id,
                motivo: value.reason && value.reason !== "NONE" ? value.reason : null,
              },
            );
          }
          continue;
        }
        await this.mensajes(change.value);
        await this.estados(change.value);
      }
    }
  }

  async inbound(input: {
    waMessageId: string;
    from: string;
    timestampUnix: number;
    body: string;
  }): Promise<void> {
    const digitos = normalizarTelefonoWa(input.from);
    const clientes = await this.db.select().from(cliente);
    const cli = clientes.find(
      (c) => c.telefonoWa && normalizarTelefonoWa(c.telefonoWa) === digitos,
    );
    if (!cli) {
      await this.audit.insert({
        actorTipo: "sistema",
        actorId: "whatsapp",
        accion: "whatsapp.inbound_desconocido",
        entidad: "whatsapp_inbound",
        entidadId: input.waMessageId,
        despues: { from: digitos },
      });
      return;
    }

    const conv = await this.ensureConversacion(cli.id);
    const expira = ventanaExpiraAtDesdeWebhook(input.timestampUnix);
    await this.db
      .update(conversacion)
      .set({
        ventanaExpiraAt: expira,
        ultimoInboundAt: new Date(input.timestampUnix * 1000),
        noLeidos: sql`${conversacion.noLeidos} + 1`,
      })
      .where(eq(conversacion.id, conv.id));

    const inserted = await this.db
      .insert(mensaje)
      .values({
        conversacionId: conv.id,
        waMessageId: input.waMessageId,
        direction: "INBOUND",
        tipo: "texto",
        bodyRenderizado: input.body,
        status: "delivered",
      })
      .onConflictDoNothing()
      .returning({ id: mensaje.id });

    if (!inserted[0]) return;

    this.events.emit({
      tipo: "mensaje.nuevo",
      organizacionId: cli.organizacionId,
      conversacionId: conv.id,
      mensajeId: inserted[0].id,
      clienteId: cli.id,
    });
  }

  private async mensajes(value: MetaChangeValue | undefined): Promise<void> {
    for (const msg of value?.messages ?? []) {
      await this.inbound({
        waMessageId: msg.id,
        from: msg.from,
        timestampUnix: Number(msg.timestamp),
        body:
          msg.text?.body ?? msg.button?.text ?? msg.button?.payload ?? "",
      });
    }
  }

  private async estados(value: MetaChangeValue | undefined): Promise<void> {
    for (const st of value?.statuses ?? []) {
      const [row] = await this.db
        .select()
        .from(mensaje)
        .where(eq(mensaje.waMessageId, st.id))
        .limit(1);
      if (!row) continue;
      const errorCode = st.errors?.[0]?.code
        ? String(st.errors[0].code)
        : null;
      await this.db
        .update(mensaje)
        .set({ status: st.status, errorCode })
        .where(eq(mensaje.id, row.id));
      const [conv] = await this.db
        .select()
        .from(conversacion)
        .where(eq(conversacion.id, row.conversacionId))
        .limit(1);
      if (!conv) continue;
      const [cli] = await this.db
        .select()
        .from(cliente)
        .where(eq(cliente.id, conv.clienteId))
        .limit(1);
      if (!cli) continue;
      this.events.emit({
        tipo: "mensaje.estado",
        organizacionId: cli.organizacionId,
        conversacionId: conv.id,
        mensajeId: row.id,
        clienteId: cli.id,
      });
    }
  }

  async ensureConversacion(clienteId: string) {
    const [existente] = await this.db
      .select()
      .from(conversacion)
      .where(eq(conversacion.clienteId, clienteId))
      .limit(1);
    if (existente) return existente;
    const inserted = await this.db
      .insert(conversacion)
      .values({ clienteId, noLeidos: 0 })
      .onConflictDoNothing()
      .returning();
    if (inserted[0]) return inserted[0];
    const [again] = await this.db
      .select()
      .from(conversacion)
      .where(eq(conversacion.clienteId, clienteId))
      .limit(1);
    if (!again) {
      throw new DomainException(
        "VALIDACION",
        "No se pudo abrir la conversación",
        500,
      );
    }
    return again;
  }
}

export function metaInboundPayload(input: {
  waMessageId: string;
  from: string;
  timestampUnix: number;
  body: string;
}): MetaPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              messages: [
                {
                  id: input.waMessageId,
                  from: input.from,
                  timestamp: String(input.timestampUnix),
                  type: "text",
                  text: { body: input.body },
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function metaStatusPayload(input: {
  waMessageId: string;
  status: string;
  errorCode?: string;
}): MetaPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "messages",
            value: {
              statuses: [
                {
                  id: input.waMessageId,
                  status: input.status,
                  errors: input.errorCode
                    ? [{ code: Number(input.errorCode) }]
                    : undefined,
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function metaTemplateStatusPayload(input: {
  name: string;
  language: string;
  event: string;
}): MetaPayload {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        changes: [
          {
            field: "message_template_status_update",
            value: {
              message_template_name: input.name,
              message_template_language: input.language,
              event: input.event,
            },
          },
        ],
      },
    ],
  };
}
