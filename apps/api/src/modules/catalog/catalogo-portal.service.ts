import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, isNull } from "drizzle-orm";
import {
  clienteBono,
  clienteProducto,
  producto,
} from "@misupertostada/db";
import {
  portalBonoSchema,
  portalProductoSchema,
  precioEfectivoCentavos,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import type { CatalogoPortal, ClientePortalRef } from "./catalogo-portal";

@Injectable()
export class CatalogoPortalService implements CatalogoPortal {
  constructor(@Inject(DRIZZLE) private readonly db: AppDatabase) {}

  async catalogo(clienteRow: ClientePortalRef) {
    const productos = await this.db
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.organizacionId, clienteRow.organizacionId),
          eq(producto.activo, true),
        ),
      )
      .orderBy(asc(producto.familia), asc(producto.orden));

    const ligas = await this.db
      .select()
      .from(clienteProducto)
      .where(eq(clienteProducto.clienteId, clienteRow.id));
    const ligaPorProducto = new Map(ligas.map((l) => [l.productoId, l]));

    const filas = productos.map((p) => {
      const liga = ligaPorProducto.get(p.id);
      const precioCentavos = precioEfectivoCentavos({
        precioClienteCentavos: liga?.precioCentavos ?? null,
        precioBaseCentavos: p.precioBaseCentavos ?? null,
      });
      const alias = liga?.alias?.trim() || p.nombreCanonico;
      return portalProductoSchema.parse({
        productoId: p.id,
        alias,
        nombreCanonico: p.nombreCanonico,
        unidadMedida: p.unidadMedida,
        precioCentavos,
        favorito: liga?.favorito ?? false,
        familia: p.familia,
        orden: liga?.orden ?? p.orden,
        pedible: precioCentavos != null,
        fotoAssetId: p.fotoAssetId ?? null,
      });
    });

    return [...filas].sort((a, b) => {
      if (a.favorito !== b.favorito) return a.favorito ? -1 : 1;
      if (a.familia !== b.familia) return a.familia.localeCompare(b.familia);
      return a.orden - b.orden;
    });
  }

  async bonosDisponibles(clienteRow: ClientePortalRef) {
    const rows = await this.db
      .select({
        bono: clienteBono,
        nombreCanonico: producto.nombreCanonico,
        unidadMedida: producto.unidadMedida,
        fotoAssetId: producto.fotoAssetId,
        alias: clienteProducto.alias,
      })
      .from(clienteBono)
      .innerJoin(producto, eq(producto.id, clienteBono.productoId))
      .leftJoin(
        clienteProducto,
        and(
          eq(clienteProducto.clienteId, clienteBono.clienteId),
          eq(clienteProducto.productoId, clienteBono.productoId),
        ),
      )
      .where(
        and(
          eq(clienteBono.clienteId, clienteRow.id),
          eq(clienteBono.organizacionId, clienteRow.organizacionId),
          isNull(clienteBono.anuladoAt),
        ),
      )
      .orderBy(asc(clienteBono.createdAt));

    return rows
      .map((row) => {
        const disponible =
          row.bono.cantidadOtorgada - row.bono.cantidadAplicada;
        if (disponible <= 0) return null;
        const alias = row.alias?.trim() || row.nombreCanonico;
        return portalBonoSchema.parse({
          id: row.bono.id,
          productoId: row.bono.productoId,
          alias,
          nombreCanonico: row.nombreCanonico,
          unidadMedida: row.unidadMedida,
          descripcion: row.bono.descripcion,
          cantidadDisponible: disponible,
          fotoAssetId: row.fotoAssetId ?? null,
        });
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
  }
}
