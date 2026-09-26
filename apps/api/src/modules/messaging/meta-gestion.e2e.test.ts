import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  conexionWaba,
  plantillaWa,
  usuario,
} from "@misupertostada/db";
import { permisosEfectivos, type Clock } from "@misupertostada/shared";
import { crearOrgDePrueba, openTestDb, postgresListo } from "../../test/db";
import type { Actor } from "../identity/actor";
import { AuditWriter } from "../shared/audit.writer";
import { EncryptionService } from "../shared/crypto";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { FakeMetaGestionAdapter } from "./fake.meta-gestion";
import { MetaGestionService } from "./meta-gestion.service";
import { PlantillaService } from "./plantilla.service";
import { WebhookService, metaTemplateStatusPayload } from "./webhook.service";

const listo = await postgresListo();

const reloj: Clock = { now: () => new Date("2026-09-10T18:00:00Z") };

async function fixture(opts: { conectado: boolean }) {
  process.env.APP_ENCRYPTION_KEY ??= "ab".repeat(32);
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const enc = new EncryptionService();
  const meta = new FakeMetaGestionAdapter();
  const plantillas = new PlantillaService(db);
  const servicio = new MetaGestionService(db, reloj, meta, enc, audit);
  const webhooks = new WebhookService(db, reloj, audit, new PedidoEvents(), plantillas);

  const org = await crearOrgDePrueba(db, "org-meta-");
  const username = `jefe-${crypto.randomUUID().slice(0, 8)}`;
  const [jefe] = await db
    .insert(usuario)
    .values({ organizacionId: org.id, username, rol: "ADMIN_JEFE", activo: true })
    .returning({ id: usuario.id });
  const actor: Actor = {
    usuarioId: jefe!.id,
    organizacionId: org.id,
    username,
    rol: "ADMIN_JEFE",
    permisos: permisosEfectivos("ADMIN_JEFE"),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: "test",
  };
  await plantillas.ensureFakeSeed(org.id, reloj.now());
  const wabaId = `waba-${crypto.randomUUID()}`;
  if (opts.conectado) {
    await db
      .update(conexionWaba)
      .set({
        estado: "CONECTADO",
        wabaId,
        phoneNumberId: `pn-${crypto.randomUUID()}`,
        accessTokenCifrado: enc.encrypt("token-de-prueba"),
      })
      .where(eq(conexionWaba.organizacionId, org.id));
  }

  return { client, db, meta, servicio, webhooks, actor, orgId: org.id, wabaId };
}

