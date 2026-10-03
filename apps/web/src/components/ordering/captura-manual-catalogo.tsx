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
import { PrecioCampo } from "@/components/domain/precio-campo";
import { Checkbox } from "@/components/ui/checkbox";
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
  puedeFijarPrecio,
  precios,
  onPrecioChange,
  guardarEnCliente,
  onGuardarEnClienteChange,
}: {
  grupos: GrupoCaptura[];
  cargando: boolean;
  q: string;
  onBusquedaChange: (q: string) => void;
  fotoPorProducto: Map<string, string | null>;
  cantidades: Record<string, number>;
  onCantidadChange: (productoId: string, cantidad: number) => void;
  /** `precios.cambiar`: puede poner precio para este pedido. */
  puedeFijarPrecio: boolean;
  /** Precio puesto a mano por producto; ausente = el del catálogo. */
  precios: Record<string, number | null>;
  onPrecioChange: (productoId: string, centavos: number | null) => void;
  guardarEnCliente: Record<string, boolean>;
  onGuardarEnClienteChange: (productoId: string, guardar: boolean) => void;
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
                puedeFijarPrecio={puedeFijarPrecio}
                precio={precios[fila.productoId]}
                onPrecioChange={(c) => onPrecioChange(fila.productoId, c)}
                guardar={guardarEnCliente[fila.productoId] ?? false}
                onGuardarChange={(g) => onGuardarEnClienteChange(fila.productoId, g)}
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
  puedeFijarPrecio,
  precio,
  onPrecioChange,
  guardar,
  onGuardarChange,
}: {
  fila: ClienteProductoFila;
  fotoAssetId?: string | null;
  cantidad: number;
  onChange: (cantidad: number) => void;
  puedeFijarPrecio: boolean;
  precio: number | null | undefined;
  onPrecioChange: (centavos: number | null) => void;
  guardar: boolean;
  onGuardarChange: (guardar: boolean) => void;
}) {
  const alias = fila.alias?.trim() || fila.nombreCanonico;
  const unidad = UNIDAD_CORTA[fila.unidadMedida];
  const precioEfectivo = precioEfectivoCentavos({
    precioClienteCentavos: fila.precioCentavos,
    precioBaseCentavos: fila.precioBaseCentavos,
  });
  // Sin precio de lista solo se pide si quien captura puede ponérselo.
  const pedible = precioEfectivo != null || puedeFijarPrecio;
  const precioLinea = precio === undefined ? precioEfectivo : precio;
  const cambiado = precioLinea != null && precioLinea !== precioEfectivo;
  return (
    <div
      className={cn(
        "border-b border-[var(--border-subtle)] px-3 py-2.5 last:border-b-0",
        "transition-colors duration-control ease-out",
        cantidad > 0 && "bg-[var(--green-50)]",
      )}
    >
      <div className="flex min-h-fila items-center gap-3">
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
            {precioEfectivo != null ? (
              <>
                <Money centavos={precioEfectivo} tone="muted" /> / {unidad}
              </>
            ) : puedeFijarPrecio ? (
              "Sin precio de lista — póngalo abajo"
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
      {cantidad > 0 && puedeFijarPrecio ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 pl-12">
          <div className="flex items-center gap-2 text-[12px] text-tinta-600">
            <span>Precio de este pedido / {unidad}</span>
            <PrecioCampo
              centavos={precioLinea}
              onChange={onPrecioChange}
              etiqueta={`Precio de ${fila.nombreCanonico} para este pedido`}
              destacado={cambiado}
            />
          </div>
          {cambiado ? (
            <Checkbox
              size="sm"
              checked={guardar}
              onChange={(e) => onGuardarChange(e.currentTarget.checked)}
              label="Guardar como precio de este cliente"
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
