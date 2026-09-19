import {
  MENSAJE_PEDIDO_ANULADO,
  MENSAJE_VENTANA_CERRADA,
  capturaAbierta,
  fechaDeInstante,
  formatearFechaLarga,
  horaEnZona,
  tienePermiso,
  type BusinessCalendar,
} from "@misupertostada/shared";
import type { EjesOperacion } from "../shared/calendar.service";
import { DomainException } from "../shared/domain.exception";
import type { Actor } from "../identity/actor";
import type { ClientePortal } from "./portal-token.service";

export type ItemSnapshot = {
  productoId: string;
  cantidad: number;
  nombreMostrado: string;
  unidadMedida: "LIBRA" | "BOLSA" | "UNIDAD";
  precioUnitarioCentavos: number;
  esDevolucion: boolean;
  bonoId: string | null;
};

export function horarioDe(
  clienteRow: Pick<ClientePortal, "horarioEntregaFijo">,
): string | null {
  const raw = clienteRow.horarioEntregaFijo;
  if (!raw) return null;
  return raw.slice(0, 5);
}

export function exigirCaptura(actor: Actor): void {
  if (!tienePermiso(actor.permisos, "pedidos.capturar_manual")) {
    throw new DomainException(
      "PERMISO_DENEGADO",
      "No tiene permiso para esta acción",
      403,
    );
  }
}

export function exigirAnulable(estado: string): void {
  if (estado === "ANULADO") {
    throw new DomainException("PEDIDO_ANULADO", MENSAJE_PEDIDO_ANULADO, 409);
  }
  if (estado === "ENTREGADO") {
    throw new DomainException(
      "PEDIDO_ENTREGADO",
      "Un pedido entregado no se anula: la factura se calcula sobre lo entregado.",
      409,
    );
  }
  if (estado !== "CONFIRMADO") {
    throw new DomainException(
      "PEDIDO_NO_EDITABLE",
      "Solo se anulan pedidos confirmados",
      409,
    );
  }
}

export function exigirConfirmado(estado: string): void {
  if (estado === "ANULADO") {
    throw new DomainException("PEDIDO_ANULADO", MENSAJE_PEDIDO_ANULADO, 409);
  }
  if (estado !== "CONFIRMADO") {
    throw new DomainException(
      "PEDIDO_NO_EDITABLE",
      "Solo se ajustan pedidos confirmados",
      409,
    );
  }
}

export function congelarSnapshots(
  snapshots: ItemSnapshot[],
  itemsAntes: ItemSnapshot[],
): ItemSnapshot[] {
  return snapshots.map((item) => {
    const previo = itemsAntes.find(
      (p) =>
        p.productoId === item.productoId &&
        p.esDevolucion === item.esDevolucion &&
        (!item.esDevolucion || p.bonoId === item.bonoId),
    );
    if (!previo) return item;
    return {
      ...item,
      nombreMostrado: previo.nombreMostrado,
      unidadMedida: previo.unidadMedida,
      precioUnitarioCentavos: item.esDevolucion
        ? 0
        : previo.precioUnitarioCentavos,
      bonoId: item.esDevolucion ? item.bonoId : null,
    };
  });
}

/**
 * `proxima` es `null` cuando no hay horario configurado en `ventana_semanal`:
 * no hay apertura que prometer, así que el mensaje se queda en el genérico en
 * vez de inventar una fecha.
 */
export function ventanaCerrada(proxima: Date | null): DomainException {
  if (!proxima) {
    return new DomainException("VENTANA_CERRADA", MENSAJE_VENTANA_CERRADA, 409);
  }
  const fechaLarga = formatearFechaLarga(fechaDeInstante(proxima));
  const hora = horaEnZona(proxima);
  return new DomainException(
    "VENTANA_CERRADA",
    `${MENSAJE_VENTANA_CERRADA} Abre el ${fechaLarga} a las ${hora}.`,
    409,
  );
}

export function diaCerrado(): DomainException {
  return new DomainException(
    "DIA_CERRADO",
    "El día de operación ya está cerrado. Reabrir requiere motivo y lo hace solo el administrador jefe.",
    409,
  );
}

/**
 * Un día REABIERTO acepta pedidos del portal aunque el reloj diga que la
 * ventana venció: es lo mismo que ya permite el panel.
 */
export function exigirVentanaPortal(
  cal: BusinessCalendar,
  now: Date,
  ejes: EjesOperacion,
): void {
  if (capturaAbierta(ejes.ventanaAbierta, ejes.estadoCaptura)) return;
  throw ventanaCerrada(cal.getProximaApertura(now));
}
