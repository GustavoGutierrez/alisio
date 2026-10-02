# Memoria persistente

`memory` es un plugin integrado (paquete `@alisio/plugin-memory`) que da al modelo memoria persistente
basada en SQLite y FTS5 locales. Está activado por defecto y puede desactivarse.

## Observaciones

Cada memoria es una observación con:

- un título y un tipo: `decision`, `bugfix`, `discovery`, `pattern`, `architecture`, `config`,
  `preference` o `learning`;
- un cuerpo estructurado como **What / Why / Where / Learned**;
- un proyecto, un alcance (`project` o `personal`) y un `topic_key` opcional
  (`family/description`, kebab-case).

## Almacenamiento

- SQLite + FTS5 (tokenizador trigram, ranking BM25 combinado con recencia y número de accesos). Sin
  embeddings ni red.
- Una base de datos por usuario en `<state home>/memory.sqlite` (`ALISIO_STATE_HOME`/XDG),
  independiente de `--db`, para que la memoria sobreviva entre sesiones, ejecuciones y proyectos
  (alcance `personal`). El archivo es local, con permisos 0600.
- El proyecto se identifica como `<name>-<hash8>` del realpath de la raíz Git o del directorio de
  trabajo.
- El mismo `topic_key` en el mismo proyecto y alcance actualiza la fila (`revision_count`); los
  duplicados exactos dentro de 15 minutos incrementan `duplicate_count`. El borrado es lógico por
  defecto. `<private>…</private>` se guarda como `[REDACTED]`. El contenido está limitado a 50 000
  caracteres.

## Herramientas

| Herramienta | Función |
| --- | --- |
| `memory_save` | Guardar o actualizar (upsert) una observación |
| `memory_search` | Filas compactas; AND por defecto, con `match: "any"` y `all_projects` disponibles |
| `memory_get` | Observación completa por ID |
| `memory_context` | Contexto de memoria reciente (resúmenes de sesión, prompts, observaciones fijadas y recientes) |
| `memory_timeline` | Vecinos cronológicos de una memoria dentro de la misma sesión |
| `memory_pin` | Fijar (o desfijar) una memoria para que siempre se incluya en el contexto de memoria |
| `memory_forget` | Borrado lógico; `hard: true` la elimina de forma permanente |

Estas herramientas usan el efecto `internal`: solo escriben en la base de memoria de Alisio, nunca en
el workspace, por lo que siguen disponibles con `--read-only`.

## Comportamiento

- **Protocolo en el prompt de sistema**: guardar decisiones, bugfixes, descubrimientos, convenciones,
  configuración y preferencias; recuperar con contexto → búsqueda → detalle.
- **Sesión nueva**: inyecta un bloque `memory_context` (resumen de la última sesión, prompts recientes,
  observaciones fijadas y recientes) dentro de `injectBudgetTokens`.
- **Compactación**: en la misma llamada al modelo se extraen observaciones del tramo descartado (con
  upsert/deduplicación), el checkpoint se archiva como resumen de sesión con resultado
  `confirmed`/`failed`/`unknown`, y se añaden memorias relevantes (con IDs) dentro del presupuesto. Con
  JSON inválido el checkpoint queda solo en texto y no se extrae nada.
- **Fin de sesión** (`/clear`, `/exit`, salida de la TUI) con actividad: escribe un resumen con
  Goal / Instructions / Discoveries / Accomplished / Next Steps / Relevant Files, acotado por
  `pluginHooks.sessionEndTimeoutMs`.
- **TUI**: `/memory` (recientes), `/memory <query>`, `/memory show|forget|pin|unpin <id>`; un contador
  `mem N` en la barra de estado; detalle en `/stats`.

## Pestaña web {#web-tab}

En la interfaz web (`alisio serve`) una pestaña **Memoria** de solo lectura muestra lo que este
plugin guarda para el chat abierto; existe solo mientras el plugin está habilitado (véase la
[pestaña Memoria](/es/web#memory-tab)). El plugin registra tres
[vistas de datos](/es/plugins#data-views) (`records`, `summary`, `context`) que la pestaña lee, y
cada sección tiene su propio origen:

| Sección | De dónde sale |
| --- | --- |
| **Guardado en este chat** | Observaciones cuyo `session` es el id de sesión del chat (guardadas por `memory_save`, por la compactación o por el resumen de fin de sesión) y que no se olvidaron, primero las fijadas y luego por `updated_at`, de la más reciente a la más antigua. El filtro por tipo y la búsqueda de texto (título, contenido y `topic_key`, sin distinguir mayúsculas, de cualquier longitud) se ejecutan en la base de datos. |
| **Resumen de la sesión** | El resumen guardado para la sesión: como máximo uno, sobrescrito por la compactación y por el resumen de fin de sesión. |
| **Contexto cargado** | El texto exacto que el plugin devolvió desde su hook de inicio de sesión cuando empezó el chat. El plugin lo recuerda en su propia base de datos (tabla `injected_context`, versión de esquema 101), así que nada analiza el transcript. |

Las vistas solo leen: no cambian contadores de acceso ni marcas de tiempo. Una memoria con
`topic_key` que otro chat actualiza pasa a ese chat, por lo que puede salir de la lista de este. Los
chats iniciados antes de esta versión no tienen **Contexto cargado**, y el contexto recuperado tras
una compactación no se registra. El contexto recordado es lo que el plugin devolvió: el runner
trunca las inyecciones muy largas y no informa si las persistió.

## Configuración

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

| Campo | Por defecto | Descripción |
| --- | --- | --- |
| `enabled` | `true` | Activa el plugin |
| `dbPath` | `<state home>/memory.sqlite` | Las rutas relativas se resuelven desde el archivo de configuración |
| `injectBudgetTokens` | `1500` | Presupuesto (100–20000) para el contexto inyectado al iniciar sesión y tras la compactación |
| `recallLimit` | `8` | Memorias recuperadas tras la compactación (0–20) |
| `autoSummary` | `true` | Escribe un resumen de sesión con `/clear`, `/exit` o al salir (TUI) |
| `defaultScope` | `project` | `project` o `personal` |

## Desactivación

```sh
alisio --disable-plugin memory
```

o `"builtinPlugins": { "memory": { "enabled": false } }`. Desactivada, no hay herramientas, prompt,
hooks, comando, estado ni archivo de base de datos, y la compactación funciona en su modo genérico.

## Límites

La búsqueda usa el tokenizador trigram, por lo que los términos de menos de 3 caracteres se ignoran, y
no hay búsqueda semántica. El resumen automático de fin de sesión solo se ejecuta en la TUI (no en
`run` headless). Consulte [Limitaciones conocidas](/es/limitations) para conocer las restricciones de
almacenamiento, búsqueda y ciclo de vida.
