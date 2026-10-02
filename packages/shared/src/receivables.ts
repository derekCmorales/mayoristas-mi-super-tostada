import { z } from "zod";
import {
  ABONO_ESTADOS,
  ABONO_ORIGENES,
  PAGO_ESTADOS,
  PAGO_METODOS,
  PEDIDO_ESTADOS,
  UNIDADES_MEDIDA,
  pagoRequiereComprobante,
  type PagoEstado,
} from "./estados";
import { centavosSchema } from "./money";

/** Query string: `""` y ausente → `undefined`, compatible con `parseBody`/`ZodType<T>`. */
function opcionalVacio<T extends z.ZodTypeAny>(
  schema: T,
): z.ZodType<z.infer<T> | undefined> {
  return z.preprocess(
    (value) => (value === "" || value === undefined ? undefined : value),
    schema.optional(),
  ) as z.ZodType<z.infer<T> | undefined>;
}

const fechaCalendarioSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD");

/** Antigüedad a partir de la cual una factura con saldo se considera VENCIDO. */
export const ANTIGUEDAD_VENCIDA_DIAS = 15;

export const TIPO_EVENTO_PEDIDO_ENTREGADO = "PedidoEntregado";
export const TIPO_EVENTO_LIMITE_CREDITO = "LimiteCreditoExcedido";

export const MENSAJE_PEDIDO_NO_ENTREGABLE =
  "Solo se entrega un pedido en producción. Cierre la ventana primero.";
export const MENSAJE_CANTIDAD_ENTREGADA =
  "La cantidad entregada debe ser un entero mayor o igual a cero.";
export const MENSAJE_DTE_DUPLICADO =
  "Ese número de DTE ya está registrado en otra factura.";
export const MENSAJE_PAGO_EXCEDE_SALDO =
  "El monto supera el saldo pendiente. No se registra saldo a favor.";
export const MENSAJE_COMPROBANTE_REQUERIDO =
  "Este método de pago requiere foto del comprobante.";
export const MENSAJE_PAGO_OBJETIVO =
  "Indique exactamente una factura o un cliente.";
export const MENSAJE_ABONO_PENDIENTE =
  "La transferencia queda en revisión hasta que se confirme.";
export const MENSAJE_MOTIVO_RECHAZO_REQUERIDO =
  "Indique el motivo del rechazo.";
export const MENSAJE_ABONO_NO_PENDIENTE =
  "Solo se puede confirmar o rechazar un abono pendiente.";
export const MENSAJE_DESCRIPCION_REQUERIDA =
  "La descripción del abono es obligatoria.";
export const MENSAJE_SIN_SENAL = "Sin señal · queda en este teléfono";
export const idempotencyKeySchema = z.string().trim().min(8).max(128);

export const COBRANZA_SSE_TIPOS = [
  "pedido.entregado",
  "factura.actualizada",
  "pago.registrado",
  "abono.reportado",
  "abono.confirmado",
  "abono.rechazado",
] as const;

export type CobranzaSseTipo = (typeof COBRANZA_SSE_TIPOS)[number];

function exigirEnterosCentavos(
  valores: ReadonlyArray<number>,
  fn: string,
): void {
  for (const valor of valores) {
    if (!Number.isInteger(valor)) {
      throw new Error(`${fn}: solo enteros en centavos`);
    }
  }
}

/**
 * Estado derivado. Nunca se guarda en `factura`.
 * Pagado ⇔ abonado >= monto (incluye factura de Q 0.00).
 * Vencido gana sobre abono parcial cuando hay saldo y ≥ 15 días.
 */
export function estadoFactura(input: {
  montoCentavos: number;
  abonadoCentavos: number;
  antiguedadDias: number;
}): PagoEstado {
  exigirEnterosCentavos(
    [input.montoCentavos, input.abonadoCentavos, input.antiguedadDias],
    "estadoFactura",
  );
  if (input.abonadoCentavos >= input.montoCentavos) return "PAGADO";
  const saldo = input.montoCentavos - input.abonadoCentavos;
  if (saldo > 0 && input.antiguedadDias >= ANTIGUEDAD_VENCIDA_DIAS) {
    return "VENCIDO";
  }
  if (input.abonadoCentavos > 0) return "ABONO_PARCIAL";
  return "PENDIENTE";
}

