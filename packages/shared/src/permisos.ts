import { ROLES, type Rol } from "./estados";
import { MODULOS_ACCESO, type ModuloAccesoId } from "./modulos-acceso";

/** Núcleo operativo: antes era visible para todos; ahora se otorga por módulo. */
const PANEL_VER = [
  "panel.hoy",
  "panel.tablero",
  "panel.pedidos",
  "panel.produccion",
  "panel.reparto",
  "panel.cartera",
  "panel.conversaciones",
  "panel.catalogo",
] as const;

export const PERMISOS = [
  ...PANEL_VER,
  "precios.cambiar",
  "catalogo.escribir",
  "pedidos.capturar_manual",
  "pedidos.entregar",
  "cobranza.registrar_pago",
  "cobranza.capturar_dte",
  "cobranza.confirmar_transferencia",
  "usuarios.gestionar",
  "permisos.delegar",
  "ventana.cerrar",
  "ventana.reabrir",
  "ventana.configurar",
  "mensajeria.enviar",
  "mensajeria.conectar",
  "audit.leer",
] as const;

export type PermisoCodigo = (typeof PERMISOS)[number];

/** No se pueden otorgar por API, aunque el actor sea ADMIN_JEFE. Van con el puesto. */
export const PERMISOS_NO_DELEGABLES = [
  "usuarios.gestionar",
  "permisos.delegar",
  "ventana.reabrir",
  "ventana.configurar",
  "mensajeria.conectar",
  "audit.leer",
] as const;

export type PermisoNoDelegable = (typeof PERMISOS_NO_DELEGABLES)[number];

const NUCLEO_PANEL: readonly PermisoCodigo[] = [
  "panel.hoy",
  "panel.tablero",
  "panel.pedidos",
  "panel.produccion",
  "panel.reparto",
  "panel.cartera",
];

/**
 * Plantillas de puesto: solo siembran grants al crear (o migrar) una cuenta.
 * El acceso efectivo ya no se deriva del rol — vive en `usuario_permiso`.
 *
 * **Mínimo privilegio.** Cada puesto operativo recibe solo lo que su oficio usa cada día
 * (ver AGENTS.md §1). Lo demás lo delega ADMIN_JEFE caso por caso desde Usuarios:
 *
 * - PRODUCCION (planta): solo la hoja de producción. Arranca de madrugada y solo le
 *   interesan las tortillas; no ve cartera, precios ni conversaciones.
 * - TIENDA (mostrador y facturación): emite el DTE en el sistema externo y prepara los pedidos.
 *   Lee pedidos y la hoja, captura pedidos de mostrador o llamada, captura el número de DTE y
 *   registra lo que se cobra en tienda (efectivo o transferencia con comprobante). No marca
 *   entregas (eso es de ruta), no confirma transferencias reportadas por el portal ni ve Hoy,
 *   Tablero o Reparto.
 * - REPARTO (ruta): marca entregas y cobra en puerta (con comprobante). Nada más: ni cartera
 *   completa, ni tablero, ni pedidos de otros días.
 */
export const ROL_PERMISOS: Record<Rol, readonly PermisoCodigo[]> = {
  ADMIN_JEFE: PERMISOS,
  ADMIN: [
    ...NUCLEO_PANEL,
    "panel.conversaciones",
    "panel.catalogo",
    "catalogo.escribir",
    "pedidos.capturar_manual",
    "pedidos.entregar",
    "cobranza.registrar_pago",
    "cobranza.capturar_dte",
    "cobranza.confirmar_transferencia",
    "ventana.cerrar",
    "mensajeria.enviar",
  ],
  PRODUCCION: ["panel.produccion"],
  TIENDA: [
    "panel.pedidos",
    "panel.produccion",
    "panel.cartera",
    "pedidos.capturar_manual",
    "cobranza.capturar_dte",
    "cobranza.registrar_pago",
  ],
  REPARTO: ["panel.reparto", "pedidos.entregar", "cobranza.registrar_pago"],
};

export function esPermisoCodigo(value: string): value is PermisoCodigo {
  return (PERMISOS as readonly string[]).includes(value);
}

export function esNoDelegable(codigo: PermisoCodigo): boolean {
  return (PERMISOS_NO_DELEGABLES as readonly string[]).includes(codigo);
}

/**
 * Permisos efectivos de una sesión.
 *
 * - ADMIN_JEFE: catálogo completo (no depende de filas en `usuario_permiso`).
 * - Cualquier otro puesto: **solo** los grants explícitos. El rol ya no aporta
 *   un preset invisible que no se pueda quitar.
 */
export function permisosEfectivos(
  rol: Rol,
  extras: readonly PermisoCodigo[] = [],
): PermisoCodigo[] {
  if (rol === "ADMIN_JEFE") {
    return [...PERMISOS];
  }
  const set = new Set<PermisoCodigo>(extras);
  return PERMISOS.filter((codigo) => set.has(codigo));
}

/** Paquete que se escribe en `usuario_permiso` al crear con un puesto. */
export function permisosPlantilla(rol: Rol): PermisoCodigo[] {
  return permisosEfectivos(rol, ROL_PERMISOS[rol]);
}

export function tienePermiso(
  efectivos: readonly PermisoCodigo[],
  codigo: PermisoCodigo,
): boolean {
  return efectivos.includes(codigo);
}

export function puedeDelegar(actorRol: Rol, codigo: PermisoCodigo): boolean {
  return actorRol === "ADMIN_JEFE" && !esNoDelegable(codigo);
}

export const PERMISO_DESCRIPCION: Record<PermisoCodigo, string> = {
  "panel.hoy": "Ver el módulo Hoy",
  "panel.tablero": "Ver el módulo Tablero",
  "panel.pedidos": "Ver el módulo Pedidos",
  "panel.produccion": "Ver el módulo Producción",
  "panel.reparto": "Ver el módulo Reparto",
  "panel.cartera": "Ver el módulo Cartera",
  "panel.conversaciones": "Ver el módulo Conversaciones",
  "panel.catalogo": "Ver Catálogo y clientes",
  "precios.cambiar": "Cambiar precios por cliente",
  "catalogo.escribir": "Crear y editar productos y clientes",
  "pedidos.capturar_manual": "Capturar pedidos recibidos por llamada",
  "pedidos.entregar": "Marcar un pedido como entregado y ajustar cantidades",
  "cobranza.registrar_pago": "Registrar cobros y abonos",
  "cobranza.capturar_dte": "Registrar el número de DTE del sistema externo",
  "cobranza.confirmar_transferencia":
    "Confirmar o rechazar transferencias reportadas por clientes",
  "usuarios.gestionar": "Crear y desactivar cuentas internas",
  "permisos.delegar": "Delegar permisos granulares",
  "ventana.cerrar": "Cerrar la ventana y generar la hoja de producción",
  "ventana.reabrir": "Reabrir un día de operación cerrado",
  "ventana.configurar": "Editar el horario semanal del portal",
  "mensajeria.enviar": "Enviar WhatsApp y mapear plantillas",
  "mensajeria.conectar": "Conectar el WABA con Embedded Signup",
  "audit.leer": "Consultar el historial de acciones",
};

export const ROLES_CONOCIDOS = ROLES;

/** Módulos que incluye la plantilla de un puesto (para UI al crear). */
export function modulosDePlantilla(rol: Rol): ModuloAccesoId[] {
  const plantilla = new Set(ROL_PERMISOS[rol]);
  return MODULOS_ACCESO.filter((m) => plantilla.has(m.ver)).map((m) => m.id);
}
