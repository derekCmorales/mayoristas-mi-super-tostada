import { Inject, Injectable } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { clienteBono, producto } from "@misupertostada/db";
import {
  anularBonoRequestSchema,
  clienteBonoPublicoSchema,
  instanteAIso,
  otorgarBonoRequestSchema,
  type ClienteBonoPublico,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { PedidoEvents } from "../shared/panel-events";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { CLIENTE_PROPIETARIO, type ClientePropietario } from "./cliente-ports";

@Injectable()
export class ClienteBonoService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    @Inject(CLIENTE_PROPIETARIO) private readonly clientes: ClientePropietario,
    private readonly events: PedidoEvents,
  ) {}

  async listar(clienteId: string, actor: Actor): Promise<ClienteBonoPublico[]> {
    await this.clientes.owned(clienteId, actor.organizacionId);
    const rows = await this.db
      .select({
        bono: clienteBono,
        nombreCanonico: producto.nombreCanonico,
        unidadMedida: producto.unidadMedida,
      })
      .from(clienteBono)
      .innerJoin(producto, eq(producto.id, clienteBono.productoId))
      .where(
        and(
          eq(clienteBono.clienteId, clienteId),
          eq(clienteBono.organizacionId, actor.organizacionId),
        ),
      )
      .orderBy(asc(clienteBono.createdAt));

    return rows.map((row) =>
      clienteBonoPublicoSchema.parse({
        id: row.bono.id,
        productoId: row.bono.productoId,
        nombreCanonico: row.nombreCanonico,
        unidadMedida: row.unidadMedida,
        descripcion: row.bono.descripcion,
        cantidadOtorgada: row.bono.cantidadOtorgada,
        cantidadAplicada: row.bono.cantidadAplicada,
        cantidadDisponible:
          row.bono.cantidadOtorgada - row.bono.cantidadAplicada,
        otorgadoAt: instanteAIso(row.bono.createdAt),
        anuladoAt: row.bono.anuladoAt ? instanteAIso(row.bono.anuladoAt) : null,
        motivoAnulacion: row.bono.motivoAnulacion ?? null,
      }),
    );
  }

  async otorgar(
    clienteId: string,
    body: unknown,
    actor: Actor,
  ): Promise<ClienteBonoPublico> {
    const input = parseBody(otorgarBonoRequestSchema, body);
    await this.clientes.owned(clienteId, actor.organizacionId);

    const [prod] = await this.db
      .select()
      .from(producto)
      .where(
        and(
          eq(producto.id, input.productoId),
          eq(producto.organizacionId, actor.organizacionId),
          eq(producto.activo, true),
        ),
      )
      .limit(1);
    if (!prod) {
      throw new DomainException(
        "PRODUCTO_INACTIVO",
        "El producto no está activo o no existe",
        409,
      );
    }

    const [row] = await this.db
      .insert(clienteBono)
      .values({
        organizacionId: actor.organizacionId,
        clienteId,
        productoId: input.productoId,
        descripcion: input.descripcion,
        cantidadOtorgada: input.cantidad,
        cantidadAplicada: 0,
        otorgadoPor: actor.usuarioId,
      })
      .returning();

    if (!row) {
      throw new DomainException("VALIDACION", "No se pudo otorgar el bono", 500);
    }

    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "cliente_bono.otorgar",
      entidad: "cliente_bono",
      entidadId: row.id,
      antes: null,
      despues: {
        productoId: input.productoId,
        descripcion: input.descripcion,
        cantidadOtorgada: input.cantidad,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    this.events.emit({
      organizacionId: actor.organizacionId,
      tipo: "cliente.bono",
      clienteId,
    });

    const lista = await this.listar(clienteId, actor);
    const creado = lista.find((b) => b.id === row.id);
    if (!creado) {
      throw new DomainException("NO_ENCONTRADO", "No se pudo leer el bono", 500);
    }
    return creado;
  }

  async anular(
    clienteId: string,
    bonoId: string,
    body: unknown,
    actor: Actor,
  ): Promise<ClienteBonoPublico> {
    const input = parseBody(anularBonoRequestSchema, body);
    await this.clientes.owned(clienteId, actor.organizacionId);

    const [bono] = await this.db
      .select()
      .from(clienteBono)
      .where(
        and(
          eq(clienteBono.id, bonoId),
          eq(clienteBono.clienteId, clienteId),
          eq(clienteBono.organizacionId, actor.organizacionId),
        ),
      )
      .limit(1);

    if (!bono) {
      throw new DomainException("NO_ENCONTRADO", "Bono no encontrado", 404);
    }
    if (bono.anuladoAt) {
      throw new DomainException("BONO_ANULADO", "Ese bono ya está anulado", 409);
    }
    if (bono.cantidadAplicada > 0) {
      throw new DomainException(
        "BONO_PARCIALMENTE_APLICADO",
        "No se puede anular: el bono ya se usó en un pedido. El saldo restante queda congelado.",
        409,
      );
    }

    const anuladoAt = new Date();
    await this.db
      .update(clienteBono)
      .set({
        anuladoAt,
        motivoAnulacion: input.motivo,
      })
      .where(eq(clienteBono.id, bonoId));

    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "cliente_bono.anular",
      entidad: "cliente_bono",
      entidadId: bonoId,
      antes: { anuladoAt: null, motivoAnulacion: null },
      despues: {
        anuladoAt: instanteAIso(anuladoAt),
        motivoAnulacion: input.motivo,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });

    this.events.emit({
      organizacionId: actor.organizacionId,
      tipo: "cliente.bono",
      clienteId,
    });

    const lista = await this.listar(clienteId, actor);
    const actualizado = lista.find((b) => b.id === bonoId);
    if (!actualizado) {
      throw new DomainException("NO_ENCONTRADO", "No se pudo leer el bono", 500);
    }
    return actualizado;
  }
}
