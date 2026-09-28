import {
  FAMILIA_ETIQUETA,
  FAMILIAS,
  UNIDAD_CORTA,
  fechaDeInstante,
  formatearFechaLarga,
  horaEnZona,
  type DiaEstadoCalendario,
  type Familia,
  type PortalBono,
  type PortalPedido,
  type PortalProducto,
  type PortalSaludo,
  type PortalSesion,
  type PortalVentana,
} from "@misupertostada/shared";

export function saludoCopy(saludo: PortalSaludo, nombre: string): string {
  return saludo === "tardes"
    ? `Buenas tardes, ${nombre}.`
    : `Buenas noches, ${nombre}.`;
}

export function entregaCopy(sesion: Pick<PortalSesion, "ventana">): string {
  const fecha = formatearFechaLarga(sesion.ventana.fechaEntrega);
  const hora = sesion.ventana.horarioEntregaFijo;
  return hora
    ? `Su pedido llega el ${fecha} a las ${hora}.`
    : `Su pedido llega el ${fecha}.`;
}

/**
 * `null` cuando el negocio no tiene horario configurado: no hay apertura que
 * prometer, y es mejor pedirle al cliente que vuelva que inventarle una fecha.
 */
export function copyProximaApertura(iso: string | null): string {
  if (!iso) return "Vuelva a consultar más tarde.";
  const instante = new Date(iso);
  const fecha = formatearFechaLarga(fechaDeInstante(instante));
  return `Abre de nuevo el ${fecha} a las ${horaEnZona(instante)}.`;
}

/** El cierre es configurable por weekday: nunca lo escribas a mano en el copy. */
export function copyEdicionHasta(cierraAt: string | null): string | null {
  if (!cierraAt) return null;
  return `Puede cambiarlo hasta las ${horaEnZona(new Date(cierraAt))}. Después entra a producción.`;
}

/**
 * El reloj sigue vivo pero Cristian (o el cron) ya cerró el día. El navbar
 * del panel lo rotula «Día cerrado»; el portal usa el mismo predicado para
 * no decir «ventana abierta · cierra en…».
 */
export function cierreAnticipadoVentana(ventana: {
  abierta: boolean;
  diaEstado: DiaEstadoCalendario;
}): boolean {
  return ventana.abierta && ventana.diaEstado === "CERRADO";
}

/**
 * Props del `VentanaBadge` de pedido. Viven aquí para que el chrome del
 * portal (navbar) y las páginas no vuelvan a armar el objeto a mano.
 */
export function propsVentanaPedido(ventana: PortalVentana): {
  abierta: boolean;
  reabierta: boolean;
  diaCerrado: boolean;
  cierraAt: string | null;
  proximaAperturaAt: string | null;
} {
  return {
    abierta: ventana.abierta,
    reabierta: ventana.diaEstado === "REABIERTO",
    diaCerrado: ventana.diaEstado === "CERRADO",
    cierraAt: ventana.cierraAt,
    proximaAperturaAt: ventana.proximaAperturaAt,
  };
}

/** Countdown del portal: hacia el cierre, o hacia la apertura si no hay ventana viva. */
export function propsVentanaCountdown(ventana: PortalVentana): {
  cierraAt: string | null;
  abreAt: string | null;
} {
  if (cierreAnticipadoVentana(ventana) || !ventana.abierta) {
    return { cierraAt: null, abreAt: ventana.proximaAperturaAt };
  }
  return { cierraAt: ventana.cierraAt, abreAt: null };
}

/**
 * Qué muestra `/pedir`. Se deriva del pedido que tiene el servidor más la
 * intención explícita del cliente de editarlo; congelarlo en un `useState`
 * inicial dejaba la pantalla pegada cuando el pedido aparecía después —por SSE
 * o porque la tienda lo capturó por teléfono— y el cliente podía sobrescribirlo
 * sin enterarse.
 */
export function vistaPedir(input: {
  pedidoAbierto: PortalPedido | null;
  editando: boolean;
}): "confirmacion" | "catalogo" {
  if (input.pedidoAbierto && !input.editando) return "confirmacion";
  return "catalogo";
}

/**
 * Por qué no se puede confirmar. `null` = se puede.
 *
 * Existe porque el pie del catálogo se montaba solo si había algo en el
 * carrito, y en el teléfono ese pie es el único camino a «Revisar pedido»: un
 * cliente que vaciaba su pedido para rehacerlo se quedaba sin ninguna acción a
 * la vista. La regla del repo es control deshabilitado con motivo, nunca
 * control escondido.
 */
export function motivoNoConfirmar(input: {
  abierta: boolean;
  cierreAnticipado: boolean;
  lineas: number;
  proximaAperturaAt: string | null;
}): string | null {
  if (input.cierreAnticipado) {
    return `El día ya cerró. ${copyProximaApertura(input.proximaAperturaAt)}`;
  }
  if (!input.abierta) {
    return `La ventana de pedido está cerrada. ${copyProximaApertura(input.proximaAperturaAt)}`;
  }
  if (input.lineas === 0) {
    return "Agregue al menos un producto para poder confirmar.";
  }
  return null;
}

export type CtaInicio =
  | { kind: "pedir"; label: "Hacer mi pedido" }
  | { kind: "editar"; label: "Ver o editar mi pedido" }
  | { kind: "catalogo"; label: "Ver catálogo" }
  | { kind: "pedidos"; label: "Ver mis pedidos" };

export function ctaInicio(input: {
  abierta: boolean;
  pedidoAbierto: PortalPedido | null;
}): CtaInicio {
  if (input.abierta && !input.pedidoAbierto) {
    return { kind: "pedir", label: "Hacer mi pedido" };
  }
  if (input.abierta && input.pedidoAbierto) {
    return { kind: "editar", label: "Ver o editar mi pedido" };
  }
  return { kind: "pedidos", label: "Ver mis pedidos" };
}

