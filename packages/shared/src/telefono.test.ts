import { describe, expect, test } from "bun:test";
import {
  formatearTelefonoWa,
  revisarTelefonoWa,
  telefonoWaParaEnvio,
  telefonoWaSchema,
} from "./telefono";

describe("revisarTelefonoWa", () => {
  test.each([
    ["55551234", "+50255551234", "+502 5555 1234"],
    ["5555-1234", "+50255551234", "+502 5555 1234"],
    ["+502 5555 1234", "+50255551234", "+502 5555 1234"],
    ["502 3012 3456", "+50230123456", "+502 3012 3456"],
    ["(502) 4012-3456", "+50240123456", "+502 4012 3456"],
    ["0050255551234", "+50255551234", "+502 5555 1234"],
  ])("celular de Guatemala %s", (raw, e164, legible) => {
    const r = revisarTelefonoWa(raw);
    expect(r.estado).toBe("VALIDO");
    expect(r.e164).toBe(e164);
    expect(r.legible).toBe(legible);
    expect(r.problema).toBeNull();
  });

  test("fijo de Guatemala: enviable pero marcado", () => {
    const r = revisarTelefonoWa("2222-3333");
    expect(r.estado).toBe("FIJO");
    expect(r.e164).toBe("+50222223333");
    expect(r.problema).not.toBeNull();
  });

  test("vacío o nulo", () => {
    expect(revisarTelefonoWa(null).estado).toBe("SIN_NUMERO");
    expect(revisarTelefonoWa("   ").estado).toBe("SIN_NUMERO");
  });

  test.each([
    ["5555123", "faltan"],
    ["555512345", "sobran"],
    ["+502 5555 12345", "502 con 9"],
    ["18001234", "empieza con 1"],
    ["5555abcd", "letras"],
    ["pendiente", "texto"],
  ])("inválido: %s (%s)", (raw) => {
    const r = revisarTelefonoWa(raw);
    expect(r.estado).toBe("INVALIDO");
    expect(r.e164).toBeNull();
    expect(r.legible).toBe(raw);
    expect(r.problema).toBeTruthy();
  });

  test("otro país solo con +", () => {
    expect(revisarTelefonoWa("+1 555 123 4567").e164).toBe("+15551234567");
    expect(revisarTelefonoWa("15551234567").estado).toBe("INVALIDO");
  });
});

describe("telefonoWaParaEnvio", () => {
  test("lo que pide Meta: dígitos con código, sin +", () => {
    expect(telefonoWaParaEnvio("5555-1234")).toBe("50255551234");
    expect(telefonoWaParaEnvio("abc")).toBeNull();
    expect(telefonoWaParaEnvio(null)).toBeNull();
  });
});

describe("formatearTelefonoWa", () => {
  test("agrupa el válido y deja el inválido tal cual", () => {
    expect(formatearTelefonoWa("+50255551234")).toBe("+502 5555 1234");
    expect(formatearTelefonoWa("555")).toBe("555");
    expect(formatearTelefonoWa(null)).toBeNull();
  });
});

describe("telefonoWaSchema", () => {
  test("guarda canónico", () => {
    expect(telefonoWaSchema.parse("5555 1234")).toBe("+50255551234");
    expect(telefonoWaSchema.parse("")).toBeNull();
    expect(telefonoWaSchema.parse(null)).toBeNull();
    expect(telefonoWaSchema.parse(undefined)).toBeUndefined();
  });

  test("rechaza lo que no se puede enviar", () => {
    expect(telefonoWaSchema.safeParse("123").success).toBe(false);
  });
});
