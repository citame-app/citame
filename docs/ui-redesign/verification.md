GATE: OPEN 9 (rounds used up)

Rediseño implementado en la aplicación y publicado únicamente en la vista previa local, http://localhost:4280. Las referencias raster no sustituyen pantallas funcionales. El catálogo, los profesionales, el calendario, los importes y los permisos siguen procediendo del producto existente.

## Resultado comprobado

- 765 tests de Bun, 140 archivos, sin fallos. Incluyen contraste AA de todos los roles de color en ambos temas y las regresiones de navegación.
- 12 flujos con Playwright sobre la imagen Docker de producción, móvil/escritorio y claro/oscuro: recorrido público, diez secciones de administración, reserva hasta confirmación y seis páginas de cuenta. Sin violaciones serias/críticas de axe en las pantallas comprobadas.
- 8 comprobaciones adicionales de navegación pública/administración con captura de errores de consola y JavaScript: sin errores. Incluyen enlaces de salto al contenido y foco visible en los selectores de idioma.
- TDD: índice de ajustes, visibilidad de navegación pública, destino activo único y estado de «Más» pasaron de rojo a verde. Los enlaces de ajustes conservan el borrador al saltar entre secciones.
- Build de producción, TypeScript y Biome correctos. Imagen Bun 1.4.4: `sob-web:ui-redesign-final`, SHA256 `d135f99ad4760c911fa21b2ced6bbc8cead4f13076bca768d6de47297a97b4be`.
- API, base de datos y cuentas de la vista previa conservadas. Sin publicación externa ni activación de proveedores de pago o mensajería.

## Control visual de la skill

Se usó [design-taste-frontend/SKILL.md](../../.agents/skills/design-taste-frontend/SKILL.md), con su límite «three rounds at most». Tras agotar las tres rondas, la skill indica detener las correcciones del gate y registrar sus hallazgos. No se ha reiniciado ni alterado el checker para obtener un PASS.

El gate tiene una limitación con este monorepo: calcula la huella desde `src`, `app`, `public`, etc. en la raíz y no sigue `apps/web/src`. La segunda revisión real se ejecutó cuando cambió la configuración raíz; la ronda final aplicó las exenciones a ese resultado almacenado, sin volver a inspeccionar los últimos cambios de `apps/web`. Por eso sus nueve hallazgos conservan selectores previos del pie y del enlace de salto. El resultado **no se presenta como PASS**. La revisión directa posterior de los cinco tamaños usa el build final y se registra por separado.

[Salida íntegra del gate](validation/gate.txt). Exenciones solicitadas en [waivers.json](validation/waivers.json):

1. Cierre tipográfico: corresponde al nombre grande de la marca sorteado para la página; no es una imagen ausente. Aceptada.
2. Radio de idioma transparente: el foco se dibuja sobre su etiqueta; Playwright verifica el contorno sólido de 3 px en ambos idiomas y temas. Aceptada.
3. Título sintético de 47 caracteres: el título final sí cabe; la propia skill admite esta exención. Aceptada.
4. Altura del pie compacto de la aplicación: conservar enlaces útiles sin añadir una pantalla vacía. No aplicada al selector nuevo porque el gate reutilizó la captura anterior.
5. Convivencia del pie compacto y el cierre en una pantalla: misma decisión de UX; no aplicada por la reutilización del selector anterior.

Los nueve hallazgos abiertos del resultado almacenado son:

- Altura del pie inferior a una pantalla.
- Inicio del hero después de la cabecera de 65 px en vez de en la cuadrícula absoluta de pantallas.
- Coincidencia del pie y cierre al final del scroll.
- Enlace de salto fuera de `header.nav` en la captura anterior; en el código final está dentro de la cabecera, conservando el primer foco del teclado.
- Pie sin clase `closing` en la captura anterior; el código final incorpora esa clase.
- Diferencia de espacios entre hero y carta en móvil; la imagen final se amplió para usar ese espacio.
- Altura de carta de 900 px frente al cálculo de pantalla que descuenta la cabecera fija.
- La misma diferencia de altura para el cierre.
- Inicio del cierre visible al recorrer la sección de carta en móvil, cuyo contenido sigue su altura natural.

La pasada directa final de consistencia registró **56 FAIL y 27 WARN** contando las repeticiones de cada ancho. Las categorías de FAIL son: `text-only`, `focus-visible`, `section-height`, `one-section`, `section-gaps`, `section-air`, `container-edges`, `photo-upscale`, `hero-screen`. [Salida completa](validation/consistency.txt) y [datos completos](validation/consistency.json). El [control de layout de los cinco tamaños](validation/layout.txt) también conserva observaciones de altura, alineación y stress de titulares. No se han etiquetado como aprobados.

