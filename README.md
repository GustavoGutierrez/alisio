# Alisio

**Velocidad y eficiencia para construir.**

Arnés de programación extensible con núcleo propio en TypeScript, Bun, pnpm, Biome y Vitest.
Versión **0.1.0-alpha.1**. Incluye CLI interactiva y headless, API compatible con OpenAI,
herramientas locales, plugins TypeScript, AGENTS.md, Agent Skills, MCP y un adaptador Herdr.

## Inicio rápido

Requisitos: Node.js 24+, pnpm 11.25.0, Git y ripgrep en PATH. Bun 1.4.2 se instala como
dependencia de desarrollo y se usa mediante `pnpm exec bun`. El ejecutable compilado
incluye Bun; Git y ripgrep siguen siendo dependencias externas.

```sh
pnpm install --frozen-lockfile
pnpm dev --help
pnpm dev doctor
pnpm check
```

Configure su endpoint y modelo antes de ejecutar tareas. No hay un modelo predeterminado
ni credenciales incluidas.

```sh
cp examples/openai-compatible.json my-api.json
# Edite baseURL, model y tokenParameter en my-api.json.
export OPENAI_API_KEY='SU_CLAVE'
pnpm dev run "Explica este repositorio" --config ./my-api.json --read-only
```

PowerShell:

```powershell
$env:OPENAI_API_KEY = 'SU_CLAVE'
pnpm dev run "Explica este repositorio" --config ./my-api.json --read-only
```

Para un servidor local sin autenticación, edite el modelo y la URL de
`examples/local-api.json`, y úselo mediante `--config`. El modelo debe soportar
streaming y tool calling en el protocolo seleccionado.

Para permitir modificaciones:

```sh
pnpm dev run "Implementa la tarea descrita en docs/task.md" --config ./my-api.json --allow-write
```

Para permitir ejecutar pruebas/comandos agregue `--allow-process`. Esa capacidad da
acceso a procesos arbitrarios con los permisos del usuario; no es un sandbox.

## API compatible con OpenAI

Alisio usa el SDK oficial `openai` como transporte y controla su propio ciclo de herramientas.

| Campo | Función |
| --- | --- |
| `provider.baseURL` | URL base, incluyendo `/v1` cuando el servidor lo requiera |
| `provider.model` | Identificador exacto del modelo en su servidor |
| `provider.apiKeyEnv` | Variable que contiene la clave; default `OPENAI_API_KEY` |
| `provider.apiMode` | `chat` para Chat Completions o `responses` |
| `provider.auth` | `bearer` o `none`; `none` omite Authorization |
| `provider.tokenParameter` | En modo chat: `max_tokens`, `max_completion_tokens` u `omit` |
| `provider.streamUsage` | Solicitar estadísticas en streaming si el servidor lo soporta |
| `provider.contextWindow` | Opcional. Ventana de contexto en tokens del modelo configurado; tiene prioridad sobre `GET /models` |

Precedencia del proveedor: archivo seleccionado → variables de entorno → flags.
Variables: `OPENAI_BASE_URL`, `ALISIO_MODEL`, `ALISIO_API_MODE`.
Flags: `--base-url`, `--model`, `--api-mode`.

El modo chat maneja mensajes textuales y function tool calls. El modo Responses conserva
los items opacos del proveedor, incluido razonamiento cifrado para continuación con `store:false`.
Un proveedor compatible puede implementar solo una parte de OpenAI; valide su modelo y endpoint.
No se han probado todas las plataformas comerciales ni una llamada facturable real.

## Configuración y confianza

`alisio init` crea `.alisio/config.json` con valores de ejemplo, sin secretos.
La configuración del proyecto se carga **solo** con `--trust-project` o mediante
`--config ruta`. Esto impide que abrir un repositorio redirija automáticamente
su clave API a un endpoint definido por ese repositorio.

Sin esas opciones se lee `~/.config/alisio/config.json` (o XDG_CONFIG_HOME).
`ALISIO_CONFIG_HOME` permite seleccionar otro directorio global.
Las sesiones se guardan en `~/.local/state/alisio/sessions.sqlite` (o XDG_STATE_HOME).
`ALISIO_STATE_HOME` y `--db` permiten cambiar esa ubicación.
La base de datos contiene conversación y resultados: no la suba al repositorio.

