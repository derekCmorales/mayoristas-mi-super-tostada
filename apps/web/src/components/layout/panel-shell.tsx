"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Banknote,
  ClipboardList,
  Factory,
  LayoutDashboard,
  ChevronDown,
  MessageCircle,
  Package,
  Sun,
  Truck,
  Users,
  Settings,
  LogOut,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  formatearFechaLarga,
  MENSAJE_COLA_SESION,
  ROL_ETIQUETA,
  tienePermiso,
  type ActorPublico,
  type CalendarioAhora,
} from "@misupertostada/shared";
import { etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import {
  esSoloLectura,
  repartirNavMovil,
  seccionVisible,
  type SeccionPanel,
} from "@/lib/nav-vista";
import { api } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Avatar, Button, ScrollShadow } from "@heroui/react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { MovilNav, type MovilNavItem } from "@/components/layout/movil-nav";
import { Wordmark } from "@/components/brand/wordmark";
import { VentanaBadge } from "@/components/domain/ventana-badge";
import { avisoReabierto } from "@/lib/reabierto-vista";
import { intervaloRefetchVentana } from "@/lib/ventana-refetch";
import { Skeleton } from "@/components/ui/skeleton";
import type { ReactNode } from "react";
import { useEffect, useId, useState } from "react";
import { OfflineBanner } from "@/components/feedback/offline-banner";
import { useColaOffline } from "@/hooks/use-cola-offline";

type NavItem = {
  href?: string;
  id: SeccionPanel;
  label: string;
  icon: typeof Package;
  soon?: boolean;
  /**
   * Si es false, el ítem pasa al final del orden móvil: se muestra en la barra
   * inferior solo si sobran ranuras, si no cae en la hoja "Más".
   */
  mobile?: boolean;
};

/**
 * Qué permiso hace visible cada sección vive en `PERMISOS_SECCION`
 * (`@/lib/nav-vista`), no aquí: es lógica testeable sin montar el shell.
 */
const NAV: readonly NavItem[] = [
  { href: "/hoy", id: "hoy", label: "Hoy", icon: Sun },
  {
    href: "/tablero",
    id: "tablero",
    label: "Tablero",
    icon: LayoutDashboard,
    mobile: false,
  },
  { href: "/pedidos", id: "pedidos", label: "Pedidos", icon: ClipboardList },
  { href: "/produccion", id: "produccion", label: "Producción", icon: Factory },
  { href: "/reparto", id: "reparto", label: "Reparto", icon: Truck },
  { href: "/cartera", id: "cartera", label: "Cartera", icon: Banknote },
  {
    href: "/conversaciones",
    id: "conversaciones",
    label: "Conversaciones",
    icon: MessageCircle,
    mobile: false,
  },
  {
    href: "/catalogo",
    id: "catalogo",
    label: "Catálogo",
    icon: Package,
    mobile: false,
  },
  {
    href: "/clientes",
    id: "clientes",
    label: "Clientes",
    icon: Users,
    mobile: false,
  },
];

