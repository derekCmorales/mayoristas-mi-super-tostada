"use client";

import {
  Alert,
  Button,
  Card,
  Description,
  Input,
  Label,
  Modal,
  TextArea,
  TextField,
} from "@heroui/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CONFIRMACION_ELIMINAR_CLIENTE,
  type EliminarClienteResponse,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { toastSuccess } from "@/lib/toast";

/**
 * Borrado permanente. Solo se monta para ADMIN_JEFE (el servidor lo vuelve a exigir) y pide
 * escribir ELIMINAR: desactivar es el camino normal; esto no se deshace.
 * El servidor rechaza clientes con pedidos o pagos (`CLIENTE_CON_HISTORIAL`).
 */
export function EliminarClienteCard({
  clienteId,
  nombre,
}: {
  clienteId: string;
  nombre: string;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const [abierto, setAbierto] = useState(false);
  const [confirmacion, setConfirmacion] = useState("");
  const [motivo, setMotivo] = useState("");
  const [error, setError] = useState<string | null>(null);

  const listo = confirmacion.trim() === CONFIRMACION_ELIMINAR_CLIENTE;

  const eliminar = useMutation({
    mutationFn: () =>
      api<EliminarClienteResponse>(`/clientes/${clienteId}`, {
        method: "DELETE",
        body: JSON.stringify({
          confirmacion: confirmacion.trim(),
          motivo: motivo.trim() || null,
        }),
      }),
    onSuccess: () => {
      toastSuccess(`${nombre} eliminado`);
      qc.removeQueries({ queryKey: ["clientes", clienteId] });
      void qc.invalidateQueries({ queryKey: ["clientes"] });
      void qc.invalidateQueries({ queryKey: ["conversaciones"] });
      router.replace("/clientes");
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "No se pudo eliminar"),
  });

  function cerrar() {
    setAbierto(false);
    setConfirmacion("");
    setMotivo("");
    setError(null);
  }

  return (
    <>
      <Card className="gap-3 border-[var(--red-100)] p-4 sm:p-5">
        <Card.Header>
          <Card.Title className="text-base text-tinta-900">
            Eliminar cliente
          </Card.Title>
          <Card.Description>
            Lo borra por completo: ficha, precios, bonos sin usar y su chat de
            WhatsApp. No se puede deshacer. Solo procede si nunca tuvo pedidos
            ni pagos; si los tuvo, desactívelo.
          </Card.Description>
        </Card.Header>
        <Card.Footer>
          <Button
            className="w-full sm:w-auto"
            size="sm"
            variant="danger"
            onPress={() => setAbierto(true)}
          >
            Eliminar definitivamente
          </Button>
        </Card.Footer>
      </Card>

      <Modal.Backdrop
        isOpen={abierto}
        onOpenChange={(open) => {
          if (!open) cerrar();
        }}
      >
        <Modal.Container size="md">
          <Modal.Dialog>
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>Eliminar a {nombre}</Modal.Heading>
              <p className="text-sm text-pretty text-tinta-500">
                Esta acción es permanente. Queda registrada en la bitácora con
                su usuario.
              </p>
            </Modal.Header>
            <Modal.Body className="grid gap-4">
              <TextField
                autoComplete="off"
                value={confirmacion}
                onChange={(v) => {
                  setConfirmacion(v);
                  setError(null);
                }}
              >
                <Label>
                  Escriba{" "}
                  <span className="font-mono font-semibold">
                    {CONFIRMACION_ELIMINAR_CLIENTE}
                  </span>{" "}
                  para confirmar
                </Label>
                <Input
                  autoCapitalize="characters"
                  placeholder={CONFIRMACION_ELIMINAR_CLIENTE}
                  spellCheck={false}
                />
              </TextField>
              <TextField value={motivo} onChange={setMotivo}>
                <Label>Motivo (opcional)</Label>
                <TextArea rows={2} placeholder="Ej. duplicado, creado por error" />
                <Description>Se guarda en la bitácora.</Description>
              </TextField>
              {error && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se eliminó</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </Modal.Body>
            <Modal.Footer className="flex-wrap">
              <Button variant="secondary" onPress={cerrar}>
                Cancelar
              </Button>
              <Button
                isDisabled={!listo || eliminar.isPending}
                variant="danger"
                onPress={() => eliminar.mutate()}
              >
                {eliminar.isPending ? "Eliminando…" : "Eliminar definitivamente"}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </>
  );
}
