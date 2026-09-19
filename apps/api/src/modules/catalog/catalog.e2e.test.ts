import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
  auditLog,
  cliente,
  clienteProducto,
  organizacion,
  producto,
  usuario,
} from "@misupertostada/db";
import { permisosEfectivos, permisosPlantilla } from "@misupertostada/shared";
import { AuditWriter } from "../shared/audit.writer";
import { DomainException } from "../shared/domain.exception";
import {
  crearOrgDePrueba,
  openTestDb,
  postgresListo,
} from "../../test/db";
import type { Actor } from "../identity/actor";
import { ProductosService } from "./productos.service";
import { ClientesService } from "./clientes.service";
import { ClienteProductoService } from "./cliente-producto.service";
import { ClienteBonoService } from "./cliente-bono.service";
import { ImportService } from "./import.service";
import { ProductosImportHandler } from "./productos-import.handler";
import { ClientesImportHandler } from "./clientes-import.handler";
import { ClienteProductoImportHandler } from "./cliente-producto-import.handler";
import { PedidoEvents } from "../shared/panel-events";

const listo = await postgresListo();

async function fixture() {
  const { client, db } = openTestDb();
  const audit = new AuditWriter(db);
  const events = new PedidoEvents();
  const productos = new ProductosService(db, audit, events);
  const clientes = new ClientesService(db, audit);
  const clienteProductoSvc = new ClienteProductoService(db, audit, clientes, events);
  const clienteBonoSvc = new ClienteBonoService(db, audit, clientes, events);
  const importHandlers = [
    new ProductosImportHandler(db, productos),
    new ClientesImportHandler(db, clientes),
    new ClienteProductoImportHandler(db, clienteProductoSvc),
  ];
  const importSvc = new ImportService(audit, importHandlers);

  const org = await crearOrgDePrueba(db, "org-");

  const username = `jefe-${crypto.randomUUID().slice(0, 8)}`;
  const [jefe] = await db
    .insert(usuario)
    .values({
      organizacionId: org!.id,
      username,
      rol: "ADMIN_JEFE",
      activo: true,
    })
    .returning({ id: usuario.id });

  const actor: Actor = {
    usuarioId: jefe!.id,
    organizacionId: org!.id,
    username,
    rol: "ADMIN_JEFE",
    permisos: permisosEfectivos("ADMIN_JEFE"),
    sesionId: crypto.randomUUID(),
    ip: "127.0.0.1",
    userAgent: "test",
  };

  const actorSinPrecio: Actor = {
    ...actor,
    rol: "ADMIN",
    permisos: permisosPlantilla("ADMIN"),
  };

  return {
    client,
    db,
    productos,
    clientes,
    clienteProductoSvc,
    clienteBonoSvc,
    importSvc,
    actor,
    actorSinPrecio,
    orgId: org!.id,
  };
}

