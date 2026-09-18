import { Inject, Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
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
  MENSAJE_PRECIO_AUSENTE,
  anularPedidoRequestSchema,
  confirmarPedidoRequestSchema,
  crearPedidoManualRequestSchema,
  editarItemsPedidoRequestSchema,
  editarNotasPedidoRequestSchema,
  instanteAIso,
  listarPedidosQuerySchema,
  pedidoBandejaSchema,
  pedidoDetalleSchema,
  portalPedidoSchema,
  precioEfectivoCentavos,
  textoConfirmacionPedido,
  totalPedidoCentavos,
  type PedidoBandeja,
  type PedidoDetalle,
  type PedidoSseEvent,
  type PortalPedido,
  capturaAbierta,
  type BusinessCalendar,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import {
  abonosAplicadosDeFactura,
  presentarFactura,
} from "../receivables/factura-presentacion";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import {
  BusinessCalendarService,
  type EjesOperacion,
} from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { esViolacionUnica } from "../shared/pg-error";
import type { Actor } from "../identity/actor";
import type { ClientePortal } from "./portal-token.service";
import { PedidoEvents } from "./pedido-events";
import {
  congelarSnapshots,
  diaCerrado,
  exigirAnulable,
  exigirCaptura,
  exigirConfirmado,
  horarioDe,
  ventanaCerrada,
  type ItemSnapshot,
} from "./pedido-reglas";
import {
  aplicarBonosEnPedido,
  restaurarBonosDePedido,
} from "./pedido-bono";
import {
  bloquearDiaOperacion,
  leerEstadoDia,
} from "../shared/dia-operacion";

export type PortalMeta = { ip: string | null; userAgent: string | null };

type ClienteRef = { id: string; organizacionId: string };

/** Operación (llave interna) y entrega (lo que ve el cliente), ya resueltas. */
type FechasPedido = { operacion: string; entrega: string };

@Injectable()
export class PedidoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly events: PedidoEvents,
  ) {}

  async upsertPortal(
    clienteRow: ClientePortal,
    body: unknown,
    meta: PortalMeta,
  ): Promise<PortalPedido> {
    const input = parseBody(confirmarPedidoRequestSchema, body);
    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    // Mismo eje de captura que el panel: con el día reabierto el portal escribe
    // sobre esa operación, no sobre la ventana siguiente. Ver `PortalService`.
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    const fechaEntrega = ejes.entregaCaptura;
    this.exigirVentanaPortal(cal, now, ejes);
    const [abierto] = await this.db
      .select()
      .from(pedido)
      .where(
        and(
          eq(pedido.clienteId, clienteRow.id),
          eq(pedido.fechaOperacion, fechaOperacion),
          eq(pedido.origen, "PORTAL"),
          isNull(pedido.anuladoAt),
        ),
      )
      .limit(1);
    const itemsPrevios = abierto
      ? await this.itemsDe(abierto.id, this.db)
      : [];
    const snapshots = await this.tasarItems(
      clienteRow,
      input.items,
      itemsPrevios,
    );

    for (let intento = 0; intento < 5; intento++) {
      try {
        const resultado = await this.db.transaction(async (tx) => {
          await this.exigirDiaNoCerrado(
            tx,
            clienteRow.organizacionId,
            fechaOperacion,
            ejes.ventanaAbierta,
          );
          await tx
            .select({ id: cliente.id })
            .from(cliente)
            .where(eq(cliente.id, clienteRow.id))
            .for("update");

          const [existente] = await tx
            .select()
            .from(pedido)
            .where(
              and(
                eq(pedido.clienteId, clienteRow.id),
                eq(pedido.fechaOperacion, fechaOperacion),
                eq(pedido.origen, "PORTAL"),
                isNull(pedido.anuladoAt),
              ),
            )
            .limit(1)
            .for("update");

          const itemsAntes = existente
            ? await this.itemsDe(existente.id, tx)
            : [];

          const esEdicion = Boolean(existente);
          const pedidoId = existente
            ? existente.id
            : await this.insertarPedido(
                tx,
                clienteRow,
                { operacion: fechaOperacion, entrega: fechaEntrega },
                { origen: "PORTAL" },
              );

          const congelados = await this.resolverSnapshotsConBonos(
            tx,
            clienteRow,
            pedidoId,
            input.items,
            snapshots,
            itemsAntes,
          );

          if (existente) {
            await tx
              .delete(pedidoItem)
              .where(eq(pedidoItem.pedidoId, existente.id));
          }

          await this.escribirItems(tx, pedidoId, congelados);

          if (!esEdicion) {
            await this.outbox.insert(
              {
                tipo: "PedidoConfirmado",
                destinatarioId: clienteRow.id,
                fechaOperacion,
                payload: {
                  pedidoId,
                  clienteId: clienteRow.id,
                  fechaOperacion,
                },
              },
              tx,
            );
          }

          await this.audit.insert(
            {
              actorTipo: "cliente",
              actorId: clienteRow.id,
              accion: esEdicion ? "portal.editar" : "portal.confirmar",
              entidad: "pedido",
              entidadId: pedidoId,
              antes: esEdicion ? { items: itemsAntes } : null,
              despues: { items: congelados },
              ip: meta.ip,
              userAgent: meta.userAgent,
            },
            tx,
          );

          return {
            presentado: await this.presentar(
              pedidoId,
              horarioDe(clienteRow),
              tx,
            ),
            tipo: esEdicion
              ? ("pedido.editado" as const)
              : ("pedido.creado" as const),
            pedidoId,
          };
        });
        this.emitir(clienteRow.organizacionId, {
          tipo: resultado.tipo,
          pedidoId: resultado.pedidoId,
          fechaOperacion,
        });
        return resultado.presentado;
      } catch (err) {
        if (!esViolacionUnica(err) || intento === 4) throw err;
      }
    }
    throw new DomainException("VALIDACION", "No se pudo crear el pedido", 500);
  }

  async anularPortal(
    clienteRow: ClientePortal,
    meta: PortalMeta,
  ): Promise<void> {
    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    this.exigirVentanaPortal(cal, now, ejes);

    const [row] = await this.db
      .select()
      .from(pedido)
      .where(
        and(
          eq(pedido.clienteId, clienteRow.id),
          eq(pedido.fechaOperacion, fechaOperacion),
          eq(pedido.origen, "PORTAL"),
          isNull(pedido.anuladoAt),
        ),
      )
      .limit(1);

    if (!row) {
      throw new DomainException(
        "NO_ENCONTRADO",
        "No tiene un pedido para cancelar",
        404,
      );
    }

    exigirAnulable(row.estado);
    const motivo = "Cancelado por el cliente desde el portal";
    const anuladoAt = this.calendar.now();

    await this.db.transaction(async (tx) => {
      await this.exigirDiaNoCerrado(
        tx,
        clienteRow.organizacionId,
        fechaOperacion,
        ejes.ventanaAbierta,
      );
      await restaurarBonosDePedido(tx, row.id);
      await tx
        .update(pedido)
        .set({
          estado: "ANULADO",
          anuladoAt,
          motivoAnulacion: motivo,
        })
        .where(eq(pedido.id, row.id));
      await this.audit.insert(
        {
          actorTipo: "cliente",
          actorId: clienteRow.id,
          accion: "portal.anular",
          entidad: "pedido",
          entidadId: row.id,
          antes: { estado: row.estado, anuladoAt: null },
          despues: {
            estado: "ANULADO",
            motivo,
            anuladoAt: instanteAIso(anuladoAt),
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
    });

    this.emitir(clienteRow.organizacionId, {
      tipo: "pedido.anulado",
      pedidoId: row.id,
      fechaOperacion: row.fechaOperacion,
    });
  }

  async portalAbierto(
    clienteId: string,
    fechaOperacion: string,
    horarioEntregaFijo: string | null,
  ): Promise<PortalPedido | null> {
    const [row] = await this.db
      .select()
      .from(pedido)
      .where(
        and(
          eq(pedido.clienteId, clienteId),
          eq(pedido.fechaOperacion, fechaOperacion),
          eq(pedido.origen, "PORTAL"),
          isNull(pedido.anuladoAt),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.presentar(row.id, horarioEntregaFijo);
  }

  async listar(actor: Actor, query: unknown): Promise<PedidoBandeja[]> {
    const input = parseBody(listarPedidosQuerySchema, query);
    /** Historial: cliente + flag, sin fecha → últimos pedidos de ese restaurante. */
    const desdeRango =
      input.desde && input.hasta
        ? input.desde <= input.hasta
          ? input.desde
          : input.hasta
        : (input.desde ?? input.fechaOperacion);
    const hastaRango =
      input.desde && input.hasta
        ? input.desde <= input.hasta
          ? input.hasta
          : input.desde
        : (input.hasta ?? input.fechaOperacion ?? desdeRango);
    const historialCliente =
      Boolean(input.clienteId) && !desdeRango && input.historial === true;
    const filtros = [eq(pedido.organizacionId, actor.organizacionId)];
    if (desdeRango && hastaRango) {
      if (desdeRango === hastaRango) {
        filtros.push(eq(pedido.fechaOperacion, desdeRango));
      } else {
        filtros.push(sql`${pedido.fechaOperacion} >= ${desdeRango}`);
        filtros.push(sql`${pedido.fechaOperacion} <= ${hastaRango}`);
      }
    } else if (!historialCliente) {
      const fechas = await this.fechaCapturaPanel(actor.organizacionId);
      filtros.push(eq(pedido.fechaOperacion, fechas.operacion));
    }
    if (input.clienteId) filtros.push(eq(pedido.clienteId, input.clienteId));
    if (input.estado) filtros.push(eq(pedido.estado, input.estado));

    const base = this.db
      .select({
        id: pedido.id,
        correlativo: pedido.correlativo,
        fechaOperacion: pedido.fechaOperacion,
        fechaEntrega: pedido.fechaEntrega,
        clienteId: pedido.clienteId,
        clienteNombre: cliente.nombre,
        estado: pedido.estado,
        origen: pedido.origen,
        capturadoPor: pedido.capturadoPor,
        capturadoAt: pedido.createdAt,
        notasAdmin: pedido.notasAdmin,
      })
      .from(pedido)
      .innerJoin(cliente, eq(cliente.id, pedido.clienteId))
      .where(and(...filtros));

    const rows = historialCliente
      ? await base
          .orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo))
          .limit(80)
      : await base.orderBy(desc(pedido.fechaOperacion), desc(pedido.correlativo));

    const ids = rows.map((r) => r.id);
    const totales = new Map<string, number>();
    if (ids.length > 0) {
      const items = await this.db
        .select()
        .from(pedidoItem)
        .where(inArray(pedidoItem.pedidoId, ids));
      for (const item of items) {
        const prev = totales.get(item.pedidoId) ?? 0;
        totales.set(
          item.pedidoId,
          prev + item.cantidadPedida * item.precioUnitarioCentavos,
        );
      }
    }

    return rows.map((row) =>
      pedidoBandejaSchema.parse({
        id: row.id,
        correlativo: row.correlativo,
        fechaOperacion: row.fechaOperacion,
        fechaEntrega: row.fechaEntrega,
        clienteId: row.clienteId,
        clienteNombre: row.clienteNombre,
        estado: row.estado,
        origen: row.origen,
        totalCentavos: totales.get(row.id) ?? 0,
        capturadoPor: row.capturadoPor ?? null,
        capturadoAt: instanteAIso(row.capturadoAt),
        notasAdmin: row.notasAdmin ?? null,
      }),
    );
  }

  async obtener(id: string, actor: Actor): Promise<PedidoDetalle> {
    return this.presentarPanel(id, actor.organizacionId);
  }

  async crearManual(body: unknown, actor: Actor): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(crearPedidoManualRequestSchema, body);
    const fechas = await this.fechaCapturaPanel(actor.organizacionId);
    const fechaOperacion = fechas.operacion;
    const relojVivo = await this.relojVivoSobre(
      actor.organizacionId,
      fechaOperacion,
    );
    const clienteRow = await this.clienteDe(
      input.clienteId,
      actor.organizacionId,
    );
    const snapshots = await this.tasarItems(clienteRow, input.items, []);
    const notasAdmin = input.notasAdmin?.trim() || null;

    for (let intento = 0; intento < 5; intento++) {
      try {
        const pedidoId = await this.db.transaction(async (tx) => {
          await this.exigirDiaNoCerrado(
            tx,
            actor.organizacionId,
            fechaOperacion,
            relojVivo,
          );
          await tx
            .select({ id: cliente.id })
            .from(cliente)
            .where(eq(cliente.id, clienteRow.id))
            .for("update");
          const id = await this.insertarPedido(tx, clienteRow, fechas, {
            origen: "MANUAL",
            capturadoPor: actor.usuarioId,
            notasAdmin,
          });
          const congelados = await this.resolverSnapshotsConBonos(
            tx,
            clienteRow,
            id,
            input.items,
            snapshots,
            [],
          );
          await this.escribirItems(tx, id, congelados);
          await this.outbox.insert(
            {
              tipo: "PedidoConfirmado",
              destinatarioId: clienteRow.id,
              fechaOperacion,
              payload: {
                pedidoId: id,
                clienteId: clienteRow.id,
                fechaOperacion,
              },
            },
            tx,
          );
          await this.audit.insert(
            {
              actorTipo: "usuario",
              actorId: actor.usuarioId,
              accion: "pedidos.capturar",
              entidad: "pedido",
              entidadId: id,
              antes: null,
              despues: { items: snapshots, notasAdmin, origen: "MANUAL" },
              ip: actor.ip,
              userAgent: actor.userAgent,
            },
            tx,
          );
          return id;
        });
        this.emitir(actor.organizacionId, {
          tipo: "pedido.creado",
          pedidoId,
          fechaOperacion,
        });
        return this.presentarPanel(pedidoId, actor.organizacionId);
      } catch (err) {
        if (!esViolacionUnica(err) || intento === 4) throw err;
      }
    }
    throw new DomainException("VALIDACION", "No se pudo crear el pedido", 500);
  }

  async editarNotas(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(editarNotasPedidoRequestSchema, body);
    const row = await this.pedidoDe(id, actor.organizacionId);
    exigirConfirmado(row.estado);
    const notasAdmin = input.notasAdmin.trim();
    const relojVivo = await this.relojVivoSobre(
      actor.organizacionId,
      row.fechaOperacion,
    );
    await this.db.transaction(async (tx) => {
      await this.exigirDiaNoCerrado(
        tx,
        actor.organizacionId,
        row.fechaOperacion,
        relojVivo,
      );
      await tx
        .update(pedido)
        .set({ notasAdmin })
        .where(eq(pedido.id, row.id));
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "pedidos.notas",
          entidad: "pedido",
          entidadId: row.id,
          antes: { notasAdmin: row.notasAdmin },
          despues: { notasAdmin },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
    this.emitir(actor.organizacionId, {
      tipo: "pedido.editado",
      pedidoId: row.id,
      fechaOperacion: row.fechaOperacion,
    });
    return this.presentarPanel(row.id, actor.organizacionId);
  }

  async editarItems(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(editarItemsPedidoRequestSchema, body);
    const row = await this.pedidoDe(id, actor.organizacionId);
    exigirConfirmado(row.estado);
    const itemsPrevios = await this.itemsDe(row.id, this.db);
    const snapshots = await this.tasarItems(
      { id: row.clienteId, organizacionId: row.organizacionId },
      input.items,
      itemsPrevios,
    );
    const relojVivoItems = await this.relojVivoSobre(
      actor.organizacionId,
      row.fechaOperacion,
    );

    await this.db.transaction(async (tx) => {
      await this.exigirDiaNoCerrado(
        tx,
        actor.organizacionId,
        row.fechaOperacion,
        relojVivoItems,
      );
      const itemsAntes = await this.itemsDe(row.id, tx);
      const congelados = await this.resolverSnapshotsConBonos(
        tx,
        { id: row.clienteId, organizacionId: row.organizacionId },
        row.id,
        input.items,
        snapshots,
        itemsAntes,
      );
      await tx.delete(pedidoItem).where(eq(pedidoItem.pedidoId, row.id));
      await this.escribirItems(tx, row.id, congelados);
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "pedidos.editar_items",
          entidad: "pedido",
          entidadId: row.id,
          antes: { items: itemsAntes },
          despues: { items: congelados },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
    this.emitir(actor.organizacionId, {
      tipo: "pedido.editado",
      pedidoId: row.id,
      fechaOperacion: row.fechaOperacion,
    });
    return this.presentarPanel(row.id, actor.organizacionId);
  }

  async anular(id: string, body: unknown, actor: Actor): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(anularPedidoRequestSchema, body);
    const row = await this.pedidoDe(id, actor.organizacionId);
    exigirAnulable(row.estado);
    const anuladoAt = this.calendar.now();
    const relojVivoAnular = await this.relojVivoSobre(
      actor.organizacionId,
      row.fechaOperacion,
    );
    await this.db.transaction(async (tx) => {
      await this.exigirDiaNoCerrado(
        tx,
        actor.organizacionId,
        row.fechaOperacion,
        relojVivoAnular,
      );
      await restaurarBonosDePedido(tx, row.id);
      await tx
        .update(pedido)
        .set({
          estado: "ANULADO",
          anuladoAt,
          motivoAnulacion: input.motivo,
        })
        .where(eq(pedido.id, row.id));
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "pedidos.anular",
          entidad: "pedido",
          entidadId: row.id,
          antes: { estado: row.estado, anuladoAt: null },
          despues: {
            estado: "ANULADO",
            motivo: input.motivo,
            anuladoAt: instanteAIso(anuladoAt),
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });
    this.emitir(actor.organizacionId, {
      tipo: "pedido.anulado",
      pedidoId: row.id,
      fechaOperacion: row.fechaOperacion,
    });
    return this.presentarPanel(row.id, actor.organizacionId);
  }

  async presentar(
    pedidoId: string,
    horarioEntregaFijo: string | null,
    tx: AppDatabase = this.db,
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

  private async presentarPanel(
    pedidoId: string,
    organizacionId: string,
  ): Promise<PedidoDetalle> {
    const row = await this.pedidoDe(pedidoId, organizacionId);
    const [cli] = await this.db
      .select()
      .from(cliente)
      .where(eq(cliente.id, row.clienteId))
      .limit(1);
    if (!cli) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    const cal = await this.calendar.load(organizacionId);
    const lineas = await this.db
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

    const logs = await this.db
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
      const users = await this.db
        .select({ id: usuario.id, username: usuario.username })
        .from(usuario)
        .where(inArray(usuario.id, usuarioIds));
      for (const u of users) nombres.set(u.id, u.username);
    }

    const capturadoPorNombre = row.capturadoPor
      ? (nombres.get(row.capturadoPor) ?? null)
      : null;

    const facturaInfo = await this.facturaDePedido(pedidoId, organizacionId);

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

  private async facturaDePedido(pedidoId: string, organizacionId: string) {
    const [fac] = await this.db
      .select()
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(eq(factura.pedidoId, pedidoId), eq(pedido.organizacionId, organizacionId)),
      )
      .limit(1);
    if (!fac) return null;

    const [facturaInfo, abonos] = await Promise.all([
      presentarFactura(this.db, this.calendar, fac.factura),
      abonosAplicadosDeFactura(this.db, fac.factura.id),
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

  private async tasarItems(
    clienteRow: ClienteRef,
    items: {
      productoId: string;
      cantidad: number;
      esDevolucion?: boolean;
      bonoId?: string;
    }[],
    previos: ItemSnapshot[],
  ): Promise<ItemSnapshot[]> {
    const claves = items.map((i) =>
      i.esDevolucion
        ? `d:${i.bonoId ?? i.productoId}:${i.productoId}`
        : `p:${i.productoId}`,
    );
    const unicos = new Set(claves);
    if (unicos.size !== claves.length) {
      throw new DomainException(
        "VALIDACION",
        "Hay productos repetidos en el pedido",
        400,
      );
    }

    const productos = await this.db
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.organizacionId, clienteRow.organizacionId),
          eq(producto.activo, true),
        ),
      );
    const porId = new Map(productos.map((p) => [p.id, p]));

    const ligas = await this.db
      .select()
      .from(clienteProducto)
      .where(eq(clienteProducto.clienteId, clienteRow.id));
    const ligaPorProducto = new Map(ligas.map((l) => [l.productoId, l]));
    const previoPorClave = new Map(
      previos.map((i) => [`${i.productoId}:${i.esDevolucion ? "1" : "0"}`, i]),
    );

    return items
      .filter((item) => !item.esDevolucion)
      .map((item) => {
        const clave = `${item.productoId}:0`;
        const ya = previoPorClave.get(clave);
        if (ya) {
          return { ...ya, cantidad: item.cantidad };
        }
        const prod = porId.get(item.productoId);
        const liga = ligaPorProducto.get(item.productoId);
        const precioUnitarioCentavos = prod
          ? precioEfectivoCentavos({
              precioClienteCentavos: liga?.precioCentavos ?? null,
              precioBaseCentavos: prod.precioBaseCentavos ?? null,
            })
          : null;
        if (!prod || precioUnitarioCentavos == null) {
          throw new DomainException(
            "PRECIO_AUSENTE",
            MENSAJE_PRECIO_AUSENTE,
            409,
          );
        }
        const alias = liga?.alias?.trim();
        return {
          productoId: item.productoId,
          cantidad: item.cantidad,
          nombreMostrado: alias || prod.nombreCanonico,
          unidadMedida: prod.unidadMedida,
          precioUnitarioCentavos,
          esDevolucion: false,
          bonoId: null,
        };
      });
  }

  private async resolverSnapshotsConBonos(
    tx: AppDatabase,
    clienteRow: ClienteRef,
    pedidoId: string,
    itemsInput: {
      productoId: string;
      cantidad: number;
      esDevolucion?: boolean;
      bonoId?: string;
    }[],
    snapshotsPagados: ItemSnapshot[],
    itemsAntes: ItemSnapshot[],
  ): Promise<ItemSnapshot[]> {
    const productos = await tx
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.organizacionId, clienteRow.organizacionId),
          eq(producto.activo, true),
        ),
      );
    const porId = new Map(productos.map((p) => [p.id, p]));
    const ligas = await tx
      .select()
      .from(clienteProducto)
      .where(eq(clienteProducto.clienteId, clienteRow.id));
    const ligaPorProducto = new Map(ligas.map((l) => [l.productoId, l]));

    const devolucionSnapshots = await aplicarBonosEnPedido(
      tx,
      clienteRow.id,
      pedidoId,
      itemsInput,
      (_item, _bonoId) => {
        const prod = porId.get(_item.productoId);
        if (!prod) {
          throw new DomainException(
            "PRODUCTO_INACTIVO",
            "El producto no está activo",
            409,
          );
        }
        const liga = ligaPorProducto.get(_item.productoId);
        const alias = liga?.alias?.trim();
        return {
          nombreMostrado: alias || prod.nombreCanonico,
          unidadMedida: prod.unidadMedida,
          precioUnitarioCentavos: 0,
        };
      },
    );

    return congelarSnapshots(
      [...snapshotsPagados, ...devolucionSnapshots],
      itemsAntes,
    );
  }

  /**
   * Un pedido capturado desde el panel entra siempre en el eje de **captura**,
   * nunca en el de reparto: si se digita a las 09:00, pertenece a la ventana
   * que abre esa tarde, no a la que Tony está entregando.
   */
  private async fechaCapturaPanel(
    organizacionId: string,
  ): Promise<FechasPedido> {
    const ejes = await this.calendar.ejes(organizacionId);
    return { operacion: ejes.captura, entrega: ejes.entregaCaptura };
  }

  private async relojVivoSobre(
    organizacionId: string,
    fechaOperacion: string,
  ): Promise<boolean> {
    const ejes = await this.calendar.ejes(organizacionId);
    return ejes.ventanaAbierta && ejes.captura === fechaOperacion;
  }

  private async exigirDiaNoCerrado(
    tx: AppDatabase,
    organizacionId: string,
    fechaOperacion: string,
    relojVivoSobreEstaFecha: boolean,
  ): Promise<void> {
    await bloquearDiaOperacion(tx, organizacionId, fechaOperacion);
    const { diaEstado } = await leerEstadoDia(tx, organizacionId, fechaOperacion);
    if (diaEstado !== "CERRADO") return;
    if (relojVivoSobreEstaFecha) return;
    throw diaCerrado();
  }

  /**
   * Un día REABIERTO acepta pedidos del portal aunque el reloj diga que la
   * ventana venció: es lo mismo que ya permite el panel. `exigirDiaNoCerrado`
   * cierra la carrera dentro de la transacción.
   */
  private exigirVentanaPortal(
    cal: BusinessCalendar,
    now: Date,
    ejes: EjesOperacion,
  ): void {
    if (capturaAbierta(ejes.ventanaAbierta, ejes.estadoCaptura)) return;
    throw ventanaCerrada(cal.getProximaApertura(now));
  }

  private async insertarPedido(
    tx: AppDatabase,
    clienteRow: ClienteRef,
    fechas: FechasPedido,
    opts: {
      origen: "PORTAL" | "MANUAL";
      capturadoPor?: string | null;
      notasAdmin?: string | null;
    },
  ): Promise<string> {
    const [agg] = await tx
      .select({
        max: sql<number>`coalesce(max(${pedido.correlativo}), 0)::int`,
      })
      .from(pedido)
      .where(eq(pedido.organizacionId, clienteRow.organizacionId));
    const correlativo = Number(agg?.max ?? 0) + 1;
    const [row] = await tx
      .insert(pedido)
      .values({
        organizacionId: clienteRow.organizacionId,
        correlativo,
        fechaOperacion: fechas.operacion,
        fechaEntrega: fechas.entrega,
        clienteId: clienteRow.id,
        estado: "CONFIRMADO",
        origen: opts.origen,
        capturadoPor: opts.capturadoPor ?? null,
        notasAdmin: opts.notasAdmin ?? null,
      })
      .returning({ id: pedido.id });
    if (!row) {
      throw new DomainException("VALIDACION", "No se pudo crear el pedido", 500);
    }
    return row.id;
  }

  private async escribirItems(
    tx: AppDatabase,
    pedidoId: string,
    items: ItemSnapshot[],
  ): Promise<void> {
    if (items.length === 0) return;
    await tx.insert(pedidoItem).values(
      items.map((item) => ({
        pedidoId,
        productoId: item.productoId,
        cantidadPedida: item.cantidad,
        cantidadEntregada: item.cantidad,
        precioUnitarioCentavos: item.precioUnitarioCentavos,
        nombreMostrado: item.nombreMostrado,
        unidadMedida: item.unidadMedida,
        esDevolucion: item.esDevolucion,
        bonoId: item.bonoId,
      })),
    );
  }

  private async itemsDe(
    pedidoId: string,
    tx: AppDatabase,
  ): Promise<ItemSnapshot[]> {
    const rows = await tx
      .select()
      .from(pedidoItem)
      .where(eq(pedidoItem.pedidoId, pedidoId));
    return rows.map((item) => ({
      productoId: item.productoId,
      cantidad: item.cantidadPedida,
      nombreMostrado: item.nombreMostrado,
      unidadMedida: item.unidadMedida,
      precioUnitarioCentavos: item.precioUnitarioCentavos,
      esDevolucion: item.esDevolucion,
      bonoId: item.bonoId ?? null,
    }));
  }

  private async clienteDe(
    id: string,
    organizacionId: string,
  ): Promise<typeof cliente.$inferSelect> {
    const [row] = await this.db
      .select()
      .from(cliente)
      .where(and(eq(cliente.id, id), eq(cliente.organizacionId, organizacionId)))
      .limit(1);
    if (!row) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    return row;
  }

  private async pedidoDe(id: string, organizacionId: string) {
    const [row] = await this.db
      .select()
      .from(pedido)
      .where(
        and(eq(pedido.id, id), eq(pedido.organizacionId, organizacionId)),
      )
      .limit(1);
    if (!row) {
      throw new DomainException("NO_ENCONTRADO", "Pedido no encontrado", 404);
    }
    return row;
  }

  private emitir(
    organizacionId: string,
    evento: PedidoSseEvent,
  ): void {
    this.events.emit({ ...evento, organizacionId });
  }
}
