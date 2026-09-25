import { z } from "zod";
import { formatearFechaLarga } from "./calendar";
import { centavosSchema, formatearCentavos } from "./money";
import { PEDIDO_ESTADOS } from "./estados";

/** Código de Meta cuando se envía texto libre fuera de la ventana de 24 h. */
export const META_ERROR_VENTANA_CERRADA = "131047";

/** Límite de una variable de plantilla (Cloud API). */
export const META_PARAM_MAX_CHARS = 1024;

/** Texto libre de sesión (Cloud API). */
export const META_TEXTO_MAX_CHARS = 4096;

export const MENSAJE_VENTANA_WA_CERRADA =
  "Este restaurante no ha escrito recientemente. Solo puede mandar un aviso ya armado.";
export const MENSAJE_PREVIEW_NO_COINCIDE =
  "El preview no coincide con el mensaje a enviar.";
export const MENSAJE_PLANTILLA_NO_APROBADA =
  "Esa plantilla no está aprobada. Meta puede haberla pausado.";
export const MENSAJE_PARAMETRO_INVALIDO =
  "Las variables de plantilla no admiten saltos de línea, tabulaciones ni más de 4 espacios seguidos.";

export const PLANTILLA_PROPOSITOS = [
  "INVITACION",
  "CONFIRMACION",
  "ESTADO_CUENTA",
  "CONSOLIDADO",
] as const;
export type PlantillaProposito = (typeof PLANTILLA_PROPOSITOS)[number];

/** Copy operacional de los cuatro avisos automáticos (sin nombres Meta). */
export const PROPOSITO_ETIQUETA: Record<PlantillaProposito, string> = {
  INVITACION: "Aviso de invitación a pedir",
  CONFIRMACION: "Aviso de confirmación de pedido",
  ESTADO_CUENTA: "Aviso de estado de cuenta",
  CONSOLIDADO: "Aviso de pedido consolidado",
};

export const pedidoNocheSchema = z.object({
  id: z.string().uuid(),
  correlativo: z.number().int().positive(),
  estado: z.enum(PEDIDO_ESTADOS),
  fechaOperacion: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});
export type PedidoNoche = z.infer<typeof pedidoNocheSchema>;

export const TIPO_OUTBOX_PEDIDO_CONFIRMADO = "PedidoConfirmado";
export const TIPO_OUTBOX_INVITACION = "InvitacionDiaria";
export const TIPO_OUTBOX_RECORDATORIO = "RecordatorioCobro";

export const MESSAGING_SSE_TIPOS = ["mensaje.nuevo", "mensaje.estado"] as const;
export type MessagingSseTipo = (typeof MESSAGING_SSE_TIPOS)[number];

export const MENSAJE_DIRECCIONES = ["INBOUND", "OUTBOUND"] as const;
export const MENSAJE_STATUS = [
  "sent",
  "delivered",
  "read",
  "failed",
  "pending",
] as const;

export type ValidacionPlantilla =
  | { ok: true }
  | { ok: false; code: "SALTO_LINEA" | "TAB" | "ESPACIOS" | "VACIO" | "LONGITUD"; mensaje: string };

/**
 * F-706. Atrapa el error aquí, no en Meta.
 * Un parámetro no puede tener salto de línea, tab, >4 espacios seguidos,
 * estar vacío ni exceder el límite de caracteres.
 */
export function validarParametrosPlantilla(
  params: readonly string[],
): ValidacionPlantilla {
  for (const raw of params) {
    if (raw.length === 0 || raw.trim().length === 0) {
      return {
        ok: false,
        code: "VACIO",
        mensaje: "Ninguna variable de plantilla puede ir vacía.",
      };
    }
    if (raw.includes("\n") || raw.includes("\r")) {
      return {
        ok: false,
        code: "SALTO_LINEA",
        mensaje: MENSAJE_PARAMETRO_INVALIDO,
      };
    }
    if (raw.includes("\t")) {
      return { ok: false, code: "TAB", mensaje: MENSAJE_PARAMETRO_INVALIDO };
    }
    if (/ {5,}/.test(raw)) {
      return {
        ok: false,
        code: "ESPACIOS",
        mensaje: MENSAJE_PARAMETRO_INVALIDO,
      };
    }
    if (raw.length > META_PARAM_MAX_CHARS) {
      return {
        ok: false,
        code: "LONGITUD",
        mensaje: `Una variable supera los ${META_PARAM_MAX_CHARS} caracteres de Meta.`,
      };
    }
  }
  return { ok: true };
}

