import { describe, expect, test } from "bun:test";
import {
  ASSET_MAX_BYTES,
  encolar,
  type AccionCola,
  type FilaCola,
  type RutaReparto,
} from "@misupertostada/shared";
import {
  MemoryColaStore,
  filasColaDesdeStorage,
  rutaDesdeStorage,
  type ColaStore,
} from "./offline-idb";
import { drenarCola, type SyncPorts } from "./offline-sync";

const PEDIDO = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PRODUCTO = "dddddddd-dddd-dddd-dddd-dddddddddddd";
const KEY_E = "entrega-tony-tabasco";

function iso(n: number): string {
  return `2026-08-20T18:00:${String(n).padStart(2, "0")}.000Z`;
}

function entrega(): AccionCola {
  return {
    tipo: "ENTREGA",
    idempotencyKey: KEY_E,
    pedidoId: PEDIDO,
    items: [{ productoId: PRODUCTO, cantidadEntregada: 50 }],
  };
}

function filaValida(): FilaCola {
  return encolar([], entrega(), iso(1))[0]!;
}

/**
 * Misma forma que IndexedDB: puede devolver basura. El cliente
 * (`drenarCola`) solo habla con `ColaStore`, no con Zod.
 */
class StorageSucio implements ColaStore {
  rawCola: unknown = [];
  private blobs = new Map<string, Blob>();
  private rutaRaw: unknown;

  async leerCola(): Promise<FilaCola[]> {
    return filasColaDesdeStorage(this.rawCola);
  }

  async escribirCola(cola: FilaCola[]): Promise<void> {
    this.rawCola = cola.map((f) => ({ ...f }));
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    if (blob.size > ASSET_MAX_BYTES) {
      throw new Error("El comprobante supera el tamaño máximo");
    }
    this.blobs.set(id, blob);
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    return this.blobs.get(id);
  }

  async putRuta(ruta: RutaReparto): Promise<void> {
    this.rutaRaw = ruta;
  }

  async getRuta(): Promise<RutaReparto | undefined> {
    return rutaDesdeStorage(this.rutaRaw);
  }
}

function ports(): SyncPorts & { entregas: string[] } {
  const entregas: string[] = [];
  return {
    entregas,
    postEntrega: async (body) => {
      entregas.push(body.idempotencyKey);
      return { idempotente: false };
    },
    postPago: async () => ({ idempotente: false }),
    subirComprobante: async () => "99999999-9999-9999-9999-999999999999",
  };
}

describe("filasColaDesdeStorage", () => {
  test("omite filas corruptas y no lanza", () => {
    const raw = [filaValida(), { tipo: "NOPE" }, null, "basura"];
    expect(filasColaDesdeStorage(raw).map((f) => f.idempotencyKey)).toEqual([
      KEY_E,
    ]);
    expect(filasColaDesdeStorage(undefined)).toEqual([]);
    expect(filasColaDesdeStorage("no-array")).toEqual([]);
  });
});

describe("rutaDesdeStorage", () => {
  test("snapshot inválido es ausencia, no excepción", () => {
    expect(rutaDesdeStorage({ fechaOperacion: "2026-08-21", paradas: [] })?.fechaOperacion).toBe(
      "2026-08-21",
    );
    expect(rutaDesdeStorage({ fechaOperacion: "no-es-fecha" })).toBeUndefined();
    expect(rutaDesdeStorage(undefined)).toBeUndefined();
  });
});

describe("ColaStore", () => {
  test("MemoryColaStore.leerCola de vacío no lanza y devuelve []", async () => {
    const store = new MemoryColaStore();
    await expect(store.leerCola()).resolves.toEqual([]);
  });

  test("un store con basura persistida sigue siendo sustituible: drenarCola confirma lo válido", async () => {
    const store = new StorageSucio();
    store.rawCola = [filaValida(), { tipo: "basura-de-schema-viejo" }];
    const api = ports();
    const r = await drenarCola(store, api);
    expect(api.entregas).toEqual([KEY_E]);
    expect(r.confirmadas).toBe(1);
    expect(await store.leerCola()).toEqual([]);
  });
});
