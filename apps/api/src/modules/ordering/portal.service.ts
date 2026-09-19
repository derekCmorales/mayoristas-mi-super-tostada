import { Inject, Injectable } from "@nestjs/common";
import type {
  AbonoPublico,
  AssetVariante,
  PortalCuenta,
  PortalFacturaFiltro,
  PortalFacturas,
  PortalHistorial,
  PortalPedidoDetalleCliente,
  PortalSesion,
} from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { AssetsService } from "../shared/storage/assets.service";
import { ABONO_PORTAL, type AbonoPortal } from "../receivables/abono-portal";
import { FACTURA_PORTAL, type FacturaPortal } from "../receivables/factura-portal";
import { PortalSessionService } from "./portal-session.service";
import { PortalPedidoService } from "./portal-pedido.service";
import { PortalAssetsService } from "./portal-assets.service";
import type { ClientePortal } from "./portal-token.service";
import type { PortalMeta } from "./portal-meta";

export type { PortalMeta } from "./portal-meta";

@Injectable()
export class PortalService {
  constructor(
    private readonly audit: AuditWriter,
    private readonly assets: AssetsService,
    private readonly session: PortalSessionService,
    private readonly portalPedidos: PortalPedidoService,
    private readonly portalAssets: PortalAssetsService,
    @Inject(ABONO_PORTAL) private readonly abonos: AbonoPortal,
    @Inject(FACTURA_PORTAL) private readonly facturas: FacturaPortal,
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
    return this.session.abrir(clienteRow);
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
    return this.portalPedidos.listar(clienteRow.id, opts);
  }

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
    return this.facturas.listar(
      clienteRow.id,
      clienteRow.organizacionId,
      opts,
    );
  }

  async obtenerPedido(
    clienteRow: ClientePortal,
    pedidoId: string,
    meta: PortalMeta,
  ): Promise<PortalPedidoDetalleCliente> {
    const detalle = await this.portalPedidos.detalle(
      clienteRow.id,
      clienteRow.organizacionId,
      pedidoId,
    );
    await this.audit.insert({
      actorTipo: "cliente",
      actorId: clienteRow.id,
      accion: "portal.pedido.ver",
      entidad: "pedido",
      entidadId: detalle.id,
      ip: meta.ip,
      userAgent: meta.userAgent,
    });
    return detalle;
  }

  async assetContent(
    clienteRow: ClientePortal,
    assetId: string,
    variante?: AssetVariante | string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    return this.portalAssets.content(clienteRow, assetId, variante);
  }

  async assetViewUrl(
    clienteRow: ClientePortal,
    assetId: string,
    apiBaseUrl: string,
  ): Promise<string> {
    return this.portalAssets.viewUrl(clienteRow, assetId, apiBaseUrl);
  }
}
