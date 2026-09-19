"use client";

import type { CalendarioAhora } from "@misupertostada/shared";
import { copyEjePedidos } from "@/lib/ejes-vista";
import { PildorasEjePedidos } from "@/components/ordering/pildoras-eje-pedidos";

export function CapturaManualAviso({
  calendario,
}: {
  calendario: CalendarioAhora;
}) {
  const copyCaptura = copyEjePedidos(
    calendario.fechaOperacionCaptura,
    calendario.fechaOperacionCaptura,
    calendario,
  );
  if (!copyCaptura) return null;

  return (
    <div className="grid gap-2.5 rounded-campo border border-[var(--yellow-400)]/35 bg-[var(--yellow-100)]/90 px-3 py-3">
      <p className="text-sm leading-relaxed text-pretty text-[var(--amber-700)]">
        <span className="font-semibold">{copyCaptura.titulo}.</span>{" "}
        {copyCaptura.detalle}
      </p>
      <PildorasEjePedidos
        fecha={calendario.fechaOperacionCaptura}
        cal={calendario}
      />
    </div>
  );
}