describe.skipIf(!listo)("Gestión Meta", () => {
  test("crear, editar y retirar: Meta recibe los componentes, la fila no se borra y todo queda en audit_log", async () => {
    const f = await fixture({ conectado: true });
    try {
      f.meta.statusAlCrear = "PENDING";
      const creada = await f.servicio.crear(
        {
          name: "mst_recordatorio_v1",
          language: "es",
          category: "UTILITY",
          headerTipo: "DOCUMENT",
          headerEjemplos: [],
          body: "Hola {{1}}, su saldo pendiente es {{2}}. Gracias.",
          bodyEjemplos: ["Tabascos", "Q 250.00"],
          footer: "Mi Súper Tostada",
          botones: [{ tipo: "QUICK_REPLY", texto: "Ya pagué" }],
        },
        f.actor,
      );
      expect(creada.status).toBe("PENDING");
      expect(creada.metaTemplateId).toStartWith("hsm.fake.");
      const enviados = f.meta.creadas[0]!.componentes as Array<Record<string, unknown>>;
      expect(enviados.map((c) => c.type)).toEqual(["HEADER", "BODY", "FOOTER", "BUTTONS"]);
      expect(enviados[0]).toMatchObject({ format: "DOCUMENT" });
      expect(enviados[1]).toMatchObject({ example: { body_text: [["Tabascos", "Q 250.00"]] } });

      await expect(
        f.servicio.editar(creada.id, { body: "Hola {{1}}, gracias." }, f.actor),
      ).rejects.toBeInstanceOf(DomainException); // PENDING no se edita

      await f.db
        .update(plantillaWa)
        .set({ status: "APPROVED" })
        .where(eq(plantillaWa.id, creada.id));
      const editada = await f.servicio.editar(
        creada.id,
        { headerTipo: "NONE", headerEjemplos: [], body: "Hola {{1}}, gracias por su pago.", bodyEjemplos: ["Tabascos"], botones: [] },
        f.actor,
      );
      expect(editada.status).toBe("PENDING");
      expect(editada.name).toBe("mst_recordatorio_v1");
      expect(f.meta.editadas).toHaveLength(1);

      const retirada = await f.servicio.retirar(creada.id, { motivo: "Ya no se usa" }, f.actor);
      expect(retirada.status).toBe("DELETED");
      expect(f.meta.retiradas).toEqual([{ name: "mst_recordatorio_v1", metaTemplateId: creada.metaTemplateId }]);
      const [fila] = await f.db.select().from(plantillaWa).where(eq(plantillaWa.id, creada.id));
      expect(fila).toBeDefined();

      const acciones = await f.db
        .select({ accion: auditLog.accion })
        .from(auditLog)
        .where(and(eq(auditLog.entidad, "plantilla_wa"), eq(auditLog.entidadId, creada.id)));
      expect(acciones.map((a) => a.accion).sort()).toEqual([
        "mensajeria.plantilla_crear",
        "mensajeria.plantilla_editar",
        "mensajeria.plantilla_retirar",
      ]);
    } finally {
      await f.client.end();
    }
  });

  test("no se retira una plantilla que usa un aviso automático", async () => {
    const f = await fixture({ conectado: true });
    try {
      const lista = await f.servicio.plantillas(f.actor);
      const enUso = lista.find((p) => p.proposito === "CONFIRMACION")!;
      await expect(
        f.servicio.retirar(enUso.id, { motivo: "prueba" }, f.actor),
      ).rejects.toMatchObject({ code: "PLANTILLA_EN_USO" });
      expect(f.meta.retiradas).toHaveLength(0);
    } finally {
      await f.client.end();
    }
  });

  test("sincronizar marca DELETED lo que Meta ya no tiene y trae el motivo de rechazo", async () => {
    const f = await fixture({ conectado: true });
    try {
      f.meta.plantillas = [
        {
          metaTemplateId: "111",
          name: "mst_confirmacion_v1",
          language: "es",
          status: "APPROVED",
          category: "UTILITY",
          componentes: [{ type: "BODY", text: "Recibimos su pedido {{1}}." }],
          motivoRechazo: null,
          calidad: "GREEN",
        },
        {
          metaTemplateId: "222",
          name: "mst_promo_v1",
          language: "es",
          status: "REJECTED",
          category: "MARKETING",
          componentes: [],
          motivoRechazo: "INVALID_FORMAT",
          calidad: null,
        },
      ];
      const lista = await f.servicio.sincronizar(f.actor);
      const por = new Map(lista.map((p) => [p.name, p]));
      expect(por.get("mst_confirmacion_v1")).toMatchObject({ metaTemplateId: "111", calidad: "GREEN" });
      expect(por.get("mst_promo_v1")).toMatchObject({ status: "REJECTED", motivoRechazo: "INVALID_FORMAT" });
      expect(por.get("mst_invitacion_v1")?.status).toBe("DELETED");
    } finally {
      await f.client.end();
    }
  });

  test("webhook de estado de plantilla solo toca la organización dueña del WABA", async () => {
    const f = await fixture({ conectado: true });
    const otra = await fixture({ conectado: true });
    try {
      const payload = metaTemplateStatusPayload({ name: "mst_confirmacion_v1", language: "es", event: "REJECTED" });
      payload.entry![0]!.id = f.wabaId;
      payload.entry![0]!.changes![0]!.value!.reason = "INVALID_FORMAT";
      await f.webhooks.ingest(payload, undefined, undefined);
      const [mia] = await f.db
        .select()
        .from(plantillaWa)
        .where(and(eq(plantillaWa.organizacionId, f.orgId), eq(plantillaWa.name, "mst_confirmacion_v1")));
      const [ajena] = await f.db
        .select()
        .from(plantillaWa)
        .where(and(eq(plantillaWa.organizacionId, otra.orgId), eq(plantillaWa.name, "mst_confirmacion_v1")));
      expect(mia).toMatchObject({ status: "REJECTED", motivoRechazo: "INVALID_FORMAT" });
      expect(ajena?.status).toBe("APPROVED");
    } finally {
      await f.client.end();
      await otra.client.end();
    }
  });
});
