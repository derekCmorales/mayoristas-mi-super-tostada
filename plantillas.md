# Plantillas de WhatsApp — verificación con Meta

Inventario de plantillas que el sistema necesita para operar sin transcripciones manuales.
Este documento conecta la **lógica de negocio** (qué se envía, cuándo y a quién) con lo que hay que
**crear y aprobar en Meta Business Manager**.

Referencias técnicas:

- Propósitos y validación: `packages/shared/src/messaging.ts`
- Plantillas de desarrollo (fake): `apps/api/src/modules/messaging/plantilla.service.ts` → `PLANTILLAS_FAKE`
- Despacho automático: `apps/api/src/modules/messaging/messaging.dispatcher.ts`
- Restricciones de plataforma: `AGENTS.md` §8

---

## 1. Resumen ejecutivo

| # | Propósito interno | Nombre sugerido en Meta | Categoría | ¿Automático? | Destinatario |
|---|-------------------|-------------------------|-----------|--------------|--------------|
| 1 | `INVITACION` | `mst_invitacion_v1` | UTILITY | Sí — cron 18:00 GT | Cada cliente activo con teléfono WA |
| 2 | `CONFIRMACION` | `mst_confirmacion_v1` | UTILITY | Sí — al confirmar pedido | Cliente que acaba de pedir |
| 3 | `ESTADO_CUENTA` | `mst_estado_cuenta_v1` | UTILITY | Sí — recordatorio manual desde cartera | Cliente con facturas pendientes |

**Total a verificar con Meta: 3 plantillas** (más texto libre dentro de la ventana de 24 h, que no requiere plantilla).

El sistema **no hardcodea** nombres en producción: sincroniza desde Graph API y mapea cada propósito
a una plantilla aprobada desde el panel (`GET /mensajeria/plantillas`, `POST /mensajeria/plantillas/mapear`).

---

## 2. Reglas de Meta que no se pueden negociar

Estas reglas están codificadas en `validarParametrosPlantilla()` y el despachador las aplica antes de llamar a Meta.

| Regla | Por qué importa |
|-------|-----------------|
| Fuera de la ventana de 24 h solo plantillas aprobadas | Error `131047` si se intenta texto libre |
| Variables sin `\n`, sin `\t`, sin más de 4 espacios seguidos | Meta rechaza el envío; el desglose de ítems **no cabe** en una variable |
| Máximo 1024 caracteres por variable | Límite Cloud API |
| Preview renderizado obligatorio antes de enviar manual | El operador ve el mensaje tal como llegará |
| `wa_message_id` único | Meta reintenta webhooks; deduplicamos |
| Categoría UTILITY para operación transaccional | MARKETING tiene restricciones de ventana y calidad distintas |

**Implicación de diseño:** el detalle de un pedido (líneas, cantidades, alias) va en **texto libre**
solo cuando la ventana de 24 h está abierta. Fuera de ella, el estado de cuenta va en **PDF adjunto**,
no en variables de plantilla.

---

## 3. Arquitectura: cómo encaja en el sistema

```
Evento de negocio          Outbox / acción manual          Propósito           Plantilla Meta
─────────────────────────────────────────────────────────────────────────────────────────────
Cron 18:00 GT              InvitacionDiaria                INVITACION          mst_invitacion_v1
Pedido confirmado          PedidoConfirmado                CONFIRMACION        mst_confirmacion_v1
Clic en cartera            RecordatorioCobro                 ESTADO_CUENTA       mst_estado_cuenta_v1
Mensaje manual (panel)     POST /conversaciones/:id/enviar  (cualquiera APPROVED o texto libre)
```

Flujo de conexión con Meta:

1. **Embedded Signup** — registrar la WABA bajo la app de Tech Provider (`conexion.service.ts`).
2. **Sincronizar plantillas** — `POST /mensajeria/plantillas/sync` trae estado y componentes desde Graph API.
3. **Mapear propósitos** — asociar cada `INVITACION | CONFIRMACION | ESTADO_CUENTA` a la plantilla aprobada correspondiente.
4. **Webhook `message_template_status_update`** — si Meta pausa o rechaza una plantilla, el estado se actualiza en BD y el envío se bloquea con `PLANTILLA_NO_APROBADA`.

