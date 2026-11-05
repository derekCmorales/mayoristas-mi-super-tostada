import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { cliente, organizacion } from "@misupertostada/db";
import {
  HORA_INVITACION,
  cambiarEnvioAutomaticoRequestSchema,
  envioAutomaticoEstadoSchema,
  revisarTelefonoWa,
  type EnvioAutomaticoEstado,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";

/**
 * Interruptor de los avisos automáticos de WhatsApp (invitación diaria y
 * confirmación de pedido). El estado de cuenta no pasa por aquí: solo sale
 * cuando una persona lo manda.
 */
@Injectable()
export class EnvioAutomaticoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
  ) {}

  async activo(organizacionId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ activo: organizacion.envioAutomaticoActivo })
      .from(organizacion)
      .where(eq(organizacion.id, organizacionId))
      .limit(1);
    return row?.activo ?? false;
  }

  async estado(actor: Actor): Promise<EnvioAutomaticoEstado> {
    const clientes = await this.db
      .select({
        telefonoWa: cliente.telefonoWa,
        tokenPortalCifrado: cliente.tokenPortalCifrado,
      })
      .from(cliente)
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(cliente.activo, true),
        ),
      );
    const conteo = { activos: clientes.length, listos: 0, sinWhatsapp: 0, whatsappInvalido: 0, sinPortal: 0 };
    for (const c of clientes) {
      const tel = revisarTelefonoWa(c.telefonoWa);
      if (tel.estado === "SIN_NUMERO") conteo.sinWhatsapp += 1;
      else if (!tel.e164) conteo.whatsappInvalido += 1;
      else if (!c.tokenPortalCifrado) conteo.sinPortal += 1;
      else conteo.listos += 1;
    }
    return envioAutomaticoEstadoSchema.parse({
      activo: await this.activo(actor.organizacionId),
      horaInvitacion: HORA_INVITACION,
      clientes: conteo,
    });
  }

  async cambiar(body: unknown, actor: Actor): Promise<EnvioAutomaticoEstado> {
    const input = parseBody(cambiarEnvioAutomaticoRequestSchema, body);
    const antes = await this.activo(actor.organizacionId);
    if (antes !== input.activo) {
      const [row] = await this.db
        .update(organizacion)
        .set({ envioAutomaticoActivo: input.activo })
        .where(eq(organizacion.id, actor.organizacionId))
        .returning({ id: organizacion.id });
      if (!row) {
        throw new DomainException("NO_ENCONTRADO", "Organización no encontrada", 404);
      }
      await this.audit.insert({
        actorTipo: "usuario",
        actorId: actor.usuarioId,
        accion: input.activo
          ? "mensajeria.envio_automatico.encender"
          : "mensajeria.envio_automatico.apagar",
        entidad: "organizacion",
        entidadId: actor.organizacionId,
        antes: { envioAutomaticoActivo: antes },
        despues: { envioAutomaticoActivo: input.activo },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
    }
    return this.estado(actor);
  }
}
