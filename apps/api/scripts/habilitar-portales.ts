/**
 * Deja a los clientes existentes listos para el envío automático de WhatsApp.
 * Ver `src/modules/catalog/habilitar-portales.ts` para las reglas.
 *
 * Uso (desde la raíz del repo; mejor con el .sh):
 *   bun apps/api/scripts/habilitar-portales.ts            # en seco: solo reporta
 *   bun apps/api/scripts/habilitar-portales.ts --aplicar  # escribe
 *   ... --org <uuid> --activar-inactivos --rotar-sin-cifrar
 *
 * Nunca imprime enlaces ni tokens.
 */
import { resolve } from "node:path";
import { config } from "dotenv";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "@misupertostada/db";
import { loadEnv } from "../src/config/env";
import { EncryptionService } from "../src/modules/shared/crypto";
import type { AppDatabase } from "../src/modules/shared/database.module";
import { habilitarPortales } from "../src/modules/catalog/habilitar-portales";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const args = process.argv.slice(2);
const conocidos = new Set(["--aplicar", "--activar-inactivos", "--rotar-sin-cifrar", "--org"]);
const orgIdx = args.indexOf("--org");
const organizacionId = orgIdx >= 0 ? args[orgIdx + 1] : undefined;
for (const [i, a] of args.entries()) {
  if (i === orgIdx + 1 && orgIdx >= 0) continue;
  if (!conocidos.has(a)) {
    console.error(`Opción desconocida: ${a}`);
    process.exit(2);
  }
}
if (orgIdx >= 0 && !organizacionId) {
  console.error("--org necesita el id de la organización");
  process.exit(2);
}
const aplicar = args.includes("--aplicar");

const env = loadEnv();
const crypto = new EncryptionService();
if (!crypto.disponible()) {
  console.error("❌ APP_ENCRYPTION_KEY falta o es inválida: sin ella el envío no puede leer el enlace del portal.");
  process.exit(1);
}

const client = postgres(env.DATABASE_URL, { max: 1 });
const db = drizzle(client, { schema }) as AppDatabase;
const host = new URL(env.DATABASE_URL).host;

console.log(aplicar ? `✍️  Aplicando cambios en ${host}` : `👀 En seco contra ${host} (nada se escribe; agregue --aplicar)`);

try {
  const resultados = await habilitarPortales(db, crypto, {
    aplicar,
    organizacionId,
    activarInactivos: args.includes("--activar-inactivos"),
    rotarSinCifrar: args.includes("--rotar-sin-cifrar"),
  });
  if (resultados.length === 0) console.log("No hay organizaciones que coincidan.");
  for (const r of resultados) {
    console.log(`\n🏭 ${r.organizacion} (${r.organizacionId})`);
    if (r.ventanaSembrada) {
      console.log(`   ${aplicar ? "✓" : "→"} ventana semanal incompleta: ${aplicar ? "sembrada" : "se sembraría"} con el horario por defecto`);
    }
    for (const c of r.clientes) {
      if (c.acciones.length === 0 && !c.pendiente) continue;
      const marca = c.pendiente ? "⚠️ " : aplicar ? "✓ " : "→ ";
      const detalle = [...c.acciones, c.pendiente ? `NO recibirá avisos: ${c.pendiente}` : null]
        .filter(Boolean)
        .join(" · ");
      console.log(`   ${marca}${c.nombre}: ${detalle}`);
    }
    const conProblema = r.clientes.filter((c) => c.pendiente).length;
    console.log(
      `   Resultado: ${r.listos} clientes ${aplicar ? "listos" : "quedarían listos"} para recibir avisos; ${conProblema} por revisar.`,
    );
  }
  if (!aplicar) console.log("\nNada se escribió. Repita con --aplicar para guardar.");
  else console.log("\nListo. El envío se enciende en Configuración → Plantillas de Meta.");
} finally {
  await client.end({ timeout: 1 });
}