En desarrollo (sin credenciales Meta) el sistema usa `FakeWhatsAppAdapter` con las tres plantillas
sembradas automáticamente; no hace falta Meta para programar.

---

## 4. Plantillas — detalle para Meta

Convención de nombres: `mst_{proposito}_v1` en minúsculas, idioma `es` (español).
Los nombres en Meta pueden diferir siempre que se mapeen correctamente en el panel; los sugeridos
coinciden con el seed de desarrollo.

### 4.1 `INVITACION` — Apertura de ventana nocturna

**Negocio:** Reemplaza el copy-paste que Cristian hace entre 21:00 y 24:00 a cada restaurante.
Se dispara **una vez por cliente por día de operación** a las **18:00** hora Guatemala (`InvitacionJob`).
Solo clientes activos con `telefono_wa` y token de portal válido.

**Cuerpo (BODY):**

```
Buenas noches. Ya está abierta la toma de pedidos para {{1}}. Puede responder aquí o abrir su portal.
```

| Variable | Origen | Ejemplo |
|----------|--------|---------|
| `{{1}}` | `fecha_entrega` del día (día de reparto, no el de operación) | `Viernes 22 de agosto` |

**Botón (obligatorio):**

| Componente | Valor |
|------------|-------|
| Tipo | URL (índice 0) |
| Texto del botón | `Abrir portal` (o similar, ≤ 25 caracteres) |
| URL en plantilla | `https://pedidos.misupertostada.com/p/{{1}}` — tipo **dinámica** |

Meta no acepta una URL que sea solo `{{1}}`: el dominio va fijo y la variable al final.
El sistema envía en `buttonParams` **solo el token**; Meta lo pega al final de la URL.

> En la solicitud de aprobación, el ejemplo de `{{1}}` es un token ficticio
> (`a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4`). Si cambia `WEB_ORIGIN`, hay que aprobar una `v2`.

**Ventana Meta:** fuera de las 24 h del cliente — por eso es plantilla, no texto libre.

**Idempotencia:** constraint única en outbox `(tipo=InvitacionDiaria, destinatario_id, fecha_operacion)`.

---

### 4.2 `CONFIRMACION` — Pedido recibido

**Negocio:** El restaurante sabe al instante que el pedido quedó capturado, con correlativo, fecha de entrega y total.
Se encola al pasar el pedido a `CONFIRMADO` (`PedidoConfirmado` en outbox).

**Cuerpo (BODY):**

```
Recibimos su pedido {{1}} para el {{2}}. Total {{3}}.
```

| Variable | Origen | Ejemplo |
|----------|--------|---------|
| `{{1}}` | Correlativo global del pedido | `1847` |
| `{{2}}` | Fecha de entrega + horario fijo si el cliente lo tiene | `Viernes 22 de agosto. Entrega a las 08:00` o solo `Viernes 22 de agosto` |
| `{{3}}` | Total en quetzales (formateo de presentación) | `Q 1,240.50` |

**Botón (obligatorio):**

| Componente | Valor |
|------------|-------|
| Tipo | URL dinámica |
| Texto del botón | `Ver pedido` |
| URL en plantilla | `https://pedidos.misupertostada.com/p/{{1}}` |
| Ejemplo | `https://pedidos.misupertostada.com/p/a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4/pedidos/0f8c2a4e-1b3d-4e5f-8a9b-1c2d3e4f5a6b` |

El sistema envía como sufijo `{token}/pedidos/{pedido.id}`: el botón abre el detalle del pedido
en el portal, con el desglose completo. Un cliente sin token de portal no recibe confirmación.

**Nota:** el desglose línea por línea **no va en el cuerpo** — no cabe en variables de Meta
(sin saltos de línea). Por eso vive en el portal, detrás del botón.

