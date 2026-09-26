# Subagentes

`subagents` es un plugin integrado (paquete `@alisio/plugin-subagents`). Con él, el modelo puede
delegar trabajo en agentes especializados. Cada agente se ejecuta en su propia sesión hija, con
contexto nuevo y permisos reducidos. Los agentes pueden ejecutarse en paralelo, en primer o en
segundo plano, y la TUI los muestra en un árbol en vivo. Está activado por defecto; desactívelo con
`--disable-plugin subagents` o `"builtinPlugins": { "subagents": { "enabled": false } }`.

## Agentes integrados

| Agente | Herramientas | Función |
| --- | --- | --- |
| `general` | `*` (todas las herramientas del padre, incluida la delegación) | Tareas de varios pasos: investigación, cambios de código y verificación |
| `explore` | Lectura, listado, búsqueda, Git, `context_explain` y herramientas de skills; solo lectura | Exploración rápida del código con rutas citadas |
| `plan` | Lectura, listado, búsqueda, Git y `context_explain`; solo lectura | Plan de implementación ordenado con archivos y riesgos; nunca edita |

## Definir agentes

Un agente es un archivo Markdown con frontmatter YAML; el cuerpo es el prompt de sistema del agente.

```md
---
name: test-writer
description: Writes focused unit tests for a given module and runs them.
tools: [read_file, list_files, search_text, write_file, edit_file, run_process]
model: inherit
maxTurns: 30
color: green
permission:
  edit: allow
  bash: ask
skills: [testing-conventions]
---
You write small, behavior-focused tests. Read the module first, follow the existing test
style, run only the affected tests and report what you added and the results.
```

| Campo | Descripción |
| --- | --- |
| `name` | Obligatorio (por defecto, el nombre del archivo): letras minúsculas, dígitos y guiones simples, hasta 64 caracteres |
| `description` | Obligatorio. Se muestra al modelo en la herramienta `task`, así que indique cuándo usar el agente |
| `tools` | Lista de herramientas permitidas; `*` significa todas las herramientas del padre, incluida la delegación |
| `disallowedTools` | Herramientas que se retiran al agente |
| `model` | Un selector configurado `proveedor/modelo` (recomendado), un ID sin proveedor que sea único, o `inherit` (por defecto). Los alias de Claude `sonnet`, `opus` y `haiku` heredan el modelo del padre con una advertencia |
| `mode` | `subagent` (por defecto), `primary` o `all`. Los agentes `primary` no pueden usarse mediante `task` |
| `maxTurns` | Límite de turnos (alias `steps`, `maxSteps`); por defecto `builtinPlugins.subagents.maxTurns` |
| `color` | Color en el árbol de agentes |
| `permission` | `edit`/`write` y `bash`/`process`: `allow`, `ask` o `deny`. Los mapas de patrones (opencode) pasan a `ask` |
| `hidden` | Oculta el agente de la lista de la herramienta `task` |
| `background` | Iniciar en segundo plano por defecto |
| `skills` | Skills que se indica al agente cargar con `skill_load` antes de empezar (no se preinyectan) |
| `readOnly` | Ejecutar en solo lectura |

Las claves desconocidas se ignoran con una advertencia (`/agents defs` muestra las advertencias). Por
compatibilidad, los nombres de herramientas de Claude Code como `tools: Read, Grep, Glob, Bash` se
asignan a herramientas de Alisio (`read_file`, `search_text`, `list_files`, `shell`/`run_process`, …),
y `tools: { bash: false }` de opencode se traduce en `disallowedTools`.

También se pueden pasar agentes adicionales en la línea de comandos como JSON (`description`,
`prompt`, y opcionalmente `tools` y `model`):

```sh
alisio --agents '{"reviewer":{"description":"Reviews diffs for bugs","prompt":"Review the change and list correctness bugs.","tools":["read_file","search_text","git_diff"]}}'
```

## Descubrimiento y precedencia {#discovery-and-precedence}

Gana la primera definición con un nombre dado; las ocultadas se informan en `/agents defs`.

