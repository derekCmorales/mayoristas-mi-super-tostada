import { z } from "zod";

/**
 * Teléfonos de WhatsApp.
 *
 * Meta envía y recibe el número en formato internacional sin `+`
 * (`50255551234`). Aquí se guarda con `+` (`+50255551234`) y se muestra
 * agrupado (`+502 5555 1234`).
 *
 * Reglas de Guatemala: 8 dígitos; el primero dice qué es.
 * - 3, 4 y 5: celular. Es lo normal para WhatsApp.
 * - 2, 6 y 7: línea fija. Solo funciona si el restaurante registró ese fijo
 *   en WhatsApp Business; se marca para revisarlo, no se rechaza.
 * - 1, 8, 9 y 0 no existen como número de abonado.
 *
 * Un número de otro país se acepta solo si viene con `+` (o `00`): sin el
 * prefijo no hay forma de saber de dónde es.
 */
export const CODIGO_PAIS_GT = "502";

export type TelefonoWaEstado =
  /** No hay número capturado. */
  | "SIN_NUMERO"
  /** El texto no es un número que WhatsApp pueda recibir. */
  | "INVALIDO"
  /** Número de Guatemala que empieza con 2, 6 o 7: fijo. */
  | "FIJO"
  /** Listo para enviar. */
  | "VALIDO";

export type TelefonoWaRevision = {
  estado: TelefonoWaEstado;
  /** `+50255551234`, o null si no hay número enviable. */
  e164: string | null;
  /** `+502 5555 1234` para mostrar; el texto original si no es válido. */
  legible: string | null;
  /** Por qué no sirve o qué revisar. Null si está bien. */
  problema: string | null;
};

export const TELEFONO_WA_ESTADO_ETIQUETA: Record<TelefonoWaEstado, string> = {
  SIN_NUMERO: "Sin WhatsApp",
  INVALIDO: "WhatsApp inválido",
  FIJO: "WhatsApp en fijo",
  VALIDO: "WhatsApp listo",
};

/** Solo dígitos. Lo usa el webhook para comparar lo que manda Meta. */
export function normalizarTelefonoWa(raw: string): string {
  return raw.replace(/\D/g, "");
}

const PRIMER_DIGITO_GT_VALIDO = /^[234567]/;
const PRIMER_DIGITO_GT_FIJO = /^[267]/;

export function revisarTelefonoWa(
  raw: string | null | undefined,
): TelefonoWaRevision {
  const texto = (raw ?? "").trim();
  if (!texto) {
    return { estado: "SIN_NUMERO", e164: null, legible: null, problema: "Sin número de WhatsApp" };
  }
  const invalido = (problema: string): TelefonoWaRevision => ({
    estado: "INVALIDO",
    e164: null,
    legible: texto,
    problema,
  });
  // Solo dígitos, espacios, guiones, puntos, paréntesis y un `+` inicial.
  if (!/^\+?[\d\s().-]+$/.test(texto)) {
    return invalido("Tiene letras o símbolos");
  }
  const internacional = texto.startsWith("+") || /^00/.test(texto.replace(/\D/g, ""));
  let digitos = normalizarTelefonoWa(texto);
  if (texto.startsWith("+") === false && digitos.startsWith("00")) {
    digitos = digitos.slice(2);
  }

  let local: string | null = null;
  if (digitos.length === 8 && !texto.startsWith("+")) {
    local = digitos;
  } else if (digitos.startsWith(CODIGO_PAIS_GT)) {
    if (digitos.length !== 11) {
      return invalido("Un número de Guatemala lleva 8 dígitos después del 502");
    }
    local = digitos.slice(3);
  } else if (!internacional) {
    return invalido(
      digitos.length < 8
        ? "Faltan dígitos: un número de Guatemala lleva 8"
        : "Sobran dígitos: un número de Guatemala lleva 8 (o +código de país)",
    );
  }

  if (local !== null) {
    if (!PRIMER_DIGITO_GT_VALIDO.test(local)) {
      return invalido("En Guatemala ningún número empieza con " + local[0]);
    }
    const e164 = `+${CODIGO_PAIS_GT}${local}`;
    const legible = `+${CODIGO_PAIS_GT} ${local.slice(0, 4)} ${local.slice(4)}`;
    if (PRIMER_DIGITO_GT_FIJO.test(local)) {
      return {
        estado: "FIJO",
        e164,
        legible,
        problema: "Parece línea fija: confirme que tenga WhatsApp Business",
      };
    }
    return { estado: "VALIDO", e164, legible, problema: null };
  }

  // Otro país: E.164 admite de 8 a 15 dígitos con el código incluido.
  if (digitos.length < 8 || digitos.length > 15 || digitos.startsWith("0")) {
    return invalido("Número internacional con longitud o código de país incorrecto");
  }
  return { estado: "VALIDO", e164: `+${digitos}`, legible: `+${digitos}`, problema: null };
}

/** Lo que va en `to` del Graph API: dígitos con código de país, sin `+`. Null si no se puede enviar. */
export function telefonoWaParaEnvio(raw: string | null | undefined): string | null {
  const r = revisarTelefonoWa(raw);
  return r.e164 ? r.e164.slice(1) : null;
}

/** Para mostrar en el panel: agrupado si es válido, tal cual si no. */
export function formatearTelefonoWa(raw: string | null | undefined): string | null {
  return revisarTelefonoWa(raw).legible;
}

/**
 * Campo de formulario: vacío → null; con número, debe ser enviable y se guarda
 * canónico (`+50255551234`), así el webhook y el envío leen lo mismo.
 */
export const telefonoWaSchema = z
  .string()
  .trim()
  .max(32)
  .nullable()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    if (v === null || v === "") return null;
    const r = revisarTelefonoWa(v);
    if (!r.e164) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: r.problema ?? "Teléfono inválido" });
      return z.NEVER;
    }
    return r.e164;
  });
