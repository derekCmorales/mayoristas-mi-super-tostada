import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { cliente, organizacion } from "@misupertostada/db";
import {
  HORA_INVITACION,
  TIPO_OUTBOX_INVITACION,
  horaEnZona,
  telefonoWaParaEnvio,
  type Clock,
} from "@misupertostada/shared";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { OutboxWriter } from "../shared/outbox.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { EncryptionService } from "../shared/crypto";

@Injectable()
export class InvitacionJob {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly calendar: BusinessCalendarService,
    private readonly outbox: OutboxWriter,
    private readonly crypto: EncryptionService,
  ) {}

  async tick(): Promise<number> {
    const now = this.clock.now();
    if (horaEnZona(now) !== HORA_INVITACION) return 0;

    // Con el interruptor apagado ni siquiera se encola: al encenderlo no
    // sale una invitación vieja.
    const orgs = await this.db
      .select({ id: organizacion.id })
      .from(organizacion)
      .where(eq(organizacion.envioAutomaticoActivo, true));
    let n = 0;
    for (const { id: organizacionId } of orgs) {
      const cal = await this.calendar.load(organizacionId);
      if (!cal.isVentanaAbierta(now)) continue;
      const fechaOperacion = cal.getFechaOperacion(now);
      const clientes = await this.db
        .select()
        .from(cliente)
        .where(
          and(eq(cliente.activo, true), eq(cliente.organizacionId, organizacionId)),
        );
      for (const cli of clientes) {
        if (!telefonoWaParaEnvio(cli.telefonoWa) || !cli.tokenPortalCifrado) continue;
        if (!this.crypto.decrypt(cli.tokenPortalCifrado)) continue;
        const row = await this.outbox.insert({
          tipo: TIPO_OUTBOX_INVITACION,
          destinatarioId: cli.id,
          fechaOperacion,
          payload: { clienteId: cli.id, fechaOperacion },
        });
        if (row) n += 1;
      }
    }
    return n;
  }
}