| Orden | Origen | Ubicación | Estado |
| --- | --- | --- | --- |
| 1 | CLI | `--agents <json>` | Alisio |
| 2 | Proyecto | `.alisio/agents/` | Formato de Alisio |
| 3 | Convención | `.agents/agents/` | Convención especulativa, todavía sin adopción relevante |
| 4 | Compatibilidad | `.claude/agents/`, `.opencode/agent/`, `.opencode/agents/` | Leídos con compatibilidad con Claude Code y opencode |
| 5 | Usuario | `<config home>/agents/`, `~/.claude/agents/`, `~/.config/opencode/agent/`, `~/.config/opencode/agents/` | Definiciones personales |
| 6 | Plugins | Directorios registrados con `api.resources.agents(dir)` | Con espacio de nombres `plugin:name` |
| 7 | Integrados | `general`, `explore`, `plan` | Siempre disponibles |

Los orígenes de proyecto (2–4) solo se leen en proyectos de confianza: `--trust-project` o un
`--config` explícito. No existe un estándar común entre herramientas para las definiciones de
agentes; los lectores de compatibilidad cubren los formatos habituales de Claude Code y opencode.

## Herramientas de delegación

| Herramienta | Entrada | Comportamiento |
| --- | --- | --- |
| `task` | `description`, `prompt`, `subagent_type`, y opcionalmente `model`, `task_id`, `background` | Inicia un agente (o continúa `task_id` con todo su historial) y devuelve su informe final. `model` reemplaza la definición solo para ese hijo. Varias llamadas `task` en un mismo turno se ejecutan en paralelo |
| `task_status` | `task_id` | Estado, agente, indicador de segundo plano y tokens; no espera |
| `task_wait` | `task_id`, opcionalmente `timeout_ms` | Espera un resultado, acotado por `waitMaxMs`; devuelve el estado si vence el tiempo |
| `send_message` | `task_id`, `text` | Mensaje unidireccional: se encola para el siguiente turno de un hijo en ejecución, o reanuda en segundo plano un hijo terminado |

Los resultados se envuelven en un elemento `<task id="…" agent="…" state="…">` con la cabecera
`Subagent output (non-authoritative; verify important claims before relying on them)` y se limitan a
`resultMaxBytes` (50 KB por defecto). Los fallos son errores estructurados de la herramienta que
incluyen el `task_id`, de modo que la tarea puede reanudarse.

Las tareas en segundo plano (`background: true`, el campo `background` o Ctrl+B en la TUI) regresan
de inmediato. Cuando terminan, se inyecta una `<task-notification>` en el siguiente turno del padre.
Si el padre está inactivo, se entrega junto con su próximo mensaje.

No hay bloqueos mutuos: un agente solo puede dirigirse a sus propios descendientes, nunca a sí mismo
ni a un ancestro, y todas las esperas están acotadas.

Los selectores de agente y `task.model` usan el mismo resolvedor que `/model`. Un destino no
disponible falla antes de llamar al modelo. Un ID sin proveedor ambiguo muestra alternativas seguras
`proveedor/modelo`; nunca hay selección aleatoria. El hijo obtiene su propia vinculación de
proveedor/sesión y continuación opaca, sin modificar al padre ni al valor global por defecto.

## Límites {#limits}

Se configuran en `builtinPlugins.subagents`:

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Activa el plugin |
| `maxDepth` | `3` | Anidamiento máximo; los agentes en el límite no reciben la herramienta `task` |
| `maxConcurrentPerParent` | `4` | Hijos en ejecución por padre (1–32) |
| `maxConcurrentTotal` | `8` | Hijos en ejecución en total (1–64) |
| `maxQueued` | `16` | Tareas en espera por encima de los límites de concurrencia; las siguientes fallan de inmediato (0–256) |
| `maxTurns` | `50` | Límite de turnos por defecto por hijo (1–500) |
| `timeoutMs` | `600000` | Tiempo límite por ejecución de un hijo (mínimo 1000) |
| `maxTokensPerChild` | presupuesto del núcleo | Presupuesto acumulado de tokens por hijo; por defecto, el presupuesto proporcional del núcleo |
| `parallelWrites` | `ask` | `ask`, `worktree`, `serial` o `shared` (ver más abajo) |
| `waitMaxMs` | `600000` | Cota superior de `task_wait` (mínimo 100) |
| `resultMaxBytes` | `50000` | Tamaño máximo del resultado (1000–1000000) |
| `agents` | `{}` | Agentes como con `--agents` (`description`, `prompt`, `tools`, `model`) |
| `worktreeDir` | `<state home>/worktrees` | Dónde se crean los worktrees; las rutas relativas se resuelven desde el archivo de configuración |

