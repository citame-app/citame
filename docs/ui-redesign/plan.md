Place — Sisters of Beauty, una sede; aplicación de reservas y gestión del salón.
Deal: marfil/rosa de la marca mediante start brand; Lora + Nunito Sans (Lora conserva el carácter serif del nombre); hero place; nav-cards simplificado a navegación útil; footer-columns; colour-band; block; dots; offer pair; name type moment; picture-develops film. Sin efectos WebGL ni fondos decorativos. El primer azul y la primera fuente sans se descartaron por conflicto con la marca existente; photo-chapters se volvió a sortear porque exige una página larga.

## Hechos y voz
Se vende atención de belleza en un salón con reserva online. Servicios, precios, moneda, duración, profesionales, reglas y zona horaria proceden de la API. El entorno de vista previa contiene datos sintéticos identificados como demo. No tenemos dirección, fotografías del negocio, horarios publicados ni credenciales de producción. No inventar testimonios, reputación, descuentos, facturación ni miembros del equipo.

Voz: clara, cercana y práctica; registro de servicio; palabras corrientes, acciones concretas, sin promesas de rapidez ni eslóganes. Mantener inglés y español. CTA principal: reservar cita (la aplicación conserva sus traducciones de turno). Comprender, seleccionar, revisar y confirmar.

## Portada, tres pantallas de escritorio
- hero: fotografía editorial de cabello sobre texto y una sola acción principal; categoría y ventana real de reserva; 1 pantalla.
- services: carta de servicios real con precio/duración y fotografía de manicura; composición pair; momento picture-develops film una vez; 1 pantalla con el catálogo demo, crece si el catálogo real lo necesita.
- how: tres pasos, nombres reales del equipo, nombre tipográfico y cierre de marca; 1 pantalla. Pie en columnas con enlaces y procedencia de las ilustraciones.
En móviles la altura sigue el contenido: no esconder servicios para forzar un número de pantallas.

## Cobertura de la aplicación
- Portada, portfolio y reseñas: encabezados, navegación, imágenes, carta y estados vacíos.
- Reservas: cuatro pasos, opciones de servicio/profesional, fecha/horas, resumen persistente, revisión, consentimientos y confirmación.
- Cuenta: navegación lateral en escritorio, accesos en móvil; citas, reprogramación, perfil, avisos, lista de espera, reseñas y recompensas.
- Acceso: inicio, alta, recuperación, restablecimiento y verificación; imagen editorial y formulario; OAuth conserva su flujo.
- Administración: sidebar, barra móvil, cabeceras, controles/tablas, filtros, pestañas, paneles y diálogos compartidos.
- Hoy y agenda: cifras/tareas, ritmo de las filas, cabeceras por profesional y calendario operativo.
- Clientes: directorio y detalle, formularios/fotos, importación/exportación y combinación de fichas.
- Servicios y equipo: catálogo, combinaciones, tiempos de exposición, horarios y recursos.
- Caja: ventas, cobros, inventario, contabilidad, bonos, regalos y fidelización.
- Informes, reputación y ajustes: filtros y pestañas; índice de ajustes mediante enlaces que mantienen los formularios montados y sus borradores.
- Pago, consentimiento, baja de avisos y widget: sistema de controles/estados compartido; preservar estado y contratos.

## Alcance de las reglas de landing
Los requisitos de pantallas completas, fotografías, entrada hero y momento se aplican a la portada comercial. Las pantallas operativas conservan densidad, pestañas, modo oscuro y navegación/resúmenes persistentes: son funciones del producto existente. No introducir animaciones editoriales en cada formulario de cobro o calendario. La petición de generar imágenes con imagegen sustituye la preferencia de la skill por fotografía de archivo; son ilustraciones anónimas declaradas en el pie, nunca trabajos o personas reales del negocio.

## Validación
TDD para nueva navegación de secciones: test rojo por componente ausente, implementación y test verde. Bun para lógica/componentes existentes; Playwright autorizado por el usuario para flujos de aplicación. Scripts de la skill para revisión visual, tamaños, consistencia, rendimiento y gate. Registro final en verification.md.