/** CTA secundaria cuando la ventana está cerrada: ver catálogo (solo lectura). */
export function ctaInicioSecundaria(abierta: boolean): CtaInicio | null {
  if (abierta) return null;
  return { kind: "catalogo", label: "Ver catálogo" };
}

export function avisoLimiteCredito(cuenta: {
  facturasPendientes: number;
  limiteFacturasPendientes: number | null;
}): string | null {
  const limite = cuenta.limiteFacturasPendientes;
  if (limite == null) return null;
  if (cuenta.facturasPendientes < limite) return null;
  return "Tiene una acumulación alta de facturas pendientes. Puede pedir igual; la fábrica le avisa antes de despachar.";
}

export type GrupoCatalogo = {
  key: string;
  titulo: string;
  productos: PortalProducto[];
};

/**
 * El cliente escribe «tostada» con el teclado del teléfono, sin acentos, y el
 * catálogo tiene «Tostáda»; también al revés. Comparar substrings crudos hacía
 * que la búsqueda no encontrara nada y la pantalla culpara al cliente con
 * «Nada con ese nombre».
 */
export function normalizarBusqueda(texto: string): string {
  return texto
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLowerCase();
}

function coincideBusqueda(p: PortalProducto, query: string): boolean {
  const q = normalizarBusqueda(query);
  if (!q) return true;
  return (
    normalizarBusqueda(p.alias).includes(q) ||
    normalizarBusqueda(p.nombreCanonico).includes(q)
  );
}

/**
 * Favoritos primero (si coinciden), resto agrupado por familia
 * en el orden canónico TORTILLA → TOSTADA → FRITURA.
 */
export function gruposCatalogo(input: {
  catalogo: readonly PortalProducto[];
  query?: string;
}): { favoritos: PortalProducto[]; grupos: GrupoCatalogo[] } {
  const filtrados = input.catalogo.filter((p) =>
    coincideBusqueda(p, input.query ?? ""),
  );
  const favoritos = filtrados.filter((p) => p.favorito);
  const resto = filtrados.filter((p) => !p.favorito);

  const porFamilia = new Map<Familia, PortalProducto[]>();
  for (const f of FAMILIAS) porFamilia.set(f, []);
  for (const p of resto) {
    porFamilia.get(p.familia)?.push(p);
  }

  const grupos: GrupoCatalogo[] = [];
  for (const f of FAMILIAS) {
    const productos = porFamilia.get(f) ?? [];
    if (productos.length === 0) continue;
    grupos.push({
      key: f,
      titulo: FAMILIA_ETIQUETA[f],
      productos,
    });
  }

  return { favoritos, grupos };
}

export function origenPedidoLabel(origen: "PORTAL" | "MANUAL"): string {
  return origen === "PORTAL" ? "Portal" : "Tienda";
}

export function cantidadesDesdePedido(
  pedido: PortalPedido | null,
): Record<string, number> {
  if (!pedido) return {};
  return Object.fromEntries(
    pedido.items
      .filter((item) => !item.esDevolucion)
      .map((item) => [item.productoId, item.cantidad]),
  );
}

export function cantidadesBonoDesdePedido(
  pedido: PortalPedido | null,
): Record<string, number> {
  if (!pedido) return {};
  return Object.fromEntries(
    pedido.items
      .filter((item) => item.esDevolucion && item.bonoId)
      .map((item) => [item.bonoId!, item.cantidad]),
  );
}

export function lineasPedidoCount(
  ...cantidades: Record<string, number>[]
): number {
  return cantidades.reduce(
    (n, rec) => n + Object.values(rec).filter((v) => v > 0).length,
    0,
  );
}

export function copyCuentaProductos(
  lineas: number,
  variante: "en-pedido" | "corto",
): string {
  const noun = lineas === 1 ? "producto" : "productos";
  return variante === "en-pedido"
    ? `${lineas} ${noun} en pedido`
    : `${lineas} ${noun}`;
}

export function hayBonosPendientes(
  bonos: readonly Pick<PortalBono, "cantidadDisponible">[] | null | undefined,
): boolean {
  return (bonos ?? []).some((b) => b.cantidadDisponible > 0);
}

export function copyLosetaBonos(
  bonos: readonly Pick<
    PortalBono,
    "alias" | "cantidadDisponible" | "unidadMedida"
  >[],
): { cifra: number; etiqueta: string; detalle: string } | null {
  const activos = bonos.filter((b) => b.cantidadDisponible > 0);
  if (activos.length === 0) return null;
  const primero = activos[0]!;
  if (activos.length === 1) {
    return {
      cifra: primero.cantidadDisponible,
      etiqueta: `${UNIDAD_CORTA[primero.unidadMedida]} gratis`,
      detalle: primero.alias,
    };
  }
  return {
    cifra: activos.length,
    etiqueta: "productos gratis",
    detalle: activos
      .map(
        (b) =>
          `${b.cantidadDisponible} ${UNIDAD_CORTA[b.unidadMedida]} de ${b.alias}`,
      )
      .join(" · "),
  };
}

export function assetSrcPathPortal(token: string, assetId: string): string {
  return `/p/${encodeURIComponent(token)}/assets/${assetId}`;
}

/** Enlace completo del portal para compartir con el cliente. El portal lo sirve
    la misma app que el panel, así que el origen del panel es el del portal
    (en producción, `https://pedidos.misupertostada.com`). */
export function enlacePortal(origen: string, token: string): string {
  return `${origen.replace(/\/+$/, "")}/p/${encodeURIComponent(token)}`;
}
