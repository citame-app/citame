# Calendario de Citame basado en Booksy

Revisión del 17 de noviembre de 2026 y cambios locales en la agenda web. La referencia es la agenda profesional de Booksy, consultada mediante la extensión de ChatGPT en la sesión autenticada del navegador. La primera revisión fue de solo lectura. En la ampliación, el usuario autorizó expresamente una cita futura de prueba y su retirada posterior: se creó una única cita el 12 de enero de 2027, de 9:30 a 9:35, sin cliente asociado ni datos de contacto, con una nota interna que la identificaba como prueba. Se canceló al terminar. Se comprobó el estado «Cancelado» y, con la agenda cargada de nuevo, su ausencia de la agenda activa. Booksy conserva la trazabilidad de la cancelación; no se efectuó un borrado permanente. La pestaña quedó en su URL original de hoy, día y profesionales en activo.

El cambio principal es una agenda que ocupa la pantalla y conserva el contexto al abrir una reserva. La semana muestra profesionales por días. Las citas cortas ocupan tarjetas compactas y los servicios de una misma reserva pueden representarse en bloques separados. Los avisos de nuevas citas llegan por SSE.

## Comparación con la referencia

| Área | Booksy observado | Citame tras este cambio |
| --- | --- | --- |
| Espacio de trabajo | Barra de navegación estrecha, controles superiores, panel de fechas y filtros, agenda con scroll propio | Distribución equivalente en la agenda; cuenta, idioma y tema en un menú compacto |
| Día | Columnas por profesional con horario de trabajo, disponibilidad, ausencias y línea de hora actual | Columnas con horario e iniciales, fondos de disponibilidad y ausencias, cabeceras y eje horario persistentes |
| Citas cortas | Tarjetas de una línea y distribución lateral cuando falta espacio | Altura mínima de 24 px y carriles calculados también según la ocupación visual para evitar tapar citas consecutivas |
| Servicios | Varios bloques pertenecientes a una misma reserva y detalle agrupado | Se divide el plan guardado cuando la suma de duraciones y buffers coincide con la reserva. Cualquier bloque abre la reserva original |
| Colores | Fondos suaves y franja lateral; el estado también tiene sus propios indicadores | Color estable derivado del nombre del servicio, separado del estado. Conserva señales de cancelación e inasistencia |
| Semana | Matriz de profesionales por días, contador y acceso a todas las citas de una celda | Matriz del equipo completo, resúmenes acotados, ausencias, días sin horario y acceso al día de cada profesional |
| Mes | Semanas completas, contadores y muestras de citas por día | Semanas completas de lunes a domingo, muestras, contadores y navegación al día |
| Lista | Agenda cronológica agrupada por fecha y resumen de importe | Lista por fecha con duración, profesional y valor previsto por moneda; el importe representa servicios programados, no ingresos cobrados |
| Fechas | Mini calendario, anterior/siguiente y saltos de ±1 a ±6 semanas | Mini calendario, selección directa de fecha, Hoy, desplazamiento por vista y saltos de semanas |
| Filtros | Profesionales, recursos y distintos estados o indicadores | Equipo, profesionales con horario en el período, estado, canceladas y búsqueda local por cliente o servicio |
| Detalle | Panel lateral con cliente, servicios, notas, estado y cobro | Reutiliza el panel funcional de Citame y permite abrirlo desde un enlace del aviso |
| Lista de espera | Contador contextual, panel de solicitudes y detalle de servicio y profesional | Panel lateral con contador de solicitudes activas cuyos intervalos intersectan las fechas visibles, detalle desplegable y revisión de las ofertas existentes |
| Notificaciones | Historial por día de llegada, activo/archivado, filtros y archivo | Campana en la aplicación, historial paginado de altas, reprogramaciones y cancelaciones, filtro por tipo, archivo individual o del día visible, restauración por usuario |
| Añadir a la agenda | Menú de cita, falta de disponibilidad y ausencia | Menú de nueva cita, bloqueo de franja y ausencia. Los dos últimos reutilizan el modelo de tiempo libre por profesional, con rango de fechas, motivo y todo el día |
| Aviso de cita | Toast oscuro centrado arriba con campana, fecha y hora, cliente, servicio y cierre | Toast equivalente con iniciales, enlace a la cita, cierre y pausa del tiempo de exposición al pasar el ratón o enfocar |

