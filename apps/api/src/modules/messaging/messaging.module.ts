import { Inject, Module, type OnModuleInit } from "@nestjs/common";
import { organizacion } from "@misupertostada/db";
import type { Clock } from "@misupertostada/shared";
import { loadEnv } from "../../config/env";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { OutboxDispatcherRegistry } from "../shared/outbox.dispatcher";
import { PgBossService } from "../shared/pgboss.service";
import { EncryptionService } from "../shared/crypto";
import { WHATSAPP_PORT } from "./whatsapp.port";
import { FakeWhatsAppAdapter } from "./fake.whatsapp";
import {
  GraphWhatsAppAdapter,
  resolverAuthWabaDesdeDb,
} from "./graph.whatsapp";
import { elegirPuertoWhatsApp } from "./elegir-puerto-whatsapp";
import { WebhookService } from "./webhook.service";
import { WebhooksController } from "./webhooks.controller";
import { PlantillaService } from "./plantilla.service";
import { ConversacionService } from "./conversacion.service";
import { ConversacionesController } from "./conversaciones.controller";
import { MessagingDispatcher } from "./messaging.dispatcher";
import { InvitacionJob } from "./invitacion.job";
import { ConexionWabaService } from "./conexion.service";

export const COLA_INVITACION = "mensajeria.invitacion";

@Module({
  controllers: [WebhooksController, ConversacionesController],
  providers: [
    FakeWhatsAppAdapter,
    {
      provide: WHATSAPP_PORT,
      inject: [FakeWhatsAppAdapter, DRIZZLE, EncryptionService],
      useFactory: (
        fake: FakeWhatsAppAdapter,
        db: AppDatabase,
        crypto: EncryptionService,
      ) => {
        const env = loadEnv();
        return elegirPuertoWhatsApp(
          env,
          fake,
          new GraphWhatsAppAdapter(
            env.META_GRAPH_VERSION,
            resolverAuthWabaDesdeDb(db, crypto),
          ),
        );
      },
    },
    WebhookService,
    PlantillaService,
    ConversacionService,
    MessagingDispatcher,
    InvitacionJob,
    ConexionWabaService,
  ],
  exports: [FakeWhatsAppAdapter, MessagingDispatcher, PlantillaService],
})
export class MessagingModule implements OnModuleInit {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly registry: OutboxDispatcherRegistry,
    private readonly dispatcher: MessagingDispatcher,
    private readonly plantillas: PlantillaService,
    private readonly invitaciones: InvitacionJob,
    private readonly boss: PgBossService,
  ) {
    this.registry.register(this.dispatcher);
  }

  async onModuleInit(): Promise<void> {
    const env = loadEnv();
    if (!env.META_APP_ID) {
      const orgs = await this.db.select({ id: organizacion.id }).from(organizacion);
      for (const org of orgs) {
        await this.plantillas.ensureFakeSeed(org.id, this.clock.now());
      }
    }
    await this.boss.registerIntervalJob(COLA_INVITACION, 60_000, async () => {
      await this.invitaciones.tick();
    });
  }
}
