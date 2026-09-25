import { Check, CheckCheck, FileText, TriangleAlert } from "lucide-react";
import {
  PROPOSITO_ETIQUETA,
  type PlantillaProposito,
} from "@misupertostada/shared";
import { cn } from "@/lib/utils";

type EstadoUi = "enviado" | "entregado" | "leido" | "error" | "pending";

export function MensajePreview({
  variant = "respuesta",
  proposito,
  etiqueta,
  cuerpo,
  adjunto,
  hora,
  estado,
  alineacion = "izquierda",
  className,
}: {
  /** @deprecated use variant */
  tipo?: "plantilla" | "libre";
  variant?: "aviso" | "respuesta";
  proposito?: PlantillaProposito;
  etiqueta?: string;
  /** @deprecated use etiqueta/proposito */
  plantilla?: string;
  cuerpo: string;
  adjunto?: string;
  hora?: string;
  estado?: string;
  alineacion?: "izquierda" | "derecha";
  className?: string;
}) {
  const esAviso = variant === "aviso";
  const rotulo =
    etiqueta ??
    (proposito ? PROPOSITO_ETIQUETA[proposito] : undefined) ??
    (esAviso ? "Aviso automático" : "Respuesta de la fábrica");
  const marca = normalizarEstado(estado);

  return (
    <div
      className={cn(
        "grid max-w-[min(100%,420px)] gap-1.5",
        alineacion === "derecha" ? "justify-self-end" : "justify-self-start",
        className,
      )}
    >
      <span
        className={cn(
          "mst-label",
          alineacion === "derecha" ? "text-right" : "text-left",
        )}
      >
        {rotulo}
      </span>
      <div
        className={cn(
          "rounded-[14px] border p-3 shadow-[var(--shadow-xs)]",
          alineacion === "derecha"
            ? "rounded-br-[4px]"
            : "rounded-bl-[4px]",
          esAviso
            ? "border-[var(--green-200)] bg-[var(--green-50)]"
            : "border-[var(--border-subtle)] bg-blanco",
        )}
      >
        {adjunto ? (
          <div className="mb-2 flex items-center gap-2 rounded-campo border border-[var(--border-subtle)] bg-tinta-50 p-2">
            <FileText size={16} className="text-peligro" aria-hidden />
            <span className="text-xs font-semibold">{adjunto}</span>
          </div>
        ) : null}
        <p className="whitespace-pre-wrap text-sm leading-relaxed text-tinta-800">
          {cuerpo}
        </p>
        <div className="mt-1 flex items-center justify-end gap-1.5 text-[11px] tabular-nums text-tinta-500">
          {hora}
          {marca === "enviado" || marca === "pending" ? (
            <Check size={12} aria-hidden />
          ) : null}
          {marca === "entregado" ? <CheckCheck size={12} aria-hidden /> : null}
          {marca === "leido" ? (
            <CheckCheck size={12} className="text-[var(--blue-600)]" aria-hidden />
          ) : null}
          {marca === "error" ? (
            <TriangleAlert size={12} className="text-peligro" aria-hidden />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function normalizarEstado(estado: string | undefined): EstadoUi | undefined {
  if (!estado) return undefined;
  if (estado === "sent" || estado === "enviado") return "enviado";
  if (estado === "delivered" || estado === "entregado") return "entregado";
  if (estado === "read" || estado === "leido") return "leido";
  if (estado === "failed" || estado === "error") return "error";
  if (estado === "pending") return "pending";
  return undefined;
}
