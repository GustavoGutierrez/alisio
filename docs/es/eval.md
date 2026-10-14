# Reliability Lab (`alisio eval`)

El Reliability Lab responde una pregunta con datos: ¿un cambio del arnés, una estrategia o un modelo
hace que Alisio sea mejor o peor en un conjunto de tareas? Ejecuta una **suite** de tareas varias
veces, comprueba cada resultado con verificadores deterministas e informa tasas de éxito con su
incertidumbre. Es una herramienta de desarrollo y de CI: se ejecuta en modo headless
(`alisio eval`), no tiene interfaz interactiva y nada sale de tu máquina.

## Principio rector {#principle}

Un número sin sus condiciones de medición es una anécdota. Cada reporte lleva el id y la versión de la
suite, la versión del arnés, un hash de la configuración efectiva, el proveedor, el modelo, el modo, `k`
y la semilla. El laboratorio nunca afirma determinismo donde solo hay repetición: una ejecución `live`
depende de un modelo real, y `--seed` solo ordena las ejecuciones (el proveedor nunca la recibe).

Los valores medidos (uso del proveedor, tiempo de pared, conteos de eventos) y los estimados (costo en
USD) viven en bloques separados y nunca se suman.

## Live y replay {#modes}

| Modo | Proveedor | Qué mide | Úsalo para |
| --- | --- | --- | --- |
| `live` (por defecto) | el proveedor configurado | el arnés y el modelo juntos, con varianza | decidir estrategias y modelos |
| `replay` | una grabación (cassette) | solo el arnés, de forma determinista | CI barato, detectar regresiones del runner, las herramientas, la compactación y los permisos |

**El replay mide el arnés, no el modelo.** Las respuestas del modelo salen de una grabación, así que un
replay en verde no dice nada sobre la calidad del modelo. La cabecera del reporte dice `replay` y lo
repite.

## Inicio rápido {#quick-start}

Las suites incluidas viven en el checkout del código fuente (`tests/fixtures/eval`), no en el paquete
npm ni en el binario autónomo. Desde un checkout:

```sh
alisio eval list
ALISIO_CONFIG_HOME="$(mktemp -d)" alisio eval run tool-sequences --mode replay --allow-write --allow-process
alisio eval run smoke-coding --k 5 --allow-write --allow-process
```

