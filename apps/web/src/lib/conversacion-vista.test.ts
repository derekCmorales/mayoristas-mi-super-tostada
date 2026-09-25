import { describe, expect, test } from "bun:test";
import type { ConversacionBandeja } from "@misupertostada/shared";
import {
  aplicarSegmentoLista,
  buildConversacionesHref,
  conteosSegmento,
  copyEmptySegmento,
  copyVentanaWhatsapp,
  etiquetaMensajeSaliente,
  filtrarBandeja,
  ladoBurbuja,
  parseConversacionSegmento,
  porContestar,
  puedeResponder,
} from "./conversacion-vista";

function conv(partial: Partial<ConversacionBandeja>): ConversacionBandeja {
  return {
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
    notasPermanentes: null,
    saldoCentavos: 0,
    facturasPendientes: 0,
    pedidoNoche: null,
    fechaOperacionViva: "2026-08-20",
    ...partial,
  };
}

describe("parseConversacionSegmento", () => {
  test("segmentos válidos y default", () => {
    expect(parseConversacionSegmento("por_contestar")).toBe("por_contestar");
    expect(parseConversacionSegmento("puedo_responder")).toBe("puedo_responder");
    expect(parseConversacionSegmento(null)).toBe("todas");
    expect(parseConversacionSegmento("no_leidos")).toBe("todas");
  });
});

describe("buildConversacionesHref", () => {
  test("id y segmento en query string", () => {
    expect(
      buildConversacionesHref({
        id: "11111111-1111-4111-8111-111111111111",
        segmento: "por_contestar",
      }),
    ).toBe(
      "/conversaciones?id=11111111-1111-4111-8111-111111111111&segmento=por_contestar",
    );
    expect(buildConversacionesHref({})).toBe("/conversaciones");
  });
});

describe("segmentos de bandeja", () => {
  const rows = [
    conv({ id: "a", noLeidos: 2, ventanaAbierta: false }),
    conv({ id: "b", noLeidos: 0, ventanaAbierta: true }),
    conv({ id: "c", noLeidos: 1, ventanaAbierta: true }),
  ];

  test("por_contestar no pierde no leídos", () => {
    const filtrados = aplicarSegmentoLista(rows, "por_contestar");
    expect(filtrados.map((r) => r.id)).toEqual(["a", "c"]);
    expect(filtrados.every(porContestar)).toBe(true);
  });

  test("puedo_responder solo ventana viva", () => {
    const filtrados = aplicarSegmentoLista(rows, "puedo_responder");
    expect(filtrados.map((r) => r.id)).toEqual(["b", "c"]);
    expect(filtrados.every(puedeResponder)).toBe(true);
  });

  test("conteos reflejan la bandeja", () => {
    expect(conteosSegmento(rows)).toEqual({
      todas: 3,
      por_contestar: 2,
      puedo_responder: 2,
    });
  });
});

describe("filtrarBandeja", () => {
  test("busca por nombre y último mensaje", () => {
    const rows = [
      conv({ clienteNombre: "La Fonda", ultimoCuerpo: "50 libras" }),
      conv({
        id: "b",
        clienteNombre: "Tabascos",
        ultimoCuerpo: "gracias",
      }),
    ];
    expect(filtrarBandeja(rows, "tabasco")).toHaveLength(1);
    expect(filtrarBandeja(rows, "50 libras")).toHaveLength(1);
  });
});

describe("ladoBurbuja", () => {
  test("cliente izquierda, fábrica derecha", () => {
    expect(ladoBurbuja("INBOUND")).toBe("izquierda");
    expect(ladoBurbuja("OUTBOUND")).toBe("derecha");
  });
});

describe("etiquetaMensajeSaliente", () => {
  test("aviso automático vs respuesta humana", () => {
    expect(
      etiquetaMensajeSaliente({
        id: "1",
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
    ).toBe("Aviso de estado de cuenta");
    expect(
      etiquetaMensajeSaliente({
        id: "2",
        waMessageId: "w2",
        direction: "OUTBOUND",
        tipo: "texto",
        templateName: null,
        bodyRenderizado: "Recibido",
        status: "sent",
        errorCode: null,
        createdAt: "2026-08-20T21:00:00.000Z",
      }),
    ).toBe("Respuesta de la fábrica");
  });
});

describe("copyVentanaWhatsapp", () => {
  test("ventana viva habla de responder, no de Meta", () => {
    const copy = copyVentanaWhatsapp({
      ventanaAbierta: true,
      restanteMs: 3 * 3_600_000,
    });
    expect(copy.titulo).toContain("Puede responder");
    expect(copy.titulo).toContain("3 h");
    expect(copy.descripcion).not.toContain("Meta");
  });

  test("ventana apagada habla de avisos armados", () => {
    const copy = copyVentanaWhatsapp({
      ventanaAbierta: false,
      restanteMs: null,
    });
    expect(copy.titulo).toBe("Solo avisos armados");
    expect(copy.descripcion).not.toContain("131047");
  });
});

describe("copyEmptySegmento", () => {
  test("empty honesto por segmento", () => {
    expect(copyEmptySegmento("por_contestar", false).titulo).toBe(
      "Todo contestado",
    );
    expect(copyEmptySegmento("puedo_responder", false).titulo).toContain(
      "texto libre",
    );
  });
});
