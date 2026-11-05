import type { PermisoCodigo, Rol } from "@misupertostada/shared";
import { tienePermiso } from "@misupertostada/shared";

export const SECCIONES_PANEL = [
  "hoy",
  "tablero",
  "pedidos",
  "produccion",
  "reparto",
  "cartera",
  "conversaciones",
  "catalogo",
  "clientes",
] as const;

export type SeccionPanel = (typeof SECCIONES_PANEL)[number];

/**
 * Permisos que hacen **visible** una sección.
 *
 * Admin jefe otorga módulos enteros (`panel.*`). Sin el permiso de ver, la
 * sección no aparece en el menú. Catálogo y Clientes comparten `panel.catalogo`.
 */
export const PERMISOS_SECCION: Record<
  SeccionPanel,
  readonly PermisoCodigo[]
> = {
  hoy: ["panel.hoy"],
  tablero: ["panel.tablero"],
  pedidos: ["panel.pedidos"],
  produccion: ["panel.produccion"],
  reparto: ["panel.reparto"],
  cartera: ["panel.cartera"],
  conversaciones: ["panel.conversaciones"],
  catalogo: ["panel.catalogo"],
  clientes: ["panel.catalogo"],
};

/**
 * Permisos de escritura de cada sección: lo que hace falta para que algún botón
 * de acción se habilite. Sin ninguno, la pantalla es de solo lectura y hay que
 * decirlo —si no, Alex ve una pantalla sin botones y cree que algo falló.
 *
 * Vacío = la sección no tiene escrituras para nadie (Producción y Tablero solo
 * leen y exportan).
 */
export const ESCRITURAS_POR_SECCION: Record<
  SeccionPanel,
  readonly PermisoCodigo[]
> = {
  hoy: ["ventana.cerrar", "ventana.reabrir", "pedidos.capturar_manual"],
  tablero: [],
  pedidos: ["pedidos.capturar_manual"],
  produccion: [],
  reparto: ["pedidos.entregar", "cobranza.registrar_pago"],
  cartera: [
    "cobranza.registrar_pago",
    "cobranza.capturar_dte",
    "cobranza.confirmar_transferencia",
    "mensajeria.enviar",
  ],
  conversaciones: ["mensajeria.enviar", "mensajeria.conectar"],
  catalogo: ["catalogo.escribir", "precios.cambiar"],
  clientes: ["catalogo.escribir", "precios.cambiar"],
};

export function seccionVisible(
  seccion: SeccionPanel,
  permisos: readonly PermisoCodigo[],
): boolean {
  const requeridos = PERMISOS_SECCION[seccion];
  return requeridos.some((codigo) => tienePermiso(permisos, codigo));
}

/**
 * `true` cuando el usuario ve la sección pero no puede escribir nada en ella.
 * Las secciones sin escrituras (Tablero, Producción) nunca lo son: nadie tiene
 * botones ahí, así que el aviso sobraría.
 */
export function esSoloLectura(
  seccion: SeccionPanel,
  permisos: readonly PermisoCodigo[],
): boolean {
  const escrituras = ESCRITURAS_POR_SECCION[seccion];
  if (escrituras.length === 0) return false;
  return !escrituras.some((codigo) => tienePermiso(permisos, codigo));
}

/** Ranuras totales en la barra inferior antes de activar el botón «Más». */
export const MOVIL_NAV_MAX = 4;
/** Ranuras fijas cuando hay desbordamiento (la cuarta es «Más»). */
export const MOVIL_NAV_FIJOS = 3;

/**
 * Orden de prioridad en la barra inferior por puesto. Las secciones de uso
 * diario del oficio quedan visibles; el resto pasa al menú flotante «Más».
 */
export const PRIORIDAD_MOVIL_POR_ROL: Record<Rol, readonly SeccionPanel[]> = {
  REPARTO: ["reparto", "cartera", "hoy", "pedidos", "produccion", "tablero"],
  PRODUCCION: ["produccion", "pedidos", "hoy", "reparto", "cartera", "tablero"],
  TIENDA: ["pedidos", "cartera", "hoy", "produccion", "reparto", "tablero"],
  ADMIN: ["hoy", "pedidos", "produccion", "reparto", "cartera", "tablero"],
  ADMIN_JEFE: ["hoy", "pedidos", "produccion", "reparto", "cartera", "tablero"],
};

/**
 * Sección a la que entra la cuenta al iniciar sesión: la primera visible según la prioridad
 * de su puesto. Con plantillas de mínimo privilegio un repartidor no ve «Hoy»; mandarlo ahí
 * lo dejaría en una pantalla que no es la suya.
 */
export function seccionInicio(
  rol: Rol,
  permisos: readonly PermisoCodigo[],
): SeccionPanel {
  const orden = [...PRIORIDAD_MOVIL_POR_ROL[rol], ...SECCIONES_PANEL];
  return orden.find((s) => seccionVisible(s, permisos)) ?? "hoy";
}

type NavMovilItem = { id: SeccionPanel; mobile?: boolean };

/**
 * Reparte secciones visibles entre la barra inferior y el menú «Más».
 * Prioriza por puesto; las marcadas `mobile: false` van al final del orden.
 */
export function repartirNavMovil<T extends NavMovilItem>(
  visibles: readonly T[],
  rol: Rol,
): { barra: T[]; extra: T[] } {
  const navegables = visibles.filter((item) => item.id);
  const operativas = navegables.filter((item) => item.mobile !== false);
  const administrativas = navegables.filter((item) => item.mobile === false);

  const prioridad = PRIORIDAD_MOVIL_POR_ROL[rol];
  const operativasPorId = new Map(operativas.map((item) => [item.id, item]));
  const operativasOrdenadas: T[] = [];

  for (const id of prioridad) {
    const item = operativasPorId.get(id);
    if (item) {
      operativasOrdenadas.push(item);
      operativasPorId.delete(id);
    }
  }
  for (const item of operativas) {
    if (operativasPorId.has(item.id)) operativasOrdenadas.push(item);
  }

  const todas = [...operativasOrdenadas, ...administrativas];
  if (todas.length <= MOVIL_NAV_MAX) return { barra: todas, extra: [] };
  return {
    barra: operativasOrdenadas.slice(0, MOVIL_NAV_FIJOS),
    extra: [
      ...operativasOrdenadas.slice(MOVIL_NAV_FIJOS),
      ...administrativas,
    ],
  };
}
