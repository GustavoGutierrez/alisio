# Configuración

## Selección global del proveedor

En la TUI, `/connect` escribe los perfiles no secretos y el proveedor/modelo activo en
`<config home>/providers.json`. Los secretos se guardan por separado en
`<config home>/credentials.json`, escrito atómicamente con modo `0600`; el directorio usa `0700`
donde se admiten permisos POSIX. Es protección del sistema de archivos, **no cifrado**. Las claves
nunca aparecen en `doctor`, el inicio, los eventos ni el estado de plugins.

Los `values` de un perfil pueden incluir un `contextWindow` opcional (en **tokens**) para el modelo
de ese perfil. Existe para servidores locales compatibles con OpenAI (por ejemplo llama.cpp) cuyo
`GET /models` omite `context_window`: con él, la barra de contexto y la compactación automática usan
la ventana real en lugar de un honesto `?`. `/connect` lo pregunta cuando el catálogo descubierto no
informa la ventana del modelo seleccionado. La ventana efectiva de un modelo es, por prioridad: el
`provider.contextWindow` heredado (solo para el modelo configurado), luego el
`values.contextWindow` del perfil activo (intención del usuario: prevalece sobre el catálogo) y
luego el `context_window` del propio catálogo.

Cada conexión también recuerda el nombre de la variable de entorno de su clave de API: los `values`
del perfil guardan `apiKeyEnv` (el nombre que elegiste para esa conexión). Cuando un proveedor
necesita una clave, la precedencia es: primero la credencial guardada en `credentials.json`, luego
`process.env[apiKeyEnv]` usando el **nombre recordado en el perfil** y, solo si el perfil no lo
registra, el nombre por defecto del plugin (por ejemplo `DEEPSEEK_API_KEY` para el plugin DeepSeek,
`OPENAI_API_KEY` para el compatible con OpenAI). Como el nombre se persiste con el perfil, el
respaldo por entorno sigue funcionando aunque luego se elimine la credencial guardada. No interviene
ningún almacén de secretos nuevo: el nombre de la variable de entorno es un valor de configuración
no secreto, y las claves solo se leen del archivo de credenciales o de esa variable de entorno.

`/model` y `/models` abren el mismo selector global. Agrupa por título de proveedor todos los
perfiles creados mediante `/connect`, marca la pareja proveedor/modelo activa y mantiene disponibles
los perfiles sanos si falla otro catálogo. Elegir una pareja distinta la persiste e inicia una sesión
nueva; elegir la pareja activa no hace nada. La configuración raíz `provider` heredada se conserva
para compatibilidad de inicio y modos headless, pero no aparece en este selector.

Los selectores usan `proveedor/modelo` como forma canónica, por ejemplo
`deepseek/deepseek-chat`. Un ID sin proveedor solo se acepta cuando coincide exactamente con un
perfil configurado mediante `/connect`. Cero coincidencias falla con opciones disponibles; varias
fallan por ambigüedad. La pareja global activa es el valor por defecto de las sesiones nuevas, no
estado mutable compartido: un hijo o reemplazo programático queda vinculado sin modificar al padre.

Los integradores pueden usar `app.listAvailableModels()`, `app.resolveModel(reference)`,
`app.createSession(reference?)` y `app.switchModel(reference)`. Solo participan en la resolución
cruzada los perfiles globales de `/connect`; la configuración raíz heredada `provider` sigue siendo
compatibilidad de arranque/headless. Los metadatos y errores nunca exponen credenciales.

La configuración raíz `provider`, las variables de entorno y los flags heredados siguen admitidos y
no se reescriben. `AppOptions.provider` tiene máxima prioridad. Después, una anulación explícita del
endpoint (`--base-url`, `--api-mode`, `OPENAI_BASE_URL`, `ALISIO_API_MODE`) o una capa de proyecto de
confianza/explícita que defina un `provider` en la raíz utilizable — su `provider.model` analizado no
está vacío y no es el marcador `YOUR_MODEL_ID` que escribe `alisio setup` — selecciona el proveedor
heredado compatible con OpenAI para esa ejecución; un modelo vacío o marcador nunca anula una
selección de `/connect`. Los ajustes de MCP, plugins, skills u otros campos por sí solos no lo hacen.
En caso contrario se restaura el perfil activo de `/connect`; `--model` o `ALISIO_MODEL` solo pueden
reemplazar su modelo. El `provider` heredado global es el respaldo cuando no existe un perfil
guardado, por lo que no anula de forma permanente una selección de `/connect`.
Los modos headless nunca preguntan.

