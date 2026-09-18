import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import {
  cliente,
  clienteProducto,
  factura,
  pago,
  pedido,
  pedidoItem,
  producto,
} from "@misupertostada/db";
import { restaurarBonoNoEntregado } from "../ordering/pedido-bono";
import {
  MENSAJE_CANTIDAD_ENTREGADA,
  MENSAJE_PEDIDO_NO_ENTREGABLE,
  TIPO_EVENTO_PEDIDO_ENTREGADO,
  entregarPedidoRequestSchema,
  entregaResultadoSchema,
  montoFacturaCentavos,
  repartoQuerySchema,
  rutaRepartoSchema,
  tienePermiso,
  type EntregaResultado,
  type RutaReparto,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { DomainEventWriter } from "../shared/domain-event.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { esViolacionUnica } from "../shared/pg-error";
import type { Actor } from "../identity/actor";
import {
  FACTURA_AL_ENTREGAR,
  type FacturaAlEntregar,
} from "../receivables/factura-al-entregar";
import { pendientesDeCliente } from "../receivables/factura-presentacion";

@Injectable()
export class EntregaService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly events: DomainEventWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly bus: PedidoEvents,
    @Inject(FACTURA_AL_ENTREGAR) private readonly facturas: FacturaAlEntregar,
  ) {}

  async entregar(body: unknown, actor: Actor): Promise<EntregaResultado> {
    if (!tienePermiso(actor.permisos, "pedidos.entregar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(entregarPedidoRequestSchema, body);
    const cantidadesPorItem = new Map(
      (input.items ?? [])
        .filter((i) => i.itemId)
        .map((i) => [i.itemId!, i.cantidadEntregada]),
    );
    const cantidadesPorProducto = new Map(
      (input.items ?? [])
        .filter((i) => i.productoId && !i.itemId)
        .map((i) => [i.productoId!, i.cantidadEntregada]),
    );

    const { pedidoId, idempotente } = await this.db.transaction(async (tx) => {
      const [ped] = await tx
        .select()
        .from(pedido)
        .where(
          and(
            eq(pedido.id, input.pedidoId),
            eq(pedido.organizacionId, actor.organizacionId),
          ),
        )
        .limit(1)
        .for("update");
      if (!ped) {
        throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
      }
      if (ped.estado === "ANULADO") {
        throw new DomainException(
          "PEDIDO_NO_ENTREGABLE",
          MENSAJE_PEDIDO_NO_ENTREGABLE,
          409,
        );
      }

      const items = await tx
        .select()
        .from(pedidoItem)
        .where(eq(pedidoItem.pedidoId, ped.id));
      const tieneDevolucion = items.some((i) => i.esDevolucion);
      const cantidades = items.map((item) => {
        const override =
          cantidadesPorItem.get(item.id) ??
          (!tieneDevolucion
            ? cantidadesPorProducto.get(item.productoId)
            : undefined);
        const cantidadEntregada = override ?? item.cantidadPedida;
        if (!Number.isInteger(cantidadEntregada) || cantidadEntregada < 0) {
          throw new DomainException(
            "CANTIDAD_ENTREGADA_INVALIDA",
            MENSAJE_CANTIDAD_ENTREGADA,
            400,
          );
        }
        return { item, cantidadEntregada };
      });

      if (ped.entregaIdempotencyKey === input.idempotencyKey) {
        return { pedidoId: ped.id, idempotente: true };
      }

      if (ped.estado === "ENTREGADO") {
        if (ped.entregaIdempotencyKey) {
          throw new DomainException(
            "PEDIDO_NO_ENTREGABLE",
            MENSAJE_PEDIDO_NO_ENTREGABLE,
            409,
          );
        }
        const igual = cantidades.every(
          (c) => c.item.cantidadEntregada === c.cantidadEntregada,
        );
        if (!igual) {
          throw new DomainException(
            "PEDIDO_NO_ENTREGABLE",
            MENSAJE_PEDIDO_NO_ENTREGABLE,
            409,
          );
        }
        return { pedidoId: ped.id, idempotente: true };
      }

      if (ped.estado !== "EN_PRODUCCION") {
        throw new DomainException(
          "PEDIDO_NO_ENTREGABLE",
          MENSAJE_PEDIDO_NO_ENTREGABLE,
          409,
        );
      }

      const [keyAjena] = await tx
        .select({ id: pedido.id })
        .from(pedido)
        .where(
          and(
            eq(pedido.entregaIdempotencyKey, input.idempotencyKey),
            eq(pedido.organizacionId, actor.organizacionId),
          ),
        )
        .limit(1);
      if (keyAjena) {
        throw new DomainException(
          "PEDIDO_NO_ENTREGABLE",
          MENSAJE_PEDIDO_NO_ENTREGABLE,
          409,
        );
      }

      for (const c of cantidades) {
        await tx
          .update(pedidoItem)
          .set({ cantidadEntregada: c.cantidadEntregada })
          .where(eq(pedidoItem.id, c.item.id));
        if (
          c.item.esDevolucion &&
          c.item.bonoId &&
          c.cantidadEntregada < c.item.cantidadPedida
        ) {
          const noEntregado = c.item.cantidadPedida - c.cantidadEntregada;
          await restaurarBonoNoEntregado(tx, c.item.bonoId, noEntregado);
        }
      }
      const monto = montoFacturaCentavos(
        cantidades.map((c) => ({
          cantidadEntregada: c.cantidadEntregada,
          precioUnitarioCentavos: c.item.precioUnitarioCentavos,
        })),
      );
      try {
        await tx
          .update(pedido)
          .set({
            estado: "ENTREGADO",
            entregaIdempotencyKey: input.idempotencyKey,
          })
          .where(eq(pedido.id, ped.id));
      } catch (err) {
        if (esViolacionUnica(err)) {
          throw new DomainException(
            "PEDIDO_NO_ENTREGABLE",
            MENSAJE_PEDIDO_NO_ENTREGABLE,
            409,
          );
        }
        throw err;
      }
      await this.facturas.crearEnTx(tx, { pedidoId: ped.id, montoCentavos: monto });
      await this.events.insert(
        TIPO_EVENTO_PEDIDO_ENTREGADO,
        {
          pedidoId: ped.id,
          clienteId: ped.clienteId,
          fechaOperacion: ped.fechaOperacion,
          montoCentavos: monto,
        },
        tx,
      );
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "pedidos.entregar",
          entidad: "pedido",
          entidadId: ped.id,
          antes: { estado: ped.estado },
          despues: {
            estado: "ENTREGADO",
            cantidades: cantidades.map((c) => ({
              itemId: c.item.id,
              productoId: c.item.productoId,
              cantidadEntregada: c.cantidadEntregada,
            })),
            montoCentavos: monto,
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return { pedidoId: ped.id, idempotente: false };
    });

    const [ped] = await this.db.select().from(pedido).where(eq(pedido.id, pedidoId));
    this.bus.emit({
      organizacionId: actor.organizacionId,
      tipo: "pedido.entregado",
      fechaOperacion: ped!.fechaOperacion,
      pedidoId,
      clienteId: ped!.clienteId,
    });
    return this.resultado(pedidoId, actor, idempotente);
  }

  async ruta(query: unknown, actor: Actor): Promise<RutaReparto> {
    const q = parseBody(repartoQuerySchema, query ?? {});
    const cal = await this.calendar.load(actor.organizacionId);
    const ejes = await this.calendar.ejes(actor.organizacionId);
    // La ruta se ancla al DÍA DE CALLE, no a la ventana. Antes miraba la
    // operación y a las 15:00 —cuando abre la ventana siguiente— la ruta del
    // día se vaciaba con Tony todavía repartiendo. `fecha_entrega` está
    // congelada en el pedido, así que el eje no se mueve durante el día.
    const diaReparto =
      q.fechaEntrega ??
      (q.fechaOperacion ? cal.getFechaEntrega(q.fechaOperacion) : ejes.hoyCivil);
    const fecha = q.fechaOperacion ?? cal.getOperacionQueEntregaEn(diaReparto);
    // `fecha_entrega` está congelada en el pedido; recalcularla desde el
    // calendario actual puede diferir si el horario cambió después. Con un
    // deep-link por operación se filtra por operación, que es lo que pidieron.
    const filtroDia = q.fechaOperacion
      ? eq(pedido.fechaOperacion, q.fechaOperacion)
      : eq(pedido.fechaEntrega, diaReparto);

    const [cobrado] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${pago.montoCentavos}), 0)::int`,
      })
      .from(pago)
      .innerJoin(factura, eq(factura.id, pago.facturaId))
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(
          eq(pedido.organizacionId, actor.organizacionId),
          eq(pago.fecha, diaReparto),
        ),
      );

    const pedidos = await this.db
      .select({
        pedido,
        cliente,
      })
      .from(pedido)
      .innerJoin(cliente, eq(cliente.id, pedido.clienteId))
      .where(
        and(
          eq(pedido.organizacionId, actor.organizacionId),
          filtroDia,
          inArray(pedido.estado, ["EN_PRODUCCION", "ENTREGADO"]),
        ),
      )
      .orderBy(
        sql`${cliente.horarioEntregaFijo} asc nulls last`,
        asc(pedido.correlativo),
      );

    const paradas = [];
    for (const row of pedidos) {
      const items = await this.itemsPublicos(row.pedido.id, row.pedido.clienteId);
      const totalEstimadoCentavos = items.reduce(
        (acc, i) => acc + i.cantidadPedida * i.precioUnitarioCentavos,
        0,
      );
      const [fac] = await this.db
        .select()
        .from(factura)
        .where(eq(factura.pedidoId, row.pedido.id))
        .limit(1);
      const facturaPublica = fac
        ? await this.facturas.presentar(fac.id)
        : null;
      const { saldo, count } = await this.saldoCliente(
        row.pedido.clienteId,
        fac?.id,
      );
      paradas.push({
        pedidoId: row.pedido.id,
        correlativo: row.pedido.correlativo,
        clienteId: row.cliente.id,
        clienteNombre: row.cliente.nombre,
        horarioEntregaFijo: row.cliente.horarioEntregaFijo?.slice(0, 5) ?? null,
        telefonoWa: row.cliente.telefonoWa,
        fotoAssetId: row.cliente.fotoAssetId ?? null,
        notasPermanentes: row.cliente.notasPermanentes ?? null,
        estado: row.pedido.estado,
        totalEstimadoCentavos,
        saldoAnteriorCentavos: saldo,
        facturasPendientes: count,
        items,
        factura: facturaPublica,
      });
    }

    return rutaRepartoSchema.parse({
      fechaEntrega: diaReparto,
      fechaOperacion: fecha,
      cobradoHoyCentavos: Number(cobrado?.total ?? 0),
      paradas,
    });
  }

  private async resultado(
    pedidoId: string,
    actor: Actor,
    idempotente: boolean,
  ): Promise<EntregaResultado> {
    const [ped] = await this.db
      .select()
      .from(pedido)
      .where(
        and(eq(pedido.id, pedidoId), eq(pedido.organizacionId, actor.organizacionId)),
      )
      .limit(1);
    if (!ped) {
      throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
    }
    const [fac] = await this.db
      .select()
      .from(factura)
      .where(eq(factura.pedidoId, pedidoId))
      .limit(1);
    if (!fac) {
      throw new DomainException("FACTURA_NO_CREADA", "La entrega no generó factura", 500);
    }
    const items = await this.itemsPublicos(pedidoId, ped.clienteId);
    const presentada = await this.facturas.presentar(fac.id);
    return entregaResultadoSchema.parse({
      pedidoId,
      estado: "ENTREGADO",
      idempotente,
      items,
      factura: presentada,
    });
  }

  private async itemsPublicos(pedidoId: string, clienteId: string) {
    const items = await this.db
      .select({
        item: pedidoItem,
        fotoAssetId: producto.fotoAssetId,
      })
      .from(pedidoItem)
      .leftJoin(producto, eq(producto.id, pedidoItem.productoId))
      .where(eq(pedidoItem.pedidoId, pedidoId));
    const ligas = await this.db
      .select()
      .from(clienteProducto)
      .where(eq(clienteProducto.clienteId, clienteId));
    const notaPor = new Map(ligas.map((l) => [l.productoId, l.notaProduccion]));
    return items.map((row) => ({
      id: row.item.id,
      productoId: row.item.productoId,
      nombreMostrado: row.item.nombreMostrado,
      unidadMedida: row.item.unidadMedida,
      cantidadPedida: row.item.cantidadPedida,
      cantidadEntregada: row.item.cantidadEntregada,
      precioUnitarioCentavos: row.item.precioUnitarioCentavos,
      notaProduccion: notaPor.get(row.item.productoId) ?? null,
      fotoAssetId: row.fotoAssetId ?? null,
      esDevolucion: row.item.esDevolucion,
    }));
  }

  private async saldoCliente(
    clienteId: string,
    excluirFacturaId?: string,
  ): Promise<{ saldo: number; count: number }> {
    const { saldoCentavos, count } = await pendientesDeCliente(
      this.db,
      clienteId,
      excluirFacturaId,
    );
    return { saldo: saldoCentavos, count };
  }
}
