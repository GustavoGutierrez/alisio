# Forja: modo código

Forja es la forma en que Alisio ejecuta código por encargo del modelo. En lugar de llamar a diez
herramientas una a una y arrastrar cada respuesta por la conversación, el modelo escribe un script
corto que compone las llamadas, filtra los datos y devuelve solo lo que importa. El modo código se
compone de dos herramientas:

- **`js_run`** compone herramientas: un script de JavaScript en una VM aislada que llama a otras
  herramientas (`read_file`, `search_text`, tus herramientas MCP…), las ejecuta en paralelo y
  devuelve un resultado pequeño.
- **`python_run`** se ocupa de datos, aprendizaje automático y dashboards: un script de Python que
  lee archivos, los analiza y publica los archivos que produce ([Análisis en Python](/es/analysis)).

Ambas se ejecutan sobre el mismo núcleo: cada ejecución queda en el diario, informa de su progreso,
tiene límites y se puede cancelar, y el resultado dice qué motor se usó y por qué.

::: warning Conoce qué significa cada nivel de aislamiento
`js_run` está aislado por construcción. `python_run` está tan aislado como el backend que elija
Alisio, y uno de ellos no es un sandbox en absoluto. [Aislamiento y sus límites](#isolation) enumera
exactamente qué se garantiza y qué no.
:::

## Elegir el lenguaje {#language}

Lo elige el modelo; tú no lo configuras. La regla de enrutado del prompt del sistema le indica usar:

| Tarea | Herramienta |
| --- | --- |
| Combinar varias llamadas a herramientas, filtrar o agregar sus resultados, paginar, repartir en paralelo | `js_run` |
| Leer una hoja de cálculo o un CSV, estadística, gráficos, un informe, un dashboard, scikit-learn o statsmodels | `python_run` |
| Una llamada a una herramienta | La propia herramienta, sin script |

Antes de escribir código no trivial el modelo puede llamar a [`forge_guide`](#forge-guide) para
conocer los límites, las herramientas y los paquetes vigentes. Los scripts de `js_run` no tienen
acceso propio a archivos, red ni sistema: todo pasa por llamadas anidadas, y cada llamada anidada
pasa por la misma puerta de permisos que una llamada del modelo (una llamada que necesitaría
aprobación se rechaza con `APPROVAL_REQUIRED` en lugar de preguntar, de modo que el script no puede
pedirla por su cuenta). Las concesiones almacenadas no se aplican a las llamadas anidadas: una llamada
directa con concesión puede ejecutarse mientras la anidada recibe `APPROVAL_REQUIRED`. Es una decisión
deliberada.

<figure class="doc-shot">
  <img src="../assets/web-ui/forge_js_run_web_ui.webp" alt="Una tarjeta js_run expandida en la interfaz web: la insignia del motor JavaScript, el script resaltado con las líneas de progress y tools.call, la lista de siete llamadas anidadas (un listado y seis lecturas, cada una terminada con su duración), el valor JSON que devolvió el script y su salida de texto." width="1400" height="1180" loading="lazy" decoding="async" />
  <figcaption>Una tarjeta de <code>js_run</code>: el código, las llamadas anidadas con su estado y duración, y lo que devolvió el script.</figcaption>
</figure>

Cuando `forge.javascript.enabled` está activo (por defecto), `js_run` sustituye a la herramienta
`execute` anterior, que deja de registrarse; las sesiones guardadas con llamadas `execute` siguen
abriéndose y se muestran igual. Ponlo en `false` para recuperar `execute` y el prompt anterior.

## Aislamiento y sus límites {#isolation}

| Motor | Dónde se ejecuta | Qué garantiza |
| --- | --- | --- |
| `js_run` | QuickJS compilado a WebAssembly, en un hilo worker (Node) o un proceso hijo (Bun, el binario independiente) | Sin archivos, red, temporizadores ni procesos: la VM solo ve lo que el host le entrega. Se imponen límites de tiempo, heap, pila, llamadas y salida; la parada se confirma. |
| `python_run` en `oci` | Un contenedor Docker o Podman | Sin red, raíz de solo lectura, solo las carpetas del trabajo montadas. |
| `python_run` en `wasm` | Pyodide en un proceso de Node restringido (Modelo de Permisos de Node) | Archivos limitados al trabajo (y una copia sin enlaces del scratchpad), sin procesos hijos. Consulta los límites más abajo. |
| `python_run` en `managed` | Tu propio Python | **Ninguna.** Se ejecuta con los permisos de tu usuario. |

Alisio elige el backend de Python (consulta [Dónde se ejecuta un script](/es/analysis#backends));
nunca lo elige el modelo. Los límites, con honestidad:

- **`wasm`, red:** **no está bloqueada en Node 22 y 24**: Python puede alcanzar `node:http` a través
  del puente. Alisio sondea el proceso real e informa de lo que vio; `analysis.isolation: strict`
  excluye `wasm` salvo que el sondeo haya visto la red rechazada.
- **`wasm`, memoria:** un límite blando. El proceso padre muestrea al hijo cada 250 ms y lo mata por
  encima de `analysis.wasm.memoryMb`, así que puede excederse un instante.
- **`wasm`, escape:** el Modelo de Permisos no es una frontera frente a código hostil. Un script
  puede alcanzar el JavaScript del ejecutor (la FFI llega al proceso); el ejecutor no guarda
  secretos y el host valida todo lo que produce.
- **`wasm`, lo que un script aún puede ver:** es una mitigación, no una caja sellada. A través del
  puente un script puede leer `os.homedir()`, `os.hostname()` y `os.userInfo()` (nombre de usuario y
  ruta del home), y las rutas absolutas del host de la distribución y de las carpetas del job aparecen
  en `process.argv` del hijo. El contenido de archivos fuera del job sigue fuera de alcance. Lo que el
  ejecutor imprime cuando falla lleva las rutas del host sustituidas por marcadores (`<dist>`,
  `<job>/...`) antes de llegar al modelo.
- **`wasm`, scratchpad:** el hijo nunca recibe el scratchpad real. El proceso padre lo copia a la
  carpeta del job sin seguir enlaces (los enlaces simbólicos y los archivos especiales se omiten, 64 MB
  como máximo) y concede lectura solo sobre esa copia, de modo que un enlace puesto en el scratchpad
  no lleva a ninguna parte. En `oci` el scratchpad se monta de solo lectura y un enlace dentro se
  resuelve dentro del contenedor.
- **`wasm`, versión de Node:** el Modelo de Permisos de Node tuvo un salto mediante enlaces simbólicos
  (CVE-2025-55130, corregido en Node 22.22, 24.13 y 25.3). El backend `wasm` rechaza cualquier Node
  anterior y explica por qué; Node 23 nunca recibió la corrección.
- **`managed`:** no es un sandbox. Lee el script en la aprobación antes de permitirlo.
- **Host worker de `js_run`:** la VM está aislada, pero el worker es un hilo del proceso de Alisio.
  Un fallo que escapara del motor WebAssembly comprometería el proceso anfitrión; por eso Bun y el
  binario usan un proceso hijo, y por eso existe `forge.javascript.host` para diagnóstico.

<figure class="doc-shot">
  <img src="../assets/web-ui/forge_python_backends_web_ui.webp" alt="La sección Python de la página Forja de los ajustes con tres tarjetas de backend: Contenedor (No listo, aislado por el sistema operativo, con el comando de preparación), WebAssembly (No listo, proceso parcialmente restringido, con el comando de preparación) y Gestionado (Listo, En uso, sin aislamiento, se ejecuta en el host con tus privilegios), seguidas de las filas de runtime y política de aislamiento." width="1400" height="900" loading="lazy" decoding="async" />
  <figcaption>Los backends de Python: estado, aislamiento en texto e icono, el comando de preparación cuando falta uno y la política vigente.</figcaption>
</figure>

## Configuración {#configuration}

Forja vive bajo `forge` en `config.json`; los backends de Python viven bajo `analysis` (consulta
[Configuración](/es/configuration)). Un proyecto solo puede bajar los límites y apagar funciones.

| Clave | Por defecto | Significado |
| --- | --- | --- |
| `forge.javascript.enabled` | `true` | `js_run` activo (y `execute` apagado) o apagado. Editable desde la web |
| `forge.javascript.host` | `"auto"` | `auto` (worker en Node, proceso en Bun), `worker` o `process`. Solo global |
| `forge.javascript.timeoutMs` | `30000` | Límite de tiempo por script (hasta 300 000). Un proyecto puede bajarlo |
| `forge.javascript.memoryBytes` | `33554432` | Heap de la VM (hasta 128 MiB). Solo global |
| `forge.javascript.stackBytes` | `262144` | Pila de la VM (hasta 512 KiB). Solo global |
| `forge.javascript.maxToolCalls` | `50` | Llamadas anidadas por script (hasta 500). Un proyecto puede bajarlo |
| `forge.javascript.maxConcurrency` | `4` | Llamadas anidadas a la vez (hasta 16). Un proyecto puede bajarlo |
| `forge.javascript.maxOutputChars` | `16000` | Caracteres devueltos al modelo (hasta 48 000). Un proyecto puede bajarlo |
| `forge.state.enabled` | `true` | El objeto `state` que los scripts comparten entre ejecuciones de la sesión |
| `forge.state.maxTotalBytes` | `524288` | Tamaño de ese estado (hasta 8 MiB). Solo global |
| `forge.scratch.enabled` | `true` | El [scratchpad](#scratchpad). Solo global |
| `forge.scratch.root` | sin definir | Carpeta base de los scratchpads; `ALISIO_TMPDIR` tiene prioridad. Solo global |
| `forge.scratch.retentionDays` | `7` | Días sin actividad antes de eliminar un scratchpad; `0` nunca |
| `forge.scratch.maxBytes` | `268435456` | Cuota por sesión |
| `forge.guides.enabled` | `true` | La herramienta [`forge_guide`](#forge-guide). Editable desde la web |
| `analysis.runtime` | `"auto"` | `auto`, `managed`, `oci` o `wasm`. Solo global |
| `analysis.isolation` | `"preferred"` | `preferred`, `required` o `strict`: a qué puede recurrir `auto`. Solo global |
| `analysis.wasm.*` | | Memoria, margen de arranque, tamaño de entradas y ruta de `node` del backend WebAssembly |

```json
{
  "forge": { "javascript": { "timeoutMs": 60000, "maxToolCalls": 100 } },
  "analysis": { "runtime": "auto", "isolation": "required" }
}
```

## Comprobar y preparar los motores {#status}

```sh
alisio forge status           # JavaScript y cada backend de Python: estado, aislamiento, límites, por qué no está listo
alisio forge status --probe   # además ejecuta un script real en el aislado
alisio forge status --json
alisio analysis setup --wasm  # descarga el runtime Pyodide fijado (unos 44 MB; --profile science añade scipy y scikit-learn)
```

`alisio forge status` verifica el módulo WebAssembly contra su SHA-256 fijado, muestra el host que lo
ejecutará y, de cada backend de Python, si está listo, su aislamiento y si el sistema operativo le
deniega la red. La interfaz web muestra lo mismo en la página Forja.

## El scratchpad {#scratchpad}

Un scratchpad es una carpeta privada por sesión donde el modelo guarda scripts largos y archivos
intermedios, de modo que puede editar `plan.js` entre ejecuciones en lugar de reenviar todo el
código, y ejecutarlo con `codePath`:

```text
js_run     { "codePath": "scan.js" }
python_run { "codePath": "out/report.py" }
```

| Propiedad | Comportamiento |
| --- | --- |
| Ubicación | `<tmp>/alisio-<uid>/<workspace>/<sesión raíz>/scratchpad/`, bajo `ALISIO_TMPDIR` o `forge.scratch.root` si están definidos; una sesión hija comparte el de su raíz. Si la carpeta compartida no es privada para ti, Alisio recurre a `<state>/scratch/` y lo indica |
| Permisos | Se crea con `0700` y se comprueba (un directorio, no un enlace simbólico, tuyo). Escribir con las herramientas de archivos no pide aprobación dentro de él; `--read-only` sigue denegándolo |
| Retención | Se elimina tras `forge.scratch.retentionDays` (7) sin actividad, o al borrar la sesión; se barre como máximo una vez al día y nunca fuera de la raíz verificada |
| Cuota | `forge.scratch.maxBytes` (256 MiB). Una escritura que la superaría se deniega con un error claro; no se borra nada |
| `codePath` | Una ruta relativa dentro del scratchpad; `../` y los enlaces simbólicos que escapan fallan con `INVALID_INPUT` |
| `ALISIO_SCRATCH_DIR` | Donde `python_run` ve el scratchpad: **solo lectura**. En Python `managed` no se puede garantizar, porque ese backend no es un sandbox |

La interfaz web lo lista en la pestaña **Scratch** del panel lateral: nombre, tamaño y fecha, una
barra de cuota, la vista previa de archivos de texto y código (`.js`, `.py`, `.csv`, `.json`, `.md`),
la descarga y **Vaciar** con confirmación. No edita nada. Vaciar se rechaza mientras se ejecuta un
script de Forja de la sesión.

<figure class="doc-shot">
  <img src="../assets/web-ui/forge_scratchpad_web_ui.webp" alt="La pestaña Scratch del panel lateral con seis archivos y su tamaño y fecha (chart.png, notes.md, out/my script.py, sales_by_region.csv, scan.js y summary.json), una barra de cuota que indica 38 KB de 256,0 MB usados y el botón Vaciar." width="1400" height="900" loading="lazy" decoding="async" />
  <figcaption>La pestaña Scratch: los archivos de trabajo de la sesión, la cuota usada y el botón para vaciarla.</figcaption>
</figure>

## Guía bajo demanda: forge_guide {#forge-guide}

`forge_guide(topic)` devuelve una guía corta generada desde el estado vivo de los motores (límites,
herramientas invocables, el backend de Python que se usaría ahora y sus paquetes). Existe mientras
Forja está activa y `forge.guides.enabled` no es `false`; un script no puede llamarla. Los temas, el
mecanismo de `etag` y las pistas de error están en [Herramientas y permisos](/es/tools#forge-guide).

## En la interfaz web {#web}

- **Página de ajustes Forja.** *Ajustes → Forja* muestra el motor JavaScript (estado, versión, hash
  del WASM, host, límites, scratchpad) con el interruptor `forge.javascript.enabled`, la sección de
  Python y el interruptor de las guías. Los valores sin interruptor son de solo lectura y muestran
  la clave que hay que cambiar en el archivo.

  <figure class="doc-shot">
    <img src="../assets/web-ui/forge_settings_web_ui.webp" alt="La página Forja del diálogo de Ajustes: la sección JavaScript con el estado Listo, el motor QuickJS y el hash del WASM, el host de hilo worker, los límites de tiempo, memoria, pila, llamadas y salida, la cuota del scratchpad y el interruptor para activar js_run." width="1400" height="900" loading="lazy" decoding="async" />
    <figcaption>Ajustes → Forja: el motor JavaScript, sus límites efectivos y el interruptor de <code>js_run</code>.</figcaption>
  </figure>

- **Tarjeta de `js_run`.** Título, estado, duración y una insignia con el motor y su aislamiento; el
  cuerpo muestra el código resaltado (con botón de copiar), las llamadas anidadas en vivo con su
  estado y duración, una barra de progreso cuando el script informa `completed` y `total`, el valor,
  la salida de texto y cualquier error con su pista. No hay repetición automática.
- **Insignia de `python_run`.** Una insignia con el backend y su aislamiento, escrita y nunca solo
  con color (el backend del host se marca como no aislado), y una línea con el motivo de la
  elección. Los artefactos publicados muestran además su procedencia (motor, aislamiento y motivo).

  <figure class="doc-shot">
    <img src="../assets/web-ui/forge_python_run_badge_web_ui.webp" alt="Una tarjeta python_run terminada, titulada Sales report, con la insignia Python, host (no aislado) en color de advertencia, la línea Engine chosen: analysis.runtime=auto, analysis.isolation=preferred y debajo el artefacto report.md publicado." width="1132" height="420" loading="lazy" decoding="async" />
    <figcaption>Una tarjeta de <code>python_run</code>: la insignia del backend, el motivo de la elección y el artefacto que publicó.</figcaption>
  </figure>

- **Pestaña Scratch.** Consulta [El scratchpad](#scratchpad).

## En la terminal {#tui}

La fila de un `js_run` muestra la nota y la fracción del propio script cuando las informa y después
`2/3 calls` (llamadas anidadas terminadas sobre iniciadas); la fila de un `python_run` añade `oci`,
`wasm` o `host!` según el backend. La duración final va a la derecha como en cualquier herramienta y
la cancelación funciona igual. Las ejecuciones sin interfaz (`alisio run`) emiten el mismo progreso
en la salida JSONL.
