import { inArray, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  abono,
  asset,
  cliente,
  clienteBono,
  clienteProducto,
  conexionWaba,
  conversacion,
  diaNoLaborable,
  diaOperacion,
  domainEvents,
  factura,
  facturaAjuste,
  hojaProduccion,
  mensaje,
  organizacion,
  outbox,
  pago,
  pedido,
  pedidoItem,
  plantillaProposito,
  plantillaWa,
  producto,
  sesion,
  usuario,
  usuarioPermiso,
  ventanaSemanal,
} from "./schema";

/** El nombre termina en un UUID v4: eso es lo que marca una org de test. */
const PATRON_ORG_PRUEBA =
  "^org-.*[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$";

type Db = PostgresJsDatabase<Record<string, unknown>>;

/**
 * Ids de las organizaciones que dejaron los tests.
 *
 * Los e2e no truncan ni envuelven en transacción: su aislamiento es el UUID
 * del nombre. El precio es que cada corrida deja la organización entera atrás,
 * y sin barrerlas se acumulan sin techo —31 003 en la base de desarrollo en
 * agosto de 2026, con el cron de cierre recorriéndolas todas cada minuto—.
 */
export async function idsDeOrgsDePrueba(db: Db): Promise<string[]> {
  const filas = await db
    .select({ id: organizacion.id })
    .from(organizacion)
    .where(
      sql`${organizacion.nombre} ~ ${PATRON_ORG_PRUEBA}`,
    );
  return filas.map((f) => f.id);
}

/**
 * Borra organizaciones y todo lo que cuelga de ellas, en orden de FK.
 *
 * `audit_log` queda fuera a propósito: tiene triggers `no_update`/`no_delete`
 * y es append-only por diseño. Si el histórico de la base de test estorba, la
 * herramienta es recrearla (`db:test:reset`), no romper esa invariante.
 *
 * Devuelve cuántas organizaciones se borraron.
 */
export async function purgarOrgs(db: Db, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;

  // En lotes: `in (...)` con decenas de miles de uuids revienta el parser.
  let total = 0;
  for (let i = 0; i < ids.length; i += 500) {
    const lote = ids.slice(i, i + 500);
    // Cada lote en una transacción: si dos corridas de test purgan a la vez,
    // una puede quedarse sin filas a medio camino y romper una FK. Así el
    // lote entero se deshace en vez de dejar la base a medio limpiar.
    await db.transaction(async (tx) => {
      await purgarLote(tx as unknown as Db, lote);
    });
    total += lote.length;
  }
  return total;
}

async function purgarLote(db: Db, ids: string[]): Promise<void> {
  const clientes = db
    .select({ id: cliente.id })
    .from(cliente)
    .where(inArray(cliente.organizacionId, ids));
  const productos = db
    .select({ id: producto.id })
    .from(producto)
    .where(inArray(producto.organizacionId, ids));
  const pedidos = db
    .select({ id: pedido.id })
    .from(pedido)
    .where(inArray(pedido.organizacionId, ids));
  const usuarios = db
    .select({ id: usuario.id })
    .from(usuario)
    .where(inArray(usuario.organizacionId, ids));
  const conversaciones = db
    .select({ id: conversacion.id })
    .from(conversacion)
    .where(inArray(conversacion.clienteId, clientes));
  const facturas = db
    .select({ id: factura.id })
    .from(factura)
    .where(inArray(factura.pedidoId, pedidos));

  await db.delete(mensaje).where(inArray(mensaje.conversacionId, conversaciones));
  await db.delete(conversacion).where(inArray(conversacion.clienteId, clientes));
  await db.delete(pago).where(inArray(pago.facturaId, facturas));
  await db.delete(abono).where(inArray(abono.clienteId, clientes));
  await db
    .delete(facturaAjuste)
    .where(inArray(facturaAjuste.facturaId, facturas));
  await db.delete(factura).where(inArray(factura.pedidoId, pedidos));
  await db.delete(pedidoItem).where(inArray(pedidoItem.pedidoId, pedidos));
  await db.delete(pedido).where(inArray(pedido.organizacionId, ids));
  await db
    .delete(clienteProducto)
    .where(inArray(clienteProducto.clienteId, clientes));
  await db
    .delete(clienteProducto)
    .where(inArray(clienteProducto.productoId, productos));
  await db
    .delete(clienteBono)
    .where(inArray(clienteBono.organizacionId, ids));
  await db.delete(cliente).where(inArray(cliente.organizacionId, ids));
  await db.delete(producto).where(inArray(producto.organizacionId, ids));
  await db
    .delete(plantillaProposito)
    .where(inArray(plantillaProposito.organizacionId, ids));
  await db.delete(plantillaWa).where(inArray(plantillaWa.organizacionId, ids));
  await db.delete(conexionWaba).where(inArray(conexionWaba.organizacionId, ids));
  await db
    .delete(hojaProduccion)
    .where(inArray(hojaProduccion.organizacionId, ids));
  await db.delete(diaOperacion).where(inArray(diaOperacion.organizacionId, ids));
  await db
    .delete(diaNoLaborable)
    .where(inArray(diaNoLaborable.organizacionId, ids));
  await db
    .delete(ventanaSemanal)
    .where(inArray(ventanaSemanal.organizacionId, ids));
  await db
    .delete(usuarioPermiso)
    .where(inArray(usuarioPermiso.usuarioId, usuarios));
  await db.delete(sesion).where(inArray(sesion.usuarioId, usuarios));
  await db.delete(asset).where(inArray(asset.subidoPor, usuarios));
  await db.delete(usuario).where(inArray(usuario.organizacionId, ids));

  // Sin FK a organizacion: se limpian por el id que llevan dentro.
  await db.delete(outbox).where(inArray(outbox.destinatarioId, ids));
  await db
    .delete(domainEvents)
    .where(inArray(sql`${domainEvents.payload} ->> 'organizacionId'`, ids));

  await db.delete(organizacion).where(inArray(organizacion.id, ids));
}

/** Filas huérfanas de corridas anteriores, cuando ya no queda su organización. */
export async function purgarOutboxHuerfano(db: Db): Promise<void> {
  await db
    .delete(outbox)
    .where(
      sql`not exists (select 1 from ${organizacion} o where o.id = ${outbox.destinatarioId})
          and not exists (select 1 from ${cliente} c where c.id = ${outbox.destinatarioId})`,
    );
}
