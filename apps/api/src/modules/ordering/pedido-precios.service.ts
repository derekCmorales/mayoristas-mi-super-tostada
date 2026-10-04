import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq, inArray, notInArray } from "drizzle-orm";
import {
  cliente,
  clienteProducto,
  pedido,
  pedidoItem,
  producto,
} from "@misupertostada/db";
import {
  MENSAJE_AJUSTE_BAJO_ABONADO,
  MAXIMO_DIAS_RECALCULO,
  MENSAJE_PEDIDO_ANULADO,
  MENSAJE_RECALCULO_FUERA_DE_PLAZO,
  MENSAJE_VISTA_PREVIA_VENCIDA,
  desplazarFecha,
  ajustarPreciosPedidoRequestSchema,
  ajustePrecioPedidoSchema,
  montoFacturaCentavos,
  precioEfectivoCentavos,
  recalcularPreciosRequestSchema,
  recalcularPreciosResultadoSchema,
  totalPedidoCentavos,
  type AjustePrecioPedido,
  type PedidoDetalle,
  type RecalcularPreciosResultado,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import {
  FACTURA_AJUSTE,
  type FacturaAjuste,
} from "../receivables/factura-ajuste";
import { PedidoEvents } from "./pedido-events";
import { exigirPermisoPrecios } from "./pedido-reglas";
import { presentarPedidoPanel } from "./pedido-presentacion";

type PedidoRow = typeof pedido.$inferSelect;
type LineaRow = typeof pedidoItem.$inferSelect;

type Plan = {
  vista: AjustePrecioPedido;
  pedido: PedidoRow;
  /** Valor de `precio_manual` para cada línea que cambia. */
  manual: Map<string, boolean>;
};

type OrigenAjuste = "MANUAL" | "CATALOGO";

/**
 * Corrección de precios de pedidos ya capturados.
 *
 * El snapshot de precio (§2.2) existe para que un cambio de catálogo **no**
 * reescriba pedidos solo. Este servicio es la puerta explícita para cuando el
 * snapshot nació mal —p. ej. un catálogo regresado a la lista de fábrica—:
 * alguien con `precios.cambiar` lo pide, con motivo, y queda en `audit_log`.
 *
 * - Antes de entregar: solo cambia `pedido_item.precio_unitario_centavos`.
 * - Ya entregado: además mueve el monto de la factura (port `FACTURA_AJUSTE`),
 *   que deja su propio rastro en `factura_ajuste`. Si Carla ya capturó DTE, la
 *   respuesta lo trae para que el panel avise de la nota de crédito/débito.
 * - Nunca baja una factura por debajo de lo ya abonado: no hay devoluciones.
 * - El recálculo con catálogo respeta las líneas con `precio_manual`: un
 *   precio negociado a propósito no es un snapshot mal nacido.
 *
 * Cantidades, nombres y hoja de producción no se tocan: el día puede estar
 * cerrado y producción no se entera.
 */
@Injectable()
export class PedidoPreciosService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly events: PedidoEvents,
    @Inject(FACTURA_AJUSTE) private readonly facturas: FacturaAjuste,
  ) {}

  /** Precios puestos a mano para un pedido. */
  async ajustar(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<PedidoDetalle> {
    exigirPermisoPrecios(actor);
    const input = parseBody(ajustarPreciosPedidoRequestSchema, body);
    const nuevos = new Map(
      input.items.map((i) => [i.productoId, i.precioUnitarioCentavos]),
    );
    if (nuevos.size !== input.items.length) {
      throw new DomainException(
        "VALIDACION",
        "Hay productos repetidos en el ajuste",
        400,
      );
    }

    const plan = await this.db.transaction(async (tx) => {
      const row = await bloquearPedido(tx, id, actor.organizacionId);
      if (row.estado === "ANULADO") {
        throw new DomainException("PEDIDO_ANULADO", MENSAJE_PEDIDO_ANULADO, 409);
      }
      const lineas = await lineasDe(tx, row.id);
      const pagadas = new Set(
        lineas.filter((l) => !l.esDevolucion).map((l) => l.productoId),
      );
      if ([...nuevos.keys()].some((p) => !pagadas.has(p))) {
        throw new DomainException(
          "VALIDACION",
          "Ese producto no está en el pedido",
          400,
        );
      }
      const nombre = await nombreCliente(tx, row.clienteId);
      const catalogo = await preciosDeCatalogo(tx, actor.organizacionId, [
        row.clienteId,
      ]);
      // Igual al catálogo deja de ser «a mano»: el recálculo ya puede tocarlo.
      const plan = await this.planear(tx, row, nombre, lineas, nuevos, (p, c) =>
        c !== catalogo(row.clienteId, p),
      );
      if (plan.vista.omitido) {
        throw new DomainException(
          "AJUSTE_BAJO_ABONADO",
          plan.vista.omitido,
          409,
        );
      }
      if (plan.vista.cambios.length > 0) {
        await this.aplicar(tx, plan, input.motivo, "MANUAL", actor);
      }
      return plan;
    });

    if (plan.vista.cambios.length > 0) this.emitir(actor, [plan]);
    return presentarPedidoPanel(
      this.db,
      this.calendar,
      id,
      actor.organizacionId,
    );
  }

  /**
   * Todos los pedidos vivos de una operación, con el precio que el catálogo
   * les da hoy. Sin `aplicar` es solo vista previa.
   */
  async recalcular(
    body: unknown,
    actor: Actor,
  ): Promise<RecalcularPreciosResultado> {
    exigirPermisoPrecios(actor);
    const input = parseBody(recalcularPreciosRequestSchema, body);
    const { hoyCivil } = await this.calendar.ejes(actor.organizacionId);
    if (input.fechaOperacion < desplazarFecha(hoyCivil, -MAXIMO_DIAS_RECALCULO)) {
      throw new DomainException(
        "RECALCULO_FUERA_DE_PLAZO",
        MENSAJE_RECALCULO_FUERA_DE_PLAZO,
        409,
      );
    }

    let lineasManualesDelDia = 0;
    const planes = await this.db.transaction(async (tx) => {
      lineasManualesDelDia = 0;
      const consulta = tx
        .select()
        .from(pedido)
        .where(
          and(
            eq(pedido.organizacionId, actor.organizacionId),
            eq(pedido.fechaOperacion, input.fechaOperacion),
            notInArray(pedido.estado, ["ANULADO", "BORRADOR"]),
          ),
        )
        .orderBy(asc(pedido.correlativo));
      // La vista previa no bloquea: no debe frenar a Tony entregando.
      const pedidos = input.aplicar
        ? await consulta.for("update")
        : await consulta;
      if (pedidos.length === 0) return [];

      const precios = await preciosDeCatalogo(
        tx,
        actor.organizacionId,
        pedidos.map((p) => p.clienteId),
      );
      const nombres = await nombresDeClientes(
        tx,
        pedidos.map((p) => p.clienteId),
      );
      const todasLasLineas = await tx
        .select()
        .from(pedidoItem)
        .where(
          inArray(
            pedidoItem.pedidoId,
            pedidos.map((p) => p.id),
          ),
        );

      const planes: Plan[] = [];
      for (const row of pedidos) {
        const lineas = todasLasLineas.filter((l) => l.pedidoId === row.id);
        const nuevos = new Map<string, number>();
        let lineasManuales = 0;
        for (const l of lineas) {
          if (l.esDevolucion) continue;
          const precio = precios(row.clienteId, l.productoId);
          if (precio == null || precio === l.precioUnitarioCentavos) continue;
          if (l.precioManual) {
            lineasManuales += 1;
            continue;
          }
          nuevos.set(l.productoId, precio);
        }
        const plan = await this.planear(
          tx,
          row,
          nombres.get(row.clienteId) ?? "",
          lineas,
          nuevos,
          () => false,
        );
        plan.vista.lineasManuales = lineasManuales;
        lineasManualesDelDia += lineasManuales;
        if (plan.vista.cambios.length > 0) planes.push(plan);
      }
      if (!input.aplicar || !input.motivo) return planes;

      // Solo se escribe lo que el usuario vio y aprobó.
      const aplicables = planes.filter((p) => !p.vista.omitido);
      const esperado = new Map(
        (input.esperado ?? []).map((e) => [e.pedidoId, e]),
      );
      // Total, estado y DTE: si el pedido se entregó o le capturaron DTE
      // después de la vista previa, el usuario no vio que se tocaría su
      // factura ni el aviso de la nota de crédito/débito.
      const coincide =
        aplicables.length === esperado.size &&
        aplicables.every((p) => {
          const e = esperado.get(p.vista.pedidoId);
          return (
            e != null &&
            e.totalDespuesCentavos === p.vista.totalDespuesCentavos &&
            e.estado === p.vista.estado &&
            e.numeroDte === p.vista.numeroDte
          );
        });
      if (!coincide) {
        throw new DomainException(
          "VISTA_PREVIA_VENCIDA",
          MENSAJE_VISTA_PREVIA_VENCIDA,
          409,
        );
      }
      for (const plan of aplicables) {
        // Savepoint por pedido: un abono que entra a media corrida deja ese
        // pedido sin tocar, no tumba los demás.
        try {
          await tx.transaction((sp) =>
            this.aplicar(sp, plan, input.motivo!, "CATALOGO", actor),
          );
        } catch (err) {
          if (
            err instanceof DomainException &&
            err.code === "AJUSTE_BAJO_ABONADO"
          ) {
            plan.vista.omitido = MENSAJE_AJUSTE_BAJO_ABONADO;
            continue;
          }
          throw err;
        }
      }
      return planes;
    });

    if (input.aplicar) {
      this.emitir(
        actor,
        planes.filter((p) => !p.vista.omitido),
      );
    }
    return recalcularPreciosResultadoSchema.parse({
      fechaOperacion: input.fechaOperacion,
      aplicado: input.aplicar,
      pedidos: planes.map((p) => p.vista),
      lineasManuales: lineasManualesDelDia,
    });
  }

  private async planear(
    tx: AppDatabase,
    row: PedidoRow,
    clienteNombre: string,
    lineas: LineaRow[],
    nuevos: Map<string, number>,
    esManual: (productoId: string, precioCentavos: number) => boolean,
  ): Promise<Plan> {
    // La factura se calcula sobre lo entregado (§5); antes de entregar, sobre
    // lo pedido.
    const entregado = row.estado === "ENTREGADO";
    const precioNuevo = (l: LineaRow) =>
      l.esDevolucion
        ? l.precioUnitarioCentavos
        : (nuevos.get(l.productoId) ?? l.precioUnitarioCentavos);

    const cambios = lineas
      .filter((l) => !l.esDevolucion && precioNuevo(l) !== l.precioUnitarioCentavos)
      .map((l) => ({
        productoId: l.productoId,
        nombreMostrado: l.nombreMostrado,
        antesCentavos: l.precioUnitarioCentavos,
        despuesCentavos: precioNuevo(l),
      }));
    // Misma regla que EntregaService para la factura; la del pedido si no.
    const total = (precio: (l: LineaRow) => number) =>
      entregado
        ? montoFacturaCentavos(
            lineas.map((l) => ({
              cantidadEntregada: l.cantidadEntregada,
              precioUnitarioCentavos: precio(l),
            })),
          )
        : totalPedidoCentavos(
            lineas.map((l) => ({
              cantidad: l.cantidadPedida,
              precioUnitarioCentavos: precio(l),
            })),
          );
    const totalAntesCentavos = total((l) => l.precioUnitarioCentavos);
    const totalDespuesCentavos = total(precioNuevo);

    // Solo un pedido entregado tiene factura (nace en EntregaService).
    const factura =
      cambios.length > 0 && entregado
        ? await this.facturas.vistaDePedido(tx, row.id)
        : null;
    const omitido =
      factura && totalDespuesCentavos < factura.abonadoCentavos
        ? MENSAJE_AJUSTE_BAJO_ABONADO
        : null;

    return {
      pedido: row,
      manual: new Map(
        cambios.map((c) => [c.productoId, esManual(c.productoId, c.despuesCentavos)]),
      ),
      vista: ajustePrecioPedidoSchema.parse({
        pedidoId: row.id,
        correlativo: row.correlativo,
        clienteNombre,
        estado: row.estado,
        totalAntesCentavos,
        totalDespuesCentavos,
        cambios,
        ajustaFactura:
          factura !== null && factura.montoCentavos !== totalDespuesCentavos,
        numeroDte: factura?.numeroDte ?? null,
        omitido,
      }),
    };
  }

  private async aplicar(
    tx: AppDatabase,
    plan: Plan,
    motivo: string,
    origen: OrigenAjuste,
    actor: Actor,
  ): Promise<void> {
    const { vista } = plan;
    for (const c of vista.cambios) {
      await tx
        .update(pedidoItem)
        .set({
          precioUnitarioCentavos: c.despuesCentavos,
          precioManual: plan.manual.get(c.productoId) ?? false,
        })
        .where(
          and(
            eq(pedidoItem.pedidoId, vista.pedidoId),
            eq(pedidoItem.productoId, c.productoId),
            eq(pedidoItem.esDevolucion, false),
          ),
        );
    }
    const factura = vista.ajustaFactura
      ? await this.facturas.ajustarEnTx(tx, {
          pedidoId: vista.pedidoId,
          montoCentavos: vista.totalDespuesCentavos,
          motivo,
          actor,
        })
      : null;
    await this.audit.insert(
      {
        actorTipo: "usuario",
        actorId: actor.usuarioId,
        accion: "pedidos.ajustar_precios",
        entidad: "pedido",
        entidadId: vista.pedidoId,
        antes: {
          estado: vista.estado,
          totalCentavos: vista.totalAntesCentavos,
          precios: vista.cambios.map((c) => ({
            productoId: c.productoId,
            precioUnitarioCentavos: c.antesCentavos,
          })),
        },
        despues: {
          motivo,
          origen,
          totalCentavos: vista.totalDespuesCentavos,
          precios: vista.cambios.map((c) => ({
            productoId: c.productoId,
            precioUnitarioCentavos: c.despuesCentavos,
          })),
          factura: factura
            ? {
                facturaId: factura.facturaId,
                montoAnteriorCentavos: factura.montoAnteriorCentavos,
                montoNuevoCentavos: factura.montoNuevoCentavos,
                numeroDte: factura.numeroDte,
              }
            : null,
        },
        ip: actor.ip,
        userAgent: actor.userAgent,
      },
      tx,
    );
  }

  private emitir(actor: Actor, planes: Plan[]): void {
    for (const { vista, pedido: row } of planes) {
      this.events.emit({
        organizacionId: actor.organizacionId,
        tipo: "pedido.editado",
        pedidoId: vista.pedidoId,
        fechaOperacion: row.fechaOperacion,
      });
      if (vista.ajustaFactura) {
        this.events.emit({
          organizacionId: actor.organizacionId,
          tipo: "factura.actualizada",
          fechaOperacion: row.fechaOperacion,
          pedidoId: vista.pedidoId,
          clienteId: row.clienteId,
        });
      }
    }
  }
}