---

### 4.3 `ESTADO_CUENTA` — Recordatorio de cobro

**Negocio:** Reemplaza el “¿me puede mandar su estado de cuenta?” del cuaderno.
Carla o Cristian lo disparan desde `/cartera` → recordatorio por cliente.
Usa el **mismo propósito** que un envío manual de estado de cuenta desde conversaciones.

**Cuerpo (BODY):**

```
Le compartimos su estado de cuenta: {{1}} facturas pendientes por {{2}}.
```

| Variable | Origen | Ejemplo |
|----------|--------|---------|
| `{{1}}` | Cantidad de facturas con saldo > 0 | `3` |
| `{{2}}` | Suma de saldos pendientes | `Q 4,520.00` |

**Header (obligatorio):**

| Componente | Valor |
|------------|-------|
| Tipo | DOCUMENT |
| Contenido al enviar | PDF generado en servidor (`estado-cuenta.pdf`) |

El PDF lleva el detalle de cada factura (número DTE, monto, abonado, saldo, antigüedad).
**Una sola plantilla** sirve para 3 o 30 facturas porque el desglose va en el adjunto, no en variables.

**Idempotencia:** un recordatorio por cliente por `fecha_operacion` (si ya se encoló hoy, el panel avisa).

**Copy del PDF:** nunca dice “Cancelado” para facturas pagadas; usa “Pagado” (`estado-cuenta-pdf.tsx`).

---

> **Retirado (2026-11):** el consolidado por WhatsApp a producción y tienda (`mst_consolidado_v1`).
> Alex y Carla leen la hoja en el panel; el cierre ya no envía nada.

## 5. Lo que NO es plantilla (pero hay que saberlo)

| Caso | Cuándo | Cómo |
|------|--------|------|
| Texto libre en conversación | Ventana de 24 h abierta (cliente escribió o tocó quick-reply) | `tipo: "texto"` — sin aprobación previa de Meta |
| Desglose completo de pedido | Ventana abierta | Prosa en el composer; puede asistir IA con revisión humana |
| Selección manual de plantilla | Ventana cerrada | Composer bloqueado a plantillas; preview obligatorio |

Si Meta devuelve `131047`, la ventana está cerrada: hay que usar plantilla, no intentar rodear el límite.

---

## 6. Cómo crearlas y verificarlas en Meta

### 6.1 Prerrequisitos

- Cuenta de WhatsApp Business verificada y WABA conectada al sistema (Embedded Signup).
- App de Meta en modo producción (o al menos con permisos `whatsapp_business_messaging` y `whatsapp_business_management`).
- Dominio de producción fijado en `WEB_ORIGIN` (para la URL del botón de invitación).

### 6.2 Creación en Business Manager

Ruta habitual: **Meta Business Suite → Configuración de WhatsApp → Plantillas de mensajes → Crear plantilla**.

Para cada una de las tres:

1. **Nombre** — usar los sugeridos (`mst_invitacion_v1`, etc.) o el que prefieran; luego mapear en el panel.
2. **Categoría** — `UTILITY` (transaccional / operativo, no promocional).
3. **Idioma** — Español (`es`).
4. **Componentes** — según la tabla de cada sección §4 (BODY + HEADER/BUTTON donde aplique).
5. **Muestras de variables** — usar datos realistas:
   - Fechas: `Viernes 22 de agosto` (formato `formatearFechaLarga`)
   - Montos: `Q 1,240.50` (formato `formatearCentavos`)
   - URL de ejemplo en invitación: `https://app.TU-DOMINIO/p/token-ejemplo-32-chars`
6. **Enviar a revisión** — Meta suele responder en 24–48 h; UTILITY transaccional suele aprobarse si el copy es claro y no parece marketing.

### 6.3 Después de la aprobación

