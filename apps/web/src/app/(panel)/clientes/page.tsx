"use client";

import {
  Alert,
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  SearchField,
  TextArea,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Users } from "lucide-react";
import { useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import {
  crearClienteRequestSchema,
  normalizarTelefonoWa,
  tienePermiso,
  type ActorPublico,
  type CarteraLista,
  type ClientePublico,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { subirFotoCliente } from "@/lib/upload-asset";
import {
  cobranzaDeCliente,
  compararClientesPorAlerta,
  nivelAlertaCliente,
  resumenClientes,
  resumenCobranzaPorCliente,
} from "@/lib/cliente-cobranza";
import { PanelShell } from "@/components/layout/panel-shell";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { FotoPicker } from "@/components/catalog/foto-picker";
import { ClienteMiniCard } from "@/components/catalog/cliente-mini-card";
import { ClientesResumen } from "@/components/catalog/clientes-resumen";
import {
  ayudaTelefonoWa,
  problemaWhatsapp,
} from "@/components/catalog/telefono-wa";

type FiltroActivo = "activos" | "todos" | "con_saldo" | "revisar_whatsapp";

const FILTROS = [
  { id: "activos", label: "Activos" },
  { id: "con_saldo", label: "Con saldo" },
  { id: "revisar_whatsapp", label: "Revisar WhatsApp" },
  { id: "todos", label: "Todos" },
] as const;

export default function ClientesPage() {
  return (
    <Suspense fallback={null}>
      <ClientesVista />
    </Suspense>
  );
}

function ClientesVista() {
  const qc = useQueryClient();
  const search = useSearchParams();
  const [q, setQ] = useState("");
  /* Configuración → Plantillas de Meta enlaza aquí con `?whatsapp=revisar`. */
  const [filtro, setFiltro] = useState<FiltroActivo>(
    search.get("whatsapp") === "revisar" ? "revisar_whatsapp" : "activos",
  );
  const [crear, setCrear] = useState(false);

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  const canWrite = tienePermiso(me.data?.usuario.permisos ?? [], "catalogo.escribir");
  const clientes = useQuery({
    queryKey: ["clientes"],
    queryFn: () => api<ClientePublico[]>("/clientes"),
  });
  const cartera = useQuery({
    queryKey: ["cartera", { estado: "pendientes", limit: 200 }],
    queryFn: () => api<CarteraLista>("/cartera?estado=pendientes&limit=200"),
    enabled: Boolean(me.data),
  });

  const cobranzaMap = useMemo(
    () => resumenCobranzaPorCliente(cartera.data?.items ?? []),
    [cartera.data],
  );

  const resumen = useMemo(
    () => (clientes.data ? resumenClientes(clientes.data, cobranzaMap) : null),
    [clientes.data, cobranzaMap],
  );

  /* El listado se ordena por gravedad de la cuenta y luego por nombre: quien
     está al límite se lee primero, sin barrer toda la cuadrícula. */
  const filtrados = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (clientes.data ?? [])
      .filter((c) => {
        if (filtro === "activos" && !c.activo) return false;
        if (filtro === "revisar_whatsapp" && (!c.activo || !problemaWhatsapp(c))) {
          return false;
        }
        if (
          filtro === "con_saldo" &&
          cobranzaDeCliente(c, cobranzaMap).facturasPendientes === 0
        ) {
          return false;
        }
        if (!needle) return true;
        /* El teléfono se guarda +50255551234: se busca también por dígitos. */
        return [c.nombre, c.contacto ?? "", c.telefonoWa ?? "", normalizarTelefonoWa(c.telefonoWa ?? "")]
          .join(" ")
          .toLowerCase()
          .includes(needle);
      })
      .map((cliente) => {
        const cobranza = cobranzaDeCliente(cliente, cobranzaMap);
        return {
          cliente,
          cobranza,
          nivel: nivelAlertaCliente(cliente, cobranza),
          nombre: cliente.nombre,
        };
      })
      .sort(compararClientesPorAlerta);
  }, [clientes.data, q, filtro, cobranzaMap]);

  const loading = clientes.isLoading || cartera.isLoading;
  const porRevisar = useMemo(
    () => (clientes.data ?? []).filter((c) => c.activo && problemaWhatsapp(c)).length,
    [clientes.data],
  );
  const total = clientes.data?.length ?? 0;

  return (
    <PanelShell title="Clientes">
      <div className="grid min-w-0 gap-5">
        <ClientesResumen resumen={resumen} cargando={loading} />

        <section className="grid gap-3" aria-label="Buscar y filtrar">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <SearchField
              aria-label="Buscar cliente"
              className="min-w-0 flex-1"
              value={q}
              onChange={setQ}
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Nombre, contacto o WhatsApp" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            {canWrite && (
              <Button
                className="button--accent shrink-0"
                variant="primary"
                onPress={() => setCrear(true)}
              >
                <Plus size={16} aria-hidden />
                Agregar cliente
              </Button>
            )}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <ToggleButtonGroup
              aria-label="Filtrar clientes"
              className="mst-segmento-activo"
              disallowEmptySelection
              selectedKeys={new Set([filtro])}
              selectionMode="single"
              size="sm"
              onSelectionChange={(keys) => {
                const next = [...keys][0];
                if (typeof next === "string") setFiltro(next as FiltroActivo);
              }}
            >
              {FILTROS.map((f, i) => (
                <ToggleButton key={f.id} id={f.id}>
                  {i > 0 && <ToggleButtonGroup.Separator />}
                  {f.label}
                  {f.id === "revisar_whatsapp" && porRevisar > 0 ? (
                    <span className="ml-1 tabular-nums text-peligro">{porRevisar}</span>
                  ) : null}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>

            {!loading && (
              <p className="mst-label tabular-nums" aria-live="polite">
                {filtrados.length} de {total}
              </p>
            )}
          </div>
        </section>

        {loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {Array.from({ length: 6 }, (_, i) => (
              <Skeleton key={i} className="h-52 w-full rounded-tarjeta" />
            ))}
          </div>
        ) : filtrados.length === 0 ? (
          <EmptyState
            icon={<Users size={22} aria-hidden />}
            title={q ? "Ningún cliente coincide" : "No hay clientes"}
            description={
              q
                ? "Pruebe con el nombre comercial, el contacto o el teléfono."
                : filtro === "con_saldo"
                  ? "Nadie tiene facturas pendientes ahora."
                  : filtro === "revisar_whatsapp"
                    ? "Todos los clientes activos tienen WhatsApp válido y enlace del portal."
                  : filtro === "activos"
                    ? "No hay clientes activos. Cambie a Todos o cree una ficha nueva."
                    : "Cree la ficha nueva. El portal y los alias viven dentro de cada cliente."
            }
            action={
              canWrite && !q && filtro !== "con_saldo" && filtro !== "revisar_whatsapp" ? (
                <Button
                  className="button--accent"
                  size="sm"
                  variant="primary"
                  onPress={() => setCrear(true)}
                >
                  Agregar cliente
                </Button>
              ) : null
            }
          />
        ) : (
          <ul className="grid min-w-0 gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {filtrados.map(({ cliente, cobranza }) => (
              <li key={cliente.id} className="min-w-0">
                <ClienteMiniCard cliente={cliente} cobranza={cobranza} />
              </li>
            ))}
          </ul>
        )}
      </div>

      <ClienteNuevoModal
        abierto={crear}
        onOpenChange={setCrear}
        onSaved={() => {
          qc.invalidateQueries({ queryKey: ["clientes"] });
          qc.invalidateQueries({ queryKey: ["cartera"] });
          setCrear(false);
        }}
      />
    </PanelShell>
  );
}

