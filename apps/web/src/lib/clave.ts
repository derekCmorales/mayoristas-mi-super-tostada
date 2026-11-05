/**
 * Contraseña inicial para cuentas nuevas creadas con un atajo de puesto.
 *
 * Tres grupos de cinco caracteres (`k7mqp-3xh9d-wz2ra`): 17 caracteres, ~74 bits de entropía,
 * muy por encima del mínimo de 10 del servidor. El alfabeto omite lo que se confunde al
 * dictarlo o teclearlo en el celular (0/o, 1/l/i): quien la recibe es alguien en planta o en
 * ruta, no frente a un teclado.
 *
 * Usa `crypto.getRandomValues` con rechazo para no sesgar el módulo.
 */
export const ALFABETO_CLAVE = "abcdefghjkmnpqrstuvwxyz23456789";

const GRUPOS = 3;
const POR_GRUPO = 5;

export function generarClave(
  random: (buf: Uint8Array) => Uint8Array = (buf) => crypto.getRandomValues(buf),
): string {
  const n = ALFABETO_CLAVE.length;
  // Mayor múltiplo de n que cabe en un byte: lo que quede arriba se descarta.
  const limite = 256 - (256 % n);
  const total = GRUPOS * POR_GRUPO;
  const chars: string[] = [];
  const buf = new Uint8Array(total * 2);
  while (chars.length < total) {
    random(buf);
    for (const byte of buf) {
      if (byte >= limite) continue;
      chars.push(ALFABETO_CLAVE[byte % n]!);
      if (chars.length === total) break;
    }
  }
  const grupos: string[] = [];
  for (let i = 0; i < total; i += POR_GRUPO) {
    grupos.push(chars.slice(i, i + POR_GRUPO).join(""));
  }
  return grupos.join("-");
}
