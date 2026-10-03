import type { AppDatabase } from "../shared/database.module";
import type { Actor } from "../identity/actor";

export const FACTURA_AJUSTE = Symbol("FACTURA_AJUSTE");

export type FacturaAjusteInput = {
  pedidoId: string;
  montoCentavos: number;
  motivo: string;
  actor: Actor;
};

export type FacturaAjusteResultado = {
  facturaId: string;
  montoAnteriorCentavos: number;
  montoNuevoCentavos: number;
  numeroDte: string | null;
};

export type FacturaAjusteVista = {
  facturaId: string;
  montoCentavos: number;
  abonadoCentavos: number;
  numeroDte: string | null;
};

/**
 * Port: ordering corrige precios de un pedido entregado y necesita mover el
 * monto de su factura en la misma transacción, sin importar FacturaService.
 */
export interface FacturaAjuste {
  /** Factura vigente del pedido, o `null` si todavía no se entregó. */
  vistaDePedido(
    tx: AppDatabase,
    pedidoId: string,
  ): Promise<FacturaAjusteVista | null>;
  /**
   * Cambia el monto y deja el rastro en `factura_ajuste`, `audit_log` y
   * `domain_events`. Rechaza bajar el monto por debajo de lo ya abonado.
   * `null` si el pedido no tiene factura o el monto no cambia.
   */
  ajustarEnTx(
    tx: AppDatabase,
    input: FacturaAjusteInput,
  ): Promise<FacturaAjusteResultado | null>;
}
