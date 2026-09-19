import type { ImportTipo } from "@misupertostada/shared";
import type { Actor } from "../identity/actor";

export interface ImportHandler {
  readonly tipo: ImportTipo;

  procesarFila(
    row: Record<string, string>,
    actor: Actor,
    aplicar: boolean,
    vistos: Set<string>,
  ): Promise<void>;
}