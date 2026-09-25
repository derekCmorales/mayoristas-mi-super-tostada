import { describe, expect, test } from "bun:test";
import {
  etiquetaVentanaBadge,
  formatearRestante,
} from "./ventana-badge";

describe("formatearRestante", () => {
  test("formatea horas, minutos y segundos", () => {
    // 1 hora, 2 minutos, 3 segundos = 3723000 ms
    expect(formatearRestante(3723000)).toBe("1:02:03");
  });

  test("formatea 0 segundos en 0:00:00", () => {
    expect(formatearRestante(0)).toBe("0:00:00");
  });
});

describe("etiquetaVentanaBadge", () => {
  const baseNow = new Date("2026-09-03T18:00:00.000Z").getTime();

  test("ventana abierta con cierraAt muestra el tiempo restante por defecto (incluso en navbar sm)", () => {
    const cierraAt = new Date("2026-09-03T21:30:15.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      abierta: true,
      cierraAt,
      compacto: false,
      now: baseNow,
    });

    expect(res.viva).toBe(true);
    expect(res.etiqueta).toBe("Ventana abierta · Cierra en 3:30:15");
  });

  test("ventana abierta con compacto=true oculta el tiempo restante", () => {
    const cierraAt = new Date("2026-09-03T21:30:15.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      abierta: true,
      cierraAt,
      compacto: true,
      now: baseNow,
    });

    expect(res.viva).toBe(true);
    expect(res.etiqueta).toBe("Ventana abierta");
  });

  test("ventana cerrada con proximaAperturaAt muestra el tiempo restante hasta abrir", () => {
    const proximaAperturaAt = new Date("2026-09-04T01:15:00.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      abierta: false,
      proximaAperturaAt,
      compacto: false,
      now: baseNow,
    });

    expect(res.viva).toBe(false);
    expect(res.etiqueta).toBe("Ventana cerrada · Abre en 7:15:00");
  });

  test("ventana cerrada con compacto=true oculta el tiempo restante", () => {
    const proximaAperturaAt = new Date("2026-09-04T01:15:00.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      abierta: false,
      proximaAperturaAt,
      compacto: true,
      now: baseNow,
    });

    expect(res.viva).toBe(false);
    expect(res.etiqueta).toBe("Ventana cerrada");
  });

  test("cierre anticipado muestra Día cerrado con cuenta regresiva de apertura", () => {
    const proximaAperturaAt = new Date("2026-09-04T01:15:00.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      abierta: true,
      diaCerrado: true,
      proximaAperturaAt,
      compacto: false,
      now: baseNow,
    });

    expect(res.cierreAnticipado).toBe(true);
    expect(res.etiqueta).toBe("Día cerrado · Abre en 7:15:00");
  });

  test("día reabierto muestra Ventana reabierta", () => {
    const res = etiquetaVentanaBadge({
      abierta: false,
      reabierta: true,
      now: baseNow,
    });

    expect(res.reabiertaPedido).toBe(true);
    expect(res.etiqueta).toBe("Ventana reabierta");
  });

  test("whatsapp muestra puede responder con cuenta regresiva cuando no es compacto", () => {
    const expiraAt = new Date("2026-09-03T20:00:00.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      tipo: "whatsapp",
      abierta: true,
      expiraAt,
      compacto: false,
      now: baseNow,
    });

    expect(res.viva).toBe(true);
    expect(res.etiqueta).toBe("Puede responder · queda 2:00:00");
  });

  test("whatsapp con compacto=true muestra únicamente Puede responder", () => {
    const expiraAt = new Date("2026-09-03T20:00:00.000Z").toISOString();
    const res = etiquetaVentanaBadge({
      tipo: "whatsapp",
      abierta: true,
      expiraAt,
      compacto: true,
      now: baseNow,
    });

    expect(res.viva).toBe(true);
    expect(res.etiqueta).toBe("Puede responder");
  });

  test("whatsapp cerrada habla de avisos armados", () => {
    const res = etiquetaVentanaBadge({
      tipo: "whatsapp",
      abierta: false,
      expiraAt: null,
      compacto: false,
      now: baseNow,
    });

    expect(res.viva).toBe(false);
    expect(res.etiqueta).toBe("Solo avisos armados");
  });
});