La revisión también cubrió directorio y ficha de cliente, personal, turnos, configuración y catálogo de servicios. En producción solo se guardó y canceló la cita de prueba autorizada. Las solicitudes reales de espera, los avisos, los horarios y las citas reales no se modificaron. Los formularios de bloqueo y ausencia se descartaron. No se publicaron huecos ni se enviaron mensajes o cobros.

## Flujos observados en Booksy

### Crear una cita y asignar servicios

El botón flotante abre tres acciones: nueva cita, falta de disponibilidad y ausencia. Nueva cita abre un panel lateral de unos 484 px y conserva la agenda visible. La selección de cliente es opcional; dejarla vacía representa un cliente sin cita previa. Al guardar sin cliente aparece una sugerencia de añadir nombre y teléfono, con la alternativa «Ahora no». No se creó una ficha de cliente para la prueba.

El panel separa «Cita» de «Notas y datos». Incluye fecha, reserva de grupo, recurrencia, selección de servicio, extras, inicio, fin, profesional y recurso. Seleccionar un servicio actualiza su duración y precio y recalcula el fin. El panel muestra un bloque provisional en la agenda antes de guardar. La nota interna se distingue del mensaje para el cliente; hay un indicador de favoritos. El pie mantiene total, importe a pagar y acciones visibles.

El selector de profesional conserva todas las opciones y explica su elegibilidad: disponible, disponible a una hora posterior o no realiza este servicio. La elección manual muestra su origen y permite marcar que la solicitó el cliente. Los recursos tienen el mismo patrón: recurso compatible y disponible frente a recurso que no presta el servicio. No basta con filtrar por nombre o permitir cualquier profesional.

«Añadir otro servicio» abre «Servicio #2», con inicio por defecto al terminar el anterior y sus propios servicio, extras, inicio, fin, profesional y recurso. Cancelar este subpanel vuelve a la cita original sin añadirlo. Esta independencia requiere un modelo por servicio; el modelo actual de Citame mantiene un profesional para la reserva completa.

La recurrencia abre una ventana con reglas, fecha final y previsualización de citas. Ofrece cada día, semana, dos, tres, cuatro o seis semanas, mes y días seleccionados. Se inspeccionaron las opciones sin aplicar una serie. La reserva guardada muestra cabecera verde «Confirmado», origen, referencia, cambio de estado y acciones de reservar otra vez o cobrar. La cancelación utiliza una confirmación y retira la cita del calendario activo, conservando un detalle «Cancelado» consultable.

### Bloqueo y ausencia

Falta de disponibilidad abre un panel con fecha, inicio, fin, empleado, recurso y motivo. Guardar está deshabilitado sin un destino. Se inspeccionó el selector de empleado y se descartó el formulario.

Ausencia navega a Personal y recursos → Turnos y abre una ventana con todo el día, duración, selección de fechas, repetir, motivo, aprobación y selección de uno o varios empleados. Los motivos son día personal, enfermedad, vacaciones, formación, inasistencia, llegada tarde, salida anticipada y otro. Se inspeccionó sin guardar.

En Citame, bloquear franja y añadir ausencia están disponibles desde la agenda con los permisos existentes. Una ausencia de todo el día abarca medianoches locales y permite varios días inclusivos; el día del cambio de horario de otoño en Madrid dura 25 horas. El servidor conserva su comportamiento de informar sobre citas que entran en conflicto sin reprogramarlas automáticamente. Las ausencias de Citame todavía no tienen motivo categórico, aprobación, repetición ni selección múltiple. El bloqueo por recurso requiere su recorrido específico.

### Lista de espera

El contador depende del día o período. El panel explica que Booksy avisa a los interesados cuando el centro publica un hueco de última hora. Las filas se agrupan por fecha, identifican cliente y duración solicitada, y abren un detalle con momento de incorporación, servicio, duración, precio y preferencia de profesional. El detalle ofrece reservar ahora, llamar, enviar mensaje y eliminar. No se ejecutó ninguna acción sobre solicitudes reales ni se publicó un hueco.

Citame conserva su sistema de ofertas: un hueco compatible produce una oferta con caducidad; antes de aceptar se revisan precio, consentimientos, formularios y protección de reserva. La agenda muestra las solicitudes activas que intersectan las fechas visibles y permite desplegar sus detalles y revisar ofertas sin salir del calendario. El enlace de reserva aceptada abre su día, profesional y detalle, cerrando el panel de espera. Esta lógica no equivale al mecanismo de publicación y aviso de Booksy; no se introduce un botón de reserva que omita las garantías actuales.