Capacidades de ejecución:

- Lectura y búsqueda disponibles inicialmente.
- `--allow-write`: edición y escritura de archivos.
- `--allow-process`: procesos y shell arbitrarios.
- `--allow-mcp`: iniciar/conectar servidores configurados y usar sus capacidades.
- `--allow-agents`: comunicación con agentes vecinos en Herdr.
- `--read-only`: desactiva escritura, procesos arbitrarios, MCP, mensajería y plugins ejecutables.

Los plugins globales son código personal confiable. Los plugins de proyecto requieren
`--trust-project`; `--plugin ruta` confía explícitamente en esa entrada y sus dependencias.
No se instala código ni se descargan plugins automáticamente.

## CLI

```sh
pnpm dev                                 # TUI interactiva (si stdin/stdout son una terminal)
pnpm dev --no-tui                        # Modo interactivo readline sencillo
pnpm dev --disable-plugin memory         # Sin el plugin integrado de memoria
pnpm dev run "Revisa el código" --json    # Eventos JSONL; diagnósticos en stderr
pnpm dev sessions list
pnpm dev resume SESSION_ID "Continúa"
pnpm dev context explain src/application.ts
pnpm dev skills list
pnpm dev skills validate ./fixtures/skills
pnpm dev plugins list
pnpm dev plugins doctor --plugin ./examples/hello-plugin.ts
pnpm dev mcp list --config ./my-api.json
pnpm dev mcp doctor my-server --config ./my-api.json --allow-mcp
```

`resume SESSION_ID` sin prompt abre la TUI con esa sesión; con prompt sigue siendo headless.
Si se indica `--model` al reanudar, la sesión cambia a ese modelo para los turnos siguientes.

En el modo `--no-tui`: `/exit`, `/new`, `/skill:nombre solicitud`, `/command example.hello:hello`.
Las líneas se procesan secuencialmente. Ctrl+C cancela y cierra. Después puede usar `resume`.

## Interfaz de terminal (TUI)

