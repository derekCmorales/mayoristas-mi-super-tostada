import { Module } from "@nestjs/common";
import { FacturaService, FACTURA_AL_ENTREGAR } from "./factura.service";
import { PagoService } from "./pago.service";
import { AbonoService } from "./abono.service";
import { ABONO_PORTAL } from "./abono-portal";
import { FACTURA_PORTAL } from "./factura-portal";
import { FacturaPortalService } from "./factura-portal.service";
import { CarteraService } from "./cartera.service";
import { ReceivablesController } from "./receivables.controller";

@Module({
  controllers: [ReceivablesController],
  providers: [
    FacturaService,
    AbonoService,
    PagoService,
    CarteraService,
    { provide: FACTURA_AL_ENTREGAR, useExisting: FacturaService },
    { provide: ABONO_PORTAL, useExisting: AbonoService },
    FacturaPortalService,
    { provide: FACTURA_PORTAL, useExisting: FacturaPortalService },
  ],
  exports: [
    FACTURA_AL_ENTREGAR,
    ABONO_PORTAL,
    FACTURA_PORTAL,
    FacturaService,
    PagoService,
    AbonoService,
    CarteraService,
  ],
})
export class ReceivablesModule {}
