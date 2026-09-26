# Herramientas y permisos

Cada herramienta declara un **efecto**. El efecto decide si la herramienta está disponible, pide
aprobación o está desactivada.

| Efecto | Significado | Por defecto |
| --- | --- | --- |
| `read` | Sin efectos secundarios | Activada |
| `write` | Modifica archivos del workspace | Requiere `--allow-write` (o aprobación en la TUI) |
| `process` | Ejecuta procesos arbitrarios | Requiere `--allow-process` (o aprobación en la TUI) |
| `external` | Herramientas de MCP, Herdr y plugins externos | Activada solo cuando MCP, agentes o plugins externos están activos, y nunca con `--read-only` |
| `internal` | Escribe solo estado propio de Alisio (nunca el workspace ni la red) | Siempre permitida; solo se respeta en plugins integrados |

Las operaciones desconocidas o de plugins usan `external` por defecto. `/tools` en la TUI muestra el
estado actual de cada herramienta (`enabled`, `ask`, `disabled`).

## Herramientas incluidas

| Herramienta | Efecto | Función |
| --- | --- | --- |
| `read_file` | `read` | Leer un archivo de texto |
| `list_files` | `read` | Listar archivos |
| `search_text` | `read` | Buscar con ripgrep |
| `git_status` | `read` | `git status --porcelain=v1` |
| `git_diff` | `read` | `git diff --no-ext-diff --no-textconv` |
| `skill_load`, `skill_search`, `skill_resource` | `read` | Catálogo, activación y recursos de Agent Skills |
| `context_explain` | `read` | Explicar qué alcances de `AGENTS.md` se aplican a una ruta |
| `write_file` | `write` | Escribir un archivo |
| `edit_file` | `write` | Reemplazar una coincidencia exacta y única en un archivo |
| `run_process` | `process` | Ejecutar un comando con un array de argumentos |
| `shell` | `process` | Ejecutar un comando de shell |

Las ediciones exigen una huella SHA-256 del archivo y una coincidencia exacta y única. Las escrituras
usan un archivo temporal más un reemplazo atómico en el mismo filesystem. Las operaciones mediadas
rechazan rutas fuera del workspace y symlinks; esto no protege frente a procesos hostiles que cambien
rutas concurrentemente, ni confina una shell libre.

Los archivos editables y el escaneo inicial de lectura están limitados a 1 MiB; las salidas de
herramientas se acotan y un resultado truncado se indica explícitamente. Las lecturas independientes
se ejecutan en lotes de hasta cuatro; las operaciones con efectos se serializan.

## Flags de permisos

| Flag | Efecto |
| --- | --- |
| (ninguno) | Solo herramientas de lectura y búsqueda |
| `--allow-write` | Activa `write_file` y `edit_file` |
| `--allow-process` | Activa `run_process` y `shell` |
| `--allow-mcp` | Inicia/conecta los servidores MCP configurados y expone sus capacidades |
| `--allow-agents` | Activa las herramientas de mensajería de Herdr |
| `--read-only` | Desactiva escrituras, procesos arbitrarios, MCP, mensajería entre agentes y plugins ejecutables (externos) |

`--read-only` prevalece sobre cualquier flag `--allow-*`. Los plugins integrados (por ejemplo
`memory`) siguen activos con `--read-only` porque sus herramientas solo usan el efecto `internal`;
use `--disable-plugin memory` para un modo estrictamente sin escrituras.

## Aprobación interactiva

En la TUI, las herramientas `write` y `process` no permitidas mediante flags se ofrecen al modelo y
Alisio pregunta antes de ejecutar cada llamada: permitir una vez, permitir ese efecto durante la
sesión o denegar. Los modos headless (`run`, `resume <id> "prompt"`, `--json`) nunca preguntan.
Consulte [Interfaz de terminal](/es/tui#interactive-approvals).

## No es un sandbox

::: danger
Alisio **no** ofrece un sandbox del sistema operativo. `--allow-process` da al modelo procesos
arbitrarios con sus privilegios de usuario. Los plugins se ejecutan en el mismo proceso con todos los
privilegios; ni un manifiesto de plugin ni un subproceso son una frontera de aislamiento, y el campo
`effect` no aísla nada.
:::

## MCP

Los servidores MCP se configuran en [`mcp.servers`](/es/configuration#mcp-servers) y solo se inician
o contactan con `--allow-mcp` (y nunca con `--read-only`).

- `mcp_connect` conecta bajo demanda y registra las herramientas del servidor; `mcp_resource` y
  `mcp_prompt` permiten listar y consultar recursos y prompts.
- Las herramientas expuestas deben usar esquemas soportados por el registro. Los cambios de esquema
  exigen reiniciar; nunca se ejecuta una llamada con un esquema obsoleto.
- No hay OAuth interactivo ni reintentos automáticos de operaciones con efectos.

```sh
alisio mcp list --config ./my-api.json
alisio mcp doctor my-server --config ./my-api.json --allow-mcp
```

## Herdr

Dentro de un panel de [Herdr](https://github.com/GustavoGutierrez/alisio/blob/main/docs/herdr.md),
los reportes de ciclo de vida se activan con las variables de Herdr (`HERDR_ENV=1`, `HERDR_PANE_ID`,
`HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`). Alisio reporta `custom:alisio`, su estado y su sesión, y
libera esa autoridad al salir. `--no-herdr` desactiva los reportes.

```sh
alisio --config /path/to/my-api.json --allow-agents
```

Con `--allow-agents`, el modelo obtiene `herdr_agents`, `herdr_prompt`, `herdr_read` y `herdr_wait`.
Use IDs de panel o nombres únicos de agentes. Los argumentos se envían como arrays, nunca se
interpolan en una shell, y los mensajes ambiguos no se reintentan.

Alisio es una integración custom: no use `herdr agent start --kind alisio` (Herdr 0.9.1 no incluye
ese kind). Inícielo en un panel existente o con `herdr pane run`, y reanude manualmente con
`alisio resume`.