/** Sustituye `{{1}}`, `{{2}}`, … (índice 1 como en Meta). */
export function renderCuerpoPlantilla(
  cuerpo: string,
  params: readonly string[],
): string {
  return cuerpo.replace(/\{\{(\d+)\}\}/g, (_m, n: string) => {
    const idx = Number(n) - 1;
    return params[idx] ?? "";
  });
}

export function extraerCuerpoPlantilla(componentes: unknown): string {
  if (!Array.isArray(componentes)) return "";
  for (const raw of componentes) {
    if (
      raw &&
      typeof raw === "object" &&
      "type" in raw &&
      String(raw.type).toUpperCase() === "BODY" &&
      "text" in raw &&
      typeof raw.text === "string"
    ) {
      return raw.text;
    }
  }
  return "";
}

/**
 * Convierte el timestamp Unix (segundos) del webhook de Meta en la
 * expiración de la ventana de 24 h. No usa el reloj local.
 */
export function ventanaExpiraAtDesdeWebhook(timestampUnix: number): Date {
  return new Date((timestampUnix + 24 * 60 * 60) * 1000);
}

export function ventanaWaAbierta(
  ventanaExpiraAt: Date | string | null | undefined,
  now: Date,
): boolean {
  if (!ventanaExpiraAt) return false;
  const expira =
    ventanaExpiraAt instanceof Date
      ? ventanaExpiraAt
      : new Date(ventanaExpiraAt);
  return now.getTime() < expira.getTime();
}

/** `fechaEntrega`: el día en que se reparte, no el día en que abre la ventana. */
export function textoInvitacion(fechaEntrega: string): string {
  const fecha = formatearFechaLarga(fechaEntrega);
  return `Buenas noches. Ya está abierta la toma de pedidos para ${fecha}. Puede responder aquí o abrir su portal.`;
}

export function paramsInvitacion(fechaEntrega: string): string[] {
  return [formatearFechaLarga(fechaEntrega)];
}

export function paramsConfirmacion(input: {
  correlativo: number;
  fechaEntrega: string;
  totalCentavos: number;
  horarioEntregaFijo: string | null;
}): string[] {
  const fecha = formatearFechaLarga(input.fechaEntrega);
  const conHorario = input.horarioEntregaFijo
    ? `${fecha}. Entrega a las ${input.horarioEntregaFijo}`
    : fecha;
  return [
    String(input.correlativo),
    conHorario,
    formatearCentavos(input.totalCentavos),
  ];
}

export function textoEstadoCuenta(input: {
  pendientes: number;
  saldoCentavos: number;
}): string {
  const saldo = formatearCentavos(input.saldoCentavos);
  return `Le compartimos su estado de cuenta: ${input.pendientes} facturas pendientes por ${saldo}.`;
}

export function paramsEstadoCuenta(input: {
  pendientes: number;
  saldoCentavos: number;
}): string[] {
  return [
    String(input.pendientes),
    formatearCentavos(input.saldoCentavos),
  ];
}

/** Interno (planta): lleva las dos fechas, que no coinciden. */
export function textoConsolidado(input: {
  fechaOperacion: string;
  fechaEntrega: string;
  version: number;
}): string {
  const operacion = formatearFechaLarga(input.fechaOperacion);
  const entrega = formatearFechaLarga(input.fechaEntrega);
  return `Pedido consolidado de la operación del ${operacion} · entrega ${entrega} (v${input.version}).`;
}

export function paramsConsolidado(input: {
  fechaOperacion: string;
  fechaEntrega: string;
  version: number;
}): string[] {
  return [
    `${formatearFechaLarga(input.fechaOperacion)} · entrega ${formatearFechaLarga(input.fechaEntrega)}`,
    String(input.version),
  ];
}

export function normalizarTelefonoWa(raw: string): string {
  const digitos = raw.replace(/\D/g, "");
  return digitos;
}

const uuid = z.string().uuid();

export const enviarMensajeRequestSchema = z.discriminatedUnion("tipo", [
  z.object({
    tipo: z.literal("texto"),
    cuerpo: z.string().min(1).max(META_TEXTO_MAX_CHARS),
    cuerpoRenderizado: z.string().min(1),
  }),
  z.object({
    tipo: z.literal("plantilla"),
    plantillaId: uuid.optional(),
    proposito: z.enum(PLANTILLA_PROPOSITOS).optional(),
    params: z.array(z.string()).default([]),
    cuerpoRenderizado: z.string().min(1),
  }),
]);
export type EnviarMensajeRequest = z.infer<typeof enviarMensajeRequestSchema>;

