import { z } from "zod";
import {
  ABONO_ESTADOS,
  FAMILIAS,
  PAGO_METODOS,
  PEDIDO_ESTADOS,
  PEDIDO_ORIGENES,
  PUNTOS_CARGA,
  UNIDADES_MEDIDA,
} from "./estados";
import { MESSAGING_SSE_TIPOS } from "./messaging";
import { COBRANZA_SSE_TIPOS } from "./receivables";
import { CATALOGO_SSE_TIPOS } from "./catalog";
import {
  DIA_ESTADOS_CALENDARIO,
  formatearFechaLarga,
} from "./calendar";
import { centavosSchema, formatearCentavos } from "./money";

/** Query string: `""` y ausente → `undefined`, compatible con `parseBody`/`ZodType<T>`. */
function opcionalVacio<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.infer<T> | undefined> {
  return z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    schema.optional(),
  ) as z.ZodType<z.infer<T> | undefined>;
}

export const UNIDAD_CORTA = {
  LIBRA: "lb",
  BOLSA: "bolsas",
  UNIDAD: "un",
} as const;

/**
 * Total del pedido: suma de cantidad × precio_unitario, ambos enteros en
 * centavos. No hay redondeo: el producto de dos enteros ya es entero.
 * El redondeo bancario de `money.ts` aplica si algún día entra un factor no entero.
 */
export function totalPedidoCentavos(
  items: ReadonlyArray<{ cantidad: number; precioUnitarioCentavos: number }>,
): number {
  let total = 0;
  for (const item of items) {
    if (
      !Number.isInteger(item.cantidad) ||
      !Number.isInteger(item.precioUnitarioCentavos)
    ) {
      throw new Error("totalPedidoCentavos: solo enteros en centavos");
    }
    total += item.cantidad * item.precioUnitarioCentavos;
  }
  return total;
}

export const confirmarPedidoItemSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.number().int().min(1).max(9999),
  esDevolucion: z.boolean().default(false),
  bonoId: z.string().uuid().optional(),
});

export const confirmarPedidoRequestSchema = z.object({
  items: z.array(confirmarPedidoItemSchema).min(1),
});

export type ConfirmarPedidoRequest = z.infer<typeof confirmarPedidoRequestSchema>;

export const portalProductoSchema = z.object({
  productoId: z.string().uuid(),
  alias: z.string(),
  nombreCanonico: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  precioCentavos: z.number().int().nullable(),
  favorito: z.boolean(),
  familia: z.enum(FAMILIAS),
  orden: z.number().int(),
  pedible: z.boolean(),
  /** Foto del producto activo; null si no hay. Nunca SKU ni punto de carga. */
  fotoAssetId: z.string().uuid().nullable(),
});

export type PortalProducto = z.infer<typeof portalProductoSchema>;

export const portalVentanaSchema = z.object({
  abierta: z.boolean(),
  fechaOperacion: z.string().min(10),
  /** Día de reparto de esta ventana. Es la fecha que se le dice al cliente. */
  fechaEntrega: z.string().min(10),
  /**
   * Estado de la operación de captura. El navbar del panel lo usa para
   * «Día cerrado»; el portal tiene que ver el mismo bit, no reinventarlo
   * con `abierta` (que sigue true si el reloj no ha vencido).
   */
  diaEstado: z.enum(DIA_ESTADOS_CALENDARIO),
  /** `null` cuando no hay horario configurado: no hay cierre que prometer. */
  cierraAt: z.string().min(20).nullable(),
  /** `null` cuando la semana entera está apagada. */
  proximaAperturaAt: z.string().min(20).nullable(),
  horarioEntregaFijo: z.string().nullable(),
});

export type PortalVentana = z.infer<typeof portalVentanaSchema>;

export const portalPedidoItemSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.number().int().positive(),
  nombreMostrado: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  precioUnitarioCentavos: centavosSchema,
  subtotalCentavos: centavosSchema,
  esDevolucion: z.boolean().default(false),
  bonoId: z.string().uuid().nullable().default(null),
});

export type PortalPedidoItem = z.infer<typeof portalPedidoItemSchema>;

export const portalPedidoSchema = z.object({
  id: z.string().uuid(),
  correlativo: z.number().int().positive(),
  estado: z.enum(PEDIDO_ESTADOS),
  fechaOperacion: z.string(),
  fechaEntrega: z.string(),
  origen: z.literal("PORTAL"),
  items: z.array(portalPedidoItemSchema),
  totalCentavos: centavosSchema,
  textoConfirmacion: z.string(),
});

