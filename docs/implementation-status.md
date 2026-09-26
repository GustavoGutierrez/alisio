# Estado de implementación — 0.1.0-alpha.1

La especificación original es la dirección del producto, no una declaración de que todos
sus criterios de release estén superados. Esta entrega inicia el proyecto con una alpha
funcional, no solo interfaces o stubs.

## Implementado

- Núcleo propio: streaming, tool loop, validación de entradas, límites de turnos/tiempo/contexto,
  presupuesto de tokens reportados, cancelación y eventos versionados.
- API compatible con OpenAI configurable: Chat Completions y Responses, modelo/URL/clave,
  ausencia de autenticación y diferencias de parámetros de tokens.
- SQLite: conversación autoritativa, eventos, journal de herramientas, estado de plugins,
  bloqueo de sesión y recuperación conservadora de efectos inciertos.
- Herramientas locales: lectura, escritura/edición con hash, ripgrep, procesos, shell y Git.
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
  directorios; catálogo progresivo, activación y recursos.
- Presupuesto de tokens proporcional: `limits.maxTokens` es opcional; por defecto 8 × ventana de
  contexto (entre 400k y 8M) o 1M si la ventana es desconocida.
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
- Puntos de extensión genéricos: `api.sessions`, `api.ui.panel/select/open/interactive`,
  `api.resources.agents/list`, `ToolDefinition.concurrent`, contexto de sesión en comandos.
- Plugins locales y manifiestos de directorio: herramientas, comandos, eventos, contexto,
  skills, estado y desregistro/cleanup.
- MCP oficial v2: stdio, Streamable HTTP, herramientas, recursos, prompts y cierre.
- Herdr custom: reportes de lifecycle, sesión y herramientas de comunicación entre agentes.
- CLI interactiva/headless, JSONL, reanudación, configuración y diagnósticos.
- Runtime Node-first: Node.js >=22.16 (mínimo verificado: 22.13–22.15 incluyen `node:sqlite`
  sin FTS5; 22.16.0 funciona) y compatible con Bun. Sin APIs `Bun.*`: `node:sqlite` (en ambos
  runtimes), `node:fs` y `node:child_process` detrás de la capa de runtime; el
  `ExperimentalWarning` de SQLite se filtra de forma específica sin ocultar otros avisos.
- Monorepo publicable: `@alisio/sdk` (contrato, sin dependencias), `@alisio/core` (núcleo
  embebible), `@alisio/plugin-memory` (depende solo del SDK y usa el puerto de almacenamiento)
  y `alisio` (CLI/TUI, registro de plugins integrados). Build con `tsc` a `dist/` (JS + `.d.ts`),
  `publishConfig.exports` sin fuentes, changesets para versionado y publicación con provenance.
- Plugins como paquetes npm (`--plugin nombre` o `plugins: ["nombre"]`), resueltos desde el
  proyecto y luego las raíces globales; exigen la keyword `alisio-plugin`.
- Binario autónomo opcional (`pnpm build:binary`, Bun) y workflow de release con binarios
  linux-x64/arm64, darwin-x64/arm64 y windows-x64, `SHA256SUMS` e instalador `scripts/install.sh`.
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
  con `--read-only`; aprobación en la TUI). `alisio init` sigue creando la configuración y
  ahora sugiere `/init`.
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
  spinner, duración, vista previa y diff de ediciones, barra de contexto y tokens, comandos
  `/help /model /compact /stats /clear /sessions /resume /tools /exit` con autocompletado,
  interrupción con Esc y aprobación interactiva de `write`/`process`. `--no-tui` conserva
  el modo readline.
- Compactación de contexto en el núcleo (manual y automática por umbral), con resumen del
  proveedor actual, emparejamiento de llamadas/resultados preservado y persistencia
  transaccional (migración 2: columna `messages.compacted`).
- Plugins: puntos de extensión aditivos en `PluginAPI` (apiVersion 1): hooks de
  compactación (`beforeCompact` con campos JSON extra en la misma llamada, `afterCompact` con
  inyección de contexto e informe), `session.onStart/onEnd`, `model.complete` agnóstico del
  proveedor, `ui.status` y metadatos de comandos. El host aplica timeouts y aísla fallos.
  Registro de plugins integrados (`packages/cli/src/builtin.ts`) con ruta de confianza, nombres sin
  prefijo y efecto `internal`; desactivables por configuración o `--disable-plugin`.
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
- Cambio de modelo por sesión (`AgentRunner.setModel`, `sessions.model`); el proveedor acepta
  un modelo por petición. Catálogo `GET /models` con ventana de contexto cuando el proveedor
  la informa, tokens en caché (`prompt_tokens_details.cached_tokens` o
  `prompt_cache_hit_tokens`) y razonamiento visible (`reasoning_content`) solo para mostrar.
