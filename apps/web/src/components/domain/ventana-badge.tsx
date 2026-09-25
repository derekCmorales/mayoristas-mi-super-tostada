"use client";

import { useEffect, useState } from "react";
import { Clock, Lock, LockOpen } from "lucide-react";
import { cn } from "@/lib/utils";

export function formatearRestante(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function etiquetaVentanaBadge({
  tipo = "pedido",
  abierta,
  reabierta = false,
  diaCerrado = false,
  expiraAt,
  cierraAt,
  proximaAperturaAt,
  compacto = false,
  now = Date.now(),
}: {
  tipo?: "pedido" | "whatsapp";
  abierta: boolean;
  reabierta?: boolean;
  diaCerrado?: boolean;
  expiraAt?: string | null;
  cierraAt?: string | null;
  proximaAperturaAt?: string | null;
  compacto?: boolean;
  now?: number;
}): {
  etiqueta: string;
  viva: boolean;
  cierreAnticipado: boolean;
  reabiertaPedido: boolean;
  restante: number;
} {
  const cierreAnticipado =
    tipo === "pedido" && diaCerrado && abierta && !reabierta;

  const targetIso =
    tipo === "whatsapp"
      ? expiraAt
      : cierreAnticipado
        ? proximaAperturaAt
        : abierta
          ? cierraAt
          : proximaAperturaAt;

  const restante = targetIso ? Math.max(0, new Date(targetIso).getTime() - now) : 0;
  // `reabierta` manda aunque `abierta` sea true: capturaAbierta es true en un
  // día REABIERTO, y si exigimos `!abierta` el chip verde «Ventana abierta»
  // contradice al portal cuando el reloj corre sobre un día CERRADO.
  const reabiertaPedido = tipo === "pedido" && reabierta;
  const viva =
    tipo === "whatsapp" && expiraAt
      ? restante > 0
      : abierta && !cierreAnticipado;

  let etiqueta = viva ? "Ventana abierta" : "Ventana cerrada";
  if (reabiertaPedido) {
    etiqueta = "Ventana reabierta";
  } else if (cierreAnticipado) {
    etiqueta =
      !compacto && proximaAperturaAt && restante > 0
        ? `Día cerrado · Abre en ${formatearRestante(restante)}`
        : "Día cerrado";
  } else if (tipo === "whatsapp") {
    etiqueta =
      viva && !compacto
        ? `Puede responder · queda ${formatearRestante(restante)}`
        : viva
          ? "Puede responder"
          : "Solo avisos armados";
  } else if (!reabiertaPedido && viva && cierraAt && restante > 0) {
    etiqueta = compacto
      ? "Ventana abierta"
      : `Ventana abierta · Cierra en ${formatearRestante(restante)}`;
  } else if (!reabiertaPedido && !viva && proximaAperturaAt && restante > 0) {
    etiqueta = compacto
      ? "Ventana cerrada"
      : `Ventana cerrada · Abre en ${formatearRestante(restante)}`;
  }

  return {
    etiqueta,
    viva,
    cierreAnticipado,
    reabiertaPedido,
    restante,
  };
}

export function VentanaBadge({
  abierta,
  size = "md",
  compacto = false,
  tipo = "pedido",
  reabierta = false,
  diaCerrado = false,
  expiraAt,
  cierraAt,
  proximaAperturaAt,
  className,
}: {
  abierta: boolean;
  size?: "sm" | "md";
  /**
   * Oculta el contador de tiempo restante y muestra solo el estado (abierta/cerrada).
   * Por defecto false: muestra el tiempo restante igual que en la card de /hoy.
   */
  compacto?: boolean;
  tipo?: "pedido" | "whatsapp";
  /**
   * El día de captura está reabierto: el reloj dice cerrado pero el panel sí
   * acepta pedidos (`exigirDiaNoCerrado` solo bloquea CERRADO). Decir «Ventana
   * cerrada» ahí es mentir sobre lo que el sistema deja hacer.
   */
  reabierta?: boolean;
  /**
   * La operación de captura ya se cerró manualmente o por cron, pero el reloj
   * de la ventana sigue vivo y el portal aún acepta pedidos tardíos.
   */
  diaCerrado?: boolean;
  expiraAt?: string | null;
  cierraAt?: string | null;
  proximaAperturaAt?: string | null;
  className?: string;
}) {
  const [now, setNow] = useState(() => Date.now());

  const tieneTimer =
    !compacto &&
    ((tipo === "whatsapp" && Boolean(expiraAt)) ||
      (tipo === "pedido" && (Boolean(cierraAt) || Boolean(proximaAperturaAt))));

  useEffect(() => {
    if (!tieneTimer) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [tieneTimer, tipo, expiraAt, cierraAt, proximaAperturaAt, diaCerrado, abierta]);

  const { etiqueta, viva, cierreAnticipado, reabiertaPedido } =
    etiquetaVentanaBadge({
      tipo,
      abierta,
      reabierta,
      diaCerrado,
      expiraAt,
      cierraAt,
      proximaAperturaAt,
      compacto,
      now,
    });

  const Icon = reabiertaPedido
    ? LockOpen
    : cierreAnticipado
      ? Lock
      : viva
        ? Clock
        : Lock;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-pill font-semibold tabular-nums",
        size === "sm" ? "h-[22px] px-2 text-[12px]" : "h-7 px-3 text-xs",
        reabiertaPedido || cierreAnticipado
          ? "bg-[var(--amber-100)] text-[var(--amber-700)]"
          : viva
            ? "bg-[var(--green-100)] text-[var(--green-700)]"
            : "bg-[var(--ink-100)] text-[var(--ink-600)]",
        className,
      )}
    >
      <Icon size={size === "sm" ? 12 : 14} aria-hidden />
      {etiqueta}
    </span>
  );
}
