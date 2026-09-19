import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { abono, factura, pago, pedido } from "@misupertostada/db";
import {
  estadoFactura,
  facturaPublicaSchema,
  instanteAIso,
  type AbonoEstado,
  type FacturaPublica,
  type PagoMetodo,
} from "@misupertostada/shared";
import type { AppDatabase } from "../shared/database.module";
import { BusinessCalendarService } from "../shared/calendar.service";

const abonadoSql = sql<number>`coalesce((
  select sum(${pago.montoCentavos}) from ${pago} where ${pago.facturaId} = ${factura.id}
), 0)::int`;

export function antiguedadDiasDe(
  cal: { diasCalendarioEntre: (desde: Date, hasta: Date) => number },
  desde: Date | string | null | undefined,
  hasta: Date,
): number {
  if (!desde) return 0;
  const d = desde instanceof Date ? desde : new Date(desde);
  if (Number.isNaN(d.getTime())) return 0;
  return Math.max(0, cal.diasCalendarioEntre(d, hasta));
}

export async function abonadoDeFactura(
  db: AppDatabase,
  facturaId: string,
): Promise<number> {
  const [row] = await db
    .select({
      total: sql<number>`coalesce(sum(${pago.montoCentavos}), 0)::int`,
    })
    .from(pago)
    .where(eq(pago.facturaId, facturaId));
  return Number(row?.total ?? 0);
}

export async function presentarFactura(
  db: AppDatabase,
  calendar: BusinessCalendarService,
  fac: typeof factura.$inferSelect,
): Promise<FacturaPublica> {
  const [ped] = await db
    .select({ organizacionId: pedido.organizacionId })
    .from(pedido)
    .where(eq(pedido.id, fac.pedidoId))
    .limit(1);
  const abonadoCentavos = await abonadoDeFactura(db, fac.id);
  const cal = await calendar.load(ped?.organizacionId);
  const now = calendar.now();
  const emitida = fac.emitidaAt ?? fac.createdAt;
  const antiguedadDias = antiguedadDiasDe(cal, emitida, now);
  const saldoCentavos = Math.max(0, fac.montoCentavos - abonadoCentavos);
  return facturaPublicaSchema.parse({
    id: fac.id,
    pedidoId: fac.pedidoId,
    numeroDte: fac.numeroDte ?? null,
    montoCentavos: fac.montoCentavos,
    abonadoCentavos,
    saldoCentavos,
    emitidaAt: emitida ? instanteAIso(emitida) : null,
    antiguedadDias,
    estado: estadoFactura({
      montoCentavos: fac.montoCentavos,
      abonadoCentavos,
      antiguedadDias,
    }),
  });
}

export async function pendientesDeCliente(
  db: AppDatabase,
  clienteId: string,
  excluirFacturaId?: string,
): Promise<{ count: number; saldoCentavos: number }> {
  const condiciones = [
    eq(pedido.clienteId, clienteId),
    sql`${factura.montoCentavos} > ${abonadoSql}`,
  ];
  if (excluirFacturaId) {
    condiciones.push(sql`${factura.id} <> ${excluirFacturaId}`);
  }
  const [row] = await db
    .select({
      count: sql<number>`count(*)::int`,
      saldo: sql<number>`coalesce(sum(${factura.montoCentavos} - ${abonadoSql}), 0)::int`,
    })
    .from(factura)
    .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
    .where(and(...condiciones));
  return {
    count: Number(row?.count ?? 0),
    saldoCentavos: Number(row?.saldo ?? 0),
  };
}

/** Abono aplicado a una factura, con el detalle de pago y comprobante. */
export type AbonoAplicado = {
  abonoId: string;
  pagoId: string;
  fecha: string;
  metodo: PagoMetodo;
  estado: AbonoEstado;
  montoCentavos: number;
  comprobanteAssetId: string | null;
};

/**
 * Desglose de abonos de una factura. `pago` es la aplicación a la factura;
 * método, estado y comprobante viven en el `abono` que la originó.
 */
export async function abonosAplicadosDeFactura(
  db: AppDatabase,
  facturaId: string,
): Promise<AbonoAplicado[]> {
  const filas = await db
    .select({ pago, abono })
    .from(pago)
    .innerJoin(abono, eq(abono.id, pago.abonoId))
    .where(eq(pago.facturaId, facturaId))
    .orderBy(asc(pago.fecha));
  return filas.map((f) => ({
    abonoId: f.abono.id,
    pagoId: f.pago.id,
    fecha: f.pago.fecha,
    metodo: f.pago.metodo,
    estado: f.abono.estado,
    montoCentavos: f.pago.montoCentavos,
    comprobanteAssetId: f.pago.comprobanteAssetId ?? null,
  }));
}

export type FacturaPendienteResumen = {
  numeroDte: string | null;
  montoCentavos: number;
  abonadoCentavos: number;
  saldoCentavos: number;
  estado: ReturnType<typeof estadoFactura>;
  antiguedadDias: number;
};

/**
 * Facturas no pagadas de un cliente, con desglose por factura. Usado para el
 * estado de cuenta (PDF de recordatorio); a diferencia de `pendientesDeCliente`
 * (solo total y conteo), aquí cada factura viaja completa.
 */
export async function facturasPendientesDeCliente(
  db: AppDatabase,
  calendar: BusinessCalendarService,
  clienteId: string,
): Promise<{
  facturasPendientes: number;
  saldoCentavos: number;
  facturas: FacturaPendienteResumen[];
}> {
  const filas = await db
    .select()
    .from(factura)
    .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
    .where(eq(pedido.clienteId, clienteId));
  if (filas.length === 0) {
    return { facturasPendientes: 0, saldoCentavos: 0, facturas: [] };
  }

  const ids = filas.map((f) => f.factura.id);
  const pagos = await db.select().from(pago).where(inArray(pago.facturaId, ids));
  const abonadoPor = new Map<string, number>();
  for (const p of pagos) {
    abonadoPor.set(p.facturaId, (abonadoPor.get(p.facturaId) ?? 0) + p.montoCentavos);
  }

  const cal = await calendar.load(filas[0]!.pedido.organizacionId);
  const now = calendar.now();
  const facturas: FacturaPendienteResumen[] = [];
  for (const fila of filas) {
    const fac = fila.factura;
    const abonadoCentavos = abonadoPor.get(fac.id) ?? 0;
    const emitida = fac.emitidaAt ?? fac.createdAt;
    const antiguedadDias = antiguedadDiasDe(cal, emitida, now);
    const estado = estadoFactura({
      montoCentavos: fac.montoCentavos,
      abonadoCentavos,
      antiguedadDias,
    });
    if (estado === "PAGADO") continue;
    facturas.push({
      numeroDte: fac.numeroDte,
      montoCentavos: fac.montoCentavos,
      abonadoCentavos,
      saldoCentavos: fac.montoCentavos - abonadoCentavos,
      estado,
      antiguedadDias,
    });
  }

  return {
    facturasPendientes: facturas.length,
    saldoCentavos: facturas.reduce((acc, f) => acc + f.saldoCentavos, 0),
    facturas,
  };
}
