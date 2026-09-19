import { Inject, Injectable } from "@nestjs/common";
import {
  capturaAbierta,
  instanteAIso,
  portalSesionSchema,
  saludoPortalDe,
  timestampsVentana,
  type PortalSesion,
} from "@misupertostada/shared";
import { BusinessCalendarService } from "../shared/calendar.service";
import { ABONO_PORTAL, type AbonoPortal } from "../receivables/abono-portal";
import { CATALOGO_PORTAL, type CatalogoPortal } from "../catalog/catalogo-portal";
import { PedidoService } from "./pedido.service";
import { PortalPedidoService } from "./portal-pedido.service";
import { horarioDe } from "./pedido-reglas";
import type { ClientePortal } from "./portal-token.service";

@Injectable()
export class PortalSessionService {
  constructor(
    private readonly calendar: BusinessCalendarService,
    private readonly pedidos: PedidoService,
    private readonly portalPedidos: PortalPedidoService,
    @Inject(CATALOGO_PORTAL) private readonly catalogo: CatalogoPortal,
    @Inject(ABONO_PORTAL) private readonly abonos: AbonoPortal,
  ) {}

  async abrir(clienteRow: ClientePortal): Promise<PortalSesion> {
    const cal = await this.calendar.load(clienteRow.organizacionId);
    const now = this.calendar.now();
    const ejes = await this.calendar.ejes(clienteRow.organizacionId);
    const fechaOperacion = ejes.captura;
    const diaEstado = ejes.estadoCaptura;
    const abierta = capturaAbierta(ejes.ventanaAbierta, diaEstado);
    const horario = horarioDe(clienteRow);
    const { cierraAt, proximaAperturaAt } = timestampsVentana({
      ventanaAbierta: ejes.ventanaAbierta,
      estadoCaptura: diaEstado,
      cierraDate: cal.getCierreVentana(now),
      proximaAperturaDesde: (from) => cal.getProximaApertura(from),
      now,
    });

    const [catalogo, bonos, pedidoAbierto, cuenta, ultimoPedido] =
      await Promise.all([
        this.catalogo.catalogo(clienteRow),
        this.catalogo.bonosDisponibles(clienteRow),
        this.pedidos.portalAbierto(clienteRow.id, fechaOperacion, horario),
        this.abonos.cuentaDe(clienteRow.id, clienteRow.organizacionId),
        this.portalPedidos.ultimo(clienteRow.id),
      ]);

    return portalSesionSchema.parse({
      cliente: {
        id: clienteRow.id,
        nombre: clienteRow.nombre,
        horarioEntregaFijo: horario,
      },
      ventana: {
        abierta,
        fechaOperacion,
        fechaEntrega: ejes.entregaCaptura,
        diaEstado,
        cierraAt,
        proximaAperturaAt,
        horarioEntregaFijo: horario,
      },
      catalogo,
      bonos,
      pedidoAbierto,
      cuenta,
      ahoraIso: instanteAIso(now),
      saludo: saludoPortalDe(now),
      ultimoPedido,
    });
  }
}
