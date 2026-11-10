> Esta es la traducción al español de [README.md](README.md). Ambos archivos deben actualizarse juntos.

# @alisio/plugin-subagents

**Subagentes para [Alisio](https://github.com/GustavoGutierrez/alisio).** El agente principal
delega trabajo con la herramienta `task` en agentes especializados que se ejecutan en sesiones
hijas independientes: contexto limpio, permisos restringidos, su propio modelo y sus propios
límites.

## Qué es

Se distribuye como plugin integrado de la CLI `alisio` (se desactiva con
`--disable-plugin subagents` o `builtinPlugins.subagents.enabled: false`). Está construido sobre
el servicio genérico `api.sessions`, `api.ui.panel` y `api.ui.select`, por lo que depende solo de
`@alisio/sdk` más `zod` y `yaml`.

## Instalación

Viene preinstalado en la CLI `alisio`. Para un host embebido, regístralo mediante la lista
`builtins` de `createApplication`.

## Herramientas

| Herramienta | Entrada | Comportamiento |
| --- | --- | --- |
| `task` | `description`, `prompt`, `subagent_type`, opcionales `model`, `task_id`, `background` | Inicia un agente (o continúa `task_id` con su historial completo) y devuelve su informe final; varias llamadas en un mismo turno se ejecutan en paralelo |
| `task_status` | `task_id` | Estado, agente, indicador de segundo plano y tokens; no espera |
| `task_wait` | `task_id`, opcional `timeout_ms` | Espera un resultado, acotado por `waitMaxMs` |
| `send_message` | `task_id`, `text` | Mensaje unidireccional: queda en cola para el siguiente turno de un hijo en ejecución, o reanuda a un hijo que ya terminó |

Los resultados se envuelven en elementos `<task …>`; las tareas en segundo plano entregan un
`<task-notification>` al terminar. Los fallos son errores de herramienta estructurados que
conservan el `task_id`, de modo que la tarea puede reanudarse.

## Definiciones de agentes

Markdown + frontmatter YAML (`name`, `description`, `tools`, `model`, `permission`,
`maxTurns`, …) descubiertos desde `--agents` (JSON), `.alisio/agents`, `.agents/agents`,
`.claude/agents`, `.opencode/agent(s)`, directorios de usuario y recursos de plugins. Integrados:
`general` (tareas de varios pasos), `explore` (exploración de solo lectura) y `plan` (planes de
implementación de solo lectura).

## Escrituras en paralelo con git

Con `parallelWrites: "worktree"`, cada hijo con capacidad de escritura trabaja en su propio git
worktree (`worktreeDir`, por defecto `<state home>/worktrees`); el comando `/agents` de la TUI
ofrece `open|cancel|kill|resume` y `merge|discard <id>` para los worktrees. `ask`, `serial` y
`shared` son los demás modos.

## Configuración

En `builtinPlugins.subagents`:

| Campo | Valor por defecto | Descripción |
| --- | --- | --- |
| `maxDepth` | `3` | Anidamiento máximo (1–8) |
| `maxConcurrentPerParent` | `4` | Hijos en ejecución por padre (1–32) |
| `maxConcurrentTotal` | `8` | Hijos en ejecución en total (1–64) |
| `maxQueued` | `16` | Tareas en espera más allá de los límites de concurrencia (0–256) |
| `maxTurns` | `50` | Límite de turnos por defecto para cada hijo |
| `timeoutMs` | `600000` | Tiempo de espera por ejecución de un hijo |
| `maxTokensPerChild` | presupuesto del core | Presupuesto acumulado de tokens por hijo |
| `maxOutputTokensPerChild` | `16384` | Presupuesto de tokens de salida por llamada y por hijo |
| `parallelWrites` | `ask` | `ask`, `worktree`, `serial` o `shared` |
| `resultMaxBytes` | `50000` | Tamaño máximo del resultado |
| `worktreeDir` | `<state home>/worktrees` | Dónde se crean los worktrees |

Los hijos nunca superan a su padre: un padre de solo lectura (o `--read-only`) hace que todos sus
descendientes sean de solo lectura, y las aprobaciones suben hasta la TUI etiquetadas con la ruta
del agente.

## Documentación

[Subagentes](https://gustavogutierrez.github.io/alisio/subagents) ·
[Configuración](https://gustavogutierrez.github.io/alisio/configuration).

## Requisitos

Node.js **>= 22.16** o Bun **>= 1.4.2**.

## Licencia

MIT. Mantenido por Gustavo Gutiérrez Mercado. Código fuente: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.
