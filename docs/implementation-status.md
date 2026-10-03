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
  (`specs/alisio-web-memory-tab-v1.md`); tareas en segundo plano (fase 3) y objetivos de sesión
  `/goal` (fase 4) de la especificación de modos, goal y tareas en segundo plano.
- Validación.
- Pendiente para llegar a 1.0.0.
- Alcance de la verificación: una sección por área (runtime y empaquetado; subagentes, AGENTS.md y
  skills; plantillas y `/init`; pantalla de inicio y extensiones; TUI y compactación; presupuesto de
  tokens de salida del agente; límite de contexto frente al catálogo; memoria y plugins; pegado y
  adjuntos de imagen; preguntar al usuario; herramientas de red; confianza de proyecto y permisos;
  agente activo y effort; contratos de eventos y bloques UI; persistencia v4, blobs y catálogo de
  comandos; agentes del usuario; servidor web; modos, `/reload` y `/changelog`; pestaña Memory y
  vistas de plugins; tareas en segundo plano; objetivos de sesión).
- Límites conocidos: runtime y empaquetado; subagentes; proveedores, plantillas y licencia; memoria;
  plugins e instalación; portapapeles, pegado y TUI; skills y contexto; compactación y truncamiento;
  permisos, aprobaciones y confianza; preguntas y herramientas de red; persistencia, estadísticas y
  Herdr; agente activo y effort; agentes del usuario; servidor web; modos, recarga y novedades;
  pestaña Memory y vistas de plugins; tareas en segundo plano; objetivos de sesión.

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

Primera fase de `specs/alisio-modes-goal-background-v1.md` (decisiones del propietario confirmadas
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

Especificada en `specs/alisio-web-memory-tab-v1.md`. Solo web; todo aditivo.

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

### Tareas en segundo plano (fase 3 de la especificación de modos, goal y tareas)

Especificada en `specs/alisio-modes-goal-background-v1.md` (§8). Todo aditivo.

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

Especificada en `specs/alisio-modes-goal-background-v1.md` (§9). Todo aditivo; decisiones del
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

Fase 1 de `specs/alisio-data-analysis-runtime-v1.2.md` (§21): `python_run`, `artifact_create`,
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

Fase 2 de `specs/alisio-data-analysis-runtime-v1.2.md` (§21): comodín del router, visor aislado
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

Fase 3 de `specs/alisio-data-analysis-runtime-v1.2.md` (§21): ingesta de CSV, TSV, JSON, JSONL y
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

Fase 4 de `specs/alisio-data-analysis-runtime-v1.2.md` (§21): runtime `oci` opcional (Docker o
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
  herramienta solo avisa/pide confirmación (headless exige `--yes`/`--trust-plugin`). No se
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