- Lockfile y versiones fijadas; Biome, TypeScript, Vitest y CI Linux con Node 22.16, 22.x y 24.

## Validación

Consultar validation.txt para la ejecución final. Las pruebas de proveedor usan un
servidor HTTP local determinista, no una cuenta externa. MCP se prueba con el SDK servidor
real en procesos/HTTP locales. El binario Linux ejecuta un ciclo completo, carga un plugin
externo con dependencia y conserva la sesión. La integración Herdr tiene validación de
contrato; el escenario de dos agentes bajo un servidor Herdr real quedó bloqueado por el entorno.

## Pendiente para estabilizar v0.1

- Ejecutar y ajustar matriz Windows/macOS; CI actual cubre Linux, no certifica otros sistemas.
- Validar proveedores y modelos reales con credenciales del usuario.
- Validar Herdr con servidor/PTY reales; añadir launcher/resumer nativo si Herdr lo permite.
- Checkpoints/rewind de sesión y memoria vectorial: no existen.
- Onboarding interactivo; temas de color configurables; vista de razonamiento expandible.
- Primera publicación real en npm y release con binarios (flujos preparados, no ejecutados);
  SemVer de rangos de plugins y recarga en sesión inactiva.
- Discovery automático de rutas Pi y watch incremental.
- OAuth MCP interactivo, reconexión explícita en la CLI y capacidades multimedia MCP.
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
- `pack:check` empaqueta los cuatro paquetes con pnpm y valida contenido (solo `dist`, README,
  LICENSE, `package.json`), `exports` hacia `dist`, ausencia de `workspace:` y de fuentes.
- Instalación global real con npm desde los tarballs locales mediante un registro temporal
  (`scripts/install-smoke.ts`): `alisio --help` funciona desde el empaquetado npm.
- DeepSeek real bajo Node puro con el CLI construido (`run --read-only`, herramientas y JSONL).
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
- DeepSeek real (`deepseek-flash`, `--read-only`): dos `explore` en paralelo resumidos por el
  padre, y un caso anidado `general` → `explore` persistido con profundidades 1 y 2.
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
- DeepSeek real (`deepseek-flash`) sobre una copia temporal de `examples/plugins/custom-mascot`:
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
- Verificación manual en pseudo-terminal (Linux, xterm-256color, emulado con `pyte`) contra un
  servidor simulado y contra DeepSeek real (`deepseek-flash`): arranque, streaming Markdown,
  herramientas, aprobación, `/stats`, `/model`, `/compact`, `/tools`, `/sessions`, `/resume`,
  `/clear`, Esc, Ctrl+C, Ctrl+D, redimensionado a 60 y 40 columnas sin líneas desbordadas, y el
  binario compilado. No se probó en Windows/macOS ni en emuladores reales distintos (kitty,
  iTerm2, Windows Terminal); Shift+Enter depende de la terminal.
- No se ejecutó una compactación automática con DeepSeek real (ventana de 1M tokens).

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
- DeepSeek real (`deepseek-flash`, headless): el modelo guardó una memoria con
  `memory_save` en `--read-only` y, en una sesión nueva, respondió desde el contexto inyectado.
- No verificado: copia real mediante `xclip`/`wl-copy`/`pbcopy`/Windows (para no modificar
  el portapapeles del usuario); compactación automática con DeepSeek real; Windows/macOS.

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
- DeepSeek real (`deepseek-flash`, llamada directa al proveedor con `node --env-file=.env`,
  sin imprimir la clave): una imagen PNG real de 64×64 (fondo azul con una franja diagonal
  blanca) enviada como `image_url` obtuvo una respuesta correcta y específica
  ("The background is blue, and yes, it contains a thin white diagonal stripe..."), confirmando
  que `deepseek-flash` admite contenido de visión con el formato exacto que produce esta
  implementación. Con un servidor local que devuelve 400 para contenido de imagen, el SDK
  `openai` lanza un `BadRequestError` con mensaje legible que el runner ya convierte en un
  `run_failed` limpio (sin caída ni traza cruda).
