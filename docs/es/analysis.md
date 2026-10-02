# Análisis en Python y artefactos

Alisio puede escribir un script de Python y ejecutarlo en una carpeta que administra, fuera de tu
repositorio. Cada archivo que el script deja en su carpeta de salida se convierte en un
**artefacto descargable**: un dashboard HTML, un informe Markdown, un PDF, una hoja de cálculo, un
gráfico o cualquier otro archivo. La interfaz web muestra cada artefacto como una tarjeta en el
chat; la terminal lo anuncia con su ruta local.

::: warning Python administrado no es un sandbox
Python administrado no es un sandbox: el script se ejecuta con tus permisos y puede leer tus
archivos y usar la red. Lee el script en la aprobación antes de permitirlo.
:::

## Inicio rápido {#quick-start}

No hace falta preparar nada. Alisio descubre Python 3.10 o posterior en tu máquina la primera vez
que el modelo llama a `python_run`:

```sh
alisio                                   # the TUI asks before running Python
alisio run --allow-analysis "Summarize sales.csv into report.md and a bar chart"
alisio analysis status                   # which interpreter was found
```

Pide un resultado, por ejemplo *"analiza data.csv y dame un dashboard HTML"*. El modelo escribe
el script, Alisio pide aprobación, lo ejecuta y publica los archivos.

## Herramientas {#tools}

