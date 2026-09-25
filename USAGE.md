# USAGE.md — Cómo usar Mi Súper Tostada

Guía práctica de lo que **ya está implementado** en este repositorio: qué hace cada módulo, la lógica de negocio detrás, y cómo probarlo (manual y automatizado).

| Documento | Para qué sirve |
|---|---|
| **`CONTEXT.md`** | Qué se construye, backlog, glosario, actores |
| **`AGENTS.md`** | Reglas técnicas duras (centavos, calendario, idempotencia, etc.) |
| **`USAGE.md`** (este archivo) | Arranque, pantallas, flujos y pruebas |
| **`DEPLOY.md`** | Producción: Openship (Mac) → VPS. El local no usa ese flujo |
| **`README.md`** | Instalación mínima y scripts |

---

## 1. Arranque local

### Requisitos

- [Bun](https://bun.sh) 1.3+
- Postgres nativo en marcha (Homebrew / Postgres.app). El loop diario **no usa Docker**.
- Node.js LTS solo para producción (`node dist/main.js`).

### Primera vez

```bash
cp .env.example .env
bun install
bun run db:setup      # create + migrate + seed  → base de desarrollo
bun run db:test:setup # create + migrate         → base de test (<base>_test)
bun test              # suite completa
bun run dev:all       # web :3000 + api :3001 + tests en watch
```

`db:test:setup` no es opcional: los tests corren contra `<DATABASE_URL>_test`, nunca contra la base
de desarrollo (`dev-all` deja `bun test --watch` corriendo, y los e2e dejan una organización por
test). Si esa base no existe, los e2e se saltan y la suite avisa por consola en vez de verse verde.
Para limpiar una base ya contaminada por corridas viejas: `bun run db:purge:test-data --dry` cuenta,
sin `--dry` borra.

O por separado:

```bash
bun run dev         # solo Next.js → http://localhost:3000
bun run dev:api     # solo NestJS → http://localhost:3001
```

Salud de la API: `GET http://localhost:3001/health` (reporta `db: ok|down`).

---

## 2. Credenciales y datos de prueba

### Usuarios internos (solo desarrollo)

El seed crea cuatro cuentas con la misma contraseña (`SEED_ADMIN_PASSWORD` en `.env`, default **`dev-local-only`**):

| Usuario | Rol | Uso típico |
|---|---|---|
| `cristian` | ADMIN_JEFE | Cierra ventana, reapertura, permisos, tablero completo |
| `alex` | PRODUCCION | Ve hoja de producción (solo lectura operativa) |
| `carla` | TIENDA | Captura DTE, pedidos manuales, cobros |
| `tony` | REPARTO | Ruta, entregas, cobros en calle (offline) |

Login: http://localhost:3000/login → cookie `httpOnly` de sesión.

### Portal del cliente (desarrollo)

Tras `db:seed`, la consola imprime la URL del portal de **Tabasco Casa Vieja**:

```
http://localhost:3000/p/dev-tabasco-casa-vieja-portal-token
```

Ese cliente tiene en seed:

- Alias comerciales (`tortilla grande`, `tortilla mediana`, etc.)
- Precios de **demo** (no reales): Q 12.50 / Q 11.00 / Q 10.00 por libra de tortilla
- Nota de producción **GRUESA** en tortillas
- Nachos blancos con precio de demo

Para otro cliente: panel **Clientes** → detalle → **Rotar token de portal** (solo ADMIN_JEFE). La URL nueva se muestra una sola vez.

### Catálogo seed

12 productos y 13 clientes según `CONTEXT.md` §5 (Tabasco Casa Vieja, Kraken con fajitas, Metroplaza con entrega 09:00, etc.). Los precios reales **no** vienen en seed salvo el demo de Tabasco Casa Vieja; Cristian los carga en **Clientes → productos del cliente**.

### Mega-seed (historial denso sobre datos existentes)

Llena cartera, ruta, producción, WhatsApp y tablero con ~45 días hábiles de pedidos, facturas y pagos **encima de los clientes y productos que ya están en la base** (no crea clientes ni ligas nuevas). Usa precios de `cliente_producto` cuando existen; si un cliente no tiene ligas, elige productos al azar con precios demo en el snapshot del pedido.

```bash
bun run db:seed:mega        # seed base (opcional) + clear previo + historial
bun run db:seed:mega:clear  # solo borra lo marcado [MEGA_SEED]
```

En producción (contenedor `api`), con el seed base ya aplicado:

```bash
docker exec -it NOMBRE_CONTENEDOR_API sh -c '
  export DATABASE_URL="postgresql://${POSTGRES_USER:-tostada}:${POSTGRES_PASSWORD}@postgres:5432/${POSTGRES_DB:-misupertostada}"
  cd /app && bun packages/db/src/seed-mega.ts --skip-base
'
```

Re-ejecutar es seguro (limpia pedidos/hojas marcados y vuelve a generar).

---

## 3. Mapa de pantallas

### Panel interno (requiere login)

| Ruta | Pantalla | Actor principal |
|---|---|---|
| `/hoy` | Operación del día: ventana, cierre, resumen de ruta | Cristian |
| `/tablero` | Dashboard analítico + PDF quincena | Cristian |
| `/pedidos` | Bandeja, captura manual, detalle, SSE en vivo | Cristian / Carla |
| `/produccion` | Hoja de producción del día | Alex |
| `/reparto` | Ruta de Tony: entregar y cobrar (offline) | Tony |
| `/cartera` | Facturas pendientes, pagos, cuadre | Cristian / Carla |
| `/conversaciones` | Bandeja WhatsApp | Cristian |
| `/catalogo` | Productos (CRUD, familias, fotos) | Cristian |
| `/clientes` | Clientes, alias, precios, import CSV | Cristian |
| `/configuracion` | Hub de tres accesos (usuarios, historial, ventana). Engranaje junto al usuario; solo `ADMIN_JEFE` | Cristian |

### Portal público (sin login)

| Ruta | Pantalla |
|---|---|
| `/p/{token}` | Pedido del cliente + estado de cuenta |

---

## 4. Conceptos transversales (léelos antes de probar)

### Fecha de operación vs. reloj del navegador

- Zona fija: **`America/Guatemala`** (UTC−6, sin horario de verano).
- **Ventana de pedido:** lun–sáb 15:00 → 03:00 de fábrica (el cierre a las 03:00 es del día de calendario siguiente). Domingo inactivo — y cualquier weekday con la ventana apagada tampoco es día de entrega. Configurable por weekday en `/configuracion`. Adelantar la hora **no reabre** un ciclo cuyo inicio ya pasó; eso solo se hace con **Reabrir día** en Hoy. El panel (`/hoy`, badge) lee el mismo `GET /calendario/ahora` que el portal.
- **El horario tiene una sola fuente: la tabla `ventana_semanal`**, que es lo que guarda `/configuracion`. No hay valor de respaldo en ningún lado. Si a la organización le faltan sus 7 filas, no hay ventana: el badge del panel queda «Sin horario configurado» y el portal no acepta pedidos hasta que un `ADMIN_JEFE` lo defina.
- Si el viernes abre 15:00 y cierra el sábado a las 06:00, un pedido a las 02:00 del sábado es **operación del viernes**.
- **Operación ≠ entrega.** `fecha_operacion` es el día en que abrió la ventana (llave interna: hoja, cierre, ruta). `fecha_entrega` es el **siguiente día activo**, y es la fecha que se le muestra al cliente y al personal. Ventana lun 15:00 → mar 03:00 ⇒ operación lunes, entrega martes. Ventana sáb 15:00 → dom 03:00 con domingo inactivo ⇒ operación sábado, entrega **lunes**.
- La entrega se **congela** en el pedido al capturarlo: cambiar la ventana después no reescribe pedidos viejos.
- Toda decisión de calendario pasa por **`BusinessCalendar`** en servidor. El badge de ventana en el panel viene de `GET /calendario/ahora`.

### Los tres ejes de fecha: captura, en curso, día de calendario

Este es el concepto que más se malinterpreta. La ventana cruza la medianoche
(p. ej. lunes 15:00 → martes 03:00), así que **«hoy» significa tres cosas
distintas** y cada pantalla se ancla a la que le toca. Nunca uno sustituye al
otro «porque casi siempre coinciden».

| Eje | Qué es | Campo en `GET /calendario/ahora` | Quién lo usa |
|---|---|---|---|
| **Captura** | La ventana que se puede escribir ahora | `fechaOperacionCaptura` | Portal, pedido manual, cerrar/reabrir día |
| **En curso** | La operación que se reparte y se cobra hoy | `fechaOperacionEnCurso` | `/hoy`, `/produccion`, `/reparto`, cartera |
| **Día de calendario** | El día de calendario en Guatemala | `hoyCivil` | Caja (`pago.fecha`), antigüedad de factura, tablero |

Un martes cualquiera, con ventana 15:00 → 03:00:

```
00:00 ─ 03:00   captura=lun  en curso=lun  calendario=mar   ventana del lunes abierta
03:00 ─ 15:00   captura=mar  en curso=lun  calendario=mar   se reparte lo del lunes
15:00 ─ 24:00   captura=mar  en curso=lun  calendario=mar   entra la noche del martes
```

Reglas que se derivan y que el código garantiza:

- **`en curso` no es «la última ventana que cerró».** Es la operación cuya
  `fecha_entrega` cae hoy (`BusinessCalendar.getOperacionQueEntregaEn`). Por
  eso **no salta a las 15:00** cuando abre la ventana siguiente: el repartidor
  sigue en la calle con la misma carga.
- **La ruta de `/reparto` se consulta por `fecha_entrega`, no por operación.**
  `fecha_entrega` está congelada en el pedido, así que el eje no se mueve
  durante el día.
- **El cobro vive en el eje de día de calendario.** `cartera/resumen` devuelve `fechaCobro`
  junto al monto: al abrir una operación pasada verás lo que se cobró **ese**
  día, no lo de hoy.
- **El tablero recorta por día de calendario**, no por operación, y sus atajos
  (semana / quincena / mes) también.
- **Sin filtro explícito**, las pantallas de operación abren en el eje con
  trabajo activo: **captura** mientras la ventana está abierta, **en curso**
  cuando cerró. Una sola regla, en `EjesOperacion.fechaFoco` (servidor) y
  `fechaDefectoHoy` (web).

En la UI cada pantalla dice a qué eje está anclada, sin que haya que deducirlo
de los datos:

| Dónde | Qué se ve | Eje |
|---|---|---|
| Encabezado del panel | Tres celdas: **Captura · Reparto · Día** (la última desde `md`), con la entrega anotada solo cuando cae en otro día (sábado con carga en planta, feriados) | los tres |
| `/hoy` | Selector **«Reparto de hoy» / «Pedidos de esta noche»** cuando los ejes difieren. **Sin calendario**: es la operación viva, no un informe. Un deep link `?fechaOperacion=` a un día pasado muestra el aviso «No es la operación en curso» + **Volver a hoy** | captura o en curso |
| `/produccion` | Cinta **«Hoja de la operación …· se entrega hoy …»**. Anclada a la operación en curso, nunca al foco | en curso |
| `/reparto` | Cinta **«Ruta de hoy · …»** con la operación de origen. Si el snapshot offline es de otro día, lo dice en vez de presentarlo como el de hoy | día de calendario |
| `/cartera` | «Cobrado hoy» lleva la fecha escrita y la nota **«Día de calle»**; cuadra con el cuadre del día | día de calendario |
| `/pedidos` | Bajo el contador, el rótulo del rango: **Operación en captura / en curso / histórico**, o **«Rango de operaciones»** si abarca varios días | foco (default) |
| `/tablero` | El filtro avisa: **«Días de calendario en Guatemala, no operaciones»** | día de calendario |

- El calendario de `/pedidos` tiene dos atajos: **Hoy** = operación en curso,
  **Esta noche** = operación en captura. «Esta noche» solo aparece cuando
  apunta a otro día.
- El copy de los tres ejes vive en `apps/web/src/lib/ejes-vista.ts`, no repartido
  por pantalla: si cambia la regla, cambia en un sitio.

### Dinero

- Siempre **enteros en centavos** (`1250` = Q 12.50).
- El formateo `Q 12.50` solo ocurre en UI.
- Cada línea de pedido guarda **snapshot** de precio, nombre y unidad al momento de capturar.

### Soft delete

- Nada se borra: productos/clientes se **desactivan**; pedidos se **anulan** con motivo.

### Idempotencia

- Mensajes automáticos → tabla `outbox` con constraint única.
- Acciones offline de reparto → `idempotency_key` de cliente; el servidor deduplica entregas.

### UI: nunca "Cancelado" a secas

- Pedido anulado → **"Anulado"**
- Factura saldada → **"Pagado"** (en Guatemala "cancelado" significa pagado; el sistema evita la ambigüedad)

---

## 5. Módulos implementados

Estado según backlog de `CONTEXT.md`. `[x]` = criterios de aceptación cubiertos en código y tests.

---

### E0 — Fundación

#### Infraestructura (F-001)

**Qué hay:** monorepo Bun, `apps/api` (NestJS), `apps/web` (Next.js), `packages/shared`, `packages/db`, `packages/pdf`. Env validado con Zod al boot.

**Cómo probar:**

```bash
bun run typecheck
bun run lint
curl -s http://localhost:3001/health | jq
```

**Pendiente:** CI en GitHub Actions.

#### Esquema y seed (F-002)

**Lógica:** todas las entidades de dominio en Drizzle; migraciones reversibles en `packages/db/drizzle/`.

**Cómo probar:**

```bash
bun run db:setup
bun test packages/db/src/schema.money.test.ts
bun test packages/db/src/audit.append-only.test.ts
```

#### BusinessCalendar (F-003)

**Lógica de negocio:**

| Función | Comportamiento |
|---|---|
| `isVentanaAbierta` | 15:00–03:00 GT de fábrica; configurable por weekday. Sin filas en `ventana_semanal`, siempre `false` |
| `getFechaOperacion` | Ventana abierta ⇒ el día que abrió; si no, el día de calendario hábil |
| `getFechaOperacionDeVentanaReciente` | La ventana que acaba de cerrar (eje de **cierre**) |
| `getFechaEntrega` | Siguiente día activo después de la operación |
| `getOperacionQueEntregaEn` | Inversa de la anterior: la operación **en curso** un día dado. No mira el reloj, así que no salta a las 15:00 |
| `getSiguienteDiaHabil` | Salta domingos y `dia_no_laborable` |
| `isSabado` | Sábado ⇒ toda la carga sale de **PLANTA** |

`BusinessCalendarService.ejes(orgId)` resuelve los tres ejes de una sola vez
(`captura`, `enCurso`, `hoyCivil`, `fechaFoco`). Cualquier servicio que
necesite «qué día es» debe pedirlo ahí en vez de recalcularlo.

**Cómo probar:**

```bash
bun test packages/shared/src/calendar.test.ts
```

Manual: abre el panel y observa el badge de ventana; fuera de horario el portal informa cuándo abre de nuevo.

#### Auth y roles (F-004)

**Lógica:** cookie `httpOnly` + argon2id; permisos granulares delegables por ADMIN_JEFE.

| Rol | Acciones destacadas |
|---|---|
| ADMIN_JEFE | Todo, incl. reapertura y delegación |
| ADMIN | Catálogo, pedidos, cobranza, cierre de ventana |
| PRODUCCION | Solo lectura operativa |
| TIENDA | DTE, pagos, pedidos manuales |
| REPARTO | Entregar y registrar pagos |

**Cómo probar:**

```bash
bun test packages/shared/src/permisos.test.ts
bun test apps/api/src/modules/identity/auth.service.test.ts
```

Manual: entra con `tony` → en `/reparto` puedes entregar/cobrar; en `/catalogo` no hay acciones de escritura.

#### Auditoría y outbox (F-005)

**Lógica:** `audit_log` append-only (quién hizo qué); `domain_events` + `outbox` para side effects; worker pg-boss con reintentos.

**Cómo probar:**

```bash
bun test apps/api/src/modules/shared/outbox.writer.test.ts
bun test apps/api/src/modules/shared/outbox.processor.test.ts
bun test apps/api/src/modules/shared/pgboss.smoke.test.ts
```

#### Storage R2 (F-006)

**Lógica:** URLs prefirmadas; el browser sube directo a R2 (o `FakeStorageAdapter` en dev). Tabla `Asset` con sha256.

**Cómo probar:**

```bash
bun test apps/api/src/modules/shared/storage/assets.service.test.ts
```

Manual: adjuntar comprobante de pago en `/cartera` o `/reparto` (sin R2 configurado usa fake y guarda metadata).

---

### E1 — Catálogo y clientes

#### Productos (F-101) — `/catalogo`

**Lógica:** SKU, familia, unidad (`LIBRA`/`BOLSA`/`UNIDAD`), punto de carga (`PLANTA`/`DEMOCRACIA`), orden arrastrable, desactivación sin borrado.

**Cómo probar:**

```bash
bun test apps/api/src/modules/catalog/catalog.e2e.test.ts
bun test packages/shared/src/catalog.test.ts
```

Manual: http://localhost:3000/catalogo → crear producto, reordenar, desactivar.

#### Clientes (F-102) — `/clientes`

**Lógica:** teléfono WA, horario fijo de entrega, notas permanentes, límite de facturas pendientes, token de portal rotable.

**Cómo probar:** mismo e2e de catálogo + manual en `/clientes` y `/clientes/[id]`.

#### Bonos de reposición (F-105) — ficha cliente → Operación

Cuando un restaurante junta producto dañado (ej. tortilla quebradita) sin devolverlo físicamente, Cristian registra en la ficha **Bonos de reposición**: producto del catálogo, descripción y cantidad. El cliente lo ve en el portal como **gratis** y elige cuántas unidades tomar en su pedido; la línea queda a **Q 0.00** con chip **Devolución**. Producción y reparto sí cuentan las libras; la factura no cobra esa línea. Si anula el pedido antes del cierre, el saldo vuelve al bono.

**Cómo probar:** `bun test apps/api/src/modules/catalog/catalog.e2e.test.ts` (otorgar/anular) y `bun test apps/api/src/modules/ordering/ordering.e2e.test.ts` (consumo y restauración).

#### Alias y precios (F-103)

**Lógica:** `ClienteProducto` = cómo **ese** cliente llama al producto, su precio, nota de producción (ej. GRUESA), favoritos. El portal **no** auto-crea ligas: solo aparecen productos con precio cargado.

**Manual:** Clientes → Tabasco Casa Vieja → editar alias/precio/favorito → abrir portal y verificar que los favoritos salen arriba con el alias del cliente.

#### Importador CSV (F-104)

**Lógica:** plantilla descargable, preview con errores por fila, importación parcial permitida.

**Manual:** `/clientes` o `/catalogo` → Importar → descargar plantilla → subir CSV con errores y confirmar solo filas válidas.

**API:**

```
GET  /catalogo/import/plantillas/{clientes|productos}
POST /catalogo/import/preview
POST /catalogo/import/confirmar
```

---

### E2 — Portal del cliente

#### Acceso por token (F-201)

**Lógica:** `/p/{token}` sin login; token hasheado en BD; rate limit por token e IP; cada apertura en `audit_log`; token revocado → 404 genérico.

**Cómo probar:**

```bash
bun test apps/api/src/modules/ordering/ordering.e2e.test.ts
bun test apps/api/src/modules/ordering/portal-rate-limit.test.ts
```

**Ver como cliente:**

1. Abre http://localhost:3000/p/dev-tabasco-casa-vieja-portal-token
2. Si la ventana está cerrada, verás cuándo abre de nuevo (validado en servidor)
3. Pestaña **Estado de cuenta** muestra facturas pendientes

#### Captura de pedido (F-202)

**Lógica:** favoritos arriba con alias y precio del cliente; solo cantidades; confirmación con subtotal; mobile-first.

**Manual (ventana abierta, 15:00–03:00 GT):**

1. Portal → elige cantidades en favoritos
2. Revisa resumen con subtotal
3. Confirma → pedido aparece en `/pedidos` del panel (SSE lo refresca)

#### Ventana horaria (F-203)

**Lógica:** fuera de horario el portal no acepta envío; muestra próxima apertura.

**Probar fuera de horario:** los tests e2e usan reloj controlado; manualmente solo fuera de 15:00–03:00 GT. Ojo: a las 00:00 la ventana **sigue abierta**; el corte es a las 03:00.

#### Edición hasta cierre (F-204)

**Lógica:** el cliente puede editar mientras la ventana esté abierta; cada edición queda en `audit_log` con diff; **no** hay versionado del pedido; cancelar desde portal no está permitido (debe llamar).

#### Estado de cuenta (F-205)

**Lógica:** facturas pendientes, montos, antigüedad, límite configurable — mismo enlace del portal.

**API:** `GET /p/{token}/cuenta`

---

### E3 — Panel de pedidos

#### Bandeja (F-301) — `/pedidos`

**Lógica:** filtro por fecha de operación, cliente, estado; varios pedidos del mismo cliente el mismo día; correlativo global simple.

**Con qué operación abre:** con el **foco** (§4), no con «hoy». A las 20:00 los
pedidos entran en la ventana de captura, así que abrir en la operación ya
repartida dejaba la bandeja congelada mientras el SSE llenaba otra. El atajo
**Hoy** sigue apuntando al eje en curso; **Esta noche**, a la captura.

**Cómo probar:**

```bash
bun test apps/api/src/modules/ordering/pedidos.e2e.test.ts
```

Manual: captura desde portal + captura manual → ambos visibles en bandeja.

#### Pedido manual (F-302)

**Lógica:** salta ventana horaria; `origen: MANUAL`; registra quién capturó. Caso típico: Tienda 6 por llamada.

**Manual:** `/pedidos` → Nuevo pedido manual → elegir cliente y líneas.

#### Tiempo real SSE (F-303)

**Lógica:** nuevos pedidos y cambios de estado invalidan TanStack Query vía SSE; reconexión automática.

**Manual:** abre `/pedidos` en dos pestañas; confirma un pedido en el portal → la bandeja se actualiza sola.

#### Notas extraordinarias (F-304)

**Lógica:** campo libre por pedido ("llevar junto con tortillas de la mañana"). Horario, punto de carga y grosor **no** se escriben a mano: salen del catálogo.

---

### E4 — Operación diaria

#### Cierre y consolidación (F-401) — `/hoy`

**Lógica de negocio:**

1. Cristian cierra la ventana cuando termina la noche.
2. **Solo entonces** se materializa la hoja de producción (Alex no ve datos viejos).
3. Se emite evento `VentanaPedidoCerrada` → outbox.

**Qué operación muestra `/hoy`:** la del eje con trabajo activo (ver §4).
Cuando captura y reparto son operaciones distintas aparece un selector
**«Reparto de hoy» / «Pedidos de esta noche»**. **`/hoy` no tiene calendario**:
es la operación viva, y ofrecer atajos de semana/quincena/mes prometía un rango
que la pantalla nunca consultó (siempre pide un día). Para revisar operaciones
pasadas está `/pedidos`. Un deep link `?fechaOperacion=` a un día pasado se
rotula como histórico con un botón **Volver a hoy**.

**Manual:**

1. Login como `cristian`
2. `/hoy` → **Cerrar ventana del día**
3. Verifica que `/produccion` ya muestra la hoja
4. A las 08:00 del día siguiente, `/hoy` debe abrir en la operación que se
   reparte (no en la ventana de esa tarde, que aún está vacía)

**Cómo probar:**

```bash
bun test apps/api/src/modules/fulfillment/fulfillment.e2e.test.ts
```

#### Hoja de producción (F-402) — `/produccion`

**Lógica:** agrupada por punto de carga; sábado ⇒ todo desde PLANTA; horarios fijos y notas GRUESAS impresos; formato reconocible respecto al WhatsApp actual (ver `CONTEXT.md` §4).

**Eje de la hoja:** la operación **en curso**, pedida explícitamente
(`GET /operacion?fechaOperacion=`). Alex produce de madrugada lo que se reparte
hoy. Con el foco, a las 15:01 —cuando abre la ventana de la tarde— la pantalla
saltaba a una operación sin hoja materializada y se vaciaba a media jornada.

**Manual:** tras cierre, abre `/produccion` y compara estructura con el mensaje consolidado de referencia.

#### Vistas por rol (F-403)

**Lógica:** **misma información, distintas acciones.** El núcleo operativo —Hoy, Tablero, Pedidos,
Producción, Reparto y Cartera— lo ven los cinco roles, incluido `PRODUCCION`, que no tiene ningún
permiso. Ninguno de esos GET está restringido en la API, así que ocultarlos en el menú por permiso
de *escritura* solo servía para que Alex no pudiera mirar la cartera que el backend ya le servía.

Catálogo, Clientes y Conversaciones sí siguen pidiendo permiso: no son la jornada.

**Ver ≠ actuar.** Las acciones siguen guardadas por permiso en cada pantalla y en cada endpoint.
Cuando el usuario no tiene ninguna escritura en la sección que está mirando, el panel muestra un
badge **«Solo lectura»** junto al título, para que la ausencia de botones se lea como permiso y no
como fallo de carga. Tablero y Producción no lo llevan: nadie escribe ahí.

Quién ve qué y quién queda en solo lectura vive en `apps/web/src/lib/nav-vista.ts`
(`PERMISOS_SECCION`, `ESCRITURAS_POR_SECCION`), con tests.

**Manual:** entra con `alex` (PRODUCCION) → aparecen Pedidos, Reparto, Cartera y Tablero, con datos,
sin botones de escritura y con el badge «Solo lectura».

#### Exportación (F-404)

**Lógica:** hoja en texto y PDF (`pdfcn` / `takumi-pdf`, sin Chrome headless) para WhatsApp o impresión de respaldo.

**Manual:** `/produccion` o `/hoy` → exportar texto/PDF.

**API:** `GET /hojas/{fecha}`

#### Reapertura (F-405)

**Lógica:**

1. Solo ADMIN_JEFE, motivo obligatorio
2. No reenvía mensajes ya enviados
3. Al recerrar: hoja **versión 2** con cambios resaltados
4. Todo en `audit_log`

**Manual:** `/hoy` → Reabrir (como `cristian`) → editar pedidos → cerrar de nuevo → ver versión 2.

---

### E5 — Cobranza

#### Entrega (F-501) — `/reparto`

**Lógica:**

- `cantidad_entregada` por línea; default = lo pedido
- La factura se calcula sobre lo **entregado**, no lo pedido
- Requiere `idempotencyKey` (obligatorio desde F-801)

**Eje de la ruta:** `/reparto` se consulta por **día de calle**
(`pedido.fecha_entrega = hoy de calendario`), no por fecha de operación. La ruta no
cambia cuando abre la ventana de la tarde. `GET /reparto` acepta
`?fechaEntrega=` (y `?fechaOperacion=` para deep-links viejos) y devuelve
ambos campos en la respuesta.

**Manual:**

1. Login `tony` → `/reparto`
2. Selecciona parada → ajusta cantidades si hace falta → **Marcar entregado**
3. El pedido pasa a estado ENTREGADO y se genera factura pendiente
4. Deja pasar las 15:00: la ruta debe seguir mostrando las mismas paradas

#### Captura DTE (F-502)

**Lógica:** Carla registra el número del sistema externo de facturación; es el puente pedido ↔ cartera.

**Manual:** `/pedidos` (pedido entregado) o `/cartera` → Capturar DTE.

#### Pagos y abonos (F-503) — `/cartera`, `/reparto`

**Lógica:**

- Tabla `Pago` propia: monto, método (`EFECTIVO` | `TRANSFERENCIA`), fecha
- Factura **Pagada** cuando `SUM(pagos) >= factura.monto` (nunca un booleano suelto)
- Abonos parciales soportados

**Cómo probar:**

```bash
bun test packages/shared/src/receivables.test.ts
bun test apps/api/src/modules/receivables/receivables.e2e.test.ts
```

#### Comprobantes (F-504)

**Lógica:** foto de transferencia/recibo subida vía presign R2, ligada al pago.

#### Control de cartera (F-505) — `/cartera`

**Lógica:** contador de facturas pendientes vs. límite por cliente; alerta al superar; filtros; cuadre diario con repartidor; corte quincenal.

`GET /cartera/resumen` devuelve `cobradoHoyCentavos` junto con `fechaCobro`:

- **Con `?fechaOperacion=`** el monto es el del **día de calle de esa
  operación**, no el de hoy: abrir una operación pasada muestra lo que se cobró
  ese día.
- **Sin filtro** es el **día de calendario**, a secas. Derivarlo del foco mandaba
  «Cobrado hoy» a Q 0.00 a las 15:01 —el foco salta a la ventana que abre, cuya
  entrega es mañana— y contradecía al cuadre del día, que siempre usó día de calendario.

La UI escribe `fechaCobro` junto al número, para que no dependa de que el
usuario sepa cuál de los tres «hoy» está mirando.

El **cuadre acepta día** (`GET /cobranza/cuadre?fecha=`): la pestaña «Cuadre del día» tiene un
selector para revisar caja de días pasados. Sin fecha responde el día de calendario de hoy. `/reparto` en
cambio se queda fijo en hoy a propósito: es la pantalla de calle, offline, con cola en IndexedDB, y
un selector ahí permitiría entregar o cobrar contra el día equivocado.

Los filtros de facturas se llaman **«Emitida desde / hasta»** porque recortan por el día de calendario de
`factura.emitida_at` —el día de calle—, no por la operación.

**Manual:** `/cartera` → filtrar por cliente → registrar pago → ver contador bajar. Luego «Cuadre
del día» → elegir un día pasado y contrastar con el filtro de facturas del mismo rango.

**API:**

```
GET  /cartera
GET  /cartera/resumen
GET  /cobranza/cuadre
POST /pagos
POST /cartera/clientes/:id/recordatorio
```

---

### E6 — Dashboard

#### Tablero (F-601) — `/tablero`

**Lógica:** KPIs de operación del día, cartera (saldo, efectivo vs transferencia, antigüedad), ventas por periodo, volumen por producto, adopción portal vs manual, alertas (cliente que dejó de pedir, sobre límite).

**Cómo probar:**

```bash
bun test packages/shared/src/analytics.test.ts
bun test apps/api/src/modules/analytics/analytics.e2e.test.ts
```

Manual: genera pedidos/entregas/pagos de prueba → `/tablero` con filtros de fecha.

#### PDF del tablero (F-602)

El reporte **sigue al recorte**, no siempre es la quincena: `reporteTablero`
(en `@misupertostada/shared`) decide título y nombre de archivo a partir del
rango ya resuelto.

| Recorte | Título | Archivo |
|---|---|---|
| Un solo día (o `periodo=hoy`) | Resumen del día | `resumen-dia-2026-08-22.pdf` |
| `periodo=semana` | Resumen de la semana | `resumen-semana-<desde>-<hasta>.pdf` |
| `periodo=quincena` | Cierre de quincena | `cierre-quincena-<desde>-<hasta>.pdf` |
| `periodo=mes` | Cierre de mes | `cierre-mes-<desde>-<hasta>.pdf` |
| `periodo=rango` | Resumen del periodo | `resumen-periodo-<desde>-<hasta>.pdf` |

Contenido: KPI del recorte, movimiento diario (ventas y caja del mismo día,
con totales), participación por cliente, volumen por producto, antigüedad de
cartera, ruta y adopción, tabla completa de clientes y un bloque «Requiere
atención» (sobre límite, aún no piden, dejaron de pedir). Los filtros activos
salen como chips en el encabezado de cada hoja.

**Manual:** `/tablero` → el botón de la barra de filtros cambia de texto con el
periodo elegido.

**API:** `GET /tablero/quincena.pdf` (la ruta conserva el nombre histórico; el
`Content-Disposition` sale del rango resuelto, nunca del query crudo).

---

### E7 — Mensajería

#### WhatsApp — `/conversaciones`

**Para qué sirve:** cola de **excepciones** de restaurantes. Cristian contesta lo que escribieron; invitaciones, confirmaciones, estados de cuenta y consolidados salen solos por outbox.

**Lógica clave:**

- Sin credenciales Meta → **`FakeWhatsAppAdapter`** (desarrollo no bloqueado)
- Si el restaurante escribió recientemente → puede responder en texto libre
- Si no escribió → solo avisos ya armados (p. ej. **Mandar estado de cuenta**)
- Preview obligatorio antes de enviar texto libre
- Ficha lateral: pedido de esta noche, horario, saldo, notas

**Cómo probar:**

```bash
bun test apps/web/src/lib/conversacion-vista.test.ts
bun test apps/web/src/components/domain/ventana-badge.test.ts
bun test apps/api/src/modules/messaging/messaging.e2e.test.ts
bun test packages/shared/src/messaging.test.ts
```

**Manual (fake):**

1. `/conversaciones` → abrir conversación de un cliente con teléfono WA
2. En **Pruebas** (solo desarrollo): simular mensaje del restaurante
3. Con ventana viva: escribir y enviar texto libre
4. Con ventana apagada: **Mandar estado de cuenta** (igual que en cartera)

**API útil en dev:**

```
POST /conversaciones/:id/simular-inbound
POST /conversaciones/:id/enviar
POST /cartera/clientes/:id/recordatorio
GET  /conversaciones/:id
GET  /mensajeria/plantillas
```

---

### E8 — Offline / PWA

#### Cola local (F-801) — `/reparto`

**Lógica de negocio (Tony en la calle):**

1. Acciones de entrega y cobro se encolan en **IndexedDB** si no hay señal
2. Al recuperar conexión, se sincronizan con `idempotency_key`
3. **UI honesta:** nunca muestra éxito sin confirmación del servidor; banner de pendientes visible
4. ENTREGA debe sincronizarse antes que PAGO del mismo pedido

**Cómo probar automatizado:**

```bash
bun test packages/shared/src/offline.test.ts
bun test apps/web/src/lib/offline-sync.test.ts
```

**Manual:**

1. Login `tony` → `/reparto?sw=1` (activa service worker en dev)
2. DevTools → Network → **Offline**
3. Marca entrega o registra cobro → debe decir "pendiente de sincronizar"
4. Vuelve online → banner "Enviar ahora" o sync automático
5. Solo tras respuesta OK del servidor desaparece de la cola

**Instalar PWA:** chip "Instalar app" en el panel (Chrome/Android; en iOS: Compartir → Añadir a inicio).

**Archivos clave:**

| Archivo | Rol |
|---|---|
| `apps/web/public/sw.js` | Cache de shell; no intercepta API |
| `apps/web/src/hooks/use-cola-offline.tsx` | Estado React de la cola |
| `apps/web/src/lib/offline-sync.ts` | Drenado FIFO hacia API |
| `packages/shared/src/offline.ts` | Reglas puras de cola |

---

## 6. Flujo operativo de punta a punta

Recorrido recomendado para validar que todo encaja (ideal con ventana abierta):

```
1. Cliente pide          →  /p/dev-tabasco-casa-vieja-portal-token
2. Cristian ve pedido    →  /pedidos  (SSE)
3. Cristian cierra noche →  /hoy → Cerrar ventana
4. Alex ve hoja          →  /produccion
5. Tony entrega          →  /reparto → Marcar entregado
6. Carla captura DTE     →  /cartera → DTE
7. Tony cobra            →  /reparto → Registrar pago (o offline)
8. Cristian cuadra       →  /cartera → Cuadre / tablero
9. Recordatorio WA       →  /conversaciones (si aplica)
```

**Regla de sábado:** si `fecha_operacion` cae en sábado, la hoja muestra toda la carga desde PLANTA aunque las tortillas sean de DEMOCRACIA.

---

## 7. Suite de tests

```bash
# Todo
bun test

# Por área
bun test packages/shared/src/calendar.test.ts
bun test packages/shared/src/offline.test.ts
bun test apps/api/src/modules/ordering/ordering.e2e.test.ts
bun test apps/api/src/modules/fulfillment/fulfillment.e2e.test.ts
bun test apps/api/src/modules/receivables/receivables.e2e.test.ts
bun test apps/api/src/modules/messaging/messaging.e2e.test.ts
bun test apps/api/src/modules/analytics/analytics.e2e.test.ts
bun test apps/web/src/lib/offline-sync.test.ts
bun test apps/web/src/lib/ejes-vista.test.ts   # copy de los tres ejes en la UI
```

Los e2e de API requieren Postgres accesible en `DATABASE_URL`. Si no hay DB, esos tests se saltan solos.

---

## 8. API de referencia rápida

Base: `http://localhost:3001`

| Área | Endpoints principales |
|---|---|
| Auth | `POST /auth/login`, `GET /auth/me`, `POST /auth/logout` |
| Calendario | `GET /calendario/ahora` |
| Pedidos | `GET/POST /pedidos`, `POST /pedidos/:id/anular` |
| Portal | `GET /p/:token`, `GET /p/:token/cuenta` |
| Operación | `GET /operacion`, `POST /operacion/cerrar`, `POST /operacion/reabrir` |
| Hojas | `GET /hojas/:fecha` |
| Reparto | `GET /reparto`, `POST /entregas` |
| Cartera | `GET /cartera`, `POST /pagos` |
| Tablero | `GET /tablero`, `GET /tablero/quincena.pdf` |
| Catálogo | `GET/POST /productos`, `GET/POST /clientes` |
| Mensajería | `GET /conversaciones`, `POST /conversaciones/:id/enviar` |
| Assets | `POST /assets/presign`, `POST /assets/confirm` |

Todas las respuestas siguen el envelope de `@misupertostada/shared`.

---

## 9. Pendiente (E9 — puesta en marcha)

| ID | Qué falta |
|---|---|
| F-901 | Carga de datos reales (clientes, precios, productos de producción) |
| F-902 | Pruebas en campo con Tony y Carla |
| F-903 | Respaldos `pg_dump` semanal a R2 |
| F-904 | Observabilidad completa (Sentry en prod; `/health` ya existe) |
| F-905 | Manual impreso y capacitación presencial |
| F-001 | CI GitHub Actions |

---

## 10. Issues conocidos (revisión E8)

Hallazgos de la revisión de código sobre offline/PWA. Corregir antes de uso en campo con Tony:

| Severidad | Issue | Impacto |
|---|---|---|
| MEDIUM | `siguienteAccion` trata ENTREGA en estado `error` como bloqueo para PAGO | Cobro puede quedar atascado en cola |
| MEDIUM | `OfflineBanner` usa `cola.length` en vez de solo pendientes reales | Banner engañoso con filas en error |
| LOW | Service Worker filtra API por puerto `3001` | Confuso en mantenimiento; en prod usar pathname `/api/` |
| LOW | `idempotencyKey` nueva en cada tap de entrega | Cubierto por coalesce local; documentar invariante |

---

## 11. Glosario rápido

| Término | En el sistema |
|---|---|
| La Demo | Punto de carga `DEMOCRACIA` (tortillas) |
| La planta | Punto de carga `PLANTA` (resto) |
| Fecha de operación | Día en que **abrió la ventana**. Llave interna (hoja, cierre, ruta, outbox). No es la de entrega ni `created_at` |
| Fecha de entrega | Siguiente día activo tras la operación. Congelada en el pedido; es la que ven cliente y personal |
| Pagado | Factura saldada (no decir "cancelado") |
| Anulado | Pedido anulado desde panel |
| DTE | Número de factura externa capturado por Carla |

Para el glosario completo y casos de negocio, ver `CONTEXT.md` §2.