El segundo comando reproduce las cassettes grabadas con un directorio de configuración vacío (ver
[Replay y cassettes](#cassettes)); el tercero necesita un proveedor configurado y gasta tokens reales.
Desde el paquete npm o el binario, pasa tu propia suite con `--suite-dir`.

## Escribir una suite {#writing-a-suite}

Una suite es un directorio con un `suite.json` y un directorio de fixture por tarea. Cada tarea se
ejecuta en una copia temporal de su fixture, nunca en tu árbol de trabajo.

```text
my-suite/
  suite.json
  fixtures/fix-add/        # copied for each run
    src/math.ts
    check.ts
```

```json
{
  "schemaVersion": 1,
  "suiteId": "my-suite",
  "suiteVersion": "1.0.0",
  "description": "Small coding tasks.",
  "tasks": [
    {
      "id": "fix-add",
      "prompt": "The function add in src/math.ts is wrong. Fix it. Change only src/math.ts.",
      "fixture": "fixtures/fix-add",
      "budget": { "maxTurns": 30, "maxTokens": 200000, "maxWallMs": 120000, "maxToolCalls": 40 },
      "policy": { "mode": "auto", "allow": ["process"] },
      "verifiers": [
        {
          "kind": "command",
          "id": "check",
          "command": ["node", "--experimental-strip-types", "check.ts"],
          "timeoutMs": 30000
        },
        { "kind": "tree-diff-within", "id": "scope", "allowed": ["src/math.ts"] }
      ],
      "tags": ["coding"]
    }
  ]
}
```

- `suiteVersion` es semver. Si cambias un fixture o un verificador debes subirla: `compare` se niega a
  mezclar versiones.
- Las rutas (`fixture` y las de los verificadores) deben ser relativas y quedar dentro de la suite o del
  directorio de la tarea; se rechazan `..`, las rutas absolutas y los enlaces simbólicos que escapan, y
  los ids de tareas y de verificadores deben ser únicos. El cargador indica la tarea y el campo erróneo.
- `agent` ejecuta opcionalmente la tarea con uno de tus agentes principales.
- `fixtureGit: true` inicializa un repositorio git dentro de la copia, para las tareas que lo necesitan.

### Presupuestos {#budgets}

`maxTurns` y `maxWallMs` son obligatorios; `maxTokens` y `maxToolCalls` son opcionales. Una ejecución
que excede alguno se detiene con estado `budget_exceeded`, cuenta como no aprobada y registra el
motivo. `maxTokens` solo se aplica si el proveedor informa el uso; sin uso la ejecución registra el
incidente `usage_unreported` y puede pasarse por una respuesta.

### Política {#policy}

`policy.mode` es `ask`, `auto` o `full`; `policy.allow` puede añadir `write`, `process`, `external` o
`analysis`; `readOnly` restringe aún más. Una suite solo puede igualar o restringir los permisos de
quien la ejecuta: las opciones `--allow-write`, `--allow-process`, `--allow-external` y
`--allow-analysis` corresponden a los efectos `write`, `process`, `external` y `analysis`. Una tarea
que pide un efecto que no concediste se rechaza antes de la primera ejecución, sin recortarla en
silencio. Una tarea con `mode: "full"` exige además `--allow-suite-full`.

En modo `ask` el laboratorio es headless y **deniega toda aprobación** (cada una cuenta como incidente
`approval_denied`); `alisio run`, en cambio, pregunta. En `auto` y `full` un efecto no concedido se
rechaza sin evento de aprobación.

### Verificadores {#verifiers}

Los verificadores son deterministas y locales; no hay modelo juez. Cada uno devuelve `pass`, `fail` o
`error`. Una tarea aprueba cuando todos sus verificadores aprueban y no se excedió ningún presupuesto.

| Tipo | Comprueba |
| --- | --- |
| `command` | ejecuta `command` (un arreglo de argumentos, sin shell) dentro de `timeoutMs` (máximo 600000) y comprueba `expectExit` y `expectStdoutIncludes` |
| `file-equals` | el sha256 del archivo es igual a `sha256` |
| `file-contains` | el archivo contiene `text` |
| `file-absent` | el archivo no existe |
| `tree-diff-within` | todo archivo modificado, añadido o borrado está en `allowed` (`dir/` permite un directorio completo; `.git` y `node_modules` se ignoran) |
| `tool-sequence` | una regla sobre las llamadas a herramientas de la ejecución, abajo |

Reglas de `tool-sequence`:

| Regla | Aprueba cuando |
| --- | --- |
| `{"type": "before", "first": "read_file", "then": "edit_file"}` | `first` ocurrió antes de cada llamada a `then` (compara nombres de herramienta, no archivos) |
| `{"type": "never", "tool": "bash"}` | la herramienta nunca se llamó |
| `{"type": "max-calls", "tool": "read_file", "max": 3}` | la herramienta se llamó como máximo `max` veces |
| `{"type": "no-repeat-failure", "tool": "edit_file"}` | no se repitió una llamada idéntica que ya había fallado |

`error` significa que el verificador no pudo ejecutarse (una ruta fuera del directorio, un comando que
no arranca, eventos ausentes). Se informa aparte y no es ni aprobado ni fallido. Un `command` que
excede su tiempo límite es `fail`: es la verificación propia de la tarea ejecutando código que escribió
el agente.

### `replayNormalize` {#replay-normalize}

El replay compara lo que el arnés envía al proveedor. Si una tarea imprime ruido que cambia entre
ejecuciones (fechas, PIDs), decláralo para que no parezca una regresión:

```json
"replayNormalize": [
  { "pattern": "\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z", "replace": "<TIMESTAMP>" }
]
```

`pattern` es una expresión regular global. Una regla demasiado amplia puede ocultar una regresión real.

## Comandos {#commands}

Las opciones globales (`--json`, `--allow-*`, `--read-only`, `--model`, `--base-url`...) funcionan igual
que en `alisio run`.

| Comando | Hace |
| --- | --- |
| `alisio eval list [--suite-dir DIR]` | lista las suites incluidas (solo en un checkout) y las de `DIR` |
| `alisio eval run <suite>` | ejecuta una suite `k` veces y escribe el reporte |
| `alisio eval record <suite>` | ejecuta cada tarea una vez, en vivo, y escribe su cassette |
| `alisio eval compare <baseline> <candidate>` | compara dos reportes (`report.json` o su directorio) |
| `alisio eval variants <suite> --variants compare.json` | ejecuta variantes de configuración sobre las mismas tareas y las compara |
| `alisio eval export <runId> --out FILE [--force]` | escribe un paquete compartible de una ejecución guardada, sin rutas absolutas ni secretos |

`<suite>` es el id de una suite o el nombre de su directorio. Opciones de `run` y `variants`:

| Opción | Significado |
| --- | --- |
| `--tasks id,id` | solo estas tareas |
| `--k N` | repeticiones por tarea (5 por defecto; 1 por defecto en replay) |
| `--seed N` | semilla del orden de ejecución; cada ejecución recibe `seed + repetición` |
| `--mode live\|replay` | solo `run`; `variants` rechaza replay |
| `--cassette-dir DIR` | cassettes que leer o escribir (por defecto `<suite>/cassettes`) |
| `--keep` | conserva el directorio temporal de cada ejecución e imprime su ruta |
| `--out DIR` | escribe los tres archivos del reporte directamente en `DIR` |
| `--suite-dir DIR` | una suite, o un directorio de suites, fuera de las incluidas |
| `--yes` | acepta una suite de `--suite-dir` sin preguntar |
| `--allow-suite-full` | permite ejecutar tareas con `mode: "full"` |
| `--input-rate USD`, `--output-rate USD` | USD por millón de tokens; ambas o ninguna |
| `--variants FILE` | solo `variants`: el archivo `compare.json` |

`record` acepta `--tasks`, `--seed`, `--keep`, `--cassette-dir`, `--suite-dir`, `--yes` y
`--allow-suite-full`. Con `--json`, `run` imprime un registro JSON por ejecución y el reporte al final;
`variants` imprime líneas con un `type` (`variant_report`, `comparison`); `compare --json` imprime la
comparación.

### Códigos de salida {#exit-codes}

| Código | Significado |
| --- | --- |
| `0` | terminó, sin importar qué tareas aprobaron |
| `1` | error de uso o de infraestructura (también si alguna ejecución terminó en `error`; el reporte se escribe igualmente) |
| `2` | un replay divergió de su cassette |
| `3` | `compare` de suites incompatibles (`suiteId` o `suiteVersion` distintos) |

Una tarea fallida es un dato, no un error: en CI condiciona sobre el reporte, no sobre el código `0`.

### Suites de terceros {#third-party}

Una suite de `--suite-dir` es código que se ejecuta con tus privilegios: los comandos de sus
verificadores y las herramientas que habilita no están aislados. El comando imprime una advertencia y
pide confirmación; sin terminal se niega salvo que pases `--yes`. Ejecuta solo suites en las que
confíes.

### Variantes {#variants}

`compare.json` nombra una suite y dos o más variantes, cada una un conjunto de sobrescrituras de
configuración:

```json
{
  "suite": "smoke-coding",
  "variants": [
    { "id": "baseline", "overrides": {} },
    { "id": "early-compaction", "overrides": { "compaction.threshold": 0.6 } }
  ]
}
```

Solo se aceptan claves de la configuración medida; una clave desconocida, o una que no entra en el hash
de configuración (proveedor, plugins, MCP, rutas), rechaza el archivo antes de la primera ejecución.
Para comparar modelos usa `--model`. Las variantes se ejecutan intercaladas (A, B, luego B, A...) sobre
las mismas tareas, repeticiones y semillas, lo que reparte la deriva del proveedor sin eliminarla. Cada
variante tiene su propio directorio de reporte, más `comparison.json` y `comparison.md` en la raíz.

## Leer los resultados {#reading-results}

### Tasa de éxito e intervalo de Wilson {#success-rate}

`successRate` son las aprobadas sobre las ejecuciones juzgadas, con un intervalo de Wilson al 95 %. Con
pocas ejecuciones el intervalo es ancho: 3/5 va de cerca del 23 % al 88 %. Una tarea cuenta las
ejecuciones juzgadas `pass`, `fail` o `budget_exceeded`. Las que terminaron en `error` son fallos de
infraestructura (copia del fixture, red o autenticación del proveedor, un verificador que no puede
arrancar): se excluyen de toda tasa y se cuentan aparte. Un fallo que causa el modelo (salida truncada,
demasiadas llamadas a herramientas en un turno, un verificador `command` colgado) es `fail`, no
`error`.

### pass@k y pass^k {#pass-k}

- `pass@k`: al menos una de las `k` ejecuciones aprobó. Responde «¿puede hacerlo alguna vez?».
- `pass^k`: las `k` ejecuciones aprobaron. Responde «¿puedo confiar en él?». Cae rápido al crecer `k`.

Ambas se muestran por tarea. Una tarea con `pass@5` sí y `pass^5` no es inestable, no está resuelta.

### Por qué `k` es al menos 5 {#why-k}

Con menos de 5 ejecuciones juzgadas el reporte imprime una advertencia de **low power** (baja
potencia) y `compare` no afirma nada. Con `k = 5` solo un 0/5 frente a un 5/5 puede dar veredicto,
porque los intervalos deben ser disjuntos. Usa un `k` mayor para detectar diferencias menores; cada
repetición cuesta tokens reales.

### `inconclusive` y `low power` {#verdicts}

`compare` lee los intervalos, no las estimaciones puntuales:

| Veredicto | Significado |
| --- | --- |
| `improved` / `regressed` | ambos lados tienen al menos 5 ejecuciones juzgadas y los intervalos de Wilson son disjuntos |
| `inconclusive` | los intervalos se solapan (rozarse cuenta). No es «sin diferencia»: falta evidencia |
| `low power` | menos de 5 ejecuciones juzgadas en un lado; no se afirma ninguna dirección |
| `not comparable` | ejecuciones con `error` en un lado, modos distintos o (para deltas de tokens y costo) ajustes de compactación distintos |

En replay el reporte no tiene intervalos: cada tarea sale `changed` o `unchanged`. Toda comparación
termina con una nota al pie que declara sus límites: un filtro conservador, no una prueba de
significancia; repeticiones supuestas independientes; sin corrección por el número de tareas;
ejecuciones con `error` excluidas.

### Medido y estimado {#measured-estimated}

El bloque `measured` contiene los tokens informados por el proveedor, el tiempo de pared (mediana y
varianza muestral), y tokens y tiempo por éxito. Las cifras por éxito son el gasto total de las
ejecuciones juzgadas, fallos incluidos, dividido por los éxitos. Los tokens son los del bucle principal
y **excluyen las llamadas de compactación**. Si un proveedor no informa el uso en todos los turnos, las
cifras de tokens se omiten, no se adivinan.

`estimated` contiene `costUsd` y solo existe si pasas **ambas** `--input-rate` y `--output-rate`.
Alisio no adivina precios, y el costo ignora el precio de los tokens en caché y de razonamiento. Las
comparaciones solo comparan costos estimados cuando ambos reportes usaron las mismas tarifas.

### Archivos del reporte {#report-files}

`run` escribe tres archivos en `<dataDir>/eval/<runId>/` (el directorio de estado), o directamente en
`--out`:

| Archivo | Contenido |
| --- | --- |
| `report.json` | condiciones, métricas por tarea, resumen |
| `report.md` | lo mismo, legible, con las tablas Measured y Estimated separadas |
| `runs.jsonl` | un registro por ejecución: verificadores, uso, incidentes, errores, divergencia |

Pasa un `report.json` o su directorio a `compare`.

### Exportar una ejecución {#export}

```sh
alisio eval export 2026-10-13T12-00-00-000Z --out share/run.json
```

`export` lee `<dataDir>/eval/<runId>/` y escribe **un** archivo JSON,
`{ "schemaVersion": 1, "report": ..., "runs": [...], "markdown": "..." }`, que compartes tú. No se
sube nada y no hay acceso a la red. El id de la ejecución es el nombre del directorio (letras, dígitos,
`.`, `_`, `-`; sin separadores de ruta). Se niega a sobrescribir un `FILE` existente salvo que pases
`--force`.

Qué hace con el contenido:

- Las rutas absolutas (tu directorio personal, el directorio de datos, el directorio de la ejecución,
  los directorios temporales y cualquier otra ruta absoluta) se sustituyen por marcadores como
  `<home>`, `<run-dir>`, `<tmp>` o `<path>`. Los directorios temporales conservados con `--keep` no
  forman parte del paquete.
- Un id de proveedor que no es un identificador simple, porque puede incluir el host del endpoint, se
  sustituye por `custom-endpoint` en todas partes.
- El mismo escáner de secretos que protege las cassettes (formas conocidas de claves más las
  credenciales presentes en tu entorno) recorre todo el paquete. Si encuentra uno, `export` **se
  niega** (código `1`) y nombra el campo, por ejemplo `runs[1].verifiers[0].detail`, nunca el valor.
  No se elimina nada y no se escribe nada.

La limpieza se basa en patrones. No es una garantía: un prompt de tarea, el detalle de un verificador o
la salida de una herramienta pueden contener una cadena sensible que ningún patrón reconoce. Lee el
paquete antes de compartirlo.

## Replay y cassettes {#cassettes}

Una cassette (`cassette/v1`, JSONL) registra cada llamada al proveedor de una tarea: una huella de la
petición (instrucciones, mensajes, herramientas con sus esquemas, límite de salida, modelo,
herramientas nativas y esfuerzo de razonamiento) y los eventos que emitió el proveedor. Los ids de
llamadas a herramientas y los datos de continuación del proveedor se guardan tal cual. Las rutas por
ejecución y los ids generados se normalizan antes de calcular el hash. El escritor rechaza una
cassette que contenga un secreto (formas conocidas de claves y las credenciales exactas de tu perfil) o
que exceda 256 KB (2 MB por directorio); el escaneo es una red de seguridad, así que revisa una
cassette antes de versionarla.

```sh
alisio eval record my-suite --suite-dir ./suites --tasks fix-add   # live; writes the cassette
alisio eval run my-suite --suite-dir ./suites --mode replay        # no provider, no network
```

El replay no necesita proveedor ni credenciales, pero sí los mismos permisos que tuvo la grabación
(`--allow-write --allow-process` para las cassettes incluidas) y una configuración limpia. Tu propia
configuración cambia lo que recibe el proveedor, así que para las cassettes incluidas apunta
`ALISIO_CONFIG_HOME` a un directorio vacío. La ejecución avisa cuando el hash de configuración difiere
del grabado.

### Divergencia {#divergence}

Si el arnés pide al proveedor algo distinto de lo grabado, la ejecución termina en `error` con
`replay_divergence`, el comando imprime la tarea, la llamada, el campo (por ejemplo
`tools[edit_file].description` o `messages[3].tool.result`) con extractos alrededor de la primera
diferencia, escribe igualmente el reporte y sale con `2`. Las llamadas grabadas que nunca se hacen, o
las llamadas de más, también divergen.

Una divergencia tras cambiar el arnés es justo el objetivo: el replay es un detector de regresiones. Si
el cambio es intencional, revisa el diff y vuelve a grabar. Todo lo que cambie lo que recibe el
proveedor invalida las cassettes, incluido tu esfuerzo de razonamiento o activar la búsqueda nativa.

### Suites incluidas {#bundled-suites}

| Suite | Tareas | Modo |
| --- | --- | --- |
| `smoke-coding` 1.2.0 | 7 tareas pequeñas de TypeScript (tres fáciles, cuatro más difíciles; tres endurecidas tras saturar) | live; 4 cassettes |
| `tool-sequences` | 6 tareas de uso de herramientas con estado, una con una transición inválida deliberada | replay; 6 cassettes |
| `long-context` | 3 tareas con datos enterrados en archivos largos y salidas de comandos truncadas | live; sin cassettes |

Existen **solo en el checkout del repositorio** (`tests/fixtures/eval`), no en el paquete npm ni en el
binario; allí `list` sale vacío y lo explica. Las cassettes incluidas se grabaron con un proveedor
scripted (una lista fija de llamadas a herramientas), no con un modelo real: fijan el comportamiento
del arnés. `pnpm test` las reproduce en unos dos segundos.

Para regrabarlas, por ejemplo tras un cambio intencional del arnés, ejecuta desde el checkout:

```sh
pnpm eval:record-bundled
```

(acepta `--tasks suite/tarea,...` y `--out DIR`). Dos grabaciones seguidas son idénticas byte a byte.
Para grabar un modelo real usa `alisio eval record <suite>` con tu proveedor. Revisa el diff de la
cassette antes de versionarla.

## Usar el replay en CI {#ci}

`pnpm eval:ci` reproduce todas las cassettes incluidas y sale con código distinto de cero cuando un
replay diverge (salida `2`), una tarea reproducida no pasa o no se pudo reproducir nada (un conjunto
vacío es una mala configuración, no un éxito; ambos con salida `1`). Sale con `0` solo cuando todas las
cassettes se reproducen sin divergencia y pasan. Se ejecuta desde un checkout del código fuente (el
script, las suites y las cassettes no están en el paquete npm), no necesita proveedor, credenciales ni
red, fija por sí mismo `--allow-write --allow-process` y una configuración vacía, y tarda unos dos
segundos.

```sh
pnpm eval:ci                       # reports in a new temporary directory
pnpm eval:ci --out ./eval-report   # <dir>/<suite>/report.json and report.md
```

`--suite-dir DIR` y `--cassette-dir DIR` sustituyen las ubicaciones incluidas (`--cassette-dir` exige
una sola suite). Una suite sin cassettes (`long-context`) se lista como omitida. Una divergencia nombra
la tarea, la llamada y el campo, por ejemplo `tools[edit_file].description`.

**Informa; decide el propietario.** El replay mide el arnés, no el modelo, y el laboratorio nunca
promueve ni bloquea un cambio por sí solo. Nada lo ejecuta por defecto: no está en
`.github/workflows/ci.yml` ni en la lista de verificación de entrega. Para activarlo, añade un job como
este (es un fragmento, no un job activo):

```yaml
eval-replay:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v4
    - uses: pnpm/action-setup@v4
    - uses: actions/setup-node@v4
      with:
        node-version: "24"
        cache: pnpm
    - run: pnpm install --frozen-lockfile
    - run: pnpm eval:ci --out eval-report
    - uses: actions/upload-artifact@v4
      if: always()
      with:
        name: eval-report
        path: eval-report
```

Deja el job fuera de los checks obligatorios para que sea informativo; volverlo obligatorio es decisión
del propietario. Tras un cambio intencional del arnés, regraba con `pnpm eval:record-bundled`.

## Resultados medidos {#measured}

`smoke-coding` 1.2.0, `k = 5`, live, arnés 0.6.0, 2026-10-14, tareas `rename-symbol`,
`edit-respects-hash` y `off-by-one-among-passing`:

| Modelo | pass | fail | `budget_exceeded` | error | Tasa de éxito por tarea (Wilson 95 %) |
| --- | --- | --- | --- | --- | --- |
| `opencode-go/deepseek-v4.1-flash` | 15 | 0 | 0 | 0 | 100 % [56,6 %; 100 %] en las tres |
| `opencode-go/mimo-v2.6-flash` | 9 | 0 | 6 (5 por `maxWallMs`, 1 por `maxTokens`) | 0 | 80 % [37,6 %; 96,4 %], 80 % [37,6 %; 96,4 %], 20 % [3,6 %; 62,4 %] |

- DeepSeek saturó las tareas: el objetivo de 30-80 % era una hipótesis y no se cumplió. La mediana de
  tiempo fue de 43-106 s por ejecución y de 117k-256k tokens por éxito.
- MiMo no tuvo ejecuciones `fail` causadas por el modelo, así que los verificadores nunca rechazaron una
  solución incorrecta. Su tasa menor se debe sobre todo al tiempo de reloj (latencia del proveedor,
  unos 30 s por turno), por lo que mezcla capacidad y velocidad. Los intervalos se solapan con los de
  DeepSeek: `eval compare` daría `inconclusive`. Los presupuestos no se subieron para favorecerlo; el
  presupuesto forma parte de la tarea.
- `smoke-coding` es una suite de humo y regresión. Satura con un modelo barato y fuerte y solo
  discrimina (en parte por latencia) con uno más débil. El poder discriminante entre modelos no está
  establecido.

## Límites {#limits}

- **Sin LLM como juez.** Los verificadores son deterministas; la calidad subjetiva no se mide.
- **Sin benchmarks de terceros** (SWE-bench y similares). El formato de suite podría alojarlos; no se
  incluye ninguno.
- **Sin determinismo en `live`.** Las repeticiones y los intervalos describen la varianza; la semilla
  solo ordena las ejecuciones.
- **El replay no es evidencia sobre el modelo** (ver [Live y replay](#modes)).
- **Un subproceso o una política no es un sandbox.** Las herramientas de archivos están mediadas, pero
  cuando a una tarea se le concede `process`, o se ejecuta un verificador `command`, el código corre con
  tus privilegios y puede escribir fuera de la copia temporal. No confíes en que «nada fuera de la copia
  cambia» en ese caso.
- **Las repeticiones se suponen independientes**, nada está pareado y no hay corrección por
  comparaciones múltiples entre tareas.
- **Sin subida.** Los reportes son archivos locales que compartes tú; `export` solo escribe un paquete
  local depurado, y su limpieza se basa en patrones, no es una garantía. Las suites nunca se ejecutan
  contra tu árbol de trabajo real.
- **Las cassettes incluidas fijan solo el arnés**, y un cambio legítimo del arnés las invalida.
- **Sin verificar con un modelo real**: `long-context` aún no se ha medido con un modelo real; no lo
  uses para decidir hasta ejecutarlo en vivo con `k = 5`. Ver [Resultados medidos](#measured).
- **Solo está verificado el proveedor compatible con OpenAI desde un archivo de configuración**; el
  proveedor se resuelve una vez por comando, así que un plugin de proveedor que lea credenciales de
  forma perezosa en cada petición puede no funcionar.

Consulta [Limitaciones conocidas](/es/limitations) para el alcance de la verificación.