const VACIO = {
  nombre: "",
  contacto: "",
  telefonoWa: "",
  horarioEntregaFijo: "",
  notasPermanentes: "",
  limiteFacturasPendientes: "",
};

function ClienteNuevoModal({
  abierto,
  onOpenChange,
  onSaved,
}: {
  abierto: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const [foto, setFoto] = useState<File | null>(null);
  const [campos, setCampos] = useState(VACIO);
  const ayudaTel = ayudaTelefonoWa(campos.telefonoWa);

  const set = (k: keyof typeof VACIO) => (value: string) =>
    setCampos((prev) => ({ ...prev, [k]: value }));

  const guardar = useMutation({
    mutationFn: async () => {
      const limite = campos.limiteFacturasPendientes.trim();
      const parsed = crearClienteRequestSchema.safeParse({
        nombre: campos.nombre,
        contacto: campos.contacto.trim() || null,
        telefonoWa: campos.telefonoWa.trim() || null,
        horarioEntregaFijo: campos.horarioEntregaFijo.trim() || null,
        notasPermanentes: campos.notasPermanentes.trim() || null,
        limiteFacturasPendientes: limite ? Number(limite) : null,
      });
      if (!parsed.success) {
        const tel = parsed.error.issues.find((i) => i.path[0] === "telefonoWa");
        throw new Error(tel ? `Teléfono WhatsApp: ${tel.message}` : "Revise los datos del cliente");
      }

      const creado = await api<ClientePublico>("/clientes", {
        method: "POST",
        body: JSON.stringify(parsed.data),
      });

      /* La foto va en un segundo viaje: si falla, el cliente ya existe y la
         foto se agrega desde la ficha. No se pierde la captura. */
      if (foto) {
        try {
          const assetId = await subirFotoCliente(foto, creado.id);
          await api(`/clientes/${creado.id}`, {
            method: "PATCH",
            body: JSON.stringify({ fotoAssetId: assetId }),
          });
        } catch (err) {
          toastFromError(
            err,
            "Cliente guardado; la foto no se subió. Puede agregarla en la ficha.",
          );
          return creado;
        }
      }
      toastSuccess("Cliente guardado");
      return creado;
    },
    onSuccess: () => {
      setCampos(VACIO);
      setFoto(null);
      setError(null);
      onSaved();
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : "No se pudo guardar");
      if (err instanceof ApiError) toastFromError(err, "No se pudo guardar");
    },
  });

  return (
    <Modal.Backdrop isOpen={abierto} onOpenChange={onOpenChange}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Heading>Nuevo cliente</Modal.Heading>
            <p className="text-sm text-tinta-500">
              La foto ayuda a reconocer el restaurante en reparto y en el listado.
            </p>
          </Modal.Header>

          <Modal.Body>
            <form
              id="cliente-nuevo"
              className="grid gap-6"
              onSubmit={(e) => {
                e.preventDefault();
                guardar.mutate();
              }}
            >
              <FotoPicker value={foto} onChange={setFoto} />

              <fieldset className="grid gap-3">
                <legend className="mb-1 text-sm font-semibold text-tinta-900">
                  Identidad
                </legend>
                <TextField isRequired value={campos.nombre} onChange={set("nombre")}>
                  <Label>Nombre del restaurante</Label>
                  <Input placeholder="Ej. Kraken" />
                </TextField>
                <div className="grid gap-3 sm:grid-cols-2">
                  <TextField value={campos.contacto} onChange={set("contacto")}>
                    <Label>Contacto</Label>
                    <Input />
                  </TextField>
                  <TextField
                    type="tel"
                    value={campos.telefonoWa}
                    onChange={set("telefonoWa")}
                    isInvalid={ayudaTel.invalido}
                  >
                    <Label>Teléfono WhatsApp</Label>
                    <Input inputMode="tel" placeholder="5555 1234" />
                    {ayudaTel.invalido ? (
                      <FieldError>{ayudaTel.texto}</FieldError>
                    ) : (
                      <Description>{ayudaTel.texto}</Description>
                    )}
                  </TextField>
                </div>
              </fieldset>

              <fieldset className="grid gap-3 sm:grid-cols-2">
                <legend className="mb-1 text-sm font-semibold text-tinta-900 sm:col-span-2">
                  Entrega y cobranza
                </legend>
                <TextField
                  value={campos.horarioEntregaFijo}
                  onChange={set("horarioEntregaFijo")}
                >
                  <Label>Horario de entrega fijo</Label>
                  <Input placeholder="09:00" />
                  <Description>Formato 24 h, HH:MM</Description>
                </TextField>
                <TextField
                  value={campos.limiteFacturasPendientes}
                  onChange={set("limiteFacturasPendientes")}
                >
                  <Label>Límite de facturas pendientes</Label>
                  <Input inputMode="numeric" />
                  <Description>Como en el cuaderno de cobros</Description>
                </TextField>
              </fieldset>

              <TextField
                value={campos.notasPermanentes}
                onChange={set("notasPermanentes")}
              >
                <Label>Notas permanentes</Label>
                <TextArea rows={3} />
                <Description>Instrucciones que no cambian día a día</Description>
              </TextField>

              {error && (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>No se guardó</Alert.Title>
                    <Alert.Description>{error}</Alert.Description>
                  </Alert.Content>
                </Alert>
              )}
            </form>
          </Modal.Body>

          <Modal.Footer>
            <Button variant="tertiary" onPress={() => onOpenChange(false)}>
              Cerrar
            </Button>
            <Button
              form="cliente-nuevo"
              isDisabled={guardar.isPending}
              type="submit"
              variant="primary"
            >
              {guardar.isPending ? "Un momento…" : "Guardar cliente"}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