- No verificado: recepción de imágenes por el portapapeles nativo en macOS o Windows (sin acceso
  a esas plataformas); miniaturas en línea reales en una terminal con protocolo Kitty o iTerm2
  (el entorno de prueba solo tiene xterm-256color, así que solo se ejerció la ruta de
  compatibilidad de texto).

## Límites conocidos

- Runtime: Node no carga `.env` automáticamente (Bun sí); use variables de entorno o
  `node --env-file=.env`. Los plugins `.ts` locales requieren Bun o Node >=22.18; los paquetes
  npm de plugins deben publicarse en JavaScript. La condición de export `alisio-source` solo
  se usa en desarrollo dentro del monorepo y no se publica.
- Subagentes: los mensajes en cola (`send_message`, notificaciones) viven en memoria y se pierden
  al salir; una notificación en segundo plano llega con el siguiente turno del padre; las skills
  de una definición no se preinyectan (se pide cargarlas con `skill_load`); los worktrees solo se
  usan cuando se solapan escritores; `/agents merge` exige árbol limpio y no resuelve conflictos;
  el panel muestra las tareas iniciadas en este proceso; `kill` equivale a `cancel`.
- Plantillas: sin inclusiones ni parciales, sin ejecución de comandos ni inyección de archivos;
  solo `$1`..`$9` posicionales; `/init` depende del modelo para limitarse a hechos verificados y
  consume bastantes tokens en repositorios grandes (`limits.maxTokens`).
- Pantalla de inicio: con `TERM=dumb` solo la pantalla de inicio pasa a ASCII; el resto de la
  TUI (cabecera, barras) sigue usando glifos Unicode. El ancho se cuenta por punto de código,
  así que glifos anchos (CJK, emoji) en mascotas personalizadas pueden desalinear. Los
  proveedores son síncronos: un proveedor lento no puede interrumpirse, solo descartarse.
- Licencia MIT provisional (titular: Gustavo Gutiérrez), pendiente de confirmación.

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
- Plugins: `model.complete` usa el proveedor configurado (el modelo de la sesión cuando el
  plugin lo pasa) y no descuenta del presupuesto `limits.maxTokens`. Los hooks corren en
  proceso: el timeout aborta la espera y señala el `AbortSignal`, pero no puede detener
  código síncrono bloqueante.
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
- `provider.contextWindow` se aplica solo al modelo configurado; tras `/model`, la ventana
  proviene de `GET /models` o queda como desconocida (y la compactación automática por
  umbral se desactiva para ese modelo, salvo por `limits.maxContextChars`).
- La compactación usa el proveedor actual; su consumo de tokens no se suma al presupuesto
  `limits.maxTokens`. Las estimaciones antes/después son aproximadas (≈4 caracteres/token).
  Los items opacos de Responses del tramo resumido se descartan; los conservados no cambian.
  Una sesión con resultados de herramientas inciertos no se compacta hasta recuperarla.
- Aprobaciones: solo para efectos `write` y `process` y solo en la TUI; "permitir en la
  sesión" dura mientras viva el proceso. La espera cuenta dentro de `limits.timeoutMs`.
  El contrato `Policy` no cambió: la aprobación es una opción adicional de `RunnerOptions`.
- Un `resume` con otro modelo ya no falla: la sesión es la fuente del modelo y `--model`
  lo cambia explícitamente para los turnos siguientes.

- Plugins en proceso pueden bloquear el event loop o saltarse servicios mediados. Solo código
  confiable; los timeouts del motor no pueden detener código síncrono hostil.
- El bloqueo SQLite por PID está diseñado para procesos locales en un host, no para una base
  compartida en red. La reutilización de PID puede exigir intervención del usuario.
- La validación de rutas no es un aislamiento OS. La shell y plugins tienen permisos del usuario.
- Las estadísticas dependen del proveedor. Si no envía usage, el límite de tokens no es exacto;
  siguen aplicando límites de turnos, tiempo, longitud del contexto y salida por petición.
- El adaptador chat soporta texto y function tools; bloques privados de razonamiento de
  proveedores de terceros no se normalizan. Para continuation de OpenAI use Responses.
- La sesión restaura el historial activo (el compactado queda archivado). Hay migraciones
  hacia adelante e idempotentes (v1 → v2); no hay migraciones hacia atrás.
- Lectura/edición de texto limitada a 1 MiB. Búsquedas/salidas extensas se truncan explícitamente.
- La integración Herdr permite intercambio por terminales; no promete autonomía multiagente
  completa ni planificación distribuida.
