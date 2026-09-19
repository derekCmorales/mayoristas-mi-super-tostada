import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { producto } from "@misupertostada/db";
import {
  crearProductoRequestSchema,
  quetzalesTextoACentavos,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import type { Actor } from "../identity/actor";
import type { ImportHandler } from "./import-handlers";
import { ProductosService } from "./productos.service";
import { col, parseBool, parseEnteroOpcional } from "./import-csv.utils";

@Injectable()
export class ProductosImportHandler implements ImportHandler {
  readonly tipo = "productos" as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly productos: ProductosService,
  ) {}

  async procesarFila(
    row: Record<string, string>,
    actor: Actor,
    aplicar: boolean,
    vistos: Set<string>,
  ): Promise<void> {
    const precioBaseTexto = (row.precio_base ?? "").trim();
    const parsed = crearProductoRequestSchema.parse({
      sku: col(row, "sku"),
      nombreCanonico: col(row, "nombre_canonico"),
      familia: col(row, "familia"),
      unidadMedida: col(row, "unidad_medida"),
      puntoCarga: col(row, "punto_carga"),
      esProducido: parseBool(row.es_producido ?? "", true),
      ...(precioBaseTexto
        ? { precioBaseCentavos: quetzalesTextoACentavos(precioBaseTexto) }
        : {}),
      orden: parseEnteroOpcional(row.orden ?? "") ?? undefined,
    });
    if (vistos.has(parsed.sku)) {
      throw new Error("SKU duplicado en el archivo");
    }
    const [existe] = await this.db
      .select({ id: producto.id })
      .from(producto)
      .where(
        and(
          eq(producto.organizacionId, actor.organizacionId),
          eq(producto.sku, parsed.sku),
        ),
      )
      .limit(1);
    if (existe) throw new Error("Ya existe un producto con ese SKU");
    vistos.add(parsed.sku);
    if (aplicar) await this.productos.crear(parsed, actor);
  }
}