### Notificaciones dentro de la aplicación

El panel de Booksy se abre a la derecha con el calendario legible. Agrupa por día de llegada y muestra icono, tipo, fecha y hora programadas, cliente, servicio y avatar. Incluye archivo por aviso y por día. Filtros separa activo/archivado y permite seleccionar altas y cambios, cancelaciones, inasistencias o cancelaciones tardías, confirmación pendiente, pagos móviles, reseñas, comentarios y avisos de Booksy. No se archivaron avisos ni se aplicaron preferencias en producción.

Citame incorpora un historial de los eventos auditados de creación, reprogramación y cancelación. Conserva la fecha programada que tenía el evento y utiliza la fecha y profesional actuales para abrir el detalle correcto si la cita se ha vuelto a mover. Los nombres y servicios proceden de datos autorizados actuales; el historial no expone teléfonos, correo ni notas internas. Las citas o clientes eliminados dejan de ser visibles.

Archivar guarda una relación usuario/evento en el servidor. No modifica el registro de auditoría ni afecta a otros usuarios, admite restauración y sobrevive a una recarga. «Archivar este día» actúa sobre las filas de ese día cargadas en la página, sin incluir eventos nuevos que lleguen mientras se usa el panel. La paginación limita cada respuesta a 25 avisos. La caché del frontend se separa por usuario; el proveedor SSE se vuelve a montar al cambiar de cuenta. Las categorías adicionales de Booksy no se muestran sin un evento equivalente real.

## Actualizaciones en directo

La web reutiliza `/api/sync/stream` y `/api/sync/pull`, que ya autentican a profesionales y propietarios y aplican el alcance de cada cuenta. Una sola conexión permanece montada durante la navegación por administración. El servidor anuncia el cursor del registro de cambios; el cliente recupera los cambios autorizados y actualiza las consultas activas.

La conexión inicial establece una referencia sin anunciar reservas históricas. Las reconexiones conservan el cursor en memoria y recuperan cambios pendientes. Los cursores y las versiones descartan repeticiones. Los avisos nuevos se identifican por reservas desconocidas de versión inicial; los cambios de fecha y las cancelaciones de reservas conocidas tienen su propio aviso. Si una reserva se crea y modifica antes de su primer pull, el registro puede devolver ya una versión posterior y no producir el aviso de alta. La agenda sí se actualiza con su estado actual.

Los avisos incluyen reservas de fechas distintas de la vista abierta. Pulsarlos selecciona el día y profesional de la reserva y abre su detalle mediante el parámetro `appointment`. El nombre de cliente añadido al contrato de sincronización es opcional y procede del servidor; no se añaden teléfonos ni correos a ese aviso.

El cliente cierra la conexión al salir de administración, responde a los eventos de conexión y desconexión del navegador y aborta peticiones pendientes al desmontarse. Un pull de respaldo cada 30 segundos recupera eventos perdidos. El refresco periódico de la agenda se desactiva mientras el canal está conectado y permanece disponible como respaldo al desconectarse.

Los cambios recibidos también invalidan el historial de notificaciones. El historial tiene un refresco de respaldo cada 30 segundos; la lista de espera conserva su refresco de 15 segundos porque no forma parte del registro de sincronización actual.

El servidor web excluye `text/event-stream` de gzip: comprimir los pequeños mensajes retenía los eventos en el buffer. La ruta SSE devuelve además `X-Accel-Buffering: no` y `Cache-Control: private, no-store`. Los proxies de producción deben mantener el flujo sin buffering, como ya establece la configuración Caddy del repositorio.

## Rendimiento

- La animación de arrastre actualiza únicamente el bloque activo con `requestAnimationFrame`, en lugar de reconciliar toda la agenda por cada movimiento del puntero.
- Citas y servicios se indexan por día y profesional. El cálculo de carriles se memoriza y la búsqueda de bloques utiliza mapas.
- El servidor agrupa los snapshots de servicios una sola vez y carga recursos, series y protecciones en paralelo.
- La proyección de protecciones pasa de una consulta por reserva a un máximo de dos consultas por rango, conservando el cálculo de devoluciones.
- La navegación precarga el rango vecino al pasar el ratón o enfocar el control. Nunca dibuja las citas del rango anterior bajo una fecha nueva mientras espera la respuesta.
- Semana y mes limitan las tarjetas de resumen por celda. El acceso a todas las citas conduce al día correspondiente.
- Los rangos mensuales contemplan la hora adicional del cambio de horario de otoño en Madrid. Las coordenadas de bloques usan hora local y recortan reservas que cruzan medianoche.