export type PortalPedido = z.infer<typeof portalPedidoSchema>;

/**
 * Factura del cliente en el portal. Lleva el pedido que la originó
 * (`factura.pedidoId` es único por pedido) porque sin el correlativo el DTE es
 * un número suelto: el cliente no puede saber a qué entrega corresponde.
 *
 * `PAGADO` entra en el enum a propósito. La lista de cobranza sigue contando
 * solo lo pendiente, pero una factura saldada tiene que seguir siendo
 * consultable: si desaparece, el abono que la pagó apunta a la nada.
 */
export const portalFacturaSchema = z.object({
  id: z.string().uuid(),
  pedidoId: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaEntrega: z.string(),
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
  abonadoCentavos: centavosSchema,
  saldoCentavos: centavosSchema,
  emitidaAt: z.string().nullable(),
  antiguedadDias: z.number().int().nonnegative(),
  estado: z.enum(["PENDIENTE", "ABONO_PARCIAL", "VENCIDO", "PAGADO"]),
});

export type PortalFactura = z.infer<typeof portalFacturaSchema>;

/** Nombre anterior; la forma ya no es solo de pendientes. */
export const portalFacturaPendienteSchema = portalFacturaSchema;
export type PortalFacturaPendiente = PortalFactura;

export const PORTAL_FACTURA_FILTROS = ["pendientes", "pagadas", "todas"] as const;
export type PortalFacturaFiltro = (typeof PORTAL_FACTURA_FILTROS)[number];

