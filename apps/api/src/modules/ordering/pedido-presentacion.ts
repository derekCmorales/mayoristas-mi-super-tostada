import { and, desc, eq, inArray } from "drizzle-orm";
import {
  auditLog,
  cliente,
  clienteProducto,
  factura,
  pedido,
  pedidoItem,
  producto,
  usuario,
} from "@misupertostada/db";
import {
  instanteAIso,
  pedidoDetalleSchema,
  portalPedidoSchema,
  textoConfirmacionPedido,
  totalPedidoCentavos,
  type PedidoDetalle,
  type PortalPedido,
} from "@misupertostada/shared";
import type { AppDatabase } from "../shared/database.module";
import { BusinessCalendarService } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import {
  abonosAplicadosDeFactura,
  presentarFactura,
} from "../receivables/factura-presentacion";
import { horarioDe } from "./pedido-reglas";
import { pedidoDe } from "./pedido-repositorio";

export async function presentarPortalPedido(
  db: AppDatabase,
  pedidoId: string,
  horarioEntregaFijo: string | null,
  tx: AppDatabase = db,
): Promise<PortalPedido> {
  const [row] = await tx
    .select()
    .from(pedido)
    .where(eq(pedido.id, pedidoId))
    .limit(1);
  if (!row) {
    throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
  }
  const items = await tx
    .select()
    .from(pedidoItem)
    .where(eq(pedidoItem.pedidoId, pedidoId));
  const mapped = items.map((item) => ({
    productoId: item.productoId,
    cantidad: item.cantidadPedida,
    nombreMostrado: item.nombreMostrado,
    unidadMedida: item.unidadMedida,
    precioUnitarioCentavos: item.precioUnitarioCentavos,
    subtotalCentavos: item.cantidadPedida * item.precioUnitarioCentavos,
    esDevolucion: item.esDevolucion,
    bonoId: item.bonoId ?? null,
  }));
  const totalCentavos = totalPedidoCentavos(mapped);
  return portalPedidoSchema.parse({
    id: row.id,
    correlativo: row.correlativo,
    estado: row.estado,
    fechaOperacion: row.fechaOperacion,
    fechaEntrega: row.fechaEntrega,
    origen: "PORTAL",
    items: mapped,
    totalCentavos,
    textoConfirmacion: textoConfirmacionPedido({
      correlativo: row.correlativo,
      fechaEntrega: row.fechaEntrega,
      totalCentavos,
      horarioEntregaFijo,
    }),
  });
}

export async function facturaDePedidoPanel(
  db: AppDatabase,
  calendar: BusinessCalendarService,
  pedidoId: string,
  organizacionId: string,
) {
  const [fac] = await db
    .select()
    .from(factura)
    .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
    .where(
      and(eq(factura.pedidoId, pedidoId), eq(pedido.organizacionId, organizacionId)),
    )
    .limit(1);
  if (!fac) return null;

  const [facturaInfo, abonos] = await Promise.all([
    presentarFactura(db, calendar, fac.factura),
    abonosAplicadosDeFactura(db, fac.factura.id),
  ]);

  return {
    ...facturaInfo,
    abonos: abonos.map((a) => ({
      abonoId: a.abonoId,
      fecha: a.fecha,
      metodo: a.metodo,
      estado: a.estado,
      montoCentavos: a.montoCentavos,
    })),
    pagos: abonos.map((a) => ({
      id: a.pagoId,
      montoCentavos: a.montoCentavos,
      metodo: a.metodo,
      fecha: a.fecha,
      comprobanteAssetId: a.comprobanteAssetId,
    })),
  };
}

