# PDF diseñados: document_create

Pide a Alisio un PDF, un documento para imprimir o «convierte este Markdown a PDF» y produce un
archivo diseñado: portada, tabla de contenido, números de página, tablas, avisos y código con
estilo, en un tema a tu elección. El modelo escribe **solo el contenido** (Markdown o un documento
estructurado); Alisio se encarga de la presentación, de modo que el resultado se ve igual en todas
las máquinas y no interviene HTML ni CSS.

El PDF se publica como un artefacto normal: la interfaz web lo previsualiza, las ejecuciones sin
interfaz lo listan y la terminal interactiva lo lista sin vista previa.

## Qué necesitas {#requirements}

Un navegador de la familia Chromium en la máquina: Google Chrome, Chromium, Microsoft Edge, Brave o
Vivaldi, versión 131 o posterior. Alisio nunca descarga un navegador. Lo busca en este orden: el
ajuste `documents.chromiumPath`, las variables de entorno `ALISIO_CHROME_PATH`, `CHROME_PATH` y
`PUPPETEER_EXECUTABLE_PATH`, las carpetas de instalación habituales del sistema y `PATH`.

```bash
alisio documents status
```

muestra si el motor está listo, su versión y, si no lo está, por qué y cómo arreglarlo. Cuando no
se encuentra ningún navegador, `document_create` responde `DOCUMENT_ENGINE_UNAVAILABLE` con la
acción para tu sistema y publica una versión HTML autocontenida del documento que puedes abrir en
cualquier navegador e imprimir a PDF.

| Sistema | Arreglo habitual |
|---|---|
| Linux | Instala `google-chrome`, `chromium` o `microsoft-edge` con el gestor de paquetes |
| macOS | Instala Google Chrome, Microsoft Edge o Chromium (por ejemplo `brew install --cask google-chrome`) |
| Windows | Instala Google Chrome o usa Microsoft Edge, que viene con Windows |

El binario independiente no incluye archivos de recursos, así que los documentos requieren la
instalación con npm (`npm install -g @alisio/alisio-code`); la compatibilidad con Alisio Desktop
llega con el motor de escritorio.

## Temas {#themes}

| Tema | Úsalo para |
|---|---|
| `executive-clean` (predeterminado) | Informes, propuestas y memorandos: texto con serifa, portada azul marino, filetes finos |
| `data-report` | Tablas, tarjetas de cifras e informes con muchos datos: tipografía sans, acento verde azulado, encabezados de tabla marcados |
| `technical-spec` | Especificaciones, manuales y guías operativas: encabezados numerados, código destacado, tablas con cuadrícula |

Todos los temas admiten A4 y Carta en vertical y horizontal (y Legal y A5), usan solo las
tipografías incluidas (Inter, Source Serif 4 y JetBrains Mono, con la licencia SIL Open Font
License) y colocan el título del documento y los números de página en los márgenes. El modelo
llama primero a `document_themes` para ver la lista, los bloques y el estado del motor.

## Contenido: Markdown o bloques {#content}

