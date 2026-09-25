"use client";

import Link from "next/link";
import { ESTADO_PRESENTACION, type ConversacionDetalle } from "@misupertostada/shared";
import { ExternalLink, ShoppingBag, Wallet } from "lucide-react";
import {
  hrefCapturaPedido,
  hrefCarteraCliente,
  hrefFichaCliente,
  hrefPedidoNoche,
} from "@/lib/conversacion-vista";
import { Money } from "@/components/domain/money";
import { cn } from "@/lib/utils";

export function FichaRestaurante({
  conversacion,
  className,
}: {
  conversacion: ConversacionDetalle;
  className?: string;
}) {
  const pedido = conversacion.pedidoNoche;
  const estadoPedido = pedido ? ESTADO_PRESENTACION[pedido.estado] : null;

  return (
    <aside
      className={cn(
        "flex min-h-0 flex-col gap-3 overflow-y-auto overscroll-contain border-[var(--border-subtle)] bg-[var(--surface-page)] p-3 sm:p-4",
        className,
      )}
    >
      <div className="grid gap-1">
        <p className="mst-label">Contexto del restaurante</p>
        <Link
          className="inline-flex items-center gap-1 text-sm font-semibold text-marca hover:underline"
          href={hrefFichaCliente(conversacion.clienteId)}
        >
          Ver ficha completa
          <ExternalLink size={14} aria-hidden />
        </Link>
      </div>

      <dl className="grid content-start gap-3 text-sm">
        <div className="grid gap-0.5">
          <dt className="mst-label">Horario de entrega</dt>
          <dd className="text-tinta-800">
            {conversacion.horarioEntregaFijo ?? "Sin horario fijo"}
          </dd>
        </div>

        {conversacion.notasPermanentes ? (
          <div className="grid gap-0.5">
            <dt className="mst-label">Notas permanentes</dt>
            <dd className="whitespace-pre-wrap text-tinta-800">
              {conversacion.notasPermanentes}
            </dd>
          </div>
        ) : null}

        <div className="grid gap-0.5">
          <dt className="mst-label">Pedido de esta noche</dt>
          <dd>
            {pedido ? (
              <Link
                className="inline-flex flex-wrap items-center gap-2 font-semibold text-marca hover:underline"
                href={hrefPedidoNoche({
                  fechaOperacion: pedido.fechaOperacion,
                  pedidoId: pedido.id,
                })}
              >
                <ShoppingBag size={14} aria-hidden />
                #{pedido.correlativo}
                {estadoPedido ? (
                  <span
                    className="rounded-pill px-2 py-0.5 text-[11px] font-semibold"
                    style={{
                      background: estadoPedido.bg,
                      color: estadoPedido.fg,
                    }}
                  >
                    {estadoPedido.label}
                  </span>
                ) : null}
              </Link>
            ) : (
              <div className="grid gap-1">
                <p className="text-tinta-600">Aún no pide esta noche</p>
                {conversacion.fechaOperacionViva ? (
                  <Link
                    className="inline-flex items-center gap-1 text-sm font-semibold text-marca hover:underline"
                    href={hrefCapturaPedido(
                      conversacion.clienteId,
                      conversacion.fechaOperacionViva,
                    )}
                  >
                    Capturar en Pedidos
                    <ExternalLink size={14} aria-hidden />
                  </Link>
                ) : null}
              </div>
            )}
          </dd>
        </div>

        <div className="grid gap-0.5">
          <dt className="mst-label">Saldo pendiente</dt>
          <dd>
            {conversacion.facturasPendientes > 0 ? (
              <Link
                className="inline-flex flex-wrap items-center gap-2 hover:underline"
                href={hrefCarteraCliente(conversacion.clienteId)}
              >
                <Wallet size={14} className="text-marca" aria-hidden />
                <Money
                  centavos={conversacion.saldoCentavos}
                  tone={
                    conversacion.saldoCentavos > 0 ? "pendiente" : "default"
                  }
                />
                <span className="text-tinta-600">
                  · {conversacion.facturasPendientes}{" "}
                  {conversacion.facturasPendientes === 1
                    ? "factura"
                    : "facturas"}
                </span>
              </Link>
            ) : (
              <p className="text-tinta-600">Sin saldo pendiente</p>
            )}
          </dd>
        </div>

        {!conversacion.telefonoWa ? (
          <p className="rounded-campo bg-[var(--amber-50)] px-3 py-2 text-xs text-[var(--amber-800)]">
            Este restaurante no tiene teléfono de WhatsApp registrado.
          </p>
        ) : null}
      </dl>
    </aside>
  );
}
