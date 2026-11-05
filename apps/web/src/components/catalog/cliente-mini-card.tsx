"use client";

import { Card, Chip } from "@heroui/react";
import Link from "next/link";
import { formatearTelefonoWa, type ClientePublico } from "@misupertostada/shared";
import { ClienteAvatar } from "@/components/catalog/cliente-avatar";
import { WhatsappChip } from "@/components/catalog/telefono-wa";
import { Money } from "@/components/domain/money";
import { cn } from "@/lib/utils";
import {
  nivelAlertaCliente,
  type ClienteCobranzaResumen,
  type NivelAlertaCliente,
} from "@/lib/cliente-cobranza";

/* El filete izquierdo lleva el estado de la cuenta. Antes la ficha entera se
   pintaba de rojo al excederse el límite; a doce fichas por pantalla eso grita
   más de lo que informa. */
const RAIL: Record<NivelAlertaCliente, string> = {
  excedido: "border-l-[var(--red-600)]",
  vencido: "border-l-[var(--red-600)]",
  pendiente: "border-l-[var(--amber-600)]",
  ninguno: "border-l-[var(--green-300)]",
};

export function ClienteMiniCard({
  cliente,
  cobranza,
}: {
  cliente: ClientePublico;
  cobranza: ClienteCobranzaResumen;
}) {
  const nivel = nivelAlertaCliente(cliente, cobranza);
  const excedido = nivel === "excedido";

  return (
    <Link
      href={`/clientes/${cliente.id}`}
      className={cn(
        "group block rounded-tarjeta text-inherit no-underline",
        "hover:text-inherit hover:no-underline",
        "focus-visible:outline-none focus-visible:shadow-foco",
      )}
    >
      <Card
        className={cn(
          "h-full min-w-0 gap-4 border-l-[3px] p-4",
          "transition-shadow duration-control ease-out group-hover:shadow-[var(--shadow-md)]",
          RAIL[nivel],
          !cliente.activo && "opacity-70",
        )}
      >
        <Card.Header className="flex-row items-start gap-3">
          <ClienteAvatar
            nombre={cliente.nombre}
            fotoAssetId={cliente.fotoAssetId}
            size="md"
          />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Card.Title className="truncate text-[15px] leading-snug text-tinta-900">
                {cliente.nombre}
              </Card.Title>
              {!cliente.activo && (
                <Chip color="warning" size="sm" variant="soft">
                  Inactivo
                </Chip>
              )}
              {cliente.activo && <WhatsappChip cliente={cliente} />}
            </div>
            <Card.Description className="mt-0.5 truncate">
              {cliente.contacto ?? "Sin contacto"}
              {cliente.telefonoWa ? ` · ${formatearTelefonoWa(cliente.telefonoWa)}` : ""}
            </Card.Description>
            <p className="mt-0.5 text-xs tabular-nums text-tinta-500">
              {cliente.horarioEntregaFijo
                ? `Entrega ${cliente.horarioEntregaFijo}`
                : "Sin horario fijo"}
            </p>
          </div>
        </Card.Header>

        {/* La cuenta se lee en una sola línea: cuántas facturas y cuánto dinero.
            El detalle (vencidas, sin DTE) solo aparece cuando existe. */}
        <Card.Content
          className={cn(
            "mt-auto flex-row items-end justify-between gap-3 rounded-[calc(var(--radius-card)-6px)] px-3 py-2.5",
            excedido ? "bg-[var(--red-100)]" : "bg-[var(--ink-50)]",
          )}
        >
          <div className="min-w-0">
            <p className="mst-label text-[11px]">Facturas pendientes</p>
            <p
              className={cn(
                "text-lg font-semibold leading-none tabular-nums sm:text-[22px]",
                excedido
                  ? "text-peligro"
                  : cobranza.facturasPendientes > 0
                    ? "text-tinta-900"
                    : "text-marca",
              )}
            >
              {cobranza.facturasPendientes}
              {cliente.limiteFacturasPendientes != null && (
                <span className="text-sm font-medium text-tinta-500">
                  /{cliente.limiteFacturasPendientes}
                </span>
              )}
            </p>
          </div>
          <div className="min-w-0 shrink text-right">
            <p className="mst-label text-[11px]">Saldo</p>
            <Money
              centavos={cobranza.saldoCentavos}
              tone={cobranza.saldoCentavos > 0 ? "pendiente" : "muted"}
              truncate
              className="text-sm sm:text-[15px]"
            />
          </div>
        </Card.Content>

        {(excedido ||
          cobranza.facturasVencidas > 0 ||
          cobranza.facturasEnProgreso > 0) && (
          <Card.Footer className="flex-wrap gap-1.5">
            {excedido && (
              <Chip color="danger" size="sm" variant="soft">
                Límite excedido
              </Chip>
            )}
            {cobranza.facturasVencidas > 0 && (
              <Chip color="danger" size="sm" variant="soft">
                {cobranza.facturasVencidas} vencida
                {cobranza.facturasVencidas === 1 ? "" : "s"}
              </Chip>
            )}
            {cobranza.facturasEnProgreso > 0 && (
              <Chip color="warning" size="sm" variant="soft">
                {cobranza.facturasEnProgreso} por facturar
              </Chip>
            )}
          </Card.Footer>
        )}
      </Card>
    </Link>
  );
}
