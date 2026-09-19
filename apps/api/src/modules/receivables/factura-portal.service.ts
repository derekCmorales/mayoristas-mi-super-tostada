import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, sql } from "drizzle-orm";
import { factura, pago, pedido } from "@misupertostada/db";
import {
  instanteAIso,
  portalFacturaSchema,
  portalFacturasSchema,
  portalPedidoDetalleFacturaSchema,
  estadoFactura,
  type PortalFacturaFiltro,
  type PortalFacturas,
  type PortalPedidoDetalleCliente,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { BusinessCalendarService } from "../shared/calendar.service";
import {
  abonosAplicadosDeFactura,
  presentarFactura,
} from "./factura-presentacion";
import type { FacturaPortal } from "./factura-portal";

const HISTORIAL_DEFAULT = 20;

@Injectable()
export class FacturaPortalService implements FacturaPortal {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly calendar: BusinessCalendarService,
  ) {}

  async listar(
    clienteId: string,
    organizacionId: string,
    opts?: { filtro?: PortalFacturaFiltro; limit?: number; offset?: number },
  ): Promise<PortalFacturas> {
    const filtro = opts?.filtro ?? "pendientes";
    const limit = Math.min(Math.max(opts?.limit ?? HISTORIAL_DEFAULT, 1), 50);
    const offset = Math.max(opts?.offset ?? 0, 0);

    const abonadoSql = sql<number>`coalesce((
      select sum(${pago.montoCentavos}) from ${pago} where ${pago.facturaId} = ${factura.id}
    ), 0)::int`;

    const condPagada = sql`${abonadoSql} >= ${factura.montoCentavos}`;
    const filtroSql =
      filtro === "pendientes"
        ? sql`not (${condPagada})`
        : filtro === "pagadas"
          ? condPagada
          : sql`true`;

    const rows = await this.db
      .select({
        factura,
        abonado: abonadoSql,
        correlativo: pedido.correlativo,
        fechaEntrega: pedido.fechaEntrega,
      })
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(
          eq(pedido.clienteId, clienteId),
          eq(pedido.organizacionId, organizacionId),
          filtroSql,
        ),
      )
      .orderBy(
        desc(sql`coalesce(${factura.emitidaAt}, ${factura.createdAt})`),
        desc(pedido.correlativo),
      )
      .limit(limit + 1)
      .offset(offset);

    const cal = await this.calendar.load(organizacionId);
    const now = this.calendar.now();

    const items = rows.slice(0, limit).map((row) => {
      const fac = row.factura;
      const abonado = Number(row.abonado);
      const emitida = fac.emitidaAt ?? fac.createdAt;
      const antiguedadDias = emitida ? cal.diasCalendarioEntre(emitida, now) : 0;
      return portalFacturaSchema.parse({
        id: fac.id,
        pedidoId: fac.pedidoId,
        correlativo: row.correlativo,
        fechaEntrega: row.fechaEntrega,
        numeroDte: fac.numeroDte ?? null,
        montoCentavos: fac.montoCentavos,
        abonadoCentavos: abonado,
        saldoCentavos: Math.max(0, fac.montoCentavos - abonado),
        emitidaAt: emitida ? instanteAIso(emitida) : null,
        antiguedadDias,
        estado: estadoFactura({
          montoCentavos: fac.montoCentavos,
          abonadoCentavos: abonado,
          antiguedadDias,
        }),
      });
    });

    return portalFacturasSchema.parse({
      items,
      nextOffset: rows.length > limit ? offset + limit : null,
    });
  }

  async dePedido(
    pedidoId: string,
    organizacionId: string,
  ): Promise<PortalPedidoDetalleCliente["factura"]> {
    const [fac] = await this.db
      .select()
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(
          eq(factura.pedidoId, pedidoId),
          eq(pedido.organizacionId, organizacionId),
        ),
      )
      .limit(1);
    if (!fac) return null;

    const [facturaInfo, abonos] = await Promise.all([
      presentarFactura(this.db, this.calendar, fac.factura),
      abonosAplicadosDeFactura(this.db, fac.factura.id),
    ]);

    return portalPedidoDetalleFacturaSchema.parse({
      id: facturaInfo.id,
      numeroDte: facturaInfo.numeroDte,
      montoCentavos: facturaInfo.montoCentavos,
      abonadoCentavos: facturaInfo.abonadoCentavos,
      saldoCentavos: facturaInfo.saldoCentavos,
      antiguedadDias: facturaInfo.antiguedadDias,
      estado: facturaInfo.estado,
      abonos: abonos.map((a) => ({
        abonoId: a.abonoId,
        fecha: a.fecha,
        metodo: a.metodo,
        estado: a.estado,
        montoCentavos: a.montoCentavos,
      })),
    });
  }
}