/** Suma enteros: entregado × snapshot. Sin redondeo bancario. */
export function montoFacturaCentavos(
  items: ReadonlyArray<{
    cantidadEntregada: number;
    precioUnitarioCentavos: number;
  }>,
): number {
  let total = 0;
  for (const item of items) {
    exigirEnterosCentavos(
      [item.cantidadEntregada, item.precioUnitarioCentavos],
      "montoFacturaCentavos",
    );
    if (item.cantidadEntregada < 0) {
      throw new Error("montoFacturaCentavos: cantidad no puede ser negativa");
    }
    total += item.cantidadEntregada * item.precioUnitarioCentavos;
  }
  return total;
}

export type AsignacionFifo = {
  facturaId: string;
  montoCentavos: number;
};

/**
 * Reparte un cobro a facturas pendientes en orden (ya ordenadas ASC).
 * `sobra > 0` ⇒ el caller rechaza con PAGO_EXCEDE_SALDO. Cero filas si monto es 0.
 */
export function aplicarFifo(
  facturasPendientes: ReadonlyArray<{ id: string; saldoCentavos: number }>,
  montoCentavos: number,
): { asignaciones: AsignacionFifo[]; sobra: number } {
  exigirEnterosCentavos([montoCentavos], "aplicarFifo");
  if (montoCentavos < 0) {
    throw new Error("aplicarFifo: el monto no puede ser negativo");
  }
  let restante = montoCentavos;
  const asignaciones: AsignacionFifo[] = [];
  for (const fac of facturasPendientes) {
    exigirEnterosCentavos([fac.saldoCentavos], "aplicarFifo");
    if (fac.saldoCentavos <= 0 || restante <= 0) continue;
    const aplicado = Math.min(fac.saldoCentavos, restante);
    asignaciones.push({ facturaId: fac.id, montoCentavos: aplicado });
    restante -= aplicado;
  }
  return { asignaciones, sobra: restante };
}

export const entregarItemSchema = z.object({
  itemId: z.string().uuid().optional(),
  /** Snapshot offline antiguo; solo si no hay líneas de devolución. */
  productoId: z.string().uuid().optional(),
  cantidadEntregada: z.number().int().min(0).max(9999),
}).refine((v) => Boolean(v.itemId ?? v.productoId), {
  message: "Indique itemId o productoId",
});

export const entregarPedidoRequestSchema = z.object({
  pedidoId: z.string().uuid(),
  idempotencyKey: idempotencyKeySchema,
  items: z.array(entregarItemSchema).optional(),
});
export type EntregarPedidoRequest = z.infer<typeof entregarPedidoRequestSchema>;

export const capturarDteRequestSchema = z.object({
  numeroDte: z.string().trim().min(1).max(80),
});
export type CapturarDteRequest = z.infer<typeof capturarDteRequestSchema>;

export const registrarPagoRequestSchema = z
  .object({
    id: z.string().uuid(),
    idempotencyKey: idempotencyKeySchema,
    clienteId: z.string().uuid(),
    montoCentavos: z.number().int().positive(),
    metodo: z.enum(PAGO_METODOS),
    comprobanteAssetId: z.string().uuid().optional(),
    fecha: fechaCalendarioSchema.optional(),
    /** Solo REPARTO offline: el comprobante se sube al sincronizar. */
    origen: z.enum(ABONO_ORIGENES).optional(),
  })
  .superRefine((value, ctx) => {
    if (pagoRequiereComprobante(value.metodo) && !value.comprobanteAssetId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: MENSAJE_COMPROBANTE_REQUERIDO,
        path: ["comprobanteAssetId"],
      });
    }
  });
export type RegistrarPagoRequest = z.infer<typeof registrarPagoRequestSchema>;

