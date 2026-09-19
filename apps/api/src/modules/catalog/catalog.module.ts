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
import { IMPORT_HANDLERS } from "./import-tokens";
import { ProductosImportHandler } from "./productos-import.handler";
import { ClientesImportHandler } from "./clientes-import.handler";
import { ClienteProductoImportHandler } from "./cliente-producto-import.handler";
import { CatalogoPortalService } from "./catalogo-portal.service";
import { CATALOGO_PORTAL } from "./catalogo-portal";

@Module({
  controllers: [ProductosController, ClientesController, ImportController],
  providers: [
    ProductosService,
    ClientesService,
    { provide: CLIENTE_PROPIETARIO, useExisting: ClientesService },
    { provide: CLIENTE_CREADOR, useExisting: ClientesService },
    ClienteProductoService,
    ClienteBonoService,
    ProductosImportHandler,
    ClientesImportHandler,
    ClienteProductoImportHandler,
    {
      provide: IMPORT_HANDLERS,
      useFactory: (
        productos: ProductosImportHandler,
        clientes: ClientesImportHandler,
        clienteProducto: ClienteProductoImportHandler,
      ) => [productos, clientes, clienteProducto],
      inject: [
        ProductosImportHandler,
        ClientesImportHandler,
        ClienteProductoImportHandler,
      ],
    },
    ImportService,
    CatalogoPortalService,
    { provide: CATALOGO_PORTAL, useExisting: CatalogoPortalService },
  ],
  exports: [ClienteBonoService, CATALOGO_PORTAL],
})
export class CatalogModule {}
