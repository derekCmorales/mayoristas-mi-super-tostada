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
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type {
  AjustePrecioPedido,
  RecalcularPreciosResultado,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { EstadoBadge } from "@/components/domain/estado-badge";
import { Money } from "@/components/domain/money";

/**
 * Pasa el catálogo vigente a todos los pedidos de una operación. Primero
 * muestra qué cambiaría (el servidor no escribe nada en la vista previa) y
 * solo aplica con motivo. Pensado para el caso en que el catálogo estuvo mal
 * mientras se tomaban los pedidos de la noche.
 */
export function DialogoRecalcularPrecios({
  fechaOperacion,
  onClose,
}: {
  fechaOperacion: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const previa = useQuery({
    queryKey: ["pedidos", "recalcular-precios", fechaOperacion],
    queryFn: () =>
      api<RecalcularPreciosResultado>("/pedidos/recalcular-precios", {
        method: "POST",
        body: JSON.stringify({ fechaOperacion, aplicar: false }),
      }),
    staleTime: 0,
    gcTime: 0,
  });

  const aplicar = useMutation({
    mutationFn: () =>
      api<RecalcularPreciosResultado>("/pedidos/recalcular-precios", {
        method: "POST",
        body: JSON.stringify({ fechaOperacion, motivo, aplicar: true }),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      void qc.invalidateQueries({ queryKey: ["cartera"] });
      const hechos = r.pedidos.filter((p) => !p.omitido).length;
      toastSuccess(
        hechos === 1
          ? "1 pedido corregido"
          : `${hechos} pedidos corregidos`,
      );
      onClose();
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "No se pudo recalcular");
      toastFromError(err, "No se pudieron recalcular los precios");
    },
  });

  const pedidos = previa.data?.pedidos ?? [];
  const aplicables = pedidos.filter((p) => !p.omitido);
  const conDte = aplicables.filter((p) => p.ajustaFactura && p.numeroDte);
  const formId = `recalcular-${fechaOperacion}`;

  return (
    <Modal.Backdrop isOpen onOpenChange={(abierto) => !abierto && onClose()}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              Recalcular precios · operación{" "}
              {etiquetaDiaSemanaCorto(fechaOperacion)}
            </Modal.Heading>
            <p className="text-sm text-tinta-500">
              Pone el precio del catálogo actual en los pedidos de ese día que
              se tomaron con otro. Los entregados también corrigen su factura.
              Cantidades y producción no cambian.
            </p>
          </Modal.Header>
          <Modal.Body>
            <form
              id={formId}
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (motivo.trim() && aplicables.length > 0) aplicar.mutate();
              }}
            >
              {previa.isLoading ? (
                <p className="flex items-center gap-2 text-sm text-tinta-500">
                  <Spinner size="sm" /> Comparando con el catálogo…
                </p>
              ) : previa.isError ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se pudo comparar</Alert.Title>
                    <Alert.Description>
                      {previa.error instanceof ApiError
                        ? previa.error.message
                        : "Intente de nuevo."}
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : pedidos.length === 0 ? (
                <p className="rounded-campo bg-[var(--green-50)] px-3 py-3 text-sm text-tinta-800">
                  Todos los pedidos de ese día ya cuadran con el catálogo.
                </p>
              ) : (
                <ul className="grid max-h-[45vh] divide-y divide-[var(--border-subtle)] overflow-auto rounded-campo border border-[var(--border-subtle)]">
                  {pedidos.map((p) => (
                    <FilaPrevia key={p.pedidoId} pedido={p} />
                  ))}
                </ul>
              )}

              {conDte.length > 0 ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>
                      {conDte.length === 1
                        ? "1 factura ya tiene DTE"
                        : `${conDte.length} facturas ya tienen DTE`}
                    </Alert.Title>
                    <Alert.Description>
                      Aquí se corrige el saldo del cliente. En el sistema de
                      facturación hay que emitir la nota de crédito o débito:{" "}
                      {conDte.map((p) => p.numeroDte).join(", ")}.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}

              {aplicables.length > 0 ? (
                <TextField isRequired value={motivo} onChange={setMotivo}>
                  <Label>Motivo</Label>
                  <TextArea
                    rows={2}
                    placeholder="Ej. el catálogo tenía los precios de fábrica"
                  />
                  <Description>
                    Obligatorio. Queda en el historial de cada pedido con tu
                    usuario.
                  </Description>
                </TextField>
              ) : null}

              {error ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se aplicó</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}
            </form>
          </Modal.Body>
          <Modal.Footer className="flex-wrap gap-2">
            <Button variant="tertiary" onPress={onClose}>
              {aplicables.length > 0 ? "Cancelar" : "Cerrar"}
            </Button>
            {aplicables.length > 0 ? (
              <Button
                form={formId}
                type="submit"
                variant="primary"
                className="w-full sm:w-auto"
                isDisabled={!motivo.trim() || aplicar.isPending}
                isPending={aplicar.isPending}
              >
                {({ isPending }) => (
                  <>
                    {isPending && <Spinner color="current" size="sm" />}
                    {aplicables.length === 1
                      ? "Corregir 1 pedido"
                      : `Corregir ${aplicables.length} pedidos`}
                  </>
                )}
              </Button>
            ) : null}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function FilaPrevia({ pedido }: { pedido: AjustePrecioPedido }) {
  return (
    <li className="grid gap-1 px-3 py-2.5">
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <span className="font-mono text-xs tabular-nums text-tinta-500">
          #{pedido.correlativo}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-semibold text-tinta-900">
          {pedido.clienteNombre}
        </span>
        <EstadoBadge estado={pedido.estado} size="sm" />
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-[12px] text-tinta-500">
        <span className="min-w-0">
          {pedido.cambios.length === 1
            ? "1 precio"
            : `${pedido.cambios.length} precios`}
          {pedido.ajustaFactura ? " · corrige la factura" : null}
        </span>
        <span className="flex items-baseline gap-2">
          <Money centavos={pedido.totalAntesCentavos} tone="muted" />
          <span aria-hidden>→</span>
          <Money centavos={pedido.totalDespuesCentavos} />
        </span>
      </div>
      {pedido.omitido ? (
        <p className="text-[12px] font-semibold text-peligro">
          No se toca: {pedido.omitido}
        </p>
      ) : null}
    </li>
  );
}
