"use client";

import { Chip, ListBox } from "@heroui/react";
import { horaEnZona, type ConversacionBandeja } from "@misupertostada/shared";
import { MessageCircle } from "lucide-react";
import type { ReactNode } from "react";
import { VentanaBadge } from "@/components/domain/ventana-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { RowSkeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export function ListaConversaciones({
  items,
  sel,
  loading,
  vacio,
  onSelect,
  className,
}: {
  items: ConversacionBandeja[];
  sel: string | null;
  loading: boolean;
  vacio?: ReactNode;
  onSelect: (id: string) => void;
  className?: string;
}) {
  if (loading) return <RowSkeleton rows={8} />;
  if (items.length === 0) {
    return (
      vacio ?? (
        <EmptyState
          icon={<MessageCircle size={22} aria-hidden />}
          title="Sin conversaciones"
          description="El hilo se abre con el primer mensaje, de entrada o de salida."
        />
      )
    );
  }

  return (
    <ListBox
      aria-label="Conversaciones"
      className={cn("p-0 [&>*+*]:mt-0", className)}
      disallowEmptySelection
      selectedKeys={sel ? new Set([sel]) : new Set<string>()}
      selectionMode="single"
      onSelectionChange={(keys) => {
        if (keys === "all") return;
        const next = [...keys][0];
        if (typeof next === "string") onSelect(next);
      }}
    >
      {items.map((v) => {
        const activo = v.id === sel;
        const hora = v.ultimoAt ? horaEnZona(new Date(v.ultimoAt)) : "";
        return (
          <ListBox.Item
            key={v.id}
            id={v.id}
            textValue={v.clienteNombre}
            className={cn(
              "grid min-h-fila w-full items-start gap-1 rounded-none border-b border-l-[3px] px-4 py-3",
              "border-b-[var(--border-subtle)]",
              "transition-[background-color,border-color] duration-control ease-out",
              activo
                ? "border-l-marca bg-[var(--green-50)]"
                : "border-l-transparent hover:bg-tinta-50",
            )}
          >
            <span className="flex w-full items-center gap-1.5">
              <span className="min-w-0 flex-1 truncate text-sm font-semibold text-tinta-900">
                {v.clienteNombre}
              </span>
              {v.noLeidos > 0 ? (
                <Chip
                  className="shrink-0 tabular-nums"
                  color="danger"
                  size="sm"
                  variant="primary"
                >
                  {v.noLeidos}
                  <span className="sr-only"> sin leer</span>
                </Chip>
              ) : null}
              <span className="shrink-0 text-[11px] tabular-nums text-tinta-500">
                {hora}
              </span>
            </span>
            <span className="w-full truncate text-xs text-tinta-500">
              {v.ultimoCuerpo ?? "Sin mensajes"}
            </span>
            <VentanaBadge
              abierta={v.ventanaAbierta}
              tipo="whatsapp"
              expiraAt={v.ventanaExpiraAt}
              size="sm"
              compacto
            />
          </ListBox.Item>
        );
      })}
    </ListBox>
  );
}
