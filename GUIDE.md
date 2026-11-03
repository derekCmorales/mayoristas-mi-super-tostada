# GUIDE.md — Cómo funciona la operación del día a día

Guía de **negocio**, no de código. Para explicarle el sistema al personal y al dueño.

- **`CONTEXT.md`** = qué se construye y por qué (producto, glosario, backlog).
- **`AGENTS.md`** = cómo se construye (reglas técnicas, convenciones).
- **`USAGE.md`** = cómo se prueba (feature por feature, con comandos).
- **`GUIDE.md`** (este archivo) = **cómo se opera**. Lenguaje de negocio, sin jerga técnica.

Si vas a explicarle el sistema a alguien que no lo construyó, este es el archivo.

---

## 1. La idea central

Todo el sistema descansa en una sola frase: **una noche de pedidos es una sola
operación, aunque cruce la medianoche.**

La ventana abre el lunes a las 15:00 y cierra el martes a las 03:00. Todo lo que
entre ahí dentro —las 16:00, las 23:00, la 01:00, las 02:00— pertenece a **la
operación del lunes**. No importa que el reloj ya diga martes. Esa es la unidad
de trabajo: una operación tiene una hoja de producción, un cierre y una ruta.

Esto no es un detalle técnico, es el modelo del negocio: los restaurantes cierran
entre 21:00 y 22:00 y hasta entonces saben qué necesitan. Pedir después de
medianoche es normal para ellos. El sistema tenía que tratarlo como normal
también.

El horario de fábrica es **lun–sáb 15:00 → 03:00, domingo cerrado**, y es
configurable por día de la semana desde `/configuracion`. La tabla del horario es
la **única** fuente: no hay valor de respaldo en ninguna parte. Si a la
organización le faltan sus siete filas, no hay ventana y el portal no acepta
pedidos hasta que se defina.

---

## 2. Los tres relojes

Este es el único concepto que cuesta, y vale la pena entenderlo porque explica el
90% de las confusiones.

En el sistema «hoy» significa tres cosas distintas, y entre las 03:00 y las 15:00
**las tres son diferentes**:

| Eje | Qué es | Para qué sirve |
|---|---|---|
| **Fecha de operación** | El día en que **abrió** la ventana | Llave interna: hoja, cierre, ruta |
| **Fecha de entrega** | El siguiente día activo | Es la fecha que se le dice al cliente y al personal |
| **Día de calendario** | El día del calendario, a secas | Caja, antigüedad de facturas, tablero |

Un martes cualquiera:

```
00:00 – 03:00   se captura la operación del LUNES   ·  se reparte lo del lunes
03:00 – 15:00   ya no se captura nada               ·  se reparte lo del lunes
15:00 – 24:00   se captura la operación del MARTES  ·  se reparte lo del lunes
```

Fíjate en la columna de la derecha: **el reparto no salta a las 15:00**. Tony está
en la calle con la carga del lunes hasta que termine, aunque a las 15:00 ya esté
entrando la noche del martes. Son dos trabajos simultáneos sobre operaciones
distintas.

Por eso cada pantalla está anclada a su eje y lo dice en el encabezado.
`/produccion` y `/reparto` miran la operación **en curso**. El portal y la captura
miran la de **captura**. La caja y el tablero miran el **día de calendario**.

**La regla de entrega:** entrega = siguiente día activo después de la operación,
saltando domingos y feriados. Lunes → martes. **Sábado → lunes**, porque el
domingo está apagado. Y hay una regla aparte: **el sábado toda la carga sale de la
planta**, sin importar el punto de carga de cada producto.

**Lo que se congela:** cuando el cliente confirma su pedido, su fecha de entrega
queda grabada en ese pedido para siempre. Si después se cambia el horario en
configuración, los pedidos viejos no se reescriben. Al cliente ya se le dijo «llega
el martes» y llega el martes.

---

## 3. El día, hora por hora

### 15:00 — abre la ventana

El portal se abre solo. Cada cliente tiene un enlace propio, permanente, sin
contraseña y sin app que instalar. Entra, ve **sus** productos con **sus** nombres
y **sus** precios, y pide.

Eso de «sus nombres» es importante: el cliente ve «tortilla grande», el sistema
guarda «Tortilla No. 16». Esa traducción —que antes Cristian hacía de cabeza y es
donde nacía el error silencioso de producción— está guardada por cliente, una sola
vez.

El cliente **puede editar su pedido hasta el cierre**. Cada edición queda
registrada. Lo que **no** puede es anular desde el portal: para eso tiene que
llamar. Fue decisión de negocio, no limitación técnica.

Los pedidos por llamada (Tienda 6, por ejemplo) se capturan a mano desde
`/pedidos`. Un pedido manual **se salta el reloj**: entra aunque la ventana esté
cerrada, y queda marcado como manual con el nombre de quién lo capturó.

### 03:00 — cierra sola

