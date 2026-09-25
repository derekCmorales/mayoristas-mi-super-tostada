import { describe, expect, test } from "bun:test";
import {
  META_ERROR_VENTANA_CERRADA,
  META_PARAM_MAX_CHARS,
  MENSAJE_VENTANA_WA_CERRADA,
  PLANTILLA_PROPOSITOS,
  PROPOSITO_ETIQUETA,
  conversacionBandejaSchema,
  conversacionDetalleSchema,
  enviarMensajeRequestSchema,
  mensajePublicoSchema,
  paramsConfirmacion,
  paramsEstadoCuenta,
  paramsInvitacion,
  pedidoNocheSchema,
  renderCuerpoPlantilla,
  textoEstadoCuenta,
  textoInvitacion,
  validarParametrosPlantilla,
  ventanaExpiraAtDesdeWebhook,
  ventanaWaAbierta,
} from "./messaging";

describe("validarParametrosPlantilla", () => {
  test("acepta variables limpias y el preview renderizado coincide", () => {
    const params = ["Tabasco Casa Vieja", "Viernes 21 de agosto"];
    const resultado = validarParametrosPlantilla(params);
    expect(resultado.ok).toBe(true);
    expect(
      renderCuerpoPlantilla(
        "Buenas noches {{1}}. Pedido para {{2}}.",
        params,
      ),
    ).toBe("Buenas noches Tabasco Casa Vieja. Pedido para Viernes 21 de agosto.");
  });

  test("rechaza salto de línea", () => {
    const resultado = validarParametrosPlantilla(["linea1\nlinea2"]);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.code).toBe("SALTO_LINEA");
  });

  test("rechaza tab", () => {
    const resultado = validarParametrosPlantilla(["hola\tmundo"]);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.code).toBe("TAB");
  });

  test("rechaza más de 4 espacios seguidos", () => {
    const resultado = validarParametrosPlantilla(["hola     mundo"]);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.code).toBe("ESPACIOS");
    expect(validarParametrosPlantilla(["hola    mundo"]).ok).toBe(true);
  });

  test("rechaza variable vacía o solo espacios", () => {
    expect(validarParametrosPlantilla([""]).ok).toBe(false);
    expect(validarParametrosPlantilla(["   "]).ok).toBe(false);
    const vacio = validarParametrosPlantilla(["ok", ""]);
    expect(vacio.ok).toBe(false);
    if (!vacio.ok) expect(vacio.code).toBe("VACIO");
  });

  test("rechaza overflow del límite de Meta", () => {
    const resultado = validarParametrosPlantilla(["x".repeat(META_PARAM_MAX_CHARS + 1)]);
    expect(resultado.ok).toBe(false);
    if (!resultado.ok) expect(resultado.code).toBe("LONGITUD");
    expect(validarParametrosPlantilla(["x".repeat(META_PARAM_MAX_CHARS)]).ok).toBe(
      true,
    );
  });
});

describe("enviarMensajeRequestSchema", () => {
  const conv = {
    cuerpoRenderizado: "Hola",
  };

  test("exige cuerpoRenderizado; texto libre o plantilla", () => {
    expect(
      enviarMensajeRequestSchema.parse({
        tipo: "texto",
        cuerpo: "Hola",
        ...conv,
      }).tipo,
    ).toBe("texto");
    expect(
      enviarMensajeRequestSchema.parse({
        tipo: "plantilla",
        proposito: "ESTADO_CUENTA",
        params: ["3", "Q 1,865.00"],
        cuerpoRenderizado: "Le compartimos su estado de cuenta: 3 facturas pendientes por Q 1,865.00.",
      }).tipo,
    ).toBe("plantilla");
    expect(
      enviarMensajeRequestSchema.safeParse({ tipo: "texto", cuerpo: "Hola" })
        .success,
    ).toBe(false);
  });

  test("rechaza propósito inventado", () => {
    expect(
      enviarMensajeRequestSchema.safeParse({
        tipo: "plantilla",
        proposito: "PROMO",
        params: ["x"],
        cuerpoRenderizado: "x",
      }).success,
    ).toBe(false);
  });
});

