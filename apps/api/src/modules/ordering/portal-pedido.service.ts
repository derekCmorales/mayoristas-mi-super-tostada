import { Inject, Injectable } from "@nestjs/common";
import { desc, eq } from "drizzle-orm";
import { pedido, pedidoItem, producto } from "@misupertostada/db";
import {
  MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
  portalHistorialSchema,
  portalPedidoDetalleClienteSchema,
  portalPedidoResumenSchema,
  totalPedidoCentavos,
  type PortalHistorial,
  type PortalPedidoDetalleCliente,
  type PortalPedidoResumen,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { FACTURA_PORTAL, type FacturaPortal } from "../receivables/factura-portal";
import { totalesPorPedidoIds } from "./pedido-repositorio";

const HISTORIAL_DEFAULT = 20;

@Injectable()
export class PortalPedidoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(FACTURA_PORTAL) private readonly facturas: FacturaPortal,
  ) {}

  async listar(
    clienteId: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<PortalHistorial> {
    const limit = Math.min(Math.max(opts?.limit ?? HISTORIAL_DEFAULT, 1), 50);
    const offset = Math.max(opts?.offset ?? 0, 0);

    const rows = await this.db
      .select({
        id: pedido.id,
        correlativo: pedido.correlativo,
        fechaOperacion: pedido.fechaOperacion,
        fechaEntrega: pedido.fechaEntrega,
        estado: pedido.estado,
        origen: pedido.origen,
      })
      .from(pedido)
      .where(eq(pedido.clienteId, clienteId))
      .orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo))
      .limit(limit + 1)
      .offset(offset);

    const page = rows.slice(0, limit);
    const totales = await totalesPorPedidoIds(
      this.db,
      page.map((r) => r.id),
    );
    const items = page.map((row) =>
      portalPedidoResumenSchema.parse({
        id: row.id,
        correlativo: row.correlativo,
        fechaOperacion: row.fechaOperacion,
        fechaEntrega: row.fechaEntrega,
        estado: row.estado,
        totalCentavos: totales.get(row.id) ?? 0,
        origen: row.origen,
      }),
    );

    return portalHistorialSchema.parse({
      items,
      nextOffset: rows.length > limit ? offset + limit : null,
    });
  }

  async detalle(
    clienteId: string,
    organizacionId: string,
    pedidoId: string,
  ): Promise<PortalPedidoDetalleCliente> {
    const [row] = await this.db
      .select()
      .from(pedido)
      .where(eq(pedido.id, pedidoId))
      .limit(1);

    if (!row || row.clienteId !== clienteId) {
      throw new DomainException(
        "NO_ENCONTRADO",
        MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
        404,
      );
    }

    const itemsRows = await this.db
      .select({
        item: pedidoItem,
        fotoAssetId: producto.fotoAssetId,
      })
      .from(pedidoItem)
      .leftJoin(producto, eq(producto.id, pedidoItem.productoId))
      .where(eq(pedidoItem.pedidoId, row.id));

    const items = itemsRows.map(({ item, fotoAssetId }) => ({
      productoId: item.productoId,
      cantidad: item.cantidadPedida,
      nombreMostrado: item.nombreMostrado,
      unidadMedida: item.unidadMedida,
      precioUnitarioCentavos: item.precioUnitarioCentavos,
      subtotalCentavos: item.cantidadPedida * item.precioUnitarioCentavos,
      fotoAssetId: fotoAssetId ?? null,
      esDevolucion: item.esDevolucion,
      bonoId: item.bonoId ?? null,
    }));

    const totalCentavos = totalPedidoCentavos(
      items.map((i) => ({
        cantidad: i.cantidad,
        precioUnitarioCentavos: i.precioUnitarioCentavos,
      })),
    );

    const facturaInfo = await this.facturas.dePedido(row.id, organizacionId);

    return portalPedidoDetalleClienteSchema.parse({
      id: row.id,
      correlativo: row.correlativo,
      fechaOperacion: row.fechaOperacion,
      fechaEntrega: row.fechaEntrega,
      estado: row.estado,
      totalCentavos,
      origen: row.origen,
      items,
      factura: facturaInfo,
    });
  }

  async ultimo(clienteId: string): Promise<PortalPedidoResumen | null> {
    const [row] = await this.db
      .select({
        id: pedido.id,
        correlativo: pedido.correlativo,
        fechaOperacion: pedido.fechaOperacion,
        fechaEntrega: pedido.fechaEntrega,
        estado: pedido.estado,
        origen: pedido.origen,
      })
      .from(pedido)
      .where(eq(pedido.clienteId, clienteId))
      .orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo))
      .limit(1);
    if (!row) return null;
    const totales = await totalesPorPedidoIds(this.db, [row.id]);
    return portalPedidoResumenSchema.parse({
      id: row.id,
      correlativo: row.correlativo,
      fechaOperacion: row.fechaOperacion,
      fechaEntrega: row.fechaEntrega,
      estado: row.estado,
      totalCentavos: totales.get(row.id) ?? 0,
      origen: row.origen,
    });
  }
}
