import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { auditLog, cliente } from "@misupertostada/db";
import { crearOrgDePrueba, openTestDb, postgresListo } from "../../test/db";
import { EncryptionService } from "../shared/crypto";
import { habilitarPortales } from "./habilitar-portales";

const listo = await postgresListo();

describe.skipIf(!listo)("habilitarPortales", () => {
  async function fixture() {
    process.env.APP_ENCRYPTION_KEY ??= "ab".repeat(32);
    const { client, db } = openTestDb();
    const enc = new EncryptionService();
    const org = await crearOrgDePrueba(db, "org-portales-");
    const alta = (valores: Partial<typeof cliente.$inferInsert>) =>
      db
        .insert(cliente)
        .values({ organizacionId: org.id, nombre: `C ${crypto.randomUUID().slice(0, 8)}`, ...valores })
        .returning()
        .then((r) => r[0]!);
    return { client, db, enc, orgId: org.id, alta };
  }

  test("en seco no cambia nada; al aplicar crea enlaces y normaliza teléfonos", async () => {
    const f = await fixture();
    try {
      const sinPortal = await f.alta({ telefonoWa: "5555 1234" });
      const invalido = await f.alta({ telefonoWa: "123" });
      const inactivo = await f.alta({ telefonoWa: "55551235", activo: false });

      const seco = await habilitarPortales(f.db, f.enc, { aplicar: false, organizacionId: f.orgId });
      expect(seco[0]!.listos).toBe(1);
      const [sinTocar] = await f.db.select().from(cliente).where(eq(cliente.id, sinPortal.id));
      expect(sinTocar!.tokenPortalHash).toBeNull();
      expect(sinTocar!.telefonoWa).toBe("5555 1234");

      const [r] = await habilitarPortales(f.db, f.enc, { aplicar: true, organizacionId: f.orgId });
      expect(r!.listos).toBe(1);
      const [hecho] = await f.db.select().from(cliente).where(eq(cliente.id, sinPortal.id));
      expect(hecho!.telefonoWa).toBe("+50255551234");
      expect(hecho!.tokenPortalHash).toBeTruthy();
      expect(f.enc.decrypt(hecho!.tokenPortalCifrado!)).toBeTruthy();

      // Inválido: recibe enlace pero el teléfono no se toca y queda reportado.
      const [inv] = await f.db.select().from(cliente).where(eq(cliente.id, invalido.id));
      expect(inv!.telefonoWa).toBe("123");
      expect(r!.clientes.find((c) => c.id === invalido.id)?.pendiente).toBeTruthy();

      // Inactivo: no se toca sin la bandera.
      const [ina] = await f.db.select().from(cliente).where(eq(cliente.id, inactivo.id));
      expect(ina!.activo).toBe(false);
      expect(ina!.tokenPortalHash).toBeNull();

      const audits = await f.db
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entidadId, sinPortal.id), eq(auditLog.accion, "clientes.habilitar_portal")));
      expect(audits).toHaveLength(1);

      // Idempotente: una segunda corrida no rota el enlace.
      await habilitarPortales(f.db, f.enc, { aplicar: true, organizacionId: f.orgId });
      const [otra] = await f.db.select().from(cliente).where(eq(cliente.id, sinPortal.id));
      expect(otra!.tokenPortalHash).toBe(hecho!.tokenPortalHash);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("enlace sin copia cifrada solo se rota con la bandera; inactivos con la suya", async () => {
    const f = await fixture();
    try {
      const viejo = await f.alta({ telefonoWa: "+50255551236", tokenPortalHash: `h-${crypto.randomUUID()}` });
      const inactivo = await f.alta({ telefonoWa: "+50255551237", activo: false });

      const [r1] = await habilitarPortales(f.db, f.enc, { aplicar: true, organizacionId: f.orgId });
      expect(r1!.clientes.find((c) => c.id === viejo.id)?.pendiente).toContain("--rotar-sin-cifrar");

      const [r2] = await habilitarPortales(f.db, f.enc, {
        aplicar: true,
        organizacionId: f.orgId,
        rotarSinCifrar: true,
        activarInactivos: true,
      });
      expect(r2!.listos).toBe(2);
      const [v] = await f.db.select().from(cliente).where(eq(cliente.id, viejo.id));
      expect(v!.tokenPortalHash).not.toBe(viejo.tokenPortalHash);
      const [i] = await f.db.select().from(cliente).where(eq(cliente.id, inactivo.id));
      expect(i!.activo).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
