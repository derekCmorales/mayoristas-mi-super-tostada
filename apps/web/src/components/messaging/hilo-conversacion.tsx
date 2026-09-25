"use client";

import {
  fechaDeInstante,
  formatearFechaLarga,
  horaEnZona,
  type ConversacionDetalle,
} from "@misupertostada/shared";
import { useEffect, useRef } from "react";
import { etiquetaMensajeSaliente } from "@/lib/conversacion-vista";
import { MensajePreview } from "@/components/domain/mensaje-preview";
import { cn } from "@/lib/utils";

export function HiloConversacion({
  conversacion,
  className,
}: {
  conversacion: ConversacionDetalle;
  className?: string;
}) {
  const cajaRef = useRef<HTMLDivElement>(null);
  const total = conversacion.mensajes.length;

  useEffect(() => {
    const caja = cajaRef.current;
    if (caja) caja.scrollTop = caja.scrollHeight;
  }, [total, conversacion.id]);

  if (total === 0) {
    return (
      <p
        className={cn(
          "grid h-full min-h-0 place-items-center bg-[var(--cream-100)] px-4 py-10 text-center text-sm text-tinta-500",
          className,
        )}
      >
        Todavía no hay mensajes en este hilo.
      </p>
    );
  }

  const filas = conversacion.mensajes.map((m, i) => {
    const instante = new Date(m.createdAt);
    const dia = String(fechaDeInstante(instante));
    const anterior = conversacion.mensajes[i - 1];
    const diaAnterior = anterior
      ? String(fechaDeInstante(new Date(anterior.createdAt)))
      : null;
    return { m, hora: horaEnZona(instante), dia, abreDia: dia !== diaAnterior };
  });

  return (
    <div
      ref={cajaRef}
      className={cn(
        "min-h-0 overflow-y-auto overscroll-contain bg-[var(--cream-100)]",
        className,
      )}
    >
      <div className="grid gap-4 px-4 py-4">
        {filas.map(({ m, hora, dia, abreDia }) => {
          const esEntrante = m.direction === "INBOUND";

          return (
            <div key={m.id} className="grid gap-4">
              {abreDia ? (
                <p className="justify-self-center rounded-pill bg-blanco px-3 py-1 text-[11px] font-semibold text-tinta-500 shadow-[var(--shadow-xs)]">
                  {formatearFechaLarga(dia)}
                </p>
              ) : null}

              {esEntrante ? (
                <div className="grid w-full max-w-[min(100%,380px)] gap-1.5 justify-self-start">
                  <span className="mst-label">{conversacion.clienteNombre}</span>
                  <div className="rounded-[14px_14px_14px_4px] border border-[var(--green-200)] bg-[var(--green-50)] p-3 text-sm text-tinta-800 shadow-[var(--shadow-xs)]">
                    <p className="whitespace-pre-wrap leading-relaxed">
                      {m.bodyRenderizado}
                    </p>
                    <p className="mt-1 text-right text-[11px] tabular-nums text-tinta-500">
                      {hora}
                    </p>
                  </div>
                </div>
              ) : (
                <MensajePreview
                  variant={
                    m.tipo === "plantilla" ? "aviso" : "respuesta"
                  }
                  proposito={m.proposito ?? undefined}
                  etiqueta={etiquetaMensajeSaliente(m)}
                  cuerpo={m.bodyRenderizado ?? ""}
                  adjunto={m.adjuntoNombre ?? undefined}
                  hora={hora}
                  estado={m.status ?? undefined}
                  alineacion="derecha"
                  className={cn(
                    "justify-self-end",
                    m.status === "failed" && "opacity-80",
                  )}
                />
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
