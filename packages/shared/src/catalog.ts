import { z } from "zod";
import {
  FAMILIAS,
  PUNTOS_CARGA,
  UNIDADES_MEDIDA,
  type Familia,
} from "./estados";
import { centavosSchema } from "./money";
import { telefonoWaSchema } from "./telefono";

export const FAMILIA_ETIQUETA: Record<Familia, string> = {
  TORTILLA: "Tortilla",
  TOSTADA: "Tostada",
  FRITURA: "Fritura",
};

export const skuSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((v) => v.toUpperCase());

export const horarioEntregaSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM (24 h)")
  .nullable();

export const crearProductoRequestSchema = z.object({
  sku: skuSchema,
  nombreCanonico: z.string().trim().min(1).max(120),
  familia: z.enum(FAMILIAS),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  puntoCarga: z.enum(PUNTOS_CARGA),
  esProducido: z.boolean().default(true),
  precioBaseCentavos: centavosSchema.nonnegative().nullable().optional(),
  fotoAssetId: z.string().uuid().nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
});

export type CrearProductoRequest = z.infer<typeof crearProductoRequestSchema>;

export const editarProductoRequestSchema = z.object({
  sku: skuSchema.optional(),
  nombreCanonico: z.string().trim().min(1).max(120).optional(),
  familia: z.enum(FAMILIAS).optional(),
  unidadMedida: z.enum(UNIDADES_MEDIDA).optional(),
  puntoCarga: z.enum(PUNTOS_CARGA).optional(),
  esProducido: z.boolean().optional(),
  precioBaseCentavos: centavosSchema.nonnegative().nullable().optional(),
  fotoAssetId: z.string().uuid().nullable().optional(),
  orden: z.number().int().nonnegative().optional(),
});

export type EditarProductoRequest = z.infer<typeof editarProductoRequestSchema>;

export const reordenarProductosRequestSchema = z.object({
  familia: z.enum(FAMILIAS),
  ids: z.array(z.string().uuid()).min(1),
});

export type ReordenarProductosRequest = z.infer<
  typeof reordenarProductosRequestSchema
>;

export const productoPublicoSchema = z.object({
  id: z.string().uuid(),
  sku: z.string(),
  nombreCanonico: z.string(),
  familia: z.enum(FAMILIAS),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  puntoCarga: z.enum(PUNTOS_CARGA),
  esProducido: z.boolean(),
  precioBaseCentavos: z.number().int().nullable(),
  fotoAssetId: z.string().uuid().nullable(),
  orden: z.number().int(),
  activo: z.boolean(),
});

export type ProductoPublico = z.infer<typeof productoPublicoSchema>;

export const crearClienteRequestSchema = z.object({
  nombre: z.string().trim().min(1).max(160),
  contacto: z.string().trim().max(160).nullable().optional(),
  telefonoWa: telefonoWaSchema,
  horarioEntregaFijo: horarioEntregaSchema.optional(),
  notasPermanentes: z.string().trim().max(2000).nullable().optional(),
  limiteFacturasPendientes: z.number().int().positive().nullable().optional(),
  fotoAssetId: z.string().uuid().nullable().optional(),
});

export type CrearClienteRequest = z.infer<typeof crearClienteRequestSchema>;

export const editarClienteRequestSchema = crearClienteRequestSchema.partial();

export type EditarClienteRequest = z.infer<typeof editarClienteRequestSchema>;

export const clientePublicoSchema = z.object({
  id: z.string().uuid(),
  nombre: z.string(),
  contacto: z.string().nullable(),
  telefonoWa: z.string().nullable(),
  horarioEntregaFijo: z.string().nullable(),
  notasPermanentes: z.string().nullable(),
  limiteFacturasPendientes: z.number().int().nullable(),
  fotoAssetId: z.string().uuid().nullable(),
  tieneTokenPortal: z.boolean(),
  activo: z.boolean(),
});

export type ClientePublico = z.infer<typeof clientePublicoSchema>;

export const tokenPortalResponseSchema = z.object({
  token: z.string().min(20),
});

export type TokenPortalResponse = z.infer<typeof tokenPortalResponseSchema>;

