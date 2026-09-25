"use client";

import {
  Alert,
  Button,
  Chip,
  SearchField,
  ToggleButton,
  ToggleButtonGroup,
} from "@heroui/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronLeft, MessageCircle } from "lucide-react";
import { Suspense, useEffect, useMemo, useState, useTransition } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  MENSAJE_VENTANA_WA_CERRADA,
  tienePermiso,
  type ActorPublico,
  type ConexionWabaPublica,
  type ConversacionBandeja,
  type ConversacionDetalle,
  type PlantillaWaPublica,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import {
  aplicarSegmentoLista,
  buildConversacionesHref,
  conteosSegmento,
  copyEmptySegmento,
  copyVentanaWhatsapp,
  filtrarBandeja,
  parseConversacionSegmento,
  type ConversacionSegmento,
} from "@/lib/conversacion-vista";
import { PanelShell } from "@/components/layout/panel-shell";
import { PageToolbar } from "@/components/layout/page-header";
import { ListaConversaciones } from "@/components/messaging/lista-conversaciones";
import { HiloConversacion } from "@/components/messaging/hilo-conversacion";
import { ComposerWhatsapp } from "@/components/messaging/composer-whatsapp";
import { FichaRestaurante } from "@/components/messaging/ficha-restaurante";
import { VentanaBadge } from "@/components/domain/ventana-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { toastFromError, toastInfo, toastSuccess } from "@/lib/toast";
import { cn } from "@/lib/utils";

const SEGMENTOS: Array<{ id: ConversacionSegmento; label: string }> = [
  { id: "por_contestar", label: "Por contestar" },
  { id: "puedo_responder", label: "Puedo responder" },
  { id: "todas", label: "Todas" },
];

export default function ConversacionesPage() {
  return (
    <Suspense fallback={<ConversacionesSkeleton />}>
      <ConversacionesInner />
    </Suspense>
  );
}

