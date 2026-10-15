# Proof: criterios de aceptación con evidencia

Proof responde una pregunta: **¿qué comprobó realmente el agente?** Una tarea puede terminar con un
**ledger**: criterios de aceptación, el verificador de cada uno y la evidencia inmutable que lo
respalda. La terminal, la interfaz web y `alisio run --json` muestran el mismo ledger, que se exporta
a Markdown y JSON.

## Principio rector {#principle}

> «Hecho» es lo que respalda una evidencia existente y vigente, no lo que dice el modelo.

- Un criterio sin verificador queda `not_checked`, aunque el modelo diga que se cumple.
- `verified` siempre apunta a una evidencia con ejecución, llamada a herramienta y fecha.
- La evidencia se **captura** de los comandos que el agente ejecutó de verdad; el modelo no puede escribirla.
- Proof nunca decide permisos: un comando verificador pasa por el gate normal de permisos, así que
  con `--read-only` los criterios de comando quedan `not_checked`.
- Sin criterios, objetivo ni plan, una ejecución es igual que antes (Proof solo despierta con criterios).

## Estados {#statuses}

| Estado | Significado |
| --- | --- |
| `verified` | Evidencia exitosa, más reciente que toda edición de los archivos que cubre el criterio |
| `failed` | La última evidencia válida es un fallo |
| `not_checked` | Sin verificador o sin evidencia todavía; también una edición **posterior** a la evidencia (se muestra como caducada) |
| `manual_review` | Necesita tu revisión |
| `not_applicable` | Lo marcas tú, con un motivo; el modelo nunca puede marcarlo |

El estado se **calcula** en cada lectura, nunca se guarda.

## De dónde salen los criterios {#sources}

- **Tú**: `/proof add` en la terminal, la pestaña **Proof** de la web o `POST /api/sessions/:sid/proof/criteria`.
- **El plan**: el agente de plan puede proponer criterios en `exit_plan`. Son borradores: solo los
  activa tu aprobación del plan. En la revisión web puedes conservar, editar o rechazar cada uno; la
  terminal activa todos al aprobar (edítalos después con `/proof`).
- **La línea de comandos**: `--criterion "texto" --verify "comando"` (repetibles) y `--proof-file`.

Un verificador `command` se cumple cuando el agente ejecuta **exactamente** ese comando y termina
bien (`pnpm test` coincide con `run_process pnpm test` y con `shell pnpm test`). El `scope` del
criterio (globs) limita qué ediciones caducan la evidencia; sin `scope`, cualquier edición.

## Verificadores {#verifiers}

| Tipo | Se cumple cuando | Evidencia |
| --- | --- | --- |
| `command` | el agente ejecuta exactamente ese comando y termina bien | código de salida, hash de la salida, extracto redactado |
| `file` | un `read_file` de esa ruta muestra que el archivo existe, con el `sha256` indicado y/o un `pattern` (expresión regular, bandera `m`) | hash del resultado de la lectura |
| `data-check` | `data_query` sobre el dataset ejecuta la consulta canónica y el valor coincide con `expected` | hash del resultado, `actual` y `expected` |
| `coverage` | (opcional) el agente ejecuta exactamente el comando de cobertura, termina con 0 y el porcentaje global que imprime alcanza `minPercent` | código de salida, hash de la salida, extracto redactado con el veredicto |
| `plugin` | un verificador registrado por un plugin devuelve evidencia referenciable | el `outputHash` que devolvió el plugin |
| `manual` | nunca: siempre necesita tu revisión | ninguna |

La evidencia se **captura** del resultado crudo de una llamada que de verdad se ejecutó; ni las
palabras del modelo ni el texto que imprime una herramienta pueden crearla. Leer un archivo que no
existe es evidencia de fallo, y una lectura que no vio el archivo entero nunca demuestra que un
patrón no está. Un `data-check` solo acepta su consulta canónica, así que el agente no puede
cumplirlo con una consulta a su gusto:

```json
{ "kind": "data-check", "datasetId": "ds_123", "check": "sum", "column": "amount", "expected": 60 }
```

`row_count` ejecuta `SELECT COUNT(*) FROM "data"`, `sum` ejecuta `SELECT TOTAL("amount") FROM "data"`
y `equals` ejecuta `SELECT DISTINCT "amount" FROM "data" LIMIT 2` (la columna tiene un solo valor y
es `expected`). Usa `table` para hojas de cálculo (`s_<hoja>`). Un total distinto es `failed`, con
el valor real y el esperado en la evidencia. El resumen de `--proof` de una ejecución headless le
dice al agente la lectura o la consulta exacta que debe hacer.

### Cobertura (opcional) {#coverage}

