import { Inject, Injectable } from "@nestjs/common";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  abono,
  clienteBono,
  clienteProducto,
  factura,
  pago,
  pedido,
  pedidoItem,
  producto,
} from "@misupertostada/db";
import {
  capturaAbierta,
  instanteAIso,
  timestampsVentana,
  portalFacturaSchema,
  portalFacturasSchema,
  portalHistorialSchema,
  portalPedidoDetalleClienteSchema,
  portalPedidoResumenSchema,
  portalProductoSchema,
  portalBonoSchema,
  portalSesionSchema,
  precioEfectivoCentavos,
  estadoFactura,
  saludoPortalDe,
  totalPedidoCentavos,
  MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
  type AbonoPublico,
  type AssetVariante,
  type PortalCuenta,
  type PortalFacturaFiltro,
  type PortalFacturas,
  type PortalHistorial,
  type PortalPedidoDetalleCliente,
  type PortalPedidoResumen,
  type PortalSesion,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import { AssetsService } from "../shared/storage/assets.service";
import { PedidoService, type PortalMeta } from "./pedido.service";
import { horarioDe } from "./pedido-reglas";
import type { ClientePortal } from "./portal-token.service";
import { ABONO_PORTAL, type AbonoPortal } from "../receivables/abono-portal";
import {
  abonosAplicadosDeFactura,
  presentarFactura,
} from "../receivables/factura-presentacion";

const HISTORIAL_DEFAULT = 20;

@Injectable()
export class PortalService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly pedidos: PedidoService,
    private readonly assets: AssetsService,
    @Inject(ABONO_PORTAL) private readonly abonos: AbonoPortal,
  ) {}

  async abrirSesion(
    clienteRow: ClientePortal,
    meta: PortalMeta,
  ): Promise<PortalSesion> {
    await this.audit.insert({
      actorTipo: "cliente",
      actorId: clienteRow.id,
      accion: "portal.abrir",
      entidad: "cliente",
      entidadId: clienteRow.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    /*
     * El portal se ancla al **mismo** eje de captura que el panel, no a
     * `getFechaOperacion(now)` a secas: si el admin reabrió el día, `ejes()`
     * devuelve esa operación y no la ventana siguiente. Sin esto el cliente
     * seguía viendo «cerrada» —y pidiendo sobre otra fecha— después de una
     * reapertura.
     */
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    const diaEstado = ejes.estadoCaptura;
    const abierta = capturaAbierta(ejes.ventanaAbierta, diaEstado);
    const horario = horarioDe(clienteRow);
    const { cierraAt, proximaAperturaAt } = timestampsVentana({
      ventanaAbierta: ejes.ventanaAbierta,
      estadoCaptura: diaEstado,
      cierraDate: cal.getCierreVentana(now),
      proximaAperturaDesde: (from) => cal.getProximaApertura(from),
      now,
    });
    const [catalogo, bonos, pedidoAbierto, cuenta, ultimoPedido] =
      await Promise.all([
        this.catalogoDe(clienteRow),
        this.bonosDe(clienteRow),
        this.pedidos.portalAbierto(clienteRow.id, fechaOperacion, horario),
        this.cuentaDe(clienteRow),
        this.ultimoPedidoDe(clienteRow.id),
      ]);

    return portalSesionSchema.parse({
      cliente: {
        id: clienteRow.id,
        nombre: clienteRow.nombre,
        horarioEntregaFijo: horario,
      },
      ventana: {
        abierta,
        fechaOperacion,
        fechaEntrega: ejes.entregaCaptura,
        diaEstado,
        // Misma función que `/calendario/ahora`. En un día CERRADO con el
        // reloj vivo, `cierraAt` queda null y `proximaAperturaAt` apunta a
        // las 15:00: el portal cuenta lo mismo que el navbar.
        //
        // En un día REABIERTO no hay cierre de reloj que prometer (lo cierra
        // el admin a mano). `proximaAperturaAt` sí se manda para que el
        // portal refresque a las 15:00. El copy de «abre de nuevo» solo se
        // muestra si `abierta` es false.
        cierraAt,
        proximaAperturaAt,
        horarioEntregaFijo: horario,
      },
      catalogo,
      bonos,
      pedidoAbierto,
      cuenta,
      ahoraIso: instanteAIso(now),
      saludo: saludoPortalDe(now),
      ultimoPedido,
    });
  }

  async cuentaDe(clienteRow: ClientePortal): Promise<PortalCuenta> {
    return this.abonos.cuentaDe(clienteRow.id, clienteRow.organizacionId);
  }

  async reportarAbono(
    clienteRow: ClientePortal,
    body: unknown,
    meta: PortalMeta,
  ): Promise<AbonoPublico> {
    return this.abonos.reportarTransferencia(
      clienteRow.id,
      clienteRow.organizacionId,
      body,
      meta,
    );
  }

  presignAbonoAsset(body: unknown) {
    return this.assets.presignPortal(body);
  }

  confirmAbonoAsset(body: unknown) {
    return this.assets.confirmPortal(body);
  }

  async listarPedidos(
    clienteRow: ClientePortal,
    meta: PortalMeta,
    opts?: { limit?: number; offset?: number },
  ): Promise<PortalHistorial> {
    await this.audit.insert({
      actorTipo: "cliente",
      actorId: clienteRow.id,
      accion: "portal.historial",
      entidad: "cliente",
      entidadId: clienteRow.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

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
      .where(eq(pedido.clienteId, clienteRow.id))
      .orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo))
      .limit(limit + 1)
      .offset(offset);

    const page = rows.slice(0, limit);
    const totales = await this.totalesDe(page.map((r) => r.id));
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

  /**
   * Facturas del cliente, con filtro. La cuenta (`GET /p/:token/cuenta`) sigue
   * devolviendo solo lo pendiente porque viaja dentro de la sesión y no puede
   * crecer con el historial; esto es la lista paginada aparte.
   *
   * Que se puedan pedir las pagadas no es un lujo: un abono se aplica por FIFO
   * contra facturas que muchas veces ya quedaron saldadas, y si esas facturas
   * no se pueden consultar, el enlace desde el abono no lleva a ningún lado.
   */
  async listarFacturas(
    clienteRow: ClientePortal,
    meta: PortalMeta,
    opts?: { filtro?: PortalFacturaFiltro; limit?: number; offset?: number },
  ): Promise<PortalFacturas> {
    await this.audit.insert({
      actorTipo: "cliente",
      actorId: clienteRow.id,
      accion: "portal.facturas",
      entidad: "cliente",
      entidadId: clienteRow.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

    const filtro = opts?.filtro ?? "pendientes";
    const limit = Math.min(Math.max(opts?.limit ?? HISTORIAL_DEFAULT, 1), 50);
    const offset = Math.max(opts?.offset ?? 0, 0);

    const abonadoSql = sql<number>`coalesce((
      select sum(${pago.montoCentavos}) from ${pago} where ${pago.facturaId} = ${factura.id}
    ), 0)::int`;

    // El filtro se resuelve en SQL: paginar en memoria obligaría a traer todas
    // las facturas del cliente para descartar la mitad.
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
      .where(and(eq(pedido.clienteId, clienteRow.id), filtroSql))
      .orderBy(
        desc(sql`coalesce(${factura.emitidaAt}, ${factura.createdAt})`),
        desc(pedido.correlativo),
      )
      .limit(limit + 1)
      .offset(offset);

    const cal = await this.calendar.load(clienteRow.organizacionId);
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

  async obtenerPedido(
    clienteRow: ClientePortal,
    pedidoId: string,
    meta: PortalMeta,
  ): Promise<PortalPedidoDetalleCliente> {
    const [row] = await this.db
      .select()
      .from(pedido)
      .where(eq(pedido.id, pedidoId))
      .limit(1);

    if (!row || row.clienteId !== clienteRow.id) {
      throw new DomainException(
        "NO_ENCONTRADO",
        MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO,
        404,
      );
    }

    await this.audit.insert({
      actorTipo: "cliente",
      actorId: clienteRow.id,
      accion: "portal.pedido.ver",
      entidad: "pedido",
      entidadId: row.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });

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

    const facturaInfo = await this.facturaDePedido(row.id);

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

  /**
   * Bytes de un asset solo si es foto de producto activo de la org
   * o foto del propio cliente. Cualquier otro UUID → 404 genérico.
   */
  async assetContent(
    clienteRow: ClientePortal,
    assetId: string,
    variante?: AssetVariante | string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const permitido = await this.assetPermitido(clienteRow, assetId);
    if (!permitido) {
      throw new DomainException("NO_ENCONTRADO", "Archivo no encontrado", 404);
    }
    return this.assets.getContent(assetId, variante);
  }

  async assetViewUrl(
    clienteRow: ClientePortal,
    assetId: string,
    apiBaseUrl: string,
  ): Promise<string> {
    const permitido = await this.assetPermitido(clienteRow, assetId);
    if (!permitido) {
      throw new DomainException("NO_ENCONTRADO", "Archivo no encontrado", 404);
    }
    return this.assets.getViewUrl(assetId, apiBaseUrl);
  }

  private async assetPermitido(
    clienteRow: ClientePortal,
    assetId: string,
  ): Promise<boolean> {
    if (clienteRow.fotoAssetId === assetId) return true;

    const [ab] = await this.db
      .select({ id: abono.id })
      .from(abono)
      .where(
        and(
          eq(abono.comprobanteAssetId, assetId),
          eq(abono.clienteId, clienteRow.id),
        ),
      )
      .limit(1);
    if (ab) return true;

    const [prod] = await this.db
      .select({ id: producto.id })
      .from(producto)
      .where(
        and(
          eq(producto.fotoAssetId, assetId),
          eq(producto.organizacionId, clienteRow.organizacionId),
          eq(producto.activo, true),
        ),
      )
      .limit(1);
    return Boolean(prod);
  }

  private async ultimoPedidoDe(
    clienteId: string,
  ): Promise<PortalPedidoResumen | null> {
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
    const totales = await this.totalesDe([row.id]);
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

  private async totalesDe(ids: string[]): Promise<Map<string, number>> {
    const totales = new Map<string, number>();
    if (ids.length === 0) return totales;
    const items = await this.db
      .select()
      .from(pedidoItem)
      .where(inArray(pedidoItem.pedidoId, ids));
    for (const item of items) {
      const prev = totales.get(item.pedidoId) ?? 0;
      totales.set(
        item.pedidoId,
        prev + item.cantidadPedida * item.precioUnitarioCentavos,
      );
    }
    return totales;
  }

  private async facturaDePedido(pedidoId: string) {
    const [fac] = await this.db
      .select()
      .from(factura)
      .where(eq(factura.pedidoId, pedidoId))
      .limit(1);
    if (!fac) return null;

    const [facturaInfo, abonos] = await Promise.all([
      presentarFactura(this.db, this.calendar, fac),
      abonosAplicadosDeFactura(this.db, fac.id),
    ]);

    return {
      ...facturaInfo,
      abonos: abonos.map((a) => ({
        abonoId: a.abonoId,
        fecha: a.fecha,
        metodo: a.metodo,
        estado: a.estado,
        montoCentavos: a.montoCentavos,
      })),
    };
  }

  private async bonosDe(clienteRow: ClientePortal) {
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

  private async catalogoDe(clienteRow: ClientePortal) {
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
}
