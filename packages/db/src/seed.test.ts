import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { PRECIOS_BASE_SEED_CENTAVOS, PRODUCTOS_SEED } from "./catalogo-seed";
import { seed } from "./seed";
import { testDatabaseUrl } from "./test-url";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const raiz = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Octubre de 2026: `SEED_ON_BOOT: "true"` quedó fijo en el compose de deploy y
 * el seed era un upsert. Cada deploy regresó los precios del catálogo a la
 * lista de fábrica y los pedidos de esa noche se tasaron con ella. Estos tests
 * cuidan las dos mitades del fix.
 */
describe("deploy no corre el seed por default", () => {
  test("el compose de producción no fija SEED_ON_BOOT en true", () => {
    const compose = readFileSync(join(raiz, "deploy/docker-compose.yml"), "utf8");
    expect(compose).not.toMatch(/SEED_ON_BOOT:\s*["']?true/);
  });

  test("el ejemplo de env de deploy no lo deja en true", () => {
    const env = readFileSync(join(raiz, "deploy/openship.env.example"), "utf8");
    expect(env).not.toMatch(/^SEED_ON_BOOT=true/m);
  });

  test("el entrypoint lo trata como apagado si falta", () => {
    const entry = readFileSync(join(raiz, "deploy/entrypoint-api.sh"), "utf8");
    expect(entry).toContain('"${SEED_ON_BOOT:-false}" = "true"');
  });
});

const databaseUrl = testDatabaseUrl();

async function postgresListo(): Promise<boolean> {
  const client = postgres(databaseUrl, { max: 1, connect_timeout: 2 });
  try {
    await client`select 1 from producto limit 1`;
    return true;
  } catch {
    return false;
  } finally {
    await client.end({ timeout: 1 });
  }
}

const listo = await postgresListo();

describe.skipIf(!listo)("seed sobre una base viva", () => {
  const organizacionId = randomUUID();
  // El patrón `org-…<uuid>` es lo que barre el afterAll global de los tests.
  const nombreOrganizacion = `org-seed-${organizacionId}`;
  const client = postgres(databaseUrl, { max: 2 });
  const db = drizzle(client, { schema });
  const sku = PRODUCTOS_SEED[0]!.sku;

  beforeAll(async () => {
    await seed(databaseUrl, {
      organizacionId,
      nombreOrganizacion,
      produccion: true,
    });
  });

  afterAll(async () => {
    await client.end({ timeout: 1 });
  });

  test("el primer seed carga el catálogo con los precios de lista", async () => {
    const [prod] = await db
      .select()
      .from(schema.producto)
      .where(
        and(
          eq(schema.producto.organizacionId, organizacionId),
          eq(schema.producto.sku, sku),
        ),
      );
    expect(prod?.precioBaseCentavos).toBe(PRECIOS_BASE_SEED_CENTAVOS[sku]);
  });

  test("correrlo otra vez no pisa precios, nombres, clientes ni bajas hechas en el panel", async () => {
    const [prod] = await db
      .update(schema.producto)
      .set({ precioBaseCentavos: 4321, nombreCanonico: "Nombre de Cristian" })
      .where(
        and(
          eq(schema.producto.organizacionId, organizacionId),
          eq(schema.producto.sku, sku),
        ),
      )
      .returning();
    const [otro] = await db
      .update(schema.producto)
      .set({ activo: false })
      .where(
        and(
          eq(schema.producto.organizacionId, organizacionId),
          eq(schema.producto.sku, PRODUCTOS_SEED[1]!.sku),
        ),
      )
      .returning();
    const [cli] = await db
      .select()
      .from(schema.cliente)
      .where(eq(schema.cliente.organizacionId, organizacionId))
      .limit(1);
    await db
      .update(schema.cliente)
      .set({ notasPermanentes: "Entrar por atrás", limiteFacturasPendientes: 3 })
      .where(eq(schema.cliente.id, cli!.id));
    const [nuevo] = await db
      .insert(schema.cliente)
      .values({ organizacionId, nombre: "CLIENTE DADO DE ALTA EN EL PANEL" })
      .returning();

    await seed(databaseUrl, {
      organizacionId,
      nombreOrganizacion,
      produccion: true,
    });

    const [prodDespues] = await db
      .select()
      .from(schema.producto)
      .where(eq(schema.producto.id, prod!.id));
    expect(prodDespues?.precioBaseCentavos).toBe(4321);
    expect(prodDespues?.nombreCanonico).toBe("Nombre de Cristian");

    const [otroDespues] = await db
      .select()
      .from(schema.producto)
      .where(eq(schema.producto.id, otro!.id));
    expect(otroDespues?.activo).toBe(false);

    const [cliDespues] = await db
      .select()
      .from(schema.cliente)
      .where(eq(schema.cliente.id, cli!.id));
    expect(cliDespues?.notasPermanentes).toBe("Entrar por atrás");
    expect(cliDespues?.limiteFacturasPendientes).toBe(3);

    const [nuevoDespues] = await db
      .select()
      .from(schema.cliente)
      .where(eq(schema.cliente.id, nuevo!.id));
    expect(nuevoDespues?.activo).toBe(true);
  });
});
