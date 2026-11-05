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
import { ConversacionService } from "./conversacion.service";
import { PlantillaService } from "./plantilla.service";
import { ConexionWabaService } from "./conexion.service";
import { EnvioAutomaticoService } from "./envio-automatico.service";

@Controller()
export class ConversacionesController {
  constructor(
    private readonly conversaciones: ConversacionService,
    private readonly plantillas: PlantillaService,
    private readonly conexion: ConexionWabaService,
    private readonly envioAutomatico: EnvioAutomaticoService,
  ) {}

  @Get("conversaciones")
  async listar(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.conversaciones.listar(actor));
  }

  @Get("conversaciones/:id")
  async obtener(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.conversaciones.obtener(id, actor));
  }

  @Post("conversaciones/:id/enviar")
  @RequierePermiso("mensajeria.enviar")
  async enviar(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.conversaciones.enviar(id, body, actor));
  }

  @Post("conversaciones/:id/leer")
  async leer(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.conversaciones.marcarLeidos(id, actor));
  }

  @Post("conversaciones/:id/simular-inbound")
  async simular(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    await this.conversaciones.simularInbound(id, body, actor);
    return envelopeOk({ ok: true });
  }

  @Get("mensajeria/conexion")
  async conexionEstado(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.conexion.estado(actor));
  }

  @Get("mensajeria/envio-automatico")
  async envioAutomaticoEstado(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.envioAutomatico.estado(actor));
  }

  @Put("mensajeria/envio-automatico")
  @RequierePermiso("mensajeria.conectar")
  async envioAutomaticoCambiar(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.envioAutomatico.cambiar(body, actor));
  }

  @Post("mensajeria/oauth/callback")
  @RequierePermiso("mensajeria.conectar")
  async oauth(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.conexion.callback(body, actor));
  }

  @Get("mensajeria/plantillas")
  async plantillasListar(@CurrentActor() actor: Actor) {
    return envelopeOk(await this.plantillas.listar(actor));
  }

  @Put("mensajeria/propositos")
  @RequierePermiso("mensajeria.enviar")
  async mapear(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.plantillas.mapear(body, actor));
  }

  @Post("mensajeria/plantillas/sync")
  @RequierePermiso("mensajeria.conectar")
  async sync(@CurrentActor() actor: Actor) {
    await this.conexion.syncPlantillas(actor);
    return envelopeOk(await this.plantillas.listar(actor));
  }

  @Post("cartera/clientes/:id/recordatorio")
  @RequierePermiso("mensajeria.enviar")
  async recordar(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.conversaciones.encolarRecordatorio(id, actor));
  }
}
