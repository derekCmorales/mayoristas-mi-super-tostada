import { describe, expect, test } from "bun:test";
import { portalPedidoDetalleFacturaSchema } from "@misupertostada/shared";

describe("FacturaPortal DTO", () => {
  test("dePedido cumple portalPedidoDetalleFacturaSchema (sin campos extra)", () => {
    const dto = portalPedidoDetalleFacturaSchema.parse({
      id: "00000000-0000-4000-8000-000000000010",
      numeroDte: "DTE-1",
      montoCentavos: 10000,
      abonadoCentavos: 3000,
      saldoCentavos: 7000,
      antiguedadDias: 5,
      estado: "ABONO_PARCIAL",
      abonos: [
        {
          abonoId: "00000000-0000-4000-8000-000000000011",
          fecha: "2026-08-20",
          metodo: "EFECTIVO",
          estado: "CONFIRMADO",
          montoCentavos: 3000,
        },
      ],
    });
    expect(dto.saldoCentavos).toBe(7000);
    expect(dto).not.toHaveProperty("pedidoId");
    expect(dto).not.toHaveProperty("emitidaAt");
  });
});
