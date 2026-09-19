"use client";

import { SearchField } from "@heroui/react";
import type { ClienteProductoFila } from "@misupertostada/shared";
import {
  FAMILIA_ETIQUETA,
  UNIDAD_CORTA,
  precioEfectivoCentavos,
} from "@misupertostada/shared";
import { ProductoThumb } from "@/components/catalog/producto-thumb";
import { Money } from "@/components/domain/money";
import { QuantityStepper } from "@/components/ui/quantity-stepper";
import { cn } from "@/lib/utils";
import type { GrupoCaptura } from "@/lib/pedido-vista";

export function CapturaManualCatalogo({
  grupos,
  cargando,
  q,
  onBusquedaChange,
  fotoPorProducto,
  cantidades,
  onCantidadChange,
}: {
  grupos: GrupoCaptura[];
  cargando: boolean;
  q: string;
  onBusquedaChange: (q: string) => void;
  fotoPorProducto: Map<string, string | null>;
  cantidades: Record<string, number>;
  onCantidadChange: (productoId: string, cantidad: number) => void;
}) {
  return (
    <>
      <SearchField aria-label="Buscar producto" value={q} onChange={onBusquedaChange}>
        <SearchField.Group>
          <SearchField.SearchIcon />
          <SearchField.Input placeholder="Alias o nombre" />
          <SearchField.ClearButton />
        </SearchField.Group>
      </SearchField>

      <div className="max-h-[40vh] overflow-auto rounded-campo border border-[var(--border-subtle)]">
        {grupos.map((grupo) => (
          <section key={grupo.key}>
            <h3 className="sticky top-0 z-[1] flex items-center justify-between gap-2 border-b border-[var(--border-subtle)] bg-[var(--ink-50)] px-3 py-2 mst-label">
              <span>{grupo.label}</span>
              <span className="tabular-nums text-tinta-400">{grupo.filas.length}</span>
            </h3>
            {grupo.filas.map((fila) => (
              <CapturaFila
                key={fila.productoId}
                fila={fila}
                fotoAssetId={fotoPorProducto.get(fila.productoId)}
                cantidad={cantidades[fila.productoId] ?? 0}
                onChange={(cantidad) => onCantidadChange(fila.productoId, cantidad)}
              />
            ))}
          </section>
        ))}
        {grupos.length === 0 && (
          <p className="px-4 py-6 text-sm text-tinta-500">
            {cargando ? "Cargando catálogo…" : "Ningún producto coincide."}
          </p>
        )}
      </div>
    </>
  );
}

function CapturaFila({
  fila,
  fotoAssetId,
  cantidad,
  onChange,
}: {
  fila: ClienteProductoFila;
  fotoAssetId?: string | null;
  cantidad: number;
  onChange: (cantidad: number) => void;
}) {
  const alias = fila.alias?.trim() || fila.nombreCanonico;
  const unidad = UNIDAD_CORTA[fila.unidadMedida];
  const precioEfectivo = precioEfectivoCentavos({
    precioClienteCentavos: fila.precioCentavos,
    precioBaseCentavos: fila.precioBaseCentavos,
  });
  const pedible = precioEfectivo != null;
  return (
    <div
      className={cn(
        "flex min-h-fila items-center gap-3 border-b border-[var(--border-subtle)] px-3 py-2.5 last:border-b-0",
        "transition-colors duration-control ease-out",
        cantidad > 0 && "bg-[var(--green-50)]",
      )}
    >
      <ProductoThumb
        nombre={fila.nombreCanonico}
        fotoAssetId={fotoAssetId}
        size="sm"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-pretty text-tinta-900">
          {fila.nombreCanonico}
        </p>
        <p className="text-[12px] text-tinta-500">
          {alias !== fila.nombreCanonico ? `«${alias}» · ` : null}
          {FAMILIA_ETIQUETA[fila.familia]}
          {" · "}
          {pedible ? (
            <>
              <Money centavos={precioEfectivo} tone="muted" /> / {unidad}
            </>
          ) : (
            "Sin precio — no pedible"
          )}
        </p>
      </div>
      <QuantityStepper
        value={cantidad}
        onChange={onChange}
        unidad={unidad}
        disabled={!pedible}
      />
    </div>
  );
}
