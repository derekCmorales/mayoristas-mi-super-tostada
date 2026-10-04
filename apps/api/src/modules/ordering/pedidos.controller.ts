import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Sse,
} from "@nestjs/common";
import { envelopeOk } from "@misupertostada/shared";
import type { Observable } from "rxjs";
import { RequierePermiso } from "../identity/permisos.guard";
import { CurrentActor } from "../identity/current-actor";
import type { Actor } from "../identity/actor";
import { PedidoEvents } from "./pedido-events";
import { PedidoService } from "./pedido.service";
import { PedidoPreciosService } from "./pedido-precios.service";
import { DomainException } from "../shared/domain.exception";

@Controller("pedidos")
export class PedidosController {
  constructor(
    private readonly pedidos: PedidoService,
    private readonly precios: PedidoPreciosService,
    private readonly events: PedidoEvents,
  ) {}

  @Sse("stream")
  @Header("Cache-Control", "no-cache, no-transform")
  @Header("X-Accel-Buffering", "no")
  @Header("Connection", "keep-alive")
  stream(@CurrentActor() actor: Actor | undefined): Observable<{ data: unknown }> {
    if (!actor) {
      throw new DomainException("SESION_REQUERIDA", "Inicie sesión", 401);
    }
    return this.events.stream(actor.organizacionId);
  }

  @Get()
  async listar(
    @Query() query: Record<string, string | undefined>,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.pedidos.listar(actor, query));
  }

  @Post()
  @RequierePermiso("pedidos.capturar_manual")
  async crear(@Body() body: unknown, @CurrentActor() actor: Actor) {
    return envelopeOk(await this.pedidos.crearManual(body, actor));
  }

  /** Vista previa (`aplicar: false`) o recálculo con el catálogo vigente. */
  @Post("recalcular-precios")
  @RequierePermiso("precios.cambiar")
  async recalcularPrecios(
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.precios.recalcular(body, actor));
  }

  @Get(":id")
  async obtener(
    @Param("id", ParseUUIDPipe) id: string,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.pedidos.obtener(id, actor));
  }

  @Patch(":id/notas")
  @RequierePermiso("pedidos.capturar_manual")
  async notas(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.pedidos.editarNotas(id, body, actor));
  }

  @Patch(":id/items")
  @RequierePermiso("pedidos.capturar_manual")
  async items(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.pedidos.editarItems(id, body, actor));
  }

  @Post(":id/precios")
  @RequierePermiso("precios.cambiar")
  async ajustarPrecios(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.precios.ajustar(id, body, actor));
  }

  @Post(":id/anular")
  @RequierePermiso("pedidos.capturar_manual")
  async anular(
    @Param("id", ParseUUIDPipe) id: string,
    @Body() body: unknown,
    @CurrentActor() actor: Actor,
  ) {
    return envelopeOk(await this.pedidos.anular(id, body, actor));
  }
}
