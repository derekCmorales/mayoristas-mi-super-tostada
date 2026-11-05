import { randomBytes } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import {
  auditLog,
  cliente,
  organizacion,
  sembrarVentanaSemanal,
  ventanaSemanal,
} from "@misupertostada/db";
import { revisarTelefonoWa } from "@misupertostada/shared";
import type { AppDatabase } from "../shared/database.module";
import { hashPortalToken } from "../shared/portal-token";

/**
 * Deja a los clientes existentes listos para el envío automático: enlace del
 * portal, teléfono en formato canónico y la ventana semanal de su
 * organización. Lo corre `scripts/habilitar-portales-clientes.sh`.
 *
 * Nada se borra ni se pisa:
 * - El enlace del portal solo se crea donde no hay. Un cliente con enlace viejo
 *   sin copia cifrada (de antes del cifrado) solo se rota con `rotarSinCifrar`,
 *   porque rotar invalida el enlace que el restaurante ya tenga guardado.
 * - El teléfono solo se reescribe si es válido y está en otro formato
 *   (`5555 1234` → `+50255551234`). Los inválidos se reportan, no se tocan.
 * - La ventana semanal se siembra con `ON CONFLICT DO NOTHING`.
 * - Un cliente inactivo se reactiva solo con `activarInactivos`.
 *
 * Cada cambio queda en `audit_log` con actor `sistema`.
 */
export type HabilitarOpciones = {
  aplicar: boolean;
  organizacionId?: string;
  activarInactivos?: boolean;
  rotarSinCifrar?: boolean;
};

export type HabilitarCliente = {
  id: string;
  nombre: string;
  acciones: string[];
  /** Por qué no recibirá avisos aunque se encienda el envío. */
  pendiente: string | null;
};

export type HabilitarResultado = {
  organizacionId: string;
  organizacion: string;
  ventanaSembrada: boolean;
  clientes: HabilitarCliente[];
  listos: number;
};

type Cifrador = {
  encrypt(plaintext: string): string | null;
  decrypt(payload: string): string | null;
};

const ACTOR = "script.habilitar-portales";

export async function habilitarPortales(
  db: AppDatabase,
  crypto: Cifrador,
  opciones: HabilitarOpciones,
): Promise<HabilitarResultado[]> {
  const orgs = await db
    .select({ id: organizacion.id, nombre: organizacion.nombre })
    .from(organizacion)
    .where(
      opciones.organizacionId
        ? eq(organizacion.id, opciones.organizacionId)
        : eq(organizacion.activo, true),
    )
    .orderBy(asc(organizacion.nombre));

  const resultados: HabilitarResultado[] = [];
  for (const org of orgs) {
    const filasVentana = await db
      .select({ weekday: ventanaSemanal.weekday })
      .from(ventanaSemanal)
      .where(eq(ventanaSemanal.organizacionId, org.id));
    const ventanaSembrada = filasVentana.length < 7;
    if (ventanaSembrada && opciones.aplicar) {
      await sembrarVentanaSemanal(db, org.id);
      await auditar(db, "organizacion", org.id, "ventana.sembrar", { filas: filasVentana.length }, { filas: 7 });
    }

    const clientes = await db
      .select()
      .from(cliente)
      .where(eq(cliente.organizacionId, org.id))
      .orderBy(asc(cliente.nombre));

    const filas: HabilitarCliente[] = [];
    let listos = 0;
    for (const c of clientes) {
      const acciones: string[] = [];
      const cambios: Partial<typeof cliente.$inferInsert> = {};
      const antes: Record<string, unknown> = {};
      const despues: Record<string, unknown> = {};

      let activo = c.activo;
      if (!c.activo) {
        if (!opciones.activarInactivos) {
          filas.push({ id: c.id, nombre: c.nombre, acciones, pendiente: "inactivo (use --activar-inactivos)" });
          continue;
        }
        cambios.activo = true;
        antes.activo = false;
        despues.activo = true;
        activo = true;
        acciones.push("reactivar");
      }

      const tel = revisarTelefonoWa(c.telefonoWa);
      if (tel.e164 && tel.e164 !== c.telefonoWa) {
        cambios.telefonoWa = tel.e164;
        antes.telefonoWa = c.telefonoWa;
        despues.telefonoWa = tel.e164;
        acciones.push(`teléfono ${c.telefonoWa} → ${tel.legible}`);
      }

      const tokenUsable = Boolean(c.tokenPortalCifrado && crypto.decrypt(c.tokenPortalCifrado));
      const sinEnlace = !c.tokenPortalHash;
      const enlaceSinCifrar = Boolean(c.tokenPortalHash) && !tokenUsable;
      let portalListo = tokenUsable;
      if (sinEnlace || (enlaceSinCifrar && opciones.rotarSinCifrar)) {
        const token = randomBytes(32).toString("base64url");
        const cifrado = crypto.encrypt(token);
        if (!cifrado) throw new Error("APP_ENCRYPTION_KEY falta o es inválida: no se puede cifrar el enlace");
        cambios.tokenPortalHash = hashPortalToken(token);
        cambios.tokenPortalCifrado = cifrado;
        antes.tieneTokenPortal = !sinEnlace;
        despues.tieneTokenPortal = true;
        acciones.push(sinEnlace ? "crear enlace del portal" : "rotar enlace sin copia cifrada");
        portalListo = true;
      }

      if (opciones.aplicar && Object.keys(cambios).length > 0) {
        await db
          .update(cliente)
          .set(cambios)
          .where(and(eq(cliente.id, c.id), eq(cliente.organizacionId, org.id)));
        await auditar(db, "cliente", c.id, "clientes.habilitar_portal", antes, despues);
      }

      const problemas: string[] = [];
      if (!tel.e164) problemas.push(tel.problema ?? "sin WhatsApp válido");
      if (!portalListo) problemas.push("enlace sin copia cifrada (use --rotar-sin-cifrar)");
      if (problemas.length === 0 && activo) listos += 1;
      filas.push({ id: c.id, nombre: c.nombre, acciones, pendiente: problemas.join(" · ") || null });
    }
    resultados.push({ organizacionId: org.id, organizacion: org.nombre, ventanaSembrada, clientes: filas, listos });
  }
  return resultados;
}

async function auditar(
  db: AppDatabase,
  entidad: string,
  entidadId: string,
  accion: string,
  antes: unknown,
  despues: unknown,
): Promise<void> {
  await db.insert(auditLog).values({
    actorTipo: "sistema",
    actorId: ACTOR,
    accion,
    entidad,
    entidadId,
    antes,
    despues,
  });
}
