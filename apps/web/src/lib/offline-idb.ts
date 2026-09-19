import {
  ASSET_MAX_BYTES,
  MENSAJE_COLA_INDEXEDDB,
  filaColaSchema,
  rutaRepartoSchema,
  type FilaCola,
  type RutaReparto,
} from "@misupertostada/shared";

export type ColaStore = {
  leerCola(): Promise<FilaCola[]>;
  escribirCola(cola: FilaCola[]): Promise<void>;
  putBlob(id: string, blob: Blob): Promise<void>;
  getBlob(id: string): Promise<Blob | undefined>;
  putRuta(ruta: RutaReparto): Promise<void>;
  getRuta(): Promise<RutaReparto | undefined>;
};

/**
 * Interpreta lo persistido. Basura de un schema viejo o una escritura a
 * medias no lanza: se omite. `MemoryColaStore.leerCola` nunca tira por
 * contenido; IndexedDB tiene que cumplir el mismo contrato o el sync de
 * Tony se cae entero por una sola fila.
 */
export function filasColaDesdeStorage(raw: unknown): FilaCola[] {
  if (!Array.isArray(raw)) return [];
  const filas: FilaCola[] = [];
  for (const fila of raw) {
    const parsed = filaColaSchema.safeParse(fila);
    if (parsed.success) filas.push(parsed.data);
  }
  return filas;
}

export function rutaDesdeStorage(raw: unknown): RutaReparto | undefined {
  if (!raw) return undefined;
  const parsed = rutaRepartoSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
}

const DB_NOMBRE = "mst-offline";
const DB_VERSION = 1;
const KEY_COLA = "filas";
const KEY_RUTA = "snapshot";

/** Store inyectable para tests. No toca IndexedDB. */
export class MemoryColaStore implements ColaStore {
  private cola: FilaCola[] = [];
  private blobs = new Map<string, Blob>();
  private ruta: RutaReparto | undefined;

  async leerCola(): Promise<FilaCola[]> {
    return this.cola.map((f) => ({ ...f }));
  }

  async escribirCola(cola: FilaCola[]): Promise<void> {
    this.cola = cola.map((f) => ({ ...f }));
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
    this.ruta = ruta;
  }

  async getRuta(): Promise<RutaReparto | undefined> {
    return this.ruta;
  }
}

export class IdbColaStore implements ColaStore {
  constructor(private readonly db: IDBDatabase) {}

  async leerCola(): Promise<FilaCola[]> {
    const raw = await this.get<unknown>("cola", KEY_COLA);
    return filasColaDesdeStorage(raw);
  }

  async escribirCola(cola: FilaCola[]): Promise<void> {
    await this.put("cola", KEY_COLA, cola);
  }

  async putBlob(id: string, blob: Blob): Promise<void> {
    if (blob.size > ASSET_MAX_BYTES) {
      throw new Error("El comprobante supera el tamaño máximo");
    }
    await this.put("blobs", id, blob);
  }

  async getBlob(id: string): Promise<Blob | undefined> {
    const raw = await this.get<Blob>("blobs", id);
    return raw ?? undefined;
  }

  async putRuta(ruta: RutaReparto): Promise<void> {
    await this.put("ruta", KEY_RUTA, ruta);
  }

  async getRuta(): Promise<RutaReparto | undefined> {
    const raw = await this.get<unknown>("ruta", KEY_RUTA);
    return rutaDesdeStorage(raw);
  }

  private get<T>(store: string, key: string): Promise<T | undefined> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readonly");
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result as T | undefined);
      req.onerror = () => reject(new Error(MENSAJE_COLA_INDEXEDDB));
    });
  }

  private put(store: string, key: string, value: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, "readwrite");
      tx.objectStore(store).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(new Error(MENSAJE_COLA_INDEXEDDB));
    });
  }
}

export async function abrirColaStore(): Promise<ColaStore> {
  if (typeof indexedDB === "undefined") {
    throw new Error(MENSAJE_COLA_INDEXEDDB);
  }
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NOMBRE, DB_VERSION);
    req.onupgradeneeded = () => {
      const next = req.result;
      if (!next.objectStoreNames.contains("cola")) next.createObjectStore("cola");
      if (!next.objectStoreNames.contains("blobs")) next.createObjectStore("blobs");
      if (!next.objectStoreNames.contains("ruta")) next.createObjectStore("ruta");
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(new Error(MENSAJE_COLA_INDEXEDDB));
  });
  return new IdbColaStore(db);
}
