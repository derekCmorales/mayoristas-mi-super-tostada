/**
 * Esquema Drizzle. Nada se borra: usar `activo` o `anulado_at`.
 * Un DELETE de filas de negocio es un error de diseño.
 *
 * audit_log es append-only: el writer solo inserta; no hay servicios de
 * update/delete. Montos siempre `integer` (centavos).
 */
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  time,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
};

export const rolEnum = pgEnum("rol", [
  "ADMIN_JEFE",
  "ADMIN",
  "PRODUCCION",
  "TIENDA",
  "REPARTO",
]);

export const unidadMedidaEnum = pgEnum("unidad_medida", [
  "LIBRA",
  "BOLSA",
  "UNIDAD",
]);

export const puntoCargaEnum = pgEnum("punto_carga", ["PLANTA", "DEMOCRACIA"]);

export const familiaEnum = pgEnum("familia", [
  "TORTILLA",
  "TOSTADA",
  "FRITURA",
]);

export const pedidoEstadoEnum = pgEnum("pedido_estado", [
  "BORRADOR",
  "CONFIRMADO",
  "EN_PRODUCCION",
  "ENTREGADO",
  "ANULADO",
]);

export const pedidoOrigenEnum = pgEnum("pedido_origen", ["PORTAL", "MANUAL"]);

export const pagoMetodoEnum = pgEnum("pago_metodo", [
  "EFECTIVO",
  "TRANSFERENCIA",
  "CHEQUE",
]);

export const abonoEstadoEnum = pgEnum("abono_estado", [
  "PENDIENTE",
  "CONFIRMADO",
  "RECHAZADO",
]);

export const abonoOrigenEnum = pgEnum("abono_origen", [
  "PORTAL",
  "REPARTO",
  "MANUAL",
]);

export const outboxEstadoEnum = pgEnum("outbox_estado", [
  "PENDIENTE",
  "ENVIADO",
  "ERROR",
]);

export const mensajeDireccionEnum = pgEnum("mensaje_direccion", [
  "INBOUND",
  "OUTBOUND",
]);

export const organizacion = pgTable("organizacion", {
  id: uuid("id").primaryKey().defaultRandom(),
  nombre: text("nombre").notNull(),
  /**
   * Tope para no reabrir al adelantar el horario. Null = el reloj manda.
   */
  ventanaNoAbrirHasta: timestamp("ventana_no_abrir_hasta", {
    withTimezone: true,
    mode: "date",
  }),
  activo: boolean("activo").notNull().default(true),
  ...timestamps,
});

export const usuario = pgTable(
  "usuario",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    email: text("email"),
    username: text("username").notNull(),
    passwordHash: text("password_hash"),
    rol: rolEnum("rol").notNull(),
    activo: boolean("activo").notNull().default(true),
    ...timestamps,
  },
  (t) => [unique("usuario_username_unique").on(t.username)],
);

export const sesion = pgTable(
  "sesion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true, mode: "date" }).notNull(),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [unique("sesion_token_hash_unique").on(t.tokenHash)],
);

export const permiso = pgTable(
  "permiso",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    codigo: text("codigo").notNull(),
    descripcion: text("descripcion").notNull(),
  },
  (t) => [unique("permiso_codigo_unique").on(t.codigo)],
);

export const usuarioPermiso = pgTable(
  "usuario_permiso",
  {
    usuarioId: uuid("usuario_id")
      .notNull()
      .references(() => usuario.id),
    permisoId: uuid("permiso_id")
      .notNull()
      .references(() => permiso.id),
    grantedBy: uuid("granted_by").references(() => usuario.id),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [unique("usuario_permiso_pk").on(t.usuarioId, t.permisoId)],
);

export const cliente = pgTable(
  "cliente",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    nombre: text("nombre").notNull(),
    contacto: text("contacto"),
    telefonoWa: text("telefono_wa"),
    horarioEntregaFijo: time("horario_entrega_fijo"),
    notasPermanentes: text("notas_permanentes"),
    limiteFacturasPendientes: integer("limite_facturas_pendientes"),
    fotoAssetId: uuid("foto_asset_id"),
    tokenPortalHash: text("token_portal_hash"),
    tokenPortalCifrado: text("token_portal_cifrado"),
    activo: boolean("activo").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    unique("cliente_org_nombre_unique").on(t.organizacionId, t.nombre),
    unique("cliente_token_portal_hash_unique").on(t.tokenPortalHash),
  ],
);

