import { describe, expect, test } from "bun:test";
import {
  PERFILES_CUENTA,
  resumenPlantilla,
  sugerirUsername,
} from "./perfiles-cuenta";
import { usernameSchema } from "./auth";

describe("perfiles de cuenta", () => {
  test("ningún atajo crea un administrador jefe", () => {
    for (const p of PERFILES_CUENTA) {
      expect(p.rol).not.toBe("ADMIN_JEFE");
      expect(usernameSchema.safeParse(p.usuarioBase).success).toBe(true);
    }
  });

  test("el resumen del repartidor es solo reparto, entrega y cobro", () => {
    const r = resumenPlantilla("REPARTO");
    expect(r.modulos.map((m) => m.id)).toEqual(["reparto"]);
    expect(r.acciones).toHaveLength(2);
  });

  test("producción no tiene acciones de escritura", () => {
    expect(resumenPlantilla("PRODUCCION").acciones).toEqual([]);
  });
});

describe("sugerirUsername", () => {
  test("usa la base si está libre y numera si no", () => {
    expect(sugerirUsername("reparto", [])).toBe("reparto");
    expect(sugerirUsername("reparto", ["Reparto"])).toBe("reparto2");
    expect(sugerirUsername("reparto", ["reparto", "reparto2"])).toBe("reparto3");
  });
});