```bash
# En el panel (usuario con permiso mensajeria.conectar):
# 1. Conectar WABA (Embedded Signup)
# 2. Sincronizar plantillas
POST /mensajeria/plantillas/sync

# 3. Mapear cada propósito a la plantilla aprobada
POST /mensajeria/plantillas/mapear
{ "proposito": "INVITACION", "plantillaId": "<uuid-de-bd>" }
# Repetir para CONFIRMACION y ESTADO_CUENTA
```

También se puede hacer desde `/conversaciones` si la UI de mapeo está expuesta allí.

### 6.4 Webhook de estado

Suscribir el campo `message_template_status_update` en la WABA.
Cuando Meta cambie `APPROVED` → `PAUSED` o `REJECTED`, el sistema actualiza `plantilla_wa.status`
y bloquea envíos de ese propósito hasta que se reactive o se mapee otra plantilla.

---

## 7. Checklist de verificación antes de producción

### Por plantilla

- [ ] Estado `APPROVED` en Meta y reflejado tras `sync`
- [ ] Mapeada al propósito correcto en `plantilla_proposito`
- [ ] Número de variables del BODY coincide con lo que envía el código
- [ ] Preview en panel coincide con un envío de prueba real
- [ ] `INVITACION`: botón abre el portal con token válido
- [ ] `ESTADO_CUENTA`: PDF se adjunta y abre correctamente en el teléfono
- [ ] Ninguna variable de prueba tiene saltos de línea ni espacios largos

### Por flujo de negocio

- [ ] 18:00 GT: un solo `InvitacionDiaria` por cliente; segundo tick no duplica
- [ ] Confirmar pedido desde portal o panel dispara `PedidoConfirmado` una sola vez
- [ ] Recordatorio desde cartera encola `RecordatorioCobro` y adjunta PDF
- [ ] Reintento de outbox no duplica `wa_message_id`

### Pruebas automatizadas

```bash
bun test packages/shared/src/messaging.test.ts
bun test apps/api/src/modules/messaging/messaging.e2e.test.ts
```

---

## 8. Operación y mantenimiento

| Situación | Qué hacer |
|-----------|-----------|
| Meta pausó una plantilla por calidad | Revisar métricas en Business Manager; corregir copy; crear `mst_*_v2` y remapear |
| Cambio de dominio (`WEB_ORIGIN`) | Actualizar env + **nueva versión** de `mst_invitacion_*` con URL de ejemplo del dominio nuevo |
| Cliente no recibe invitación | Verificar `telefono_wa`, token de portal, plantilla APPROVED y fila en outbox |
| Error `131047` en panel | Normal fuera de ventana: usar plantilla, no texto libre |

**Versión de plantillas:** al cambiar el copy de forma incompatible (número de variables, tipo de header),
crear `mst_{proposito}_v2`, aprobar en Meta, sincronizar y remapear. No editar una plantilla aprobada
in situ — Meta exige nueva revisión de todas formas.

---

## 9. Plantillas futuras (no implementadas aún)

Estas aparecen en la arquitectura de eventos pero **no tienen propósito ni despacho hoy**:

| Evento | Uso potencial | Estado |
|--------|---------------|--------|
| `LimiteCreditoExcedido` | Alerta al admin cuando un cliente supera facturas pendientes | Pendiente de definir copy y plantilla |

Antes de agregar un quinto propósito, extender `PLANTILLA_PROPOSITOS` en `packages/shared`, el mapeo en BD
y este documento.

---

## 10. Ejemplos de mensaje renderizado

Con los parámetros de prueba del seed:

**Invitación**

> Buenas noches. Ya está abierta la toma de pedidos para Viernes 22 de agosto. Puede responder aquí o abrir su portal.
> [Abrir portal]

**Confirmación**

> Recibimos su pedido 1847 para el Viernes 22 de agosto. Entrega a las 08:00. Total Q 1,240.50.
> [Ver pedido]

**Estado de cuenta**

> [PDF adjunto]
> Le compartimos su estado de cuenta: 3 facturas pendientes por Q 4,520.00.

---

*Última revisión: alineado con `PLANTILLAS_FAKE` y `MessagingDispatcher` del repositorio.*