```json
{
  "builtinPlugins": {
    "subagents": { "maxDepth": 2, "maxConcurrentPerParent": 3, "parallelWrites": "worktree" }
  }
}
```

## Permisos

Los hijos nunca superan a su padre:

- Un padre de solo lectura (o `--read-only`) hace que todos sus descendientes sean de solo lectura;
  las herramientas denegadas siguen denegadas.
- `permission` y `readOnly` en una definición solo pueden restringir más. `ask` significa la
  aprobación por llamada de la TUI.
- Las aprobaciones que piden los hijos suben hasta la TUI, etiquetadas con la ruta del agente.

## Cancelación y recuperación

- Abortar un padre aborta todos sus descendientes en ejecución. Los procesos de las herramientas
  reciben SIGTERM y, tras un margen de 5 s, SIGKILL.
- Los hijos cancelados conservan su sesión y pueden reanudarse pasando su `task_id` a `task`, o con
  `/agents resume <id>`.
- Al arrancar, los hijos que estaban en ejecución o en cola se marcan como `interrupted`; nunca se
  reinician automáticamente.

## Escrituras en paralelo y git

Cuando dos o más hijos con capacidad de escritura se ejecutarían a la vez, `parallelWrites` decide
cómo se aíslan sus cambios. Con `ask`, Alisio pregunta una vez por sesión:

| Modo | Comportamiento |
| --- | --- |
| `worktree` | Cada escritor obtiene un worktree de git en `<state home>/worktrees/<id>` en la rama `alisio/<id>`, creada desde `HEAD`. Su resultado informa la rama, los archivos modificados y el diffstat. Los worktrees sin cambios se eliminan automáticamente |
| `serial` | Los escritores toman un bloqueo de escritura y se ejecutan de uno en uno; las lecturas siguen en paralelo |
| `shared` | Todos los escritores comparten el directorio de trabajo, bajo su propio riesgo |

- `/agents merge <id>` ejecuta `git merge --no-ff` de la rama. Requiere un árbol de trabajo limpio.
  Si hay conflictos, el merge se aborta, el repositorio queda sin cambios y se listan los archivos
  en conflicto. `/agents discard <id>` elimina el worktree y la rama.
- Con `ask` y sin terminal interactiva (headless), se usa `serial` y se añade una nota al resultado.
- Fuera de un repositorio git solo están disponibles `serial` y `shared`.
- Si el árbol de trabajo principal tiene cambios sin confirmar, los resultados con worktree incluyen
  una advertencia, porque el worktree no los contiene.

## En la TUI {#in-the-tui}

El panel del árbol de agentes está bajo el editor. Muestra cuántos agentes están en ejecución, en
cola y terminados y, para cada agente: un icono de estado, su nombre y color, el tiempo transcurrido,
sus tokens y un resumen en vivo de una línea. La sangría muestra padre → hijo. Consulte
[Interfaz de terminal](/es/tui#agent-panel) para las teclas.

| Comando | Función |
| --- | --- |
| `/agents` | Lista las tareas de subagentes de la sesión |
| `/agents open <id>` | Abre la conversación de una tarea en una vista de solo lectura |
| `/agents cancel <id>`, `/agents kill <id>` | Cancela una tarea y sus descendientes |
| `/agents resume <id> [message]` | Reanuda en segundo plano una tarea terminada o cancelada |
| `/agents merge <id>` | Fusiona la rama del worktree de una tarea (`--no-ff`) y elimina el worktree |
| `/agents discard <id>` | Elimina el worktree y la rama de una tarea |
| `/agents defs` | Lista las definiciones de agentes, sus orígenes y advertencias |

Los IDs admiten un prefijo único.

## Ejemplos

Pida exploración en paralelo en un prompt:

```text
Use two explore subagents in parallel: one maps the plugin host, the other the TUI panel code.
Then summarize how plugin panels are rendered.
```

Un revisor de solo lectura para este proyecto, guardado como `.alisio/agents/reviewer.md` (requiere
`--trust-project` o `--config`):

```md
---
name: reviewer
description: Reviews the current diff for correctness bugs. Use after making changes.
tools: Read, Grep, Glob, git_diff
readOnly: true
color: magenta
---
Run a careful review of the uncommitted changes. Report only real bugs with file and line.
```
