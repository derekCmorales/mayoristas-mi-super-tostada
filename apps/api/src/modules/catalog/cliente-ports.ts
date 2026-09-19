import type { ClientePublico } from "@misupertostada/shared";
import type { Actor } from "../identity/actor";

export const CLIENTE_PROPIETARIO = Symbol("CLIENTE_PROPIETARIO");
export const CLIENTE_CREADOR = Symbol("CLIENTE_CREADOR");

/**
 * Verificación de pertenencia: ¿este cliente es de esta organización?
 * Lanza NO_ENCONTRADO si no. Es todo lo que `ClienteBonoService` y
 * `ClienteProductoService` necesitan de `ClientesService` — no el CRUD entero.
 */
export interface ClientePropietario {
  owned(
    id: string,
    organizacionId: string,
  ): Promise<{ id: string; organizacionId: string }>;
}

/** Alta de cliente. Es todo lo que `ImportService` necesita de `ClientesService`. */
export interface ClienteCreador {
  crear(body: unknown, actor: Actor): Promise<ClientePublico>;
}
