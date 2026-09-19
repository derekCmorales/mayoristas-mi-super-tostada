import { Inject, Injectable } from "@nestjs/common";
import { and, eq, sql } from "drizzle-orm";
import { cliente, pedido } from "@misupertostada/db";
import {
  anularPedidoRequestSchema,
  confirmarPedidoRequestSchema,
  crearPedidoManualRequestSchema,
  editarItemsPedidoRequestSchema,
  editarNotasPedidoRequestSchema,
  instanteAIso,
  listarPedidosQuerySchema,
  pedidoBandejaSchema,
  type PedidoBandeja,
  type PedidoDetalle,
  type PedidoSseEvent,
  type PortalPedido,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { esViolacionUnica } from "../shared/pg-error";
import type { Actor } from "../identity/actor";
import type { ClientePortal } from "./portal-token.service";
import { PedidoEvents } from "./pedido-events";
import {
  exigirAnulable,
  exigirCaptura,
  exigirConfirmado,
  exigirVentanaPortal,
  horarioDe,
} from "./pedido-reglas";
import { restaurarBonosDePedido } from "./pedido-bono";
import {
  buscarPedidoPortalAbierto,
  clienteDe,
  escribirItems,
  insertarPedido,
  itemsDe,
  listarPedidosBandeja,
  pedidoDe,
  reemplazarItems,
  totalesPorPedidoIds,
} from "./pedido-repositorio";
import {
  resolverSnapshotsConBonos,
  tasarItemsPagados,
} from "./pedido-tasacion";
import {
  exigirDiaNoCerrado,
  fechasCapturaPanel,
  relojVivoSobreCaptura,
} from "./pedido-calendario";
import {
  presentarPedidoPanel,
  presentarPortalPedido,
} from "./pedido-presentacion";

export type { PortalMeta } from "./portal-meta";

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
    meta: import("./portal-meta").PortalMeta,
  ): Promise<PortalPedido> {
    const input = parseBody(confirmarPedidoRequestSchema, body);
    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    const fechaEntrega = ejes.entregaCaptura;
    exigirVentanaPortal(cal, now, ejes);

    const abierto = await buscarPedidoPortalAbierto(
      this.db,
      clienteRow.id,
      fechaOperacion,
    );
    const itemsPrevios = abierto ? await itemsDe(this.db, abierto.id) : [];
    const snapshots = await tasarItemsPagados(
      this.db,
      clienteRow,
      input.items,
      itemsPrevios,
    );

    for (let intento = 0; intento < 5; intento++) {
      try {
        const resultado = await this.db.transaction(async (tx) => {
          await exigirDiaNoCerrado(
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

          const existente = await buscarPedidoPortalAbierto(
            tx,
            clienteRow.id,
            fechaOperacion,
          );
          const itemsAntes = existente
            ? await itemsDe(tx, existente.id)
            : [];
          const esEdicion = Boolean(existente);
          const pedidoId = existente
            ? existente.id
            : await insertarPedido(
                tx,
                clienteRow,
                { operacion: fechaOperacion, entrega: fechaEntrega },
                { origen: "PORTAL" },
              );

          const congelados = await resolverSnapshotsConBonos(
            tx,
            clienteRow,
            pedidoId,
            input.items,
            snapshots,
            itemsAntes,
          );

          if (existente) {
            await reemplazarItems(tx, existente.id, congelados);
          } else {
            await escribirItems(tx, pedidoId, congelados);
          }

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
            presentado: await presentarPortalPedido(
              this.db,
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
    meta: import("./portal-meta").PortalMeta,
  ): Promise<void> {
    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    exigirVentanaPortal(cal, now, ejes);

    const row = await buscarPedidoPortalAbierto(
      this.db,
      clienteRow.id,
      fechaOperacion,
    );
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
      await exigirDiaNoCerrado(
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
    const row = await buscarPedidoPortalAbierto(
      this.db,
      clienteId,
      fechaOperacion,
    );
    if (!row) return null;
    return presentarPortalPedido(
      this.db,
      row.id,
      horarioEntregaFijo,
    );
  }

  async listar(actor: Actor, query: unknown): Promise<PedidoBandeja[]> {
    const input = parseBody(listarPedidosQuerySchema, query);
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
      const fechas = await fechasCapturaPanel(
        this.calendar,
        actor.organizacionId,
      );
      filtros.push(eq(pedido.fechaOperacion, fechas.operacion));
    }
    if (input.clienteId) filtros.push(eq(pedido.clienteId, input.clienteId));
    if (input.estado) filtros.push(eq(pedido.estado, input.estado));

    const rows = await listarPedidosBandeja(
      this.db,
      and(...filtros),
      historialCliente,
    );
    const totales = await totalesPorPedidoIds(
      this.db,
      rows.map((r) => r.id),
    );

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
    return presentarPedidoPanel(
      this.db,
      this.calendar,
      id,
      actor.organizacionId,
    );
  }

  async crearManual(body: unknown, actor: Actor): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(crearPedidoManualRequestSchema, body);
    const fechas = await fechasCapturaPanel(this.calendar, actor.organizacionId);
    const fechaOperacion = fechas.operacion;
    const relojVivo = await relojVivoSobreCaptura(
      this.calendar,
      actor.organizacionId,
      fechaOperacion,
    );
    const clienteRow = await clienteDe(
      this.db,
      input.clienteId,
      actor.organizacionId,
    );
    const snapshots = await tasarItemsPagados(
      this.db,
      clienteRow,
      input.items,
      [],
    );
    const notasAdmin = input.notasAdmin?.trim() || null;

    for (let intento = 0; intento < 5; intento++) {
      try {
        const pedidoId = await this.db.transaction(async (tx) => {
          await exigirDiaNoCerrado(
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
          const id = await insertarPedido(tx, clienteRow, fechas, {
            origen: "MANUAL",
            capturadoPor: actor.usuarioId,
            notasAdmin,
          });
          const congelados = await resolverSnapshotsConBonos(
            tx,
            clienteRow,
            id,
            input.items,
            snapshots,
            [],
          );
          await escribirItems(tx, id, congelados);
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
        return presentarPedidoPanel(
          this.db,
          this.calendar,
          pedidoId,
          actor.organizacionId,
        );
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
    const row = await pedidoDe(this.db, id, actor.organizacionId);
    exigirConfirmado(row.estado);
    const notasAdmin = input.notasAdmin.trim();
    const relojVivo = await relojVivoSobreCaptura(
      this.calendar,
      actor.organizacionId,
      row.fechaOperacion,
    );
    await this.db.transaction(async (tx) => {
      await exigirDiaNoCerrado(
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
    return presentarPedidoPanel(
      this.db,
      this.calendar,
      row.id,
      actor.organizacionId,
    );
  }

  async editarItems(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(editarItemsPedidoRequestSchema, body);
    const row = await pedidoDe(this.db, id, actor.organizacionId);
    exigirConfirmado(row.estado);
    const itemsPrevios = await itemsDe(this.db, row.id);
    const snapshots = await tasarItemsPagados(
      this.db,
      { id: row.clienteId, organizacionId: row.organizacionId },
      input.items,
      itemsPrevios,
    );
    const relojVivo = await relojVivoSobreCaptura(
      this.calendar,
      actor.organizacionId,
      row.fechaOperacion,
    );

    await this.db.transaction(async (tx) => {
      await exigirDiaNoCerrado(
        tx,
        actor.organizacionId,
        row.fechaOperacion,
        relojVivo,
      );
      const itemsAntes = await itemsDe(tx, row.id);
      const congelados = await resolverSnapshotsConBonos(
        tx,
        { id: row.clienteId, organizacionId: row.organizacionId },
        row.id,
        input.items,
        snapshots,
        itemsAntes,
      );
      await reemplazarItems(tx, row.id, congelados);
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
    return presentarPedidoPanel(
      this.db,
      this.calendar,
      row.id,
      actor.organizacionId,
    );
  }

  async anular(id: string, body: unknown, actor: Actor): Promise<PedidoDetalle> {
    exigirCaptura(actor);
    const input = parseBody(anularPedidoRequestSchema, body);
    const row = await pedidoDe(this.db, id, actor.organizacionId);
    exigirAnulable(row.estado);
    const anuladoAt = this.calendar.now();
    const relojVivo = await relojVivoSobreCaptura(
      this.calendar,
      actor.organizacionId,
      row.fechaOperacion,
    );
    await this.db.transaction(async (tx) => {
      await exigirDiaNoCerrado(
        tx,
        actor.organizacionId,
        row.fechaOperacion,
        relojVivo,
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
    return presentarPedidoPanel(
      this.db,
      this.calendar,
      row.id,
      actor.organizacionId,
    );
  }

  async presentar(
    pedidoId: string,
    horarioEntregaFijo: string | null,
    tx: AppDatabase = this.db,
  ): Promise<PortalPedido> {
    return presentarPortalPedido(
      this.db,
      pedidoId,
      horarioEntregaFijo,
      tx,
    );
  }

  private emitir(
    organizacionId: string,
    evento: PedidoSseEvent,
  ): void {
    this.events.emit({ ...evento, organizacionId });
  }
}
