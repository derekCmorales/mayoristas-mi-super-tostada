"use client";

import { Button, Modal, Spinner } from "@heroui/react";
import type { OperacionResumen } from "@misupertostada/shared";

export function DialogoCierre({
  open,
  resumen,
  loading,
  onClose,
  onConfirm,
}: {
  open: boolean;
  resumen: OperacionResumen | undefined;
  loading: boolean;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const preview = resumen?.previewCierre;
  const corrigiendo = resumen?.diaEstado === "REABIERTO";
  return (
    <Modal.Backdrop
      isOpen={open}
      onOpenChange={(abierto) => {
        if (!abierto) onClose();
      }}
    >
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              {corrigiendo
                ? "Volver a cerrar y corregir la hoja"
                : "Cerrar ventana y generar hoja"}
            </Modal.Heading>
            <p className="text-sm leading-relaxed text-pretty text-tinta-500">
              {corrigiendo
                ? "Sale la hoja corregida con los cambios resaltados. La que ya imprimieron queda vieja: hay que volver a imprimir o revisar los cambios en Producción."
                : "Se materializa la hoja de producción y queda visible en Producción y Reparto. Después de esto, reabrir el día requiere motivo."}
            </p>
          </Modal.Header>

          <Modal.Body>
            <dl className="grid gap-0 rounded-tarjeta border border-[var(--border-subtle)] text-sm">
              <Fila
                etiqueta="Pedidos confirmados"
                valor={preview?.confirmados ?? 0}
              />
              <Fila
                etiqueta="Borradores que quedan fuera"
                valor={preview?.borradores ?? 0}
                ultima
              />
            </dl>
          </Modal.Body>

          <Modal.Footer>
            <Button isDisabled={loading} variant="tertiary" onPress={onClose}>
              Cancelar
            </Button>
            <Button isPending={loading} variant="primary" onPress={onConfirm}>
              {({ isPending }) => (
                <>
                  {isPending && <Spinner color="current" size="sm" />}
                  {corrigiendo ? "Cerrar y corregir" : "Cerrar y generar"}
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function Fila({
  etiqueta,
  valor,
  ultima,
}: {
  etiqueta: string;
  valor: number;
  ultima?: boolean;
}) {
  return (
    <div
      className={
        ultima
          ? "flex items-center justify-between gap-4 px-4 py-2.5"
          : "flex items-center justify-between gap-4 border-b border-[var(--border-subtle)] px-4 py-2.5"
      }
    >
      <dt className="min-w-0 text-pretty text-tinta-500">{etiqueta}</dt>
      <dd className="shrink-0 font-semibold tabular-nums text-tinta-900">{valor}</dd>
    </div>
  );
}