export const upsertClienteProductoRequestSchema = z.object({
  alias: z.string().trim().min(1).max(120).nullable().optional(),
  precioCentavos: centavosSchema.nonnegative().nullable().optional(),
  notaProduccion: z.string().trim().max(200).nullable().optional(),
  favorito: z.boolean().optional(),
  orden: z.number().int().nonnegative().optional(),
});

export type UpsertClienteProductoRequest = z.infer<
  typeof upsertClienteProductoRequestSchema
>;

export const clienteProductoFilaSchema = z.object({
  productoId: z.string().uuid(),
  sku: z.string(),
  nombreCanonico: z.string(),
  familia: z.enum(FAMILIAS),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  puntoCarga: z.enum(PUNTOS_CARGA),
  productoActivo: z.boolean(),
  alias: z.string().nullable(),
  /** Override del cliente; null hereda precioBaseCentavos. */
  precioCentavos: z.number().int().nullable(),
  precioBaseCentavos: z.number().int().nullable(),
  notaProduccion: z.string().nullable(),
  favorito: z.boolean(),
  orden: z.number().int(),
  ligado: z.boolean(),
});

export type ClienteProductoFila = z.infer<typeof clienteProductoFilaSchema>;

export const reordenarClienteProductosRequestSchema = z.object({
  ids: z.array(z.string().uuid()).min(1),
});

export const IMPORT_TIPOS = [
  "productos",
  "clientes",
  "cliente_producto",
] as const;
export type ImportTipo = (typeof IMPORT_TIPOS)[number];

export const importarCsvRequestSchema = z.object({
  tipo: z.enum(IMPORT_TIPOS),
  csv: z.string().min(1).max(2_000_000),
});

export type ImportarCsvRequest = z.infer<typeof importarCsvRequestSchema>;

export const importFilaResultadoSchema = z.object({
  indice: z.number().int(),
  ok: z.boolean(),
  error: z.string().optional(),
});

export const importReporteSchema = z.object({
  tipo: z.enum(IMPORT_TIPOS),
  filas: z.array(importFilaResultadoSchema),
  validas: z.number().int(),
  invalidas: z.number().int(),
  aplicadas: z.number().int().optional(),
});

export type ImportReporte = z.infer<typeof importReporteSchema>;

/** Precio de captura: override del cliente, o base del catálogo si no hay override. */
export function precioEfectivoCentavos(input: {
  precioClienteCentavos: number | null;
  precioBaseCentavos: number | null;
}): number | null {
  return input.precioClienteCentavos ?? input.precioBaseCentavos;
}

export const otorgarBonoRequestSchema = z.object({
  productoId: z.string().uuid(),
  descripcion: z.string().trim().min(1).max(200),
  cantidad: z.number().int().min(1).max(9999),
});

export type OtorgarBonoRequest = z.infer<typeof otorgarBonoRequestSchema>;

export const anularBonoRequestSchema = z.object({
  motivo: z.string().trim().min(1).max(500),
});

export type AnularBonoRequest = z.infer<typeof anularBonoRequestSchema>;

export const clienteBonoPublicoSchema = z.object({
  id: z.string().uuid(),
  productoId: z.string().uuid(),
  nombreCanonico: z.string(),
  unidadMedida: z.enum(UNIDADES_MEDIDA),
  descripcion: z.string(),
  cantidadOtorgada: z.number().int().positive(),
  cantidadAplicada: z.number().int().nonnegative(),
  cantidadDisponible: z.number().int().nonnegative(),
  otorgadoAt: z.string().min(20),
  anuladoAt: z.string().nullable(),
  motivoAnulacion: z.string().nullable(),
});

export type ClienteBonoPublico = z.infer<typeof clienteBonoPublicoSchema>;

export const CATALOGO_SSE_TIPOS = [
  "producto.precio",
  "cliente_producto.precio",
  "cliente.bono",
] as const;

export type CatalogoSseTipo = (typeof CATALOGO_SSE_TIPOS)[number];

export const PLANTILLAS_CSV: Record<ImportTipo, string> = {
  productos:
    "sku,nombre_canonico,familia,unidad_medida,punto_carga,es_producido,precio_base,orden\n",
  clientes:
    "nombre,contacto,telefono_wa,horario_entrega_fijo,notas_permanentes,limite_facturas_pendientes\n",
  cliente_producto:
    "cliente_nombre,producto_sku,alias,precio,nota_produccion,favorito,orden\n",
};
