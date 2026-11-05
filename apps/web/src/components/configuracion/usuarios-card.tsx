"use client";

import {
  Alert,
  Button,
  Card,
  Checkbox,
  Chip,
  Description,
  Input,
  Label,
  ListBox,
  Modal,
  Select,
  Table,
  TextField,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, UserCog } from "lucide-react";
import { useMemo, useState } from "react";
import {
  MODULOS_ACCESO,
  PERFILES_CUENTA,
  ROL_ETIQUETA,
  ROLES,
  modulosDePermisos,
  modulosDePlantilla,
  tieneModulo,
  type ActorPublico,
  type ModuloAccesoId,
  type PerfilCuenta,
  type Rol,
} from "@misupertostada/shared";
import { api } from "@/lib/api";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { EmptyState } from "@/components/ui/empty-state";
import { RowSkeleton } from "@/components/ui/skeleton";
import { AtajoCuentaModal } from "./atajo-cuenta-modal";

const ROL_CONSECUENCIA: Record<Rol, string> = {
  ADMIN_JEFE: "Ve todos los módulos y es el único que administra cuentas.",
  ADMIN: "Puesto de oficina; el menú móvil prioriza el día operativo.",
  PRODUCCION: "Puesto de planta; el menú móvil prioriza la hoja.",
  TIENDA: "Puesto de mostrador; el menú móvil prioriza pedidos y cartera.",
  REPARTO: "Puesto de ruta; el menú móvil prioriza reparto y cobro.",
};

const MIN_CLAVE = 10;

const PUESTOS_CREABLES = ROLES.filter((r) => r !== "ADMIN_JEFE") as Rol[];

export function UsuariosCard() {
  const qc = useQueryClient();
  const [crear, setCrear] = useState(false);
  const [detalle, setDetalle] = useState<ActorPublico | null>(null);
  const [clave, setClave] = useState<ActorPublico | null>(null);
  const [atajo, setAtajo] = useState<PerfilCuenta | null>(null);

  const lista = useQuery({
    queryKey: ["usuarios"],
    queryFn: () => api<ActorPublico[]>("/usuarios"),
  });

  const usuarios = useMemo(() => lista.data ?? [], [lista.data]);
  const activos = usuarios.filter((u) => u.activo).length;

  return (
    <Card className="w-full">
      <Card.Header className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <Card.Title>Usuarios</Card.Title>
          <Card.Description>
            Cuentas internas del panel. Nada se borra: se desactiva, y el
            historial de esa cuenta se conserva.
          </Card.Description>
        </div>
        <Button
          className="shrink-0"
          size="sm"
          variant="primary"
          onPress={() => setCrear(true)}
        >
          <Plus size={16} aria-hidden />
          Nuevo usuario
        </Button>
      </Card.Header>

      {/* Atajos por puesto: cuenta lista en un paso con la plantilla de mínimo privilegio. */}
      <div className="grid gap-2 border-t border-[var(--border-subtle)] px-4 py-3 sm:px-5">
        <p className="mst-label">Crear rápido por puesto</p>
        <div className="flex flex-wrap gap-2">
          {PERFILES_CUENTA.map((p) => (
            <Button
              key={p.id}
              size="sm"
              variant="secondary"
              onPress={() => setAtajo(p)}
            >
              {p.etiqueta}
            </Button>
          ))}
        </div>
        <p className="text-xs text-tinta-500">
          Usuario sugerido, contraseña generada y solo los módulos que el
          puesto usa. Para algo a la medida, use «Nuevo usuario».
        </p>
      </div>

      <Card.Content className="p-0">
        {lista.isLoading ? (
          <RowSkeleton rows={4} />
        ) : (
          <div className="overflow-x-auto">
          <Table>
            <Table.ScrollContainer>
              <Table.Content
                aria-label="Cuentas internas"
                className="min-w-[560px]"
              >
                <Table.Header>
                  <Table.Column isRowHeader id="usuario">
                    Usuario
                  </Table.Column>
                  <Table.Column id="puesto">Puesto</Table.Column>
                  <Table.Column id="modulos">Módulos</Table.Column>
                  <Table.Column id="estado">Estado</Table.Column>
                  <Table.Column id="accion">Detalle</Table.Column>
                </Table.Header>
                <Table.Body
                  items={usuarios}
                  renderEmptyState={() => (
                    <EmptyState
                      icon={<UserCog size={22} aria-hidden />}
                      title="No hay cuentas todavía"
                      description="Cree la cuenta y marque qué módulos del panel verá esa persona."
                      action={
                        <Button
                          size="sm"
                          variant="primary"
                          onPress={() => setCrear(true)}
                        >
                          Nuevo usuario
                        </Button>
                      }
                    />
                  )}
                >
                  {(u: ActorPublico) => (
                    <Table.Row id={u.id}>
                      <Table.Cell className="font-semibold text-tinta-900">
                        {u.username}
                      </Table.Cell>
                      <Table.Cell className="text-tinta-700">
                        {ROL_ETIQUETA[u.rol]}
                      </Table.Cell>
                      <Table.Cell className="tabular-nums text-tinta-500">
                        {resumenModulos(u)}
                      </Table.Cell>
                      <Table.Cell>
                        <Chip
                          color={u.activo ? "success" : "warning"}
                          size="sm"
                          variant="soft"
                        >
                          {u.activo ? "Activa" : "Inactiva"}
                        </Chip>
                      </Table.Cell>
                      <Table.Cell className="text-right">
                        <Button
                          aria-label={`Abrir la cuenta de ${u.username}`}
                          size="sm"
                          variant="tertiary"
                          onPress={() => setDetalle(u)}
                        >
                          Abrir
                        </Button>
                      </Table.Cell>
                    </Table.Row>
                  )}
                </Table.Body>
              </Table.Content>
            </Table.ScrollContainer>
          </Table>
          </div>
        )}
      </Card.Content>

      <Card.Footer className="justify-between">
        <p className="mst-label tabular-nums" aria-live="polite">
          {lista.isLoading
            ? "Cargando cuentas…"
            : `${activos} activas de ${usuarios.length}`}
        </p>
      </Card.Footer>

      <CrearModal
        abierto={crear}
        onOpenChange={setCrear}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["usuarios"] });
          setCrear(false);
        }}
      />
      {detalle ? (
        <DetalleModal
          usuario={detalle}
          onClose={() => setDetalle(null)}
          onReset={() => {
            setClave(detalle);
            setDetalle(null);
          }}
          onChanged={(next) => {
            qc.invalidateQueries({ queryKey: ["usuarios"] });
            setDetalle(next);
          }}
        />
      ) : null}
      {atajo ? (
        <AtajoCuentaModal
          perfil={atajo}
          existentes={usuarios.map((u) => u.username)}
          onClose={() => setAtajo(null)}
          onCreated={() => qc.invalidateQueries({ queryKey: ["usuarios"] })}
        />
      ) : null}
      {clave ? (
        <ResetModal
          usuario={clave}
          onClose={() => setClave(null)}
          onOk={() => setClave(null)}
        />
      ) : null}
    </Card>
  );
}