Hay cuatro proveedores integrados y activados por defecto:

| Proveedor | Alcance |
| --- | --- |
| DeepSeek | Descubre modelos desde `https://api.deepseek.com`; admite Chat Completions y Responses. `/connect` también muestra una URL base opcional, etiquetada para proxies compatibles con DeepSeek. |
| OpenCode Console (Zen) | Descubre entradas `opencode/<id-del-modelo>` desde `https://opencode.ai/zen/v1/models`. Los modelos documentados GPT/Grok/Muse usan Responses; DeepSeek/GLM/Kimi/MiMo/MiniMax y los compatibles documentados usan Chat Completions; Claude y los Qwen documentados usan Anthropic Messages. Se ocultan Gemini nativo y System One. |
| OpenCode Go | Descubre entradas `opencode-go/<id-del-modelo>` desde `https://opencode.ai/zen/go/v1/models`. Su mapa independiente envía GPT/Grok/Muse a Responses, familias abiertas compatibles a Chat Completions y MiniMax/Qwen a Anthropic Messages. |
| Compatible con OpenAI | Endpoint genérico y configurable de Chat Completions o Responses. |

Las peticiones de modelos de OpenCode Console y Go envían `user-agent: alisio/<versión>` y un identificador opaco y
estable de conversación `x-opencode-session`. Ninguna cabecera contiene rutas, prompts ni credenciales.
Sus catálogos no requieren autenticación. Ambos fallan de forma cerrada: ocultan cualquier entrada
ausente del mapa de protocolos documentado, en lugar de adivinar su endpoint.

Alisio combina la configuración global con una capa seleccionada y valida cada archivo de forma
estricta (se rechazan las claves desconocidas). La precedencia se describe en
[Servidores MCP](#servidores-mcp) y el
[modelo de confianza de la configuración](/es/quick-start#configuration-trust-model).

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "YOUR_MODEL_ID",
    "apiMode": "chat",
    "auth": "bearer",
    "tokenParameter": "max_tokens",
    "streamUsage": false
  },
  "limits": { "maxTurns": 20, "timeoutMs": 300000 },
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2, "maxOutputTokens": 16000 },
  "builtinPlugins": { "memory": { "enabled": true } },
  "pluginHooks": { "timeoutMs": 15000, "sessionEndTimeoutMs": 10000 },
  "plugins": [],
  "skills": [],
  "mcp": { "servers": {} }
}
```

`schemaVersion` debe ser `1` (el valor por defecto).

## `provider`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `baseURL` | `https://api.openai.com/v1` | URL base, incluyendo `/v1` cuando el servidor lo requiera. Solo HTTP(S), sin credenciales en la URL |
| `apiKeyEnv` | `OPENAI_API_KEY` | Nombre de la variable de entorno que contiene la clave |
| `model` | `""` | Identificador exacto del modelo en su servidor (obligatorio para ejecutar) |
| `apiMode` | `chat` | `chat` (Chat Completions) o `responses` (API Responses) |
| `auth` | `bearer` | `bearer` o `none`; `none` omite la cabecera `Authorization` |
| `tokenParameter` | `max_tokens` | Solo en modo chat: `max_tokens`, `max_completion_tokens` u `omit` |
| `streamUsage` | `false` | Solicitar estadísticas de uso durante el streaming, si el servidor lo soporta |
| `contextWindow` | ninguno | Ventana de contexto opcional en tokens para el modelo configurado; tiene prioridad sobre `GET /models` |

El modo chat maneja mensajes de texto y function tool calls. El modo Responses conserva los items
opacos del proveedor, incluido el razonamiento cifrado para continuación con `store: false`. Un
proveedor compatible puede implementar solo una parte de la API de OpenAI: valide su modelo y endpoint.

Dentro de la configuración heredada del proveedor, la precedencia es archivo global → archivo de
proyecto de confianza o explícito → variables de entorno → flags de la CLI. La precedencia de
selección anterior determina cuándo se usa esa configuración en lugar del perfil activo de
`/connect`.

