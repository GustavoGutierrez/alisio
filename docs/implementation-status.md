# Estado de implementación — `__ALISIO_VERSION__`

La especificación original es la dirección del producto, no una declaración de que todos
sus criterios de release estén superados. Esta entrega inicia el proyecto con una alpha
funcional, no solo interfaces o stubs.

## Contenido

El índice es de texto plano a propósito: este archivo se lee tanto en GitHub como dentro del
sitio, y los dos generan anclas distintas para títulos con acentos (GitHub las conserva, VitePress
las elimina), así que unos enlaces internos aquí se romperían en uno de los dos. Use el esquema de
la derecha en el sitio o la búsqueda de su navegador en GitHub.

- Implementado: proveedores y `/connect`; núcleo, límites y almacenamiento; herramientas, AGENTS.md
  y skills; subagentes; plugins, extensiones y MCP; CLI, runtime y empaquetado; plantillas, pantalla
  de inicio y TUI; compactación, plugins y memoria; modelo y enrutamiento por sesión; preguntar al
  usuario; herramientas de red y CLI; confianza de proyecto y diagnóstico; agente activo y effort
  de razonamiento; servidor web (`alisio serve`).
- Validación.
- Pendiente para estabilizar v0.1.
- Alcance de la verificación: una sección por área (runtime y empaquetado; subagentes, AGENTS.md y
  skills; plantillas y `/init`; pantalla de inicio y extensiones; TUI y compactación; presupuesto de
  tokens de salida del agente; límite de contexto frente al catálogo; memoria y plugins; pegado y
  adjuntos de imagen; preguntar al usuario; herramientas de red; confianza de proyecto y permisos;
  agente activo y effort; contratos de eventos y bloques UI; persistencia v4, blobs y catálogo de
  comandos; servidor web).
- Límites conocidos: runtime y empaquetado; subagentes; proveedores, plantillas y licencia; memoria;
  plugins e instalación; portapapeles, pegado y TUI; skills y contexto; compactación y truncamiento;
  permisos, aprobaciones y confianza; preguntas y herramientas de red; persistencia, estadísticas y
  Herdr; agente activo y effort; servidor web.

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
  `--read-only` prevalece y bloquea también concesión, recuerdo y revocación. En `/mcp`, el diálogo
  de consentimiento ofrece "Conceder solo para esta sesión" o "Conceder y recordar (global)"; la
  escritura global es atómica y conserva campos no relacionados; una acción "Revocar consentimiento
  MCP global" limpia `mcp.allow` y elimina el permiso de ejecución desconectando los servidores.
  Gestor TUI `/mcp` agrupado por origen real, con estados, detalles saneados, catálogo y anotaciones
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
  (incluido `/skills`/`/skill` con sugerencias del catálogo por nombre o descripción),
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
  `/model`, `/connect`, compactación, `/plugins`, `/skills`, `/mcp` y `/stats`; las puntuales
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
- Gestor TUI `/plugins` (`/plugin`): catálogo filtrable de plugins integrados y externos con nombre,
  descripción, categoría/origen seguro y estados activo, inactivo, fallido o reinicio necesario.
  El estado de reinicio desaparece al volver al estado original del runtime; no permite desactivar
  proveedores retenidos por ninguna sesión enrutada viva.
  Persiste anulaciones en `.alisio/config.json` con escritura atómica y conserva campos no
  relacionados. Los cambios se aplican tras reiniciar (no hay descarga parcial en caliente); los
  externos requieren confianza y confirmación explícita. Protege el proveedor de modelo activo y
  los recursos de sesión vivos.
- Plugin integrado `memory` (estilo Engram): SQLite + FTS5 trigram, BM25 con recencia y
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
  tras 10 minutos de inactividad y confianza leída del almacén de confianza de la terminal (la web
  nunca la concede).
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

## Validación

Consultar [validation.txt](https://github.com/GustavoGutierrez/alisio/blob/main/docs/validation.txt) para la ejecución final. Las pruebas de proveedor usan un
servidor HTTP local determinista, no una cuenta externa. MCP se prueba con el SDK servidor
real en procesos/HTTP locales. El binario Linux ejecuta un ciclo completo, carga un plugin
externo con dependencia y conserva la sesión. La integración Herdr tiene validación de
contrato; el escenario de dos agentes bajo un servidor Herdr real quedó bloqueado por el entorno.

## Pendiente para estabilizar v0.1

- Ejecutar y ajustar matriz Windows/macOS; CI actual cubre Linux, no certifica otros sistemas.
- Validar DeepSeek, OpenCode Console/Zen y OpenCode Go con credenciales del usuario. La inferencia
  solo se verificó con claves falsas y HTTP simulado/local; los catálogos públicos sin autenticación
  de Zen y Go se comprobaron por separado. No se usaron ni inspeccionaron credenciales reales.
- Validar Herdr con servidor/PTY reales; añadir launcher/resumer nativo si Herdr lo permite.
- Checkpoints/rewind de sesión y memoria vectorial: no existen.
- Onboarding interactivo; temas de color configurables; vista de razonamiento expandible.
- Primera publicación real en npm y release con binarios: el script `pnpm publish`
  (`scripts/publish.ts`, ver [Publicación](/es/publishing)) está implementado y cubierto por
  pruebas unitarias, pero no se ha ejecutado contra el registro real; SemVer de rangos de plugins
  y recarga en sesión inactiva.
- Discovery automático de rutas Pi y watch incremental.
- OAuth MCP interactivo y capacidades multimedia MCP. `/mcp` permite reconexión explícita y bearer
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
  extremo por stdio con una fixtura real: cada servidor `enabled` conecta sin tocar `/mcp`, los
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
  servidor; `/mcp` muestra el recuento de herramientas); el runner nunca corrompe un transcript
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

## Límites conocidos

## Límites conocidos

### Runtime y empaquetado

- Runtime: Node no carga `.env` automáticamente (Bun sí); use variables de entorno o
  `node --env-file=.env`. Los plugins `.ts` locales requieren Bun o Node >=22.18; los paquetes
  npm de plugins deben publicarse en JavaScript. La condición de export `alisio-source` solo
  se usa en desarrollo dentro del monorepo y no se publica.

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
- Licencia MIT provisional (titular: Gustavo Gutiérrez), pendiente de confirmación.

### Memoria

- Memoria: la búsqueda usa el tokenizador trigram, así que los términos de menos de 3
  caracteres se ignoran. Sin búsqueda semántica. El resumen automático de cierre solo se
  ejecuta en la TUI (no en `run` headless) y está acotado por
  `pluginHooks.sessionEndTimeoutMs`; si vence, la salida continúa sin resumen. El resumen de
  cierre reemplaza al checkpoint archivado de la misma sesión (un resumen por sesión).
  Los prompts de usuario se copian a la base de memoria (redactando `<private>`) al compactar
  y al cerrar; la base es local con permisos 0600.
- Diferencias con Engram: la tabla de sesiones se llama `memory_sessions` (la base puede
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
  mientras viva el proceso. La espera cuenta dentro de `limits.timeoutMs`. El contrato `Policy` no
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
- Las rutas de archivos, blobs y gestión (plugins, skills, MCP, proveedores, ajustes) llegan en
  fases posteriores; la web no ofrece aún adjuntos, explorador, trayectoria, métricas por sesión ni
  renderizadores ricos (los bloques `diff`, `terminal`, `json`, `test-results`, `progress`, `mermaid`
  y `math` se muestran de forma simple o como código).
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
