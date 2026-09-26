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
| `webfetch` | `external` | Leer una URL como texto/markdown/html (véase [más abajo](#webfetch)) |
| `websearch` | `external` | Buscar en la web (véase [más abajo](#websearch)) |
| `execute` | `process` | Ejecutar un fragmento JS que llama a otras herramientas ("Code Mode", véase [más abajo](#execute)) |

Las ediciones exigen una huella SHA-256 del archivo y una coincidencia exacta y única. Las escrituras
usan un archivo temporal más un reemplazo atómico en el mismo filesystem. Las operaciones mediadas
rechazan rutas fuera del workspace y symlinks; esto no protege frente a procesos hostiles que cambien
rutas concurrentemente, ni confina una shell libre.

Los archivos editables y el escaneo inicial de lectura están limitados a 1 MiB; las salidas de
herramientas se acotan y un resultado truncado se indica explícitamente. Las lecturas independientes
se ejecutan en lotes de hasta cuatro; las operaciones con efectos se serializan.

Los plugins integrados añaden más herramientas: `memory_*` de [Memoria persistente](/es/memory) y
`task`, `task_status`, `task_wait` y `send_message` de [Subagentes](/es/subagents), todas con el
efecto `internal`.

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
   | `"tavily"` | `TAVILY_API_KEY` (o `websearch.apiKeyEnv`) | Nivel gratuito sin tarjeta (1000 créditos/mes en el momento de escribir esto) |
   | `"brave"` | `BRAVE_SEARCH_API_KEY` | Necesita tarjeta; crédito recurrente de ~5 USD/mes ≈ 1000 consultas en el momento de escribir esto — no es gratis sin tarjeta |
   | `"serpapi"` | `SERPAPI_API_KEY` | Consulte los precios actuales de SerpApi |
   | `"native"` | `provider.apiMode: "responses"` | El proveedor del modelo busca del lado del servidor; véase abajo — la herramienta `websearch` ni siquiera se registra en este modo |

3. **Nada configurado**: una instancia pública de [SearXNG](https://docs.searxng.org/) (el valor por
   defecto de `websearch.searxngUrl`), consultada con `GET <url>/search?q=...&format=json` —
   genuinamente gratis y sin clave. **En la práctica esto es poco fiable**: al construir esta
   herramienta, casi todas las instancias públicas probadas (de [searx.space](https://searx.space))
   limitaron la tasa o bloquearon como bot una única solicitud automatizada recién hecha. Trátelo
   como un punto de partida, no como algo de lo que depender. Autoalojarlo es una línea de
   configuración:

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
proveedores compatibles con OpenAI —incluida la configuración de DeepSeek que trae Alisio— **no**
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

## Flags de permisos {#permission-flags}

| Flag | Efecto |
| --- | --- |
| (ninguno) | Solo lectura y búsqueda en modos headless; en la TUI, `write`/`process`/`external` también se ofrecen y **preguntan siempre** (véase la tabla de verdad abajo) |
| `--allow-write` | Activa `write_file` y `edit_file` directamente, sin preguntar |
| `--allow-process` | Activa `run_process`, `shell` y `execute` directamente, sin preguntar |
| `--allow-external` | Activa `webfetch` y `websearch` directamente, sin preguntar |
| `--allow-mcp` | Inicia/conecta los servidores MCP configurados y expone sus capacidades |
| `--allow-agents` | Activa las herramientas de mensajería de Herdr |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, herramientas de red, MCP, mensajería entre agentes y plugins ejecutables (externos) — nunca se ofrecen, ni en la TUI ni en headless |

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

## Aprobación interactiva

En la TUI, las herramientas `write`, `process` y `external` no permitidas mediante flags se ofrecen
al modelo y Alisio pregunta antes de ejecutar cada llamada: permitir una vez, permitir ese efecto
durante la sesión o denegar. Los modos headless (`run`, `resume <id> "prompt"`, `--json`) nunca
preguntan. Consulte [Interfaz de terminal](/es/tui#interactive-approvals).

## Confianza del proyecto {#project-trust}

Aparte de las aprobaciones de llamadas a herramientas, abrir un repositorio no debe cargar en
silencio *su* configuración de Alisio (que puede apuntar su clave de API a otro endpoint) ni
ejecutar sus plugins. La TUI pregunta una vez por directorio antes de hacerlo; la decisión persiste
y un `.alisio/config.json` modificado vuelve a preguntar. `alisio trust list`/
`alisio trust revoke <path>` la inspeccionan o la deshacen. Consulte [Inicio
rápido](/es/quick-start#configuration-trust-model) para el flujo completo y
[Configuración](/es/configuration) para el comando `alisio trust`.

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
bloquea MCP. Los servidores stdio son subprocesos sin sandbox; los valores `env` directos quedan
limitados a ese proceso hijo y no aparecen en diagnósticos.

- `mcp_connect` conecta bajo demanda y registra las herramientas del servidor; `mcp_resource` y
  `mcp_prompt` permiten listar y consultar recursos y prompts.
- `/mcp` muestra los estados desactivado, desconectado, conectando, conectado, fallido, requiere
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
