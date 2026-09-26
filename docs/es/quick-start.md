# Inicio rápido

Alisio no incluye un modelo predeterminado ni credenciales. Configure un endpoint y un modelo antes de
ejecutar tareas. El modelo debe soportar streaming y tool calling en el protocolo seleccionado.

## 1. Crear un archivo de configuración

`alisio setup` escribe un `.alisio/config.json` de ejemplo en el directorio actual, sin secretos.
También puede escribir el archivo usted mismo en cualquier ubicación.

```sh
alisio setup
```

Endpoint compatible con OpenAI (`my-api.json`):

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.openai.com/v1",
    "apiKeyEnv": "OPENAI_API_KEY",
    "model": "YOUR_MODEL_ID",
    "apiMode": "chat",
    "auth": "bearer",
    "tokenParameter": "max_completion_tokens",
    "streamUsage": true
  }
}
```

DeepSeek (`deepseek.json`):

```json
{
  "schemaVersion": 1,
  "provider": {
    "baseURL": "https://api.deepseek.com/v1",
    "apiKeyEnv": "DEEPSEEK_API_KEY",
    "model": "deepseek-chat",
    "apiMode": "chat",
    "tokenParameter": "max_tokens",
    "streamUsage": true
  }
}
```

Un servidor local sin autenticación usa `"auth": "none"` y su propia `baseURL`, por ejemplo
`http://127.0.0.1:1234/v1`. Todos los campos se describen en [Configuración](/es/configuration).

## 2. Proporcionar la clave de API mediante el entorno

Las claves se leen **solo** de la variable de entorno indicada en `provider.apiKeyEnv`
(por defecto `OPENAI_API_KEY`). Nunca escriba claves en archivos de configuración.

```sh
export OPENAI_API_KEY='YOUR_KEY'
```

PowerShell:

```powershell
$env:OPENAI_API_KEY = 'YOUR_KEY'
```

## 3. Comprobar la instalación

```sh
alisio doctor --config ./my-api.json
```

`doctor` muestra la versión, el runtime, la plataforma, el workspace, las rutas de Git y ripgrep, y la
configuración del proveedor, incluido si la variable de la clave está definida. Nunca muestra la clave.

## 4. Ejecutar

```sh
# Interactive terminal UI
alisio --config ./my-api.json

# Headless, read-only
alisio run "Explain this repository" --config ./my-api.json --read-only

# Headless with versioned JSONL events on stdout (diagnostics go to stderr)
alisio run "Review the code" --config ./my-api.json --json

# Allow edits (and processes, if needed)
alisio run "Implement the task in docs/task.md" --config ./my-api.json --allow-write
```

`--allow-process` da acceso a procesos arbitrarios con sus privilegios de usuario; no es un sandbox.
Consulte [Herramientas y permisos](/es/tools).

## 5. Sesiones

Las sesiones se guardan en SQLite y pueden reanudarse.

```sh
alisio sessions list
alisio resume <id>                 # opens the TUI with that session
alisio resume <id> "Continue"      # headless turn in that session
alisio sessions recover <id> --acknowledge
```

Indicar `--model` al reanudar cambia la sesión a ese modelo para los turnos siguientes.
`sessions recover` solo es necesario cuando una caída dejó una herramienta con resultado incierto;
consulte [Compactación de contexto](/es/compaction#uncertain-tool-results).

## 6. Generar AGENTS.md

Ejecute la plantilla integrada `/init` en la TUI, o en modo headless, para crear o actualizar el
`AGENTS.md` raíz con instrucciones específicas del proyecto para agentes de programación:

```sh
alisio run "/init" --config ./my-api.json --allow-write
```

Consulte [Plantillas de prompts](/es/prompt-templates#built-in-init).

## Modelo de confianza de la configuración {#configuration-trust-model}

Abrir un repositorio no debe redirigir su clave de API a un endpoint elegido por ese repositorio. Por
eso Alisio lee:

| Origen | Cuándo |
| --- | --- |
| `--config <path>` | Siempre que se indique: un archivo de confianza explícita |
| `<workspace>/.alisio/config.json` | Solo con `--trust-project` |
| `~/.config/alisio/config.json` (`ALISIO_CONFIG_HOME` o `XDG_CONFIG_HOME`) | En los demás casos |

`--trust-project` también carga los plugins ejecutables del proyecto desde `.alisio/plugins`, que se
ejecutan con todos los privilegios del proceso. Úselo solo en repositorios de confianza.

Siguiente: [Interfaz de terminal](/es/tui) · [Plantillas de prompts](/es/prompt-templates) · [Configuración](/es/configuration).
