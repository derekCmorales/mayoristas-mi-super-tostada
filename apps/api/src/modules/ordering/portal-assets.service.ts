import { Inject, Injectable } from "@nestjs/common";
import { and, eq } from "drizzle-orm";
import { abono, producto } from "@misupertostada/db";
import type { AssetVariante } from "@misupertostada/shared";
import { DRIZZLE } from "../shared/tokens";
import type { AppDatabase } from "../shared/database.module";
import { DomainException } from "../shared/domain.exception";
import { AssetsService } from "../shared/storage/assets.service";
import type { ClientePortal } from "./portal-token.service";

@Injectable()
export class PortalAssetsService {
  constructor(
    @Inject(DRIZZLE) private readonly db: AppDatabase,
    private readonly assets: AssetsService,
  ) {}

  async content(
    clienteRow: ClientePortal,
    assetId: string,
    variante?: AssetVariante | string,
  ): Promise<{ bytes: Buffer; mime: string }> {
    const permitido = await this.permitido(clienteRow, assetId);
    if (!permitido) {
      throw new DomainException("NO_ENCONTRADO", "Archivo no encontrado", 404);
    }
    return this.assets.getContent(assetId, variante);
  }

  async viewUrl(
    clienteRow: ClientePortal,
    assetId: string,
    apiBaseUrl: string,
  ): Promise<string> {
    const permitido = await this.permitido(clienteRow, assetId);
    if (!permitido) {
      throw new DomainException("NO_ENCONTRADO", "Archivo no encontrado", 404);
    }
    return this.assets.getViewUrl(assetId, apiBaseUrl);
  }

  private async permitido(
    clienteRow: ClientePortal,
    assetId: string,
  ): Promise<boolean> {
    if (clienteRow.fotoAssetId === assetId) return true;

    const [ab] = await this.db
      .select({ id: abono.id })
      .from(abono)
      .where(
        and(
          eq(abono.comprobanteAssetId, assetId),
          eq(abono.clienteId, clienteRow.id),
        ),
      )
      .limit(1);
    if (ab) return true;

    const [prod] = await this.db
      .select({ id: producto.id })
      .from(producto)
      .where(
        and(
          eq(producto.fotoAssetId, assetId),
          eq(producto.organizacionId, clienteRow.organizacionId),
          eq(producto.activo, true),
        ),
      )
      .limit(1);
    return Boolean(prod);
  }
}