function itemActivo(pathname: string, item: NavItem): boolean {
  if (!item.href) return false;
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

export function PanelShell({
  title,
  barraFija,
  fill,
  children,
}: {
  title: string;
  /** Barra sticky pegada al header del panel (sin hueco del padding de main). */
  barraFija?: ReactNode;
  /**
   * El main no scrollea: el hijo llena el viewport y cada sección interna
   * scrollea por su cuenta. Para bandejas (conversaciones), no para páginas
   * de documento.
   */
  fill?: boolean;
  children: ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const qc = useQueryClient();
  const mainId = useId();
  const [masAbierto, setMasAbierto] = useState(false);
  const [cuentaAbierta, setCuentaAbierta] = useState(false);
  const [estadoAbierto, setEstadoAbierto] = useState(false);
  const cola = useColaOffline();
  const mostrarBanner =
    pathname.startsWith("/reparto") || cola.cola.length > 0;
  const sesionCola = cola.cola.some((f) => f.estado === "sesion");

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  const calendario = useQuery({
    queryKey: ["calendario", "ahora"],
    queryFn: () => api<CalendarioAhora>("/calendario/ahora"),
    enabled: Boolean(me.data),
    refetchInterval: (query) =>
      intervaloRefetchVentana({
        cierraAt: query.state.data?.cierraAt,
        proximaAperturaAt: query.state.data?.proximaAperturaAt,
      }),
    refetchOnWindowFocus: true,
  });
  const carteraResumen = useQuery({
    queryKey: ["cartera", "resumen"],
    queryFn: () => api<{ transferenciasPendientesCount: number }>("/cartera/resumen"),
    enabled: Boolean(me.data),
    refetchInterval: 60_000,
  });
  const aviso = avisoReabierto(calendario.data);
  const transferenciasPendientes =
    carteraResumen.data?.transferenciasPendientesCount ?? 0;

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 401) {
      router.replace("/login");
    }
  }, [me.error, router]);

  useEffect(() => {
    setMasAbierto(false);
    setCuentaAbierta(false);
    setEstadoAbierto(false);
  }, [pathname]);

  const abrirMas = (open: boolean) => {
    setMasAbierto(open);
    if (open) {
      setCuentaAbierta(false);
      setEstadoAbierto(false);
    }
  };

  const abrirCuenta = (open: boolean) => {
    setCuentaAbierta(open);
    if (open) {
      setMasAbierto(false);
      setEstadoAbierto(false);
    }
  };

  const abrirEstado = (open: boolean) => {
    setEstadoAbierto(open);
    if (open) {
      setMasAbierto(false);
      setCuentaAbierta(false);
    }
  };

  const logout = useMutation({
    mutationFn: () => api("/auth/logout", { method: "POST" }),
    onSuccess: () => {
      qc.clear();
      router.replace("/login");
    },
  });

  if (me.isLoading || !me.data) {
    return <ShellSkeleton />;
  }

  const usuario = me.data.usuario;
  const visibles = NAV.filter((item) =>
    seccionVisible(item.id, usuario.permisos),
  );
  const seccionActivaItem = NAV.find((item) => itemActivo(pathname, item));
  const seccionActiva = seccionActivaItem?.id;
  const etiquetaSeccion = seccionActivaItem?.label;
  const soloLectura = seccionActiva
    ? esSoloLectura(seccionActiva, usuario.permisos)
    : false;
  const { barra: movilBarra, extra: movilExtra } = repartirNavMovil(
    visibles.filter((item) => item.href && !item.soon),
    usuario.rol,
  );
  const aMovilNav = (items: readonly NavItem[]) =>
    items.flatMap((item): MovilNavItem[] =>
      item.href ? [{ href: item.href, id: item.id, label: item.label, icon: item.icon }] : [],
    );
  const iniciales = usuario.username.slice(0, 2).toUpperCase();
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--surface-page)]">
      {estadoAbierto ? (
        <button
          type="button"
          aria-label="Cerrar estado operativo"
          className="fixed inset-0 z-[calc(var(--z-popover)-1)] bg-tinta-900/30 backdrop-blur-[2px] transition-opacity duration-control lg:hidden"
          onClick={() => setEstadoAbierto(false)}
        />
      ) : null}
      <a
        href={`#${mainId}`}
        className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[var(--z-toast)] focus:rounded-campo focus:bg-blanco focus:px-3 focus:py-2 focus:shadow-modal"
      >
        Saltar al contenido
      </a>

      <aside
        id="nav-panel"
        className="hidden w-sidebar shrink-0 flex-col border-r border-[var(--border-subtle)] bg-blanco lg:flex shadow-sm z-10"
      >
        <div className="flex shrink-0 items-center justify-center border-b border-[var(--border-subtle)] px-1 py-5">
          <Link
            href="/hoy"
            className="flex w-full items-center justify-center rounded-campo no-underline hover:no-underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-marca/50"
            aria-label="Mi Súper Tostada · Hoy"
          >
            <Wordmark className="h-36 w-auto max-w-full" />
          </Link>
        </div>
        <ScrollShadow
          aria-label="Principal"
          className="grid flex-1 content-start gap-1 overflow-y-auto px-3 py-4"
        >
          {visibles.map((item) => (
            <NavLink key={item.id} item={item} pathname={pathname} />
          ))}
        </ScrollShadow>
        <div className="flex items-center gap-3 border-t border-[var(--border-subtle)] p-4 bg-tinta-50/30">
          <Avatar className="size-9 bg-marca-soft text-marca shadow-sm">
            <Avatar.Fallback className="text-xs font-semibold text-marca">
              {iniciales}
            </Avatar.Fallback>
          </Avatar>
          <span className="min-w-0 flex-1 leading-tight">
            <span className="block truncate text-sm font-semibold text-tinta-900">
              {usuario.username}
            </span>
            <span className="block mst-label text-tinta-500 text-[10px]">
              {ROL_ETIQUETA[usuario.rol]}
            </span>
          </span>
          <div className="flex items-center gap-1 shrink-0">
            {tienePermiso(usuario.permisos, "usuarios.gestionar") ? (
              <Link
                href="/configuracion"
                aria-label="Configuración"
                className={cn(
                  "flex size-8 items-center justify-center rounded-lg text-tinta-500 hover:bg-tinta-100 hover:text-tinta-900 transition-colors",
                  pathname.startsWith("/configuracion") && "bg-acento/15 text-marca hover:bg-acento/25 hover:text-marca"
                )}
              >
                <Settings size={18} aria-hidden />
              </Link>
            ) : null}
            <Button
              isIconOnly
              variant="ghost"
              size="sm"
              onPress={() => logout.mutate()}
              isPending={logout.isPending}
              aria-label="Salir"
              className="size-8 text-tinta-500 hover:text-peligro hover:bg-peligro/10"
            >
              <LogOut size={18} aria-hidden />
            </Button>
          </div>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-[var(--z-sticky)] flex min-h-topbar min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-tinta-200/50 bg-blanco/80 backdrop-blur-md px-3 py-2 sm:px-4 lg:px-5 shadow-sm">
          <div className="min-w-0 max-w-full shrink">
            <h1 className="truncate text-sm font-semibold text-tinta-900 lg:text-lg">
              {title}
            </h1>
            {etiquetaSeccion && etiquetaSeccion !== title ? (
              <p className="mst-label truncate text-tinta-500 lg:hidden">
                {etiquetaSeccion}
              </p>
            ) : null}
          </div>
          {/*
            Sin este aviso, quien no puede escribir ve una pantalla sin botones
            y no sabe si es su permiso o un fallo de carga.
          */}
          {soloLectura && (
            <span
              className="mst-label hidden shrink-0 rounded-full bg-tinta-100 px-2 py-0.5 text-tinta-600 lg:inline"
              title="Puede consultar esta sección, pero no registrar acciones en ella."
            >
              Solo lectura
            </span>
          )}
          <div className="ml-auto flex min-w-0 max-w-full flex-1 flex-wrap items-center justify-end gap-2">
            {calendario.data ? <EjesFecha cal={calendario.data} layout="horizontal" /> : null}
            {aviso ? (
              <span
                className="mst-label hidden shrink-0 rounded-full bg-[var(--amber-100)] px-2 py-0.5 text-[var(--amber-700)] sm:inline"
                title={aviso.detalle}
              >
                {aviso.chip}
              </span>
            ) : null}
            {transferenciasPendientes > 0 ? (
              <Link
                className="mst-label hidden shrink-0 rounded-full bg-[var(--amber-100)] px-2 py-0.5 text-[var(--amber-700)] no-underline hover:text-[var(--amber-800)] sm:inline"
                href="/cartera?panel=transferencias"
                title={`${transferenciasPendientes} transferencia${transferenciasPendientes === 1 ? "" : "s"} pendientes de confirmar`}
              >
                {transferenciasPendientes} transferencia
                {transferenciasPendientes === 1 ? "" : "s"}
              </Link>
            ) : null}
            {calendario.data ? (
              <>
                <VentanaBadge
                  size="sm"
                  abierta={calendario.data.capturaAbierta}
                  reabierta={calendario.data.diaEstado === "REABIERTO"}
                  diaCerrado={calendario.data.diaEstado === "CERRADO"}
                  cierraAt={calendario.data.cierraAt}
                  proximaAperturaAt={calendario.data.proximaAperturaAt}
                  className="hidden max-w-full lg:inline-flex"
                />
                <Popover open={estadoAbierto} onOpenChange={abrirEstado} modal>
                  <PopoverTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex shrink-0 items-center gap-0.5 rounded-pill pr-1.5 focus-visible:outline-none focus-visible:shadow-foco lg:hidden"
                      aria-haspopup="dialog"
                      aria-expanded={estadoAbierto}
                      aria-label="Ver estado del día y fechas de operación"
                    >
                      <VentanaBadge
                        size="sm"
                        abierta={calendario.data.capturaAbierta}
                        reabierta={calendario.data.diaEstado === "REABIERTO"}
                        diaCerrado={calendario.data.diaEstado === "CERRADO"}
                        cierraAt={calendario.data.cierraAt}
                        proximaAperturaAt={calendario.data.proximaAperturaAt}
                      />
                      <ChevronDown
                        size={14}
                        className={cn(
                          "shrink-0 text-tinta-500 transition-transform duration-control",
                          estadoAbierto && "rotate-180",
                        )}
                        aria-hidden
                      />
                    </button>
                  </PopoverTrigger>
                  <PopoverContent
                    align="end"
                    side="bottom"
                    sideOffset={8}
                    collisionPadding={16}
                    className={cn(
                      "border-0 bg-transparent p-0 shadow-none outline-none",
                      "w-[min(calc(100vw-1.25rem),360px)]",
                      "origin-top-right",
                      "transition-[opacity,transform] duration-control ease-out",
                      "data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
                      "data-[state=open]:scale-100 data-[state=open]:opacity-100",
                    )}
                  >
                    <div className="relative rounded-2xl border border-[var(--border-subtle)] bg-blanco p-3 shadow-[0_12px_40px_rgba(23,25,15,0.16)]">
                      <span
                        aria-hidden
                        className="absolute -top-[5px] right-5 size-2.5 rotate-45 border-l border-t border-[var(--border-subtle)] bg-blanco"
                      />
                      <p className="mb-2.5 px-1 text-[10px] font-bold uppercase tracking-wider text-tinta-500">
                        Estado operativo
                      </p>
                      <div className="grid gap-3">
                        <div className="flex flex-wrap items-center gap-2">
                          <VentanaBadge
                            size="md"
                            abierta={calendario.data.capturaAbierta}
                            reabierta={calendario.data.diaEstado === "REABIERTO"}
                            diaCerrado={calendario.data.diaEstado === "CERRADO"}
                            cierraAt={calendario.data.cierraAt}
                            proximaAperturaAt={calendario.data.proximaAperturaAt}
                          />
                          {soloLectura ? (
                            <span
                              className="mst-label rounded-full bg-tinta-100 px-2 py-0.5 text-tinta-600"
                              title="Puede consultar esta sección, pero no registrar acciones en ella."
                            >
                              Solo lectura
                            </span>
                          ) : null}
                        </div>
                        <EjesFecha cal={calendario.data} layout="stacked" />
                        {aviso ? (
                          <div className="rounded-xl border border-[var(--amber-200)] bg-[var(--amber-100)] px-3 py-2">
                            <p className="text-sm font-semibold text-[var(--amber-800)]">
                              {aviso.chip}
                            </p>
                            <p className="mt-1 text-xs text-[var(--amber-700)]">{aviso.detalle}</p>
                          </div>
                        ) : null}
                        {transferenciasPendientes > 0 ? (
                          <Link
                            href="/cartera?panel=transferencias"
                            onClick={() => setEstadoAbierto(false)}
                            className="flex min-h-tap items-center justify-between rounded-xl border border-[var(--amber-200)] bg-[var(--amber-100)] px-3 py-2 text-sm font-semibold text-[var(--amber-800)] no-underline hover:text-[var(--amber-900)]"
                          >
                            <span>
                              {transferenciasPendientes} transferencia
                              {transferenciasPendientes === 1 ? "" : "s"} pendientes
                            </span>
                            <span className="text-xs font-medium">Ver →</span>
                          </Link>
                        ) : null}
                      </div>
                    </div>
                  </PopoverContent>
                </Popover>
              </>
            ) : null}
            <Popover open={cuentaAbierta} onOpenChange={abrirCuenta}>
              <PopoverTrigger asChild>
                <button
                  type="button"
                  className="grid size-11 shrink-0 place-items-center rounded-campo text-tinta-800 transition-transform active:scale-95 lg:hidden focus-visible:outline-none focus-visible:shadow-foco"
                  aria-haspopup="dialog"
                  aria-expanded={cuentaAbierta}
                >
                  <Avatar className="size-8 bg-marca-soft text-marca">
                    <Avatar.Fallback className="text-xs font-semibold text-marca">
                      {iniciales}
                    </Avatar.Fallback>
                  </Avatar>
                  <span className="sr-only">Cuenta</span>
                </button>
              </PopoverTrigger>
              <PopoverContent
                align="end"
                side="bottom"
                sideOffset={8}
                collisionPadding={16}
                className={cn(
                  "w-[min(280px,calc(100vw-2rem))] p-0",
                  "transition-[opacity,transform] duration-control ease-out",
                  "data-[state=closed]:scale-95 data-[state=closed]:opacity-0",
                  "data-[state=open]:scale-100 data-[state=open]:opacity-100",
                )}
              >
                <div className="p-3">
                  <div className="flex items-center gap-3">
                    <Avatar className="size-10 bg-marca-soft text-marca">
                      <Avatar.Fallback className="text-xs font-semibold text-marca">
                        {iniciales}
                      </Avatar.Fallback>
                    </Avatar>
                    <span className="min-w-0 flex-1 leading-tight">
                      <span className="block truncate text-sm font-semibold text-tinta-900">
                        {usuario.username}
                      </span>
                      <span className="block mst-label text-tinta-500">
                        {ROL_ETIQUETA[usuario.rol]}
                      </span>
                    </span>
                  </div>
                  {soloLectura ? (
                    <p className="mt-2 rounded-campo bg-tinta-50 px-2.5 py-1.5 text-[11px] font-medium text-tinta-600">
                      Solo lectura en esta sección
                    </p>
                  ) : null}
                </div>
                <div className="grid gap-0.5 border-t border-[var(--border-subtle)] p-2">
                  {tienePermiso(usuario.permisos, "usuarios.gestionar") ? (
                    <Link
                      href="/configuracion"
                      onClick={() => setCuentaAbierta(false)}
                      className={cn(
                        "flex min-h-tap items-center gap-3 rounded-lg px-3 text-sm font-medium no-underline hover:no-underline transition-colors",
                        pathname.startsWith("/configuracion")
                          ? "bg-acento/15 font-semibold text-tinta-900"
                          : "text-tinta-700 hover:bg-tinta-100 hover:text-tinta-900",
                      )}
                    >
                      <Settings size={18} aria-hidden />
                      Configuración
                    </Link>
                  ) : null}
                  <Button
                    variant="ghost"
                    size="sm"
                    onPress={() => {
                      setCuentaAbierta(false);
                      logout.mutate();
                    }}
                    isPending={logout.isPending}
                    className="min-h-tap w-full justify-start gap-3 rounded-lg px-3 text-tinta-700 hover:text-peligro hover:bg-[var(--red-100)]"
                  >
                    <LogOut size={18} aria-hidden />
                    Salir
                  </Button>
                </div>
              </PopoverContent>
            </Popover>
          </div>
        </header>
        {mostrarBanner && (
          <OfflineBanner
            online={cola.online}
            pendientes={cola.cola.length}
            sincronizando={cola.sincronizando}
            onReintentar={cola.enviarAhora}
          />
        )}
        {sesionCola && (
          <div
            role="status"
            className="bg-[var(--amber-100)] px-4 py-2 text-xs font-semibold text-[var(--amber-700)]"
          >
            {MENSAJE_COLA_SESION}
          </div>
        )}
        {cola.errorApertura && (
          <div role="alert" className="bg-[var(--red-100)] px-4 py-2 text-xs font-semibold text-peligro">
            {cola.errorApertura}
          </div>
        )}
        <main
          id={mainId}
          className={cn(
            "relative min-h-0 flex-1",
            fill
              ? "flex flex-col overflow-hidden"
              : "overflow-y-auto overscroll-y-contain",
            barraFija
              ? "pb-[calc(var(--bottombar-height)+2rem+env(safe-area-inset-bottom,0px))] lg:pb-6"
              : fill
                ? "px-4 pt-3 pb-[calc(var(--bottombar-height)+0.5rem+env(safe-area-inset-bottom,0px))] lg:px-6 lg:py-4 lg:pb-4"
                : "px-4 py-4 pb-[calc(var(--bottombar-height)+2rem+env(safe-area-inset-bottom,0px))] lg:px-6 lg:py-6 lg:pb-6",
          )}
        >
          {barraFija ? (
            <div className="sticky top-0 isolate z-[calc(var(--z-sticky)+1)] border-b border-[var(--border-subtle)] bg-[var(--surface-page)] px-4 py-3 lg:px-6">
              <div className="mx-auto w-full max-w-[var(--page-max)]">
                {barraFija}
              </div>
            </div>
          ) : null}
          <div
            className={cn(
              "mx-auto w-full max-w-[var(--page-max)]",
              fill && "flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden",
              barraFija && "px-4 py-4 lg:px-6 lg:py-6",
            )}
          >
            {children}
          </div>
        </main>
      </div>

      <MovilNav
        pathname={pathname}
        barra={aMovilNav(movilBarra)}
        extra={aMovilNav(movilExtra)}
        abierto={masAbierto}
        onAbiertoChange={abrirMas}
      />
    </div>
  );
}