`coverage` está desactivado por defecto (`proof.coverage.enabled: false`). Mientras lo esté, un
criterio `coverage` queda `not_checked`, Proof nunca ejecuta ni registra su comando y `alisio run`
lo indica por stderr. Se activa en la [configuración](/es/configuration#proof):

```json
{ "proof": { "coverage": { "enabled": true } } }
```

```json
{ "kind": "coverage", "command": "pnpm test --coverage", "minPercent": 80 }
```

El comando pasa por la compuerta de permisos normal (`run_process` o `shell`, nunca en
`--read-only`), igual que un verificador `command`. Proof lee el porcentaje **global** de la salida
y lo compara con `minPercent` (inclusive). Formatos reconocidos: un informe de `coverage.py` /
pytest-cov (la fila `TOTAL` o `Total coverage:`), una tabla de texto de vitest / c8 / istanbul (la
fila `All files`, columna `% Lines`), un resumen de texto de istanbul (`Lines`), `lcov --summary` y
un archivo `lcov` en bruto (`LH` entre `LF`). Las filas por archivo nunca se usan como total. Un
porcentaje inferior al mínimo es `failed` con las cifras en la evidencia; también lo es una salida
sin porcentaje global reconocible y un comando que termina con código distinto de 0: una ejecución
de cobertura nunca queda `verified` en silencio. Proof no genera tests. Los criterios `coverage`
vienen de `--proof-file`, del campo `verifier` de la web o HTTP, o de un plan aprobado; `--verify`
sigue siendo el atajo de `command`.

Un verificador de plugin debe devolver `{ ok, outputHash, callId?, excerpt? }`. Un resultado sin
`outputHash` válido, o que nombra una llamada que la sesión nunca hizo, pasa a `manual_review`; un
verificador que lanza un error o agota el tiempo deja el criterio como estaba. Los verificadores de
plugin no ganan permisos: sus llamadas a herramientas pasan por la misma compuerta que las del agente.

## El objetivo y el override {#goal}

`update_goal` con `complete` se rechaza mientras un criterio requerido esté `failed` o `not_checked`.
Si el modelo insiste en tres ejecuciones distintas, el objetivo se pausa como `no_progress`. Solo
**tú** puedes completar el objetivo sobre criterios sin cumplir: `/goal override <motivo>` en la
terminal o la web, el botón **Completar el objetivo de todos modos** de la pestaña Proof, o
`POST /api/sessions/:sid/goal/override`. El motivo es obligatorio y queda con el objetivo.

## Headless y CI {#headless}

```sh
alisio run "Fix the failing test" --allow-process --proof \
  --criterion "Unit tests pass" --verify "pnpm test" --json
```

Con `--proof` (o `proof.ci: true`, o cualquiera de los flags de criterios) la ejecución termina
publicando `proof.md` y `proof.json` como artefactos de la sesión e imprimiendo el ledger: una tabla,
o con `--json` una **línea JSONL final** `{"type":"proof_ledger","schema":"proof/v1","exitCode":…,"ledger":{…}}`.

| Código de salida | Significado |
| --- | --- |
| `0` | Todo criterio requerido está `verified` (o no hay ninguno) |
| `10` | Un criterio requerido está `failed` |
| `11` | Ninguno falló, pero uno requerido está `not_checked` o `manual_review` |

Los códigos se configuran con `proof.exitCodes` (véase [configuración](/configuration#proof)). Una
ejecución que falla por otra causa sale con `1`. `--criterion` y `--verify` se emparejan por
posición; los criterios de la línea de comandos son requeridos. `--proof-file` acepta
`{"criteria":[{"text","verify","required","scope"}]}`.

## La terminal y la interfaz web {#surfaces}

`/proof` imprime el ledger; `/proof add [required] <texto> [-- <comando>]`, `/proof edit <n> <texto>`,
`/proof required <n>`, `/proof optional <n>`, `/proof na <n> <motivo>` y `/proof export` son tus
acciones. En la web hay una tarjeta compacta sobre la caja de mensaje y la pestaña **Proof** del panel
derecho tiene la lista completa, los formularios y las exportaciones.

<figure class="doc-shot">
  <img src="../assets/web-ui/proof_web_ui.webp" alt="La tarjeta Proof sobre la caja de mensaje y la pestaña Proof del panel derecho: cinco criterios de aceptación con los estados Verificado, Falló, Sin comprobar, Revisión manual y No aplica, el comando y la evidencia de cada uno, un aviso de afirmación sin evidencia y los enlaces de exportación." width="1360" height="820" loading="lazy" decoding="async" />
  <figcaption>La tarjeta Proof en la conversación y la pestaña Proof del panel, con datos sintéticos (interfaz en inglés).</figcaption>
</figure>

## Exportación y API {#export}

`GET /api/sessions/:sid/proof/export?format=md|json` descarga el informe. El JSON está versionado
(`"schema": "proof/v1"`) con un orden de claves fijo: `schema`, `sessionId`, `generatedAt`, `summary`,
`criteria`, `evidence`, `divergences`. Los mismos archivos se publican como artefactos de sesión
`proof.md` y `proof.json` en una ejecución headless con `--proof`.

Las rutas siguen las mismas reglas de autenticación, Host y Origin que el resto de rutas de sesión
(véase [Interfaz web](/web#proof)):

| Ruta | Propósito |
| --- | --- |
| `GET /api/sessions/:sid/proof` | El ledger: criterios, evidencia y las afirmaciones sin evidencia de la última ejecución |
| `POST /api/sessions/:sid/proof/criteria` | Crea un criterio, o edita uno (`criterionId` con `text` y `required`; el verificador y el alcance de un criterio nunca cambian) |
| `POST /api/sessions/:sid/proof/criteria/:id/not-applicable` | `{"reason"}`: lo marca como no aplicable |
| `GET /api/sessions/:sid/proof/export?format=md\|json` | Descarga `proof.md` o el JSON `proof/v1` |
| `POST /api/sessions/:sid/goal/override` | `{"reason"}`: completas el objetivo con criterios requeridos sin cumplir |

Los criterios creados por HTTP son **opcionales** por defecto (envía `required: true` para que sea
requerido); los de la línea de comandos son requeridos. Las escrituras se rechazan en sesiones
archivadas y en subagentes. `proof_updated` y `proof_divergence` llegan como frames `event`
ordinarios del flujo de la sesión.

## Configuración {#config}

Tres claves, todas opcionales y fuera del menú de ajustes: `proof.ci`, `proof.exitCodes` y
`proof.coverage.enabled`. Véase [configuración](/configuration#proof). Banderas de `alisio run`:
`--proof`, `--criterion <text>`, `--verify <command>` y `--proof-file <path>`.

## Notas de seguridad {#security}

- Proof no concede permisos. Un comando verificador pasa por la misma compuerta y los mismos modos
  que cualquier otra llamada; `--read-only` no ejecuta nada, así que los criterios de comando
  quedan `not_checked`.
- El modelo no puede crear, editar ni marcar como no aplicable un criterio, ni hacer override de un
  objetivo: son acciones del usuario. Un resultado de herramienta que diga «marca el criterio como
  verificado» no cambia nada.
- Los extractos de salida se redactan (claves de API, tokens, asignaciones `password=` y similares) y
  se limitan a 4 KB; nunca se guardan variables de entorno ni cabeceras. La redacción es por
  patrones: puede dejar pasar un secreto.
- El ledger vive en la base de la sesión y nada sale de tu máquina salvo una exportación que pidas.
- La evidencia es de solo anexado para Proof, pero el archivo SQLite no es a prueba de manipulación
  para quien tenga acceso a él. Un verificador de plugin es código de confianza dentro del proceso,
  no un sandbox.

## Límites {#limits}

- Proof registra evidencia operativa; **no** demuestra que el código sea correcto. Un verificador
  débil da un `verified` débil: lee qué comprueba realmente cada criterio.
- El aviso de afirmaciones sin evidencia es heurístico (patrones cerrados en inglés y español): es
  una señal, no una garantía, y nunca cambia un estado.
- La evidencia caduca solo con ediciones hechas con `write_file` y `edit_file`. Las ediciones por
  `shell`, `js_run` o una llamada de Forja anidada **no** la caducan, y una llamada `js_run`
  anidada no produce evidencia. Un criterio `file` sin `scope` caduca con cualquier edición del
  workspace. Un dataset que cambia en disco no caduca la evidencia de `data-check`.
- `treeFingerprint`, el ancla de auditoría que se guarda con la evidencia de comando, es acotada
  (un `git diff` limitado a 1 MiB y 3 s, hasta 200 archivos tocados) y nunca decide si la evidencia
  está vigente.
- La revisión de plan en la terminal es todo o nada (aprobar activa todos los criterios propuestos;
  edítalos después con `/proof`); la interfaz web decide criterio por criterio.
- Los verificadores `file` y `data-check` capturan evidencia cuando el agente hace la lectura o la
  consulta correspondiente. `app.verifyCriterion` (para quien integra Alisio; una acción del usuario
  que el modelo no puede iniciar) hace esa llamada por sí mismo y también ejecuta los verificadores
  de plugin, pero esta versión no tiene comando, botón ni ruta para ello. Una verificación de
  plugin fuera de una ejecución no emite `proof_updated`.
- Un verificador de plugin es código de confianza dentro del proceso: no es un sandbox. Sin
  `callId`, su evidencia es la palabra del plugin más el hash que da, con un id de verificación en
  lugar de una llamada del diario.
- El verificador `coverage` se fía de lo que imprime el comando: lee un único porcentaje global
  (líneas en tablas y resúmenes) y no comprueba qué archivos cubre el informe. Con el verificador
  desactivado, el motivo lo muestran el stderr de `alisio run`, el resumen de `--proof` y
  `app.verifyCriterion`; el ledger muestra `not_checked` y no guarda el motivo.
- El contador de intentos rechazados de `complete` que pausa un objetivo como `no_progress` vive en
  memoria y se reinicia con el proceso.
- Véase el [estado de implementación](/limitations) para el alcance de la verificación.