export const reportarAbonoPortalRequestSchema = z.object({
  id: z.string().uuid(),
  idempotencyKey: idempotencyKeySchema,
  montoCentavos: z.number().int().positive(),
  descripcion: z.string().trim().min(1).max(280),
  comprobanteAssetId: z.string().uuid(),
});
export type ReportarAbonoPortalRequest = z.infer<
  typeof reportarAbonoPortalRequestSchema
>;

export const rechazarAbonoRequestSchema = z.object({
  motivo: z.string().trim().min(1).max(280),
});
export type RechazarAbonoRequest = z.infer<typeof rechazarAbonoRequestSchema>;

/** Entero desde query string (`"40"` → 40). Ausente/`""` → undefined. */
function opcionalEnteroQuery(
  min: number,
  max: number,
): z.ZodType<number | undefined> {
  return z.preprocess((value) => {
    if (value === "" || value === undefined || value === null) return undefined;
    const n = typeof value === "number" ? value : Number(value);
    return Number.isFinite(n) ? n : undefined;
  }, z.number().int().min(min).max(max).optional()) as z.ZodType<
    number | undefined
  >;
}

export const CARTERA_PAGE_SIZE_DEFAULT = 40;
export const CARTERA_PAGE_SIZE_MAX = 200;

export const abonosQuerySchema = z.object({
  estado: opcionalVacio(z.enum(["PENDIENTE", "CONFIRMADO", "RECHAZADO", "todas"])),
  clienteId: opcionalVacio(z.string().uuid()),
  limit: opcionalEnteroQuery(1, CARTERA_PAGE_SIZE_MAX),
  offset: opcionalEnteroQuery(0, 100_000),
});
export type AbonosQuery = z.infer<typeof abonosQuerySchema>;

export const carteraQuerySchema = z.object({
  estado: opcionalVacio(z.enum(["todas", "pendientes", "vencidas"])),
  clienteId: opcionalVacio(z.string().uuid()),
  desde: opcionalVacio(fechaCalendarioSchema),
  hasta: opcionalVacio(fechaCalendarioSchema),
  metodoPago: opcionalVacio(z.enum(PAGO_METODOS)),
  fechaOperacion: opcionalVacio(fechaCalendarioSchema),
  /** Nombre, DTE o correlativo. */
  q: opcionalVacio(z.string().trim().max(80)),
  /** Solo facturas sin número DTE (por facturar). */
  sinDte: opcionalVacio(z.enum(["1"])),
  limit: opcionalEnteroQuery(1, CARTERA_PAGE_SIZE_MAX),
  offset: opcionalEnteroQuery(0, 100_000),
});
export type CarteraQuery = z.infer<typeof carteraQuerySchema>;

export const cuadreQuerySchema = z.object({
  fecha: opcionalVacio(fechaCalendarioSchema),
});
export type CuadreQuery = z.infer<typeof cuadreQuerySchema>;

/**
 * La ruta se pide por **día de reparto**, que es como trabaja Tony. Se acepta
 * `fechaOperacion` para deep-links viejos, pero el eje real es `fechaEntrega`.
 */
export const repartoQuerySchema = z.object({
  fechaEntrega: opcionalVacio(fechaCalendarioSchema),
  fechaOperacion: opcionalVacio(fechaCalendarioSchema),
});
export type RepartoQuery = z.infer<typeof repartoQuerySchema>;

export const facturaPublicaSchema = z.object({
  id: z.string().uuid(),
  pedidoId: z.string().uuid(),
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
  abonadoCentavos: centavosSchema,
  saldoCentavos: centavosSchema,
  emitidaAt: z.string().nullable(),
  antiguedadDias: z.number().int().nonnegative(),
  estado: z.enum(PAGO_ESTADOS),
});
export type FacturaPublica = z.infer<typeof facturaPublicaSchema>;

/** Snapshot viejo en IndexedDB puede omitir foto; default null. */
const fotoAssetIdSnapshotSchema = z
  .string()
  .uuid()
  .nullable()
  .optional()
  .transform((v) => v ?? null);

