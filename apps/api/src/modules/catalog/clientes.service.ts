import { randomBytes } from "node:crypto";
import { Inject, Injectable, Optional } from "@nestjs/common";
import { and, asc, eq } from "drizzle-orm";
import { cliente } from "@misupertostada/db";
import {
  clientePublicoSchema,
  crearClienteRequestSchema,
  editarClienteRequestSchema,
  type ClientePublico,
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
