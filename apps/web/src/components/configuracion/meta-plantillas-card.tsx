"use client";

import {
  Alert,
  AlertDialog,
  Button,
  Card,
  Chip,
  Input,
  Label,
  ListBox,
  Modal,
  SearchField,
  Select,
  Switch,
  TextField,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import { es } from "date-fns/locale";
import {
  Archive,
  CheckCircle2,
  ChevronRight,
  Clock3,
  CopyPlus,
  FileText,
  PauseCircle,
  PencilLine,
  Plus,
  Power,
  RefreshCw,
  Trash2,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import {
  META_CATEGORIA_ETIQUETA,
  META_PLANTILLA_STATUS_ETIQUETA,
  PLANTILLA_PROPOSITOS,
  PROPOSITO_ETIQUETA,
  borradorDeComponentes,
  PROPOSITOS_AUTOMATICOS,
  extraerCuerpoPlantilla,
  motivoRechazoLegible,
  type ConexionWabaPublica,
  type EnvioAutomaticoEstado,
  type PlantillaMeta,
  type PlantillaProposito,
} from "@misupertostada/shared";
import { api } from "@/lib/api";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/ui/empty-state";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Skeleton } from "@/components/ui/skeleton";
import {
  IDIOMA_ETIQUETA,
  PlantillaFormulario,
  type ModoFormulario,
} from "./plantilla-formulario";
import { PlantillaVistaWhatsApp } from "./plantilla-vista-whatsapp";

const CLAVE = ["mensajeria", "meta", "plantillas"] as const;
const EDITABLES = new Set(["APPROVED", "REJECTED", "PAUSED"]);

type Grupo = "vigentes" | "aprobadas" | "revision" | "atencion" | "retiradas";

function grupoDe(status: string): Exclude<Grupo, "vigentes"> {
  if (status === "APPROVED") return "aprobadas";
  if (status === "PENDING" || status === "IN_APPEAL") return "revision";
  if (status === "DELETED" || status === "PENDING_DELETION") return "retiradas";
  return "atencion";
}

type Tono = { icon: LucideIcon; chip: "success" | "warning" | "danger" | undefined; acento: string };

/* El color dice qué hacer: verde se puede usar, ámbar esperar, rojo corregir. */
function tonoDe(status: string): Tono {
  switch (grupoDe(status)) {
    case "aprobadas":
      return { icon: CheckCircle2, chip: "success", acento: "bg-marca" };
    case "revision":
      return { icon: Clock3, chip: "warning", acento: "bg-[var(--amber-600)]" };
    case "retiradas":
      return { icon: Archive, chip: undefined, acento: "bg-[var(--ink-300)]" };
    default:
      return {
        icon: status === "PAUSED" ? PauseCircle : XCircle,
        chip: "danger",
        acento: "bg-peligro",
      };
  }
}

const CALIDAD: Record<string, { etiqueta: string; clase: string }> = {
  GREEN: { etiqueta: "Calidad alta", clase: "bg-marca" },
  YELLOW: { etiqueta: "Calidad media", clase: "bg-[var(--amber-600)]" },
  RED: { etiqueta: "Calidad baja", clase: "bg-peligro" },
};

function etiquetaStatus(status: string): string {
  return META_PLANTILLA_STATUS_ETIQUETA[status] ?? status;
}

function hace(iso: string | null): string | null {
  if (!iso) return null;
  return formatDistanceToNow(new Date(iso), { addSuffix: true, locale: es });
}

/** `mst_aviso_v1` → `mst_aviso_v2`; sin sufijo, agrega `_v2`. Salta nombres ocupados. */
function siguienteVersion(name: string, ocupados: ReadonlySet<string>): string {
  const m = name.match(/^(.*)_v(\d+)$/);
  const base = m ? m[1]! : name;
  let n = m ? Number(m[2]) + 1 : 2;
  while (ocupados.has(`${base}_v${n}`)) n += 1;
  return `${base}_v${n}`.slice(0, 512);
}

/**
 * Configuración → Plantillas de Meta. Todo lo que el negocio tiene aprobado en
 * Meta para escribirle a sus clientes fuera de la ventana de 24 h, con su
 * estado de revisión y qué aviso automático usa cada una.
 */
export function MetaPlantillasCard() {
  const qc = useQueryClient();
  const [grupo, setGrupo] = useState<Grupo>("vigentes");
  const [q, setQ] = useState("");
  const [detalle, setDetalle] = useState<PlantillaMeta | null>(null);
  const [formulario, setFormulario] = useState<ModoFormulario | null>(null);
  const [retirando, setRetirando] = useState<PlantillaMeta | null>(null);

  const conexion = useQuery({
    queryKey: ["mensajeria", "conexion"],
    queryFn: () => api<ConexionWabaPublica>("/mensajeria/conexion"),
  });
  const lista = useQuery({
    queryKey: CLAVE,
    queryFn: () => api<PlantillaMeta[]>("/mensajeria/meta/plantillas"),
  });

  function refrescar(data?: PlantillaMeta[]) {
    if (data) qc.setQueryData(CLAVE, data);
    else qc.invalidateQueries({ queryKey: CLAVE });
    /* El selector de plantillas del inbox lee otra lista: que no quede vieja. */
    qc.invalidateQueries({ queryKey: ["mensajeria", "plantillas"] });
  }

  const sync = useMutation<PlantillaMeta[], Error, void>({
    mutationFn: () => api<PlantillaMeta[]>("/mensajeria/meta/plantillas/sync", { method: "POST" }),
    onSuccess: (data) => {
      refrescar(data);
      toastSuccess("Plantillas al día con Meta");
    },
    onError: toastFromError,
  });

  const todas = useMemo(() => lista.data ?? [], [lista.data]);
  const conteo = useMemo(() => {
    const c: Record<Grupo, number> = { vigentes: 0, aprobadas: 0, revision: 0, atencion: 0, retiradas: 0 };
    for (const p of todas) {
      const g = grupoDe(p.status);
      c[g] += 1;
      if (g !== "retiradas") c.vigentes += 1;
    }
    return c;
  }, [todas]);

  const needle = q.trim().toLowerCase();
  const visibles = todas.filter((p) => {
    const g = grupoDe(p.status);
    const enGrupo = grupo === "vigentes" ? g !== "retiradas" : g === grupo;
    if (!enGrupo) return false;
    if (!needle) return true;
    return (
      p.name.toLowerCase().includes(needle) ||
      extraerCuerpoPlantilla(p.componentes).toLowerCase().includes(needle)
    );
  });

  const ultimaSync = todas.reduce<string | null>(
    (max, p) => (p.sincronizadoAt && (!max || p.sincronizadoAt > max) ? p.sincronizadoAt : max),
    null,
  );
  const desarrollo = conexion.data?.modoDesarrollo === true;
  const sinConectar = Boolean(conexion.data && !desarrollo && conexion.data.estado !== "CONECTADO");
  const ocupados = useMemo(() => new Set(todas.map((p) => p.name)), [todas]);

  function duplicar(p: PlantillaMeta) {
    const borrador = borradorDeComponentes(p);
    setDetalle(null);
    setFormulario({ tipo: "duplicar", borrador: { ...borrador, name: siguienteVersion(p.name, ocupados) } });
  }

  return (
    <Card className="w-full">
      <Card.Header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="grid gap-1">
          <Card.Title>Plantillas de Meta</Card.Title>
          <Card.Description className="max-w-[60ch] text-pretty">
            Los mensajes aprobados por Meta con los que el sistema escribe a los
            restaurantes cuando no han escrito en las últimas 24 horas.
          </Card.Description>
          <p className="mst-label tabular-nums">
            {conexion.data?.wabaId ? `Cuenta ${conexion.data.wabaId}` : desarrollo ? "Meta simulado" : "Sin cuenta"}
            {ultimaSync ? ` · sincronizado ${hace(ultimaSync)}` : ""}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <Button
            size="sm"
            variant="secondary"
            isDisabled={sync.isPending || sinConectar}
            onPress={() => sync.mutate()}
          >
            <RefreshCw size={14} className={cn(sync.isPending && "animate-spin")} aria-hidden />
            {sync.isPending ? "Sincronizando…" : "Sincronizar"}
          </Button>
          <Button
            size="sm"
            variant="primary"
            isDisabled={sinConectar}
            onPress={() => setFormulario({ tipo: "nueva" })}
          >
            <Plus size={14} aria-hidden />
            Nueva plantilla
          </Button>
        </div>
      </Card.Header>

      <Card.Content className="grid gap-5">
        {sinConectar ? (
          <Alert status="warning">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>WhatsApp sin conectar</Alert.Title>
              <Alert.Description>
                Conecte la cuenta de WhatsApp del negocio con Meta para crear y
                sincronizar plantillas.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}
        {desarrollo ? (
          <Alert status="accent">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>Modo desarrollo</Alert.Title>
              <Alert.Description>
                Meta está simulado: las plantillas nuevas se aprueban al instante
                y nada sale a WhatsApp.
              </Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {lista.error ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>No se pudieron leer las plantillas</Alert.Title>
              <Alert.Description>{lista.error.message}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        {conteo.atencion > 0 && grupo !== "atencion" ? (
          <Alert status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>
                {conteo.atencion === 1
                  ? "1 plantilla requiere atención"
                  : `${conteo.atencion} plantillas requieren atención`}
              </Alert.Title>
              <Alert.Description>Meta las rechazó o las pausó. No se pueden enviar hasta corregirlas.</Alert.Description>
            </Alert.Content>
            <Button size="sm" variant="secondary" onPress={() => setGrupo("atencion")}>
              Ver
            </Button>
          </Alert>
        ) : null}

        <EnvioAutomaticoPanel desarrollo={desarrollo} />

        <AvisosDelSistema plantillas={todas} cargando={lista.isLoading} onCambio={() => refrescar()} />

        <section className="grid gap-3" aria-labelledby="todas-plantillas">
          <h3 id="todas-plantillas" className="text-sm font-semibold text-tinta-900">
            Todas las plantillas
          </h3>
          <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-center">
            <SearchField aria-label="Buscar plantilla" value={q} onChange={setQ}>
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Nombre o texto del mensaje" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            <div className="-mx-1 overflow-x-auto px-1">
              <SegmentedControl
                label="Filtrar por estado"
                value={grupo}
                onChange={setGrupo}
                className="flex-nowrap"
                options={[
                  { id: "vigentes", label: "Vigentes", count: conteo.vigentes },
                  { id: "aprobadas", label: "Aprobadas", count: conteo.aprobadas },
                  { id: "revision", label: "En revisión", count: conteo.revision },
                  { id: "atencion", label: "Atención", count: conteo.atencion },
                  { id: "retiradas", label: "Retiradas", count: conteo.retiradas },
                ]}
              />
            </div>
          </div>

          {lista.isLoading ? (
            <div className="grid gap-2">
              {Array.from({ length: 4 }, (_, i) => (
                <Skeleton key={i} className="h-[76px] w-full rounded-tarjeta" />
              ))}
            </div>
          ) : todas.length === 0 ? (
            <EmptyState
              icon={<FileText size={22} aria-hidden />}
              title="Todavía no hay plantillas"
              description="Cree la primera o sincronice si ya las tiene en el Business Manager de Meta."
              action={
                <Button variant="primary" isDisabled={sinConectar} onPress={() => setFormulario({ tipo: "nueva" })}>
                  <Plus size={14} aria-hidden />
                  Nueva plantilla
                </Button>
              }
            />
          ) : visibles.length === 0 ? (
            <EmptyState
              icon={<FileText size={22} aria-hidden />}
              title={needle ? "Ninguna coincide con la búsqueda" : "Nada en este estado"}
              description={
                needle
                  ? "Busque por el nombre en Meta o por una palabra del mensaje."
                  : "Cuando Meta cambie el estado de una plantilla, aparece aquí sola."
              }
              action={
                needle || grupo !== "vigentes" ? (
                  <Button
                    size="sm"
                    variant="tertiary"
                    onPress={() => {
                      setQ("");
                      setGrupo("vigentes");
                    }}
                  >
                    Ver todas
                  </Button>
                ) : null
              }
            />
          ) : (
            <ul className="grid gap-2">
              {visibles.map((p) => (
                <li key={p.id}>
                  <FilaPlantilla plantilla={p} onAbrir={() => setDetalle(p)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      </Card.Content>

      {detalle ? (
        <DetallePlantilla
          plantilla={detalle}
          onClose={() => setDetalle(null)}
          onEditar={() => {
            setFormulario({ tipo: "editar", plantilla: detalle, borrador: borradorDeComponentes(detalle) });
            setDetalle(null);
          }}
          onDuplicar={() => duplicar(detalle)}
          onRetirar={() => {
            setRetirando(detalle);
            setDetalle(null);
          }}
        />
      ) : null}

      {formulario ? (
        <PlantillaFormulario
          modo={formulario}
          onClose={() => setFormulario(null)}
          onGuardada={() => {
            setFormulario(null);
            refrescar();
          }}
        />
      ) : null}

      <RetirarDialogo
        plantilla={retirando}
        onClose={() => setRetirando(null)}
        onRetirada={() => {
          setRetirando(null);
          refrescar();
        }}
      />
    </Card>
  );
}

/* ─── Avisos automáticos ─────────────────────────────────────────────── */

const CLAVE_ENVIO = ["mensajeria", "envio-automatico"] as const;

function esAutomatico(prop: PlantillaProposito): boolean {
  return (PROPOSITOS_AUTOMATICOS as readonly string[]).includes(prop);
}

/** Cuándo sale cada aviso, dicho como lo vive el restaurante. */
function avisoCuando(prop: PlantillaProposito, horaInvitacion: string): { cuando: string; detalle: string } {
  switch (prop) {
    case "INVITACION":
      return {
        cuando: `Automático · todos los días a las ${horaInvitacion}`,
        detalle:
          "Solo los días con la ventana de pedidos abierta a esa hora. Uno por cliente por día, con el enlace a su portal.",
      };
    case "CONFIRMACION":
      return {
        cuando: "Automático · al registrar un pedido nuevo",
        detalle:
          "Por el portal o capturado en el panel. Editar el pedido después no la reenvía.",
      };
    case "ESTADO_CUENTA":
      return {
        cuando: "Manual · solo cuando alguien lo manda",
        detalle:
          "Desde Conversaciones o Cartera, con el PDF adjunto. El interruptor no lo afecta.",
      };
  }
}

/**
 * El interruptor general. Nace apagado: conectar Meta y aprobar plantillas no
 * basta para que el sistema empiece a escribirle a los restaurantes.
 */
function EnvioAutomaticoPanel({ desarrollo }: { desarrollo: boolean }) {
  const qc = useQueryClient();
  const [confirmar, setConfirmar] = useState(false);
  const estado = useQuery({
    queryKey: CLAVE_ENVIO,
    queryFn: () => api<EnvioAutomaticoEstado>("/mensajeria/envio-automatico"),
  });
  const cambiar = useMutation<EnvioAutomaticoEstado, Error, boolean>({
    mutationFn: (activo) =>
      api<EnvioAutomaticoEstado>("/mensajeria/envio-automatico", {
        method: "PUT",
        body: JSON.stringify({ activo }),
      }),
    onSuccess: (data) => {
      qc.setQueryData(CLAVE_ENVIO, data);
      setConfirmar(false);
      toastSuccess(data.activo ? "Envío automático encendido" : "Envío automático apagado");
    },
    onError: toastFromError,
  });

  const d = estado.data;
  const activo = d?.activo === true;
  const c = d?.clientes;
  const fuera = c ? c.sinWhatsapp + c.whatsappInvalido + c.sinPortal : 0;

  return (
    <section
      aria-labelledby="envio-automatico"
      className={cn(
        "grid gap-3 rounded-tarjeta border p-4",
        activo
          ? "border-[var(--green-300)] bg-marca-soft"
          : "border-[var(--border-subtle)] bg-[var(--ink-50)]",
      )}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 items-start gap-3">
          <span
            className={cn(
              "grid size-10 shrink-0 place-items-center rounded-campo",
              activo ? "bg-marca text-blanco" : "bg-blanco text-tinta-500",
            )}
          >
            <Power size={18} aria-hidden />
          </span>
          <div className="min-w-0">
            <h3 id="envio-automatico" className="text-sm font-semibold text-tinta-900">
              Envío automático {activo ? "encendido" : "apagado"}
            </h3>
            <p className="max-w-[60ch] text-xs leading-relaxed text-tinta-500 text-pretty">
              {activo
                ? `La invitación sale a las ${d?.horaInvitacion} y la confirmación al registrar cada pedido. Apáguelo y lo que esté en cola no sale.`
                : "Nada sale solo: ni la invitación diaria ni la confirmación de pedido. Lo que se acumule mientras está apagado se descarta, no se manda al encender."}
              {desarrollo ? " Modo desarrollo: aunque esté encendido, Meta está simulado." : ""}
            </p>
          </div>
        </div>
        {estado.isLoading ? (
          <Skeleton className="h-8 w-28 rounded-campo" />
        ) : (
          <Switch
            aria-label="Envío automático de avisos"
            isSelected={activo}
            isDisabled={cambiar.isPending || !d}
            onChange={(v) => (v ? setConfirmar(true) : cambiar.mutate(false))}
          >
            <Switch.Content>
              <Switch.Control>
                <Switch.Thumb />
              </Switch.Control>
              <span className="text-sm font-medium">{activo ? "Encendido" : "Apagado"}</span>
            </Switch.Content>
          </Switch>
        )}
      </div>

      {c ? (
        <p className="text-xs tabular-nums text-tinta-500">
          <span className="font-semibold text-tinta-900">
            {c.listos} de {c.activos} clientes activos
          </span>{" "}
          los recibirían.
          {fuera > 0 ? (
            <>
              {" "}
              Quedan fuera {[
                c.sinWhatsapp ? `${c.sinWhatsapp} sin WhatsApp` : null,
                c.whatsappInvalido ? `${c.whatsappInvalido} con número inválido` : null,
                c.sinPortal ? `${c.sinPortal} sin enlace del portal` : null,
              ]
                .filter(Boolean)
                .join(", ")}
              .{" "}
              <Link href="/clientes?whatsapp=revisar" className="font-semibold text-marca">
                Revisar clientes
              </Link>
            </>
          ) : null}
        </p>
      ) : null}

      <AlertDialog.Backdrop isOpen={confirmar} onOpenChange={(open) => (!open ? setConfirmar(false) : undefined)}>
        <AlertDialog.Container>
          <AlertDialog.Dialog>
            <AlertDialog.CloseTrigger />
            <AlertDialog.Header>
              <AlertDialog.Icon status="warning" />
              <AlertDialog.Heading>¿Encender el envío automático?</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <ul className="grid list-disc gap-1.5 pl-5 text-sm text-tinta-800">
                <li>
                  Hoy a las {d?.horaInvitacion}, si la ventana está abierta, sale la invitación a{" "}
                  <strong className="tabular-nums">{c?.listos ?? 0}</strong> clientes.
                </li>
                <li>Cada pedido nuevo manda su confirmación al restaurante.</li>
                <li>Los mensajes salen de verdad por WhatsApp y Meta los cobra.</li>
              </ul>
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button variant="tertiary" onPress={() => setConfirmar(false)}>
                Cancelar
              </Button>
              <Button variant="primary" isDisabled={cambiar.isPending} onPress={() => cambiar.mutate(true)}>
                {cambiar.isPending ? "Encendiendo…" : "Encender"}
              </Button>
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  );
}

/**
 * Lo que el sistema manda solo y con qué plantilla. Es la pregunta que importa
 * ("¿la confirmación va a salir mañana?"), así que va antes que la lista.
 */
function AvisosDelSistema({
  plantillas,
  cargando,
  onCambio,
}: {
  plantillas: PlantillaMeta[];
  cargando: boolean;
  onCambio: () => void;
}) {
  const aprobadas = plantillas.filter((p) => p.status === "APPROVED");
  const envio = useQuery({
    queryKey: CLAVE_ENVIO,
    queryFn: () => api<EnvioAutomaticoEstado>("/mensajeria/envio-automatico"),
  });
  const envioActivo = envio.data?.activo === true;
  const horaInvitacion = envio.data?.horaInvitacion ?? "—";
  const asignar = useMutation<unknown, Error, { proposito: PlantillaProposito; plantillaId: string }>({
    mutationFn: (body) =>
      api("/mensajeria/propositos", { method: "PUT", body: JSON.stringify(body) }),
    onSuccess: () => {
      toastSuccess("Aviso actualizado");
      onCambio();
    },
    onError: toastFromError,
  });

  return (
    <section className="grid gap-3" aria-labelledby="avisos-sistema">
      <div>
        <h3 id="avisos-sistema" className="text-sm font-semibold text-tinta-900">
          Avisos automáticos
        </h3>
        <p className="text-xs text-tinta-500">
          Solo sale un aviso si su plantilla está aprobada por Meta y, en los
          automáticos, si el envío automático está encendido.
        </p>
      </div>
      <ul className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {PLANTILLA_PROPOSITOS.map((prop) => {
          const actual = plantillas.find((p) => p.proposito === prop) ?? null;
          const aprobada = actual?.status === "APPROVED";
          const apagado = esAutomatico(prop) && !envioActivo;
          const lista = aprobada && !apagado;
          const { cuando, detalle } = avisoCuando(prop, horaInvitacion);
          const estadoTexto = !actual
            ? "No sale: sin plantilla"
            : !aprobada
              ? `No sale: ${etiquetaStatus(actual.status).toLowerCase()}`
              : apagado
                ? "No sale: envío automático apagado"
                : "Listo";
          const tono = actual ? tonoDe(actual.status) : null;
          const Icon = tono?.icon ?? XCircle;
          const opciones = aprobadas.some((p) => p.id === actual?.id) || !actual ? aprobadas : [actual, ...aprobadas];
          return (
            <li
              key={prop}
              className={cn(
                "grid gap-3 rounded-campo border p-3",
                lista
                  ? "border-[var(--border-subtle)]"
                  : aprobada && apagado
                    ? "border-[var(--border-subtle)] bg-[var(--ink-50)]"
                    : "border-[var(--red-100)] bg-[var(--red-100)]/40",
              )}
            >
              <div className="flex items-start gap-2.5">
                {aprobada && apagado ? (
                  <PauseCircle size={18} className="mt-0.5 shrink-0 text-tinta-500" aria-hidden />
                ) : (
                  <Icon
                    size={18}
                    className={cn("mt-0.5 shrink-0", lista ? "text-marca" : "text-peligro")}
                    aria-hidden
                  />
                )}
                <div className="grid min-w-0 gap-0.5">
                  <p className="text-sm font-semibold text-tinta-900">{PROPOSITO_ETIQUETA[prop]}</p>
                  <p className="text-xs font-medium text-tinta-800">{cuando}</p>
                  <p className="text-xs text-tinta-500 text-pretty">{detalle}</p>
                  <p
                    className={cn(
                      "text-xs",
                      lista ? "text-marca" : aprobada && apagado ? "font-semibold text-tinta-500" : "font-semibold text-peligro",
                    )}
                  >
                    {estadoTexto}
                  </p>
                </div>
              </div>
              {cargando ? (
                <Skeleton className="h-10 w-full rounded-campo" />
              ) : (
                <Select
                  aria-label={`Plantilla para ${PROPOSITO_ETIQUETA[prop]}`}
                  placeholder={aprobadas.length ? "Elegir plantilla aprobada" : "No hay plantillas aprobadas"}
                  isDisabled={asignar.isPending || aprobadas.length === 0}
                  value={actual?.id ?? null}
                  onChange={(v) => {
                    if (typeof v === "string" && v !== actual?.id) asignar.mutate({ proposito: prop, plantillaId: v });
                  }}
                >
                  <Select.Trigger>
                    <Select.Value className="font-mono text-sm" />
                    <Select.Indicator />
                  </Select.Trigger>
                  <Select.Popover>
                    <ListBox>
                      {opciones.map((p) => (
                        <ListBox.Item
                          key={p.id}
                          id={p.id}
                          textValue={p.name}
                          isDisabled={p.status !== "APPROVED"}
                        >
                          <span className="font-mono text-sm">{p.name}</span>
                          <span className="ml-1 text-xs text-tinta-500">
                            {IDIOMA_ETIQUETA[p.language] ?? p.language}
                          </span>
                          <ListBox.ItemIndicator />
                        </ListBox.Item>
                      ))}
                    </ListBox>
                  </Select.Popover>
                </Select>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/* ─── Lista y detalle ────────────────────────────────────────────────── */

function FilaPlantilla({ plantilla: p, onAbrir }: { plantilla: PlantillaMeta; onAbrir: () => void }) {
  const tono = tonoDe(p.status);
  const Icon = tono.icon;
  const cuerpo = extraerCuerpoPlantilla(p.componentes);
  return (
    <button
      type="button"
      onClick={onAbrir}
      className={cn(
        "group relative grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 overflow-hidden rounded-tarjeta border border-[var(--border-subtle)] bg-blanco py-3 pl-4 pr-3 text-left",
        "transition-shadow duration-control ease-out hover:shadow-[var(--shadow-md)]",
        "focus-visible:outline-none focus-visible:shadow-foco",
        p.status === "DELETED" && "opacity-70",
      )}
    >
      <span className={cn("absolute inset-y-0 left-0 w-1", tono.acento)} aria-hidden />
      <Icon
        size={20}
        className={cn(
          "shrink-0",
          tono.chip === "success" && "text-marca",
          tono.chip === "warning" && "text-[var(--amber-600)]",
          tono.chip === "danger" && "text-peligro",
          !tono.chip && "text-tinta-500",
        )}
        aria-hidden
      />
      <span className="grid min-w-0 gap-0.5">
        <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="truncate font-mono text-sm font-semibold text-tinta-900">{p.name}</span>
          <Chip size="sm" variant="soft" color={tono.chip}>
            {etiquetaStatus(p.status)}
          </Chip>
          {p.proposito ? (
            <Chip size="sm" variant="soft">
              {PROPOSITO_ETIQUETA[p.proposito as PlantillaProposito] ?? p.proposito}
            </Chip>
          ) : null}
        </span>
        <span className="truncate text-sm text-tinta-800">
          {cuerpo || <span className="text-tinta-400">Sin cuerpo de texto</span>}
        </span>
        <span className="text-xs text-tinta-500">
          {META_CATEGORIA_ETIQUETA[p.category] ?? p.category} · {IDIOMA_ETIQUETA[p.language] ?? p.language}
          {p.motivoRechazo ? <span className="text-peligro"> · {motivoRechazoLegible(p.motivoRechazo)}</span> : null}
        </span>
      </span>
      <ChevronRight
        size={18}
        className="shrink-0 text-tinta-500 transition-transform duration-control group-hover:translate-x-0.5"
        aria-hidden
      />
    </button>
  );
}

function DetallePlantilla({
  plantilla: p,
  onClose,
  onEditar,
  onDuplicar,
  onRetirar,
}: {
  plantilla: PlantillaMeta;
  onClose: () => void;
  onEditar: () => void;
  onDuplicar: () => void;
  onRetirar: () => void;
}) {
  const tono = tonoDe(p.status);
  const retirada = p.status === "DELETED";
  const editable = EDITABLES.has(p.status);
  const borrador = useMemo(() => borradorDeComponentes(p), [p]);
  const calidad = p.calidad ? CALIDAD[p.calidad] : undefined;

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <Modal.Container size="lg" scroll="inside">
        <Modal.Dialog>
          <Modal.CloseTrigger />
          <Modal.Header>
            <div className="flex flex-wrap items-center gap-2">
              <Modal.Heading className="font-mono text-base [overflow-wrap:anywhere]">{p.name}</Modal.Heading>
              <Chip size="sm" variant="soft" color={tono.chip}>
                {etiquetaStatus(p.status)}
              </Chip>
            </div>
          </Modal.Header>
          <Modal.Body>
            <div className="grid gap-5">
              {p.motivoRechazo ? (
                <Alert status="danger">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>Por qué Meta la rechazó</Alert.Title>
                    <Alert.Description>{motivoRechazoLegible(p.motivoRechazo)}</Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : p.status === "PENDING" ? (
                <Alert status="warning">
                  <Alert.Indicator />
                  <Alert.Content>
                    <Alert.Title>En revisión de Meta</Alert.Title>
                    <Alert.Description>
                      Suele tardar minutos. El estado cambia aquí solo cuando Meta responde.
                    </Alert.Description>
                  </Alert.Content>
                </Alert>
              ) : null}

              <PlantillaVistaWhatsApp borrador={borrador} />

              <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3">
                <Dato etiqueta="Categoría">{META_CATEGORIA_ETIQUETA[p.category] ?? p.category}</Dato>
                <Dato etiqueta="Idioma">{IDIOMA_ETIQUETA[p.language] ?? p.language}</Dato>
                <Dato etiqueta="Calidad">
                  {calidad ? (
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("size-2 rounded-full", calidad.clase)} aria-hidden />
                      {calidad.etiqueta}
                    </span>
                  ) : (
                    <span className="text-tinta-500">Sin dato aún</span>
                  )}
                </Dato>
                <Dato etiqueta="Uso en el sistema">
                  {p.proposito ? PROPOSITO_ETIQUETA[p.proposito as PlantillaProposito] : <span className="text-tinta-500">Ninguno</span>}
                </Dato>
                <Dato etiqueta="Sincronizada">{hace(p.sincronizadoAt) ?? "—"}</Dato>
                <Dato etiqueta="ID en Meta">
                  <span className="font-mono text-xs [overflow-wrap:anywhere]">{p.metaTemplateId ?? "—"}</span>
                </Dato>
              </dl>

              {!retirada && !editable ? (
                <p className="text-xs text-tinta-500">
                  Meta no deja editar una plantilla mientras la revisa. Para cambiarla
                  ya, cree una versión nueva.
                </p>
              ) : null}
            </div>
          </Modal.Body>
          <Modal.Footer className="flex-col-reverse items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            {!retirada ? (
              <Button
                variant="tertiary"
                className="text-peligro"
                isDisabled={Boolean(p.proposito)}
                onPress={onRetirar}
              >
                <Trash2 size={14} aria-hidden />
                {p.proposito ? "En uso: no se puede retirar" : "Retirar de Meta"}
              </Button>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" onPress={onDuplicar}>
                <CopyPlus size={14} aria-hidden />
                Nueva versión
              </Button>
              {!retirada ? (
                <Button variant="primary" isDisabled={!editable} onPress={onEditar}>
                  <PencilLine size={14} aria-hidden />
                  Editar
                </Button>
              ) : null}
            </div>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}

function Dato({ etiqueta, children }: { etiqueta: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="mst-label text-[11px]">{etiqueta}</dt>
      <dd className="mt-1 text-sm font-medium text-tinta-900">{children}</dd>
    </div>
  );
}

function RetirarDialogo({
  plantilla,
  onClose,
  onRetirada,
}: {
  plantilla: PlantillaMeta | null;
  onClose: () => void;
  onRetirada: () => void;
}) {
  const [motivo, setMotivo] = useState("");
  const retirar = useMutation<PlantillaMeta, Error, void>({
    mutationFn: () =>
      api<PlantillaMeta>(`/mensajeria/meta/plantillas/${plantilla!.id}/retirar`, {
        method: "POST",
        body: JSON.stringify({ motivo }),
      }),
    onSuccess: () => {
      toastSuccess("Plantilla retirada de Meta");
      setMotivo("");
      onRetirada();
    },
    onError: toastFromError,
  });

  function cerrar() {
    setMotivo("");
    onClose();
  }

  return (
    <AlertDialog.Backdrop isOpen={plantilla !== null} onOpenChange={(open) => (!open ? cerrar() : undefined)}>
      <AlertDialog.Container>
        <AlertDialog.Dialog>
          <AlertDialog.CloseTrigger />
          <AlertDialog.Header>
            <AlertDialog.Icon status="danger" />
            <AlertDialog.Heading>¿Retirar esta plantilla de Meta?</AlertDialog.Heading>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <div className="grid gap-3">
              <p className="font-mono text-sm font-semibold text-tinta-900 [overflow-wrap:anywhere]">
                {plantilla?.name}
              </p>
              <p className="text-sm text-tinta-800 text-pretty">
                Meta la borra de la cuenta y no deja reusar el nombre por 30 días.
                Aquí queda en Retiradas, con su historial.
              </p>
              <TextField isRequired value={motivo} onChange={setMotivo}>
                <Label>Motivo</Label>
                <Input placeholder="Ej. reemplazada por la v2" />
              </TextField>
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button variant="tertiary" onPress={cerrar}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              isDisabled={motivo.trim().length < 3 || retirar.isPending}
              onPress={() => retirar.mutate()}
            >
              {retirar.isPending ? "Retirando…" : "Retirar"}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