/** Snapshot offline antiguo puede omitir id; la API siempre lo manda. */
const itemIdSnapshotSchema = z
  .string()
  .uuid()
  .optional()
  .transform((v) => v ?? null);

export const entregaItemPublicoSchema = z.object({
  id: itemIdSnapshotSchema,
  productoId: z.string().uuid(),
  nombreMostrado: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  cantidadPedida: z.number().int().nonnegative(),
  cantidadEntregada: z.number().int().nonnegative(),
  precioUnitarioCentavos: centavosSchema,
  notaProduccion: z.string().nullable(),
  fotoAssetId: fotoAssetIdSnapshotSchema,
  esDevolucion: z.boolean().default(false),
});
export type EntregaItemPublico = z.infer<typeof entregaItemPublicoSchema>;

export const entregaResultadoSchema = z.object({
  pedidoId: z.string().uuid(),
  estado: z.literal("ENTREGADO"),
  idempotente: z.boolean(),
  items: z.array(entregaItemPublicoSchema),
  factura: facturaPublicaSchema,
});
export type EntregaResultado = z.infer<typeof entregaResultadoSchema>;

export const rutaParadaSchema = z.object({
  pedidoId: z.string().uuid(),
  correlativo: z.number().int().positive(),
  clienteId: z.string().uuid(),
  clienteNombre: z.string(),
  horarioEntregaFijo: z.string().nullable(),
  telefonoWa: z.string().nullable(),
  fotoAssetId: fotoAssetIdSnapshotSchema,
  /** Snapshot viejo puede omitir; default null. */
  notasPermanentes: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? null),
  estado: z.enum(PEDIDO_ESTADOS),
  totalEstimadoCentavos: centavosSchema,
  saldoAnteriorCentavos: centavosSchema,
  facturasPendientes: z.number().int().nonnegative(),
  items: z.array(entregaItemPublicoSchema),
  factura: facturaPublicaSchema.nullable(),
});
export type RutaParada = z.infer<typeof rutaParadaSchema>;

export const rutaRepartoSchema = z.object({
  /** Día de calle. Es el eje de la ruta. */
  fechaEntrega: fechaCalendarioSchema.optional(),
  /** Operación de origen. Informativo: una fecha de entrega la determina. */
  fechaOperacion: fechaCalendarioSchema,
  /** KPI de calle; snapshot offline antiguo sin el campo → 0. */
  cobradoHoyCentavos: z.preprocess(
    (v) => (v === undefined || v === null ? 0 : v),
    centavosSchema,
  ),
  paradas: z.array(rutaParadaSchema),
});
export type RutaReparto = z.infer<typeof rutaRepartoSchema>;

/**
 * Un día de calle que ya pasó con pedidos que nunca se marcaron entregados.
 * Siguen en `EN_PRODUCCION`, sin factura: no cuentan en la cartera ni se les
 * puede registrar un cobro hasta que alguien los marque.
 */
export const diaRepartoAtrasadoSchema = z.object({
  fechaEntrega: fechaCalendarioSchema,
  pendientes: z.number().int().positive(),
  /** Sobre lo pedido; la factura sale de lo que se marque entregado. */
  montoEstimadoCentavos: centavosSchema,
});
export type DiaRepartoAtrasado = z.infer<typeof diaRepartoAtrasadoSchema>;

export const repartoAtrasadosSchema = z.object({
  /** Día de calle de referencia: todo lo anterior a esta fecha está atrasado. */
  hoy: fechaCalendarioSchema,
  pendientes: z.number().int().nonnegative(),
  montoEstimadoCentavos: centavosSchema,
  /** Del más reciente al más viejo. */
  dias: z.array(diaRepartoAtrasadoSchema),
});
export type RepartoAtrasados = z.infer<typeof repartoAtrasadosSchema>;

