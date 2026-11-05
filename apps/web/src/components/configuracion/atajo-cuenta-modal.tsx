"use client";

import {
  Alert,
  Button,
  Chip,
  Description,
  Input,
  Label,
  Modal,
  TextField,
} from "@heroui/react";
import { useMutation } from "@tanstack/react-query";
import { Copy, RefreshCw } from "lucide-react";
import { useState } from "react";
import {
  resumenPlantilla,
  sugerirUsername,
  usernameSchema,
  type ActorPublico,
  type PerfilCuenta,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { generarClave } from "@/lib/clave";
import { toastSuccess } from "@/lib/toast";

/**
 * Atajo para crear la cuenta de un puesto en un paso: usuario sugerido, contraseña generada y
 * la plantilla de mínimo privilegio del puesto (`ROL_PERMISOS`). Solo manda el `rol`; el
 * servidor siembra la plantilla exacta. Lo extra se delega después en el detalle de la cuenta.
 *
 * La contraseña se muestra una sola vez, al terminar, para copiarla y entregarla.
 */
export function AtajoCuentaModal({
  perfil,
  existentes,
  onClose,
  onCreated,
}: {
  perfil: PerfilCuenta;
  existentes: readonly string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = useState(() =>
    sugerirUsername(perfil.usuarioBase, existentes),
  );
  const [password, setPassword] = useState(() => generarClave());
  const [creada, setCreada] = useState<{ username: string; password: string } | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const plantilla = resumenPlantilla(perfil.rol);
  const usuarioValido = usernameSchema.safeParse(username);

  const crear = useMutation({
    mutationFn: () =>
      api<ActorPublico>("/usuarios", {
        method: "POST",
        body: JSON.stringify({
          username: usuarioValido.success ? usuarioValido.data : username,
          password,
          rol: perfil.rol,
        }),
      }),
    onSuccess: (u) => {
      setCreada({ username: u.username, password });
      setError(null);
      onCreated();
    },
    onError: (err) =>
      setError(err instanceof ApiError ? err.message : "No se pudo crear la cuenta"),
  });

  function copiarAcceso() {
    if (!creada) return;
    const texto = [
      `Usuario: ${creada.username}`,
      `Contraseña: ${creada.password}`,
      `Entrar en: ${window.location.origin}/login`,
    ].join("\n");
    void navigator.clipboard.writeText(texto);
    toastSuccess("Acceso copiado");
  }

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>
              {creada ? "Cuenta creada" : `Nueva cuenta · ${perfil.etiqueta}`}
            </Modal.Heading>
            <p className="text-sm text-pretty text-tinta-500">
              {creada
                ? "Copie el acceso y entrégueselo a la persona. La contraseña no se vuelve a mostrar; si la pierde, restablézcala desde la cuenta."
                : perfil.resumen}
            </p>
          </Modal.Header>

          <Modal.Body className="grid gap-4">
            {creada ? (
              <dl className="grid gap-2 rounded-campo bg-tinta-50 p-3 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-tinta-500">Usuario</dt>
                  <dd className="font-mono font-semibold text-tinta-900">
                    {creada.username}
                  </dd>
                </div>
                <div className="flex flex-wrap justify-between gap-2">
                  <dt className="text-tinta-500">Contraseña</dt>
                  <dd className="font-mono font-semibold break-all text-tinta-900">
                    {creada.password}
                  </dd>
                </div>
              </dl>
            ) : (
              <>
                <div className="grid gap-2">
                  <p className="mst-label">Entra a</p>
                  <div className="flex flex-wrap gap-1.5">
                    {plantilla.modulos.map((m) => (
                      <Chip key={m.id} size="sm" variant="soft">
                        {m.etiqueta}
                      </Chip>
                    ))}
                  </div>
                  {plantilla.acciones.length > 0 ? (
                    <ul className="list-disc pl-5 text-xs leading-relaxed text-tinta-600">
                      {plantilla.acciones.map((a) => (
                        <li key={a}>{a}</li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-xs text-tinta-600">Solo lectura.</p>
                  )}
                  <p className="text-xs text-tinta-500">
                    Todo lo demás queda cerrado. Si hace falta, se delega
                    después desde el detalle de la cuenta.
                  </p>
                </div>

                <TextField
                  isRequired
                  isInvalid={!usuarioValido.success && username.length > 0}
                  value={username}
                  onChange={(v) => {
                    setUsername(v);
                    setError(null);
                  }}
                >
                  <Label>Usuario</Label>
                  <Input autoComplete="off" spellCheck={false} />
                  <Description>
                    Con esto entra al panel. No se cambia después.
                  </Description>
                </TextField>

                <div className="grid gap-1.5">
                  <p className="mst-label">Contraseña generada</p>
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 rounded-campo bg-tinta-50 px-3 py-2 font-mono text-sm break-all text-tinta-900">
                      {password}
                    </code>
                    <Button
                      isIconOnly
                      aria-label="Generar otra contraseña"
                      size="sm"
                      variant="tertiary"
                      onPress={() => setPassword(generarClave())}
                    >
                      <RefreshCw size={16} aria-hidden />
                    </Button>
                  </div>
                  <p className="text-xs text-tinta-500">
                    Fácil de dictar: sin 0, o, 1, l ni i.
                  </p>
                </div>
              </>
            )}

            {error && (
              <Alert status="danger">
                <Alert.Indicator />
                <Alert.Content>
                  <Alert.Title>No se creó la cuenta</Alert.Title>
                  <Alert.Description>{error}</Alert.Description>
                </Alert.Content>
              </Alert>
            )}
          </Modal.Body>

          <Modal.Footer className="flex-wrap">
            {creada ? (
              <>
                <Button variant="tertiary" onPress={onClose}>
                  Listo
                </Button>
                <Button variant="primary" onPress={copiarAcceso}>
                  <Copy size={16} aria-hidden />
                  Copiar acceso
                </Button>
              </>
            ) : (
              <>
                <Button variant="tertiary" onPress={onClose}>
                  Cancelar
                </Button>
                <Button
                  isDisabled={!usuarioValido.success || crear.isPending}
                  variant="primary"
                  onPress={() => crear.mutate()}
                >
                  {crear.isPending ? "Un momento…" : "Crear cuenta"}
                </Button>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