export const mapearPropositoRequestSchema = z.object({
  proposito: z.enum(PLANTILLA_PROPOSITOS),
  plantillaId: uuid,
});
export type MapearPropositoRequest = z.infer<typeof mapearPropositoRequestSchema>;

export const recordatorioCobroRequestSchema = z.object({
  clienteId: uuid,
});
export type RecordatorioCobroRequest = z.infer<
  typeof recordatorioCobroRequestSchema
>;

export const simularInboundRequestSchema = z.object({
  from: z.string().min(5).max(20),
  body: z.string().min(1).max(META_TEXTO_MAX_CHARS),
  timestamp: z.number().int().positive().optional(),
});
export type SimularInboundRequest = z.infer<typeof simularInboundRequestSchema>;

export const mensajePublicoSchema = z.object({
  id: uuid,
  waMessageId: z.string().nullable(),
  direction: z.enum(MENSAJE_DIRECCIONES),
  tipo: z.string(),
  templateName: z.string().nullable(),
  proposito: z.enum(PLANTILLA_PROPOSITOS).nullable().optional(),
  bodyRenderizado: z.string().nullable(),
  status: z.string().nullable(),
  errorCode: z.string().nullable(),
  createdAt: z.string().min(20),
  adjuntoNombre: z.string().nullable().optional(),
});
export type MensajePublico = z.infer<typeof mensajePublicoSchema>;

export const conversacionBandejaSchema = z.object({
  id: uuid,
  clienteId: uuid,
  clienteNombre: z.string(),
  telefonoWa: z.string().nullable(),
  ventanaExpiraAt: z.string().nullable(),
  ventanaAbierta: z.boolean(),
  ultimoInboundAt: z.string().nullable(),
  noLeidos: z.number().int().nonnegative(),
  ultimoCuerpo: z.string().nullable(),
  ultimoAt: z.string().nullable(),
  horarioEntregaFijo: z.string().nullable(),
  notasPermanentes: z.string().nullable(),
  saldoCentavos: centavosSchema,
  facturasPendientes: z.number().int().nonnegative(),
  pedidoNoche: pedidoNocheSchema.nullable(),
  fechaOperacionViva: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});
export type ConversacionBandeja = z.infer<typeof conversacionBandejaSchema>;

export const conversacionDetalleSchema = conversacionBandejaSchema.extend({
  mensajes: z.array(mensajePublicoSchema),
});
export type ConversacionDetalle = z.infer<typeof conversacionDetalleSchema>;

export const plantillaWaPublicaSchema = z.object({
  id: uuid,
  name: z.string(),
  category: z.string(),
  language: z.string(),
  status: z.string(),
  componentes: z.unknown(),
  proposito: z.enum(PLANTILLA_PROPOSITOS).nullable(),
  sincronizadoAt: z.string().nullable(),
});
export type PlantillaWaPublica = z.infer<typeof plantillaWaPublicaSchema>;

export const conexionWabaPublicaSchema = z.object({
  estado: z.enum(["DESCONECTADO", "CONECTADO", "DESARROLLO"]),
  modoDesarrollo: z.boolean(),
  puedeConectarMeta: z.boolean(),
  wabaId: z.string().nullable(),
  waProduccion: z.string().nullable(),
  waTienda: z.string().nullable(),
});
export type ConexionWabaPublica = z.infer<typeof conexionWabaPublicaSchema>;

export const estadoCuentaPdfFacturaSchema = z.object({
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
  abonadoCentavos: centavosSchema,
  saldoCentavos: centavosSchema,
  estado: z.string(),
  antiguedadDias: z.number().int().nonnegative(),
});

export const estadoCuentaPdfSchema = z.object({
  clienteNombre: z.string(),
  generadoAt: z.string(),
  facturasPendientes: z.number().int().nonnegative(),
  saldoCentavos: centavosSchema,
  facturas: z.array(estadoCuentaPdfFacturaSchema),
});
export type EstadoCuentaPdf = z.infer<typeof estadoCuentaPdfSchema>;

export const messagingSseEventSchema = z.object({
  tipo: z.enum(MESSAGING_SSE_TIPOS),
  conversacionId: uuid.optional(),
  mensajeId: uuid.optional(),
  clienteId: uuid.optional(),
});
export type MessagingSseEvent = z.infer<typeof messagingSseEventSchema>;
