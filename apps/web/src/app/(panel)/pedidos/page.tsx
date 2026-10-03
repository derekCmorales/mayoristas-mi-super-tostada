"use client";

import {
  Button,
  Card,
  SearchField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, ClipboardList, Plus, X } from "lucide-react";
import { Suspense, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  horaEnZona,
  tienePermiso,
  type ActorPublico,
  type CalendarioAhora,
  type ClientePublico,
  type PedidoBandeja,
  type PedidoDetalle as PedidoDetalleDto,
  type PeriodoTablero,
} from "@misupertostada/shared";
import { api } from "@/lib/api";
import {
  aplicarSegmentoLista,
  buildPedidosHref,
  estadoDeSegmento,
  filtrarBandeja,
  parsePedidoSegmento,
  parsePedidosRango,
  type PedidoSegmento,
} from "@/lib/pedido-vista";
import { PanelShell } from "@/components/layout/panel-shell";
import { PedidoDetalle } from "@/components/ordering/pedido-detalle";
import { CapturaManual } from "@/components/ordering/captura-manual";
import { DialogoRecalcularPrecios } from "@/components/ordering/dialogo-recalcular-precios";
import { ClienteAvatar } from "@/components/catalog/cliente-avatar";
import { EstadoBadge } from "@/components/domain/estado-badge";
import { Money } from "@/components/domain/money";
import {
  etiquetaDiaSemanaCorto,
  periodoDePresetCalendario,
  PRESETS_OPERACION,
} from "@/lib/fecha-ui";
import { DateField } from "@/components/ui/date-field";
import { fechaFocoUi } from "@/lib/ejes-vista";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiCard, KpiGrid, KpiGridSkeleton } from "@/components/ui/kpi-grid";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type VistaPedidos = {
  periodo: PeriodoTablero;
  desde: string;
  hasta: string;
  clienteId: string;
  historialMode: boolean;
  segmento: PedidoSegmento;
  sel: string | null;
};

const SEGMENTOS = [
  { id: "todos", label: "Todos" },
  { id: "vivos", label: "Vivos" },
  { id: "ANULADO", label: "Anulados" },
] as const;

function PedidosInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const clienteIdUrl = searchParams.get("clienteId") ?? "";
  const pedidoIdUrl = searchParams.get("pedidoId");
  const segmentoUrl = parsePedidoSegmento(searchParams.get("estado"));
  const searchKey = searchParams.toString();

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  const calendario = useQuery({
    queryKey: ["calendario", "ahora"],
    queryFn: () => api<CalendarioAhora>("/calendario/ahora"),
    enabled: Boolean(me.data),
  });
  const puedeEscribir = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "pedidos.capturar_manual",
  );
  const puedeDte = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "cobranza.capturar_dte",
  );
  const puedeCambiarPrecio = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "precios.cambiar",
  );

  // Tres fechas distintas, tres papeles distintos (ver `USAGE.md` §4):
  // «Hoy» es la operación EN CURSO —la que se reparte—, «Esta noche» la de
  // CAPTURA, y el FOCO es con la que abre la bandeja sin filtro. Usar «hoy»
  // como default dejaba la bandeja en la operación ya repartida mientras el
  // SSE llenaba la de esta noche.
  const fechaHoy = calendario.data?.fechaOperacionEnCurso ?? "";
  const fechaNoche = calendario.data?.fechaOperacionCaptura ?? "";
  const fechaFoco = fechaFocoUi(calendario.data);

  const [q, setQ] = useState("");
  const [captura, setCaptura] = useState(false);
  const [recalcular, setRecalcular] = useState(false);

  // Toda la vista (rango, cliente, segmento, selección) vive en la URL: es
  // deep-linkeable y sobrevive al refresh. Antes se copiaba a siete `useState`
  // desde un efecto, que reintroducía el estado duplicado que la URL ya tenía.
  const claveUrl = `${searchKey}|${fechaHoy}|${fechaFoco}`;
  const vistaUrl = useMemo<VistaPedidos>(() => {
    const base = {
      clienteId: clienteIdUrl,
      segmento: segmentoUrl,
      sel: pedidoIdUrl || null,
    };
    const parsed = fechaHoy
      ? parsePedidosRango(new URLSearchParams(searchKey), fechaHoy, fechaFoco)
      : null;
    if (!parsed) {
      return {
        ...base,
        periodo: "hoy" as PeriodoTablero,
        desde: "",
        hasta: "",
        // Sin `fechaHoy` todavía no hay rango que mostrar, pero eso no es
        // modo historial: eso solo lo decide `parsePedidosRango`.
        historialMode: Boolean(fechaHoy),
      };
    }
    return {
      ...base,
      periodo: parsed.periodo,
      desde: parsed.desde,
      hasta: parsed.hasta,
      historialMode: false,
    };
  }, [clienteIdUrl, segmentoUrl, pedidoIdUrl, fechaHoy, fechaFoco, searchKey]);

  // `syncUrl` navega dentro de una transición, así que el search param tarda
  // un frame. El eco adelanta el cambio y cede en cuanto la URL lo alcanza.
  const [eco, setEco] = useState<{ url: string; vista: VistaPedidos } | null>(
    null,
  );
  const vista = eco && eco.url === claveUrl ? eco.vista : vistaUrl;
  const { periodo, desde, hasta, clienteId, historialMode, segmento, sel } =
    vista;

  function aplicar(patch: Partial<VistaPedidos>) {
    setEco({ url: claveUrl, vista: { ...vista, ...patch } });
  }

  const historialCliente = Boolean(clienteId) && historialMode && !desde;
  const estadoApi = estadoDeSegmento(segmento);

  const clientes = useQuery({
    queryKey: ["clientes"],
    queryFn: () => api<ClientePublico[]>("/clientes"),
    enabled: Boolean(me.data),
  });
  const pedidos = useQuery({
    queryKey: ["pedidos", { desde, hasta, clienteId, estadoApi, historialCliente }],
    queryFn: () =>
      api<PedidoBandeja[]>(
        `/pedidos${queryString({
          desde: historialCliente ? undefined : desde || undefined,
          hasta: historialCliente ? undefined : hasta || undefined,
          clienteId: clienteId || undefined,
          estado: estadoApi,
          historial: historialCliente ? "1" : undefined,
        })}`,
      ),
    enabled: historialCliente || Boolean(desde && hasta),
    placeholderData: keepPreviousData,
  });
  const detalle = useQuery({
    queryKey: ["pedidos", sel],
    queryFn: () => api<PedidoDetalleDto>(`/pedidos/${sel}`),
    enabled: Boolean(sel),
  });

  const clientePorId = useMemo(() => {
    const map = new Map<string, ClientePublico>();
    for (const c of clientes.data ?? []) map.set(c.id, c);
    return map;
  }, [clientes.data]);

  const lista = useMemo(() => {
    const segmentados = aplicarSegmentoLista(pedidos.data ?? [], segmento);
    return filtrarBandeja(segmentados, q);
  }, [pedidos.data, segmento, q]);

  const resumen = useMemo(
    () => (pedidos.data ? resumenBandeja(pedidos.data) : null),
    [pedidos.data],
  );

  const historialNombre = clienteId
    ? (clientePorId.get(clienteId)?.nombre ?? "cliente")
    : null;

  const totalPedidos = pedidos.data?.length ?? 0;
  const cargandoLista = pedidos.isLoading && !pedidos.data;

  function syncUrl(next: {
    periodo?: PeriodoTablero;
    desde?: string;
    hasta?: string;
    clienteId?: string;
    historial?: boolean;
    pedidoId?: string | null;
    segmento?: PedidoSegmento;
  }) {
    const nextHistorial =
      next.historial !== undefined ? next.historial : historialCliente;
    const href = buildPedidosHref({
      periodo: nextHistorial ? undefined : (next.periodo ?? periodo),
      desde: nextHistorial ? undefined : (next.desde !== undefined ? next.desde : desde) || undefined,
      hasta: nextHistorial ? undefined : (next.hasta !== undefined ? next.hasta : hasta) || undefined,
      clienteId:
        next.clienteId !== undefined
          ? next.clienteId || undefined
          : clienteId || undefined,
      historial: nextHistorial,
      pedidoId:
        next.pedidoId === null
          ? undefined
          : (next.pedidoId ?? sel) || undefined,
      estado: next.segmento ?? segmento,
    });
    if (href !== `${pathname}${searchParams.toString() ? `?${searchParams}` : ""}`) {
      router.replace(href, { scroll: false });
    }
  }

  function onRangoChange(
    rango: { desde: string; hasta: string },
    nextPeriodo: PeriodoTablero,
  ) {
    aplicar({
      periodo: nextPeriodo,
      desde: rango.desde,
      hasta: rango.hasta,
      historialMode: false,
    });
    syncUrl({
      periodo: nextPeriodo,
      desde: rango.desde,
      hasta: rango.hasta,
      historial: false,
    });
  }

  function onFechaChange(next: string) {
    if (!next) {
      if (clienteId) {
        aplicar({ historialMode: true, desde: "", hasta: "" });
        syncUrl({ historial: true, desde: "", hasta: "" });
      }
      return;
    }
    onRangoChange({ desde: next, hasta: next }, "rango");
  }

  function onSegmentoChange(next: PedidoSegmento) {
    aplicar({ segmento: next });
    syncUrl({ segmento: next });
  }

  function onSelect(id: string) {
    aplicar({ sel: id });
    syncUrl({ pedidoId: id });
  }

  function salirHistorial() {
    // Volver a la bandeja del día es volver al FOCO, no a la operación en
    // curso: por la tarde el trabajo vivo es la ventana que está capturando.
    const vuelta = fechaFoco || fechaHoy;
    const periodoVuelta: PeriodoTablero =
      vuelta === fechaHoy ? "hoy" : "rango";
    aplicar({
      historialMode: false,
      clienteId: "",
      periodo: periodoVuelta,
      desde: vuelta,
      hasta: vuelta,
      sel: null,
    });
    syncUrl({
      clienteId: "",
      historial: false,
      periodo: periodoVuelta,
      desde: vuelta,
      hasta: vuelta,
      pedidoId: null,
    });
  }

  return (
    <PanelShell title="Pedidos">
      <div className="grid gap-5">
        <BandejaResumen resumen={resumen} cargando={cargandoLista} />

        <section className="grid min-w-0 gap-3" aria-label="Buscar y filtrar">
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="min-w-0 w-full sm:w-auto sm:min-w-[11rem] sm:max-w-[15rem]">
              <DateField
                id="filtro-fecha-operacion"
                value={desde}
                rangeEnd={hasta || undefined}
                onChange={onFechaChange}
                onRangeChange={(rango, preset) =>
                  onRangoChange(rango, periodoDePresetCalendario(preset))
                }
                clearable={Boolean(clienteId)}
                ancla={desde || hasta || fechaHoy}
                fechaHoy={fechaHoy || undefined}
                fechaNoche={fechaNoche || undefined}
                presets={PRESETS_OPERACION}
              />
            </div>
            <SearchField
              aria-label="Buscar pedido"
              className="min-w-0 flex-1"
              value={q}
              onChange={setQ}
            >
              <SearchField.Group>
                <SearchField.SearchIcon />
                <SearchField.Input placeholder="Restaurante o correlativo" />
                <SearchField.ClearButton />
              </SearchField.Group>
            </SearchField>
            {puedeEscribir && (
              <Button
                className="button--accent w-full shrink-0 sm:w-auto"
                variant="primary"
                onPress={() => setCaptura(true)}
              >
                <Plus size={16} aria-hidden />
                Capturar pedido
              </Button>
            )}
          </div>

          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 max-w-full overflow-x-auto pb-0.5">
              <ToggleButtonGroup
                aria-label="Filtrar pedidos por estado"
                className="mst-segmento-activo w-max min-w-full sm:min-w-0"
                disallowEmptySelection
                selectedKeys={new Set([segmento])}
                selectionMode="single"
                size="sm"
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (typeof next === "string") {
                    onSegmentoChange(next as PedidoSegmento);
                  }
                }}
              >
                {SEGMENTOS.map((s, i) => (
                  <ToggleButton key={s.id} id={s.id}>
                    {i > 0 && <ToggleButtonGroup.Separator />}
                    {s.label}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </div>

            <div className="flex items-center gap-3">
              {/* Recalcular es por operación: solo con un día elegido. */}
              {puedeCambiarPrecio && desde && desde === hasta && !historialCliente ? (
                <Button
                  size="sm"
                  variant="secondary"
                  onPress={() => setRecalcular(true)}
                >
                  Recalcular precios
                </Button>
              ) : null}
              {!cargandoLista && pedidos.data ? (
                <p className="mst-label tabular-nums" aria-live="polite">
                  {lista.length} de {totalPedidos}
                </p>
              ) : null}
            </div>
          </div>
        </section>

        {historialCliente && historialNombre ? (
          <div className="flex min-h-11 items-center gap-2 rounded-campo border border-[var(--border-subtle)] bg-[var(--green-50)] px-3">
            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-tinta-900 text-pretty">
              Historial de {historialNombre}
            </span>
            <Button
              aria-label="Volver a la bandeja del día"
              size="sm"
              variant="secondary"
              onPress={salirHistorial}
            >
              <X size={14} aria-hidden />
              Día
            </Button>
          </div>
        ) : null}

        <div className="grid items-start gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
          <Card
            className={cn(
              "gap-0 overflow-hidden p-0",
              sel && "hidden lg:flex",
            )}
          >
            <div
              className={cn(
                "transition-opacity duration-slow ease-out",
                pedidos.isFetching && pedidos.data ? "opacity-70" : "opacity-100",
              )}
              aria-busy={pedidos.isFetching || undefined}
            >
              {cargandoLista ? (
                <BandejaSkeleton />
              ) : lista.length === 0 ? (
                <EmptyState
                  icon={<ClipboardList size={22} aria-hidden />}
                  title={
                    q
                      ? "Ningún pedido coincide"
                      : segmento === "ANULADO"
                        ? "Sin pedidos anulados"
                        : "Nadie ha pedido todavía"
                  }
                  description={
                    q
                      ? "Pruebe con el nombre del restaurante o el correlativo."
                      : segmento === "ANULADO"
                        ? "En esta operación no se anuló ningún pedido."
                        : puedeEscribir
                          ? "Capture el extra de una llamada o espere al portal."
                          : "Los pedidos del portal y de tienda aparecen aquí."
                  }
                  action={
                    puedeEscribir && !q && segmento !== "ANULADO" ? (
                      <Button
                        className="button--accent"
                        size="sm"
                        variant="primary"
                        onPress={() => setCaptura(true)}
                      >
                        Capturar pedido
                      </Button>
                    ) : null
                  }
                />
              ) : (
                <ul>
                  {lista.map((p) => {
                    const activo = p.id === sel;
                    const cliente = clientePorId.get(p.clienteId);
                    return (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => onSelect(p.id)}
                          aria-current={activo ? "true" : undefined}
                          className={cn(
                            "grid min-h-fila w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-[var(--border-subtle)] px-4 py-2.5 text-left last:border-b-0",
                            "border-l-[3px] transition-[background-color,border-color] duration-control ease-out",
                            "focus-visible:outline-none focus-visible:shadow-foco",
                            activo
                              ? "border-l-marca bg-[var(--green-50)]"
                              : "border-l-transparent hover:bg-[var(--ink-50)]",
                          )}
                        >
                          <ClienteAvatar
                            nombre={p.clienteNombre}
                            fotoAssetId={cliente?.fotoAssetId}
                            size="sm"
                          />
                          <span className="min-w-0">
                            <span className="flex items-center gap-2">
                              <span className="font-mono text-[12px] tabular-nums text-tinta-500">
                                #{p.correlativo}
                              </span>
                              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-pretty text-tinta-900">
                                {p.clienteNombre}
                              </span>
                              <EstadoBadge estado={p.estado} size="sm" />
                            </span>
                            <span className="flex gap-2 text-[12px] text-tinta-500">
                              <span>
                                <span
                                  className={cn(
                                    p.origen === "MANUAL" &&
                                      "font-semibold text-[var(--amber-700)]",
                                  )}
                                >
                                  {p.origen === "PORTAL" ? "Portal" : "Manual"}
                                </span>
                                {" · "}
                                {desde !== hasta
                                  ? `${etiquetaDiaSemanaCorto(p.fechaOperacion)} · entrega ${etiquetaDiaSemanaCorto(p.fechaEntrega)} · `
                                  : ""}
                                {horaEnZona(new Date(p.capturadoAt))}
                              </span>
                              <span className="ml-auto shrink-0">
                                <Money centavos={p.totalCentavos} tone="muted" truncate />
                              </span>
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
          </Card>

          <div className={cn(!sel && "hidden lg:block")}>
            {sel ? (
              <div className="grid gap-3">
                <Button
                  className="lg:hidden"
                  size="sm"
                  variant="tertiary"
                  onPress={() => {
                    aplicar({ sel: null });
                    syncUrl({ pedidoId: null });
                  }}
                >
                  <ChevronLeft size={16} aria-hidden />
                  Pedidos
                </Button>
                {detalle.isLoading || !detalle.data ? (
                  <Card className="gap-3 p-5">
                    <Skeleton className="h-6 w-48" />
                    <Skeleton className="h-32 w-full rounded-campo" />
                  </Card>
                ) : (
                  <PedidoDetalle
                    pedido={detalle.data}
                    puedeDte={puedeDte}
                    puedeEscribir={puedeEscribir}
                    puedeCambiarPrecio={puedeCambiarPrecio}
                    fotoAssetId={
                      clientePorId.get(detalle.data.clienteId)?.fotoAssetId
                    }
                  />
                )}
              </div>
            ) : (
              <EmptyState
                icon={<ClipboardList size={22} aria-hidden />}
                title="Elija un pedido"
                description="La lista de la izquierda muestra portal y llamadas del día de operación."
              />
            )}
          </div>
        </div>
      </div>

      {recalcular && desde ? (
        <DialogoRecalcularPrecios
          fechaOperacion={desde}
          onClose={() => setRecalcular(false)}
        />
      ) : null}

      <CapturaManual
        open={captura}
        onClose={() => setCaptura(false)}
        onCaptured={(pedido) => {
          setCaptura(false);
          void qc.invalidateQueries({ queryKey: ["pedidos"] });
          const fueraDeRango =
            pedido.fechaOperacion < desde || pedido.fechaOperacion > hasta;
          aplicar({
            sel: pedido.id,
            ...(fueraDeRango
              ? {
                  periodo: "rango" as PeriodoTablero,
                  desde: pedido.fechaOperacion,
                  hasta: pedido.fechaOperacion,
                }
              : {}),
          });
          syncUrl({
            pedidoId: pedido.id,
            periodo: "rango",
            desde: pedido.fechaOperacion,
            hasta: pedido.fechaOperacion,
            historial: false,
          });
        }}
      />
    </PanelShell>
  );
}

type ResumenBandeja = {
  pedidos: number;
  vivos: number;
  anulados: number;
  totalCentavos: number;
};

/** Cifras de la ventana cargada: lo que ya se pidió y cuánto suma. */
function resumenBandeja(rows: readonly PedidoBandeja[]): ResumenBandeja {
  let vivos = 0;
  let anulados = 0;
  let totalCentavos = 0;
  for (const p of rows) {
    if (p.estado === "ANULADO") {
      anulados += 1;
      continue;
    }
    vivos += 1;
    totalCentavos += p.totalCentavos;
  }
  return { pedidos: rows.length, vivos, anulados, totalCentavos };
}

function BandejaResumen({
  resumen,
  cargando,
}: {
  resumen: ResumenBandeja | null;
  cargando: boolean;
}) {
  if (cargando) {
    return <KpiGridSkeleton count={4} />;
  }
  if (!resumen) return null;
  return (
    <KpiGrid>
      <KpiCard etiqueta="Pedidos" valor={resumen.pedidos} />
      <KpiCard etiqueta="Vivos" valor={resumen.vivos} tono="aviso" />
      <KpiCard
        etiqueta="Anulados"
        valor={resumen.anulados}
        tono={resumen.anulados > 0 ? "peligro" : "neutro"}
        valorInactivo={resumen.anulados === 0}
      />
      <KpiCard
        etiqueta="Total vivo"
        className="border-[var(--amber-600)]/30 bg-[var(--amber-100)]/20"
        tono="aviso"
        valor={
          <Money
            centavos={resumen.totalCentavos}
            tone="pendiente"
            truncate
            className="font-display leading-none"
          />
        }
      />
    </KpiGrid>
  );
}

function BandejaSkeleton() {
  return (
    <ul aria-hidden>
      {Array.from({ length: 8 }, (_, i) => (
        <li
          key={i}
          className="flex min-h-fila items-center gap-3 border-b border-[var(--border-subtle)] px-4 last:border-b-0"
        >
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-24" />
          </div>
        </li>
      ))}
    </ul>
  );
}

/**
 * `useSearchParams` obliga a un límite de Suspense: sin él el prerender
 * estático falla en build.
 */
export default function PedidosPage() {
  return (
    <Suspense
      fallback={
        <PanelShell title="Pedidos">
          <BandejaSkeleton />
        </PanelShell>
      }
    >
      <PedidosInner />
    </Suspense>
  );
}

function queryString(params: Record<string, string | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v) s.set(k, v);
  }
  const out = s.toString();
  return out ? `?${out}` : "";
}
