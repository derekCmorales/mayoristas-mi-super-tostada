import { Inject, Injectable } from "@nestjs/common";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  cliente,
  diaOperacion,
  hojaProduccion,
  organizacion,
  outbox,
  pedido,
  pedidoItem,
  producto,
} from "@misupertostada/db";
import {
  MENSAJE_DIA_CERRADO,
  MENSAJE_DIA_NO_CERRADO,
  MENSAJE_HOJA_NO_MATERIALIZADA,
  TIPO_EVENTO_VENTANA_CERRADA,
  cerrarDiaRequestSchema,
  cierreResultadoSchema,
  fechaDeInstante,
  operacionResumenSchema,
  reabrirDiaRequestSchema,
  reaperturaResultadoSchema,
  tienePermiso,
  type CierreResultado,
  type OperacionResumen,
  type ReaperturaResultado,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { OutboxWriter } from "../shared/outbox.writer";
import { DomainEventWriter } from "../shared/domain-event.writer";
import { BusinessCalendarService } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import { bloquearDiaOperacion, leerEstadoDia } from "../shared/dia-operacion";
import { PedidoEvents } from "../shared/panel-events";
import type { Actor } from "../identity/actor";
import { HojaService } from "./hoja.service";

@Injectable()
export class CierreService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    private readonly outbox: OutboxWriter,
    private readonly events: DomainEventWriter,
    private readonly calendar: BusinessCalendarService,
    private readonly hoja: HojaService,
    private readonly bus: PedidoEvents,
  ) {}

  async resumen(
    actor: Actor,
    fechaOperacion?: string,
  ): Promise<OperacionResumen> {
    const fecha = fechaOperacion ?? (await this.fechaDefault(actor.organizacionId));
    const cal = await this.calendar.load(actor.organizacionId);
    const { diaEstado, versionHoja, motivoReapertura } = await leerEstadoDia(
      this.db,
      actor.organizacionId,
      fecha,
    );

    const pedidos = await this.db
      .select({
        origen: pedido.origen,
        estado: pedido.estado,
        clienteId: pedido.clienteId,
      })
      .from(pedido)
      .where(
        and(
          eq(pedido.organizacionId, actor.organizacionId),
          eq(pedido.fechaOperacion, fecha),
        ),
      );

    const vivos = pedidos.filter((p) => p.estado !== "ANULADO");
    const pedidosPortal = vivos.filter((p) => p.origen === "PORTAL").length;
    const pedidosManual = vivos.filter((p) => p.origen === "MANUAL").length;
    const confirmados = vivos.filter(
      (p) => p.estado === "CONFIRMADO" || p.estado === "EN_PRODUCCION",
    ).length;
    const borradores = vivos.filter((p) => p.estado === "BORRADOR").length;
    const ruta = {
      confirmados: vivos.filter((p) => p.estado === "CONFIRMADO").length,
      enProduccion: vivos.filter((p) => p.estado === "EN_PRODUCCION").length,
      entregados: vivos.filter((p) => p.estado === "ENTREGADO").length,
      anulados: pedidos.filter((p) => p.estado === "ANULADO").length,
    };

    const [libras] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${pedidoItem.cantidadPedida}), 0)`,
      })
      .from(pedidoItem)
      .innerJoin(pedido, eq(pedido.id, pedidoItem.pedidoId))
      .innerJoin(producto, eq(producto.id, pedidoItem.productoId))
      .where(
        and(
          eq(pedido.organizacionId, actor.organizacionId),
          eq(pedido.fechaOperacion, fecha),
          isNull(pedido.anuladoAt),
          sql`${pedido.estado} <> 'ANULADO'`,
          eq(producto.familia, "TORTILLA"),
          eq(producto.unidadMedida, "LIBRA"),
        ),
      );

    const [monto] = await this.db
      .select({
        total: sql<number>`coalesce(sum(${pedidoItem.cantidadPedida} * ${pedidoItem.precioUnitarioCentavos}), 0)::int`,
      })
      .from(pedidoItem)
      .innerJoin(pedido, eq(pedido.id, pedidoItem.pedidoId))
      .where(
        and(
          eq(pedido.organizacionId, actor.organizacionId),
          eq(pedido.fechaOperacion, fecha),
          isNull(pedido.anuladoAt),
          sql`${pedido.estado} <> 'ANULADO'`,
        ),
      );

    const activos = await this.db
      .select({ clienteId: cliente.id, nombre: cliente.nombre })
      .from(cliente)
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(cliente.activo, true),
        ),
      );
    const conPedido = new Set(vivos.map((p) => p.clienteId));
    const clientesSinPedido = activos
      .filter((c) => !conPedido.has(c.clienteId))
      .map((c) => ({ clienteId: c.clienteId, nombre: c.nombre }));

    const destinos = await this.destinatariosOutbox(actor.organizacionId);
    const outboxRows =
      destinos.length === 0
        ? []
        : await this.db
            .select({ estado: outbox.estado })
            .from(outbox)
            .where(
              and(
                eq(outbox.fechaOperacion, fecha),
                inArray(outbox.destinatarioId, destinos),
              ),
            );

    return operacionResumenSchema.parse({
      fechaOperacion: fecha,
      fechaEntrega: cal.getFechaEntrega(fecha),
      diaEstado,
      versionHoja,
      pedidosPortal,
      pedidosManual,
      librasTortilla: Number(libras?.total ?? 0),
      montoPedidosCentavos: Number(monto?.total ?? 0),
      ruta,
      clientesSinPedido,
      outboxPendientes: outboxRows.filter((r) => r.estado === "PENDIENTE").length,
      outboxEnviados: outboxRows.filter((r) => r.estado === "ENVIADO").length,
      outboxError: outboxRows.filter((r) => r.estado === "ERROR").length,
      previewCierre: {
        confirmados,
        borradores,
        // El cierre ya no manda WhatsApp: la hoja se lee en el panel.
        mensajesAEncolar: 0,
      },
      motivoReapertura,
    });
  }

  async cerrar(body: unknown, actor: Actor): Promise<CierreResultado> {
    if (!tienePermiso(actor.permisos, "ventana.cerrar")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(cerrarDiaRequestSchema, body ?? {});
    const fecha =
      input.fechaOperacion ?? (await this.fechaCierre(actor.organizacionId));
    return this.ejecutarCierre({
      organizacionId: actor.organizacionId,
      fechaOperacion: fecha,
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      ip: actor.ip,
      userAgent: actor.userAgent,
      skipIfReabierto: false,
    });
  }

  async reabrir(body: unknown, actor: Actor): Promise<ReaperturaResultado> {
    if (!tienePermiso(actor.permisos, "ventana.reabrir")) {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "No tiene permiso para esta acción",
        403,
      );
    }
    const input = parseBody(reabrirDiaRequestSchema, body);
    const fecha =
      input.fechaOperacion ?? (await this.fechaCierre(actor.organizacionId));

    await this.db.transaction(async (tx) => {
      await bloquearDiaOperacion(tx, actor.organizacionId, fecha);
      const [dia] = await tx
        .select()
        .from(diaOperacion)
        .where(
          and(
            eq(diaOperacion.organizacionId, actor.organizacionId),
            eq(diaOperacion.fechaOperacion, fecha),
          ),
        )
        .limit(1)
        .for("update");

      if (!dia || dia.estado !== "CERRADO") {
        throw new DomainException(
          "DIA_NO_CERRADO",
          MENSAJE_DIA_NO_CERRADO,
          409,
        );
      }

      const now = this.calendar.now();
      await tx
        .update(diaOperacion)
        .set({
          estado: "REABIERTO",
          motivoReapertura: input.motivo,
          reabiertoAt: now,
          reabiertoPor: actor.usuarioId,
        })
        .where(eq(diaOperacion.id, dia.id));

      await tx
        .update(pedido)
        .set({ estado: "CONFIRMADO" })
        .where(
          and(
            eq(pedido.organizacionId, actor.organizacionId),
            eq(pedido.fechaOperacion, fecha),
            eq(pedido.estado, "EN_PRODUCCION"),
          ),
        );

      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "ventana.reabrir",
          entidad: "dia_operacion",
          entidadId: dia.id,
          antes: { estado: "CERRADO" },
          despues: { estado: "REABIERTO", motivo: input.motivo, fechaOperacion: fecha },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
    });

    this.bus.emit({
      organizacionId: actor.organizacionId,
      tipo: "dia.reabierto",
      fechaOperacion: fecha,
    });

    return reaperturaResultadoSchema.parse({
      fechaOperacion: fecha,
      diaEstado: "REABIERTO",
      motivo: input.motivo,
    });
  }

  /**
   * Barrido de cierres. Cierra **toda** operación cuya ventana ya venció y
   * sigue sin cerrar, no solo la más reciente.
   *
   * Antes cerraba únicamente `getFechaOperacionDeVentanaReciente(now)`: si el
   * proceso no estaba vivo en el minuto del cierre —deploy, reinicio, laptop
   * apagada— esa operación quedaba abierta para siempre, sin hoja y con los
   * pedidos en CONFIRMADO, y nadie la volvía a mirar. Producción y reparto
   * salían en blanco el día del reparto sin explicar por qué.
   *
   * El calendario se resuelve **por organización**: cada una tiene su horario
   * en `ventana_semanal`, así que ni la ventana abierta de una frena el cierre
   * de las demás ni su fecha de operación sirve para las otras. Los candidatos
   * con pedidos salen de una sola consulta, no de recorrer cada organización.
   */
  async cerrarSiToca(organizacionId?: string): Promise<void> {
    const now = this.calendar.now();
    const pendientes = await this.operacionesPendientes(now, organizacionId);

    for (const [orgId, fechas] of pendientes) {
      const cal = await this.calendar.load(orgId);
      for (const fecha of fechas) {
        const fin = cal.getFinVentanaDeOperacion(fecha);
        // Sin ventana ese día no hay nada que cerrar; con la ventana todavía
        // corriendo se sigue capturando — salvo un día ya CERRADO con
        // CONFIRMADO huérfanos (portal o manual tras cierre anticipado / seed).
        if (!fin || now < fin) {
          const { diaEstado } = await leerEstadoDia(this.db, orgId, fecha);
          if (diaEstado !== "CERRADO") continue;
        }
        await this.ejecutarCierre({
          organizacionId: orgId,
          fechaOperacion: fecha,
          actorTipo: "sistema",
          actorId: "cron",
          skipIfReabierto: true,
        });
      }
    }
  }

  /**
   * `(organización → fechas de operación)` que el barrido debe evaluar:
   *
   * - la ventana que acaba de cerrar, aunque no tenga pedidos (mantiene el día
   *   marcado CERRADO y la hoja materializada, aunque salga vacía),
   * - toda operación pasada con pedidos vivos cuyo día no está CERRADO: el
   *   atrasado que el barrido viejo no recuperaba nunca,
   * - todo `dia_operacion` pasado que no esté CERRADO, tenga pedidos o no: es
   *   lo que devuelve al redil un día REABIERTO y olvidado, y
   * - todo día ya CERRADO con pedidos CONFIRMADO vivos: captura tardía del
   *   portal o del panel después de un cierre anticipado (o del seed, que
   *   cierra «hoy» para armar la ruta y deja la ventana viva). Sin esto esos
   *   pedidos se quedan fuera de producción y de la ruta para siempre.
   *
   * Que un día REABIERTO entre en la lista no significa que se cierre ya:
   * `ejecutarCierre` respeta la reapertura hasta que vence.
   */
  private async operacionesPendientes(
    now: Date,
    organizacionId?: string,
  ): Promise<Map<string, string[]>> {
    const hoy = fechaDeInstante(now);

    const conPedidos = await this.db
      .selectDistinct({
        organizacionId: pedido.organizacionId,
        fechaOperacion: pedido.fechaOperacion,
      })
      .from(pedido)
      .leftJoin(
        diaOperacion,
        and(
          eq(diaOperacion.organizacionId, pedido.organizacionId),
          eq(diaOperacion.fechaOperacion, pedido.fechaOperacion),
        ),
      )
      .where(
        and(
          organizacionId
            ? eq(pedido.organizacionId, organizacionId)
            : undefined,
          sql`${pedido.estado} <> 'ANULADO'`,
          sql`${pedido.fechaOperacion} <= ${hoy}`,
          sql`(${diaOperacion.estado} is null or ${diaOperacion.estado} <> 'CERRADO')`,
        ),
      );

    const diasAbiertos = await this.db
      .select({
        organizacionId: diaOperacion.organizacionId,
        fechaOperacion: diaOperacion.fechaOperacion,
      })
      .from(diaOperacion)
      .where(
        and(
          organizacionId
            ? eq(diaOperacion.organizacionId, organizacionId)
            : undefined,
          sql`${diaOperacion.estado} <> 'CERRADO'`,
          sql`${diaOperacion.fechaOperacion} <= ${hoy}`,
        ),
      );

    const porOrg = new Map<string, Set<string>>();
    const tardios = await this.db
      .selectDistinct({
        organizacionId: pedido.organizacionId,
        fechaOperacion: pedido.fechaOperacion,
      })
      .from(pedido)
      .innerJoin(
        diaOperacion,
        and(
          eq(diaOperacion.organizacionId, pedido.organizacionId),
          eq(diaOperacion.fechaOperacion, pedido.fechaOperacion),
        ),
      )
      .where(
        and(
          organizacionId
            ? eq(pedido.organizacionId, organizacionId)
            : undefined,
          eq(pedido.estado, "CONFIRMADO"),
          isNull(pedido.anuladoAt),
          eq(diaOperacion.estado, "CERRADO"),
        ),
      );

    for (const fila of [...conPedidos, ...diasAbiertos, ...tardios]) {
      const set = porOrg.get(fila.organizacionId) ?? new Set<string>();
      set.add(fila.fechaOperacion);
      porOrg.set(fila.organizacionId, set);
    }

    // La ventana recién cerrada de cada organización activa, tenga pedidos o
    // no: es el caso normal del cron y no debe depender de que haya pedidos.
    const orgs = organizacionId
      ? [{ id: organizacionId }]
      : await this.db
          .select({ id: organizacion.id })
          .from(organizacion)
          .where(eq(organizacion.activo, true));

    for (const org of orgs) {
      const cal = await this.calendar.load(org.id);
      if (cal.isVentanaAbierta(now)) continue;
      const reciente = cal.getFechaOperacionDeVentanaReciente(now);
      const set = porOrg.get(org.id) ?? new Set<string>();
      set.add(reciente);
      porOrg.set(org.id, set);
    }

    return new Map(
      [...porOrg].map(([orgId, fechas]) => [orgId, [...fechas].sort()]),
    );
  }

  /**
   * Operación sobre la que actúan «cerrar día» y «reabrir día» sin fecha
   * explícita: la ventana que se está capturando, o la que acaba de cerrar.
   * No es `fechaDefault`: cerrar el día opera sobre la captura, mientras que
   * `/hoy` mira el reparto.
   */
  private async fechaCierre(organizacionId: string): Promise<string> {
    const cal = await this.calendar.load(organizacionId);
    const now = this.calendar.now();
    return cal.isVentanaAbierta(now)
      ? cal.getFechaOperacion(now)
      : cal.getFechaOperacionDeVentanaReciente(now);
  }

  /**
   * Operación que `/hoy` y `/produccion` muestran sin filtro explícito: la
   * que tiene trabajo activo. Con la ventana cerrada eso es el reparto en
   * curso, no la ventana que abre esta tarde — que es lo que hacía que a las
   * 08:00 la pantalla abriera en una operación todavía vacía.
   */
  private async fechaDefault(organizacionId: string): Promise<string> {
    const ejes = await this.calendar.ejes(organizacionId);
    return ejes.fechaFoco;
  }

  private async destinatariosOutbox(organizacionId: string): Promise<string[]> {
    const clientes = await this.db
      .select({ id: cliente.id })
      .from(cliente)
      .where(eq(cliente.organizacionId, organizacionId));
    return [organizacionId, ...clientes.map((c) => c.id)];
  }

  private async ejecutarCierre(opts: {
    organizacionId: string;
    fechaOperacion: string;
    actorTipo: "usuario" | "sistema";
    actorId: string;
    ip?: string | null;
    userAgent?: string | null;
    skipIfReabierto: boolean;
  }): Promise<CierreResultado> {
    const cal = await this.calendar.load(opts.organizacionId);
    let version = 1;
    let idempotente = false;
    let absorbiendoTardios = false;

    await this.db.transaction(async (tx) => {
      await bloquearDiaOperacion(tx, opts.organizacionId, opts.fechaOperacion);
      const [dia] = await tx
        .select()
        .from(diaOperacion)
        .where(
          and(
            eq(diaOperacion.organizacionId, opts.organizacionId),
            eq(diaOperacion.fechaOperacion, opts.fechaOperacion),
          ),
        )
        .limit(1)
        .for("update");

      if (dia?.estado === "CERRADO") {
        const [huerfano] = await tx
          .select({ id: pedido.id })
          .from(pedido)
          .where(
            and(
              eq(pedido.organizacionId, opts.organizacionId),
              eq(pedido.fechaOperacion, opts.fechaOperacion),
              eq(pedido.estado, "CONFIRMADO"),
              isNull(pedido.anuladoAt),
            ),
          )
          .limit(1);
        if (!huerfano) {
          const [hoja] = await tx
            .select({ version: hojaProduccion.version })
            .from(hojaProduccion)
            .where(
              and(
                eq(hojaProduccion.organizacionId, opts.organizacionId),
                eq(hojaProduccion.fechaOperacion, opts.fechaOperacion),
              ),
            )
            .orderBy(sql`${hojaProduccion.version} desc`)
            .limit(1);
          version = hoja?.version ?? 1;
          idempotente = true;
          return;
        }
        // Día cerrado con CONFIRMADO que llegaron después (ventana viva o
        // seed). Se rematerializa vN+1 y se promocionan; el unique del outbox
        // no deja un segundo VentanaPedidoCerrada para el mismo día.
        absorbiendoTardios = true;
      }

      // Un día reabierto no se cierra por debajo mientras alguien lo esté
      // corrigiendo: el cron espera a que venza la reapertura (el cierre de su
      // propia ventana, con un piso de gracia). Pasado eso sí lo cierra, porque
      // si no se queda sin hoja y con los pedidos en CONFIRMADO para siempre
      // —que es como la operación del 22 de agosto de 2026 llegó a su día de
      // reparto con producción y reparto en blanco—.
      if (dia?.estado === "REABIERTO" && opts.skipIfReabierto) {
        // Sin `reabierto_at` no hay desde cuándo contar la gracia: no se cierra
        // sola y manda el panel, que la rotula.
        const limite = dia.reabiertoAt
          ? cal.getLimiteDeReapertura(opts.fechaOperacion, dia.reabiertoAt)
          : null;
        if (!limite || this.calendar.now() < limite) {
          idempotente = true;
          version = 1;
          return;
        }
      }

      const [ultima] = await tx
        .select({ version: hojaProduccion.version })
        .from(hojaProduccion)
        .where(
          and(
            eq(hojaProduccion.organizacionId, opts.organizacionId),
            eq(hojaProduccion.fechaOperacion, opts.fechaOperacion),
          ),
        )
        .orderBy(sql`${hojaProduccion.version} desc`)
        .limit(1);
      version = (ultima?.version ?? 0) + 1;

      const generadoPor =
        opts.actorTipo === "usuario" ? opts.actorId : null;
      await this.hoja.materializar(
        opts.organizacionId,
        opts.fechaOperacion,
        version,
        generadoPor,
        cal,
        tx,
      );

      await tx
        .update(pedido)
        .set({ estado: "EN_PRODUCCION" })
        .where(
          and(
            eq(pedido.organizacionId, opts.organizacionId),
            eq(pedido.fechaOperacion, opts.fechaOperacion),
            eq(pedido.estado, "CONFIRMADO"),
          ),
        );

      const now = this.calendar.now();
      if (!absorbiendoTardios) {
        if (!dia) {
          await tx.insert(diaOperacion).values({
            organizacionId: opts.organizacionId,
            fechaOperacion: opts.fechaOperacion,
            estado: "CERRADO",
            cerradoAt: now,
            cerradoPor: generadoPor,
          });
        } else {
          await tx
            .update(diaOperacion)
            .set({
              estado: "CERRADO",
              cerradoAt: now,
              cerradoPor: generadoPor,
            })
            .where(eq(diaOperacion.id, dia.id));
        }

        await this.events.insert(
          TIPO_EVENTO_VENTANA_CERRADA,
          {
            organizacionId: opts.organizacionId,
            fechaOperacion: opts.fechaOperacion,
            version,
          },
          tx,
        );

        await this.outbox.insert(
          {
            tipo: TIPO_EVENTO_VENTANA_CERRADA,
            destinatarioId: opts.organizacionId,
            fechaOperacion: opts.fechaOperacion,
            payload: {
              organizacionId: opts.organizacionId,
              fechaOperacion: opts.fechaOperacion,
              version,
            },
          },
          tx,
        );
      }

      await this.audit.insert(
        {
          actorTipo: opts.actorTipo,
          actorId: opts.actorId,
          accion: "ventana.cerrar",
          entidad: "dia_operacion",
          entidadId: `${opts.organizacionId}:${opts.fechaOperacion}`,
          antes: { estado: dia?.estado ?? "SIN_CIERRE" },
          despues: {
            estado: "CERRADO",
            version,
            fechaOperacion: opts.fechaOperacion,
            tardios: absorbiendoTardios || undefined,
          },
          ip: opts.ip,
          userAgent: opts.userAgent,
        },
        tx,
      );
    });

    if (!idempotente) {
      this.bus.emit({
        organizacionId: opts.organizacionId,
        tipo: "dia.cerrado",
        fechaOperacion: opts.fechaOperacion,
        versionHoja: version,
      });
      this.bus.emit({
        organizacionId: opts.organizacionId,
        tipo: "hoja.generada",
        fechaOperacion: opts.fechaOperacion,
        versionHoja: version,
      });
    }

    return cierreResultadoSchema.parse({
      fechaOperacion: opts.fechaOperacion,
      version,
      idempotente,
      diaEstado: "CERRADO",
    });
  }
}

export function diaCerrado(): DomainException {
  return new DomainException("DIA_CERRADO", MENSAJE_DIA_CERRADO, 409);
}

export function hojaNoMaterializada(): DomainException {
  return new DomainException(
    "HOJA_NO_MATERIALIZADA",
    MENSAJE_HOJA_NO_MATERIALIZADA,
    404,
  );
}
