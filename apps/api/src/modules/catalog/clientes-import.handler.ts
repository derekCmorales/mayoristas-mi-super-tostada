import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { cliente } from "@misupertostada/db";
import { crearClienteRequestSchema } from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import type { Actor } from "../identity/actor";
import type { ImportHandler } from "./import-handlers";
import { CLIENTE_CREADOR, type ClienteCreador } from "./cliente-ports";
import { col, parseEnteroOpcional, vacioANull } from "./import-csv.utils";

@Injectable()
export class ClientesImportHandler implements ImportHandler {
  readonly tipo = "clientes" as const;

  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    @Inject(CLIENTE_CREADOR) private readonly clientes: ClienteCreador,
  ) {}

  async procesarFila(
    row: Record<string, string>,
    actor: Actor,
    aplicar: boolean,
    vistos: Set<string>,
  ): Promise<void> {
    const nombre = col(row, "nombre");
    const clave = nombre.toLowerCase();
    if (vistos.has(clave)) throw new Error("Nombre duplicado en el archivo");
    const parsed = crearClienteRequestSchema.parse({
      nombre,
      contacto: vacioANull(row.contacto ?? ""),
      telefonoWa: vacioANull(row.telefono_wa ?? ""),
      horarioEntregaFijo: vacioANull(row.horario_entrega_fijo ?? ""),
      notasPermanentes: vacioANull(row.notas_permanentes ?? ""),
      limiteFacturasPendientes: parseEnteroOpcional(
        row.limite_facturas_pendientes ?? "",
      ),
    });
    const [existe] = await this.db
      .select({ id: cliente.id })
      .from(cliente)
      .where(
        and(
          eq(cliente.organizacionId, actor.organizacionId),
          eq(cliente.nombre, parsed.nombre),
        ),
      )
      .limit(1);
    if (existe) throw new Error("Ya existe un cliente con ese nombre");
    vistos.add(clave);
    if (aplicar) await this.clientes.crear(parsed, actor);
  }
}