export const producto = pgTable(
  "producto",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    sku: text("sku").notNull(),
    nombreCanonico: text("nombre_canonico").notNull(),
    familia: familiaEnum("familia").notNull(),
    unidadMedida: unidadMedidaEnum("unidad_medida").notNull(),
    puntoCarga: puntoCargaEnum("punto_carga").notNull(),
    esProducido: boolean("es_producido").notNull().default(true),
    fotoAssetId: uuid("foto_asset_id"),
    /** Precio de lista. Los clientes sin override en cliente_producto lo heredan. */
    precioBaseCentavos: integer("precio_base_centavos"),
    orden: integer("orden").notNull().default(0),
    activo: boolean("activo").notNull().default(true),
    ...timestamps,
  },
  (t) => [unique("producto_org_sku_unique").on(t.organizacionId, t.sku)],
);

export const clienteProducto = pgTable(
  "cliente_producto",
  {
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => cliente.id),
    productoId: uuid("producto_id")
      .notNull()
      .references(() => producto.id),
    alias: text("alias"),
    /** Snapshot vivo del catálogo del cliente. Nulo hasta que Cristian cargue precios. */
    precioCentavos: integer("precio_centavos"),
    notaProduccion: text("nota_produccion"),
    favorito: boolean("favorito").notNull().default(false),
    orden: integer("orden").notNull().default(0),
  },
  (t) => [
    unique("cliente_producto_pk").on(t.clienteId, t.productoId),
  ],
);

/** Crédito de reposición por producto dañado. Nada se borra: anular con motivo. */
export const clienteBono = pgTable(
  "cliente_bono",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => cliente.id),
    productoId: uuid("producto_id")
      .notNull()
      .references(() => producto.id),
    descripcion: text("descripcion").notNull(),
    cantidadOtorgada: integer("cantidad_otorgada").notNull(),
    cantidadAplicada: integer("cantidad_aplicada").notNull().default(0),
    otorgadoPor: uuid("otorgado_por")
      .notNull()
      .references(() => usuario.id),
    anuladoAt: timestamp("anulado_at", { withTimezone: true, mode: "date" }),
    motivoAnulacion: text("motivo_anulacion"),
    ...timestamps,
  },
  (t) => [
    index("cliente_bono_cliente_idx").on(t.clienteId),
  ],
);

export const pedido = pgTable(
  "pedido",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    correlativo: integer("correlativo").notNull(),
    fechaOperacion: date("fecha_operacion", { mode: "string" }).notNull(),
    /** Día de reparto. Congelado al capturar: no se recalcula si cambia la ventana. */
    fechaEntrega: date("fecha_entrega", { mode: "string" }).notNull(),
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => cliente.id),
    estado: pedidoEstadoEnum("estado").notNull().default("BORRADOR"),
    origen: pedidoOrigenEnum("origen").notNull(),
    notasAdmin: text("notas_admin"),
    capturadoPor: uuid("capturado_por").references(() => usuario.id),
    anuladoAt: timestamp("anulado_at", { withTimezone: true, mode: "date" }),
    motivoAnulacion: text("motivo_anulacion"),
    entregaIdempotencyKey: text("entrega_idempotency_key"),
    ...timestamps,
  },
  (t) => [
    unique("pedido_org_correlativo_unique").on(t.organizacionId, t.correlativo),
    index("pedido_fecha_operacion_idx").on(t.fechaOperacion),
    index("pedido_fecha_entrega_idx").on(t.fechaEntrega),
    uniqueIndex("pedido_entrega_idempotency_key_unique")
      .on(t.entregaIdempotencyKey)
      .where(sql`${t.entregaIdempotencyKey} is not null`),
  ],
);

export const pedidoItem = pgTable("pedido_item", {
  id: uuid("id").primaryKey().defaultRandom(),
  pedidoId: uuid("pedido_id")
    .notNull()
    .references(() => pedido.id),
  productoId: uuid("producto_id")
    .notNull()
    .references(() => producto.id),
  cantidadPedida: integer("cantidad_pedida").notNull(),
  cantidadEntregada: integer("cantidad_entregada").notNull(),
  precioUnitarioCentavos: integer("precio_unitario_centavos").notNull(),
  nombreMostrado: text("nombre_mostrado").notNull(),
  unidadMedida: unidadMedidaEnum("unidad_medida").notNull(),
  esDevolucion: boolean("es_devolucion").notNull().default(false),
  bonoId: uuid("bono_id").references(() => clienteBono.id),
});

export const factura = pgTable(
  "factura",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    pedidoId: uuid("pedido_id")
      .notNull()
      .references(() => pedido.id),
    numeroDte: text("numero_dte"),
    montoCentavos: integer("monto_centavos").notNull(),
    emitidaAt: timestamp("emitida_at", { withTimezone: true, mode: "date" }),
    ...timestamps,
  },
  (t) => [
    unique("factura_pedido_unique").on(t.pedidoId),
    uniqueIndex("factura_numero_dte_unique")
      .on(t.numeroDte)
      .where(sql`${t.numeroDte} is not null`),
  ],
);