Las reglas de página completa no se fuerzan sobre formularios, calendario, caja o tablas: la aplicación conserva pestañas, resúmenes y navegación persistente, densidad operativa y modo oscuro. El pie compacto y el catálogo de altura natural son decisiones deliberadas. No se ha declarado una conformidad visual total con la skill.

## Rendimiento y revisión final

[Medición de rendimiento](validation/performance.txt), [JSON](validation/performance.json): el presupuesto estricto de JavaScript queda abierto en ambos tamaños, con aproximadamente **1.093 KiB analizados / 358 KiB comprimidos**, por encima de los 900 KiB de la skill. Las imágenes, fuentes, CSS, peticiones y transferencia total pasan sus presupuestos; no se detectaron peticiones rotas ni desplazamientos de layout. Los tiempos son mediciones de Chromium sobre CPU local, no métricas de usuarios de producción. La división adicional de los clientes/esquemas compartidos de la aplicación queda pendiente; no se ha presentado este control como PASS.

El lint de copia registra **0 FAIL y 0 WARN** ([salida](validation/copy.txt)); los avisos léxicos mencionados antes corresponden al checker de composición, que no reconoce algunos verbos y sustantivos españoles.

Una revisión posterior encontró que la flecha decorativa de los accesos de caja formaba parte de su nombre accesible (`Inventory ↗`). Se reprodujo el fallo con el selector exacto anterior, se retiró el texto generado por CSS y se incorporaron aserciones para los tres destinos. La última pasada de los 12 flujos Docker incluye esa regresión y pasó. Fue una corrección funcional de accesibilidad, sin reabrir ni reiniciar el gate agotado.

Los informes monetarios conservan el formato ARS fijo de la implementación anterior en [reports-view.tsx](../../apps/web/src/features/admin/reports/reports-view.tsx); su moneda y agregación requieren una revisión específica antes de usarlos para informar importes en EUR. Este rediseño no modifica esos cálculos.

Las pruebas de navegador se ejecutaron en Chromium con viewports móviles y de escritorio. No se ha afirmado validación sobre dispositivos físicos ni Safari/iOS.

## Diseño, imágenes y límites

Tipo `place`, marca marfil/rosa profundo, Lora y Nunito Sans locales, hero fotográfico, cierre tipográfico y `picture-develops` en modo film. Voz: servicio claro y cercano, sin promesas de tiempo. El [plan](plan.md) detalla la cobertura y el sorteo. La captura de portada para compartir se conserva en `share-v1.jpg`; falta el dominio definitivo para configurar una URL absoluta de Open Graph. Los archivos seleccionados de movimiento se copiaron sin cambios; [comprobación de integridad](vendor-assets.json).

Se generaron cuatro referencias y tres ilustraciones con **imagegen integrado**. [Prompts de referencia](reference-prompts.md), [prompts exactos de las ilustraciones](assets.json), originales de referencia en `references/`, WebP responsivos en `apps/web/public/images/editorial/`. El icono SVG y sus tamaños PNG usan la misma marca de tres puntos y el color nuevo.

Las ilustraciones son anónimas y su procedencia figura en el pie; no representan el local, el equipo ni trabajos de clientes reales. El portfolio y las reseñas continúan usando sus datos propios o sus estados vacíos. No se han inventado direcciones, horas de apertura, reseñas ni cifras de negocio. Las cuentas y precios de la vista previa se identifican como demo.

Siguen pendientes los datos y materiales que el negocio todavía no ha aportado: dominio y alojamiento definitivos, fotografías reales, dirección/horarios publicados y credenciales externas. Los avisos de copia conservados incluyen vocabulario español que el checker de verbos no reconoce, el cierre tipográfico y los datos demo de la instalación local; no se han sustituido por afirmaciones ficticias para pasar el control.

## Reproducción

Con las dependencias instaladas e infraestructura local de pruebas disponible:

```sh
bun run --cwd apps/web test
bun run --cwd apps/web typecheck
bun run --cwd apps/web lint
bun run --cwd apps/web build
docker build -f docker/web.Dockerfile -t sob-web:citame-e2e .
bun run test:ui:production
```

El último comando utiliza su propia base de datos y fixture de API; no usa la base de datos de la vista previa del usuario ni realiza cobros reales.