Markdown admite encabezados (h4 y siguientes pasan a nivel 3), listas con un nivel anidado, tablas,
citas, código delimitado, imágenes, avisos de GitHub (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`,
`CAUTION`), una línea `---pagebreak---` y `[TOC]`. El front matter define `title`, `subtitle`,
`author`, `date`, `organization`, `theme`, `lang` y `toc: true`; un `title` añade una portada.

Sin front matter, el primer encabezado `#` pasa a ser el título de la portada y las líneas en
negrita `**Clave:** valor` justo debajo (versión, fecha, autor; una línea `Subtítulo` define el
subtítulo) pasan a ser los detalles de la portada, de modo que el cuerpo empieza en la página 2.
Pasa `cover: false` (o `cover: false` en el front matter) para no crear portada. El tema
`technical-spec` numera sus encabezados automáticamente, salvo que el documento ya los numere
(`## 02. Historia`, `### 2.1 Origen`): entonces los deja como están escritos.

Para un control más fino, el modelo envía un `spec` de bloques: `cover`, `heading`, `paragraph`,
`bullets`, `table`, `image`, `quote`, `callout`, `code`, `stat_grid`, `page_break` y `toc`. Los
campos de texto aceptan solo Markdown en línea (negrita, cursiva, código y enlaces). El HTML en
bruto nunca se interpreta: se imprime como texto visible.

Las imágenes son archivos del espacio de trabajo o artefactos de la sesión, declarados en `assets`
y referenciados por id. Las imágenes remotas nunca se descargan; se conserva el texto alternativo
y aparece el aviso `remote_image_skipped`.
Una imagen que no se puede usar (archivo ausente, SVG, cualquier tipo distinto de PNG, JPEG, WebP
o GIF, demasiado grande) no hace fallar el documento: se sustituye por un pequeño marcador con su
texto alternativo y un aviso `image_skipped` indica el motivo. Solo las violaciones de seguridad
(rutas absolutas, `..`, enlaces que salen del espacio de trabajo, un proyecto sin confianza)
detienen la llamada.

## Colores de marca {#brand}

`theme` acepta un id de tema o un objeto `{ "id": "data-report", "accent": "#b4531a", "ink": "#1a1a1a" }`
(o `accent:` e `ink:` en el front matter). El acento colorea las líneas de los encabezados, los
encabezados de tabla, los avisos y los bloques de la portada de todos los temas; la tinta colorea
el texto y los encabezados. Los colores son valores hexadecimales; uno cuyo contraste con la
página sea inferior a 4,5:1 se oscurece hasta cumplirlo y un aviso `accent_adjusted` o
`ink_adjusted` lo indica. Cualquier valor que no sea un color hexadecimal se rechaza con
`DOCUMENT_INPUT_INVALID`.

## Comprobaciones y reparación automática {#qa}

Con `quality: "professional"` (el valor por defecto) cada renderizado se comprueba y, si se detecta
un problema de maquetación conocido, se repara hasta dos veces: una tabla más ancha que la página
cambia la página a horizontal (salvo que fijes una orientación) y luego a una densidad compacta de
tabla. `quality: "fast"` comprueba pero nunca repara. El resultado lista cada aviso y cada
reparación. Las comprobaciones:

- Caracteres que ninguna tipografía incluida cubre (`glyphs_missing`, con la escritura no admitida).
- Contenido más ancho que el área de texto (`overflow`) e imágenes impresas por debajo de 150 ppp.
- Tipografías incrustadas en el PDF que no están incluidas (`font_not_bundled`) y el límite de páginas.
- Una última página vacía, que se repara quitando el salto de página final.

Un PDF con un error sin reparar se publica igualmente, con `Checks: FAILED` y el motivo.

## Seguridad {#security}

- Todo el texto se escapa; la página generada no tiene scripts ni estilos en línea y lleva una
  política de seguridad de contenido estricta.
- La red está desactivada al renderizar: cada petición se intercepta y solo se sirve el paquete del
  propio documento, así que no se descarga ninguna imagen, tipografía ni estilo de ningún sitio.
- Las rutas de recursos deben ser relativas al espacio de trabajo y se resuelven con su ruta real:
  se deniegan las rutas absolutas, `..` y los enlaces simbólicos que salen del espacio de trabajo,
  así como cualquier archivo del espacio de trabajo en un proyecto sin confianza. Solo se aceptan
  PNG, JPEG, WebP y GIF, hasta 10 MB cada uno y 50 MB en total.
- Límites: 400 KB de Markdown, 2 000 bloques, 500 filas por tabla, 200 páginas, un PDF de 50 MB,
  60 s por renderizado y 180 s por llamada, dos renderizados a la vez.
- El navegador se ejecuta con un perfil temporal y un entorno mínimo (sin claves de API) y se
  termina al cancelar o al agotar el tiempo. `documents.chromiumPath` es solo global: un proyecto
  no puede elegir el binario.

## Configuración {#configuration}

| Clave | Valor por defecto | Significado |
|---|---|---|
| `documents.enabled` | `true` | Registra `document_create` y `document_themes`; se aplica en el siguiente arranque |
| `documents.engine` | `auto` | `auto`, `chromium` o `weasyprint` (WeasyPrint aún no está disponible) |
| `documents.chromiumPath` | sin definir | Ruta explícita del navegador (solo global) |
| `documents.defaultPageSize` | `A4` | `A4`, `Letter`, `Legal` o `A5` |

## Límites de esta versión {#limits}

- La salida es RGB para uso de oficina, láser y digital. No es salida para imprenta: sin CMYK, sin
  PDF/X, sin sangrado ni marcas de corte, y sin afirmar conformidad con PDF/A ni PDF/UA (el PDF
  lleva etiquetas cuando el navegador lo admite).
- La tabla de contenido lista los encabezados como enlaces sin números de página.
- Solo texto latino, griego y cirílico. El chino, japonés, coreano, árabe, hebreo y escrituras
  similares se informan como glifos ausentes; los emoji se eliminan. Las flechas, los signos de
  comparación y las marcas de verificación se sustituyen por texto simple porque los subconjuntos
  incluidos no los tienen.
- Los encabezados de capítulo corrientes y las notas al pie de página, el motor de escritorio, los
  gráficos, las imágenes SVG y las comprobaciones visuales no forman parte de esta versión.
- Los PDF programáticos (formularios, fusión, reportlab) siguen con `python_run`; consulta
  [Forja](/es/forja).
