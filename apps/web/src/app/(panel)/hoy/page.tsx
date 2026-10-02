"use client";

import {
  keepPreviousData,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, startTransition, useEffect, useMemo, useState } from "react";
import {
  horaEnZona,
  tienePermiso,
  type ActorPublico,
  type CalendarioAhora,
  type CarteraResumen,
  type CierreResultado,
  type ClientePublico,
  type OperacionResumen,
  type PedidoBandeja,
  type PedidoEstado,
  type RepartoAtrasados,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { buildPedidosHref } from "@/lib/pedido-vista";
import {
  copyHeroFoco,
  copyVentanaHoy,
  fechaDeFoco,
  fechaDefectoHoy,
  focoDeFecha,
  hrefClienteSinPedido,
  hrefHoyFecha,
  hrefLimiteCredito,
  hrefPedidoNoche,
  mapaFotoCliente,
  recortarPedidosNoche,
  type FocoOperacion,
} from "@/lib/hoy-vista";
import { toastFromError } from "@/lib/toast";
import { PanelShell } from "@/components/layout/panel-shell";
import {
  Button,
  Card,
  Chip,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { EmptyState } from "@/components/ui/empty-state";
import { etiquetaDiaCorto, etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import { Skeleton } from "@/components/ui/skeleton";
import { DialogoCierre } from "@/components/fulfillment/dialogo-cierre";
import { DialogoReabrir } from "@/components/fulfillment/dialogo-reabrir";
import { AvisoAtrasados } from "@/components/fulfillment/aviso-atrasados";
import { VentanaBadge } from "@/components/domain/ventana-badge";
import { ContadorFacturas } from "@/components/domain/contador-facturas";
import { ClienteAvatar } from "@/components/catalog/cliente-avatar";
import { EstadoBadge } from "@/components/domain/estado-badge";
import { Money } from "@/components/domain/money";
import { ScrollFadeLista } from "@/components/ui/scroll-fade-lista";
import { KpiCard, KpiGrid, KpiGridSkeleton } from "@/components/ui/kpi-grid";
import { cn } from "@/lib/utils";

/* Tira de cifras del arranque del día: el mismo patrón que `ClientesResumen`,
   para que Hoy y Clientes se escaneen igual. */
function ChipRuta({ estado, valor }: { estado: PedidoEstado; valor: number }) {
  return (
    <span className="inline-flex min-h-11 items-center gap-2 rounded-campo border border-[var(--border-subtle)] bg-blanco px-3 text-sm">
      <EstadoBadge estado={estado} size="sm" />
      <span className="font-semibold tabular-nums text-tinta-900">{valor}</span>
    </span>
  );
}

function HeroNoche({
  montoCentavos,
  pedidosTotal,
  entregados,
  foco,
  fechaEntrega,
  actualizando,
  loading,
}: {
  montoCentavos: number;
  pedidosTotal: number;
  entregados: number;
  foco: FocoOperacion;
  fechaEntrega?: string;
  actualizando?: boolean;
  loading?: boolean;
}) {
  const copy = copyHeroFoco(foco);
  const progreso =
    pedidosTotal <= 0
      ? 0
      : Math.min(100, Math.round((entregados / pedidosTotal) * 100));

  return (
    <section className="overflow-hidden rounded-tarjeta border border-[var(--green-900)] bg-[var(--surface-brand)] p-5 shadow-modal sm:p-6">
      <div className="flex flex-col gap-6 lg:flex-row lg:items-center lg:justify-between lg:gap-10">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--green-200)]">
            {copy.titulo}
          </p>
          {loading ? (
            <Skeleton className="mt-3 h-12 w-48 bg-[var(--green-900)]/50" />
          ) : (
            <p className="mt-2 min-w-0 font-display text-3xl leading-none tabular-nums text-acento sm:text-4xl lg:text-5xl">
              <Money centavos={montoCentavos} className="text-acento" truncate />
            </p>
          )}
          <p className="mt-2 max-w-md text-sm text-pretty text-[var(--green-200)]">
            {copy.nota}
          </p>
          {fechaEntrega ? (
            <p className="mt-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--green-300)]">
              Entrega {fechaEntrega}
            </p>
          ) : null}
          {actualizando ? (
            <p
              className="mt-1 text-[11px] font-semibold text-[var(--green-200)]"
              aria-live="polite"
            >
              Actualizando…
            </p>
          ) : null}
        </div>

        {/* El avance de reparto es la otra mitad del titular: cuánto vale la
            operación y cuánto de eso ya salió. Las cifras sueltas viven abajo
            en la tira de KPIs, no repetidas aquí. */}
        <div className="w-full rounded-[14px] border border-[var(--yellow-300)]/35 bg-[var(--yellow-100)]/10 px-4 py-3.5 lg:max-w-xs lg:shrink-0">
          <div className="mb-2 flex items-center justify-between gap-3 text-sm">
            <span className="text-[var(--yellow-200)]">Avance de reparto</span>
            <span className="font-semibold tabular-nums text-acento">
              {loading ? "—" : `${entregados} / ${pedidosTotal}`}
            </span>
          </div>
          <div
            className="h-2.5 overflow-hidden rounded-pill bg-black/25"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={loading ? 0 : progreso}
            aria-label="Avance de reparto"
          >
            <div
              className="h-full rounded-pill bg-acento transition-[width] duration-surface ease-out"
              style={{ width: `${loading ? 0 : progreso}%` }}
            />
          </div>
          <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--yellow-200)]">
            {loading ? "—" : `${progreso}% entregado`}
          </p>
        </div>
      </div>
    </section>
  );
}

function HoyInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const sp = useSearchParams();
  const fechaFromUrl = sp.get("fechaOperacion") ?? "";
  const [cerrando, setCerrando] = useState(false);
  const [reabriendo, setReabriendo] = useState(false);
  const [errorReabrir, setErrorReabrir] = useState<string>();

  // Elegir fecha hace `router.replace` dentro de una transición, así que el
  // search param tarda un frame. El eco local hace que el picker responda de
  // inmediato; en cuanto la URL cambia —por la transición o por navegar a
  // /hoy sin parámetro— manda la URL y el eco se descarta.
  const [eco, setEco] = useState({ url: fechaFromUrl, valor: fechaFromUrl });
  const fechaLocal = eco.url === fechaFromUrl ? eco.valor : fechaFromUrl;

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  const calendario = useQuery({
    queryKey: ["calendario", "ahora"],
    queryFn: () => api<CalendarioAhora>("/calendario/ahora"),
    enabled: Boolean(me.data),
  });
  // Sin fecha en la URL, `/hoy` abre en el eje que corresponde al momento:
  // capturando mientras la ventana está abierta, repartiendo cuando cerró.
  const fechaSel = fechaLocal || fechaDefectoHoy(calendario.data);
  const foco = focoDeFecha(fechaSel, calendario.data);
  const fechaCaptura = calendario.data?.fechaOperacionCaptura ?? "";
  const operacion = useQuery({
    queryKey: ["operacion", fechaSel],
    queryFn: () =>
      api<OperacionResumen>(
        `/operacion${fechaSel ? `?fechaOperacion=${fechaSel}` : ""}`,
      ),
    enabled: Boolean(me.data) && Boolean(fechaSel),
    placeholderData: keepPreviousData,
  });
  const operacionCaptura = useQuery({
    queryKey: ["operacion", fechaCaptura],
    queryFn: () =>
      api<OperacionResumen>(`/operacion?fechaOperacion=${fechaCaptura}`),
    enabled: Boolean(me.data) && Boolean(fechaCaptura),
  });
  const fecha = operacion.isPlaceholderData
    ? fechaSel
    : (operacion.data?.fechaOperacion ?? fechaSel);
  const pedidos = useQuery({
    queryKey: ["pedidos", { fechaOperacion: fecha }],
    queryFn: () =>
      api<PedidoBandeja[]>(`/pedidos?fechaOperacion=${fecha}`),
    enabled: Boolean(fecha),
    placeholderData: keepPreviousData,
  });
  const clientes = useQuery({
    queryKey: ["clientes"],
    queryFn: () => api<ClientePublico[]>("/clientes"),
    enabled: Boolean(me.data),
  });
  const cartera = useQuery({
    queryKey: ["cartera", "resumen", fecha],
    queryFn: () =>
      api<CarteraResumen>(
        `/cartera/resumen${fecha ? `?fechaOperacion=${fecha}` : ""}`,
      ),
    enabled: Boolean(me.data),
    placeholderData: keepPreviousData,
  });

  // Misma consulta y clave que en `/reparto`: una entrega la refresca en los
  // dos lados. Sin señal o sin datos, simplemente no se muestra.
  const atrasados = useQuery({
    queryKey: ["ruta", "atrasados"],
    queryFn: () => api<RepartoAtrasados>("/reparto/atrasados"),
    enabled: Boolean(me.data),
  });

  const fotoPorCliente = useMemo(
    () => mapaFotoCliente(clientes.data ?? []),
    [clientes.data],
  );
  const listaNoche = useMemo(
    () => recortarPedidosNoche(pedidos.data ?? []),
    [pedidos.data],
  );
  const clientesSinPedido = operacion.data?.clientesSinPedido ?? [];

  const puedeCerrar = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "ventana.cerrar",
  );
  const puedeReabrir = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "ventana.reabrir",
  );
  const puedeConfirmarTransferencias = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "cobranza.confirmar_transferencia",
  );
  const transferenciasPendientes =
    cartera.data?.transferenciasPendientesCount ?? 0;

  const cerrar = useMutation({
    mutationFn: () =>
      api<CierreResultado>("/operacion/cerrar", {
        method: "POST",
        body: JSON.stringify({
          fechaOperacion: fechaCaptura || operacionCaptura.data?.fechaOperacion,
        }),
      }),
    onSuccess: () => {
      setCerrando(false);
      void qc.invalidateQueries({ queryKey: ["operacion"] });
      void qc.invalidateQueries({ queryKey: ["hoja"] });
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      void qc.invalidateQueries({ queryKey: ["calendario"] });
      void qc.invalidateQueries({ queryKey: ["ruta"] });
      void qc.invalidateQueries({ queryKey: ["tablero"] });
    },
    onError: (err) => toastFromError(err, "No se pudo cerrar la ventana"),
  });

  const reabrir = useMutation({
    mutationFn: (motivo: string) =>
      api("/operacion/reabrir", {
        method: "POST",
        body: JSON.stringify({
          motivo,
          fechaOperacion: fechaCaptura || operacionCaptura.data?.fechaOperacion,
        }),
      }),
    onSuccess: () => {
      setReabriendo(false);
      setErrorReabrir(undefined);
      void qc.invalidateQueries({ queryKey: ["operacion"] });
      void qc.invalidateQueries({ queryKey: ["hoja"] });
      void qc.invalidateQueries({ queryKey: ["pedidos"] });
      void qc.invalidateQueries({ queryKey: ["calendario"] });
      void qc.invalidateQueries({ queryKey: ["ruta"] });
      void qc.invalidateQueries({ queryKey: ["tablero"] });
    },
    onError: (err) => {
      setErrorReabrir(err instanceof ApiError ? err.message : "No se pudo reabrir");
    },
  });

  useEffect(() => {
    if (operacion.error) {
      toastFromError(operacion.error, "No se pudo cargar la operación");
    }
  }, [operacion.error]);

  function elegirFecha(value: string) {
    setEco({ url: fechaFromUrl, valor: value });
    startTransition(() => {
      router.replace(hrefHoyFecha(value), { scroll: false });
    });
  }

  function elegirFoco(next: FocoOperacion) {
    const iso = fechaDeFoco(next, calendario.data);
    if (iso) elegirFecha(iso);
  }

  const data = operacion.data;
  const pedidosDelDia = data ? data.pedidosPortal + data.pedidosManual : 0;
  const capturaCerrada = calendario.data?.diaEstado === "CERRADO";
  const capturaReabierta = calendario.data?.diaEstado === "REABIERTO";
  const actualizando = operacion.isFetching && Boolean(data);
  const ejesSeparados = Boolean(
    calendario.data && !calendario.data.mismaOperacion,
  );
  const horarioVentana =
    calendario.data?.horarioApertura && calendario.data.horarioCierre
      ? {
          apertura: calendario.data.horarioApertura,
          cierre: calendario.data.horarioCierre,
        }
      : null;
  const copyVentana = copyVentanaHoy(horarioVentana);

  return (
    <PanelShell title="Hoy">
      <div
        className={cn(
          "grid gap-5 transition-opacity duration-slow ease-out",
          actualizando && "opacity-70",
        )}
        aria-busy={actualizando || undefined}
      >
        {/*
          Sin selector de fecha: `/hoy` es la operación viva, no un informe.
          Cuando los dos ejes se separan, el segmentado deja elegir entre ellos;
          una fecha pasada solo llega por deep link (?fechaOperacion=…) y se
          señala como tal para que nadie confunda un archivo con el turno.
        */}
        {ejesSeparados && calendario.data ? (
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="min-w-0 max-w-full overflow-x-auto pb-0.5">
              <ToggleButtonGroup
                aria-label="Operación que se está viendo"
                className="mst-segmento-activo w-max min-w-full sm:min-w-0"
                disallowEmptySelection
                selectedKeys={new Set([foco])}
                selectionMode="single"
                size="sm"
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (next === "curso" || next === "captura") elegirFoco(next);
                }}
              >
                <ToggleButton id="curso">
                  {`Reparto de hoy · ${etiquetaDiaCorto(calendario.data.fechaOperacionEnCurso)}`}
                </ToggleButton>
                <ToggleButton id="captura">
                  <ToggleButtonGroup.Separator />
                  {`Pedidos de esta noche · ${etiquetaDiaCorto(calendario.data.fechaOperacionCaptura)}`}
                </ToggleButton>
              </ToggleButtonGroup>
            </div>
            {foco === "otra" ? (
              <Button variant="ghost" size="sm" onPress={() => elegirFoco("curso")}>
                Volver a hoy
              </Button>
            ) : null}
          </div>
        ) : foco === "otra" && fechaSel ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-tarjeta border border-white/20 bg-blanco/80 backdrop-blur-md px-4 py-2.5 shadow-sm">
            <p className="text-sm text-tinta-800">
              Viendo la operación del{" "}
              <span className="font-semibold tabular-nums">
                {etiquetaDiaCorto(fechaSel)}
              </span>
              . No es la operación en curso.
            </p>
            <Button variant="ghost" size="sm" onPress={() => elegirFoco("curso")}>
              Volver a hoy
            </Button>
          </div>
        ) : null}

        {operacion.isLoading && !data && (
          <div className="grid gap-5">
            <HeroNoche
              montoCentavos={0}
              pedidosTotal={0}
              entregados={0}
              foco={foco}
              loading
            />
            <KpiGridSkeleton count={4} />
            <Skeleton className="h-14 w-full rounded-tarjeta" />
            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr] lg:items-start">
              <Skeleton className="h-64 rounded-tarjeta" />
              <Skeleton className="h-64 rounded-tarjeta" />
            </div>
          </div>
        )}

        {operacion.error && !data && (
          <EmptyState
            title="No se pudo cargar la operación"
            description="Revise la conexión e intente de nuevo."
            action={
              <Button
                variant="secondary"
                onPress={() => void operacion.refetch()}
              >
                Reintentar
              </Button>
            }
          />
        )}

        {data && (
          <>
            <HeroNoche
              montoCentavos={data.montoPedidosCentavos}
              pedidosTotal={pedidosDelDia}
              entregados={data.ruta.entregados}
              foco={foco}
              fechaEntrega={data.fechaEntrega}
              actualizando={actualizando}
            />

            {/* Lo que se quedó sin marcar en días anteriores no tiene factura:
                no aparece en «Por cobrar» ni en la cartera. Se señala aquí
                para que no se acumule sin que nadie lo vea. */}
            <AvisoAtrasados dias={atrasados.data?.dias ?? []} />

            {/*
              Sin métrica de outbox: la cola de WhatsApp es plomería, no
              jornada. Quien abre `/hoy` asume que al cliente ya se le avisó y
              lo que necesita saber es quién falta por ordenar —eso está más
              abajo, en «Clientes sin pedido». Los contadores siguen en
              `GET /operacion` para diagnóstico.
            */}
            <KpiGrid>
              <KpiCard
                etiqueta="Pedidos del día"
                valor={pedidosDelDia}
                nota={`${data.pedidosPortal} del portal · ${data.pedidosManual} manuales`}
              />
              <KpiCard
                etiqueta="Libras de tortilla"
                valor={`${data.librasTortilla} lb`}
                nota="Lo que hay que producir"
              />
              <KpiCard
                etiqueta="Entregados"
                valor={`${data.ruta.entregados} de ${pedidosDelDia}`}
                nota={`${data.ruta.confirmados + data.ruta.enProduccion} sin entregar`}
                tono={
                  pedidosDelDia > 0 && data.ruta.entregados === pedidosDelDia
                    ? "ok"
                    : "neutro"
                }
              />
              <KpiCard
                etiqueta="Por cobrar del día"
                valor={
                  <Money
                    centavos={
                      cartera.data?.porCobrarFechaOperacionCentavos ?? null
                    }
                    truncate
                    className="text-acento-fuerte"
                  />
                }
                nota="Facturas de esta operación"
              />
            </KpiGrid>

            {/* Desglose por estado: lo que Cristian pregunta a media ruta.
                Va en una sola tarjeta para que no compita con las cifras. */}
            <Card className="p-3">
              <div
                className="flex flex-wrap items-center gap-2"
                aria-label="Pedidos por estado"
                role="group"
              >
                <span className="mst-label mr-1 text-[11px]">Por estado</span>
                <ChipRuta estado="CONFIRMADO" valor={data.ruta.confirmados} />
                <ChipRuta estado="EN_PRODUCCION" valor={data.ruta.enProduccion} />
                <ChipRuta estado="ENTREGADO" valor={data.ruta.entregados} />
                <ChipRuta estado="ANULADO" valor={data.ruta.anulados} />
              </div>
            </Card>

            <div className="grid gap-4 lg:grid-cols-[1.6fr_1fr] lg:items-start">
              <div className="grid gap-4">
                <Card className="w-full">
                  <Card.Header className="flex flex-col items-start gap-3 sm:flex-row sm:justify-between sm:gap-4">
                    <div className="min-w-0 flex flex-col gap-1">
                      <Card.Title>
                        {foco === "captura"
                          ? "Pedidos de la noche"
                          : "Pedidos de la operación"}
                      </Card.Title>
                      <Card.Description>
                        {listaNoche.meta
                          ? `${listaNoche.meta} pedidos · Operación ${etiquetaDiaSemanaCorto(data.fechaOperacion)} · Entrega ${etiquetaDiaSemanaCorto(data.fechaEntrega)}`
                          : `Operación ${etiquetaDiaSemanaCorto(data.fechaOperacion)} · Entrega ${etiquetaDiaSemanaCorto(data.fechaEntrega)}`}
                      </Card.Description>
                    </div>
                    <Button
                      size="sm"
                      variant="secondary"
                      onPress={() =>
                        router.push(
                          buildPedidosHref({
                            fechaOperacion: data.fechaOperacion,
                          }),
                        )
                      }
                    >
                      Ver todos
                    </Button>
                  </Card.Header>
                  <Card.Content className="p-0">
                  {pedidos.isLoading && !pedidos.data && (
                    <Skeleton className="mx-4 mb-4 h-32" />
                  )}
                  {pedidos.data && pedidos.data.length === 0 && (
                    <EmptyState
                      title="Todavía no hay pedidos"
                      description={copyVentana.empty}
                    />
                  )}
                  {pedidos.data && pedidos.data.length > 0 && (
                    <ul className="border-t border-[var(--border-subtle)]">
                      {listaNoche.visible.map((p) => (
                        <li key={p.id}>
                          <Link
                            href={hrefPedidoNoche({
                              fechaOperacion: data.fechaOperacion,
                              pedidoId: p.id,
                            })}
                            aria-label={`Pedido #${p.correlativo} ${p.clienteNombre}`}
                            className={cn(
                              "grid min-h-fila w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5 border-b border-[var(--border-subtle)] px-4 py-2.5 text-left",
                              "text-inherit no-underline transition-[background-color] duration-control ease-out hover:bg-tinta-50 hover:text-inherit hover:no-underline",
                              "focus-visible:outline-none focus-visible:shadow-foco",
                            )}
                          >
                            <ClienteAvatar
                              nombre={p.clienteNombre}
                              fotoAssetId={fotoPorCliente.get(p.clienteId)}
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
                                  {p.origen === "PORTAL" ? "Portal" : "Manual"} ·{" "}
                                  {horaEnZona(new Date(p.capturadoAt))}
                                </span>
                                <span className="ml-auto shrink-0">
                                  <Money
                                    centavos={p.totalCentavos}
                                    tone="muted"
                                    truncate
                                  />
                                </span>
                              </span>
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                  </Card.Content>
                </Card>

                <Card className="w-full">
                  <Card.Header className="flex flex-col gap-1 items-start">
                    <Card.Title>Aún no piden</Card.Title>
                    <Card.Description>
                      {clientesSinPedido.length > 0
                        ? `${clientesSinPedido.length} clientes activos sin pedido`
                        : "Clientes activos pendientes de pedir en esta operación"}
                    </Card.Description>
                  </Card.Header>
                  <Card.Content className="p-0">
                  {clientesSinPedido.length === 0 ? (
                    <p className="px-5 pb-5 pt-2 text-sm text-tinta-500">
                      Todos los clientes activos ya ingresaron pedido.
                    </p>
                  ) : (
                    <ScrollFadeLista
                      className="max-h-[min(22rem,50vh)] overflow-y-auto border-t border-[var(--border-subtle)]"
                      ariaLabel="Clientes sin pedido"
                    >
                      {clientesSinPedido.map((c) => (
                        <li key={c.clienteId}>
                          <Link
                            href={hrefClienteSinPedido(c.clienteId)}
                            aria-label={`Ficha de ${c.nombre}`}
                            className="flex min-h-fila items-center gap-3 border-b border-[var(--border-subtle)] px-4 py-2.5 text-inherit no-underline transition-[background-color] duration-control ease-out hover:bg-tinta-50 hover:text-inherit hover:no-underline focus-visible:outline-none focus-visible:shadow-foco"
                          >
                            <ClienteAvatar
                              nombre={c.nombre}
                              fotoAssetId={fotoPorCliente.get(c.clienteId)}
                              size="sm"
                            />
                            <span className="min-w-0 flex-1 truncate text-sm font-semibold text-pretty text-marca">
                              {c.nombre}
                            </span>
                            <span className="text-[12px] text-tinta-500">
                              Capture en Pedidos
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ScrollFadeLista>
                  )}
                  </Card.Content>
                </Card>
              </div>

              <div className="grid gap-4">
                <Card
                  className="w-full border-[var(--green-900)] bg-[var(--surface-brand)] text-[var(--text-on-brand)]"
                >
                  <Card.Header className="flex flex-col gap-1 items-start">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-[var(--green-200)]">
                      Ventana de captura
                    </p>
                    <Card.Title className="text-acento">
                      Cierre de la ventana
                    </Card.Title>
                    <Card.Description className="text-[var(--green-200)]">
                      {copyVentana.subtitle}
                    </Card.Description>
                  </Card.Header>
                  <Card.Content>
                  <div className="grid gap-3">
                    {horarioVentana ? (
                      <div
                        className="flex flex-wrap items-center gap-2"
                        aria-label="Horario de la ventana"
                      >
                        <span className="inline-flex min-h-7 items-center rounded-pill bg-acento px-3 text-xs font-semibold tabular-nums text-[var(--green-900)]">
                          Abre {horarioVentana.apertura.slice(0, 5)}
                        </span>
                        <span className="inline-flex min-h-7 items-center rounded-pill bg-[var(--yellow-200)] px-3 text-xs font-semibold tabular-nums text-[var(--amber-700)]">
                          Cierra {horarioVentana.cierre.slice(0, 5)}
                        </span>
                        <span className="inline-flex min-h-7 items-center rounded-pill border border-[var(--yellow-300)]/50 bg-[var(--yellow-100)]/15 px-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--yellow-200)]">
                          America/Guatemala
                        </span>
                      </div>
                    ) : null}
                    <div className="flex flex-wrap items-center gap-2">
                      <VentanaBadge
                        abierta={Boolean(calendario.data?.capturaAbierta)}
                        reabierta={capturaReabierta}
                        diaCerrado={capturaCerrada}
                        cierraAt={calendario.data?.cierraAt}
                        proximaAperturaAt={calendario.data?.proximaAperturaAt}
                      />
                      {capturaReabierta && (
                        <Chip color="warning" size="sm" variant="soft">
                          Reabierto
                        </Chip>
                      )}
                    </div>
                    <p className="text-sm leading-relaxed text-pretty text-[var(--green-100)]">
                      {capturaReabierta
                        ? "La hoja que ya imprimieron quedó vieja. Al cerrar de nuevo sale la hoja corregida, con los cambios resaltados."
                        : "Al cerrar se materializa la hoja de producción. El consolidado queda listo para descargar y enviar por WhatsApp. Un solo paso."}
                    </p>
                    {capturaReabierta && (
                      <p className="flex gap-2 rounded-campo border border-[var(--yellow-400)]/35 bg-[var(--yellow-100)]/90 px-3 py-2.5 text-sm leading-relaxed text-pretty text-[var(--amber-700)]">
                        <TriangleAlert
                          size={16}
                          className="mt-0.5 shrink-0"
                          aria-hidden
                        />
                        <span>
                          <strong className="font-semibold">
                            Este día no se cierra solo.
                          </strong>{" "}
                          El cierre automático del fin de la ventana no toca los
                          días reabiertos, para no pisar la corrección. Hasta
                          que cierre aquí, los pedidos siguen fuera de
                          producción y la hoja corregida no existe.
                        </span>
                      </p>
                    )}
                    <Button
                      variant="secondary"
                      size="lg"
                      className="w-full"
                      isDisabled={capturaCerrada || !puedeCerrar}
                      aria-label={
                        !puedeCerrar
                          ? "Solo quien tiene ventana.cerrar puede cerrar"
                          : capturaCerrada
                            ? "El día ya está cerrado"
                            : undefined
                      }
                      onPress={() => setCerrando(true)}
                    >
                      {capturaCerrada
                        ? "Día cerrado · hoja generada"
                        : capturaReabierta
                          ? "Volver a cerrar y corregir la hoja"
                          : "Cerrar ventana y generar hoja"}
                    </Button>
                    {!puedeCerrar && (
                      <p className="text-xs text-[var(--green-200)]">
                        Solo ADMIN o ADMIN_JEFE cierra la ventana.
                      </p>
                    )}
                    {capturaCerrada && (
                      <Button
                        variant="secondary"
                        className="w-full"
                        isDisabled={!puedeReabrir}
                        aria-label={
                          puedeReabrir
                            ? undefined
                            : "Solo ADMIN_JEFE puede reabrir un día cerrado"
                        }
                        onPress={() => setReabriendo(true)}
                      >
                        Reabrir día
                      </Button>
                    )}
                    {capturaCerrada && !puedeReabrir && (
                      <p className="text-xs text-[var(--green-200)]">
                        Solo ADMIN_JEFE puede reabrir un día cerrado.
                      </p>
                    )}
                    {capturaCerrada && (
                      <Link
                        href="/produccion"
                        className="text-center text-sm font-semibold text-acento no-underline hover:text-[var(--yellow-300)] hover:no-underline"
                      >
                        Ver hoja de producción
                      </Link>
                    )}
                  </div>
                  </Card.Content>
                </Card>

                <Card className="w-full">
                  <Card.Header className="flex flex-col gap-1 items-start">
                    <Card.Title>Clientes al límite</Card.Title>
                    <Card.Description>Alerta informativa · no bloquea entrega ni cobro</Card.Description>
                  </Card.Header>
                  <Card.Content className="p-0">
                  {(cartera.data?.clientesSobreLimite.length ?? 0) === 0 ? (
                    <p className="px-5 pb-5 pt-2 text-sm text-tinta-500">
                      Ningún cliente supera el límite de crédito.
                    </p>
                  ) : (
                    <div className="grid gap-2 px-4 pb-4">
                      {cartera.data?.clientesSobreLimite.map((c) => (
                        <ContadorFacturas
                          key={c.clienteId}
                          pendientes={c.pendientes}
                          limite={c.limite}
                          etiqueta={c.nombre}
                          href={hrefLimiteCredito(c.clienteId)}
                        />
                      ))}
                    </div>
                  )}
                  </Card.Content>
                </Card>

                {puedeConfirmarTransferencias && transferenciasPendientes > 0 ? (
                  <Card className="w-full border-[var(--yellow-500)]/40 bg-[var(--yellow-500)]/5">
                    <Card.Header className="flex flex-col gap-1 items-start">
                      <Card.Title>Transferencias en revisión</Card.Title>
                      <Card.Description>
                        Reportadas por clientes; el saldo no baja hasta confirmarlas.
                      </Card.Description>
                    </Card.Header>
                    <Card.Content className="flex flex-col gap-3 px-5 pb-5">
                      <p className="text-sm text-tinta-700">
                        {transferenciasPendientes} transferencia
                        {transferenciasPendientes === 1 ? "" : "s"} pendiente
                        {transferenciasPendientes === 1 ? "" : "s"} de confirmación.
                      </p>
                      <Button
                        variant="tertiary"
                        className="self-start"
                        onPress={() =>
                          router.push("/cartera?panel=transferencias")
                        }
                      >
                        Revisar en cartera
                      </Button>
                    </Card.Content>
                  </Card>
                ) : null}
              </div>
            </div>
          </>
        )}
      </div>

      <DialogoCierre
        open={cerrando}
        resumen={operacionCaptura.data}
        loading={cerrar.isPending}
        onClose={() => setCerrando(false)}
        onConfirm={() => cerrar.mutate()}
      />
      <DialogoReabrir
        open={reabriendo}
        loading={reabrir.isPending}
        error={errorReabrir}
        onClose={() => setReabriendo(false)}
        onConfirm={(motivo) => reabrir.mutate(motivo)}
      />
    </PanelShell>
  );
}

export default function HoyPage() {
  return (
    <Suspense
      fallback={
        <PanelShell title="Hoy">
          <Skeleton className="h-48" />
        </PanelShell>
      }
    >
      <HoyInner />
    </Suspense>
  );
}

