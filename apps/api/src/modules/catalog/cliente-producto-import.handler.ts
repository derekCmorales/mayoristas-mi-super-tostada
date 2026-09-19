import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { cliente, producto } from "@misupertostada/db";
import { quetzalesTextoACentavos } from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import type { Actor } from "../identity/actor";
import type { ImportHandler } from "./import-handlers";
import { ClienteProductoService } from "./cliente-producto.service";
import {
  col,
  parseBool,
  parseEnteroOpcional,
  vacioANull,
} from "./import-csv.utils";

@Injectable()
export class ClienteProductoImportHandler implements ImportHandler {
  readonly tipo = "cliente_producto" as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly clienteProductoSvc: ClienteProductoService,
  ) {}

  async procesarFila(
    row: Record<string, string>,
    actor: Actor,
    aplicar: boolean,
    vistos: Set<string>,
  ): Promise<void> {
    const nombre = col(row, "cliente_nombre");
    const sku = col(row, "producto_sku").toUpperCase();
    const clave = `${nombre.toLowerCase()}::${sku}`;
    if (vistos.has(clave)) throw new Error("Fila duplicada en el archivo");
    const [cli] = await this.db
      .select()
      .from(cliente)
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(cliente.nombre, nombre),
        ),
      )
      .limit(1);
    if (!cli) throw new Error(`Cliente no encontrado: ${nombre}`);
    const [prod] = await this.db
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.organizacionId, actor.organizacionId),
          eq(producto.sku, sku),
        ),
      )
      .limit(1);
    if (!prod) throw new Error(`Producto no encontrado: ${sku}`);
    vistos.add(clave);
    if (!aplicar) return;
    const precioTexto = (row.precio ?? "").trim();
    await this.clienteProductoSvc.upsert(
      cli.id,
      prod.id,
      {
        alias: vacioANull(row.alias ?? ""),
        notaProduccion: vacioANull(row.nota_produccion ?? ""),
        favorito: parseBool(row.favorito ?? "", false),
        orden: parseEnteroOpcional(row.orden ?? "") ?? undefined,
        ...(precioTexto
          ? { precioCentavos: quetzalesTextoACentavos(precioTexto) }
          : {}),
      },
      actor,
    );
  }
}
