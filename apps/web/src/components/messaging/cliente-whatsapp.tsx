"use client";

import { Button, Card } from "@heroui/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { ConversacionDetalle } from "@misupertostada/shared";
import { api } from "@/lib/api";
import { buildConversacionesHref } from "@/lib/conversacion-vista";
import { toastFromError } from "@/lib/toast";
import { HiloConversacion } from "@/components/messaging/hilo-conversacion";
import { VentanaBadge } from "@/components/domain/ventana-badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";

/**
 * Chat de WhatsApp del cliente, visto desde su ficha. Es de solo lectura: responder vive en
 * Conversaciones, donde están el composer, las plantillas y el control de la ventana de 24 h.
 * La clave cuelga de `["conversaciones"]`, así el SSE de mensajes nuevos también la refresca.
 */
export function ClienteWhatsapp({
  clienteId,
  telefonoWa,
  puedeEnviar,
}: {
  clienteId: string;
  telefonoWa: string | null;
  puedeEnviar: boolean;
}) {
  const router = useRouter();
  const hilo = useQuery({
    queryKey: ["conversaciones", "cliente", clienteId],
    queryFn: () =>
      api<ConversacionDetalle | null>(`/clientes/${clienteId}/conversacion`),
  });

  const abrir = useMutation({
    mutationFn: () =>
      api<{ id: string }>(`/clientes/${clienteId}/conversacion`, {
        method: "POST",
      }),
    onSuccess: (data) => router.push(buildConversacionesHref({ id: data.id })),
    onError: (err) => toastFromError(err, "No se pudo abrir la conversación"),
  });

  if (hilo.isLoading) {
    return (
      <Card className="gap-3 p-4 sm:p-5">
        <Skeleton className="h-6 w-48 rounded-campo" />
        <Skeleton className="h-72 w-full rounded-campo" />
      </Card>
    );
  }

  const conv = hilo.data;

  if (!conv) {
    return (
      <Card className="p-0">
        <EmptyState
          icon={<MessageCircle size={22} aria-hidden />}
          title="Sin mensajes de WhatsApp"
          description={
            telefonoWa
              ? "Todavía no hay conversación con este cliente."
              : "El cliente no tiene teléfono de WhatsApp. Agréguelo en Datos para poder escribirle."
          }
          action={
            puedeEnviar && telefonoWa ? (
              <Button
                isDisabled={abrir.isPending}
                size="sm"
                variant="secondary"
                onPress={() => abrir.mutate()}
              >
                {abrir.isPending ? "Un momento…" : "Escribirle por WhatsApp"}
              </Button>
            ) : undefined
          }
        />
      </Card>
    );
  }

  return (
    <Card className="gap-0 overflow-hidden p-0">
      <Card.Header className="flex-row flex-wrap items-center justify-between gap-2 px-4 py-4 pb-3 sm:px-5">
        <div className="min-w-0">
          <Card.Title className="text-base text-tinta-900">WhatsApp</Card.Title>
          <Card.Description>
            {conv.mensajes.length === 1
              ? "1 mensaje"
              : `${conv.mensajes.length} mensajes`}
            {telefonoWa ? ` · ${telefonoWa}` : ""}
          </Card.Description>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VentanaBadge
            abierta={conv.ventanaAbierta}
            tipo="whatsapp"
            expiraAt={conv.ventanaExpiraAt}
          />
          <Link className="text-sm" href={buildConversacionesHref({ id: conv.id })}>
            {puedeEnviar ? "Responder" : "Abrir en Conversaciones"}
          </Link>
        </div>
      </Card.Header>
      <Card.Content className="p-0">
        <HiloConversacion
          conversacion={conv}
          className="h-[min(32rem,60vh)] overflow-y-auto overscroll-contain"
        />
      </Card.Content>
    </Card>
  );
}
