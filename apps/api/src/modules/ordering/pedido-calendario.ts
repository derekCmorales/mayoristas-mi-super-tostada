import type { AppDatabase } from "../shared/database.module";
import { BusinessCalendarService } from "../shared/calendar.service";
import {
  bloquearDiaOperacion,
  leerEstadoDia,
} from "../shared/dia-operacion";
import { diaCerrado } from "./pedido-reglas";
import type { FechasPedido } from "./pedido-repositorio";

export async function fechasCapturaPanel(
  calendar: BusinessCalendarService,
  organizacionId: string,
): Promise<FechasPedido> {
  const ejes = await calendar.ejes(organizacionId);
  return { operacion: ejes.captura, entrega: ejes.entregaCaptura };
}

export async function relojVivoSobreCaptura(
  calendar: BusinessCalendarService,
  organizacionId: string,
  fechaOperacion: string,
): Promise<boolean> {
  const ejes = await calendar.ejes(organizacionId);
  return ejes.ventanaAbierta && ejes.captura === fechaOperacion;
}

export async function exigirDiaNoCerrado(
  tx: AppDatabase,
  organizacionId: string,
  fechaOperacion: string,
  relojVivoSobreEstaFecha: boolean,
): Promise<void> {
  await bloquearDiaOperacion(tx, organizacionId, fechaOperacion);
  const { diaEstado } = await leerEstadoDia(tx, organizacionId, fechaOperacion);
  if (diaEstado !== "CERRADO") return;
  if (relojVivoSobreEstaFecha) return;
  throw diaCerrado();
}
