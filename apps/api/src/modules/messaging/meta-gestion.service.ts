import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import { plantillaProposito, plantillaWa } from "@misupertostada/db";
import {
  PROPOSITO_ETIQUETA,
  componentesMetaDeBorrador,
  instanteAIso,
  plantillaBorradorSchema,
  plantillaMetaSchema,
  retirarPlantillaRequestSchema,
  type Clock,
  type PlantillaBorrador,
  type PlantillaMeta,
  type PlantillaProposito,
} from "@misupertostada/shared";
import { loadEnv, metaWhatsAppConfigured } from "../../config/env";
import { CLOCK, DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { AuditWriter } from "../shared/audit.writer";
import { EncryptionService } from "../shared/crypto";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { resolverAuthWabaDesdeDb } from "./graph.whatsapp";
import {
  META_GESTION_PORT,
  type CredencialesWaba,
  type MetaGestionPort,
} from "./meta-gestion.port";
import { pdfDeEjemplo } from "./pdf-ejemplo";

/** Meta solo deja editar plantillas ya revisadas. */
const STATUS_EDITABLES = new Set(["APPROVED", "REJECTED", "PAUSED"]);

type Modo =
  | { fuente: "META"; cred: CredencialesWaba }
  | { fuente: "DESARROLLO" };

@Injectable()
export class MetaGestionService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(META_GESTION_PORT) private readonly meta: MetaGestionPort,
    private readonly crypto: EncryptionService,
    private readonly audit: AuditWriter,
  ) {}

  async plantillas(actor: Actor): Promise<PlantillaMeta[]> {
    const rows = await this.db
      .select()
      .from(plantillaWa)
      .where(eq(plantillaWa.organizacionId, actor.organizacionId));
    const mapas = await this.db
      .select()
      .from(plantillaProposito)
      .where(eq(plantillaProposito.organizacionId, actor.organizacionId));
    const proposito = new Map(
      mapas.map((m) => [m.plantillaWaId, m.proposito as PlantillaProposito]),
    );
    return rows
      .map((row) =>
        plantillaMetaSchema.parse({
          id: row.id,
          metaTemplateId: row.metaTemplateId,
          name: row.name,
          language: row.language,
          category: row.category,
          status: row.status,
          motivoRechazo: row.motivoRechazo,
          calidad: row.calidad,
          componentes: row.componentes,
          proposito: proposito.get(row.id) ?? null,
          sincronizadoAt: row.sincronizadoAt ? instanteAIso(row.sincronizadoAt) : null,
        }),
      )
      .sort((a, b) => a.name.localeCompare(b.name) || a.language.localeCompare(b.language));
  }

  /**
   * Trae de Meta el estado vivo. Lo que ya no existe allá (retirado desde el
   * Business Manager) queda como `DELETED`: la fila no se borra.
   */
  async sincronizar(actor: Actor): Promise<PlantillaMeta[]> {
    const modo = await this.modo(actor.organizacionId);
    if (modo.fuente === "DESARROLLO") return this.plantillas(actor);
    const remotas = await this.meta.listarPlantillas(modo.cred);
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      for (const r of remotas) {
        await tx
          .insert(plantillaWa)
          .values({
            organizacionId: actor.organizacionId,
            name: r.name,
            language: r.language,
            status: r.status,
            category: r.category,
            componentes: r.componentes,
            metaTemplateId: r.metaTemplateId,
            motivoRechazo: r.motivoRechazo,
            calidad: r.calidad,
            sincronizadoAt: now,
          })
          .onConflictDoUpdate({
            target: [plantillaWa.organizacionId, plantillaWa.name, plantillaWa.language],
            set: {
              status: r.status,
              category: r.category,
              componentes: r.componentes,
              metaTemplateId: r.metaTemplateId,
              motivoRechazo: r.motivoRechazo,
              calidad: r.calidad,
              sincronizadoAt: now,
            },
          });
      }
      const vivas = new Set(remotas.map((r) => `${r.name}\u0000${r.language}`));
      const locales = await tx
        .select({ id: plantillaWa.id, name: plantillaWa.name, language: plantillaWa.language })
        .from(plantillaWa)
        .where(
          and(
            eq(plantillaWa.organizacionId, actor.organizacionId),
            ne(plantillaWa.status, "DELETED"),
          ),
        );
      for (const l of locales) {
        if (vivas.has(`${l.name}\u0000${l.language}`)) continue;
        await tx
          .update(plantillaWa)
          .set({ status: "DELETED", sincronizadoAt: now })
          .where(eq(plantillaWa.id, l.id));
      }
    });
    return this.plantillas(actor);
  }

  async crear(body: unknown, actor: Actor): Promise<PlantillaMeta> {
    const borrador = parseBody(plantillaBorradorSchema, body);
    const [existente] = await this.db
      .select()
      .from(plantillaWa)
      .where(
        and(
          eq(plantillaWa.organizacionId, actor.organizacionId),
          eq(plantillaWa.name, borrador.name),
          eq(plantillaWa.language, borrador.language),
        ),
      )
      .limit(1);
    if (existente && existente.status !== "DELETED") {
      throw new DomainException(
        "PLANTILLA_DUPLICADA",
        "Ya existe una plantilla con ese nombre e idioma",
        409,
      );
    }
    const modo = await this.modo(actor.organizacionId);
    const cred = this.credOSimulada(modo, actor.organizacionId);
    const componentes = await this.componentes(borrador, cred.accessToken);
    const creada = await this.meta.crearPlantilla({
      ...cred,
      name: borrador.name,
      language: borrador.language,
      category: borrador.category,
      componentes,
    });
    const now = this.clock.now();
    const id = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(plantillaWa)
        .values({
          organizacionId: actor.organizacionId,
          name: borrador.name,
          language: borrador.language,
          category: creada.category,
          status: creada.status,
          componentes,
          metaTemplateId: creada.metaTemplateId,
          sincronizadoAt: now,
        })
        .onConflictDoUpdate({
          target: [plantillaWa.organizacionId, plantillaWa.name, plantillaWa.language],
          set: {
            category: creada.category,
            status: creada.status,
            componentes,
            metaTemplateId: creada.metaTemplateId,
            motivoRechazo: null,
            calidad: null,
            sincronizadoAt: now,
          },
        })
        .returning({ id: plantillaWa.id });
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "mensajeria.plantilla_crear",
          entidad: "plantilla_wa",
          entidadId: row!.id,
          despues: { name: borrador.name, language: borrador.language, category: borrador.category, componentes },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return row!.id;
    });
    return this.una(id, actor);
  }

  async editar(id: string, body: unknown, actor: Actor): Promise<PlantillaMeta> {
    const row = await this.fila(id, actor);
    if (!row.metaTemplateId) {
      throw new DomainException(
        "NO_DISPONIBLE",
        "Sincronice con Meta antes de editar esta plantilla",
        409,
      );
    }
    if (!STATUS_EDITABLES.has(row.status)) {
      throw new DomainException(
        "PLANTILLA_NO_EDITABLE",
        "Meta solo permite editar plantillas aprobadas, rechazadas o pausadas",
        409,
      );
    }
    /* Nombre, idioma y categoría no cambian: Meta los fija al crear. */
    const borrador = parseBody(plantillaBorradorSchema, {
      ...(body && typeof body === "object" ? body : {}),
      name: row.name,
      language: row.language,
      category: row.category === "MARKETING" ? "MARKETING" : "UTILITY",
    });
    const modo = await this.modo(actor.organizacionId);
    const cred = this.credOSimulada(modo, actor.organizacionId);
    const componentes = await this.componentes(borrador, cred.accessToken);
    await this.meta.editarPlantilla({
      accessToken: cred.accessToken,
      metaTemplateId: row.metaTemplateId,
      componentes,
    });
    const now = this.clock.now();
    /* Meta vuelve a revisar toda edición. Se refleja ya, sin esperar al webhook. */
    const status = modo.fuente === "DESARROLLO" ? "APPROVED" : "PENDING";
    await this.db.transaction(async (tx) => {
      await tx
        .update(plantillaWa)
        .set({ componentes, status, motivoRechazo: null, sincronizadoAt: now })
        .where(eq(plantillaWa.id, row.id));
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "mensajeria.plantilla_editar",
          entidad: "plantilla_wa",
          entidadId: row.id,
          antes: { status: row.status, componentes: row.componentes },
          despues: { status, componentes },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
    return this.una(row.id, actor);
  }

  async retirar(id: string, body: unknown, actor: Actor): Promise<PlantillaMeta> {
    const { motivo } = parseBody(retirarPlantillaRequestSchema, body);
    const row = await this.fila(id, actor);
    if (row.status === "DELETED") return this.una(row.id, actor);
    const [mapa] = await this.db
      .select()
      .from(plantillaProposito)
      .where(eq(plantillaProposito.plantillaWaId, row.id))
      .limit(1);
    if (mapa) {
      const aviso = PROPOSITO_ETIQUETA[mapa.proposito as PlantillaProposito] ?? mapa.proposito;
      throw new DomainException(
        "PLANTILLA_EN_USO",
        `La usa el ${aviso.toLowerCase()}. Asigne otra plantilla a ese aviso antes de retirarla.`,
        409,
      );
    }
    const modo = await this.modo(actor.organizacionId);
    const cred = this.credOSimulada(modo, actor.organizacionId);
    await this.meta.retirarPlantilla({
      ...cred,
      name: row.name,
      metaTemplateId: row.metaTemplateId,
    });
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      await tx
        .update(plantillaWa)
        .set({ status: "DELETED", sincronizadoAt: now })
        .where(eq(plantillaWa.id, row.id));
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "mensajeria.plantilla_retirar",
          entidad: "plantilla_wa",
          entidadId: row.id,
          antes: { status: row.status },
          despues: { status: "DELETED", motivo },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
    return this.una(row.id, actor);
  }

  /* ─── Internos ─────────────────────────────────────────────────────── */

  private async modo(organizacionId: string): Promise<Modo> {
    const auth = await resolverAuthWabaDesdeDb(this.db, this.crypto)(organizacionId);
    if (auth) {
      return { fuente: "META", cred: { wabaId: auth.wabaId, accessToken: auth.accessToken } };
    }
    if (metaWhatsAppConfigured(loadEnv())) {
      throw new DomainException(
        "NO_DISPONIBLE",
        "Conecte el WhatsApp del negocio con Meta antes de usar esta sección",
        409,
      );
    }
    return { fuente: "DESARROLLO" };
  }

  private credOSimulada(modo: Modo, organizacionId: string): CredencialesWaba {
    return modo.fuente === "META"
      ? modo.cred
      : { wabaId: `waba.fake.${organizacionId}`, accessToken: "" };
  }

  private async componentes(b: PlantillaBorrador, accessToken: string): Promise<unknown[]> {
    if (b.headerTipo !== "DOCUMENT") return componentesMetaDeBorrador(b);
    const { handle } = await this.meta.subirEjemplo({
      accessToken,
      bytes: pdfDeEjemplo("Ejemplo de documento"),
      mime: "application/pdf",
      filename: "ejemplo.pdf",
    });
    return componentesMetaDeBorrador(b, handle);
  }

  private async fila(id: string, actor: Actor) {
    const [row] = await this.db
      .select()
      .from(plantillaWa)
      .where(and(eq(plantillaWa.id, id), eq(plantillaWa.organizacionId, actor.organizacionId)))
      .limit(1);
    if (!row) throw new DomainException("NO_ENCONTRADO", "Plantilla no encontrada", 404);
    return row;
  }

  private async una(id: string, actor: Actor): Promise<PlantillaMeta> {
    const todas = await this.plantillas(actor);
    const p = todas.find((x) => x.id === id);
    if (!p) throw new DomainException("NO_ENCONTRADO", "Plantilla no encontrada", 404);
    return p;
  }
}
