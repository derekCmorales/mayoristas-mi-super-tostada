import type { AppDatabase } from "../modules/shared/database.module";
import { AuditWriter } from "../modules/shared/audit.writer";
import { BusinessCalendarService } from "../modules/shared/calendar.service";
import { AssetsService } from "../modules/shared/storage/assets.service";
import { CatalogoPortalService } from "../modules/catalog/catalogo-portal.service";
import { AbonoService } from "../modules/receivables/abono.service";
import { FacturaPortalService } from "../modules/receivables/factura-portal.service";
import { PedidoService } from "../modules/ordering/pedido.service";
import { PortalService } from "../modules/ordering/portal.service";
import { PortalPedidoService } from "../modules/ordering/portal-pedido.service";
import { PortalAssetsService } from "../modules/ordering/portal-assets.service";
import { PortalSessionService } from "../modules/ordering/portal-session.service";

/** Arma el grafo de portal como en `OrderingModule`, para e2e sin Nest. */
export function crearPortalService(deps: {
  db: AppDatabase;
  audit: AuditWriter;
  calendar: BusinessCalendarService;
  pedidos: PedidoService;
  assets: AssetsService;
  abonos: AbonoService;
}) {
  const facturasPortal = new FacturaPortalService(deps.db, deps.calendar);
  const catalogoPortal = new CatalogoPortalService(deps.db);
  const portalPedidos = new PortalPedidoService(deps.db, facturasPortal);
  const portalAssets = new PortalAssetsService(deps.db, deps.assets);
  const session = new PortalSessionService(
    deps.calendar,
    deps.pedidos,
    portalPedidos,
    catalogoPortal,
    deps.abonos,
  );
  return new PortalService(
    deps.audit,
    deps.assets,
    session,
    portalPedidos,
    portalAssets,
    deps.abonos,
    facturasPortal,
  );
}