export const portalFacturasSchema = z.object({
  items: z.array(portalFacturaSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});
export type PortalFacturas = z.infer<typeof portalFacturasSchema>;

/**
 * A qué factura fue a parar cada quetzal de un abono. Trae el pedido para que
 * el DTE deje de ser texto muerto y se pueda abrir la entrega que se está
 * pagando.
 */
export const portalAbonoAplicacionSchema = z.object({
  facturaId: z.string().uuid(),
  pedidoId: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaEntrega: z.string(),
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
});
export type PortalAbonoAplicacion = z.infer<typeof portalAbonoAplicacionSchema>;

export const portalAbonoSchema = z.object({
  id: z.string().uuid(),
  montoCentavos: centavosSchema,
  metodo: z.enum(PAGO_METODOS),
  estado: z.enum(ABONO_ESTADOS),
  descripcion: z.string().nullable(),
  comprobanteAssetId: z.string().uuid().nullable(),
  fecha: z.string(),
  confirmadoAt: z.string().nullable(),
  motivoRechazo: z.string().nullable(),
  aplicaciones: z.array(portalAbonoAplicacionSchema),
});
export type PortalAbono = z.infer<typeof portalAbonoSchema>;

export const portalCuentaSchema = z.object({
  facturasPendientes: z.number().int().nonnegative(),
  limiteFacturasPendientes: z.number().int().nullable(),
  saldoCentavos: centavosSchema,
  facturas: z.array(portalFacturaSchema),
  abonos: z.array(portalAbonoSchema),
  transferenciasEnRevisionCentavos: centavosSchema,
});

export type PortalCuenta = z.infer<typeof portalCuentaSchema>;

/** Resumen liviano para historial / último pedido del home. No reusar portalPedidoSchema. */
export const portalPedidoResumenSchema = z.object({
  id: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaOperacion: z.string(),
  fechaEntrega: z.string(),
  estado: z.enum(PEDIDO_ESTADOS),
  totalCentavos: centavosSchema,
  origen: z.enum(PEDIDO_ORIGENES),
});

export type PortalPedidoResumen = z.infer<typeof portalPedidoResumenSchema>;

export const portalHistorialSchema = z.object({
  items: z.array(portalPedidoResumenSchema),
  nextOffset: z.number().int().nonnegative().nullable(),
});

export type PortalHistorial = z.infer<typeof portalHistorialSchema>;

export const portalBonoSchema = z.object({
  id: z.string().uuid(),
  productoId: z.string().uuid(),
  alias: z.string(),
  nombreCanonico: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  descripcion: z.string(),
  cantidadDisponible: z.number().int().nonnegative(),
  fotoAssetId: z.string().uuid().nullable(),
});

export type PortalBono = z.infer<typeof portalBonoSchema>;

export const portalPedidoDetalleItemSchema = z.object({
  productoId: z.string().uuid(),
  cantidad: z.number().int().positive(),
  nombreMostrado: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  precioUnitarioCentavos: centavosSchema,
  subtotalCentavos: centavosSchema,
  fotoAssetId: z.string().uuid().nullable(),
  esDevolucion: z.boolean().default(false),
  bonoId: z.string().uuid().nullable().default(null),
});

export type PortalPedidoDetalleItem = z.infer<
  typeof portalPedidoDetalleItemSchema
>;

/** Abono aplicado a la factura de un pedido, visto por el cliente. */
export const portalFacturaAbonoSchema = z.object({
  abonoId: z.string().uuid(),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  metodo: z.enum(PAGO_METODOS),
  estado: z.enum(ABONO_ESTADOS),
  montoCentavos: centavosSchema,
});
export type PortalFacturaAbono = z.infer<typeof portalFacturaAbonoSchema>;

export const portalPedidoDetalleFacturaSchema = z.object({
  id: z.string().uuid(),
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
  abonadoCentavos: centavosSchema,
  saldoCentavos: centavosSchema,
  antiguedadDias: z.number().int().nonnegative(),
  estado: z.enum(["PENDIENTE", "ABONO_PARCIAL", "VENCIDO", "PAGADO"]),
  /** Lo ya pagado de esta factura, para responder «cuánto me falta». */
  abonos: z.array(portalFacturaAbonoSchema),
});

export type PortalPedidoDetalleFactura = z.infer<
  typeof portalPedidoDetalleFacturaSchema
>;

/** Cobro aplicado a la factura de un pedido (panel). */
export const pedidoPagoSchema = z.object({
  id: z.string().uuid(),
  montoCentavos: centavosSchema,
  metodo: z.enum(PAGO_METODOS),
  fecha: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  comprobanteAssetId: z.string().uuid().nullable(),
});
export type PedidoPago = z.infer<typeof pedidoPagoSchema>;

export const pedidoDetalleFacturaSchema = portalPedidoDetalleFacturaSchema.extend({
  pagos: z.array(pedidoPagoSchema),
});
export type PedidoDetalleFactura = z.infer<typeof pedidoDetalleFacturaSchema>;

export const portalPedidoDetalleClienteSchema = portalPedidoResumenSchema.extend({
  items: z.array(portalPedidoDetalleItemSchema),
  factura: portalPedidoDetalleFacturaSchema.nullable(),
});

export type PortalPedidoDetalleCliente = z.infer<
  typeof portalPedidoDetalleClienteSchema
>;

export const portalSaludoSchema = z.enum(["tardes", "noches"]);

export type PortalSaludo = z.infer<typeof portalSaludoSchema>;

export const portalSesionSchema = z.object({
  cliente: z.object({
    id: z.string().uuid(),
    nombre: z.string(),
    horarioEntregaFijo: z.string().nullable(),
  }),
  ventana: portalVentanaSchema,
  catalogo: z.array(portalProductoSchema),
  bonos: z.array(portalBonoSchema).default([]),
  pedidoAbierto: portalPedidoSchema.nullable(),
  cuenta: portalCuentaSchema,
  /** Instantáneo del servidor (GT) — solo presentación. */
  ahoraIso: z.string().min(20),
  /** < 18:00 GT → tardes; si no → noches. Lo calcula el servidor. */
  saludo: portalSaludoSchema,
  ultimoPedido: portalPedidoResumenSchema.nullable(),
});

export type PortalSesion = z.infer<typeof portalSesionSchema>;

export function textoConfirmacionPedido(input: {
  correlativo: number;
  /** Día de reparto, no el día en que abrió la ventana. */
  fechaEntrega: string;
  totalCentavos: number;
  horarioEntregaFijo: string | null;
}): string {
  const fecha = formatearFechaLarga(input.fechaEntrega);
  const total = formatearCentavos(input.totalCentavos);
  const horario = input.horarioEntregaFijo
    ? ` Entrega a las ${input.horarioEntregaFijo}.`
    : "";
  return `Recibimos su pedido ${input.correlativo} para el ${fecha}. Total ${total}.${horario}`;
}

export const MENSAJE_PORTAL_NO_ENCONTRADO = "No encontramos esa página.";
export const MENSAJE_PEDIDO_PORTAL_NO_ENCONTRADO = "No encontramos ese pedido.";
export const MENSAJE_VENTANA_CERRADA =
  "La ventana de pedido está cerrada. Abre de nuevo a la hora indicada.";
export const MENSAJE_PRECIO_AUSENTE =
  "Ese producto no tiene precio. Avisé a la fábrica.";
export const MENSAJE_LIMITE_TASA =
  "Demasiadas solicitudes. Espere un momento y vuelva a intentar.";
export const MENSAJE_PEDIDO_ANULADO =
  "Ese pedido está anulado y no se puede modificar.";
export const MENSAJE_MOTIVO_ANULACION =
  "Indique el motivo. El pedido queda anulado, no se borra.";
export const MENSAJE_MOTIVO_AJUSTE_PRECIO =
  "Indique el motivo del cambio de precio. Queda en el historial.";
export const MENSAJE_PRECIO_LINEA_CAPTURADA =
  "Esa línea ya tiene precio. Para cambiarlo use «Corregir precios»: pide motivo.";
export const MENSAJE_VISTA_PREVIA_VENCIDA =
  "Los pedidos o el catálogo cambiaron desde la vista previa. Revísela de nuevo.";
export const MENSAJE_AJUSTE_BAJO_ABONADO =
  "Esta factura ya tiene abonado más que el nuevo total. Corrija el abono antes de bajar el precio.";

const fechaOperacionSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD");

export const listarPedidosQuerySchema = z.object({
  fechaOperacion: opcionalVacio(fechaOperacionSchema),
  desde: opcionalVacio(fechaOperacionSchema),
  hasta: opcionalVacio(fechaOperacionSchema),
  clienteId: opcionalVacio(z.string().uuid()),
  estado: opcionalVacio(z.enum(PEDIDO_ESTADOS)),
  /** Con clienteId y sin fecha: últimos pedidos del restaurante (no solo el día). */
  historial: opcionalVacio(
    z.enum(["1", "true"]).transform(() => true as const),
  ),
});

export type ListarPedidosQuery = z.infer<typeof listarPedidosQuerySchema>;

export const pedidoBandejaSchema = z.object({
  id: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaOperacion: z.string(),
  fechaEntrega: z.string(),
  clienteId: z.string().uuid(),
  clienteNombre: z.string(),
  estado: z.enum(PEDIDO_ESTADOS),
  origen: z.enum(PEDIDO_ORIGENES),
  totalCentavos: centavosSchema,
  capturadoPor: z.string().uuid().nullable(),
  capturadoAt: z.string().min(20),
  notasAdmin: z.string().nullable(),
});

export type PedidoBandeja = z.infer<typeof pedidoBandejaSchema>;

export const pedidoDetalleItemSchema = z.object({
  id: z.string().uuid().optional(),
  productoId: z.string().uuid(),
  cantidad: z.number().int().positive(),
  /** Igual a `cantidad` hasta entregar. La factura se calcula sobre esta. */
  cantidadEntregada: z.number().int().nonnegative(),
  /** Snapshot comercial (alias del cliente al capturar). */
  nombreMostrado: z.string(),
  /** Nombre de producción vivo; el panel interno muestra este. */
  nombreCanonico: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  precioUnitarioCentavos: centavosSchema,
  /**
   * Precio que el catálogo le daría hoy a este cliente (`null` si no hay).
   * Solo informativo: el pedido cobra su snapshot. Si difieren, el panel
   * ofrece ajustar.
   */
  precioCatalogoCentavos: centavosSchema.nullable().default(null),
  subtotalCentavos: centavosSchema,
  puntoCarga: z.enum(PUNTOS_CARGA),
  notaProduccion: z.string().nullable(),
  esDevolucion: z.boolean().default(false),
  bonoId: z.string().uuid().nullable().default(null),
});

export type PedidoDetalleItem = z.infer<typeof pedidoDetalleItemSchema>;

export const pedidoAuditEntrySchema = z.object({
  accion: z.string(),
  actorTipo: z.string(),
  actorNombre: z.string().nullable(),
  createdAt: z.string().min(20),
  antes: z.unknown().nullable(),
  despues: z.unknown().nullable(),
});

export type PedidoAuditEntry = z.infer<typeof pedidoAuditEntrySchema>;

export const pedidoDetalleSchema = z.object({
  id: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaOperacion: z.string(),
  fechaEntrega: z.string(),
  clienteId: z.string().uuid(),
  clienteNombre: z.string(),
  clienteContacto: z.string().nullable(),
  clienteTelefonoWa: z.string().nullable(),
  horarioEntregaFijo: z.string().nullable(),
  notasPermanentes: z.string().nullable(),
  estado: z.enum(PEDIDO_ESTADOS),
  origen: z.enum(PEDIDO_ORIGENES),
  notasAdmin: z.string().nullable(),
  capturadoPor: z.string().uuid().nullable(),
  capturadoPorNombre: z.string().nullable(),
  capturadoAt: z.string().min(20),
  anuladoAt: z.string().nullable(),
  motivoAnulacion: z.string().nullable(),
  items: z.array(pedidoDetalleItemSchema),
  totalCentavos: centavosSchema,
  /** Presente cuando el pedido ya generó factura (típicamente ENTREGADO). */
  factura: pedidoDetalleFacturaSchema.nullable(),
  historial: z.array(pedidoAuditEntrySchema),
});

export type PedidoDetalle = z.infer<typeof pedidoDetalleSchema>;

/**
 * Línea capturada desde el panel. A diferencia del portal, admite un precio
 * puesto a mano: vale solo para este pedido y exige `precios.cambiar` cuando
 * difiere del que tocaría (catálogo, o el snapshot si la línea ya existía).
 */
export const capturaPanelItemSchema = confirmarPedidoItemSchema.extend({
  precioUnitarioCentavos: centavosSchema.nonnegative().optional(),
});

export type CapturaPanelItem = z.infer<typeof capturaPanelItemSchema>;

export const crearPedidoManualRequestSchema = z.object({
  clienteId: z.string().uuid(),
  items: z.array(capturaPanelItemSchema).min(1),
  notasAdmin: z.string().max(2000).optional(),
});

export type CrearPedidoManualRequest = z.infer<
  typeof crearPedidoManualRequestSchema
>;

export const editarNotasPedidoRequestSchema = z.object({
  notasAdmin: z.string().max(2000),
});

export type EditarNotasPedidoRequest = z.infer<
  typeof editarNotasPedidoRequestSchema
>;

export const editarItemsPedidoRequestSchema = z.object({
  items: z.array(capturaPanelItemSchema).min(1),
});

export type EditarItemsPedidoRequest = z.infer<
  typeof editarItemsPedidoRequestSchema
>;

export const anularPedidoRequestSchema = z.object({
  motivo: z
    .string()
    .trim()
    .min(1, MENSAJE_MOTIVO_ANULACION)
    .max(500),
});

export type AnularPedidoRequest = z.infer<typeof anularPedidoRequestSchema>;

const motivoAjustePrecioSchema = z
  .string()
  .trim()
  .min(1, MENSAJE_MOTIVO_AJUSTE_PRECIO)
  .max(500);

/**
 * Corrige el precio de líneas de un pedido ya capturado. Sirve en cualquier
 * estado menos ANULADO; si el pedido ya se entregó, también ajusta su factura.
 */
export const ajustarPreciosPedidoRequestSchema = z.object({
  motivo: motivoAjustePrecioSchema,
  items: z
    .array(
      z.object({
        productoId: z.string().uuid(),
        precioUnitarioCentavos: centavosSchema.nonnegative(),
      }),
    )
    .min(1),
});

export type AjustarPreciosPedidoRequest = z.infer<
  typeof ajustarPreciosPedidoRequestSchema
>;

/**
 * Recalcula con el catálogo vigente todos los pedidos de una operación.
 * `aplicar: false` solo devuelve la vista previa, sin escribir nada.
 */
export const recalcularPreciosRequestSchema = z
  .object({
    fechaOperacion: fechaOperacionSchema,
    /** Obligatorio al aplicar; la vista previa no escribe nada. */
    motivo: motivoAjustePrecioSchema.optional(),
    aplicar: z.boolean().default(false),
    /**
     * Al aplicar: los pedidos que el usuario vio en la vista previa, con su
     * total nuevo. Si el servidor calcula otra cosa —llegó un pedido, cambió
     * el catálogo, entró un abono—, rechaza en vez de escribir lo no visto.
     */
    esperado: z
      .array(
        z.object({
          pedidoId: z.string().uuid(),
          totalDespuesCentavos: centavosSchema,
        }),
      )
      .optional(),
  })
  .refine((r) => !r.aplicar || r.motivo, {
    message: MENSAJE_MOTIVO_AJUSTE_PRECIO,
    path: ["motivo"],
  })
  .refine((r) => !r.aplicar || r.esperado, {
    message: MENSAJE_VISTA_PREVIA_VENCIDA,
    path: ["esperado"],
  });

export type RecalcularPreciosRequest = z.infer<
  typeof recalcularPreciosRequestSchema
>;

export const ajustePrecioLineaSchema = z.object({
  productoId: z.string().uuid(),
  nombreMostrado: z.string(),
  antesCentavos: centavosSchema,
  despuesCentavos: centavosSchema,
});

export type AjustePrecioLinea = z.infer<typeof ajustePrecioLineaSchema>;

export const ajustePrecioPedidoSchema = z.object({
  pedidoId: z.string().uuid(),
  correlativo: z.number().int().positive(),
  clienteNombre: z.string(),
  estado: z.enum(PEDIDO_ESTADOS),
  /** Sobre lo entregado si el pedido ya se entregó; si no, sobre lo pedido. */
  totalAntesCentavos: centavosSchema,
  totalDespuesCentavos: centavosSchema,
  cambios: z.array(ajustePrecioLineaSchema),
  /** El pedido ya tenía factura y su monto cambia. */
  ajustaFactura: z.boolean(),
  /** Carla ya capturó DTE: hay que emitir nota de crédito/débito fuera. */
  numeroDte: z.string().nullable(),
  /** Por qué no se toca (p. ej. abonado mayor al nuevo total). */
  omitido: z.string().nullable(),
  /** Líneas con precio puesto a mano que el recálculo respeta. */
  lineasManuales: z.number().int().nonnegative().default(0),
});

export type AjustePrecioPedido = z.infer<typeof ajustePrecioPedidoSchema>;

export const recalcularPreciosResultadoSchema = z.object({
  fechaOperacion: z.string(),
  aplicado: z.boolean(),
  /** Solo pedidos con al menos una línea distinta del catálogo. */
  pedidos: z.array(ajustePrecioPedidoSchema),
});

export type RecalcularPreciosResultado = z.infer<
  typeof recalcularPreciosResultadoSchema
>;

export const PEDIDO_SSE_TIPOS = [
  "pedido.creado",
  "pedido.editado",
  "pedido.anulado",
] as const;

export const OPERACION_SSE_TIPOS = [
  "dia.cerrado",
  "dia.reabierto",
  "hoja.generada",
] as const;

export const PANEL_SSE_TIPOS = [
  ...PEDIDO_SSE_TIPOS,
  ...OPERACION_SSE_TIPOS,
  ...COBRANZA_SSE_TIPOS,
  ...MESSAGING_SSE_TIPOS,
  ...CATALOGO_SSE_TIPOS,
] as const;

export const pedidoSseEventSchema = z.object({
  tipo: z.enum(PEDIDO_SSE_TIPOS),
  pedidoId: z.string().uuid(),
  fechaOperacion: fechaOperacionSchema,
});

export type PedidoSseEvent = z.infer<typeof pedidoSseEventSchema>;

export const panelSseEventSchema = z.union([
  pedidoSseEventSchema,
  z.object({
    tipo: z.enum(OPERACION_SSE_TIPOS),
    fechaOperacion: fechaOperacionSchema,
    versionHoja: z.number().int().nullable().optional(),
  }),
  z.object({
    tipo: z.enum(COBRANZA_SSE_TIPOS),
    fechaOperacion: fechaOperacionSchema,
    pedidoId: z.string().uuid().optional(),
    facturaId: z.string().uuid().optional(),
    clienteId: z.string().uuid().optional(),
    abonoId: z.string().uuid().optional(),
  }),
  z.object({
    tipo: z.enum(MESSAGING_SSE_TIPOS),
    conversacionId: z.string().uuid().optional(),
    mensajeId: z.string().uuid().optional(),
    clienteId: z.string().uuid().optional(),
  }),
  z.object({
    tipo: z.literal("producto.precio"),
    productoId: z.string().uuid(),
  }),
  z.object({
    tipo: z.literal("cliente_producto.precio"),
    productoId: z.string().uuid(),
    clienteId: z.string().uuid(),
  }),
  z.object({
    tipo: z.literal("cliente.bono"),
    clienteId: z.string().uuid(),
  }),
]);

export type PanelSseEvent = z.infer<typeof panelSseEventSchema>;
