# Interfaz de terminal

Sin subcomando, y con stdin y stdout conectados a una terminal, Alisio abre una TUI construida con
[`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui). Acepta los mismos
flags globales que el resto de la CLI (`--config`, `--model`, `--allow-write`, `--allow-process`,
`--read-only`, etc.).

```sh
alisio --config ./my-api.json
alisio resume <id>        # TUI on an existing session
alisio --no-tui           # plain readline mode instead of the TUI
```

`run`, `resume <id> "prompt"` y `--json` nunca abren la TUI. La TUI usa la pantalla alternativa de la
terminal; al salir imprime la conversación y el ID de sesión. Salir es rápido: un turno en vuelo
recibe hasta 3 segundos, los hooks de fin de sesión ~1,5 segundos (durante la salida; `/clear`
sigue honrando el `pluginHooks.sessionEndTimeoutMs` completo) y el cierre de servidores MCP,
proveedor y plugins corre en paralelo con topes cortos — un servidor o plugin colgado nunca
retrasa la salida.

## Ruta rápida

| Quiero… | Ir a |
| --- | --- |
| Elegir o cambiar proveedor y modelo | [`/connect`, `/model`](#comandos) |
| Pegar texto o una imagen | [Pegar: texto e imágenes](#paste-text-and-images) |
| Aprobar o denegar una escritura/proceso | [Aprobaciones interactivas](#interactive-approvals) |
| Responder una pregunta de opción múltiple | [Preguntar al usuario](#ask-user-question) |
| Conceder o revocar consentimiento MCP | [Gestor MCP](#mcp) |
| Ver o cancelar un subagente | [Panel de agentes](#agent-panel) |
## Pantalla de inicio

Las sesiones interactivas comienzan con una pantalla de inicio: la mascota (por defecto "Ali", un
espíritu-nube de los vientos alisios), la versión, una línea de bienvenida, el modelo, el host del
proveedor (nunca las claves), el directorio de trabajo, el acceso (estado de `write`/`process` o
`read-only`), si la memoria está activada, los plugins cargados y dos consejos rotativos. Se dispone
en paralelo cuando la terminal es ancha y apilada cuando es estrecha; por debajo de 40 columnas la
mascota se reduce a una sola línea. En la TUI es el primer bloque de la conversación y se desplaza
con ella; en el modo `--no-tui` se imprime en stderr.

Solo se muestra en la TUI interactiva (stdout es una terminal) o en el modo readline (solo cuando
stderr es una terminal). Nunca se muestra con `run`, `resume <id> "prompt"`, `--json`, `--quiet`,
`--no-banner`, cuando la variable de entorno `CI` está definida, ni cuando el flujo de destino no es
una terminal. La salida JSONL nunca se ve afectada, aunque los plugins registren una mascota.

```sh
alisio --no-banner        # interactive, without the startup screen
alisio --quiet            # no startup screen and no non-essential hints
```

`TERM=dumb` la muestra en ASCII sin color, `NO_COLOR` desactiva el color y una locale `C`/`POSIX`
cambia a ASCII. Los plugins pueden reemplazar la mascota o toda la pantalla mediante
[puntos de extensión](/es/plugins#extension-points).

## Disposición {#layout}

La pantalla se reorganiza al redimensionar la terminal, y cada línea se trunca o ajusta al ancho.

| Zona | Contenido |
| --- | --- |
| Cabecera | **Alisio Code** y la versión del paquete en ejecución (el mismo valor que imprime `--version`), **modelo · proveedor · effort** (el nombre del modelo en cian negrita, el nombre del proveedor en magenta, el nivel de effort en amarillo cuando el modelo activo anuncia niveles soportados), host del proveedor (nunca la clave ni la ruta), modo de API, directorio de trabajo abreviado, ID corto de sesión, la rama git del directorio de trabajo cuando está dentro de un repositorio (`⎇ main`, o el SHA corto del commit en HEAD separado) y permisos con color (`write`/`process`: `on`, `ask` u `off`; `mcp:on` cuando el permiso de ejecución efectivo está concedido, `mcp:off` en caso contrario; `read-only`) |
| Conversación | Mensajes del usuario resaltados; respuestas del asistente en streaming renderizadas como Markdown: títulos en cian brillante y negrita, tablas con columnas alineadas adaptadas al ancho (las filas separadoras con guiones largos em/en se normalizan de nuevo a `---`), listas, código en línea y en bloque — el código en bloque se sangra y se colorea por sintaxis según el lenguaje (TypeScript/JavaScript, JSON, Bash, Python, YAML, CSS, HTML, Markdown) sin ninguna dependencia de resaltado — y enlaces. Una pista atenuada `⎘ copy · /copy` aparece bajo cada respuesta completada. El razonamiento visible que envía el proveedor (por ejemplo `reasoning_content` de DeepSeek) se muestra atenuado mientras llega y luego se colapsa en una línea; nunca se persiste ni se reenvía |
| Bloques de herramientas | Un bloque por llamada: nombre, argumento resumido (ruta, comando, patrón), spinner mientras se ejecuta, estado ✓/✗, duración y vista previa truncada. `edit_file`/`write_file` muestran un diff `+`/`-` calculado a partir de los argumentos. Las herramientas que devuelven datos estructurados (por ejemplo MCP) renderizan **bloques nativos**: tablas de columnas alineadas con celdas que se ajustan al ancho, clave-valor en dos columnas, árboles con glifos de ramas, bloques de código con resaltado de sintaxis, bloques markdown e imágenes en línea cuando la terminal lo soporta (marcador atenuado `[image: …]` en caso contrario) |
| Barra de estado | **Línea del agente activo** bajo el editor: `agente: <nombre> · <modelo> · <proveedor> · <effort>` (modelo en cian negrita, proveedor en magenta, effort en amarillo; el effort aparece solo cuando el modelo activo anuncia niveles soportados; en terminales estrechos se descartan primero las piezas de menor prioridad). Contexto usado frente al **presupuesto efectivo**, `used / total (pct%)`, con barra verde/amarilla/roja que se pone roja exactamente donde se dispara la compactación automática; tokens acumulados de entrada/salida y en caché (`⚡`) cuando se informan; turnos; duración del turno en curso; estado; estado de plugins (por ejemplo `mem N`) |
| Selectores | Listas seleccionables para `/model`, `/agents`, `/effort`, `/plugins`, `/skills`, `/resume` y las aprobaciones |

Los errores aparecen en rojo dentro de la conversación sin cerrar la TUI.

La barra de contexto mide **la misma métrica efectiva que usa el motor** para la compactación
automática. Con una ventana de contexto conocida (el campo `context_window`/`context_length` de
`GET /models`, `provider.contextWindow` para el modelo configurado, o el override
`values.contextWindow` del perfil activo de `/connect` para su modelo), el total es esa ventana y la
barra se pone roja en `threshold` de ella (por defecto 85 %). El catálogo se carga de forma perezosa
al arrancar y se refresca tras cada cambio de proveedor/modelo, de modo que la ventana real del
modelo activo se muestra siempre que el descubrimiento la exponga. El override por perfil existe
para servidores locales (por ejemplo llama.cpp) que omiten `context_window`: `/connect` lo pregunta
en tokens cuando el catálogo no puede indicar la ventana del modelo seleccionado, y el override
prevalece sobre el catálogo. Cuando la ventana no puede conocerse, la barra muestra un honesto
`~9.9k / ?` en lugar de un total o porcentaje inventado: el presupuesto de caracteres de respaldo
sigue siendo una salvaguarda de compactación interna del motor, nunca un total mostrado.
El contexto usado es el último `prompt + completion` informado por el proveedor; sin `usage`, se
muestra una estimación marcada con `~` (unos 4 caracteres por token).

## Comandos

Al escribir `/` se abre el autocompletado: `/skills` sugiere las skills efectivas por
nombre o descripción, y `/resume` sugiere los IDs de sesión que coincidan con el prefijo.

### Comandos de un vistazo

| Comando | Función |
| --- | --- |
| `/help` | Comandos y teclas |
| `/connect` | Abrir un formulario de proveedor con pegado de URL, entrada secreta enmascarada, un campo de variable de entorno de la clave de API (la conexión recuerda su nombre para el respaldo por entorno), edición con cursor e instrucciones explícitas para enviar/cancelar; después mostrar la lista titulada y prefijada del proveedor elegido, persistir la selección globalmente e iniciar una sesión nueva |
| `/model`, `/models` | Abre el selector global de proveedor/modelo. Las entradas se agrupan y prefijan con el título del proveedor, se marca la pareja activa y los catálogos no disponibles siguen visibles sin ocultar perfiles sanos. Una pareja distinta se persiste e inicia una sesión nueva; la pareja activa no hace nada. No se lista la configuración raíz heredada |
| `/compact [focus]` | Resume la historia antigua con el modelo actual, con instrucciones de foco opcionales |
| `/stats` | Tokens (entrada, salida, caché), turnos, llamadas y errores por herramienta, duración, modelos, contexto y detalles de plugins |
| `/clear` (`/new`) | Inicia una sesión nueva con el modelo actual |
| `/sessions` | Sesiones recientes del workspace |
| `/resume <id>` | Reanuda por ID o prefijo; sin argumento muestra un selector |
| `/tools` | Herramientas y su estado según los permisos (`enabled`, `ask`, `disabled`) |
| `/plugins` | Filtra plugins activos, inactivos y fallidos; muestra metadatos/origen y persiste una anulación del proyecto. Los cambios indican `restart required`; las acciones externas requieren confianza y confirmación, y no se puede desactivar el proveedor de modelo activo. Los plugins se agrupan bajo cabeceras de categoría no seleccionables (`model-provider ›`, `memory ›`…); al filtrar, una cabecera solo permanece si su grupo aún tiene coincidencias, y `↑`/`↓` saltan las cabeceras |
| `/skills` | Explora el catálogo efectivo acotado; busca con `/`, alterna orden por nombre/origen/tokens con `t`, muestra detalles seguros y habilita o deshabilita skills gestionables de inmediato. Las skills de plugins están bloqueadas y se gestionan con `/plugins` |
| `/mcps` | Explora servidores por origen; separa configuración/activación, permiso de sesión, conexión y herramientas cargadas; muestra anotaciones; conecta/reconecta; y persiste la activación en el archivo que lo definió. Sin `--allow-mcp` inicial (o `mcp.allow` global), Conectar/Activar muestra las consecuencias de proceso/red y puede conceder acceso solo para esta sesión TUI, o recordarlo globalmente (`mcp.allow`) para todas las sesiones. Una fila "Revocar consentimiento MCP global" limpia esa preferencia y desconecta los servidores. `--read-only` lo bloquea |
| `/settings` (`/prefs`) | Menú de ajustes: lista estilo OpenCode con preferencias reales y conectadas (compactación, contexto, consentimiento MCP, límites, padding del editor, inset del contenido) y filas de navegación hacia los gestores siguientes. Filas de dos columnas (nombre + valor actual), filtro escribiendo, contador `(n/total)`, pie con la descripción de la fila resaltada; Enter o Espacio cambia un valor, Esc sale. Se persiste en tu configuración de usuario y se aplica a la sesión en curso |
| `/copy` | Copia la última respuesta del asistente al portapapeles como texto crudo (sin formato, sin los colores ANSI que se ven en pantalla) |
| `/ask <pregunta>` | Convierte tu propia pregunta en una llamada a `ask_user_question` de opción múltiple; consulte [Preguntar al usuario](#ask-user-question) |
| `/btw [pregunta]` | Hace una pregunta lateral sobre la sesión actual sin añadirla a la conversación: una llamada sin herramientas al modelo de la sesión ve el historial activo (se descartan los mensajes más antiguos para caber en el presupuesto de contexto) y responde en un panel sobre el editor, nunca en la transcripción, los runs, los eventos ni los tokens de la sesión. Funciona con un turno en curso; Esc cancela una pregunta pendiente o cierra el panel. Sin pregunta muestra tu respuesta lateral más reciente, `←`/`→` recorren las anteriores (`2/5`) y `↑`/`↓` desplazan; si aún no hay ninguna imprime `Usage: /btw <question>`. Se guardan las 20 últimas por sesión, compartidas con la interfaz web. En modo `--no-tui` la respuesta se imprime |
| `/agents` | Abre el selector de agente activo: cada agente seleccionable de la sesión principal con su descripción y marcadores de actual/por defecto/solo lectura. Elegir uno persiste `agents.active`, se aplica desde el siguiente prompt y cambia el modelo de la sesión si el agente declara uno; consulte [Agente activo y effort](#active-agent-and-effort). Con un argumento (`list`, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`) enruta a la gestión de tareas del plugin de subagentes, consulte [Subagentes](/es/subagents#in-the-tui) |
| `/effort [nivel]` | Establece el effort de razonamiento del modelo activo cuando anuncia `effort.supportedLevels`: sin argumento abre un selector (el valor por defecto del modelo está marcado), con argumento valida y persiste (`agents.effort`). El nivel se envía desde el siguiente prompt; consulte [Agente activo y effort](#active-agent-and-effort) |
| `/init [focus]` | [Plantilla de prompt](/es/prompt-templates#built-in-init) integrada: analiza el repositorio y crea o actualiza el `AGENTS.md` raíz |
| `/artifacts [filter]` | Recorre los artefactos de la sesión (los más recientes primero, con filtro) y ofrece Vista previa aquí, Abrir con la aplicación predeterminada, Copiar ruta, Mostrar en la carpeta, Copiar al workspace…, Mostrar fuentes del análisis, Detalles o Eliminar; consulta [Artefactos](#artifacts) |
| `/permissions` | Revisa los permisos guardados de la sesión (por ejemplo, análisis en Python permitido en esta sesión) y los revoca |
| `/exit` (`/quit`) | Salir |
| `/skill:name request` | Carga una skill y envía la solicitud |
| `/command plugin.id:name args` | Ejecuta un comando de plugin |
| `/memory …` | Comando del plugin integrado de memoria; consulte [Memoria persistente](/es/memory) |
| `/agents …` | Gestión heredada de tareas de subagentes (plugin integrado): `list`, `open`, `cancel`, `kill`, `resume`, `merge`, `discard`, `defs`; sigue disponible con un argumento como arriba — consulte [Subagentes](/es/subagents#in-the-tui) |
| `/agents new [descripción]` | Crea un agente en `.agents/agents` (proyecto o global). Con una descripción, el modelo activo redacta las instrucciones de inmediato ("Building with Alisio", Esc cancela); al terminar Alisio ofrece probarlo en una sesión nueva. Consulte [Agentes](/es/agents#terminal-agents) |
| `/agents templates` | Crea un agente a partir de una plantilla (Code Reviewer, Test Writer, Security Auditor, …). Consulte [Agentes](/es/agents) |
| `/agents manage` | Edita, activa, prueba o elimina agentes guardados; `/agents edit <id> [project\|global]` y `/agents delete <id> [project\|global]` van directo a uno |
| `/agents reload` | Vuelve a descubrir archivos de agentes cambiados fuera de Alisio |
| `/agent:<id>` | Activa un agente cargado desde el siguiente prompt; hay un comando por agente cargado y el prefijo `agent:` nunca colisiona con otros comandos |

`/init` es una plantilla de prompt que genera o actualiza `AGENTS.md` a partir del repositorio; no
tiene relación con el comando `alisio setup`, que solo genera un `.alisio/config.json` de ejemplo.
Las demás [plantillas de prompts](/es/prompt-templates) aparecen en una sección propia de `/help` y
en el autocompletado.

Los demás comandos de plugins se enrutan de la misma manera y aparecen en `/help` y en el
autocompletado. Mientras un turno está en curso, los prompts y los comandos `/model`, `/agents` (selector), `/effort`, `/plugins`, `/skills`, `/mcps`, `/settings`, `/compact`,
`/clear` y `/resume` esperan: pulse Esc para interrumpir primero. Los verbos de gestión de tareas de
subagentes (`/agents open …`, `/agents list`, …) y `/btw` siguen funcionando durante un turno.

### Catálogo de skills y autocompletado

El catálogo de skills usa `↑`/`↓`, RePág/AvPág, Inicio/Fin y la rueda del ratón. Mantiene visible la
selección al filtrar, ordenar y redimensionar, solo renderiza las filas que caben e informa los
recortes como `↑ N more above` / `↓ N more below`. Enter o Espacio cambia la skill gestionable
seleccionada; Esc cierra el catálogo. Las skills también aparecen directamente en el
autocompletado de comandos del editor: al empezar a escribir `/ski…` (o el propio nombre de la
skill, como `/branch-pr…`) cada skill efectiva aparece como comando `skill:<nombre>` con un
marcador de ámbito (`[u]` usuario, `[p]` proyecto, `[c]` config, `[l]` plugin) y su descripción, al
estilo OpenCode; elegir una inserta `skill:<nombre>` y envía. Además, `/skills <prefijo>` (o
`/skills <prefijo>`) autocompleta las entradas del catálogo por nombre o descripción (las
deshabilitadas, bloqueadas y sombreadas siguen listadas con una pista de estado); aceptar una
sugerencia solo rellena el argumento, así que enviar todavía abre el catálogo. Las entradas
`skill:<nombre>` del autocompletado pueden ocultarse con el ajuste `tui.skillSlashCommands` (ver
más abajo); el gestor `/skills` y su autocompletado de argumentos siguen funcionando igualmente.

### Menú de ajustes (`/settings`)

`/settings` abre una lista de ajustes estilo OpenCode. Cada fila es un ajuste con su valor actual
en una columna derecha; la cabecera muestra el proveedor/modelo activo. La lista permite buscar
escribiendo (coincidencia con nombre, clave, categoría y descripción), navegar con
`↑`/`↓`/Inicio/Fin/RePág/AvPág, cambiar el ajuste resaltado con Enter o Espacio, y muestra un
contador `(n/total)` y un pie con la descripción de la fila resaltada. Esc vuelve al editor.
Escribir un espacio después de empezar a buscar inserta un espacio en el filtro. Bajo
`--read-only` todas las filas se muestran marcadas como de solo lectura: no se persiste nada.

Cada ajuste siguiente es real y está conectado: se persiste en tu configuración de **usuario**
(`~/.config/alisio/config.json`) mediante el mismo escritor atómico que usa el consentimiento MCP
y se aplica a la sesión en curso. Los valores que no estén en la lista ofrecida (por ejemplo un
`compaction.threshold: 0.87` editado a mano) avanzan al siguiente valor ofrecido al primer Enter.

| Ajuste | Valores | Por defecto | Se aplica |
| --- | --- | --- | --- |
| Auto-compact (`compaction.auto`) | `true` / `false` | `true` | siguiente ejecución |
| Umbral de compactación (`compaction.threshold`) | 50 % – 95 % en pasos de 5 % | `85 %` | siguiente ejecución |
| Mantener últimos turnos (`compaction.keepTurns`) | 0 – 20 | `2` | siguiente ejecución |
| Tope de tokens de salida de compactación (`compaction.maxOutputTokens`) | 8k / 12k / 16k / 24k / 32k | `16000` | siguiente ejecución |
| Fallback a CLAUDE.md (`context.claudeMdFallback`) | `true` / `false` | `false` | siguiente turno |
| Tope de bytes de AGENTS.md (`context.maxBytes`) | 4 KiB – 1 MiB en pasos de 4 KiB | `32768` | siguiente turno |
| Proveedor de búsqueda web (`websearch.provider`) | `searxng` / `duckduckgo-instant` / `duckduckgo-html` / `tavily` / `brave` / `serpapi` / `native` | sin definir (cadena de respaldo) | siguiente llamada de búsqueda |
| Recordar consentimiento MCP (`mcp.allow`) | `true` / `false` | `false` | inmediato |
| Máximo de turnos (`limits.maxTurns`) | 5 / 10 / 15 / 20 / 30 / 50 / 100 | `100` | siguiente ejecución |
| Tope de tokens de salida del agente (`limits.maxOutputTokens`) | 1k / 2k / 4k / 8k / 16k | `16384` | siguiente ejecución |
| Presupuesto de caracteres de contexto (`limits.maxContextChars`) | 80k / 120k / 160k / 240k / 320k / 800k | `800000` | siguiente ejecución |
| Tiempo de espera de ejecución (`limits.timeoutMs`) | 30 s – 600 s en pasos de 30 s (se persiste en ms) | `300000 ms` (5 min) | siguiente ejecución |
| Tiempo de espera de hooks de plugins (`pluginHooks.timeoutMs`) | 1 s – 120 s en pasos de 1 s (se persiste en ms) | `15000 ms` | siguiente hook |
| Padding del editor (`tui.paddingX`) | 0 – 4 | `1` | inmediato |
| Inset del contenido (`tui.contentPaddingX`) | 0 – 12 | `2` | inmediato |
| Comandos slash de skills (`tui.skillSlashCommands`) | `true` / `false` | `true` | inmediato |

"Recordar consentimiento MCP" alterna el mismo consentimiento persistido que el flujo de
concesión de `/mcps`: activarlo escribe `mcp.allow` y concede el permiso en tiempo de ejecución
(los servidores habilitados se conectarán solos desde el próximo inicio; usa `/mcps` para
conectarlos ahora), y desactivarlo revoca el consentimiento y desconecta los servidores.

Las filas inferiores navegan: Proveedor y modelo, Conectar proveedor, Compactar contexto ahora,
Plugins, Skills, Servidores MCP y Estadísticas de sesión. Las filas que abren un gestor dejan
Esc/atrás a ese gestor; las acciones puntuales (compactar, estadísticas) vuelven a la lista.

**No incluidos (lista honesta):** varios ajustes habituales en otros agentes de código no existen
aún en Alisio, así que NO se ofrecen aquí — telemetría (Alisio no recopila ninguna), renderizado
de diagramas Mermaid, modo de dirección/seguimiento, doble Esc para salir, selección automática
de transporte (handshake stdio/http), tiempo de inactividad HTTP para MCP, telemetría de
instalación, entradas de changelog colapsadas, cursor por hardware, limpiar al reducir la
terminal, progreso en terminal, cambio de tema, niveles de aviso, filtro de árbol, un valor de
confianza persistido por defecto y una ventana de contexto global de proveedor/modelo (esa es por
perfil en `/connect`). El agente activo y el effort de razonamiento viven en `/agents` y
`/effort`; un valor de confianza persistido sigue fuera de alcance por ahora. Si falta un ajuste
es porque Alisio no implementa esa función; ninguna fila es un stub.

En el modo `--no-tui` los comandos admitidos son `/exit`, `/new`, `/skill:name request` y
`/command plugin.id:name args`. Las líneas se procesan secuencialmente; Ctrl+C cancela y sale.

### Agente activo y effort {#active-agent-and-effort}

El **agente activo** dirige la sesión principal: su prompt de sistema se anexa a cada prompt, y un
agente de solo lectura (como el `plan` integrado) limita la ejecución a lecturas (sin herramientas
de escritura/proceso, sin aprobaciones). Alisio incluye dos integrados:

| Agente | Descripción |
| --- | --- |
| `build` (por defecto) | Agente general de máxima potencia: edita código y archivos, ejecuta procesos y verifica su trabajo con el flujo de permisos normal. El valor por defecto no añade persona, así que el comportamiento inicial no cambia |
| `plan` | Agente de planificación de solo lectura: analiza el código y devuelve un plan de implementación sin modificar nada |

`/agents` (selector de agente activo) lista cada agente seleccionable con su descripción: los
integrados más cualquier definición principal-capaz del sistema de [subagentes](/es/subagents)
(definiciones marcadas `mode: primary` o `mode: all`), incluidos los `--agents <json>` y los
archivos Markdown de agentes. El agente actual se marca, `build` muestra su marcador `(default)` y
los agentes de solo lectura muestran `read-only`. Elegir uno persiste `agents.active` en tu
configuración de usuario y se aplica **desde el siguiente prompt** (se conserva la sesión actual).
Cuando el agente elegido declara un `model`, el modelo de la sesión se cambia con el enrutamiento
normal de proveedores (inicia una sesión nueva, exactamente como `/model`); un agente sin modelo
conserva el modelo actual — anúlelo en cualquier momento con `/model`. Un id de agente persistido
que ya no resuelve (por ejemplo, porque se eliminó su definición) cae a `build`.

**Effort de razonamiento.** Cuando el modelo activo anuncia `effort.supportedLevels` en su
catálogo (por ejemplo los modelos DeepSeek), `/effort` selecciona el nivel que se envía con cada
prompt siguiente: sin argumento abre un selector sobre los niveles soportados (se marca el
`defaultLevel` del modelo, además de una entrada *Auto · por defecto del proveedor* que limpia el
valor guardado); con argumento, el nivel se valida y se persiste (`agents.effort`). El proveedor lo
recibe como `reasoning_effort` (Chat Completions) o `reasoning.effort` (Responses); los proveedores
sin concepto de effort lo ignoran. Si más tarde el modelo cambia a uno que no soporta el nivel
guardado, se usa el valor por defecto del modelo silenciosamente con un aviso único. El nivel
elegido también se muestra en la cabecera y en la barra de estado, en amarillo.

## Gestor MCP {#mcp}

`/mcps` en la TUI lista los servidores por origen y, para el seleccionado, separa los estados
configurado/activado, permiso de sesión, conexión y herramientas cargadas, mostrando las anotaciones
de las herramientas. Sin `--allow-mcp` al arrancar (o el `mcp.allow` global), **Conectar**/**Activar**
explica las consecuencias de proceso/red y ofrece una concesión **solo para esta sesión** o
**Conceder y recordar** (que escribe `mcp.allow` y auto-conecta los servidores activados desde el
siguiente arranque); una fila **Revocar consentimiento MCP global** borra esa preferencia y
desconecta los servidores. `--read-only` bloquea todo el gestor. Consulte
[Herramientas y permisos](/es/tools#mcp) para la configuración de servidores y
[Configuración](/es/configuration#servidores-mcp) para `mcp.allow`.
## Teclas

| Tecla | Acción |
| --- | --- |
| Enter | Enviar |
| Shift+Enter, Alt+Enter, Ctrl+J | Insertar una línea nueva (depende de la terminal) |
| Tab | Autocompletar |
| ↑ / ↓ | Historial de entrada |
| Esc | Interrumpir el turno en curso |
| Ctrl+C | Borrar la entrada; interrumpir un turno activo; pulsado dos veces con la entrada vacía, salir |
| Ctrl+D | Salir cuando la entrada está vacía |
| `c` / `y` | Copiar la última respuesta del asistente como texto crudo (cuando la entrada está vacía) |
| `x` | Expandir o plegar la fila plegable más cercana — una sección **Thought** terminada, un lote agrupado de llamadas a herramientas o una salida de comando larga (cuando la entrada está vacía; véase [Visualización de herramientas y razonamiento](#tool-reasoning-display)) |
| Clic del ratón | En la fila de cabecera de un bloque plegable, expandirlo o plegarlo (véase [Visualización de herramientas y razonamiento](#tool-reasoning-display)) |
| PgUp / PgDn, rueda del ratón | Desplazar la conversación |
| Ctrl+X | Enfocar el [panel de agentes](#agent-panel) |
| Ctrl+B | Pasar a segundo plano los agentes en primer plano en ejecución (durante un turno) |
| Ctrl+K | Cancelar el agente seleccionado o visualizado |
| Ctrl+V | Adjuntar una imagen del portapapeles (véase [Pegar](#paste-text-and-images)) |
| Ctrl+R | Quitar la última imagen adjuntada |

`/exit`, doble Ctrl+C con la entrada vacía y Ctrl+D pasan por el mismo apagado acotado: lo que siga
en ejecución se aborta y se espera como mucho ~3 segundos, los hooks de fin de sesión reciben ~1,5
segundos y el cierre de la aplicación también está limitado — salir se siente instantáneo incluso
con muchos servidores MCP.

## Visualización de herramientas y razonamiento {#tool-reasoning-display}

La transcripción sigue las convenciones visuales de otros agentes de código, para que un turno
activo se lea como una historia y no como un muro de llamadas crudas:

- **Nombres de herramientas legibles.** `read_file` se muestra como **Read File**, `search_text`
  como **Search Text**, `mcp_devforge_time_diff` como **MCP · Devforge Time Diff**. Los acrónimos
  conocidos se conservan en mayúsculas (HTTP, API, CLI…). El nombre de máquina sigue disponible,
  atenuado, en la fila de detalle de cada llamada agrupada y en los informes `/tools` y `/stats`.
- **Razonamiento plegable.** Mientras el modelo piensa, la fila muestra la cola en vivo
  `✻ thinking…`. Cuando la sección de pensamiento termina se pliega a **`+ Thought · 2.9s`** (la
  duración aproxima el intervalo de pensamiento a partir de la secuencia de eventos; en sesiones
  reanudadas se omite). Al expandir se muestra el texto completo del pensamiento, acotado a 40
  líneas envueltas.
- **Lotes de herramientas agrupados.** Las llamadas consecutivas del mismo tipo (`read`, `write`,
  `process`, `mcp`) aparecen como **una sola fila cuando todas terminan**: `✓ Read File — 3 reads ·
  60ms` para un lote uniforme, o `✓ Explored — 3 reads` cuando el lote mezcla herramientas de
  lectura. Al expandir se lista cada llamada con su estado, duración, resumen, una vista previa de
  salida acotada y su línea de código de salida. Un lote que comparte nombre conserva el nombre
  legible de la herramienta más un sustantivo de recuento por tipo (`reads`, `files`, `commands`,
  `calls`, `tasks`). Las llamadas en ejecución o en espera de aprobación siempre siguen siendo
  filas individuales con su propio spinner y estado en vivo — un lote se pliega en su fila de grupo
  solo cuando todas las llamadas han terminado.
- **Salida de comando larga.** Una vista previa más larga que el límite plegado (3 líneas limpias
  al tener éxito, 6 en error) se pliega a la vista familiar del shell: las primeras líneas,
  `… N more lines` y una línea final **`Command exited with code 0.`** (verde) o
  `Command exited with code 1.` (roja) cuando la herramienta informó un código de salida
  (run_process, shell, search_text). Al expandir se revela la salida completa. Los diffs de
  edición, las imágenes y los bloques ui nativos (tablas, árboles…) conservan su renderizado
  anterior; los bloques enriquecidos no se pliegan porque ya van acotados.

Los plegables se alternan pulsando **`x`** con la **entrada vacía** (nunca mientras se escribe un
mensaje — la misma convención de entrada vacía que `c`/`y`), o **haciendo clic en la fila de
cabecera** de un bloque plegable con el ratón (la selección por arrastre y copiar-al-seleccionar no
se ven afectados: un clic sin movimiento alterna, un arrastre sigue seleccionando). "Más cercano"
significa el último de la transcripción, así que durante el streaming `x` pliega el último bloque
terminado. Las filas plegadas muestran un `+` atenuado y las expandidas un `−`.

## Panel de agentes {#agent-panel}

Cuando se ejecutan [subagentes](/es/subagents), aparece bajo el editor un panel en árbol plegable. Su
cabecera muestra cuántos agentes están en ejecución, en cola, **esperando** y terminados; cada fila
muestra un icono de estado, el nombre y el color del agente, el tiempo transcurrido, los tokens y un
resumen en vivo de una línea. La sangría muestra padre → hijo.

Una fila muestra **esperando** (◆, distinto del spinner de ejecución) en lugar de en ejecución
cuando ese agente está bloqueado en `ask_user_question` o en una aprobación de escritura/proceso —ya
sea la que se muestra en pantalla, o en cola tras otra—. Es un estado solo de presentación calculado
a partir de la misma [cola interactiva](#ask-user-question) que serializa los avisos; nunca se
persiste, así que desaparece en cuanto se responde o se retira la pregunta del agente.

| Foco | Tecla | Acción |
| --- | --- | --- |
| Editor | Ctrl+X, o ↓ con el editor vacío cuando hay agentes | Enfocar el panel |
| Editor | Ctrl+X y después ↓ en menos de 800 ms | Abrir directamente el primer agente |
| Panel | ↑ / ↓ | Mover la selección |
| Panel | → | Expandir, o entrar en los hijos |
| Panel | ← | Plegar, o ir al padre |
| Panel | Enter | Abrir la conversación del agente en una vista de solo lectura |
| Panel | Esc, Tab | Volver al editor |
| Vista de hijo | ↑ | Agente padre (desde un agente de primer nivel, vuelve a la conversación raíz) |
| Vista de hijo | ↓ | Primer hijo |
| Vista de hijo | ← / → | Hermano anterior / siguiente |
| Vista de hijo | Esc | Volver a la conversación raíz |
| Panel o vista de hijo | Ctrl+K | Cancelar el agente seleccionado o visualizado (pide s/n —`y`/`n`— cuando tiene descendientes) |
| Cualquiera | Ctrl+B | Pasar a segundo plano los agentes en primer plano en ejecución |

En una vista de hijo, el pie muestra la ruta del agente, su índice y el total, el porcentaje de
contexto, los tokens y sugerencias de teclas. Escribir mientras el panel tiene el foco devuelve el
foco al editor.

## Copiar al seleccionar

La TUI captura el ratón. Al arrastrar se selecciona texto y se copia al portapapeles con la primera
herramienta disponible, sin shell:

| Plataforma | Herramientas probadas en orden |
| --- | --- |
| Linux | `wl-copy`, `xclip -selection clipboard`, `xsel -b` (más las herramientas de Windows bajo WSL) |
| macOS | `pbcopy` |
| Windows | `clip.exe`, PowerShell `Set-Clipboard` |

Si ninguna funciona, Alisio envía una secuencia de escape OSC 52 y la informa como **no verificada**,
porque la terminal no puede confirmarla. `/copy` copia la última respuesta del asistente de la misma
manera.

### Copiar una respuesta

Cada respuesta completada del asistente muestra una pista atenuada **`⎘ copy · /copy`** bajo ella
(`[copy] · /copy` en ASCII si la terminal no soporta Unicode) — solo informa de que la respuesta se
puede copiar, no dispara nada por sí misma. Pulsar **`c`** (o **`y`**) con la **entrada vacía**
copia la última respuesta del asistente exactamente igual que `/copy` — como **texto crudo, sin
formato** (la fuente Markdown, nunca el renderizado con color) — y muestra la misma confirmación
`Copied (<herramienta>)`. Escribir `c` o `y` a mitad de un mensaje escribe con normalidad: el
atajo solo actúa con la entrada vacía, sin autocompletado a la vista y sin un turno en curso. La
pista aparece solo cuando la respuesta está completa (nunca durante el streaming).

Mientras la captura del ratón está activa, la selección nativa de la terminal suele requerir
**Shift+arrastrar**.

## Resultados enriquecidos de herramientas {#rich-tool-results}

Las herramientas que responden con datos estructurados —los servidores MCP a la cabeza— dejan de
aplanar su salida en texto JSON crudo. El conector mapea las formas verificadas a bloques `ui` propios de
Alisio y la TUI los renderiza de forma nativa bajo la cabecera de la herramienta:

- **Tablas** como columnas alineadas: cabecera en negrita, celdas que se ajustan al ancho de su
  columna (los valores largos se envuelven en vez de cortarse) y una línea separadora atenuada bajo
  la cabecera. Un título opcional aparece atenuado sobre el bloque.
- **Clave-valor** en dos columnas: claves en cian brillante a la izquierda, valores envueltos a la
  derecha.
- **Árboles** con glifos de ramas (`├─`/`└─`/`│`) y con alternativa ASCII (`|-`/`` `- ``/`|`) en
  terminales sin Unicode. Una anotación `(meta)` atenuada sigue a la etiqueta cuando existe.
- **Código** como mini bloque de código que reutiliza el resaltador de las respuestas: cerca
  atenuada ` ```lang `, líneas resaltadas y la cerca de cierre.
- **Markdown** con el renderizador de Markdown habitual de las respuestas (títulos, listas, tablas…).
- **Imágenes** en línea cuando la terminal soporta el protocolo de gráficos kitty o iTerm2
  (detección automática de pi-tui 0.87.1). Sin soporte de imágenes —o con `NO_COLOR`— se muestra
  un marcador atenuado `[image: image/png 640x480]`.

Cada bloque tiene una **proyección de texto canónica** que siempre forma parte del resultado de la
herramienta, de modo que el modelo, `/copy`, los resúmenes de compactación y cualquier ruta
headless ven solo texto plano (los bytes de imagen nunca llegan al prompt del modelo). El transcript
también guarda la proyección, de forma que `resume` reproduce los resultados enriquecidos de manera
nativa. Es una capa de presentación: el JSON crudo no se muestra cuando se renderiza un bloque, y
las formas no reconocidas conservan el comportamiento de vista previa anterior.

## Pegar: texto e imágenes {#paste-text-and-images}

**Texto.** Pegar, incluido texto de varias líneas, se inserta como una única edición atómica en el
cursor: nunca se fragmenta en pulsaciones, nunca se envía antes de tiempo por un salto de línea
incluido, y se deshace en un solo paso. Los pegados largos (más de 10 líneas o 1000 caracteres) se
colapsan en un marcador como `[paste #1 +42 lines]` que se expande al texto completo al enviar el
mensaje. Esto proviene del propio componente del editor (pegado con corchetes), no de código
específico de Alisio.

**Imágenes.** `Ctrl+V` adjunta al mensaje en composición la imagen que haya en el portapapeles del
sistema:

| Tecla | Acción |
| --- | --- |
| Ctrl+V | Adjuntar la imagen del portapapeles (PNG, JPEG, GIF o WebP) |
| Ctrl+R | Quitar la última imagen adjuntada |

Las imágenes adjuntas aparecen sobre el editor: como miniatura en línea en terminales que admiten el
protocolo gráfico Kitty o iTerm2, o si no, como una línea compacta como
`[1] image/png 1024x768, 42.0 KB`. Hasta **4 adjuntos** por mensaje, **5 MB** de bytes crudos por
imagen; superar cualquiera de los dos límites muestra un mensaje en línea y rechaza solo la imagen
que lo excede — nunca bloquea la TUI. Los adjuntos viajan con el siguiente mensaje que se envíe
(cualquier comando que llegue al modelo, incluida una plantilla de prompt renderizada) y se
limpian después.

Los adjuntos enviados se convierten en partes de contenido de visión compatibles con OpenAI
(`image_url` en modo chat, `input_image` en modo Responses) junto al texto, usando el proveedor ya
configurado — no existe una opción de visión aparte. Alisio no comprueba si un modelo admite
imágenes antes de enviarlas; si no las admite, el rechazo del propio proveedor aparece como un
error en línea normal, igual que cualquier otro fallo de la petición. Los adjuntos se persisten
junto con el mensaje, así que `/resume` y la compactación los ven; una imagen resumida (descartada)
se describe al modelo del checkpoint solo por su tipo y dimensiones — sus bytes nunca se reenvían
ni aparecen en el texto del checkpoint.

El acceso al portapapeles de imágenes depende de un ayudante nativo de la plataforma y no está
garantizado en todos los casos:

| Plataforma | Portapapeles de imagen nativo | Limitaciones habituales |
| --- | --- | --- |
| Linux (X11) | Sí, mediante un ayudante incluido | Recurre a `wl-paste` en Wayland; no disponible por SSH simple sin reenvío de X11 ni una sesión Wayland/X11 activa |
| Linux (Wayland) | Vía `wl-paste` | Misma limitación con sesiones remotas/SSH |
| macOS | Sí, mediante un ayudante incluido | No verificado por SSH en este proyecto |
| Windows | Sí, mediante un ayudante incluido | No verificado por SSH en este proyecto |

Cuando no hay ningún ayudante disponible, `Ctrl+V` no hace nada dañino: informa de que el acceso al
portapapeles de imágenes no está disponible y deja la entrada intacta. Esto es habitual en sesiones
remotas o sin interfaz gráfica, porque el acceso al portapapeles de imágenes necesita un servidor de
pantalla local o APIs nativas de la plataforma que una sesión SSH simple no ofrece.

**Modo `--no-tui` (readline).** Ahí no hay soporte de imágenes en absoluto: ni renderizado ni
integración con el portapapeles. El pegado de una sola línea de texto funciona igual que escribir.
El pegado de varias líneas **no** se pega de forma atómica: la interfaz `readline` simple de Node no
admite pegado con corchetes, así que cada salto de línea incluido se trata como su propio Enter, y
se envía un mensaje por línea en lugar de un único mensaje combinado. Use la TUI completa (la
opción por defecto en una terminal interactiva) para pegar varias líneas o imágenes.

## Preguntar al usuario (ask_user_question) {#ask-user-question}

El modelo puede hacer una o varias preguntas de opción múltiple con la herramienta
`ask_user_question` (véase [Herramientas y permisos](/es/tools#ask-user-question)) —por ejemplo
cuando hay una bifurcación real en el enfoque y la preferencia del usuario cambia lo que sigue—.
También puede iniciarlo usted mismo con `/ask <pregunta>`: el agente propone 2 a 4 opciones
concretas para su propia pregunta (marcando una como `recommended` solo cuando tiene una opinión
clara) y llama a la herramienta de inmediato.

Las preguntas se muestran **de una en una** (por pasos), no como un único panel con las opciones de
todas las preguntas a la vez: una terminal estrecha no puede mostrar de forma legible las opciones de
varias preguntas en una sola pantalla, y un paso se reajusta de forma independiente al
redimensionar. La línea de cabecera muestra `Question i/N`; una opción `recommended` se marca y
colorea, no solo se describe, así que resalta incluso cuando las descripciones se truncan.

| Tecla | Acción |
| --- | --- |
| ↑ / ↓ | Mover la opción resaltada (da la vuelta en los extremos) |
| → / Espacio | Alternar una opción (solo en preguntas de selección múltiple) |
| Enter | Confirma la pregunta actual y avanza; envía en la última pregunta |
| ← / Retroceso | Retroceder para cambiar una respuesta anterior (solo se ofrece tras avanzar) |
| Esc | Omite **solo la pregunta actual** |

**Esc omite solo la pregunta actual**, no todo el lote: la marca como omitida (se muestra como
`_Skipped_` en el resumen) y pasa a la siguiente exactamente igual que Enter, así que una pregunta
anterior o posterior del mismo lote nunca se ve afectada. Fue una decisión deliberada (el
comportamiento exacto de Claude Code aquí no se pudo verificar de forma independiente en su
momento): cancelar todo el lote descartaría respuestas ya dadas, lo cual sorprende más que omitir
una sola pregunta.

Tras confirmar u omitir la última pregunta, se añade un resumen compacto a la conversación: una
línea por pregunta con su cabecera y la(s) opción(es) elegida(s), o `_Skipped_` / `_None selected_`
(una respuesta de selección múltiple explícitamente vacía, distinta de una omisión); las etiquetas
largas de las opciones se truncan con `…` final en lugar de ajustarse, para mantener el resumen
corto.

### Un solo aviso a la vez

Las aprobaciones de escritura/proceso, el selector de `/model` y `ask_user_question` comparten
**una sola cola interactiva**: como mucho uno de ellos está en pantalla a la vez, en el orden en que
se solicitaron (estrictamente FIFO —el primero en llegar, el primero en atenderse—; no hay
prioridad de la raíz sobre los subagentes, ya que un subagente también puede llamar a
`ask_user_question` mediante la misma herramienta). La pregunta de un [subagente](/es/subagents)
muestra una migaja de pan con quién pregunta (su ruta de agente, p. ej. `general › explore asks:`) y
su respuesta se entrega solo a ese subagente exacto, nunca se difunde. Si un subagente se cancela
mientras su pregunta está en cola o mostrándose, se retira de forma limpia —un aviso lo indica, y el
siguiente elemento en cola (si lo hay) ocupa su lugar— en lugar de dejar un aviso obsoleto para una
sesión ya muerta. El [panel de agentes](#agent-panel) muestra a ese agente como **esperando**
mientras esté en cola o mostrándose.

Los selectores propios de `/model` y `/resume` no forman parte de esta cola compartida: son comandos
que usted mismo escribe, nunca concurrentes con la pregunta de un subagente.

## Respuestas truncadas {#truncated-responses}

Cuando una respuesta se corta por `limits.maxOutputTokens` (razón de finalización `length`), el
texto producido hasta ese momento se conserva y la ejecución termina con normalidad, pero la TUI
añade un aviso visible: `Response cut by max output tokens — the answer may be incomplete.` Es un
aviso, no un error: aumente `limits.maxOutputTokens` en su configuración para respuestas más largas
(véase [Configuración](/es/configuration#limits)). Un checkpoint de compactación truncado se
muestra con el marcador `partial` y apunta a `compaction.maxOutputTokens` (véase
[Compactación de contexto](/es/compaction)). Los modos sin interfaz siguen siendo legibles por
máquina: `alisio run --json` nunca imprime el texto del aviso y solo lleva el estado en los datos
del evento — `run_completed` incluye `"truncated": true` cuando la respuesta final se cortó, y
`compaction_completed` incluye `"partial": true` para un resumen cortado.

## Límite de turnos {#turn-limit}

`limits.maxTurns` es un **carril de seguridad, no un tope duro** (los topes duros reales son el
presupuesto de tokens y el tiempo de espera de ejecución). Cuando una ejecución alcanza el tope de
turnos, Alisio conserva todo lo producido hasta ese momento y termina la ejecución **suavemente**:
la TUI añade un aviso amable —
`Turn limit reached — the answer may be incomplete. Continue with another prompt or raise
limits.maxTurns (/settings → Max turns).` — en lugar de un bloque de error, y usted puede
simplemente escribir `continue` para seguir en la misma sesión (el transcript queda intacto). Los
consumidores sin interfaz ven el evento `run_turns_exceeded` con el tope en sus datos, y el
resultado de la ejecución trae `"status": "turns-exceeded"` con el texto parcial. Los subagentes
que alcanzan su tope devuelven su informe parcial como salida utilizable con un marcador
`turnsExceeded`, nunca como un fallo (véase [Subagentes](/es/subagents#turn-limit)).

## Aprobaciones interactivas {#interactive-approvals}

En la TUI, cuando `write` o `process` no están permitidos mediante flags, las herramientas
correspondientes se ofrecen igualmente al modelo, y Alisio pregunta antes de ejecutarlas:

- **Permitir una vez** (*Allow once*)
- **Permitir siempre `<effect>` en esta sesión** (*Always allow*; dura mientras vive el proceso)
- **Denegar** (*Deny*)

Una ruta de herramienta fuera del workspace y de toda raíz extra declarada pregunta igual, acotada al
directorio contenedor (una aprobación de sesión cubre el subárbol de ese directorio). Con
`--read-only` no se pregunta y esas herramientas siguen desactivadas. Los modos headless nunca
preguntan. El tiempo de espera de una aprobación cuenta dentro de `limits.timeoutMs`. Las
aprobaciones comparten la misma [cola interactiva](#ask-user-question) que `ask_user_question`, así
que el aviso de aprobación de un subagente y su pregunta nunca compiten por la pantalla. Consulte
[Herramientas y permisos](/es/tools).

## Artefactos {#artifacts}

Los archivos que publican [`python_run` o `artifact_create`](/es/analysis) se anuncian debajo de la
fila de la herramienta con su tipo, nombre, tamaño y ruta local real:

```text
  ▤ Dashboard  sales-dashboard.zip  48 KB
    ~/.local/state/alisio/artifacts/3f2a…/7c1d…/sales-dashboard--art_01JZ…/files/index.html
```

Sin Unicode los iconos son ASCII (`[D]`, `[M]`, `[T]`, `[I]`, `[J]`, `[C]`, `[Z]`, `[F]`) y
`NO_COLOR` quita los colores. Al terminar un turno que publicó artefactos, una línea tenue te
recuerda `/artifacts`. Nada se abre automáticamente.

`/artifacts [filter]` lista los artefactos de la sesión raíz; elige uno y después una acción (solo
se ofrecen las que aplican):

| Acción | Cuándo | Qué hace |
| --- | --- | --- |
| **Preview here** | Markdown, CSV/TSV, JSON, texto y código | Una vista previa acotada y desplazable (abajo) |
| **Open with default app** | Siempre | `xdg-open`, `open` o `explorer.exe`, nunca a través de un shell |
| **Copy path** | Siempre | Copia la ruta local (OSC 52 cuando hace falta) |
| **Reveal in folder** | Siempre | `explorer.exe /select,` en Windows, `open -R` en macOS, la carpeta en Linux |
| **Copy to workspace…** | No con `--read-only` | Pide una carpeta del workspace y ejecuta `artifact_export`; escribir pregunta antes salvo con `--allow-write` |
| **Reveal analysis sources** | Salidas de `python_run` | Abre la carpeta del trabajo (script, logs) de esa ejecución |
| **Details** | Siempre | Fecha, modelo, proveedor, runtime, entradas con sus hashes, la ejecución y, en una repetición, la ejecución que repite |
| **Rerun** | Salidas de `python_run`, cuando `python_run` está disponible | Ejecuta el mismo script con las mismas entradas como una ejecución nueva con artefactos nuevos; pregunta como la primera vez |
| **Delete** | Artefactos listos | Con confirmación |

Un artefacto cuyos archivos eliminó la [retención](/es/analysis#retention) sigue apareciendo en la
lista, marcado como `Expired`, y ofrece solo **Details** y **Rerun** (una repetición lo recrea
mientras se conserve su script).

Esc vuelve atrás y un segundo Esc cierra. Por SSH o sin pantalla no se lanza nada: Alisio muestra la
ruta y ofrece copiarla.

La vista previa muestra Markdown con el renderer del chat (primeros 256 KiB), CSV/TSV como tabla
(200 filas × 20 columnas, con la leyenda `showing 200 of 12,480 rows · 20 of 31 columns`), JSON con
formato (256 KiB) y texto o código con resaltado (2 000 líneas); el pie dice `truncated` cuando se
recortó. ↑/↓, RePág/AvPág e Inicio/Fin desplazan, `o` abre con la aplicación predeterminada, `c`
copia la ruta y Esc o `q` cierran. Los dashboards, PDF, imágenes y documentos de oficina nunca se
dibujan en la terminal.

Ejecutar Python pregunta con su propio título, `Run Python analysis (managed · not sandboxed)?`,
muestra las primeras 40 líneas del script y ofrece **Allow once**, **Allow for this session**
(guardado para la sesión, también tras reiniciar) y **Deny**; Esc deniega. `/permissions` lista los
permisos guardados y los revoca. Con `analysis.runtime: "oci"` el título dice
`(container · no network)`.

Instalar los paquetes opcionales de Python pregunta con `Install Python packages (analysis; needs
network)?`, listando los paquetes, la estimación de descarga y que no se compila nada, y ofrece solo
**Allow once** y **Deny**: este permiso nunca se recuerda. `/settings` tiene un grupo **Data
analysis** con el interruptor, el tiempo máximo y los tres valores de retención.

### Herramientas de datos {#data}

Los resultados de `data_inspect` y `data_query` muestran sus tablas en la transcripción con el mismo
renderizador de tablas: el esquema con pistas de tipo y estadísticas, una muestra de filas o el
resultado de la consulta (como máximo 1 000 filas, con una nota `truncated`). La terminal no adjunta
archivos: el modelo lee un archivo del workspace con `data_inspect { path }`, y una ruta fuera del
workspace sigue la aprobación de directorios habitual. La vista previa de CSV/TSV de `/artifacts` lee
los archivos como la ingesta (delimitadores `,` `;` TAB o `|`; UTF-8, UTF-16 con BOM o windows-1252);
XLSX nunca se dibuja en la terminal, así que **Open with default app** es su única acción, y el modelo
lo lee con `data_inspect`. Consulta [Datos tabulares](/es/analysis#data).
