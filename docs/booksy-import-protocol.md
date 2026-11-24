# Protocolo de copia y migración de Booksy a Citame

El ensayo actual comienza el **18 de noviembre de 2026 a las 00:00 de Europe/Madrid**, equivalente a `2026-11-17T23:00:00Z`. Booksy continúa siendo el sistema operativo del centro. Este procedimiento copia información y no cancela, edita, elimina ni cambia la publicación de nada en Booksy. No implica dejar de usar Booksy.

## Destinos y límites del ensayo

Los originales se conservan fuera del repositorio, en una carpeta privada con permisos 0700 y archivos 0600. Cada captura conserva su fecha, referencia de origen, texto/campos observados y SHA-256. Las revisiones son documentos nuevos; un original nunca se sustituye. La copia actual usa la base local persistente `sob_booksy_rehearsal_20261117_run5`, distinta de la demo y de producción. Los ensayos anteriores se conservan intactos; un cambio de normalización genera otra base, no una sobrescritura. No tiene servidor público ni workers, proveedores de mensajes, invitaciones, pagos o tareas de renovación activos.

Hay dos resultados diferentes:

- **Archivo de origen:** copia exacta de los bytes capturados, también guardada en `booksy_rehearsal.raw_capture`. Permite recuperar campos todavía no proyectados. Sus recuentos son capturas, no citas nativas.
- **Proyección Citame:** personal, servicios, asignaciones, clientes, horarios, bloqueos, citas y sus servicios congelados que tengan referencias y campos verificables. Se registra cada correspondencia por negocio, entidad e ID externo. Los nombres, teléfonos o correos por sí solos no identifican ni fusionan personas.

Los comandos de esta versión admiten bases locales identificadas de ensayo, comprobación de restauración y preparación de una candidata. `canCutOver` siempre es falso. Booksy sólo se consulta durante este protocolo.

### Carga inicial verificada del 17/11/2026