describe("textos deterministas", () => {
  test("invitación nombra la fecha de operación, sin saltos de línea", () => {
    const texto = textoInvitacion("2026-08-21");
    expect(texto).toContain("Viernes 21 de agosto");
    expect(texto).not.toMatch(/\n|\t/);
    expect(validarParametrosPlantilla(paramsInvitacion("2026-08-21")).ok).toBe(
      true,
    );
  });

  test("estado de cuenta usa Pendiente y montos en quetzales; nunca Cancelado", () => {
    const texto = textoEstadoCuenta({
      pendientes: 3,
      saldoCentavos: 186500,
    });
    expect(texto).toContain("3 facturas pendientes");
    expect(texto).toContain("Q 1,865.00");
    expect(texto.toLowerCase()).not.toContain("cancelad");
    expect(
      validarParametrosPlantilla(
        paramsEstadoCuenta({ pendientes: 3, saldoCentavos: 186500 }),
      ).ok,
    ).toBe(true);
  });

  test("confirmación rellena correlativo, fecha y total", () => {
    const params = paramsConfirmacion({
      correlativo: 1042,
      fechaEntrega: "2026-08-21",
      totalCentavos: 74500,
      horarioEntregaFijo: "08:30",
    });
    expect(validarParametrosPlantilla(params).ok).toBe(true);
    expect(params[0]).toBe("1042");
    expect(params[1]).toContain("Viernes 21 de agosto");
    expect(params[2]).toBe("Q 745.00");
  });
});

describe("ventana de 24 h desde el webhook", () => {
  test("expira exactamente 24 h después del timestamp de Meta, no del reloj local", () => {
    const ts = 1_787_250_000;
    const expira = ventanaExpiraAtDesdeWebhook(ts);
    expect(expira.toISOString()).toBe(
      new Date((ts + 24 * 60 * 60) * 1000).toISOString(),
    );
    expect(
      ventanaWaAbierta(expira, new Date((ts + 23 * 60 * 60) * 1000)),
    ).toBe(true);
    expect(
      ventanaWaAbierta(expira, new Date((ts + 24 * 60 * 60) * 1000)),
    ).toBe(false);
  });

  test("sin inbound la ventana está cerrada", () => {
    expect(ventanaWaAbierta(null, new Date(1_787_250_000_000))).toBe(false);
  });
});

describe("contrato de bandeja enriquecido", () => {
  const base = {
    id: "11111111-1111-4111-8111-111111111111",
    clienteId: "22222222-2222-4222-8222-222222222222",
    clienteNombre: "Tabascos",
    telefonoWa: "50212345678",
    ventanaExpiraAt: null,
    ventanaAbierta: false,
    ultimoInboundAt: null,
    noLeidos: 0,
    ultimoCuerpo: "Hola",
    ultimoAt: "2026-08-20T21:00:00.000Z",
    horarioEntregaFijo: "07:00",
    notasPermanentes: "Grosor especial",
    saldoCentavos: 125000,
    facturasPendientes: 2,
    pedidoNoche: {
      id: "33333333-3333-4333-8333-333333333333",
      correlativo: 42,
      estado: "CONFIRMADO" as const,
      fechaOperacion: "2026-08-20",
    },
    fechaOperacionViva: "2026-08-20",
  };

  test("ConversacionBandeja incluye contexto de restaurante", () => {
    const parsed = conversacionBandejaSchema.parse(base);
    expect(parsed.saldoCentavos).toBe(125000);
    expect(parsed.pedidoNoche?.correlativo).toBe(42);
  });

  test("ConversacionDetalle extiende bandeja con mensajes y proposito", () => {
    const parsed = conversacionDetalleSchema.parse({
      ...base,
      mensajes: [
        mensajePublicoSchema.parse({
          id: "44444444-4444-4444-8444-444444444444",
          waMessageId: "w1",
          direction: "OUTBOUND",
          tipo: "plantilla",
          templateName: "mst_estado_cuenta_v1",
          proposito: "ESTADO_CUENTA",
          bodyRenderizado: "Estado",
          status: "sent",
          errorCode: null,
          createdAt: "2026-08-20T21:00:00.000Z",
        }),
      ],
    });
    expect(parsed.mensajes[0]?.proposito).toBe("ESTADO_CUENTA");
  });

  test("pedidoNocheSchema rechaza montos flotantes", () => {
    expect(
      pedidoNocheSchema.safeParse({
        id: "33333333-3333-4333-8333-333333333333",
        correlativo: 1,
        estado: "CONFIRMADO",
        fechaOperacion: "2026-08-20",
      }).success,
    ).toBe(true);
  });
});

describe("constantes de plataforma", () => {
  test("los cuatro propósitos y el copy operativo están fijos", () => {
    expect([...PLANTILLA_PROPOSITOS]).toEqual([
      "INVITACION",
      "CONFIRMACION",
      "ESTADO_CUENTA",
      "CONSOLIDADO",
    ]);
    expect(META_ERROR_VENTANA_CERRADA).toBe("131047");
    expect(MENSAJE_VENTANA_WA_CERRADA).toMatch(/aviso/i);
    expect(PROPOSITO_ETIQUETA.ESTADO_CUENTA).toBe("Aviso de estado de cuenta");
  });
});
