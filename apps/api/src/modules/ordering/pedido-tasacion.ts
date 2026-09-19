import { and, eq } from "drizzle-orm";
import { clienteProducto, producto } from "@misupertostada/db";
import {
  MENSAJE_PRECIO_AUSENTE,
  precioEfectivoCentavos,
} from "@misupertostada/shared";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { aplicarBonosEnPedido } from "./pedido-bono";
import { congelarSnapshots, type ItemSnapshot } from "./pedido-reglas";
import type { ClienteRef } from "./pedido-repositorio";

type ItemInput = {
  productoId: string;
  cantidad: number;
  esDevolucion?: boolean;
  bonoId?: string;
};

async function cargarCatalogoCliente(
  db: AppDatabase,
  clienteRow: ClienteRef,
) {
  const productos = await db
    .select()
    .from(producto)
    .where(
      and(
        eq(producto.organizacionId, clienteRow.organizacionId),
        eq(producto.activo, true),
      ),
    );
  const ligas = await db
    .select()
    .from(clienteProducto)
    .where(eq(clienteProducto.clienteId, clienteRow.id));
  return {
    porId: new Map(productos.map((p) => [p.id, p])),
    ligaPorProducto: new Map(ligas.map((l) => [l.productoId, l])),
  };
}

export async function tasarItemsPagados(
  db: AppDatabase,
  clienteRow: ClienteRef,
  items: ItemInput[],
  previos: ItemSnapshot[],
): Promise<ItemSnapshot[]> {
  const claves = items.map((i) =>
    i.esDevolucion
      ? `d:${i.bonoId ?? i.productoId}:${i.productoId}`
      : `p:${i.productoId}`,
  );
  const unicos = new Set(claves);
  if (unicos.size !== claves.length) {
    throw new DomainException(
      "VALIDACION",
      "Hay productos repetidos en el pedido",
      400,
    );
  }

  const { porId, ligaPorProducto } = await cargarCatalogoCliente(db, clienteRow);
  const previoPorClave = new Map(
    previos.map((i) => [`${i.productoId}:${i.esDevolucion ? "1" : "0"}`, i]),
  );

  return items
    .filter((item) => !item.esDevolucion)
    .map((item) => {
      const clave = `${item.productoId}:0`;
      const ya = previoPorClave.get(clave);
      if (ya) {
        return { ...ya, cantidad: item.cantidad };
      }
      const prod = porId.get(item.productoId);
      const liga = ligaPorProducto.get(item.productoId);
      const precioUnitarioCentavos = prod
        ? precioEfectivoCentavos({
            precioClienteCentavos: liga?.precioCentavos ?? null,
            precioBaseCentavos: prod.precioBaseCentavos ?? null,
          })
        : null;
      if (!prod || precioUnitarioCentavos == null) {
        throw new DomainException(
          "PRECIO_AUSENTE",
          MENSAJE_PRECIO_AUSENTE,
          409,
        );
      }
      const alias = liga?.alias?.trim();
      return {
        productoId: item.productoId,
        cantidad: item.cantidad,
        nombreMostrado: alias || prod.nombreCanonico,
        unidadMedida: prod.unidadMedida,
        precioUnitarioCentavos,
        esDevolucion: false,
        bonoId: null,
      };
    });
}

export async function resolverSnapshotsConBonos(
  tx: AppDatabase,
  clienteRow: ClienteRef,
  pedidoId: string,
  itemsInput: ItemInput[],
  snapshotsPagados: ItemSnapshot[],
  itemsAntes: ItemSnapshot[],
): Promise<ItemSnapshot[]> {
  const { porId, ligaPorProducto } = await cargarCatalogoCliente(tx, clienteRow);

  const devolucionSnapshots = await aplicarBonosEnPedido(
    tx,
    clienteRow.id,
    pedidoId,
    itemsInput,
    (_item) => {
      const prod = porId.get(_item.productoId);
      if (!prod) {
        throw new DomainException(
          "PRODUCTO_INACTIVO",
          "El producto no está activo",
          409,
        );
      }
      const liga = ligaPorProducto.get(_item.productoId);
      const alias = liga?.alias?.trim();
      return {
        nombreMostrado: alias || prod.nombreCanonico,
        unidadMedida: prod.unidadMedida,
        precioUnitarioCentavos: 0,
      };
    },
  );

  return congelarSnapshots(
    [...snapshotsPagados, ...devolucionSnapshots],
    itemsAntes,
  );
}