export const facturaCarteraSchema = facturaPublicaSchema.extend({
  correlativo: z.number().int().positive(),
  clienteId: z.string().uuid(),
  clienteNombre: z.string(),
  fechaOperacion: fechaCalendarioSchema,
  fotoAssetId: z.string().uuid().nullable(),
});
export type FacturaCartera = z.infer<typeof facturaCarteraSchema>;

/** Prioridad en la lista de cartera: urgencia antes que recencia. */
function rankEstadoCartera(estado: PagoEstado): number {
  if (estado === "VENCIDO") return 0;
  if (estado === "ABONO_PARCIAL") return 1;
  if (estado === "PENDIENTE") return 2;
  return 3;
}

/**
 * Lista general de cartera: vencidas arriba, luego operación más reciente.
 * Dentro del mismo día gana el pedido con correlativo más alto.
 */
export function ordenarCartera(
  a: FacturaCartera,
  b: FacturaCartera,
): number {
  const porEstado = rankEstadoCartera(a.estado) - rankEstadoCartera(b.estado);
  if (porEstado !== 0) return porEstado;

  if (a.estado === "VENCIDO" && b.estado === "VENCIDO") {
    if (b.antiguedadDias !== a.antiguedadDias) {
      return b.antiguedadDias - a.antiguedadDias;
    }
  }

  if (a.fechaOperacion !== b.fechaOperacion) {
    return a.fechaOperacion < b.fechaOperacion ? 1 : -1;
  }

  if (b.correlativo !== a.correlativo) {
    return b.correlativo - a.correlativo;
  }

  return a.clienteNombre.localeCompare(b.clienteNombre, "es");
}

/** Orden FIFO de cobro: la factura más vieja va primero (la que recibe el pago). */
export function ordenarFacturasFifo(
  a: {
    emitidaAt: string | null;
    correlativo?: number;
    fechaOperacion?: string;
  },
  b: {
    emitidaAt: string | null;
    correlativo?: number;
    fechaOperacion?: string;
  },
): number {
  const ea = a.emitidaAt ?? a.fechaOperacion ?? "";
  const eb = b.emitidaAt ?? b.fechaOperacion ?? "";
  if (ea !== eb) return ea < eb ? -1 : 1;
  const ca = a.correlativo ?? 0;
  const cb = b.correlativo ?? 0;
  return ca - cb;
}

export const carteraCountsSchema = z.object({
  todas: z.number().int().nonnegative(),
  pendientes: z.number().int().nonnegative(),
  vencidas: z.number().int().nonnegative(),
});
export type CarteraCounts = z.infer<typeof carteraCountsSchema>;

