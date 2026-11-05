import { describe, expect, test } from "bun:test";
import { crearUsuarioRequestSchema } from "@misupertostada/shared";
import { ALFABETO_CLAVE, generarClave } from "./clave";

describe("generarClave", () => {
  test("formato legible y cumple el mínimo del servidor", () => {
    const clave = generarClave();
    expect(clave).toMatch(/^[a-z2-9]{5}-[a-z2-9]{5}-[a-z2-9]{5}$/);
    for (const c of clave.replace(/-/g, "")) {
      expect(ALFABETO_CLAVE).toContain(c);
    }
    const parsed = crearUsuarioRequestSchema.safeParse({
      username: "reparto",
      password: clave,
      rol: "REPARTO",
    });
    expect(parsed.success).toBe(true);
  });

  test("no repite entre llamadas", () => {
    const claves = new Set(Array.from({ length: 200 }, () => generarClave()));
    expect(claves.size).toBe(200);
  });

  test("descarta bytes altos para no sesgar el alfabeto", () => {
    // Primero todo 255 (se descarta), luego ceros (→ primera letra).
    let llamada = 0;
    const clave = generarClave((buf) => {
      buf.fill(llamada++ === 0 ? 255 : 0);
      return buf;
    });
    expect(clave).toBe("aaaaa-aaaaa-aaaaa");
  });
});
