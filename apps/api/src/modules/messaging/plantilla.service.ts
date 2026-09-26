import { Inject, Injectable } from "@nestjs/common";
import { and, eq, ne } from "drizzle-orm";
import {
  conexionWaba,
  plantillaProposito,
  plantillaWa,
} from "@misupertostada/db";
import {
  PLANTILLA_PROPOSITOS,
  instanteAIso,
  plantillaWaPublicaSchema,
  type PlantillaProposito,
  type PlantillaWaPublica,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { mapearPropositoRequestSchema } from "@misupertostada/shared";
import type { Actor } from "../identity/actor";
import type { GraphPlantilla } from "./whatsapp.port";
import { tienePermiso } from "@misupertostada/shared";

export const PLANTILLAS_FAKE: Array<{
  name: string;
  proposito: PlantillaProposito;
  category: string;
  language: string;
  body: string;
}> = [
  {
    name: "mst_invitacion_v1",
    proposito: "INVITACION",
    category: "UTILITY",
    language: "es",
    body: "Buenas noches. Ya está abierta la toma de pedidos para {{1}}. Puede responder aquí o abrir su portal.",
  },
  {
    name: "mst_confirmacion_v1",
    proposito: "CONFIRMACION",
    category: "UTILITY",
    language: "es",
    body: "Recibimos su pedido {{1}} para el {{2}}. Total {{3}}.",
  },
  {
    name: "mst_estado_cuenta_v1",
    proposito: "ESTADO_CUENTA",
    category: "UTILITY",
    language: "es",
    body: "Le compartimos su estado de cuenta: {{1}} facturas pendientes por {{2}}.",
  },
  {
    name: "mst_consolidado_v1",
    proposito: "CONSOLIDADO",
    category: "UTILITY",
    language: "es",
    body: "Pedido consolidado para {{1}} (v{{2}}).",
  },
];

@Injectable()
export class PlantillaService {
  constructor(@Inject(DRIZZLE) private readonly db: AppDatabase) {}

  async listar(actor: Actor): Promise<PlantillaWaPublica[]> {
    return this.listarOrg(actor.organizacionId);
  }

  async listarOrg(organizacionId: string): Promise<PlantillaWaPublica[]> {
    const rows = await this.db
      .select()
      .from(plantillaWa)
      .where(
        and(
          eq(plantillaWa.organizacionId, organizacionId),
          ne(plantillaWa.status, "DELETED"),
        ),
      );
    const mapas = await this.db
      .select()
      .from(plantillaProposito)
      .where(eq(plantillaProposito.organizacionId, organizacionId));
    const porPlantilla = new Map(
      mapas.map((m) => [m.plantillaWaId, m.proposito as PlantillaProposito]),
    );
    return rows.map((row) =>
      plantillaWaPublicaSchema.parse({
        id: row.id,
        name: row.name,
        category: row.category,
        language: row.language,
        status: row.status,
        componentes: row.componentes,
        proposito: porPlantilla.get(row.id) ?? null,
        sincronizadoAt: row.sincronizadoAt
          ? instanteAIso(row.sincronizadoAt)
          : null,
      }),
    );
  }

  async mapear(body: unknown, actor: Actor): Promise<PlantillaWaPublica[]> {
    if (!tienePermiso(actor.permisos, "mensajeria.enviar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(mapearPropositoRequestSchema, body);
    const [tpl] = await this.db
      .select()
      .from(plantillaWa)
      .where(
        and(
          eq(plantillaWa.id, input.plantillaId),
          eq(plantillaWa.organizacionId, actor.organizacionId),
        ),
      )
      .limit(1);
    if (!tpl) {
      throw new DomainException("NO_ENCONTRADO", "Plantilla no encontrada", 404);
    }
    await this.db
      .insert(plantillaProposito)
      .values({
        organizacionId: actor.organizacionId,
        proposito: input.proposito,
        plantillaWaId: tpl.id,
      })
      .onConflictDoUpdate({
        target: [
          plantillaProposito.organizacionId,
          plantillaProposito.proposito,
        ],
        set: { plantillaWaId: tpl.id },
      });
    return this.listar(actor);
  }

  async resolver(
    organizacionId: string,
    proposito: PlantillaProposito,
  ): Promise<typeof plantillaWa.$inferSelect> {
    const [mapa] = await this.db
      .select()
      .from(plantillaProposito)
      .where(
        and(
          eq(plantillaProposito.organizacionId, organizacionId),
          eq(plantillaProposito.proposito, proposito),
        ),
      )
      .limit(1);
    if (!mapa) {
      throw new DomainException(
        "NO_ENCONTRADO",
        "No hay plantilla mapeada para ese propósito",
        409,
      );
    }
    const [tpl] = await this.db
      .select()
      .from(plantillaWa)
      .where(eq(plantillaWa.id, mapa.plantillaWaId))
      .limit(1);
    if (!tpl) {
      throw new DomainException("NO_ENCONTRADO", "Plantilla no encontrada", 404);
    }
    if (tpl.status !== "APPROVED") {
      throw new DomainException(
        "PLANTILLA_NO_APROBADA",
        "Esa plantilla no está aprobada. Meta puede haberla pausado.",
        409,
      );
    }
    return tpl;
  }

  async upsertDesdeGraph(
    organizacionId: string,
    items: GraphPlantilla[],
    now: Date,
  ): Promise<void> {
    for (const item of items) {
      await this.db
        .insert(plantillaWa)
        .values({
          organizacionId,
          name: item.name,
          language: item.language,
          status: item.status,
          category: item.category,
          componentes: item.componentes,
          sincronizadoAt: now,
        })
        .onConflictDoUpdate({
          target: [
            plantillaWa.organizacionId,
            plantillaWa.name,
            plantillaWa.language,
          ],
          set: {
            status: item.status,
            category: item.category,
            componentes: item.componentes,
            sincronizadoAt: now,
          },
        });
    }
  }

  /**
   * Webhook `message_template_status_update`. Con varios negocios conectados
   * al mismo tech provider dos WABA pueden tener plantillas con el mismo
   * nombre: si el evento trae el WABA, solo se toca la organización dueña.
   */
  async actualizarStatus(
    name: string,
    language: string,
    status: string,
    now: Date,
    opts: { wabaId?: string; motivo?: string | null } = {},
  ): Promise<void> {
    const filtros = [eq(plantillaWa.name, name), eq(plantillaWa.language, language)];
    if (opts.wabaId) {
      const [conn] = await this.db
        .select({ organizacionId: conexionWaba.organizacionId })
        .from(conexionWaba)
        .where(eq(conexionWaba.wabaId, opts.wabaId))
        .limit(1);
      if (conn) filtros.push(eq(plantillaWa.organizacionId, conn.organizacionId));
    }
    await this.db
      .update(plantillaWa)
      .set({
        status,
        sincronizadoAt: now,
        ...(opts.motivo !== undefined ? { motivoRechazo: opts.motivo } : {}),
      })
      .where(and(...filtros));
  }

  async ensureFakeSeed(organizacionId: string, now: Date): Promise<void> {
    const items: GraphPlantilla[] = PLANTILLAS_FAKE.map((p) => ({
      name: p.name,
      language: p.language,
      status: "APPROVED",
      category: p.category,
      componentes: [{ type: "BODY", text: p.body }],
    }));
    await this.upsertDesdeGraph(organizacionId, items, now);
    const rows = await this.db
      .select()
      .from(plantillaWa)
      .where(eq(plantillaWa.organizacionId, organizacionId));
    for (const def of PLANTILLAS_FAKE) {
      const tpl = rows.find((r) => r.name === def.name);
      if (!tpl) continue;
      await this.db
        .insert(plantillaProposito)
        .values({
          organizacionId,
          proposito: def.proposito,
          plantillaWaId: tpl.id,
        })
        .onConflictDoNothing();
    }
    const [conn] = await this.db
      .select()
      .from(conexionWaba)
      .where(eq(conexionWaba.organizacionId, organizacionId))
      .limit(1);
    if (!conn) {
      await this.db.insert(conexionWaba).values({
        organizacionId,
        estado: "DESARROLLO",
      });
    }
  }
}

export function esProposito(
  value: string,
): value is PlantillaProposito {
  return (PLANTILLA_PROPOSITOS as readonly string[]).includes(value);
}