| Herramienta | Efecto | Qué hace |
| --- | --- | --- |
| `python_run` | `process` (capability `analysis.run`) | Escribe `script/main.py`, lo ejecuta y publica lo que deja en `$ALISIO_OUTPUT_DIR`. |
| `artifact_create` | `internal` | Publica texto que el modelo ya tiene (Markdown, HTML, CSV, JSON, SVG). Funciona sin Python. |
| `artifact_list` | `read` | Lista los artefactos de la sesión. |
| `artifact_read` | `read` | Lee un artefacto de texto (como máximo 64 KiB; los más largos se recortan y lo indican). |
| `artifact_export` | `write` | Copia un artefacto al workspace; confinado a él y tras la aprobación de escritura habitual. |
| `data_inspect` | `read` | Ingiere un archivo CSV, TSV, JSON, JSONL o XLSX en un dataset SQLite y lo describe: hojas, columnas, pistas de tipo, estadísticas y filas de muestra. Consulta [Datos tabulares](#data). |
| `data_query` | `read` | Ejecuta un `SELECT` de solo lectura sobre un dataset, acotado en filas y tiempo. |

`python_run` recibe `code`, un `title` opcional, `inputs` (archivos del workspace, o
`{ "datasetId": … }` para un dataset, copiados a `$ALISIO_INPUT_DIR`), `timeoutMs` (hasta
`analysis.limits.timeoutMs`), `publishOnError`, `extras` (`["analysis"]` o `["science"]`, consulta
[Extras opcionales](#extras)) y `rerunOf` (un artefacto o ejecución de la sesión que se ejecuta de
nuevo en lugar de `code`, consulta [Ejecutar de nuevo](#rerun)). Las herramientas de datos funcionan sin Python
(salvo para XLSX) y con `--read-only`: solo leen, y la ingesta escribe en la carpeta de estado, nunca
en el repositorio.

La interfaz web previsualiza los artefactos en un panel lateral y ejecuta los dashboards HTML en un
visor aislado (sin cookie, sin red, origen opaco); consulta [Interfaz web](/es/web#artifacts). La
TUI previsualiza los artefactos de texto y los copia al workspace desde `/artifacts`; consulta
[TUI](/es/tui#artifacts). Copiar desde la web o la TUI es una llamada real a `artifact_export` en la
sesión, así que pregunta antes de escribir igual que una llamada del modelo.

<figure class="doc-shot">
  <img src="../assets/web-ui/trajectory_web_ui.webp" alt="La pestaña Trayectoria con los eventos durables de una sesión (tool_started, tool_completed, turn_completed, artifact_published, memory_save) y un dashboard ejecutivo de ventas abierto en el panel de artefactos a la derecha." width="1833" height="986" loading="lazy" decoding="async" />
  <figcaption>La pestaña Trayectoria: una fila por evento durable, con un artefacto abierto en el panel lateral.</figcaption>
</figure>

## Cómo funciona una ejecución {#execution}

Cada llamada tiene su propia carpeta de trabajo bajo el directorio de estado (nunca el
repositorio):

```text
<state>/analysis/jobs/<workspace>/<session>/<exec_id>/
├── job.json
├── script/main.py          the model's code, plus the alisio_runtime helpers
├── input/                  copies of the requested inputs
├── work/                   current directory and HOME of the script
├── staging/                $ALISIO_OUTPUT_DIR
└── logs/stdout.log, stderr.log
```

| Variable | Valor |
| --- | --- |
| `ALISIO_OUTPUT_DIR` | `staging/`: lo que se publica |
| `ALISIO_INPUT_DIR` | `input/` |
| `ALISIO_WORK_DIR` | `work/` (también el directorio actual, `HOME` y `TMPDIR`) |
| `ALISIO_EXECUTION_ID` | `exec_…` |
| `MPLBACKEND` | `Agg` |

El intérprete se ejecuta con `-E -s -B -u -X utf8` y un entorno en lista blanca: nunca recibe
claves de proveedor ni variables `ALISIO_*` de configuración. Solo están disponibles la biblioteca
estándar de Python y el paquete incluido `alisio_runtime`, salvo que instales los extras
opcionales.

- Código de salida 0: se publica todo lo que hay en `staging/`.
- Código distinto de 0: no se publica nada, salvo con `publishOnError`; entonces los artefactos
  quedan marcados como **Parcial**.
- Tiempo agotado (`analysis.limits.timeoutMs`, 120 s por defecto): la ejecución queda
  `timed_out` y no se publica nada.
- Detener (web o TUI): se termina el árbol de procesos y no se publica nada.

### Qué se publica {#publishing}

Sin `outputs.json`, cada archivo de primer nivel de la carpeta de salida es un artefacto; una
carpeta de primer nivel con `index.html` es un dashboard multiarchivo; cualquier otra carpeta se
convierte en un archivo ZIP. Para elegir nombres y títulos, escribe `outputs.json`:

```json
{ "artifacts": [
  { "path": "sales-dashboard", "title": "Sales dashboard", "entry": "index.html" },
  { "path": "summary.pdf", "title": "Executive summary" }
] }
```

Los archivos se copian a `<state>/artifacts/…/files/` junto a un `manifest.json` público (sin
rutas absolutas ni código). La publicación es todo o nada: enlaces simbólicos, enlaces duros,
`..`, archivos ocultos, más de `analysis.limits.maxFiles` archivos, un archivo por encima de
`maxFileBytes` o un total por encima de `maxOutputBytes` rechazan la publicación completa con el
motivo. El script, sus logs y `job.json` nunca se publican.

### alisio_runtime {#alisio-runtime}

Un paquete auxiliar en Python puro que se copia junto a cada script:

```python
from alisio_runtime import output_dir, html, svg, charts, outputs

chart = svg.bar(["Q1", "Q2", "Q3"], [12, 18, 9], title="Sales")
html.write("index.html", "Sales", f"<h1>Sales</h1>{chart}")
(output_dir() / "summary.md").write_text("# Summary\n", encoding="utf-8")
outputs.declare("index.html", title="Sales dashboard")
```

El HTML se mostrará sin conexión: incrusta datos, scripts y estilos en línea (sin CDN ni
`fetch`). Para los gráficos usa `charts` o `svg` (siguiente sección) en lugar de escribir SVG o
cargar una biblioteca a mano.

### Gráficos {#charts}

Los modelos que dibujan gráficos a mano suelen equivocarse: arcos SVG de tarta con un
`large-arc-flag` incorrecto o un sector del 100% roto, SVG de tamaño fijo que se quedan diminutos
dentro de una tarjeta grande, o un `<script src>` a un CDN que el visor bloquea (sin red).
Por eso `alisio_runtime` incluye dos ayudantes probados. Chart.js es el único motor de gráficos.

| Ayudante | Úsalo para | Notas |
| --- | --- | --- |
| `charts` | Dashboards interactivos en un solo HTML | [Chart.js](https://www.chartjs.org/) 4.5.1 (MIT) incluido con Alisio e incrustado **una sola vez** por página: sin CDN, sin red y sin `eval`, así que funciona en el visor, sin conexión y en el archivo descargado. Adaptable al contenedor, con tooltips, leyendas, etiquetas de valor, una etiqueta para lectores de pantalla y una tabla de datos plegable por gráfico, con colores claros y oscuros que siguen el esquema de la página. |
| `svg` | Salida estática (un archivo `.svg`, un informe, sin script) y alternativa | Un único `<svg>` con `viewBox` que escala con su contenedor, `<title>` y `<desc>`, y texto con `currentColor`. |

```python
from alisio_runtime import charts

body = charts.kpis(("Orders", "1,204", "+8% vs last month")) + charts.grid(
    charts.card("Order status", charts.donut(["Delivered", "In transit", "Cancelled"], [81.7, 14.8, 3.4])),
    charts.card("Sales by seller", charts.bar(
        ["Ana", "Luis", "Marta"], {"Sales": [120000, 95000, 87000], "Profit": [30000, 21000, 25000]},
        fmt="currency:USD", locale="en-US")),
    charts.card("Orders per month", charts.line(["Jan", "Feb", "Mar"], {"Orders": [120, 135, 128]})),
)
charts.write("dashboard.html", "Sales dashboard", body)   # Chart.js is inlined here, once
```

`charts.pie`, `donut`, `bar`, `hbar`, `line`, `area` y `scatter` reciben las etiquetas y los valores
(una lista, o `{nombre de serie: lista}` para varias series, agrupadas o con `stacked=True`) y,
opcionalmente, `title`, `fmt`, `locale`, `unit`, `height` y `note`. `fmt` es `"number"`,
`"integer"`, `"percent"` (los valores son fracciones), `"compact"`, `"currency:USD"` (cualquier
código ISO) o un diccionario de opciones de `Intl.NumberFormat`; `locale` es una etiqueta como
`"es-CO"` (por defecto, la del visor). Compón la página con `charts.card` (un gráfico por tarjeta),
`charts.grid` y `charts.kpis`; `charts.write` (o `charts.page`) añade la biblioteca y el script de
dibujo una sola vez, sin importar cuántos gráficos tenga la página. Los valores de una tarta que
faltan, no son numéricos o son negativos se omiten con un aviso en stderr, los datos vacíos
muestran un mensaje "No data" en lugar de fallar, y más de 8 series lanzan un error porque ninguna
paleta permite distinguirlas. Las funciones de `svg` (`pie`, `donut`, `bar`, `hbar`, `line`,
`area`, `scatter`) reciben los mismos datos; `svg.pie_slices` es la geometría pura de las tartas (el
último sector termina exactamente en 360 grados y un único sector del 100% es un círculo completo).

Pautas que recibe el modelo: un gráfico por tarjeta con una altura mínima, una tarta solo para 2 a 5
partes (más categorías se agrupan en "Other"; usa una dona o `hbar`), etiqueta siempre los valores,
conserva la tabla de datos y da formato a dinero y números con el idioma del usuario. Plotly sigue
siendo un extra opcional (`alisio analysis setup --extras analysis`, unos 75 MB con sus
dependencias) para lo que Chart.js no cubre; `html.inline_plotly()` lo incrusta.

Cuando un artefacto HTML publicado contiene arcos SVG de tarta escritos a mano, gráficos SVG de
tamaño fijo sin `viewBox` o un script u hoja de estilos cargados desde la red, el resultado de
`python_run` añade un `warning:` que nombra los ayudantes. Nunca rechaza el artefacto.

<figure class="doc-shot">
  <img src="../assets/web-ui/dashboard_charts_web_ui.webp" alt="Un dashboard creado con alisio_runtime.charts: tres cifras destacadas, una dona del estado de los pedidos y una tarta del reparto por canal con porcentajes en cada sector, y un gráfico de barras agrupadas de ventas y beneficio por vendedor, todos ajustados a sus tarjetas." width="1280" height="1000" loading="lazy" decoding="async" />
  <figcaption>Un dashboard generado con <code>alisio_runtime.charts</code> en el visor aislado.</figcaption>
</figure>

### Tipos de artefacto {#types}

El tipo sale de la extensión y de los primeros bytes; si no coinciden, el archivo es solo
descargable. Se publican dashboards (`.html`), documentos (`.md`, `.pdf`, `.docx`, `.odt`,
`.pptx`), hojas de cálculo (`.csv`, `.tsv`, `.xlsx`), imágenes (`.png`, `.jpg`, `.gif`, `.webp`,
`.svg`), datos (`.json`), texto y código, archivos comprimidos (`.zip`) y cualquier otro archivo.
En la interfaz web, las hojas de cálculo se abren en el [visor de tablas](/es/web#tables); un CSV o
TSV puede estar en UTF-8, UTF-16 (con BOM) o windows-1252.

<figure class="doc-shot">
  <img src="../assets/web-ui/dashboard_generated.webp" alt="Un dashboard ejecutivo de ventas generado por Alisio en el panel de artefactos: ranking de vendedores, ventas por canal, segmentos de clientes y estado de los pedidos." width="1835" height="990" loading="lazy" decoding="async" />
  <figcaption>Un dashboard ejecutivo generado en el panel de artefactos.</figcaption>
</figure>

## Datos tabulares {#data}

Los archivos CSV, TSV, JSON, JSONL y XLSX se convierten en **datasets**: un archivo SQLite por
dataset, creado con `node:sqlite` de Node (no se añade ningún motor de base de datos ni dependencia
nativa). El archivo original nunca se modifica; el SQLite es una copia regenerable. La interfaz web
adjunta un archivo con el botón `+` del compositor (muestra *Leyendo sales.csv…* y luego un chip que
abre la tabla); en la terminal el modelo lee un archivo del workspace con `data_inspect { path }`
(las rutas fuera del workspace siguen la aprobación de directorios habitual). El mismo contenido en la
misma sesión reutiliza su dataset.

<figure class="doc-shot">
  <img src="../assets/web-ui/Preview_of_tabular_data_in_CSV_and_Excel.webp" alt="El visor de tablas con un CSV de 300 filas, su filtro y los botones de copiar y descargar, junto al chip del dataset adjunto en la conversación." width="1831" height="980" loading="lazy" decoding="async" />
  <figcaption>El visor de tablas con un CSV de 300 filas y el chip de datos adjuntos en el chat.</figcaption>
</figure>

```text
CSV/TSV/JSON/JSONL ── proceso del motor de datos (node:sqlite) ──┐
XLSX ── biblioteca estándar de Python (zipfile + xml + sqlite3) ─┤──► <dataset>.sqlite (solo lectura)
                                                                 │        │
       data_inspect / data_query / visor de tablas ◄─────────────┘        └──► python_run lo lee con sqlite3
```

### No se pierde nada {#data-lossless}

Las columnas no declaran tipo, así que SQLite no convierte nada. El analizador guarda una celda como
número solo cuando su texto es un número simple (sin ceros a la izquierda, sin separadores de miles,
dentro del rango entero seguro); todo lo demás conserva su **texto exacto**: `007`, `1,234`, `$12`,
`N/A`. Las celdas vacías son `NULL`. La única normalización es `1.50` → `1.5`. Cada columna recibe una
pista de tipo (`integer`, `real`, `date`, `boolean` o `text`, según las primeras 1 000 filas) y
estadísticas (filas, nulos, distintos, mínimo, máximo, media, los cinco valores más frecuentes y
`text_fallbacks`, el número de celdas guardadas como texto en una columna que parece numérica), todo
dentro del archivo. Los nombres de columna son identificadores ASCII en minúsculas (`Año de venta` →
`ano_de_venta`); el encabezado original queda como etiqueta.

| Formato | Notas |
| --- | --- |
| CSV, TSV | RFC 4180 (comillas, comillas dobladas, saltos de línea dentro de comillas, CRLF), UTF-8 con o sin BOM, UTF-16 por BOM, windows-1252 si los bytes no son UTF-8, delimitador `,` `;` TAB o `\|` detectado. Las filas irregulares se rellenan o recortan. Una primera fila numérica son datos, no encabezado. Tabla `data`. |
| JSONL | Un objeto por línea; las claves pueden aparecer tarde. Los valores anidados se guardan como texto JSON y los booleanos como `true`/`false`. Tabla `data`. |
| JSON | Un array de objetos (hasta 50 MiB; para más, usa JSONL). |
| XLSX | Necesita Python 3.10+ (el helper de la biblioteca estándar `alisio_runtime/xlsx_to_sqlite.py`: cadenas compartidas e *inline*, números, fechas según el formato, épocas 1900 y 1904, booleanos, fórmulas como su valor en caché). Una tabla `s_<hoja>` por hoja. Sin Python la respuesta es `dataset_unsupported`: *Export the sheet as CSV, or install Python 3.10+.* |

Un XLSX y su exportación a CSV producen las mismas columnas, tipos y estadísticas.

### Consultas {#data-query}

`data_query` recibe una sola sentencia `SELECT` o `WITH` (dialecto SQLite; entrecomilla los nombres de
columna) y devuelve como máximo `maxRows` filas (200 por defecto, máximo 1 000, celdas recortadas a
2 KiB), como texto para el modelo y como bloque de tabla para la terminal y la web. Tiene doble
protección porque `node:sqlite` no tiene *authorizer*, *progress handler* ni `interrupt()`, y
`prepare()` descarta en silencio el texto posterior a la primera sentencia:

- una comprobación léxica rechaza más de una sentencia, todo lo que no sea `SELECT`/`WITH`, `ATTACH`,
  `PRAGMA`, `INSERT`, `UPDATE`, `DELETE`, `CREATE`, `DROP`, `VACUUM`, transacciones y `load_extension`
  fuera de literales y comentarios (`replace(…)` como función es válida);
- el archivo se abre en solo lectura (`query_only`, `trusted_schema=OFF`, sin extensiones) en un
  proceso aparte.

Una sentencia que supera `analysis.data.queryTimeoutMs` (5 s) se **mata junto con su proceso**
(`query_timeout`) y la consulta siguiente arranca otro. Un dataset de otra sesión responde
`not_found`.

### Desde Python {#data-python}

`python_run { inputs: [{ "datasetId": "ds_…" }] }` copia el archivo SQLite a
`$ALISIO_INPUT_DIR/<nombre>.sqlite` (nunca un enlace, para que un script no pueda alterar el original)
y lo lista en `input/inputs.json`:

```python
from alisio_runtime import datasets

db = datasets.open("sales")                     # sqlite3, solo lectura: mode=ro&immutable=1
total = db.execute("SELECT sum(revenue) FROM data").fetchone()[0]
for column in datasets.columns("sales"):        # pistas de tipo y estadísticas
    print(column["name"], column["type"], column["nulls"])
```

Con los extras opcionales instalados, `pandas.read_sql_query("SELECT * FROM data", db)` funciona
sobre la misma conexión.

### Límites {#data-limits}

| Clave | Valor por defecto | Significado |
| --- | --- | --- |
| `analysis.data.maxUploadBytes` | 200 MiB | Archivo más grande que se ingiere |
| `analysis.data.maxRows` | 5 000 000 | Filas por hoja; un archivo mayor no deja dataset |
| `analysis.data.queryTimeoutMs` | 5 000 | Tiempo máximo de una sentencia de `data_query` |
| `analysis.data.maxInteractiveRows` | 1 000 000 | Por encima, el visor de tablas desactiva el orden y el filtro |

Además, fijos: 1 000 columnas y 1 MiB por celda. Los archivos no tienen índices (son de solo lectura),
así que ordenar y filtrar recorren la hoja; el análisis complejo va en `python_run`. Consulta
[Limitaciones](/es/limitations) para lo que `node:sqlite` no puede hacer.

## Permisos {#permissions}

`python_run` declara la capability `analysis.run` dentro del efecto `process`:

| Estado | Resultado |
| --- | --- |
| `--read-only` o `analysis.enabled: false` | No se registra ninguna herramienta de análisis. |
| `--allow-process` o `--allow-analysis` | Se ejecuta sin preguntar (auditado como `flag`). |
| "Permitir en esta sesión" guardado | Se ejecuta sin preguntar, también tras reiniciar y en `alisio resume`. |
| En otro caso, interactivo | Pregunta: Permitir esta vez / Permitir en esta sesión / Denegar. |
| En otro caso, headless | `python_run` no se ofrece. |

Permitir Python nunca permite `shell` ni `run_process`. Una denegación queda registrada pero no se
recuerda: la siguiente llamada vuelve a preguntar. Revisa y revoca los permisos guardados con
`/permissions` (TUI y web) o con el botón de llave de la cabecera web.

Instalar los [paquetes opcionales](#extras) es una segunda capability, `analysis.install`.
**Siempre pregunta**, solo ofrece **Permitir esta vez** y **Denegar** (no se guarda nada) y ninguna
flag, preset ni permiso anterior la cubre. En una ejecución headless no existe: la llamada falla y
nombra el comando opcional que hace lo mismo a mano.

## Runtime de contenedor {#oci}

Por defecto el script se ejecuta con tu propio Python (`managed`). Si tienes Docker o Podman puedes
ejecutarlo en un contenedor; es opcional y nunca obligatorio:

```json
{
  "analysis": {
    "runtime": "oci",
    "oci": {
      "engine": "docker",
      "image": "python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f",
      "memoryMb": 2048,
      "cpus": 2
    }
  }
}
```

Solo tu configuración de **usuario** puede elegir el runtime y la imagen (el `.alisio/config.json`
de un proyecto no puede: se ignora con un aviso). La imagen debe fijarse por digest
(`nombre@sha256:…`); una etiqueta como `python:3.12` se rechaza al cargar la configuración, así que
una etiqueta móvil nunca cambia lo que ejecuta tu código. Descárgala una vez; Alisio nunca descarga
ni construye durante un análisis:

```sh
alisio analysis setup --oci --image python:3.12-slim   # la descarga e imprime el valor con digest
alisio analysis setup --oci                            # descarga analysis.oci.image y la verifica
alisio analysis status                                 # motor, versión y si la imagen está
```

La imagen necesita `python` en su `PATH`; para usar pandas y compañía, construye o elige una imagen
que los traiga (el entorno de extras no se usa en modo contenedor). Cada ejecución lanza:

```text
<motor> run --rm --name alisio-<exec_id> --network=none --read-only --cap-drop=ALL
  --security-opt=no-new-privileges --pids-limit=256 --memory=<memoryMb>m --cpus=<cpus>
  [--user <uid>:<gid>]  -v …/script:/job/script:ro  -v …/input:/job/input:ro
  -v …/work:/job/work:rw  -v …/staging:/job/out:rw  --tmpfs /tmp:size=256m  <imagen> python …
```

| Garantía | `managed` | `oci` |
| --- | --- | --- |
| Leer tus archivos fuera del trabajo | No impedido | Impedido (solo se ven los montajes) |
| Escribir fuera del trabajo | No impedido | Impedido salvo `work/` y `staging/` |
| Red | No impedida | Bloqueada (`--network=none`) |
| Memoria y CPU | Solo el tiempo máximo | Limitadas |
| Procesos huérfanos | Grupo de procesos; `setsid` puede escapar | Contenidos en el contenedor |
| Escapar del contenedor | n/a | Posible ante una vulnerabilidad del kernel o del motor |

El aislamiento es parcial: un contenedor no es una frontera frente a código hostil. Cancelar una
ejecución (o su tiempo máximo) ejecuta además `<motor> kill alisio-<exec_id>`, porque detener el
cliente no siempre detiene el contenedor, y no queda ningún contenedor `alisio-*`. Notas por
plataforma:

- **Linux**: los archivos que escribe el script son tuyos (`--user`). Docker sin root mapea tu
  usuario por sí mismo; Podman sin root añade `--userns=keep-id`. Con SELinux en modo enforcing los
  montajes se reetiquetan (`,z`).
- **macOS y Windows (Docker Desktop)**: se omite `--user` porque el uso compartido de archivos
  mapea el propietario. Las rutas con espacios o caracteres no ASCII funcionan (los argumentos
  nunca pasan por un shell); una ruta del host con `:` (fuera del prefijo de unidad de Windows) se
  rechaza con un mensaje.
- Verificado en Linux con Docker (red bloqueada, escribir fuera de `/job/out` y `/job/work` falla,
  cancelar no deja contenedores). No verificado aquí: Podman, Docker Desktop en macOS y Windows.

## Sin Python {#no-python}

Si no hay Python 3.10+, `python_run` responde con instrucciones de instalación para tu sistema
(`winget` en Windows, Homebrew o python.org en macOS, `apt`, `dnf`, `pacman`, `zypper`, `apk`…) y
no ejecuta nada. `alisio doctor` y `alisio analysis status` muestran la misma guía. Instala Python
y vuelve a pedirlo; no hace falta reiniciar. Para fijar un intérprete, inicia Alisio con
`--python <path>`.

## Extras opcionales {#extras}

pandas, numpy, Matplotlib y compañía no son necesarios para trabajar con la biblioteca estándar. Se
instalan solo cuando los quieres, desde wheels con hashes fijados en un entorno virtual privado (no
se compila nada, y nada se instala durante una ejecución sin tu aprobación):

```sh
alisio analysis setup --extras analysis   # pandas, numpy, matplotlib, openpyxl, python-docx, reportlab, plotly, jinja2
alisio analysis setup --extras science    # analysis + scipy, statsmodels, scikit-learn
```

También puedes dejar que el modelo lo pida. Una llamada `python_run { extras: ["analysis"] }` sin los
extras instalados pide el permiso `analysis.install`, mostrando los paquetes, una estimación de la
descarga (unos 75 MB para `analysis`, 140 MB para `science`) y que necesita red; **Permitir esta
vez** los instala y el script se ejecuta, **Denegar** (o una ejecución headless) falla con
`alisio analysis setup --extras analysis` como comando opcional.

Toda instalación usa `--require-hashes` y `--only-binary=:all:` con los lockfiles que trae Alisio.
Sin red (o con el índice inalcanzable) falla limpiamente: el mensaje dice que no se instaló nada, no
queda un entorno a medio construir, el entorno que ya estaba activo se mantiene y `python_run` sigue
funcionando con la biblioteca estándar.

Existen wheels de todos los paquetes en Linux, macOS y Windows, x64 y arm64, con Python 3.10, 3.12 y
3.13, comprobado con `pip download --only-binary=:all:` por el job de CI `extras-wheels`. Límites
conocidos (también comprobados): Windows sobre Arm las tiene para `analysis` con Python 3.12 y 3.13
pero no con 3.10, y para `science` solo con 3.13; Alpine (musl) no tiene wheel de scikit-learn, así
que `science` no está disponible allí.

## Retención {#retention}

Los datos de análisis crecen, así que un limpiador los depura como máximo una vez cada 24 horas, en
segundo plano unos segundos después de arrancar Alisio (nunca retrasa el arranque, y no se ejecuta
con `--read-only` ni con `analysis.enabled: false`). Ejecútalo ahora con
`alisio analysis sweep [--force]`.

| Qué | Se elimina tras | Ajuste |
| --- | --- | --- |
| `work/` (temporales) de un trabajo | 7 días | `analysis.retention.intermediateDays` |
| `logs/` y `staging/` de un trabajo | 30 días | `analysis.retention.jobsDays` |
| `script/`, `input/` y `job.json` | 30 días **y** ningún artefacto listo de esa ejecución | `analysis.retention.jobsDays` |
| Artefactos | Nunca por defecto; con un número pasan a **Caducado** (archivos borrados, tarjeta conservada) | `analysis.retention.artifactsDays` |
| Datasets | 30 días sin uso, con el original subido en `blobs/` | `analysis.retention.jobsDays` |

`0` desactiva el borrado de ese tipo de archivo. Las ejecuciones en curso nunca se tocan, solo se
borran carpetas bajo `analysis/jobs`, y los valores de retención son solo globales (un barrido cubre
todos los workspaces). Edítalos en **Ajustes → Análisis de datos** (web) o `/settings` (TUI).

## Ejecutar de nuevo y procedencia {#rerun}

Cada artefacto lleva su procedencia en `manifest.json` y en **Detalles**: fecha, modelo, proveedor,
runtime (`managed` con la versión de Python y los extras, u `oci` con el motor y el digest de la
imagen), las entradas con su sha256, el id de la ejecución y el hash del script, nunca el script en
sí ni una ruta.

**Ejecutar de nuevo** (web: **Ejecutar de nuevo** en el menú del panel; TUI: `/artifacts` →
**Rerun**) ejecuta el mismo `script/main.py` con las mismas entradas como una ejecución **nueva**:
artefactos nuevos que registran `rerunOf` (la ejecución original), y la ejecución y los artefactos
anteriores nunca se sobrescriben. Pasa por el mismo permiso que la primera ejecución. Las entradas
son las copias que conserva el trabajo original, comprobadas por sha256 (un dataset debe seguir
existiendo con el mismo contenido); si falta o cambió el script, una entrada o un dataset, no se
ejecuta nada y se listan todos los problemas. Un artefacto caducado se puede volver a ejecutar
mientras se conserve su script, que es la forma de recrearlo. El modelo puede hacer lo mismo con
`python_run { rerunOf: "art_…" }`.

## Dónde se guarda todo {#storage}

| Carpeta | Contenido |
| --- | --- |
| `<state>/artifacts/<workspace>/<session>/<slug>--<art_id>/` | `manifest.json` y `files/` |
| `<state>/analysis/jobs/…` | scripts, entradas y logs (no se publican) |
| `<state>/analysis/datasets/<workspace>/<session>/<ds_id>.sqlite` | un archivo SQLite de solo lectura por dataset |
| `<state>/analysis/engine/` | el script del motor de datos (una copia empaquetada, escrita una vez) |
| `<state>/blobs/` | archivos subidos desde la web (los originales de los datasets) |
| `<state>/runtimes/python/` | `discovery.json` y los entornos opcionales de extras |
| `<state>/analysis/.last-sweep` | cuándo se ejecutó el último barrido de retención (`.sweep.lock` mientras corre) |

`<state>` es `~/.local/state/alisio` (o `ALISIO_STATE_HOME`, o la carpeta de `--db`).
