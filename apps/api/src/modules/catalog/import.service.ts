import { Inject, Injectable } from "@nestjs/common";
import {
  PLANTILLAS_CSV,
  importarCsvRequestSchema,
  parseCsv,
  type ImportReporte,
  type ImportTipo,
} from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import { parseBody } from "../shared/zod-body";
import type { Actor } from "../identity/actor";
import { IMPORT_HANDLERS } from "./import-tokens";
import type { ImportHandler } from "./import-handlers";

@Injectable()
export class ImportService {
  constructor(
    private readonly audit: AuditWriter,
    @Inject(IMPORT_HANDLERS)
    private readonly handlers: ReadonlyArray<ImportHandler>,
  ) {}

  plantilla(tipo: string): { filename: string; csv: string } {
    const clave = tipo.replace(/\.csv$/i, "") as ImportTipo;
    const csv = PLANTILLAS_CSV[clave];
    if (!csv) {
      throw new DomainException("VALIDACION", "Plantilla desconocida", 400);
    }
    return { filename: `${clave}.csv`, csv };
  }

  async preview(body: unknown, actor: Actor): Promise<ImportReporte> {
    return this.ejecutar(body, actor, false);
  }

  async confirmar(body: unknown, actor: Actor): Promise<ImportReporte> {
    const reporte = await this.ejecutar(body, actor, true);
    await this.audit.insert({
      actorTipo: "usuario",
      actorId: actor.usuarioId,
      accion: "catalogo.importar",
      entidad: "organizacion",
      entidadId: actor.organizacionId,
      despues: {
        tipo: reporte.tipo,
        aplicadas: reporte.aplicadas,
        invalidas: reporte.invalidas,
      },
      ip: actor.ip,
      userAgent: actor.userAgent,
    });
    return reporte;
  }

  private async ejecutar(
    body: unknown,
    actor: Actor,
    aplicar: boolean,
  ): Promise<ImportReporte> {
    const input = parseBody(importarCsvRequestSchema, body);
    const handler = this.handlerPara(input.tipo);
    const { rows } = parseCsv(input.csv);
    const filas: ImportReporte["filas"] = [];
    const vistos = new Set<string>();
    let aplicadas = 0;

    for (let i = 0; i < rows.length; i++) {
      const indice = i + 2;
      try {
        await handler.procesarFila(rows[i]!, actor, aplicar, vistos);
        filas.push({ indice, ok: true });
        if (aplicar) aplicadas += 1;
      } catch (err) {
        filas.push({
          indice,
          ok: false,
          error: mensajeFila(err),
        });
      }
    }

    const validas = filas.filter((f) => f.ok).length;
    const invalidas = filas.filter((f) => !f.ok).length;
    return {
      tipo: input.tipo,
      filas,
      validas,
      invalidas,
      aplicadas: aplicar ? aplicadas : 0,
    };
  }

  private handlerPara(tipo: ImportTipo): ImportHandler {
    const handler = this.handlers.find((candidato) => candidato.tipo === tipo);
    if (!handler) {
      throw new DomainException(
        "VALIDACION",
        `No existe un procesador para la importación ${tipo}`,
        400,
      );
    }
    return handler;
  }
}

function mensajeFila(err: unknown): string {
  if (err instanceof DomainException) return err.message;
  if (err instanceof Error) return err.message;
  return "Fila inválida";
}
