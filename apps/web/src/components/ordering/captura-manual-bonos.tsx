"use client";

import { Chip } from "@heroui/react";
import type { ClienteBonoPublico } from "@misupertostada/shared";
import { UNIDAD_CORTA } from "@misupertostada/shared";
import { QuantityStepper } from "@/components/ui/quantity-stepper";

export function CapturaManualBonos({
  bonos,
  cantidadesBono,
  onCantidadChange,
}: {
  bonos: ClienteBonoPublico[];
  cantidadesBono: Record<string, number>;
  onCantidadChange: (bonoId: string, cantidad: number) => void;
}) {
  if (bonos.length === 0) return null;

  return (
    <section className="grid gap-2">
      <h3 className="mst-label px-0.5">Devolución pendiente</h3>
      <div className="rounded-campo border border-[var(--border-subtle)]">
        {bonos.map((b) => (
          <div
            key={b.id}
            className="flex flex-wrap items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-3 last:border-b-0"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <p className="text-sm font-semibold text-tinta-900">
                  {b.nombreCanonico}
                </p>
                <Chip size="sm" variant="soft" color="success">
                  Devolución
                </Chip>
              </div>
              <p className="text-xs text-tinta-500">{b.descripcion}</p>
            </div>
            <QuantityStepper
              value={cantidadesBono[b.id] ?? 0}
              onChange={(cantidad) => onCantidadChange(b.id, cantidad)}
              min={0}
              max={b.cantidadDisponible}
              unidad={UNIDAD_CORTA[b.unidadMedida]}
            />
          </div>
        ))}
      </div>
    </section>
  );
}
