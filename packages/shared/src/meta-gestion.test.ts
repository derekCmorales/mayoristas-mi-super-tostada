import { describe, expect, test } from "bun:test";
import {
  borradorDeComponentes,
  componentesMetaDeBorrador,
  motivoRechazoLegible,
  plantillaBorradorSchema,
} from "./meta-gestion";

const base = {
  name: "mst_prueba_v1",
  language: "es",
  category: "UTILITY",
  headerTipo: "NONE",
  headerEjemplos: [],
  body: "Hola {{1}}, su pedido {{2}} va en camino.",
  bodyEjemplos: ["Tabascos", "1024"],
  botones: [],
} as const;

describe("plantillaBorradorSchema", () => {
  test("acepta un borrador válido", () => {
    expect(plantillaBorradorSchema.safeParse(base).success).toBe(true);
  });

  test("exige variables en orden y un ejemplo por variable", () => {
    expect(
      plantillaBorradorSchema.safeParse({ ...base, body: "Hola {{2}} y {{3}} listo." }).success,
    ).toBe(false);
    expect(
      plantillaBorradorSchema.safeParse({ ...base, bodyEjemplos: ["solo uno"] }).success,
    ).toBe(false);
  });

  test("rechaza cuerpo que empieza o termina con variable, y nombres con mayúsculas", () => {
    expect(
      plantillaBorradorSchema.safeParse({ ...base, body: "{{1}} hola {{2}} ok", }).success,
    ).toBe(false);
    expect(
      plantillaBorradorSchema.safeParse({ ...base, body: "Hola {{1}} y {{2}}" }).success,
    ).toBe(false);
    expect(plantillaBorradorSchema.safeParse({ ...base, name: "Mst Prueba" }).success).toBe(false);
  });

  test("botón URL con variable exige ejemplo y la variable al final", () => {
    const url = (b: object) =>
      plantillaBorradorSchema.safeParse({ ...base, botones: [{ tipo: "URL", texto: "Abrir", ...b }] }).success;
    expect(url({ url: "https://x.gt/p/{{1}}", ejemplo: "https://x.gt/p/abc" })).toBe(true);
    expect(url({ url: "https://x.gt/p/{{1}}" })).toBe(false);
    expect(url({ url: "https://x.gt/{{1}}/p" , ejemplo: "https://x.gt/a/p" })).toBe(false);
  });
});

describe("componentes ↔ borrador", () => {
  test("ida y vuelta conserva lo editable", () => {
    const b = plantillaBorradorSchema.parse({
      ...base,
      headerTipo: "TEXT",
      headerTexto: "Pedido {{1}}",
      headerEjemplos: ["1024"],
      footer: "Mi Súper Tostada",
      botones: [{ tipo: "QUICK_REPLY", texto: "Recibido" }],
    });
    const comps = componentesMetaDeBorrador(b);
    const vuelta = borradorDeComponentes({ name: b.name, language: b.language, category: b.category, componentes: comps });
    expect(vuelta).toEqual(b);
  });
});

describe("motivoRechazoLegible", () => {
  test("traduce los motivos conocidos y deja pasar los nuevos", () => {
    expect(motivoRechazoLegible("TAG_CONTENT_MISMATCH")).toContain("Utilidad");
    expect(motivoRechazoLegible("ALGO_NUEVO")).toBe("ALGO_NUEVO");
  });
});
