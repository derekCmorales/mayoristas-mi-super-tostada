import { and, eq } from "drizzle-orm";
import { clienteProducto, producto } from "@misupertostada/db";
import {
  MENSAJE_PRECIO_AUSENTE,
  MENSAJE_PRECIO_LINEA_CAPTURADA,
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
  /** Solo desde el panel (`capturaPanelItemSchema`). El portal nunca lo manda. */
  precioUnitarioCentavos?: number;
};

/**
 * Aplica el precio puesto a mano a una línea nueva, si difiere del catálogo.
 * Un precio igual no cuenta como fijado ni exige `precios.cambiar`.
 */
function conPrecioFijado(
  snapshot: ItemSnapshot,
  item: ItemInput,
  porDefectoCentavos: number | null,
): ItemSnapshot {
  const fijado = item.precioUnitarioCentavos;
  if (fijado === undefined || fijado === porDefectoCentavos) return snapshot;
  return {
    ...snapshot,
    precioUnitarioCentavos: fijado,
    precioFijado: { porDefectoCentavos },
    precioManual: true,
  };
}

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
        // Una línea ya capturada no cambia de precio por aquí: eso es
        // «Corregir precios», que exige motivo (§2.2). Reenviar el mismo
        // snapshot sí vale.
        if (
          item.precioUnitarioCentavos !== undefined &&
          item.precioUnitarioCentavos !== ya.precioUnitarioCentavos
        ) {
          throw new DomainException(
            "PRECIO_LINEA_CAPTURADA",
            MENSAJE_PRECIO_LINEA_CAPTURADA,
            409,
          );
        }
        return { ...ya, cantidad: item.cantidad };
      }
      const prod = porId.get(item.productoId);
      const liga = ligaPorProducto.get(item.productoId);
      const precioCatalogo = prod
        ? precioEfectivoCentavos({
            precioClienteCentavos: liga?.precioCentavos ?? null,
            precioBaseCentavos: prod.precioBaseCentavos ?? null,
          })
        : null;
      // Un precio puesto a mano cubre también un producto sin precio de lista.
      const precioUnitarioCentavos =
        item.precioUnitarioCentavos ?? precioCatalogo;
      if (!prod || precioUnitarioCentavos == null) {
        throw new DomainException(
          "PRECIO_AUSENTE",
          MENSAJE_PRECIO_AUSENTE,
          409,
        );
      }
      const alias = liga?.alias?.trim();
      return conPrecioFijado(
        {
          productoId: item.productoId,
          cantidad: item.cantidad,
          nombreMostrado: alias || prod.nombreCanonico,
          unidadMedida: prod.unidadMedida,
          precioUnitarioCentavos: precioCatalogo ?? precioUnitarioCentavos,
          esDevolucion: false,
          bonoId: null,
        },
        item,
        precioCatalogo,
      );
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
