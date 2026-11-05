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

@Controller()
export class ConversacionesController {
  constructor(
    private readonly conversaciones: ConversacionService,
    private readonly plantillas: PlantillaService,
    private readonly conexion: ConexionWabaService,
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

  /** Chat de WhatsApp visto desde la ficha del cliente; `null` si nunca hubo mensajes. */
  @Get("clientes/:clienteId/conversacion")
  async porCliente(
    @Param("clienteId", ParseUUIDPipe) clienteId: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(
      await this.conversaciones.obtenerPorCliente(clienteId, actor),
    );
  }

  @Post("clientes/:clienteId/conversacion")
  @RequierePermiso("mensajeria.enviar")
  async abrirPorCliente(
    @Param("clienteId", ParseUUIDPipe) clienteId: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(
      await this.conversaciones.abrirPorCliente(clienteId, actor),
    );
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
