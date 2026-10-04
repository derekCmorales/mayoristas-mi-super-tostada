/**
 * Seed con los datos de CONTEXT.md §5.
 * Idempotente y **solo de inserción** en producción: correrlo sobre una base
 * viva no cambia nada que ya exista (precios, nombres, notas, `activo`). Lo
 * nuevo entra; lo editado desde el panel se respeta. `seed.test.ts` lo vigila.
 * En producción no hay usuarios ni token de portal de demo.
 * Solo en desarrollo (D5) además **reescribe** datos de demo en cada corrida:
 * alias/favoritos/nota de Tabasco Casa Vieja y los tokens de portal de todos
 * los clientes (para que los links de demo sean conocidos). No lo corras en
 * una base de staging con datos de verdad sin `NODE_ENV=production`.
 */
import { resolve } from "node:path";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { config } from "dotenv";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq, and, sql } from "drizzle-orm";
import postgres from "postgres";
import * as argon2 from "argon2";
import {
  PERMISO_DESCRIPCION,
  PERMISOS,
  ROL_PERMISOS,
  type PermisoCodigo,
  type Rol,
} from "@misupertostada/shared";
import * as schema from "./schema";
import { PRODUCTOS_SEED, PRECIOS_BASE_SEED_CENTAVOS } from "./catalogo-seed";
import { sembrarVentanaSemanal } from "./ventana-semanal";

config({ path: resolve(import.meta.dir, "../../../.env") });
config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

const ORG_ID = "00000000-0000-4000-a000-000000000001";

const PRODUCTOS = PRODUCTOS_SEED;