describe.skipIf(!listo)("catálogo E1", () => {
  test("recorrido: producto, cliente, precio 1250, CSV parcial, desactivar, token", async () => {
    const f = await fixture();
    try {
      const sku = `TORT-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const creado = await f.productos.crear(
        {
          sku,
          nombreCanonico: "Tortilla de prueba E1",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
        },
        f.actor,
      );
      expect(creado.sku).toBe(sku);
      expect(creado.activo).toBe(true);

      await expect(
        f.productos.crear(
          {
            sku,
            nombreCanonico: "Duplicado",
            familia: "TORTILLA",
            unidadMedida: "LIBRA",
            puntoCarga: "DEMOCRACIA",
          },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "SKU_EN_USO" });

      const nombreCliente = `Prueba E1 ${crypto.randomUUID().slice(0, 8)}`;
      const cli = await f.clientes.crear(
        { nombre: nombreCliente, horarioEntregaFijo: "09:00" },
        f.actor,
      );
      expect(cli.horarioEntregaFijo).toBe("09:00");
      expect(cli.tieneTokenPortal).toBe(false);

      await f.clienteProductoSvc.upsert(
        cli.id,
        creado.id,
        { precioCentavos: 1250, notaProduccion: "GRUESA", alias: "grande" },
        f.actor,
      );

      const filas = await f.clienteProductoSvc.listar(cli.id, f.actor);
      const ligada = filas.find((r) => r.productoId === creado.id);
      expect(ligada?.precioCentavos).toBe(1250);
      expect(ligada?.precioBaseCentavos).toBeNull();
      expect(ligada?.alias).toBe("grande");
      expect(ligada?.ligado).toBe(true);

      await expect(
        f.clienteProductoSvc.upsert(
          cli.id,
          creado.id,
          { precioCentavos: 1500 },
          f.actorSinPrecio,
        ),
      ).rejects.toMatchObject({ code: "PERMISO_DENEGADO" });

      const soloAlias = await f.clienteProductoSvc.upsert(
        cli.id,
        creado.id,
        { alias: "tortilla grande" },
        f.actorSinPrecio,
      );
      expect(soloAlias.precioCentavos).toBe(1250);
      expect(soloAlias.alias).toBe("tortilla grande");

      const skuBueno = `NACH-${crypto.randomUUID().slice(0, 6).toUpperCase()}`;
      const csv = [
        "sku,nombre_canonico,familia,unidad_medida,punto_carga,es_producido,orden",
        `${skuBueno},Nachos de prueba,FRITURA,BOLSA,PLANTA,true,1`,
        `MALO,Producto roto,SNACKS,BOLSA,PLANTA,true,2`,
      ].join("\n");

      const preview = await f.importSvc.preview({ tipo: "productos", csv }, f.actor);
      expect(preview.validas).toBe(1);
      expect(preview.invalidas).toBe(1);
      const existentesPreview = await f.db
        .select()
        .from(producto)
        .where(
          and(eq(producto.organizacionId, f.orgId), eq(producto.sku, skuBueno)),
        );
      expect(existentesPreview).toHaveLength(0);

      const confirmado = await f.importSvc.confirmar(
        { tipo: "productos", csv },
        f.actor,
      );
      expect(confirmado.aplicadas).toBe(1);
      expect(confirmado.invalidas).toBe(1);
      const insertados = await f.db
        .select()
        .from(producto)
        .where(
          and(eq(producto.organizacionId, f.orgId), eq(producto.sku, skuBueno)),
        );
      expect(insertados).toHaveLength(1);

      const countAntes = (
        await f.db
          .select()
          .from(producto)
          .where(eq(producto.organizacionId, f.orgId))
      ).length;
      await f.productos.desactivar(creado.id, f.actor);
      const todos = await f.db
        .select()
        .from(producto)
        .where(eq(producto.organizacionId, f.orgId));
      expect(todos).toHaveLength(countAntes);
      expect(todos.find((p) => p.id === creado.id)?.activo).toBe(false);

      const auditsPrecio = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entidadId, `${cli.id}:${creado.id}`));
      const cambioPrecio = auditsPrecio.find(
        (a) => a.accion === "cliente_producto.precio",
      );
      expect(cambioPrecio?.antes).toEqual({ precioCentavos: null });
      expect(cambioPrecio?.despues).toEqual({ precioCentavos: 1250 });

      const { token } = await f.clientes.rotarTokenPortal(cli.id, f.actor);
      expect(token.length).toBeGreaterThan(20);
      const [cliRow] = await f.db
        .select()
        .from(cliente)
        .where(eq(cliente.id, cli.id));
      expect(cliRow?.tokenPortalHash).toBeTruthy();
      expect(cliRow?.tokenPortalHash).not.toBe(token);

      const auditsToken = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entidadId, cli.id));
      const rotacion = auditsToken.find((a) => a.accion === "clientes.rotar_token");
      expect(rotacion).toBeTruthy();
      expect(JSON.stringify(rotacion)).not.toContain(token);

      const { token: segundo } = await f.clientes.rotarTokenPortal(
        cli.id,
        f.actor,
      );
      expect(segundo).not.toBe(token);
      const [cliRow2] = await f.db
        .select()
        .from(cliente)
        .where(eq(cliente.id, cli.id));
      expect(cliRow2?.tokenPortalHash).not.toBe(cliRow?.tokenPortalHash);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("reordenar dentro de la familia no mezcla TORTILLA con FRITURA", async () => {
    const f = await fixture();
    try {
      const a = await f.productos.crear(
        {
          sku: `A-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "A",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
          orden: 1,
        },
        f.actor,
      );
      const b = await f.productos.crear(
        {
          sku: `B-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "B",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "DEMOCRACIA",
          orden: 2,
        },
        f.actor,
      );
      const fritura = await f.productos.crear(
        {
          sku: `F-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "F",
          familia: "FRITURA",
          unidadMedida: "BOLSA",
          puntoCarga: "PLANTA",
          orden: 1,
        },
        f.actor,
      );

      await f.productos.reordenar(
        { familia: "TORTILLA", ids: [b.id, a.id] },
        f.actor,
      );
      const lista = await f.productos.listar(f.actor);
      const tortillas = lista.filter((p) => p.familia === "TORTILLA");
      expect(tortillas.map((p) => p.id)).toEqual([b.id, a.id]);
      expect(lista.find((p) => p.id === fritura.id)?.orden).toBe(1);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("import de cliente_producto hace upsert de precio desde texto 12.50", async () => {
    const f = await fixture();
    try {
      const prod = await f.productos.crear(
        {
          sku: `P-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Papalinas test",
          familia: "FRITURA",
          unidadMedida: "BOLSA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Cliente CSV ${crypto.randomUUID().slice(0, 6)}` },
        f.actor,
      );
      const csv = [
        "cliente_nombre,producto_sku,alias,precio,nota_produccion,favorito,orden",
        `${cli.nombre},${prod.sku},papas,12.50,saladas,true,1`,
      ].join("\n");
      const reporte = await f.importSvc.confirmar(
        { tipo: "cliente_producto", csv },
        f.actor,
      );
      expect(reporte.aplicadas).toBe(1);
      const [row] = await f.db
        .select()
        .from(clienteProducto)
        .where(
          and(
            eq(clienteProducto.clienteId, cli.id),
            eq(clienteProducto.productoId, prod.id),
          ),
        );
      expect(row?.precioCentavos).toBe(1250);
      expect(row?.alias).toBe("papas");
      expect(row?.favorito).toBe(true);
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });

  test("bono: otorgar, listar saldo, anular con audit y rechazar producto inactivo", async () => {
    const f = await fixture();
    try {
      const prod = await f.productos.crear(
        {
          sku: `BONO-${crypto.randomUUID().slice(0, 6)}`,
          nombreCanonico: "Tortilla bono",
          familia: "TORTILLA",
          unidadMedida: "LIBRA",
          puntoCarga: "PLANTA",
        },
        f.actor,
      );
      const cli = await f.clientes.crear(
        { nombre: `Bono ${crypto.randomUUID().slice(0, 8)}` },
        f.actor,
      );
      const bono = await f.clienteBonoSvc.otorgar(
        cli.id,
        {
          productoId: prod.id,
          descripcion: "tortilla quebradita",
          cantidad: 2,
        },
        f.actor,
      );
      expect(bono.cantidadDisponible).toBe(2);
      expect(bono.cantidadAplicada).toBe(0);

      const lista = await f.clienteBonoSvc.listar(cli.id, f.actor);
      expect(lista.some((b) => b.id === bono.id)).toBe(true);

      const audits = await f.db
        .select()
        .from(auditLog)
        .where(eq(auditLog.entidad, "cliente_bono"));
      expect(audits.some((a) => a.accion === "cliente_bono.otorgar")).toBe(true);

      const anulado = await f.clienteBonoSvc.anular(
        cli.id,
        bono.id,
        { motivo: "registrado por error" },
        f.actor,
      );
      expect(anulado.anuladoAt).not.toBeNull();
      expect(anulado.motivoAnulacion).toBe("registrado por error");

      await f.productos.desactivar(prod.id, f.actor);
      await expect(
        f.clienteBonoSvc.otorgar(
          cli.id,
          {
            productoId: prod.id,
            descripcion: "x",
            cantidad: 1,
          },
          f.actor,
        ),
      ).rejects.toMatchObject({ code: "PRODUCTO_INACTIVO" });
    } finally {
      await f.client.end({ timeout: 1 });
    }
  });
});
