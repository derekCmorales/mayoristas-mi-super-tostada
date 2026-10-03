"use client";

import {
  Alert,
  Button,
  Description,
  Label,
  Modal,
  Spinner,
  TextArea,
  TextField,
} from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import {
  UNIDAD_CORTA,
  type PedidoDetalle,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { Money } from "@/components/domain/money";
import { PrecioCampo } from "@/components/domain/precio-campo";

type Linea = PedidoDetalle["items"][number];

/**
 * Corrige el precio de las líneas de UN pedido ya capturado. El cambio de
 * catálogo no reescribe pedidos (snapshot); esta es la puerta explícita, con
 * motivo, para cuando el snapshot nació mal. Si el pedido ya se entregó,
 * también ajusta el monto de su factura.
 */
export function DialogoAjustePrecios({
  pedido,
  onClose,
}: {
  pedido: PedidoDetalle;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const lineas = pedido.items.filter((i) => !i.esDevolucion);
  const [precios, setPrecios] = useState<Record<string, number | null>>(() =>
    Object.fromEntries(
      lineas.map((l) => [l.productoId, l.precioUnitarioCentavos]),
    ),
  );
  // Los campos guardan su propio texto: al rellenar desde el catálogo se
  // remontan para mostrar el valor nuevo.
  const [version, setVersion] = useState(0);
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const entregado = pedido.estado === "ENTREGADO";
  const cantidadCobrada = (l: Linea) =>
    entregado ? l.cantidadEntregada : l.cantidad;
  const precioNuevo = (l: Linea) =>
    precios[l.productoId] ?? l.precioUnitarioCentavos;
  const cambios = lineas.filter(
    (l) => precioNuevo(l) !== l.precioUnitarioCentavos,
  );
  const incompletos = lineas.some((l) => precios[l.productoId] == null);
  const difierenDelCatalogo = lineas.some(
    (l) =>
      l.precioCatalogoCentavos != null &&
      l.precioCatalogoCentavos !== precioNuevo(l),
  );

  const devolucionesCentavos = pedido.items
    .filter((i) => i.esDevolucion)
    .reduce((acc, i) => acc + cantidadCobrada(i) * i.precioUnitarioCentavos, 0);
  const totalAntes = lineas.reduce(
    (acc, l) => acc + cantidadCobrada(l) * l.precioUnitarioCentavos,
    devolucionesCentavos,
  );
  const totalDespues = lineas.reduce(
    (acc, l) => acc + cantidadCobrada(l) * precioNuevo(l),
    devolucionesCentavos,
  );
  const abonado = pedido.factura?.abonadoCentavos ?? 0;
  const bajoAbonado = pedido.factura != null && totalDespues < abonado;

  const ajustar = useMutation({
    mutationFn: () =>
      api<PedidoDetalle>(`/pedidos/${pedido.id}/precios`, {
        method: "POST",
        body: JSON.stringify({
          motivo,
          items: cambios.map((l) => ({
            productoId: l.productoId,
            precioUnitarioCentavos: precioNuevo(l),
          })),
        }),
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      void qc.invalidateQueries({ queryKey: ["cartera"] });
      toastSuccess(
        pedido.factura
          ? "Precios y factura corregidos"
          : "Precios corregidos",
      );
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "No se pudo ajustar");
      toastFromError(err, "No se pudieron ajustar los precios");
    },
  });

  function usarCatalogo() {
    setPrecios((prev) => {
      const next = { ...prev };
      for (const l of lineas) {
        if (l.precioCatalogoCentavos != null) {
          next[l.productoId] = l.precioCatalogoCentavos;
        }
      }
      return next;
    });
    setVersion((v) => v + 1);
  }

  const formId = `ajuste-precios-${pedido.id}`;

  return (
    <Modal.Backdrop isOpen onOpenChange={(abierto) => !abierto && onClose()}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              Corregir precios del pedido #{pedido.correlativo}
            </Modal.Heading>
            <p className="text-sm text-tinta-500">
              Solo cambia el precio de este pedido; el catálogo no se toca.
              Cantidades y producción quedan igual.
            </p>
          </Modal.Header>
          <Modal.Body>
            <form
              id={formId}
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (motivo.trim() && cambios.length > 0 && !incompletos) {
                  ajustar.mutate();
                }
              }}
            >
              {difierenDelCatalogo ? (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-campo bg-[var(--ink-50)] px-3 py-2 text-sm">
                  <span className="text-tinta-700">
                    Hay líneas con un precio distinto al del catálogo actual.
                  </span>
                  <Button size="sm" variant="secondary" onPress={usarCatalogo}>
                    Usar precios del catálogo
                  </Button>
                </div>
              ) : null}

              <ul className="grid divide-y divide-[var(--border-subtle)] rounded-campo border border-[var(--border-subtle)]">
                {lineas.map((l) => {
                  const nuevo = precios[l.productoId] ?? null;
                  const cambiado =
                    nuevo != null && nuevo !== l.precioUnitarioCentavos;
                  return (
                    <li
                      key={l.productoId}
                      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-semibold text-tinta-900">
                          {l.nombreCanonico}
                        </p>
                        <p className="text-[12px] text-tinta-500">
                          <span className="tabular-nums">
                            {cantidadCobrada(l)} {UNIDAD_CORTA[l.unidadMedida]}
                          </span>
                          {" · ahora "}
                          <Money centavos={l.precioUnitarioCentavos} tone="muted" />
                          {l.precioCatalogoCentavos != null ? (
                            <>
                              {" · catálogo "}
                              <Money
                                centavos={l.precioCatalogoCentavos}
                                tone="muted"
                              />
                            </>
                          ) : null}
                        </p>
                      </div>
                      <PrecioCampo
                        key={`${l.productoId}-${version}`}
                        centavos={nuevo}
                        onChange={(c) =>
                          setPrecios((prev) => ({ ...prev, [l.productoId]: c }))
                        }
                        etiqueta={`Precio nuevo de ${l.nombreCanonico}`}
                        destacado={cambiado}
                      />
                    </li>
                  );
                })}
              </ul>

              <div className="grid gap-1 rounded-campo bg-[var(--ink-50)] px-3 py-2 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="mst-label">
                    {entregado ? "Factura" : "Total del pedido"}
                  </span>
                  <span className="flex items-baseline gap-2">
                    {cambios.length > 0 ? (
                      <>
                        <Money centavos={totalAntes} tone="muted" />
                        <span aria-hidden>→</span>
                      </>
                    ) : null}
                    <Money centavos={totalDespues} className="text-base" />
                  </span>
                </div>
                {entregado ? (
                  <p className="text-[12px] text-tinta-500">
                    Calculado sobre lo entregado.
                  </p>
                ) : null}
              </div>

              {pedido.factura && cambios.length > 0 ? (
                bajoAbonado ? (
                  <Alert status="danger">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>El total quedaría debajo de lo abonado</Alert.Title>
                      <Alert.Description>
                        Esta factura ya tiene <Money centavos={abonado} /> abonados.
                        No se puede bajar más allá de eso.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : pedido.factura.numeroDte ? (
                  <Alert status="warning">
                    <Alert.Indicator />
                    <Alert.Content>
                      <Alert.Title>
                        La factura ya tiene DTE {pedido.factura.numeroDte}
                      </Alert.Title>
                      <Alert.Description>
                        Aquí se corrige el saldo del cliente. En el sistema de
                        facturación hay que emitir la nota de crédito o débito
                        por la diferencia.
                      </Alert.Description>
                    </Alert.Content>
                  </Alert>
                ) : null
              ) : null}

              <TextField isRequired value={motivo} onChange={setMotivo}>
                <Label>Motivo</Label>
                <TextArea
                  rows={2}
                  placeholder="Ej. se tomó con el precio viejo del catálogo"
                />
                <Description>
                  Obligatorio. Queda en el historial con tu usuario.
                </Description>
              </TextField>

              {error ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se ajustó</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </form>
          </Modal.Body>
          <Modal.Footer className="flex-wrap gap-2">
            <Button variant="tertiary" onPress={onClose}>
              Cancelar
            </Button>
            <Button
              form={formId}
              type="submit"
              variant="primary"
              className="w-full sm:w-auto"
              isDisabled={
                !motivo.trim() ||
                cambios.length === 0 ||
                incompletos ||
                bajoAbonado ||
                ajustar.isPending
              }
              isPending={ajustar.isPending}
            >
              {({ isPending }) => (
                <>
                  {isPending && <Spinner color="current" size="sm" />}
                  {cambios.length === 0
                    ? "Sin cambios"
                    : cambios.length === 1
                      ? "Corregir 1 precio"
                      : `Corregir ${cambios.length} precios`}
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