const CLIENTES = [
  {
    nombre: "AL ESTILO BAJA (METROPLAZA)",
    notasPermanentes: "Centro comercial Metroplaza.",
    limiteFacturasPendientes: null,
    horarioEntregaFijo: "09:00",
    telefonoWa: null,
  },
  {
    nombre: "AL ESTILO BAJA (FLORESTA)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "MISTER TACO (LA ESPERANZA)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "FORTUNATEC",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TABASCO INTERPLAZA",
    notasPermanentes: "Pago semanal.",
    limiteFacturasPendientes: 5,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TABASCO CASA VIEJA (LA ESPERANZA)",
    notasPermanentes: "Paga en efectivo. Tortilla gruesa.",
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: "+50255550101",
  },
  {
    nombre: "TABASCO CASA VIEJA (ATRÁS DEL ESTADIO)",
    notasPermanentes: "Paga diario.",
    limiteFacturasPendientes: 3,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TABASCO 14 AVENIDA",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TABASCO (INTERAMERICANA PLAZA)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TABASCO (PAULINOS)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "VICTORIAS",
    notasPermanentes: "Pago semanal.",
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "HOTEL S&J BELLA LUNA",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "COLINA COUNTRY CLUB MANSION DEL VIAJERO",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "LOMA REAL",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "ALPUJARRA",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "ESCUELA LA CIENAGA (ENFRENTE DEL RASTRO)",
    notasPermanentes: "Prefiere CHEQUE; siempre con foto del cheque.",
    limiteFacturasPendientes: null,
    horarioEntregaFijo: "09:00",
    telefonoWa: null,
  },
  {
    nombre: "VIENESA (IGSS)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "VIENESA (JUZGADOS)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "PURA FRESCURA",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TAQUERO LEO (MINERVA)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "TAQUERO JOSÉ MORALES (JARDINES)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "DONA ISABEL (JARDINES)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "KRAKEN (FLORESTA)",
    notasPermanentes: "Pide fajitas.",
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "KRAKEN (PASEO LA LUNA)",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "DON NAPO (PASEO LA LUNA)",
    notasPermanentes: "Pide ~1 vez por semana.",
    limiteFacturasPendientes: 2,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "DON NAPO (ZONA 3)",
    notasPermanentes: null,
    limiteFacturasPendientes: 2,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
  {
    nombre: "FLAUTERÍA",
    notasPermanentes: null,
    limiteFacturasPendientes: null,
    horarioEntregaFijo: null,
    telefonoWa: null,
  },
] as const;

/** Feriados nacionales. Los domingos NO se seedan: son no laborables por regla. */
const FERIADOS = [
  { fecha: "2026-01-01", motivo: "Año Nuevo" },
  { fecha: "2026-04-02", motivo: "Jueves Santo" },
  { fecha: "2026-04-03", motivo: "Viernes Santo" },
  { fecha: "2026-05-01", motivo: "Día del Trabajo" },
  { fecha: "2026-06-30", motivo: "Día del Ejército" },
  { fecha: "2026-09-15", motivo: "Independencia" },
  { fecha: "2026-10-20", motivo: "Revolución" },
  { fecha: "2026-11-01", motivo: "Todos los Santos" },
  { fecha: "2026-12-25", motivo: "Navidad" },
  { fecha: "2027-01-01", motivo: "Año Nuevo" },
  { fecha: "2027-03-25", motivo: "Jueves Santo" },
  { fecha: "2027-03-26", motivo: "Viernes Santo" },
  { fecha: "2027-05-01", motivo: "Día del Trabajo" },
  { fecha: "2027-06-30", motivo: "Día del Ejército" },
  { fecha: "2027-09-15", motivo: "Independencia" },
  { fecha: "2027-10-20", motivo: "Revolución" },
  { fecha: "2027-11-01", motivo: "Todos los Santos" },
  { fecha: "2027-12-25", motivo: "Navidad" },
] as const;

export type SeedOpciones = {
  /** Por defecto la organización fija de producción. Los tests usan una propia. */
  organizacionId?: string;
  nombreOrganizacion?: string;
  /** Sin usuarios, alias ni tokens de demo. Por defecto `NODE_ENV === "production"`. */
  produccion?: boolean;
};

export async function seed(databaseUrl: string, opciones: SeedOpciones = {}) {
  const organizacionId = opciones.organizacionId ?? ORG_ID;
  const nombreOrganizacion = opciones.nombreOrganizacion ?? "Mi Súper Tostada";
  const produccion =
    opciones.produccion ?? process.env.NODE_ENV === "production";
  const client = postgres(databaseUrl, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    await db
      .insert(schema.organizacion)
      .values({ id: organizacionId, nombre: nombreOrganizacion })
      .onConflictDoNothing({ target: schema.organizacion.id });

    // Sin estas 7 filas el calendario trata la semana como apagada: no hay
    // fallback de horario en ninguna parte.
    await sembrarVentanaSemanal(db, organizacionId);

    await db
      .insert(schema.permiso)
      .values(
        PERMISOS.map((codigo) => ({
          codigo,
          descripcion: PERMISO_DESCRIPCION[codigo],
        })),
      )
      .onConflictDoNothing();

    if (!produccion) {
      const password = process.env.SEED_ADMIN_PASSWORD ?? "dev-local-only";
      const passwordHash = await argon2.hash(password, {
        type: argon2.argon2id,
      });
      await db
        .insert(schema.usuario)
        .values([
          {
            organizacionId,
            username: "cristian",
            passwordHash,
            rol: "ADMIN_JEFE",
          },
          {
            organizacionId,
            username: "alex",
            passwordHash,
            rol: "PRODUCCION",
          },
          {
            organizacionId,
            username: "carla",
            passwordHash,
            rol: "TIENDA",
          },
          {
            organizacionId,
            username: "tony",
            passwordHash,
            rol: "REPARTO",
          },
        ])
        .onConflictDoNothing();

      // Acceso por módulos: el puesto ya no aporta permisos solos; hay que
      // materializar la plantilla en usuario_permiso (igual que la migración).
      const sembrados = await db
        .select({
          id: schema.usuario.id,
          rol: schema.usuario.rol,
        })
        .from(schema.usuario)
        .where(eq(schema.usuario.organizacionId, organizacionId));
      const catalogoPermisos = await db.select().from(schema.permiso);
      const porCodigo = new Map(
        catalogoPermisos.map((p) => [p.codigo as PermisoCodigo, p.id]),
      );
      const grants: {
        usuarioId: string;
        permisoId: string;
        grantedBy: null;
      }[] = [];
      for (const u of sembrados) {
        if (u.rol === "ADMIN_JEFE") continue;
        for (const codigo of ROL_PERMISOS[u.rol as Rol]) {
          const permisoId = porCodigo.get(codigo);
          if (permisoId) {
            grants.push({ usuarioId: u.id, permisoId, grantedBy: null });
          }
        }
      }
      if (grants.length > 0) {
        await db
          .insert(schema.usuarioPermiso)
          .values(grants)
          .onConflictDoNothing();
      }
    }

    // Catálogo y clientes: el seed solo **inserta lo que falta**. Una vez que
    // la fila existe, es de Cristian —la edita desde el panel— y el seed no la
    // vuelve a tocar: ni precio, ni nombre, ni notas, ni `activo`.
    //
    // Antes era un upsert que reescribía `precio_base_centavos` con la lista de
    // `catalogo-seed.ts` y desactivaba todo SKU o cliente fuera de la lista
    // fija. Con `SEED_ON_BOOT=true` olvidado en el compose, cada deploy de
    // octubre de 2026 regresó los precios a los de fábrica y los pedidos de esa
    // noche se tasaron mal. Ver `seed.test.ts`.
    await db
      .insert(schema.producto)
      .values(
        PRODUCTOS.map((p) => ({
          organizacionId,
          ...p,
          precioBaseCentavos: PRECIOS_BASE_SEED_CENTAVOS[p.sku] ?? null,
        })),
      )
      .onConflictDoNothing({
        target: [schema.producto.organizacionId, schema.producto.sku],
      });

    await db
      .insert(schema.cliente)
      .values(
        CLIENTES.map((c) => ({
          organizacionId,
          ...c,
        })),
      )
      .onConflictDoNothing({
        target: [schema.cliente.organizacionId, schema.cliente.nombre],
      });

    await db
      .insert(schema.diaNoLaborable)
      .values(
        FERIADOS.map((f) => ({
          organizacionId,
          fecha: f.fecha,
          motivo: f.motivo,
          editable: true,
        })),
      )
      .onConflictDoNothing();

    const tortillas = await db
      .select()
      .from(schema.producto)
      .where(
        and(
          eq(schema.producto.organizacionId, organizacionId),
          eq(schema.producto.familia, "TORTILLA"),
        ),
      );

    const [tabascoCasaVieja] = await db
      .select()
      .from(schema.cliente)
      .where(
        and(
          eq(schema.cliente.organizacionId, organizacionId),
          eq(schema.cliente.nombre, "TABASCO CASA VIEJA (LA ESPERANZA)"),
        ),
      );

    if (tabascoCasaVieja) {
      await db
        .insert(schema.clienteProducto)
        .values(
          tortillas.map((t, i) => ({
            clienteId: tabascoCasaVieja.id,
            productoId: t.id,
            notaProduccion: "GRUESA",
            precioCentavos: null,
            orden: i + 1,
          })),
        )
        .onConflictDoNothing();
    }

    if (tabascoCasaVieja && !produccion) {
      const demoTortilla: Record<
        string,
        { alias: string; favorito: boolean }
      > = {
        "TORT-16": {
          alias: "tortilla grande",
          favorito: true,
        },
        "TORT-14": {
          alias: "tortilla mediana",
          favorito: true,
        },
        "TORT-12": {
          alias: "tortilla pequeña",
          favorito: true,
        },
        "TORT-10": {
          alias: "tortilla mini",
          favorito: true,
        },
        "TORT-GARN": {
          alias: "tortilla garnacha",
          favorito: false,
        },
      };
      for (const t of tortillas) {
        const demo = demoTortilla[t.sku];
        if (!demo) continue;
        await db
          .update(schema.clienteProducto)
          .set({
            alias: demo.alias,
            favorito: demo.favorito,
            notaProduccion: "GRUESA",
          })
          .where(
            and(
              eq(schema.clienteProducto.clienteId, tabascoCasaVieja.id),
              eq(schema.clienteProducto.productoId, t.id),
            ),
          );
      }

      const [nachosBlancosP] = await db
        .select()
        .from(schema.producto)
        .where(
          and(
            eq(schema.producto.organizacionId, organizacionId),
            eq(schema.producto.sku, "NACH-B-P"),
          ),
        );
      if (nachosBlancosP) {
        await db
          .insert(schema.clienteProducto)
          .values({
            clienteId: tabascoCasaVieja.id,
            productoId: nachosBlancosP.id,
            alias: "nachos blancos pequeños",
            precioCentavos: null,
            favorito: false,
            orden: 10,
          })
          .onConflictDoNothing();
        await db
          .update(schema.clienteProducto)
          .set({
            alias: "nachos blancos pequeños",
          })
          .where(
            and(
              eq(schema.clienteProducto.clienteId, tabascoCasaVieja.id),
              eq(schema.clienteProducto.productoId, nachosBlancosP.id),
            ),
          );
      }
    }

    if (!produccion) {
      await db
        .update(schema.cliente)
        .set({
          tokenPortalHash: null,
          tokenPortalCifrado: null,
        })
        .where(eq(schema.cliente.organizacionId, organizacionId));

      const todosClientes = await db
        .select()
        .from(schema.cliente)
        .where(eq(schema.cliente.organizacionId, organizacionId));

      for (const cl of todosClientes) {
        const slug = cl.nombre
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "");
        const tokenPortal =
          cl.nombre === "TABASCO CASA VIEJA (LA ESPERANZA)"
            ? "dev-tabasco-casa-vieja-portal-token"
            : `dev-${cl.id.slice(0, 8)}-${slug}-token`;

        const tokenHash = createHash("sha256").update(tokenPortal).digest("hex");
        const tokenCifrado = encryptSeed(tokenPortal);

        await db
          .update(schema.cliente)
          .set({
            tokenPortalHash: tokenHash,
            tokenPortalCifrado: tokenCifrado,
          })
          .where(eq(schema.cliente.id, cl.id));
      }

      console.log(
        `[seed] Portal Tabasco Casa Vieja: http://localhost:3000/p/dev-tabasco-casa-vieja-portal-token`,
      );
      console.log(
        "[seed] Precios base en catálogo; alias de demo en Tabasco Casa Vieja.",
      );
    }

    await seedPlantillasFake(db, organizacionId);

    const krakens = await db
      .select()
      .from(schema.cliente)
      .where(
        and(
          eq(schema.cliente.organizacionId, organizacionId),
          sql`${schema.cliente.nombre} LIKE 'KRAKEN%'`,
        ),
      );

    const [fajitas] = await db
      .select()
      .from(schema.producto)
      .where(
        and(
          eq(schema.producto.organizacionId, organizacionId),
          eq(schema.producto.sku, "FAJ-B"),
        ),
      );

    if (fajitas) {
      for (const kraken of krakens) {
        await db
          .insert(schema.clienteProducto)
          .values({
            clienteId: kraken.id,
            productoId: fajitas.id,
            precioCentavos: null,
            orden: 1,
          })
          .onConflictDoNothing();
      }
    }
  } finally {
    await client.end();
  }
}

