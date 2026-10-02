import type { DiaRepartoAtrasado, RepartoAtrasados } from "@misupertostada/shared";
import { esFechaIso } from "./fecha-ui";

/**
 * Qué día de calle muestra `/reparto`.
 *
 * Sin parámetro la ruta es la de hoy, y es la única que se guarda como
 * snapshot offline: Tony sale a la calle con esa. Un día anterior llega por
 * `?fechaEntrega=…` —desde el selector o desde el aviso de atrasados— y sirve
 * para marcar lo que se quedó sin registrar. Nunca pisa el snapshot de hoy.
 */

export const PARAM_DIA_REPARTO = "fechaEntrega";

/**
 * Día elegido en la URL, o `null` cuando la vista es la de hoy. Un valor que
 * no es fecha, o que coincide con hoy, cuenta como hoy: así no hay dos
 * caminos para la misma ruta y el snapshot sigue siendo el de la calle.
 */
export function diaRepartoDesdeParam(
  param: string | null | undefined,
  hoy: string | null | undefined,
): string | null {
  if (!param || !esFechaIso(param)) return null;
  if (hoy && param === hoy) return null;
  return param;
}

/**
 * La página y el endpoint comparten ruta y parámetro, así que el mismo href
 * sirve para navegar y para pedir la ruta. Sin fecha, el día lo decide el
 * servidor —nunca el reloj del navegador—.
 */
export function hrefRepartoDia(fechaEntrega?: string | null): string {
  return fechaEntrega
    ? `/reparto?${PARAM_DIA_REPARTO}=${fechaEntrega}`
    : "/reparto";
}

/** Los días atrasados, sin el que ya se está viendo. */
export function diasAtrasadosVisibles(
  atrasados: RepartoAtrasados | undefined,
  diaVista: string | null,
): DiaRepartoAtrasado[] {
  return (atrasados?.dias ?? []).filter((d) => d.fechaEntrega !== diaVista);
}

export function plural(n: number, uno: string, varios: string): string {
  return `${n} ${n === 1 ? uno : varios}`;
}

export function tituloAtrasados(dias: DiaRepartoAtrasado[]): string {
  const pedidos = dias.reduce((acc, d) => acc + d.pendientes, 0);
  return `${plural(pedidos, "pedido", "pedidos")} de días anteriores sin marcar como entregado${pedidos === 1 ? "" : "s"}`;
}
