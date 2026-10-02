# Herramientas y permisos

Cada herramienta declara un **efecto**. El efecto decide si la herramienta está disponible, pide
aprobación o está desactivada.

| Efecto | Significado | Por defecto |
| --- | --- | --- |
| `read` | Sin efectos secundarios | Activada |
| `write` | Modifica archivos del workspace | Requiere `--allow-write` (o aprobación en la TUI) |
| `process` | Ejecuta procesos arbitrarios | Requiere `--allow-process` (o aprobación en la TUI) |
| `external` | Herramientas de red (`webfetch`, `websearch`), MCP, Herdr y plugins externos | Requiere `--allow-external` (o aprobación en la TUI), `--allow-mcp`, `--allow-agents` o un plugin externo activo; nunca con `--read-only` |
| `internal` | Escribe solo estado propio de Alisio (nunca el workspace ni la red) | Siempre permitida; solo se respeta en plugins integrados |

Las operaciones desconocidas o de plugins usan `external` por defecto. `/tools` en la TUI muestra el
estado actual de cada herramienta (`enabled`, `ask`, `disabled`).

## Herramientas incluidas

| Herramienta | Efecto | Función |
| --- | --- | --- |
| `read_file` | `read` | Leer un archivo de texto |
| `list_files` | `read` | Listar archivos |
| `search_text` | `read` | Buscar con ripgrep |
| `git_status` | `read` | `git status --porcelain=v1` |
| `git_diff` | `read` | `git diff --no-ext-diff --no-textconv` |
| `skill_load`, `skill_search`, `skill_resource` | `read` | Catálogo, activación y recursos de Agent Skills |
| `context_explain` | `read` | Explicar qué archivos `AGENTS.md` se aplican a una ruta (consulte [Contexto](/es/context)) |
| `ask_user_question` | `read` | Preguntar al usuario de 1 a 4 preguntas de opción múltiple (véase [más abajo](#ask-user-question)) |
| `write_file` | `write` | Escribir un archivo |
| `edit_file` | `write` | Reemplazar una coincidencia exacta y única en un archivo |
| `run_process` | `process` | Ejecutar un comando con un array de argumentos |
| `shell` | `process` | Ejecutar un comando de shell |
| `bg_run` | `process` | Iniciar un comando de shell en segundo plano y seguir trabajando (véase [más abajo](#background-tasks)) |
| `bg_list`, `bg_output`, `bg_stop` | `process` | Listar las tareas en segundo plano, leer la salida de una de forma incremental, detener una (véase [más abajo](#background-tasks)) |
| `webfetch` | `external` | Leer una URL como texto/markdown/html (véase [más abajo](#webfetch)) |
| `websearch` | `external` | Buscar en la web (véase [más abajo](#websearch)) |
| `execute` | `process` | Ejecutar un fragmento JS que llama a otras herramientas ("Code Mode", véase [más abajo](#execute)) |
| `plugin_install` | `process` | Instalar un paquete de plugin npm en el directorio global de plugins (véase [más abajo](#plugin-install)) |

Las ediciones exigen una huella SHA-256 del archivo y una coincidencia exacta y única. Las escrituras
usan un archivo temporal más un reemplazo atómico en el mismo filesystem. Las operaciones mediadas
rechazan symlinks; esto no protege frente a procesos hostiles que cambien rutas concurrentemente, ni
confina una shell libre.

Los archivos editables y el escaneo inicial de lectura están limitados a 1 MiB; las salidas de
herramientas se acotan y un resultado truncado se indica explícitamente. Las lecturas independientes
se ejecutan en lotes de hasta cuatro; las operaciones con efectos se serializan.

`list_files` y `search_text` necesitan el ejecutable `rg` en el `PATH`. Cuando falta, las
herramientas y `alisio doctor` indican cómo instalarlo: `sudo apt install ripgrep`
(Debian/Ubuntu), `brew install ripgrep` (macOS), `winget install BurntSushi.ripgrep.MSVC` o
`scoop install ripgrep` (Windows).

Los plugins integrados añaden más herramientas: `memory_*` de [Memoria persistente](/es/memory) y
`task`, `task_status`, `task_wait` y `send_message` de [Subagentes](/es/subagents), todas con el
efecto `internal`.

## Partes de visualización para la interfaz web {#ui-parts}

Algunas herramientas incluidas añaden un bloque de visualización después de su resultado de texto
habitual, para clientes que muestran salida enriquecida como la [interfaz web](/es/web). El texto
sigue siendo la primera parte y es la única que recibe un modelo (los resultados de herramientas
llegan a los proveedores como su proyección de texto), así que la entrada del modelo, `alisio run
--json` y la TUI no cambian.

| Herramienta | Bloque | Contenido |
| --- | --- | --- |
| `write_file`, `edit_file` | `diff` | Parche unificado del cambio (`/dev/null` para un archivo nuevo), con la extensión del archivo como `lang`; recortado en un límite de línea a partir de 200 KB con un rótulo que lo indica |
| `shell`, `run_process` | `terminal` | Línea de comando, salida estándar y después error estándar (los últimos 256 KB), código de salida y duración |

Escribir un contenido idéntico no añade bloque. La TUI sigue mostrando estas herramientas como
antes, a partir de su texto; los bloques de los mismos tipos que devuelven plugins y servidores MCP
se siguen mostrando en la TUI.

## Preguntar al usuario {#ask-user-question}

`ask_user_question` permite al modelo hacer de 1 a 4 preguntas de opción múltiple (2 a 4 opciones
cada una, con como mucho una marcada `recommended` por pregunta —una sugerencia, nunca impuesta—)
cuando hay una bifurcación real en el enfoque. Es `effect: read`, pero está condicionada a que haya
**alguna** interfaz interactiva enlazada (`ui.interactive()`), sin importar qué sesión pregunta —un
[subagente](/es/subagents) bajo una TUI raíz interactiva también puede usarla—. En una ejecución
headless (`run`, `resume <id> "prompt"`, `--json`, o cualquier sesión sin interfaz interactiva
enlazada) la llamada falla rápido con un error estructurado que indica al modelo que pregunte en
texto plano en su lugar; nunca se queda esperando una interfaz que no puede responder. Véase
[Interfaz de terminal](/es/tui#ask-user-question) para el panel, sus teclas, el comportamiento de
Esc (omite solo la pregunta actual) y cómo se ponen en cola y se enrutan las preguntas de la raíz y
de los subagentes hacia la sesión exacta que preguntó.

## Entregar un plan: exit_plan {#exit-plan}

`exit_plan` es como termina el agente integrado **plan**: `{ plan: string (Markdown, hasta 60 000
caracteres), title?: string }`. Es `effect: read`, de modo que cualquier política lo permite, y se
ofrece **solo a la ejecución del agente plan** (nunca a `build`, a los subagentes ni a Code Mode). La
herramienta guarda el plan como artefacto `plan.md` (uno por llamada, así que cada revisión es un
artefacto nuevo de la sesión), pide una decisión al usuario con la misma infraestructura que
`ask_user_question` y **siempre devuelve un resultado de herramienta**, de modo que la sesión nunca
queda con una llamada colgada:

| `decision` del resultado | Significado | Qué se le dice al modelo |
|---|---|---|
| `approved` | El usuario aceptó | El agente build implementará exactamente este plan: responde en una frase y detente |
| `skipped` | Omitir por ahora, Esc, una pantalla cerrada, una ejecución cancelada o un tiempo agotado | Sigue en modo plan; no la llames de nuevo salvo que te lo pidan |
| `feedback` | Añadir contexto (el texto va en `feedback`) | Revisa el plan y vuelve a llamar a `exit_plan` |
| `unavailable` | Sin interfaz interactiva (`alisio run`, `--json`) o con `--read-only` | Da el plan completo como respuesta final |

La herramienta nunca cambia de agente ni inicia trabajo: registra la decisión y, cuando termina la
ejecución del plan, el anfitrión cambia a `build` e inicia un turno de implementación (véanse
[Terminal](/es/tui#plan-review) y [Web](/es/web#plan-review)). El agente plan es de solo lectura
porque la política de su ejecución no permite ningún efecto de escritura, proceso o externo, así que
ningún [modo de permisos](#permission-modes) puede ampliarla. `plan_proposed` y `plan_decided` son
eventos de ejecución durables.

## Ejecutar comandos en segundo plano: bg_run {#background-tasks}

`bg_run` inicia un comando de shell y devuelve de inmediato un id de tarea, de modo que el agente
puede seguir trabajando mientras corre un servidor de desarrollo, un watcher o una suite de pruebas
larga. Son cuatro herramientas, todas con `effect: process`:

| Herramienta | Entrada | Resultado |
| --- | --- | --- |
| `bg_run` | `command` (hasta 8 000 caracteres), `cwd?` (relativo al workspace), `label?`, `timeoutMs?` (de 1 s a 24 h, limitado por `tasks.maxRunMs`) | `{ id, label, status: "running", timeout_ms, note }` |
| `bg_list` | `status?`, `limit?` (hasta 50) | `{ tasks: [{ id, label, status, exit_code?, error?, stopped_by?, output_bytes, … }] }`, la más reciente primero |
| `bg_output` | `id`, `offset?` (0 por defecto), `limit?` (hasta 65 536 bytes, 16 KiB por defecto) | `{ id, status, exit_code?, text, next_offset, eof, output_truncated? }` |
| `bg_stop` | `id` | La tarea tal como queda tras la parada: `cancelled`, `stopped_by: "model"` |

**Una sola política para las cuatro.** Iniciar, listar, leer la salida de una tarea y detenerla pasan
por la misma compuerta `process` que `shell` y `run_process`: [`--read-only`](#permission-flags) y el
agente plan deniegan el conjunto entero (un modo que no puede iniciar un proceso tampoco puede leer
ni detener uno), y en modo `ask` y `auto` cada llamada pregunta primero (`Allow for this session`
cubre el resto). El modo `full` las ejecuta sin preguntar. El comando, el directorio de trabajo
(comprobado con la [política de rutas](#external-directories)) y el entorno siguen las mismas reglas
que `shell`: el mismo shell y la misma lista corta de variables de entorno. Una tarea pertenece a la
sesión raíz que la inició; otra sesión, aunque sea del mismo workspace, recibe «not found».

**Leer la salida.** La salida (estándar y de error, en orden de llegada) se guarda en un archivo de
log con offsets en bytes: pase `0` la primera vez y después el `next_offset` de la llamada anterior,
de modo que nada se repite y el contexto del modelo no se inunda. `eof` es verdadero solo cuando la
tarea terminó y se leyó todo. Un log conserva sus primeros `tasks.maxOutputBytes` bytes (2 MiB por
defecto), después una línea de aviso; los **últimos 32 KiB** se añaden cuando la tarea termina, así
que el error al final de una compilación larga sigue ahí.

**Estados.** `queued → running → stopping → succeeded | failed | cancelled | lost`; cada cambio es un
compare-and-set en la base de datos, de modo que nunca se sale de un estado terminal y una parada que
compite con la salida del proceso termina en un único estado. Una parada suya (UI) o del modelo
(`bg_stop`) es `cancelled`, nunca `failed`; el watchdog (`tasks.maxRunMs`, 1 hora por defecto) detiene
una tarea que corre demasiado y termina `failed` con el código `timeout`; detener envía SIGTERM al
grupo de procesos y SIGKILL tras 3 segundos (`taskkill /T /F` en Windows). Se conserva el origen de la
parada (`user`, `model`, `timeout`, `shutdown`).

**Límites.** Como máximo `tasks.maxPerSession` tareas vivas por sesión (4 por defecto) y 16 por
proceso de Alisio; los ajustes están en [Configuración](/es/configuration#tasks).

**La notificación de fin de tarea.** Cuando una tarea termina **por sí sola** (éxito, fallo o el
límite de tiempo), un mensaje despierta al agente dueño de la sesión: los ids de las tareas, su estado
y cómo leer la salida con `bg_output`. Está coalescida y limitada en frecuencia, nunca es uno por
turno:

- las tareas que terminan con menos de 2 segundos de diferencia comparten un mensaje;
- como máximo un despertar por sesión cada 10 segundos y 6 cada 10 minutos; lo que no cabe espera al
  siguiente lote (no se descarta nada);
- mientras la sesión está ocupada (corre un turno, espera una aprobación o una pregunta, otro proceso
  tiene la sesión) el mensaje espera y se reintenta cada 2 segundos, y otra vez en cuanto la sesión
  queda libre;
- la entrega se reclama en la base de datos (`delivered_at`) antes de despertar, así que no puede
  repetirse; una tarea cuya salida el modelo ya leyó después de que terminara **no** se anuncia;
- no se envía nada por una tarea que usted o el modelo detuvieron, por una que murió con Alisio, por
  tareas de sesiones hijas (subagentes) ni por una sesión archivada.

El despertar es una ejecución normal de la sesión: la terminal la inicia por su ruta de prompts y el
servidor web mediante su planificador de ejecuciones (`runner.enqueue` por sí solo dejaría el texto
esperando al siguiente prompt). En `alisio run` sin interfaz nada despierta al agente (el resultado de
`bg_run` lo dice): lea la salida con `bg_output`.

**Ciclo de vida y seguridad.** Una tarea es un proceso hijo corriente de Alisio, iniciado con el
ejecutor de procesos compartido. **No** está aislada (corre con sus permisos) y **no** es *detached*:
cuando Alisio termina (`/exit`, el final de `alisio run`, cerrar el servidor o un workspace) se mata el
grupo de procesos de cada tarea viva y la tarea termina `cancelled` con origen `shutdown`; un comando
que deja hijos en segundo plano los pierde también. `alisio run` no espera ninguna tarea: detiene las
que siguen corriendo y lo dice por stderr. Si Alisio muere de golpe (SIGKILL, corte de luz) nada puede
ejecutarse, así que el siguiente arranque marca las tareas sin terminar como `lost` —solo aquellas
cuyo proceso dueño ya no existe, nunca las de otro proceso de Alisio vivo— y sus procesos pueden seguir
corriendo: deténgalos usted (la tarea muestra su `pid`). Las tareas terminadas y sus logs se borran
tras `tasks.retentionDays` (7 por defecto). Los ids de tarea son ULID (80 bits aleatorios).

Véanse [Interfaz de terminal](/es/tui#tasks) e [Interfaz web](/es/web#background-tasks) para los
paneles `/tasks`.

## Trabajar hacia un objetivo: get_goal y update_goal {#goal-tools}

`/goal` ([terminal](/es/tui#goals), [web](/es/web#goals)) mantiene al agente trabajando en un objetivo
hasta que esté terminado, bloqueado, en pausa o sin presupuesto. Estas dos herramientas son todo lo
que el modelo tiene a mano sobre él:

- `get_goal` lee el objetivo, el estado y lo que queda del presupuesto de tokens, del tope de turnos
  y del tope de tiempo.
- `update_goal` informa que el objetivo está **`complete`** o **`blocked`**, con un `summary` y una
  lista de `evidence` (de 1 a 20 elementos, cada uno con un `kind` — `file`, `test`, `log`, `command`,
  `denied` u `other` — y un `detail`: una ruta, una ejecución de pruebas, una línea de registro).
  `complete` sin evidencia se rechaza. Un informe `blocked` debe repetirse, con evidencia nueva, en el
  turno **siguiente** (`goal.blockedRepeats`, 2 turnos consecutivos por defecto) antes de que el
  objetivo se detenga; un turno que no lo repite lo borra. Solo la evidencia de tipo `denied` (se
  denegó un permiso) bloquea de inmediato. Alisio no verifica la evidencia: se guarda y se muestra para
  que **tú** puedas hacerlo.

El modelo no puede pausar, reanudar, editar ni borrar el objetivo, ni cambiar su presupuesto: ninguna
herramienta lo hace, solo tú. `update_goal` solo funciona mientras el objetivo está activo (uno que
pausaste sigue en pausa) y cambia la contabilidad interna de Alisio, nunca el workspace, por lo que es
un efecto `internal` y nunca amplía un permiso.

Las dos herramientas son **opt-in**: una ejecución solo las ve mientras su sesión tiene un objetivo
**activo** y el agente no es el agente plan (el `execute` de Code Mode nunca las ofrece). En cualquier
otro caso no figuran ni se pueden llamar, así que sus descripciones no cuestan tokens en las peticiones
de una sesión sin objetivo.

## Leer una URL: webfetch {#webfetch}

`webfetch(url, format?, timeout?)` obtiene una URL `http(s)` y la devuelve como `markdown` (por
defecto), `text` o `html`. Sigue redirecciones (limitadas por el valor por defecto del propio
runtime, unos 20 saltos), y rechaza respuestas no textuales (imágenes, otros binarios) con un error
claro en lugar de devolver basura — compruebe primero el `content-type` de la respuesta si no está
seguro de que una URL sea legible. Las respuestas de más de 5 MiB se rechazan. `timeout` es en
segundos, 30 por defecto, con tope de 120.

El HTML se convierte con [`turndown`](https://www.npmjs.com/package/turndown) (markdown) o con una
extracción de texto mínima que elimina script/style; ambos usan
[`@mixmark-io/domino`](https://www.npmjs.com/package/@mixmark-io/domino), una implementación de DOM
pequeña y en JS puro (la única dependencia de turndown) — nunca un navegador headless ni jsdom. El
texto convertido incluido en el resultado se limita a 20 000 caracteres; una página más larga se
trunca ahí, pero el texto completo se escribe en un archivo de caché del workspace
(`.alisio/cache/webfetch/<hash>.<ext>`) y el `fullTextPath` del resultado lo indica, así que un
`read_file` posterior nunca pierde información.

## Buscar en la web: websearch {#websearch}

`websearch(query)` devuelve `{ title, url, snippet }[]`. No se incluye ningún proveedor como
dependencia obligatoria; la herramienta resuelve uno, en este orden:

1. **Una extensión `websearch` registrada por un plugin**
   (`api.extensions.register("websearch", ...)`) — véase [Escribir plugins](/es/plugins#extension-points).
   Reemplaza por completo lo siguiente mientras esté cargada; un proveedor que lanza excepción
   recurre a la cadena integrada con un diagnóstico.
2. **`websearch.provider`** de la [configuración](/es/configuration), si está definido:

   | `provider` | Necesita | Notas |
   | --- | --- | --- |
   | `"searxng"` | `websearch.searxngUrl` (opcional; véase abajo) | Autoalojado u otra instancia pública |
   | `"duckduckgo-instant"` | Nada | Sin clave; **solo responde consultas factuales/de infobox directas** (estilo Wikipedia) — un resultado vacío no significa que no exista nada en la web |
   | `"duckduckgo-html"` | Nada | Búsqueda web HTML **lite** de DuckDuckGo sin clave — una búsqueda web general real (a diferencia de `duckduckgo-instant`). Analiza HTML que DuckDuckGo puede cambiar en cualquier momento; la automatización intensa puede disparar verificaciones de bot. Un respaldo sólido sin clave cuando la instancia SearXNG por defecto está bloqueada como bot |
   | `"tavily"` | `TAVILY_API_KEY` (o `websearch.apiKeyEnv`) | Nivel gratuito sin tarjeta (1000 créditos/mes en el momento de escribir esto) |
   | `"brave"` | `BRAVE_SEARCH_API_KEY` | Necesita tarjeta; crédito recurrente de ~5 USD/mes ≈ 1000 consultas en el momento de escribir esto — no es gratis sin tarjeta |
   | `"serpapi"` | `SERPAPI_API_KEY` | Consulte los precios actuales de SerpApi |
   | `"native"` | `provider.apiMode: "responses"` | El proveedor del modelo busca del lado del servidor; véase abajo — la herramienta `websearch` ni siquiera se registra en este modo |

3. **Nada configurado**: una instancia pública de [SearXNG](https://docs.searxng.org/) (el valor por
   defecto de `websearch.searxngUrl`), consultada con `GET <url>/search?q=...&format=json` —
   genuinamente gratis y sin clave. **En la práctica esto es poco fiable**: al construir esta
   herramienta, casi todas las instancias públicas probadas (de [searx.space](https://searx.space))
   limitaron la tasa o bloquearon como bot una única solicitud automatizada recién hecha. Trátelo
   como un punto de partida, no como algo de lo que depender. Si le ocurre, cambie a
   `"duckduckgo-html"` en `/settings` → Proveedor de búsqueda web (o configure
   `websearch.provider`), o autoaloje — en cualquier caso es una línea de configuración:

   ```sh
   docker run -d -p 8080:8080 searxng/searxng
   ```
   ```json
   { "websearch": { "searxngUrl": "http://localhost:8080" } }
   ```

   Un `searxngUrl` que no sea loopback debe usar `https://` (una protección SSRF heurística, ya
   que —a diferencia de los hosts fijos de los demás proveedores— este es configurable por el
   usuario y podría apuntar a cualquier sitio).

Cada resultado incluye un `source`; cuando aplica, una `limitation` (por ejemplo, el alcance
limitado de DuckDuckGo Instant Answer) y, solo cuando un proveedor de plugin falló y se recurrió a
la cadena integrada, un `diagnostic`.

**El paso a través `"native"`** es opcional y específico del proveedor: con
`provider.apiMode: "responses"`, Alisio añade una definición de herramienta nativa del proveedor sin
procesar (`{ type: websearch.nativeToolType }`, por defecto `"web_search"`) a la petición de la
Responses API en lugar de implementar su propia llamada HTTP; el proveedor responde la búsqueda del
lado del servidor, así que la herramienta `websearch` no se registra en este modo. La mayoría de
proveedores compatibles con OpenAI —incluida la configuración de DeepSeek— **no**
admiten esto; consulte la documentación de su proveedor para conocer el tipo exacto de herramienta
que espera antes de activarlo. Una herramienta no admitida/rechazada aparece como un error normal
del proveedor, igual que cualquier otro fallo de la petición.

## Ejecutar un fragmento contra otras herramientas: execute {#execute}

`execute(code)` ("Code Mode") ejecuta un breve fragmento de JavaScript que llama a otras
herramientas ya registradas mediante `await callTool(name, input)` y devuelve un único valor final
—así los resultados intermedios de las herramientas (por ejemplo, el contenido de varios archivos)
nunca vuelven a entrar en el contexto propio del modelo, solo lo hace el valor de retorno del
fragmento—. Es una funcionalidad mucho más ligera de lo que podría sonar: **no** replica un motor o
intérprete JS completo, y no le da al fragmento ninguna capacidad que una llamada a herramienta
secuencial sencilla no tuviera ya.

- El aislamiento usa el módulo `vm` propio de Node: el fragmento obtiene su propio objeto global e
  intrínsecos de V8, sin `require`, `process`, `fetch`, acceso al sistema de archivos ni
  temporizadores — lo único expuesto es `callTool`. `codeGeneration` está restringido, así que el
  fragmento no puede usar `eval()` ni `new Function()` para conseguir más.
- Cada `callTool` anidado pasa por exactamente la misma puerta de efecto/permiso que una llamada
  directa: un efecto que la política actual no permita ya se deniega directamente. `execute` nunca
  dispara una nueva aprobación interactiva desde dentro del fragmento (eso podría significar un
  aviso anidado confuso y potencialmente en punto muerto) — solo puede usar lo que esta sesión ya
  tiene.
- Limitado a 10 segundos en tiempo real y 20 llamadas a herramientas anidadas; un fragmento no puede
  llamarse a sí mismo mediante `execute`.

::: danger No es un sandbox de seguridad
La propia documentación de Node es explícita: "el módulo vm no es un mecanismo de seguridad; no lo
use para ejecutar código no confiable". `execute` aísla el ámbito de un fragmento y acota su tiempo
de ejecución por corrección y ergonomía, no como frontera a nivel de sistema operativo — el mismo
modelo de confianza que el resto de herramientas de Alisio en el mismo proceso. Véase [No es un
sandbox](#no-es-un-sandbox).
:::

`execute` usa el efecto `process` (reutilizando la puerta existente en lugar de añadir una
clasificación nueva): ejecutar un fragmento JS es ejecución de código arbitrario en el mismo
espíritu que `run_process`/`shell`, y `--allow-process` es lo que un usuario ya espera que controle
"ejecutar cosas".

## Instalar plugins: plugin_install {#plugin-install}

`plugin_install(spec)` instala un paquete de plugin npm en el directorio global de plugins de Alisio
(`<config home>/plugins`) y añade su nombre npm al array `plugins` de la configuración global — la
misma rutina que hay detrás del comando `alisio install`. `spec` acepta `npm:<paquete>[@<versión>]` o
un nombre de paquete pelado, validado antes de cualquier operación de red. Permite que el modelo
instale un plugin a petición tuya en lugar de que escribas tú el comando: el agente forma la
especificación correcta e invoca la herramienta, y tú conservas la última palabra mediante el flujo
de permisos habitual.

Es una herramienta del host con el efecto `process`: instalar ejecuta `npm install`, un subproceso
sin sandbox que puede ejecutar los scripts de ciclo de vida del paquete, así que pasa por la misma
compuerta que `run_process`/`shell` — permitida directamente con `--allow-process`, preguntada de
forma interactiva en la TUI en caso contrario, y denegada por completo (ni siquiera registrada) con
`--read-only`. El resultado se sanea y devuelve el nombre del paquete, la versión instalada, la
entrada de configuración, la ruta de instalación y la nota de confianza del proyecto. Consulte
[Escribir plugins](/es/plugins#installing-plugins-from-npm) para la historia completa, incluida la
regla de confirmación `--yes` en headless.

## Rutas fuera del workspace {#external-directories}

Las herramientas de lectura, escritura y edición se mediatizan contra el workspace más los
directorios que declare. Una ruta fuera de toda raíz permitida ya no es un callejón sin salida:
pregunta por aprobación acotada al **directorio contenedor**, no al archivo individual.

- **Interactivo (TUI):** Alisio pregunta **Permitir una vez**, **Permitir siempre este directorio en
  esta sesión** o **Denegar**. Una aprobación de sesión cubre ese directorio y todo su subárbol, así
  que una respuesta cubre todos los archivos bajo él. El mismo aviso, la misma cola y las mismas
  opciones que las aprobaciones de capacidad anteriores.
- **Las escrituras siguen condicionadas:** una aprobación de directorio externo es un
  **prerrequisito, no un sustituto**. Una escritura o edición fuera del workspace sigue necesitando
  `--allow-write` (o su propia aprobación); primero corre la comprobación de directorio y después la
  del efecto.
- **Headless / no interactivo (`run`, `resume <id> "prompt"`, `--json`):** el aviso nunca se cuelga.
  La llamada se deniega con la ruta resuelta y los remedios exactos.
- **Llamadas anidadas de `execute`** nunca abren un aviso nuevo: solo pueden usar directorios ya
  aprobados para la sesión.

Declare raíces extra de dos formas (se combinan):

| Mecanismo | Alcance | Notas |
| --- | --- | --- |
| `--add-dir <paths...>` | Una ejecución | Repetible; las rutas se resuelven contra el directorio actual |
| `additionalDirectories` en la [configuración](/es/configuration#additionaldirectories) | Persistente | Se resuelve respecto al archivo de configuración que lo define, se canoniza al cargar y es aditivo entre capas |

`--read-only` permanece totalmente bloqueado: no concede **ningún** acceso externo mediante el aviso,
`--add-dir` ni `additionalDirectories`. Véase [Flags de permisos](#permission-flags).

## Flags de permisos {#permission-flags}

| Flag | Efecto |
| --- | --- |
| (ninguno) | Solo lectura y búsqueda en modos headless; en la TUI, `write`/`process`/`external` también se ofrecen y **preguntan siempre** (véase la tabla de verdad abajo) |
| `--allow-write` | Activa `write_file` y `edit_file` directamente, sin preguntar |
| `--allow-process` | Activa `run_process`, `shell` y `execute` directamente, sin preguntar |
| `--allow-analysis` | Activa directamente solo el análisis en Python (`python_run`, capability `analysis.run`); nunca `shell` ni `run_process` |
| `--python <path>` | Fija el intérprete Python 3.10+ de `python_run` (si no, se descubre automáticamente) |
| `--allow-external` | Activa `webfetch` y `websearch` directamente, sin preguntar |
| `--allow-mcp` | Inicia/conecta los servidores MCP configurados y expone sus capacidades |
| `--allow-agents` | Activa las herramientas de mensajería de Herdr |
| `--add-dir <paths...>` | Declara directorios extra que las herramientas pueden tocar fuera del workspace (repetible, solo esta ejecución) |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, herramientas de red, MCP, mensajería entre agentes y plugins ejecutables (externos) — nunca se ofrecen, ni en la TUI ni en headless; también desactiva toda ruta externa |

`--read-only` prevalece sobre cualquier flag `--allow-*`. Los plugins integrados (por ejemplo
`memory`) siguen activos con `--read-only` porque sus herramientas solo usan el efecto `internal`;
use `--disable-plugin memory` para un modo estrictamente sin escrituras.

### Tabla de verdad de write/process/external

| Estado | TUI | Headless (`run`, `resume <id> "prompt"`, `--json`) |
| --- | --- | --- |
| Sin flag, sin `--read-only` | **Pregunta siempre** que el modelo llama la herramienta (permitir una vez / permitir durante la sesión / denegar) | La herramienta simplemente **no está disponible** — no hay a quién preguntar |
| `--allow-write` / `--allow-process` / `--allow-external` | **Permitida**, nunca pregunta | **Permitida**, nunca pregunta |
| `--read-only` | **Nunca se ofrece**, denegada de forma dura | **Nunca se ofrece**, denegada de forma dura |

El "pregunta siempre" por defecto de la TUI no necesita ningún flag adicional: es el propio flujo de
aprobación siempre activo de la TUI (el mismo que ya usaban `write`/`process`) que ahora también
cubre `external`. Los modos headless son no interactivos por diseño, así que un flag sin definir ahí
significa que el efecto no está disponible, sin más — nunca se pregunta, nunca se permite en
silencio.

### Flujo de ejecución de herramientas

El diagrama siguiente (recurso fuente
`docs/assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp`) muestra cómo la
ejecución de herramientas atraviesa el modelo de permisos: cada llamada se resuelve contra el efecto
declarado por su definición de herramienta y solo entonces se ejecuta — permitida, consultada
(aprobación interactiva) o denegada. Es una ilustración del flujo de esta sección, no una frontera
de seguridad.

![Flujo de Ejecución de Herramientas y Modelo de Permisos — flujo de ejecución de herramientas y modelo de permisos](<../assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp>)

## Aprobación interactiva

En la TUI, las herramientas `write`, `process` y `external` no permitidas mediante flags se ofrecen
al modelo y Alisio pregunta antes de ejecutar cada llamada: permitir una vez, permitir ese efecto
durante la sesión o denegar. Una ruta fuera del workspace y de toda raíz extra declarada usa las
mismas tres opciones, acotadas al directorio contenedor. Los modos headless (`run`, `resume <id> "prompt"`, `--json`) nunca
preguntan. Consulte [Interfaz de terminal](/es/tui#interactive-approvals).

## Confianza del proyecto {#project-trust}

Aparte de las aprobaciones de llamadas a herramientas, abrir un repositorio no debe cargar en
silencio *su* configuración de Alisio (que puede apuntar su clave de API a otro endpoint) ni
ejecutar sus plugins. La TUI pregunta una vez por directorio antes de hacerlo; la decisión persiste
y un `.alisio/config.json` modificado vuelve a preguntar. `alisio trust list`/
`alisio trust revoke <path>` la inspeccionan o la deshacen. Consulte [Inicio
rápido](/es/quick-start#configuration-trust-model) para el flujo completo y
[Configuración](/es/configuration) para el comando `alisio trust`.

## Análisis en Python {#python-analysis}

`python_run`, `artifact_create`, `artifact_list`, `artifact_read` y `artifact_export` publican,
listan, leen y copian artefactos descargables (`artifact_export` es una herramienta `write`:
pregunta salvo con `--allow-write`, y `--read-only` la elimina); consulta
[Análisis en Python y artefactos](/es/analysis). `python_run` declara la **capability**
`analysis.run`, un permiso más fino dentro del efecto `process`: `--allow-process` (o una
aprobación de sesión de `process`) la cubre, mientras que `--allow-analysis` y su propia aprobación
nunca amplían `process`. Su decisión **Permitir en esta sesión** se guarda para la sesión raíz y
sobrevive a los reinicios, así que también aplica cuando un `alisio resume <id> "prompt"` headless
continúa esa sesión. Revócala con `/permissions`. Toda decisión queda auditada. `execute` solo
llega a `python_run` cuando ya está permitido por una flag (nunca a través de un permiso guardado).
Python administrado no es un sandbox; con `analysis.runtime: "oci"` la misma llamada se ejecuta en un
contenedor sin acceso a la red (aislamiento con límites, consulta
[Runtime de contenedor](/es/analysis#oci)).

`python_run { extras: ["analysis"] }` pide los paquetes opcionales de Python. Si no están instalados,
pide una segunda capability, **`analysis.install`**: siempre pregunta, ofrece solo **Permitir esta
vez** y **Denegar** (no se guarda ningún permiso), muestra los paquetes, la estimación de descarga y
que necesita red, y **ninguna flag la cubre** (ni `--allow-process` ni `--allow-analysis`). Una
ejecución headless no tiene a quién preguntar, así que la llamada falla nombrando el comando opcional
`alisio analysis setup --extras analysis`. `python_run { rerunOf: "art_…" }` ejecuta de nuevo un
análisis anterior de la sesión (mismo script, entradas verificadas por hash, artefactos nuevos) tras
la misma puerta `analysis.run`; consulta [Ejecutar de nuevo](/es/analysis#rerun).

### Datos tabulares {#data-tools}

`data_inspect` y `data_query` (efecto `read`) describen y consultan archivos CSV, TSV, JSON, JSONL y
XLSX mediante un dataset SQLite por archivo; consulta [Datos tabulares](/es/analysis#data). Nunca
escriben en el repositorio (la ingesta escribe en la carpeta de estado), así que siguen disponibles
con `--read-only` y no necesitan ninguna flag. `data_inspect { path }` resuelve la ruta como
`read_file` (workspace o un directorio extra aprobado); `data_query` ejecuta una sola sentencia
`SELECT`/`WITH` sobre un dataset de la sesión, limitada a 1 000 filas y a `analysis.data.queryTimeoutMs`.
Ambas muestran sus tablas con el renderizador de tablas de la terminal.
`python_run { inputs: [{ "datasetId": … }] }` entrega el dataset a un script. XLSX es el único formato
que necesita Python 3.10+ (un helper fijo de Alisio con la biblioteca estándar, no código del modelo).

## Modos de permisos {#permission-modes}

La TUI (`/permission`) y la interfaz web (el menú de permisos y `/permission`) comparten tres
**modos de permisos**. Una única tabla de `@alisio/core` asigna a cada modo la política de la
ejecución, y los presets de la web se derivan de ella:

| Modo | `write` | `process` | `external` | Preset web |
| --- | --- | --- | --- | --- |
| `ask` | pregunta | pregunta | pregunta | `ask` |
| `auto` | permitido | pregunta | pregunta | `workspace-write` |
| `full` | permitido | permitido | permitido | `full-access` |

`auto` tiene reglas fijas y ningún clasificador de IA: las ediciones dentro del workspace se
ejecutan; los comandos, la red y las herramientas externas siguen preguntando. Un modo solo elige
qué **efectos** se ejecutan sin preguntar; las rutas fuera del workspace siguen preguntando por
directorio y la preconcesión del análisis en Python (`--allow-analysis`) no forma parte de ningún
modo. `--read-only` elimina el manejador de aprobación, así que allí no se pueden elegir modos. En
`alisio serve` los flags de arranque son el techo: un efecto que no permiten sigue preguntando sea
cual sea el modo. El modo plan lo impone el runner, no el prompt: un agente de solo lectura no tiene
herramientas de escritura, de procesos ni externas sea cual sea el modo elegido. Véase
[TUI](/es/tui#permission-modes) y [Interfaz web](/es/web#permission-modes).

## No es un sandbox

::: danger
Alisio **no** ofrece un sandbox del sistema operativo. `--allow-process` da al modelo procesos
arbitrarios con sus privilegios de usuario. Los plugins se ejecutan en el mismo proceso con todos los
privilegios; ni un manifiesto de plugin ni un subproceso son una frontera de aislamiento, y el campo
`effect` no aísla nada.
:::

## MCP

Los servidores MCP usan la configuración canónica `mcp.servers` o la compatible `mcpServers`.
Permanecen desconectados hasta que se solicitan. Los modos headless, JSON, readline y doctor, y el
uso embebido, requieren `--allow-mcp`/`allowMcp`; en la TUI interactiva, **Conectar** o **Activar**
presenta primero un consentimiento de proceso/red válido solo para esa sesión. `--read-only` siempre
bloquea MCP.

La preferencia de usuario `mcp.allow` concede el mismo consentimiento de proceso/red de forma
**persistente entre sesiones**: cada inicio (TUI y headless) comienza concedido, muestra `mcp:on`, y
auto-conecta los servidores activados. Solo se lee de la capa global/de usuario
(`<config home>/config.json`) y eleva el permiso inicial igual que `--allow-mcp`; `--read-only`
prevalece sobre ambos. Un valor en `.alisio/config.json` de un proyecto se ignora para esta decisión.
Concederlo persiste entre sesiones: actívelo solo si confía en cada servidor configurado, porque los
servidores MCP se ejecutan sin sandbox con sus privilegios de usuario. Los servidores stdio son
subprocesos sin sandbox; los valores `env` directos quedan limitados a ese proceso hijo y no aparecen
en diagnósticos.

- `mcp_connect` conecta bajo demanda y registra las herramientas del servidor; `mcp_resource` y
  `mcp_prompt` permiten listar y consultar recursos y prompts.
- `/mcps` muestra los estados desactivado, desconectado, conectando, conectado, fallido, requiere
  autenticación y requiere reinicio cuando correspondan. Configuración/activación, permiso de
  ejecución, conexión y cantidad de herramientas cargadas son estados separados. Presenta las
  anotaciones declaradas de solo lectura, destructiva y mundo abierto; una herramienta sin
  anotaciones no se considera destructiva.
- Las herramientas conectadas usan nombres semánticos seguros para proveedores, como
  `mcp_devforge_time_diff`; solo se agrega un hash corto y determinista por colisión o truncamiento.
  Están disponibles en el siguiente turno del modelo. El modelo aún decide si las llama: escriba
  «usa `devforge/time_diff`» cuando la llamada sea obligatoria, en vez de depender de la selección
  automática.
- Las herramientas expuestas deben usar esquemas soportados por el registro. Los cambios de esquema
  exigen reconectar; nunca se ejecuta una llamada con un esquema obsoleto.
- No hay OAuth interactivo ni reintentos automáticos de operaciones con efectos.

```sh
alisio mcp list --config ./my-api.json
alisio mcp doctor my-server --config ./my-api.json --allow-mcp
```

### Resultados enriquecidos

Los resultados de herramientas y recursos MCP ya no se aplana a texto JSON. El conector los mapea
heurísticamente a las partes de contenido propias de Alisio:

- Las partes `text` siguen siendo texto; las partes `image` se convierten en imágenes.
- `structuredContent` (o una parte de texto parseable como JSON) que coincida con una **forma
  verificada** se convierte en un bloque nativo de la TUI: tablas `{columns, rows}` /
  `{headers, rows}` (las filas también pueden ser objetos indexados por los nombres de columna),
  objetos planos de escalares como clave-valor, y árboles `{nodes: [{label, children?, meta?}]}`.
  Todo lo demás —incluido JSON anidado sin forma reconocida— sigue siendo texto plano, como antes.
- Siempre se añade una **proyección de texto canónica** de cada bloque/imagen, de modo que el
  modelo, la compactación y cualquier ruta headless (`run`, `resume <id> "prompt"`, `--json`,
  `--no-tui`, `TERM=dumb`, `NO_COLOR`) vean exactamente lo que veían antes: solo texto, nunca
  bytes de imagen. La TUI renderiza el bloque de forma nativa sobre esa misma proyección.

En la TUI, las tablas se renderizan como columnas alineadas con celdas que se ajustan al ancho; el
clave-valor, como dos columnas; los árboles, con glifos de ramas; los bloques de código, con el
mismo resaltado de sintaxis que las respuestas; y los bloques markdown, con el renderizador de
Markdown habitual. Las imágenes se muestran en línea cuando la terminal soporta el protocolo de
gráficos kitty o iTerm2 (marcador atenuado `[image: mime AxA]` en caso contrario). `mcp_resource`
usa el mismo mapeo para contenidos de texto y blobs de imagen; los blobs que no son imagen se
convierten en un marcador corto en vez de base64 crudo.

Limitaciones: la detección de formas es deliberadamente conservadora (heurística, no impulsada por
protocolo); los servidores que devuelven solo JSON no estructurado conservan el comportamiento
anterior literalmente; y si la terminal no puede renderizar imágenes, la TUI muestra un marcador
mientras el modelo sigue leyendo `[image: …]` en la proyección de texto.

### Ejemplo: Brave Search

El paquete oficial corre sobre stdio mediante `npx` (resuelto desde su `PATH`, que el conector
reenvía al proceso hijo):

```json
{
  "mcp": {
    "servers": {
      "brave-search": {
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@brave/brave-search-mcp-server"],
        "envAllow": ["BRAVE_API_KEY"]
      }
    }
  }
}
```

`envAllow` reenvía las variables de entorno listadas **por nombre** desde su shell; la clave nunca
queda en el archivo de configuración. Expórtela antes de iniciar Alisio:

```sh
export BRAVE_API_KEY=tu-clave
```

MCP permanece desconectado hasta que se solicita: pasar `--allow-mcp` (o activar la preferencia
global `mcp.allow`) concede el consentimiento de proceso/red y auto-conecta los servidores
activados; en la TUI también puede elegir **Conectar** en `/mcps`.

## Herdr

Dentro de un panel de [Herdr](https://github.com/GustavoGutierrez/alisio/blob/main/docs/herdr.md),
los reportes de ciclo de vida se activan con las variables de Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`,
`HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`). Alisio reporta `custom:alisio`, su estado y su sesión, y
libera esa autoridad al salir. `--no-herdr` desactiva los reportes.

```sh
alisio --config /path/to/my-api.json --allow-agents
```

Con `--allow-agents`, el modelo obtiene `herdr_agents`, `herdr_prompt`, `herdr_read` y `herdr_wait`.
Use IDs de panel o nombres únicos de agentes. Los argumentos se envían como arrays, nunca se
interpolan en una shell, y los mensajes ambiguos no se reintentan.

Alisio es una integración custom: no use `herdr agent start --kind alisio` (Herdr 0.9.1 no incluye
ese kind). Inícielo en un panel existente o con `herdr pane run`, y reanude manualmente con
`alisio resume`.