if (import.meta.main) {
  const url =
    process.env.DATABASE_URL ??
    "postgresql://postgres:postgres@localhost:5432/misupertostada";
  await seed(url);
  console.log("Seed CONTEXT §5 aplicado (idempotente).");
}

function encryptSeed(plain: string): string | null {
  const hex = process.env.APP_ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) return null;
  const key = Buffer.from(hex, "hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plain, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    "v1",
    iv.toString("base64url"),
    tag.toString("base64url"),
    encrypted.toString("base64url"),
  ].join(".");
}

async function seedPlantillasFake(
  db: ReturnType<typeof drizzle<typeof schema>>,
  orgId: string,
): Promise<void> {
  const defs = [
    {
      name: "mst_invitacion_v1",
      proposito: "INVITACION",
      body: "Buenas noches. Ya está abierta la toma de pedidos para {{1}}. Puede responder aquí o abrir su portal.",
    },
    {
      name: "mst_confirmacion_v1",
      proposito: "CONFIRMACION",
      body: "Recibimos su pedido {{1}} para el {{2}}. Total {{3}}.",
    },
    {
      name: "mst_estado_cuenta_v1",
      proposito: "ESTADO_CUENTA",
      body: "Le compartimos su estado de cuenta: {{1}} facturas pendientes por {{2}}.",
    },
    {
      name: "mst_consolidado_v1",
      proposito: "CONSOLIDADO",
      body: "Pedido consolidado para {{1}} (v{{2}}).",
    },
  ] as const;
  for (const def of defs) {
    await db
      .insert(schema.plantillaWa)
      .values({
        organizacionId: orgId,
        name: def.name,
        language: "es",
        status: "APPROVED",
        category: "UTILITY",
        componentes: [{ type: "BODY", text: def.body }],
        sincronizadoAt: new Date(),
      })
      .onConflictDoNothing();
  }
  const rows = await db
    .select()
    .from(schema.plantillaWa)
    .where(eq(schema.plantillaWa.organizacionId, orgId));
  for (const def of defs) {
    const tpl = rows.find((r) => r.name === def.name);
    if (!tpl) continue;
    await db
      .insert(schema.plantillaProposito)
      .values({
        organizacionId: orgId,
        proposito: def.proposito,
        plantillaWaId: tpl.id,
      })
      .onConflictDoNothing();
  }
  await db
    .insert(schema.conexionWaba)
    .values({ organizacionId: orgId, estado: "DESARROLLO" })
    .onConflictDoNothing();
}