async function bloquearPedido(
  tx: AppDatabase,
  id: string,
  organizacionId: string,
): Promise<PedidoRow> {
  const [row] = await tx
    .select()
    .from(pedido)
    .where(and(eq(pedido.id, id), eq(pedido.organizacionId, organizacionId)))
    .limit(1)
    .for("update");
  if (!row) {
    throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
  }
  return row;
}

function lineasDe(tx: AppDatabase, pedidoId: string): Promise<LineaRow[]> {
  return tx.select().from(pedidoItem).where(eq(pedidoItem.pedidoId, pedidoId));
}

async function nombreCliente(tx: AppDatabase, clienteId: string) {
  const nombres = await nombresDeClientes(tx, [clienteId]);
  return nombres.get(clienteId) ?? "";
}

async function nombresDeClientes(
  tx: AppDatabase,
  clienteIds: string[],
): Promise<Map<string, string>> {
  const rows = await tx
    .select({ id: cliente.id, nombre: cliente.nombre })
    .from(cliente)
    .where(inArray(cliente.id, [...new Set(clienteIds)]));
  return new Map(rows.map((r) => [r.id, r.nombre]));
}

/**
 * Precio que el catálogo le da hoy a cada cliente: el suyo si lo tiene, si no
 * el de lista. Misma regla que `tasarItemsPagados`, para todos de una vez.
 */