## `limits`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `maxTurns` | `20` | Turnos del modelo por ejecución (1–100). Cada turno es una respuesta del modelo; una ejecución que solo llama a herramientas muchas veces puede agotarlos |
| `timeoutMs` | `300000` | Tiempo límite de la ejecución en milisegundos (mínimo 100); incluye las esperas de aprobación |
| `maxContextChars` | `160000` | Límite de longitud del contexto en caracteres. Actúa como **disparador de compactación por defecto (fallback)** cuando la ventana del modelo es desconocida (o absurdamente grande; ver [compactación](/es/configuration#compaction)) — tokens estimados (`~caracteres/4`) que alcanzan `maxContextChars / 4` — y como **límite duro** que debe caber tras una compactación |
| `maxOutputTokens` | `4096` | Tokens de salida por petición. Cuando un modelo alcanza este presupuesto a mitad de respuesta, Alisio conserva el texto producido, avisa de que la respuesta se cortó (`response cut by max output tokens`), completa la ejecución con normalidad y marca la finalización como `truncated` en `run_completed`. Las llamadas a herramientas totalmente escritas siguen ejecutándose. Aumente este presupuesto para respuestas más largas |
| `maxTokens` | proporcional | Presupuesto acumulado opcional de tokens informados por ejecución. Por defecto: 8 × la ventana de contexto del modelo, acotado a 400000–8000000; 1000000 cuando la ventana es desconocida |

## `compaction`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `auto` | `true` | Compactar automáticamente antes de una llamada al modelo |
| `threshold` | `0.85` | Fracción (0.1–0.99) de una ventana de contexto conocida que activa la compactación |
| `keepTurns` | `2` | Turnos recientes conservados sin cambios (0–20) |
| `maxOutputTokens` | `16000` | Presupuesto de tokens de salida para la llamada del resumidor. Independiente de `limits.maxOutputTokens` y nunca recurre a él. Si el presupuesto corta el resumen, el checkpoint se conserva como **parcial** (la interfaz lo indica); si no se produjo nada aprovechable, la compactación falla y pide que aumente este valor |

La compactación automática usa **un único presupuesto efectivo**. Cuando la ventana de contexto del
modelo es conocida, se dispara cuando el contexto usado alcanza `threshold` (por defecto `0.85`) de
esa ventana; el presupuesto fijo `limits.maxContextChars` queda entonces solo como límite duro
posterior a la compactación. Cuando la ventana es desconocida — o absurdamente grande (las ventanas
declaradas por encima de `2_000_000` tokens se tratan como desconocidas para que un
`ventana × threshold` gigantesco no oculte la presión real) — se recurre al presupuesto de
caracteres: la estimación de caracteres en bruto (`~caracteres / 4`, unos 4 caracteres por token)
que alcanza `maxContextChars / 4` también compacta (un informe de tokens del proveedor nunca
dispara el respaldo por sí solo). La barra de contexto de la TUI muestra la misma ventana conocida,
o un honesto `?` cuando es desconocida (ver [Interfaz de terminal](/es/tui)); el respaldo de
caracteres anterior es una salvaguarda del motor, nunca un total mostrado.

Consulte [Compactación de contexto](/es/compaction).

## `websearch`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `provider` | ninguno (SearXNG público) | `"searxng"`, `"duckduckgo-instant"`, `"tavily"`, `"brave"`, `"serpapi"` o `"native"` — véase [Herramientas y permisos](/es/tools#websearch) |
| `searxngUrl` | una instancia pública | Instancia SearXNG autoalojada u otra pública; los valores que no sean loopback deben usar `https://` |
| `apiKeyEnv` | `<PROVIDER>_API_KEY` | Variable de entorno con la clave para `tavily`/`brave`/`serpapi` |
| `nativeToolType` | `web_search` | Solo para `provider: "native"`: el tipo de herramienta nativa del proveedor enviado al modelo |

## `context`

```json
{ "context": { "claudeMdFallback": false, "maxBytes": 32768 } }
```

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `claudeMdFallback` | `false` | Usar `CLAUDE.md` en directorios sin archivo `AGENTS` |
| `maxBytes` | `32768` | Bytes totales de contenido `AGENTS.md` inyectado (1024–1048576); se conservan los archivos más cercanos |

Consulte [Contexto: AGENTS.md y skills](/es/context).

## `builtinPlugins`

Opciones de los plugins integrados, indexadas por ID de plugin. Cada entrada acepta `enabled`; cada
plugin valida el resto de su sección. Los plugins integrados son `deepseek`, `opencode`, `opencode-go`,
`openai-compatible`, `memory` y `subagents`; las
opciones de `subagents` se detallan en [Subagentes](/es/subagents#limits). Opciones de `memory`:

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `builtinPlugins.memory.enabled` | `true` | Activa el plugin de memoria |
| `builtinPlugins.memory.dbPath` | `<state home>/memory.sqlite` | Ruta de la base de datos; las rutas relativas se resuelven desde el archivo de configuración |
| `builtinPlugins.memory.injectBudgetTokens` | `1500` | Presupuesto de tokens (100–20000) para el contexto de memoria inyectado |
| `builtinPlugins.memory.recallLimit` | `8` | Memorias recuperadas tras la compactación (0–20) |
| `builtinPlugins.memory.autoSummary` | `true` | Escribe un resumen de sesión con `/clear`, `/exit` o al salir (TUI) |
| `builtinPlugins.memory.defaultScope` | `project` | `project` o `personal` |

Consulte [Memoria persistente](/es/memory).

## `pluginHooks`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `timeoutMs` | `15000` | Tiempo límite (100–120000 ms) de los hooks de compactación y de inicio de sesión |
| `sessionEndTimeoutMs` | `10000` | Tiempo límite (100–120000 ms) de los hooks de fin de sesión |

## `plugins`

Lista de plugins de confianza: rutas (resueltas respecto al archivo de configuración) o nombres de
paquetes npm. Consulte [Escribir plugins](/es/plugins#loading-plugins).

```json
{ "plugins": ["alisio-plugin-foo", "./plugins/local.js"] }
```

Los paquetes instalados con `alisio install` aterrizan en el directorio global de plugins
(`<config home>/plugins`, mediante `npm install --prefix`) y sus nombres npm se añaden
automáticamente al array `plugins` de la configuración GLOBAL — consulte
[Instalar plugins desde npm](/es/plugins#installing-plugins-from-npm). Nunca se escriben entradas de
ruta que apunten al paquete instalado; los nombres npm siguen siendo portables.
`pluginOverrides` de abajo puede desactivar un paquete instalado del proyecto en cada proyecto igual
que cualquier otro plugin externo.

`/plugins` guarda por separado las anulaciones externas del proyecto, indexadas por el ID estable
del plugin:

```json
{ "pluginOverrides": { "acme.hello": { "enabled": false } } }
```

Los cambios de plugins integrados usan el campo existente `builtinPlugins.<id>.enabled`. Ambas
formas se aplican tras reiniciar. No modifican los perfiles globales de proveedores ni el almacén
separado de credenciales.

## `skills`

Raíces adicionales de Agent Skills, resueltas respecto al archivo de configuración.

```json
{ "skills": ["./skills"] }
```

También se buscan las raíces de proyecto (`.agents/skills`, `.alisio/skills`, `.claude/skills`, solo
en proyectos de confianza), las raíces de usuario y las skills de plugins. Consulte
[Contexto: AGENTS.md y skills](/es/context#skills).

`/skills` escribe las decisiones de activación locales del proyecto sin cambiar las raíces:

```json
{ "skillOverrides": { "review": { "enabled": false } } }
```

Las anulaciones se aplican a la skill efectiva del proyecto actual. Las skills propiedad de plugins
están bloqueadas y siguen el ciclo de vida de su plugin.

## Plantillas de prompts

No hay una clave de configuración para las plantillas. Se leen de `<config home>/prompts/` y, en
proyectos de confianza, de `.alisio/prompts/`. Consulte [Plantillas de prompts](/es/prompt-templates).

## Servidores MCP

Alisio siempre lee `<ALISIO_CONFIG_HOME>/config.json` (por defecto
`~/.config/alisio/config.json`). La configuración de un proyecto de confianza se superpone desde
`<workspace>/.alisio/config.json`. Un `--config <archivo>` explícito y de confianza se superpone a la
configuración global y reemplaza la capa del proyecto. Un archivo de proyecto sin confianza nunca se
lee. Los ajustes superiores de la capa seleccionada reemplazan los globales; las listas ejecutables
de plugins y skills no se concatenan. Los servidores MCP son la excepción definida: se combinan por
nombre y gana la capa seleccionada. Las rutas relativas se resuelven respecto al archivo que las
definió.

La forma canónica es `mcp.servers`, indexada por nombre. `transport` puede ser explícito o inferirse
de `command`/`url`.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `transport` | inferido | `stdio` o `http` (Streamable HTTP) |
| `enabled` | `true` | Estado configurado persistido que gestiona `/mcp`; no concede permiso de ejecución ni significa conectado |
| `command` | ninguno | stdio: ejecutable |
| `args` | `[]` | stdio: argumentos; `./` y `../` se resuelven respecto al archivo de configuración |
| `url` | ninguno | http: URL del servidor |
| `envAllow` | `[]` | Variables de entorno que se pasan al servidor stdio |
| `env` | `{}` | Valores literales que se pasan solo a este subproceso; prevalecen sobre el mismo nombre de `envAllow` |
| `bearerTokenEnv` | ninguno | Variable de entorno que contiene un token bearer HTTP |

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
      "local-no-secreto": {
        "command": "./bin/local-mcp",
        "env": { "LOG_LEVEL": "info" }
      },
      "remoto-publico": {
        "url": "https://example.com/public-mcp"
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

También se acepta la forma común superior `mcpServers`. Infiere `stdio` si existe `command` y `http`
si existe `url`:

```json
{
  "mcpServers": {
    "devforge": {
      "command": "/ruta/a/devforge-mcp",
      "args": [],
      "env": { "DEV_FORGE_CONFIG": "/ruta/a/devforge/config.json" }
    }
  }
}
```

No defina el mismo nombre en `mcp.servers` y `mcpServers` dentro de un archivo. Se validan de forma
estricta nombres, transportes, URL, comandos, argumentos y valores de entorno. Los diagnósticos nunca
muestran esos valores. Los valores directos de `env` se pasan solo a ese subproceso y prevalecen
sobre una variable del mismo nombre reenviada con `envAllow`; úselos para opciones no secretas o
rutas locales protegidas. Los secretos HTTP no pueden escribirse literalmente:
`bearerTokenEnv` nombra la variable de entorno que contiene el token. Un servidor configurado
permanece desconectado hasta que se solicita. La TUI interactiva puede conceder acceso MCP de
proceso/red para la sesión actual de la aplicación tras una confirmación clara; ese permiso no se
guarda en la configuración. Los modos no TUI y los consumidores programáticos aún requieren
`--allow-mcp` o `allowMcp`; `--read-only` siempre prohíbe MCP. Un servidor stdio es un
subproceso con sus privilegios de usuario, **no un sandbox**. Confíe únicamente en la configuración y
el ejecutable que use. Consulte [Herramientas y permisos](/es/tools#mcp).

### Consentimiento global (`mcp.allow`)

Defina `"mcp": { "allow": true }` en **su configuración de usuario**
(`<config home>/config.json`, por defecto `~/.config/alisio/config.json`) para conceder
consentimiento de proceso/red MCP **entre sesiones para este usuario**: cada inicio de Alisio (TUI
interactiva y headless) comienza con el permiso de ejecución MCP ya concedido, la cabecera muestra
`mcp:on`, y cada servidor marcado como `enabled` se conecta automáticamente, igual que pulsar
**Conectar** en cada uno. Esto evita la pregunta por sesión en cada reinicio.

```json
{
  "mcp": {
    "allow": true,
    "servers": {
      "devforge": { "command": "/ruta/a/devforge-mcp" }
    }
  }
}
```

- `mcp.allow` se **lee solo de la capa global/de usuario**; un valor en `.alisio/config.json` de un
  proyecto se ignora deliberadamente, para que un proyecto no pueda concederse consentimiento de red.
- Ausente o `false` mantiene el comportamiento actual: el permiso no está concedido al iniciar, la TUI
  puede concederlo por sesión, y los usos headless/programáticos siguen exigiendo `--allow-mcp`
  (que continúa funcionando como concesión explícita por ejecución, equivalente a `mcp.allow: true`
  en esa ejecución).
- `--read-only` siempre bloquea MCP por completo, independientemente de `mcp.allow`; ni siquiera se
  ofrece.
- Concederlo persiste entre sesiones y auto-conecta los servidores activados. Los servidores MCP
  se ejecutan sin sandbox con sus privilegios de usuario: active el consentimiento global solo si
  confía en cada servidor que configure.
- El gestor `/mcp` de la TUI puede definirlo (Conceder y recordar) y revocarlo; consulte
  [Interfaz de terminal](/es/tui#mcp).

## Variables de entorno

| Variable | Función |
| --- | --- |
| `OPENAI_API_KEY` (o el nombre indicado en `provider.apiKeyEnv`) | Clave de API |
| `OPENAI_BASE_URL` | Reemplaza `provider.baseURL` |
| `ALISIO_MODEL` | Reemplaza `provider.model` |
| `ALISIO_API_MODE` | Reemplaza `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Directorio de configuración global (por defecto `$XDG_CONFIG_HOME/alisio` o `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | Directorio de estado para `sessions.sqlite`, `memory.sqlite` y `trust.json` (por defecto `$XDG_STATE_HOME/alisio` o `~/.local/state/alisio`) |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Directorios base XDG estándar, usados cuando las variables `ALISIO_*` no están definidas |
| `CI` | Si está definida (y no vale `false` ni `0`), no se muestra la pantalla de inicio |
| `NO_COLOR` | Desactiva el color en la pantalla de inicio |
| `TERM=dumb` | Pantalla de inicio en ASCII sin color |
| `HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH` | Definidas por Herdr; activan los reportes de ciclo de vida |

La base de datos de sesiones contiene conversaciones y resultados de herramientas: no la suba al
repositorio.

## Flags de la CLI

Flags globales (válidos para todos los comandos):

| Flag | Descripción |
| --- | --- |
| `--cwd <path>` | Directorio de trabajo |
| `--config <path>` | Archivo de configuración de confianza explícita |
| `--trust-project` | Carga la configuración y los plugins ejecutables del proyecto (todos los privilegios del proceso) |
| `--plugin <path...>` | Carga plugins de confianza explícita (rutas o nombres de paquete) |
| `--model <id>` | ID del modelo del proveedor |
| `--base-url <url>` | URL base de la API compatible con OpenAI, incluyendo `/v1` si hace falta |
| `--api-mode <mode>` | `chat` o `responses` |
| `--allow-write` | Permite escribir archivos |
| `--allow-process` | Permite subprocesos arbitrarios; sin sandbox |
| `--allow-external` | Permite herramientas de red: `webfetch`, `websearch` y la búsqueda nativa del proveedor |
| `--allow-mcp` | Permite los servidores MCP configurados y las llamadas a herramientas remotas |
| `--allow-agents` | Permite enviar mensajes a agentes vecinos mediante Herdr |
| `--no-herdr` | Desactiva los reportes automáticos de ciclo de vida a Herdr |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, herramientas de red, plugins ejecutables y MCP |
| `--db <path>` | Base de datos de sesiones |
| `--json` | Emite eventos JSONL versionados |
| `--no-tui` | Usa el modo interactivo readline sencillo en lugar de la TUI |
| `--disable-plugin <ids...>` | Desactiva plugins integrados (`memory`, `subagents`) |
| `--agents <json>` | Definiciones adicionales de subagentes en JSON: `{"name":{"description":"...","prompt":"..."}}` |
| `--no-banner` | No muestra la pantalla de inicio |
| `--quiet` | Suprime la salida no esencial (pantalla de inicio, sugerencias) |
| `-V`, `--version` | Muestra la versión |
| `-h`, `--help` | Muestra la ayuda |

Comandos:

| Comando | Descripción |
| --- | --- |
| `alisio` | TUI interactiva (o readline con `--no-tui`) |
| `alisio run <prompt>` | Ejecución headless; `/name args` ejecuta una [plantilla de prompt](/es/prompt-templates) |
| `alisio resume <session> [prompt]` | Reanuda una sesión (TUI sin prompt, headless con prompt) |
| `alisio setup` | Escribe un `.alisio/config.json` de ejemplo sin secretos (para `AGENTS.md`, use `/init`) |
| `alisio doctor` | Diagnóstico del entorno y del proveedor; avisa cuando no hay modelo configurado |
| `alisio trust list` | Lista los directorios con una decisión de confianza guardada |
| `alisio trust revoke <path>` | Olvida la decisión de confianza de un directorio (vuelve a preguntar la próxima vez) |
| `alisio sessions list` | Lista las sesiones |
| `alisio sessions recover <session> --acknowledge` | Reconoce efectos inciertos de herramientas tras una caída |
| `alisio context explain <path>` | Muestra qué archivos `AGENTS.md` se aplican a una ruta |
| `alisio skills list [path]` | Lista las skills descubiertas |
| `alisio skills validate [path]` | Valida skills (código de salida distinto de cero si hay diagnósticos) |
| `alisio plugins list` | Lista los plugins globales, de proyecto y explícitos |
| `alisio plugins doctor` | Carga los plugins y muestra sus herramientas y comandos |
| `alisio mcp list` | Lista los servidores MCP configurados |
| `alisio mcp doctor <server>` | Se conecta a un servidor (requiere `--allow-mcp`) |

## `AGENTS.md`

Los archivos de instrucciones (`AGENTS.override.md`, `AGENTS.md`, el heredado `AGENT.md` y,
opcionalmente, `CLAUDE.md`) se describen en [Contexto: AGENTS.md y skills](/es/context#agents-md).