export async function presentarPedidoPanel(
  db: AppDatabase,
  calendar: BusinessCalendarService,
  pedidoId: string,
  organizacionId: string,
): Promise<PedidoDetalle> {
  const row = await pedidoDe(db, pedidoId, organizacionId);
  const [cli] = await db
    .select()
    .from(cliente)
    .where(eq(cliente.id, row.clienteId))
    .limit(1);
  if (!cli) {
    throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
  }
  const cal = await calendar.load(organizacionId);
  const lineas = await db
    .select({
      item: pedidoItem,
      nombreCanonico: producto.nombreCanonico,
      puntoCarga: producto.puntoCarga,
      notaProduccion: clienteProducto.notaProduccion,
    })
    .from(pedidoItem)
    .innerJoin(producto, eq(producto.id, pedidoItem.productoId))
    .leftJoin(
      clienteProducto,
      and(
        eq(clienteProducto.clienteId, row.clienteId),
        eq(clienteProducto.productoId, pedidoItem.productoId),
      ),
    )
    .where(eq(pedidoItem.pedidoId, pedidoId));

  const items = lineas.map((linea) => ({
    id: linea.item.id,
    productoId: linea.item.productoId,
    cantidad: linea.item.cantidadPedida,
    nombreMostrado: linea.item.nombreMostrado,
    nombreCanonico: linea.nombreCanonico,
    unidadMedida: linea.item.unidadMedida,
    precioUnitarioCentavos: linea.item.precioUnitarioCentavos,
    subtotalCentavos:
      linea.item.cantidadPedida * linea.item.precioUnitarioCentavos,
    puntoCarga: cal.puntoCargaEfectivo(
      linea.puntoCarga,
      row.fechaOperacion,
    ),
    notaProduccion: linea.notaProduccion ?? null,
    esDevolucion: linea.item.esDevolucion,
    bonoId: linea.item.bonoId ?? null,
  }));
  const totalCentavos = totalPedidoCentavos(items);

  const logs = await db
    .select()
    .from(auditLog)
    .where(
      and(eq(auditLog.entidad, "pedido"), eq(auditLog.entidadId, pedidoId)),
    )
    .orderBy(desc(auditLog.createdAt))
    .limit(30);

  const usuarioIds = [
    ...new Set(
      [
        row.capturadoPor,
        ...logs
          .filter((l) => l.actorTipo === "usuario")
          .map((l) => l.actorId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const nombres = new Map<string, string>();
  if (usuarioIds.length > 0) {
    const users = await db
      .select({ id: usuario.id, username: usuario.username })
      .from(usuario)
      .where(inArray(usuario.id, usuarioIds));
    for (const u of users) nombres.set(u.id, u.username);
  }

  const capturadoPorNombre = row.capturadoPor
    ? (nombres.get(row.capturadoPor) ?? null)
    : null;

  const facturaInfo = await facturaDePedidoPanel(
    db,
    calendar,
    pedidoId,
    organizacionId,
  );

  return pedidoDetalleSchema.parse({
    id: row.id,
    correlativo: row.correlativo,
    fechaOperacion: row.fechaOperacion,
    fechaEntrega: row.fechaEntrega,
    clienteId: cli.id,
    clienteNombre: cli.nombre,
    clienteContacto: cli.contacto ?? null,
    clienteTelefonoWa: cli.telefonoWa ?? null,
    horarioEntregaFijo: horarioDe(cli),
    notasPermanentes: cli.notasPermanentes ?? null,
    estado: row.estado,
    origen: row.origen,
    notasAdmin: row.notasAdmin ?? null,
    capturadoPor: row.capturadoPor ?? null,
    capturadoPorNombre,
    capturadoAt: instanteAIso(row.createdAt),
    anuladoAt: row.anuladoAt ? instanteAIso(row.anuladoAt) : null,
    motivoAnulacion: row.motivoAnulacion ?? null,
    items,
    totalCentavos,
    factura: facturaInfo,
    historial: logs.map((l) => ({
      accion: l.accion,
      actorTipo: l.actorTipo,
      actorNombre:
        l.actorTipo === "usuario"
          ? (nombres.get(l.actorId) ?? null)
          : l.actorTipo === "cliente"
            ? cli.nombre
            : null,
      createdAt: instanteAIso(l.createdAt),
      antes: l.antes ?? null,
      despues: l.despues ?? null,
    })),
  });
}
