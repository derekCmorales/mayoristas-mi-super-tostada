import Link from "next/link";
import { Card } from "@heroui/react";
import { ChevronRight } from "lucide-react";
import type { DiaRepartoAtrasado } from "@misupertostada/shared";
import { Money } from "@/components/domain/money";
import { etiquetaDiaSemanaCorto } from "@/lib/fecha-ui";
import { hrefRepartoDia, plural, tituloAtrasados } from "@/lib/reparto-dia";

/**
 * Pedidos de días de calle ya pasados que nadie marcó entregados.
 *
 * No están perdidos, pero sin la marca no tienen factura: no aparecen en la
 * cartera ni se les puede registrar un cobro. Cada fila lleva a la ruta de ese
 * día para marcarlos ahí mismo.
 */
export function AvisoAtrasados({ dias }: { dias: DiaRepartoAtrasado[] }) {
  if (dias.length === 0) return null;
  return (
    <Card className="w-full gap-3 border-l-[4px] border-l-[var(--amber-600)] p-4">
      <Card.Header className="flex flex-col items-start gap-1">
        <Card.Title>{tituloAtrasados(dias)}</Card.Title>
        <Card.Description>
          Siguen guardados, pero sin factura: no cuentan en cartera ni se les
          puede cobrar hasta marcarlos.
        </Card.Description>
      </Card.Header>
      <Card.Content className="p-0">
        <ul className="grid gap-2">
          {dias.map((d) => (
            <li key={d.fechaEntrega}>
              <Link
                href={hrefRepartoDia(d.fechaEntrega)}
                className="flex min-h-fila min-w-0 items-center gap-3 rounded-tarjeta border border-[var(--border-subtle)] bg-blanco px-4 py-3 text-inherit no-underline transition-[background-color] duration-control ease-out hover:bg-tinta-50 hover:text-inherit hover:no-underline focus-visible:outline-none focus-visible:shadow-foco"
              >
                <span className="min-w-0 flex-1 grid gap-0.5">
                  <span className="text-sm font-semibold text-tinta-900">
                    Reparto del {etiquetaDiaSemanaCorto(d.fechaEntrega)}
                  </span>
                  <span className="text-xs tabular-nums text-tinta-500">
                    {plural(d.pendientes, "pedido sin marcar", "pedidos sin marcar")}
                  </span>
                </span>
                <Money
                  centavos={d.montoEstimadoCentavos}
                  tone="pendiente"
                  truncate
                />
                <ChevronRight
                  size={18}
                  aria-hidden
                  className="shrink-0 text-tinta-500"
                />
              </Link>
            </li>
          ))}
        </ul>
      </Card.Content>
    </Card>
  );
}
