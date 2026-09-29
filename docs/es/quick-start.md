# Inicio rápido

Alisio incluye activado el plugin de proveedor compatible con OpenAI, pero no un modelo ni
credenciales predeterminados. Inicie la TUI y ejecute `/connect`: elija el proveedor, introduzca sus
ajustes y clave, y seleccione un modelo descubierto. La selección se aplica globalmente en inicios
posteriores.

## Ruta rápida (60 segundos)

1. `alisio setup` — escriba un `.alisio/config.json` de ejemplo, sin secretos.
2. Exporte la variable de la clave que indique ese archivo (paso 2 más abajo).
3. `alisio doctor --config ./my-api.json` — confirme runtime, herramientas y proveedor.
4. `alisio --config ./my-api.json` — abra la TUI y ejecute `/connect` para elegir proveedor y modelo.

Cada paso se detalla a continuación; [Interfaz de terminal](/es/tui) cubre la TUI.

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

DeepSeek (`deepseek.json`, tras instalar el plugin DeepSeek con
`alisio install npm:@alisio/plugin-deepseek`):

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
configuración del proveedor, incluido si la variable de la clave está definida. Si falta ripgrep,
también imprime los comandos de instalación por plataforma (lo usan `search_text`/`list_files`).
Nunca muestra la clave.

## 4. Ejecutar

```sh
# TUI interactiva: las herramientas de escritura/proceso/red se ofrecen y preguntan antes de cada llamada
alisio --config ./my-api.json

# Headless, read-only: las herramientas de escritura/proceso/red ni siquiera se ofrecen
alisio run "Explain this repository" --config ./my-api.json --read-only

# Headless con eventos JSONL versionados en stdout (los diagnósticos van a stderr)
alisio run "Review the code" --config ./my-api.json --json

# Omitir la pregunta y permitir ediciones (y procesos, si hace falta) directamente
alisio run "Implement the task in docs/task.md" --config ./my-api.json --allow-write
```

Las herramientas de escritura/proceso/red de la TUI **preguntan siempre por defecto** —permitir una
vez, permitir durante la sesión o denegar— sin necesitar ningún flag.
`--allow-write`/`--allow-process`/`--allow-external` omiten esa pregunta y permiten directamente;
`--read-only` las desactiva por completo, sin ofrecerlas nunca al modelo. Los modos headless
`run`/`resume <id> "prompt"`/`--json` no tienen a nadie a quien preguntar, así que ahí esos mismos
flags significan que la herramienta simplemente no está disponible sin ellos. `--allow-process` (o
una respuesta de "permitir" a la pregunta) da acceso a procesos arbitrarios con sus privilegios de
usuario; no es un sandbox. Consulte [Herramientas y permisos](/es/tools#permission-flags) para la
tabla de verdad completa.

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
| `<workspace>/.alisio/config.json` | Con `--trust-project`, o tras confiar en él interactivamente (véase abajo) |
| `~/.config/alisio/config.json` (`ALISIO_CONFIG_HOME` o `XDG_CONFIG_HOME`) | En los demás casos |

Confiar en un proyecto también carga sus plugins ejecutables desde `.alisio/plugins` (todos los
privilegios del proceso), y sus agentes/skills/prompts desde `.alisio/agents`, `.agents/agents`,
`.alisio/skills` y `.alisio/prompts`.

**Confianza interactiva de una sola vez.** Al iniciar la TUI (no en modo headless `run`/`--json`,
que siguen exigiendo `--trust-project`/`--config` explícitamente — ahí no hay nadie a quien
preguntar) en un directorio con alguno de esos recursos de proyecto, sin `--trust-project`/
`--config`, se pregunta una vez:

```
This directory has Alisio project configuration: /path/to/repo
Trusting it lets Alisio load that configuration for this and future runs — including a possibly
different provider endpoint or API key — plus its plugins, agents, skills and prompt templates.
Declining uses Alisio's own defaults instead; nothing here is read.
Trust this project's Alisio configuration? [y/N]
```

La decisión se recuerda por directorio (`alisio trust list`/`alisio trust revoke <path>` la
inspeccionan o la deshacen) junto con un hash del contenido de `.alisio/config.json`, así que editar
ese archivo —incluso después de haber confiado una vez— vuelve a preguntar en lugar de mantener en
silencio la confianza anterior. Un directorio sin ningún recurso de proyecto nunca recibe la
pregunta. `--trust-project`/`--config` siguen siendo confianza explícita de una sola ejecución, como
antes, y nunca se escriben en este almacén.

Siguiente: [Interfaz de terminal](/es/tui) · [Plantillas de prompts](/es/prompt-templates) · [Configuración](/es/configuration).