async function preciosDeCatalogo(
  tx: AppDatabase,
  organizacionId: string,
  clienteIds: string[],
): Promise<(clienteId: string, productoId: string) => number | null> {
  const productos = await tx
    .select({ id: producto.id, precioBaseCentavos: producto.precioBaseCentavos })
    .from(producto)
    // Como `cargarCatalogoCliente`: un producto inactivo no tiene precio
    // vigente, así que sus líneas se quedan como están.
    .where(
      and(eq(producto.organizacionId, organizacionId), eq(producto.activo, true)),
    );
  const ligas = await tx
    .select({
      clienteId: clienteProducto.clienteId,
      productoId: clienteProducto.productoId,
      precioCentavos: clienteProducto.precioCentavos,
    })
    .from(clienteProducto)
    .where(inArray(clienteProducto.clienteId, [...new Set(clienteIds)]));
  const base = new Map(productos.map((p) => [p.id, p.precioBaseCentavos]));
  const propio = new Map(
    ligas.map((l) => [`${l.clienteId}:${l.productoId}`, l.precioCentavos]),
  );
  return (clienteId, productoId) =>
    !base.has(productoId)
      ? null
      : precioEfectivoCentavos({
          precioClienteCentavos:
            propio.get(`${clienteId}:${productoId}`) ?? null,
          precioBaseCentavos: base.get(productoId) ?? null,
        });
}
