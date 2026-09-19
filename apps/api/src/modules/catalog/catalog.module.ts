import { Module } from "@nestjs/common";
import { ProductosService } from "./productos.service";
import { ProductosController } from "./productos.controller";
import { ClientesService } from "./clientes.service";
import { ClientesController } from "./clientes.controller";
import { ClienteProductoService } from "./cliente-producto.service";
import { ClienteBonoService } from "./cliente-bono.service";
import { ImportService } from "./import.service";
import { ImportController } from "./import.controller";
import { CLIENTE_CREADOR, CLIENTE_PROPIETARIO } from "./cliente-ports";

@Module({
  controllers: [ProductosController, ClientesController, ImportController],
  providers: [
    ProductosService,
    ClientesService,
    { provide: CLIENTE_PROPIETARIO, useExisting: ClientesService },
    { provide: CLIENTE_CREADOR, useExisting: ClientesService },
    ClienteProductoService,
    ClienteBonoService,
    ImportService,
  ],
  exports: [ClienteBonoService],
})
export class CatalogModule {}
