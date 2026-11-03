import { Inject, Injectable, Logger } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { conexionWaba, organizacion, plantillaWa } from "@misupertostada/db";
import {
  conexionWabaPublicaSchema,
  tienePermiso,
  type Clock,
  type ConexionWabaPublica,
} from "@misupertostada/shared";
import {
  conexionWabaDesdeEnv,
  loadEnv,
  metaSignupConfigured,
} from "../../config/env";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { EncryptionService } from "../shared/crypto";
import { AuditWriter } from "../shared/audit.writer";
import type { Actor } from "../identity/actor";
import { WHATSAPP_PORT, type WhatsAppPort } from "./whatsapp.port";
import { PlantillaService } from "./plantilla.service";

@Injectable()
export class ConexionWabaService {
  private readonly logger = new Logger(ConexionWabaService.name);

  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(WHATSAPP_PORT) private readonly wa: WhatsAppPort,
    private readonly crypto: EncryptionService,
    private readonly plantillas: PlantillaService,
    private readonly audit: AuditWriter,
  ) {}

  /**
   * La WABA se conectó por el onboarding del tech provider, no por el Embedded
   * Signup de este panel: el env trae waba, número y token, y aquí se guardan
   * cifrados en `conexion_waba`. Corre en cada arranque y es idempotente.
   *
   * Solo actúa si hay exactamente una organización. Una base de desarrollo o de
   * tests tiene muchas; elegir una al azar mandaría WhatsApps reales desde ahí.
   *
   * Al pasar de DESARROLLO a CONECTADO, las plantillas sembradas por el fake
   * pasan a DELETED: Meta no las conoce. No se borra la fila: al crear la real
   * con el mismo nombre desde Configuración se reutiliza (upsert por nombre e
   * idioma), y su propósito sigue mapeado. Con PENDING el panel la daría por
   * duplicada y no dejaría crearla.
   */
  async importarDesdeEnv(): Promise<void> {
    const env = loadEnv();
    const conn = conexionWabaDesdeEnv(env);
    if (!conn) return;
    const orgs = await this.db.select({ id: organizacion.id }).from(organizacion).limit(2);
    if (orgs.length !== 1) {
      this.logger.warn(
        `META_WABA_ID presente pero hay ${orgs.length} organizaciones; no se importa la conexión`,
      );
      return;
    }
    const organizacionId = orgs[0]!.id;
    const tokenCifrado = this.crypto.encrypt(conn.accessToken);
    if (!tokenCifrado) {
      this.logger.error("APP_ENCRYPTION_KEY falta: no se puede guardar el token de WABA");
      return;
    }
    const [actual] = await this.db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, organizacionId))
      .limit(1);
    const igual =
      actual?.estado === "CONECTADO" &&
      actual.wabaId === conn.wabaId &&
      actual.phoneNumberId === conn.phoneNumberId &&
      actual.accessTokenCifrado !== null &&
      this.crypto.decrypt(actual.accessTokenCifrado) === conn.accessToken;

    if (!igual) {
      const valores = {
        wabaId: conn.wabaId,
        phoneNumberId: conn.phoneNumberId,
        accessTokenCifrado: tokenCifrado,
        estado: "CONECTADO",
      };
      await this.db.transaction(async (tx) => {
        if (actual?.estado !== "CONECTADO") {
          await tx
            .update(plantillaWa)
            .set({ status: "DELETED" })
            .where(
              and(
                eq(plantillaWa.organizacionId, organizacionId),
                ne(plantillaWa.status, "DELETED"),
              ),
            );
        }
        await tx
          .insert(conexionWaba)
          .values({ organizacionId, ...valores })
          .onConflictDoUpdate({ target: conexionWaba.organizacionId, set: valores });
        await this.audit.insert(
          {
            actorTipo: "sistema",
            actorId: "env",
            accion: "mensajeria.conexion_importada",
            entidad: "conexion_waba",
            entidadId: organizacionId,
            antes: actual
              ? {
                  estado: actual.estado,
                  wabaId: actual.wabaId,
                  phoneNumberId: actual.phoneNumberId,
                }
              : null,
            despues: {
              estado: "CONECTADO",
              wabaId: conn.wabaId,
              phoneNumberId: conn.phoneNumberId,
            },
          },
          tx,
        );
      });
      this.logger.log(`Conexión WABA ${conn.wabaId} importada desde el env`);
    }

    try {
      const items = await this.wa.syncTemplates({
        wabaId: conn.wabaId,
        accessToken: conn.accessToken,
      });
      await this.plantillas.upsertDesdeGraph(organizacionId, items, this.clock.now());
    } catch (err) {
      this.logger.warn(
        `No se pudieron sincronizar plantillas al arrancar: ${err instanceof Error ? err.message : "error"}`,
      );
    }
  }

  async estado(actor: Actor): Promise<ConexionWabaPublica> {
    const env = loadEnv();
    const [row] = await this.db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, actor.organizacionId))
      .limit(1);
    const modoDesarrollo = !row || row.estado === "DESARROLLO" || !env.META_APP_ID;
    return conexionWabaPublicaSchema.parse({
      estado: row?.estado ?? "DESARROLLO",
      modoDesarrollo,
      puedeConectarMeta: metaSignupConfigured(env),
      wabaId: row?.wabaId ?? null,
      waProduccion: row?.waProduccion ?? null,
      waTienda: row?.waTienda ?? null,
    });
  }

  async callback(body: unknown, actor: Actor): Promise<ConexionWabaPublica> {
    if (!tienePermiso(actor.permisos, "mensajeria.conectar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const env = loadEnv();
    if (!metaSignupConfigured(env)) {
      await this.plantillas.ensureFakeSeed(actor.organizacionId, this.clock.now());
      await this.db
        .insert(conexionWaba)
        .values({
          organizacionId: actor.organizacionId,
          estado: "DESARROLLO",
        })
        .onConflictDoNothing();
      return this.estado(actor);
    }
    const code =
      body && typeof body === "object" && "code" in body
        ? String((body as { code: unknown }).code)
        : "";
    if (!code) {
      throw new DomainException("VALIDACION", "Falta el code de Embedded Signup", 400);
    }
    throw new DomainException(
      "NO_DISPONIBLE",
      "El intercambio OAuth de Meta se activa cuando la app esté verificada",
      409,
    );
  }

  async syncPlantillas(actor: Actor): Promise<void> {
    if (!tienePermiso(actor.permisos, "mensajeria.conectar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const env = loadEnv();
    const [row] = await this.db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, actor.organizacionId))
      .limit(1);
    if (!row?.wabaId || !row.accessTokenCifrado || !env.META_APP_ID) {
      await this.plantillas.ensureFakeSeed(actor.organizacionId, this.clock.now());
      return;
    }
    const token = this.crypto.decrypt(row.accessTokenCifrado);
    if (!token) {
      throw new DomainException("VALIDACION", "No se pudo descifrar el token de WABA", 409);
    }
    const items = await this.wa.syncTemplates({ wabaId: row.wabaId, accessToken: token });
    await this.plantillas.upsertDesdeGraph(
      actor.organizacionId,
      items,
      this.clock.now(),
    );
  }
}