/** Página de cartera: items + totales de tabs bajo los mismos filtros (sin estado). */
export const carteraListaSchema = z.object({
  items: z.array(facturaCarteraSchema),
  total: z.number().int().nonnegative(),
  counts: carteraCountsSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type CarteraLista = z.infer<typeof carteraListaSchema>;

export const clienteSobreLimiteSchema = z.object({
  clienteId: z.string().uuid(),
  nombre: z.string(),
  pendientes: z.number().int().nonnegative(),
  limite: z.number().int().positive(),
  fotoAssetId: z.string().uuid().nullable(),
});
export type ClienteSobreLimite = z.infer<typeof clienteSobreLimiteSchema>;

export const carteraResumenSchema = z.object({
  pendientesCount: z.number().int().nonnegative(),
  pendientesSaldoCentavos: centavosSchema,
  /**
   * Cobrado el día de calle de la operación consultada, no «hoy» a secas:
   * navegar a una operación pasada debe mostrar lo que se cobró ese día.
   */
  cobradoHoyCentavos: centavosSchema,
  /** Día de calendario al que corresponde `cobradoHoyCentavos`. */
  fechaCobro: fechaCalendarioSchema.optional(),
  porCobrarFechaOperacionCentavos: centavosSchema,
  transferenciasPendientesCount: z.number().int().nonnegative(),
  clientesSobreLimite: z.array(clienteSobreLimiteSchema),
});
export type CarteraResumen = z.infer<typeof carteraResumenSchema>;

export const pagoPublicoSchema = z.object({
  id: z.string().uuid(),
  facturaId: z.string().uuid(),
  montoCentavos: centavosSchema,
  metodo: z.enum(PAGO_METODOS),
  fecha: fechaCalendarioSchema,
  registradoPor: z.string().uuid().nullable(),
  registradoPorNombre: z.string().nullable().optional(),
  comprobanteAssetId: z.string().uuid().nullable(),
  clienteNombre: z.string().optional(),
  numeroDte: z.string().nullable().optional(),
});
export type PagoPublico = z.infer<typeof pagoPublicoSchema>;

/**
 * A qué factura se aplicó cada parte de un abono. Lleva el pedido porque el
 * DTE solo identifica la factura ante el SAT: quien mira la pantalla —cliente
 * o cobranza— necesita saber de qué entrega se trata.
 */
export const aplicacionAbonoSchema = z.object({
  facturaId: z.string().uuid(),
  pedidoId: z.string().uuid(),
  correlativo: z.number().int().positive(),
  fechaEntrega: z.string(),
  numeroDte: z.string().nullable(),
  montoCentavos: centavosSchema,
});
export type AplicacionAbono = z.infer<typeof aplicacionAbonoSchema>;

export const abonoPublicoSchema = z.object({
  id: z.string().uuid(),
  clienteId: z.string().uuid(),
  clienteNombre: z.string().optional(),
  montoCentavos: centavosSchema,
  metodo: z.enum(PAGO_METODOS),
  estado: z.enum(ABONO_ESTADOS),
  descripcion: z.string().nullable(),
  comprobanteAssetId: z.string().uuid().nullable(),
  origen: z.enum(ABONO_ORIGENES),
  fecha: fechaCalendarioSchema,
  registradoPor: z.string().uuid().nullable(),
  registradoPorNombre: z.string().nullable().optional(),
  confirmadoPor: z.string().uuid().nullable(),
  confirmadoPorNombre: z.string().nullable().optional(),
  confirmadoAt: z.string().nullable(),
  motivoRechazo: z.string().nullable(),
  aplicaciones: z.array(aplicacionAbonoSchema),
});
export type AbonoPublico = z.infer<typeof abonoPublicoSchema>;

export const abonoListaSchema = z.object({
  items: z.array(abonoPublicoSchema),
  total: z.number().int().nonnegative(),
  pendientesCount: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  hasMore: z.boolean(),
});
export type AbonoLista = z.infer<typeof abonoListaSchema>;

export const abonoRegistroResultadoSchema = z.object({
  idempotente: z.boolean(),
  abono: abonoPublicoSchema,
  pagos: z.array(pagoPublicoSchema).optional(),
  facturas: z.array(facturaPublicaSchema).optional(),
});
export type AbonoRegistroResultado = z.infer<typeof abonoRegistroResultadoSchema>;

export const pagoRegistroResultadoSchema = z.object({
  idempotente: z.boolean(),
  pagos: z.array(pagoPublicoSchema),
  facturas: z.array(facturaPublicaSchema),
});
export type PagoRegistroResultado = z.infer<typeof pagoRegistroResultadoSchema>;

export const cuadreActorSchema = z.object({
  usuarioId: z.string().uuid().nullable(),
  username: z.string(),
  efectivoCentavos: centavosSchema,
  transferenciaCentavos: centavosSchema,
  chequeCentavos: centavosSchema,
  count: z.number().int().nonnegative(),
});
export type CuadreActor = z.infer<typeof cuadreActorSchema>;

export const cuadreDiaSchema = z.object({
  fecha: fechaCalendarioSchema,
  totalEfectivoCentavos: centavosSchema,
  totalTransferenciaCentavos: centavosSchema,
  totalChequeCentavos: centavosSchema,
  totalCentavos: centavosSchema,
  porActor: z.array(cuadreActorSchema),
  pagos: z.array(pagoPublicoSchema),
});
export type CuadreDia = z.infer<typeof cuadreDiaSchema>;
