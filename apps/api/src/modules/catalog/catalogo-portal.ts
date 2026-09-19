import type { PortalBono, PortalProducto } from "@misupertostada/shared";

export const CATALOGO_PORTAL = Symbol("CATALOGO_PORTAL");

export type ClientePortalRef = {
  id: string;
  organizacionId: string;
};

export interface CatalogoPortal {
  catalogo(cliente: ClientePortalRef): Promise<PortalProducto[]>;
  bonosDisponibles(cliente: ClientePortalRef): Promise<PortalBono[]>;
}