export const abono = pgTable(
  "abono",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => cliente.id),
    montoCentavos: integer("monto_centavos").notNull(),
    metodo: pagoMetodoEnum("metodo").notNull(),
    estado: abonoEstadoEnum("estado").notNull(),
    descripcion: text("descripcion"),
    comprobanteAssetId: uuid("comprobante_asset_id"),
    origen: abonoOrigenEnum("origen").notNull(),
    registradoPor: uuid("registrado_por").references(() => usuario.id),
    confirmadoPor: uuid("confirmado_por").references(() => usuario.id),
    confirmadoAt: timestamp("confirmado_at", {
      withTimezone: true,
      mode: "date",
    }),
    anuladoAt: timestamp("anulado_at", { withTimezone: true, mode: "date" }),
    motivoRechazo: text("motivo_rechazo"),
    fecha: date("fecha", { mode: "string" }).notNull(),
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("abono_idempotency_key_unique")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const pago = pgTable(
  "pago",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    abonoId: uuid("abono_id")
      .notNull()
      .references(() => abono.id),
    facturaId: uuid("factura_id")
      .notNull()
      .references(() => factura.id),
    montoCentavos: integer("monto_centavos").notNull(),
    metodo: pagoMetodoEnum("metodo").notNull(),
    fecha: date("fecha", { mode: "string" }).notNull(),
    comprobanteAssetId: uuid("comprobante_asset_id"),
    registradoPor: uuid("registrado_por").references(() => usuario.id),
    idempotencyKey: text("idempotency_key"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("pago_idempotency_key_unique")
      .on(t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const conversacion = pgTable(
  "conversacion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clienteId: uuid("cliente_id")
      .notNull()
      .references(() => cliente.id),
    ventanaExpiraAt: timestamp("ventana_expira_at", {
      withTimezone: true,
      mode: "date",
    }),
    ultimoInboundAt: timestamp("ultimo_inbound_at", {
      withTimezone: true,
      mode: "date",
    }),
    noLeidos: integer("no_leidos").notNull().default(0),
    ...timestamps,
  },
  (t) => [unique("conversacion_cliente_id_unique").on(t.clienteId)],
);

export const mensaje = pgTable(
  "mensaje",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversacionId: uuid("conversacion_id")
      .notNull()
      .references(() => conversacion.id),
    waMessageId: text("wa_message_id"),
    direction: mensajeDireccionEnum("direction").notNull(),
    tipo: text("tipo").notNull(),
    templateName: text("template_name"),
    params: jsonb("params"),
    bodyRenderizado: text("body_renderizado"),
    status: text("status"),
    errorCode: text("error_code"),
    enviadoPor: uuid("enviado_por").references(() => usuario.id),
    ...timestamps,
  },
  (t) => [unique("mensaje_wa_message_id_unique").on(t.waMessageId)],
);

export const plantillaWa = pgTable(
  "plantilla_wa",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    name: text("name").notNull(),
    category: text("category").notNull(),
    language: text("language").notNull(),
    status: text("status").notNull(),
    componentes: jsonb("componentes"),
    metaTemplateId: text("meta_template_id"),
    motivoRechazo: text("motivo_rechazo"),
    calidad: text("calidad"),
    sincronizadoAt: timestamp("sincronizado_at", {
      withTimezone: true,
      mode: "date",
    }),
  },
  (t) => [
    unique("plantilla_wa_org_name_lang_unique").on(
      t.organizacionId,
      t.name,
      t.language,
    ),
  ],
);

export const conexionWaba = pgTable(
  "conexion_waba",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    wabaId: text("waba_id"),
    phoneNumberId: text("phone_number_id"),
    accessTokenCifrado: text("access_token_cifrado"),
    waProduccion: text("wa_produccion"),
    waTienda: text("wa_tienda"),
    estado: text("estado").notNull().default("DESARROLLO"),
    ...timestamps,
  },
  (t) => [unique("conexion_waba_org_unique").on(t.organizacionId)],
);

export const plantillaProposito = pgTable(
  "plantilla_proposito",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    proposito: text("proposito").notNull(),
    plantillaWaId: uuid("plantilla_wa_id")
      .notNull()
      .references(() => plantillaWa.id),
    ...timestamps,
  },
  (t) => [
    unique("plantilla_proposito_org_proposito_unique").on(
      t.organizacionId,
      t.proposito,
    ),
  ],
);