/**
 * Los tres ejes de fecha del negocio, uno al lado del otro.
 *
 * El chrome mostraba solo el de captura, así que entre las 15:00 y las 03:00
 * anunciaba la operación de mañana mientras /reparto, /produccion y cartera
 * trabajaban la de hoy, sin ningún sitio donde leer esa otra fecha. Ahora cada
 * eje tiene su celda y ninguna pantalla tiene que adivinar cuál es «hoy».
 * Ver `calendarioAhoraSchema` y `BusinessCalendarService.ejes`.
 */
function EjesFecha({
  cal,
  layout = "horizontal",
}: {
  cal: CalendarioAhora;
  layout?: "horizontal" | "stacked";
}) {
  // La entrega solo se anota cuando no cae el mismo día que la operación
  // (sábado con carga en planta, feriados): el resto del tiempo es ruido.
  const entregaDistinta = cal.fechaEntregaCaptura !== cal.fechaOperacionCaptura;
  const nota = entregaDistinta
    ? `Entrega: ${formatearFechaLarga(cal.fechaEntregaCaptura)}`
    : cal.esSabado
      ? "Carga en planta"
      : undefined;
  const notaCorta = entregaDistinta
    ? `Entrega ${etiquetaDiaSemanaCorto(cal.fechaEntregaCaptura)}`
    : nota;

  if (layout === "stacked") {
    return (
      <dl className="grid gap-2">
        <Eje
          label="Captura de pedidos"
          iso={cal.fechaOperacionCaptura}
          nota={nota}
          className="rounded-campo border border-[var(--border-subtle)] bg-[var(--surface-page)] px-3 py-2"
        />
        <Eje
          label="En reparto hoy"
          iso={cal.fechaOperacionEnCurso}
          className="rounded-campo border border-[var(--border-subtle)] bg-[var(--surface-page)] px-3 py-2"
        />
        <Eje
          label="Día de calendario"
          iso={cal.hoyCivil}
          className="rounded-campo border border-[var(--border-subtle)] bg-[var(--surface-page)] px-3 py-2"
        />
      </dl>
    );
  }

  return (
    <dl className="hidden max-w-full min-w-0 flex-wrap items-stretch divide-[var(--border-subtle)] overflow-hidden rounded-campo border border-[var(--border-subtle)] bg-[var(--surface-page)] shadow-[0_1px_2px_rgba(0,0,0,0.03)] sm:flex">
      <Eje
        compact
        label="Captura"
        iso={cal.fechaOperacionCaptura}
        nota={notaCorta}
        titleNota={nota}
      />
      <Eje
        compact
        label="Reparto hoy"
        iso={cal.fechaOperacionEnCurso}
        className="border-l border-[var(--border-subtle)]"
      />
      <Eje
        compact
        label="Calendario"
        iso={cal.hoyCivil}
        className="hidden border-l border-[var(--border-subtle)] xl:flex"
      />
    </dl>
  );
}

