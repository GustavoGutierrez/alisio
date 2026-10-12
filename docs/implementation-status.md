# Estado de implementación — `__ALISIO_VERSION__`

La especificación original es la dirección del producto, no una declaración de que todos
sus criterios de release estén superados. `__ALISIO_VERSION__` es una versión estable
(semver 0.x: las versiones menores pueden incluir cambios incompatibles hasta 1.0.0), funcional
y no solo interfaces o stubs.

## Contenido

El índice es de texto plano a propósito: este archivo se lee tanto en GitHub como dentro del
sitio, y los dos generan anclas distintas para títulos con acentos (GitHub las conserva, VitePress
las elimina), así que unos enlaces internos aquí se romperían en uno de los dos. Use el esquema de
la derecha en el sitio o la búsqueda de su navegador en GitHub.

- Implementado: proveedores y `/connect`; núcleo, límites y almacenamiento; herramientas, AGENTS.md
  y skills; subagentes; plugins, extensiones y MCP; CLI, runtime y empaquetado; plantillas, pantalla
  de inicio y TUI; compactación, plugins y memoria; modelo y enrutamiento por sesión; preguntar al
  usuario; herramientas de red y CLI; confianza de proyecto y diagnóstico; agente activo y effort
  de razonamiento; agentes del usuario (ventana Agentes y `/agents`); servidor web
  (`alisio serve`); modos de permisos, `/reload` y `/changelog` (fase 1 de la especificación de
  modos, goal y tareas en segundo plano); pestaña Memory de la web y vistas de datos de plugins
  (`specs/archive/alisio-web-memory-tab-v1.md`); tareas en segundo plano (fase 3) y objetivos de sesión
  `/goal` (fase 4) de la especificación de modos, goal y tareas en segundo plano; Decision
  Intelligence (fases 1 a 5 de `specs/alisio-decision-intelligence-v1.md`); Smart Dashboard (fases 0 a 7
  de `specs/alisio-smart-dashboard-v1.md`; pendientes la medición E7, el benchmark B/C y el
  release).
- Validación.
- Pendiente para llegar a 1.0.0.
- Alcance de la verificación: una sección por área (runtime y empaquetado; subagentes, AGENTS.md y
  skills; plantillas y `/init`; pantalla de inicio y extensiones; TUI y compactación; presupuesto de
  tokens de salida del agente; límite de contexto frente al catálogo; memoria y plugins; pegado y
  adjuntos de imagen; preguntar al usuario; herramientas de red; confianza de proyecto y permisos;
  agente activo y effort; contratos de eventos y bloques UI; persistencia v4, blobs y catálogo de
  comandos; agentes del usuario; servidor web; modos, `/reload` y `/changelog`; pestaña Memory y
  vistas de plugins; tareas en segundo plano; objetivos de sesión; Decision Intelligence; Smart
  Dashboard).
- Límites conocidos: runtime y empaquetado; subagentes; proveedores, plantillas y licencia; memoria;
  plugins e instalación; portapapeles, pegado y TUI; skills y contexto; compactación y truncamiento;
  permisos, aprobaciones y confianza; preguntas y herramientas de red; persistencia, estadísticas y
  Herdr; agente activo y effort; agentes del usuario; servidor web; modos, recarga y novedades;
  pestaña Memory y vistas de plugins; tareas en segundo plano; objetivos de sesión; Decision
  Intelligence; Smart Dashboard.

## Implementado

### Proveedores y `/connect`

- Proveedores de primera clase: contrato SDK aditivo `providers.register`, registro múltiple en el
  núcleo y activación transaccional. El adaptador OpenAI-compatible salió del núcleo al plugin
  integrado `@alisio/plugin-openai-compatible` (Chat/Responses, catálogo y mismo ID heredado
  `openai-compatible:<modo>:<baseURL normalizada>`). `/connect` permite elegir proveedor,
  configuración y modelo; persiste globalmente el perfil sin secretos en `providers.json` y las
  credenciales en `credentials.json` (escritura atómica, `0600`, directorio `0700`; no cifrado).
  Cuando el catálogo no informa la ventana de contexto del modelo seleccionado (servidores locales
  como llama.cpp), `/connect` pregunta un `contextWindow` opcional en tokens que se guarda en los
  `values` del perfil y alimenta la barra de contexto.
  El perfil también recuerda el nombre de la variable de entorno de la clave (`values.apiKeyEnv`):
  los registros de los plugins exponen el campo, `/connect` lo persiste, y al crear el proveedor se
  usa el nombre recordado (con respaldo al nombre por defecto del plugin) para leer
  `process.env[...]` cuando no hay credencial guardada; la credencial guardada siempre tiene
  prioridad.
  El arranque sin proveedor permite onboarding; headless nunca pregunta. Cada cambio inicia una
  sesión nueva para no mezclar continuación opaca. Se mantienen config/env/flags heredados y la
  máxima prioridad de `AppOptions.provider`. Un perfil activo de `/connect` se restaura entre
  proyectos aunque la capa de confianza solo defina MCP/plugins/skills; solo un `provider` raíz real
  en la capa de proyecto/explícita o una anulación de endpoint selecciona el adaptador heredado para
  esa ejecución. La cobertura usa hogares y proyectos temporales con credenciales ficticias e incluye
  reinicio tras `/model`; no consulta configuración ni credenciales reales del usuario.
  El formulario de `/connect` acepta pegado normal y bracketed paste por fragmentos, permite editar
  URL con cursor y mantiene los secretos enmascarados fuera del historial y del transcript.
  Hay tres plugins dedicados adicionales, publicados como paquetes independientes desde el
  monorepo alisio-plugins e instalables con `alisio install npm:@alisio/plugin-...` (ya no son
  integrados de Alisio): `@alisio/plugin-deepseek` usa el endpoint
  oficial por defecto, descubre metadatos de contexto/salida/modalidades/capacidades y admite Chat
  Completions y Responses; `@alisio/plugin-opencode` integra Console/Zen con referencias
  `opencode/<id-del-modelo>`; y `@alisio/plugin-opencode-go` usa `opencode-go/<id-del-modelo>`.
  Ambos OpenCode consultan catálogos sin autenticación y envían Bearer, `user-agent:
  alisio/<versión>` y un `x-opencode-session` opaco y estable en inferencia. Cada producto conserva
  su propio mapa exacto documentado para Responses, Chat Completions o Anthropic Messages; los IDs
  futuros desconocidos se ocultan y fallan cerrados. Zen filtra explícitamente Gemini nativo y
  System One porque no satisfacen el contrato actual del agente de texto. El selector muestra el
  proveedor propietario, y cada cambio persistido inicia una sesión nueva para aislar datos de
  continuación por producto, endpoint y protocolo. El proveedor genérico sigue disponible.

### Núcleo, límites y almacenamiento

- Núcleo propio: streaming, tool loop, validación de entradas, límites de turnos/tiempo/contexto,
  presupuesto de tokens reportados, cancelación y eventos versionados.
- Límite de turnos SUAVE (`limits.maxTurns`, por defecto `100`): al alcanzar el tope, la ejecución
  termina con `status: "turns-exceeded"` y evento `run_turns_exceeded` (datos con el tope) en lugar
  de fallar: el transcript hasta ese punto se conserva íntegro, la TUI muestra un aviso amable (no
  un error), la siguiente ejecución en la misma sesión continúa donde quedó, y un subagente que agota
  su tope entrega su informe parcial como `completed` con el marcador `turnsExceeded` (nunca
  `failed`). Los topes duros reales siguen siendo el presupuesto de tokens (`maxTokens`) y el
  tiempo de espera (`timeoutMs`), sin cambios de semántica.
- API compatible con OpenAI configurable: Chat Completions y Responses, modelo/URL/clave,
  ausencia de autenticación y diferencias de parámetros de tokens.
- SQLite: conversación autoritativa, eventos, journal de herramientas, estado de plugins,
  bloqueo de sesión y recuperación conservadora de efectos inciertos.
- Contratos de la fase 0 de `alisio serve` (aditivos, `schemaVersion` sigue en `1`): el SDK tipa
  cada evento que emite el runner (`RunEventType`, `RunEventDataMap`, `KnownRunEvent`,
  `EphemeralRunEventType`/`isEphemeralRunEventType`); `RunEvent` gana `eventId` opcional (el
  `events.seq` global persistido, ausente en `text_delta`/`reasoning_delta`/`tool_progress`) y
  `correlationId` opcional; `SessionStore.event` devuelve `number | void`; `RunOptions` acepta
  `runId` y `correlationId`; `turn_completed` añade `durationMs` y `ttftMs`. `UiBlock` gana los
  kinds `diff`, `terminal`, `mermaid`, `math`, `json`, `test-results` y `progress` (lista en
  `UI_BLOCK_KINDS`) con fallback de texto en la TUI y en la proyección de texto del núcleo; un kind
  desconocido o mal formado se muestra como JSON etiquetado en lugar de fallar. El SDK añade los
  tipos del protocolo web v1 (`ServerFrame`, `PendingApproval`, `PendingInteraction`,
  `CommandDescriptor`, `SessionUiStatus`, `BlobRef`, `ApiError`), como borrador sin servidor aún.
  `Attachment.data` sigue siendo obligatorio: las subidas por hash viajan como `BlobRef` y el host
  las resuelve a `data` (fase 1).
- Persistencia v4 y catálogo de comandos (fase 1 de `alisio serve`): migración aditiva v4 de
  `SQLiteStore` (tablas `runs`, `workspaces` y `blobs`; columnas nulables en `sessions`, `events` y
  `tool_calls`; índice único parcial `(session, request_id)`); métodos opcionales de `SessionStore`
  (`beginRun`, `endRun`, `runByRequest`, `runs`, `messagesPage`, `eventsPage`, `interruptRuns`); el
  runner registra cada ejecución (también TUI y headless) y marca las llamadas a herramientas con
  `run_id`, nombre, efecto y tiempos; `createApplication` marca como `interrupted` las ejecuciones de
  procesos muertos al arrancar (junto a `interruptStale()`, que se invoca en el constructor de
  `ChildSessions`). `BlobStore` (`app.blobs`) guarda adjuntos por SHA-256 en
  `<state home>/blobs/sha256/<aa>/<hash>` y resuelve un `BlobRef` a un `Attachment` en base64
  verificado. `CommandCatalog` y `BUILTIN_COMMANDS` en `@alisio/core` describen los comandos de barra
  (integrados, plugins, plantillas, skills) con superficies y modo de ejecución; la TUI toma de ahí
  su lista y resolución y delega `/tools` y `/sessions`. La lógica pura del agente activo vive en
  `@alisio/core` (`agents/active.ts`); la CLI la reexporta.

### Herramientas, AGENTS.md y skills

- Herramientas locales: lectura, escritura/edición con hash, ripgrep (con mensaje de instalación
  por plataforma si `rg` falta, en las herramientas y en `alisio doctor`), procesos, shell y Git.
- AGENTS.md según la convención agents.md: global `<config>/AGENTS.md` (con `AGENTS.override.md`
  que lo reemplaza); recorrido desde la raíz hasta el cwd con un archivo por directorio
  (`AGENTS.override.md` > `AGENTS.md` > `AGENT.md` como alias heredado > `CLAUDE.md` solo con
  `context.claudeMdFallback`); orden raíz → cercano con cabecera "el más cercano gana; las
  instrucciones explícitas del usuario prevalecen"; archivos anidados adjuntados de forma
  perezosa una vez por sesión y archivo; límite total de 32 KiB conservando los más cercanos.
  `Agente.md` deja de leerse.
- Agent Skills: `.agents/skills`, `.alisio/skills` y `.claude/skills` desde el cwd hasta la raíz
  (solo proyectos de confianza), rutas configuradas, `~/.agents/skills` y `<config>/skills`, y
  plugins; el proyecto prevalece con aviso y ganador determinista; validación de nombres según la
  especificación (el desajuste con el directorio solo avisa); profundidad ≤ 5 y ≤ 2000
  directorios; catálogo progresivo, activación y recursos. Gestor TUI `/skills` con búsqueda,
  orden por nombre/origen/tokens aproximados, viewport acotado y navegación completa; metadatos
  seguros de origen/alcance/propietario, anulaciones de proyecto atómicas con efecto inmediato y
  skills de plugins bloqueadas por su ciclo de vida.
- Presupuesto de tokens proporcional: `limits.maxTokens` es opcional; por defecto 8 × ventana de
  contexto (entre 400k y 8M) o 1M si la ventana es desconocida.

### Subagentes

- Plugin integrado `subagents` (`@alisio/plugin-subagents`, desactivable): definiciones de agentes
  en Markdown + YAML con precedencia CLI > proyecto > `.agents/agents` (convención especulativa) >
  compatibilidad `.claude/agents` y `.opencode/agent(s)` > usuario > plugins > integrados
  (`general`, `explore`, `plan`); herramientas `task`, `task_status`, `task_wait` y
  `send_message`; sesiones hijas persistidas con padre, profundidad, estado y uso (migración 3);
  contexto nuevo por hijo; límites de profundidad (se retira `task`), concurrencia, cola acotada,
  turnos, tiempo y tokens; permisos solo restrictivos con aprobaciones que suben a la TUI con la
  ruta del agente; cancelación en cascada con SIGTERM y SIGKILL tras 5 s; hijos interrumpidos al
  reiniciar y reanudables con `task_id`; notificaciones de tareas en segundo plano; escrituras en
  paralelo en git con worktree por subagente (merge/discard), escritura serial o directorio
  compartido; panel de árbol de agentes con navegación por flechas y vistas de solo lectura.

### Plugins, extensiones y MCP

- Categorías de plugins: la unión `PluginCategory` del SDK se amplió a `memory`, `subagents`,
  `search`, `tools`, `security`, `analytics`, `mcp`, `storage` y `ui` (más `model-provider` y
  `methodology-harness`), validadas por esquema en el host. Los integrados `memory` y `subagents`
  declaran su categoría: `/plugins` los agrupa bajo encabezados propios en lugar de "General" y la
  vista de detalle los lista, sin cambios en la pantalla de inicio ni en el conteo de proveedores.
  La documentación de plugins (EN/ES) lista las categorías aceptadas con su significado.
- Puntos de extensión genéricos: `api.sessions`, `api.ui.panel/select/open/interactive`,
  `api.resources.agents/list`, `ToolDefinition.concurrent`, contexto de sesión en comandos.
- Plugins locales y manifiestos de directorio: herramientas, comandos, eventos, contexto,
  skills, estado y desregistro/cleanup.
- MCP oficial v2: stdio, Streamable HTTP, herramientas, recursos, prompts y cierre. Configuración
  global + proyecto de confianza (o global + `--config` explícito), combinación por nombre, forma
  canónica `mcp.servers` y alias compatible `mcpServers`; conexión diferida bajo `--allow-mcp` en
  usos no TUI o mediante consentimiento explícito válido solo para la sesión TUI actual; bloqueo
  absoluto con `--read-only`.
  Consentimiento global persistente `mcp.allow` (booleano en la configuración de usuario, solo capa
  global): al iniciar con permiso concedido (`--allow-mcp` o `mcp.allow:true`), los servidores
  `enabled` se auto-conectan como si se pulsara Conectar en cada uno, con fallos por servidor,
  saneados y no fatales al arranque (expuestos como `mcpStartupFailures` y avisos de la TUI/headless);
  el proyecto nunca puede concederse consentimiento (`mcp.allow` de capa seleccionada se ignora);
  `--read-only` prevalece y bloquea también concesión, recuerdo y revocación. En `/mcps`, el diálogo
  de consentimiento ofrece "Conceder solo para esta sesión" o "Conceder y recordar (global)"; la
  escritura global es atómica y conserva campos no relacionados; una acción "Revocar consentimiento
  MCP global" limpia `mcp.allow` y elimina el permiso de ejecución desconectando los servidores.
  Gestor TUI `/mcps` agrupado por origen real, con estados, detalles saneados, catálogo y anotaciones
  de herramientas; distingue activación configurada, permiso de ejecución, conexión y herramientas
  cargadas. La conexión/reconexión registra nombres semánticos seguros como
  `mcp_devforge_time_diff` para el siguiente turno, limpia al desconectar y persiste la activación de
  forma atómica en la forma y archivo que definieron el servidor. El modelo conserva la decisión de
  llamar una herramienta; el nombre semántico mejora, pero no garantiza, la selección automática.
- Herdr custom: reportes de lifecycle, sesión y herramientas de comunicación entre agentes.

### CLI, runtime y empaquetado

- CLI interactiva/headless, JSONL, reanudación, configuración y diagnósticos.
- Runtime Node-first: Node.js >=22.16 (mínimo verificado: 22.13–22.15 incluyen `node:sqlite`
  sin FTS5; 22.16.0 funciona) y compatible con Bun. Sin APIs `Bun.*`: `node:sqlite` (en ambos
  runtimes), `node:fs` y `node:child_process` detrás de la capa de runtime; el
  `ExperimentalWarning` de SQLite se filtra de forma específica sin ocultar otros avisos.
- Monorepo publicable: `@alisio/sdk` (contrato, sin dependencias), `@alisio/core` (núcleo
  embebible), `@alisio/plugin-memory`, `@alisio/plugin-openai-compatible`,
  `@alisio/plugin-subagents` y
  `alisio` (CLI/TUI, registro de plugins integrados). Los plugins dedicados de proveedores
  (DeepSeek, OpenCode Console/Go) se publican desde el monorepo alisio-plugins. Build con `tsc` a `dist/` (JS + `.d.ts`),
  `publishConfig.exports` sin fuentes, changesets para versionado y publicación con provenance.
  Nuevo `scripts/publish.ts` (`pnpm publish`): empaqueta y publica en orden dependiente seguro
  (sdk → core → plugins → cli), con `--all`/`--package <nombre>` obligatorios, `--version`
  (bump atómico), `--dry-run` (sin efectos), `--build`/`--no-build`, el mismo chequeo de fugas que
  `pack:check` sobre el manifiesto empaquetado, `==> nombre@versión` por paquete y detención
  clara ante fallos sin publicar en silencio el resto; documentado en [Publishing](/publishing).
- Plugins como paquetes npm (`--plugin nombre` o `plugins: ["nombre"]`), resueltos desde el
  proyecto y luego las raíces globales; exigen la keyword `alisio-plugin`.
- Instalador de plugins npm (`alisio install npm:<paquete>[@<versión>]` y herramienta del host
  `plugin_install` para el agente): validación de la especificación antes de cualquier red
  (charset seguro, sin `..`/rutas absolutas, prefijos desconocidos rechazados), instalación
  GLOBAL con `npm install --prefix <config home>/plugins` y persistencia del NOMBRE npm en el
  array `plugins` de `<config home>/config.json` (escritura atómica, campos no relacionados
  conservados, sin duplicados); idempotencia con `--update` para refrescar a `@latest`;
  confirmación previa de scripts de ciclo de vida en terminal interactiva, rechazo accionable en
  headless/`--json` sin `--yes` (o `--trust-plugin`) y rechazo absoluto con `--read-only`;
  salida de npm fallida saneada (sin tokens/secretos) con el comando de reintento exacto; la
  misma rutina compartida para CLI y herramienta, con runner inyectable para pruebas sin red
  (npm falso por shim de PATH o inyectado).`plugins list` muestra los paquetes instalados junto
  a los plugins de archivos/directorios, y la resolución de paquetes añade `<config home>/plugins`
  a las raíces globales (incluida su variante `node_modules/`).
- Binario autónomo opcional (`pnpm build:binary`, Bun) y workflow de release con binarios
  linux-x64/arm64, darwin-x64/arm64 y windows-x64, `SHA256SUMS` e instalador `scripts/install.sh`.

### Plantillas, pantalla de inicio y TUI

- Sitio de documentación bilingüe (VitePress, inglés y español) desplegado en GitHub Pages.
- Plantillas de prompts: Markdown con frontmatter YAML (`description`, `argument-hint`,
  `requires`), sintaxis `$ARGUMENTS` y `$1`..`$9`; fuentes con precedencia documentada
  (integradas < plugins vía `resources.prompts` < usuario `<config>/prompts` < proyecto
  `.alisio/prompts` solo si es de confianza) y diagnósticos (`prompt_override`,
  `prompt_conflict`, `prompt_invalid`, `prompt_shadowed`). Cada plantilla es un comando slash
  con descripción en `/help` y autocompletado; se envía como turno normal (streaming,
  herramientas, aprobaciones) y la conversación muestra `/nombre args` (persistido como
  `display`). Headless: `alisio run "/init ..."` con la misma sintaxis.
- `/init` integrado: analiza el repositorio y crea o actualiza `AGENTS.md` en el sitio
  (`edit_file` con `expectedHash`), solo con hechos verificados; exige escritura (rechazo claro
  con `--read-only`; aprobación en la TUI). El comando `alisio setup` (antes `alisio init`,
  renombrado para no confundirse con `/init`) sigue creando la configuración y sugiere `/init`.
- Registro genérico de puntos de extensión (`api.extensions.register`, campo declarativo
  `extensions`) con los puntos tipados `mascot` y `startup-screen`: resolución determinista
  (prioridad, id del plugin, orden de registro), diagnósticos `extension_conflict` en `/stats` y
  `plugins doctor`, desregistro al desactivar el plugin.
- Pantalla de inicio con mascota reemplazable: mascota original de Alisio (espíritu de nube del
  viento alisio) con variantes Unicode, ASCII y compacta; pantalla por defecto con secciones
  reutilizables, disposición lado a lado o apilada, consejos rotativos deterministas; fallback
  seguro ante proveedores que fallan, devuelven basura o tardan; salida saneada y recortada.
  Se muestra como primer bloque de la TUI y en stderr (si es TTY) en modo `--no-tui`; nunca en
  `run`, `--json`, `--quiet`, `--no-banner`, `CI` ni sin TTY. Ejemplo publicable en
  `examples/plugins/custom-mascot/`.
- TUI con `@earendil-works/pi-tui` 0.87.1 (pantalla alternativa, renderizado diferencial):
  cabecera con modelo/host/permisos, conversación con Markdown, bloques de herramientas con
  spinner, duración, vista previa y diff de ediciones, barra de contexto y tokens (ventana real
  del modelo cuando el catálogo la expone; `~9.9k / ?` honesto cuando no), comandos
  `/help /model /compact /stats /clear /sessions /resume /tools /exit` con autocompletado
  (incluido `/skills` con sugerencias del catálogo por nombre o descripción),
  interrupción con Esc y aprobación interactiva de `write`/`process`. `--no-tui` conserva
  el modo readline.
- Renderizado Markdown mejorado: títulos en cian brillante y negrita, tablas con columnas
  alineadas al ancho (un `transform` previo al parseo normaliza las filas separadoras con
  guiones em/en/de caja a `---` ASCII conservando los dos puntos de alineación, sin tocar
  bloques de código delimitados/sangrados ni `---` sueltos), y código en bloque sangrado
  (2 espacios) con resaltado de sintaxis por línea SIN dependencias para ts/tsx/js/jsx/json/
  bash/sh/python/yaml/css/html/md (palabras clave, cadenas —incluidas f-strings de Python y
  llaves de JSON—, comentarios de línea y de bloque con continuidad multilínea, números,
  llamadas a funciones, atributos/asignaciones y variables `$`; el tokenizador sanea ANSI y
  caracteres de control de la entrada, nunca los reemite, y con `NO_COLOR` devuelve líneas
  planas). Tono base gris para el cuerpo vía `defaultTextStyle`. Copiar respuestas: pista
  atenuada `⎘ copy · /copy` (`[copy] · /copy` en terminales sin Unicode) bajo cada respuesta
  completada (nunca durante el streaming), y atajo `c`/`y` con la entrada VACÍA que copia la
  última respuesta como texto crudo (misma ruta que `/copy`, mismo aviso `Copied (<herramienta>)`).
- Resultados enriquecidos de herramientas (MCP "Nivel 0"): el conector deja de aplanar
  `CallToolResult`/`ReadResourceResult` a `JSON.stringify`. El SDK amplía el contenido de
  `ToolResult` de forma aditiva —`{type:"text"} | {type:"image", mimeType, data} |
  {type:"ui", block: UiBlock}` con `textResult` intacto— donde `UiBlock` es unión discriminada
  propia de Alisio (tabla `{columns, rows}` con cabeceras como nombre alternativo y filas de
  objetos indexadas por columna, clave-valor de escalares planos, árbol `{nodes: {label,
  children?, meta?}}`, código y markdown); los tipos MCP nunca se filtran al SDK, el mapeo vive
  en el adaptador de core (`packages/core/src/mcp/rich.ts`). Heurística conservadora: solo las
  formas verificadas de `structuredContent` o de partes de texto parseables como JSON se pliegan
  a bloques; el resto conserva literalmente el comportamiento anterior (incluido
  `JSON.stringify` para resultados sin contenido reconocible). SIEMPRE se añade la proyección de
  texto canónica de cada bloque/imagen (parte de texto adicional; render compacto de tablas como
  markdown, `clave: valor`, árboles con `├─/└─`, código cercado) y marcadores `[image: mime (N
  bytes)]` en lugar de bytes base64: el modelo, la compactación (`clampMessage`/`reduceMessagesToBudget`
  recortan SOLO partes de texto; `serializeForSummary` resume solo la proyección), los proveedores
  (el runner aplica `textProjection` antes de `provider.stream`) y todas las rutas headless
  (`run`, `resume <id> "prompt"`, `--json`, `--no-tui`, `TERM=dumb`, `NO_COLOR`) siguen viendo
  texto únicamente. El store persiste las partes ricas con `endCall`/`append` (JSON completo, sin
  migración) y el TUI las recupera con `SessionStore.callResult` solo para sus eventos
  (`tool_completed` sigue emitiendo `preview` de texto; JSONL sin cambios). TUI: `TranscriptItem`
  de herramienta con `ui?`/`image?`; `ToolBlock` renderiza tablas alineadas con celdas que se
  ajustan al ancho, clave-valor en dos columnas, árboles con `├─/└─/│` (ASCII `|-/`- /|` sin
  Unicode), bloques de código con el mismo `highlightCode`, markdown con el renderizador habitual,
  e imágenes en línea vía el componente `Image` de pi-tui 0.87.1 (detección `getCapabilities`),
  con marcador atenuado `[image: mime WxH]` si no hay soporte o hay `NO_COLOR`; `itemsFromHistory`
  reproduce los bloques al reanudar. Documentado en `docs/tools.md`, `docs/es/tools.md`,
  `docs/tui.md` y `docs/es/tui.md`.
- Presentación de herramientas y razonamiento en la TUI (estilo Claude Code/OpenCode): nombres
  legibles (`read_file` → `Read File`, `mcp_*` → `MCP · …`, acronyms como HTTP/API en
  mayúsculas); razonamiento terminado plegado a `+ Thought · 2.9s` (expandible, acotado a 40
  líneas; la duración aproxima el intervalo de pensamiento desde las marcas de tiempo de los
  deltas); lotes de llamadas consecutivas del mismo tipo agrupados en una fila al terminar
  (`✓ Read File — 3 reads · 60ms`, verbo de tipo para lotes mixtos, `✗` si falló alguna; las
  llamadas en ejecución/esperando aprobación siguen siendo filas individuales con su spinner);
  salida de comando larga plegada con `… N more lines` y línea final `Command exited with code
  0.`/`code 1.` derivada con seguridad del JSON de vista previa (run_process/shell/search_text,
  tolerando el sufijo `<instructions>` de las lecturas); alternar con `x` en la entrada vacía o
  clic en la fila de cabecera (el clic sintetizado por pi-tui no rompe copiar-al-seleccionar).
  Modelo puro en `state.ts` (`humanizeToolName`, `toolKindOf`, `groupToolEntries`, `FoldCandidate`
  y `exitCodeOf`) sin imports de terminal; componentes con caché de líneas por
  versión/ancho/plegado (los frames de reloj no re-renderizan filas sin cambios), sincronización
  por claves estables con reutilización de componentes y orden preservado; el `tool_started` del
  runner lleva el `effect` del registro (aditivo) para agrupar por capacidad real en vivo.
  Documentado en `docs/tui.md` y `docs/es/tui.md`.
- Comando `/settings` (`/prefs`): menú de ajustes estilo OpenCode — filas de dos columnas
  (preferencia + valor actual), filtro escribiendo (nombre/clave/categoría/descripción), contador
  `(n/total)` y pie con la descripción de la fila resaltada; Enter/Espacio cambia el valor, Esc
  sale. Dieciséis ajustes REALES y conectados, persistidos de forma atómica en la configuración global
  de usuario (`setConfigValue`, puerta de entrada acotada a un conjunto de claves validado con el
  propio esquema) y aplicados en caliente: `compaction.auto/threshold/keepTurns/maxOutputTokens` y
  `limits.maxTurns/maxOutputTokens/maxContextChars/timeoutMs` (vía `AgentRunner.applySettings`,
  surten efecto en la siguiente ejecución; `limits.timeoutMs` se muestra en segundos y se persiste
  en milisegundos), `context.claudeMdFallback/maxBytes` (vía `ProjectContext.update`, siguiente
  turno), `websearch.provider` (enum, muta el objeto compartido que la cadena de búsqueda lee en
  cada llamada; `native` requiere un proveedor que lo soporte), `pluginHooks.timeoutMs` (vía
  `PluginHost.applyTimeoutSettings`, siguiente hook), `tui.paddingX` (padding del editor, inmediato),
  `tui.contentPaddingX` (inset horizontal de cada lado del contenido del transcript, inmediato;
  acotado en terminales estrechas para no colapsar la columna de contenido),
  `tui.skillSlashCommands` (alterna las entradas `skill:<id>` del autocompletado, inmediato) y el
  consentimiento `mcp.allow` por el camino
  `rememberGlobalMcpConsent`/`revokeGlobalMcpConsent`. Bajo
  `--read-only` todo se muestra en solo lectura. Las filas inferiores navegan a
  `/model`, `/connect`, compactación, `/plugins`, `/skills`, `/mcps` y `/stats`; las puntuales
  (compactar, estadísticas) avisan y reabren la lista. La lista es HONESTA: no se ofrecen ajustes
  inexistentes (telemetría, Mermaid, modo dirección, doble Esc, transporte automático, idle HTTP,
  tema, niveles de aviso, confianza persistida, ventana de contexto global...) — ver docs/tui.md.
  `/settings` se bloquea mientras un turno está en curso, igual que los gestores a los que da acceso.
- Skills en el autocompletado de comandos: cada skill efectiva del catálogo aparece como entrada de
  primer nivel `skill:<id>` (marcador de ámbito `[u]`/`[p]`/`[c]`/`[l]`, pista de estado
  deshabilitada/bloqueada/sombreada y descripción recortada, como en `/skills`), de modo que
  `/ski…` o el propio nombre de la skill las muestran y elegir una inserta `skill:<id>`. El enrutado
  `/skill:<id>` existente no cambia, ni el completado de argumentos de `/skills` ni `/resume`.
  El ajuste `tui.skillSlashCommands` (por defecto `true`) oculta SOLO esas entradas `skill:<id>`
  cuando está desactivado: el gestor `/skills` y su autocompletado de argumentos siguen disponibles,
  y el proveedor del editor se reconstruye al guardar, sin reinicio.
- Dependencia con parche (`patchedDependencies` en `pnpm-workspace.yaml`, `patches/`): pi-tui 0.87.1
  filtraba los nombres `skill:*` quitando el prefijo al emparejar (diseñado para `/branch…`), lo que
  hacía imposible que `/ski…` mostrara `skill:branch-pr`; el parche empareja el nombre completo.
  Cualquier comando que reconstruya `node_modules` (instalación limpia/CI) aplica el parche solo si
  `pnpm install` corre con `patchedDependencies` presente.
- Versión en tiempo de ejecución por paquete: metadatos de plugins, `user-agent` por defecto y el
  cliente MCP leen la versión de su propio `package.json` (con la inyección
  `ALISIO_PACKAGE_VERSION` para binarios autónomos y `dev` como último recurso); la cabecera de la
  TUI muestra **Alisio Code** y, junto con el banner y `--version`, resuelve la versión del CLI
  caminando hacia arriba hasta el `package.json` de `@alisio/alisio-code` (límite de 8 niveles),
  sin literales que puedan desincronizarse de la publicación.

### Compactación, plugins y memoria

- Compactación de contexto en el núcleo (manual y automática por umbral), con resumen del
  proveedor actual, emparejamiento de llamadas/resultados preservado y persistencia
  transaccional (migración 2: columna `messages.compacted`).
- Plugins: puntos de extensión aditivos en `PluginAPI` (apiVersion 1): hooks de
  compactación (`beforeCompact` con campos JSON extra en la misma llamada, `afterCompact` con
  inyección de contexto e informe), `session.onStart/onEnd`, `model.complete` agnóstico del
  proveedor, `ui.status` y metadatos de comandos. El host aplica timeouts y aísla fallos.
  Registro de plugins integrados (`packages/cli/src/builtin.ts`) con ruta de confianza, nombres sin
  prefijo y efecto `internal`; desactivables por configuración o `--disable-plugin`.
- Gestor TUI `/plugins`: catálogo filtrable de plugins integrados y externos con nombre,
  descripción, categoría/origen seguro y estados activo, inactivo, fallido o reinicio necesario.
  El estado de reinicio desaparece al volver al estado original del runtime; no permite desactivar
  proveedores retenidos por ninguna sesión enrutada viva.
  Persiste anulaciones en `.alisio/config.json` con escritura atómica y conserva campos no
  relacionados. Los cambios se aplican tras reiniciar (no hay descarga parcial en caliente); los
  externos requieren confianza y confirmación explícita. Protege el proveedor de modelo activo y
  los recursos de sesión vivos.
- Plugin integrado `memory` con persistencia local: SQLite + FTS5 trigram, BM25 con recencia y
  accesos, upsert por `topic_key`, deduplicación con ventana de 15 minutos, borrado lógico,
  redacción de `<private>`, fijadas, línea temporal, prompts recientes, resúmenes de sesión;
  siete herramientas `memory_*`, protocolo en el prompt, inyección presupuestada al iniciar
  sesión, extracción de memorias y archivo del checkpoint en la compactación, resumen al
  cerrar la TUI y comando `/memory`. El núcleo no contiene referencias a memoria.
- TUI: copiar al seleccionar (ratón capturado) con adaptador de portapapeles aislado y
  respaldo OSC 52 declarado como no verificable; `/copy`; comandos de plugins enrutados
  genéricamente; estado de plugins en la barra y en `/stats`.
- Pegado de texto e imágenes en la TUI: el pegado de texto (incluido multilínea) ya llega como
  una única edición atómica gracias al propio componente del editor (pegado con corchetes), sin
  fragmentarse ni enviar antes de tiempo; los pegados largos colapsan en un marcador
  `[paste #N ...]`. `Ctrl+V` adjunta la imagen del portapapeles del sistema (PNG/JPEG/GIF/WebP,
  detección por cabecera; sin reimplementar el sniffing ni las secuencias Kitty/iTerm2, se
  reutilizan las de pi-tui) y `Ctrl+R` quita la última adjuntada; se muestran sobre el editor
  como miniatura en línea cuando la terminal es capaz, o como una línea compacta
  (`[N] image/png WxH, X.X KB`) en caso contrario. Límite de 5 MB por imagen y 4 adjuntos por
  mensaje, aplicado en la TUI (no en `@alisio/core`). Se envían como partes de contenido de
  visión compatibles con OpenAI (`image_url` en chat, `input_image` en Responses) junto al SDK
  `openai`; no hay comprobación previa de si el modelo admite visión — se intenta siempre y un
  rechazo del proveedor se muestra como un error en línea normal. Los adjuntos se persisten con
  el mensaje (`Message.attachments` en `@alisio/sdk`); la compactación describe una imagen
  resumida solo por tipo MIME y dimensiones, nunca reenvía ni conserva sus bytes en el
  checkpoint.

### Modelo y enrutamiento por sesión

- Cambio de modelo por sesión (`AgentRunner.setModel`, `sessions.model`); el proveedor acepta
  un modelo por petición. `/model` y `/models` comparten un selector global que agrega solo perfiles
  creados con `/connect`, identifica la propiedad proveedor/modelo, marca la pareja activa, aísla
  fallos de catálogo por perfil y persiste un cambio en una sesión nueva. La configuración heredada
  queda fuera del selector. Catálogo `GET /models` con ventana de contexto y metadatos estructurados
  cuando el proveedor los informa, tokens en caché (`prompt_tokens_details.cached_tokens` o
  `prompt_cache_hit_tokens`) y razonamiento visible (`reasoning_content`/`reasoning_text`) solo para
  mostrar.
- Enrutamiento explícito proveedor/modelo por sesión: API programática sin credenciales para listar,
  resolver y crear/cambiar sesiones; sintaxis canónica `proveedor/modelo` e IDs desnudos solo si son
  únicos. Las definiciones de agentes y `task.model` usan el mismo resolvedor. Padre e hijos pueden
  ejecutar proveedores configurados distintos en paralelo sin mutar el valor global por defecto;
  cada sesión conserva proveedor, modelo, continuación opaca e ID OpenCode propios. Los destinos
  ausentes, ambiguos o con catálogo no disponible fallan antes de inferencia con orientación segura.
- Lockfile y versiones fijadas; Biome, TypeScript, Vitest y CI Linux con Node 22.16, 22.x y 24.

### Agente activo y effort de razonamiento

- Sistema de agente ACTIVO de la sesión principal: integrados `build` (por defecto, sin persona
  añadida: comportamiento idéntico al actual) y `plan` (planificador de solo lectura que inyecta su
  prompt de sistema y limita la ejecución a lecturas vía `RunOptions.policy`/`approvals`), más las
  definiciones principal-capaces publicadas por el plugin de subagentes (`mode: primary|all`,
  incluidas las de `--agents <json>`). El prompt de sistema del agente se anexa por ejecución en el
  runner (`RunOptions.instructions`, el mismo seam que la persona base), y el cambio de agente se
  aplica desde el siguiente prompt, sin reiniciar la sesión.
- Comando de TUI `/agents`: selector navegable con nombre, descripción y marcadores de
  actual/por defecto/solo lectura; elegir persiste `agents.active` (escritor atómico de la capa de
  usuario) y cambia el modelo de la sesión por el enrutamiento existente de proveedores cuando el
  agente declara `model` (sesión nueva, como `/model`). Los verbos de gestión de tareas de
  subagentes (`list/open/cancel/kill/resume/merge/discard/defs`) siguen enrutándose al plugin de
  subagentes cuando `/agents` recibe argumentos. El mismo agente activo se aplica en los modos
  `run`, `resume` y `--no-tui` (prompt y acotación de solo lectura; el effort es solo de la TUI).
- Effort de razonamiento: `ModelInfo.effort` (niveles y `defaultLevel`) ya descubierto por el
  proveedor DeepSeek; contrato aditivo `reasoningEffort` en `CompletionRequest` y en la petición de
  `ModelProvider.stream`, que el runner propaga por `RunnerOptions`/`RunOptions` y DeepSeek envía
  como `reasoning_effort` (Chat Completions) o `reasoning.effort` (Responses); los demás
  proveedores lo ignoran. Comando `/effort [nivel]`: sin argumento, selector sobre
  `supportedLevels` con el `defaultLevel` marcado (y una entrada para limpiar el valor guardado);
  con argumento, valida y persiste `agents.effort`. El nivel efectivo se resuelve contra el modelo
  ACTIVO: si el guardado no lo soporta el modelo nuevo, se usa el `defaultLevel` con un aviso único
  (un solo fallo de catálogo degrada a "sin effort" con honestidad).
- Barra de estado bajo el editor y cabecera: `agente · modelo · proveedor · effort` con tres
  colores distintos (modelo cian negrita, proveedor magenta, effort amarillo); el segmento de
  effort solo aparece cuando el modelo activo anuncia `supportedLevels`; en terminales estrechos se
  descartan primero las piezas de menor prioridad. Lógica de diseño pura y probada
  (`identityParts`/`fitIdentityParts`).

### Agentes del usuario (ventana Agentes y `/agents`)

- Almacenamiento portable y compartido con otras herramientas: un archivo Markdown por agente con
  frontmatter YAML, en dos ámbitos: proyecto `<workspace>/.agents/agents/<id>.md` y global
  `~/.agents/agents/<id>.md` (`os.homedir()`). El frontmatter sigue la convención de subagentes
  de Claude Code/OpenCode (`name` = id en minúsculas con guiones, `description`, `model`, `tools`
  opcional, `mode: all` al crear); el cuerpo son las instrucciones (prompt de sistema). Los
  ajustes propios de Alisio viven bajo una sola clave `alisio:` que las demás herramientas ignoran
  (`displayName`, `reasoning.effort`, `reasoning.summary`, `text.format.type`, `text.verbosity`,
  `createdAt`, `updatedAt`). La edición usa el modelo de documento de `yaml`: claves desconocidas y
  comentarios escritos por otra herramienta se conservan; solo se tocan las claves de Alisio. La
  escritura es atómica (archivo temporal + `rename`). Servicio compartido en el núcleo:
  `AgentDefinitionService` (`app.agentDefinitions`), usado por el servidor web y la TUI.
- Almacenamiento previo de Alisio: se LEEN ambos, sin migración. El descubrimiento del plugin de
  subagentes sigue leyendo `.alisio/agents`, `<config>/agents`, `.claude/agents`,
  `.opencode/agent(s)` y los demás orígenes de siempre, y ahora también `~/.agents/agents` (orden:
  proyecto `.alisio/agents` > proyecto `.agents/agents` > compatibles > `<config>/agents` >
  `~/.agents/agents` > `~/.claude/agents`…). El gestor de agentes solo ESCRIBE y lista los dos
  ámbitos `.agents/agents`.
- Listado: une los dos ámbitos con insignia Proyecto/Global; si el mismo id existe en ambos, el de
  proyecto prevalece y se marca "Reemplaza al global" (y el global "Reemplazado por el de
  proyecto"). Al crear se elige el ámbito: Proyecto por defecto con un workspace abierto; Global
  sin workspace. Mover un agente entre ámbitos no está implementado.
- Recarga en caliente: tras crear, editar o borrar, el servicio pide al registro de agentes del
  plugin de subagentes que vuelva a descubrir los archivos (verbo `/agents reload`, también
  disponible a mano), y comprueba que la ruta guardada esté cargada (estado `definitions` del
  plugin). La respuesta lleva `live`: `true` solo si el proceso en ejecución ya la usa. En el
  servidor web se recarga cada workspace abierto y se emite `catalog_changed` (`agents`) para que
  los clientes refresquen. Sin el plugin de subagentes, con un workspace no confiable (proyecto) o
  si otro origen de mayor prioridad tapa el archivo, `live` es `false` y la web muestra "Agente
  guardado. Reinicia Alisio para usarlo." (la TUI imprime el aviso equivalente). No hay vigilante
  de archivos: los cambios hechos fuera de Alisio se recogen al abrir la lista de agentes (web y
  `/agents` en la TUI) o con `/agents reload`.
- Confianza desde la web: un workspace no confiable guarda los agentes de proyecto pero no los
  carga; el editor y el menú ⋯ del workspace ofrecen "Confiar en este workspace…" (ver Servidor
  web). Si el workspace se confió antes de tener recursos de proyecto, al guardar su primer agente
  de proyecto se reabre la aplicación y el agente queda cargado (`live: true`); si no, el workspace
  pasa a mostrarse como no confiable en la barra lateral.
- Plantillas compartidas en el núcleo (`AGENT_TEMPLATES`, servidas por `GET /api/agents/templates`
  y usadas por la TUI): Code Reviewer, Test Writer, Refactoring Assistant, Documentation Writer,
  Security Auditor, Bug Triage & Debugger, Migration Assistant, Research Agent, Customer Support
  Agent, DevOps Assistant, Meeting Assistant y Analytics Agent (sin duplicados), cada una con
  instrucciones y ajustes por defecto.
- Creación asistida: una llamada sin herramientas del modelo ACTIVO (`app.provider`, vía
  `completeText`) escribe o refina nombre, descripción, instrucciones y ajustes sugeridos. Guía de
  autoría: si existe una skill descubierta llamada `create-agent` (o `agent-creator`) se usa su
  cuerpo; si no, la skill incluida `bundled:create-agent` (`packages/core/src/agents/create-agent-skill.ts`:
  rol, objetivo, alcance, uso de herramientas, restricciones, formato de salida, ejemplos). En el
  repositorio no había ninguna skill de ese tipo (solo `alisio-publish`), así que se usa la
  incluida. La respuesta indica `guidance` y `generatedBy`.
- Capacidades: derivadas solo de los metadatos del catálogo (`ModelInfo.effort.supportedLevels`,
  `inputModalities`/`modalities`, `capabilities` con claves como `reasoning`, `tools`,
  `structured_outputs`, `verbosity`). Un `false` explícito oculta/deshabilita la opción. Si el
  proveedor no declara nada (caso habitual del `GET /models` OpenAI-compatible), se ofrece todo de
  forma permisiva (`known: false`, la UI lo indica). Al cambiar de modelo los ajustes no
  soportados se eliminan o se sustituyen (`fitAgentSettings`).
- Web: entrada "Agentes" justo encima de "Ajustes" en la barra lateral (y su icono en la barra
  contraída). Reutiliza el armazón del modal de Ajustes. Lista "Tus agentes" + "Plantillas";
  editor con migas `Agentes › Nuevo agente/<nombre>`, pestañas Configuración/Sesiones, dos
  columnas (una en pantallas estrechas): definición (nombre, descripción, instrucciones, ámbito),
  modelo (lista real de `GET /api/agents/models` con etiquetas de capacidad), formato de texto,
  esfuerzo, verbosidad y resumen según capacidades; botón "Guardar" activo solo con nombre
  válido, modelo y cambios sin guardar. Columna derecha: petición `curl` a la API propia de
  Alisio (`POST /api/agents`, `PUT /api/agents/:id`) con números de línea, resaltado y copiar, y
  los pasos de inicio marcados con estado real (definición guardada, workspace, sesión con el
  agente, sesión con título = hubo un mensaje); se descartan con × (guardado en `localStorage`
  con try/catch). "Crear con Alisio" muestra el diálogo "Construyendo con Alisio" (progreso
  indeterminado, tiempo transcurrido, Cancelar que aborta la petición y la llamada al modelo); un
  error se muestra sin tocar el formulario. Un agente nuevo generado se guarda y se ofrece
  "Probarlo en un chat nuevo" (por defecto) o "Seguir en el editor". Pestaña Sesiones: sesiones
  con ese agente (`GET /api/sessions?agent=<id>`) y botón para iniciar una.
- Comandos y cambio de agente: cada agente cargado (integrados, proyecto, global) es el comando
  `/agent:<id>`; el espacio de nombres `agent:` evita colisiones con comandos integrados, de
  plugins, plantillas y `skill:<id>` (si una fuente de mayor prioridad ya tiene ese nombre exacto,
  el comando del agente se omite). En la web, `/agents` sin argumentos abre un selector con
  búsqueda (subcadena en id, nombre y descripción), insignia Proyecto/Global/Integrado, el actual
  marcado y `build` como vuelta al agente predeterminado; la insignia del agente en la cabecera
  abre el mismo selector. La activación guarda el agente en la sesión y se aplica desde el
  SIGUIENTE mensaje (nunca a mitad de una ejecución): instrucciones, modo de solo lectura y
  esfuerzo por defecto. El modelo del agente se aplica en la misma sesión solo si pertenece al
  proveedor de la sesión; si no, el chat conserva su modelo y lo dice ("inicia un chat nuevo con
  el agente"). Precedencia del esfuerzo: el de la sesión (web) o `/effort` (TUI) gana; si no, el
  del agente.
- TUI: `/agents` abre el selector (filtro por subcadena en nombre y descripción, insignias,
  actual, predeterminado) con las acciones "+ Crear agente…" y "✎ Gestionar…"; `/agents new
  [descripción]` (con descripción: creación asistida directa), `/agents templates`,
  `/agents manage`, `/agents edit|delete <id> [project|global]`; el resto de verbos (`list`,
  `defs`, `reload`, `open`, `cancel`…) siguen yendo al plugin de subagentes. El editor es una
  lista de campos (ámbito al crear, nombre, descripción, instrucciones —una línea, `\n` para saltos—,
  modelo de la lista configurada, esfuerzo/resumen/verbosidad/formato según capacidades,
  "✦ Refinar con Alisio", guardar, cerrar). "Construyendo con Alisio" se muestra en la línea de
  pistas y Esc lo cancela. Tras crear: "▶ Probarlo en una sesión nueva" (por defecto) o seguir en
  el editor. `/agent:<id>` activa un agente (como el selector, a nivel global `agents.active`).

### Preguntar al usuario (ask_user_question)

- Herramienta `ask_user_question` (núcleo, no un plugin) y comando `/ask`: el modelo —o un
  subagente hijo, ya que la condición es que exista alguna UI interactiva enlazada, nunca cuál
  sesión pregunta— puede hacer de 1 a 4 preguntas de opción múltiple (2-4 opciones, como mucho una
  `recommended`); falla rápido con un error estructurado en modo headless en vez de bloquear.
  Contrato SDK aditivo: `Question`/`QuestionOption`/`AskQuestionsRequest`/`AskQuestionsResult` y
  `ui.askQuestions`, con `ToolContext.label` nuevo para atribuir la llamada a la sesión hija que
  pregunta (igual que `ApprovalRequest.label`). Panel de la TUI por pasos (una pregunta a la vez,
  para legibilidad en terminales estrechas), con navegación ↑↓ (con vuelta, igual que
  `SelectList`), alternar con →/Espacio en preguntas de selección múltiple, Enter confirma y
  avanza, ←/Retroceso corrige una respuesta anterior y Esc omite **solo la pregunta actual**
  (decisión documentada: el comportamiento exacto de Claude Code no se pudo verificar de forma
  independiente, así que se eligió el menos sorprendente). Resumen final compacto en la
  conversación con etiquetas truncadas con `…`. Una única cola interactiva (`InteractiveQueue`,
  FIFO, sin prioridad de la raíz sobre los subagentes) serializa aprobaciones, el `select` de
  `/model` y `ask_user_question`, de modo que nunca hay más de un aviso en pantalla aunque
  pregunten varios subagentes a la vez; una pregunta retirada (sesión cancelada mientras estaba en
  cola o en pantalla) se descarta con un aviso, sin dejar un panel obsoleto. El panel de árbol de
  agentes gana un estado de presentación **esperando** (distinto de en ejecución) para las sesiones
  bloqueadas en una pregunta o una aprobación.

### Herramientas de red y CLI

- Herramientas de red (núcleo, no plugins): `webfetch(url, format?, timeout?)` lee una URL como
  `markdown`/`text`/`html` (conversión con `turndown` + `@mixmark-io/domino`, sin navegador ni
  jsdom), rechaza contenido no textual, limita a 5 MiB y trunca el texto embebido a 20 000
  caracteres conservando el texto completo en `.alisio/cache/webfetch/<hash>.<ext>` (legible con
  `read_file`). `websearch(query)` resuelve un proveedor en orden: una extensión `websearch`
  registrada por un plugin (nuevo punto de extensión, mismo mecanismo que `mascot`/`startup-screen`,
  con reintento seguro y diagnóstico ante un proveedor que falla) → `websearch.provider` configurado
  (`searxng`, `duckduckgo-instant`, `duckduckgo-html`, `tavily`, `brave`, `serpapi`, `native`) → una
  instancia pública de SearXNG por defecto. `duckduckgo-html` implementa la búsqueda web real sin
  clave como un raspado tolerante del endpoint `https://lite.duckduckgo.com/lite/` (solo confía en
  anclas `result-link` cuyo `href` pasa por el redireccionador `//duckduckgo.com/l/?uddg=`, decodifica
  la URL destino y las entidades HTML, y toma el fragmento de la celda `result-snippet` siguiente).
  Modo `native`: añade la herramienta nativa del proveedor
  (`websearch.nativeToolType`, por defecto `web_search`) a la petición de la Responses API en vez de
  implementar la llamada HTTP propia; exige `provider.apiMode: "responses"` y no registra la
  herramienta `websearch`. `execute(code)` ("Code Mode") ejecuta un fragmento JS en el módulo `vm`
  de Node que solo puede invocar otras herramientas ya registradas vía `callTool`, respetando su
  propio efecto/permiso (sin poder disparar una aprobación nueva), acotado a 10 s y 20 llamadas
  anidadas, sin poder llamarse a sí mismo. Nuevo efecto `external` reutilizado para `webfetch`/
  `websearch` (antes solo cubría MCP/Herdr/plugins) con su propio flag `--allow-external` y
  aprobación interactiva en la TUI igual que `write`/`process`; `execute` reutiliza el efecto
  `process` existente. Se decidió deliberadamente **no** implementar una herramienta de navegador
  (browser): el usuario descartó esa pieza por ahora al no tener un navegador adjunto como el de
  opencode desktop.
- Comando `alisio setup` (renombrado desde `alisio init`, sin alias): sigue escribiendo el mismo
  `.alisio/config.json` de ejemplo; `alisio init` ahora se comporta como cualquier subcomando
  desconocido (comportamiento propio de commander, sin trato especial).

### Confianza de proyecto y diagnóstico

- Confianza de proyecto por directorio, de una sola vez: al iniciar la TUI (nunca en modo headless
  `run`/`resume "prompt"`/`--json`, que siguen exigiendo `--trust-project`/`--config` explícitos
  porque ahí no hay nadie a quien preguntar) en un directorio con recursos de proyecto
  (`.alisio/config.json`, `.alisio/plugins`, `.alisio/agents`, `.agents/agents`, `.alisio/skills` o
  `.alisio/prompts`) y sin `--trust-project`/`--config`, se pregunta una vez con una explicación
  clara de lo que implica confiar (puede redirigir el endpoint/clave del proveedor y carga
  plugins/agentes/skills). La decisión se guarda en `<ALISIO_STATE_HOME>/trust.json` por ruta de
  workspace resuelta (`realpath`), junto con un hash SHA-256 del contenido de
  `.alisio/config.json`; un archivo modificado desde la última decisión vuelve a preguntar en vez de
  mantener la confianza en silencio. Un directorio sin ningún recurso de proyecto nunca recibe la
  pregunta. `--trust-project`/`--config` de una ejecución nunca se persisten como si fueran una
  concesión interactiva. Nuevos comandos `alisio trust list`/`alisio trust revoke <path>`.
- Verificación en código (no solo lectura) de que **write/process/external ya preguntaban por
  defecto en la TUI** antes de esta tarea (para write/process, desde una función previa; `external`
  se añadió en la propia tarea anterior de esta sesión): la TUI siempre pasa un manejador `approve`
  a `createApplication` salvo con `--read-only`, así que sin ningún flag el efecto ya se ofrece y
  pregunta en cada llamada — no estaba «simplemente no disponible» como se asumió al plantear esta
  tarea. Confirmado con una prueba de integración end-to-end
  (`permission-truth-table` en `fixtures/scenarios.ts`) que ejercita las tres combinaciones
  (preguntar / permitir sin preguntar / denegar sin ofrecer) para los tres efectos, y con una
  verificación real en pseudo-terminal (ver más abajo) que muestra el selector «Allow write_file
  (write): x.txt?» sin ningún flag. El trabajo funcional nuevo de esta tarea para permisos es,
  por tanto, únicamente la confianza de proyecto y el aviso de modelo sin configurar; el
  comportamiento de aprobación en sí no cambió.
- `alisio doctor` y la pantalla de inicio avisan explícitamente cuando el modelo resuelto está
  vacío o es el marcador `YOUR_MODEL_ID` que escribe `alisio setup`, en vez de dejar que el primer
  turno real falle contra un modelo inexistente.

### Servidor web (`alisio serve`)

- Paquete nuevo `@alisio/server` (solo `node:http`, sin dependencias de runtime nuevas, sin
  WebSocket), cargado por `alisio serve` con `import()` dinámico: `alisio`, `alisio run` y la TUI no
  lo cargan (comprobado por traza de resolución de módulos).
- Seguridad local: enlace a `127.0.0.1` por defecto (`--allow-remote` obligatorio para otra
  dirección), token de arranque de 256 bits por proceso canjeado una vez por una cookie
  `HttpOnly; SameSite=Strict` con nombre por puerto (`alisio_session_<port>`) y otro secreto,
  comprobación de `Host` y `Origin`, `Content-Type: application/json` en peticiones con efecto,
  cabeceras de seguridad y CSP que incluye el hash de los scripts en línea del build web.
  `/api/health` (sin autenticación), `/api/ready`, `/api/metrics`; logs JSON por línea en stderr
  (`ALISIO_LOG_LEVEL`).
- `WorkspaceHost`: una `Application` por workspace (raíz git del `realpath`), creada al usarse,
  desalojo LRU al llegar a `--max-workspaces`, `503 workspace_limit` si todos están ocupados, cierre
  tras 10 minutos de inactividad y confianza leída del almacén de confianza de la terminal. La web también
  puede concederla o retirarla (`POST /api/workspaces/:wid/trust` con `confirmed: true`, desde el
  menú ⋯ del workspace o el editor de Agentes, tras una confirmación que explica lo que se
  desbloquea): guarda la misma decisión que la pregunta de la terminal (`trust.json`, ligada al hash
  de `.alisio/config.json`) y reabre la aplicación del workspace; se rechaza con ejecuciones activas
  (`409 runs_active`), con `--read-only` y con `--trust-project`/`--config`. Un workspace conocido cuya carpeta ya no existe (o no es accesible) responde
  `404 workspace_missing` al abrirse (crear sesión, prompts, archivos) en lugar de un 500, y
  `GET /api/workspaces` lo marca con `exists: false`; la web lo atenúa y desactiva sus sesiones
  nuevas. Verificado con tests de `WorkspaceHost` y de rutas; no se vigila el disco en vivo (el
  estado se refresca al recargar la lista o al fallar una apertura).
- Workspaces archivados (migración v5 aditiva: `workspaces.archived_at` nullable).
  `PATCH /api/workspaces/:wid {archived}` inserta la fila si el workspace solo se conocía por sus
  sesiones (también si su carpeta ya no existe), cierra la aplicación inactiva y responde
  `409 runs_active` con ejecuciones activas; `GET /api/workspaces` los oculta salvo con
  `?archived=true|all` (misma semántica que `GET /api/sessions`); `POST /api/sessions` responde
  `409 workspace_archived`; `POST /api/workspaces` con la misma carpeta lo desarchiva. Las sesiones
  no se tocan y siguen legibles. La web tiene un menú de acciones por workspace (Fijar, Archivar /
  Desarchivar) y **Mostrar archivados** también muestra los workspaces archivados, al final.
- "Abrir un workspace" con diálogo nativo: `POST /api/workspaces/pick` abre en el escritorio del
  servidor zenity/kdialog/yad (Linux/BSD, con `DISPLAY` o `WAYLAND_DISPLAY`), `osascript
  choose folder` (macOS) o PowerShell `-STA` con `FolderBrowserDialog` y, como alternativa,
  `Shell.Application.BrowseForFolder` (Windows), con `execFile` sin shell y argumentos fijos (título
  y carpeta inicial validada como argumentos o variables de entorno). Un diálogo a la vez
  (`409 picker_busy`), 5 minutos de límite (cuenta como cancelado), cancelación por código de salida
  1/5/252, `-128` de osascript o salida vacía de PowerShell. `capabilities.nativePicker` y
  `capabilities.folderBrowser` en `/api/health`; `ALISIO_NATIVE_PICKER=0` lo desactiva. Alternativa
  garantizada en todos los sistemas: `GET /api/fs/dirs` (solo nombres de subdirectorios, migas de
  pan construidas por el servidor, unidades `A:\`–`Z:\` en la raíz de Windows, `404`/`403` en
  lugar de 500). Ambos solo con enlace loopback; con `--allow-remote` solo queda escribir la ruta.
- Barra lateral: el botón de archivados y la búsqueda recalculan la lista en cada render (antes un
  `useComputed` solo se actualizaba al cambiar la señal de la barra, no el estado local), y los
  menús de acciones de sesión y de workspace se posicionan respecto a la ventana para que el
  contenedor con scroll no los recorte. El explorador de carpetas muestra como máximo 2 000
  subcarpetas por directorio (aviso de truncado); para directorios mayores queda "Escribir una ruta".
- Control de parada del compositor rediseñado: cuadrado relleno con esquinas redondeadas y un arco
  de progreso que gira alrededor del botón mientras la ejecución está activa (estático con
  `prefers-reduced-motion`).
- Sesiones (crear, listar, leer, modificar; sin borrado: se archivan), mensajes, eventos y
  ejecuciones paginados; prompts idempotentes por `requestId` (índice único de `runs`), texto
  encolado durante una ejecución, `session_busy`, `session_locked`, cancelación y compactación
  manual. `RunScheduler` con semáforo global `--max-runs` y cola FIFO.
- Stream SSE multiplexado por pestaña con snapshot por sesión construido y registrado en el mismo
  tick, frames durables con `id` = `eventId`, deltas agrupados cada 33 ms, latido cada 15 s y cola
  acotada por cliente que termina el stream con `resync` si se desborda.
- `ApprovalBridge` e `InteractionBridge` con fallo cerrado (denegar/cancelar sin observadores tras
  30 s, al abortar o tras 10 min), primera respuesta gana, aprobaciones de sesiones hijas en su
  sesión raíz. Presets de permisos por sesión con techo en los flags de arranque; cada sesión recibe
  su propio objeto `RunOptions.policy`, así que "permitir para la sesión" no se filtra a otras
  sesiones del workspace.
- Apagado ordenado (`SIGINT`/`SIGTERM`: 503, runs cancelados, aprobaciones denegadas, streams
  cerrados, apps cerradas con los topes existentes; segundo `SIGINT` fuerza la salida) y
  reconciliación de runs al arrancar.
- Rutas de la fase 3 en `@alisio/server`: `GET /api/commands?session=|workspace=` (el
  `CommandCatalog` compartido filtrado a la superficie `web`) y `POST /api/sessions/:sid/commands`
  (`{requestId, name, args?}` → `CommandOutcome`: los comandos `core` se ejecutan en el servidor; las
  plantillas de prompt, las skills y `/ask` devuelven un prompt expandido que el cliente envía;
  `/help` lista los comandos web; `/effort` se guarda por sesión en vez de cambiar el ajuste
  global; `/model` y `/compact` responden `409 session_busy` durante una ejecución; `requestId`
  repetido → `{duplicate:true}`), `GET /api/sessions/:sid/models` (`SessionModels`: catálogo del
  proveedor de la sesión con niveles de esfuerzo, `unavailable` si no se puede listar),
  `GET /api/sessions/:sid/context` (`SessionContextUsage`: `runner.estimateContext` y
  `contextBudget`) y `GET /api/sessions/:sid/export` (JSONL: eventos durables en orden de
  `events.seq` y después una línea `{"type":"message"}` por mensaje, incluidos los compactados).
  Las ejecuciones web aplican ahora el agente de la sesión (`sessions.options.agent`, si no el
  agente activo de la app): instrucciones por ejecución y, si es de solo lectura, política sin
  efectos y sin aprobaciones. Las sesiones sin título muestran su primer prompt (una línea, 60
  caracteres), derivado al leer y nunca persistido.
- Preguntas laterales `/btw [pregunta]` (servicio `SideQuestions` del núcleo, expuesto como
  `app.sideQuestions` y en el `CommandCatalog` para tui, web y api): una llamada sin herramientas al
  modelo y proveedor de la sesión con su historial activo serializado como transcripción de texto
  (como la compactación; se descartan los mensajes más antiguos para caber en `maxContextChars` y en
  la ventana del modelo) más una instrucción de responder de forma concisa sin actuar. No escribe en
  `messages`, `tool_calls`, `runs`, `events` ni en el uso de la sesión y no toma el bloqueo de la
  sesión, así que funciona durante un run con su propio `AbortSignal`. El historial (20 por sesión)
  vive en `plugin_state` bajo `core:btw`, sin migración. TUI: panel en la ranura de selectores (nunca
  en la transcripción) con "Thinking…", Esc cancela/cierra, `←`/`→` recorren respuestas, `↑`/`↓`
  desplazan; modo readline: imprime la respuesta o `Usage: /btw <question>`. Servidor:
  `GET|POST /api/sessions/:sid/btw` y `POST .../btw/cancel` (también cancela al cerrarse la petición;
  código nuevo `409 cancelled`, fallos del proveedor `502 provider_unavailable`). Web: el compositor
  intercepta `/btw` y abre un panel flotante (chunk diferido) con estado pendiente y Cancelar,
  respuesta en Markdown, tokens, copiar y navegación `2/5`.
- Interfaz web `@alisio/web` (paquete privado; su build viaja dentro de `@alisio/server` en
  `dist/web`, copiado por `scripts/copy-web.mjs` tras `tsc`): Vite 8 + Preact 10 +
  `@preact/signals`, CSS Modules con tokens en custom properties, sin Tailwind ni librerías de
  componentes. Reductores puros (`store/transcript.ts`, `sessions.ts`, `pending.ts`,
  `composer.ts`), cliente SSE con lotes por `requestAnimationFrame`, backoff con jitter 0,5→10 s y
  reapertura tras `resync`; sidebar de workspaces y sesiones, cabecera con título editable, insignia
  de agente y preset y descarga del log; transcript con burbuja de usuario, filas compactas de
  herramientas y razonamiento, Markdown incremental con bloques congelados (tokens de `marked`
  renderizados como nodos Preact, sin `innerHTML`), código resaltado de forma diferida con shiki
  (motor JavaScript, 14 gramáticas cargadas bajo demanda); compositor con paleta `/`, historial,
  preset, modelo + esfuerzo, anillo de contexto y enviar/detener; panel de aprobaciones e
  interacciones que ocupa el lugar del compositor; temas oscuro/claro/sistema sin parpadeo, EN/ES y
  `prefers-reduced-motion`. `pnpm web:size` (también dentro de `pnpm pack:check`) exige JS inicial ≤
  90 KB y CSS inicial ≤ 20 KB gzip.
- Fase 4 (renderizadores de desarrollo, explorador y adjuntos):
  - Renderizadores web diferidos por kind (un chunk cada uno, resolución probada en T-17 con
    fallback para kinds desconocidos y cargas fallidas): `diff` (parser de parche unificado propio y
    diff de líneas Myers para bloques con solo `before`/`after`; unificado o lado a lado, hunks
    plegables, navegación por archivos), `terminal` (parser SGR propio: 16 colores con tokens por
    tema, 256 colores y truecolor, negrita/tenue/cursiva/subrayado/inverso; descarta el resto de
    escapes; `\r` resuelto; últimas 2 000 líneas con "mostrar todo"; streaming desde
    `tool_progress` para `shell`/`run_process`), `json` (árbol plegable, profundidad
    `collapsedDepth`, copia de valor y de JSONPath, > 1 000 hijos truncados), `test-results`
    (resumen, filtro de fallos, error y `archivo:línea`) y `progress`. Sin dependencias nuevas.
  - Núcleo: `write_file`/`edit_file` añaden un bloque `diff` (parche unificado de
    `runtime/diff.ts`, ≤ 200 KB cortado por línea) y `shell`/`run_process` un bloque `terminal`
    (stdout y luego stderr, últimos 256 KB, código de salida y duración) después del texto actual,
    que sigue siendo la primera parte y lo único que ve el proveedor (`textProjection`). La TUI
    ignora esos dos bloques en esas cuatro herramientas (`richPartsOf(result, toolName)`) para no
    duplicar la salida que ya muestra.
  - Servidor: `GET /api/workspaces/:wid/tree|file|diff` y `GET /api/sessions/:sid/changes`
    (`routes/files.ts`: `safePath` del núcleo más comprobación del `realpath`; páginas de 1 000
    entradas; vista previa ≤ 2 MB con `X-Truncated`/`X-File-Size` y `download=1`; imágenes por bytes
    mágicos, SVG como texto, binarios como descarga; `git` con `spawn` sin shell, 2 s, sin
    fsmonitor, diff externo ni textconv). `POST /api/blobs` (cuerpo binario ≤ 10 MB, único `POST`
    sin JSON; PNG/JPEG/GIF/WebP por bytes mágicos con dimensiones; `201 BlobRef`) y
    `GET /api/blobs/:hash` (tipo guardado, `inline`, `private, max-age=31536000, immutable`), sobre
    un `BlobStore` del servidor con la misma raíz que el de cada workspace.
  - Web: panel lateral con Archivos (árbol perezoso), Cambios (diff frente a `HEAD`) y Vista
    previa (código, Markdown, JSON, imagen; mencionar como `@ruta`); rutas de filas de herramientas,
    enlaces Markdown relativos y cabeceras de diff abren el archivo. Compositor con adjuntos (`+`,
    pegar, arrastrar; miniaturas, subida inmediata, quitar; máx. 8 por mensaje) y miniaturas en las
    burbujas. Pestaña Trayectoria (eventos durables agrupados por run, cargados por páginas e
    incrementalmente) y línea de estadísticas bajo el compositor (último run; totales de la sesión
    al pasar el ratón; caché "—" si el proveedor no la informa). JS inicial 56,3 KB y CSS 7,8 KB
    gzip.
- Fase 5 (renderizadores ricos y gestión):
  - Web: `mermaid` (11.17.2) y `math` (KaTeX 0.18.9) como chunks diferidos. La vista de Mermaid
    (chunk pequeño) importa Mermaid y DOMPurify (3.4.16) solo cuando el bloque entra en pantalla y
    nunca mientras se genera; `securityLevel: "strict"`, `htmlLabels: false`, renders serializados
    y reinicialización al cambiar de tema; el SVG pasa por DOMPurify (perfil SVG) antes del DOM.
    Fuente/diagrama, zoom, exportar SVG, pantalla completa y copiar. KaTeX va con su vista, su CSS y
    sus fuentes (servidas como archivos: la CSP no admite `data:` en fuentes), con `trust: false`,
    `throwOnError: false`, `maxExpand: 500`, `maxSize: 50` y macros por bloque; el HTML se sanea con
    DOMPurify. Un error de Mermaid o de KaTeX muestra la fuente y el mensaje (`renderMath`/
    `renderMermaid` puros, T-17). Markdown: extensión de `marked` para `\( … \)` en línea (token
    `inlineMath`); ` ```math `, ` ```latex ` y párrafos `$$ … $$` siguen siendo display; `$` suelto
    no se interpreta (T-16).
  - Servidor (`routes/management.ts`, `routes/providers.ts`): `GET/PATCH /api/plugins`,
    `GET/PATCH /api/skills`, `GET/PATCH /api/mcp` y `POST /api/mcp/consent`, `GET /api/agents`,
    `GET/PATCH /api/settings`, `GET /api/providers`, `PUT /api/providers/:profile`,
    `PUT/DELETE /api/providers/:profile/credentials`, `POST /api/providers/:profile/activate` y
    `GET /api/models`, todas con `?workspace=` o `{workspace}` (id opaco o ruta absoluta) y
    validación propia. Los cambios emiten `catalog_changed` (`commands`, `plugins`, `skills`,
    `mcp`, `models`, `agents`). MCP nunca devuelve comando, argumentos ni URL. Las credenciales
    son de solo escritura: las respuestas llevan `{configured, source: "file"|"env", tail?}` con
    `tail` (`…XYZ`) solo para secretos de 16 caracteres o más.
  - Decisión (plugins): `setPluginEnabled` escribe el ajuste del proyecto y la app en curso queda
    `restart-required`; el servidor recicla la `Application` del workspace (`WorkspaceHost.recycle`)
    en cuanto no tiene runs (en el momento o cuando termina el último run, vía el `onChange` del
    `RunScheduler`). Los workspaces no confiables marcan todos los plugins como no gestionables
    (su `.alisio/config.json` se ignoraría). Las skills se aplican en caliente.
  - Decisión (proveedores, P-01): activar un perfil responde `409 runs_active` si el workspace tiene
    runs en cola o en curso; si no, `activateProviderProfile` cambia la app del workspace y guarda
    el perfil como activo en `providers.json`. Otros workspaces abiertos mantienen su proveedor.
  - Núcleo (aditivo): `ProviderSettingsStore.saveProfile/setCredentials/deleteCredentials/
    credentialStatus` y `maskSecret`; `settableSettings()` (tipo y opciones de cada
    `SettableSettingKey`); `PluginHost.toolsOf(plugin)` (dueño de cada tool registrada, también
    para built-ins); `grantMcpRuntimePermission` y `rememberGlobalMcpConsent` aceptan la fuente
    `"interactive-web"` (P-07).
  - Web: el modal de Ajustes (chunk propio, cargado al abrirlo) con General (idioma y ajustes del
    agente), Modelos (perfiles, credenciales con campos de contraseña que se vacían al guardar,
    activación con modelo), Plugins (pestañas, buscador, contador y tarjetas de `image2.png`),
    Skills, Servidores MCP (confirmación explícita antes de conceder acceso), Presets de agente
    (usar en la sesión abierta) y Apariencia, más "Abrir archivo de configuración" con rutas
    copiables. Las filas de tools de plugins muestran el nombre de la tool y el plugin como
    etiqueta. JS inicial 60,6 KB y CSS 7,5 KB gzip (antes 56,3 y 7,8); chunk de `math` 75 KB gzip
    (KaTeX incluido), Mermaid 32 KB de motor más ~138 KB de núcleo y un chunk por tipo de diagrama.

### Modos de permisos, `/reload` y `/changelog` (fase 1)

Primera fase de `specs/archive/alisio-modes-goal-background-v1.md` (decisiones del propietario confirmadas
el 2026-10-02). Las fases 2 (revisión del plan), 3 (tareas en segundo plano, migración v7) y 4
(`/goal`, migración v8) están implementadas (ver las secciones siguientes).

- Núcleo (aditivo): `PermissionMode` en el SDK y `PermissionPresetInfo.mode`; la **tabla única**
  `PERMISSION_MODE_TABLE` (`permissions/modes.ts`: `ask` pregunta por todo; `auto` permite escrituras
  y pregunta por procesos y externo; `full` lo permite todo) de la que derivan los presets del
  servidor (`host/presets.ts`) y la TUI; `AgentRunner.setPolicy` (muta en sitio `write/process/
  external`, nunca `analysis`); `cycleableAgents`/`nextAgent` (orden estable `build`, `plan`, resto
  por nombre); `reloadApplication` (`reload.ts`: guarda de inactividad, validación de la
  configuración, construcción de la aplicación nueva junto a la vigente, intercambio y cierre de la
  antigua; informe por área); el parser puro del changelog (`changelog/`) y los datos embebidos
  (`changelog/data.ts`, generado desde `CHANGELOG.md` por `scripts/changelog-data.ts`; `pnpm build`
  lo regenera y un test falla si están desactualizados). Comandos `permission` (alias
  `permissions`), `reload` y `changelog` en el catálogo (TUI y web).
- TUI: Shift+Tab cicla los agentes principales desde el listener de entrada (corre antes del
  Editor); bloqueado durante un turno y con picker, autocompletado o panel de agentes abiertos; no
  cambia el modelo ni crea una sesión (a diferencia del selector `/agents`). `/permission` abre un
  menú de cinco filas (ask, auto, full access con confirmación «no es un sandbox», Status, Manage
  saved permissions…) o acepta `ask|auto|full|status`; el modo inicial se deriva de los flags solo
  como etiqueta (sin flags `ask`, `--allow-write` `auto`, los tres flags `full`, otra combinación
  `custom`, `--read-only` bloqueado) y se muestra siempre (cabecera `mode:` y barra de estado
  `mode:`). `/reload` reconstruye la aplicación (la variable `app` pasa a `let` y se re-enlazan
  catálogo de comandos, proveedor, cachés de modelos, UI interactiva y autocompletado; se reaplica
  el modo elegido). `/changelog [version]` abre un panel desplazable y tras una actualización una
  sola línea avisa (`tui-state.json` junto a la base de datos, escritura atómica y tolerante a fallos).
- Servidor: `WorkspaceHost.reload` (construir primero, intercambiar después; `recycle` cierra
  primero), `POST /api/workspaces/:wid/reload` (`409 runs_active` con ejecuciones; `400` con la
  configuración rota), `GET /api/changelog?version=&lastSeen=`, los comandos `permission`, `reload`
  (exclusivo) y `changelog` en `POST /api/sessions/:sid/commands`, y `GET /api/agents` en orden
  estable. Mismas reglas de autenticación, Host y Origen que el resto de `/api`.
- Web: selector `Agente: <nombre>` en el compositor y atajo Mayús+Tab con el foco en el textarea
  (`preventDefault`; ignorado con IME, paleta abierta u otros modificadores; anuncio `aria-live`),
  popover de permisos con los tres modos, estado y «Gestionar permisos guardados…», confirmación al
  elegir acceso total, diálogo de `/changelog` (chunk propio) y aviso discreto tras actualizar
  (`localStorage` con `try/catch`). Textos en EN y ES.

### Pestaña Memory de la web y vistas de datos de plugins

Especificada en `specs/archive/alisio-web-memory-tab-v1.md`. Solo web; todo aditivo.

- SDK: `api.views?.register({ id, description, params?, handler })` (`ViewDefinition`,
  `ViewContext`, `ViewParamsError`) y los códigos de error `view_failed` (502), `view_timeout`
  (504) y `view_too_large` (502). El miembro es opcional en el tipo: un plugin lo detecta con
  `api.views?.register` y sigue funcionando en un core anterior.
- Core (`PluginHost`): registro por plugin con validación (id, descripción, esquema de primitivos
  sin `$ref`, duplicados) que se deshace con el plugin, `viewsOf(plugin)` y `runView` (Ajv con
  conversión de tipos desde la cadena de consulta y valores por defecto; `ViewRunError`).
- Servidor: `GET /api/sessions/:sid/views/:plugin/:view?<params>` (`routes/plugin-views.ts`) con la
  misma autenticación, Host y Origen que el resto de `/api`; sesión existente con workspace
  existente, solo plugins habilitados (también un plugin deshabilitado que sigue corriendo por
  `restart-required`), 404 uniforme para plugin/vista desconocidos o deshabilitados, máximo 16
  parámetros de 512 caracteres, timeout de 5 s con `AbortSignal`, respuesta de 1 MiB como máximo,
  errores del plugin genéricos (`view_failed`) y sin parámetros ni contenido en los logs.
  `ServerOptions.views` baja los límites en pruebas.
- Plugin de memoria: vistas `records`, `summary` y `context` (solo `SELECT`; paginación por cursor
  keyset sobre `pinned, updated_at, id`; búsqueda `LIKE` escapada) y la tabla `injected_context`
  (migración 101) donde el plugin recuerda lo que inyectó al empezar cada sesión.
- Web: selector genérico «plugin X habilitado» (`store/plugins.ts`, alimentado por la misma petición
  de `GET /api/plugins` que ya se hacía), pestaña Memory solo con el plugin habilitado y vuelta a
  Conversación si se deshabilita, controlador con descarte de respuestas obsoletas
  (`store/memory.ts`), componente, textos y estilos en un chunk perezoso. Para recuperar presupuesto
  de bundle los cargadores perezosos de `app.tsx` pasaron a un único componente `Lazy` y la pestaña
  Trayectoria también se carga de forma perezosa.

### Temas de iconos de la web (`web.iconTheme`)

Punto de extensión `icon-theme` (`@alisio/sdk`) y ajuste global `web.iconTheme` (por defecto `none`)
que selecciona **un solo** tema activo a la vez. Un plugin registra `{ id, label, manifestPath,
iconsDir }` con rutas absolutas; el servidor sirve el catálogo (`GET /api/icon-themes`), el
manifiesto del tema activo (`GET /api/icon-theme/manifest`) y sus SVG (`GET
/api/icon-theme/icons/:name`, confinado al `iconsDir`, con ETag y caché inmutable). La web carga el
manifiesto una vez y resuelve el icono por nombre exacto, extensión más larga y defecto (las
carpetas incluyen la variante expandida), con vuelta al set de iconos inline si no hay tema o el
icono falla. El dock (pestaña Archivos) usa estos iconos y el selector vive en Ajustes → Apariencia.
El plugin `@alisio/plugin-material-icons` (vendoriza el set de Material Icon Theme, MIT, 1251 SVG +
manifiesto) vive en el repositorio **`alisio-plugins`** y se instala por separado con
`alisio install npm:@alisio/plugin-material-icons`. Límites de esta rebanada: se ignoran las
variantes `_light` y los sets que no publiquen un manifiesto estilo VSCode.

### Tareas en segundo plano (fase 3 de la especificación de modos, goal y tareas)

Especificada en `specs/archive/alisio-modes-goal-background-v1.md` (§8). Todo aditivo.

- Migración **v7** (solo hacia delante, idempotente): `background_tasks` (estados `queued`, `running`,
  `stopping`, `succeeded`, `failed`, `cancelled`, `lost`; `abort_origin`, `error_code`, `owner_pid`,
  `pid`, ruta del log relativa a la carpeta de estado, `delivered_at`) y `session_goals` (sin lector
  hasta la fase 4).
- Core: `BackgroundTasks` (`background/service.ts`) sobre el ejecutor de procesos compartido
  (`runProcess`, ahora con `onSpawn` y `killProcessTree`/`isProcessAlive` exportados; no hay un segundo
  *spawner*). Cada cambio de estado es un compare-and-set en SQL; el origen de la parada (`user`,
  `model`, `timeout`, `shutdown`) se conserva aparte de su efecto (`cancelled` para el usuario, el
  modelo y el cierre; `failed` con `timeout` para el watchdog). Logs en
  `<estado>/tasks/<sesión raíz>/<id>.log` con escrituras síncronas y lecturas por offset (las lecturas
  nunca parten un carácter UTF-8); tope por log (cabeza + marcador + cola de 32 KiB al terminar).
  Límites: `tasks.maxPerSession` por sesión raíz y 16 por proceso. Cierre ordenado (`close()`): se
  rechazan tareas nuevas, se aborta, se espera y se mata el grupo de procesos de las que no mueren;
  además un manejador síncrono de `exit` mata los grupos si el proceso sale sin `close()`.
  Recuperación al arrancar (`recover()`, y el servidor al iniciar): `lost` solo para tareas cuyo
  `owner_pid` ya no existe (nunca las de este proceso ni las de otro proceso vivo).
- Herramientas `bg_run`, `bg_list`, `bg_output`, `bg_stop` (`tools/background.ts`), **las cuatro con
  efecto `process`** (decisión del propietario: lo que no puede iniciar un proceso tampoco lo lee ni lo
  detiene; la especificación original tenía `bg_list` como `read`). Una sesión solo ve las tareas de su
  árbol. `bg_output` devuelve `next_offset` y `eof`; una lectura del modelo (y un `bg_list`) de una
  tarea ya terminada la marca como entregada.
- Notificación (`background/notify.ts`): un mensaje por lote (ventana de 2 s), como mucho uno por
  sesión cada 10 s y 6 cada 10 min, reintento cada 2 s y al quedar libre la sesión, reclamación de
  `delivered_at` con compare-and-set antes de despertar y liberación si el despertar no arrancó. Solo
  para sesiones raíz y tareas que terminaron por sí solas (éxito, fallo, timeout). El despertar lo inicia
  el host: la TUI por `runPrompt` (`wakeDecision`), el servidor por `RunScheduler` con el id de petición
  `bg-<id>`; `runner.enqueue` no despierta una sesión inactiva (verificado).
- Espejo de subagentes: `subagentTasks` lee el panel (`PanelProvider.nodes`) del plugin de subagentes,
  que ya existía; **no** hizo falta publicar estado nuevo desde `plugin-subagents` (la especificación
  lo suponía) y su gestor, herramientas y `<task-notification>` no cambian.
- Retención: `TaskJanitor` (patrón del janitor de análisis: temporizador sin referencia, 30 s tras el
  arranque y después cada día; nunca con `--read-only` ni `:memory:`).
- Configuración: sección `tasks` (`enabled`, `maxPerSession`, `maxRunMs`, `maxOutputBytes`,
  `retentionDays`; esta última solo global y con aviso si un proyecto la define), todas ajustables con
  etiquetas EN/ES en la web y las principales en `/settings`.
- Servidor: `GET /api/sessions/:sid/tasks`, `GET …/tasks/:tid/output?offset=&limit=`,
  `POST …/tasks/:tid/stop`, código `task_not_found` (404), frame `tasks_changed`. Un workspace con
  tareas vivas no se expulsa por inactividad, un reciclaje diferido espera a que terminen y `/reload`
  responde `409`.
- TUI: `/tasks` (`tui/tasks.ts`: reductor puro y `TasksView`) con lista, salida en vivo, parada con
  confirmación; `/reload` se rechaza con tareas vivas. `alisio run` detiene las tareas que siguen
  corriendo al terminar y lo dice por stderr.
- Web: pestaña Tareas del Dock (chunk perezoso con su store y sus textos), contador en la pestaña y
  punto en el icono del panel, aviso cuando una tarea termina por sí sola, `/tasks`. Para recuperar
  presupuesto de bundle el diccionario del idioma no activo (español) pasó a un chunk que se carga antes
  del primer render o al cambiar de idioma; el bundle inicial bajó de ~89,9 KB a ~78 KB gzip.

### Objetivos de sesión `/goal` (fase 4 de la especificación de modos, goal y tareas)

Especificada en `specs/archive/alisio-modes-goal-background-v1.md` (§9). Todo aditivo; decisiones del
propietario del 2026-10-02 aplicadas tal cual.

- Migración **v8** (aditiva, `ALTER TABLE`): la tabla `session_goals` de la v7 no tenía lector y le
  faltaban las columnas del runtime (`goal_id`, `detail`, `summary`, `blocked_run`, `continuations`,
  `inflight`, `last_run_id`, `kickoff_sent`, `owner_pid`); una base que ya estaba en v7 (las
  alphas de la fase 3) las recibe sin perder filas.
- Máquina de estados pura (`goal/machine.ts`): `active`, `paused`, `blocked`, `budget_limited`,
  `complete`, cada una con un código de motivo cerrado (`created`, `resumed`, `user_paused`,
  `user_interrupt`, `model_complete`, `model_blocked`, `policy_denied`, `run_error`, `token_budget`,
  `max_turns`, `max_wall`, `no_progress` con detalle `repeated_reply` o `no_tool_turns`, `restart`).
  Usuario: crear, pausar, reanudar (pausa o bloqueo), editar y borrar en cualquier estado, cambiar el
  presupuesto en cualquier estado (subirlo o quitarlo reactiva un `budget_limited(token_budget)`; bajarlo
  a lo gastado detiene uno activo). Modelo: solo `complete` o `blocked`, solo con el objetivo `active`
  y con evidencia. Sistema: topes y disyuntores, interrupción del usuario, reinicio; nunca reanuda.
  Reanudar tras `max_turns`/`max_wall` concede una asignación más de ese tope.
- Servicio (`goal/service.ts`, `app.goals`) sobre `GoalStore` (`goal/store.ts`): cada cambio es
  lectura-modificación-escritura en una transacción `BEGIN IMMEDIATE`; `epoch` (cambia con estado,
  objetivo y presupuesto; los totales no lo mueven) más `goalId` permiten que un cliente diga lo que
  vio (`expect`) y reciba `conflict` si otro lo cambió. Un goal de otra pestaña, ventana o proceso que
  comparte la base no se pisa.
- **Una lista ordenada de bloqueadores** (`goal/blockers.ts`, `goalBlocker`): no activo, desactivado,
  ejecución en curso o continuación reclamada, entrada del usuario sin enviar (TUI), permiso pendiente,
  pregunta o revisión de plan pendiente, agente `plan`, tareas en segundo plano vivas. Son esperas, no
  estados; `goalWaiting` da la etiqueta de la UI.
- Continuación idempotente: `next()` comprueba los topes, aplica la lista y **reclama una** continuación
  con un compare-and-set (`inflight` = id de petición `goal-<goalId>-<n>`); un segundo disparo ve la
  reclamación y espera. El host la inicia como una ejecución normal (`RunScheduler` con
  `beginRun(requestId)` en el servidor; `runPrompt` en la TUI), así que los ids de llamadas y los datos
  de continuación del proveedor no cambian. Prompts (`goal/prompts.ts`): contrato completo **una vez**
  (`kickoff`, con el objetivo citado como dato en `<goal_objective>`), después una pista corta y estable
  (la misma cadena cada turno: prefijo estable para la caché del proveedor), recordatorio tipo auditoría
  cada 5 turnos y avisos tras la segunda repetición o el segundo turno sin herramientas.
- Presupuesto **duro y acumulado**: `tokens_used` suma `usage.input + usage.output` de cada ejecución
  (el mismo recuento que el runner; sin `usage` se estima por caracteres). Cada continuación arranca con
  `maxTokens` = lo que queda, por lo que el guardia del runner (antes de cada llamada a herramienta y al
  final de cada lote) detiene la ejecución; como el runner cuenta por petición, el gasto puede pasar del
  presupuesto como mucho una petición. Una ejecución que lanza (error, tope, timeout) conserva su uso
  (`core/run-stats.ts`, un `WeakMap` junto al error), de modo que un tope de presupuesto es `budget_limited`
  y no `run_error`. No hay turno de cierre. «Turno» = una ejecución (kickoff, continuación o mensaje del
  usuario con el goal activo); el tiempo es el de las ejecuciones (incluye esperar una aprobación dentro
  de una ejecución, no la espera entre ejecuciones) y el `timeoutMs` de cada continuación se acota a lo
  que queda.
- Disyuntores: respuesta final idéntica (huella normalizada) y turnos sin herramientas; la primera
  ocurrencia se registra (`onLog`), la segunda añade un aviso a la siguiente continuación y el límite
  pausa con `no_progress`. `blocked` exige el mismo informe en turnos consecutivos
  (`goal.blockedRepeats`) salvo evidencia `denied`. Un fallo de ejecución bloquea con el error como
  motivo, salvo un `RunTimeoutError` (cuenta como turno sin herramientas). Esc/Detener/cancelar pausa
  (`user_interrupt`).
- Herramientas `get_goal` y `update_goal` (`tools/goal.ts`, efecto `internal`): **opt-in** (se añaden a
  `OPT_IN_TOOLS`; solo se ofrecen a las ejecuciones de una sesión con goal `active` y agente distinto de
  `plan`; Code Mode no las ve), por lo que sus descripciones no cuestan tokens en el resto. El modelo no
  tiene herramienta para pausar, reanudar, editar, borrar ni cambiar el presupuesto.
- Reinicio: `pauseOrphans` (arranque de aplicación y de servidor) pausa con `restart` los goals `active`
  cuyo `owner_pid` ya no existe (o es desconocido); nunca los de este proceso ni los de otro proceso
  vivo, y nunca reanuda. Idempotencia por ejecución: `last_run_id` evita contar dos veces una ejecución.
- Configuración: sección `goal` (`enabled`, `maxTurns` 50, `maxMinutes` 120, `repeatedReplyLimit` 3,
  `noToolTurnsLimit` 3, `blockedRepeats` 2), todas ajustables con etiquetas EN/ES en la web y en
  `/settings`. **No hay presupuesto de tokens por defecto** (se avisa en la documentación).
- Servidor: `GET|PUT|PATCH|DELETE /api/sessions/:sid/goal`, `POST …/goal/pause|resume`, comando
  `/goal` en `POST …/commands` (misma gramática que la TUI, `parseGoalCommand`; `confirm` para
  reemplazar), frame `goal_changed`, `goal` en el snapshot SSE, códigos `goal_not_found`, `goal_conflict`,
  `goal_disabled`. `GoalDriver` (`host/goal.ts`) es el único camino que inicia continuaciones: tras cada
  ejecución (`RunScheduler` ahora informa resultado, error y tiempos), al terminar la última tarea,
  al cambiar opciones de sesión (agente) y tras las acciones del usuario.
- TUI: `/goal` y su menú (`tui/goal.ts`: `planGoalCommand`, filas del selector, `GoalBar`), confirmación
  de reemplazo, continuación tras cada `task()`, pausa con Esc, `goal.*` en `/settings`.
- Web: barra del objetivo (chunk perezoso con su store y sus textos EN/ES), barra de progreso del
  presupuesto, botones Pausar/Reanudar/Editar/Borrar, filas de la paleta, `/goal` con confirmación;
  en el bundle inicial solo el signal y el manejo del frame (JS inicial 79,8 KB gzip de 90).

### Decision Intelligence (fases 1 a 5 de la especificación)

Especificada en `specs/alisio-decision-intelligence-v1.md`. Todo aditivo y opcional: sin proveedor
Alisio se comporta igual. Solo infraestructura: el paquete no incluye ningún proveedor ni ninguna
función que consuma decisiones (los consumidores son especificaciones posteriores). Guía de usuario:
[Decision Intelligence](/es/decision-intelligence).

- Contrato en `@alisio/sdk`: `DecisionProvider` (`select`, `boolean`, `ordinal`; `health?`, `activate?`,
  `deactivate?`, `decide`), `DecisionRequest`, `DecisionResponse`, `DecisionProviderError` (`not_ready`,
  `unavailable`, `timeout`, `invalid_response`, `internal`), `DecisionRequestError`, `DecisionStats`,
  el helper puro `summarizeDecisionEvents`, la categoría `"decisions"`, los eventos `decision_completed`
  y `decision_fallback` en `RunEventDataMap`, `PluginAPI.decisions?`, `PluginAPI.paths?`,
  `PluginAPI.options?` y `ToolContext.decisions?`. Todos opcionales y detectables por presencia.
- Núcleo (`packages/core/src/decisions/`): `DecisionRegistry` (registro por plugin que se deshace al
  descargarlo), `DecisionService` (`tryDecide`, `attempt`, `decide`), validación de la petición (1 a 16
  decisiones, 2 a 20 opciones, 2 a 12 niveles, `state` de hasta 16 KB y petición de hasta 32 KB, claves
  e `id` con patrón fijo) y validación por clave de cada respuesta (el resultado parcial es válido; los
  rechazos se explican con `low_confidence`, `invalid`, `unsupported` o `missing`).
- Tiempo límite impuesto por el núcleo (`decisions.timeoutMs`, 1500 ms por defecto, resultado de la Fase
  0) y disyuntor (3 fallos consecutivos abren 30 s; una sonda medio abierta). Cuentan `timeout`,
  `invalid_response`, `internal` y los errores sin tipo; no cuentan `not_ready`, `unavailable`, la baja
  confianza ni los rechazos por decisión. El núcleo nunca llama a `health()` en la ruta de `decide`.
- Fallback por decisión (`tryDecide` devuelve `null` solo ante fallo de infraestructura, desactivación o
  rechazo total); motivos: `timeout`, `not_ready`, `unavailable`, `invalid_response`, `provider_error`,
  `circuit_open`, `unsupported`, `all_rejected`.
- Configuración: bloque `decisions` (`enabled`, `provider`, `timeoutMs`, `minConfidence`, `telemetry`);
  `provider` y `telemetry` son solo globales (una capa de proyecto o `--config` que las defina se
  ignora con diagnóstico, sin fallo de arranque); las cinco claves son ajustables en vivo con etiquetas
  EN/ES en la web. `pluginOverrides[id].options` (solo global, hasta 8 KB, claves con patrón fijo),
  que alimenta `api.options` como instantánea congelada en `setup`; `setPluginEnabled` conserva las
  `options`. `api.paths` (`state`, `config`, `cache`) con modo `0700` en la primera lectura, bajo la
  misma raíz de estado que análisis y artefactos (respeta `--db`).
- Ciclo de vida del proveedor activo: `activate()` y `deactivate()` se disparan al pasar a ser el activo
  (arranque, cambio de `decisions.provider` en vivo, registro tardío) y al dejar de serlo; acotados por
  tiempo, serializados por proveedor, nunca fatales y nunca esperados en el arranque. Un fallo se
  guarda como error de ciclo de vida y se ve solo en `/decisions`.
- Cierre acotado de plugins: `PluginHost.close()` libera los plugins en paralelo, cada uno con su tope
  (`pluginHooks.disposeTimeoutMs`, 100 a 10000, por defecto 2000), y registra los fallos sin impedir el
  resto; el proveedor activo se desactiva antes. `alisio run` gestiona ahora `SIGTERM` y `SIGHUP` como
  `SIGINT`, así que un `kill` también ejecuta `dispose()`. `discoverPlugins` solo trata como plugin un
  directorio con `alisio-plugin.json`, porque `<config home>/plugins/<id>` es también donde
  `api.paths.config` guarda los archivos de un plugin.
- Eventos y métricas: `ToolContext.decisions` ligado a la ejecución (las llamadas anidadas de Code Mode no
  lo reciben); los eventos llevan solo metadatos (nunca `state`, instrucciones ni etiquetas) y no se
  persisten con `telemetry: false`; métricas en memoria por sesión y por proceso.
- Comando `/decisions` (TUI y web, mismo texto Markdown) con estado, salud (límite propio de 1 s),
  capacidades, circuito, ajustes, error de ciclo de vida y métricas; sección «Decision Intelligence» en
  `/stats` (solo si hubo decisiones) calculada con `summarizeDecisionEvents` en las tres rutas (núcleo,
  TUI y web). En la web las estadísticas de decisiones van en el tooltip de los totales de la sesión.
- Activación pedida por el plugin: `api.decisions.activate?(providerId, options?)` (`options.recommend === true` marca y preselecciona Yes en vez de No, sin saltarse la pregunta; opcional, detectable por
  presencia; `DecisionActivationResult` con `activated`, `already_active`, `other_provider_active`,
  `declined`, `needs_confirmation`, `disabled`, `unavailable`). Solo acepta proveedores registrados por
  el propio plugin; nunca sobrescribe un `decisions.provider` distinto; con `decisions.provider` vacío
  pregunta una vez (Sí/No) por la vía interactiva del host y, sin superficie interactiva
  (`alisio run`), devuelve `needs_confirmation`. Si se acepta, persiste solo `decisions.provider` en la
  configuración global con el mismo escritor atómico que los ajustes en vivo y aplica el cambio en
  caliente; si falla el guardado, `unavailable` y sin cambio en memoria. Límites: el texto de la
  pregunta está en inglés, no hay una confirmación por plugin recordada (cada llamada con la
  configuración vacía pregunta de nuevo) y no se añade ninguna frontera de confianza (un plugin
  confiable ya podía actuar con los permisos del usuario; la confirmación es la salvaguarda).

### Smart Dashboard (fases 0 a 7 de la especificación)

Especificada en `specs/alisio-smart-dashboard-v1.md` (release previsto 0.4.0). Estado: la fase 0 está
hecha, las fases 1 a 7 están implementadas y la fase 8 se midió el 2026-10-03 con `deepseek-flash`
(resultados en `docs/benchmark-dashboard.json`; resumen en la guía de usuario). **La puerta de §11.2
falla**: B (15 ejecuciones, 1 repetición por dataset) redujo los tokens de salida un 28,5 % (exigido
50 %) y los turnos un 8,7 % (exigido 40 %), con 15/15 specs válidos y 0 avisos de lint; el modelo
elige `dashboard_generate` en el 100 % de las ejecuciones (E7), pero sigue usando `python_run` después.
C (5 ejecuciones, informativa): Laya respondió en 4/5. **Pendiente**: decisión del propietario sobre
cómo continuar y la fase 9 (release). Guía de
usuario: [Smart Dashboard](/es/smart-dashboard). El proveedor de decisiones refina solo el propósito
(`PROVIDER_DECISIONS` en `pack.ts`): con Laya 0.3.24 real acertó el 90 % en el propósito y quedó cerca del azar
en columnas y gráficos, así que las reglas deciden el resto.

- Herramienta `dashboard_generate` (efecto `internal`): entrada `{ datasetId, goal?, title?, locale?,
  sheet? }`; construye un dashboard sin código ni llamada al modelo y lo publica como `dashboard.html`
  con procedencia propia (`generator`, `spec`, `planner`, `decisionProvider?`, `fallbacks`). Errores
  `dataset_not_found`, `no_usable_columns`, `plan_failed` y `query_failed`, con la indicación de usar
  `python_run`; un error no deja un artefacto parcial. Una consulta que falla elimina solo su
  componente y queda anotada en el resultado.
- Pipeline puro en `packages/core/src/analysis/dashboard/`: perfilador de columnas (roles `time`,
  `measure`, `dimension`, `identifier`, `boolean` y `unknown`, calculados con las estadísticas de
  `_alisio_columns` sin una nueva pasada de ingesta), candidatos (medidas ≤ 8, dimensiones ≤ 8, tiempo
  ≤ 4), planificador «reglas primero, decisiones encima», `DashboardSpec` v1 (tipos en `@alisio/sdk`),
  validador con tabla de reparación determinista (`valid`, `repaired`, `fallback`; nunca se llama al
  modelo), planificador de consultas y renderizador en TypeScript. Catálogo cerrado: `kpi`, `line`,
  `area`, `bar`, `hbar`, `pie`, `donut`, `scatter` y `table`; límites de 12 componentes, 6 KPI y 8
  columnas de tabla, y de 1 a 20 categorías por ranking.
- Planificador de consultas: cada componente es un único `SELECT` construido desde un AST con
  identificadores tomados solo del catálogo de columnas del dataset, siempre entrecomillados y sin
  literales del modelo ni del proveedor; se ejecuta por `DatasetService.query()` (guardia de sentencia,
  lector de solo lectura y tiempo límite). La tendencia elige el cubo de tiempo más grueso que deje
  como máximo 400 cubos en lugar de truncar la cola; los cubos de tiempo exigen una fecha ISO 8601.
- Pack de decisiones `smart-dashboard-v1`: el `state` lleva solo el objetivo (truncado a 300
  caracteres) y, por columna preseleccionada, un alias opaco, la etiqueta (≤ 60), el rol, el tipo
  inferido y el cubo de cardinalidad; nunca valores de celdas. Sin proveedor el plan por reglas es
  igual de válido.
- Renderizador con el mismo contrato DOM que `alisio_runtime.charts`: el CSS y el script de arranque
  pasaron de cadenas de `charts.py` a archivos del runtime (`charts.css`, `charts-boot.js`,
  `html-base.css`) que leen ambos renderizadores; se subió la versión del runtime. KPI en notación
  compacta desde un millón (el valor exacto queda en la ayuda emergente), nombres de columna legibles,
  títulos y etiquetas por plantilla `en`/`es`, y «Otros» en los gráficos de participación.
- Configuración: `analysis.smartDashboard` (booleano, `true` por defecto). Con `false` la herramienta
  no se registra. No es solo global, pero un `false` global no lo deshace una capa de proyecto (el
  bucle de capas conserva el valor global cuando la capa no define la clave). Ajustable en vivo con
  etiquetas EN/ES en la web y entrada en `/settings` de la TUI; se aplica al siguiente arranque.
- Registro bajo `analysisEnabled && config.analysis.smartDashboard`, igual que `artifact_create`.
- Guía al modelo (fase 6, §10.1 de la especificación): con `smartDashboard: true` las descripciones de
  `python_run`, `data_inspect`, `data_query` y `artifact_create`, la cabecera de `describeDataset` y los
  avisos de `chart-lint` mencionan `dashboard_generate` y dejan `python_run` para lo que el catálogo no
  cubre; con `false` son idénticas a las de 0.3.0 (resúmenes SHA-256 en `tests/dashboard-tool.test.ts`).
  El arnés de benchmark registra ahora el motivo de los fallos (`failureReason`, `failureClass`,
  `lastTurnTokens`, `endedWithoutDashboard`; `failureReasons` por variante).
- Progreso: la herramienta emite `Analyzing dataset…`, `Planning dashboard…`, `Building N components…`,
  `Query i/N…` y `Dashboard ready`; la web muestra la última línea en la fila de la herramienta y la
  TUI gana el manejo de `tool_progress` (última línea no vacía, ≤ 80 caracteres, borrada al terminar).
  La ficha del artefacto en la web muestra el planificador y el proveedor de decisiones.
- Pruebas golden acotadas de `DashboardSpec` en `tests/golden/dashboard/*.json` (excepción documentada
  en `CONTRIBUTING.md`); el HTML solo con aserciones estructurales.
- Arnés de benchmark `scripts/bench-dashboard.ts` y `scripts/bench/lib.ts` (fase 0); los resultados
  irán a `docs/benchmark-dashboard.json`, excluido del sitio.

## Validación

Consultar [validation.txt](https://github.com/GustavoGutierrez/alisio/blob/main/docs/validation.txt) para la ejecución final. Las pruebas de proveedor usan un
servidor HTTP local determinista, no una cuenta externa. MCP se prueba con el SDK servidor
real en procesos/HTTP locales. El binario Linux ejecuta un ciclo completo, carga un plugin
externo con dependencia y conserva la sesión. La integración Herdr tiene validación de
contrato; el escenario de dos agentes bajo un servidor Herdr real quedó bloqueado por el entorno.

## Pendiente para llegar a 1.0.0

- Ejecutar y ajustar matriz Windows/macOS; CI actual cubre Linux, no certifica otros sistemas.
- Validar DeepSeek, OpenCode Console/Zen y OpenCode Go con credenciales del usuario. La inferencia
  solo se verificó con claves falsas y HTTP simulado/local; los catálogos públicos sin autenticación
  de Zen y Go se comprobaron por separado. No se usaron ni inspeccionaron credenciales reales.
- Validar Herdr con servidor/PTY reales; añadir launcher/resumer nativo si Herdr lo permite.
- Checkpoints/rewind de sesión y memoria vectorial: no existen.
- Onboarding interactivo; temas de color configurables; vista de razonamiento expandible.
- Release estable con binarios: el script `pnpm publish` (`scripts/publish.ts`, ver
  [Publicación](/es/publishing)) publica las versiones alpha anteriores y la `0.1.0` estable
  (dist-tag `latest`); SemVer de rangos de plugins (`@alisio/sdk` como peer `^0.2.0`) y recarga en
  sesión inactiva.
- Discovery automático de rutas Pi y watch incremental.
- OAuth MCP interactivo y capacidades multimedia MCP. `/mcps` permite reconexión explícita y bearer
  mediante referencia a variable de entorno, pero no flujos de autenticación en navegador.
  El comportamiento de consentimiento repetido es ahora configurable: la preferencia global
  `mcp.allow` concede consentimiento MCP de forma persistente y auto-conecta los servidores
  activados en cada inicio; la concesión por sesión en la TUI es la alternativa cuando `mcp.allow`
  no está definido. Conceder persiste entre sesiones: un servidor que auto-conecta al arranque se
  ejecuta sin sandbox con los privilegios del usuario cada vez que está activado.
- OpenTelemetry remoto, métricas de memoria y benchmarks de repositorios grandes.
- Endurecer frente a procesos hostiles y carreras de filesystem. No se ofrece sandbox OS.

## Runtime y empaquetado: alcance de la verificación

- Pruebas bajo Node (Vitest): adaptador SQLite (filas planas, transacciones anidadas, FTS5
  trigram, permisos 0600, filtro del aviso experimental), helpers de archivos, `which`, runner
  de procesos (salida, truncado, timeout) y resolución de plugins por ruta o paquete. Todos
  los escenarios de integración se ejecutan en proceso bajo Node y un subconjunto también en Bun.
- `test:cli` ejecuta `packages/cli/dist/main.js` con Node contra un proveedor simulado
  (verificado en Node 22.19 y en el mínimo 22.16.0); `test:compiled` hace lo mismo con el
  binario Bun. Ambos comprueban que no aparezca el `ExperimentalWarning` de SQLite.
- `pack:check` empaqueta los nueve paquetes publicables con pnpm y valida contenido (solo `dist`, README,
  LICENSE, `package.json`), `exports` hacia `dist`, ausencia de `workspace:` y de fuentes.
- Instalación global real con npm desde los tarballs locales mediante un registro temporal
  (`scripts/install-smoke.ts`): `alisio --help` funciona desde el empaquetado npm.
- La ampliación actual de DeepSeek, OpenCode Console y OpenCode Go se verificó bajo Node puro con el
  CLI construido, claves falsas e inferencia HTTP simulada/local (`run --read-only`, herramientas y
  JSONL). Los catálogos públicos sin autenticación de Zen y Go se comprobaron por separado; no se
  usaron credenciales reales ni cuentas OpenCode reales.
- El enrutamiento por sesión se verificó con perfiles y claves falsas: padre/hijo concurrentes en
  proveedores distintos, selectores canónicos/únicos/ausentes/ambiguos, reanudación tras reinicio,
  aislamiento de continuación, reemplazos de agente/`task` e IDs OpenCode estables y distintos.
- `scripts/install.sh` probado contra un espejo local (instalación con checksum y rechazo de
  un binario alterado). No se ejecutó ninguna publicación ni release; los workflows de release
  y Pages no se ejecutaron en GitHub. Binarios macOS/Windows/arm64 no probados (compilación
  cruzada de Bun).

## Subagentes, AGENTS.md y skills: alcance de la verificación

- Vitest (Node): cargador de AGENTS.md (override, orden, adjunto perezoso por sesión, límite de
  32 KiB, CLAUDE.md desactivado por defecto, explain); skills (rutas, confianza, colisiones,
  nombres, profundidad y límite de directorios); presupuesto proporcional y una ejecución del
  tamaño de `/init` que ya no se agota; periodo de gracia SIGTERM → SIGKILL; definiciones de
  agentes (formato, compatibilidad Claude Code y opencode, precedencia, confianza, integrados);
  reductor de foco del panel. Con proveedor simulado: paralelismo y aislamiento de contexto,
  envoltura y límite de resultados, retirada de `task` al límite de profundidad, cola llena,
  error estructurado, permisos (solo lectura heredada), plugin desactivado, `send_message` a un
  hijo en ejecución, espera acotada y rechazo de esperar a un ancestro, notificación en segundo
  plano, cancelación en cascada con muerte forzada de un proceso, reanudación tras marcar
  interrumpido, worktrees en un repositorio real (dos ramas, merge, conflicto con merge abortado
  y descarte), orden serial y el paso de `ask` a `serial` sin terminal interactiva.
- Pseudo-terminal: panel con 4 agentes (uno anidado), acorde Ctrl+X ↓, ↓ desde el editor vacío,
  flechas en el panel, apertura de vistas de solo lectura, navegación padre/hijo/hermanos,
  colapsar, confirmación de Ctrl+K, `/agents`, y la pregunta de worktrees con dos escritores.
- Proveedor simulado (`--read-only`): dos `explore` en paralelo resumidos por el padre, y un caso
  anidado `general` → `explore` persistido con profundidades 1 y 2.
- No verificado: fusión real de worktrees con DeepSeek, Windows/macOS, rendimiento con muchos
  agentes simultáneos.

## Plantillas y `/init`: alcance de la verificación

- Vitest: parseo y validación del frontmatter, sustitución de argumentos, precedencia y
  diagnósticos, nombres reservados, confianza del proyecto, expansión slash, `display` en el
  historial. Escenarios: `/init` con proveedor simulado (list_files/read_file → write_file al
  crear; read_file → edit_file con hash al actualizar, conservando el contenido humano),
  rechazo con `--read-only` y sin `--allow-write`, aprobaciones, plantillas de plugin, usuario
  y proyecto (no cargadas sin confianza). `test:cli`/`test:compiled`: `run "/init"` headless y
  rechazo con `--read-only`.
- Proveedor simulado sobre una copia temporal de `examples/plugins/custom-mascot`:
  creó un `AGENTS.md` de 103 líneas con hechos verificados; una segunda ejecución con foco lo
  actualizó con `edit_file` conservando una nota humana. En esa segunda ejecución se agotó
  `limits.maxTokens` (100 000) después de aplicar los cambios; en repositorios grandes conviene
  subir ese límite.

## Pantalla de inicio y extensiones: alcance de la verificación

- Pruebas (Vitest, Node): registro (prioridades, desempate por id, conflictos, fallbacks,
  desregistro); pantalla por defecto en 36/60/100/160 columnas (secciones presentes, anchos
  dentro del límite, ASCII sin unicode, sin ANSI sin color); mascota y pantalla de plugins,
  campo declarativo, prioridades, empate con diagnóstico, proveedores rotos con fallback,
  saneado de secuencias de control, vuelta a los valores por defecto al cerrar el plugin;
  política del banner (TUI, readline, run, `--json`, `--quiet`, `--no-banner`, `CI`, sin TTY)
  y capacidades del terminal (`TERM=dumb`, `NO_COLOR`, `LANG=C`, 0 columnas → 80).
- `test:cli` y `test:compiled`: el JSONL de `run --json` es idéntico (normalizando ids, marcas de
  tiempo y duraciones) con y sin un plugin que registra mascota y pantalla, sin banner en stdout
  ni stderr.
- Pseudo-terminal: TUI a 110 y 36 columnas, `TERM=dumb`, `NO_COLOR=1`, `--no-banner`, plugin de
  ejemplo (cometa) en ancho y estrecho, y modo `--no-tui` con stderr TTY, redirigido y `--quiet`.

## TUI y compactación: alcance de la verificación

- Pruebas automáticas: formateadores, parseo de comandos, ajuste al ancho, diff de ediciones y
  reducción de eventos a modelo de vista (Vitest); planificador de compactación (Vitest);
  compactación manual/automática, persistencia tras reabrir la base, rechazo con llamadas
  inciertas, cambio de modelo persistido, migración de una base v1 y aprobación
  denegar/permitir en sesión (escenarios Bun); `listModels`, modelo por petición, tokens en
  caché y razonamiento con un servidor HTTP local.
- Renderizado y copia en la TUI (Vitest, `tests/tui-markdown.test.ts`): tokenizador por línea
  (segmentos exactos para ts/json/bash/python, docstrings y comentarios de bloque multilínea,
  llaves y pares de JSON, f-strings de Python, claves YAML, propiedades CSS, tags/atributos
  HTML); `highlightCode` con color (códigos SGR por estilo) y sin color (`NO_COLOR` → líneas
  planas sin `\x1b`); saneado de ANSI/controles incrustados en la entrada (nunca se reemiten) y
  caracteres raros (emoji incluido); `codeBlockIndent` aplicado al renderizar un bloque real
  con `AssistantBlock`; pista de copia: presente con respuesta completada, ausente durante
  streaming, ausente con respuesta vacía, aparece al completarse (`update`), fallback ASCII con
  `TERM=dumb`/`LANG=C`; enrutado puro del atajo `editorCopyKey` (`c`/`y` solo con entrada
  vacía, sin autocompletado y sin turno en curso); normalización de separadores de tabla
  (guiones em/en → `---` con alineación, sin tocar código delimitado/sangrado, `---` sueltos ni
  filas de prosa).
- Resultados enriquecidos (Vitest, sin red, `tests/mcp-rich.test.ts`, `tests/rich-results.test.ts`,
  `tests/tui-rich-render.test.ts`): contrato SDK aditivo (la unión de contenido y `UiBlock`
  compilan; `textResult` byte-idéntico; `textProjection` conserva orden/isError y devuelve la
  misma referencia para contenido solo-texto); mapeo MCP → bloques con fixturas: texto solo,
  parte de imagen (mime + base64 + marcador de proyección), tablas `{columns,rows}`/
  `{headers,rows}` con filas de objetos, clave-valor plano, árboles `{nodes}` con meta e hijos,
  texto JSON parseable con forma, fallback a texto para JSON anidado/arrays/no parseable, partes
  desconocidas como marcador (nunca bytes), `structuredContent` sin forma → comportamiento
  anterior, `isError` preservado, recursos (texto, blob de imagen, blob no-imagen → marcador,
  listado sin `contents` → JSON plano) y proyección canónica SIEMPRE presente junto a un bloque;
  persistencia: `endCall`/`callResult`/`append`/`messages` redondean ui/image intactos y
  `callResult` solo responde para llamadas completadas; compactación: `reduceMessageSizes`/
  `reduceMessagesToBudget` recortan solo partes de texto (las ui/image pasan intactas y no
  cuentan contra el tope), `serializeForSummary` emite solo la proyección (sin bytes ni
  `undefined`); runner: con un proveedor controlado y el adaptador real, el modelo recibe solo
  `["text","text"]` (texto + proyección), el store conserva ui/image y `tool_completed` emite
  `preview` solo-texto; TUI: `renderUiBlock` alinea tablas y envuelve celdas largas, clave-valor
  en dos columnas, árboles con `├─/└─/│` y ASCII `|-/`- /|`, código a través de `highlightCode`,
  markdown con el renderizador, imágenes: marcador con dimensiones sin protocolo, secuencia
  iTerm2 con `setCapabilities("iterm2")`, marcador con `NO_COLOR` incluso con soporte, bloques
  sin color con `NO_COLOR` (módulo fresco); `reduceEvent` e `itemsFromHistory` redondean ui/image
  y `isUiBlock` rechaza payloads malformados. Sin red: las fixturas llegaron solo hasta el
  adaptador puro; los tests de conector existentes (`mcp.test.ts` stdio/http) pasaron sin cambios
  de expectativas.
- Verificación manual en pseudo-terminal (Linux, xterm-256color, emulado con `pyte`) contra un
  servidor simulado local: arranque, streaming Markdown,
  herramientas, aprobación, `/stats`, `/model`, `/compact`, `/tools`, `/sessions`, `/resume`,
  `/clear`, Esc, Ctrl+C, Ctrl+D, redimensionado a 60 y 40 columnas sin líneas desbordadas, y el
  binario compilado. No se probó en Windows/macOS ni en emuladores reales distintos (kitty,
  iTerm2, Windows Terminal); Shift+Enter depende de la terminal.
- No se ejecutó una compactación automática con inferencia real autenticada.
- Métrica de contexto coherente (Vitest, proveedores simulados, sin red): el runner compacta con el
  presupuesto de caracteres de respaldo cuando la ventana es desconocida, NO compacta pronto cuando
  la ventana conocida es grande (el desajuste DeepSeek ~1M de ventana frente a 800k de caracteres),
  compacta en `ventana × threshold` aunque esté muy por debajo del presupuesto de caracteres, y
  trata las ventanas declaradas por encima de 2M de tokens como desconocidas para que el respaldo
  siga protegiendo. `app.contextBudget` informa la ventana del modelo cuando el catálogo la expone
  (carga perezosa de `GET /models` y refresco tras el cambio de modelo; verificado con fixturas
  oficiales de DeepSeek/OpenCode) y una base honesta `basis: "unknown"` sin total inventado en caso
  contrario; la barra de la TUI pinta `~9.9k / ?` para ese caso (Vitest de reducción/formateo) y
  expone el punto de compactación a la TUI.
- Cambio: `limits.maxContextChars` ahora tiene por defecto `800000` caracteres (≈ `200000` tokens,
  antes `160000` ≈ 40k) en el esquema de configuración y en el menú de ajustes (`/settings` →
  Presupuesto de caracteres de contexto, que ahora ofrece 800k entre sus valores). Es una suposición
  para ventanas de modelo desconocidas — el mismo presupuesto de ~200k tokens que OpenCode asume
  para proveedores personalizados — pensada para servidores locales que no informan su ventana
  (p. ej. llama.cpp); una ventana conocida (≤ 2M tokens) siempre la anula (compactación en
  `ventana × threshold`) y el usuario puede bajarla desde `/settings`.
- Recuperación del presupuesto de contexto tras una compactación insuficiente (Vitest, proveedores
  simulados, sin red): si tras compactar los mensajes conservados aún superan `limits.maxContextChars`,
  el runner reduce el contenido retenido contra un OBJETIVO TOTAL de caracteres
  (`objetivo = max(4 000, límite − instrucciones − herramientas)`), recortando primero los mensajes
  más grandes en rondas de límites descendentes (resultados de herramientas 8k → 4 096 → 2 048 →
  1 024 → 512; textos usuario/asistente 16k → 8 192 → 4 096 → 2 048 → 1 024; marcador
  `… [truncated by context budget]`, solo contenido: roles/IDs de llamada/fronteras intactos,
  revisado en el transcript persistido) y completa el prompt. Esto cubre también sesiones con
  MUCHOS resultados medios de herramientas (3–8k cada uno, p. ej. salidas MCP), que individualmente
  quedaban bajo los límites por mensaje y antes producían `truncated: 0` y el error fatal; el evento
  `context_reduced` informa cuántos mensajes se cortaron. Solo una sesión patológica (instrucciones +
  herramientas que ya superan el límite por sí solas, de manera que ni el suelo de 4 000 caracteres
  cabe) lanza el error accionable (tamaño aproximado + `/compact` + nueva sesión) y, como la
  reducción persiste, un prompt posterior en la misma sesión completa sin errores. El límite duro,
  el umbral de ventana, el respaldo de caracteres y la semántica de `shouldCompactContext` no
  cambian; los checkpoints (`summary`) nunca se cortan; el reducer es determinista (orden total
  estable: más grande primero, empates por posición).
- Versión en tiempo de ejecución (Vitest): un cargador por paquete lee la versión del propio
  `package.json` (`ALISIO_PACKAGE_VERSION` gana en binarios autónomos; `dev` si no hay manifest ni
  inyección). Metadatos de plugins, `user-agent` por defecto y el cliente MCP dejan de llevar
  literales de versión; un test de regresión falla si cualquier fuente de `packages/*/src` vuelve a
  contener una literal de versión de publicación.
- MCP: la auto-conexión de arranque con `mcp.allow:true` (o `--allow-mcp`) se verifica de extremo a
  extremo por stdio con una fixtura real: cada servidor `enabled` conecta sin tocar `/mcps`, los
  `disabled` no, los definidos en un `.alisio/config.json` de proyecto de confianza también, y
  `--read-only` lo bloquea todo.
- ripgrep ausente: el escenario `search` de integración se salta limpiamente cuando `rg` no está en
  el PATH (Vitest `skipIf` y guard en la fixtura independiente); `search_text`/`list_files` y
  `alisio doctor` explican cómo instalarlo por plataforma en lugar de un ENOENT crudo.
- Script de publicación (`scripts/publish.ts`, Vitest con directorios temporales y sin red): orden
  sdk → core → cli, rechazo del chequeo de fugas (manifiesto `workspace:`), dry-run sin efectos
  secundarios (no escribe ni publica), matemática del bump de versión (escritura atómica y
  restauración ante fallo) y error de paquete desconocido. El diagrama de flujo de herramientas
  `docs/assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp` (referenciado en
  `/tools` y `/es/tools`) es un binario sin rastrear que debe añadirse a git.
- Truncamiento (Vitest, proveedores simulados, sin red): los cuatro adaptadores (openai-compatible,
  deepseek, opencode, opencode-go) emiten `completed` con `truncated: true` cuando el corte
  (`finish_reason` `length`, `response.incomplete` o `stop_reason` `max_tokens`) dejó texto
  aprovechable y llamadas completas, y siguen lanzando con texto vacío, llamadas parciales o
  final abrupto; el runner completa una respuesta cortada sin llamadas con el evento
  `response_truncated` y `truncated: true` en `run_completed`, ejecuta las llamadas de un turno
  cortado y continúa, acepta un resumen cortado pero aprovechable como checkpoint parcial
  (`partial: true` en `compaction_completed`), falla con mensaje accionable cuando el resumen no
  produjo nada (`compaction.maxOutputTokens`) y usa `compaction.maxOutputTokens` (por defecto
  16000 en el esquema de configuración, 4096 si el runner se construye sin configuración), nunca
  el presupuesto del bucle del agente; la TUI muestra el aviso y el marcador `partial` (Vitest de
  reducción de eventos) y el esquema de configuración acepta el nuevo campo con su dato por
  defecto.

## Presupuesto de tokens de salida del agente: alcance de la verificación

- Cambio: `limits.maxOutputTokens` ahora tiene por defecto `16384` (antes `4096`) en el esquema de
  configuración y en el menú de ajustes (`/settings` → "Agent max output tokens"), porque un tope de
  4096 deja a los modelos con razonamiento (p. ej. DeepSeek) agotar todo el presupuesto en el
  razonamiento antes de producir texto útil; eso hacía fallar subagentes de exploración/auditoría con
  «cut off by max output tokens before any usable content» tras 20–50 s de trabajo.
- Nuevo: las sesiones hijas (subagentes) reciben un presupuesto de salida por llamada propio.
  `builtinPlugins.subagents.maxOutputTokensPerChild` (positivo, por defecto `16384`) se introduce en
  la especificación del hijo (`maxOutputTokens` en `ChildSessionSpec`), se persiste en sus opciones y
  se reenvía a cada llamada del runner; sin él, el hijo usaría el defecto global de 4096 del runner.
  El presupuesto acumulado `maxTokensPerChild` no cambia (sigue siendo la suma por ejecución, no el
  tope por llamada). El runner ahora acepta `maxOutputTokens` por ejecución en `RunOptions` y lo
  aplica delante del presupuesto del runner: opción por ejecución > opciones del runner > 4096.
- Mensajes: el error «raise limits.maxOutputTokens» y el aviso de la TUI ahora señalan también
  `/settings → Agent max output tokens`.
- Verificación (Vitest, sin red): esquema de configuración (`config-layers`, `subagents`); reenvío
  del presupuesto en hijos y rechazo de valores no positivos (`children-output-tokens`, `subagents`);
  regresión de la sesión principal que mantiene `limits.maxOutputTokens`; aviso de la TUI
  (`tui-state`); truncación sin cambios (la ruta de compactación conserva su propio presupuesto de
  16000).

## Límite de contexto frente al catálogo de herramientas y velocidad de salida: alcance de la verificación

- Límite duro posterior a la compactación corregido: ahora mide SOLO el contenido reducible
  (instrucciones + transcript), no el catálogo fijo de herramientas (`toolsText`). Antes, un
  catálogo grande (p. ej. un servidor MCP con ~95 herramientas y los tools asignables) podía valer
  100k+ caracteres por sí solo: el objetivo de reducción `max(4 000, límite − instrucciones −
  herramientas)` quedaba en el suelo de 4 000 y aun así `chars()` (con el catálogo) superaba el
  límite, matando la ejecución con «Context budget exceeded» incluso con un transcript casi vacío
  — la falla reportada en subagentes/exploraciones. Ahora `objetivo = max(4 000, límite −
  instrucciones)` y la comprobación fatal usa `instrucciones + JSON.stringify(mensajes)`; el
  catálogo es una realidad de despliegue (decisión de `/plugins`), no crecimiento de sesión, y el
  mensaje fatal (que solo se dispara si instrucciones + transcript siguen superando el límite tras
  la reducción) menciona `/compact`, recortar salidas grandes y desactivar servidores MCP
  innecesarios con `/plugins`. La compactación automática (`shouldCompactContext`) sigue midiendo
  la petición COMPLETA (ventanas y respaldo de caracteres protegen lo que el modelo ve,
  herramientas incluidas); solo el límite duro posterior y la reducción del transcript excluyen el
  catálogo. El evento `context_reduced` y todos los invariantes del reducer no cambian.
- Velocidad de salida corregida (`/exit`, doble Ctrl+C, Ctrl+D, SIGINT/SIGTERM): el cierre de
  `McpConnector` acota cada `client.close()` por servidor a 800 ms (el cierre stdio del SDK puede
  tardar ~4 s con un servidor que ignore la terminación) y toda la fase a 1500 ms, solo en el
  `close()` terminal; `disconnect()` en caliente conserva su semántica sin tope para el
  reconexado interactivo. `app.close()` ejecuta herdr+MCP en paralelo y luego proveedor+plugins
  (store al final), todo con `Promise.allSettled` y topes de etapa de 2500 ms, con el mismo
  tratamiento acotado en la ruta de error de `createApplication`. La TUI acota el apagado: turno
  en vuelo ≤ 3 s y hooks de fin de sesión ≤ 1,5 s al salir (el `/clear` conserva el límite
  completo de `pluginHooks.sessionEndTimeoutMs`).
- Verificación (Vitest, sin red): un sesión con `toolsText` de ~200k caracteres y transcript
  pequeño completa sin error fatal, sin `context_reduced` y sin compactar, y su transcript queda
  intacto (`runner-truncation`); el caso patológico irreducible (solo instrucciones) sigue
  fallando con el error accionable que ahora sugiere `/plugins`; `McpConnector.close()` vuelve en
  < 3 s frente a un servidor stdio real que ignora fin de stdin y SIGTERM (el SDK tardaría ~4 s),
  con registro limpio y estado `disconnected` (`mcp-close-timeout`, fixtura `mcp-slow-server`);
  `app.close()` vuelve en < 6 s aunque `dispose` de proveedor y plugin nunca resuelvan
  (`exit-speed`); `app.endSession` queda acotado por `sessionEndTimeoutMs` con un hook colgado
  (`exit-speed`); los topes de la TUI (3 s/1,5 s) están cubiertos por el helper `bounded`
  (`tui-exit`); suites existentes (MCP, consentimiento MCP en caliente, presupuesto de contexto,
  compactación, truncación, subagentes, tokens de salida por hijo, tui-state) sin cambios o con
  ajustes de redacción.
- Limitación documentada: un catálogo MCP enorme debe gestionarse con `/plugins` (desactivar el
  servidor; `/mcps` muestra el recuento de herramientas); el runner nunca corrompe un transcript
  sano por el catálogo, y la compactación automática con ventana desconocida sigue disparándose
  por la petición completa (herramientas incluidas) como protección del contexto real del modelo.

## Memoria y plugins: alcance de la verificación

- Pruebas automáticas (escenarios Bun y Vitest): store (upsert por `topic_key` con
  `revision_count` y sesión más reciente, filas independientes por proyecto y alcance,
  deduplicación dentro/fuera de la ventana, ranking, AND/any, alcance proyecto/personal y
  `all_projects`, redacción, límite de 50 000 caracteres, fijadas, línea temporal, prompts,
  resúmenes, borrado lógico y físico, reapertura); migración sobre una base de sesiones v2
  existente (versiones 1, 2, 100, idempotente); herramientas a través del plugin con política
  de solo lectura; compactación con extracción de memorias, JSON inválido, emparejamiento e
  IDs intactos, archivo `confirmed` y presupuesto de recuerdo; inyección al iniciar sesión
  dentro del presupuesto; contrato de hooks (invocación, campos extra, fallo aislado,
  timeouts con aborto, `model.complete`, nombres/efectos de plugins externos frente a
  integrados); memoria activada frente a desactivada (sin herramientas, prompt, comando,
  estado ni archivo; compactación genérica); selección de comandos de portapapeles con un
  spawner falso.
- Verificación manual en pseudo-terminal con servidor simulado: `memory_save` con
  `--read-only`, contador en la barra, `/memory` (lista, búsqueda, detalle), compactación con
  informe de memoria y archivo confirmado, desplazamiento con la rueda, copiar al seleccionar
  y `/copy` (con `DISPLAY` retirado, por lo que se ejercitó el respaldo OSC 52), `/stats`,
  `/help`, resumen al salir con `/exit` e inyección de contexto en el siguiente arranque.
- Proveedor simulado headless: el modelo guardó una memoria con `memory_save` en `--read-only` y,
  en una sesión nueva, respondió desde el contexto inyectado.
- No verificado: copia real mediante `xclip`/`wl-copy`/`pbcopy`/Windows (para no modificar
  el portapapeles del usuario); compactación automática con inferencia real; Windows/macOS.

## Pegado y adjuntos de imagen: alcance de la verificación

- Vitest: sniffing de PNG/JPEG/GIF/WebP por cabecera, límites de tamaño (5 MB) y cantidad (4),
  captions compactas, mensajes de rechazo, mapeo al tipo `Attachment` del SDK, y el flujo de
  `Ctrl+V` sin portapapeles (no-op explicado), con `getImage()` devolviendo `null` (vacío) o
  `undefined` (no disponible) tratados por separado, y un fallo de lectura capturado sin lanzar.
  Compactación: un adjunto en el tramo resumido se describe al modelo solo por tipo MIME y
  dimensiones (nunca sus bytes en base64), y uno conservado sobrevive intacto. Persistencia:
  cierre y reapertura de la base reproduce el adjunto byte a byte (JSON genérico existente,
  sin cambios de esquema). Proveedor: las partes `image_url` (chat) e `input_image` (Responses)
  se verifican contra un servidor HTTP local con la forma exacta que espera cada modo.
- Verificación real en pseudo-terminal (Linux, X11 disponible en este entorno) con el binario
  construido: un pegado multilínea real con marcadores de pegado con corchetes se insertó como
  una sola operación, sin fragmentarse ni enviarse antes de tiempo, y se envió correctamente al
  presionar Enter. Se colocó una imagen PNG real (no simulada) en el portapapeles X11 con
  `xclip`, `Ctrl+V` la adjuntó mostrando la línea compacta `[1] image/png 2x2, 0.1 KB` (el
  terminal de prueba no soporta gráficos Kitty/iTerm2), `Ctrl+R` la quitó, y al reenviarla y
  enviar el mensaje la petición HTTP capturada contenía la parte `image_url` con los bytes
  base64 decodificados **idénticos** a los del PNG original.
- Modo `--no-tui`: verificado con el mismo binario. El pegado de una sola línea funciona igual
  que escribir. Un pegado real de varias líneas (sin marcadores, tal como lo entrega una
  terminal real a un programa que nunca activó el pegado con corchetes) se fragmenta: cada línea
  se envía como un mensaje independiente, confirmado por la petición capturada. `Ctrl+V` es un
  no-op inocuo (el byte se descarta, sin insertar nada ni bloquear).
- Con un servidor local, una imagen PNG de 64×64 enviada como `image_url` conservó el formato exacto
  que produce esta implementación. Otro servidor local devuelve 400 para contenido de imagen; el SDK
  `openai` lanza un `BadRequestError` con mensaje legible que el runner ya convierte en un
  `run_failed` limpio (sin caída ni traza cruda).
- No verificado: recepción de imágenes por el portapapeles nativo en macOS o Windows (sin acceso
  a esas plataformas); miniaturas en línea reales en una terminal con protocolo Kitty o iTerm2
  (el entorno de prueba solo tiene xterm-256color, así que solo se ejerció la ruta de
  compatibilidad de texto).

## Preguntar al usuario (ask_user_question): alcance de la verificación

- Vitest: reductor puro del panel (`questions.ts`, 19 pruebas) — cursor inicial en la opción
  recomendada, navegación con vuelta, confirmar de selección única y múltiple (incluida la
  confirmación explícita sin nada marcado, distinta de omitir), omitir (Esc) solo la pregunta
  actual sin abortar el lote, retroceder restaurando la respuesta previa exacta sin borrarla,
  truncado de etiquetas y resumen final. `InteractiveQueue` (`queue.ts`, 8 pruebas) — orden FIFO
  estricto, un trabajo rechazado no bloquea el siguiente, retirada limpia de un elemento ya
  abortado antes de su turno o mientras espera en cola (la cola sigue avanzando tras el hueco),
  visibilidad de `current()`/`isQueued()`/`isWaiting()` para el panel de agentes. Escenario de
  integración (`fixtures/scenarios.ts`, `ask-user-question`): sin `ui` en absoluto y con
  `interactive()` en `false` fallan rápido sin invocar `askQuestions`; con una `ui` falsa
  interactiva, la petición reenvía `session`/`label`/`signal` y las respuestas se asignan de
  vuelta en el orden de las preguntas (incluida una omitida, que se traduce en `selected: []` con
  `skipped: true`, distinto de una selección múltiple vacía y explícita); validación de esquema
  (1-4 preguntas, 2-4 opciones) a través de `ToolRegistry.parse`; reglas de negocio en tiempo de
  ejecución (como mucho una opción `recommended`, etiquetas únicas por pregunta).
- Pseudo-terminal (Linux, xterm-256color) con un servidor simulado real: lote de dos preguntas
  (una de selección única con una opción `recommended` marcada visualmente, otra de selección
  múltiple) a 100 columnas — navegación con vuelta verificada (↑ dos veces desde la opción
  recomendada pasa por la primera y da la vuelta a la última), alternar con →, retroceder
  restaurando el cursor exacto de una pregunta ya confirmada, reavanzar, omitir con Esc la última
  pregunta (envía el lote sin abortarlo) y el bloque de resumen final con las etiquetas correctas.
  Confirmado también a 28 columnas con el flujo `/ask`: el modelo propuso 3 opciones marcando
  `Node` como recomendada, Enter la confirmó de inmediato y el resumen (`Runtime: Node`) se
  renderizó sin desbordar ni truncar mal a ese ancho.
- No verificado en pseudo-terminal (solo con pruebas unitarias de `InteractiveQueue`, que son
  deterministas y agnósticas de qué sesión pregunta): dos o más subagentes reales llamando a
  `ask_user_question` a la vez a través de `@alisio/plugin-subagents` y del panel de agentes real,
  con la migaja de pan mostrando qué agente pregunta y la retirada limpia de una pregunta en cola
  al cancelar ese subagente. El diseño y el enrutamiento (cola única, respuesta solo a la sesión
  exacta que preguntó) están probados de forma aislada pero no se ejerció con subagentes reales en
  una terminal; ver «Límites conocidos».
- No se intentó `/ask` con inferencia real autenticada (se priorizó el servidor simulado
  determinista, que permite fijar exactamente las opciones y así verificar cada tecla del panel;
  las tareas previas de este proyecto ya validaron por separado que DeepSeek responde de forma
  fiable a llamadas de herramientas).

## Herramientas de red (webfetch, websearch, execute): alcance de la verificación

- Escenarios de integración (Vitest, servidor HTTP local determinista vía `fixtures/http.ts`):
  `webfetch` — redirección seguida, HTML a markdown con script/style eliminados, rechazo de
  contenido binario/imagen, rechazo de esquemas no http(s), truncado con `fullTextPath` y
  verificación del texto completo en disco. `websearch` — cadena SearXNG con `searxngUrl`
  apuntando al servidor local, DuckDuckGo Instant Answer (con `fetch` global reemplazado
  temporalmente para no depender de la red), guarda SSRF (`validateSearxngUrl`), el nuevo punto de
  extensión `websearch` con prioridad ganando sobre lo integrado, su reintento seguro con
  diagnóstico ante un proveedor que lanza excepción, y la restauración de la cadena integrada al
  cerrar el `PluginHost`. `execute` — llamada exitosa a una herramienta permitida, denegación de un
  efecto no autorizado (sin tocar el sistema de archivos), éxito cuando la política sí lo permite,
  cumplimiento del timeout (con `timeoutMs` inyectable para pruebas rápidas), límite de 20 llamadas
  anidadas, prohibición de llamarse a sí mismo, y ausencia de `require`/`process`/`fetch`/
  `setTimeout` dentro del snippet aislado.
- Verificación real (Bun, sin clave alguna del entorno de Alisio expuesta): una llamada real a
  `https://example.com/` con `webfetch` devolvió HTML convertido correctamente a markdown
  (`# Example Domain`, enlace conservado); una llamada real a `execute` combinando
  `callTool("webfetch", ...)` dentro del snippet aislado con `policy.external: true` confirmó el
  contenido de la página y devolvió solo un resumen calculado (no la página completa). Una llamada
  real a `websearch` con `duckduckgo-instant` devolvió resultados reales para «Node.js» (tras
  ajustar el proveedor a un `User-Agent` de navegador y a detectar JSON por contenido en vez de por
  cabecera `Content-Type`, ya que la API de DuckDuckGo devuelve JSON válido con un
  `Content-Type: application/x-javascript` en ciertas condiciones).
- Hallazgo empírico nuevo sobre DuckDuckGo (2026-09): una solicitud automatizada a
  `https://html.duckduckgo.com/html/?q=...` devuelve HTTP 202 con un desafío de captcha, mientras
  que `https://lite.duckduckgo.com/lite/?q=...&kl=us-en` responde HTTP 200 con resultados reales y
  sin clave. Sobre esa base se añadió el proveedor `duckduckgo-html` (sin clave, sin cookies) con un
  analizador tolerante de HTML; su cobertura sin red (Vitest) incluye: extracción de 3+ resultados
  con URL destino decodificada desde `uddg`, entidades HTML decodificadas en títulos, fragmentos
  (`snippet`) extraídos y sin etiquetas, anclas no resultantes (anuncios/relacionados) ignoradas,
  respuesta de desafío/captcha (HTTP 202 o página no reconocible) que lanza un error accionable que
  nombra al proveedor y sus causas posibles, y una página lite legítima sin resultados que devuelve
  `[]`; `searchWithFallback` resuelve el proveedor tanto por config como el menú `/settings` lo
  lista. Una llamada real a `lite.duckduckgo.com/lite/` con el `User-Agent` de navegador del
  proveedor devolvió resultados reales para «node.js web framework».
- Hallazgo empírico honesto sobre el proveedor SearXNG por defecto (sin configurar nada): se
  probaron 9 instancias públicas distintas listadas en searx.space (incluida la que se dejó como
  URL por defecto, `searx.be`) con una única solicitud automatizada fresca cada una; **todas**
  devolvieron un captcha/verificación de bot (HTTP 200 con una página de desafío) o `429 Too Many
  Requests`. La cadena por defecto es correcta arquitectónicamente (sin clave, autoalojable, sin
  bloqueo de proveedor) pero en la práctica actual no debe asumirse funcional sin autoalojar una
  instancia propia; el mensaje de `limitation` del resultado y la documentación lo dicen así de
  forma explícita.
- No verificado: una llamada real a un proveedor de pago (`tavily`/`brave`/`serpapi`) — ninguna
  clave de esos servicios está disponible en este entorno y no se fabricó ninguna; solo se probaron
  con un servidor HTTP local simulando su forma de respuesta. Tampoco se verificó el modo `native`
  contra un proveedor real que lo soporte (la configuración de DeepSeek no lo
  soporta, como se documenta); su validación (`apiMode: "responses"` requerido) y el paso del tipo
  de herramienta nativa hacia la petición sí están cubiertos por el flujo normal de tipos y por
  inspección de código, no por una llamada real.

## Confianza de proyecto y permisos por defecto: alcance de la verificación

- Vitest (`fixtures/scenarios.ts`, escenario `project-trust`): un directorio sin recursos de
  proyecto nunca necesita confianza; un directorio con `.alisio/config.json` fresco marca
  `needsPrompt`; guardar una decisión de confianza hace que deje de pedirse; modificar el contenido
  de `.alisio/config.json` fuerza `needsPrompt` de nuevo con un hash distinto; una decisión de
  «no confiar» tampoco vuelve a preguntar; `listTrust`/`revokeTrust` reflejan y deshacen
  correctamente el estado, y revocar hace que vuelva a pedirse.
- Vitest (`fixtures/scenarios.ts`, escenario `permission-truth-table`): para `write_file`
  (`write`), `run_process` (`process`) y `webfetch` (`external`) por separado, con `AgentRunner`
  real ejecutando un turno completo contra un proveedor simulado — sin flag y con un manejador
  `approve` (igual que la TUI real) el efecto se ofrece y el manejador es preguntado de verdad;
  con el flag de permiso correspondiente, se permite sin preguntar nunca; sin manejador `approve`
  y con la política en `false` (equivalente a `--read-only`), la herramienta no se ofrece en
  absoluto.
- `fixtures/cli-e2e.ts` (Node y binario Bun): `alisio doctor` sin `--trust-project` contra un
  `.alisio/config.json` con una `baseURL` distintiva nunca la lee (usa el valor por defecto del
  esquema) y no crea ninguna entrada en el almacén de confianza; con `--trust-project` sí la lee,
  y tampoco persiste ninguna entrada (la confianza explícita de una ejecución sigue sin guardarse).
- Pseudo-terminal (Linux, xterm-256color) con un servidor simulado real: primera ejecución en un
  proyecto nuevo con `.alisio/config.json` muestra el aviso de confianza con el texto explicativo
  completo; aceptar («y») carga la configuración del proyecto (la TUI arranca mostrando el modelo y
  el host del servidor simulado del proyecto, y la cabecera muestra `write:ask process:ask`);
  una segunda ejecución no vuelve a preguntar; editar `.alisio/config.json` sí fuerza una nueva
  pregunta; declinar (tanto escribiendo «n» como pulsando Enter, que por defecto es «No») dejar
  la configuración sin cargar, verificado porque la aplicación falla entonces con el mismo error
  claro de siempre («Set ALISIO_MODEL, --model, or provider.model») en vez de usar el modelo del
  proyecto; un directorio sin ningún recurso de proyecto arranca sin ninguna pregunta de confianza.
- No verificado en pseudo-terminal de forma aislada (sí por inspección de código y por la prueba
  `permission-truth-table`): el selector de aprobación real apareciendo para `run_process`/
  `webfetch` específicamente sin ningún flag (se verificó explícitamente para `write_file`, que
  comparte exactamente el mismo mecanismo genérico que los otros dos efectos).
- No verificado: `alisio trust list`/`alisio trust revoke` en pseudo-terminal (sí se probó su
  lógica de forma aislada en Vitest); comportamiento en Windows/macOS.

## Agente activo y effort: alcance de la verificación

- Vitest: `tests/active-agent.test.ts` (catálogo y resolución del agente activo, opciones por
  ejecución —el `plan` inyecta su prompt de sistema vía `RunOptions.instructions` y acota a solo
  lectura con `policy`/`approvals`—, resolución del effort por modelo con respaldo silencioso al
  `defaultLevel`, validación de `/effort [nivel]`, filas del selector y piezas de la línea de
  estado con roles de color, truncación y omisión del segmento de effort sin niveles soportados,
  comandos reservados `/agents` y `/effort`, y publicación de definiciones principal-capaces por el
  plugin de subagentes a través de `pluginState`); `tests/deepseek-effort.test.ts` (fixture HTTP
  local: `reasoning_effort` en Chat Completions y `reasoning.effort` en Responses, presentes solo
  cuando se fija el valor); `tests/settings-persistence.test.ts` y `tests/config-layers.test.ts`
  (claves `agents.active`/`agents.effort` en el esquema, el allowlist estricto y el escritor
  atómico, con el valor por defecto `build`); `tests/subagents-defs.test.ts` (`mode` en
  `--agents <json>`). Sin red: los catálogos reales de DeepSeek no se consultan en las pruebas.
- No verificado en pseudo-terminal: la interacción visual del selector `/agents` y del picker de
  `/effort` (sí su lógica pura y las piezas de estado), ni el envío efectivo del effort contra la
  API real de DeepSeek (sí el cuerpo de la petición contra el servidor de pruebas).

## Agentes del usuario: alcance de la verificación

- Vitest: `tests/agent-definitions.test.ts` (validación, ids, archivo Markdown legible por el
  parser de subagentes sin avisos, conservación de claves y comentarios ajenos, archivos
  inválidos, mezcla de ámbitos con reemplazo, `live` con registro falso, recarga real con la
  aplicación y el plugin de subagentes —el agente aparece y desaparece sin reiniciar— y aviso de
  reinicio sin plugin, capacidades y ajuste, borradores y plantillas);
  `tests/server-agents.test.ts` (CRUD HTTP en ambos ámbitos, `/api/agents` y `/api/commands`
  reflejan el agente al momento, validación, `--read-only`, `live: false` sin plugin, modelos,
  borrador con la guía incluida y con una skill `create-agent` descubierta, crear → sesión nueva
  con el agente y sus instrucciones/effort en la siguiente petición, `/agent:<id>` y vuelta a
  `build`, filtro `?agent=`, confianza desde la web con confirmación —los agentes de proyecto se
  cargan y se descargan al retirarla—, primer agente de un workspace confiado sin recursos y
  rechazo con `--read-only`); `tests/tui-agent-manager.test.ts` (verbos de `/agents`, filas e
  insignias del selector, filtro, filas del editor según capacidades, ajuste al guardar,
  instrucciones en una línea, registro de `/agent:<id>` y regla de colisión en el catálogo);
  `tests/web-agents.test.ts` (formulario, guardar solo con cambios válidos, ajuste por
  capacidades, `curl` de la API propia, resaltado, pasos de inicio, filtro e insignias del
  selector, cliente API con cancelación y paridad de i18n).
- Verificado a mano en navegador (Playwright contra `alisio serve` aislado): entrada Agentes
  encima de Ajustes, lista con plantillas, editor a dos columnas con el panel de configuración y
  los pasos, y aviso de workspace no confiable.
- No verificado: la generación con un modelo real (solo con proveedor de prueba), la interacción
  visual completa de la TUI en pseudo-terminal (sí su lógica pura) y Windows/macOS.

## Rutas externas y aprobación de directorios: alcance de la verificación

- Vitest: `tests/external-paths.test.ts` (unidad de `PathAccess`: dentro del workspace, raíz extra
  declarada, aprobación por directorio contenedor con cobertura de subárbol en modo sesión,
  `once` acotado al archivo, denegación con ruta y remedios, modo no interactivo sin aviso,
  `--read-only` sin raíces extra ni aviso, endurecimiento de symlinks y mensaje con la ruta;
  integración con `createApplication` y un proveedor simulado: lectura externa aprobada, lectura vía
  `--add-dir`, lectura vía `additionalDirectories`, denegación headless con `--add-dir` y
  `additionalDirectories`, `--read-only` bloqueado con `--add-dir`, y la escritura externa que sigue
  exigiendo su política de escritura); `tests/config-layers.test.ts` (fusión aditiva de
  `additionalDirectories`, incluido que un array vacío en una capa inferior no borra la global, y
  canonización/orden).
- La mediación reutiliza `safePath` (sin symlinks, `lstat` por segmento) y es mediación, no un
  sandbox del sistema operativo; no es a prueba de carreras frente a procesos hostiles concurrentes.
- No verificado en pseudo-terminal: la interacción visual del aviso de directorio externo (sí su
  lógica con un decisor inyectado). Las llamadas anidadas de `execute` nunca abren un aviso nuevo:
  solo alcanzan directorios ya aprobados para la sesión.

## Contratos de eventos y bloques UI: alcance de la verificación

- Vitest: `tests/run-events-contract.test.ts` ejecuta el `AgentRunner` real con `SQLiteStore` y un
  proveedor simulado (razonamiento, texto, llamada con aprobación, progreso, segundo turno, fallo,
  cancelación, cambio de modelo y compactación omitida) y valida cada evento contra un espejo en
  tiempo de ejecución de `RunEventDataMap` (exhaustivo por tipo en compilación); comprueba que los
  eventos durables llevan `eventId` igual a `events.seq`, que los efímeros no, que `seq` sigue siendo
  por ejecución, que `runId`/`correlationId` se propagan y que un store que no devuelve nada deja los
  eventos sin `eventId`. `tests/ui-blocks-fallback.test.ts` renderiza cada kind nuevo en la TUI (con
  y sin Unicode) y en la proyección de texto, y comprueba que un kind desconocido o mal formado no
  lanza.
- No verificado en pseudo-terminal: el aspecto visual de los nuevos bloques en la TUI (sí sus
  líneas). Ningún productor integrado emite todavía los kinds nuevos (las herramientas los añadirán
  en la fase 4). `ttftMs` mide hasta el primer delta de texto o razonamiento; un proveedor que solo
  entrega la respuesta completa no lo informa. Los tipos del protocolo web no tienen implementación
  todavía y pueden cambiar hasta que exista `@alisio/server`.

## Persistencia v4, blobs y catálogo de comandos: alcance de la verificación

- Vitest: `tests/store-migration-v4.test.ts` construye una base v3 con el DDL antiguo y datos, la abre
  con `SQLiteStore` (sin pérdida de filas, versión 4 registrada, migración idempotente al reabrir),
  comprueba la unicidad de `runs` por `(session, request_id)` (reintento devuelve la ejecución
  existente; el índice parcial rechaza un duplicado directo), la transición `queued` → `running` →
  terminal sin sobrescribir un estado terminal, `interruptRuns` (solo dueños muertos o ausentes; se
  conservan los de este proceso y los de otro proceso vivo), marcas de tiempo de sesiones raíz,
  columnas nuevas de `tool_calls`, paginación de mensajes y eventos, el registro de ejecuciones del
  runner (completada, preasignada en cola, fallida, cancelada, `turns_exceeded`, store sin métodos
  opcionales) y la reconciliación en `createApplication`. `tests/blobs.test.ts` cubre deduplicación,
  permisos `0600`/`0700`, hashes inválidos, contenido manipulado, la resolución a base64 que llega al
  proveedor y los adjuntos en línea heredados. `tests/command-catalog.test.ts` cubre fuentes,
  superficies, alias, colisiones y los manejadores core; `tests/command-catalog-tui-parity.test.ts`
  compara la lista de comandos, la resolución y la salida de `/tools` y `/sessions` con las
  implementaciones previas de la TUI.
- Bun: el escenario `store-migration` de `fixtures/scenarios.ts` (ejecutado en Node y Bun por
  `tests/integration.test.ts`) verifica la migración y el índice único parcial en Bun, y
  `pnpm test:compiled` comprueba que el binario Bun escribe filas en `runs` al ejecutar `alisio run`.
- No verificado: la TUI en pseudo-terminal tras delegar `/tools` y `/sessions` (sí su texto).
  `workspaces`, `sessions.pinned`/`archived_at`, `messagesPage` y `eventsPage` los consume
  `@alisio/server` (ver la sección del servidor web).

## Servidor web (`alisio serve`): alcance de la verificación

- `/btw`: `tests/side-questions.test.ts` (núcleo y catálogo: sin escrituras en `messages`, `events`,
  `runs`, `tool_calls` ni en el uso de la sesión; funciona con la sesión ocupada; cancelación;
  errores del proveedor; validación; límite de 20; recorte al presupuesto; precedencia del built-in;
  línea de uso), `tests/server-side-questions.test.ts` (HTTP real en puerto efímero con proveedor
  falso: pregunta durante un run, validación, cancelación explícita y por desconexión del cliente,
  502, ruta de comandos), `tests/tui-btw.test.ts` (estado puro y render del panel) y
  `tests/web-btw.test.ts` (intercepción del compositor, navegación, cliente de la API). Verificado a
  mano: la TUI y el modo `--no-tui` en tmux, y la web con Playwright contra un proveedor
  OpenAI-compatible simulado (pregunta durante un run, transcripción intacta tras recargar,
  navegación, cancelación, línea de uso, 390 px de ancho). No hay arnés de pseudo-terminal
  automatizado para la TUI.
- Vitest, con el servidor real en un puerto efímero, base de datos temporal y proveedor falso
  inyectado por `AppOptions.provider`: `tests/server-auth.test.ts` (T-07: cookie ausente, canje del
  token con 303, token erróneo, `Host` y `Origin` ajenos, `Content-Type`, `--allow-remote`, salud,
  cabeceras, assets estáticos, fallback SPA y confinamiento de rutas), `tests/server-workspaces.test.ts`
  (T-18), `tests/server-prompts.test.ts` (T-09: idempotencia secuencial y concurrente, `enqueue`,
  `session_busy`, `session_locked` con un PID vivo ajeno, cola FIFO con `--max-runs 1`,
  cancelación en cola y en curso, compactación), `tests/server-sse.test.ts` (T-08: snapshot y
  deltas sin huecos, reconexión a mitad de ejecución sin duplicar texto, `tool_result`, estado de
  sesión para el sidebar, latido, límites; el desbordamiento con `resync` se prueba sobre el hub con
  un socket que no drena), `tests/server-approvals.test.ts` (T-10) y `tests/server-shutdown.test.ts`
  (T-13, apagado llamado en proceso). `tests/store-web-metadata.test.ts` cubre los métodos nuevos
  de `SQLiteStore`.
- Workspaces archivados: `tests/store-migration-v5.test.ts` (bases v4 y v3 migradas a v5,
  idempotencia, workspace conocido solo por sesiones) y el bloque "archived workspaces" de
  `tests/server-workspaces.test.ts` (filtro `archived`, cierre de la aplicación, `409 runs_active`
  con un proveedor retenido, `409 workspace_archived`, carpeta desaparecida, desarchivado al
  reabrir); la agrupación de la barra lateral en `tests/web-api-sessions.test.ts`.
- Selector de carpetas: `tests/folder-picker.test.ts` prueba, en cualquier sistema anfitrión, la
  búsqueda en `PATH` (delimitadores y `PATHEXT`), la elección de herramienta por plataforma, los
  argumentos exactos de zenity/kdialog/yad/osascript/PowerShell, el análisis de la salida de los
  tres sistemas (barra final de macOS, barras invertidas y raíces de unidad de Windows, CRLF) y la
  detección de cancelación, además de migas de pan y carpeta superior con `path.win32` y
  `path.posix`. `tests/server-folder-picker.test.ts` usa un selector falso inyectado (nunca abre un
  diálogo real): ruta elegida, cancelado, `409 picker_busy`, `503 picker_unavailable`, desactivado
  con `--allow-remote`, y el explorador (`404`, `403` con un directorio sin permisos, sin archivos,
  cookie obligatoria). **El diálogo nativo no se abre en ninguna prueba automatizada**: en
  Linux/GNOME solo se comprobó la detección (`zenity --version`) y el diálogo real queda pendiente de
  verificación manual; macOS y Windows quedan cubiertos únicamente por los tests de construcción de
  comandos y análisis de salida. El listado de unidades de Windows no se ha ejecutado en Windows.
- T-12 (`tests/startup-no-server.test.ts`): ejecuta el código fuente de la CLI en Node con un hook
  `module.registerHooks` que registra cada módulo resuelto y comprueba que `--help`, `run`, el modo
  sin argumentos y `serve --help` no cargan `packages/server` ni `node:http`. Bun no tiene un hook
  equivalente: en el binario solo se comprueba `serve --help`.
- `pnpm test:cli` (Node) y `pnpm test:compiled` (binario Bun): `serve --help`, rechazo de
  `--host 0.0.0.0` sin `--allow-remote`, arranque con `--no-open --port 0`, `/api/health` sin
  cookie, `401` sin cookie, canje del token y parada con `SIGTERM` (código 0).
- `tests/server-web-routes.test.ts`: catálogo web sin comandos solo de TUI, ejecución de comandos
  `core`, expansión de plantillas y `/ask`, `/help`, `/clear` con sesión nueva, `/effort` por
  sesión, `unknown_command`, idempotencia, `session_busy` de `/model` durante una ejecución, modelos
  (con y sin catálogo), contexto con ventana conocida, exportación JSONL ordenada, título derivado
  del primer prompt y agente `plan` aplicado (instrucciones y sin `write_file`).
- Interfaz web: Vitest sin DOM sobre los módulos puros — `tests/web-transcript-store.test.ts` (T-15:
  snapshot, deltas, `message` que sustituye el eco local y el texto en curso, resultados de
  herramientas en cualquier orden, avisos, notas locales tras un snapshot, páginas anteriores),
  `tests/web-events.test.ts` (lotes por frame, reapertura por cambio de sesiones y tras `resync`,
  backoff, `nudge`, protocolo distinto), `tests/web-markdown-incremental.test.ts` (T-16: mismo
  resultado que un parseo completo con cualquier tamaño de trozo, identidad de bloques congelados,
  fence sin cerrar, fences especiales), `tests/web-composer.test.ts` (paleta, historial,
  aprobaciones pendientes, todos los kinds de `UiBlock` con renderer y paridad de claves y
  marcadores EN/ES), `tests/web-api-sessions.test.ts` y `tests/web-tools.test.ts`.
- Prueba manual con Playwright (Chromium) contra `node packages/cli/dist/main.js serve` y un
  proveedor OpenAI-compatible simulado: canje del token, crear sesión, streaming con razonamiento,
  dos lecturas y Markdown con tabla y código resaltado, fallo de herramienta visible, panel de
  aprobación con foco y respuesta por teclado (`O`) que devuelve el foco al compositor, paleta `/` y
  `/stats`, tema claro tras recargar y ancho de 390 px sin desbordamiento horizontal; consola sin
  errores. No verificado: lectores de pantalla reales, Firefox/Safari, otros sistemas, la
  interacción de preguntas de plugins en un navegador (solo sus reductores), la reconexión tras un
  corte de red real y el rendimiento con sesiones de 10 000 mensajes.
- No verificado: la apertura automática del navegador, el apagado por señal con ejecuciones activas
  fuera de las pruebas en proceso, Windows/macOS y la contención de SQLite con varias apps y runs
  concurrentes reales (P-03).
- Fase 4: `tests/server-files.test.ts` (T-11: orden y tamaños del árbol, páginas de 1 000,
  `.gitignore`, traversal con `..`, rutas absolutas y symlinks de directorio y de archivo hacia
  fuera → 403 sin filtrar contenido, 404, truncado a 2 MB y descarga completa, detección de
  imágenes, SVG y binarios, cambios de la sesión con estado git, diff frente a `HEAD`, archivo sin
  seguimiento y `409 not_a_git_repo`), `tests/server-blobs.test.ts` (detección y dimensiones de
  PNG/JPEG/GIF/WebP, deduplicación, 415 por contenido y por tipo declarado, vacío, `Origin` ajeno,
  401, 413 por encima de 10 MB, servicio con tipo y caché, y T-09: un prompt con `BlobRef` llega al
  proveedor como adjunto base64 y un hash desconocido da 400), `tests/standard-tools-ui.test.ts`
  (parches unificados, bloques de las cuatro herramientas con el texto intacto como primera parte,
  límite de 200 KB y la TUI sin esos bloques), `tests/web-renderers.test.ts` (parser de parches,
  diff Myers, filas lado a lado, SGR, `\r`, JSONPath y resumen de tests),
  `tests/web-renderer-registry.test.ts` (T-17), `tests/web-dock.test.ts`,
  `tests/web-attachments.test.ts`, `tests/web-stats-trajectory.test.ts` (RF-16 y agrupación de la
  trayectoria) y T-15 ampliado (miniaturas y sustitución del eco con adjuntos). Los componentes
  Preact no tienen pruebas con DOM: se verificaron a mano con Playwright (Chromium, 1440 px y
  390 px) contra `alisio serve` con un proveedor OpenAI-compatible simulado y un plugin local que
  devuelve bloques `test-results`, `json`, `progress` y un kind desconocido: diff de
  `write_file`/`edit_file`, salida ANSI de `shell` con 2 306 líneas y "mostrar todo", código de
  salida, árbol JSON de un fence largo, fallback de kind desconocido, panel de archivos (árbol sin
  `dist/` ni `*.log` ignorados, vista previa de código, imagen y Markdown, Cambios con estado git y
  diff frente a `HEAD`), subida de una imagen con `+` que llega al proveedor como `image_url`,
  miniatura persistida tras recargar, Trayectoria con duraciones y línea de estadísticas; consola
  sin errores ni avisos y sin desbordamiento horizontal a 390 px. La prueba encontró y corrigió dos
  defectos: el límite de 48 KB del runner medía también los bloques de visualización (ahora mide
  la proyección de texto) y la tabla de la trayectoria ocultaba la columna de duración. No
  verificado: rendimiento del árbol con 50 000 entradas reales en el navegador, `git`
  ausente y lectores de pantalla.
- Fase 5: `tests/web-rich-renderers.test.ts` (T-17: opciones de KaTeX, display/inline, error de
  análisis → fuente y mensaje, `\href{javascript:}` sin enlace, fallo inesperado del motor;
  configuración estricta de Mermaid, SVG saneado, diagrama inválido sin llamar a `render`),
  T-16 ampliado (`\( … \)` en línea, `$` de precios, `\(` sin cerrar, código en línea,
  ` ```math ` y `$$` durante el streaming), `tests/web-tools.test.ts` (etiquetas de tools de
  plugins), `tests/provider-credentials-store.test.ts` (máscara, estado sin valores, 0600,
  borrado, perfil sin cambiar el activo, metadatos de ajustes), `tests/server-management.test.ts`
  (plugins con tools/comandos, reciclado inmediato y diferido hasta el fin del run,
  `catalog_changed` y paleta actualizada, 400/403/404, workspace no confiable, skills fuera de la
  paleta y sin rutas, MCP sin comando ni argumentos, `mcp_not_permitted`, consentimiento que exige
  `confirmed: true`, agentes y ajustes con validación) y `tests/server-secrets.test.ts` (T-14:
  recorre todas las respuestas de gestión, sus cabeceras, los frames SSE y las líneas de log
  buscando dos claves guardadas; `credentials.json` en 0600; `source: "env"` sin `tail`; perfiles
  sin valores secretos; activación real y `409 runs_active`). Verificado a mano con Playwright
  (Chromium, 1400 px) contra `alisio serve --trust-project` con un proveedor OpenAI-compatible
  simulado, un plugin de proyecto, una skill y un servidor MCP inexistente: diagrama Mermaid en
  oscuro y claro, pantalla completa, fórmulas en línea y en bloque, fallback de Mermaid y KaTeX
  inválidos, cada página de Ajustes, "Abrir archivo de configuración", guardar una credencial (ni
  el DOM, ni `localStorage`, ni `/api/providers` contienen el valor; solo `…XYZ`), activar
  `fake-small`, deshabilitar el plugin y la skill (la paleta `/` pierde `/smoke-tools:smoke-hello`
  y `/skill:tidy`), conceder MCP y ver el fallo de conexión saneado. La prueba encontró y corrigió
  fuentes de KaTeX inlineadas como `data:` que la CSP bloqueaba. No verificado: 390 px del modal de
  Ajustes, lectores de pantalla, Firefox/Safari y un servidor MCP real conectado desde la web.

## Análisis en Python y artefactos (fase 1): alcance de la verificación

Fase 1 de `specs/archive/alisio-data-analysis-runtime-v1.2.md` (§21): `python_run`, `artifact_create`,
`artifact_list`, capability `analysis.run` con permisos persistidos, `--allow-analysis`,
`--python`, migración v6, rutas de artefactos y permisos, tarjeta de descarga y popover de
permisos en la web, anuncio, `/artifacts` y `/permissions` en la TUI.

- Decisiones del propietario (§23.2) adoptadas según la recomendación del documento y **confirmadas
  por el propietario el 2026-10-01**: D1 core (no plugin), D2 `analysis.enabled` activo por defecto, D3 el permiso
  de sesión persistido aplica en `resume` headless, D4 flag `--allow-analysis`, D5 contenido de los
  extras (`analysis`/`science`, lockfiles con hashes generados con `uv pip compile --universal`),
  D7 helper XLSX como efecto `read` (fase 3; sin efecto aún), D8 origen separado del visor
  diferido, D11 tabla `datasets` creada en v6, D12 `ctx.artifacts` solo para built-ins (el host
  de plugins lo retira, junto con `capability`, de las herramientas de plugins externos), D14 sin
  devolver imágenes al modelo.
- Vitest: `store-migration-v6` (v5 con datos → v6 sin pérdida, idempotencia, `CHECK`, raíz de
  sesión), `artifact-kinds` (extensión frente a bytes; conflicto → `file`), `artifact-store`
  (copia byte a byte, dashboard multiarchivo, ZIP de carpeta, `outputs.json`, idempotencia por
  ejecución, rechazo completo por symlink, hard link, `..`, `maxFiles` y `maxFileBytes` sin filas ni
  carpetas), `zip-writer` (CRC, nombres UTF-8; `python -m zipfile -t` cuando hay Python),
  `analysis-install-hints` (Windows, macOS con y sin Homebrew, Debian/Ubuntu, Fedora/RHEL, Arch,
  openSUSE, Alpine, otro Linux, Python < 3.10), `analysis-runtime-discovery` (arranque sin
  procesos, una sonda y `discovery.json`, caché por `mtime`, orden `--python` → `uv` → `py -3` →
  `python3` → `python`, alias de Microsoft Store, `PATHEXT`, intérprete del venv por plataforma),
  `analysis-python-run` (intérprete falso portable en `fixtures/fake-python.mjs`: dos
  `artifact_published`, separación de scripts/logs, entorno sin claves, salida ≠ 0,
  `publishOnError`, `timed_out`, cancelación ≤ 6 s, rechazo sin publicar, `runtime_unavailable`;
  más un caso con Python real que se salta si no hay Python 3.10+), `analysis-capabilities`
  (matriz de §10.3 con una `Application` real), `analysis-runtime-sources`, `server-artifacts`,
  `server-capabilities`, `web-artifacts-store`, `tui-artifacts`, `open-path` y ampliaciones de
  `run-events-contract`, `ui-blocks-fallback`, `command-catalog-tui-parity` y `server-approvals`.
- Verificado a mano el 2026-10-01 en Linux (Ubuntu 22.04, Python 3.10.12 encontrado vía `uv`) con
  el CLI compilado y un proveedor OpenAI-compatible simulado: `alisio run --allow-analysis --json`
  emite tres `artifact_published` con `path`; sin `--json` imprime las líneas `artifact: …`;
  `alisio analysis status` muestra el intérprete y, con `--python` inexistente, el motivo y la
  guía; en `alisio serve` (Playwright, Chromium) el panel de aprobación muestra el título, la
  advertencia y el script, **S** guarda el permiso, aparecen las tarjetas bajo la herramienta
  (también tras recargar), la descarga desde el botón y desde la tarjeta entrega los bytes
  publicados, y el popover lista y revoca el permiso. No verificado: Windows y macOS (el job
  `portability` de CI ejecuta las pruebas marcadas), la TUI interactiva en un terminal real,
  `alisio analysis setup --extras` (requiere red; los lockfiles se generaron pero no se instalaron)
  y lectores de pantalla.

## Análisis en Python y artefactos (fase 2): alcance de la verificación

Fase 2 de `specs/archive/alisio-data-analysis-runtime-v1.2.md` (§21): comodín del router, visor aislado
`/artifact-view/<token>/*` con enlace firmado (HMAC con el secreto del proceso, 10 min), rutas
`files/*`, `view`, `export`, `sources` y `DELETE`, `runToolCall` (un run sin modelo con las mismas
puertas que una llamada del modelo), `artifact_read` y `artifact_export`; en la web "Abrir archivo"
en las tarjetas previsualizables, `ArtifactPanel` con asa compartida con el Dock, desplegable,
menú, pantalla completa, expandir, renderers por tipo, modo estrecho, Detalles y `/artifacts`; en
la TUI "Preview here", "Copy to workspace…", "Reveal analysis sources" y "Details".

- Vitest: `server-http` (comodín del router), `server-artifact-view` (CSP exacta, sin
  `X-Frame-Options`, `CORP cross-origin`, `private, no-store`, token caducado o falsificado → 403,
  token de A sin acceso a B, `..`, `%2e%2e%2f` y rutas absolutas → 404, `Host` inválido → 403,
  solo GET/HEAD, tokens ausentes de los logs, PDF sin `sandbox`, `files/*` en línea salvo HTML,
  `sources` con y sin `?logs=1`, `DELETE`), `server-artifacts-export` (aprobación `write` en la web,
  archivo en `Changes`, transcripción válida, `409 runs_active`), `artifact-tools`
  (`artifact_read` truncado y confinado a la sesión, `artifact_export` con y sin `--allow-write`,
  separadores `\` y `/`, sin sobrescribir, confinado al workspace, carpeta multiarchivo, ausente con
  `--read-only`), `web-artifact-panel` (`clampPanelWidth`, pasos de teclado, ancho guardado con
  almacenamiento que lanza, exclusividad de la ranura derecha, `cardSubtitle`, renderer por tipo,
  imágenes relativas de Markdown, filtro y caché de enlaces), `tui-artifact-preview` (límites,
  leyenda, `truncated`, desplazamiento y teclas) y ampliaciones de `tui-artifacts`,
  `web-artifacts-store` y `command-catalog`.
- Verificado a mano el 2026-10-01 en Linux con Chromium (Playwright), `alisio serve` compilado y un
  proveedor OpenAI-compatible simulado que publica un Markdown, un dashboard HTML, un JSON y un
  binario: en reposo la tarjeta muestra el tipo y con hover o foco de teclado "Abrir archivo" (el
  binario nunca); el clic abre el panel (`aria-expanded="true"`) y la descarga no lo abre; el asa
  respeta 320 px y el máximo (viewport − sidebar − 360), ←/→, Shift, Inicio/Fin, doble clic y
  arrastre, y el ancho persiste tras recargar; el desplegable lista los artefactos con el actual
  marcado y cambia con flechas y Enter; Descargar, Pantalla completa (`aria-pressed`) y Cerrar (el
  foco vuelve a la tarjeta); Esc cierra primero el menú; abrir el Dock cierra el panel y viceversa;
  con Ajustes abiertos el panel queda `inert` sin recargar el iframe; a 600 px es un diálogo modal
  con el foco atrapado; Expandir oculta el chat; Copiar al workspace pide la aprobación y el archivo
  aparece en Cambios; Eliminar confirma y la tarjeta pasa a "Eliminado"; `/artifacts dash` abre el
  panel filtrado. El dashboard de prueba, dentro del iframe y en una pestaña nueva, no pudo leer
  `document.cookie` ni `localStorage` (`SecurityError`), su origen es `null` y `fetch` a
  `/api/sessions` y a un sitio externo falló por `connect-src 'none'`; en el iframe
  `parent.document` lanzó `SecurityError` (en la pestaña nueva `parent` es la propia página). No
  verificado: Firefox y Safari, Windows y macOS (`explorer.exe /select,` y `open -R` solo tienen
  pruebas de construcción de argumentos), la TUI interactiva en un terminal real y lectores de
  pantalla.

## Datos tabulares con `node:sqlite` (fase 3): alcance de la verificación

Fase 3 de `specs/archive/alisio-data-analysis-runtime-v1.2.md` (§21): ingesta de CSV, TSV, JSON, JSONL y
XLSX en un archivo SQLite por dataset, `data_inspect` y `data_query`, guardia SQL, rutas de datasets
y frames `dataset_ready`/`dataset_failed`, subida desde el compositor web con chips y resumen en el
prompt, `SpreadsheetView` (también para artefactos `spreadsheet`), helper XLSX en Python con la
biblioteca estándar (D6, opción B), `datasetId` en `python_run` y `alisio_runtime.datasets`.

- Desviaciones del documento (editadas en la especificación): el motor de datos es un **proceso
  hijo**, no `worker_threads`, porque `worker.terminate()` no interrumpe una llamada nativa de
  SQLite (comprobado en Node 22.19 y Bun 1.4.2 con una CTE recursiva infinita); el límite de tiempo
  mata el proceso. El motor se empaqueta en `engine-source.ts` (regenerar con
  `node --experimental-strip-types scripts/analysis-data-engine.ts`; un test detecta el desfase). El
  cursor de página es `[rowid]`. `node:sqlite` enlaza todo número como REAL, así que los enteros se
  enlazan como BigInt. La migración v6 no cambió. No hay `ingest.ts`/`query.ts` separados.
- Fuera de esta fase por §21/§18: la página **Data analysis** de Settings y las claves editables de
  `analysis` (fase 4, con la retención).
- Vitest: `data-csv-parser` (RFC 4180, trozos arbitrarios, delimitador, codificaciones, conversión
  sin pérdida), `data-sql-guard` (tabla de aceptadas/rechazadas), `data-ingest` (valores exactos,
  BOM UTF-8/UTF-16, CRLF, `;`, windows-1252, nombres, filas irregulares, JSONL con claves tardías,
  límites sin dataset parcial, reutilización por sha256, borrar y reemplazar con el motor activo,
  lectura con `sqlite3` de Python), `data-query` (solo lectura, truncado, CTE recursiva detenida en
  ≤ `queryTimeoutMs + 1 s` y consulta siguiente válida, dataset de otra sesión → `not_found`),
  `data-rows` y `web-spreadsheet` (keyset con empates, NULL y tipos mezclados sin duplicados ni
  huecos, filtro, saltos, `maxInteractiveRows`), `data-xlsx` (hojas, fechas, épocas, fórmulas,
  equivalencia con el CSV exportado, zip bomb, DOCTYPE, `maxRows`; sin Python →
  `dataset_unsupported`), `data-tools` (herramientas con un runner real y `python_run` con
  `datasetId`), `server-datasets` (subida, esquema, páginas, límites, resumen del prompt, artefacto
  perezoso y **1 000 000 de filas con `/api/health` < 100 ms y latido SSE estable**),
  `analysis-data-engine-sources`, `web-attachments`, `web-transcript-store`, `artifact-kinds` y
  `tui-artifact-preview`. `fixtures/cli-e2e.ts` ejecuta `data_inspect` + `data_query` con Node y con
  el binario Bun (que se relanza como su propio motor con `BUN_BE_BUN=1`).
- Verificado a mano el 2026-10-01 en Linux con Chromium (Playwright), `alisio serve` compilado y un
  proveedor OpenAI-compatible simulado: se adjuntó un CSV de 4 000 filas (con `007`, `N/A`, vacíos y
  comillas), el chip mostró `4,000 filas × 5 columnas` y el mensaje no se duplicó al llegar el
  durable; el modelo llamó a `data_inspect`, `data_query` y `python_run { inputs: [{ datasetId }] }`,
  cuyo script leyó el mismo archivo con `sqlite3` (intento de `DELETE` → solo lectura) y publicó un
  dashboard y un CSV; el chip abre `SpreadsheetView` con 4 001 filas aria, orden por cabecera
  (`aria-sort`, ascendente/descendente), recorrido por todo el rango, flechas, Ctrl+C y Ctrl+Mayús+C
  (celda y fila en TSV), filtro con recuento (207 coincidencias) y el artefacto CSV generado se abrió
  en la vista (ingesta perezosa). Sin errores en la consola. No verificado: Windows y macOS (el job
  `portability` ejecuta las pruebas de datos), Firefox y Safari, la TUI interactiva en un terminal
  real, lectores de pantalla, el efecto de `PRAGMA hard_heap_limit` y el redimensionado de columnas
  con el puntero (solo probadas las funciones puras).

## OCI, extras, retención y rerun (fase 4): alcance de la verificación

Fase 4 de `specs/archive/alisio-data-analysis-runtime-v1.2.md` (§21): runtime `oci` opcional (Docker o
Podman, imagen fijada por digest), instalación de extras bajo demanda con la capability
`analysis.install`, `AnalysisJanitor` (retención de artefactos, datasets, originales en `blobs/` y
trabajos internos), `Rerun` con procedencia (modelo y proveedor incluidos), la página **Análisis de
datos** de Ajustes y las claves `analysis.*` editables (con claves de tres niveles en
`setConfigValue`). Decisiones del propietario: D1–D14 según la recomendación, confirmadas
el 2026-10-01 (D10: retención 30 / 7 días y artefactos sin caducidad).

- Desviaciones del documento (editadas en la especificación): `analysis.retention.*` es **solo
  global** como `runtime` y `oci.*` (el barrido cubre todos los workspaces; las claves ignoradas de
  una capa de proyecto se listan en `alisio doctor`); `0` significa "no borrar nunca" en las tres
  claves de retención; `input/` se conserva con `script/` mientras haya un artefacto `ready`; el
  "último uso" de un dataset es la fecha de modificación de su archivo (sin migración v7); el rerun
  usa las copias de `input/` del trabajo original verificadas por sha256 (no vuelve a leer el
  archivo del workspace) y se pide con `python_run { rerunOf }`; la instalación desde el chat usa
  `ToolContext.approveInstall` y `PendingApproval.install`; los artefactos expirados siguen listados
  con `Details` y `Rerun`; el comprobador de wheels es un job propio (`extras-wheels`) además del
  paso de `portability`. No se implementaron los opcionales de §23: origen separado del visor (D8),
  lector XLSX en Node (D6), plantillas de artefacto ni XLS/ODS/Parquet.
- Marcas "(verificar)" de la especificación comprobadas y corregidas: `@tanstack/preact-table`
  **sí existe** en npm (9.2.4); `xlsx@0.18.5` sigue siendo `latest` y `npm audit` lo marca *high*;
  `exceljs@4.4.0` instala 78 paquetes y 36 MB; `--user` se omite en macOS y Windows **sin
  verificar** (no hay Docker Desktop aquí).
- Vitest: `analysis-config` (imagen sin digest rechazada al cargar, runtime/oci/retención ignorados
  desde un proyecto y listados, claves de tres niveles que conservan hermanas, solo las cinco claves),
  `analysis-oci` (argumentos exactos de §8.3 con rutas de Windows, macOS y con espacios, `--user` y
  rootless, SELinux, ruta con `:` rechazada; CLI de contenedor falsa: sin Python del host, cancelar y
  agotar el tiempo ejecutan `kill` y no queda ningún `alisio-*`, motor ausente con el otro
  instalado, sin imagen; los casos con motor real, red bloqueada, escritura fuera de `/job/out` y
  `/job/work` y cancelación, corren con `ALISIO_TEST_OCI_IMAGE` y se saltan sin él),
  `analysis-extras` (pip falso: `--require-hashes` y `--only-binary=:all:`, `uv`, fallo sin red sin
  entorno a medias ni cambio del activo, instalaciones concurrentes, aprobación solo `once`, nunca
  persistida, sin flag, headless con el remedio), `analysis-rerun` (mismo hash de script, artefactos
  nuevos con `rerunOf`, los anteriores intactos, entrada cambiada o ausente, script ausente o
  alterado, referencias ajenas, expirado, gate de capability con el script guardado, datasets,
  extras), `analysis-janitor` (reloj inyectado: `work/` a los 7 días, logs a los 30, script mientras
  haya artefactos `ready`, expiración, datasets y originales, una vez cada 24 h, bloqueo, temporizador
  sin referencia, nunca fuera de `analysis/jobs`), `analysis-application`, `server-analysis-phase4`
  (`POST …/rerun`, `GET /api/analysis`, ajustes), `web-analysis-settings`, ampliaciones de
  `tui-artifacts`, `settings`, `settings-menu` y `run-events-contract`, y `fixtures/cli-e2e.ts`
  (`analysis status` y `analysis sweep`, también con el binario Bun).
- Verificado a mano el 2026-10-01 en Linux: Docker real con `python:3.12-slim` fijada por digest
  (las pruebas con motor real pasan); `alisio analysis setup --extras analysis` instaló los extras de
  verdad con `uv` (3 s con caché) y, sin red (proxy inalcanzable), `--extras science` falló con el
  mensaje limpio, código de salida 1, sin carpeta nueva y con el entorno activo intacto; en
  `alisio serve` (Playwright, Chromium) con un proveedor simulado y Python real: ejecución con
  aprobación **S**, **Ejecutar de nuevo** desde el menú del panel (nueva ejecución con
  `rerunOf`, modelo y proveedor en la procedencia, la anterior intacta), la página **Análisis de
  datos** (estado del runtime, edición de `jobsDays` persistida en el archivo global, última
  limpieza), un artefacto envejecido y expirado con `alisio analysis sweep --force` (la tarjeta dice
  "Caducado", el desplegable lo lista, el menú ofrece solo Detalles y Ejecutar de nuevo y este
  recrea un artefacto nuevo) y la aprobación de instalación (paquetes, 75 MB, red; sin botón de
  sesión, la tecla S no hace nada, **D** deniega y el resultado nombra el comando opcional). Wheels:
  `scripts/analysis-extras-wheels.ts` comprobó 6 plataformas × Python 3.10/3.12/3.13 contra PyPI;
  huecos reales: Windows Arm (`analysis` solo con 3.12+, `science` solo con 3.13) y Alpine/musl
  (`science` sin scikit-learn). No verificado: Podman, Docker Desktop en macOS y Windows, Windows
  y macOS (job `portability`), la TUI interactiva en un terminal real, Firefox y Safari y lectores de
  pantalla.

## Estado en vivo de la ejecución y tiempos de espera: alcance de la verificación

- Diagnóstico (proveedor DeepSeek, 36 herramientas, petición de ~37 KB): la misma petición respondió
  en 2 a 7 s en casi todos los intentos (directos y por Alisio), pero de forma intermitente el
  proveedor aceptó la conexión (HTTP 200 en menos de 1 s) y solo envió comentarios SSE
  `: keep-alive` durante 54 s a 300 s sin ningún token (una vez el token llegó tras 56 s de cola).
  No depende del tamaño del prompt ni de las herramientas de análisis. El SDK de OpenAI descarta esos
  comentarios, por lo que ni el núcleo ni el plugin pueden distinguir «en cola» de «conexión muerta»;
  el temporizador de 120 s del cliente solo cubre hasta las cabeceras.
- `limits.timeoutMs` (300 s) es un límite de reloj de **toda la ejecución**, no de inactividad. Ahora
  una ejecución que lo alcanza termina como `failed` con `run_failed { code: "timeout", timeout }` y
  un mensaje que nombra modelo, proveedor y qué hacer (antes: `cancelled` con «The operation was
  aborted due to timeout»). La detención del usuario sigue siendo `cancelled`.
- Nueva clave `limits.firstTokenTimeoutMs` (por defecto `120000`, ahora `90000`, ver abajo; `0` la desactiva): detiene una
  petición totalmente silenciosa. El propietario decidió (2026-10-01) activarla en 2 min y subir
  `limits.timeoutMs` de 300000 a 600000: DeepSeek llegó a responder tras 56 s de cola, pero un
  modelo que no emite su razonamiento en streaming puede callar más de 2 min (riesgo conocido: en
  ese caso hay que subirla o poner `0`).
- Decisión del propietario (2026-10-01): una petición silenciosa se reintenta **una vez** y el valor
  por defecto de `limits.firstTokenTimeoutMs` baja de 120000 a **90000** (la petición con 56 s de
  cola sigue cabiendo). Nueva clave `limits.firstTokenRetries` (entero 0 a 3, por defecto `1`; `0`
  lo desactiva). El reintento es genérico y vive en el runner (ningún plugin de proveedor cambia):
  solo si saltó el temporizador de primer token, no llegó ningún delta de la petición y quedan
  reintentos; reenvía exactamente las mismas entradas (sin mensajes ni eventos duplicados), no cuenta
  como turno (`maxTurns` intacto) y no se inicia si no cabe en `limits.timeoutMs`. Evento aditivo
  `request_retry { attempt, of, reason, afterMs }`; `RunTimeoutInfo.attempts` (aditivo) y mensaje
  «did not respond after N attempts of 90 s each». Peor caso con los valores por defecto: unos
  2 × 90 s más una pausa de 250 ms. Contabilidad: el intento abortado no devuelve `usage`, así que no
  suma tokens; `requests` (usado solo para `firstRequest` del mensaje de timeout) cuenta turnos, no
  reintentos. Límite conocido: un modelo que no emite su razonamiento en streaming puede callar más
  de 90 s y recibir un reintento innecesario (hay que subir `firstTokenTimeoutMs` o poner `0`).
  Web, TUI y modo texto sin interfaz muestran «The model did not respond; retrying (1/1)…».
- `InflightState.startedAt` (aditivo) permite que una recarga conserve el tiempo transcurrido.
- Web: línea de estado (`RunStatus`) con fase, tiempo de ejecución y del paso, última actividad,
  aviso a los 15 s y a los 60 s con **Detener**, región `aria-live` que cambia solo con la fase o el
  nivel. TUI: la pieza de estado del pie muestra la fase y `no response for N s`.
- Pruebas: `tests/run-timeout.test.ts` (mensaje, evento y estado en el runner con un proveedor
  silencioso, parada del usuario, `firstTokenTimeoutMs`), `tests/web-run-progress.test.ts` (derivación
  de fases, umbrales con reloj falso, avisos de tiempo en el transcript), `tests/tui-run-phase.test.ts`,
  `tests/server-inflight.test.ts`. Verificado a mano en Chromium con `alisio serve` y un proveedor
  falso: fases en orden (esperando, pensando, aprobación, Python, esperando, redactando), silencio a
  15 s y 60 s, Detener, y el mensaje de tiempo agotado en EN y ES.
- Decisión del propietario (2026-10-01): recuperación automática de una respuesta cortada por
  `limits.maxOutputTokens` (caso real: DeepSeek V4.1 Flash con `@alisio/plugin-deepseek` 0.1.1 al
  pedir un dashboard; el razonamiento o el `arguments` de una llamada `python_run` larga agotaron los
  16384 tokens y la ejecución fallaba con «cut off by max output tokens before any usable content»).
  Nueva clave `limits.truncationRecoveries` (entero 0 a 5, por defecto `2`; `0` la desactiva).
  Detección en el núcleo, sin depender del proveedor: mensaje `completed` con `truncated: true` y
  (a) sin texto ni llamadas, o (b) alguna llamada con id/nombre vacío o `arguments` que no son un
  objeto JSON completo (argumentos vacíos solo cuentan en la última llamada); un fallo del proveedor
  con `code: "output_truncated"` (nuevo `OutputTruncatedError` aditivo en `@alisio/sdk`) o, por
  **compatibilidad** con plugins que no podemos cambiar, cuyo mensaje contiene «cut off by max output
  tokens before any usable content» (la única coincidencia de texto vive en
  `packages/core/src/core/truncation.ts`, `isOutputTruncationError`). Las llamadas válidas y
  completas de una respuesta cortada no se descartan (siguen ejecutándose, como antes); si UNA llamada
  está cortada se descartan TODAS (y los `providerData` del mensaje). Una respuesta cortada con texto
  útil y sin llamadas conserva el comportamiento anterior (`response_truncated`). Recuperación: las
  llamadas cortadas nunca se ejecutan ni se persisten (los ids siguen consistentes); el texto visible
  se guarda como mensaje normal del asistente; el aviso de continuación (en inglés) se añade solo a la
  petición siguiente y no se persiste (la UI web mostraría un mensaje `summary` como «compactado»);
  no consume `maxTurns` ni emite `turn_completed`; no se sube `maxOutputTokens`. En la primera
  recuperación de una respuesta vacía se baja un nivel el esfuerzo de razonamiento solo para esa
  petición, si el catálogo del modelo (`ModelInfo.effort.supportedLevels`) permite ordenar los niveles
  (nombres conocidos `none…max`); con el error heredado no se sabe si fue razonamiento o una llamada
  larga, y se trata como respuesta vacía. Agotadas las recuperaciones: `run_failed` con
  `code: "output_truncated"` y `truncation { attempts, maxOutputTokens, model }`, mensaje legible
  (web localizada EN/ES). Evento aditivo `truncation_recovery`. `python_run` añade una frase que
  pide código corto por llamada. El adaptador OpenAI-compatible (chat y responses) ya no lanza error
  ante `length` sin texto: devuelve `completed` con `truncated: true`. Pruebas:
  `tests/truncation-recovery.test.ts`, `tests/truncation.test.ts`, `tests/web-run-progress.test.ts`,
  `tests/tui-run-phase.test.ts`, `tests/config-layers.test.ts`. No cableado: el adaptador
  `@alisio/plugin-deepseek` (otro repositorio) sigue lanzando el error genérico (se recupera por la
  coincidencia heredada) y no distingue razonamiento de llamada cortada; las llamadas de resumen de compactación y de subagentes no usan esta recuperación.
- Decisión del propietario (2026-10-01): el presupuesto de tokens de salida efectivo sale del
  catálogo del modelo. `limits.maxOutputTokens` ya no tiene valor por defecto en el esquema (se
  distingue «fijado por el usuario» de «por defecto»); lo que se consume es
  `resolveMaxOutputTokens` (`packages/core/src/core/output-limit.ts`): un valor explícito (cualquier
  capa de configuración, `/settings`, el selector web u opción por ejecución) siempre gana, incluso
  por encima del máximo declarado (no se recorta ni se reintenta; si el proveedor lo rechaza, el
  error actual no cambia); si no, `min(ModelInfo.maxOutputTokens, 65536)`; si no, 16384. Se
  resuelve para el modelo de cada petición (cambios de modelo o de agente se notan en la siguiente
  ejecución) y el valor y su origen (`user`, `model`, `default`) aparecen en `response_truncated`,
  en `run_failed { code: "output_truncated" }`, en el aviso web y TUI y en `alisio doctor`. El
  catálogo es el del proveedor activo (`GET /models`; DeepSeek lo informa con `max_output_tokens`,
  hasta 393216 en V4.1 Flash, que queda en 65536); la primera petición espera hasta 2 s a un
  catálogo que aún se carga, y los catálogos de otros perfiles solo se consultan si ya estaban
  listados (se toma el menor valor declarado). Los subagentes siguen con su valor por ejecución
  (`maxOutputTokensPerChild`, 16384), la compactación con `compaction.maxOutputTokens`, y las
  preguntas laterales (`/btw`) y los hijos sin presupuesto propio heredan el valor efectivo. Límites:
  el adaptador OpenAI-compatible integrado no lee un máximo de salida de `GET /models` (solo la
  ventana de contexto), así que ahí aplica 16384 salvo que se fije el valor; el valor efectivo no se
  muestra en `/settings` (la fila muestra 16384 mientras no esté fijado); el aviso web localizado
  nombra el origen en EN/ES. Pruebas: `tests/output-limit.test.ts`, `tests/config-layers.test.ts`.
- No verificado: lectores de pantalla reales, Firefox y Safari, la TUI en un terminal real, y la
  detección de `: keep-alive`: el plugin `@alisio/plugin-deepseek` (repositorio aparte) tendría que
  envolver `fetch` y emitir un evento de latido; no se inventó esa señal.

## Modos de permisos, `/reload` y `/changelog` (fase 1): alcance de la verificación

- Verificado con Vitest (sin red ni credenciales): la tabla de modos y su coherencia con los presets
  del servidor (incluidos el techo de `alisio serve` y `read-only`), la política real del runner
  tras `setPolicy` (un efecto `write` pregunta en `ask` y no en `auto`; un `process` pregunta salvo
  en `full`; `analysis` no se toca), el orden y la envoltura del ciclo con agentes personalizados (en
  core, en la decisión de Shift+Tab de la TUI y en la web), los bloqueos de Shift+Tab (turno en
  curso, picker, autocompletado, panel), la transición de modos con `--read-only` bloqueado y el
  aviso de acceso total, el orquestador de recarga con aplicaciones simuladas y con
  `createApplication` reales (una configuración rota deja viva la aplicación y su sesión; una
  corrección se aplica y la sesión persiste), la guarda de inactividad, el parser del changelog
  (versiones, secciones, saltos de línea de Windows, archivo ausente), el orden de versiones, la
  lógica de `lastSeenVersion` en la TUI y la web (primer arranque, actualización, bajada de versión,
  almacenamiento que lanza), los datos embebidos al día, el catálogo de comandos y su paridad con la
  TUI, y las rutas HTTP (orden de agentes, `/permission`, `/reload` con `catalog_changed`,
  `runs_active`, configuración rota, 401/403/415, `/changelog`).
- Navegador: comprobado con Chromium (Playwright) contra `alisio serve` con un proveedor falso
  compatible con OpenAI; el resultado detallado está en la entrega.
- No verificado: la TUI en un terminal real (el listener de Shift+Tab, el panel de novedades y el
  menú de modos se probaron como lógica pura y compilados, no en un pseudo-terminal), terminales que
  no distinguen Shift+Tab, otros navegadores (Firefox, Safari), lectores de pantalla reales y
  Windows/macOS.

## Pestaña Memory de la web y vistas de datos de plugins: alcance de la verificación

- Verificado con Vitest (sin red): registro y validación de vistas, detección sin `api.views` (el
  plugin de memoria arranca en un host sin ella), la ruta HTTP (autenticación, Host, Origen, sesión
  y workspace inexistentes, plugin deshabilitado, también en `restart-required`, vista desconocida,
  parámetros no válidos sin eco de valores, límite de tamaño, timeout con aborto, errores
  genéricos, ausencia de parámetros en los logs), las tres vistas contra una base SQLite temporal
  (solo la sesión pedida, fijadas primero, filtro, búsqueda con comodines literales, cursor sin
  duplicados ni huecos al añadir filas, solo lectura, resumen, contexto igual a lo devuelto por el
  hook de inicio), el extremo a extremo con el plugin real en un servidor real, la migración 101 y
  la lógica de la web (selector, visibilidad y vuelta a Conversación, paginación, filtros,
  descarte de respuestas obsoletas, errores por sección, paridad EN/ES de los textos).
- Navegador: comprobado con Chromium (Playwright) contra `alisio serve` con un proveedor falso
  compatible con OpenAI y una base de memoria temporal: la pestaña aparece solo con el plugin
  habilitado; las tres secciones (el contexto cargado salió de una ejecución real); filtro, búsqueda
  y «Cargar más» (20 de 27, sin duplicados); cambio de chat; deshabilitar el plugin en Ajustes →
  Plugins quita la pestaña, vuelve a Conversación y la ruta responde 404; ancho móvil (390 px) sin
  scroll horizontal. Presupuesto del bundle inicial dentro del límite (`pnpm pack:check`).
- No verificado: Firefox y Safari, lectores de pantalla reales, Windows y macOS, bases de memoria
  grandes (miles de entradas por sesión) y el comportamiento con varios workspaces abiertos a la vez.

## Tareas en segundo plano (fase 3): alcance de la verificación

- Verificado con Vitest y procesos hijos reales (un script de Node, sin sintaxis específica de shell):
  salida por offsets sin repetir, marcador y cola de un log truncado, lecturas acotadas sin partir
  caracteres, código de salida, `cancelled` con origen al detener (usuario y modelo, idempotente) con el
  árbol de procesos muerto (un nieto), watchdog (`failed`/`timeout`) y tope de `timeoutMs`, carreras
  parada/salida, compare-and-set sin salir de un estado terminal, `lost` solo para propietarios
  muertos, límites por sesión y por proceso, alcance por árbol de sesiones, cierre ordenado (incluido
  un proceso que ignora SIGTERM) y la migración v7 (base nueva, desde v6, idempotente).
- Política con el ejecutor real: `--read-only` y el agente plan deniegan las cuatro herramientas (en
  los tres modos), `ask`/`auto` preguntan cada llamada, `full` no pregunta, y esquemas, directorio de
  trabajo fuera del workspace o inexistente.
- Notificación: coalescencia, límite de frecuencia y de ráfaga, reintento mientras está ocupada sin
  pérdidas ni duplicados, `poke`, `skip`, lectura posterior (no se anuncia), sin aviso para tareas
  detenidas, de sesiones hijas o tras el cierre; de extremo a extremo con el servidor real, el despertar
  inicia exactamente una ejecución (id `bg-<id>`), espera mientras la sesión corre y no ocurre en una
  sesión archivada.
- Rutas (401, 403 por Origen, 415, sesión ajena, offset, límite, parada), frame `tasks_changed`, tareas
  `lost` al arrancar el servidor, `/reload` rechazado y cierre del servidor sin procesos vivos; lógica
  de la TUI (reductor, panel con dependencias simuladas, `wakeDecision`, guarda de recarga); store de la
  web (lista, frames, avisos, salida por offset, parada), textos EN/ES y carga perezosa; paridad del
  catálogo de comandos; configuración y etiquetas.
- Navegador: comprobado con Chromium (Playwright) contra `alisio serve` (`packages/cli/dist/main.js`) y
  un proveedor falso compatible con OpenAI que llama a `bg_run`: salida en vivo, botón Detener, el
  despertar del agente exactamente una vez al terminar una tarea, ningún despertar tras una parada del
  usuario y una tarea `lost` tras matar el servidor con SIGKILL.
- No verificado: la TUI en un terminal real, Windows y macOS (`taskkill /T /F` y el grupo de procesos),
  otros navegadores, lectores de pantalla reales y cargas con muchas tareas simultáneas.

## Límites conocidos

## Objetivos de sesión `/goal` (fase 4): alcance de la verificación

- Verificado con Vitest: gramática del comando y del presupuesto (`50k`, `1.5M`, `clear|none|off|0`,
  `budget=` duplicado, límites), máquina de estados (transiciones por actor, reactivación al subir el
  presupuesto, reanudación con asignación nueva, reinicio), lista de bloqueadores y su orden, prompts
  (contrato una vez, pista estable, recordatorio cada 5 turnos, avisos); servicio con SQLite real y reloj
  falso (recuento acumulado entre ejecuciones, tope duro y por ejecución, turnos, tiempo, disyuntores,
  auditoría de `blocked`, error → `blocked`, reclamación idempotente, kickoff una vez, carreras de dos
  superficies por `epoch`/`goalId`, pausa por reinicio); ejecutor real con proveedor guionado (herramientas
  opt-in, objetivo completado en tres turnos, presupuesto duro, lo que el modelo no puede hacer);
  servidor real (rutas, frames, snapshot, 401/403, esperas por tarea, modo plan y aprobación pendiente,
  cancelación, reinicio, comando `/goal`, `goal.enabled`); lógica de la TUI (`planGoalCommand`, selector,
  barra, aviso de parada); store de la web (acciones con `expect`, conflicto, reemplazo con confirmación,
  formulario, filas de la paleta, textos EN/ES de cada código, carga perezosa); migración v8; paridad del
  catálogo de comandos; etiquetas de ajustes.
- Navegador: Chromium (Playwright, interfaz en español) contra `alisio serve` (`packages/cli/dist/main.js`)
  y un proveedor falso compatible con OpenAI: un objetivo que continúa 3 turnos y termina con
  `update_goal complete`; presupuesto pequeño → *Presupuesto agotado* sin más ejecuciones y reactivado al
  subirlo desde el formulario; respuesta repetida → pausa `no_progress`; botones Pausar, Reanudar, Editar y
  Borrar; espera por permiso pendiente; espera por una tarea `bg_run` y continuación al terminar; sin
  continuación en modo plan y continuación al pasar a `build`; recarga de la página y reinicio del servidor
  con SIGKILL (el objetivo vuelve en pausa, `restart`).
- No verificado: la TUI en un terminal real (su flujo `task()` → continuación está cubierto por la
  lógica pura y por las pruebas del núcleo, no por un terminal), otros navegadores, Windows y macOS,
  lectores de pantalla reales, proveedores reales (el recuento depende de que informen `usage`) y goals de
  muchas horas.

## Decision Intelligence: alcance de la verificación

- Verificado con Vitest (sin red; proveedor falso en memoria en `tests/fixtures/decision-provider.ts`):
  servicio (resultado parcial, fallback por motivo, tiempo límite con proveedor colgado, aborto del
  llamador), validación de peticiones y respuestas, disyuntor con reloj inyectado, eventos y prueba de
  privacidad con cadenas centinela sembradas en `state`, frontera del núcleo (el código de decisiones no menciona
  ningún motor concreto y `runner.ts` y `permissions` no importan `decisions/`), configuración y capas global-only,
  ciclo de vida `activate`/`deactivate`, rutas y opciones por plugin, cierre en paralelo con tope por
  plugin, comando `/decisions`, coincidencia de los tres cálculos de `/stats`, contrato de eventos,
  paridad del catálogo de comandos y etiquetas EN/ES. `fixtures/cli-e2e.ts` comprueba que `alisio run`
  ejecuta `dispose()` con `SIGTERM`, `SIGHUP` y `SIGINT`.
- Navegador: Chromium (Playwright, interfaz en español) contra `alisio serve` construido, un modelo
  falso compatible con OpenAI y un plugin local temporal con un proveedor falso: una sesión con
  decisiones completadas y una con alternativa, y `/decisions` con las métricas. Es la captura de la
  documentación; no es una prueba de calidad de decisiones.
- Fase 0 (E1 a E7, fuera del repositorio, con Laya 0.3.24 y el punto de control `multilingual`, en CPU y
  CUDA): el valor por defecto de `timeoutMs` (1500 ms) sale de ahí, y E2 mostró que `confidence` no está
  calibrada.
- No verificado: un proveedor real (no hay ninguno incluido ni publicado), la TUI en un terminal real,
  otros navegadores, Windows y macOS, lectores de pantalla, un proveedor remoto, el comportamiento con
  muchas decisiones concurrentes bajo carga y la calidad de las decisiones de cualquier motor.

## Smart Dashboard: alcance de la verificación

- Verificado con Vitest (sin red ni proveedor real): perfilador y candidatos, pack de decisiones con
  una prueba de privacidad de cadenas centinela sembradas en celdas, valores frecuentes, mínimos y
  máximos, planificador con y sin decisiones, validador y su tabla de reparación, planificador de
  consultas sobre un dataset SQLite real, renderizador (estructura, escape y formato de KPI), prueba de
  paridad con `alisio_runtime.charts` (se salta sin Python), la herramienta de extremo a extremo con un
  publicador real, pruebas golden de los `DashboardSpec` de unos pocos datasets pequeños revisados a
  mano, capas de configuración (global `false` frente a un bloque `analysis` de proyecto) y paridad de
  etiquetas EN/ES.
- Fase 0 (E1 a E5, fuera del repositorio): las reglas de roles funcionan con las estadísticas actuales
  en 8 datasets; la consulta más lenta tardó 370 ms con 500 000 filas (límite de 5000 ms), así que no
  hay muestreo; la expresión de semana de SQLite se comprobó sobre 1461 días; `chart-lint` y el visor
  no dependen del marcado `ac-*`.
- Navegador: Chromium (Playwright) contra `alisio serve` construido y un modelo falso compatible con
  OpenAI, con datos de ejemplo: el dashboard en el visor aislado y la fila de progreso. Son las capturas
  de la documentación; no son una prueba de calidad de los dashboards.
- Benchmark (fase 8, 2026-10-03, un solo modelo: `deepseek-flash`): A 45 ejecuciones, B 15 (1
  repetición por dataset), C 5 (informativa, en paralelo con B, tiempos no comparables); la puerta de
  §11.2 falla en tokens de salida y turnos. La línea base A está limitada por el presupuesto de
  tokens, y el orden de las llamadas solo se reconstruyó en C.
- Ejecución real con Laya (2026-10-04, interfaz web, compilación candidata de 0.4.3,
  `@alisio/plugin-laya` 0.1.1, `deepseek-flash`, un CSV de ventas de 4000 filas renombrado
  `ventas.csv`, prompt en español sin preguntas y modo «Acceso total», sin esperas del usuario; un
  solo dataset, un solo modelo y una sola sesión por configuración): con Laya el primer dashboard se
  publicó a los 5,0 s del envío, `dashboard_generate` tardó 161 ms y hubo 2 decisiones completadas
  (101 ms y 30 ms, ninguna rechazada, sin fallback; procedencia `rules+decisions`); el modelo no usó
  `python_run` después y la ejecución completa tomó 32,3 s. Sin proveedor y con la memoria
  desactivada, el primer dashboard llegó a los 4,5 s (52 ms), el modelo hizo 4 llamadas a
  `python_run` y publicó un dashboard extra en Python (canal x región), 45,2 s en total; con una sola
  ejecución por configuración no se puede atribuir esa diferencia a Laya. Una tercera ejecución
  (memoria activada, sin proveedor) se descartó porque una nota guardada por una ejecución anterior
  orientó al agente. `/decisions` informó 2 peticiones, 0 fallbacks, latencia media de 66 ms y p95 de
  101 ms. La primera ejecución (0.4.2 publicada) tardó 672 s por las preguntas del agente. Capturas en
  la documentación.
- No verificado: otros modelos en el benchmark; la variante C a mayor escala; la línea de progreso en
  un terminal real; otros navegadores, Windows y macOS; lectores de pantalla; y datasets muy grandes
  en el navegador.

## Límites conocidos

### Runtime y empaquetado

- Runtime: Node no carga `.env` automáticamente (Bun sí); use variables de entorno o
  `node --env-file=.env`. Los plugins `.ts` locales requieren Bun o Node >=22.18; los paquetes
  npm de plugins deben publicarse en JavaScript. La condición de export `alisio-source` solo
  se usa en desarrollo dentro del monorepo y no se publica.

### Agentes del usuario

- Solo se escriben y listan los ámbitos `.agents/agents` (proyecto y global); los agentes en
  `.alisio/agents`, `<config>/agents`, `.claude/agents` u `.opencode/agent(s)` se siguen cargando
  pero no se editan desde la ventana Agentes ni desde `/agents manage`. No se puede mover un
  agente entre ámbitos.
- `reasoning.summary`, `text.format.type` y `text.verbosity` se guardan y se muestran, pero el
  contrato `ModelProvider.stream` aún no tiene campos para ellos: no se envían al proveedor.
  `reasoning.effort` sí se aplica (como effort por defecto del agente) y el modelo del agente se
  usa al iniciar un chat con él.
- La descripción de la herramienta `task` (lista de `subagent_type` anunciados al modelo) se fija
  al arrancar: un agente nuevo se puede delegar en cuanto se recarga, pero el modelo solo lo ve
  anunciado tras reiniciar. Las tareas de subagentes en curso conservan su definición.
- El estado publicado por el plugin de subagentes (`mainAgents`, `definitions`) es global en la
  base de datos, no por workspace: con varios workspaces abiertos en `alisio serve`, el último en
  recargarse define el catálogo (limitación previa; tras cada escritura se recarga el workspace
  que escribió en último lugar).
- Sin vigilante de archivos; las ediciones externas se recogen al abrir la lista o con
  `/agents reload`.
- Las instrucciones en la TUI se editan en una línea (`\n` para saltos); para textos largos use
  "✦ Refinar con Alisio", la web o un editor externo.
- En la web, activar un agente cuyo modelo es de otro proveedor no cambia el modelo de ese chat
  (lo indica); "Probarlo en un chat nuevo" sí lo usa si los perfiles configurados lo resuelven.

### Subagentes

- Subagentes: los mensajes en cola (`send_message`, notificaciones) viven en memoria y se pierden
  al salir; una notificación en segundo plano llega con el siguiente turno del padre; las skills
  de una definición no se preinyectan (se pide cargarlas con `skill_load`); los worktrees solo se
  usan cuando se solapan escritores; `/agents merge` exige árbol limpio y no resuelve conflictos;
  el panel muestra las tareas iniciadas en este proceso; `kill` equivale a `cancel`.

### Proveedores, plantillas y licencia

- Proveedores: la resolución cruzada solo ve perfiles globales creados mediante `/connect`; la
  configuración raíz heredada no es un catálogo oculto. El catálogo se mantiene en caché hasta 15
  segundos por proceso.
- Plantillas: sin inclusiones ni parciales, sin ejecución de comandos ni inyección de archivos;
  solo `$1`..`$9` posicionales; `/init` depende del modelo para limitarse a hechos verificados y
  consume bastantes tokens en repositorios grandes (`limits.maxTokens`).
- Pantalla de inicio: con `TERM=dumb` solo la pantalla de inicio pasa a ASCII; el resto de la
  TUI (cabecera, barras) sigue usando glifos Unicode. El ancho se cuenta por punto de código,
  así que glifos anchos (CJK, emoji) en mascotas personalizadas pueden desalinear. Los
  proveedores son síncronos: un proveedor lento no puede interrumpirse, solo descartarse.
- Licencia MIT.

### Memoria

- Memoria: la búsqueda usa el tokenizador trigram, así que los términos de menos de 3
  caracteres se ignoran. Sin búsqueda semántica. El resumen automático de cierre solo se
  ejecuta en la TUI (no en `run` headless) y está acotado por
  `pluginHooks.sessionEndTimeoutMs`; si vence, la salida continúa sin resumen. El resumen de
  cierre reemplaza al checkpoint archivado de la misma sesión (un resumen por sesión).
  Los prompts de usuario se copian a la base de memoria (redactando `<private>`) al compactar
  y al cerrar; la base es local con permisos 0600.
- Detalles de implementación de memoria: la tabla de sesiones se llama `memory_sessions` (la base puede
  compartir archivo con las sesiones de Alisio); no hay FTS de prompts; el `topic_key` en
  alcance `personal` hace upsert entre proyectos (para que las preferencias sean realmente
  personales); las líneas de contexto incluyen `#id` para `memory_get`; el checkpoint de
  compactación se archiva como resumen de sesión y no como observación
  `session/compaction-recovery`, y la recuperación se inyecta de forma determinista sin
  pedir al modelo que llame herramientas. No hay sincronización en la nube, relaciones,
  juicio de conflictos ni ciclo de revisión.
- Efecto `internal`: las herramientas de memoria no modifican el workspace ni la red y se
  permiten incluso con `--read-only`. Si se prefiere un modo estrictamente sin escrituras,
  use `--disable-plugin memory`.

### Plugins e instalación

- Plugins: `model.complete` usa el proveedor configurado (el modelo de la sesión cuando el
  plugin lo pasa) y no descuenta del presupuesto `limits.maxTokens`. Los hooks corren en
  proceso: el timeout aborta la espera y señala el `AbortSignal`, pero no puede detener
  código síncrono bloqueante.
- Instalación de plugins (`alisio install`, herramienta `plugin_install`): solo npm y global —
  los paquetes aterrizan en `<config home>/plugins` mediante `npm install --prefix` y su nombre
  npm se guarda en el array `plugins` de la configuración global. Instalar es una acción por
  usuario; la carga sigue la política existente de plugins ejecutables (confianza del proyecto
  para la configuración y plugins del proyecto; `--read-only` impide cargar). No hay sandbox de
  scripts: `npm install` puede ejecutar scripts de ciclo de vida con tus privilegios y la
  herramienta solo avisa/pide confirmación (headless exige `--yes`/`--trust-plugin`).
  `alisio install --update` sin spec actualiza todos los plugins instalados en una sola llamada
  de npm, y un fallo `ERESOLVE` indica ese comando (verificado con un npm falso, sin red). No se
  soportan URLs de registro (`registry:`, `git:`, `file:`), ni resolución de dependencias propia
  de Alisio: el paquete debe declarar la keyword `alisio-plugin` para poder cargarse.

### Portapapeles, pegado y TUI

- Portapapeles: OSC 52 no puede confirmarse; la TUI lo informa como no verificado.
- Pegado y adjuntos: el acceso al portapapeles de imágenes necesita un ayudante nativo de la
  plataforma (o `wl-paste` en Wayland); suele faltar en sesiones SSH simples. No hay
  comprobación de capacidades antes de enviar una imagen: el rechazo del propio modelo aparece
  como un error en línea normal. Los límites de 5 MB por imagen y 4 adjuntos por mensaje los
  aplica la TUI, no `@alisio/core` (quien use el runner directamente puede enviar más o mayores).
  El pegado de varias líneas en modo `--no-tui` no es atómico: `readline` de Node no admite
  pegado con corchetes, así que cada salto de línea envía su propio mensaje; el pegado de una
  sola línea no se ve afectado. Las imágenes no tienen ningún soporte en modo `--no-tui`.
- TUI: las estadísticas de `/stats` cubren solo el proceso actual de la TUI para la sesión
  activa; no se reconstruyen desde eventos persistidos. La TUI necesita una terminal con
  pantalla alternativa; en otros casos use `--no-tui` o `run`.
- TUI (plegables de presentación): el clic para alternar es opcional — el atajo `x` con la
  entrada vacía es el camino garantizado; el mapeo del clic usa la altura renderizada en el
  momento del clic y el ancho de ese frame, por lo que en anchos muy estrechos o con filas de
  altura variable entre frames el acierto puede desviarse una fila (nunca rompe la selección:
  un clic sintetizado solo se detona sin arrastre). El marcador de plegado aparece solo cuando
  la fila es plegable: las filas sin marcar (`run_process` con salida corta, diffs, rich
  ui/imagenes) no alternan nada. Las vistas previas dentro de un grupo expandido van acotadas
  (3/6 líneas) y no son plegables individualmente; el razonamiento expandido se acota a 40
  líneas. La duración `Thought` es una aproximación del primer al último delta de razonamiento
  y solo existe cuando el evento llevaba marcas de tiempo (no en sesiones reanudadas).

### Skills y contexto

- Skills: el coste de tokens mostrado por `/skills` es una aproximación uniforme de bytes/4, no el
  tokenizador del proveedor. Una skill de un plugin desactivado tras reiniciar deja de existir en el
  catálogo; un cambio pendiente del plugin conserva la skill bloqueada y marca su origen como
  pendiente de reinicio. Los diagnósticos headless pueden incluir rutas de confianza; la TUI no.
- `provider.contextWindow` se aplica solo al modelo configurado; tras `/model`, la ventana
  proviene del override `values.contextWindow` del perfil activo de `/connect` (preguntado en
  `/connect` cuando el catálogo no informa la ventana del modelo seleccionado, pensado para
  servidores locales como llama.cpp que omiten `context_window`; prevalece sobre el catálogo por
  intención del usuario), de `GET /models` (el catálogo se carga de forma perezosa al arrancar y se
  refresca tras cada cambio de proveedor/modelo) o queda como desconocida: la barra de contexto
  muestra un honesto `~9.9k / ?` sin total inventado, y la compactación automática por umbral se
  desactiva para ese modelo salvo por `limits.maxContextChars` (salvaguarda interna, nunca total
  mostrado). La cobertura usa perfiles guardados y activación de `/connect` con catálogos ficticios;
  la entrada interactiva de `/connect` se verifica por tipos y manualmente, no con pruebas de UI.

### Compactación y truncamiento

- La compactación usa el proveedor actual; su consumo de tokens no se suma al presupuesto
  `limits.maxTokens`. Las estimaciones antes/después son aproximadas (≈4 caracteres/token).
  Los items opacos de Responses del tramo resumido se descartan; los conservados no cambian.
  Una sesión con resultados de herramientas inciertos no se compacta hasta recuperarla.
- Respuestas truncadas: cuando una respuesta se corta por `limits.maxOutputTokens` (o el resumen
  de compactación por `compaction.maxOutputTokens`), el texto producido se conserva tal cual. Una
  respuesta cortada completa la ejecución con aviso y marca `truncated`; un resumen cortado se
  guarda como checkpoint **parcial** — la información producida antes del corte se preserva, pero
  un resumen truncado puede omitir contexto posterior. El resumidor estima tokens por su cuenta
  (≈4 caracteres/token), así que un resumen cerca de su presupuesto puede cortarse aunque el
  modelo no esté cerca de *su* límite; el presupuesto real consumido lo informa el proveedor y no
  puede comprobarse de antemano.

### Permisos, aprobaciones y confianza

- Aprobaciones: para los efectos `write`, `process` y `external`, y solo en la TUI (la propia
  TUI ya pasa siempre un manejador `approve` salvo con `--read-only`, así que sin ningún flag el
  efecto se ofrece y se pregunta en cada llamada; ver la tabla de verdad en `docs/tools.md`); los
  modos headless (`run`, `resume "prompt"`, `--json`) nunca tienen un manejador y por tanto nunca
  preguntan — sin flag, el efecto simplemente no está disponible ahí. "Permitir en la sesión" dura
  mientras viva el proceso. La espera no cuenta para `limits.timeoutMs` (tiempo activo, ver «Revisión del plan»). El contrato `Policy` no
  cambió: la aprobación es una opción adicional de `RunnerOptions`.
- Confianza de proyecto: el hash guardado cubre solo el contenido de `.alisio/config.json`; si
  cambia únicamente otro recurso de proyecto (por ejemplo se añade `.alisio/agents` sin tocar
  `config.json`) no se vuelve a preguntar automáticamente — revóquelo con `alisio trust revoke` si
  hace falta. El prompt de confianza es un `readline` simple antes de la pantalla alterna, no la
  cola de `ask_user_question`: esta última se construye a partir de una `Application` ya creada, y
  crear esa `Application` es exactamente lo que la decisión de confianza controla, así que no podía
  usarse aquí. El almacén vive en `<ALISIO_STATE_HOME>/trust.json` con permisos 0600 (directorio
  0700); no está pensado para compartirse entre máquinas ni usuarios.

### Preguntas y herramientas de red

- `ask_user_question`/`/ask`: la cola interactiva compartida cubre aprobaciones, el `select` de
  plugins y las preguntas, pero deliberadamente NO incluye los selectores propios de `/model` ni
  `/resume` (siguen con su mecanismo previo sin cambios): son comandos que el usuario escribe él
  mismo, nunca concurrentes con la pregunta de un subagente, y `chooseModel()` ya no esperaba la
  resolución del selector antes de esta tarea, así que integrarlos habría exigido una
  reestructuración ajena al alcance. Retroceder a una pregunta de selección múltiple sin
  confirmarla descarta su selección provisional (solo las respuestas ya confirmadas sobreviven a
  ir hacia atrás y hacia adelante); al volver a entrar en una pregunta de selección múltiple sin
  respuesta previa, su opción por defecto (la recomendada, o la primera) queda premarcada, para
  que confirmar sin tocar nada sea una elección deliberada y no una selección vacía accidental —
  esto no aplica a la propia `initialQuestionState` de un lote nuevo, que empieza sin nada marcado.
  No se probó con subagentes reales concurrentes en una terminal (ver la sección de verificación).
- Un `resume` con otro modelo ya no falla: la sesión es la fuente del modelo y `--model`
  lo cambia explícitamente para los turnos siguientes.

- Plugins en proceso pueden bloquear el event loop o saltarse servicios mediados. Solo código
  confiable; los timeouts del motor no pueden detener código síncrono hostil.
- `execute` usa el módulo `vm` de Node, que **no es un mecanismo de seguridad** (documentación
  oficial de Node): aísla el ámbito global del snippet y acota su tiempo, pero no es una frontera a
  nivel de sistema operativo; un exploit de V8 podría escapar. Cada `callTool` anidado respeta el
  efecto/permiso ya concedido a la sesión, pero nunca puede solicitar uno nuevo. Límite fijo de 10 s
  y 20 llamadas anidadas (no configurables por el usuario final en esta versión).
- `webfetch`/`websearch` (efecto `external`) siguen sin sandbox de red: `--allow-external` da al
  modelo acceso a cualquier URL http(s) alcanzable, igual que `--allow-process` da acceso a
  cualquier ejecutable. El proveedor SearXNG por defecto (sin configurar nada) es poco fiable en la
  práctica frente a instancias públicas con protección antibots; véase la sección de verificación.
  DuckDuckGo Instant Answer solo responde consultas factuales directas, nunca búsqueda general.

### Persistencia, estadísticas y Herdr

- El bloqueo SQLite por PID está diseñado para procesos locales en un host, no para una base
  compartida en red. La reutilización de PID puede exigir intervención del usuario.
- La validación de rutas no es un aislamiento OS. La shell y plugins tienen permisos del usuario.
- Las estadísticas dependen del proveedor. Si no envía usage, el límite de tokens no es exacto;
  siguen aplicando límites de turnos, tiempo, longitud del contexto y salida por petición.
- El adaptador chat soporta texto y function tools; bloques privados de razonamiento de
  proveedores de terceros no se normalizan. Para continuation de OpenAI use Responses.
- La sesión restaura el historial activo (el compactado queda archivado). Hay migraciones
  hacia adelante e idempotentes (v1 → v4); no hay migraciones hacia atrás.
- Los blobs no tienen recolección de basura. Un adjunto resuelto desde un blob se persiste en el
  mensaje como base64 (igual que un adjunto en línea), porque `Attachment.data` sigue siendo
  obligatorio; el blob solo evita repetir la subida.
- `interruptRuns()` conserva las ejecuciones cuyo `owner_pid` es el del proceso actual (otra
  `Application` del mismo proceso); si el PID de un proceso muerto se reutiliza, esas filas siguen en
  `running` hasta el siguiente arranque con otro PID.
- Los manejadores core del catálogo son deliberadamente mínimos: `model` cambia el id de modelo de la
  sesión sin cambiar de proveedor, `effort` persiste el nivel sin validarlo contra el catálogo del
  modelo (la TUI sí lo valida) y `stats` resume el registro de ejecuciones, no las estadísticas en
  memoria de la TUI. La TUI solo delega `/tools` y `/sessions`; el resto de comandos sigue en su
  `switch`.
- Lectura/edición de texto limitada a 1 MiB. Búsquedas/salidas extensas se truncan explícitamente.
- La integración Herdr permite intercambio por terminales; no promete autonomía multiagente
  completa ni planificación distribuida.

### Agente activo y effort

- El effort se resuelve contra el catálogo del modelo activo en la TUI (carga asíncrona de
  `GET /models`): hasta que el catálogo llega, o si la consulta falla, no se envía ningún effort
  (degradación honesta, nunca un nivel inventado) y el segmento de effort se omite; cuando el
  catálogo por fin llega se repinta. En los modos headless (`run`, `resume`, `--no-tui`) el effort
  NO se envía (es una función de la TUI); el agente activo sí se aplica (prompt y acotación de solo
  lectura).
- El agente activo es una función del proceso actual: el cambio de agente se persiste en la capa de
  usuario, pero el cambio de modelo por agente sigue la semántica de `/model` (sesión nueva). Un
  agente con `model` no se re-aplica automáticamente si el usuario cambia el modelo después con
  `/model` — esa elección explícita del usuario gana hasta que se vuelva a elegir el agente.
- `reasoning_effort`/`reasoning.effort` se envían tal cual (validados contra `supportedLevels` del
  catálogo del modelo activo): el proveedor remoto es la autoridad final y puede rechazar un nivel
  que su catálogo ya no soporte; la aceptación real de cada nivel solo se verifica contra el
  servidor de pruebas, no contra la API pública.
- Los comandos `/agents`/`/effort` usan el nombre reservado `agents` que también registraba el
  plugin de subagentes: los verbos de gestión de tareas (con argumento) siguen enrutándose al
  plugin, pero el autocompletado del editor y `/help` muestran solo el comando de la TUI; la
  gestión de tareas sigue siempre disponible como `/agents <verbo>` y `/command agents <verbo>`.

### Servidor web

- `/btw`: la transcripción que ve la pregunta lateral es texto (cada mensaje recortado a 4 000
  caracteres, adjuntos solo como metadatos, sin datos de continuación del proveedor), no el
  historial nativo; el effort de razonamiento es el por defecto del runner (no el effort por sesión
  de la web); el historial compartido entre TUI y servidor es lectura-modificación-escritura sin
  bloqueo entre procesos (dos preguntas simultáneas desde procesos distintos pueden perder una
  entrada); la ruta no tiene idempotencia por `requestId`; en la TUI, una aprobación que llega
  mientras el panel está abierto lo sustituye (la respuesta queda en el historial y un aviso lo indica).
- Bloqueo de un solo host (PID en `sessions.locked_pid`); la web no recibe en vivo los cambios que
  hace una TUI en una sesión: se ven al reabrirla. Una sesión usada por otro proceso responde
  `409 session_locked`.
- Sin TLS; `--allow-remote` es opcional y pensado para túneles SSH. Con enlace a una dirección
  comodín (`0.0.0.0`, `::`) se aceptan cabeceras `Host` con IP literal además de las de loopback.
- El proveedor es por workspace (una `Application`): el cambio de perfil de proveedor afecta a todas
  sus sesiones; por sesión solo cambia el modelo (`runner.setModel`), y el evento `model_changed` no
  lleva `correlationId` (tampoco la compactación manual).
- La idempotencia de los prompts encolados es en memoria (100 ids por sesión, 10 min) y la cola de
  `enqueue` del runner se pierde si el proceso cae; un prompt con adjuntos durante una ejecución, o
  cualquier prompt mientras la sesión espera en cola o compacta, responde `409 session_busy`.
- Gestión (fase 5): no se instalan plugins desde la web; un cambio de plugin se aplica cuando el
  workspace queda sin runs (se recarga su app); el permiso MCP concedido desde la web vale para un
  workspace hasta que se detiene el servidor (salvo "recordar"); la credencial nueva de un perfil
  activo se usa al volver a activarlo; `DELETE .../credentials` borra todas las del perfil; la
  edición de definiciones de agentes queda fuera de v1; los estados de servidores MCP se muestran
  con su identificador sin traducir.
- Renderizadores ricos (fase 5): Mermaid pesa varios cientos de KB gzip repartidos en chunks
  (se carga solo con un diagrama visible); Mermaid incluye su propia copia de KaTeX para
  diagramas con fórmulas, distinta de la del renderizador `math`.
- Archivos (fase 4): el árbol, la lectura y el diff se limitan al workspace (las raíces de
  `--add-dir` no se exponen); `safePath` rechaza cualquier segmento que sea un enlace simbólico, así
  que los symlinks se listan pero no se abren aunque apunten dentro del workspace. El filtrado por
  `.gitignore` se hace por página (una página puede traer menos de 1 000 entradas) y necesita `git`;
  sin `git` se muestra todo salvo `.git`. **Cambios** deriva de las llamadas con efecto `write`
  (argumento `path` de `write_file`/`edit_file`) de la sesión y sus hijas y solo se anota con
  `git status`: los archivos que cambia un comando de shell no aparecen. Rutas fuera del workspace
  se omiten. El diff de un archivo sin seguimiento o de un repositorio sin commits se genera frente
  a `/dev/null` (máx. 1 MB leído); el de un archivo con seguimiento es `git diff HEAD` (incluye lo
  preparado y lo no preparado). La vista previa HTML/SVG es solo código (sin iframe).
- Blobs (fase 4): sin recolección de basura (spec §9.3); el tipo guardado es el detectado por
  bytes mágicos, no el declarado; la cabecera `Content-Type` de la subida solo admite los cuatro
  tipos de imagen o `application/octet-stream`.
- Métricas (fase 4): la línea de estadísticas se calcula en el cliente a partir de
  `run_started`/`turn_completed`/`tool_completed` (paginados por `GET /events` con `types=`); los
  tokens por segundo solo cuentan turnos que informan `usage.output` y `durationMs`; con eventos de
  versiones anteriores sin `durationMs` los tiempos LLM salen en 0.
- La interfaz web no vigila el stream con un temporizador de 45 s: el latido del servidor es un
  comentario SSE que `EventSource` no expone, así que la reconexión depende del propio navegador y
  de `online`/`visibilitychange`. La salida de comandos, los avisos y el razonamiento solo existen
  mientras la página está abierta; tras recargar, las filas de herramientas no muestran su duración.
- `Ctrl+K` lleva el foco a la búsqueda del sidebar (no hay una paleta de sesiones aparte), y los
  turnos terminados no se pliegan a un resumen "N pasos".
- Cada reconexión SSE recibe un snapshot completo (no se reenvían solo los eventos desde
  `Last-Event-ID`); la trayectoria en `GET /api/sessions/:sid/events` usa `events.seq` global como
  `seq`. Tras una compactación el cliente debe recargar los mensajes (el evento
  `compaction_completed` se lo indica).
- El binario independiente sirve solo la API y una página provisional: los assets web van con el
  paquete npm.

### Análisis en Python y artefactos

- Python administrado **no es un sandbox**: el script se ejecuta con los permisos del usuario,
  puede leer archivos, usar la red y modificar el repositorio; un proceso que haga `setsid` puede
  escapar del grupo de procesos al cancelar. El modo `oci` (Docker o Podman, imagen fijada por
  digest) bloquea la red, monta solo las carpetas del trabajo y limita memoria, CPU y procesos, pero
  un contenedor no es una frontera frente a una vulnerabilidad del kernel o del motor; solo se
  verificó en Linux con Docker. La imagen debe traer sus paquetes (el entorno de extras no se usa en
  `oci`).
- Panel de artefactos (fase 2): `Esc` pulsado dentro de un dashboard no llega a la app (el iframe
  aislado se queda con el teclado; queda el botón Cerrar); los dashboards no tienen red,
  `localStorage`, scripts de módulo ni fuentes desde archivos (sin `Access-Control-Allow-Origin`
  las peticiones CORS de un origen opaco fallan: fuentes en línea como `data:`); el enlace del
  visor caduca a los 10 minutos y los recursos que un dashboard pide más tarde fallan hasta
  reabrirlo; el PDF usa el visor del navegador sin `sandbox` (D9) y, sin visor integrado, la
  descarga; CSV/TSV/XLSX se abren en `SpreadsheetView` (fase 3). La página de Ajustes "Análisis de
  datos" (fase 4) edita `analysis.enabled`, el tiempo máximo y la retención; `runtime` y `oci.*` solo
  se editan en el archivo.
- `runToolCall` (copiar al workspace desde la web o la TUI) deja en el historial una nota de
  usuario, una llamada del asistente con un id de 9 caracteres, el resultado y un resumen del
  asistente: el modelo ve la copia en su siguiente turno como si la hubiera pedido él.
- El permiso persistido se registra para la sesión raíz; `execute` solo alcanza `python_run` con
  `--allow-analysis`/`--allow-process`, nunca con un permiso guardado. El uso de un permiso guardado
  no crea fila de auditoría (sí las decisiones y las ejecuciones por flag).
- La aprobación no muestra la ruta del intérprete (sí lo hace la página de Ajustes y `alisio
  analysis status`). La procedencia incluye modelo y proveedor desde la fase 4.
- No existe la operación de borrar sesión, así que sus permisos no se limpian. La retención
  (`AnalysisJanitor`) corre como máximo una vez al día y solo con Alisio abierto y escribible; el
  "último uso" de un dataset es la fecha de modificación de su archivo; los valores son solo
  globales. Un rerun usa las copias de entrada del trabajo original y se rechaza cuando el barrido
  ya borró el script. Extras: sin red no se instalan; sin wheel de `science` en Alpine ni en Windows
  Arm anterior a Python 3.13. No se implementaron el origen separado del visor, el lector XLSX en
  Node, las plantillas de artefacto ni XLS/ODS/Parquet (opcionales de §23).
- Las entradas (`inputs`) se copian siempre (sin enlace duro), también `datasetId` (fase 3).
- `alisio serve` sigue abriendo el navegador con su comando anterior (`cmd /c start` en
  Windows); `open-path.ts` solo se usa para archivos de la TUI.
- La línea `artifact: …` de los modos sin TUI va a stderr y no la oculta `--quiet` (no es una
  pista, es la ubicación del resultado).


### Datos tabulares

- Los datasets son archivos SQLite de `node:sqlite` (experimental en Node 22) leídos por un
  proceso aparte; sin `interrupt()` ni *authorizer*, la seguridad es la conexión de solo lectura
  más la guardia léxica de sentencia única. Sin índices: ordenar y filtrar recorren la hoja y se
  desactivan por encima de `analysis.data.maxInteractiveRows`; la hoja con orden o filtro solo
  alcanza por salto las primeras 100 000 filas (después se carga al desplazarse).
- XLSX requiere Python 3.10+ (helper con la biblioteca estándar; omite filas vacías; las celdas
  combinadas conservan el valor de la esquina superior izquierda); XLS, ODS y Parquet no se leen.
  Los JSON (no JSONL) se leen en memoria hasta 50 MiB. La cuadrícula recorta celdas de más de
  4 096 caracteres y el modelo ve 2 KiB por celda.
- La ingesta de más de 1 000 000 filas calcula `distinct`/más frecuentes sobre una muestra
  (`distinct_exact=0`). Los originales subidos desde la web quedan en `blobs/` hasta que la
  retención borra su dataset (30 días sin uso por defecto).

### Modos de permisos, recarga y novedades

- Un modo solo decide qué **efectos** se ejecutan sin preguntar: no es un sandbox, no cambia el
  confinamiento de rutas (los directorios externos siguen preguntando) ni la preconcesión de
  `--allow-analysis`. `auto` son reglas fijas, sin clasificador de IA.
- En la TUI el modo inicial es solo una etiqueta derivada de los flags: si plugins o MCP ya
  permitían `external` al arrancar, la etiqueta `ask` no lo refleja hasta elegir un modo
  (`/permission status` muestra la política real). Cambiar de modo reinicia las aprobaciones «para
  esta sesión»; se rechaza durante un turno y bajo `--read-only`.
- Shift+Tab en la TUI depende de que la terminal lo distinga (`\x1b[Z` o el protocolo Kitty); en
  la web intercepta una tecla de navegación y por eso el selector de agente es la vía accesible.
  Alternar no aplica el modelo del agente (usa `/agents`).
- `/reload` reconstruye la aplicación completa: los servidores MCP y plugins se reinician, el
  código de plugins ya importado no se recarga (el informe lo dice), los flags de arranque conservan
  su valor y se rechaza con subagentes o aprobaciones pendientes. Durante la recarga web coexisten
  un instante dos aplicaciones del mismo workspace sobre la misma base de datos. No hay
  `/reload` ni `/changelog` en `alisio run`.
- El changelog es solo inglés, manual y curado (`CHANGELOG.md`); una versión sin entrada no genera
  aviso, y `Unreleased` se muestra como «sin publicar».

### Pestaña Memory y vistas de plugins

- Las vistas de datos son de solo lectura **por contrato**, no por aislamiento: el host solo
  controla el método, los parámetros validados, el tiempo (5 s) y el tamaño (1 MiB); no puede impedir
  que el código de un plugin escriba y un handler síncrono que bloquee el bucle de eventos no se
  interrumpe con el timeout. Un plugin no es un sandbox.
- La pestaña no se actualiza en vivo (botón Refresh). Una memoria actualizada o fijada mientras se
  pagina puede saltar al principio de la lista (no se repite); una memoria con `topic_key` que otro
  chat actualiza pasa a ese chat (el upsert reasigna `session_id`) y sale de la lista del primero.
  Las sesiones hijas (subagentes) tienen su propio `session`: no aparecen en la pestaña del chat padre.
- «Context loaded» es lo que el plugin devolvió en `session.onStart`, guardado por el plugin; no
  prueba que el runner lo persistiera (si se aborta entre el hook y el `append`, queda registrado
  sin llegar al transcript; el runner además trunca cada texto) y se muestra completo hasta 50 000
  caracteres. Los chats anteriores a esta versión no tienen contexto registrado y el contexto
  recuperado tras una compactación no se guarda.
- La memoria puede contener datos sensibles del proyecto: la pestaña los muestra a quien tenga la
  cookie de sesión del servidor. Cada entrada se recorta a 10 000 caracteres en la lista.
- El selector «plugin habilitado» de la web depende de `GET /api/plugins` (se refresca al abrir una
  sesión y con `catalog_changed`); un plugin habilitado pero de una versión sin `api.views` muestra
  el error de la sección con reintento en lugar de ocultar la pestaña.
- Ajustes → General: las etiquetas de los ajustes viven en `components/settings/labels.ts` (carga
  perezosa con la página) y una prueba falla si una clave ajustable del servidor no tiene etiqueta en
  inglés o en español; una clave desconocida muestra su nombre y el traductor `t()` nunca lanza.

### Revisión del plan (`exit_plan`)

- El agente `plan` es de solo lectura porque la política de su ejecución no permite escritura,
  procesos ni red y no tiene aprobaciones: ningún modo de permisos ni preset la amplía. `exit_plan`
  (efecto `read`) es opt-in: solo la ejecución del agente `plan` integrado lo ve; `build`, los
  subagentes y Code Mode no pueden llamarlo. Un agente personalizado de solo lectura no lo recibe.
- El estado vive en `sessions.options.plan` (sin migración): una entrada por sesión, la última
  propuesta. Todas las transiciones son compare-and-set en una transacción `BEGIN IMMEDIATE`, por lo
  que aprobar dos veces (doble clic, dos pestañas, recarga) inicia **un** turno. La instantánea
  aprobada se conserva solo mientras está `approved`; después vive en el mensaje de usuario del turno
  de implementación.
- El cambio a `build` y el turno de implementación ocurren **cuando termina la ejecución del plan**,
  no en mitad de ella (el modelo recibe antes el resultado `approved` y responde una última vez). En
  la TUI el cambio es `agents.active` (global, como `/agents`); en la web, `session.options.agent`, en
  la misma transacción que la reclamación. Si el cambio de la TUI falla, la aprobación se pierde y se
  avisa cómo continuar a mano.
- Cancelar la ejecución retira la revisión pendiente y descarta una aprobación que no había empezado.
  El tiempo máximo de la ejecución (`limits.timeoutMs`, 10 min por defecto) cuenta **tiempo activo**:
  la espera de la decisión no lo consume (ver abajo). Una revisión sin respuesta equivale a «Skip for
  now» cuando la ejecución termina por otra causa. En la web, sin ningún cliente conectado durante 30 s
  (o 60 min con cliente; las aprobaciones de herramientas siguen en 10 min) la revisión se omite igual
  que las demás preguntas interactivas; en la TUI no hay tope de espera.
- Sin interfaz interactiva (`alisio run`, `--json`) o con `--read-only`, la herramienta devuelve
  `unavailable` y pide al modelo el plan completo como respuesta final; Alisio no lo imprime por su
  cuenta. El artefacto `plan.md` se crea igualmente cuando hay almacén de artefactos.
- **Reloj de la ejecución pausable.** `limits.timeoutMs` ya no es un límite de reloj: es un
  reloj de **tiempo activo** (`RunClock`) que se pausa mientras la ejecución espera a una persona. Una
  espera se marca en un único registro por aplicación (`HumanWaits`) que comparten el runner (aprobaciones
  de herramientas e instalación), la interfaz interactiva del host de plugins (`ask_user_question`,
  `exit_plan`, plugins; envuelta una sola vez en `setInteractiveUI`, así la TUI, el servidor web y
  cualquier integrador la heredan) y la aprobación de directorios externos. Las esperas simultáneas
  usan un contador: el reloj se reanuda al cerrarse la última. Una sesión hija que espera a una persona
  pausa también los relojes de sus ancestros; un padre que espera a su hijo no se pausa (es trabajo). Una
  espera sin sesión (`ui.select`) pausa todas las ejecuciones activas. `firstTokenTimeoutMs` y su
  reintento no cambian; `tasks.maxRunMs` tampoco. La ejecución devuelve `activeMs` y `goalOutcome` lo usa
  para `goal.maxMinutes`. Mensaje: «reached its limit of N s of active time (time spent waiting for you
  is not counted)».
- **Estado atascado tras una revisión interrumpida.** Una llamada de efecto `read` (como `exit_plan`)
  interrumpida por una detención o por el límite mientras lanzaba un error dejaba su fila del diario
  como `pending`, y el siguiente mensaje fallaba con «Uncertain tool outcome … sessions recover
  --acknowledge». Ahora una llamada `read` cancelada se cierra en el diario con el error (no pudo dejar
  efectos); las de `write`/`process`/`external` siguen pendientes a propósito. La propuesta `pending` de
  una ejecución terminada se marca `skipped` (`settlePlanRun`, en la TUI y en el servidor) y el
  artefacto del plan se conserva. Un proceso que muere con la revisión abierta deja la propuesta
  `pending` hasta la siguiente llamada a `exit_plan`, que la sustituye: no bloquea nada.
- Verificado: Vitest (reloj con fuente de tiempo falsa, registro `HumanWaits`, ejecuciones reales con
  aprobación, pregunta y revisión del plan que tardan más que el límite, un tope que sigue venciendo con
  trabajo real, esperas en paralelo, el caso del estado atascado) y Chromium contra `alisio serve` con un
  proveedor falso. No verificado: una TUI en un terminal real, otros navegadores, Windows/macOS, un
  proveedor real. No hay un tope duro de tiempo total (incluidas las esperas humanas) como límite
  aparte; en la web las esperas siguen acotadas por `approvalTimeoutMs` (10 min).
- La TUI edita el contexto en una línea (sin varias líneas ni historial) y su flujo de turno
  (reclamar, cambiar de agente, lanzar el turno) solo está probado por la lógica pura compartida y
  por el panel; no se ha verificado en un terminal real. En la web se comprobó con Chromium contra
  `alisio serve` y un proveedor falso; no con otros navegadores, Windows ni macOS.
- El presupuesto inicial de JS de la web quedó en unos 100 bytes de margen tras esta fase; la fase de
  tareas lo resolvió cargando bajo demanda el diccionario español (el bundle inicial bajó a ~78 KB).

### Diagramas del plan y visor del plan

- Contrato aditivo de `exit_plan`: `diagrams?: [{id, title, explanation, section?, type?, mermaid}]`. Sin él,
  la herramienta, el artefacto `plan.md` único y el resultado son los de siempre. Ajustes `plan.diagrams`
  (por defecto `true`) y `plan.maxDiagrams` (0–8, por defecto 5), vivos; el esquema que ve el modelo y la guía
  de estilo de `PLAN_INSTRUCTIONS` (agente `plan` integrado) siguen el ajuste en cada petición, mientras que
  la validación del esquema siempre acepta `diagrams` (se compila una vez al registrar la herramienta).
- Los diagramas son Mermaid (`.mmd`) escritos por el modelo. **La validación es ligera y no dibuja** (Mermaid
  necesita DOM): 8 KB por diagrama, lista de tipos (`flowchart`, `graph`, `sequenceDiagram`, `stateDiagram`,
  `stateDiagram-v2`, `erDiagram`, `classDiagram`, `gantt`, `mindmap`, `timeline`, `journey`), estimación de 40
  nodos por diagrama (por exceso; no es un analizador), y rechazo por texto de `click`/`link`/`callback`,
  `href`, `javascript:`/`vbscript:`/`data:`, `url()`, etiquetas HTML y directivas `%%{init}` o front matter con
  `securityLevel`, `htmlLabels`, `secure`, `themeCSS`, etc. Un diagrama rechazado se **descarta** con el motivo
  en el resultado de la herramienta; nunca rompe la revisión. Un diagrama que pasa pero no se dibuja en la web
  muestra su código y el error. Nada comprueba que el diagrama diga la verdad del plan.
- Con diagramas aceptados (o quitados respecto a la revisión anterior) el plan es **una carpeta por revisión**
  con entrada `plan.md` (tipo `document`, nombre `plan.md`; la descarga es un ZIP). La carpeta se escribe en un
  directorio temporal del sistema que el publicador copia y se borra. Si publicar la carpeta falla, se publica
  `plan.md` solo y se avisa. Para que el nombre fuera `plan.md` y no `plan.zip`, el almacén admite un
  `fileName` opcional en `publish` (solo interno de core; el SDK no cambia en `ArtifactPublishInput`).
- `plan.json` (`version: 1`) lo genera Alisio de forma determinista a partir del Markdown (secciones Goal,
  Context, Steps, Decisions, Risks y Verification con alias en inglés y español; un `#` de título no cuenta
  como sección) y de los diagramas: resumen, objetivos, etapas, consideraciones, encabezados con ids estables,
  y por diagrama id, título, explicación, sección resuelta, tipo, sintaxis, archivo, hash y estado
  (`new`/`updated`/`unchanged`) más `removed`. El visor lo lee de forma tolerante: ignora campos desconocidos,
  descarta elementos mal formados y solo acepta rutas `diagrams/<id>.mmd`.
- Sincronización de revisiones: la revisión anterior se lee del **estado del plan** (`sessions.options.plan.
  diagrams`: id, título y hash), no del manifiesto del artefacto anterior; así funciona aunque el artefacto se
  haya borrado o caducado. `planHash` sin diagramas es el SHA-256 del Markdown de antes; con diagramas también
  cubre sus hashes, de modo que un cambio solo en un diagrama es otra propuesta. Los estados guardados antes
  de esta versión siguen siendo válidos (el campo es opcional).
- Visor web (`components/plan/PlanViewer.tsx`, carga diferida; el contenedor `LazyPlanViewer` pesa ~1 KB en el
  panel): se abre para un artefacto con entrada `plan.md` y `plan.json` en sus archivos, por la ruta
  autenticada existente de archivos (sin rutas nuevas). Los diagramas usan el renderizador Mermaid existente
  con `themed` (tema `base` con variables de Alisio y un bloque `classDef` para las clases semánticas que el
  diagrama use sin definir); los bloques Mermaid del chat no cambian. Es Preact sin HTML del plan (solo el SVG
  saneado por el camino existente). Presupuesto inicial de JS: 80,2 KB de 90 KB.
- La TUI no dibuja: muestra título, propósito, sección, explicación y las primeras 8 líneas del código tras el
  plan (como Markdown, no con `renderCappedCode`), la ruta de la carpeta (resuelta desde el almacén) y se abre
  desde `/artifacts` (la vista previa lee `plan.md`). Sin interfaz o con `--read-only` el plan vuelve como
  texto y los archivos se escriben.
- No hay visor HTML autónomo descargable (exigiría incrustar Mermaid, unos 138 KB comprimidos de núcleo).
  Verificado en Chromium contra `alisio serve` con un proveedor falso (tema claro y oscuro, 390 px, teclado,
  revisión 2 con actualizado y quitado, ZIP, `plan.diagrams: false`); no en otros navegadores, Windows ni
  macOS, y la TUI solo por pruebas de su lógica, no en un terminal real.
- Guía de usuario: [Modo plan y revisión del plan](/es/plan).

### Tareas en segundo plano

- Una tarea es un proceso hijo corriente de Alisio: **no es un sandbox** y **no es *detached***. Muere
  con Alisio (grupo de procesos; `taskkill /T /F` en Windows, sin verificar en una máquina Windows) y
  no sobrevive a un reinicio. Tras una muerte abrupta (SIGKILL, corte de luz) ningún código puede
  correr: el siguiente arranque marca `lost` lo que quedó sin terminar y sus procesos pueden seguir
  vivos (la tarea muestra su `pid`). La detección usa `owner_pid`: un pid reutilizado por otro proceso
  puede ocultar una tarea perdida hasta que ese proceso termine.
- Un comando que deja hijos en segundo plano (`cmd &`) los pierde: se mata el grupo. La tarea termina
  cuando se cierran todas sus salidas.
- El log conserva la cabeza y los últimos 32 KiB: la parte central de una salida muy larga se pierde.
  Las lecturas del modelo están acotadas a 64 KiB; el panel web conserva 200 000 caracteres.
- La notificación solo sale de procesos con un anfitrión que sepa despertar (TUI y servidor); `alisio run`
  nunca la envía. La TUI espera a que el usuario vuelva a la sesión propietaria; una tarea que termina
  mientras el servidor está caído no se anuncia. En `ask`/`auto` cada llamada de `bg_*` pide aprobación
  (también `bg_list` y `bg_output`; «Allow for this session» cubre el resto).
- No hay `run_in_background` ni cesión a segundo plano de un comando en primer plano: solo `bg_run`
  explícito. Los subagentes aparecen en la lista solo como espejo de solo lectura.
- Un workspace con tareas vivas no se expulsa por inactividad y `/reload` se rechaza hasta que
  terminen; reciclar el workspace (por ejemplo al activar un plugin) espera igual.

### Objetivos de sesión (`/goal`)

- **Sin presupuesto de tokens por defecto**: un goal sin `budget=` solo se detiene por `goal.maxTurns` y
  `goal.maxMinutes`. El presupuesto es duro pero se aplica por petición: el gasto puede pasar del tope
  como mucho una petición (más si el proveedor no informa `usage`, donde se estima por caracteres). No
  hay turno de cierre. Cuenta entrada y salida de cada petición, es decir, un contexto largo se paga de
  nuevo en cada turno.
- **No hay modelo evaluador**: el modelo decide cuándo termina o se bloquea, con evidencia que Alisio
  guarda y muestra pero **no verifica**. Un modelo puede dar por terminado algo que no lo está.
- Un «turno» es una ejecución, no un paso del modelo; el tiempo cuenta el tiempo **activo** de las
  ejecuciones (esperar a la persona dentro de una ejecución —una aprobación, una pregunta, la revisión
  del plan— no cuenta; antes sí contaba; esperar entre ejecuciones tampoco). La continuación recibe como
  límite de ejecución lo que queda de `goal.maxMinutes`, también en tiempo activo.
- Los disyuntores usan una huella del texto final (normalizada) y el número de llamadas a herramientas
  (`get_goal`/`update_goal` cuentan como llamadas): un modelo que varía una frase evita el primero.
- Un goal pausado por reinicio nunca se reanuda solo, y el reinicio se decide por `owner_pid`: un pid
  reutilizado por otro proceso podría ocultar un goal huérfano hasta que ese proceso termine.
- La TUI no continúa mientras haya texto sin enviar en el editor ni con otra sesión abierta; la web no ve
  en vivo los cambios que una TUI hace en un goal. `alisio run` no tiene `/goal` en la v1.
- Un goal no amplía permisos y nunca se ejecuta en modo plan, pero en `full` el agente actúa sin preguntar
  durante horas: no es un sandbox. El objetivo se cita como dato, no como instrucción privilegiada, lo que
  reduce pero no elimina la inyección desde un texto malicioso que el usuario pegue.
- La TUI se verificó por lógica pura y fake terminal, no en un terminal real; la web, en Chromium.

### Decision Intelligence

- **No se incluye ningún proveedor**: sin un plugin de proveedor registrado y nombrado en
  `decisions.provider`, la función no hace nada. El plugin oficial de Laya está previsto en el
  repositorio `alisio-plugins` y no está publicado. La única función integrada que consume decisiones
  es Smart Dashboard; los plugins también pueden usar `ctx.decisions` en sus herramientas.
- **`confidence` no está calibrada** (Fase 0, E2): `decisions.minConfidence` es un filtro heurístico y
  un umbral de 0.6 no separó de forma fiable los casos claros de los ambiguos en una muestra pequeña
  etiquetada a mano. Alisio no la trata como probabilidad; la calidad debe medirse en la función que
  consume la decisión.
- **`dispose()` no se llama al deshabilitar un plugin ni con `/reload`** (ambos requieren reiniciar);
  solo al cerrar la aplicación. Una muerte súbita (`SIGKILL`, una caída) no se cubre: un plugin que
  posee un proceso del sistema debe limpiar los huérfanos él mismo. Un `dispose()` que supera
  `pluginHooks.disposeTimeoutMs` se abandona y se registra, pero no se puede interrumpir código
  síncrono bloqueante.
- **Los errores de ciclo de vida solo se ven en `/decisions`**: un `activate()` o `deactivate()`
  fallido no genera evento ni aviso en otro sitio.
- **El `/stats` de la TUI cuenta solo el proceso de TUI actual**, como el resto de sus estadísticas, y
  conserva como máximo los últimos 2000 eventos de decisión; la web muestra las estadísticas de
  decisiones solo en el tooltip de los totales de la sesión, no en la línea principal.
- **Ajustes en la TUI**: `pluginHooks.disposeTimeoutMs` y las claves `decisions.*` no figuran en el menú
  `/settings` de la terminal; se editan en el archivo de configuración. En la web sí son ajustables
  (Ajustes → General).
- Con `decisions.telemetry` en `false` los eventos no se persisten: no hay sección en `/stats` ni
  estadísticas web, y `/decisions` solo muestra las métricas en memoria del proceso. Un `state` puede
  salir del proceso si el adaptador del proveedor lo decide; el núcleo solo garantiza que los eventos y
  las métricas no lo contienen. Los plugins no son un sandbox.

### Smart Dashboard

- **No está disponible con `--read-only`**: la herramienta publica un artefacto, así que se elimina
  igual que `artifact_create`. También la elimina `analysis.enabled: false` y
  `analysis.smartDashboard: false`; el interruptor se aplica al siguiente arranque, y un `false`
  global no lo deshace un proyecto.
- **Un dataset por llamada**, sin uniones entre hojas ni archivos, sin filtros interactivos y sin
  regeneración incremental con memoria del dashboard anterior (cada llamada es independiente).
- **Sin tablas cruzadas, sin filtros de filas y sin métricas derivadas** (margen, variación
  interanual, tasas): en una ejecución real el modelo recurrió a `python_run` para un cruce canal x
  región y para excluir pedidos cancelados. Además, en la primera ejecución real la frase «ventas netas» no coincidía con la
  columna de ventas netas y el dashboard usó ventas brutas; corregido en 0.4.3.
- **Solo las fechas ISO 8601** son columnas de tiempo: otros formatos de fecha no producen tendencia.
  Las marcas con zona horaria se normalizan a UTC y un texto como `"2024"` no se trata como fecha.
- **Catálogo cerrado** (`kpi`, `line`, `area`, `bar`, `hbar`, `pie`, `donut`, `scatter`, `table`; hasta
  12 componentes y 6 KPI): mapas, embudos, tablas dinámicas y exportación a PDF quedan fuera; lo demás
  se hace con `python_run`.
- **La moneda no se infiere de los datos**: el dinero se muestra como número. Los porcentajes solo se
  formatean como tales si el nombre de la medida lo indica y todos los valores son fracciones.
- Barras horizontales: la ayuda emergente seguía la fila vecina porque la interacción `index` de
  Chart.js busca por el eje x. El script compartido `charts-boot.js` fija `interaction.axis = 'y'`
  solo para `hbar` (Fase 0, E5), igual en los dashboards de Python y en el renderizador TypeScript.
  Verificado en un navegador real (Chromium, Playwright): 8 de 8 filas en cada uno, serie única (TS)
  y tres series (Python); la prueba unitaria comprueba la configuración, no el hover.
- El color sigue `prefers-color-scheme` del navegador, igual que los dashboards de Python.
- Un componente cuya consulta falla (por ejemplo por tiempo límite) se omite y se anota; si ninguna
  responde, la herramienta falla y no publica nada.
- Un proveedor de decisiones recibe solo el objetivo y metadatos de columna, nunca valores; el núcleo
  no decide adónde envía esos datos un adaptador.
- Pendiente de esta entrega: la medición E7, los resultados del benchmark B/C y el release.
- Guía de usuario: [Smart Dashboard](/es/smart-dashboard).

### Gráficos de los dashboards (`alisio_runtime.charts` y `svg`)

- Chart.js 4.5.1 (MIT, `chart.umd.min.js`, 208 KB y unos 70 KB comprimido) viaja dentro de
  `@alisio/core` como cadena en `analysis/python/sources.ts` (generada por
  `scripts/analysis-runtime-sources.ts`; un test falla si queda desactualizada) y se copia con el resto
  de `alisio_runtime` a cada ejecución. `charts.write`/`charts.page` lo incrustan **una vez** en el HTML:
  cada dashboard con gráficos pesa unos 215 KB más. No hay CDN ni `eval`.
- **Es el único motor de gráficos.** Plotly sigue como extra opcional pesado. `svg` es solo salida estática.
- El color del dashboard sigue `prefers-color-scheme` del navegador: el iframe aislado no conoce el tema
  elegido en Alisio, así que un dashboard puede verse claro dentro de una interfaz oscura.
- Las cifras se formatean en el navegador con `Intl.NumberFormat` y el `locale` que pase el modelo (por
  defecto el del visor); los `svg.*` usan un formato compacto fijo (`1.2k`). Las tarjetas de gráficos
  no tienen paginación: una tabla de datos con miles de filas pesa en el HTML.
- La puerta de calidad (`artifacts/chart-lint.ts`) solo avisa: arcos SVG de tarta escritos a mano,
  SVG de tamaño fijo sin `viewBox` y scripts u hojas de estilo remotos. Son heurísticas sobre el HTML
  (no ejecuta la página) y pueden fallar en ambos sentidos; nunca rechaza un artefacto.
- Verificado: Vitest (geometría pura de las tartas con los tres conjuntos de datos del informe, estructura de
  `charts`, aviso de la puerta, publicación con Python real) y Chromium contra `alisio serve` con un
  proveedor falso: CSP real sin errores de consola, 1280 px y 390 px sin desbordamiento horizontal, esquema
  claro y oscuro. No verificado: otros navegadores, Windows o macOS, un modelo real con las nuevas pautas,
  lectores de pantalla ni impresión a PDF.
- Guía de usuario: [Gráficos](/es/analysis#charts).

### Compactación automática por presupuesto de caracteres

- El presupuesto `limits.maxContextChars` (800000 por defecto) es ahora también un disparador: la
  compactación automática se ejecuta cuando instrucciones + transcript alcanzan `threshold` (0,85) de
  ese límite, además del criterio por ventana. Antes, con una ventana grande (DeepSeek, ~1M) el límite
  duro se alcanzaba mucho antes de que la compactación se disparara y la ejecución fallaba.
- Último recurso: si tras recortar la conversación sigue sobre el límite y no se intentó compactar en
  ese turno, se ejecuta una compactación (motivo `budget`, ampliación aditiva de los eventos y hooks
  del SDK) y se recorta de nuevo; como máximo un intento por turno. Una compactación que falla en este
  punto se informa en el error final en vez de ocultarlo.
- El error empieza igual (`Context budget exceeded`) y ahora dice si la compactación se ejecutó, se
  omitió (sin frontera segura), falló o está desactivada.
- Web: `compaction_started` y sus finales marcan un indicador `compacting` por sesión (sin ejecución,
  como en `/compact` manual): muestra «Compactando el contexto…» y bloquea el envío, conservando el
  borrador. El servidor sigue respondiendo `session_busy`; la TUI no cambió.
- Límites: el recorte sigue sin tocar los argumentos de las llamadas a herramientas ni `providerData`;
  un único turno enorme sin frontera segura todavía puede fallar (ahora con un mensaje exacto);
  tras compactar, si la cola conservada sigue por encima del 85 %, cada turno vuelve a intentarlo.
  Verificado con tests de módulo (runner y reductor web puro); no verificado con un DeepSeek real
  ni con una captura del navegador.

### Forja: Fase 0 y Fase 1 (contratos puros)

Forja (ejecución aislada de código; especificación en `specs/alisio-forja-v1.md`) está **en curso**: todavía
no hay ninguna herramienta ni motor visibles para el usuario (la clave de configuración `forge` existe desde
la Fase 2 y no tiene efecto).

- Fase 0 (experimentos, fuera del repositorio): en Node el `WorkerIsolateHost` cierra con `terminate()` en
  ~1 ms (10/10) y arranca en ~28 ms; en Bun, `terminate()` tarda entre 20 y 3 702 ms, así que Bun usa
  `ProcessIsolateHost` (~27 ms). El WASM de `quickjs-wasi` mide 637 405 B con SHA-256
  `d4c9375f2b1ca4dc95f72c8aa2982a7a9951ac8011490d79c6582df732b4bbd9`. Pyodide 314.0.7 en Node 22.19 superó la
  puerta P0 con una salvedad: la red **no** queda denegada por el sistema en Node 22/24 (`node:http` es
  alcanzable desde Python vía FFI). El runner de Vitest de Stryker 10 ejecuta 0 pruebas por mutante con
  Vitest 5.0.1 y TypeScript 7.0.2 (0 % falso), por lo que se descartó (D-27).
- Fase 1, entregado: tipos aditivos en `@alisio/sdk` (`EngineLanguage`, `EngineId`, `IsolationLevel`,
  `EngineDescriptor`, `ForgeProgress`) y módulos puros en `packages/core/src/forge/`: `ports`, `errors`,
  `limits` (global ∩ proyecto ∩ solicitud; proyecto y solicitud solo bajan, tope global duro),
  `state-machine` (transiciones de §5.2, terminal una sola vez), `protocol` (validación del lado host:
  tipo, `seq` creciente, correlación de `callId`/`requestId`, 256 KiB, profundidad 32, claves prohibidas,
  solo JSON, cierre tras el terminal, `call`/`catalog` solo con `toolCalls`), `budget` (llamadas totales y
  simultáneas, créditos, bytes de salida), `selector` (cadena de responsabilidad genérica y reglas de
  JavaScript) y `registry` (solo se registra un motor `ready`; si no, `UnavailableEngine`, fallo cerrado).
  Nada de esto está conectado a `application.ts`, al runner, a las herramientas ni a la configuración.
- Verificado: pruebas de módulo `tests/forge-*.test.ts` (63) con Rojo → Verde → Refactor, más la puerta
  completa (`typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`,
  `docs:build`).
- Mutation testing lite (`pnpm test:mutation`, fuera de `pnpm check` y de CI): `@stryker-mutator/core`
  10.0.0 con `testRunner: "command"` (Vitest con `vitest.mutation.config.ts`), `coverageAnalysis: "off"`
  y `tsconfigFile` apuntando a un archivo inexistente. Así se desactiva su preprocesador de `tsconfig`,
  que usa la API JavaScript de TypeScript que TypeScript 7 no ofrece. El runner de Vitest de Stryker no se
  usa: con Vitest 5.0.1 ejecuta 0 pruebas por mutante.
  - Alcance: `limits.ts`, `state-machine.ts` y `protocol.ts`.
  - Validez: los dos mutantes de control (una comparación de `limits.ts` y una transición de
    `state-machine.ts`) hacen fallar sus pruebas.
  - Resultado (2026-10-12): **94,65 %** (177 mutantes muertos, 10 supervivientes) en 1 min 18 s con
    concurrencia 2.
  - Supervivientes aceptados por irrelevantes o equivalentes:
    - las opciones `allErrors` y `strict` de Ajv;
    - la rama de prototipo `null`, que no puede llegar desde JSON;
    - el encadenado opcional del validador de payload;
    - cinco en `limits.ts`, todos en constantes de tamaño por defecto (`64 * KiB` → `64 / KiB`).
      Probarlas solo repetiría la constante.
  - No se añadieron pruebas solo para matar mutantes.
- Límites: el protocolo exige `seq` estrictamente creciente (se permiten saltos); los límites de entrada y
  respuesta por llamada y las franquicias de ejecuciones activas por sesión y proceso quedan para el
  kernel y el broker (Fases posteriores).

### Forja: Fase 2 (diario, estado, directorio de sesión y configuración)

Sigue sin haber herramienta ni motor visibles: todo lo siguiente es infraestructura que usarán las fases 3 y
posteriores, y **nada está conectado todavía** a `application.ts`, al runner ni al gate.

- Entregado:
  - Migración SQLite **v9** (aditiva) en `runtime/store.ts`: `forge_executions`, `forge_calls` (con
    `paths_json`) y `forge_state`, con los índices de §9.1. Se añade la columna `owner_pid` a
    `forge_executions` (no está en la tabla de la especificación; ver decisiones).
  - `forge/journal.ts`: `SqliteExecutionJournal` (abrir, `transition` a estados no terminales validada con la
    máquina de estados, `close` terminal una sola vez con comparación de estado, `startCall`/`endCall` con ID
    `${callId}:forge:${n}`, solo hashes de entrada, `paths_json` solo para el efecto `write`;
    las llamadas en curso quedan `started` al cancelar) y `reconcileInterruptedExecutions` (§9.3).
  - `forge/state-delta.ts` (puro) y `forge/state-store.ts` (SQLite): instantánea de entrada, delta de salida,
    comparación de revisión por clave en una transacción, `STATE_CONFLICT`, clave ≤ 128 caracteres, valor
    ≤ 64 KiB y total por sesión raíz ≤ `maxTotalBytes`. Un borrado deja una lápida (valor vacío) que sigue
    contando revisiones.
  - `forge/session-path.ts` (puro) y `forge/session-dir.ts`: raíz temporal (`ALISIO_TMPDIR` > `forge.scratch.root`
    > `os.tmpdir()`), slug, creación `0700` por nivel con `lstat` (directorio, no symlink, dueño, sin bits de
    grupo ni otros), respaldo a `<stateHome>/scratch/<workspaceKey>/<rootSessionId>/` con diagnóstico (sin
    `chmod` ni seguir enlaces), marca `.alisio-session`, `resolveScratchPath` (rechaza `..`, absolutas fuera,
    symlinks que escapan y symlinks colgantes con `INVALID_INPUT`), cuota por `maxBytes`
    (`writeScratchFile`, `BUDGET_EXCEEDED`, sin borrar nada) y archivos `0600`.
  - `ScratchJanitor` en `analysis/janitor.ts`: borra directorios de sesión de sesiones raíz inexistentes o con
    actividad (archivo más reciente) anterior a `retentionDays`; exige directorio real, marca coincidente y
    ruta real bajo la raíz verificada; nunca sigue symlinks; una pasada cada 24 h con candado. El candado se
    extrajo a una función compartida con `AnalysisJanitor` (sin cambio de comportamiento).
  - Configuración `forge` (`javascript`, `state`, `scratch`, `guides`) en `config.ts`, `.strict()`, con
    `forge.javascript.enabled` en **`false`** hasta la puerta de la Fase 3. Solo globales: `javascript.host`,
    `memoryBytes`, `stackBytes`, `state.maxTotalBytes` y `scratch.*` (un proyecto que los escribe los ve en
    `provenance.ignored`). Un proyecto solo baja `timeoutMs`, `maxToolCalls`, `maxConcurrency` y
    `maxOutputChars`, y solo puede apagar `javascript`, `state` y `guides`, nunca encenderlos.
- Verificado: 86 pruebas nuevas en 8 archivos (`forge-journal`, `forge-state-delta`, `forge-state-store`,
  `forge-session-path`, `forge-session-dir`, `forge-scratch-janitor`, `forge-config` y
  `store-migration-v9`) con SQLite real y directorios temporales reales; las cinco comprobaciones de
  `store-migration-v*`/`scenarios` que listaban las versiones de migración ahora incluyen la 9. Mutation
  testing (`pnpm test:mutation`, ahora sobre `limits`, `state-machine`, `protocol`, `state-delta` y
  `session-path`): **95,50 %** (297 muertos, 14 supervivientes) en 57 s. Los supervivientes de la Fase 2 son
  equivalentes o de constante por defecto: `input.length === 0` en `resolveWithin` (el caso vacío cae igual en
  la comprobación de ruta), el `catch` de `JSON.stringify` (el resultado sigue siendo `undefined`) y
  `512 * 1024` de `DEFAULT_STATE_TOTAL_BYTES`. Un caso real (`resolveWithin(base, "..")`) se cubrió con una
  prueba después de la ejecución.
- Decisiones donde la especificación era ambigua:
  - `owner_pid` en `forge_executions`: sin él, el arranque de un segundo proceso marcaría `failed` las
    ejecuciones vivas del primero. La reconciliación solo toca filas sin dueño o con dueño muerto
    (`isProcessAlive`), el mismo criterio de `background_tasks`.
  - La razón `interrupted` se guarda en `metrics_json` (`{"reason":"interrupted"}`): no hay columna de razón.
  - La reconciliación pasa cualquier estado no terminal a `failed` aunque la máquina de estados no lo permita
    como transición (`cancelling` solo va a `cancelled`): es una corrección de datos tras un proceso muerto,
    no un paso del ciclo de vida.
  - Códigos de error: clave o valor inválidos → `INVALID_INPUT`; total por sesión excedido y cuota del
    scratchpad → `BUDGET_EXCEEDED`.
  - El límite duro de `forge.state.maxTotalBytes` es 8 MiB (la especificación no fija un máximo).
  - No se registró `forge.javascript.enabled` ni `forge.guides.enabled` como ajustables en vivo: añadirlos a
    `SETTABLE_KEYS` exige etiquetas y textos en la web (paridad EN/ES), trabajo de la Fase 7.
- Limitaciones y pendiente para la Fase 3:
  - Sin cablear: `reconcileInterruptedExecutions(store.db)` debe llamarse donde `application.ts` abre el
    `SQLiteStore` (no existe un gancho análogo para `analysis_executions`; el janitor solo trata sus filas
    `running` de más de 24 h). `ScratchJanitor` debe crearse y arrancarse junto a `AnalysisJanitor`
    (`roots`: `<tmp>/alisio-<uid>` y `<stateHome>/scratch`; `sessionExists`: el almacén de sesiones;
    `retentionDays`: `config.forge.scratch.retentionDays`). `SqliteExecutionJournal` y `SqliteStateStore`
    se construyen sobre `store.db`.
  - **Raíz autorizada del scratchpad en el gate de rutas (FJ-AC-31) y la línea de `FORGE_ROUTING_RULE`**: no
    están en esta fase; van con el runner (Fase 3). Tampoco `codePath` (FJ-AC-30): `resolveScratchPath` es el
    soporte listo.
  - Un proyecto que sube un límite reducible lo ve limitado en silencio al valor global (no aparece en
    `provenance.ignored`).
  - La verificación de dueño del directorio raíz se prueba con la función pura (`privateDirProblem`); la
    prueba con otro uid real exigiría privilegios. En Windows no se ejecutan las comprobaciones POSIX.

### Forja: Fase 3a (gate extraído, cambios del runner y puerto de llamadas anidadas)

Sigue sin haber herramienta `js_run` ni motor QuickJS (Fase 3b): con `forge.javascript.enabled` en `false`
(valor por defecto) no hay herramientas nuevas, el prompt no cambia y el gate de rutas se comporta como antes.

- Entregado:
  - Pruebas de caracterización **antes** de mover lógica: `runner-gate-characterization` (ask/auto/full,
    solo lectura, capacidades `--allow-analysis`/`--allow-process`/concesión guardada, `toolFilter`, opt-in,
    `availableTools`) y `execute-tool-characterization` (nested: deniega en vez de preguntar, exclusión de
    opt-in, autollamada, regla de `analysis.run`, límite de 20 llamadas). El defecto D-28 queda fijado como
    prueba `KNOWN DEFECT D-28: ...`: un subagente con `write` denegado y la herramienta filtrada la sigue
    alcanzando con `execute`. Se volteará cuando `execute` se retire (3b).
  - `permissions/decide.ts` (puro): `decideEffect(policy, tool, {approvals, capabilityGranted})` →
    `allow` (`via`: `effect`/`flag`/`grant`) | `ask` | `deny`, más `effectAllowed`, `effectAskable` y
    `capabilityFlagAllowed`. Lo usan `runner.ts` (`availableTools` y la rama de decisión de `executeCall`) y
    `tools/execute.ts`, sin cambio de comportamiento (las pruebas de caracterización siguen en verde).
  - Runner (D-23): (a) el lote paralelo de lecturas respeta `concurrent: false`; (b) la llamada puede
    marcarse `effectful` y una lectura cancelada ya no se cierra como no pendiente si lo hizo; (c)
    `scope.guard(efecto)` lo aplica el despachador anidado. Marca y despachador viajan por
    `core/call-internals.ts` (un `WeakMap` ligado al contexto de la llamada; no está en el SDK).
  - `forge/nested.ts`: `createNestedDispatcher` / `NestedCallDispatcher` (D-24, D-29): `toolFilter`,
    `optInAllows`, política **viva** del run, `decideEffect` con `approvals:false` y sin concesiones, rutas
    resueltas con `interactive:false`, `decisions`/`artifacts` ligados al `callId` padre, `approveInstall`
    siempre `deny`, exclusión de `FORGE_EXCLUDED_TOOLS`, errores estructurados (`TOOL_UNAVAILABLE`,
    `TOOL_INPUT_INVALID`, `PERMISSION_DENIED`, `APPROVAL_REQUIRED`, `TOOL_FAILED`, `CANCELLED`). Marca al
    padre `effectful` cuando empieza una llamada que no es `read`/`internal`. Corrige D-28 para `js_run`
    (política y filtro del run, también en sesiones hijas).
  - Cableado de la Fase 2 en `application.ts`: `reconcileInterruptedExecutions(store.db)` al abrir el
    almacén; `ScratchJanitor` junto a `AnalysisJanitor` (no se arranca con `:memory:` ni con `--read-only`);
    `SqliteExecutionJournal` y `SqliteStateStore` en `app.forge.{journal,state}`; `app.forge.scratchpad`
    (`undefined` con Forja apagada) y `app.forge.scratchJanitor`.
  - Scratchpad como raíz autorizada (FJ-AC-31): `PathAccess` acepta un proveedor `scratchpad(session)` (solo
    cuando `forge.javascript.enabled` y `forge.scratch.enabled`; `forge/scratch-provider.ts` crea el
    directorio de la sesión **raíz** con `ensureSessionDir`, una vez). Una ruta dentro del scratchpad
    verificado se resuelve sin aprobar el directorio, y una escritura confinada a él no pide aprobación.
- Verificado: 90 pruebas nuevas en 8 archivos (`runner-gate-characterization`,
  `execute-tool-characterization`, `forge-decide-effect`, `runner-forge-hooks`, `forge-nested-dispatcher`,
  `forge-scratch-gate`, `forge-scratch-provider`, `forge-application`; apoyo en `forge-gate-helpers.ts`) con
  runner, SQLite y herramientas reales. Mutation testing (`decide.ts` añadido): 98,33 % en el módulo nuevo (59
  muertos, 1 superviviente: tratar `analysis` como un efecto; se cubrió con una prueba y se comprobó a mano
  que ahora falla); total 95,96 % (356 muertos, 15 supervivientes, los 14 anteriores son de la Fase 1/2) en 29 s.
- Decisiones donde la especificación era ambigua:
  - La raíz del scratchpad solo levanta un `ask`: un run que no puede preguntar (sin manejador, `approvals:false`,
    hijo con escritura denegada) conserva su denegación, y `--read-only` la mantiene porque `PathAccess` ignora
    el scratchpad en ese modo. Una lectura dentro del scratchpad tampoco pide aprobar el directorio.
  - `APPROVAL_REQUIRED` si una llamada directa equivalente habría preguntado; `PERMISSION_DENIED` si no habría
    podido ni preguntar (solo lectura, `approvals:false`) o la ruta queda fuera de las raíces. Un rechazo del
    `guard` del run (contexto cambiado, presupuesto agotado) también es `PERMISSION_DENIED`.
  - El `ScratchJanitor` no recorre la raíz temporal compartida cuando la aplicación usa una base de datos
    propia (`options.db`, pruebas y embebedores): no puede saber qué sesiones existen y borraría las de otro
    almacén. Con el almacén por defecto recorre `<tmp>/alisio-<uid>` y `<stateHome>/scratch`.
  - El `emit` de una llamada anidada es nulo: el progreso del padre lo emitirá el broker (3b) con la carga
    `forge` tipada.
- Limitaciones y pendiente para la 3b:
  - `execute` sigue registrado y con el defecto D-28 hasta que `js_run` lo reemplace. No hay prueba de la
    cuota del scratchpad (FJ-AC-34) en el gate de las herramientas de archivo ni la línea de
    `FORGE_ROUTING_RULE`; van con `js_run`/Fase 3b.
  - El `guard` anidado se prueba contra el despachador; la causa real (instrucciones con ámbito, presupuesto)
    ya está cubierta por el runner directo. No se cargan instrucciones con ámbito (`beforePaths`) para rutas anidadas.

### Forja: Fase 3b (motor JavaScript, `js_run` y retirada de `execute`)

`js_run` ya existe: ejecuta un script en una VM QuickJS-WASM aislada (un hilo en Node, un proceso hijo en Bun
y en el binario), con llamadas anidadas que pasan por el gate de la propia sesión sin abrir aprobaciones.
`forge.javascript.enabled` pasa a **`true`** por defecto tras cumplir la puerta de la Fase 3 (abajo).

- Entregado:
  - Dependencia `quickjs-wasi` **3.6.2 exacta** en `@alisio/core`. D-22 resuelta: `tsc` 7 **conserva**
    `import … with { type: "file" }` y reescribe la extensión del `import()` dinámico, así que el WASM va como
    asset de Bun (`forge/javascript/wasm-asset.ts`, cargado solo si `process.versions.bun`); en Node,
    `createRequire(...).resolve("quickjs-wasi/quickjs.wasm")`. `runtime-manifest.ts` fija versión, SHA-256
    (`d4c9375f…bd9`), tamaño (637 405 B) y versión de protocolo/prelude; `wasm.ts` verifica el hash **antes de
    compilar** y cachea el `Module` por proceso. Un hash distinto deja el motor «no listo» (D17).
  - Hosts (D-20/D-21/D-33): `WorkerIsolateHost` (bandera `SharedArrayBuffer`, `terminate()` si no hay `exit`
    en 50 ms, confirmación por `exit`) y `ProcessIsolateHost` (entorno vacío salvo `ALISIO_FORGE_ISOLATE=1`,
    cwd temporal privado, marcos u32 BE + JSON con límite por trama, cancelación → `SIGKILL`, plazo → plazo
    local del invitado y `SIGKILL` a +500 ms). `IsolateHostFactory` elige por `process.versions.bun` y
    `forge.javascript.host`. Las entradas (`worker-entry.ts`, `process-entry.ts`, `isolate-main.ts`,
    `vm-runner.ts`, `prelude.ts`, `wasm.ts`, `framing.ts`) usan solo sintaxis TS borrable. El binario se
    relanza con el comando oculto `__forge-isolate` (despachado en `packages/cli/src/main.ts` **antes** de
    cargar configuración o SQLite) mediante el nuevo export `@alisio/core/forge-isolate`.
  - Prelude y `vm-runner.ts` (D-26, §6.2): `tools.call`/`callTool`, `catalog.search/describe`, `state`, `text`,
    `progress`, `parallel.map/settle`, `console`; cuerpo `async`; `SharedArrayBuffer` borrado; el puente se
    pasa como argumento (nunca queda en `globalThis`); intrínsecas capturadas; objetos congelados; cargador de
    módulos que siempre rechaza; `UNRESOLVABLE_PROMISE`; `fatal` terminal para el presupuesto de llamadas.
    **Todos** los invariantes se comprueban otra vez en el host (créditos, concurrencia, tamaños, protocolo).
  - `JavaScriptEngine` (puerto `ExecutionEngine`), `CapabilityBroker` (`forge/broker.ts`: llamadas, catálogo,
    salida, estado, diario y `ForgeProgress`), `ExecutionKernel` mínimo (`forge/kernel.ts`, Template Method:
    validar → seleccionar → admitir (1 por sesión, 4 por proceso: `forge/slots.ts`) → preparar → ejecutar con
    plazo del reloj del padre → recoger → limpiar siempre), `verdict.ts`, `result.ts` (resultado compacto para
    el modelo, recorte a `maxOutputChars`), `progress.ts` (4/s, terminales nunca descartados), `task-log.ts`
    (`<sessionDir>/tasks/<executionId>.log`, 0600, acotado a 256 KiB), `catalog-view.ts`, `routing-rule.ts`,
    `runtime.ts` (ensamblado, `describeForge`) y `probe.ts` (autoprueba real de un aislado).
  - `tools/js-run.ts`: efecto `read`, `concurrent:false`, `code` | `codePath` (exactamente uno; `codePath` por
    `resolveScratchPath`, `.js`, ≤ 64 KiB), descripción de 372 caracteres, cancelación = lanza (el runner deja
    pendiente una llamada que escribió, D-23b). Se registra con `forge.javascript.enabled` y motor listo,
    también en `--read-only`; con él **no** se registra `execute` (D6, sin respaldo a `node:vm`). Con Forja
    apagada todo queda como antes (`execute` registrado, prompt idéntico).
  - Regla de enrutamiento (§8.1): `ProjectContext.extras` recibe ahora el `sessionId` (cambio aditivo) para
    añadir la ruta real del scratchpad de la sesión; ≤ 900 caracteres, línea de Python solo si `python_run`
    está registrado. Con ambos motores el prompt crece 700 caracteres y la descripción de `js_run` ocupa 372: 1 072 en total sobre la línea base (límite 1 200).
  - Scratchpad: escribir en él ya no pide aprobación tampoco **sin manejador de aprobaciones** (`alisio run`),
    sí se mantiene la denegación en `--read-only` y en hijos con `approvals:false`; la cuota
    `forge.scratch.maxBytes` se aplica a toda escritura confinada al scratchpad (también las anidadas, descontando
    el tamaño del archivo que se reemplaza), con error claro y sin borrar nada (FJ-AC-34).
  - CLI: `alisio forge status [--probe] [--json]` (descriptor, hash del WASM, host efectivo, límites; `--probe`
    arranca un aislado real).
  - `fixtures/cli-e2e.ts`: `js_run` de punta a punta en Node (host worker y host proceso sobre `dist`) y en el
    binario copiado a una ruta **con espacios** (host proceso, `__forge-isolate`, WASM embebido), con progreso
    `forge` en el JSONL y cancelación por `SIGINT` de un bucle ocupado sin proceso aislado superviviente
    (control positivo previo con `pgrep`). `scripts/forge-bun-smoke.ts` (+ `tests/forge-bun-smoke.test.ts`)
    ejecuta el núcleo real sobre el Bun del repositorio con ambos hosts.
- Aceptación (todas con QuickJS, SQLite, runner y hosts reales): FJ-AC-01..04, 07 (Node y Bun), 08..15 en
  `forge-javascript-engine`, `forge-javascript-hosts`, `forge-javascript-protocol` y `forge-js-run`; 05/06 y el
  equivalente de D-28 por `js_run` en `forge-js-run`; 16/17 en `forge-javascript-engine`; 18 en `forge-wasm` y
  `forge-javascript-wiring`; 19 (adaptado: apagado ⇒ sin `js_run`, `execute` y prompt como hoy) y 20 en
  `forge-javascript-wiring`; 23 en `forge-legacy-execute-history` (almacén, TUI y utilidades web); 24 en
  `pnpm test:compiled`; 27 (100 ejecuciones seguidas con host worker; 15 con host proceso: sin ranuras
  retenidas, todas las paradas confirmadas); 27a/27b en `forge-js-run`; 30 (`codePath`) en `forge-js-run`; 31
  (también sin manejador) y 34 en `forge-scratch-gate`; 28/29/33 siguen cubiertas por la Fase 2.
- Rendimiento medido (Linux x64, Node 22.19, Bun 1.4.2; `Module` en caché; incluye el diario y el núcleo):

  | Métrica | Worker (Node) | Proceso (Node) | Worker (Bun) | Proceso (Bun) |
  |---|---|---|---|---|
  | Ejecución vacía p95 | 93 ms | 154 ms | 43 ms | 50 ms |
  | Parada de `while(true)` tras cancelar p95 | 11 ms | 15 ms | ~12 ms | ~13 ms |
  | Sobrecoste del plazo (bucle ocupado) p95 | 17 ms | 101 ms | ~14 ms | ~51 ms |
  | Llamada anidada pequeña p95 | 7 ms | 8 ms | 8 ms | 8 ms |

  Los objetivos de §12.2 (≤ 150 ms worker, ≤ 400 ms proceso, ≤ 1 s de parada, ≤ 20 ms por llamada) se cumplen.
  Las cifras de Node se midieron bajo Vitest (la entrada `.ts` se transpila al arrancar); en `dist` es menos.
- Mutation testing lite: se añaden al alcance los módulos puros nuevos (`slots`, `verdict`, `result`,
  `catalog-view`, `progress`, `hosts/framing`). Primera pasada completa 92,66 %; tras añadir pruebas de frontera
  solo para los supervivientes relevantes (liberación de ranuras con más de una por sesión, orden con
  temporizador tardío, límites de 160 caracteres y de trama, partes opcionales del informe, bordes del
  recorte) quedó en **96,25 %** (563 muertos, 1 por tiempo, 22 supervivientes: reloj real,
  `unref`, `Buffer.from` frente a `concat`, la limpieza del mapa de ranuras, equivalentes o triviales).
  Una pasada completa con 12 archivos tardó 1 min 50 s la primera vez y 4 min 56 s al repetirla con la caché
  borrada. La segunda superó el límite de 2 min, así que se recortó `mutate` a **9 archivos**, el límite de
  §12.3: salen `result`, `catalog-view` y `progress`; se quedan `slots`, `verdict` y `hosts/framing`. Las
  pruebas de los tres archivos retirados siguen en `pnpm test`. Las pasadas incrementales tardan unos 4 s.
- Decisiones donde la especificación era ambigua:
  - `KernelChannel` se redefinió: lo implementa el **núcleo** (`receive` + `bind`), no el motor; la versión de la
    Fase 1 (`onMessage(handler)`) no decía quién llamaba a quién. El motor valida y entrega; el núcleo decide.
  - `describe()` es una autocomprobación barata (hash y compilación del WASM, archivos del host); el arranque de
    un aislado real es `probe()` (`alisio forge status --probe`), no se hace en cada arranque de la aplicación.
  - `parallel`/`Promise.all`: el prelude pone en cola las llamadas sin crédito en vez de fallar; solo agotar
    `maxToolCalls` es terminal (`fatal` desde el prelude y, por si se salta el prelude, `BUDGET_EXCEEDED` del
    libro mayor del host).
  - `calls.failed` y `calls.denied` son disjuntos; `denied` = `PERMISSION_DENIED`/`APPROVAL_REQUIRED`.
  - Una ejecución cancelada hace que `js_run` **lance** (el runner decide si la llamada queda pendiente); un
    plazo vencido es un resultado de error normal (`timed_out`).
  - En Node con `host: "process"` (diagnóstico) el hijo ejecuta `process-entry.{ts,js}` directamente; el comando
    oculto `__forge-isolate` solo lo usa el binario compilado.
  - `forge.javascript.enabled` activado por un `--config` explícito no cuenta (solo la capa global lo activa),
    como el resto de claves globales de Forja; los e2e usan el config global.
- Limitaciones conocidas:
  - **No es un sandbox absoluto** (§16): el aislamiento depende de QuickJS-WASM (versión y hash fijados, sin
    extensiones), del confinamiento del hilo o proceso y del gate; un fallo del runtime no está descartado.
  - Bun usa un **proceso hijo**, no un worker (`terminate()` no es fiable allí): arranque ~50 ms frente a
    ~40 ms del worker en Bun; no hay memoria compartida, así que la cancelación de usuario es `SIGKILL` y el
    plazo depende del reloj local del invitado más el respaldo de +500 ms. El entorno del hijo está vacío
    (en Windows solo `SystemRoot`, sin probar en un Windows real).
  - La VM **no tiene red, sistema de archivos, procesos ni temporizadores**; `Date`, `Math.random` y
    `performance.now` son reales (sin promesa de determinismo). `eval`/`Function` existen dentro de la VM sin
    capacidades nuevas.
  - Las llamadas anidadas **nunca preguntan** (`APPROVAL_REQUIRED`), no cargan instrucciones con ámbito
    (`beforePaths` no se carga para rutas anidadas), tienen `emit` nulo y `approveInstall` siempre `deny`.
  - `task`, `task_wait`, `send_message`, `ask_user_question`, `js_run`, `execute` y `forge_guide` están excluidas de la VM; las
    herramientas opt-in (`exit_plan`, de objetivo) también. `python_run` solo con `--allow-analysis` o
    `--allow-process`.
  - Claves `constructor`, `prototype` y `__proto__` en un valor devuelto o en una entrada de herramienta se
    rechazan como `PROTOCOL_VIOLATION` (regla de la Fase 1); un resultado de más de 200 000 caracteres falla
    con `OUTPUT_LIMIT` desde el prelude.
  - `forge_guide`, los temas adaptativos, la pista `forge_guide(...)` en las respuestas (el texto de la pista
    no nombra la herramienta todavía), la API `GET /api/forge` y la tarjeta web son de las Fases 6-7.
  - Las sesiones antiguas con llamadas `execute` se siguen mostrando (no se tocó el mapeo web ni el TUI).
  - Con `forge.javascript.enabled: false` vuelven `execute` y el prompt anterior; con él en `true` y un motor
    que no verifica no hay ni `js_run` ni `execute` (sin respaldo a `node:vm`).
- Revisión de seguridad (invocación 2 de 3): hallazgos y correcciones. Cada uno nació de una prueba que
  reproducía el escenario (QuickJS, hosts y núcleo reales; un invitado hostil guionizado cuando el fallo estaba
  en el host) y falló antes de la corrección.
  - M1 `ask_user_question` era alcanzable desde la VM (efecto `read`) y abría prompts interactivos: ahora está
    en `FORGE_EXCLUDED_TOOLS` (FJ-AC-13). Auditoría del registro: es la única herramienta que abre una interacción
    de interfaz; aprobaciones e instalaciones ya se negaban en llamadas anidadas y `exit_plan`/objetivo son opt-in.
  - M2 El nombre de herramienta del mensaje `call` no tenía cota: el esquema exige `maxLength: 128` y el patrón del
    registro (`^[a-zA-Z0-9_-]{1,64}$`), el prelude lo comprueba (`TOOL_UNAVAILABLE`, sin enviar nada) y el broker
    solo registra o difunde nombres que el registro conoce (`dispatcher.knows`); el resto se guarda como
    `unknown:<sha256[0:12]>`.
  - M3 El invitado elegía el estado terminal y códigos propios rompían el protocolo: el prelude solo deja pasar
    los códigos de llamada anidada (`TOOL_UNAVAILABLE`, `TOOL_INPUT_INVALID`, `TOOL_FAILED`,
    `PERMISSION_DENIED`, `APPROVAL_REQUIRED`, `BUDGET_EXCEEDED`, `OUTPUT_LIMIT`, `STATE_CONFLICT`); cualquier otro
    es `SCRIPT_RUNTIME`. En el host, `verdictOf` trata un `TIMEOUT`/`CANCELLED` del invitado sin parada del
    host como `failed`/`SCRIPT_RUNTIME`: los estados `cancelled` y `timed_out` son solo del host. La prueba
    anterior que fijaba lo contrario («un invitado que se adelanta es lo mismo») se retiró.
  - M4 `edit_file` esquivaba la cuota del scratchpad: `forge/scratch-quota.ts` estima los bytes resultantes por
    herramienta (`write_file`: `content`; `edit_file`: tamaño actual − `oldText` + `newText`, una sola
    coincidencia) y se usa igual en llamadas directas y anidadas. Una herramienta de escritura sin estimador no
    obtiene el pase sin aprobación al scratchpad (pide aprobación como fuera de él); si una política la permite
    sigue contando su `content`, como antes (**no** se mide ni se revierte tras escribir).
  - L1 `PathAccess.lockScratch` serializa comprobación de cuota y escritura por directorio de scratchpad (también
    entre sesiones de la misma raíz), en el runner y en el despachador anidado.
  - L2 `JavaScriptEngine.terminate` termina la ejecución con un veredicto del host cuando la parada no se
    confirma (antes `run()` no resolvía si no llegaba ni mensaje ni `exit`): se libera el hueco (o se retiene
    hasta `settled`) y se anota `terminationUnconfirmed`.
  - L3 El límite efectivo `maxCallInputBytes` se recorta a `MAX_MESSAGE_BYTES − 4 KiB` (`MAX_CALL_INPUT_BYTES`
    = 258 048; el valor por defecto de 256 KiB de §6.5 queda como configurado, pero el efectivo es este) y el
    prelude mide **bytes UTF-8**; pasarse es `TOOL_INPUT_INVALID` y nunca `PROTOCOL_VIOLATION` (probado con ASCII,
    `é` y emoji en worker y proceso).
  - L4 El host recorta `progress.message` a 500 caracteres y solo guarda 10 000 mensajes por ejecución; el resto
    se descarta en silencio y `metrics.progressDropped` lo cuenta en el diario (más una línea en el log de la tarea).
  - L5 El prelude captura los métodos de `Array`, `String` y `Promise` que usa (`uncurry`), no usa `Promise.all`
    ni devuelve promesas desde callbacks de `then` (ambos consultan propiedades que el script puede reemplazar):
    reemplazar `Array.prototype.map/shift/join`, `Promise.prototype.then` o `Promise.resolve` ya no cambia
    `parallel` ni `tools.call`. `PRELUDE_VERSION` pasa a 2.
  - L6 `renderForgeResult` recorta `error.message` al presupuesto `maxOutputChars` y lo indica.
  - L7 `MEMORY_LIMIT`/`STACK_LIMIT` ya no salen del texto del mensaje: el prelude los marca solo si el error es del
    tipo propio del motor (`InternalError` de QuickJS, cuyo constructor se borra del ámbito global; `RangeError` para
    la pila). Un `throw new Error("out of memory")` es `SCRIPT_RUNTIME`.
  - L8 En win32 el proceso aislado recibe `SystemRoot` y nada más del entorno del padre (`isolateEnv`, probado por plataforma;
    sin ejecutar en Windows real).
  - L9 El scratchpad solo es raíz de escritura autorizada si el motor JavaScript está listo (`jsReady`) además de
    `forge.javascript.enabled` y `forge.scratch.enabled`: con un autotest fallido vuelve a pedir aprobación.
- Riesgos aceptados de esta revisión:
  - **Host worker**: una fuga completa de la VM comprometería el proceso anfitrión (hilo del mismo proceso). Es inherente a D-20;
    el host proceso (Bun, binario) no lo comparte.
  - El `fd_write` de WASI en el host proceso solo puede inyectar tramas en el canal que el host ya trata como no fiable
    (se validan igual que cualquier mensaje del invitado).
  - `STACK_LIMIT` puede imitarlo un script con un `RangeError` propio y ese mensaje; solo cambia la etiqueta de una
    ejecución ya fallida. Un `TIMEOUT` real del invitado que llegue antes que el temporizador del host (carrera de
    milisegundos con el hilo principal ocupado) se informa como `failed`/`SCRIPT_RUNTIME` en lugar de `timed_out`.
  - Una herramienta de escritura de un plugin que una política permita sin estimador de tamaño no queda acotada por la
    cuota del scratchpad (solo cuenta `content`).
- Pendiente para la invocación 3 de la revisión: re-verificación de las correcciones anteriores y repaso de
  `forge/javascript/hosts/worker-host.ts`, `isolate-main.ts` y `factory.ts` (no tocados en esta pasada).

### Forja: Fase 4 (Python en el núcleo: P1 caracterización y P2 adaptación)

`python_run` ya corre sobre el `ExecutionKernel` de `js_run` (especificación `specs/alisio-forja-python-v1.md`,
fases P1 y P2). Sin cambio de comportamiento para el modelo salvo lo aditivo de abajo; `wasm`, `auto`,
`analysis.isolation` y el análisis de imports son de la Fase 5.

- P1 (caracterización, antes de tocar código; todas verdes contra el código previo):
  `tests/analysis-python-characterization.test.ts` fija el texto exacto de `python_run` en éxito, sin salida, sin
  artefactos, error, `publishOnError` y tiempo agotado; los artefactos (nombres, tipos, procedencia en `managed` y
  `oci`); `rerunOf` con script alterado (rechazo exacto) y con entrada verificada por hash; el contenedor sin
  imagen; la lista **exacta** de argumentos de `ociRunArgs`; y la carpeta del job. La aprobación de
  `analysis.install` con `extras` (y que el modo headless no instala), el ciclo de cancelación y tiempo agotado y el
  `409 runs_active` de `/api/artifacts/:aid/rerun` ya estaban fijados por `analysis-extras`,
  `analysis-python-run`, `analysis-oci` y `server-analysis-phase4`, que no se tocaron.
- P2 (adaptación):
  - `forge/python/`: `PythonEngine` (implementa `ExecutionEngine`, una instancia por backend: `python-managed` y
    `python-oci`), `PythonBackend` (§4.2) con `ManagedBackend` (envuelve `AnalysisRuntimeManager.interpreter` y
    `runProcess`) y `OciBackend` (envuelve `OciRuntime.run`/`ociRunArgs`) sin alterar su salida,
    `PythonBackendSelector` (`backend-selector.ts`: cadena de reglas puras sobre `EngineSelector`; hoy
    `rerunOriginalBackend` y `configuredRuntime`), `StdoutFrameTransport` (`frame-transport.ts`), el analizador
    puro de líneas (`frame-parser.ts`) y `wiring.ts`. `analysis.runtime` sigue siendo `managed | oci`.
  - `ExecutionKernel` se generalizó de forma aditiva: `language`, `selection` ya hecha por quien llama,
    `payload` por motor, `limitOverrides` fijados por el núcleo (el plazo de Python llega a 900 s y el script a
    200 000 caracteres, por encima de los máximos de JavaScript), `dispatcher` opcional (Python no llama
    herramientas) y un paso opcional `collect` del motor entre `run` y la confirmación del estado compartido.
    `PreparedExecution.analysisExecutionId` enlaza la fila de `forge_executions` con `analysis_executions`
    (`SqliteExecutionJournal.linkAnalysisExecution`). Código de error nuevo: `PUBLICATION_REJECTED`.
  - `python_run` hace antes del núcleo lo que depende del contexto de la llamada (plan de `rerunOf`, lectura de
    `codePath`, sondeo de preparación, selección, `analysis.install`) y delega la ejecución: el motor crea el job y
    copia las entradas (`prepare`), lanza y lee los marcos (`run`), publica (`collect`) y mata (`terminate`). El
    texto para el modelo es el de antes más una **última línea** (PD11):
    `engine: python-oci (os-container) · reason: analysis.runtime=oci`. Si el script usa `forge.text` o
    `forge.result` aparece además una sección `--- forge output ---` (solo entonces).
  - Transporte (§7): líneas de stdout que empiezan por `\u001eALISIO-FORGE:<nonce>:` + JSON; nonce de 128 bits por
    ejecución en `ALISIO_FORGE_NONCE`; mensajes `ready`, `progress`, `output`, `state.set`, `state.delete`,
    `complete`, `fatal`; `call` y `catalog` son `PROTOCOL_VIOLATION` (y matan el proceso); 256 KiB por mensaje,
    profundidad 32, `seq` creciente, máximo 1 000 mensajes (el exceso se ignora con un aviso `warning:`); un
    marco con otro nonce es salida normal. Los marcos no llegan al modelo ni a la vista en vivo (el `stdout.log` del
    job los conserva en bruto). `runProcess.onData` recibe ahora el flujo (`stdout`/`stderr`) como segundo
    argumento opcional, para no mezclar líneas de dos flujos.
  - `alisio_runtime/forge.py` (sin dependencias, CPython 3.10+): `progress`, `text`, `result` (se envía al salir) y
    `state.get/set/delete` con el snapshot de `work/.forge/state.json`; sin nonce degrada a `print`.
    `__version__` pasa de `"3"` a `"4"`.
  - Estado compartido con JavaScript (FP-AC-19/20): el delta de `forge.state.set` se confirma después de publicar
    con éxito; un fallo del script o una publicación rechazada lo descartan.
  - Procedencia aditiva `engine`, `isolation`, `selectionReason` (PD12, FP-AC-24). `rerunOf` prefiere el backend
    original si está listo y no es **menos aislado** que el configurado (nunca baja el aislamiento elegido).
  - `codePath` (aditivo, exclusivo con `code` y `rerunOf`): `.py` dentro del scratchpad (`resolveScratchPath`),
    copiado a `script/main.py` y con el mismo hash que `code`. El scratchpad se expone de solo lectura como
    `ALISIO_SCRATCH_DIR` (variable en `managed`; montaje `:ro` en `/job/scratch` en `oci`, `ociRunArgs` con la
    opción `mounts.scratch`). Solo con el mismo requisito que `js_run` (Forja activa y motor verificado); la
    descripción de `python_run` **no cambia** (la guía va en el esquema de `codePath` y en la regla de
    enrutamiento, que ahora nombra `python_run codePath`).
- Aceptación (fakes de intérprete y de contenedor, runner y SQLite reales): FP-AC-01, 02, 03 (solo la variante
  `oci` explícito: `auto` es de la Fase 5), 09, 10 (`managed` y `oci`, con Python 3.10 real), 18, 19 (con una
  ejecución JavaScript real que lee el valor), 20, 21 (solo `managed`/`oci`), 24 y FJ-AC-32, en
  `tests/forge-python-run.test.ts`; transporte en `forge-python-frame-parser`/`forge-python-frame-transport`;
  `forge.py` contra CPython real en `forge-python-module`; selector en `forge-python-backend-selector`; núcleo en
  `forge-kernel-python`; cableado en `forge-python-application`. Con `ALISIO_TEST_OCI_IMAGE` se añade un contenedor
  real (escritura en `$ALISIO_SCRATCH_DIR` denegada, marcos a través de `docker run`); sin él se omite.
- Cambios en pruebas existentes: `tests/analysis-charts.test.ts` (`alisio_runtime.__version__` `"3"` → `"4"`, pedido
  por la especificación). Ninguna otra expectativa cambió: la línea PD11 solo está en las pruebas nuevas.
  `fixtures/fake-python.mjs` y `fixtures/fake-container.mjs` ganaron opciones aditivas (marcos, scratchpad, Python
  real en el «contenedor»); la primera espera a vaciar stdout antes de salir.
- Mutation testing lite: `forge/python/frame-parser.ts` **sustituye** a `forge/slots.ts` en `mutate` (sigue en 9
  archivos; las pruebas de `slots` siguen en `pnpm test`). Pasada completa 1 min 22 s: 96,06 % en conjunto y
  93,94 % en `frame-parser.ts` (6 supervivientes, todos equivalentes: `join` de `undefined`, banderas que solo
  son verdad en un modo y el borrado del resto de una línea que el modo `drop` ya descarta).
- Decisiones donde la especificación era ambigua:
  - `analysis.runtime` aún no distingue «explícito» de «por defecto», así que la regla de `rerunOf` va **antes** que la
    del runtime configurado y se limita a no bajar el aislamiento. La Fase 5 debe revisar el orden (§6.1 pone el
    explícito primero) cuando exista `auto`.
  - Los motores `python-*` se registran en el registro del núcleo en la primera ejecución con `describe()` estático
    (`ready: true`); la preparación real se sondea en cada llamada con `PythonBackend.check()`, que conserva los
    mensajes `runtime_unavailable` de siempre.
  - Python **no toma ranura** de Forja (`SlotTable`): un `js_run` que llama a `python_run` en la misma sesión ya
    tiene la ranura, y `python_run` nunca tuvo límite de concurrencia propio.
  - El plazo lo cuenta el reloj del núcleo desde que arranca `run`; el proceso lleva un respaldo propio 15 s mayor.
  - Una ejecución detenida por una violación del protocolo no tiene código de salida: el texto dice `stopped in …s`.
  - Un directorio de scratchpad que el motor no puede montar (`:` en la ruta) simplemente no se expone en `oci`.
- Limitaciones conocidas:
  - En `managed` `ALISIO_SCRATCH_DIR` es solo una variable: el script corre con los permisos del usuario y puede
    escribir allí (FJ-AC-32 lo documenta como no garantizado). En `oci` el montaje `:ro` lo hace cumplir el motor
    real; la prueba con el CLI falso solo comprueba los argumentos.
  - `forge.py` exige que un marco empiece una línea: si el script dejó una línea a medias, el marco se pierde como
    texto. No comprueba la profundidad JSON (el host mata la ejecución si pasa de 32).
  - Las ejecuciones de Python no aparecen todavía en `alisio forge status` ni en `GET /api/forge` (Fase 5-6).

Traspaso para la Fase 5:

- Reglas nuevas del selector: añadirlas a `RULES` en `forge/python/backend-selector.ts` (`auto` antes de
  `configuredRuntime`, filtro `analysis.isolation`, ajuste de Pyodide con `inputBytes` e imports). Ensanchar
  `PythonBackendId` con `"wasm"` y `ISOLATION_RANK`, `PythonRuntimeSetting` y el enum de `analysis.runtime`
  (`config.ts`). `PythonRequirements.importedModules`/`inputBytes` ya existen en `backend.ts`, sin uso.
- `PyodideBackend`: implementa `PythonBackend` (`forge/python/backend.ts`), se crea y se registra en
  `createPythonForge` (`wiring.ts`) junto a los otros dos; `PythonEngine` no cambia. Exposición del scratchpad:
  `PreparedJob.scratch` ya llega al backend (flag `--allow-fs-read` extra). `StdoutFrameTransport` ya sirve tal cual
  (la salida de Pyodide se redirige a `sink.onData`). `NEEDED`/sondeo: `neededBackends()` decide qué `check()` se
  llama; `wasm` entraría ahí. Los descriptores `python-*` para `forge status`/API salen de `PythonForge.engines`.

### Forja: Fase 5 (Python wasm: P3 backend Pyodide y P4 selección y superficies)

Estado: **hecho, sin commit.** Cierra las fases P3 y P4 de `specs/alisio-forja-python-v1.md`. La interfaz web de
`wasm` (tarjetas, insignias, capturas) es de la Fase 7; las guías `python.*` de `forge_guide`, de la Fase 6.

- Backend `wasm` (P3), en `packages/core/src/forge/python/`:
  - `pyodide-manifest.ts`: constante TypeScript (no JSON, porque `tsc` no copia JSON a `dist`) con Pyodide 314.0.7
    (Python 3.14.2), 5 archivos del núcleo y 30 wheels, cada uno con URL, SHA-256, tamaño y origen (`pyodide` = espejo
    oficial jsDelivr con los hashes del `pyodide-lock.json`; `pypi` = las wheels puras que el lock no trae, con los hashes
    que publica PyPI). Cierre de dependencias explícito por perfil (`base`, `analysis`, `science`; `science` incluye
    `analysis`), en orden de carga. Sin entrada de `sqlite3` (viene en la stdlib). Los hashes de los archivos del núcleo se
    contrastaron con el espejo; los de PyPI, con la API JSON de PyPI y los archivos de la Fase P0.
    `analysis` pesa 43,9 MiB y `science` 69,6 MiB (el runtime solo, 12,9 MiB).
  - `pyodide-install.ts`: `installPyodide` es **el único código que usa la red** del backend. Descarga a una carpeta de
    preparación, verifica hash y tamaño de cada archivo mientras llega (un servidor que envía más de lo fijado se corta),
    y solo entonces mueve los archivos a `<analysis dir>/pyodide/<versión>/` y escribe `ready.json`. Cualquier fallo
    borra lo descargado y lanza `PyodideIntegrityError`; si ya había una instalación completa, esa queda intacta (nunca
    se «baja» de `science` a `analysis`). `inspectPyodide` es la comprobación barata previa a cada ejecución (existencia
    y tamaño, sin hash); `verifyPyodideFiles` calcula hashes y se ejecuta **en cada lanzamiento** sobre el núcleo y las
    wheels que ese script carga.
  - `pyodide-runner.mjs` (JavaScript plano, fuente de verdad) y `pyodide-runner-source.ts` (generado por
    `scripts/pyodide-runner-source.ts`, con `tests/forge-python-pyodide-runner-source.test.ts` contra el desfase): el npm
    y el binario solo llevan módulos JavaScript, así que el runner viaja como cadena y el backend lo escribe como
    `runner-<hash>.mjs` dentro de la carpeta de Pyodide (legible por el hijo) antes de lanzar. El runner borra `fetch`,
    `WebSocket`, `XMLHttpRequest`, `EventSource` y `navigator`, instala el shim de `process.binding("constants")`,
    sustituye y congela `process.kill`/`process._kill` (D-32), carga Pyodide con `indexURL`/`lockFileURL`/`packageCacheDir`
    locales, carga solo los paquetes del escaneo de imports (los del lock por nombre y las wheels puras por archivo, en
    orden de dependencia), copia `script/`, `input/`, `work/` (con `.forge/state.json`) y el scratchpad (tope de 64 MB) al
    sistema de archivos virtual `/job`, ejecuta `main.py` como `__main__` (módulo real, con `await` de nivel superior), corre
    los `atexit` (Pyodide nunca finaliza el intérprete; sin esto `forge.result` no llegaría) y copia `/job/out` al `out/`
    real sin seguir enlaces. Un error lanzado dentro de un manejador de eventos de Node se reduce a una línea (sin el
    volcado de Emscripten) y sale con 70.
  - `wasm-node.ts`: elige el `node` (`analysis.wasm.nodePath`; el Node en ejecución; bajo Bun, el primer `node` con la corrección CVE-2025-55130 (≥ 22.22, 24.13, 25.3; solo entradas absolutas) del
    `PATH`, sin recordar fallos), construye los flags del Permission Model (**un flag por ruta**, lectura de la
    distribución, del job y del scratchpad; escritura solo en `work/` y `staging/`; nunca `--allow-child-process`,
    `--allow-worker`, `--allow-addons`, `--allow-wasi` ni `--allow-net`), el entorno vacío (solo variables `ALISIO_*`) y
    la **autoprueba de red**: lanza el `node` real con los mismos flags y le pide conectar a un puerto local nuestro. Solo
    una negativa observada cuenta como denegada; una prueba no concluyente es «no denegada». Se recuerda por binario y
    versión.
  - `pyodide-backend.ts` (`PyodideBackend`): `isolation: "wasm-process"`, `hardTermination: true`,
    `hardMemoryLimit: false`, `cooperativeInterrupt: false`, `networkDeniedByOS` de la autoprueba. Vigilante de RSS cada
    250 ms (`rss.ts`: `/proc` en Linux, `ps` en macOS/BSD, `tasklist` en Windows) que mata al hijo por encima de
    `analysis.wasm.memoryMb` y lo informa como `MEMORY_LIMIT` (`RunningProcess.limit`, leído por `PythonEngine`).
    Cancelación y plazo son `SIGKILL` inmediato (`killGraceMs: 1`) y el confirmado es el cierre del proceso. El arranque
    se mide con un archivo `work/.forge/wasm-ready` que escribe el runner (su fecha de modificación, no una línea de
    salida, para no ensuciar la salida del script ni los logs) y se informa aparte (`runtime.startupMs`, y
    `(startup 1.9s)` en la cabecera del resultado). El plazo del kernel es el del script **más**
    `analysis.wasm.startupMs`; el texto de «timed out after» sigue citando el plazo del script.
  - Migración de base de datos v10: `analysis_executions.runtime` admite `'wasm'` (reconstrucción de la tabla con el
    procedimiento oficial de SQLite; filas, ids y artefactos intactos; `tests/store-migration-v10.test.ts`).
- Selección y superficies (P4):
  - Config: `analysis.runtime: auto|managed|oci|wasm` (defecto **`auto`**), `analysis.isolation: preferred|required|strict`
    (defecto `preferred`) y `analysis.wasm {memoryMb 3072, startupMs 30000, maxInputBytes 100 MiB, nodePath null}`. Los
    tres son solo globales (una capa de proyecto se ignora con diagnóstico) y no se cambian en vivo ni desde la UI.
  - `backend-selector.ts`, reglas puras: (1) runtime explícito primero (se respeta o falla con el motivo y la salida;
    `required`/`strict` también rechazan un `managed`/`wasm` explícito que contradiga la política, para no incumplir
    «con `required` ningún script corre en el host»); (2) `auto` + `rerunOf`: vuelve al backend original si está listo,
    encaja y la política lo permite; (3) `auto`: `oci` → `wasm` → `managed` (este último solo con `preferred`; con `strict`
    solo backends con `networkDeniedByOS`; `wasm` queda fuera por `maxInputBytes`, imports desconocidos o extras sin
    perfil instalado); (4) sin candidato: `ENGINE_UNAVAILABLE` con el motivo de cada backend y el comando más corto
    (`alisio analysis setup --wasm`, con `--profile science` cuando eso lo arreglaría, `--oci` cuando `wasm` no puede encajar).
    Nunca hay reintento tras empezar (PD5).
  - `import-scan.ts` (§6.2): escáner puro sin intérprete (quita comentarios y cadenas, ve imports sangrados y con `;`),
    tabla módulo → paquete (`sklearn` → `scikit-learn`, `docx` → `python-docx`, `PIL` → `pillow`…) y clasificación por perfil.
    No es seguridad. `js`/`pyodide`/`pyodide_js` cuentan como disponibles (los trae Pyodide).
  - `python_run`: el sondeo de preparación de los candidatos va en paralelo; `wasm` solo calcula `inputBytes` si es
    candidato. La descripción de la herramienta no cambia con el defecto `auto` (la prueba de bytes de `dashboard-tool`
    sigue igual); con `wasm` explícito añade su nota.
  - CLI: `alisio analysis setup --wasm [--profile analysis|science] [--yes]` (tamaño estimado, confirmación interactiva o
    `--yes` obligatorio sin terminal, destino, progreso y, ante un hash incorrecto, mensaje claro, código de salida 1 y
    backend no listo); `alisio analysis status` suma `isolation`, `backends` y una tabla por stderr; `alisio forge status`
    lista los descriptores Python (con `--json` los incluye en `engines`); `alisio doctor` incluye `isolation` y `backends`.
  - API: `GET /api/analysis` añade `isolation` y `backends` (descriptores vivos: `ready`, `reason`, `profiles`,
    `networkDeniedByOS`); **nueva** `GET /api/forge` (`ForgeOverview` en el SDK): el motor JavaScript y luego los Python.
- Cambios de comportamiento por el defecto `auto` (deliberados, con pruebas actualizadas):
  - `analysis.runtime` por defecto pasó de `managed` a `auto`. Sin backend aislado listo se usa `managed` como antes, y el
    motivo de la línea final lo dice (`analysis.runtime=auto, analysis.isolation=preferred: managed is ready; oci: not
    ready (…); wasm: not ready (Pyodide is not installed)`). Las aprobaciones de `analysis.run` muestran `runtime: "auto"`.
  - La regla de `rerunOf` pasó **después** del runtime explícito (§6.1), así que con `managed`/`oci` explícitos un rerun ya
    no «salta» al backend original; con `auto` sí. Las tres pruebas FP-AC-21 de la Fase 4 se reescribieron para `auto` y se
    añadió una que fija que el explícito gana.
  - Las verificaciones de versión de esquema de las pruebas de migración y de `fixtures/scenarios.ts` ahora esperan `10`.
- Decisiones donde la especificación era ambigua:
  - Un cierre no cero del proceso `wasm` sigue siendo `SCRIPT_RUNTIME` (con el código de salida en el mensaje), no un código
    nuevo `RUNTIME_CRASH`: no existe en `FORGE_ERROR_CODES` y añadirlo ensancharía el esquema del protocolo. El runner usa 1
    (el script lanzó), el propio código del script, o 70 (falló el runner); `os.system` denegado sigue cayendo con la salida
    del propio Node.
  - Los extras de `python_run` en `wasm` no cargan paquetes: solo exigen que el perfil instalado los cubra (§8.2 pide cargar
    «solo lo que el análisis de imports y los extras requieren»; el perfil completo costaría 5-12 s). Un `importlib` dinámico
    falla con el `ModuleNotFoundError` de siempre.
  - `describe()` de `wasm` devuelve `ready: true` (como los otros dos), porque el registro de motores conserva el primer
    descriptor para siempre; el estado real sale de `check()` en cada llamada y de `describePythonBackends` para las
    superficies. La autoprueba de red solo se ejecuta cuando el backend está listo.
  - Un fallo de descarga sobre una instalación previa válida la deja como estaba (no «no listo»); sin instalación previa el
    resultado es no listo y sin archivos, que es lo que pide FP-AC-22.
  - La línea `· oci`/`· wasm`/`· host!` de la TUI y la insignia web quedan para la Fase 7: la TUI ya muestra la línea final
    `engine: …` del resultado y el progreso de `forge.progress`.
- Limitaciones conocidas (también en `docs/analysis.md`):
  - **La red no está aislada en Node 22 y 24**: Python alcanza `node:http` por el puente FFI. En esta máquina (Node 22.19) la
    autoprueba vio la conexión y una conexión real desde Python llegó al servidor de la prueba; por eso `networkDeniedByOS`
    es `false` y `isolation: strict` excluye `wasm`. En Node ≥ 25 no hay `--allow-net`, así que la misma autoprueba debería
    ver la negativa (no verificado: no hay Node 25 aquí; la rama «denegada» solo se prueba con un `node` falso).
  - El límite de memoria es **blando** (muestreo cada 250 ms: puede excederse entre decenas y centenares de MB antes del
    kill); `hardMemoryLimit: false`.
  - El Permission Model no es una frontera frente a código hostil: el script alcanza el JavaScript del runner y `process`
    por el FFI. `process.kill` está sustituido y congelado, pero eso es una mitigación (el SO sigue dejando señalar al propio
    grupo). Lo que el runner produce se valida en el host como no confiable.
  - Entre la verificación de hashes y la lectura del hijo hay una ventana (la carpeta es del usuario).
  - Un script que importa un paquete fuera del perfil descargado no corre en `wasm` (`auto` lo manda a otro backend; un
    `wasm` explícito falla con `PACKAGE_UNAVAILABLE`-equivalente). Un `import` oculto (`__import__`, `importlib`) engaña al
    escáner y falla en tiempo de ejecución, sin reintento.
  - Las rutas de lectura del scratchpad se copian al sistema virtual (tope 64 MB) en lugar de montarse; Python no puede
    escribirlo de vuelta aunque lo intente.
  - Los resultados numéricos pueden diferir entre backends (BLAS distinto); las pruebas usan tolerancias.
- Medido con Pyodide real 314.0.7 en Node 22.19, Linux (`ALISIO_TEST_PYODIDE=1`): arranque 1,8-1,9 s y RSS pico 356-376 MB
  con pandas; 5,1-5,2 s y 1,38 GB con scikit-learn + statsmodels + scipy + Matplotlib (solo se cargan los paquetes
  importados, no el perfil completo). Un `while True: pass` muere por `SIGKILL` sin dejar proceso; el vigilante corta una
  reserva sin límite con `memoryMb` 700.
- Pruebas: rápidas (siempre) `forge-python-backend-selector`, `forge-python-import-scan`, `forge-python-pyodide-install`
  (servidor HTTP local con un manifiesto de juguete, nunca se descarga el Pyodide real), `forge-python-pyodide-backend`
  y `forge-python-wasm-run` (un `node` falso, `fixtures/fake-node.mjs`, detrás de un script envoltorio: flags, entorno,
  directorio, vigilante, plazo con margen de arranque, autoprueba, FP-AC-04..08, 13, 16, 17, 21, 26, 28 en su forma rápida),
  `cli-analysis-wasm`, `server-forge-python`, `store-migration-v10`. Con Pyodide real
  (`ALISIO_TEST_PYODIDE=1 ALISIO_TEST_PYODIDE_DIST=<distribución verificada>`, `tests/forge-python-wasm-real.test.ts`):
  FP-AC-04, 08, 10 (incluida la igualdad byte a byte del dashboard con el CPython del host), 11, 12 (mismo volcado de
  tablas que el host), 13 y 28 (la conexión desde Python y el descriptor coinciden; `strict` excluye `wasm`), 14, 15, 16, 17,
  23 (`strace -e connect`: ninguna conexión `AF_INET` en una ejecución completa; `fetch`, `XMLHttpRequest` y `navigator`
  ausentes) y 27 (`process.kill`/`_kill` denegados y congelados). Una prueba lenta carga cada arranque en frío (1-5 s).
- Mutation testing lite: `forge/python/backend-selector.ts` y `forge/python/import-scan.ts` **sustituyen** a
  `forge/javascript/hosts/framing.ts` (sus mutantes no podía matarlos ninguna prueba de la pasada) y a `forge/verdict.ts`
  (una tabla de 40 líneas que cubren las pruebas del kernel) en `mutate`; sigue en 9 archivos. El comando de Stryker llama a
  Vitest directamente (`node node_modules/vitest/vitest.mjs run … --bail=1 --no-isolate --maxWorkers=1`, no a través de
  `pnpm exec`, que duplicaba el coste de cada mutante) y la copia del sandbox omite `docs`, `specs`, los `dist` y la web.
  Resultado (pasada completa desde cero, 692 mutantes): 94,94 % en conjunto, `backend-selector.ts` 95,83 %,
  `import-scan.ts` 87,88 %, `frame-parser.ts` 93,94 %. Los supervivientes restantes son equivalentes o inalcanzables (las
  guardas de `autoChain`/`rerunOriginalBackend` bajo un runtime explícito, que la regla 1 ya resolvió; bordes de `while`
  en el escáner). **Presupuesto**: la pasada completa tarda 4 min 35 s (el límite de D-27 para el paso completo es 5 min); una
  ejecución incremental sin cambios, 2 s.
  - **Recorte posterior (límite del propietario: una pasada en frío ≤ 2 min):** `mutate` queda en los **5 módulos
    puros de seguridad**: `limits`, `state-machine`, `protocol`, `session-path` y `decide`. `frame-parser`,
    `backend-selector`, `import-scan` y `state-delta` siguen con sus pruebas en `pnpm test`, pero ya no se mutan.
  - Resultado de la pasada en frío: **96,66 %** (289 muertos, 10 supervivientes ya conocidos) en **1 min 17 s**. Las pruebas nuevas que mató mutantes reales: un apóstrofo en un comentario o una comilla
  escapada no se tragan lo que sigue, una cadena sin cerrar termina en su línea, y la línea de motivo exacta.

### Forja: Fase 6 (contexto incremental y adaptativo: `forge_guide`)

Estado: **hecho, sin commit.** Cierra la Fase 6 de `specs/alisio-forja-v1.md` (§8.1-§8.5, FJ-AC-19 a 22). El benchmark
manual de 5 tareas necesita un modelo real y **no se ha ejecutado** (ver el final de esta sección).

- `packages/core/src/forge/guides/`: `GuideProvider` (`provider.ts`, Lazy Load: nada se construye hasta que se pide un
  tema) y los generadores puros `javascript.ts` (`js.api`, `js.patterns`, `js.tools`) y `python.ts` (`python.runtime`,
  `python.data`, `python.ml`, `python.dashboards`, `python.environment`). Cada tema ≤ 4 096 bytes (el proveedor además lo
  corta con una nota si algún día se pasara) y lleva `etag` (SHA-256 truncado a 16 caracteres del contenido final); con
  `ifNoneMatch` igual responde `{unchanged: true, etag}`. Un etag viejo no oculta contenido nuevo: si cambia un límite, un
  backend o el catálogo permitido, cambia el etag.
- Contenido adaptativo: `js.api` usa los límites efectivos y el host de `forgeRuntime.status()`; `js.tools` usa el catálogo
  del **despachador anidado de la propia llamada** (`callInternals(context).nested().catalog()`), así que ya viene filtrado
  por el modo de permisos (en `ask` no salen las escrituras ni los procesos; nunca salen `js_run`, `forge_guide`, `task*`
  ni `ask_user_question`), con un máximo de 40 entradas ordenadas y el resto por `catalog.search`.
  `python-environment.ts` ejecuta **la misma cadena del selector** que `python_run` (mismos `analysis.runtime` y
  `analysis.isolation` vivos, sin script conocido) sobre los backends reales, y los temas Python se escriben desde ese
  resultado: `wasm` lista los paquetes del perfil instalado más alto (según `describe().profiles`), `managed` los extras
  instalados (`EXTRAS_DISTRIBUTIONS`), `oci` no inventa una lista (depende de la imagen). Las garantías son la tabla de §4.3
  de la especificación Python (la red de `wasm` se declara **no** bloqueada). Si ningún backend puede correr, el tema muestra
  el mensaje del selector con su «Shortest fix».
- Herramienta `forge_guide` (`tools/forge-guide.ts`): efecto `read`, `concurrent: true`, descripción de 165 caracteres.
  Se registra tras `python_run`, solo con `forge.javascript.enabled` y `forge.guides.enabled` (FJ-AC-19: con Forja apagada
  no existe, igual que `js_run`); el enum de `topic` se construye con los temas que existen (`js.*` si el motor JavaScript
  verificó, `python.*` si `python_run` está registrada) y se compila con el AJV estricto del registro. Sigue en
  `FORGE_EXCLUDED_TOOLS`. La respuesta empieza con la línea `etag: …`.
- Pistas por error (§8.4): `hintFor` ya cubría `SCRIPT_SYNTAX`+`import` → `js.api`, `TOOL_UNAVAILABLE` → `js.tools` y
  `OUTPUT_LIMIT` → `js.patterns#filtering`; nuevo `pythonHintFor` para `PACKAGE_UNAVAILABLE`/`RUNTIME_UNAVAILABLE` →
  `python.environment`. El modelo ve una línea (`hint: <motivo> (forge_guide topic "…", section #…)`, `renderHint`), nunca la
  guía. En `python_run` la línea se añade al texto de `runtime_unavailable` y a un fallo con `ModuleNotFoundError` en
  stderr, solo mientras `forge_guide` está registrada (`guideHints`). **La descripción de `python_run` no cambió** (la prueba
  de huellas de `dashboard-tool` sigue verde).
- Regla de enrutamiento (§8.1): menciona «Call `forge_guide` before writing non-trivial code» solo si la herramienta existe;
  sigue ≤ 900 caracteres (≈ 560 con ruta de scratchpad típica). Se acortó el texto de `js_run` y de la regla.
  Presupuesto (§8.5, FJ-AC-20) medido en `tests/forge-javascript-wiring.test.ts`: crecimiento del prompt 617 + descripción de
  `js_run` 306 + descripción de `forge_guide` 165 = **1 088** caracteres (límite 1 200). Se cuenta lo que Forja añade; la
  descripción de `execute`, que sale, no se resta.
- Decisiones donde la especificación era ambigua:
  - `forge_guide` exige `forge.javascript.enabled` aunque el motor JavaScript no haya verificado (en ese caso solo salen los
    temas `python.*`); con Forja desactivada no existe aunque `python_run` sí.
  - El ancla `#filtering` no es un valor del enum: el tema es `js.patterns` y el puntero dice «section #filtering»; la guía
    tiene la sección `## #filtering`.
  - El renderizado de la pista de `js_run` pasó de `hint: <motivo>` a `hint: <motivo> (forge_guide topic "…")`
    (se actualizó la prueba de `renderForgeResult`).
  - `python.environment` solo llama a `describe()` del backend elegido (en `wasm` lanza la autoprueba de red una vez) y a
    todos los candidatos solo con `analysis.isolation: strict`, como `python_run`.
- Pruebas: `tests/forge-guide.test.ts` (tamaño por tema y por entorno, etag/FJ-AC-21, FJ-AC-22 con backends falsos, contenido
  adaptativo, esquema/enum, exclusión de la VM), `tests/forge-guide-integration.test.ts` (`js.tools` por el runner real en
  `ask` y `full`, mapeo de pistas, pistas de `python_run` con y sin la herramienta), ampliaciones de
  `tests/forge-javascript-wiring.test.ts` (FJ-AC-19 y 20 en la aplicación, `forge.guides.enabled: false`) y de
  `tests/forge-python-application.test.ts` (temas Python en la aplicación). Se escribió primero el código y luego las
  pruebas; la única prueba que falló al escribirla (FJ-AC-20, 1 212 > 1 200) obligó a acortar los textos.
- Mutation testing lite: sin cambios (los mismos 5 módulos).
- **Benchmark manual de 5 tareas (§14, Fase 6): pendiente: ejecución manual por el propietario.** Es informativo, no una
  puerta. Procedimiento reproducible, con Forja activa y un modelo real, sesión nueva por tarea y un directorio de trabajo
  con `package.json` y un CSV de ejemplo; para cada tarea se anota (a) la herramienta que eligió el modelo, (b) si llamó a
  `forge_guide` y con qué tema, (c) los caracteres de guía que cargó (suma de las respuestas de `forge_guide`) y (d) si
  terminó bien:

  | # | Tarea | Herramienta esperada |
  | --- | --- | --- |
  | 1 | «Cuenta cuántas funciones exportadas hay en cada archivo de `src/`» | `js_run` |
  | 2 | «Lee estos 12 archivos JSON y dame el total de la clave `amount`» | `js_run` |
  | 3 | «Lista los archivos de más de 100 líneas y agrúpalos por carpeta» | `js_run` |
  | 4 | «Calcula media, mediana y desviación típica del CSV y haz un gráfico de barras» | `python_run` |
  | 5 | «Entrena un clasificador sencillo sobre el CSV y dame la exactitud» | `python_run` (`python.ml`/`python.environment`) |

  Anotar además el backend que se usó (`engine:` en la última línea) y si la guía pedida coincidía con el entorno real.

### Forja: Fase 7a (servidor/API y TUI)

Estado: **hecho, sin commit.** Cubre `specs/alisio-forja-v1.md` §11.1 y §11.3, D-31 y la parte de API de FJ-AC-35. La web
(Fase 7b: tarjetas, página Forja, pestaña Scratch, capturas) **no se ha tocado**.

- Rutas del scratchpad (`packages/server/src/routes/scratch.ts`, ayudantes en `packages/core/src/forge/scratch-files.ts`):
  `GET /api/sessions/:sid/scratch` (`{available, files:[{name,size,mtime}], usedBytes, quotaBytes, truncated?}`; solo
  nombres relativos con `/`, hasta 2 000 archivos, enlaces simbólicos omitidos; `usedBytes` es lo que cuenta la cuota),
  `GET /api/sessions/:sid/scratch/files/*` (descarga con `Content-Disposition: attachment`, `nosniff`; ningún segmento
  puede ser un symlink, el archivo se abre con `O_NOFOLLOW` y cualquier fuga, directorio o archivo ausente da `404`) y
  `DELETE /api/sessions/:sid/scratch` (`{removed, freedBytes}`; conserva la carpeta, no sigue enlaces; `409 runs_active`
  si el diario tiene una ejecución Forja no terminal de la sesión raíz; `403 capability_ceiling` con `--read-only`).
  Con Forja o el scratchpad apagados el listado responde `available: false` y el borrado no hace nada.
- D-31: `SQLiteStore.forgeWriteCalls(session)` une `forge_calls` (efecto `write`, estado distinto de `failed`) con
  `forge_executions` y `tool_calls`; `/api/sessions/:sid/changes` lo suma a `effectCalls("write")` (aditivo; rutas fuera
  del workspace se descartan igual que antes).
- SSE: `ForgeProgress` ya llegaba de extremo a extremo: `tool_progress` es efímero y viaja en los frames `delta`
  (`progress: [{toolId, chunk}]`, con `chunk` = JSON del objeto). Se añadió el campo opcional `forge` a
  `InflightState.tools[]`: el último `ForgeProgress` de una herramienta en curso ya no se mezcla en `tail` (antes
  ensuciaba el texto del snapshot con JSON).
- `GET /api/forge` gana `scratch.retentionDays`/`maxBytes` (nunca `root`, es una ruta del host), `guides.enabled` y
  `python: {runtime, isolation}` (solo lectura); `alisio forge status --json` lo refleja. No contiene datos de sesión.
- TUI: la fila de `js_run` muestra `· 2/3 calls` (llamadas anidadas terminadas/iniciadas, desde `ForgeProgress`), más el
  mensaje y la fracción del propio script si los hay; la de `python_run` añade `· oci` / `· wasm` / `· host!` (desde
  `ForgeProgress.engine`, o desde la línea `engine:` del resultado si no hubo progreso, también al reanudar una sesión).
  La duración final va a la derecha como en cualquier herramienta, se pliega con el mismo atajo y la cancelación no cambia.
  Las llamadas `execute` antiguas se siguen mostrando igual.
- Headless: sin cambios de protocolo; `fixtures/cli-e2e.ts` ya comprueba `ForgeProgress` en el JSONL de `js_run`.
- Pruebas: `tests/server-forge-scratch.test.ts`, `tests/server-forge-surfaces.test.ts`, `tests/tui-forge.test.ts` y una
  ampliación de `tests/server-inflight.test.ts`. Sin cambios en `stryker` (mutation lite).
- Pendiente para 7b: hoy no hay claves `forge.*` en `SETTABLE_KEYS`. La web necesita, con etiquetas EN/ES, como mínimo
  `forge.javascript.enabled` y `forge.guides.enabled` (y opcionalmente los cuatro límites que un proyecto puede bajar);
  `forge.scratch.*`, `forge.javascript.host/memoryBytes/stackBytes` y `analysis.runtime`/`isolation` son solo globales.

### Forja: Fase 7b (interfaz web)

Estado: **hecho, sin commit; sin capturas ni páginas de documentación (Fase 8).** Cubre `specs/alisio-forja-v1.md` §11.2 y
`specs/alisio-forja-python-v1.md` §9.4 (FJ-AC-23, 26 y 35 en la parte web; FP-AC-25).

- Claves editables: `forge.javascript.enabled` y `forge.guides.enabled` entran en `SETTABLE_KEYS`
  (`packages/core/src/config.ts`), se aplican en vivo a la configuración (`application.ts`) y `PATCH /api/settings`
  recicla la aplicación del workspace como con `analysis.enabled`. El resto de claves `forge.*` y `analysis.runtime` /
  `analysis.isolation` siguen siendo de solo lectura (la web muestra la clave). Etiquetas EN/ES en `labels.ts`; la página
  General oculta `forge.*`.
- Progreso: `store/transcript.ts` pliega los `ForgeProgress` de `tool_progress` (JSON en `delta.progress[].chunk` o
  `forge` del snapshot de `inflight`) en `ToolState.forge` (llamadas anidadas por `callId`, contadores, fase) y ya no los
  mezcla con `tail`. `util/forge.ts` contiene el plegado y `ForgeThrottle`: coalescencia a 4 actualizaciones por segundo y
  llamada antes de los reductores (`store/app.ts`); un estado terminal de llamada, el fin de la llamada y cualquier frame
  que no sea progreso nunca se retienen y lo retenido sale antes. `store/progress.ts` clasifica `js_run` como
  `javascript` (estado de la ejecución «Ejecutando JavaScript…»).
- Tarjetas: `util/forge-card.ts` (puro) decide la tarjeta (`js_run`, `python_run`; `execute` y el resto, la fila
  genérica de siempre), la insignia de motor y aislamiento (texto + icono distinto para el host; nunca solo color), la
  lectura del texto de `js_run` (`status/value/output/calls/error/hint`), la línea `engine: … · reason: …` de
  `python_run` y las filas de procedencia. `ToolRow.tsx` añade insignia, progreso, barra y región `aria-live="polite"`
  (estado de la tarjeta, no cada tic); `ForgeParts.tsx` dibuja la lista de llamadas en vivo y el cuerpo de `js_run`
  (código con shiki `javascript` y «Copiar código», llamadas, valor con el visor JSON, salida, error con pista). Sin «repetir».
  Tras recargar la página la lista por llamada ya no existe (no se persiste); queda el contador del resultado.
- Ajustes: `AnalysisPage.tsx` pasa a `PythonSection.tsx` dentro de la nueva página **Forja** (`ForgePage.tsx`; entrada de
  menú nueva). JavaScript (estado, versión, hash, host efectivo y configurado, límites, scratchpad, interruptor),
  Python (todo lo anterior más una tarjeta por backend con estado, aislamiento en texto e icono, perfiles, motivo y comando
  de preparación con botón de copiar; política `analysis.isolation` y `analysis.runtime` en solo lectura con su clave y el
  backend que se usaría ahora, con las mismas reglas que el selector) y Guías. Corrige el error «Gestionado: tu propio
  Python» bajo `auto` (`modeLabelKey`). El identificador antiguo `analysis` abre Forja (`settingsPageFor`, señal
  `settingsPage`); no existía una ruta de ajustes por URL, así que no hay otra redirección.
- Procedencia (`ArtifactDetails`): motor, aislamiento, motivo y, con wasm, arranque y memoria máxima.
- Scratch: pestaña del Dock (junto a Archivos, Cambios, Vista previa y Tareas; chunk propio con su store y sus cadenas,
  `scratch-strings.ts`): lista (nombre relativo, tamaño, fecha), barra de cuota, vista previa de `.js .py .csv .json .txt
  .md` (≤ 1 MB) con el visor de texto existente (`TextView`, extraído de `TextPreview`), descarga y «Vaciar» con
  confirmación; `available: false` y los 409/403/errores muestran un aviso claro. No edita nada.
- Pruebas: `tests/web-forge-progress.test.ts`, `web-forge-card.test.ts`, `web-forge-page.test.ts`, `web-scratch.test.ts` y
  `server-forge-settings.test.ts`. Los componentes se verificaron a mano con `alisio serve` y un proveedor guionizado
  (tarjeta `js_run` con llamadas en vivo, tarjeta `python_run` con insignia y barra, página Forja, pestaña Scratch).
- Límites y observaciones: el JS del script `progress({message, completed, total})` casi nunca llegaba al cliente porque
  el coalescedor lo reemplazaba por el siguiente evento de llamada dentro de los mismos 250 ms (corregido en la Fase 8a). Los componentes no tienen pruebas de renderizado
  (el repositorio no tiene entorno DOM); su lógica vive en módulos puros probados.

### Forja: Fase 8a (documentación, capturas y cierre)

Estado: **hecho, sin commit.** Cubre `specs/alisio-forja-v1.md` §11.2 (capturas), §14 Fase 8 y §15; y
`specs/alisio-forja-python-v1.md` §9.4 (capturas), §12 y §13.

- Prueba intermitente: la causa era una suposición de reloj en las pruebas de cancelación de
  `tests/forge-javascript-engine.test.ts`. Cancelaban con `setTimeout(150)`: bajo carga el aborto podía llegar antes de que
  el script o la llamada anidada hubieran empezado (un listener añadido a una señal ya abortada nunca se dispara, así que
  `seenAbort` quedaba en `false`), y `FJ-AC-10` comparaba `Date.now() - started < 1500` incluyendo el arranque del worker.
  Ahora se cancela cuando el estado observable lo permite (el script informó `progress` y está girando; la herramienta
  anidada está esperando) mediante un sondeo del estado, la cota de parada se mide desde el aborto y la prueba del plazo
  usa 1 500 ms en lugar de 300 con una herramienta que también contempla una señal ya abortada. No se pudo reproducir el
  fallo original en varias ejecuciones en paralelo bajo carga; la corrección elimina las dos carreras identificadas por lectura.
- Coalescencia del progreso (`packages/core/src/forge/progress.ts`): el límite de 4 por segundo pasa a ser por categoría
  (progreso del script, eventos de llamada y otros); cada categoría conserva su último evento y tiene su propia ventana, el
  vaciado respeta el orden de llegada y los eventos terminales nunca se descartan ni consumen la ventana. Prueba nueva en
  `tests/forge-kernel-pure.test.ts`; primera línea roja:
  `AssertionError: expected [ 'running' ] to deeply equal [ 'running', 'call' ]`.
- Documentación (EN/ES, en paridad): página nueva `docs/forja.md` y `docs/es/forja.md` (qué es el modo código, elección del
  lenguaje, aislamiento y sus límites, claves `forge.*` y `analysis.*`, `alisio forge status`, `alisio analysis setup --wasm`,
  scratchpad, `forge_guide`, web y TUI) enlazada en la barra lateral; sección `forge` en configuración, enlaces desde
  análisis, herramientas y web, y la sección «Ajustes → Forja» de la web sustituye a la antigua página de análisis.
- Capturas reales con Playwright sobre `alisio serve` y un proveedor guionizado, datos de ejemplo y la interfaz en inglés
  (el repositorio usa una imagen por función con el texto alternativo y el pie en el idioma de cada página):
  `forge_js_run_web_ui`, `forge_settings_web_ui`, `forge_python_backends_web_ui`, `forge_python_run_badge_web_ui` y
  `forge_scratchpad_web_ui` (WebP, todas por debajo de 60 KB). La ruta del intérprete que mostraba la sección Python se
  sustituyó en el DOM antes de capturar. La captura del scratchpad muestra la lista; la vista previa de un archivo ocupa el
  panel entero y no se capturó. El interruptor de guías queda fuera de la captura de ajustes (está al final de la página).
- `CHANGELOG.md`: sección `[Unreleased]` con Forja. `tests/changelog.test.ts` ignora `Unreleased` al comprobar las
  entradas de cabecera y `packages/core/src/changelog/data.ts` se regeneró.

### Limitaciones de Forja

- **Aislamiento.** `js_run` está aislado por la VM QuickJS-WASM; en Node el worker es un hilo del proceso, de modo que un
  escape del motor comprometería a Alisio (Bun y el binario usan un proceso hijo). `python_run` en `managed` no es un
  sandbox. En `wasm` la red no está bloqueada en Node 22 y 24, el límite de memoria es blando (muestreo cada 250 ms) y un
  script hostil alcanza el JavaScript del ejecutor (FFI); `strict` excluye `wasm` salvo que el sondeo vea la red rechazada.
  `ALISIO_SCRATCH_DIR` de solo lectura no se puede garantizar en `managed`. Además, en `wasm` un script puede leer
  `os.homedir()`, `os.hostname()` y `os.userInfo()`, y las rutas absolutas del host (distribución y carpetas del job)
  aparecen en `process.argv` del hijo; el ejecutor sustituye esas rutas por marcadores en sus mensajes de fallo. `wasm`
  exige Node 22.22, 24.13 o 25.3 o posterior (CVE-2025-55130) y recibe una copia del scratchpad sin enlaces.
- **Concesiones y llamadas anidadas (D8, deliberado).** Las concesiones almacenadas no se aplican a las llamadas anidadas: una
  llamada directa con concesión puede ejecutarse mientras la anidada recibe `APPROVAL_REQUIRED`.
- **Aprobaciones.** Un script no puede pedir aprobación: la llamada anidada falla con `APPROVAL_REQUIRED`.
- **Persistencia.** La lista por llamada de la tarjeta `js_run` no se guarda: tras recargar solo quedan los contadores. El
  scratchpad vive en la carpeta temporal, se elimina tras 7 días sin actividad y no tiene copia de seguridad.
- **Rendimiento.** El arranque de Pyodide cuesta de 1 a 2 s con pandas y unos 5 s con scikit-learn; el runtime se descarga una
  vez (unos 44 MB, 70 MB con `science`). `js_run` limita 50 llamadas, 4 simultáneas y 16 000 caracteres de salida por defecto.
- **Interfaz.** Los componentes web no tienen pruebas de renderizado (no hay entorno DOM); su lógica vive en módulos puros.
  La captura del scratchpad no muestra la vista previa y las capturas de ajustes dejan fuera la sección de guías.
- **Sin repetición.** La tarjeta de `js_run` no ofrece «repetir».

#### Revisión final 3/3 de Forja: hallazgos y correcciones

Hallazgos de la tercera revisión (seguridad) y su resolución. Cada corrección empezó por una prueba de comportamiento en rojo.

- **M1 (medio, bloqueante) — `wasm` leía a través de enlaces simbólicos del scratchpad.** El Modelo de Permisos sigue los
  enlaces existentes y Python llega a `node:fs` por la FFI. Ahora el padre copia el scratchpad a `<job>/scratch-copy` sin
  seguir enlaces (`scratch-copy.ts`: omite enlaces y archivos especiales, `O_NOFOLLOW`, tope de 64 MB, profundidad acotada), concede
  `--allow-fs-read` solo sobre la copia y la borra al terminar el job. `oci` monta la carpeta real en `:ro`, pero un enlace
  dentro de un montaje se resuelve en el espacio de nombres del contenedor, no en el host (sin cambios); `managed` es el host.
  Pruebas: rápidas con node falso (flags y rutas, la copia no contiene el enlace, se limpia) y real con Pyodide (un enlace puesto en el
  scratchpad da `DENIED` desde la copia concedida, la ruta real y la ruta virtual; con la concesión del directorio real la
  misma prueba filtra el secreto, así que discrimina).
- **M2 (medio) — el sondeo de red contaba cualquier error de conexión como «denegada».** Ahora solo `ERR_ACCESS_DENIED` es
  `denied`; `ECONNREFUSED`, `EADDRNOTAVAIL`, etc. son no concluyentes (`networkDeniedByOS: false`, detalle `probe inconclusive: <code>`)
  y un resultado no concluyente no se recuerda (se vuelve a sondear).
- **L1 — Bun aceptaba entradas relativas del `PATH`.** Se omiten las no absolutas (`.`, `bin`, vacías).
- **L2 — las rutas HTTP del scratchpad usaban el proveedor sin puerta.** `app.forge.scratchpad` ahora cierra igual que
  `PathAccess` (motor verificado y no `--read-only`) y `scratchpadView` busca la carpeta sin crearla (`findSessionScratchpad`): un
  GET no hace `mkdir`; con `--read-only` o autocomprobación fallida responde `available: false`.
- **L3 — el listado recorría y ordenaba todo el árbol antes del tope de 2000.** Ahora recorre en el orden final (un directorio
  ordena como `nombre/`), se detiene al conocer un archivo más que el tope (`truncated: true`) y limita la profundidad a 32.
- **L4 — las llamadas anidadas ignoran las concesiones almacenadas.** Es la decisión D8; no se cambió el comportamiento y se
  documentó (docs EN/ES de Forja, fila D8 de la especificación, limitaciones).
- **L5 — la documentación sobrestimaba el aislamiento de `wasm`.** Documentados `os.homedir()/hostname()/userInfo()` y las rutas
  en `process.argv`; el ejecutor ya no envía rutas absolutas del host al modelo en `fail(...)` ni en `uncaughtException`
  (`<dist>`, `<job>/...`, `<host>/<último segmento>`), con prueba que ejecuta el ejecutor real con una distribución inexistente.
- **L6 — `setup --wasm` concurrentes compartían `.download/`.** Cada ejecución usa `.download-<aleatorio>`, el marcador se
  escribe con nombre temporal único y se relee antes de escribirlo (no degrada una instalación mayor terminada entretanto), el
  fallo no borra la carpeta si otra ejecución dejó un marcador, y los restos de ejecuciones muertas (más de 1 h) se limpian.
- **L7 — confirmado.** CVE-2025-55130 (salto del Modelo de Permisos con rutas simbólicas) se corrigió en Node 22.22.0, 24.13.0 y
  25.3.0 (https://nodejs.org/en/blog/vulnerability/december-2025-security-releases; Debian lo confirma en
  https://security-tracker.debian.org/tracker/CVE-2025-55130). `wasm-node.ts` exige ahora esas versiones o posteriores (23.x y
  anteriores a 22.22 se rechazan, mayores que 25 se aceptan) con el motivo «not ready» que nombra el CVE. Consecuencia: con Node 22.19 `wasm`
  no está listo; las pruebas reales de Pyodide se ejecutan con `ALISIO_TEST_PYODIDE_NODE` (por ejemplo Node 24.16).

#### Alcance de la verificación de Forja

Verificado: pruebas de comportamiento en los límites de cada módulo (núcleo, motor JavaScript con QuickJS y worker reales,
Python con backends falsos y Pyodide real bajo `ALISIO_TEST_PYODIDE`, servidor, TUI y lógica web), `pnpm test:cli` y
`pnpm test:compiled` con el binario, y comprobación manual de la web con un proveedor guionizado. No verificado: otros
sistemas operativos distintos de Linux (scratchpad y Modelo de Permisos de Node), contenedores reales de
Docker o Podman en CI, y modelos reales distintos de los usados en el benchmark.

#### Benchmark manual pendiente

**Benchmark manual de 5 tareas (§14, Fase 6): pendiente, ejecución manual por el propietario.** Es informativo, no una
puerta. Con Forja activa y un modelo real, sesión nueva por tarea y un directorio con `package.json` y un CSV de ejemplo,
anotar para cada tarea (a) la herramienta elegida, (b) si llamó a `forge_guide` y con qué tema, (c) los caracteres de guía
cargados y (d) si terminó bien, más el backend usado (`engine:` en la última línea):

| # | Tarea | Herramienta esperada |
| --- | --- | --- |
| 1 | «Cuenta cuántas funciones exportadas hay en cada archivo de `src/`» | `js_run` |
| 2 | «Lee estos 12 archivos JSON y dame el total de la clave `amount`» | `js_run` |
| 3 | «Lista los archivos de más de 100 líneas y agrúpalos por carpeta» | `js_run` |
| 4 | «Calcula media, mediana y desviación típica del CSV y haz un gráfico de barras» | `python_run` |
| 5 | «Entrena un clasificador sencillo sobre el CSV y dame la exactitud» | `python_run` (`python.ml`/`python.environment`) |