Mediciones de una ejecución local con el servidor web compilado, seis profesionales, 42 citas al día y 210 a la semana:

| Interacción | Móvil | Escritorio |
| --- | ---: | ---: |
| Cambiar a semana | 161 ms | 155 ms |
| Cambiar a mes | 98 ms | 124 ms |
| Cambiar a lista | 166 ms | 127 ms |
| Mostrar aviso tras la respuesta de creación | 29 ms | 33 ms |

Son muestras de esta máquina y estos datos, no percentiles ni una comparación medida con Booksy. El rendimiento con red móvil, otro servidor o agendas mucho mayores debe medirse en ese entorno.

## Validación

- 780 pruebas del frontend, incluidas las de calendario, permisos, panel de reserva, creación y conflictos.
- 24 pruebas de contratos de calendario y sincronización.
- 33 pruebas de API de calendario y sincronización, 19 de protección de reservas, cinco de historial de notificaciones y cuatro de lista de espera. La proyección por lote se contrasta con la proyección individual, incluida una devolución pendiente.
- Nueve pruebas de navegador aprobadas y una omisión deliberada del arrastre en móvil, donde se usa el selector de horarios. Se comprueban las cuatro vistas, scroll contenido, accesibilidad, tema oscuro, detalle de reserva, SSE entre dos sesiones, reconexión, ausencia de avisos históricos y reversión de un movimiento con conflicto. La ampliación verifica espera contextual, creación de bloques y ausencias de día completo, notificaciones tras recargar, archivo y restauración.
- Anchuras de 320, 390, 1024, 1440 y 1920 px. La agenda conserva su scroll interno sin desbordar la página.
- Comprobaciones de tipos, formato y compilación del frontend y tipos de API.

La infraestructura de pruebas usa Postgres y Valkey locales y la base `sob_test_recurring_browser`. Los datos de demostración son sintéticos y los avisos de prueba no se envían a clientes reales.

Para ejecutar la prueba de navegador:

```sh
docker compose up -d --wait postgres valkey
bun install --frozen-lockfile
bun run --cwd apps/web build
E2E_CALENDAR_FIXTURE=true bun run --cwd apps/web e2e
```

Las capturas de la demostración se guardan en `.taste-skill/calendar/`, una ruta ya excluida de Git. Las capturas de Booksy con datos de clientes no se incorporan al repositorio.

## Trabajo pendiente para una equivalencia completa

| Prioridad | Cambio | Condición de aceptación |
| --- | --- | --- |
| Alta | Agenda por recursos | Columnas y filtros por identificador de recurso, con capacidad y reservas reales; no agrupar recursos solo por su nombre |
| Alta | Interacción por servicio | Decidir y validar la asignación y reprogramación individual de servicios. Actualmente un arrastre desplaza la reserva completa |
| Resuelto | Colores configurables | Categoría y color persistidos en servicios; lectura por lotes en la agenda, conservando precios históricos |
| Alta | Panel de reserva | Igualar la composición y acciones del panel lateral de Booksy conservando permisos, depósitos y checkout existentes |
| Media | Indicadores y filtros adicionales | Exponer cobros, confirmación, origen de selección de profesional y favoritos con datos autorizados y un significado definido |
| Media | Publicar huecos de espera | Decidir si incorporar el mecanismo explícito de publicación de Booksy, además de las ofertas y aceptación actuales |
| Media | Ausencias avanzadas | Motivo categórico, aprobación, recurrencia, selección múltiple y bloqueo de recursos |
| Media | Notificaciones adicionales | Integrar reseñas, pagos y otros eventos reales, manteniendo el alcance de cada cuenta |
| Media | Avatares | Incorporar fotografías reales autorizadas de profesionales y clientes; la entrega actual utiliza iniciales |
| En curso | Resto del panel | La estructura visual común y los flujos de venta, clientes, catálogo, equipo, informes y marketing están implementados; véase `booksy-parity.md` para los pendientes de detalle |
| Media | Medición con mayor volumen | Medir p95 de navegación y respuesta a interacción, tareas largas y consumo de memoria con una carga representativa de producción |

Estos cambios son locales. La migración `0041_fast_quicksilver.sql` añade el archivo de avisos por usuario y un índice de consulta de auditoría; se aplica únicamente a las bases locales de prueba durante esta revisión. No se ha desplegado Citame ni se ha migrado una base de producción.