function Eje({
  label,
  iso,
  nota,
  titleNota,
  compact = false,
  className,
}: {
  label: string;
  iso: string;
  nota?: string;
  titleNota?: string;
  /** Barra del panel: fecha corta para que los tres ejes quepan junto al sidebar. */
  compact?: boolean;
  className?: string;
}) {
  const fechaLarga = formatearFechaLarga(iso);
  const fechaVisible = compact ? etiquetaDiaSemanaCorto(iso) : fechaLarga;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col justify-center text-left",
        compact ? "max-w-[11.5rem] px-2.5 py-1" : "px-3.5 py-0.5",
        className,
      )}
    >
      <dt className="truncate text-[10px] font-bold uppercase tracking-wide text-tinta-500 leading-none">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 font-semibold leading-none text-tinta-900",
          compact
            ? "truncate text-xs tabular-nums"
            : "flex items-center gap-2 text-xs tabular-nums",
        )}
        title={fechaLarga}
      >
        {compact ? (
          fechaVisible
        ) : (
          <>
            <span>{fechaVisible}</span>
            {nota ? (
              <span className="rounded-pill border border-[var(--green-200)] bg-marca-soft px-2 py-0.5 text-[11px] font-semibold text-marca">
                {nota}
              </span>
            ) : null}
          </>
        )}
      </dd>
      {compact && nota ? (
        <dd
          className="mt-1 truncate text-[11px] font-semibold leading-none text-marca"
          title={titleNota ?? nota}
        >
          {nota}
        </dd>
      ) : null}
    </div>
  );
}

