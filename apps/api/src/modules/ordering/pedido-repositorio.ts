import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { cliente, pedido, pedidoItem } from "@misupertostada/db";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import type { ItemSnapshot } from "./pedido-reglas";

export type ClienteRef = { id: string; organizacionId: string };
export type FechasPedido = { operacion: string; entrega: string };

export async function pedidoDe(
  db: AppDatabase,
  id: string,
  organizacionId: string,
) {
  const [row] = await db
    .select()
    .from(pedido)
    .where(and(eq(pedido.id, id), eq(pedido.organizacionId, organizacionId)))
    .limit(1);
  if (!row) {
    throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
  }
  return row;
}

export async function clienteDe(
  db: AppDatabase,
  id: string,
  organizacionId: string,
): Promise<typeof cliente.$inferSelect> {
  const [row] = await db
    .select()
    .from(cliente)
    .where(and(eq(cliente.id, id), eq(cliente.organizacionId, organizacionId)))
    .limit(1);
  if (!row) {
    throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
  }
  return row;
}

export async function itemsDe(
  db: AppDatabase,
  pedidoId: string,
): Promise<ItemSnapshot[]> {
  const rows = await db
    .select()
    .from(pedidoItem)
    .where(eq(pedidoItem.pedidoId, pedidoId));
  return rows.map((item) => ({
    productoId: item.productoId,
    cantidad: item.cantidadPedida,
    nombreMostrado: item.nombreMostrado,
    unidadMedida: item.unidadMedida,
    precioUnitarioCentavos: item.precioUnitarioCentavos,
    esDevolucion: item.esDevolucion,
    bonoId: item.bonoId ?? null,
  }));
}

export async function insertarPedido(
  tx: AppDatabase,
  clienteRow: ClienteRef,
  fechas: FechasPedido,
  opts: {
    origen: "PORTAL" | "MANUAL";
    capturadoPor?: string | null;
    notasAdmin?: string | null;
  },
): Promise<string> {
  const [agg] = await tx
    .select({
      max: sql<number>`coalesce(max(${pedido.correlativo}), 0)::int`,
    })
    .from(pedido)
    .where(eq(pedido.organizacionId, clienteRow.organizacionId));
  const correlativo = Number(agg?.max ?? 0) + 1;
  const [row] = await tx
    .insert(pedido)
    .values({
      organizacionId: clienteRow.organizacionId,
      correlativo,
      fechaOperacion: fechas.operacion,
      fechaEntrega: fechas.entrega,
      clienteId: clienteRow.id,
      estado: "CONFIRMADO",
      origen: opts.origen,
      capturadoPor: opts.capturadoPor ?? null,
      notasAdmin: opts.notasAdmin ?? null,
    })
    .returning({ id: pedido.id });
  if (!row) {
    throw new DomainException("VALIDACION", "No se pudo crear el pedido", 500);
  }
  return row.id;
}

export async function escribirItems(
  tx: AppDatabase,
  pedidoId: string,
  items: ItemSnapshot[],
): Promise<void> {
  if (items.length === 0) return;
  await tx.insert(pedidoItem).values(
    items.map((item) => ({
      pedidoId,
      productoId: item.productoId,
      cantidadPedida: item.cantidad,
      cantidadEntregada: item.cantidad,
      precioUnitarioCentavos: item.precioUnitarioCentavos,
      nombreMostrado: item.nombreMostrado,
      unidadMedida: item.unidadMedida,
      esDevolucion: item.esDevolucion,
      bonoId: item.bonoId,
    })),
  );
}

export async function reemplazarItems(
  tx: AppDatabase,
  pedidoId: string,
  items: ItemSnapshot[],
): Promise<void> {
  await tx.delete(pedidoItem).where(eq(pedidoItem.pedidoId, pedidoId));
  await escribirItems(tx, pedidoId, items);
}

export async function buscarPedidoPortalAbierto(
  db: AppDatabase,
  clienteId: string,
  fechaOperacion: string,
) {
  const [row] = await db
    .select()
    .from(pedido)
    .where(
      and(
        eq(pedido.clienteId, clienteId),
        eq(pedido.fechaOperacion, fechaOperacion),
        eq(pedido.origen, "PORTAL"),
        isNull(pedido.anuladoAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function totalesPorPedidoIds(
  db: AppDatabase,
  ids: string[],
): Promise<Map<string, number>> {
  const totales = new Map<string, number>();
  if (ids.length === 0) return totales;
  const rows = await db
    .select()
    .from(pedidoItem)
    .where(inArray(pedidoItem.pedidoId, ids));
  for (const item of rows) {
    const prev = totales.get(item.pedidoId) ?? 0;
    totales.set(
      item.pedidoId,
      prev + item.cantidadPedida * item.precioUnitarioCentavos,
    );
  }
  return totales;
}

export type FilaBandejaPedido = {
  id: string;
  correlativo: number;
  fechaOperacion: string;
  fechaEntrega: string;
  clienteId: string;
  clienteNombre: string;
  estado: string;
  origen: string;
  capturadoPor: string | null;
  capturadoAt: Date;
  notasAdmin: string | null;
};

export async function listarPedidosBandeja(
  db: AppDatabase,
  filtros: ReturnType<typeof and>,
  historialCliente: boolean,
): Promise<FilaBandejaPedido[]> {
  const base = db
    .select({
      id: pedido.id,
      correlativo: pedido.correlativo,
      fechaOperacion: pedido.fechaOperacion,
      fechaEntrega: pedido.fechaEntrega,
      clienteId: pedido.clienteId,
      clienteNombre: cliente.nombre,
      estado: pedido.estado,
      origen: pedido.origen,
      capturadoPor: pedido.capturadoPor,
      capturadoAt: pedido.createdAt,
      notasAdmin: pedido.notasAdmin,
    })
    .from(pedido)
    .innerJoin(cliente, eq(cliente.id, pedido.clienteId))
    .where(filtros);

  return historialCliente
    ? await base
        .orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo))
        .limit(80)
    : await base.orderBy(
        desc(pedido.fechaOperacion),
        desc(pedido.correlativo),
      );
}
