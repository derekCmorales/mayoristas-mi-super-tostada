"use client";

import { Card } from "@heroui/react";
import { useQuery } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect } from "react";
import { ChevronLeft, ChevronRight, Clock, History, MessageSquareText, Users } from "lucide-react";
import {
  tienePermiso,
  type ActorPublico,
  type PermisoCodigo,
} from "@misupertostada/shared";
import { api, ApiError } from "@/lib/api";
import { PanelShell } from "@/components/layout/panel-shell";
import { UsuariosCard } from "@/components/configuracion/usuarios-card";
import { HistorialCard } from "@/components/configuracion/historial-card";
import { VentanaCard } from "@/components/configuracion/ventana-card";
import { MetaPlantillasCard } from "@/components/configuracion/meta-plantillas-card";
import { Skeleton } from "@/components/ui/skeleton";
import Link from "next/link";

const SECCIONES = [
  {
    id: "usuarios" as const,
    title: "Usuarios",
    subtitle: "Cuentas internas, roles y claves. Nada se borra: se desactiva.",
    icon: Users,
  },
  {
    id: "historial" as const,
    title: "Historial de acciones",
    subtitle: "Quién hizo qué. Solo lectura, sin editar ni borrar.",
    icon: History,
  },
  {
    id: "ventana" as const,
    title: "Ventana de pedidos",
    subtitle: "Horario semanal del portal. Los de madrugada son del día que abrió.",
    icon: Clock,
  },
  {
    id: "meta" as const,
    title: "Plantillas de Meta",
    subtitle: "Crear, revisar y retirar plantillas de WhatsApp, y ver cuáles usan los avisos.",
    icon: MessageSquareText,
    permiso: "mensajeria.conectar" as PermisoCodigo,
  },
] satisfies ReadonlyArray<{
  id: string;
  title: string;
  subtitle: string;
  icon: typeof Users;
  permiso?: PermisoCodigo;
}>;

type SeccionId = (typeof SECCIONES)[number]["id"];

function esSeccion(value: string | null): value is SeccionId {
  return SECCIONES.some((s) => s.id === value);
}

export default function ConfiguracionPage() {
  return (
    <Suspense fallback={<HubSkeleton />}>
      <ConfiguracionVista />
    </Suspense>
  );
}

function ConfiguracionVista() {
  const router = useRouter();
  const search = useSearchParams();
  const raw = search.get("seccion");

  const me = useQuery({
    queryKey: ["auth", "me"],
    queryFn: () => api<{ usuario: ActorPublico }>("/auth/me"),
  });
  const ok = tienePermiso(
    me.data?.usuario.permisos ?? [],
    "usuarios.gestionar",
  );

  useEffect(() => {
    if (me.error instanceof ApiError && me.error.status === 403) {
      router.replace("/hoy");
    }
    if (me.data && !ok) router.replace("/hoy");
  }, [me.data, me.error, ok, router]);

  if (!ok) return null;

  const permisos = me.data?.usuario.permisos ?? [];
  const visibles = SECCIONES.filter((s) => {
    const permiso = "permiso" in s ? s.permiso : undefined;
    return !permiso || tienePermiso(permisos, permiso);
  });
  const seccion = esSeccion(raw) ? raw : null;
  const actual = visibles.find((s) => s.id === seccion);

  if (actual) {
    return (
      <PanelShell title={actual.title}>
        <div className="grid gap-5">
          <Link
            href="/configuracion"
            className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold text-marca no-underline hover:text-marca-hover hover:no-underline"
          >
            <ChevronLeft size={16} aria-hidden />
            Configuración
          </Link>

          {seccion === "usuarios" ? <UsuariosCard /> : null}
          {seccion === "historial" ? <HistorialCard /> : null}
          {seccion === "ventana" ? <VentanaCard /> : null}
          {seccion === "meta" ? <MetaPlantillasCard /> : null}
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Configuración">
      <div className="grid gap-5">
        <p className="max-w-[62ch] text-sm leading-relaxed text-tinta-500">
          Ajustes que tocan a todo el negocio. Cada cambio queda firmado en el
          historial.
        </p>

        <ul className="grid gap-3">
          {visibles.map((item) => {
            const Icon = item.icon;
            return (
              <li key={item.id}>
                <Link
                  href={`/configuracion?seccion=${item.id}`}
                  className="group block no-underline hover:no-underline"
                >
                  <Card className="p-4 transition-shadow duration-control ease-out group-hover:shadow-[var(--shadow-md)]">
                    <Card.Header className="flex flex-row items-center gap-3">
                      <span className="grid size-11 shrink-0 place-items-center rounded-campo bg-marca-soft text-marca">
                        <Icon size={20} aria-hidden />
                      </span>
                      <div className="min-w-0 flex-1">
                        <Card.Title className="text-base leading-snug text-tinta-900">
                          {item.title}
                        </Card.Title>
                        <Card.Description className="mt-0.5 text-xs leading-snug text-pretty">
                          {item.subtitle}
                        </Card.Description>
                      </div>
                      <ChevronRight
                        size={18}
                        className="shrink-0 text-tinta-500"
                        aria-hidden
                      />
                    </Card.Header>
                  </Card>
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </PanelShell>
  );
}

function HubSkeleton() {
  return (
    <PanelShell title="Configuración">
      <div className="grid gap-5">
        <Skeleton className="h-5 w-72" />
        <div className="grid gap-3">
          <Skeleton className="h-20 w-full rounded-tarjeta" />
          <Skeleton className="h-20 w-full rounded-tarjeta" />
          <Skeleton className="h-20 w-full rounded-tarjeta" />
        </div>
      </div>
    </PanelShell>
  );
}
