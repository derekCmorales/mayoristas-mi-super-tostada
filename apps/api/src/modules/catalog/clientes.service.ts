import { randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  abono,
  cliente,
  clienteBono,
  clienteProducto,
  conversacion,
  mensaje,
  pedido,
} from "@misupertostada/db";
import {
  clientePublicoSchema,
  crearClienteRequestSchema,
  editarClienteRequestSchema,
  eliminarClienteRequestSchema,
  type ClientePublico,
  type EliminarClienteResponse,
} from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { esViolacionUnica, normalizarHorario } from "./catalog.util";
import { hashPortalToken } from "../shared/portal-token";
import { EncryptionService } from "../shared/crypto";
import type { ClienteCreador, ClientePropietario } from "./cliente-ports";

@Injectable()
export class ClientesService implements ClientePropietario, ClienteCreador {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly audit: AuditWriter,
    @Optional() private readonly crypto?: EncryptionService,
  ) {}

  async listar(actor: Actor): Promise<ClientePublico[]> {
    const rows = await this.db
      .select()
      .from(cliente)
      .where(eq(cliente.organizacionId, actor.organizacionId))
      .orderBy(asc(cliente.nombre));
    return rows.map(presentarCliente);
  }

  async obtener(id: string, actor: Actor): Promise<ClientePublico> {
    return presentarCliente(await this.owned(id, actor.organizacionId));
  }

  async crear(body: unknown, actor: Actor): Promise<ClientePublico> {
    const input = parseBody(crearClienteRequestSchema, body);
    try {
      const [row] = await this.db
        .insert(cliente)
        .values({
          organizacionId: actor.organizacionId,
          nombre: input.nombre,
          contacto: input.contacto ?? null,
          telefonoWa: input.telefonoWa ?? null,
          horarioEntregaFijo: input.horarioEntregaFijo ?? null,
          notasPermanentes: input.notasPermanentes ?? null,
          limiteFacturasPendientes: input.limiteFacturasPendientes ?? null,
          fotoAssetId: input.fotoAssetId ?? null,
          activo: true,
        })
        .returning();
      if (!row) {
        throw new DomainException("NOMBRE_EN_USO", "Ya existe un cliente con ese nombre", 409);
      }
      await this.audit.insert({
        actorTipo: "usuario",
        actorId: actor.usuarioId,
        accion: "clientes.crear",
        entidad: "cliente",
        entidadId: row.id,
        despues: presentarCliente(row),
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return presentarCliente(row);
    } catch (err) {
      if (esViolacionUnica(err)) {
        throw new DomainException("NOMBRE_EN_USO", "Ya existe un cliente con ese nombre", 409);
      }
      throw err;
    }
  }

  async editar(id: string, body: unknown, actor: Actor): Promise<ClientePublico> {
    const input = parseBody(editarClienteRequestSchema, body);
    const actual = await this.owned(id, actor.organizacionId);
    try {
      const [row] = await this.db
        .update(cliente)
        .set({
          nombre: input.nombre ?? actual.nombre,
          contacto: input.contacto === undefined ? actual.contacto : input.contacto,
          telefonoWa: input.telefonoWa === undefined ? actual.telefonoWa : input.telefonoWa,
          horarioEntregaFijo:
            input.horarioEntregaFijo === undefined
              ? actual.horarioEntregaFijo
              : input.horarioEntregaFijo,
          notasPermanentes:
            input.notasPermanentes === undefined
              ? actual.notasPermanentes
              : input.notasPermanentes,
          limiteFacturasPendientes:
            input.limiteFacturasPendientes === undefined
              ? actual.limiteFacturasPendientes
              : input.limiteFacturasPendientes,
          fotoAssetId:
            input.fotoAssetId === undefined ? actual.fotoAssetId : input.fotoAssetId,
        })
        .where(eq(cliente.id, id))
        .returning();
      if (!row) {
        throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
      }
      await this.audit.insert({
        actorTipo: "usuario",
        actorId: actor.usuarioId,
        accion: "clientes.editar",
        entidad: "cliente",
        entidadId: id,
        antes: presentarCliente(actual),
        despues: presentarCliente(row),
        ip: actor.ip,
        userAgent: actor.userAgent,
      });
      return presentarCliente(row);
    } catch (err) {
      if (esViolacionUnica(err)) {
        throw new DomainException("NOMBRE_EN_USO", "Ya existe un cliente con ese nombre", 409);
      }
      throw err;
    }
  }

  async desactivar(id: string, actor: Actor): Promise<ClientePublico> {
    return this.setActivo(id, false, actor, "clientes.desactivar");
  }

  async activar(id: string, actor: Actor): Promise<ClientePublico> {
    return this.setActivo(id, true, actor, "clientes.activar");
  }

  /**
   * Borrado permanente de un cliente. Es la única excepción a «nada se borra» (§2.4) y está
   * acotada a propósito:
   *
   * - Solo `ADMIN_JEFE`, por rol y no por permiso delegable: no se puede regalar esta llave.
   * - Exige escribir `ELIMINAR` (`eliminarClienteRequestSchema`); desactivar sigue siendo el
   *   camino normal y reversible.
   * - Solo procede si el cliente **no tiene historial de dinero**: ningún pedido (y por lo tanto
   *   ninguna factura ni pago) y ningún abono. Si lo tiene, borrar descuadraría cierres y cartera,
   *   así que se rechaza con `CLIENTE_CON_HISTORIAL` y se sugiere desactivar. Sirve para clientes
   *   creados por error, duplicados o de prueba.
   * - Arrastra lo que cuelga solo de él: precios y alias (`cliente_producto`), bonos sin usar y
   *   su conversación de WhatsApp con sus mensajes.
   * - `audit_log` guarda la ficha completa en `antes`: el cliente desaparece del panel, pero queda
   *   evidencia de quién lo borró, cuándo, por qué y cómo era.
   */
  async eliminar(
    id: string,
    body: unknown,
    actor: Actor,
  ): Promise<EliminarClienteResponse> {
    if (actor.rol !== "ADMIN_JEFE") {
      throw new DomainException(
        "PERMISO_DENEGADO",
        "Solo el administrador jefe puede eliminar clientes",
        403,
      );
    }
    const input = parseBody(eliminarClienteRequestSchema, body);

    return this.db.transaction(async (tx) => {
      // Bloquea la fila: un pedido capturado en paralelo no puede quedar huérfano.
      const [actual] = await tx
        .select()
        .from(cliente)
        .where(
          and(eq(cliente.id, id), eq(cliente.organizacionId, actor.organizacionId)),
        )
        .for("update")
        .limit(1);
      if (!actual) {
        throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
      }

      const [conPedido] = await tx
        .select({ id: pedido.id })
        .from(pedido)
        .where(eq(pedido.clienteId, id))
        .limit(1);
      const [conAbono] = await tx
        .select({ id: abono.id })
        .from(abono)
        .where(eq(abono.clienteId, id))
        .limit(1);
      if (conPedido || conAbono) {
        throw new DomainException(
          "CLIENTE_CON_HISTORIAL",
          "Este cliente tiene pedidos o pagos registrados. Para no descuadrar cierres ni cartera no se puede eliminar; desactívelo.",
          409,
        );
      }

      const convs = await tx
        .select({ id: conversacion.id })
        .from(conversacion)
        .where(eq(conversacion.clienteId, id));
      const convIds = convs.map((c) => c.id);
      let mensajesBorrados = 0;
      if (convIds.length > 0) {
        const borrados = await tx
          .delete(mensaje)
          .where(inArray(mensaje.conversacionId, convIds))
          .returning({ id: mensaje.id });
        mensajesBorrados = borrados.length;
        await tx.delete(conversacion).where(inArray(conversacion.id, convIds));
      }
      const productos = await tx
        .delete(clienteProducto)
        .where(eq(clienteProducto.clienteId, id))
        .returning({ id: clienteProducto.productoId });
      const bonos = await tx
        .delete(clienteBono)
        .where(eq(clienteBono.clienteId, id))
        .returning({ id: clienteBono.id });
      await tx.delete(cliente).where(eq(cliente.id, id));

      await this.audit.insert(
        {
          actorTipo: "usuario",
          actorId: actor.usuarioId,
          accion: "clientes.eliminar",
          entidad: "cliente",
          entidadId: id,
          antes: presentarCliente(actual),
          despues: {
            eliminado: true,
            motivo: input.motivo ?? null,
            productosBorrados: productos.length,
            bonosBorrados: bonos.length,
            mensajesBorrados,
          },
          ip: actor.ip,
          userAgent: actor.userAgent,
        },
        tx,
      );
      return { id, eliminado: true as const };
    });
  }

  async rotarTokenPortal(
    id: string,
    actor: Actor,
  ): Promise<{ token: string }> {
    const actual = await this.owned(id, actor.organizacionId);
    const token = randomBytes(32).toString("base64url");
    const cifrado = this.crypto?.encrypt(token) ?? null;
    const [row] = await this.db
      .update(cliente)
      .set({
        tokenPortalHash: hashPortalToken(token),
        tokenPortalCifrado: cifrado,
      })
      .where(eq(cliente.id, id))
      .returning();
    if (!row) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "clientes.rotar_token",
      entidad: "cliente",
      entidadId: id,
      antes: { tieneTokenPortal: Boolean(actual.tokenPortalHash) },
      despues: { tieneTokenPortal: true },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return { token };
  }

  private async setActivo(
    id: string,
    activo: boolean,
    actor: Actor,
    accion: string,
  ): Promise<ClientePublico> {
    const actual = await this.owned(id, actor.organizacionId);
    const [row] = await this.db
      .update(cliente)
      .set({ activo })
      .where(eq(cliente.id, id))
      .returning();
    if (!row) {
      throw new DomainException("NO_ENCONTRADO", "Cliente no encontrado", 404);
    }
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion,
      entidad: "cliente",
      entidadId: id,
      antes: { activo: actual.activo },
      despues: { activo },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return presentarCliente(row);
  }

  async owned(id: string, organizacionId: string) {
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
}

function presentarCliente(row: typeof cliente.$inferSelect): ClientePublico {
  return clientePublicoSchema.parse({
    id: row.id,
    nombre: row.nombre,
    contacto: row.contacto ?? null,
    telefonoWa: row.telefonoWa ?? null,
    horarioEntregaFijo: normalizarHorario(row.horarioEntregaFijo),
    notasPermanentes: row.notasPermanentes ?? null,
    limiteFacturasPendientes: row.limiteFacturasPendientes ?? null,
    fotoAssetId: row.fotoAssetId ?? null,
    tieneTokenPortal: Boolean(row.tokenPortalHash),
    activo: row.activo,
  });
}
