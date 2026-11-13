> Esta es la traducción al español de [README.md](README.md). Ambos archivos deben actualizarse juntos.

# @alisio/plugin-memory

**Memoria persistente al estilo Engram para [Alisio](https://github.com/GustavoGutierrez/alisio).**
El modelo guarda decisiones, correcciones de errores y descubrimientos entre sesiones, y los
recupera con su contexto; la compactación y el cierre de sesión convierten las conversaciones en
memoria estructurada y con búsqueda.

## Qué es

Se distribuye como plugin integrado de la CLI `alisio` (se desactiva con
`--disable-plugin memory` o `builtinPlugins.memory.enabled: false`). Depende únicamente de
`@alisio/sdk` y guarda los datos mediante el puerto de almacenamiento del SDK: una base de datos
SQLite local con indexación trigram FTS5, ranking BM25 combinado con la antigüedad; sin
embeddings y sin red. El archivo está en `<state home>/memory.sqlite` con permisos 0600.

## Instalación

Viene preinstalado en la CLI `alisio`. Para un host embebido, regístralo mediante la lista
`builtins` de `createApplication` (la CLI lo hace por ti).

## Herramientas

| Herramienta | Propósito |
| --- | --- |
| `memory_save` | Guardar o actualizar (upsert) una observación |
| `memory_search` | Búsqueda de texto completo; AND por defecto, con `match: "any"` y `all_projects` disponibles |
| `memory_get` | Observación completa por ID |
| `memory_context` | Contexto de memoria reciente (resúmenes, prompts, fijadas, recientes) |
| `memory_timeline` | Vecinas cronológicas de una memoria dentro de una sesión |
| `memory_pin` | Fijar (o desfijar) una memoria para que aparezca siempre en el contexto de memoria |
| `memory_forget` | Borrado lógico; `hard: true` lo elimina de forma permanente |

Una observación tiene un título, un tipo (`decision`, `bugfix`, `discovery`, `pattern`,
`architecture`, `config`, `preference`, `learning`), un cuerpo **Qué / Por qué / Dónde /
Aprendido** (What / Why / Where / Learned), un alcance `project` o `personal` y un `topic_key`
opcional para upserts. Todas las herramientas de memoria usan el efecto `internal`: solo tocan la
base de datos de memoria, nunca el espacio de trabajo, por lo que siguen disponibles con
`--read-only`.

## Comportamiento

- **Compactación consciente de la memoria** — en la misma llamada al resumidor se extraen
  observaciones del tramo descartado (con upsert y deduplicación), el punto de control se archiva
  como resumen de sesión y se inyectan las memorias relevantes dentro de un presupuesto de tokens.
- **Resúmenes de sesión** — con `/clear`, `/exit` o al salir de la TUI, escribe un resumen
  estructurado Goal/Instructions/Discoveries/Accomplished/Next Steps/Relevant Files (opción
  `autoSummary`, activada por defecto).
- **Comando `/memory`** — `/memory` (recientes), `/memory <consulta>` y
  `/memory show|forget|pin|unpin <id>`; un contador `mem N` en la barra de estado de la TUI.

## Configuración

En `builtinPlugins.memory`:

| Campo | Valor por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Activa el plugin |
| `dbPath` | `<state home>/memory.sqlite` | Ruta de la base de datos; las rutas relativas se resuelven desde el archivo de configuración |
| `injectBudgetTokens` | `1500` | Presupuesto de tokens (100–20000) para el contexto de memoria inyectado |
| `recallLimit` | `8` | Memorias recuperadas tras la compactación (0–20) |
| `autoSummary` | `true` | Escribe un resumen de sesión al terminar la sesión |
| `defaultScope` | `project` | `project` o `personal` |

## Documentación

[Plugin de memoria](https://alisioair.com/memory) ·
[Configuración](https://alisioair.com/configuration).

## Requisitos

Node.js **>= 22.16** o Bun **>= 1.4.2**.

## Licencia

MIT. Mantenido por Gustavo Gutiérrez Mercado. Código fuente: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.