Sin subcomando, y con stdin/stdout conectados a una terminal, Alisio abre una TUI construida
con [`@earendil-works/pi-tui`](https://www.npmjs.com/package/@earendil-works/pi-tui)
(sucesor del paquete `@mariozechner/pi-tui`, ya deprecado). Acepta los mismos flags
globales (`--config`, `--model`, `--allow-write`, `--allow-process`, `--read-only`, etc.).
`run`, `resume … "prompt"` y `--json` no cambian. Use `--no-tui` para el modo readline.

La pantalla se reorganiza al redimensionar la terminal y trunca o ajusta cada línea al ancho:

- **Cabecera**: versión, modelo, host del proveedor (nunca la clave ni la ruta), modo de API,
  directorio de trabajo abreviado, sesión corta y permisos con color
  (`write`/`process`: `on`, `ask` u `off`; `mcp`; `read-only`).
- **Conversación**: mensajes del usuario resaltados; respuesta en streaming con Markdown
  (títulos, negritas, listas, código en línea y en bloque, enlaces). Si el proveedor envía
  razonamiento visible (por ejemplo `reasoning_content` de DeepSeek) se muestra atenuado
  mientras llega y luego se colapsa en una línea. No se persiste ni se reenvía.
- **Herramientas**: un bloque por llamada con nombre, argumento resumido (ruta, comando,
  patrón), spinner mientras corre, estado ✓/✗, duración y vista previa truncada. Para
  `edit_file`/`write_file` se muestra un diff `+`/`-` calculado a partir de los argumentos.
- **Barra de estado**: contexto usado frente a la ventana, `usado / total (pct%)`, con barra
  verde (<60 %), amarilla (<85 %) o roja; tokens acumulados de entrada/salida y en caché
  (`⚡`) si el proveedor los informa; turnos; duración del turno en curso; estado.
- Los errores aparecen en rojo dentro de la conversación sin cerrar la TUI.

Origen de la ventana de contexto: `provider.contextWindow` → campo `context_window`
(o `context_length`) de `GET /models` → `unknown`. El contexto usado es el último
`prompt + completion` informado por el proveedor; si no hay `usage`, se muestra una
estimación marcada con `~` (≈4 caracteres por token).

Comandos (con autocompletado al escribir `/`):

| Comando | Función |
| --- | --- |
| `/help` | Comandos y atajos |
| `/model [id]` | Sin argumento: lista seleccionable de `GET /models` (o el modelo configurado). Con argumento: cambia directamente. Aplica al siguiente turno y queda guardado en la sesión |
| `/compact [foco]` | Resume la historia antigua con el modelo actual, con instrucciones de foco opcionales |
| `/stats` | Tokens (entrada, salida, caché), turnos, llamadas por herramienta y errores, duración, modelos y contexto |
| `/clear` (`/new`) | Inicia una sesión nueva con el modelo actual |
| `/sessions` | Sesiones recientes del workspace |
| `/resume <id>` | Reanuda por ID o prefijo; sin argumento muestra un selector |
| `/tools` | Herramientas y su estado según permisos (`enabled`, `ask`, `disabled`) |
| `/copy` | Copia la última respuesta del asistente al portapapeles |
| `/memory …` | Comando del plugin de memoria (ver más abajo); otros comandos de plugins también aparecen aquí |
| `/exit` (`/quit`) | Salir |
| `/skill:nombre solicitud` | Carga una skill y envía la solicitud |
| `/command plugin.id:nombre args` | Ejecuta un comando de plugin |

Teclas: Enter envía; Shift+Enter, Alt+Enter o Ctrl+J insertan una línea (según la terminal);
Tab autocompleta; ↑/↓ recorren el historial; Esc interrumpe el turno en curso; Ctrl+C borra
la entrada, interrumpe si hay un turno activo y, pulsado dos veces con la entrada vacía, sale;
Ctrl+D sale con la entrada vacía; PgUp/PgDn o la rueda del ratón desplazan la conversación.

Copiar al seleccionar: la TUI captura el ratón; al arrastrar se selecciona texto y se copia
al portapapeles con la primera herramienta disponible (`wl-copy`, `xclip -selection
clipboard`, `xsel -b`, `pbcopy`, `clip.exe` o PowerShell `Set-Clipboard`), sin shell. Si
ninguna funciona se envía OSC 52 y se avisa de que no puede verificarse. Con la captura del
ratón activa, la selección nativa de la terminal suele requerir Shift+arrastrar.
La TUI usa la pantalla alternativa; al salir imprime la conversación y el ID de sesión.

Aprobaciones: en la TUI, si `write` o `process` no están permitidos con flags, las
herramientas correspondientes se ofrecen al modelo y, antes de ejecutarlas, se pregunta:
permitir una vez, permitir ese efecto durante la sesión o denegar. Con `--read-only` no se
pregunta y siguen desactivadas. Los modos headless no preguntan nunca. El tiempo de espera
de la aprobación cuenta dentro de `limits.timeoutMs`.

## Compactación de contexto

La compactación reemplaza los mensajes antiguos por un checkpoint estructurado generado por
el proveedor actual (Goal, User instructions/constraints, Discoveries, Accomplished, Current
state, Next steps, Relevant files; se pide JSON validado con zod y, si no es válido, se usa
el texto tal cual) y conserva intactos los turnos recientes. Los plugins pueden ampliarla
con los hooks de compactación (por ejemplo, la memoria). Nunca separa una llamada a herramienta de
sus resultados ni altera IDs de llamada. Los mensajes reemplazados quedan en la base de
datos marcados como compactados (auditoría), pero ya no se envían al modelo.

```json
{
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2 }
}
```

- Manual con `/compact [foco]`.
- Automática antes de una llamada al modelo cuando el contexto supera `threshold` de una
  ventana conocida, o cuando se excede `limits.maxContextChars`. Con ventana desconocida
  solo aplica el límite de caracteres. `auto: false` la desactiva.
- `keepTurns` turnos recientes se conservan; si hay menos, se conserva al menos el último.
  Dentro de un único turno largo se corta en el último límite seguro entre llamadas.
- En modo Responses, los items opacos de continuación (por ejemplo razonamiento cifrado)
  del tramo resumido se descartan junto con esos mensajes; los mensajes conservados
  mantienen los suyos sin cambios.
- Eventos: `compaction_started`, `compaction_completed` (con estimaciones `before`/`after`,
  tamaño del tramo resumido y del checkpoint, e informes de plugins), `compaction_skipped`,
  `compaction_failed` y `plugin_hook_failed`.

Si una caída deja una herramienta con resultado incierto, Alisio no la repite automáticamente.
Inspeccione sus efectos y después:

```sh
pnpm dev sessions recover SESSION_ID --acknowledge
```

La recuperación registra la incertidumbre como resultado; no asegura que un efecto externo
se haya completado ni deshace cambios.

## Plugins

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "my.hello",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Saluda al usuario.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("¡Ajá!");
      },
    });
  },
});
```

```sh
pnpm dev --plugin ./examples/hello-plugin.ts
```

`@alisio/sdk` es un paquete local del workspace, todavía no publicado. Un plugin dentro
del checkout lo resuelve mediante pnpm. Para un plugin externo, instale el paquete SDK
local como dependencia, o exporte directamente el objeto sin importar `definePlugin`;
es una función de identidad. Sus dependencias deben estar instaladas junto al plugin.

También se admiten directorios con `alisio-plugin.json`:

```json
{"apiVersion":1,"entry":"./index.ts"}
```

La API pública incluye herramientas, comandos, eventos, proveedores de contexto, rutas de
skills y almacenamiento con namespace. Los nombres de herramientas se transforman a un
namespace con hash, para evitar colisiones y cumplir restricciones del proveedor.
La activación revierte registros parciales si falla. `dispose()` libera recursos al cerrar.
Los plugins tienen permisos del proceso completo; un campo `effect` no los aísla.

El registro de rutas `resources.prompts()` está reservado para una extensión posterior;
el renderizado de plantillas no forma parte de esta alpha.

### Puntos de extensión (autores de plugins)

Se añadieron de forma aditiva a `PluginAPI` manteniendo `apiVersion: 1`: los plugins
existentes siguen funcionando sin cambios y no existe todavía un host publicado sin estos
miembros. Todos los hooks se ejecutan con un timeout impuesto por el host
(`pluginHooks.timeoutMs`, `pluginHooks.sessionEndTimeoutMs`) y reciben un `AbortSignal`;
un fallo o timeout se registra como evento `plugin_hook_failed` y el núcleo continúa sin
ese plugin.

| Miembro | Uso |
| --- | --- |
| `compaction.register({ beforeCompact, afterCompact })` | Antes: añadir instrucciones y campos JSON extra (`outputFields`) a la misma llamada del resumidor. Después: recibir el checkpoint, los campos extraídos propios y devolver `injectContext` (texto añadido tras el checkpoint) y un `report` (`summary` se muestra en la TUI) |
| `session.onStart(handler)` | Texto inyectado una vez al comenzar una sesión vacía (persistido en la sesión) |
| `session.onEnd(handler)` | Al terminar una sesión interactiva (`/clear`, `/exit`, salida) |
| `model.complete({ system, messages, maxTokens, model, signal })` | Completado de texto agnóstico del proveedor; los plugins no importan SDKs de proveedores |
| `ui.status(key, text, detail?)` | Texto breve en la barra de estado; `detail` aparece en `/stats` |
| `commands.register(name, handler, { description, argumentHint })` | La TUI enruta `/nombre` a comandos de plugin y los lista en `/help` y el autocompletado |

```ts
export default definePlugin({
  id: "my.notes",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.compaction.register({
      async beforeCompact() {
        return { outputFields: { notes: "array of short strings worth keeping" } };
      },
      async afterCompact({ extracted }) {
        const notes = Array.isArray(extracted.notes) ? extracted.notes : [];
        return { report: { summary: `notes: ${notes.length}` } };
      },
    });
  },
});
```

Los plugins externos mantienen el prefijo `p_<hash>_` en herramientas y `id:nombre` en
comandos, y no pueden declarar el efecto `internal` (se degrada a `external`).

### Plugins integrados

Los plugins de primera parte viven en `src/plugins/builtin/` y se registran en
`src/plugins/builtin/index.ts`. Se activan por una ruta de confianza del host (nombres sin
prefijo, efecto `internal` permitido), también con `--read-only`, sin `--trust-project`.
Se configuran en `builtinPlugins.<id>` y se desactivan con `enabled: false` o con
`--disable-plugin <id>`. Para añadir otro, agregue una entrada al registro.

## Memoria persistente (plugin integrado `memory`)

Memoria de estilo [Engram](https://engram.gentlemanprogramming.com): observaciones con
título, tipo (`decision`, `bugfix`, `discovery`, `pattern`, `architecture`, `config`,
`preference`, `learning`), cuerpo **What / Why / Where / Learned**, proyecto, alcance
(`project` o `personal`) y `topic_key` opcional (`familia/descripcion`, kebab-case).

- Almacenamiento: SQLite + FTS5 (tokenizador trigram, ranking BM25 combinado con recencia y
  accesos). Sin embeddings ni red. Base por usuario en `<estado>/memory.sqlite`
  (`ALISIO_STATE_HOME`/XDG), independiente de `--db`, para que la memoria sobreviva entre
  sesiones, ejecuciones y proyectos (`personal`). El proyecto se identifica como
  `<nombre>-<hash8>` del realpath de la raíz git o del cwd.
- Mismo `topic_key` en el mismo proyecto y alcance actualiza la fila (`revision_count`);
  duplicados exactos en 15 minutos incrementan `duplicate_count`. Borrado lógico por
  defecto. `<private>…</private>` se guarda como `[REDACTED]`. Contenido limitado a 50 000
  caracteres.
- Herramientas para el modelo: `memory_save`, `memory_search` (filas compactas; AND por
  defecto, `match: "any"` y `all_projects`), `memory_get`, `memory_context`,
  `memory_timeline`, `memory_pin`, `memory_forget`. Solo escriben en la base de memoria de
  Alisio, nunca en el workspace, por eso siguen disponibles con `--read-only`.
- Protocolo en el prompt de sistema: guardar decisiones, bugfixes, descubrimientos,
  convenciones, configuración y preferencias; recuperar con contexto → búsqueda → detalle.
- Sesión nueva: inyecta un bloque `memory_context` (resumen de la última sesión, prompts
  recientes, fijadas y observaciones recientes) dentro de `injectBudgetTokens`.
- Compactación: en la misma llamada al modelo se extraen observaciones del tramo descartado
  (con upsert/dedup), el checkpoint se archiva como resumen de sesión con resultado
  `confirmed`/`failed`/`unknown`, y se añaden memorias relevantes (con ids) dentro del
  presupuesto. Si el JSON es inválido, el checkpoint queda en texto y no se extrae nada.
- Al cerrar (`/clear`, `/exit`, salida de la TUI) con actividad, escribe un resumen con
  Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant Files.
- TUI: `/memory` (recientes), `/memory <consulta>`, `/memory show|forget|pin|unpin <id>`;
  contador `mem N` en la barra de estado; detalle en `/stats`.

```json
{
  "builtinPlugins": {
    "memory": {
      "enabled": true,
      "dbPath": "./memory.sqlite",
      "injectBudgetTokens": 1500,
      "recallLimit": 8,
      "autoSummary": true,
      "defaultScope": "project"
    }
  },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000 }
}
```

`dbPath` relativo se resuelve desde el archivo de configuración. Desactivada
(`enabled: false` o `--disable-plugin memory`) no hay herramientas, prompt, hooks ni archivo
de base de datos, y la compactación funciona en modo genérico.

## AGENTS.md y skills

En cada directorio se usa el primer archivo disponible en este orden: `AGENTS.md`,
`AGENT.md`, `Agente.md`. Se recomienda el nombre estándar `AGENTS.md`.

Alisio resuelve AGENTS.md desde la raíz Git (o el directorio de trabajo si no hay Git)
hasta la ruta operada. Las instrucciones nuevas se presentan al modelo antes de ejecutar
una operación que necesite reconsideración. Los alcances se etiquetan por directorio.

Skills: `.agents/skills/<nombre>/SKILL.md`, `~/.agents/skills/`, rutas de configuración
y recursos de plugins. Solo nombre y descripción se incluyen inicialmente. El cuerpo se
carga con `skill_load` o `/skill:nombre`; archivos de apoyo se leen con `skill_resource`.
Se validan YAML, nombre, descripción y coincidencia entre nombre y directorio.

Por ahora no se importa automáticamente `.pi/skills`.
Las raíces configuradas permiten reutilizar una carpeta de skills existente.

## Herramientas incluidas

`read_file`, `list_files`, `search_text`, `write_file`, `edit_file`, `run_process`,
`shell`, `git_status`, `git_diff`, `skill_load`, `skill_search`, `skill_resource`,
`context_explain`.

Las ediciones exigen una huella SHA-256 y una coincidencia exacta única. Las escrituras
usan temporal + reemplazo en el mismo filesystem. Las operaciones mediadas rechazan
rutas externas y symlinks. Esto no protege frente a procesos hostiles que cambien rutas
concurrentemente, ni confina una shell libre.

Los archivos editables y el escaneo inicial de lectura tienen un límite de 1 MiB; las
salidas de herramientas se acotan. Un resultado truncado se indica explícitamente.
Las lecturas declaradas independientes se ejecutan en lotes de hasta cuatro; las
operaciones con efectos se serializan.

## MCP

Configure servidores sin secretos literales:

```json
{
  "mcp": {
    "servers": {
      "my-server": {
        "transport": "stdio",
        "command": "node",
        "args": ["./mcp/server.js"],
        "envAllow": ["MY_SERVER_TOKEN"]
      },
      "remote": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnv": "MY_MCP_TOKEN"
      }
    }
  }
}
```

Rutas `./` y `../` de argumentos stdio se resuelven respecto al archivo de configuración.
El transporte HTTP es Streamable HTTP. `mcp_connect` conecta bajo demanda y registra las
herramientas; `mcp_resource` y `mcp_prompt` permiten listar y consultar recursos/prompts.
Las herramientas expuestas deben tener esquemas soportados por el registro. Cambios de
esquema exigen reiniciar para refrescar; no se ejecuta una llamada con un esquema obsoleto.
No hay OAuth interactivo ni reintentos automáticos de operaciones con efectos.

## Herdr

Dentro de un panel Herdr, los reportes de ciclo de vida se activan con sus variables
`HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_BIN_PATH` y `HERDR_SOCKET_PATH`.
Se reporta `custom:alisio`, estado y sesión, y se libera esa autoridad al salir.
Use `--no-herdr` para desactivar reportes.

Ejecute Alisio dentro del panel:

```sh
/path/to/alisio --config /path/to/my-api.json --allow-agents
```

Herramientas disponibles: `herdr_agents`, `herdr_prompt`, `herdr_read`, `herdr_wait`.
Use IDs de panel o nombres únicos de agentes. Alisio envía argumentos como arrays,
sin interpolar el mensaje en una shell, y no reintenta mensajes ambiguos.

Alisio es una integración custom: no use `herdr agent start --kind alisio`, porque
Herdr 0.9.1 no incluye ese kind. Inícielo en un panel existente o con `herdr pane run`.
El restablecimiento automático de sesiones por Herdr requiere soporte adicional en Herdr;
esta entrega permite reanudar manualmente con `alisio resume`.

Ver [docs/herdr.md](docs/herdr.md) para el contrato y los límites de validación.

## Desarrollo y verificación

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:compiled
pnpm bench
```

Las pruebas Vitest lanzan Bun para los módulos exclusivos de Bun. Hay pruebas HTTP locales
para ambos modos del proveedor y servidores MCP reales de prueba sobre stdio y HTTP.
`test:compiled` usa el binario construido y un servidor compatible simulado; no consume API.
La lógica de presentación de la TUI (`apps/cli/src/tui/state.ts`), el planificador y el
checkpoint de compactación (`src/core/compaction.ts`), los formateadores de memoria y el
adaptador de portapapeles (con un spawner falso) tienen pruebas Vitest directas.

`pnpm bench` mide únicamente el arranque caliente de `--help`, no velocidad del agente completo.

Estructura: `packages/sdk` (contratos), `src/core` (motor), `src/runtime` (Bun/SQLite),
`src/resources`, `src/tools`, `src/plugins`, `src/providers`, `src/mcp`,
`src/integrations/herdr.ts`, `src/plugins/builtin` (plugins integrados, p. ej. `memory`),
`apps/cli` (con `apps/cli/src/tui`).

La distribución actual es código fuente. El build se comprobó en Linux x64.
Vea [docs/implementation-status.md](docs/implementation-status.md) para pendientes reales.