export const asset = pgTable(
  "asset",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: text("key").notNull(),
    bucket: text("bucket").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    ownerType: text("owner_type").notNull(),
    ownerId: uuid("owner_id").notNull(),
    variantes: jsonb("variantes"),
    subidoPor: uuid("subido_por").references(() => usuario.id),
    ...timestamps,
  },
  (t) => [unique("asset_key_unique").on(t.key)],
);

export const diaNoLaborable = pgTable(
  "dia_no_laborable",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    fecha: date("fecha", { mode: "string" }).notNull(),
    motivo: text("motivo").notNull(),
    editable: boolean("editable").notNull().default(true),
  },
  (t) => [
    unique("dia_no_laborable_org_fecha_unique").on(t.organizacionId, t.fecha),
  ],
);

/** Append-only. No UPDATE, no DELETE. Lo consultan las personas. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    actorTipo: text("actor_tipo").notNull(),
    actorId: text("actor_id").notNull(),
    accion: text("accion").notNull(),
    entidad: text("entidad").notNull(),
    entidadId: text("entidad_id").notNull(),
    antes: jsonb("antes"),
    despues: jsonb("despues"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("audit_log_entidad_idx").on(t.entidad, t.entidadId), index("audit_log_created_at_idx").on(t.createdAt)],
);

/**
 * Única fuente de horario del negocio. No hay fallback: si una organización no
 * tiene sus 7 filas, la semana está apagada. Siémbrala con
 * `sembrarVentanaSemanal`.
 */
export const ventanaSemanal = pgTable(
  "ventana_semanal",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    weekday: integer("weekday").notNull(),
    activa: boolean("activa").notNull().default(true),
    apertura: time("apertura").notNull().default("15:00"),
    cierre: time("cierre").notNull().default("03:00"),
    cruzaMedianoche: boolean("cruza_medianoche").notNull().default(true),
  },
  (t) => [
    unique("ventana_semanal_org_weekday_unique").on(t.organizacionId, t.weekday),
  ],
);

/** Hechos de negocio. Distinto de audit_log. */
export const domainEvents = pgTable("domain_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  tipo: text("tipo").notNull(),
  payload: jsonb("payload").notNull(),
  ocurridoAt: timestamp("ocurrido_at", { withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow(),
  procesadoAt: timestamp("procesado_at", { withTimezone: true, mode: "date" }),
});

export const outbox = pgTable(
  "outbox",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tipo: text("tipo").notNull(),
    destinatarioId: uuid("destinatario_id").notNull(),
    fechaOperacion: date("fecha_operacion", { mode: "string" }).notNull(),
    payload: jsonb("payload").notNull(),
    estado: outboxEstadoEnum("estado").notNull().default("PENDIENTE"),
    intentos: integer("intentos").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("outbox_idempotencia_unique").on(
      t.tipo,
      t.destinatarioId,
      t.fechaOperacion,
    ),
  ],
);

export const diaOperacionEstadoEnum = pgEnum("dia_operacion_estado", [
  "ABIERTO",
  "CERRADO",
  "REABIERTO",
]);

export const diaOperacion = pgTable(
  "dia_operacion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    fechaOperacion: date("fecha_operacion", { mode: "string" }).notNull(),
    estado: diaOperacionEstadoEnum("estado").notNull(),
    motivoReapertura: text("motivo_reapertura"),
    cerradoAt: timestamp("cerrado_at", { withTimezone: true, mode: "date" }),
    cerradoPor: uuid("cerrado_por").references(() => usuario.id),
    reabiertoAt: timestamp("reabierto_at", { withTimezone: true, mode: "date" }),
    reabiertoPor: uuid("reabierto_por").references(() => usuario.id),
    ...timestamps,
  },
  (t) => [
    unique("dia_operacion_org_fecha_unique").on(
      t.organizacionId,
      t.fechaOperacion,
    ),
  ],
);

export const hojaProduccion = pgTable(
  "hoja_produccion",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizacionId: uuid("organizacion_id")
      .notNull()
      .references(() => organizacion.id),
    fechaOperacion: date("fecha_operacion", { mode: "string" }).notNull(),
    version: integer("version").notNull(),
    snapshot: jsonb("snapshot").notNull(),
    texto: text("texto").notNull(),
    generadoAt: timestamp("generado_at", { withTimezone: true, mode: "date" })
      .notNull()
      .defaultNow(),
    generadoPor: uuid("generado_por").references(() => usuario.id),
    ...timestamps,
  },
  (t) => [
    unique("hoja_produccion_org_fecha_version_unique").on(
      t.organizacionId,
      t.fechaOperacion,
      t.version,
    ),
  ],
);
