import { Module } from "@nestjs/common";
import { PedidoService } from "./pedido.service";
import { PedidosController } from "./pedidos.controller";
import { PortalController } from "./portal.controller";
import { PortalService } from "./portal.service";
import { PortalTokenGuard } from "./portal.guard";
import { PortalTokenService } from "./portal-token.service";
import { PortalRateLimit, portalRateLimitDefault } from "./portal-rate-limit";
import { CatalogModule } from "../catalog/catalog.module";
import { ReceivablesModule } from "../receivables/receivables.module";
import { PortalPedidoService } from "./portal-pedido.service";
import { PortalAssetsService } from "./portal-assets.service";
import { PortalSessionService } from "./portal-session.service";

@Module({
  imports: [ReceivablesModule, CatalogModule],
  controllers: [PortalController, PedidosController],
  providers: [
    PortalTokenService,
    { provide: PortalRateLimit, useFactory: portalRateLimitDefault },
    PortalTokenGuard,
    PedidoService,
    PortalPedidoService,
    PortalAssetsService,
    PortalSessionService,
    PortalService,
  ],
})
export class OrderingModule {}
