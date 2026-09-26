# Configuración

Alisio lee un único archivo JSON, validado de forma estricta (se rechazan las claves desconocidas).
Qué archivo se lee se describe en el
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
  "compaction": { "auto": true, "threshold": 0.85, "keepTurns": 2 },
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

Precedencia del proveedor: archivo seleccionado → variables de entorno → flags de la CLI.

## `limits`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `maxTurns` | `20` | Turnos del modelo por ejecución (1–100) |
| `timeoutMs` | `300000` | Tiempo límite de la ejecución en milisegundos (mínimo 100); incluye las esperas de aprobación |
| `maxContextChars` | `160000` | Límite de longitud del contexto en caracteres; también activa la compactación |
| `maxOutputTokens` | `4096` | Tokens de salida por petición |
| `maxTokens` | `100000` | Presupuesto de tokens informados por ejecución |

## `compaction`

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `auto` | `true` | Compactar automáticamente antes de una llamada al modelo |
| `threshold` | `0.85` | Fracción (0.1–0.99) de una ventana de contexto conocida que activa la compactación |
| `keepTurns` | `2` | Turnos recientes conservados sin cambios (0–20) |

Consulte [Compactación de contexto](/es/compaction).

## `builtinPlugins`

Opciones de los plugins integrados, indexadas por ID de plugin. Cada entrada acepta `enabled`; cada
plugin valida el resto de su sección. Hoy el único plugin integrado es `memory`:

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

## `skills`

Raíces adicionales de Agent Skills, resueltas respecto al archivo de configuración.

```json
{ "skills": ["./skills"] }
```

Las skills también se descubren en `.agents/skills/<name>/SKILL.md` (desde el directorio de trabajo
hasta la raíz del workspace), en `~/.agents/skills/` y en los recursos de plugins. Inicialmente solo
se incluyen el nombre y la descripción; el cuerpo se carga con la herramienta `skill_load` o con
`/skill:name`, y los archivos de apoyo con `skill_resource`. Se validan el YAML, el nombre, la
descripción y la coincidencia entre nombre y directorio (`alisio skills validate`). `.pi/skills` no
se importa automáticamente.

## `mcp.servers`

Servidores MCP, indexados por nombre. Nunca escriba secretos literales: indique nombres de variables
de entorno.

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `transport` | obligatorio | `stdio` o `http` (Streamable HTTP) |
| `command` | ninguno | stdio: ejecutable |
| `args` | `[]` | stdio: argumentos; `./` y `../` se resuelven respecto al archivo de configuración |
| `url` | ninguno | http: URL del servidor |
| `envAllow` | `[]` | Variables de entorno que se pasan al servidor stdio |
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
      "remote": {
        "transport": "http",
        "url": "https://example.com/mcp",
        "bearerTokenEnv": "MY_MCP_TOKEN"
      }
    }
  }
}
```

Los servidores MCP solo se inician o contactan con `--allow-mcp`. Consulte
[Herramientas y permisos](/es/tools#mcp).

## Variables de entorno

| Variable | Función |
| --- | --- |
| `OPENAI_API_KEY` (o el nombre indicado en `provider.apiKeyEnv`) | Clave de API |
| `OPENAI_BASE_URL` | Reemplaza `provider.baseURL` |
| `ALISIO_MODEL` | Reemplaza `provider.model` |
| `ALISIO_API_MODE` | Reemplaza `provider.apiMode` |
| `ALISIO_CONFIG_HOME` | Directorio de configuración global (por defecto `$XDG_CONFIG_HOME/alisio` o `~/.config/alisio`) |
| `ALISIO_STATE_HOME` | Directorio de estado para `sessions.sqlite` y `memory.sqlite` (por defecto `$XDG_STATE_HOME/alisio` o `~/.local/state/alisio`) |
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
| `--allow-mcp` | Permite los servidores MCP configurados y las llamadas a herramientas remotas |
| `--allow-agents` | Permite enviar mensajes a agentes vecinos mediante Herdr |
| `--no-herdr` | Desactiva los reportes automáticos de ciclo de vida a Herdr |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, plugins ejecutables y MCP |
| `--db <path>` | Base de datos de sesiones |
| `--json` | Emite eventos JSONL versionados |
| `--no-tui` | Usa el modo interactivo readline sencillo en lugar de la TUI |
| `--disable-plugin <ids...>` | Desactiva plugins integrados (por ejemplo `memory`) |
| `--no-banner` | No muestra la pantalla de inicio |
| `--quiet` | Suprime la salida no esencial (pantalla de inicio, sugerencias) |
| `-V`, `--version` | Muestra la versión |
| `-h`, `--help` | Muestra la ayuda |

Comandos:

| Comando | Descripción |
| --- | --- |
| `alisio` | TUI interactiva (o readline con `--no-tui`) |
| `alisio run <prompt>` | Ejecución headless |
| `alisio resume <session> [prompt]` | Reanuda una sesión (TUI sin prompt, headless con prompt) |
| `alisio init` | Escribe un `.alisio/config.json` de ejemplo sin secretos |
| `alisio doctor` | Diagnóstico del entorno y del proveedor |
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

En cada directorio se usa el primer archivo disponible, en este orden: `AGENTS.md`, `AGENT.md`,
`Agente.md`. Alisio los resuelve desde la raíz Git (o el directorio de trabajo si no hay Git) hasta la
ruta sobre la que se opera. Las instrucciones nuevas se presentan al modelo antes de una operación
que necesite reconsideración, y los alcances se etiquetan por directorio.
`alisio context explain <path>` muestra el resultado.
