import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import { envelopeOk } from "@misupertostada/shared";
import { RequierePermiso } from "../identity/permisos.guard";
import { CurrentActor } from "../identity/current-actor";
import type { Actor } from "../identity/actor";
import { EntregaService } from "./entrega.service";

@Controller()
export class EntregaController {
  constructor(private readonly entregas: EntregaService) {}

  @Get("reparto")
  async ruta(
    @Query() query: Record<string, string | undefined>,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.entregas.ruta(query, actor));
  }

  @Get("reparto/atrasados")
  async atrasados(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.entregas.atrasados(actor));
  }

  @Post("entregas")
  @RequierePermiso("pedidos.entregar")
  async entregar(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.entregas.entregar(body, actor));
  }
}