El sistema cierra la ventana solo, sin que nadie tenga que estar despierto. Revisa
cada minuto si ya tocó.

**El cierre es el momento importante del día.** Es cuando se materializa la hoja de
producción. Antes del cierre la hoja no existe — a propósito, para que Alex nunca
abra la pantalla y vea datos a medias que todavía van a cambiar. No se manda nada
por WhatsApp: Alex y Carla abren la hoja en el panel.

Cristian puede cerrar antes desde `/hoy` si ya vio que no falta nadie.

### 07:00 — Alex (producción)

Alex llega y abre `/produccion`. Ve la hoja de esa noche, agrupada **por punto de
carga**: lo que sale de La Demo y lo que sale de la planta. Con las libras por
cliente, los horarios fijos («ENTREGAR 9:00») y las notas de producción («GRUESAS»
de los Tabascos) ya impresas.

Esas notas no las escribe nadie cada noche. Están guardadas contra el cliente y
salen solas. Ese era otro punto de dolor: cosas que se recordaban de memoria.

La hoja se puede exportar a texto o PDF, para mandar por WhatsApp o imprimir de
respaldo.

### 08:00 — Carla (tienda y facturación)

Carla ve el pedido completo, alista y emite el DTE en el sistema externo de
siempre. Vuelve y **captura el número de factura**. El sistema no factura —no es su
trabajo— pero sí lleva el puente.

### Mañana — Tony (reparto)

Tony abre `/reparto` en el celular. Ve su ruta: a quién, qué, y cuánto debe de
antes.

Aquí hay tres reglas que importan:

1. **La factura se calcula sobre lo entregado, no sobre lo pedido.** Cada línea
   llega con la cantidad entregada igual a la pedida, y Tony la ajusta si entregó
   menos. Lo que se factura es lo que bajó del camión.
2. **Funciona sin señal.** Marcar entregado y registrar un cobro se guardan en el
   teléfono y se sincronizan cuando vuelve la red. Cada acción lleva una llave que
   evita que se duplique si se manda dos veces.
3. **`/reparto` está fijo en hoy, a propósito.** No hay selector de fecha. Es la
   única pantalla donde eso es una decisión deliberada: si Tony pudiera elegir día,
   podría marcar entregado contra el día equivocado, y esa acción se encola y se
   sincroniza sola. El riesgo no compensa. Para ver días pasados están `/pedidos` y
   el cuadre.

### Fin del día — la caja

Aquí está lo que reemplaza al cuaderno.

**Un pedido está pagado cuando la suma de sus pagos alcanza el monto de la
factura.** No es una casilla que alguien marca. Se calcula. Eso significa que los
pagos parciales funcionan solos y que nadie puede «marcar pagado» algo que no se
pagó.

Cada cliente tiene un **límite de facturas pendientes** propio, según cómo paga:
Casa Vieja del estadio paga diario, límite 3. Don Napo pide una vez por semana,
límite 2. Tabasco Interplaza paga semanal, límite 5. Cuando alguien pasa su
límite, la pantalla lo alerta. Ese era el caso real del cliente con 7 facturas
acumuladas y el otro con 15 días de atraso: no es que nadie mirara, es que contar a
mano en un cuaderno no escala.

El **cuadre del día** es lo que Tony y Cristian hacían de palabra al final de la
jornada: cuánto entró en efectivo, cuánto por transferencia, y quién cobró qué. Se
puede consultar cualquier día pasado.

> **Ojo con la palabra.** En Guatemala «cancelado» significa **pagado**. En el
> sistema un pedido «cancelado» sería anulado. Por eso la interfaz nunca dice
> «cancelado»: dice **Pagado** o **Anulado**.

---

## 4. Si algo sale mal: reabrir el día

Se cerró y faltaba un pedido. Solo Cristian puede reabrir, y **tiene que escribir el
motivo**. Al volver a cerrar, la hoja sale como **versión 2 con los cambios
resaltados**, para que Alex vea qué cambió y no tenga que compararla completa. Todo
queda en el historial.

Reabrir es también la única forma de aceptar pedidos fuera de hora. Adelantar el
horario en configuración **no** reabre un ciclo que ya empezó — eso es a propósito,
para que cambiar la configuración nunca tenga efectos retroactivos sorpresa.

---

## 5. Quién ve qué

Esto se decidió explícitamente y conviene decirlo así:

> **Los tres internos ven la misma información. Lo que cambia por rol son las
> acciones, no los datos.**

Alex, Tony y Carla ven la jornada completa: Hoy, Tablero, Pedidos, Producción,
Reparto y Cartera. Alex ya sabe filtrar mentalmente lo que le toca, y que vea el
resto le da contexto.

