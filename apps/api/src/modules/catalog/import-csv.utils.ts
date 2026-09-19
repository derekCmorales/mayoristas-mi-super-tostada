export function col(row: Record<string, string>, name: string): string {
  if (!(name in row)) throw new Error(`Falta la columna ${name}`);
  const v = row[name]!.trim();
  if (!v) throw new Error(`${name} está vacío`);
  return v;
}

export function vacioANull(raw: string): string | null {
  const v = raw.trim();
  return v === "" ? null : v;
}

export function parseEnteroOpcional(raw: string): number | null {
  const v = raw.trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) throw new Error(`Número inválido: ${raw}`);
  return Number(v);
}

export function parseBool(raw: string, defecto: boolean): boolean {
  const v = raw.trim().toLowerCase();
  if (v === "") return defecto;
  if (["1", "true", "si", "sí", "yes"].includes(v)) return true;
  if (["0", "false", "no"].includes(v)) return false;
  throw new Error(`Booleano inválido: ${raw}`);
}
