import type {
  PortalFacturaFiltro,
  PortalFacturas,
  PortalPedidoDetalleCliente,
} from "@misupertostada/shared";

export const FACTURA_PORTAL = Symbol("FACTURA_PORTAL");

export interface FacturaPortal {
  listar(
    clienteId: string,
    organizacionId: string,
    opts?: { filtro?: PortalFacturaFiltro; limit?: number; offset?: number },
  ): Promise<PortalFacturas>;

  dePedido(
    pedidoId: string,
    organizacionId: string,
  ): Promise<PortalPedidoDetalleCliente["factura"]>;
}