Lo que cambia es qué puede **hacer** cada uno. Tony entrega y cobra. Carla captura
DTE, cobra y hace pedidos manuales. Alex no escribe nada. Cuando alguien abre una
pantalla donde no puede actuar, aparece un aviso **«Solo lectura»** para que la
ausencia de botones se lea como permiso y no como que la pantalla falló.

Catálogo, Clientes y Conversaciones sí están reservados: no son la jornada.

Y una cosa que vale la pena que el dueño sepa: **los permisos se delegan sin tocar
código**. Si mañana Carla también cierra la ventana, Cristian le da ese permiso
desde configuración y listo.

---

## 6. Cómo explicárselo a cada quien

### A Alex (producción)

> «A las 7 abrís Producción. Lo que está ahí es lo definitivo — no va a cambiar
> mientras producís, porque la hoja se arma cuando cierra la noche, no antes. Ya
> viene separado: lo de La Demo por un lado, lo de planta por otro. Los grosores y
> los horarios especiales ya están puestos, no los tenés que recordar. Si algo
> cambia después, te llega la hoja versión 2 con lo nuevo marcado.»

No le expliques los tres relojes. No los necesita.

### A Tony (reparto)

> «Abrís Reparto y ahí está tu ruta de hoy. Ajustás lo que entregaste de verdad si
> bajaste menos, y cobrás ahí mismo. Si no tenés señal, seguí trabajando igual: se
> guarda en el teléfono y se manda solo cuando volvés a tener. Nunca se duplica. La
> pantalla siempre es la de hoy, no tenés que elegir fecha.»

Lo importante para él: la app no lo deja tirado sin señal, y nunca va a cobrar dos
veces por marcar dos veces.

### A Carla (tienda y facturación)

> «Ves el pedido completo para alistar y facturar. Emitís el DTE donde siempre y
> volvés a poner el número acá — eso cierra el círculo. En Cartera ves quién debe y
> cuántas facturas lleva acumuladas cada uno; cuando alguien pasa su límite te avisa
> sola. El cuadre del día te dice cuánto entró en efectivo y cuánto por
> transferencia, y podés revisar días pasados.»

### A Cristian (el jefe)

> «Ya no tenés que estar en el teléfono de 9 a 12. La ventana abre y cierra sola.
> Vos entrás a Hoy cuando querés y ves cómo va: cuánto lleva la noche, quién ya pidió
> y **quién falta por ordenar**. Si querés cerrar antes, cerrás. Si se te fue
> alguien, reabrís poniendo el motivo y sale la versión 2.»

---

## 7. El argumento para el dueño

En su lenguaje, no en el nuestro:

1. **Se recupera la noche.** Tres horas diarias de una persona, todos los días. Ya
   no hay que copiar y pegar el mensaje cliente por cliente ni esperar despierto las
   respuestas.
2. **Se elimina la traducción de cabeza.** «50 libras de grande» → «50 de la No. 16»
   ya no depende de que alguien lo traduzca bien a la una de la mañana. Está guardado
   por cliente. Ese era un error silencioso: no se notaba hasta que producción sacaba
   lo que no era.
3. **Nadie transcribe nada dos veces.** Ese fue el principio que guió todo el diseño.
   El pedido se captura una vez —lo escribe el propio cliente— y de ahí sale la hoja
   de producción, la ruta, la factura y la cartera. La doble digitación teléfono →
   cuaderno era donde se perdía dinero, y es textual: *«aunque sea muy ordenado
   siempre se pierde dinero»*.
4. **El cuaderno ahora se filtra, se respalda y se audita.** Los dos casos reales
   —el cliente con 7 facturas acumuladas y el de 15 días— no pasaban por descuido.
   Pasaban porque contar a mano no escala. Ahora el límite es por cliente, según cómo
   paga cada uno, y avisa solo.
5. **Cada acción tiene nombre y hora.** Quién cerró, quién reabrió y por qué, quién
   cobró, quién cambió un precio. Cuando cierran quincena, hay de dónde sacarlo.
6. **Los clientes no instalan nada.** Un enlace, sin contraseña. Piden desde el
   celular, tarde, como ya lo hacen. La adopción no depende de que nadie cambie de
   costumbre.

---

## 8. Lo que todavía no está probado

**WhatsApp está construido pero no verificado con Meta.** La cola de mensajes
salientes funciona y es transaccional, pero el envío real depende de la verificación
del negocio. Esa prueba queda pendiente.

**Hay un bug conocido ahí.** Cuando Meta pausa una plantilla, el sistema la marca
como pausada **en todas las organizaciones**, no solo en la que corresponde
(`plantilla.service.ts`, `actualizarStatus` filtra por nombre e idioma, sin
organización). Con un solo negocio es inofensivo. Cuando se pruebe mensajería va a
aparecer, y como el panel ya no muestra el contador de la cola, va a costar
diagnosticarlo: la confirmación falla ocho veces en silencio y muere. Tiene arreglo
directo — el webhook de Meta trae el WABA y ya existe el mapeo a organización.
