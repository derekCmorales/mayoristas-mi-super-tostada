import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { cliente, producto } from "@misupertostada/db";
import {
  PLANTILLAS_CSV,
  crearClienteRequestSchema,
  crearProductoRequestSchema,
  importarCsvRequestSchema,
  parseCsv,
  quetzalesTextoACentavos,
  type ImportReporte,
  type ImportTipo,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { ProductosService } from "./productos.service";
import { ClienteProductoService } from "./cliente-producto.service";
import { CLIENTE_CREADOR, type ClienteCreador } from "./cliente-ports";

@Injectable()
export class ImportService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly productos: ProductosService,
    @Inject(CLIENTE_CREADOR) private readonly clientes: ClienteCreador,
    private readonly clienteProductoSvc: ClienteProductoService,
  ) {}

  plantilla(tipo: string): { filename: string; csv: string } {
    const clave = tipo.replace(/\.csv$/i, "") as ImportTipo;
    const csv = PLANTILLAS_CSV[clave];
    if (!csv) {
      throw new DomainException("VALIDACION", "Plantilla desconocida", 400);
    }
    return { filename: `${clave}.csv`, csv };
  }

  async preview(body: unknown, actor: Actor): Promise<ImportReporte> {
    return this.ejecutar(body, actor, false);
  }

  async confirmar(body: unknown, actor: Actor): Promise<ImportReporte> {
    const reporte = await this.ejecutar(body, actor, true);
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "catalogo.importar",
      entidad: "organizacion",
      entidadId: actor.organizacionId,
      despues: {
        tipo: reporte.tipo,
        aplicadas: reporte.aplicadas,
        invalidas: reporte.invalidas,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return reporte;
  }

  private async ejecutar(
    body: unknown,
    actor: Actor,
    aplicar: boolean,
  ): Promise<ImportReporte> {
    const input = parseBody(importarCsvRequestSchema, body);
    const { rows } = parseCsv(input.csv);
    const filas: ImportReporte["filas"] = [];
    const vistos = new Set<string>();
    let aplicadas = 0;

    for (let i = 0; i < rows.length; i++) {
      const indice = i + 2;
      try {
        if (input.tipo === "productos") {
          await this.filaProducto(rows[i]!, actor, aplicar, vistos);
        } else if (input.tipo === "clientes") {
          await this.filaCliente(rows[i]!, actor, aplicar, vistos);
        } else {
          await this.filaClienteProducto(rows[i]!, actor, aplicar, vistos);
        }
        filas.push({ indice, ok: true });
        if (aplicar) aplicadas += 1;
      } catch (err) {
        filas.push({
          indice,
          ok: false,
          error: mensajeFila(err),
        });
      }
    }

    const validas = filas.filter((f) => f.ok).length;
    const invalidas = filas.filter((f) => !f.ok).length;
    return {
      tipo: input.tipo,
      filas,
      validas,
      invalidas,
      aplicadas: aplicar ? aplicadas : 0,
    };
  }

  private async filaProducto(
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

  private async filaCliente(
    row: Record<string, string>,
    actor: Actor,
    aplicar: boolean,
    vistos: Set<string>,
  ): Promise<void> {
    const nombre = col(row, "nombre");
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) throw new Error("Nombre duplicado en el archivo");
    const parsed = crearClienteRequestSchema.parse({
      nombre,
      contacto: vacioANull(row.contacto ?? ""),
      telefonoWa: vacioANull(row.telefono_wa ?? ""),
      horarioEntregaFijo: vacioANull(row.horario_entrega_fijo ?? ""),
      notasPermanentes: vacioANull(row.notas_permanentes ?? ""),
      limiteFacturasPendientes: parseEnteroOpcional(
        row.limite_facturas_pendientes ?? "",
      ),
    });
    const [existe] = await this.db
      .select({ id: cliente.id })
      .from(cliente)
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(cliente.nombre, parsed.nombre),
        ),
      )
      .limit(1);
    if (existe) throw new Error("Ya existe un cliente con ese nombre");
    vistos.add(clave);
    if (aplicar) await this.clientes.crear(parsed, actor);
  }

  private async filaClienteProducto(
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
        and(eq(producto.organizacionId, actor.organizacionId), eq(producto.sku, sku)),
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

function col(row: Record<string, string>, name: string): string {
  if (!(name in row)) throw new Error(`Falta la columna ${name}`);
  const v = row[name]!.trim();
  if (!v) throw new Error(`${name} está vacío`);
  return v;
}

function vacioANull(raw: string): string | null {
  const v = raw.trim();
  return v === "" ? null : v;
}

function parseEnteroOpcional(raw: string): number | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) throw new Error(`Número inválido: ${raw}`);
  return Number(v);
}

function parseBool(raw: string, defecto: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "") return defecto;
  if (["1", "true", "si", "sí", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  throw new Error(`Booleano inválido: ${raw}`);
}

function mensajeFila(err: unknown): string {
  if (err instanceof DomainException) return err.message;
  if (err instanceof Error) return err.message;
  return "Fila inválida";
}
