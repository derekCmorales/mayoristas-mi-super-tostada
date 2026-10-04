import { Inject, Injectable } from "@nestjs/common";
import { and, count, desc, eq, inArray, sql } from "drizzle-orm";
import { abono, asset, cliente, factura, pago, pedido, usuario } from "@misupertostada/db";
import {
  MENSAJE_ABONO_NO_PENDIENTE,
  MENSAJE_COMPROBANTE_REQUERIDO,
  MENSAJE_PAGO_EXCEDE_SALDO,
  abonoListaSchema,
  abonoRegistroResultadoSchema,
  abonosQuerySchema,
  aplicarFifo,
  fechaDeInstante,
  pagoRequiereComprobante,
  rechazarAbonoRequestSchema,
  reportarAbonoPortalRequestSchema,
  registrarPagoRequestSchema,
  tienePermiso,
  type AbonoLista,
  type AbonoPublico,
  type AbonoRegistroResultado,
  type PortalCuenta,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { FacturaService } from "./factura.service";
import {
  ABONO_PORTAL,
  type AbonoPortal,
  type AbonoPortalMeta,
} from "./abono-portal";
import {
  construirCuentaCliente,
  facturasPendientesDeCliente,
  presentarAbono,
} from "./abono-presentacion";
import { presentarFactura } from "./factura-presentacion";

@Injectable()
export class AbonoService implements AbonoPortal {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly bus: PedidoEvents,
    private readonly facturas: FacturaService,
  ) {}

  async cuentaDe(
    clienteId: string,
    organizacionId: string,
  ): Promise<PortalCuenta> {
    const [cli] = await this.db
      .select()
      .from(cliente)
      .where(
        and(eq(cliente.id, clienteId), eq(cliente.organizacionId, organizacionId)),
      )
      .limit(1);
    if (!cli) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    return construirCuentaCliente(this.db, this.calendar, cli);
  }

  async reportarTransferencia(
    clienteId: string,
    organizacionId: string,
    body: unknown,
    meta: AbonoPortalMeta,
  ): Promise<AbonoPublico> {
    const input = parseBody(reportarAbonoPortalRequestSchema, body);
    const existente = await this.porIdempotencia(input.id, input.idempotencyKey);
    if (existente) {
      return presentarAbono(this.db, existente);
    }

    const fecha = fechaDeInstante(this.calendar.now());
    const [row] = await this.db.transaction(async (tx) => {
      await this.exigirComprobanteAbono(tx, input.comprobanteAssetId, input.id);
      const inserted = await tx
        .insert(abono)
        .values({
          id: input.id,
          clienteId,
          montoCentavos: input.montoCentavos,
          metodo: "TRANSFERENCIA",
          estado: "PENDIENTE",
          descripcion: input.descripcion,
          comprobanteAssetId: input.comprobanteAssetId,
          origen: "PORTAL",
          registradoPor: null,
          fecha,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      const ab = inserted[0];
      if (!ab) {
        throw new DomainException("ABONO_NO_CREADO", "No se pudo reportar el abono", 500);
      }
      await this.audit.insert(
        {
          actorTipo: "cliente",
          actorId: clienteId,
          accion: "portal.reportar_abono",
          entidad: "abono",
          entidadId: ab.id,
          despues: {
            montoCentavos: ab.montoCentavos,
            metodo: ab.metodo,
            estado: ab.estado,
          },
          ip: meta.ip,
          userAgent: meta.userAgent,
        },
        tx,
      );
      return inserted;
    });

    this.bus.emit({
      organizacionId,
      tipo: "abono.reportado",
      fechaOperacion: fecha,
      clienteId,
      abonoId: row!.id,
    });
    return presentarAbono(this.db, row!);
  }

  async registrarConfirmado(
    body: unknown,
    actor: Actor,
  ): Promise<AbonoRegistroResultado> {
    if (!tienePermiso(actor.permisos, "cobranza.registrar_pago")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(registrarPagoRequestSchema, body);
    const existente = await this.porIdempotencia(input.id, input.idempotencyKey);
    if (existente) {
      return this.resultadoDeAbono(existente, true);
    }

    const fecha = this.fechaPago(input.fecha, actor);
    const now = this.calendar.now();
    const origen = input.origen ?? (actor.rol === "REPARTO" ? "REPARTO" : "MANUAL");

    const { abonoRow, pagosInsertados } = await this.db.transaction(async (tx) => {
      const [cli] = await tx
        .select()
        .from(cliente)
        .where(
          and(
            eq(cliente.id, input.clienteId),
            eq(cliente.organizacionId, actor.organizacionId),
          ),
        )
        .limit(1);
      if (!cli) {
        throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
      }

      if (pagoRequiereComprobante(input.metodo)) {
        if (!input.comprobanteAssetId) {
          throw new DomainException(
            "COMPROBANTE_REQUERIDO",
            MENSAJE_COMPROBANTE_REQUERIDO,
            400,
          );
        }
        await this.exigirComprobanteAbono(tx, input.comprobanteAssetId, input.id);
      } else if (input.comprobanteAssetId) {
        await this.exigirComprobanteAbono(tx, input.comprobanteAssetId, input.id);
      }

      const [ab] = await tx
        .insert(abono)
        .values({
          id: input.id,
          clienteId: input.clienteId,
          montoCentavos: input.montoCentavos,
          metodo: input.metodo,
          estado: "CONFIRMADO",
          descripcion: null,
          comprobanteAssetId: input.comprobanteAssetId ?? null,
          origen,
          registradoPor: actor.usuarioId,
          confirmadoPor: actor.usuarioId,
          confirmadoAt: now,
          fecha,
          idempotencyKey: input.idempotencyKey,
        })
        .returning();
      if (!ab) {
        throw new DomainException("ABONO_NO_CREADO", "No se pudo registrar el abono", 500);
      }

      const pagosInsertados = await this.aplicarEnTx(tx, ab, actor, fecha);
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "cobranza.registrar_pago",
          entidad: "abono",
          entidadId: ab.id,
          despues: {
            clienteId: ab.clienteId,
            montoCentavos: ab.montoCentavos,
            metodo: ab.metodo,
            pagos: pagosInsertados.length,
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      if (pagosInsertados[0]) {
        await this.facturas.verificarLimite(tx, pagosInsertados[0]!.pedidoId);
      }
      return { abonoRow: ab, pagosInsertados };
    });

    this.emitPagoRegistrado(actor.organizacionId, abonoRow, pagosInsertados);
    return this.resultadoDeAbono(abonoRow, false, pagosInsertados);
  }

  async confirmar(abonoId: string, actor: Actor): Promise<AbonoRegistroResultado> {
    if (!tienePermiso(actor.permisos, "cobranza.confirmar_transferencia")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const now = this.calendar.now();
    const fechaOp = fechaDeInstante(now);
    const { abonoRow, pagosInsertados } = await this.db.transaction(async (tx) => {
      const [abRow] = await tx
        .select()
        .from(abono)
        .where(eq(abono.id, abonoId))
        .limit(1)
        .for("update");
      if (!abRow) {
        throw new DomainException("NO_ENCONTRADO", "Abono no encontrado", 404);
      }
      const [cli] = await tx
        .select()
        .from(cliente)
        .where(
          and(
            eq(cliente.id, abRow.clienteId),
            eq(cliente.organizacionId, actor.organizacionId),
          ),
        )
        .limit(1);
      if (!cli) {
        throw new DomainException("NO_ENCONTRADO", "Abono no encontrado", 404);
      }
      if (abRow.estado !== "PENDIENTE") {
        throw new DomainException(
          "ABONO_NO_PENDIENTE",
          MENSAJE_ABONO_NO_PENDIENTE,
          409,
        );
      }

      await tx
        .update(abono)
        .set({
          estado: "CONFIRMADO",
          confirmadoPor: actor.usuarioId,
          confirmadoAt: now,
        })
        .where(eq(abono.id, abonoId));

      const confirmado = { ...abRow, estado: "CONFIRMADO" as const };
      const pagosInsertados = await this.aplicarEnTx(
        tx,
        confirmado,
        actor,
        abRow.fecha,
      );
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "cobranza.confirmar_transferencia",
          entidad: "abono",
          entidadId: abonoId,
          despues: { estado: "CONFIRMADO", pagos: pagosInsertados.length },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      if (pagosInsertados[0]) {
        await this.facturas.verificarLimite(tx, pagosInsertados[0]!.pedidoId);
      }
      return { abonoRow: confirmado, pagosInsertados };
    });

    this.bus.emit({
      organizacionId: actor.organizacionId,
      tipo: "abono.confirmado",
      fechaOperacion: fechaOp,
      clienteId: abonoRow.clienteId,
      abonoId: abonoRow.id,
    });
    this.emitPagoRegistrado(actor.organizacionId, abonoRow, pagosInsertados);
    return this.resultadoDeAbono(abonoRow, false, pagosInsertados);
  }

  async rechazar(
    abonoId: string,
    body: unknown,
    actor: Actor,
  ): Promise<AbonoPublico> {
    if (!tienePermiso(actor.permisos, "cobranza.confirmar_transferencia")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(rechazarAbonoRequestSchema, body);
    const now = this.calendar.now();
    const row = await this.db.transaction(async (tx) => {
      const [abRow] = await tx
        .select()
        .from(abono)
        .where(eq(abono.id, abonoId))
        .limit(1)
        .for("update");
      if (!abRow) {
        throw new DomainException("NO_ENCONTRADO", "Abono no encontrado", 404);
      }
      const [cli] = await tx
        .select({ nombre: cliente.nombre })
        .from(cliente)
        .where(
          and(
            eq(cliente.id, abRow.clienteId),
            eq(cliente.organizacionId, actor.organizacionId),
          ),
        )
        .limit(1);
      if (!cli) {
        throw new DomainException("NO_ENCONTRADO", "Abono no encontrado", 404);
      }
      if (abRow.estado !== "PENDIENTE") {
        throw new DomainException(
          "ABONO_NO_PENDIENTE",
          MENSAJE_ABONO_NO_PENDIENTE,
          409,
        );
      }
      const [updated] = await tx
        .update(abono)
        .set({
          estado: "RECHAZADO",
          anuladoAt: now,
          motivoRechazo: input.motivo,
          confirmadoPor: actor.usuarioId,
          confirmadoAt: now,
        })
        .where(eq(abono.id, abonoId))
        .returning();
      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "cobranza.rechazar_transferencia",
          entidad: "abono",
          entidadId: abonoId,
          despues: { estado: "RECHAZADO", motivo: input.motivo },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return { row: updated!, nombre: cli.nombre };
    });

    const fechaOp = fechaDeInstante(now);
    this.bus.emit({
      organizacionId: actor.organizacionId,
      tipo: "abono.rechazado",
      fechaOperacion: fechaOp,
      clienteId: row.row.clienteId,
      abonoId: row.row.id,
    });
    return presentarAbono(this.db, row.row, { clienteNombre: row.nombre });
  }

  async listar(actor: Actor, query: unknown): Promise<AbonoLista> {
    const q = parseBody(abonosQuerySchema, query ?? {});
    const limit = q.limit ?? 40;
    const offset = q.offset ?? 0;
    const condiciones = [eq(cliente.organizacionId, actor.organizacionId)];
    if (q.clienteId) condiciones.push(eq(abono.clienteId, q.clienteId));
    if (q.estado && q.estado !== "todas") {
      condiciones.push(eq(abono.estado, q.estado));
    }

    const where = and(...condiciones);
    const [totalRow] = await this.db
      .select({ n: count() })
      .from(abono)
      .innerJoin(cliente, eq(cliente.id, abono.clienteId))
      .where(where);
    const [pendRow] = await this.db
      .select({ n: count() })
      .from(abono)
      .innerJoin(cliente, eq(cliente.id, abono.clienteId))
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(abono.estado, "PENDIENTE"),
        ),
      );

    const filas = await this.db
      .select({ abono, clienteNombre: cliente.nombre })
      .from(abono)
      .innerJoin(cliente, eq(cliente.id, abono.clienteId))
      .where(where)
      .orderBy(desc(abono.createdAt))
      .limit(limit)
      .offset(offset);

    const items = await Promise.all(
      filas.map((f) =>
        presentarAbono(this.db, f.abono, { clienteNombre: f.clienteNombre }),
      ),
    );
    return abonoListaSchema.parse({
      items,
      total: Number(totalRow?.n ?? 0),
      pendientesCount: Number(pendRow?.n ?? 0),
      offset,
      limit,
      hasMore: offset + items.length < Number(totalRow?.n ?? 0),
    });
  }

  async contarPendientes(organizacionId: string): Promise<number> {
    const [row] = await this.db
      .select({ n: count() })
      .from(abono)
      .innerJoin(cliente, eq(cliente.id, abono.clienteId))
      .where(
        and(
          eq(cliente.organizacionId, organizacionId),
          eq(abono.estado, "PENDIENTE"),
        ),
      );
    return Number(row?.n ?? 0);
  }

  private async aplicarEnTx(
    tx: AppDatabase,
    abonoRow: typeof abono.$inferSelect,
    actor: Actor,
    fecha: string,
  ): Promise<Array<{ pago: typeof pago.$inferSelect; pedidoId: string }>> {
    // Bloquea las facturas del cliente antes de leer saldos. Una corrección de
    // precio (`ajustarEnTx`) bloquea la suya: así ninguna de las dos decide
    // con un saldo que la otra está cambiando, y la factura nunca queda con
    // más abonado que monto. También serializa dos abonos del mismo cliente.
    await tx
      .select({ id: factura.id })
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(
        and(
          eq(pedido.clienteId, abonoRow.clienteId),
          eq(pedido.organizacionId, actor.organizacionId),
        ),
      )
      .for("update", { of: factura });
    const destinos = await facturasPendientesDeCliente(
      tx,
      abonoRow.clienteId,
      actor.organizacionId,
    );
    const { asignaciones, sobra } = aplicarFifo(
      destinos.map((d) => ({ id: d.id, saldoCentavos: d.saldo })),
      abonoRow.montoCentavos,
    );
    if (sobra > 0 || asignaciones.length === 0) {
      throw new DomainException("PAGO_EXCEDE_SALDO", MENSAJE_PAGO_EXCEDE_SALDO, 409);
    }

    const filas: Array<{ pago: typeof pago.$inferSelect; pedidoId: string }> =
      [];
    for (let i = 0; i < asignaciones.length; i++) {
      const asg = asignaciones[i]!;
      const dest = destinos.find((d) => d.id === asg.facturaId)!;
      const [pagoRow] = await tx
        .insert(pago)
        .values({
          abonoId: abonoRow.id,
          facturaId: asg.facturaId,
          montoCentavos: asg.montoCentavos,
          metodo: abonoRow.metodo,
          fecha,
          comprobanteAssetId: abonoRow.comprobanteAssetId ?? null,
          registradoPor: actor.usuarioId,
          idempotencyKey: i === 0 ? abonoRow.idempotencyKey : null,
        })
        .returning();
      if (!pagoRow) {
        throw new DomainException("PAGO_NO_CREADO", "No se pudo registrar el cobro", 500);
      }
      filas.push({ pago: pagoRow, pedidoId: dest.pedidoId });
    }
    return filas;
  }

  private fechaPago(override: string | undefined, actor: Actor): string {
    if (
      override &&
      (actor.rol === "ADMIN_JEFE" || actor.rol === "ADMIN")
    ) {
      return override;
    }
    return fechaDeInstante(this.calendar.now());
  }

  private async porIdempotencia(id: string, key: string) {
    const [byKey] = await this.db
      .select()
      .from(abono)
      .where(eq(abono.idempotencyKey, key))
      .limit(1);
    if (byKey) return byKey;
    const [byId] = await this.db.select().from(abono).where(eq(abono.id, id)).limit(1);
    return byId ?? null;
  }

  private async exigirComprobanteAbono(
    tx: AppDatabase,
    assetId: string,
    abonoId: string,
  ): Promise<void> {
    const [row] = await tx
      .select()
      .from(asset)
      .where(eq(asset.id, assetId))
      .limit(1);
    if (!row || row.ownerType !== "abono" || row.ownerId !== abonoId) {
      throw new DomainException(
        "COMPROBANTE_REQUERIDO",
        MENSAJE_COMPROBANTE_REQUERIDO,
        400,
      );
    }
  }

  private emitPagoRegistrado(
    organizacionId: string,
    abonoRow: typeof abono.$inferSelect,
    pagosInsertados: Array<{ pago: typeof pago.$inferSelect; pedidoId: string }>,
  ): void {
    const primera = pagosInsertados[0];
    if (!primera) return;
    void this.db
      .select({ fechaOperacion: pedido.fechaOperacion, clienteId: pedido.clienteId })
      .from(factura)
      .innerJoin(pedido, eq(pedido.id, factura.pedidoId))
      .where(eq(factura.id, primera.pago.facturaId))
      .limit(1)
      .then(([ped]) => {
        this.bus.emit({
          organizacionId,
          tipo: "pago.registrado",
          fechaOperacion: ped?.fechaOperacion ?? abonoRow.fecha,
          facturaId: primera.pago.facturaId,
          clienteId: ped?.clienteId ?? abonoRow.clienteId,
        });
      });
  }

  private async resultadoDeAbono(
    abonoRow: typeof abono.$inferSelect,
    idempotente: boolean,
    pagosInsertados?: Array<{ pago: typeof pago.$inferSelect; pedidoId: string }>,
  ): Promise<AbonoRegistroResultado> {
    let filas = pagosInsertados;
    if (!filas?.length && abonoRow.estado === "CONFIRMADO") {
      const pagosRows = await this.db
        .select()
        .from(pago)
        .where(eq(pago.abonoId, abonoRow.id));
      filas = [];
      for (const pagoRow of pagosRows) {
        const [fac] = await this.db
          .select({ pedidoId: factura.pedidoId })
          .from(factura)
          .where(eq(factura.id, pagoRow.facturaId))
          .limit(1);
        if (fac) filas.push({ pago: pagoRow, pedidoId: fac.pedidoId });
      }
    }

    const ab = await presentarAbono(this.db, abonoRow);
    if (!filas?.length) {
      return abonoRegistroResultadoSchema.parse({ idempotente, abono: ab });
    }
    const facturaIds = [...new Set(filas.map((p) => p.pago.facturaId))];
    const facturas = [];
    for (const id of facturaIds) {
      const [fac] = await this.db.select().from(factura).where(eq(factura.id, id)).limit(1);
      if (fac) facturas.push(await presentarFactura(this.db, this.calendar, fac));
    }
    const registradoId = filas[0]?.pago.registradoPor;
    const [actorRow] = registradoId
      ? await this.db
          .select({ username: usuario.username })
          .from(usuario)
          .where(eq(usuario.id, registradoId))
          .limit(1)
      : [undefined];
    return abonoRegistroResultadoSchema.parse({
      idempotente,
      abono: ab,
      pagos: filas.map((p) => ({
        id: p.pago.id,
        facturaId: p.pago.facturaId,
        montoCentavos: p.pago.montoCentavos,
        metodo: p.pago.metodo,
        fecha: p.pago.fecha,
        registradoPor: p.pago.registradoPor,
        registradoPorNombre: actorRow?.username ?? null,
        comprobanteAssetId: abonoRow.comprobanteAssetId,
      })),
      facturas,
    });
  }
}
