import type { Rol } from "./estados";
import { MODULOS_ACCESO, type ModuloAccesoId } from "./modulos-acceso";
import {
  PERMISO_DESCRIPCION,
  permisosPlantilla,
  type PermisoCodigo,
} from "./permisos";

/**
 * Atajos para crear cuentas de los puestos reales del negocio (AGENTS.md §1) con la plantilla
 * de mínimo privilegio de `ROL_PERMISOS`. No usan nombres de personas: el puesto es lo que
 * define el acceso, no quién lo ocupa hoy.
 *
 * El atajo no inventa permisos: manda solo el `rol` y el servidor siembra exactamente
 * `permisosPlantilla(rol)`. Si el jefe necesita algo más, lo delega después desde Usuarios.
 */
export const PERFILES_CUENTA = [
  {
    id: "repartidor",
    rol: "REPARTO",
    etiqueta: "Repartidor",
    resumen: "Ruta del día: marca entregas y cobra en puerta con comprobante.",
    usuarioBase: "reparto",
  },
  {
    id: "produccion",
    rol: "PRODUCCION",
    etiqueta: "Producción",
    resumen: "Solo la hoja de producción de la noche. No ve dinero ni clientes.",
    usuarioBase: "produccion",
  },
  {
    id: "tienda",
    rol: "TIENDA",
    etiqueta: "Tienda y facturación",
    resumen:
      "Mostrador: prepara pedidos con la hoja, captura el DTE y registra cobros en tienda.",
    usuarioBase: "tienda",
  },
  {
    id: "oficina",
    rol: "ADMIN",
    etiqueta: "Administración",
    resumen:
      "Oficina: el día completo, cartera, clientes y WhatsApp. Sin precios ni cuentas.",
    usuarioBase: "oficina",
  },
] as const satisfies readonly {
  id: string;
  rol: Exclude<Rol, "ADMIN_JEFE">;
  etiqueta: string;
  resumen: string;
  usuarioBase: string;
}[];

export type PerfilCuenta = (typeof PERFILES_CUENTA)[number];
export type PerfilCuentaId = PerfilCuenta["id"];

/** Lo que el puesto podrá hacer, en palabras del panel, para mostrarlo antes de crear. */
export function resumenPlantilla(rol: Rol): {
  modulos: { id: ModuloAccesoId; etiqueta: string }[];
  acciones: string[];
} {
  const permisos = permisosPlantilla(rol);
  const set = new Set<PermisoCodigo>(permisos);
  return {
    modulos: MODULOS_ACCESO.filter((m) => set.has(m.ver)).map((m) => ({
      id: m.id,
      etiqueta: m.etiqueta,
    })),
    acciones: permisos
      .filter((codigo) => !codigo.startsWith("panel."))
      .map((codigo) => PERMISO_DESCRIPCION[codigo]),
  };
}

/**
 * Primer usuario libre a partir de la base: `reparto`, `reparto2`, `reparto3`…
 * Compara sin mayúsculas, igual que `usernameSchema`.
 */
export function sugerirUsername(
  base: string,
  existentes: readonly string[],
): string {
  const usados = new Set(existentes.map((u) => u.trim().toLowerCase()));
  if (!usados.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidato = `${base}${n}`;
    if (!usados.has(candidato)) return candidato;
  }
}