function ConversacionesInner() {
  const qc = useQueryClient();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();

  const idUrl = searchParams.get("id");
  const segmentoUrl = parseConversacionSegmento(searchParams.get("segmento"));
  const searchKey = searchParams.toString();

  const [q, setQ] = useState("");
  const [error, setError] = useState<string>();
  const ahora = useAhora(30_000);

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });

  const puedeEnviar = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "mensajeria.enviar",
  );

  const conexion = useQuery({
    queryKey: ["mensajeria", "conexion"],
    queryFn: () => api<ConexionWabaPublica>("/mensajeria/conexion"),
    enabled: Boolean(me.data),
  });

  const lista = useQuery({
    queryKey: ["conversaciones"],
    queryFn: () => api<ConversacionBandeja[]>("/conversaciones"),
    enabled: Boolean(me.data),
  });

  const plantillas = useQuery({
    queryKey: ["mensajeria", "plantillas"],
    queryFn: () => api<PlantillaWaPublica[]>("/mensajeria/plantillas"),
    enabled: Boolean(me.data),
  });

  const sel = idUrl;
  const segmento = segmentoUrl;

  const detalle = useQuery({
    queryKey: ["conversaciones", sel],
    queryFn: () => api<ConversacionDetalle>(`/conversaciones/${sel}`),
    enabled: Boolean(sel),
  });

  function syncUrl(patch: { id?: string | null; segmento?: ConversacionSegmento }) {
    const href = buildConversacionesHref({
      id: patch.id === null ? undefined : (patch.id ?? sel ?? undefined),
      segmento: patch.segmento ?? segmento,
    });
    startTransition(() => {
      router.replace(href, { scroll: false });
    });
  }

  const leer = useMutation({
    mutationFn: (id: string) =>
      api<ConversacionDetalle>(`/conversaciones/${id}/leer`, { method: "POST" }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["conversaciones"] });
    },
  });

  const enviar = useMutation({
    mutationFn: (input: { id: string; body: unknown }) =>
      api(`/conversaciones/${input.id}/enviar`, {
        method: "POST",
        body: JSON.stringify(input.body),
      }),
    onSuccess: () => {
      setError(undefined);
      void qc.invalidateQueries({ queryKey: ["conversaciones"] });
    },
    onError: (err) => {
      if (err instanceof ApiError && err.code === "VENTANA_WA_CERRADA") {
        setError(MENSAJE_VENTANA_WA_CERRADA);
        return;
      }
      setError(err instanceof ApiError ? err.message : "No se pudo enviar");
    },
  });

  const recordar = useMutation({
    mutationFn: (clienteId: string) =>
      api<{ encolado: boolean }>(`/cartera/clientes/${clienteId}/recordatorio`, {
        method: "POST",
      }),
    onSuccess: (data) => {
      setError(undefined);
      if (data.encolado) toastSuccess("Recordatorio encolado");
      else toastInfo("Ya se envió un recordatorio hoy");
      void qc.invalidateQueries({ queryKey: ["conversaciones"] });
    },
    onError: (err) => toastFromError(err, "No se pudo encolar el recordatorio"),
  });

  const inbound = useMutation({
    mutationFn: (input: { id: string; body: string }) =>
      api(`/conversaciones/${input.id}/simular-inbound`, {
        method: "POST",
        body: JSON.stringify({
          from: detalle.data?.telefonoWa ?? "50200000000",
          body: input.body,
        }),
      }),
    onSuccess: () => {
      setError(undefined);
      void qc.invalidateQueries({ queryKey: ["conversaciones"] });
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "No se pudo simular");
    },
  });

  function elegir(id: string) {
    setError(undefined);
    syncUrl({ id });
    leer.mutate(id);
  }

  const items = useMemo(() => lista.data ?? [], [lista.data]);
  const conteos = useMemo(() => conteosSegmento(items), [items]);

  const filtrados = useMemo(() => {
    const porSegmento = aplicarSegmentoLista(items, segmento);
    return filtrarBandeja(porSegmento, q);
  }, [items, segmento, q]);

  const hilo = detalle.data;
  const modoDesarrollo = conexion.data?.modoDesarrollo ?? false;
  const restanteHilo =
    hilo?.ventanaAbierta && hilo.ventanaExpiraAt
      ? new Date(hilo.ventanaExpiraAt).getTime() - ahora
      : null;
  const copyVentana = hilo
    ? copyVentanaWhatsapp({
        ventanaAbierta: hilo.ventanaAbierta,
        restanteMs: restanteHilo,
      })
    : null;

  return (
    <PanelShell fill title="Conversaciones">
      <div className="flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden">
        <PageToolbar
          className="shrink-0"
          description="Conteste excepciones de restaurantes. Invitaciones, confirmaciones y consolidados salen solos."
          meta={
            modoDesarrollo ? (
              <Chip color="warning" size="sm" variant="soft">
                Modo desarrollo
              </Chip>
            ) : conexion.data?.estado === "CONECTADO" ? (
              <Chip color="success" size="sm" variant="soft">
                WhatsApp conectado
              </Chip>
            ) : undefined
          }
        />

        {error ? (
          <Alert className="shrink-0" status="danger">
            <Alert.Indicator />
            <Alert.Content>
              <Alert.Title>No se envió</Alert.Title>
              <Alert.Description>{error}</Alert.Description>
            </Alert.Content>
          </Alert>
        ) : null}

        <div className="grid min-h-0 min-w-0 flex-1 grid-rows-[minmax(0,1fr)] gap-3 overflow-hidden lg:grid-cols-[minmax(0,18rem)_minmax(0,1fr)]">
          <section
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col overflow-hidden border border-[var(--border-subtle)] bg-blanco",
              sel && "hidden lg:flex",
            )}
          >
            <div className="grid shrink-0 gap-3 border-b border-[var(--border-subtle)] p-3 sm:p-4">
              <SearchField
                aria-label="Buscar conversación"
                className="w-full"
                value={q}
                onChange={setQ}
              >
                <SearchField.Group>
                  <SearchField.SearchIcon />
                  <SearchField.Input placeholder="Restaurante o texto" />
                  <SearchField.ClearButton />
                </SearchField.Group>
              </SearchField>

              <div className="min-w-0 overflow-x-auto">
                <ToggleButtonGroup
                  aria-label="Filtrar conversaciones"
                  className="w-max max-w-none"
                  disallowEmptySelection
                  selectedKeys={new Set([segmento])}
                  selectionMode="single"
                  size="sm"
                  onSelectionChange={(keys) => {
                    const next = [...keys][0];
                    if (typeof next !== "string") return;
                    syncUrl({
                      segmento: parseConversacionSegmento(next),
                    });
                  }}
                >
                  {SEGMENTOS.map((f, i) => (
                    <ToggleButton key={f.id} id={f.id}>
                      {i > 0 && <ToggleButtonGroup.Separator />}
                      {f.label}
                      <span className="ml-1 tabular-nums text-tinta-500">
                        {conteos[f.id]}
                      </span>
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </div>

              {!lista.isLoading ? (
                <p className="mst-label tabular-nums" aria-live="polite">
                  {filtrados.length} de {conteos.todas}
                </p>
              ) : null}
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              <ListaConversaciones
                items={filtrados}
                sel={sel}
                loading={lista.isLoading}
                vacio={
                  items.length > 0 ? (
                    <EmptyState
                      icon={<MessageCircle size={22} aria-hidden />}
                      title={copyEmptySegmento(segmento, Boolean(q.trim())).titulo}
                      description={
                        copyEmptySegmento(segmento, Boolean(q.trim())).descripcion
                      }
                    />
                  ) : undefined
                }
                onSelect={elegir}
              />
            </div>
          </section>

          <section
            className={cn(
              "flex h-full min-h-0 min-w-0 flex-col overflow-hidden",
              !sel && "hidden lg:flex",
            )}
          >
            {sel && detalle.isLoading ? (
              <div className="grid min-h-0 flex-1 gap-3 overflow-hidden p-4">
                <Skeleton className="h-6 w-48 shrink-0 rounded-campo" />
                <Skeleton className="min-h-0 flex-1 rounded-campo" />
              </div>
            ) : sel && hilo ? (
              <>
                <Button
                  className="mb-2 shrink-0 self-start lg:hidden"
                  size="sm"
                  variant="tertiary"
                  onPress={() => syncUrl({ id: null })}
                >
                  <ChevronLeft size={16} aria-hidden />
                  Conversaciones
                </Button>

                <div
                  className={cn(
                    "grid min-h-0 min-w-0 flex-1 overflow-hidden border border-[var(--border-subtle)] bg-blanco",
                    "grid-cols-1 grid-rows-[auto_minmax(0,8.5rem)_minmax(0,1fr)_auto]",
                    "xl:grid-cols-[minmax(0,1fr)_minmax(0,17.5rem)] xl:grid-rows-[auto_minmax(0,1fr)_auto]",
                  )}
                >
                  <header className="col-start-1 row-start-1 grid shrink-0 gap-2 border-b border-[var(--border-subtle)] p-3 sm:p-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h2 className="truncate text-[15px] font-semibold text-tinta-900">
                          {hilo.clienteNombre}
                        </h2>
                        <p className="mt-0.5 truncate text-sm text-tinta-500">
                          {hilo.telefonoWa ?? "sin WhatsApp"}
                        </p>
                      </div>
                      <VentanaBadge
                        abierta={hilo.ventanaAbierta}
                        tipo="whatsapp"
                        expiraAt={hilo.ventanaExpiraAt}
                      />
                    </div>
                    {copyVentana && !hilo.ventanaAbierta ? (
                      <p className="text-xs text-tinta-600">
                        {copyVentana.descripcion}
                      </p>
                    ) : null}
                  </header>

                  <FichaRestaurante
                    conversacion={hilo}
                    className={cn(
                      "col-start-1 row-start-2 min-h-0 min-w-0 max-h-[min(8.5rem,26svh)] overflow-y-auto overscroll-contain border-b",
                      "xl:col-start-2 xl:row-start-1 xl:row-span-3 xl:h-full xl:max-h-none xl:border-b-0 xl:border-l",
                    )}
                  />

                  <HiloConversacion
                    conversacion={hilo}
                    className="col-start-1 row-start-3 min-h-0 overflow-y-auto overscroll-contain xl:row-start-2"
                  />

                  <div className="col-start-1 row-start-4 min-h-0 max-h-[min(40svh,24rem)] overflow-y-auto overscroll-contain border-t border-[var(--border-subtle)] bg-blanco p-3 sm:p-4 xl:row-start-3">
                    <ComposerWhatsapp
                      conversacion={hilo}
                      plantillas={plantillas.data ?? []}
                      puedeEnviar={puedeEnviar}
                      enviando={enviar.isPending}
                      recordando={recordar.isPending}
                      modoDesarrollo={modoDesarrollo}
                      onEnviarTexto={(cuerpo) =>
                        enviar.mutate({
                          id: hilo.id,
                          body: {
                            tipo: "texto",
                            cuerpo,
                            cuerpoRenderizado: cuerpo,
                          },
                        })
                      }
                      onMandarEstadoCuenta={() =>
                        recordar.mutate(hilo.clienteId)
                      }
                      onSimularInbound={(body) =>
                        inbound.mutate({ id: hilo.id, body })
                      }
                    />
                  </div>
                </div>
              </>
            ) : (
              <div className="grid min-h-0 flex-1 place-items-center overflow-hidden border border-[var(--border-subtle)] bg-blanco">
                <EmptyState
                  icon={<MessageCircle size={22} aria-hidden />}
                  title="Elija una conversación"
                  description="Por contestar muestra quién escribió y aún no ha sido leído."
                />
              </div>
            )}
          </section>
        </div>
      </div>
    </PanelShell>
  );
}

function ConversacionesSkeleton() {
  return (
    <PanelShell fill title="Conversaciones">
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-hidden">
        <Skeleton className="h-10 w-full max-w-xl shrink-0 rounded-campo" />
        <Skeleton className="min-h-0 flex-1 rounded-campo" />
      </div>
    </PanelShell>
  );
}

function useAhora(intervaloMs: number): number {
  const [ahora, setAhora] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setAhora(Date.now()), intervaloMs);
    return () => window.clearInterval(id);
  }, [intervaloMs]);
  return ahora;
}