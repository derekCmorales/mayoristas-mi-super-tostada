import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { clienteProducto, producto } from "@misupertostada/db";
import {
  clienteProductoFilaSchema,
  reordenarClienteProductosRequestSchema,
  tienePermiso,
  upsertClienteProductoRequestSchema,
  type ClienteProductoFila,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { CLIENTE_PROPIETARIO, type ClientePropietario } from "./cliente-ports";

@Injectable()
export class ClienteProductoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    @Inject(CLIENTE_PROPIETARIO) private readonly clientes: ClientePropietario,
    private readonly events: PedidoEvents,
  ) {}

  async listar(clienteId: string, actor: Actor): Promise<ClienteProductoFila[]> {
    await this.clientes.owned(clienteId, actor.organizacionId);
    const productos = await this.db
      .select()
      .from(producto)
      .where(eq(producto.organizacionId, actor.organizacionId))
      .orderBy(asc(producto.familia), asc(producto.orden), asc(producto.nombreCanonico));
    const ligas = await this.db
      .select()
      .from(clienteProducto)
      .where(eq(clienteProducto.clienteId, clienteId));
    const porProducto = new Map(ligas.map((l) => [l.productoId, l]));
    return productos.map((p) => {
      const liga = porProducto.get(p.id);
      return clienteProductoFilaSchema.parse({
        productoId: p.id,
        sku: p.sku,
        nombreCanonico: p.nombreCanonico,
        familia: p.familia,
        unidadMedida: p.unidadMedida,
        puntoCarga: p.puntoCarga,
        productoActivo: p.activo,
        alias: liga?.alias ?? null,
        precioCentavos: liga?.precioCentavos ?? null,
        precioBaseCentavos: p.precioBaseCentavos ?? null,
        notaProduccion: liga?.notaProduccion ?? null,
        favorito: liga?.favorito ?? false,
        orden: liga?.orden ?? p.orden,
        ligado: Boolean(liga),
      });
    });
  }

  async upsert(
    clienteId: string,
    productoId: string,
    body: unknown,
    actor: Actor,
  ): Promise<ClienteProductoFila> {
    const input = parseBody(upsertClienteProductoRequestSchema, body);
    await this.clientes.owned(clienteId, actor.organizacionId);
    const [prod] = await this.db
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.id, productoId),
          eq(producto.organizacionId, actor.organizacionId),
        ),
      )
      .limit(1);
    if (!prod) {
      throw new DomainException("NO_ENCONTRADO", "Producto no encontrado", 404);
    }

    const [existente] = await this.db
      .select()
      .from(clienteProducto)
      .where(
        and(
          eq(clienteProducto.clienteId, clienteId),
          eq(clienteProducto.productoId, productoId),
        ),
      )
      .limit(1);

    const precioAnterior = existente?.precioCentavos ?? null;
    const cambiaPrecio =
      Object.prototype.hasOwnProperty.call(input, "precioCentavos") &&
      input.precioCentavos !== precioAnterior;

    if (cambiaPrecio && !tienePermiso(actor.permisos, "precios.cambiar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para cambiar precios",
        403,
      );
    }

    const valores = {
      alias: input.alias === undefined ? (existente?.alias ?? null) : input.alias,
      precioCentavos: cambiaPrecio
        ? (input.precioCentavos ?? null)
        : precioAnterior,
      notaProduccion:
        input.notaProduccion === undefined
          ? (existente?.notaProduccion ?? null)
          : input.notaProduccion,
      favorito: input.favorito ?? existente?.favorito ?? false,
      orden: input.orden ?? existente?.orden ?? prod.orden,
    };

    if (existente) {
      await this.db
        .update(clienteProducto)
        .set(valores)
        .where(
          and(
            eq(clienteProducto.clienteId, clienteId),
            eq(clienteProducto.productoId, productoId),
          ),
        );
    } else {
      await this.db.insert(clienteProducto).values({
        clienteId,
        productoId,
        ...valores,
      });
    }

    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: existente ? "cliente_producto.editar" : "cliente_producto.asegurar",
      entidad: "cliente_producto",
      entidadId: `${clienteId}:${productoId}`,
      antes: existente
        ? {
            alias: existente.alias,
            precioCentavos: existente.precioCentavos,
            notaProduccion: existente.notaProduccion,
            favorito: existente.favorito,
            orden: existente.orden,
          }
        : null,
      despues: valores,
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    if (cambiaPrecio) {
      await this.audit.insert({
        actorTipo: "usuario",
        actorId: actor.usuarioId,
        accion: "cliente_producto.precio",
        entidad: "cliente_producto",
        entidadId: `${clienteId}:${productoId}`,
        antes: { precioCentavos: precioAnterior },
        despues: { precioCentavos: input.precioCentavos ?? null },
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      this.events.emit({
        organizacionId: actor.organizacionId,
        tipo: "cliente_producto.precio",
        productoId,
        clienteId,
      });
    }

    const filas = await this.listar(clienteId, actor);
    const fila = filas.find((r) => r.productoId === productoId);
    if (!fila) {
      throw new DomainException("NO_ENCONTRADO", "No se pudo leer la fila", 500);
    }
    return fila;
  }

  async reordenar(
    clienteId: string,
    body: unknown,
    actor: Actor,
  ): Promise<ClienteProductoFila[]> {
    const input = parseBody(reordenarClienteProductosRequestSchema, body);
    for (let i = 0; i < input.ids.length; i++) {
      await this.upsert(clienteId, input.ids[i]!, { orden: i + 1 }, actor);
    }
    return this.listar(clienteId, actor);
  }
}
