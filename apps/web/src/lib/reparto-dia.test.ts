import { describe, expect, test } from "bun:test";
import type { RepartoAtrasados } from "@misupertostada/shared";
import {
  diaRepartoDesdeParam,
  diasAtrasadosVisibles,
  hrefRepartoDia,
  tituloAtrasados,
} from "./reparto-dia";

describe("diaRepartoDesdeParam", () => {
  test("sin parámetro es la ruta de hoy", () => {
    expect(diaRepartoDesdeParam(null, "2026-10-02")).toBeNull();
    expect(diaRepartoDesdeParam("", "2026-10-02")).toBeNull();
  });

  test("un día anterior se respeta", () => {
    expect(diaRepartoDesdeParam("2026-09-29", "2026-10-02")).toBe("2026-09-29");
  });

  test("hoy explícito cuenta como hoy: un solo camino y un solo snapshot", () => {
    expect(diaRepartoDesdeParam("2026-10-02", "2026-10-02")).toBeNull();
  });

  test("basura en la URL no inventa un día", () => {
    expect(diaRepartoDesdeParam("ayer", "2026-10-02")).toBeNull();
    expect(diaRepartoDesdeParam("2026-9-29", "2026-10-02")).toBeNull();
  });

  test("sin calendario todavía, el día de la URL se respeta", () => {
    expect(diaRepartoDesdeParam("2026-09-29", undefined)).toBe("2026-09-29");
  });
});

describe("hrefs de la ruta", () => {
  test("hoy no lleva parámetro; un día anterior sí", () => {
    expect(hrefRepartoDia(null)).toBe("/reparto");
    expect(hrefRepartoDia("2026-09-29")).toBe("/reparto?fechaEntrega=2026-09-29");
  });
});

describe("atrasados", () => {
  const atrasados: RepartoAtrasados = {
    hoy: "2026-10-02",
    pendientes: 4,
    montoEstimadoCentavos: 40000,
    dias: [
      { fechaEntrega: "2026-10-01", pendientes: 3, montoEstimadoCentavos: 30000 },
      { fechaEntrega: "2026-09-30", pendientes: 1, montoEstimadoCentavos: 10000 },
    ],
  };

  test("el día que se está viendo no se ofrece otra vez", () => {
    expect(
      diasAtrasadosVisibles(atrasados, "2026-10-01").map((d) => d.fechaEntrega),
    ).toEqual(["2026-09-30"]);
    expect(diasAtrasadosVisibles(atrasados, null)).toHaveLength(2);
    expect(diasAtrasadosVisibles(undefined, null)).toEqual([]);
  });

  test("el título cuenta pedidos, no días", () => {
    expect(tituloAtrasados(atrasados.dias)).toBe(
      "4 pedidos de días anteriores sin marcar como entregados",
    );
    expect(tituloAtrasados(atrasados.dias.slice(1))).toBe(
      "1 pedido de días anteriores sin marcar como entregado",
    );
  });
});
