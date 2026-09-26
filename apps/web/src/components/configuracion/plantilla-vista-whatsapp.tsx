"use client";

import { ExternalLink, FileText, Reply } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import type { PlantillaBorrador } from "@misupertostada/shared";
import { cn } from "@/lib/utils";

/**
 * Cómo verá el restaurante la plantilla en WhatsApp: encabezado, cuerpo con
 * los ejemplos puestos, pie y botones debajo de la burbuja. Una variable sin
 * ejemplo se muestra marcada para que salte a la vista antes de enviar.
 */
export function PlantillaVistaWhatsApp({
  borrador: b,
  className,
}: {
  borrador: PlantillaBorrador;
  className?: string;
}) {
  const vacia = !b.body.trim() && !b.headerTexto?.trim() && b.headerTipo !== "DOCUMENT";
  return (
    <div
      className={cn(
        "grid gap-1 rounded-tarjeta bg-[var(--green-50)] p-3 sm:p-4",
        className,
      )}
    >
      <div className="max-w-[320px] justify-self-start">
        <div className="rounded-[12px] rounded-tl-[4px] bg-blanco p-1.5 shadow-[var(--shadow-xs)]">
          {b.headerTipo === "DOCUMENT" ? (
            <div className="mb-1 flex items-center gap-2.5 rounded-[8px] bg-[var(--ink-50)] p-2.5">
              <span className="grid size-9 shrink-0 place-items-center rounded-[6px] bg-[var(--red-100)] text-peligro">
                <FileText size={18} aria-hidden />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-semibold text-tinta-900">
                  estado-de-cuenta.pdf
                </span>
                <span className="block text-[11px] text-tinta-500">PDF · se adjunta al enviar</span>
              </span>
            </div>
          ) : null}
          <div className="grid gap-1 px-1.5 pb-0.5 pt-1">
            {b.headerTipo === "TEXT" && b.headerTexto ? (
              <p className="text-sm font-bold leading-snug text-tinta-900 [overflow-wrap:anywhere]">
                <ConEjemplos texto={b.headerTexto} ejemplos={b.headerEjemplos} />
              </p>
            ) : null}
            <p className="whitespace-pre-wrap text-sm leading-relaxed text-tinta-800 [overflow-wrap:anywhere]">
              {vacia ? (
                <span className="text-tinta-400">El mensaje aparece aquí mientras escribe.</span>
              ) : (
                <ConEjemplos texto={b.body} ejemplos={b.bodyEjemplos} />
              )}
            </p>
            {b.footer?.trim() ? (
              <p className="text-xs leading-snug text-tinta-500">{b.footer}</p>
            ) : null}
            <p className="-mt-0.5 text-right text-[11px] tabular-nums text-tinta-400">21:14</p>
          </div>
        </div>
        {b.botones.length ? (
          <div className="mt-1 grid gap-1">
            {b.botones.map((btn, i) => (
              <span
                key={i}
                className="flex min-h-9 items-center justify-center gap-1.5 rounded-[10px] bg-blanco px-3 text-sm font-semibold text-[var(--blue-600)] shadow-[var(--shadow-xs)]"
              >
                {btn.tipo === "URL" ? (
                  <ExternalLink size={14} aria-hidden />
                ) : (
                  <Reply size={14} aria-hidden />
                )}
                {btn.texto || <span className="text-tinta-400">Botón sin texto</span>}
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Sustituye `{{n}}` por su ejemplo; si falta, lo deja marcado. */
function ConEjemplos({ texto, ejemplos }: { texto: string; ejemplos: readonly string[] }) {
  const partes: ReactNode[] = [];
  let ultimo = 0;
  for (const m of texto.matchAll(/\{\{\s*(\d+)\s*\}\}/g)) {
    const idx = m.index ?? 0;
    partes.push(texto.slice(ultimo, idx));
    const n = Number(m[1]);
    const ejemplo = ejemplos[n - 1]?.trim();
    partes.push(
      ejemplo ? (
        <span key={idx} className="rounded-[3px] bg-[var(--green-100)] px-0.5 text-tinta-900">
          {ejemplo}
        </span>
      ) : (
        <span
          key={idx}
          className="rounded-[3px] bg-[var(--amber-100)] px-1 font-mono text-[12px] text-[var(--amber-700)]"
        >
          {`{{${n}}}`}
        </span>
      ),
    );
    ultimo = idx + m[0].length;
  }
  partes.push(texto.slice(ultimo));
  return (
    <>
      {partes.map((p, i) => (
        <Fragment key={i}>{p}</Fragment>
      ))}
    </>
  );
}