function resumenModulos(u: ActorPublico): string {
  if (u.rol === "ADMIN_JEFE") return "Todos";
  const n = modulosDePermisos(u.permisos).length;
  return n === 0 ? "Ninguno" : String(n);
}

const VACIO = { username: "", password: "" };

function CrearModal({
  abierto,
  onOpenChange,
  onSaved,
}: {
  abierto: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [campos, setCampos] = useState(VACIO);
  const [rol, setRol] = useState<Rol>("ADMIN");
  const [modulos, setModulos] = useState<ModuloAccesoId[]>(() =>
    modulosDePlantilla("ADMIN"),
  );
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof VACIO) => (value: string) =>
    setCampos((prev) => ({ ...prev, [k]: value }));

  const elegirPuesto = (value: Rol) => {
    setRol(value);
    setModulos(modulosDePlantilla(value));
  };

  const toggleModulo = (id: ModuloAccesoId, on: boolean) => {
    setModulos((prev) =>
      on ? (prev.includes(id) ? prev : [...prev, id]) : prev.filter((m) => m !== id),
    );
  };

  const guardar = useMutation({
    mutationFn: () =>
      api("/usuarios", {
        method: "POST",
        body: JSON.stringify({
          username: campos.username.trim(),
          password: campos.password,
          rol,
          modulos,
        }),
      }),
    onSuccess: () => {
      toastSuccess("Cuenta creada");
      setCampos(VACIO);
      setRol("ADMIN");
      setModulos(modulosDePlantilla("ADMIN"));
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "No se pudo crear");
      toastFromError(err, "Ocurrió un error");
    },
  });

  const listo =
    campos.username.trim().length > 0 &&
    campos.password.length >= MIN_CLAVE &&
    modulos.length > 0;

  return (
    <Modal.Backdrop isOpen={abierto} onOpenChange={onOpenChange}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Nuevo usuario</Modal.Heading>
            <p className="text-sm text-tinta-500">
              La cuenta queda activa de una vez. Marque los módulos del panel
              que verá esta persona.
            </p>
          </Modal.Header>

          <Modal.Body>
            <form
              id="usuario-nuevo"
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (listo) guardar.mutate();
              }}
            >
              <TextField
                isRequired
                value={campos.username}
                onChange={set("username")}
              >
                <Label>Usuario</Label>
                <Input autoComplete="off" placeholder="Ej. carla" />
                <Description>Con esto entra al panel. No se cambia después.</Description>
              </TextField>

              <TextField
                isRequired
                type="password"
                value={campos.password}
                onChange={set("password")}
              >
                <Label>Contraseña</Label>
                <Input autoComplete="new-password" />
                <Description>Mínimo {MIN_CLAVE} caracteres.</Description>
              </TextField>

              <Select
                placeholder="Elija el puesto"
                value={rol}
                onChange={(value) => {
                  if (typeof value === "string") elegirPuesto(value as Rol);
                }}
              >
                <Label>Puesto</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Description>
                  Solo ordena el menú en el celular. Los módulos de abajo
                  definen a qué entra.
                </Description>
                <Select.Popover>
                  <ListBox>
                    {PUESTOS_CREABLES.map((r) => (
                      <ListBox.Item key={r} id={r} textValue={ROL_ETIQUETA[r]}>
                        {ROL_ETIQUETA[r]}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <div className="grid gap-3">
                <div>
                  <p className="mst-label">Módulos del panel</p>
                  <p className="mt-1 text-xs leading-relaxed text-tinta-500">
                    {ROL_CONSECUENCIA[rol]} Puede ajustar las casillas antes de
                    crear.
                  </p>
                </div>
                {MODULOS_ACCESO.map((m) => (
                  <Checkbox
                    key={m.id}
                    isSelected={modulos.includes(m.id)}
                    onChange={(on) => toggleModulo(m.id, on)}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="grid gap-0.5">
                        <span className="font-medium text-tinta-900">
                          {m.etiqueta}
                        </span>
                        <span className="text-xs text-tinta-500">
                          {m.descripcion}
                        </span>
                      </span>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </div>

              {error && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se creó la cuenta</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </form>
          </Modal.Body>

          <Modal.Footer>
            <Button variant="tertiary" onPress={() => onOpenChange(false)}>
              Cancelar
            </Button>
            <Button
              form="usuario-nuevo"
              isDisabled={!listo || guardar.isPending}
              type="submit"
              variant="primary"
            >
              {guardar.isPending ? "Un momento…" : "Crear cuenta"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function DetalleModal({
  usuario,
  onClose,
  onReset,
  onChanged,
}: {
  usuario: ActorPublico;
  onClose: () => void;
  onReset: () => void;
  onChanged: (u: ActorPublico) => void;
}) {
  const rolMut = useMutation({
    mutationFn: (rol: Rol) =>
      api<ActorPublico>(`/usuarios/${usuario.id}/rol`, {
        method: "PATCH",
        body: JSON.stringify({ rol }),
      }),
    onSuccess: (u) => {
      toastSuccess("Puesto actualizado");
      onChanged(u);
    },
    onError: (err) => toastFromError(err, "Ocurrió un error"),
  });
  const activoMut = useMutation({
    mutationFn: (activo: boolean) =>
      activo
        ? api<ActorPublico>(`/usuarios/${usuario.id}/activar`, {
            method: "PATCH",
            body: JSON.stringify({ activo: true }),
          })
        : api<{ ok: true }>(`/usuarios/${usuario.id}/desactivar`, {
            method: "PATCH",
          }).then(() => ({ ...usuario, activo: false })),
    onSuccess: (u) => {
      toastSuccess(u.activo ? "Cuenta reactivada" : "Cuenta desactivada");
      onChanged(u);
    },
    onError: (err) => toastFromError(err, "Ocurrió un error"),
  });
  const moduloMut = useMutation({
    mutationFn: (body: { modulo: ModuloAccesoId; granted: boolean }) =>
      api<ActorPublico>(`/usuarios/${usuario.id}/modulos`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: (u) => onChanged(u),
    onError: (err) => toastFromError(err, "Ocurrió un error"),
  });

  const esJefe = usuario.rol === "ADMIN_JEFE";

  return (
    <Modal.Backdrop
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>{usuario.username}</Modal.Heading>
            <div className="flex flex-wrap items-center gap-2">
              <Chip
                color={usuario.activo ? "success" : "warning"}
                size="sm"
                variant="soft"
              >
                {usuario.activo ? "Cuenta activa" : "Cuenta inactiva"}
              </Chip>
              <Chip size="sm" variant="soft">
                {ROL_ETIQUETA[usuario.rol]}
              </Chip>
            </div>
          </Modal.Header>

          <Modal.Body>
            <div className="grid gap-6">
              <Select
                value={usuario.rol}
                onChange={(value) => {
                  if (typeof value === "string" && value !== usuario.rol) {
                    rolMut.mutate(value as Rol);
                  }
                }}
              >
                <Label>Puesto</Label>
                <Select.Trigger>
                  <Select.Value />
                  <Select.Indicator />
                </Select.Trigger>
                <Description>{ROL_CONSECUENCIA[usuario.rol]}</Description>
                <Select.Popover>
                  <ListBox>
                    {ROLES.map((r) => (
                      <ListBox.Item key={r} id={r} textValue={ROL_ETIQUETA[r]}>
                        {ROL_ETIQUETA[r]}
                        <ListBox.ItemIndicator />
                      </ListBox.Item>
                    ))}
                  </ListBox>
                </Select.Popover>
              </Select>

              <div className="grid gap-3">
                <div>
                  <p className="mst-label">Módulos del panel</p>
                  <p className="mt-1 text-xs leading-relaxed text-tinta-500">
                    {esJefe
                      ? "El administrador jefe ve todo; no se edita módulo a módulo."
                      : "Cada casilla se guarda sola. Quitar una saca el módulo del menú en la próxima carga."}
                  </p>
                </div>

                {MODULOS_ACCESO.map((m) => (
                  <Checkbox
                    key={m.id}
                    isDisabled={esJefe || moduloMut.isPending}
                    isSelected={esJefe || tieneModulo(usuario.permisos, m.id)}
                    onChange={(granted) =>
                      moduloMut.mutate({ modulo: m.id, granted })
                    }
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                      <span className="grid gap-0.5">
                        <span className="font-medium text-tinta-900">
                          {m.etiqueta}
                        </span>
                        <span className="text-xs text-tinta-500">
                          {m.descripcion}
                        </span>
                      </span>
                    </Checkbox.Content>
                  </Checkbox>
                ))}
              </div>
            </div>
          </Modal.Body>

          <Modal.Footer className="justify-between">
            <Button variant="tertiary" onPress={onReset}>
              Restablecer clave
            </Button>
            {usuario.activo ? (
              <Button
                isDisabled={activoMut.isPending}
                variant="danger"
                onPress={() => activoMut.mutate(false)}
              >
                {activoMut.isPending ? "Un momento…" : "Desactivar cuenta"}
              </Button>
            ) : (
              <Button
                isDisabled={activoMut.isPending}
                variant="primary"
                onPress={() => activoMut.mutate(true)}
              >
                {activoMut.isPending ? "Un momento…" : "Reactivar cuenta"}
              </Button>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function ResetModal({
  usuario,
  onClose,
  onOk,
}: {
  usuario: ActorPublico;
  onClose: () => void;
  onOk: () => void;
}) {
  const [password, setPassword] = useState("");
  const mut = useMutation({
    mutationFn: () =>
      api(`/usuarios/${usuario.id}/password`, {
        method: "PATCH",
        body: JSON.stringify({ password }),
      }),
    onSuccess: () => {
      toastSuccess("Clave actualizada");
      setPassword("");
      onOk();
    },
    onError: (err) => toastFromError(err, "Ocurrió un error"),
  });

  const listo = password.length >= MIN_CLAVE;

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
            <Modal.Heading>Clave de {usuario.username}</Modal.Heading>
            <p className="text-sm text-tinta-500">
              La sesión abierta de esta persona se corta y tiene que entrar con
              la clave nueva.
            </p>
          </Modal.Header>

          <Modal.Body>
            <form
              id="usuario-clave"
              onSubmit={(e) => {
                e.preventDefault();
                if (listo) mut.mutate();
              }}
            >
              <TextField
                isRequired
                type="password"
                value={password}
                onChange={setPassword}
              >
                <Label>Nueva contraseña</Label>
                <Input autoComplete="new-password" />
                <Description>Mínimo {MIN_CLAVE} caracteres.</Description>
              </TextField>
            </form>
          </Modal.Body>

          <Modal.Footer>
            <Button variant="tertiary" onPress={onClose}>
              Cancelar
            </Button>
            <Button
              form="usuario-clave"
              isDisabled={!listo || mut.isPending}
              type="submit"
              variant="primary"
            >
              {mut.isPending ? "Un momento…" : "Guardar clave"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