La copia está disponible en [Citame local](http://127.0.0.1:4276/admin/calendar?date=2026-11-18&view=day), con autenticación privada y acceso exclusivamente local. La web y la API de consulta se ejecutan como servicios de usuario. Usan una restauración separada con las migraciones al día, `sob_booksy_rehearsal_20261117_run6`, que conserva el snapshot de `run5`. **Es una copia de consulta, sin sincronización automática. Booksy sigue siendo la agenda operativa.** El servidor especial bloquea escrituras comerciales, registro de cuentas y recuperación de contraseñas. Solo permite iniciar y cerrar sesión. Los workers y proveedores de mensajes o pagos están desactivados.

| Datos conservados                                         |              Resultado conciliado |
| --------------------------------------------------------- | --------------------------------: |
| Originales con SHA-256 y bytes exactos                    | 1.041 capturas / 83.116.320 bytes |
| Reservas completas de origen                              |                               608 |
| Líneas de servicio reservadas visibles en la agenda       |                               786 |
| Clientes del directorio completo                          |                             6.376 |
| Perfil separado para una reserva sin cliente identificado |                                 1 |
| Profesionales / asignaciones / tramos de horario          |                      7 / 395 / 51 |
| Catálogo de origen / extras                               |                          166 / 26 |
| Servicios nativos, incluidos 21 extras con precio         |                               187 |
| Bloqueos / productos / recursos físicos                   |                       56 / 93 / 9 |

Se capturaron y conciliaron **53 semanas**, desde el **18/11/2026 hasta el 23/11/2027**, incluyendo los 7 profesionales y 9 recursos. Las 608 reservas se abrieron completas y se reconciliaron las 53 semanas al final: ninguna referencia observada desapareció y una reserva cambiada se volvió a capturar. El último inicio observado es el **15/04/2027 a las 12:10 Europe/Madrid**. Esto **no demuestra que no existan reservas posteriores al horizonte inspeccionado**; sigue pendiente una prueba de fin de cobertura o exportación completa del proveedor.

Las reservas, combos, líneas, extras, asignaciones por servicio, preferencias de profesional y comentarios se conservan con sus IDs originales en `booksy_rehearsal.source_appointment` y el snapshot privado. Citame las muestra en su calendario y en las fichas de clientes. Las notas internas, comentario del cliente y mensaje del negocio permanecen diferenciados; solo el propietario autenticado puede consultar el detalle privado. La respuesta de calendario contiene indicadores, no textos privados. El indicador de pago no se convierte en factura ni genera ingresos.

La tabla operativa `appointment` contiene **cero reservas importadas**: esta copia de consulta conserva los solapamientos, grupos y tiempos originales sin alterar restricciones de concurrencia, desplazar citas ni descartar líneas. **No es una migración operativa lista para sustituir Booksy.** El personal, clientes, servicios, asignaciones, horarios, bloqueos, productos y recursos sí tienen proyección nativa verificable. Los colores se obtienen del RGB observado en las 166 filas del catálogo: los valores numéricos de Booksy son índices de paleta, no colores RGB.

Se preservan los **5 extras de precio variable sin importe**, pero no se activan como servicios con precio inventado. Los **16 productos sin impuesto informado** se conservan desactivados para venta; el `null` original permanece en el archivo y el campo numérico obligatorio de la proyección no se interpreta como una exención. No se importa el precio neto de venta como coste: el coste desconocido sigue siendo `null`. Las 93 entradas de stock son saldos iniciales, nunca ventas ficticias.

Los documentos originales conservan sus bytes tanto en archivos privados como en `raw_capture.payload` (`bytea`). Para campos JSON incompatibles con PostgreSQL (NUL o sustitutos Unicode sin pareja), el JSONB usa una envoltura reversible y verificada; no elimina ni sustituye caracteres del original. Los originales, credenciales y datos personales no se guardan en Git ni en logs.

El snapshot de la carga inicial es `5d46e2570c5b517f8958af70bf190d1a555ae5a94b069720dba6acb623c257d5`. Se ha generado un respaldo PostgreSQL de esta base y **restaurado en una base nueva**, verificando los 1.041 originales, campos nativos, 608 reservas y anotaciones privadas completas. La comprobación es local; sigue pendiente una segunda copia cifrada fuera de este equipo antes de un corte real.

La matriz de migración sigue abierta: archivos binarios/fotos, finanzas e histórico contable, bonos/tarjetas/suscripciones, lista de espera y configuración completa requieren captura y traducción adicionales. Conservar metadatos de estos campos dentro del original no equivale a tener esos módulos importados y operativos. La revisión conserva 263 bloqueos de traducción/completitud y `canCutOver: false`.

### Refresco del día 18/11

Una nueva lectura de Booksy para el 18/11 contiene 34 servicios de 29 reservas y tres bloqueos, consultados con los 16 recursos que declara el origen. La copia anterior contenía 35 servicios para ese día. La línea que dejó de aparecer se conserva en su captura y en la base anterior. El refresco solo reemplaza en la vista de consulta la observación del día y no se interpreta como una cancelación ni un borrado de datos de origen. Se conservaron también los dos registros de lista de espera devueltos por Booksy.

Para las líneas de cita y los bloqueos que aparecen en varias capturas diarias o semanales, el importador compara sus instantes de observación. Si un registro cambió de fecha y dejó de aparecer en el refresco de su fecha nueva, la franja antigua queda fuera de la proyección y todas las observaciones siguen en el archivo privado. Las capturas usadas para seleccionar la agenda deben incluir el conjunto completo de recursos.

La primera revisión del día utilizó `sob_booksy_rehearsal_20261117_run3`, con 607 reservas y 785 líneas en el horizonte de 53 semanas, y conserva las 1.043 capturas en el archivo privado. El respaldo actualizado se restauró en una base nueva y se verificaron sus 1.043 capturas y los datos proyectados. Solo se ha refrescado el 18/11 en esta pasada. El resto del horizonte conserva la observación anterior. El detalle de lo que falta para operar está en [la matriz de paridad](booksy-parity.md).

### Segundo refresco y ensayo del motor

Una segunda lectura del día 18 devolvió **28 reservas y 33 servicios** con los 16 recursos. En la comparación directa con la copia anterior faltaba una línea. Se conserva su observación anterior, sin inferir un cambio de estado a partir de la ausencia. Se volvieron a observar dos entradas en lista de espera. La revisión intermedia `sob_booksy_rehearsal_20261117_run4` conservó 606 grupos, 784 líneas y 1.045 capturas. Después se volvieron a leer las **53 semanas completas**, se refrescaron los detalles de dos grupos que aparecían modificados y se retuvieron las observaciones anteriores. La revisión vigente `sob_booksy_rehearsal_20261117_run5` conserva **607 grupos, 785 líneas y 1.050 capturas**. Su respaldo se restauró en una base nueva y se conciliaron bytes, campos nativos y notas. El primer día sigue teniendo 33 servicios. El fin del horizonte y el último inicio observado coinciden con la carga inicial.

En esa base restaurada se ensayó la inserción de las 785 líneas en las tablas operativas. Los 815 servicios congelados incluyen extras y se ajustan a la duración original de cada línea. Se comprobaron 762 asignaciones a recursos y 607 identificadores de grupo, incluidas las 42 reservas repartidas entre profesionales. El identificador se conserva en la agenda y en la réplica de escritorio. También se conciliaron por separado las notas internas, los comentarios de la clientela y los mensajes del centro. Para ejercitar las restricciones de PostgreSQL se asignaron dentro de la transacción las unidades mínimas que necesita el conjunto de citas. **La capacidad inferida para el ensayo no es una regla de disponibilidad de Booksy.** Se revirtió la transacción completa y se verificaron cero citas operativas persistidas.

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-rehearse-native.ts \
  sob_booksy_restorecheck_YYYYMMDD_INSTANTE HASH_SNAPSHOT
```

Usar el nombre `sob_booksy_restorecheck_...` que devuelve el respaldo, con conexión privada en loopback. El comando comprueba identidad, ventanas, recursos y metadatos del archivo y fuerza todas las restricciones diferidas antes de revertir. Solo imprime recuentos y nunca escribe datos personales en la salida. Las 26 líneas de importe desconocido se prueban con un valor transitorio en la transacción y se mantienen **sin precio conocido** en la copia de consulta. No se generan ventas, mensajes ni facturas.

La primera comprobación visual del 18/11 encontró los 33 horarios archivados y seis franjas adicionales. Cinco llevaban rótulos de bloqueo. La sexta abrió una ficha de cita cuya referencia no figuraba en el archivo. Se conservaron las observaciones sucesivas en `ui-reconciliation/`.

La lectura posterior mediante la extensión de ChatGPT cotejó **33 líneas por ID de servicio reservado, ID de grupo, profesional y horas** en la vista de profesionales trabajando. Coincidieron las 33. Las otras cuatro tarjetas correspondían a tres bloqueos y una cita confirmada. Una consulta de solo lectura a la candidata comprobó que los tres bloqueos ya estaban importados, con la misma profesional y los mismos instantes de inicio y fin.

En la cita adicional se verificaron la profesional, el servicio, el horario y el recurso asignado «Sillón». El importe de 7,50 € que Booksy muestra como «Sin cobrar» aparece bajo «Tasa de cancelación». Se conservó como evidencia y queda fuera de los cobros, facturas y ventas de Citame. La ficha actual de cliente en Booksy coincide en nombre y teléfono con el detalle de la cita. Al cotejar el identificador con el archivo local, el mismo identificador corresponde a un nombre distinto y el contacto archivado carece de teléfono.

`booksy-review-visible-booking.ts` valida las cinco observaciones privadas, la identidad, el servicio y el recurso. Por defecto se detiene ante discrepancias de identidad. `--hold-contact` crea una revisión separada con un contacto provisional, marcado como «identidad pendiente», sin teléfono ni correo y con las reservas bloqueadas. Los estados de pago y facturación permanecen desconocidos. Los bytes de las cinco observaciones se guardan en el archivo complementario junto a sus SHA-256 individuales. Para repetir el ensayo, preparar una base de ensayo vacía, aplicar el bundle de la revisión y cargar tanto el manifiesto original como el complementario antes de almacenar el snapshot. De ese ensayo se puede crear otra candidata limpia para proyectar las citas nativas.

Para repetir la comparación sin escribir en ninguna de las agendas:

```sh
cd apps/api
bun src/scripts/booksy-reconcile-calendar.ts \
  /ruta/privada/source-snapshot-HASH.json /ruta/privada/ui-reconciliation/calendar-card-ids-FECHA.json
```

El comando valida el hash del snapshot, detecta tarjetas duplicadas y escribe el comprobante privado `calendar-reconciliation-*.json`. La salida muestra recuentos. Las referencias de las diferencias se guardan en el comprobante. Una tarjeta que solo aparece en la vista queda pendiente de clasificar y la ausencia de una tarjeta no implica que se haya cancelado.

El 18/11/2026 a las 05:28, hora de Madrid, se volvió a abrir Booksy mediante la extensión de ChatGPT y se cotejaron las siete columnas. Para el 18/11 coincidieron las 34 líneas del snapshot y sus tres bloqueos. Para el 19/11 coincidieron las 41 líneas de 30 reservas y sus tres bloqueos. Cada línea se cotejó por identificador, grupo, profesional y horario. Los bloqueos coincidieron por profesional y horario. No aparecieron diferencias respecto a la candidata en esos dos días. Las dos referencias históricas ausentes del 18/11 siguieron fuera de la vista y se conservan como pendientes de confirmación en las capturas anteriores.

El cotejo del 20 al 26/11/2026 también incluyó las siete columnas. Coincidieron 171 líneas y 12 bloqueos. El 21 y el 22 estaban vacíos en ambas agendas. En la vista del 26/11 apareció una línea confirmada y un bloqueo adicionales. Se guardaron sus referencias y detalles visibles en el archivo privado.

`booksy-review-visible-block.ts` coteja la tarjeta con el detalle y prepara un snapshot suplementario para un bloqueo de profesional sin recurso asociado. La candidata `sob_booksy_candidate_20261118_1794976748` añadió el bloqueo de **14:35 a 15:35** del 26/11. En una revisión posterior se cotejaron el nombre y el teléfono de la cita adicional con la ficha de Booksy y el contacto archivado. `booksy-review-visible-booking.ts --hold-amount` conservó la reserva, su profesional y su recurso, con el importe pendiente de revisión. Booksy mostraba un descuento de 35 € y un total de 0 €. El importador conserva esos valores como evidencia y deja el estado de pago y factura sin determinar.

La candidata `sob_booksy_candidate_20261118_1794977071` contiene las **26 líneas de 18 reservas y los tres bloqueos** que se cotejaron para el 26/11. Conserva 787 líneas, 609 reservas y 57 bloqueos en el horizonte archivado. Se restauró y verificó su respaldo con 94 tablas y 1.053 originales. La carga dejó cero recibos, pagos y recordatorios. Los originales y las candidatas anteriores siguen disponibles.

Las páginas 1 a 14 de las 54 que indicaba «Lista de reservas», generado el 18/11/2026 a las 13:13, mostraron 244 líneas confirmadas y 21 canceladas con referencia, hora y estado únicos del **19 al 30/11**. De las 263 líneas archivadas en ese intervalo, 243 coincidieron por referencia de servicio reservado y minuto de inicio en Europe/Madrid. Las referencias canceladas eran distintas de las archivadas. Veinte líneas archivadas no aparecían en las páginas inspeccionadas. Las 32 líneas archivadas del 24/11 aparecían en la agenda de profesionales trabajando. En esa misma agenda apareció una línea adicional del informe, de **10:35 a 11:45**, que falta en la candidata.

El comprobante `ui-reconciliation/booking-report-reconciliation-*.json` conserva las referencias, el intervalo comprobado y el hash del snapshot. Para proyectar la línea del 24/11 todavía hacen falta las observaciones de ficha que permitan cotejar el grupo, cliente, servicio, profesional y asignación de recursos, además de las notas y el estado de facturación. Las 20 ausencias del informe requieren evidencia de agenda o ficha para determinar su estado. El selector del informe tenía diciembre deshabilitado, por lo que la comparación cubre hasta el 30/11 y sigue pendiente la prueba de cuál es la última cita.

El cotejo offline recalculó los resultados desde las 267 filas observadas y verificó los 1.053 originales del snapshot. Tras descontar dos filas repetidas, encontró 243 coincidencias por referencia, minuto local y estado. Las 20 líneas sin referencia en las páginas inspeccionadas conservan una presencia en el calendario archivado. Tres también estaban visibles en la observación de la agenda del 24/11 incluida junto al informe. Esa observación conserva el día de la agenda y el filtro, con el instante de captura sin registrar. Ninguna captura API archivada para esas 20 líneas tiene una observación de presencia con fecha igual o posterior a la generación del informe. Los 21 registros cancelados del informe tienen referencias diferentes de las líneas de la candidata. La búsqueda por referencia de la cita adicional no encontró su ficha de reserva ni su línea de calendario entre los originales del snapshot. La cita queda pendiente de completar y ningún resultado asigna un estado nuevo a una reserva.

El mismo cotejo comprobó que los 12 días entre el 19 y el 30/11 tienen al menos una captura archivada que incluye a todo el personal y los equipos del snapshot. Para cada día, la última captura completa es anterior al informe de reservas. La más reciente se tomó el 17/11 a las 22:30, hora de Madrid. El comprobante conserva por día el instante y SHA-256 de la última captura completa. Una captura parcial o una pantalla sin hora de observación puede corroborar una presencia y queda fuera del recuento de capturas completas a partir del informe.

```sh
cd apps/api
bun src/scripts/booksy-reconcile-booking-report.ts \
  /ruta/privada/source-snapshot-HASH.json \
  /ruta/privada/ui-reconciliation/booking-report-reconciliation-SHA256.json
```

El comando comprueba que informe y snapshot correspondan a la misma revisión. Escribe un comprobante privado `booking-report-offline-*.json` con las referencias y la evidencia de cada ausencia. Imprime recuentos y mantiene `canCutOver: false`. Para la candidata actual, el informe nativo del 19/11 volvió a cotejar 41 líneas de 30 reservas, 41 asignaciones físicas y tres bloqueos, dentro de las 787 líneas de 609 reservas conservadas.

La [vista local de la última candidata](http://127.0.0.1:4279/admin/calendar?date=2026-11-26&view=day) usa una restauración separada y los mismos datos de acceso que la revisión local anterior. La sesión está aislada en esta vista. El servidor web usa el build de producción, y la API de `--native-latest` escucha en `127.0.0.1:4304`. Se comprobaron las páginas autenticadas del 19, 24 y 26 con 41, 32 y 26 líneas, respectivamente, y el rechazo de escrituras en agenda, sincronización y MCP. Los servicios de consulta locales resuelven los puertos publicados en loopback al arrancar porque Docker puede reasignarlos. La consulta funciona sobre la restauración, sin conexión al origen.

Frente a la capacidad configurada en la copia, el ensayo localizó **28 periodos de exceso de ocupación en 6 profesionales** y **34 en 8 recursos**. Los periodos terminan cuando la ocupación vuelve al límite. La nueva proyección conserva las reservas previas y su ocupación con unidades internas separadas, ligadas a la franja y asignación de origen. Al calcular nuevas citas se cuenta toda esa ocupación. Una cita nueva que exceda la capacidad se rechaza y una cita que se mueva consume capacidad ordinaria en su destino.

### Candidata con citas nativas

En una copia nueva de la restauración, con todas las migraciones aplicadas y servicios desconectados, ejecutar:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-rehearse-native.ts \
  sob_booksy_candidate_YYYYMMDD_INSTANTE HASH_SNAPSHOT --prepare
```

La candidata tiene que partir con las tablas de citas y reservas vacías. El comando verifica el snapshot, la proyección y las restricciones antes de confirmar la transacción. La candidata `sob_booksy_candidate_20261117_1794956887` conserva **785 citas nativas, 607 grupos y 1.050 capturas originales**. Se cotejaron los 785 IDs, clientes, profesionales e intervalos y se comprobó que las capacidades configuradas eran idénticas a la restauración. Contiene **262 asociaciones entre 152 servicios y recursos**, de las que 82 servicios permiten elegir un recurso entre varios. Las 749 citas con reglas de recursos en el catálogo tenían exactamente un recurso asignado entre las opciones permitidas.

La [agenda de la candidata](http://127.0.0.1:4277/admin/calendar?date=2026-11-18&view=day) usa las citas nativas, con un servidor local y sesión propia. La API de consulta se ejecuta con `booksy-consultation.ts --native` y mantiene las acciones de escritura bloqueadas. El 18/11 devuelve 33 líneas nativas de 28 grupos. La [copia del archivo](http://127.0.0.1:4276/admin/calendar?date=2026-11-18&view=day) sigue disponible. La carga dejó cero recordatorios y cero recibos.

Citame bloquea el cobro de servicios de importe desconocido y deja las citas marcadas como pagadas o facturadas en Booksy pendientes de conciliación. Los 56 bloqueos archivados corresponden a personal y coinciden con los bloqueos nativos. La captura actual no contiene bloqueos exclusivos de salas o equipos. El cambio de agenda sigue pendiente de confirmar la titularidad del contacto provisional, la última cita y la cobertura de lista de espera, saldos, históricos y medios.

En Caja → **Por cobrar**, la web y la aplicación de escritorio muestran las **Citas por conciliar** para la fecha seleccionada. En escritorio, la consulta requiere conexión y empieza en el día abierto en la agenda. Cada fila indica los motivos detectados y abre su cita. Al cerrar la ficha en escritorio se recupera el día seleccionado con los datos actualizados. Una cita puede mostrar a la vez las marcas de pagada y facturada en Booksy. Esos indicadores se conservan al importar y la conciliación requiere comprobar el justificante y el saldo de origen.

Desde la ficha web o de escritorio, la persona propietaria puede confirmar en línea un pago completo ya efectuado en Booksy si la cita trae una marca de pago o factura, o si el estado del pago está pendiente de verificar. El importe se coteja con el total congelado cuando están disponibles todos los precios. La referencia del justificante y el importe se guardan en la auditoría. La cita sale de **Por cobrar** y permanece bloqueada para un cobro nuevo en Citame. La operación rechaza las citas con un recibo activo de Citame. Escritorio conserva el estado conciliado tras sincronizar y lo muestra sin conexión.

An owner can also verify a full Booksy payment after Citame has fully refunded its receipt. Citame checks that every captured payment was returned and that no bank order or refund attempt can still change the amount held, including on void receipts. A failed hosted bank order can still receive a late capture and keeps this review blocked. An existing Citame deposit also blocks review. The recorded review references the refunded receipt, which stays in the transaction history. The calendar shows the confirmed Booksy payment.

Un pago de origen desconocido mantiene la cita en **Citas por conciliar**. La preparación de la importación mantiene ese bloqueo cuando faltan los detalles de pago del grupo o requieren conciliación, aunque la agenda de origen indique que el servicio está sin pagar. Si el registro de pagos confirma que no hubo un cobro previo, la persona propietaria abre **Verificar que no hubo un pago previo** en la ficha y guarda la referencia comprobada. Citame conserva el dato de origen y retira ese motivo de bloqueo. La ficha permite corregir la revisión si aparece un justificante de pago posterior. Si cambian los indicadores de pago del origen, Citame vuelve a evaluar el bloqueo. Las notas y los cambios de horario conservan la revisión.

Para un pago parcial, la persona propietaria usa **Conciliar pago parcial de Booksy** en la ficha web o de escritorio con conexión. Citame consulta el total verificado en euros y comprueba si hay un recibo activo o depósito. El justificante queda en la auditoría. Caja abre un recibo de saldo únicamente por la diferencia. Las promociones, propinas y bonos requieren un flujo separado. Los pagos y devoluciones nativos se limitan al saldo cobrado en Citame. Escritorio muestra los importes sincronizados sin conexión. La actualización de la réplica incorpora el origen Booksy a las citas ya sincronizadas y conserva su versión. Una discrepancia con el total congelado o un pago externo adicional requiere revisión.

A change to the imported payment evidence puts the remaining balance back in review in Cloud and Desktop. The owner can confirm a new partial or full payment against the updated evidence. Review existing Citame receipts or deposits first. Changes to appointment times or notes preserve the payment review.

If every Citame payment and refund for the previous balance is resolved and all captured funds were returned, the owner can confirm the corrected partial payment. The old receipt remains refunded in transaction history. The appointment returns to **Por cobrar** with the updated balance, and Caja creates one new receipt for that balance when opened. Pending deposits or unresolved bank orders still block review.

When a new payment document leaves the paid and invoiced flags unchanged, the owner can include `paymentEvidenceChanged: true` on that booking's row in the Booksy context import. The preview counts the partial and confirmed-unpaid reviews it will reopen, whether the source flags change or the owner explicitly marks new evidence. For past bookings, the owner can mark evidence on an existing mapped service while preserving its source reference, notes, comments and professional preference. Applying the same reviewed import again preserves the result.

En una instalación operativa, la persona propietaria puede registrar desde la ficha los precios comprobados en euros, antes de descuentos, junto a la referencia del justificante. Citame conserva el precio original y su indicador y guarda la revisión en el registro de auditoría. El siguiente borrador usa los importes revisados. La confirmación del importe no abre un recibo ni registra un pago. Un recibo activo de Citame o un pago externo ya conciliado impiden cambiar el precio. Si la cita tiene una marca de pago o factura de Booksy, el propietario puede confirmar primero los importes originales. El bloqueo de cobro se mantiene hasta conciliar el pago de origen.

El resumen de citas realizadas incluye los importes conocidos de cada servicio. Una vez guardada la conciliación, el importe revisado entra en el total y en los desgloses por día, profesional y servicio. Web y escritorio indican cuántos servicios realizados tienen el precio pendiente para los filtros seleccionados. Las líneas pendientes cuentan para la actividad y sus importes quedan fuera de las sumas. Si hay importes pendientes, ambos CSV añaden la columna `unpriced_services` a los bloques por día, servicio y profesional. Los cobros se consultan por separado en las transacciones de caja.

Escritorio muestra el importe de cada servicio y las marcas de pago y factura en su réplica de agenda. Si el importe de origen sigue pendiente, la ficha indica «Importe original desconocido». La persona propietaria puede revisar el importe desde la web o desde escritorio con conexión. El importe revisado aparece tras sincronizar la cita y se conserva sin conexión. Las referencias de justificantes y las anotaciones privadas de origen quedan en el servidor.

Para preparar esa revisión desde la copia archivada:

```sh
cd apps/api
bun src/scripts/booksy-review-prices.ts /ruta/privada/source-snapshot-HASH.json
```

El comando verifica el snapshot y los originales. Guarda un comprobante `price-review-*.json` con permisos 0600 en el directorio del snapshot. Cada fila identifica la reserva, el servicio y su posición, y enlaza los SHA-256 de la evidencia. Incluye la fecha local de inicio, la cita de Citame y la ruta relativa `calendarPath` para abrirla en la instalación que use esa candidata. `pendingByDate` permite priorizar los servicios pendientes por jornada. El comprobante separa el total de la reserva, los importes explícitos de servicios y la evidencia de pago. La salida de terminal muestra recuentos y el nombre del comprobante.

En la última copia hay **27 servicios pendientes en 23 reservas**. En 22, el total coincide con la suma de los servicios de precio visible y el precio del servicio pendiente aparece oculto. Una reserva muestra un descuento y un total de cero. Para conciliar cada servicio hace falta su importe de origen antes del descuento o un justificante que lo identifique expresamente. El comprobante conserva los bloqueos de cobro y mantiene `canCutOver: false`.

El cotejo local verificó los 1.053 originales del snapshot y las 27 correspondencias con PostgreSQL, repartidas en 16 jornadas. Ninguno de los 13 snapshots locales tiene un precio numérico para esas líneas. El validador de la agenda web aceptó los 27 enlaces del comprobante.

Para obtener la lista privada de una jornada en una candidata cargada, usar el mismo snapshot que se importó:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-candidate-report.ts \
  HASH_SNAPSHOT FECHA_LOCAL --price-review /ruta/privada/source-snapshot-HASH_SNAPSHOT.json
```

El comando coteja todos los originales y la candidata local en una transacción de solo lectura para la consulta de PostgreSQL. Incluye las citas que se solapan con la jornada en la zona horaria del centro, aunque comenzaran el día anterior. Verifica cada referencia de reserva, cita y posición de servicio y añade el ID del servicio nativo. El archivo `native-price-review-*.json` se guarda con permisos 0600 junto al snapshot. La salida solo muestra el nombre del comprobante y el informe agregado de la candidata. Cada línea conserva el enlace a su cita y sigue pendiente hasta comprobar el importe original.

Para revisar toda la agenda capturada en una sola comprobación, usar `--price-review-all`:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-candidate-report.ts \
  HASH_SNAPSHOT FECHA_LOCAL_EN_EL_SNAPSHOT --price-review-all /ruta/privada/source-snapshot-HASH_SNAPSHOT.json
```

La fecha selecciona el resumen de la jornada. El comprobante privado `native-price-review-all-*.json` cubre el horizonte completo y agrupa las líneas pendientes por fecha de inicio en `pendingByDate`. Cada línea se vincula a una sola fila de servicio de la candidata. El informe de terminal incluye el recuento en `priceReviewServices`. El comprobante conserva los bloqueos de cobro y el estado `canCutOver: false`.

To prepare the billing review for the whole imported calendar, use the snapshot hash and the private connection file for the verified copy:

```sh
cd apps/api
bun --env-file=/private/connection.env src/scripts/booksy-candidate-report.ts \
  HASH_SNAPSHOT LOCAL_DATE --billing-review /private/review-directory
```

For an editable rehearsal copy, append its `citame-booksy-rehearsal-YYYYMMDD` container name. The command reconciles the native projection and the archived payment flags in one read-only transaction. The private receipt groups pending appointments by local start date and lists checkout hold reasons and a Cloud calendar link for each appointment. The terminal prints the receipt name and the appointment count. Confirm each payment or price through the appointment detail with its supporting evidence. The receipt keeps `canCutOver: false`.

Rerun the report as financial reviews are saved. On an editable rehearsal, the command matches each reviewed price to its audit entry and traces corrected Booksy payment flags from the archived flags through the owner's before-and-after audit entries. The calendar and service fields still have to match the archive. The day summary describes the archived evidence, and the private pending list uses the reviewed local state. Older context imports saved only batch totals. If an earlier import changed a flag and its history cannot be verified, reconcile against a verified compatible snapshot before using the report.

El cotejo de toda la candidata verificó los 1.053 originales y las 27 filas nativas de precio pendiente, correspondientes a 23 reservas en 16 jornadas. En el resumen del 20/11/2026 figuran 47 líneas de 38 reservas y tres servicios con importe pendiente. El informe de traducción y cobertura distingue 208 observaciones de origen que ya tienen una correspondencia nativa registrada: 152 registros de alternativas de recursos y 56 originales de bloqueos. El corte sigue pendiente de la extracción final, la conciliación financiera, el respaldo externo y la aceptación del centro.

La [agenda de revisión disponible en el navegador](http://127.0.0.1:4278/admin/calendar?date=2026-11-18&view=day) usa `sob_booksy_candidate_20261117_1794960976` y el snapshot `3a9c786321f3c2470b77819ca261b06bc0800722c0937cf0f79cbbc49478cdd7`. Tiene **786 líneas de 608 reservas** y una asignación adicional al Sillón. Se verificaron las 34 líneas del 18/11, los tres bloqueos del día y la etiqueta «identidad pendiente» en la respuesta HTML. Se cotejaron las 785 citas anteriores, sus 815 servicios y anotaciones, los 56 bloqueos, los 6.377 perfiles, las 262 reglas y las 762 reservas de recursos entre ambas candidatas. La cita adicional queda en un perfil separado del contacto archivado. La API local rechaza escrituras y la API y el worker operativos rechazan arrancar apuntando a bases de ensayo, restauración o candidata.

La candidata de catálogo `sob_booksy_candidate_20261117_1794971382` conserva las 786 líneas y los 1.051 originales en el snapshot `e5d990c5142ab881fed12092929e37fb39344c6978f208a2053eb05c8ff1d6fc`. Importa 76 relaciones explícitas para ocho extras y deriva sus profesionales de los servicios base. Siete extras con disponibilidad pública en el origen ofrecen huecos en el ensayo y solo se pueden elegir junto a un servicio compatible. Citame admite una unidad por selección. El extra con visibilidad restringida y los trece sin servicios explícitos quedan disponibles para revisión del catálogo. Los cinco extras de precio variable se conservan en el archivo privado. Se restauró el respaldo de esta candidata en `sob_booksy_restorecheck_20261117_1794971411946` y se cotejaron las 94 tablas.

La candidata `sob_booksy_candidate_20261117_1794971660` conserva los datos anteriores y deja inactivos los seis combos de origen. Los seis tienen un precio inferior al de sus componentes por separado. La suma de los precios de los componentes dentro del combo coincide con el total de origen y uno requiere una asignación de profesionales distinta. Las ofertas actuales de Citame usan los precios de catálogo por servicio. Los seis combos se pueden consultar en el catálogo de gestión con sus importes y duración. Los componentes ordenados y sus condiciones originales siguen en el archivo privado. Se verificó que el snapshot `0cd247b42ebed670887052a55093a7503d98aee91bc73809e01c18f4b61a5835` conserva exactamente las 786 líneas, los 608 grupos y los 1.051 originales.

Para aplicar esta revisión a un snapshot privado existente y conservar los ajustes manuales ya verificados, usar su hash con el siguiente comando. El comando coteja sus originales, genera nuevos archivos privados y deja disponibles ambas revisiones.

```sh
cd apps/api
bun src/scripts/booksy-prepare-full.ts /ruta/privada ID_CENTRO FECHA_LOCAL \
  --hold-combos HASH_SNAPSHOT
```

To review the terms before publishing combinations, run
`bun --no-env-file src/scripts/booksy-review-combinations.ts /private/source-snapshot-HASH.json`
from `apps/api`. The command verifies the snapshot's artifacts and compares its terms to
a fresh projection of the archived catalogue. It writes a private `combination-review-*.json`
receipt with ordered components, allocated prices, total price, duration, buffers and source
staff. It also records the professionals qualified for every component individually.
Ambiguous references and inconsistent totals are flagged. The receipt also prepares inactive
native drafts with stable identifiers for the ordered services, assigned professionals and
the allocated prices. The catalogue administration API returns drafts after a separate
catalogue write. A write from an older client preserves the terms unless the treatment
order changes, which requires a review.
The review leaves the combination's publication status and appointments intact.

Clients that support fixed-price combinations request `fixedTerms=1` from the
combination catalogue. A published combination selects a single assigned professional
and preserves the order of the EUR-priced components. Publishing a draft requires an
explicit online-visibility choice, including when it predates the visibility setting.
For a public combination, use its ID on availability and price queries. Centre accounts
can discover eligible combinations at `/appointments/combinations` and use
`/appointments/combination-availability` and `/appointments/peak-price` for internal options.
The price response carries the version and review hash required when submitting a booking.
Fixed prices exclude catalogue peak surcharges. Checkout uses the component amounts frozen on
the appointment. A move uses the booked professional list and the original service amounts.

In Web, open **Services → Combinations** to enter the EUR amounts in treatment order,
choose the assigned professionals and set the visibility. Customers retain a fixed
combination through service, professional and slot selection. To book an internal
combination, choose it in **Calendar → New appointment**. A fixed combination keeps its
allocated price through checkout and appears only on the booking surfaces allowed by its
visibility.

Desktop can select the same options in **Calendar → New appointment** after syncing its
scoped booking catalogue. Online and queued offline bookings send the same reviewed price
and professional allocation. If the offer changes before delivery, the proposal remains
in **Sync conflicts** for review.

#### Conciliación de una candidata ya cargada

El informe vuelve a comprobar la copia persistente dentro de una transacción de solo lectura. Coteja la identidad y los horarios de cada línea, los grupos, los importes congelados y sus indicadores, los comentarios, las franjas de capacidad reservadas, las asignaciones de recursos, los bloqueos y la lista de espera con el snapshot seleccionado. También comprueba los SHA-256 del archivo y coteja los identificadores, recuentos y huellas de los perfiles, el catálogo, las asignaciones profesionales y los horarios materializados. Verifica que la candidata no tenga recibos, recordatorios, ofertas ni lista de espera activa. Solo devuelve recuentos y estados de evidencias.

El informe agrupa las incidencias del plan por motivo y entidad. Los precios pendientes se cuentan por servicio, línea de agenda y reserva. Los indicadores de pago y factura se cuentan por línea de agenda como positivo, negativo explícito o desconocido. Un indicador de pago negativo acredita lo que mostró la agenda, sin sustituir el histórico de caja ni la evidencia de factura.

`scheduleByStart` desglosa el horizonte archivado por fecha local de inicio, identificador interno de profesional y estado. Incluye líneas de agenda, reservas distintas dentro de cada fila y servicios congelados, incluidos extras. Una reserva repartida entre varias profesionales, estados o fechas puede figurar en varias filas. Para el total de reservas únicas se usa `candidate.visitGroups`. El detalle del día seleccionado sigue incluyendo las citas que estaban en curso a medianoche.

En la copia local revisada, una consulta independiente en PostgreSQL, en modo de solo lectura, cotejó las 214 filas del desglose. La candidata contiene 787 líneas de agenda y 817 servicios congelados en 609 reservas únicas, distribuidas en 51 fechas con inicios observados. Se comprobaron 1.053 originales archivados. El desglose mantiene pendiente la prueba de fin de cobertura.

Para comprobar una reserva concreta, añadir `--booking-links /ruta/privada` al comando de informe. El directorio debe existir y ser privado, con permisos 0700. El comprobante `native-booking-links-HASH.json` conserva el grupo de origen y su identificador nativo, cada referencia de línea Booksy y su cita de Citame, y el identificador y posición de cada servicio congelado dentro de esa cita. La posición cero corresponde al servicio principal y las restantes a los extras, en el orden verificado. El archivo se vincula al snapshot y a la base candidata, se guarda con permisos 0600 y nunca sustituye un comprobante diferente. La salida normal conserva el resumen. El comprobante contiene referencias de reserva y debe permanecer en el archivo privado.

El ensayo local cotejó los 817 identificadores y posiciones de servicio contra PostgreSQL en modo de solo lectura. El comprobante cubrió 609 reservas y 787 líneas, incluidas 122 reservas con más de una línea. Repetir el comando conservó el mismo archivo y un directorio accesible por otros usuarios fue rechazado.

Para el 19/11, la candidata tiene 41 líneas en 30 reservas y un servicio sin precio confirmado. En toda la captura hay 27 servicios sin precio en 23 reservas, 787 líneas sin estado de factura acreditado y dos líneas sin indicador de pago. Las otras 785 líneas tienen un indicador de pago negativo. Hay dos solicitudes de lista de espera, 28 períodos de solapamiento profesional y 34 de recursos. Entre las 265 incidencias del plan, el informe identifica 56 originales de bloqueos que tienen un bloqueo nativo verificado y 152 registros de recursos alternativos cuyos servicios tienen reglas nativas verificadas. Se conservan los originales y los límites de cobertura del plan. El comprobante privado se guarda en `cutover-evidence.*`.

La preparación contrasta el tratamiento y la preferencia de profesional entre el calendario y la ficha de Booksy. En la restauración, las fichas con identificador de reserva deben aportar el tratamiento, el profesional, los dos instantes, el indicador de preferencia y el importe principal, incluido el marcador de importe oculto. Si falta un campo o discrepa de la línea congelada, el ensayo se detiene. Las dos líneas obtenidas por revisión visual se comprueban con sus propios justificantes. El archivo vigente permite reconstruir 785 líneas con ficha en 607 reservas. La candidata conserva 787 líneas en 609 reservas al incorporar las dos líneas revisadas.

El 21/11 se repitió la proyección desde los 1.053 originales con la comprobación del alcance de cada petición. El resultado coincidió íntegramente con la proyección anterior, incluidas las 785 líneas con ficha. La auditoría de las 368 fechas del 21/11/2026 al 23/11/2027 encontró observaciones completas anteriores al corte del ensayo para todas ellas y cero observaciones posteriores al corte. Se mantiene la candidata con sus dos líneas verificadas visualmente y sigue pendiente acreditar la última cita real.

`booksy-audit-calendar-window.ts` compara también las líneas de cada jornada de inicio en Europe/Madrid con la última observación sin filtros y con el conjunto completo de recursos. Un movimiento a otro día se cuenta una vez como cambio de hora. La auditoría falla si las últimas observaciones completas de una jornada se contradicen. El comprobante privado identifica referencias ausentes, inesperadas y con cambios de hora. La terminal muestra recuentos separados según el corte de frescura. El resultado mantiene las ausencias pendientes de contraste y conserva `canCutOver: false`. Una diferencia puede corresponder a una línea recuperada por otra evidencia, como un informe contrastado con el calendario visible.

The audit also reports staff changes when the booking time is unchanged. The private receipt marks an assignment as unverified when the capture cannot identify one professional, includes an unknown resource, or matches a snapshot line whose professional cannot be identified. The terminal prints counts for both categories.

```sh
bun --no-env-file apps/api/src/scripts/booksy-audit-calendar-window.ts \
  /ruta/privada/source-snapshot-HASH.json FECHA_INICIAL FECHA_FINAL INSTANTE_DE_CORTE
```

El rango de jornadas es inclusivo y el instante de corte incluye zona u offset ISO 8601. El comando lee el snapshot y sus originales locales. Si una línea ausente del calendario completo tiene evidencia visual revisada, utiliza también el snapshot padre local para reconstruir y cotejar la proyección. La evidencia de una cita individual queda registrada por separado y mantiene vigentes los requisitos de cobertura.

Las fichas también deben incluir la lista de extras. La reconstrucción y la restauración usan el mismo cálculo de precio y duración por cantidad. Cada extra conserva su posición, nombre, importe y duración de origen. Si el catálogo actual carece de esa referencia, el extra se conserva en la cita con su nombre e importes históricos. La comprobación se detiene si cambia la lista o algún dato congelado. Los 30 extras reservados coinciden en el archivo y en la candidata. Todos tenían cantidad uno en esta captura. El ensayo sintético cubre también cantidad múltiple y referencias retiradas del catálogo.

La captura vigente no contiene intervalos de procesamiento que liberen a la profesional. La conciliación exige que las líneas congeladas y sus ventanas de trabajo reflejen esa ocupación, que las reservas de capacidad estén activas según el estado de cada cita y que cada unidad asignada respete su límite o su asignación importada. Si una futura captura contiene tiempos de procesamiento, el importador se detiene hasta que exista una traducción verificada.

La agenda contiene 47 combos ya reservados. La conciliación compara en céntimos cada total de Booksy con la suma de sus componentes y coteja los importes de los 98 componentes congelados. El combo agrupa esos importes sin generar una línea adicional de cobro. Ninguno de los componentes trae marca de pago y los 98 carecen de evidencia de factura en esta captura. La conciliación de importes deja pendiente esa comprobación de facturación.

En los 608 grupos de la candidata hay 234 autorizaciones con cero euros cobrados y todo el importe aún pendiente, 373 grupos con detalle que indica que no hay depósito y un grupo sin detalle de pago. Los registros se conservan en el archivo original. La preparación nativa se detiene ante depósitos cobrados, referencias de transacción o estados contradictorios que requieran conciliación. Antes de cerrar la transacción, comprueba que la carga haya dejado cero recibos, pagos, depósitos nativos, tasas de cancelación y recordatorios.

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-candidate-report.ts \
  HASH_SNAPSHOT 2026-11-18
```

La candidata más reciente concilia 34 líneas de 29 reservas para el 18/11, 33 asignaciones físicas y tres bloqueos. En el horizonte archivado concilia 786 líneas, 608 reservas, 816 servicios congelados, 763 asignaciones y 56 bloqueos. Verifica 1.051 originales, 6.378 perfiles de cliente, siete profesionales, 187 servicios, 395 asociaciones entre servicios y profesionales y 51 tramos de horario. También coteja 93 productos, sus 93 movimientos de saldo inicial y nueve recursos físicos. El informe rechaza filas adicionales de estos tipos y reservas de stock. Siguen pendientes dos solicitudes de lista de espera, una identidad y 26 líneas con importe desconocido. El informe separa la conciliación de los datos capturados de la prueba de cobertura completa. La exportación final, la recuperación externa y la aceptación del corte se validan en un procedimiento separado.

La API operativa, el worker, la inicialización del propietario, el mantenimiento, el migrador de Compose y la carga de datos de ejemplo rechazan una base que contenga el esquema de revisión, incluso si el respaldo se restablece con un nombre normal. El migrador hace esta comprobación antes de aplicar cambios. Los ensayos de recuperación conservan su ruta de migración aislada. Un destino operativo futuro requiere una base preparada y verificada para esa función, con la copia de revisión conservada aparte.

Los comandos de consulta, archivo, importación y recuperación verifican el host, puerto y base de su URL privada antes de abrir la conexión. Si el entorno o los parámetros de conexión cambian alguno de esos destinos, el comando se detiene. PostgreSQL confirma además el nombre real de la base antes de que el comando pueda usarla.

Si Docker reasigna el puerto local del contenedor de ensayo, actualizar la conexión con el archivo privado existente:

```sh
cd apps/api
bun src/scripts/booksy-private-db.ts --refresh-connection /ruta/privada/connection.env
```

El comando exige un socket local de Docker y un único puerto en `127.0.0.1` para el contenedor identificado por la fecha. Después confirma el nombre de la base en PostgreSQL. Si cambia el puerto, escribe `connection-<base>-port-<puerto>.env` con permisos 0600 y conserva el archivo anterior. El resultado indica la ruta en `connectionFile`, que se puede pasar como `--env-file` al repetir el ensayo o el informe de la candidata. Se reutiliza un resultado existente si sus bytes coinciden. La salida omite las credenciales.

#### Recuperación de la candidata nativa

El respaldo de la candidata se restauró en `sob_booksy_restorecheck_20261117_1794959733245`. Se cotejó el contenido de 94 tablas con la misma instantánea que leyó `pg_dump`. La restauración conserva las 785 líneas de 607 grupos, los 815 servicios congelados, las 762 asignaciones a recursos, los 56 bloqueos y las dos solicitudes de lista de espera pendientes. Se comprobó de nuevo el SHA-256 de los bytes originales de las 1.050 capturas. La restauración tiene cero ofertas y cero recibos.

El respaldo de la candidata más reciente se restauró en `sob_booksy_restorecheck_20261117_1794961031866`. La comparación de las 94 tablas verificó las 786 líneas, el contacto provisional y las 1.051 capturas, con cero recibos y cero ofertas. El respaldo protegido mide 27.650.122 bytes y tiene SHA-256 `a494f063595a95357d9a2c7a965db98adaca208ac0791a02d373779769f7c333`.

Para repetir la prueba, usar el directorio privado de la candidata y el hash de su snapshot:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-backup.ts \
  --candidate HASH_SNAPSHOT /ruta/privada
```

El comando solo acepta la candidata del contenedor local de ensayo. Crea el `.dump` y su comprobante `candidate-recovery-*.json` con permisos 0600. Restaura en una base nueva, verifica el contenido y coteja cliente, profesional y horas de cada línea nativa con el snapshot. Las dos bases permanecen separadas. El respaldo comprobado mide 27.640.367 bytes y su SHA-256 es `931ca4dfc0657e12b895db955fa0e1225eaf9bb23b9402c6951ff0b265153e72`. La prueba y el respaldo son locales. Sigue pendiente una copia cifrada fuera de este equipo antes del corte.

#### Copia cifrada y recuperación en otro PostgreSQL

`booksy-portable-backup.ts` cifra el dump verificado con OpenPGP para la huella completa de una clave de recuperación. Produce un archivo `.dump.gpg` y un comprobante con sus hashes, tamaños y la huella del contenido de las tablas. El proceso necesita GnuPG. La clave privada, los archivos de conexión, las contraseñas locales y los secretos de entorno se custodian por separado. [Manual de cifrado de GnuPG](https://gnupg.org/documentation/manuals/gnupg/Operational-GPG-Commands.html).

```sh
cd apps/api
bun src/scripts/booksy-portable-backup.ts seal \
  /ruta/privada/candidate-recovery-FECHA.json /ruta/privada/cifrado /ruta/llavero HUELLA_PUBLICA
bun src/scripts/booksy-portable-backup.ts restore \
  /ruta/recibida/candidate.dump.gpg /ruta/recibida/candidate.dump.gpg.json \
  SHA256_CIFRADO_REGISTRADO /ruta/llavero 2026-11-18
```

En la restauración se compara el SHA-256 del cifrado con el valor anotado por separado. Se valida la integridad OpenPGP y se compara el SHA-256 del dump descifrado antes de ejecutar PostgreSQL. El comando usa otra instancia de PostgreSQL 18, desechable y en loopback, y se detiene si Docker apunta a otro equipo. Coteja todas las tablas y vuelve a ejecutar la conciliación del snapshot. La lista de espera se reconstruye a partir de los originales archivados, tras comprobar sus bytes y SHA-256 contra el snapshot. Si la clave necesita contraseña, se puede indicar un archivo privado con `BOOKSY_RECOVERY_PASSPHRASE_FILE` en el equipo que restaura. El destino de recuperación debe estar separado del original y la clave debe mantenerse bajo control de la persona responsable.

La prueba del 18/11/2026 copió el archivo cifrado y su comprobante a otro directorio local y recuperó el dump en un contenedor PostgreSQL nuevo. Coincidieron las 94 tablas, las 786 líneas de agenda y los 1.051 archivos de origen. El comprobante de recuperación se guardó junto al cifrado. Se usó un llavero local separado para esta prueba. La custodia definitiva de la clave y la restauración desde almacenamiento fuera de este equipo siguen pendientes antes de un corte operativo.

#### Reservas de prueba en la agenda recuperada

El comando de recuperación admite `rehearse-schedule` con los mismos argumentos que `restore`. Primero coteja el respaldo con su esquema original y, solo en el PostgreSQL desechable, aplica las migraciones pendientes y vuelve a conciliar la agenda. La fecha seleccionada debe tener tramos de exceso de capacidad profesional y de equipos, y una cita importada confirmada con precio conocido y equipo asignado que pueda moverse dentro del día. El ensayo prioriza una cita con capacidad histórica y recorre la cuadrícula usando el servicio real de reprogramación. El informe usa el reloj de la víspera de ese día, los límites y horarios de la copia y una huella separada para el estado ya migrado.

Para el 18/11, la búsqueda de disponibilidad ocultó dos inicios con exceso de capacidad profesional y tres con exceso de capacidad de equipos. El motor rechazó al intentar reservar cada uno. También confirmó una reserva ordinaria en una franja libre de cada tipo. El cliente, los servicios y el operador de prueba son sintéticos. Citame mantiene las 26 citas con importes desconocidos bloqueadas para cobro.

Tras revertir la transacción, las huellas de todas las tablas deben coincidir con la referencia tomada después de migrar. La huella original del respaldo se verifica antes de migrar. El informe separa esta prueba del corte y de la verificación de proveedores de mensajes y pagos.

El ensayo coteja el número de entradas, el instante y el SHA-256 de cada migración registrada en el PostgreSQL recuperado con los archivos SQL de la versión ensayada. Si encuentra una diferencia, termina antes de ejercitar la agenda. El comprobante incluye el total de migraciones verificadas y el instante y hash de la última.

El ensayo del 18/11 con el respaldo cifrado anterior a la migración `0056` verificó primero las 94 tablas originales y los 1.051 archivos. Después aplicó la migración a la copia desechable y volvió a conciliar la proyección. Tras las cinco negativas de capacidad y las dos reservas sintéticas, las 94 tablas conservaron la huella posterior a la migración. El comprobante `recovery-migrated-schedule-*.json` se guardó junto al cifrado.

Con la candidata de catálogo y combos más reciente, la recuperación local cifrada cotejó el 19/11/2026 y encontró 41 líneas de 30 reservas, 41 asignaciones físicas y tres bloqueos. Se verificaron las 94 tablas y los 1.051 originales. En otro ensayo se aplicaron las migraciones hasta `0059` y se comprobó el feed de escritorio. El feed entregó las 786 líneas tanto desde cero como desde el cursor anterior a las migraciones. Coincidieron cliente, profesional, horario y versión de cada línea y se comprobaron 298 indicadores de servicio sin incorporar el contenido de las notas al feed. Tras las reservas sintéticas, las 94 tablas conservaron su huella posterior a la migración. El cifrado usó una clave local de ensayo.

La recuperación cifrada de `sob_booksy_candidate_20261118_1794977071` cotejó las 94 tablas y los 1.053 originales. Tras aplicar hasta `0061` en PostgreSQL desechable, el feed de escritorio entregó las 787 líneas de 609 reservas y se comprobaron 298 indicadores. El ensayo del 18/11 rechazó dos inicios por capacidad profesional y tres por capacidad de equipos, y aceptó una reserva ordinaria de cada tipo. Las 95 tablas conservaron su huella posterior a la migración al revertir el ensayo. Quedaron protegidas de cobro las 27 citas con importes sin resolver. La clave OpenPGP fue de ensayo local. Siguen pendientes la custodia externa y el cotejo de la captura definitiva de Booksy.

Al repetir la recuperación con la lectura de originales para la lista de espera, se cotejaron las dos solicitudes, las 211 fechas observadas y los 1.053 archivos. El ensayo conservó las huellas de las 96 tablas después de aplicar las migraciones y revertir las reservas sintéticas. El comprobante local `waitlist-recovery-*.json` se guardó junto al cifrado.

Tras aplicar hasta `0063` en otro PostgreSQL desechable, el mismo respaldo cifrado volvió a conciliar las 787 líneas de 609 reservas, los 1.053 originales y los 298 indicadores. El feed cotejó los 166 colores configurados con el catálogo restaurado y entregó esos mismos colores a partir del cursor anterior a la migración. Las 96 tablas migradas conservaron su huella tras revertir las reservas de ensayo. La recuperación se hizo en este equipo con la clave de ensayo local.

El ensayo `migration-lock-recovery-*.json` repitió la restauración cifrada y la conciliación con el migrador que serializa el acceso al diario de PostgreSQL. El mismo respaldo recuperó las 787 líneas, 298 indicadores y 166 colores. Tras migrar hasta `0064`, la reversión de las reservas de ensayo conservó la huella de las 96 tablas en el PostgreSQL desechable.

El comprobante local `current-release-recovery.*` verificó el mismo respaldo con las migraciones hasta `0067`. Cotejó las 94 tablas originales, los 1.053 archivos y las 787 líneas de 609 reservas, junto con 57 bloqueos y dos solicitudes de lista de espera pendientes de revisión. La réplica recibió los 166 colores desde el cursor anterior y mantuvo los 298 indicadores sin repetir líneas de agenda. El motor rechazó cinco inicios que excedían la capacidad, aceptó dos reservas sintéticas en franjas libres y conservó la huella de las 97 tablas migradas al revertirlas. Se mantienen 27 citas con importe sin resolver bloqueadas para cobro. El ensayo corresponde a la captura local disponible y la custodia externa sigue pendiente.

El comprobante local `operational-recovery.*` repitió la restauración con Bun 1.4.4 y ejercitó los servicios de reprogramación y caja. El 18/11 se cotejaron 34 líneas de 29 reservas, 33 asignaciones de equipo y tres bloqueos. Una cita se movió dentro del día a una profesional sintética y pasó de capacidad histórica a ordinaria para profesional y equipo. Conservó cliente, grupo, duración, franjas de trabajo, servicios, notas, profesional solicitada y asignación de equipo. Se rechazaron tanto el intento inicial con una profesional sin servicio asignado como otro con una versión anterior de la cita.

El servicio rechazó abrir cobro para las 27 citas con importes pendientes. En la captura local no había citas con marca positiva de pago o factura. Ambas ramas se probaron con marcas sintéticas por separado y se revirtieron. La cita reprogramada generó un recibo de ensayo con el precio reservado y todo el saldo pendiente. Tras revertir el ensayo coincidieron las huellas de los datos de las 97 tablas migradas. La instancia desechable se eliminó. El ensayo ejecutó los servicios directamente, sin worker ni pasarelas, y el informe mantuvo `canCutOver: false`.

El comprobante local `release-ledger-recovery.*` verificó las 69 migraciones hasta `0068_inventory_product_photo`. Restauró las 94 tablas originales y verificó los 1.053 archivos de origen. La réplica entregó las 787 líneas de agenda. Las 98 tablas migradas conservaron su huella al revertir el ensayo. La restauración independiente `next-day-recovery.*` concilió el 19/11 con 41 líneas de 30 reservas, 41 asignaciones de equipo y tres bloqueos. Ambas pruebas utilizan el respaldo de la candidata conservada en este equipo.

Los comprobantes locales `review-email-ledger-recovery.*` y `next-day-0070-recovery.*` verificaron las 71 migraciones hasta `0070_isolate_review_campaigns` sobre el mismo respaldo cifrado. Comprobaron las 94 tablas originales y los 1.053 archivos, y conservaron la huella de las 98 tablas migradas al revertir los cambios sintéticos. El 18/11 se cotejaron 34 líneas, 33 asignaciones de equipo y tres bloqueos. El 19/11 se cotejaron 41 líneas, 41 asignaciones de equipo y tres bloqueos. El motor rechazó el inicio con exceso de capacidad profesional y los tres inicios con exceso de capacidad de equipos, y aceptó una reserva ordinaria de cada tipo. Si las profesionales con solapamientos tienen la agenda llena, la reserva de control puede utilizar otra profesional activa de la copia. La custodia externa y el cotejo de la captura final siguen pendientes.

Los comprobantes `live-view-0071-2026-11-18.*` y `live-view-0071-2026-11-19.*` repitieron ambos ensayos con las 72 migraciones hasta `0071_review_request_live_view`. El verificador aceptó los dos comprobantes para sus fechas y mantuvo `canCutOver` en falso.

Los comprobantes `moderation-0072-2026-11-18.*` y `moderation-0072-2026-11-19.*` volvieron a validar ambos ensayos con las 73 migraciones, incluida la actualización en directo de la moderación. El verificador aceptó los comprobantes para cada fecha. El estado del corte sigue siendo `canCutOver: false`.

El ensayo con las 74 migraciones hasta `0073_inventory_package_content` recuperó las 787 líneas de 609 reservas y cotejó los 1.053 originales y los 93 productos. Para el 18/11 concilió 34 líneas de 29 reservas, y para el 19/11, 41 líneas de 30 reservas. En cada recuperación se probó una entrega y un recuento sobre un producto de la candidata, con una unidad reservada por una venta sintética y un contenido por envase conocido. El servicio rechazó la generación y la versión obsoletas, una cuenta diferente, un reintento con otra cantidad y un recuento por debajo de las unidades reservadas. El reintento idéntico de la entrega creó un solo movimiento. La reversión retiró la venta y los movimientos de ensayo y conservó las huellas de las 98 tablas migradas.

Los comprobantes de `rehearsal-0073-stock-verified.*` se guardan en el directorio privado del respaldo cifrado. El verificador exige evidencia de inventario cuando la candidata incluye productos. Para actualizar comprobantes anteriores hay que repetir el ensayo. La custodia externa, la extracción final y la aceptación del corte quedan pendientes.

Los comprobantes privados `rehearsal-0074-ledger-verified.*` del 18, 19 y 20 de noviembre verificaron las 75 migraciones. Los tres cotejaron las huellas de las 94 tablas del respaldo, 1.053 archivos de origen, 787 líneas de 609 reservas, 93 productos y dos solicitudes de lista de espera. Los ensayos devolvieron 34 líneas de 29 reservas el 18, 41 líneas de 30 reservas el 19 y 47 líneas de 38 reservas el 20. Para el 20 se cotejaron 46 asignaciones físicas y un bloqueo. Tres reservas de ese día siguen pendientes de importe de origen.

La migración `0074_inventory_ledger_position` conserva los campos originales de la huella de los movimientos iniciales. El verificador exige que la entrega de ensayo reciba una posición superior a la del historial restaurado y que el recuento reciba otra posterior. La reversión conservó las huellas de las 98 tablas migradas. Los comprobantes anteriores al control de posiciones deben regenerarse. El respaldo y la clave siguen bajo custodia local y `canCutOver` permanece en falso.

La [agenda local de la candidata más reciente](http://127.0.0.1:4279/admin/calendar?date=2026-11-19&view=day) usa el mismo snapshot y requiere inicio de sesión. Su API devolvió 34 líneas para el 18/11 y 41 para el 19/11, con siete profesionales, zona Europe/Madrid y modo de consulta.

En los dos modos de consulta, las rutas de autenticación admiten sólo las operaciones de sesión y OAuth necesarias para el acceso. Las rutas de alta, recuperación y verificación de correo quedan bloqueadas, incluida la verificación por GET o HEAD. El proceso de consulta arranca sin proveedor de correo de cuentas. La instancia de pruebas de escritorio tiene sus propios permisos y base aislada.

La restauración del 20/11 con `0075_staff_portrait_absence_version` verificó las 76 migraciones, las huellas de 94 tablas del respaldo y 1.053 archivos originales. Confirmó 787 líneas de agenda, incluidas las 47 líneas de 38 reservas de esa jornada. Las pruebas revirtieron sus cambios y dejaron intactas las huellas de las 98 tablas migradas. El comprobante privado está en `rehearsal-0075-verified.ZolXUw`.

### Lista de espera en la candidata

Las capturas revisadas aportan observaciones para 211 fechas y dos solicitudes del 18/11. Se conservaron los clientes por referencia, la fecha, la duración solicitada (90 y 60 minutos), la flexibilidad y el orden. Las dos aparecen en [Lista de espera](http://127.0.0.1:4279/admin/waitlist) como pendientes de revisión. La captura no identifica el servicio, la profesional ni la franja horaria. En la instalación operativa, un operador con acceso a todas las agendas puede confirmar esos datos y guardar la solicitud una sola vez, con las ofertas automáticas aún pausadas. Los servicios elegidos deben encajar en la duración solicitada, incluido el tiempo de limpieza. Al habilitar las ofertas, si ambas solicitudes son elegibles para la primera revisión, la cola usa su orden de origen. La candidata de consulta mantiene la política pausada, cero entradas activas y cero ofertas.

Los ensayos del 18 y 19 de noviembre restauraron el respaldo cifrado y prepararon una copia sintética por solicitud, con servicio, profesional, franja y al menos un hueco disponible. Se verificó el rechazo de cambios en el cliente, la fecha o la duración con limpieza, así como de una cuenta sin permisos y de intentos incompatibles de reutilizar la solicitud. El reintento idéntico devolvió la misma entrada. El motor de ofertas ejecutado con la política en pausa no revisó solicitudes ni creó ofertas o recordatorios. La reversión conservó los originales y las huellas de las 98 tablas migradas.

Los comprobantes privados de `rehearsal-0073-waitlist-verified.*` vinculan la evidencia al respaldo, a la candidata y a la fecha del ensayo. Hay que repetir los comprobantes anteriores que carezcan de esta evidencia. Para preparar las dos solicitudes reales, el equipo debe confirmar los campos pendientes. El comprobante mantiene `canCutOver: false`.

El verificador también exige, por cada solicitud archivada, que el ensayo registre el rechazo del alta con ofertas activas y el rechazo al omitir la preferencia, la aceptación explícita de cualquier profesional cualificado y el reintento de la misma entrada con ofertas activas. Exige el recuento de cero solicitudes examinadas, ofertas y recordatorios con la política pausada. Hay que regenerar los comprobantes que carezcan de estos campos.

Los comprobantes privados `rehearsal-waitlist-gates.*` del 18 y 19 de noviembre se verificaron con las 74 migraciones. Ambos verificaron 1.053 originales y 787 líneas de agenda, ejercitaron las cuatro condiciones con dos solicitudes sintéticas y conservaron las huellas de las 98 tablas migradas tras la reversión. El ensayo usó una copia y una clave de prueba de este equipo. La recuperación desde la copia externa queda pendiente.

El cotejo de las 33 observaciones archivadas cubrió 211 fechas. Las dos solicitudes conservadas corresponden al 18/11/2026 y las observaciones no aportan servicio, profesional ni franja horaria. Se conservan con su fecha original y la web las muestra como solicitudes anteriores una vez transcurrida esa fecha. Para guardar una solicitud importada vigente, las ofertas deben estar pausadas y la preferencia de profesional debe confirmarse expresamente, incluida la opción de cualquier profesional cualificado. La API comprueba ambas condiciones. Si se reactivan las ofertas, repetir un guardado ya confirmado devuelve la misma entrada.

Solo una petición con un inicio y un fin explícitos, sin filtros ni paginación, cuenta como observación completa de la lista de espera. Los originales se verifican y se conservan. El informe cuenta por separado las capturas descartadas por los parámetros de consulta. Una captura descartada no confirma un cambio de fecha ni la desaparición de una solicitud.

Si la misma referencia aparece en otra fecha en una captura posterior, se toma esa fecha. Si después desaparece de la observación más reciente de esa fecha, queda fuera de la proyección de solicitudes revisables. Todas las observaciones originales permanecen en el archivo.

Si cambia la duración de los servicios elegidos entre la revisión y el envío de una oferta, Citame deja la solicitud como no disponible y conserva el original para que el equipo pueda volver a revisar las condiciones.

### Pruebas del entorno de producción

`scripts/smoke-prod.sh` usa PostgreSQL, Valkey, API, web, worker y Caddy de `compose.prod.yaml` con un proyecto desechable, datos sintéticos y acceso local. Verifica la reserva pública, el rechazo de duplicados, su presencia en el primer HTML privado de la agenda, la réplica que consume escritorio, la denegación del acceso a esa réplica desde una cuenta de cliente y el canal SSE a través del proxy. También comprueba los flujos OAuth de MCP y escritorio hasta la revocación, incluida la renovación de escritorio y la apertura del canal SSE con su token. Con `SMOKE_DESKTOP=1` ejecuta quince pruebas Rust contra ese mismo entorno. Añadir `SMOKE_EMAIL=1` incluye la prueba de invitación a reseñas que usa el correo aislado. Las pruebas cubren trabajo sin conexión, conflictos de agenda, idempotencia, propagación entre dispositivos, avisos SSE, bloqueos, directorio, bandeja de citas, lista de espera y conciliación de pagos externos. Con `SMOKE_RESTORE=1` verifica la cita con sus servicios y asignaciones de profesional y equipo en la base restaurada, y comprueba que una actualización con el entorno anterior sea rechazada. El corte del centro aún requiere una instantánea final, políticas conciliadas, configuración y pruebas de sus proveedores y la definición de qué canal aceptará nuevas reservas.

## 1. Inventario y captura de origen

Registrar la zona horaria, fecha de corte, instante de inicio/fin de cada extracción, filtros, permisos del usuario que exporta y versiones del importador y de Citame. Mantener una matriz de cobertura por entidad con estado `complete`, `partial` o `not_captured`, total esperado y evidencia de origen. Nunca interpretar un campo no exportado como falso, cero, vacío o inexistente.

Capturar lo siguiente, incluidos archivados cuando el origen permita exportarlos:

| Entidad                         | Información a conservar y cuadrar                                                                                                                                                                                                                              |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Reservas y servicios reservados | IDs de reserva y de cada línea, cliente, profesional por servicio, inicio/fin exactos, estado, reservas de grupo, series y excepciones, extras, buffers y tiempos de procesamiento, precio congelado, impuestos/descuentos, depósitos y recursos               |
| Preferencias y comentarios      | Profesional solicitado por el cliente frente a asignación automática, notas internas, comentario original del cliente, mensajes enviados por el negocio y autor/origen de cada campo. No confundir un mensaje para el cliente con un comentario escrito por él |
| Clientes                        | ID externo, datos de contacto, fichas, campos adicionales, notas, etiquetas, duplicados/fusiones, bloqueos, consentimientos y sus pruebas, fotos/documentos con acceso privado                                                                                 |
| Servicios                       | IDs, categorías, orden, colores, descripciones, precios fijos/variables/desde, variantes, extras, duración, procesamiento, buffers, profesionales habilitados, precios/duración por profesional y recursos                                                     |
| Personal                        | IDs, activos/archivados, datos y roles, horarios recurrentes, excepciones, ausencias, concurrencia y asignación de servicios. Las credenciales no se copian; no se crean invitaciones durante el ensayo                                                        |
| Recursos e inventario           | Pools/unidades, cantidades y reservas, SKU, variantes, existencias, coste/impuestos, mínimos/objetivos, proveedores y movimientos. Preservar los movimientos, no fabricar ventas para cuadrar stock                                                            |
| Lista de espera                 | Peticiones, prioridades, disponibilidad, servicios/profesionales, estados y ofertas pendientes; no enviar nuevas ofertas durante la copia                                                                                                                      |
| Bonos, tarjetas y suscripciones | Saldos, unidades, consumos, caducidades, titularidad, contratos y renovaciones. Conservar la referencia del proveedor; no cobrar ni reiniciar renovaciones                                                                                                     |
| Finanzas                        | Facturas, recibos, cobros, devoluciones, caja y comisiones, con IDs y conciliación. «Facturada» no implica «pagada»; importar un indicador no crea ingresos nuevos                                                                                             |
| Configuración y archivos        | Perfil del negocio, reglas de reserva/cancelación, comunicaciones, permisos, archivos originales y metadatos. Los secretos y tokens se trasladarán por un procedimiento separado si fuera necesario                                                            |

La vista de lista de la agenda representa varios días y puede agrupar días vacíos. Sus filas son líneas de servicio o bloqueos; no equivalen al contador de reservas. Las fichas de personal cargan servicios por desplazamiento: comparar lo capturado con el total declarado y recorrer hasta completarlo. Las semanas vacías no demuestran que no haya citas posteriores. Registrar el último inicio observado **y** una prueba de fin de cobertura del origen; sin esa prueba, «última cita» queda pendiente.

El selector de fecha de los informes inspeccionados deshabilita fechas futuras. No sustituirlo por llamadas privadas ni modificar el cliente de Booksy para saltarse restricciones. Utilizar la agenda y exportaciones oficiales disponibles. Si un campo/entidad no puede obtenerse completo, conservar la captura parcial y solicitar una exportación completa al proveedor por un canal autorizado; no marcarlo completado.

## 2. Archivo y verificación

Crear un manifiesto con negocio, corte, zona horaria, artefactos `{path, sha256, bytes, kind}` y limitaciones. Utilizar rutas relativas y verificar cada archivo; rechazar escapes de directorio, enlaces a archivos externos, archivos alterados y negocios distintos. Conservar una segunda copia cifrada del archivo antes de la migración definitiva; documentar su ubicación y verificar una restauración sin exponer los datos en logs o Git.

Para guardar el archivo en la base aislada, sin crear citas nativas:

```sh
cd apps/api
bun src/scripts/booksy-private-db.ts /ruta/privada YYYYMMDD
bun src/scripts/booksy-prepare-full.ts /ruta/privada ID_CENTRO 2026-11-18
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-archive.ts \
  /ruta/privada/manifest-HASH.json sob_booksy_rehearsal_YYYYMMDD
```

`booksy-private-db.ts` crea un contenedor propio con PostgreSQL 18, volumen persistente, puerto exclusivamente en `127.0.0.1` y contraseña aleatoria en archivos privados. Requiere que la imagen oficial `postgres:18-alpine` esté instalada. No cambia los servicios existentes. Repetirlo reutiliza únicamente el contenedor identificado con su etiqueta de ensayo. Sustituir `YYYYMMDD` por la fecha de la base y conservar los nombres/rutas concretos que devuelve cada comando. No usar la conexión de desarrollo predeterminada. El preparador completo entiende las capturas JSON `booksy-*`, valida páginas del directorio, semanas completas, detalles de todas las reservas y colores del catálogo; las exportaciones oficiales CSV/ZIP y los documentos binarios requerirán adaptadores verificados, conservando siempre sus originales.

La salida debe indicar `rawArchiveVerified: true`, el mismo número de artefactos y `nativeAppointmentsImported: false`. Repetirlo verifica los bytes y no duplica capturas.

## 3. Preparación y ensayo de la proyección

Preparar el documento normalizado del contrato `packages/contracts/src/booksy-transfer.ts`, conservando en `raw` los campos de origen y en `unprojected` cualquier entidad sin traducción verificada. Las referencias son externas y explícitas. Para reservas con varias profesionales, servicios discontinuos, recurrencias, reservas de grupo, cantidades o tarifas no representables todavía, conservar todo y bloquear la promoción; no aplanar ni descartar líneas.

```sh
cd apps/api
bun src/scripts/booksy-rehearsal.ts plan /ruta/privada/bundle.json
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-rehearsal.ts \
  apply /ruta/privada/bundle.json \
  --database sob_booksy_rehearsal_YYYYMMDD --review HASH_EXACTO_DE_LA_REVISION
```

El plan debe rechazar IDs repetidos, referencias inexistentes, fechas anteriores al corte local, horas inválidas, duraciones que no cuadren y diferencias de recuentos. La aplicación es una transacción: un conflicto impide todo el lote, sin omitir citas para continuar. Las restricciones de concurrencia siguen activas. No aumentar la capacidad ni mover fechas para hacer que una reserva encaje.

Los IDs de destino son estables y están separados por negocio y entidad. Una repetición idéntica no duplica registros. Un cambio en el origen o en la copia local bloquea la repetición; se conserva el ensayo anterior y se prepara otro snapshot/base, en vez de sobrescribir. Verificar también servicios congelados, anotaciones y asignaciones, no solo la fila principal de la cita.

Al preparar una nueva copia, se conserva el contenido por envase desde `total_pack_capacity` y `volume_unit.symbol`. Las existencias se proyectan desde `full_packages_left`. Si el contenido está ausente o no es válido, se conserva el original y queda vacía su proyección. La migración `0073_inventory_package_content` preserva la huella de las copias anteriores y deja sus campos nuevos vacíos. Un ensayo desde el archivo actual proyectó el contenido de los 93 productos y cuadró sus existencias. Una restauración separada del respaldo cifrado verificó las 74 migraciones y volvió a conciliar la agenda del 19/11/2026 sin pasar a operación.

Para conciliar y probar la recuperación del contenedor privado:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-verify.ts \
  /ruta/privada/manifest-HASH.json sob_booksy_rehearsal_YYYYMMDD /ruta/privada/bundle.json
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-backup.ts \
  /ruta/privada/manifest-HASH.json /ruta/privada/bundle.json YYYYMMDD \
  /ruta/privada/source-snapshot-HASH.json
```

El respaldo crea un `.dump` privado y una **base nueva** `sob_booksy_restorecheck_YYYYMMDD_INSTANTE`. No utiliza `drop`, `clean` ni restaura encima del ensayo. El comprobante privado registra SHA-256 del respaldo y resultado de la conciliación en la restauración. Un fallo conserva los resultados para inspección; no elimina automáticamente la base ni un respaldo parcial. `restorationVerified: true` acredita esta restauración del material capturado, no la completitud de los datos que Booksy haya entregado.

### Copia de consulta y repetición sin sobrescribir

Después del archivo y la proyección base, guardar el snapshot completo con su hash exacto:

```sh
cd apps/api
bun --env-file=/ruta/privada/connection.env src/scripts/booksy-store-source.ts \
  /ruta/privada/source-snapshot-HASH.json sob_booksy_rehearsal_YYYYMMDD HASH_SNAPSHOT
mkdir -p /ruta/privada/cache /ruta/privada/acceso
chmod 700 /ruta/privada/cache /ruta/privada/acceso
bun src/scripts/booksy-private-cache.ts /ruta/privada/cache YYYYMMDD
bun --env-file=/ruta/privada/connection.env --env-file=/ruta/privada/cache/cache.env \
  src/scripts/booksy-consultation.ts /ruta/privada/acceso HASH_SNAPSHOT
```

El servidor genera las credenciales locales en `acceso/local-owner.json` (0600), sin copiar contraseñas de Booksy, invitar personal ni enviar correo. Escucha solo en `127.0.0.1:4301`. Para abrir la interfaz:

```sh
cd apps/web
API_INTERNAL_URL=http://127.0.0.1:4301 bunx --no-install vite dev \
  --host 127.0.0.1 --port 4276 --strictPort
```

El flujo de captura autenticada es **GET-only**, restringido al centro, con respeto a los límites del proveedor. Conserva la URL de petición, incluidas las fechas e `include_unconfirmed=true`. Una respuesta filtrada puede aportar evidencia de una reserva concreta. La sustitución de un día en el snapshot exige una petición sin filtros adicionales y el conjunto completo de profesionales y recursos. Las credenciales de Booksy permanecen en memoria del navegador y no forman parte del archivo ni del repositorio. Nunca ejecutar el importador contra la demo reiniciable ni usar la conexión de desarrollo predeterminada.

`booksy-prepare-full.ts` es determinista respecto a los originales. Repetir la misma proyección/snapshot verifica los IDs y campos existentes sin duplicar. Para una revisión distinta del mismo día, crear otra base aislada en el contenedor propio:

```sh
cd apps/api
bun src/scripts/booksy-new-run.ts /ruta/privada/connection.env /ruta/privada/nueva-base 2
```

Este comando crea `sob_booksy_rehearsal_YYYYMMDD_run2` y su conexión privada; si ya existe, falla. No limpia, elimina ni reutiliza otro ensayo. Aplicar las migraciones, archivo, base y snapshot nuevos con esa conexión, y repetir respaldo/restauración. Conservar las bases y capturas anteriores.

## 4. Conciliación y aceptación

Generar un informe sin datos personales con:

- Reservas por fecha, estado y profesional; líneas de servicio por reserva, y correspondencia entre reserva de origen y entidades de destino.
- Conjuntos de IDs faltantes, adicionales y duplicados, además de recuentos. Comparar campos y hashes, no solo los totales.
- Fechas e instantes exactos, zona horaria y cambios de horario de verano; primera cita incluida y última cita demostrada.
- Clientes, personal, servicios, asignaciones, horarios, ausencias, recursos, documentos y entidades pendientes.
- Precios congelados y monedas, estados facturado/pagado, saldos y movimientos de bonos/tarjetas/inventario, y consentimientos.
- Notas/comentarios por origen: verificar su contenido íntegro y que los privados no aparezcan en endpoints de clientes, sincronización o eventos SSE.

La aceptación exige **cero** registros sin explicar, correspondencias ambiguas, conflictos, documentos ausentes y proyecciones pendientes. Revisar visualmente casos reales de cita simple, varios servicios, distinta profesional, bloqueo, cita pagada, comentario del cliente, nota privada, recurrencia y grupo. Confirmar que el ensayo no ha generado mensajes, ofertas, cobros, ingresos duplicados ni invitaciones.

### Ensayar la separación de la base operativa

```sh
cd apps/api
bun --no-env-file src/scripts/booksy-portable-backup.ts rehearse-operational-copy \
  /ruta/privada/citame-review-HASH.dump.gpg \
  /ruta/privada/citame-review-HASH.dump.gpg.json HASH_CIFRADO_VERIFICADO \
  /ruta/privada/claves 2026-11-20
```

El comando verifica el respaldo cifrado, restaura y concilia los originales y aplica las migraciones de la versión seleccionada. Genera una segunda base desechable con las tablas nativas y el historial de migraciones. El esquema `booksy_rehearsal` permanece en el respaldo privado. El ensayo rechaza la copia si encuentra cuentas, sesiones, claves, dispositivos vinculados, autorizaciones de cobro o colas y configuración de envío.

La segunda base pasa las comprobaciones de admisión y migraciones de una base operativa, mantiene las reservas públicas pausadas y conserva las citas y sus indicadores en la réplica. El ensayo de la aplicación crea cuentas sintéticas en esa base y usa un Valkey desechable. Requiere tener instaladas localmente las imágenes `postgres:18-alpine` y `valkey/valkey:9.1-alpine`. Comprueba el inicio de sesión, la agenda del propietario y las denegaciones de acceso anónimo, acceso de clientes y nuevas reservas públicas. El comando compara las huellas de las tablas y desmonta todo al terminar. El comprobante devuelve `canCutOver: false`. Siguen pendientes la captura final, la custodia externa del respaldo y la aceptación del centro.

The desktop feed check compares each recovered appointment with its stored status, visit grouping, schedule, work windows and notes. It verifies the ordered frozen services, including duration, processing time, reviewed prices and amounts still pending review. The same comparisons apply to appointments reannounced after migration. New operational receipts report how many grouped calendar lines and frozen services were checked.

El ensayo local del 20/11/2026 verificó 1.053 originales, 91 tablas nativas y 76 migraciones. Conservó 787 líneas en la réplica, incluidas las 47 líneas de 38 reservas de esa jornada. La comprobación conservó intacta la restauración privada tras las migraciones.

La prueba de la API de esa jornada confirmó el inicio de sesión con una cuenta propietaria nueva y una cookie segura. La agenda devolvió las siete columnas de personal, 47 líneas de agenda y 49 servicios en el orden conservado. La API rechazó el acceso anónimo con HTTP 401 y el de clientes con HTTP 403. Una franja disponible devolvió HTTP 409 con `online_booking_paused` al intentar reservar con la cuenta de cliente de prueba. Los perfiles importados, el historial de sincronización previo y las tablas de citas conservaron sus huellas.

Usa `rehearse-operational-write` con los mismos argumentos para ensayar además un cambio de horario. El día elegido debe ofrecer una cita importada con equipo asignado y otra franja disponible. El ensayo vincula un dispositivo temporal mediante PKCE y una clave Ed25519. El dispositivo carga la agenda antes del cambio. La sesión web mueve la cita mediante la API normal y el dispositivo recibe el aviso SSE y la cita actualizada mediante la consulta incremental. El ensayo coteja los servicios, las anotaciones y el equipo. Repetir el cambio con la versión anterior debe devolver HTTP 409 sin efectos adicionales.

Before moving a booking, the rehearsal also compares the complete frozen service terms, assigned resources and visible booking badges returned by the Desktop sync feed with Cloud's calendar. It checks the flags for notes and comments while their text stays in the authorized appointment detail.

Después, el dispositivo mueve la misma cita por la ruta de sincronización. El ensayo vuelve a consultar las franjas y puede probar la hora original si sigue siendo válida. La sesión web debe recibir el aviso SSE y leer la nueva versión en la agenda. Reenviar la misma operación conserva su recibo y repetirla con una versión antigua registra un conflicto sin aplicar otro cambio. El ensayo coteja los tramos de trabajo, los recursos, las citas ajenas y los recibos de sincronización anteriores a ambos movimientos.

El ensayo también comprueba la renovación firmada, el rechazo de una prueba firmada repetida y el cierre de acceso tras revocar el dispositivo. Las credenciales se usan en memoria y los workers de envío permanecen apagados. Los avisos que genere el cambio quedan en la cola de la copia desechable. El respaldo y la restauración privada se conservan.

El ensayo de escritura del 20/11/2026 confirmó una reprogramación con su asignación de equipo y uso de capacidad ordinaria. El dispositivo vinculado reconstruyó las 47 líneas de esa jornada, recibió el aviso SSE y consultó la versión actualizada de la cita con un token renovado. Tras revocarlo, la API rechazó tanto el token anterior como otra prueba firmada con su clave. La prueba cubre la API de vinculación y sincronización que consume el escritorio. La interacción con una aplicación GPUI instalada se verifica por separado.

Un ensayo posterior ejecutó el binario GPUI de Linux contra otra restauración desechable del respaldo cifrado. La cuenta propietaria se creó para la prueba y el cliente Rust completó el intercambio PKCE y vinculó una clave Ed25519. GPUI abrió el flujo SSE y materializó la réplica SQLite. La agenda web y esa réplica coincidieron en las **787 líneas de 609 reservas** del 18/11/2026 al 15/04/2027. Se compararon identificadores, agrupaciones, profesionales, horarios, estados, versiones, 817 servicios congelados con sus importes y 298 indicadores visibles. El día 20 coincidieron 47 líneas de 38 reservas, 49 servicios, siete profesionales y 19 indicadores. El conteo de indicadores corresponde a lo conservado en el respaldo.

Las huellas de nueve tablas de negocio, incluidas las citas, sus notas y el catálogo, coincidieron antes y después de ejecutar la copia de aplicación. Al detener el acceso web y reiniciar GPUI, el proceso reabrió la misma réplica de 787 líneas, que pasó la comprobación de integridad de SQLite. El primer callback de cuadro de GPUI llegó a los 744 ms en ese arranque local. AT-SPI detectó el proceso sin exponer un árbol de controles. El cotejo verifica los datos recibidos y la reapertura sin conexión. La revisión visual, la extracción final y la conciliación financiera siguen pendientes.

Con la migración `0076`, el ensayo de escritura volvió a verificar 1.053 originales, 91 tablas nativas y 77 migraciones. El registro de sincronización reanunció las 787 líneas importadas y la copia conservó los 298 indicadores comprobados. Se verificaron las 47 líneas de agenda y los 49 servicios del día 20, junto con el aviso en tiempo real y la revocación del dispositivo de prueba. El respaldo cifrado conservó su huella y el comprobante local mantiene `canCutOver: false`.

Un ensayo independiente de caja usó una cita sintética de 100 EUR con un abono externo verificado de 35 EUR. La agenda web y la réplica mostraron el mismo saldo de 65 EUR y el indicador de facturación de origen. La caja solo aceptó cobrar los 65 EUR y ambas vistas mostraron el cobro en Citame desde el cursor previo. La migración reanudó la proyección para una réplica que ya había recibido el abono. Las anotaciones originales y el justificante privado se conservaron en el servidor.

El ensayo del 21/11/2026 restauró el respaldo local, verificó los 1.053 originales y cotejó las 787 líneas importadas. En la agenda del 26/11 verificó 26 líneas y probó la reprogramación en ambos sentidos con SSE, el reintento idempotente y el rechazo de la versión antigua. La comprobación del inventario funcionó antes y después de crear las clasificaciones a partir de las etiquetas archivadas. La huella del respaldo original coincidió y el comprobante sigue indicando `canCutOver: false`.

La repetición con la revisión `acd3792` aplicó 113 migraciones y verificó de nuevo los 1.053 originales y las 787 líneas. En la agenda del 26/11 cotejó 26 líneas, 18 reservas y tres bloqueos. Una cita con equipo asignado se movió por la API web y luego por la API de escritorio. Ambos cambios emitieron los avisos SSE esperados y actualizaron la réplica. El reintento conservó el recibo y las versiones antiguas se rechazaron. La prueba también comprobó la renovación y revocación del dispositivo. La verificación independiente del comprobante confirmó las huellas del snapshot y del respaldo cifrado. El ensayo se hizo en el mismo equipo, con la reserva pública pausada, y conserva `canCutOver: false`.

### Copia local para probar la agenda

La web y la API de la copia editable de pruebas escuchan en `127.0.0.1` y arrancan sin proveedores de cobro ni de envío. Tras aplicar `0075` y `0076`, las huellas de citas, servicios reservados, anotaciones y dispositivos coincidieron. Los datos del personal también coincidieron al excluir la nueva columna de retratos. [Agenda local del 20/11/2026](http://127.0.0.1:4275/admin/calendar?date=2026-11-20&view=day)

Con los argumentos de la copia local, añade `--prepared` después de `--desktop-test` para arrancar sobre una copia ya preparada. El arranque comprueba el snapshot archivado, el registro exacto de migraciones, la credencial del propietario, los ajustes y Valkey antes de abrir el puerto. Omite las migraciones, la reparación del archivo y la creación inicial del propietario y sus ajustes. Usa `--check-prepared` en ese mismo lugar para comprobar esos requisitos sin abrir el servicio ni iniciar una sesión.

To reconcile an editable copy against its private archive, point the connection at the `sob_booksy_desktop_test_YYYYMMDD` database and run the prepared-copy report.

```sh
cd apps/api
umask 077
bun --env-file=/ruta/privada/conexion-preparada.env src/scripts/booksy-candidate-report.ts \
  HASH_SNAPSHOT YYYY-MM-DD --prepared-copy citame-booksy-rehearsal-YYYYMMDD \
  > /ruta/privada/cotejo-copia-preparada.json
```

The report uses a read-only transaction to match bookings, services, staff, resources, notes and indicators against the archive. If it reports a different migration ledger, compare the applied migration timestamps and hashes with the candidate release. If the copy has a verified older prefix, apply the candidate migrations to a separate restoration and retry. If the histories diverge, verify the upgrade path for that history or select a verified compatible backup before retrying. It counts local checkout records, payments, payment reviews, reminders and waitlist activity. It checks opening stock as part of the baseline. Extra stock movements or reservations, or changes to the projected records, require separate reconciliation before the baseline can match. The report keeps `canCutOver: false`.

For a prepared local copy, the verifier also recognizes one audited restoration of an empty legacy quantity and unit from the verified product archive. It checks the exact archived content, the single system audit entry and the repair timestamp order, then reconstructs the original fingerprint at version 1. The version and modification timestamp reflect the repair. Changes to prices, stock, warehouse allocations, other product business fields or the restored quantity remain reconciliation errors. The archive and its original fingerprints are retained.

The reviewed business profile accepts up to 2,000 UTF-16 units and 64 lines of plain-text description. Profile submissions normalize CRLF line breaks to LF. Update the API, Web and Desktop before saving a multiline description. For a rollback to a version with the single-line limit, keep the original in the private archive and clear the description from the current owner editor before switching versions.

La sesión HTTP propietaria comprobó 47 líneas de 38 reservas, 49 servicios y siete profesionales. GPUI abrió el perfil de pruebas ya vinculado y alcanzó el último cursor del servidor con 787 líneas, 47 de ellas del día 20, y la cola de cambios y conflictos vacía. Esta copia sirve para probar la operación local. La autorización de corte sigue el procedimiento de la sección siguiente.

El cotejo de Caja para el 20/11/2026 devolvió 44 líneas en **Por cobrar** y tres en **Citas por conciliar** por importe original desconocido. La ruta web y la de escritorio devolvieron los mismos datos y exigieron autenticación. El informe de la candidata verificó 1.053 originales e identificó 27 servicios de 23 reservas con el cobro bloqueado por importe desconocido en todo el horizonte. La última cita de origen sigue sin estar demostrada.

El 21/11/2026 se comprobó que la copia local actualizada conserva 787 líneas de agenda, 57 bloqueos, siete profesionales y 187 servicios. La siguiente fecha del archivo con citas activas es el lunes 23/11/2026, con 38 líneas. La restauración cifrada cotejó 1.053 originales y el ensayo de la candidata verificó 102 tablas nativas tras aplicar 102 migraciones. [Agenda local del 23/11/2026](http://127.0.0.1:4275/admin/calendar?date=2026-11-23&view=day)

Tras la migración `0101`, Caja separa las dos citas activas que carecen de evidencia de pago. Solo la cuenta propietaria puede registrar su conciliación con una referencia. El bloqueo independiente de las 27 líneas sin importe sigue activo. La candidata restaurada mantuvo pausada la reserva pública. El comprobante conserva `canCutOver: false` hasta completar la cobertura final, la conciliación y la verificación del respaldo fuera del equipo.

La restauración aislada de un respaldo anterior a `0101` reconstruye la evidencia de pago a partir de los detalles archivados de cada reserva. Una marca negativa sin detalle suficiente conserva el bloqueo y genera un evento para actualizar las réplicas. El ensayo verifica los bloqueos contra el archivo antes de crear una candidata operativa.

#### Prepared local calendar backup

The editable local copy may contain changes made after the source export. Export a PostgreSQL snapshot in a read-only Repeatable Read transaction, fingerprint its tables, and keep the transaction open while `pg_dump --format=custom --snapshot=ID` reads that snapshot. Sequence changes are visible across transactions. Compare sequence state before and after the dump and after restoration. Retry with writers paused if the states differ. Encrypt the dump with the recovery key and record both the plaintext and encrypted SHA-256 digests. Store the recovery key and local owner credential separately. [PostgreSQL snapshot export](https://www.postgresql.org/docs/18/functions-admin.html#FUNCTIONS-SNAPSHOT-SYNCHRONIZATION), [sequence behavior](https://www.postgresql.org/docs/18/transaction-iso.html).

Restore into an empty disposable PostgreSQL instance on the same major version. Use the recorded `sob_booksy_desktop_test_YYYYMMDD` database name, the `citame_import` owner and any roles referenced by the dump's grants. Compare the table and sequence fingerprints, archived source bytes and calendar totals for the selected day. Run `--check-prepared` against the restored database, with loopback database and Valkey addresses and the existing private `local-owner.json`. Recover into a separate database and preserve and reconcile any local changes made after the backup before switching the editable agenda to the recovered copy.

On November 22, 2026, an isolated restore of the prepared copy for November 23 matched 116 table fingerprints, five sequences and the complete 118-migration ledger. It verified 1,053 archived originals and 38 service lines in 33 bookings. The local owner credential and Valkey check passed against the restored copy. The encrypted archive and verification receipt are held on the same machine, with `canCutOver: false`.

On a dedicated test machine with the local user units installed, `systemctl --user add-wants default.target citame-local-web.service` schedules the web unit on the next start of the user manager. The web unit starts its API dependency. Docker is configured to restart the two loopback storage containers unless they were explicitly stopped. The test stopped both user units and started only the web unit. Both became active, the gateway returned a successful `/api/ready` result, and all 15 operational table fingerprints and the Monday calendar matched. A full machine restart remains untested. [systemd user targets](https://www.freedesktop.org/software/systemd/man/latest/systemd.special.html#default.target).

## 5. Cuando se decida dejar Booksy: corte futuro separado

Esta fase no se ejecuta durante el ensayo actual. Booksy sigue recibiendo cambios mientras tanto; por ello, una copia de hoy no sustituye una extracción final.

1. Acordar una ventana de corte, el responsable del centro, la fecha/instante y qué sistema recibe las nuevas reservas durante la ventana.
2. Respaldar Citame y realizar la extracción final de Booksy. Compararla con el snapshot anterior por IDs y versiones/campos; detectar altas, cambios de hora/profesional/servicios, anulaciones y estados financieros.

   ```sh
   cd apps/api
   bun src/scripts/booksy-review-delta.ts \
     /ruta/privada/source-snapshot-HASH_ANTERIOR.json \
     /ruta/privada/source-snapshot-HASH_NUEVO.json
   ```

   El comando verifica los hashes de ambos snapshots y de sus originales. Escribe un comprobante privado `source-delta-*.json` con referencias y campos cambiados, e imprime únicamente recuentos. Compara reservas, grupos, fichas, personal, servicios, horarios, bloqueos, inventario, recursos y lista de espera. También separa los cambios en el detalle de pago archivado de cada reserva y enumera los grupos con cobros observados, evidencia ausente o datos por conciliar. El comprobante conserva referencias de reserva y estados. Los importes y las referencias bancarias permanecen en el archivo original. Distingue las citas ausentes dentro del intervalo de la nueva captura de las que quedan fuera de él. Para la lista de espera, distingue las ausencias en fechas que se volvieron a observar de las ausencias sin evidencia nueva. Las dos revisiones locales más recientes conservan las mismas dos solicitudes y reutilizan las mismas 211 fechas observadas. El comprobante nunca autoriza el corte.
3. Una ausencia en una página o exportación no prueba una cancelación. Resolverla con evidencia explícita de origen; nunca borrar o cancelar automáticamente por ausencia. El comprobante identifica para cada línea ausente la última presencia observada, la última ausencia en una captura que incluía todos los recursos del snapshot y el detalle de reserva más reciente. En la comparación con la captura anterior del 17/11 se localizaron dos ausencias en la lectura semanal de las 22:30, hora de Madrid. Ambos detalles conservados son anteriores; las dos líneas quedan pendientes de confirmar.
4. Construir una base nueva con el snapshot final y los deltas verificados; repetir todas las conciliaciones, la prueba de restauración y el ensayo de separación de la base operativa. La proyección nativa comprueba cada reserva en ambos sentidos. Si falta una línea en el calendario, la carga se detiene cuando las horas de la ficha no son verificables o se solapan con el intervalo capturado. Las líneas íntegramente fuera del intervalo se conservan en la ficha original archivada. El informe también comprueba la zona horaria de la candidata y que sus recordatorios estén pausados.
5. Obtener la aceptación del responsable sobre el informe concreto. Solo entonces configurar acceso del personal, publicación de reservas y proveedores de mensajes/pagos, con una fecha de activación y pruebas controladas.
6. Evitar dobles recordatorios, renovaciones y cobros. Migrar mandatos/tokens únicamente si el proveedor permite hacerlo y está verificado; no inferir autorización comercial del historial de reservas.
7. Cambiar los enlaces públicos al sistema elegido. Mantener Booksy y sus originales accesibles en lectura durante el plazo acordado. Este protocolo no borra sus datos ni cancela la suscripción.

## Recuperación

Para recuperar la copia editable, sigue el procedimiento de [respaldo de la copia preparada](#prepared-local-calendar-backup). Para iniciar otro ensayo desde el origen, conserva la base anterior y crea una base aislada desde los originales verificados. No se restaura nada sobre Booksy. Tras un corte futuro, detener nuevas escrituras en el sistema afectado y exportar los movimientos posteriores al corte antes de restaurar o regresar al otro sistema: una restauración ciega perdería las reservas nuevas. Documentar y conciliar esos movimientos antes de reabrir reservas.

## Solicitud de exportación completa para el proveedor

La documentación oficial de Booksy indica contactar con soporte para obtener una copia de la lista de clientes en [Reino Unido](https://support.booksy.com/hc/en-gb/articles/16539806017938-How-do-I-obtain-a-copy-of-my-Client-List-from-Booksy). Su guía de [exportación completa en Polonia](https://support.booksy.com/hc/pl-pl/articles/23203340704146-Co-zrobi%C4%87-aby-otrzyma%C4%87-eksport-wszystkich-danych) enumera clientes, servicios, reservas, opiniones, productos y mensajes, y exige que lo solicite la titular de la cuenta. El alcance y el plazo deben confirmarse para España: su [canal oficial de soporte](https://support.booksy.com/hc/es-es/articles/16540029346962--C%C3%B3mo-puedo-contactar-con-el-equipo-de-soporte) publica `info.es@booksy.com` y el chat de Booksy Biz. No se da por hecho que el contenido o los plazos de otro país sean idénticos.

Texto preparado para que la titular lo revise y, cuando corresponda, lo envíe. **Este documento no envía ninguna solicitud.**

> Asunto: Solicitud de copia completa de datos para ensayo de importación, sin cambios en la cuenta
>
> Soy la titular del centro [nombre e ID del centro], desde el correo asociado a la cuenta. Solicito una copia de nuestros datos para comprobar una importación de ensayo a otro sistema. Seguiremos usando Booksy.
>
> Necesitamos todas las reservas desde el 18/11/2026 a las 00:00, zona Europe/Madrid, hasta la última reserva existente, incluidas las reservas lejanas, grupos, recurrencias y excepciones. Solicitamos IDs estables de reserva, de cada servicio reservado, cliente, profesional y recurso, junto con sus relaciones, estados, horas exactas, precios congelados, extras, descuentos, pagos/depósitos, profesional solicitado, comentarios originales del cliente y notas internas diferenciadas.
>
> Solicitamos también catálogo completo con variantes y combos, personal y permisos, servicios asignados, horarios, descansos y ausencias; clientes y campos adicionales, consentimientos y documentos; recursos, inventario y movimientos; lista de espera; bonos, tarjetas regalo y suscripciones con sus saldos y consumos; facturas, recibos, cobros, devoluciones, caja y comisiones; configuración del centro y archivos originales. Indicad expresamente cualquier campo o entidad que no esté disponible.
>
> Preferimos archivos estructurados CSV/JSON y un ZIP de documentos originales, con una descripción de campos, relaciones, totales y el instante de la extracción. Necesitamos poder demostrar la fecha de la última reserva y que no se ha omitido ninguna posterior. Confirmad si la exportación es una instantánea consistente y cómo obtener una exportación final actualizada cuando decidamos migrar.
>
> Esta solicitud es exclusivamente una copia: no autoriza cancelar o modificar citas, borrar datos, cancelar la suscripción, desactivar reservas ni alterar el funcionamiento del centro. No deben enviarse mensajes a nuestros clientes.
>
> Por favor, confirmad el procedimiento, contenido, formato y plazo aplicables en España y el canal seguro para la entrega. [Teléfono de la titular para recibir la contraseña si vuestro procedimiento lo requiere].
