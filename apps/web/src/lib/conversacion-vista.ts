import {
  PROPOSITO_ETIQUETA,
  type ConversacionBandeja,
  type MensajePublico,
  type PlantillaProposito,
} from "@misupertostada/shared";

/** Segmento de trabajo en la bandeja de excepciones. */
export type ConversacionSegmento =
  | "por_contestar"
  | "puedo_responder"
  | "todas";

export type ConversacionesUrlState = {
  id?: string;
  segmento?: ConversacionSegmento;
};

export function parseConversacionSegmento(
  raw: string | null | undefined,
): ConversacionSegmento {
  if (raw === "por_contestar" || raw === "puedo_responder") return raw;
  return "todas";
}

export function buildConversacionesHref(
  state: ConversacionesUrlState,
): string {
  const s = new URLSearchParams();
  if (state.id) s.set("id", state.id);
  if (state.segmento && state.segmento !== "todas") {
    s.set("segmento", state.segmento);
  }
  const q = s.toString();
  return q ? `/conversaciones?${q}` : "/conversaciones";
}

export function puedeResponder(conv: ConversacionBandeja): boolean {
  return conv.ventanaAbierta;
}

export function porContestar(conv: ConversacionBandeja): boolean {
  return conv.noLeidos > 0;
}

export function aplicarSegmentoLista(
  rows: readonly ConversacionBandeja[],
  segmento: ConversacionSegmento,
): ConversacionBandeja[] {
  if (segmento === "por_contestar") {
    return rows.filter(porContestar);
  }
  if (segmento === "puedo_responder") {
    return rows.filter(puedeResponder);
  }
  return [...rows];
}

export function filtrarBandeja(
  rows: readonly ConversacionBandeja[],
  q: string,
): ConversacionBandeja[] {
  const needle = q.trim().toLowerCase();
  if (!needle) return [...rows];
  return rows.filter((v) => {
    if (v.clienteNombre.toLowerCase().includes(needle)) return true;
    return (v.ultimoCuerpo ?? "").toLowerCase().includes(needle);
  });
}

export function conteosSegmento(rows: readonly ConversacionBandeja[]): {
  todas: number;
  por_contestar: number;
  puedo_responder: number;
} {
  let por_contestar = 0;
  let puedo_responder = 0;
  for (const v of rows) {
    if (porContestar(v)) por_contestar += 1;
    if (puedeResponder(v)) puedo_responder += 1;
  }
  return {
    todas: rows.length,
    por_contestar,
    puedo_responder,
  };
}

/** Lado visual de la burbuja: cliente a la izquierda, fábrica a la derecha. */
export function ladoBurbuja(
  direction: MensajePublico["direction"],
): "izquierda" | "derecha" {
  return direction === "INBOUND" ? "izquierda" : "derecha";
}

export function etiquetaMensajeSaliente(m: MensajePublico): string {
  if (m.tipo === "plantilla" && m.proposito) {
    return PROPOSITO_ETIQUETA[m.proposito];
  }
  if (m.tipo === "plantilla") {
    return "Aviso automático";
  }
  return "Respuesta de la fábrica";
}

export function copyVentanaWhatsapp(input: {
  ventanaAbierta: boolean;
  restanteMs: number | null;
}): { titulo: string; descripcion: string } {
  if (input.ventanaAbierta && input.restanteMs != null && input.restanteMs > 0) {
    const horas = Math.floor(input.restanteMs / 3_600_000);
    const textoHoras =
      horas >= 1
        ? `queda${horas === 1 ? "" : "n"} ${horas} h`
        : "queda menos de 1 h";
    return {
      titulo: `Puede responder · ${textoHoras}`,
      descripcion:
        "El restaurante escribió recientemente. Puede contestar en texto libre.",
    };
  }
  return {
    titulo: "Solo avisos armados",
    descripcion:
      "Este restaurante no ha escrito recientemente. Solo puede mandar un aviso ya definido.",
  };
}

export function copyEmptySegmento(
  segmento: ConversacionSegmento,
  hayBusqueda: boolean,
): { titulo: string; descripcion: string } {
  if (hayBusqueda) {
    return {
      titulo: "Ninguna conversación coincide",
      descripcion:
        "Pruebe con el nombre del restaurante o una palabra del último mensaje.",
    };
  }
  if (segmento === "por_contestar") {
    return {
      titulo: "Todo contestado",
      descripcion:
        "No hay mensajes sin leer. Cambie a Todas para ver la bandeja completa.",
    };
  }
  if (segmento === "puedo_responder") {
    return {
      titulo: "Nadie puede recibir texto libre",
      descripcion:
        "Ningún restaurante escribió recientemente. Use un aviso armado o espere que escriban.",
    };
  }
  return {
    titulo: "Sin conversaciones",
    descripcion:
      "El hilo se abre con el primer mensaje, de entrada o de salida.",
  };
}

export function propositoConectado(
  plantillas: readonly { proposito: PlantillaProposito | null; status: string }[],
  proposito: PlantillaProposito,
): boolean {
  return plantillas.some(
    (p) => p.proposito === proposito && p.status === "APPROVED",
  );
}

export function hrefCarteraCliente(clienteId: string): string {
  return `/cartera?clienteId=${clienteId}`;
}

export function hrefPedidoNoche(input: {
  fechaOperacion: string;
  pedidoId: string;
}): string {
  return `/pedidos?fechaOperacion=${input.fechaOperacion}&pedidoId=${input.pedidoId}`;
}

export function hrefCapturaPedido(clienteId: string, fechaOperacion: string): string {
  return `/pedidos?fechaOperacion=${fechaOperacion}&clienteId=${clienteId}`;
}

export function hrefFichaCliente(clienteId: string): string {
  return `/clientes/${clienteId}`;
}
