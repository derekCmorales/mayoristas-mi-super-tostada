"use client";

import { Description, Label, TextArea, TextField } from "@heroui/react";
import { Money } from "@/components/domain/money";

export function CapturaManualPie({
  notasAdmin,
  onNotasChange,
  totalCentavos,
  lineas,
  itemsBonos,
}: {
  notasAdmin: string;
  onNotasChange: (notas: string) => void;
  totalCentavos: number;
  lineas: number;
  itemsBonos: number;
}) {
  return (
    <>
      <TextField value={notasAdmin} onChange={onNotasChange}>
        <Label>Nota extraordinaria</Label>
        <TextArea rows={2} />
        <Description>
          Horario, grosor y punto de carga salen del catálogo. Aquí solo lo de hoy.
        </Description>
      </TextField>

      <div className="flex flex-wrap items-baseline justify-between gap-3 rounded-campo bg-[var(--ink-50)] px-4 py-3">
        <span className="mst-label">
          Total
          <span className="ml-2 font-normal tabular-nums text-tinta-500">
            {lineas} línea{lineas === 1 ? "" : "s"}
            {itemsBonos > 0 ? " · devolución a Q 0.00" : ""}
          </span>
        </span>
        <Money centavos={totalCentavos} truncate className="text-lg" />
      </div>
    </>
  );
}
