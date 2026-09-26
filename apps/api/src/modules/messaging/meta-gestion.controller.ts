import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from "@nestjs/common";
import { envelopeOk } from "@misupertostada/shared";
import { RequierePermiso } from "../identity/permisos.guard";
import { CurrentActor } from "../identity/current-actor";
import type { Actor } from "../identity/actor";
import { MetaGestionService } from "./meta-gestion.service";

/** Configuración → Plantillas de Meta. Todo exige `mensajeria.conectar`. */
@Controller("mensajeria/meta")
export class MetaGestionController {
  constructor(private readonly gestion: MetaGestionService) {}

  @Get("plantillas")
  @RequierePermiso("mensajeria.conectar")
  async plantillas(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.gestion.plantillas(actor));
  }

  @Post("plantillas/sync")
  @RequierePermiso("mensajeria.conectar")
  async sincronizar(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.gestion.sincronizar(actor));
  }

  @Post("plantillas")
  @RequierePermiso("mensajeria.conectar")
  async crear(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.gestion.crear(body, actor));
  }

  @Put("plantillas/:id")
  @RequierePermiso("mensajeria.conectar")
  async editar(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.gestion.editar(id, body, actor));
  }

  @Post("plantillas/:id/retirar")
  @RequierePermiso("mensajeria.conectar")
  async retirar(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.gestion.retirar(id, body, actor));
  }
}