function NavLink({ item, pathname }: { item: NavItem; pathname: string }) {
  const Icon = item.icon;
  const active = itemActivo(pathname, item);
  const clase = cn(
    "group flex min-h-[42px] items-center gap-3 rounded-lg px-3 text-sm font-medium transition-all duration-200 ease-out no-underline hover:no-underline",
    item.soon && "cursor-not-allowed opacity-45",
    active
      ? "bg-acento/15 font-semibold text-tinta-900"
      : "text-tinta-700 hover:bg-tinta-100 hover:text-tinta-900",
  );

  if (item.soon || !item.href) {
    return (
      <span className={clase} title="Disponible en la siguiente etapa">
        <Icon size={18} className={cn("shrink-0 transition-transform duration-200", active ? "scale-110 text-marca drop-shadow-sm" : "group-hover:scale-110")} aria-hidden />
        <span className="flex-1">{item.label}</span>
        <span className="mst-label text-[10px] uppercase tracking-wider text-tinta-500 bg-tinta-100 px-2 py-0.5 rounded-full">
          Pronto
        </span>
      </span>
    );
  }

  return (
    <Link href={item.href} aria-current={active ? "page" : undefined} className={clase}>
      <Icon size={18} className={cn("shrink-0 transition-transform duration-200", active ? "scale-110 text-marca drop-shadow-sm" : "group-hover:scale-110")} aria-hidden />
      <span className="min-w-0 flex-1 truncate">{item.label}</span>
    </Link>
  );
}

function ShellSkeleton() {
  return (
    <div className="flex h-[100dvh] overflow-hidden bg-[var(--surface-page)]">
      <div className="hidden w-sidebar border-r border-[var(--border-subtle)] bg-blanco lg:block">
        <div className="border-b border-[var(--border-subtle)] px-1 py-5">
          <Skeleton className="mx-auto size-36 rounded-full" />
        </div>
        <div className="grid gap-2 p-4">
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
        </div>
      </div>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <div className="flex h-topbar items-center border-b border-[var(--border-subtle)] bg-blanco px-6">
          <Skeleton className="h-5 w-32" />
        </div>
        <div className="p-6">
          <Skeleton className="h-36 w-full rounded-tarjeta" />
        </div>
      </div>
    </div>
  );
}
