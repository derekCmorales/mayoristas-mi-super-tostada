"use client";

import { Suspense, startTransition, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import {
  Alert,
  Button,
  Card,
  Spinner,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { ChevronLeft, Phone, Truck } from "lucide-react";
import {
  MENSAJE_GUARDAR_TELEFONO,
  MENSAJE_RUTA_SIN_SNAPSHOT,
  MENSAJE_SIN_SENAL,
  tienePermiso,
  type ActorPublico,
  type CalendarioAhora,
  type FilaCola,
  type RepartoAtrasados,
  type RutaParada,
  type RutaReparto,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { PanelShell } from "@/components/layout/panel-shell";
import { useColaOffline } from "@/hooks/use-cola-offline";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiCard, KpiGrid, KpiGridSkeleton } from "@/components/ui/kpi-grid";
import { EstadoBadge } from "@/components/domain/estado-badge";
import { Money } from "@/components/domain/money";
import { EntregaForm } from "@/components/fulfillment/entrega-form";
import {
  ParadaCard,
  ParadaCardSkeleton,
} from "@/components/fulfillment/parada-card";
import { DialogoPago } from "@/components/receivables/dialogo-pago";
import { ChipInstalar } from "@/components/feedback/chip-instalar";
import { CintaEje } from "@/components/domain/cinta-eje";
import { copyEjeReparto, capturaCerradaAnticipada } from "@/lib/ejes-vista";
import { avisoReabierto } from "@/lib/reabierto-vista";
import { ClienteAvatar } from "@/components/catalog/cliente-avatar";
import { toastFromError, toastSuccess } from "@/lib/toast";
import { etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import { DateField } from "@/components/ui/date-field";
import { Skeleton } from "@/components/ui/skeleton";
import { AvisoAtrasados } from "@/components/fulfillment/aviso-atrasados";
import {
  PARAM_DIA_REPARTO,
  diaRepartoDesdeParam,
  diasAtrasadosVisibles,
  hrefRepartoDia,
} from "@/lib/reparto-dia";
import { cn } from "@/lib/utils";
import {
  cobradoPendienteColaCentavos,
  desgloseCobroParada,
  paradaConColaLocal,
  saldoParadaCentavos,
  siguienteTrasCobro,
  siguienteTrasEntrega,
  siguienteTrasVolver,
  vistaInicialParada,
  type DestinoReparto,
  type VistaParada,
} from "@/lib/reparto-vista";

type FiltroRuta = "todas" | "pendientes" | "entregados";

/* Barra inferior fija: el CTA de cada parada vive siempre en el mismo sitio,
   a la altura del pulgar, y ocupa todo el ancho. En ruta no se busca botón. */
const BARRA_FIJA =
  "fixed inset-x-0 bottom-[var(--bottombar-height)] z-20 border-t border-[var(--border-subtle)] bg-blanco/95 px-4 py-3 backdrop-blur-sm lg:static lg:inset-auto lg:border-0 lg:bg-transparent lg:p-0 lg:backdrop-blur-none";
const CTA = "w-full min-h-14 text-base";

function RepartoInner() {
  const router = useRouter();
  const sp = useSearchParams();
  const cola = useColaOffline();
  const [sel, setSel] = useState<string | null>(null);
  const [vista, setVista] = useState<VistaParada>("entrega");
  const [filtro, setFiltro] = useState<FiltroRuta>("todas");
  const [cantidades, setCantidades] = useState<Map<string, number>>(new Map());
  const [cobrando, setCobrando] = useState(false);
  const [error, setError] = useState<string>();
  const [guardando, setGuardando] = useState(false);

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  // La cinta de eje no puede depender de la ruta: offline la ruta viene del
  // snapshot de IndexedDB y puede ser de ayer. El calendario dice qué día es
  // de verdad; si no hay señal, no se rotula nada en vez de mentir.
  const calendario = useQuery({
    queryKey: ["calendario", "ahora"],
    queryFn: () => api<CalendarioAhora>("/calendario/ahora"),
    enabled: Boolean(me.data),
    refetchInterval: 60_000,
  });
  // Día de calle que se está viendo: `null` es hoy. Un día anterior sirve
  // para marcar lo que se quedó sin registrar; nunca pisa el snapshot de hoy,
  // que es con el que Tony sale a la calle sin señal.
  const diaVista = diaRepartoDesdeParam(
    sp.get(PARAM_DIA_REPARTO),
    calendario.data?.hoyCivil,
  );
  const ruta = useQuery({
    queryKey: ["ruta", diaVista ?? "hoy"],
    queryFn: async () => {
      if (diaVista) return api<RutaReparto>(hrefRepartoDia(diaVista));
      try {
        const data = await api<RutaReparto>("/reparto");
        await cola.guardarSnapshot(data);
        return data;
      } catch (err) {
        const snap = await cola.leerSnapshot();
        if (snap) return snap;
        throw err;
      }
    },
    enabled: Boolean(me.data) && cola.listo,
  });
  // Bajo la clave «ruta» para que una entrega —propia, de la cola offline o
  // por SSE— lo refresque sin cablear nada aparte.
  const atrasados = useQuery({
    queryKey: ["ruta", "atrasados"],
    queryFn: () => api<RepartoAtrasados>("/reparto/atrasados"),
    enabled: Boolean(me.data),
  });
  const diasAtrasados = diasAtrasadosVisibles(atrasados.data, diaVista);

  function verDia(fecha: string | null) {
    const destino = diaRepartoDesdeParam(fecha, calendario.data?.hoyCivil);
    setSel(null);
    setFiltro("todas");
    startTransition(() => router.replace(hrefRepartoDia(destino)));
  }

  // Snapshot offline de otro día: la ruta se ve, pero no se presenta como
  // la de hoy. «UI honesta» también aplica a la fecha.
  const rutaDesfasada =
    !diaVista &&
    ruta.data?.fechaEntrega &&
    calendario.data &&
    ruta.data.fechaEntrega !== calendario.data.hoyCivil
      ? ruta.data.fechaEntrega
      : null;

  const puedeEntregar = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "pedidos.entregar",
  );
  const puedeCobrar = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "cobranza.registrar_pago",
  );
  const aviso = avisoReabierto(calendario.data);
  const cierreAnticipado = capturaCerradaAnticipada(calendario.data);

  const paradasEfectivas = useMemo(
    () =>
      (ruta.data?.paradas ?? []).map((p) =>
        paradaConColaLocal(p, cola.cola),
      ),
    [ruta.data?.paradas, cola.cola],
  );

  const parada = paradasEfectivas.find((p) => p.pedidoId === sel) ?? null;

  const entregados =
    paradasEfectivas.filter((p) => p.estado === "ENTREGADO").length;
  const total = paradasEfectivas.length;
  const pendientes = total - entregados;

  // Lo cobrado sin señal es de hoy: en un día anterior no se suma.
  const cobradoLocalCentavos = useMemo(
    () => (diaVista ? 0 : cobradoPendienteColaCentavos(cola.cola)),
    [cola.cola, diaVista],
  );

  const porCobrarCentavos = useMemo(
    () =>
      paradasEfectivas.reduce(
        (acc, p) =>
          acc +
          saldoParadaCentavos({
            saldoAnteriorCentavos: p.saldoAnteriorCentavos,
            facturaSaldoCentavos: p.factura?.saldoCentavos,
          }),
        0,
      ),
    [paradasEfectivas],
  );

  const paradasFiltradas = useMemo(() => {
    if (filtro === "pendientes") {
      return paradasEfectivas.filter((p) => p.estado !== "ENTREGADO");
    }
    if (filtro === "entregados") {
      return paradasEfectivas.filter((p) => p.estado === "ENTREGADO");
    }
    return paradasEfectivas;
  }, [paradasEfectivas, filtro]);

  function aplicarDestino(destino: DestinoReparto) {
    if (destino === "ruta") {
      setSel(null);
      return;
    }
    setVista(destino);
  }

  function abrir(p: RutaParada) {
    setSel(p.pedidoId);
    setError(undefined);
    setCantidades(new Map());
    const saldo = saldoParadaCentavos({
      saldoAnteriorCentavos: p.saldoAnteriorCentavos,
      facturaSaldoCentavos: p.factura?.saldoCentavos,
    });
    setVista(
      vistaInicialParada({
        estado: p.estado,
        saldoCentavos: saldo,
        entregaLocal: cola.pedidoPendiente(p.pedidoId),
      }),
    );
  }

  function volverDesde(vistaActual: VistaParada, p: RutaParada) {
    const yaEntregado =
      p.estado === "ENTREGADO" || cola.pedidoPendiente(p.pedidoId);
    aplicarDestino(siguienteTrasVolver({ vista: vistaActual, yaEntregado }));
  }

  async function guardarEntrega(paradaActual: RutaParada) {
    setError(undefined);
    setGuardando(true);
    try {
      await cola.encolarEntrega({
        tipo: "ENTREGA",
        idempotencyKey: crypto.randomUUID(),
        pedidoId: paradaActual.pedidoId,
        items: paradaActual.items.map((i) => ({
          ...(i.id ? { itemId: i.id } : { productoId: i.productoId }),
          cantidadEntregada:
            cantidades.get(i.id ?? i.productoId) ?? i.cantidadPedida,
        })),
      });
      const saldo = saldoParadaCentavos({
        saldoAnteriorCentavos: paradaActual.saldoAnteriorCentavos,
        facturaSaldoCentavos: paradaActual.factura?.saldoCentavos,
      });
      aplicarDestino(siguienteTrasEntrega(saldo));
      toastSuccess(cola.online ? "Entrega guardada" : MENSAJE_GUARDAR_TELEFONO);
    } catch (err) {
      const msg =
        err instanceof Error
          ? err.message
          : "No se pudo guardar en este teléfono";
      setError(msg);
      toastFromError(err, msg);
    } finally {
      setGuardando(false);
    }
  }

  return (
    <PanelShell title="Reparto">
      {!sel && (
        <div className="grid gap-5">
          <ChipInstalar />
          {calendario.data && !diaVista ? (
            <CintaEje copy={copyEjeReparto(calendario.data)} />
          ) : null}
          <SelectorDia
            diaVista={diaVista}
            hoy={calendario.data?.hoyCivil}
            onDia={verDia}
          />
          {diaVista ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>
                  Ruta del {etiquetaDiaSemanaCorto(diaVista)}
                </Alert.Title>
                <Alert.Description>
                  Es un día anterior. Lo que marque aquí queda registrado hoy
                  como entrega tardía de ese reparto, y su factura pasa a la
                  cartera para poder cobrarla.
                </Alert.Description>
              </Alert.Content>
              <Button size="sm" variant="secondary" onPress={() => verDia(null)}>
                Volver a hoy
              </Button>
            </Alert>
          ) : null}
          {rutaDesfasada ? (
            <Alert status="warning">
              <Alert.Indicator />
              <Alert.Content>
                <Alert.Title>Ruta guardada sin señal</Alert.Title>
                <Alert.Description>
                  Esta ruta es del {etiquetaDiaSemanaCorto(rutaDesfasada)},
                  guardada sin señal. Vuelva a cargar al recuperar conexión.
                </Alert.Description>
              </Alert.Content>
            </Alert>
          ) : null}

          <AvisoAtrasados dias={diasAtrasados} />

          <ResumenRuta
            cargando={ruta.isLoading}
            etiquetaCobrado={
              diaVista
                ? `Cobrado el ${etiquetaDiaSemanaCorto(diaVista)}`
                : "Cobrado hoy"
            }
            entregados={entregados}
            total={total}
            pendientes={pendientes}
            cobradoHoyCentavos={
              (ruta.data?.cobradoHoyCentavos ?? 0) + cobradoLocalCentavos
            }
            porCobrarCentavos={porCobrarCentavos}
          />

          {total > 4 && (
            <div className="mst-segmento-activo flex flex-wrap items-center justify-between gap-2">
              <ToggleButtonGroup
                aria-label="Filtrar paradas"
                className="w-full sm:w-auto"
                disallowEmptySelection
                fullWidth
                selectedKeys={new Set([filtro])}
                selectionMode="single"
                size="lg"
                onSelectionChange={(keys) => {
                  const next = [...keys][0];
                  if (typeof next === "string") setFiltro(next as FiltroRuta);
                }}
              >
                {(
                  [
                    { id: "todas", label: "Todas", count: total },
                    { id: "pendientes", label: "Pendientes", count: pendientes },
                    { id: "entregados", label: "Entregados", count: entregados },
                  ] as const
                ).map((f, i) => (
                  <ToggleButton
                    key={f.id}
                    id={f.id}
                    className="min-h-12 transition-colors duration-control ease-out"
                  >
                    {i > 0 && <ToggleButtonGroup.Separator />}
                    {f.label}
                    <span className="tabular-nums text-tinta-500">
                      {f.count}
                    </span>
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
              <p className="mst-label tabular-nums" aria-live="polite">
                {paradasFiltradas.length} de {total}
              </p>
            </div>
          )}

          {ruta.isLoading && (
            <div className="grid gap-3">
              <ParadaCardSkeleton />
              <ParadaCardSkeleton />
              <ParadaCardSkeleton />
            </div>
          )}
          {ruta.isError && !ruta.data && (
            <EmptyState
              title={
                diaVista
                  ? "No se pudo cargar la ruta de ese día"
                  : MENSAJE_RUTA_SIN_SNAPSHOT
              }
              description={
                diaVista
                  ? "Los días anteriores solo se consultan con señal. Lo que ya marcó sigue en la cola de este teléfono."
                  : "Tony arranca en planta. Sin esa carga no hay paradas que inventar."
              }
              icon={<Truck size={22} aria-hidden />}
              action={
                diaVista ? (
                  <Button
                    size="lg"
                    variant="secondary"
                    onPress={() => void ruta.refetch()}
                  >
                    Reintentar
                  </Button>
                ) : undefined
              }
            />
          )}
          {diaVista && ruta.data && ruta.data.paradas.length === 0 && (
            <EmptyState
              title="Ese día no tuvo ruta"
              description="No hubo pedidos en producción para repartir ese día."
              icon={<Truck size={22} aria-hidden />}
            />
          )}
          {!diaVista && ruta.data && ruta.data.paradas.length === 0 && (
            <EmptyState
              title={
                aviso?.bloqueaOperacion
                  ? "La operación de esta ruta está reabierta"
                  : cierreAnticipado
                    ? "La ruta aparece el día de entrega"
                    : "No hay ruta hasta que se cierre la ventana"
              }
              description={
                // Con el día reabierto los pedidos existen y están confirmados,
                // pero siguen fuera de la ruta. Decir solo «cierre la ventana»
                // apunta a la de esta noche, que no es la que hay que cerrar.
                aviso?.bloqueaOperacion
                  ? aviso.detalle
                  : cierreAnticipado && calendario.data?.fechaEntregaCaptura
                    ? `El cierre de esta noche ya generó la hoja. La ruta se arma el ${etiquetaDiaSemanaCorto(calendario.data.fechaEntregaCaptura)}.`
                    : "Al cerrar se pasan los pedidos a producción y aparecen aquí, ordenados por horario de entrega."
              }
              icon={<Truck size={22} aria-hidden />}
            />
          )}
          {ruta.data &&
            ruta.data.paradas.length > 0 &&
            paradasFiltradas.length === 0 && (
              <EmptyState
                title={
                  filtro === "pendientes"
                    ? "No quedan pendientes"
                    : "Sin entregados aún"
                }
                description="Cambia el filtro para ver el resto de la ruta."
                icon={<Truck size={22} aria-hidden />}
                action={
                  <Button
                    size="lg"
                    variant="secondary"
                    onPress={() => setFiltro("todas")}
                  >
                    Ver toda la ruta
                  </Button>
                }
              />
            )}
          {paradasFiltradas.length > 0 && (
            <div className="grid gap-3">
              {paradasFiltradas.map((p) => (
                <ParadaCard
                  key={p.pedidoId}
                  parada={p}
                  sinSincronizar={cola.pedidoPendiente(p.pedidoId)}
                  onAbrir={() => abrir(p)}
                />
              ))}
            </div>
          )}
          <ListaColaErrores filas={cola.cola} />
        </div>
      )}

      {sel && parada && vista === "entrega" && (
        <DetalleEntrega
          parada={parada}
          diaAnterior={diaVista}
          online={cola.online}
          puedeEntregar={puedeEntregar}
          puedeCobrar={puedeCobrar}
          error={error}
          loading={guardando}
          sinSincronizar={cola.pedidoPendiente(parada.pedidoId)}
          onBack={() => volverDesde("entrega", parada)}
          onCantidades={setCantidades}
          onEntregar={() => void guardarEntrega(parada)}
          onCobrar={() => setVista("cobro")}
        />
      )}

      {sel && parada && vista === "cobro" && (
        <DetalleCobro
          parada={parada}
          diaAnterior={diaVista}
          online={cola.online}
          puedeCobrar={puedeCobrar}
          error={error}
          sinSincronizar={cola.pedidoPendiente(parada.pedidoId)}
          onBack={() => volverDesde("cobro", parada)}
          onCobrar={() => setCobrando(true)}
        />
      )}

      {parada && (
        <DialogoPago
          key={parada.pedidoId}
          open={cobrando}
          titulo="Registrar cobro"
          descripcion={`${parada.clienteNombre} · se aplica a las facturas más antiguas`}
          saldoCentavos={saldoParadaCentavos({
            saldoAnteriorCentavos: parada.saldoAnteriorCentavos,
            facturaSaldoCentavos: parada.factura?.saldoCentavos,
          })}
          online={cola.online}
          permitirOffline
          error={error}
          onClose={() => setCobrando(false)}
          onConfirm={(input) => {
            setError(undefined);
            const blobId = input.archivo ? crypto.randomUUID() : undefined;
            void cola
              .encolarPago(
                {
                  tipo: "PAGO",
                  idempotencyKey: input.id,
                  pagoId: input.id,
                  clienteId: parada.clienteId,
                  pedidoId: parada.pedidoId,
                  montoCentavos: input.montoCentavos,
                  metodo: input.metodo,
                  blobId,
                },
                input.archivo,
              )
              .then(() => {
                setCobrando(false);
                aplicarDestino(siguienteTrasCobro());
                toastSuccess(
                  cola.online ? "Cobro guardado" : MENSAJE_GUARDAR_TELEFONO,
                );
              })
              .catch((err: unknown) => {
                const msg =
                  err instanceof ApiError || err instanceof Error
                    ? err.message
                    : "No se pudo guardar en este teléfono";
                setError(msg);
                toastFromError(err, msg);
              });
          }}
        />
      )}
    </PanelShell>
  );
}

/* El día de calle se elige aquí; por defecto, hoy. Solo días hasta hoy: la
   ruta de mañana no existe hasta que cierra la ventana. */
function SelectorDia({
  diaVista,
  hoy,
  onDia,
}: {
  diaVista: string | null;
  hoy: string | undefined;
  onDia: (fecha: string | null) => void;
}) {
  if (!hoy) return null;
  return (
    <DateField
      id="reparto-dia"
      label="Día de reparto"
      className="w-full sm:max-w-xs"
      value={diaVista ?? hoy}
      max={hoy}
      fechaHoy={hoy}
      presets={["hoy"]}
      clearable={false}
      onChange={(fecha) => onDia(fecha || null)}
    />
  );
}

/* Cuatro cifras: cuánto llevo, cuánto falta, cuánto entró y cuánto queda por
   cobrar. Es el mismo formato de KPIs de clientes y catálogo. */
function ResumenRuta({
  cargando,
  etiquetaCobrado,
  entregados,
  total,
  pendientes,
  cobradoHoyCentavos,
  porCobrarCentavos,
}: {
  cargando: boolean;
  etiquetaCobrado: string;
  entregados: number;
  total: number;
  pendientes: number;
  cobradoHoyCentavos: number;
  porCobrarCentavos: number;
}) {
  if (cargando) {
    return <KpiGridSkeleton count={4} />;
  }

  return (
    <KpiGrid>
      <KpiCard
        etiqueta="Entregas"
        valor={
          <>
            {entregados}
            <span className="text-sm font-medium text-tinta-500">/{total}</span>
          </>
        }
        tono="ok"
      />
      <KpiCard
        etiqueta="Paradas pendientes"
        valor={pendientes}
        tono={pendientes > 0 ? "aviso" : "ok"}
      />
      <KpiCard
        etiqueta={etiquetaCobrado}
        valor={<Money centavos={cobradoHoyCentavos} tone="pagado" truncate />}
      />
      <KpiCard
        etiqueta="Por cobrar en ruta"
        valor={
          <Money
            centavos={porCobrarCentavos}
            tone={porCobrarCentavos > 0 ? "pendiente" : "muted"}
            truncate
          />
        }
      />
    </KpiGrid>
  );
}

/** Solo reintentos fallidos / sesión; OfflineBanner cubre la cola pendiente. */
function ListaColaErrores({ filas }: { filas: FilaCola[] }) {
  const problemas = filas.filter(
    (f) => f.estado === "error" || f.estado === "sesion",
  );
  if (problemas.length === 0) return null;
  return (
    <Card className="gap-3 p-4">
      <Card.Header>
        <Card.Title>Reintentos en este teléfono</Card.Title>
        <Card.Description>
          Falló el envío. El cuadre solo con señal.
        </Card.Description>
      </Card.Header>
      <Card.Content>
        <ul className="grid gap-2 text-sm">
          {problemas.map((f) => (
            <li key={f.idempotencyKey} className="flex items-center gap-2">
              <EstadoBadge estado="SIN_SINCRONIZAR" size="sm" />
              <span className="min-w-0 flex-1 truncate text-tinta-800">
                {f.tipo === "ENTREGA" ? "Entrega" : "Cobro"}
                {f.estado === "error" && f.errorMensaje
                  ? ` · ${f.errorMensaje}`
                  : ""}
                {f.estado === "sesion" ? " · inicia sesión" : ""}
              </span>
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  );
}

function CabeceraParada({
  parada,
  sinSincronizar,
  onBack,
}: {
  parada: RutaParada;
  sinSincronizar: boolean;
  onBack: () => void;
}) {
  return (
    <div className="grid gap-3">
      <Button
        className="self-start"
        size="lg"
        variant="tertiary"
        onPress={onBack}
      >
        <ChevronLeft size={18} aria-hidden />
        Ruta
      </Button>
      <Card className="gap-3 p-4">
        <Card.Header className="flex-col items-start gap-3 sm:flex-row">
          <ClienteAvatar
            nombre={parada.clienteNombre}
            fotoAssetId={parada.fotoAssetId}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Card.Title className="min-w-0 text-[17px] leading-snug text-pretty text-tinta-900">
                {parada.clienteNombre}
              </Card.Title>
              {sinSincronizar && (
                <EstadoBadge estado="SIN_SINCRONIZAR" size="sm" />
              )}
            </div>
            <p className="mt-0.5 text-xs tabular-nums text-tinta-500">
              Entrega {parada.horarioEntregaFijo ?? "sin horario fijo"}
              <span className="font-mono"> · #{parada.correlativo}</span>
            </p>
          </div>
          {/* Enlace nativo: `tel:` es navegación, no una acción de botón. Se
              le da el mismo tamaño que un Button lg para el dedo con guante. */}
          {parada.telefonoWa && (
            <a
              href={`tel:${parada.telefonoWa}`}
              aria-label={`Llamar a ${parada.clienteNombre}`}
              className="inline-flex h-13 w-full shrink-0 items-center justify-center gap-2 rounded-pill border border-[var(--border-default)] bg-blanco px-5 text-base font-semibold text-tinta-900 shadow-[var(--shadow-xs)] no-underline transition-[border-color,box-shadow] duration-control ease-out hover:border-[var(--border-strong)] hover:bg-tinta-50 hover:no-underline focus-visible:outline-none focus-visible:shadow-foco sm:w-auto"
            >
              <Phone size={20} aria-hidden />
              Llamar
            </a>
          )}
        </Card.Header>
        {parada.notasPermanentes ? (
          <Card.Content className="rounded-[calc(var(--radius-card)-6px)] bg-[var(--ink-50)] px-3 py-2.5">
            <p className="mst-label text-[11px]">Nota del cliente</p>
            <p className="mt-0.5 text-sm text-pretty text-tinta-800">
              {parada.notasPermanentes}
            </p>
          </Card.Content>
        ) : null}
      </Card>
    </div>
  );
}

function DetalleEntrega({
  parada,
  diaAnterior,
  online,
  puedeEntregar,
  puedeCobrar,
  error,
  loading,
  sinSincronizar,
  onBack,
  onCantidades,
  onEntregar,
  onCobrar,
}: {
  parada: RutaParada;
  /** Día de calle ya pasado del que viene la parada; `null` si es hoy. */
  diaAnterior: string | null;
  online: boolean;
  puedeEntregar: boolean;
  puedeCobrar: boolean;
  error?: string;
  loading?: boolean;
  sinSincronizar: boolean;
  onBack: () => void;
  onCantidades: (c: Map<string, number>) => void;
  onEntregar: () => void;
  onCobrar: () => void;
}) {
  const entregadoServidor = parada.estado === "ENTREGADO";
  // Sin permiso de cobro el botón llevaba a una pantalla cuyo CTA está
  // deshabilitado: mejor no ofrecer el viaje.
  const puedeAbrirCobro = puedeCobrar && (entregadoServidor || sinSincronizar);

  return (
    <div className="grid gap-4 pb-[calc(var(--bottombar-height)+5rem)]">
      <CabeceraParada
        parada={parada}
        sinSincronizar={sinSincronizar}
        onBack={onBack}
      />
      {diaAnterior && !entregadoServidor ? (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>
              Pedido del reparto del {etiquetaDiaSemanaCorto(diaAnterior)}
            </Alert.Title>
            <Alert.Description>
              Ajuste lo que realmente se entregó ese día. Se registra como
              entrega tardía y la factura sale sobre estas cantidades.
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      <Card className="gap-0 overflow-hidden p-0">
        <Card.Header className="p-4 pb-3">
          <Card.Title>Lo entregado</Card.Title>
          <Card.Description>
            La factura se calcula sobre esto, no sobre lo pedido
          </Card.Description>
        </Card.Header>
        <Card.Content className="p-0">
          {/*
            Sin `pedidoEntregar` los steppers eran editables aunque el botón de
            guardar estuviera bloqueado: se podía «ajustar» una entrega que nunca
            se iba a enviar.
          */}
          <EntregaForm
            key={parada.pedidoId}
            items={parada.items}
            disabled={entregadoServidor || !puedeEntregar}
            onChange={onCantidades}
          />
        </Card.Content>
      </Card>
      {parada.saldoAnteriorCentavos > 0 && (
        <Card className="gap-3 border-l-[4px] border-l-[var(--amber-600)] p-4">
          <Card.Header>
            <Card.Title>Saldo anterior</Card.Title>
            <Card.Description>
              {parada.facturasPendientes} facturas pendientes
            </Card.Description>
          </Card.Header>
          <Card.Content className="flex-col flex-wrap items-stretch justify-between gap-3 sm:flex-row sm:items-center">
            <Money
              centavos={parada.saldoAnteriorCentavos}
              tone="pendiente"
              truncate
              className="text-2xl"
            />
            <Button
              className="min-h-12 w-full sm:w-auto"
              isDisabled={!puedeAbrirCobro}
              size="lg"
              variant="secondary"
              onPress={onCobrar}
            >
              Registrar cobro
            </Button>
          </Card.Content>
        </Card>
      )}
      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No se guardó</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {!online && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{MENSAJE_SIN_SENAL}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {!puedeEntregar && (
        <p className="text-center text-sm text-tinta-500">
          Producción ve la misma ruta. No marca entregas.
        </p>
      )}
      <div className={BARRA_FIJA}>
        <div className="mx-auto w-full max-w-[var(--page-max)]">
          <Button
            className={CTA}
            isDisabled={entregadoServidor || !puedeEntregar}
            isPending={loading}
            size="lg"
            variant="primary"
            onPress={onEntregar}
          >
            {({ isPending }) => (
              <>
                {isPending && <Spinner color="current" size="sm" />}
                {entregadoServidor
                  ? "Entrega registrada"
                  : online
                    ? "Marcar como entregado"
                    : MENSAJE_GUARDAR_TELEFONO}
              </>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function DetalleCobro({
  parada,
  diaAnterior,
  online,
  puedeCobrar,
  error,
  sinSincronizar,
  onBack,
  onCobrar,
}: {
  parada: RutaParada;
  diaAnterior: string | null;
  online: boolean;
  puedeCobrar: boolean;
  error?: string;
  sinSincronizar: boolean;
  onBack: () => void;
  onCobrar: () => void;
}) {
  const cobro = desgloseCobroParada({
    saldoAnteriorCentavos: parada.saldoAnteriorCentavos,
    factura: parada.factura,
  });
  const saldo = cobro.saldoTotalCentavos;
  const parcialHoy = cobro.facturaAbonadoCentavos > 0;
  // En la ruta de un día anterior la factura de la parada no es «la de hoy».
  const deLaParada = diaAnterior
    ? `del reparto del ${etiquetaDiaSemanaCorto(diaAnterior)}`
    : "de hoy";

  return (
    <div className="grid gap-4 pb-[calc(var(--bottombar-height)+5rem)]">
      <CabeceraParada
        parada={parada}
        sinSincronizar={sinSincronizar}
        onBack={onBack}
      />
      <Card
        className={cn(
          "gap-3 border-l-[4px] p-4",
          parcialHoy ? "border-l-[var(--green-600)]" : "border-l-[var(--amber-600)]",
        )}
      >
        <Card.Header>
          <Card.Title>
            {parcialHoy ? "Abono parcial" : "Por cobrar"}
          </Card.Title>
          <Card.Description>
            {cobro.saldoAnteriorCentavos > 0
              ? "El cobro se aplica primero a facturas anteriores"
              : `Cobro de la factura ${deLaParada}`}
          </Card.Description>
        </Card.Header>
        <Card.Content className="grid gap-3">
          {parcialHoy && (
            <div className="flex items-center justify-between gap-2 rounded-[calc(var(--radius-card)-6px)] bg-[var(--green-50)] px-3 py-2.5">
              <span className="text-sm text-tinta-700">
                {diaAnterior ? "Abonado a esta factura" : "Cobrado hoy"}
              </span>
              <Money
                centavos={cobro.facturaAbonadoCentavos}
                tone="pagado"
                className="text-xl font-semibold"
              />
            </div>
          )}
          {cobro.facturaSaldoCentavos > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-tinta-700">
                {diaAnterior ? "Debe de esta factura" : "Debe hoy"}
              </span>
              <Money
                centavos={cobro.facturaSaldoCentavos}
                tone="pendiente"
                className="text-xl font-semibold"
              />
            </div>
          )}
          {cobro.saldoAnteriorCentavos > 0 && (
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm text-tinta-700">Saldo anterior</span>
              <Money
                centavos={cobro.saldoAnteriorCentavos}
                tone="pendiente"
                className="text-lg"
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-subtle)] pt-3">
            <span className="text-sm font-semibold text-tinta-900">Total</span>
            <Money centavos={saldo} tone="pendiente" truncate className="text-3xl" />
            {sinSincronizar && <EstadoBadge estado="SIN_SINCRONIZAR" size="sm" />}
            {parada.factura?.estado === "ABONO_PARCIAL" && (
              <EstadoBadge estado="ABONO_PARCIAL" size="sm" />
            )}
          </div>
        </Card.Content>
      </Card>
      {error && (
        <Alert status="danger">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Title>No se guardó</Alert.Title>
            <Alert.Description>{error}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {!online && (
        <Alert status="warning">
          <Alert.Indicator />
          <Alert.Content>
            <Alert.Description>{MENSAJE_SIN_SENAL}</Alert.Description>
          </Alert.Content>
        </Alert>
      )}
      {!puedeCobrar && (
        <p className="text-center text-sm text-tinta-500">
          No tiene permiso para cobrar.
        </p>
      )}
      <div className={BARRA_FIJA}>
        <div className="mx-auto w-full max-w-[var(--page-max)]">
          <Button
            className={CTA}
            isDisabled={!puedeCobrar || saldo <= 0}
            size="lg"
            variant="primary"
            onPress={onCobrar}
          >
            {online ? "Registrar cobro" : MENSAJE_GUARDAR_TELEFONO}
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function RepartoPage() {
  return (
    <Suspense
      fallback={
        <PanelShell title="Reparto">
          <Skeleton className="h-48" />
        </PanelShell>
      }
    >
      <RepartoInner />
    </Suspense>
  );
}
