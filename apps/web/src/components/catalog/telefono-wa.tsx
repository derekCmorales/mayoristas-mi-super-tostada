"use client";

import { Chip } from "@heroui/react";
import {
  TELEFONO_WA_ESTADO_ETIQUETA,
  revisarTelefonoWa,
  type ClientePublico,
} from "@misupertostada/shared";

/**
 * ¿Le llegan los avisos de WhatsApp a este cliente? Un número sin formato o
 * sin enlace del portal hace que la invitación y la confirmación no salgan, y
 * eso solo se nota cuando el restaurante dice «no me llegó nada».
 */
export function problemaWhatsapp(
  cliente: Pick<ClientePublico, "telefonoWa" | "tieneTokenPortal">,
): { etiqueta: string; detalle: string; tono: "danger" | "warning" } | null {
  const tel = revisarTelefonoWa(cliente.telefonoWa);
  if (tel.estado === "SIN_NUMERO") {
    return { etiqueta: TELEFONO_WA_ESTADO_ETIQUETA.SIN_NUMERO, detalle: "No recibe avisos", tono: "warning" };
  }
  if (tel.estado === "INVALIDO") {
    return { etiqueta: TELEFONO_WA_ESTADO_ETIQUETA.INVALIDO, detalle: tel.problema ?? "", tono: "danger" };
  }
  if (!cliente.tieneTokenPortal) {
    return {
      etiqueta: "Sin portal",
      detalle: "Sin enlace del portal no recibe invitación ni confirmación",
      tono: "warning",
    };
  }
  if (tel.estado === "FIJO") {
    return { etiqueta: TELEFONO_WA_ESTADO_ETIQUETA.FIJO, detalle: tel.problema ?? "", tono: "warning" };
  }
  return null;
}

export function WhatsappChip({
  cliente,
}: {
  cliente: Pick<ClientePublico, "telefonoWa" | "tieneTokenPortal">;
}) {
  const p = problemaWhatsapp(cliente);
  if (!p) return null;
  return (
    <Chip color={p.tono} size="sm" variant="soft" title={p.detalle}>
      {p.etiqueta}
    </Chip>
  );
}

/**
 * Texto de ayuda bajo el campo: cómo quedará guardado, o qué le falta. Así se
 * corrige al capturar y no cuando Meta rechaza el envío.
 */
export function ayudaTelefonoWa(raw: string): { texto: string; invalido: boolean } {
  if (!raw.trim()) {
    return { texto: "8 dígitos de Guatemala, o con + si es de otro país", invalido: false };
  }
  const r = revisarTelefonoWa(raw);
  if (!r.e164) return { texto: r.problema ?? "Número inválido", invalido: true };
  if (r.estado === "FIJO") return { texto: `${r.legible} · ${r.problema}`, invalido: false };
  return { texto: `Se guarda como ${r.legible}`, invalido: false };
}
