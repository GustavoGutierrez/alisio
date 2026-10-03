# Especificación Técnica: Pestaña «Memory» en la web (vistas de datos de plugins)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | Especificación técnica ejecutable. Implementada junto con esta especificación (2026-10-02) |
| Fecha | 2026-10-02 |
| Paquetes afectados | `@alisio/sdk` (API `views`, errores de API), `@alisio/core` (`PluginHost`), `@alisio/server` (ruta de vistas), `@alisio/plugin-memory` (tres vistas + tabla de contexto inyectado), `@alisio/web` (privado: pestaña, store, i18n) |
| Paquetes nuevos | Ninguno |
| Relación con otras especificaciones | Extiende `alisio-ui.md` (protocolo web v1: rutas de sesión, formato de error) y `alisio-modes-goal-background-v1.md` (fase 1: lista de plugins del web, pestañas del encabezado). Todo es aditivo. |
| Solo web | Sí. La TUI no cambia (`/memory` ya cubre ese uso). |

## 0. Cómo usar este documento

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; sus reglas prevalecen.
2. **(verificado)** = comprobado en el código al redactar (rutas `packages/plugin-memory/src/{index,store,tools,types,format}.ts`, `packages/core/src/plugins/host.ts`, `packages/core/src/core/runner.ts`, `packages/server/src/**`, `packages/web/src/**`). **(no verificado)** = deducido; compruébalo antes de apoyarte en ello.
3. **Un plugin no es un sandbox** (`AGENTS.md`). Las vistas son de solo lectura **por contrato**, no por aislamiento: el host no puede impedir que el código de un plugin escriba donde quiera. Ninguna doc o UI lo presenta como garantía técnica.
4. Idioma: código, comentarios, textos de UI y pruebas en inglés; esta especificación en español; la documentación ES en español neutro.

## 1. Alcance y decisiones del propietario (2026-10-02)

| # | Decisión |
|---|---|
| M1/M2 | Se muestra la memoria del **chat activo** (la sesión), en tres secciones: **Saved in this chat** (registros de memoria cuyo `session` es el id de la sesión), **Session summary** (el resumen de sesión que el plugin guardó para esa sesión) y **Context loaded** (el contexto de memoria que el plugin inyectó al empezar el chat). Solo lectura. Filtro por tipo, búsqueda de texto y paginación. Primero los fijados (`pinned`), luego los más recientes. Cambiar de chat recarga y nunca muestra datos de otro chat. |
| M3 | Mecanismo: API aditiva `api.views.register({ id, description, params?, handler })` en `@alisio/sdk`; el servidor las expone tras la misma autenticación, Host y Origin que el resto de rutas: `GET /api/sessions/:sid/views/:plugin/:view`. El plugin de memoria registra sus vistas. La web detecta si el plugin de memoria está habilitado con la lista de plugins que ya tiene (`GET /api/plugins`) y muestra la pestaña **solo** si lo está; si se deshabilita con la pestaña activa, vuelve a Conversation. |
| Frontera | `@alisio/plugin-memory` depende solo de `@alisio/sdk`; core y server no lo importan. Un plugin debe seguir funcionando en un core antiguo sin `api.views` (`api.views?.register`). |
| Límites | En el servidor: solo vistas de plugins habilitados; validación de parámetros por el esquema declarado de la vista; tope de tamaño de respuesta; timeout por petición; errores mapeados al formato de error de la API; lectura solo por contrato (§3.4). |
| Seguridad | La memoria puede contener datos sensibles del proyecto: la ruta exige la misma sesión de autenticación que las demás rutas de sesión y rechaza una sesión cuyo workspace no pertenezca a los workspaces conocidos. Nunca se registran parámetros ni contenido en logs. |

Decisiones de diseño tomadas aquí (revisables por el propietario, §11):

- **D1. Contrato de ids fijo, sin ruta de descubrimiento.** La web conoce las vistas del plugin de memoria por contrato (`records`, `summary`, `context`). No hay `GET .../views` de descubrimiento: añadiría superficie sin consumidor. El esquema declarado por cada vista sí vive en el host (valida parámetros).
- **D2. El contexto inyectado lo guarda el plugin**, en su propia base (tabla `injected_context` por sesión), no se deduce parseando el mensaje del transcript (§4.3).
- **D3. «Habilitado» en la web = `enabled === true` y `status === "active"`** en `PluginInfo` (§7.1). `restart-required` con `enabled: false` (se acaba de deshabilitar y aún corre) cuenta como deshabilitado; `restart-required` con `enabled: true` (aún no cargado) también como no disponible.
- **D4. Los textos de la pestaña viven en un diccionario perezoso** (`components/memory/strings.ts`, EN y ES) y no en `i18n/en.ts`/`es.ts`, para no gastar presupuesto del bundle inicial (§9).

## 2. Verificación del plugin de memoria (contra el código)

| Hecho | Estado |
|---|---|
| Los registros están en la tabla `observations` (`session_id`, `type`, `title`, `content`, `tool_name` = producer, `project`, `scope`, `topic_key`, `pinned`, `revision_count`, `duplicate_count`, `created_at`, `updated_at`, `deleted_at`) | (verificado, `store.ts`) |
| `memory_save` escribe `session: context.session` y `source: "memory_save"`; la compactación y el resumen de fin de sesión escriben `source: "compaction"` / `"session_summary"` con el id de sesión | (verificado, `tools.ts`, `index.ts`) |
| Un upsert por `topic_key` **sobrescribe** `session_id` y `tool_name` y sube `updated_at`: la fila pasa a pertenecer a la última sesión que la tocó | (verificado, `store.save`) |
| Los duplicados exactos en 15 min solo incrementan `duplicate_count`/`updated_at`; no cambian `session_id` | (verificado, `store.save`) |
| El resumen de sesión está en `memory_sessions.summary` (una fila por sesión, `ON CONFLICT DO UPDATE`): hay **como máximo un resumen por sesión**, reescrito por la compactación y por el resumen de fin de sesión; `ended_at` se actualiza en cada guardado | (verificado, `saveSummary`) |
| El contexto de arranque lo produce `api.session.onStart` → `memoryContextText(deps, sessionId)` → `renderMemoryContext(...)` (cabecera `[Memory context from previous sessions (Alisio memory). Call memory_get with an id for details.]`) | (verificado, `tools.ts`, `format.ts`) |
| El runner llama a `sessionStart` solo si la sesión no tiene mensajes, trunca cada texto a `MAX_INJECT_CHARS` y lo añade como mensaje `user` con `summary: true`; emite `session_context_injected` | (verificado, `runner.ts`) |
| `PluginInfo.status` y `enabled` vienen del catálogo; deshabilitar un plugin incorporado en la web recicla el workspace (si está ocioso) y emite `catalog_changed` con ámbito `plugins` | (verificado, `management.ts`) |
| `store.get()` incrementa `access_count`: las vistas **no** deben usarlo (lectura pura con `SELECT`) | (verificado) |
| Los mensajes de `session_context` de sesiones hijas también pasan por `onStart` | (no verificado: no se probó con subagentes; las vistas se limitan a la sesión pedida) |

## 3. Contrato del SDK (`@alisio/sdk`, aditivo)

### 3.1 Tipos

```ts
export interface ViewContext {
  sessionId: string;   // la sesión validada por el host
  workspace: string;   // workspace de esa sesión
  signal: AbortSignal; // aborta al expirar el timeout del host
}
export interface ViewDefinition {
  /** `^[a-z][a-z0-9-]{0,39}$`. */
  id: string;
  description: string;
  /** Objeto plano de primitivos (string | integer | number | boolean). Sin `$ref`. */
  params?: JsonSchema;
  handler(params: Record<string, unknown>, context: ViewContext): unknown | Promise<unknown>;
}
interface PluginAPI {
  /** Ausente en un core anterior: usa `api.views?.register(...)`. */
  views?: { register(view: ViewDefinition): () => void };
}
export class ViewParamsError extends Error { readonly code = "view_invalid_params" }
```

Se añaden a `ApiErrorCode`: `view_failed` (502), `view_timeout` (504), `view_too_large` (502).

### 3.2 Registro (core, `PluginHost`)

- Valida `id`, `description` no vacía (≤ 300), `handler` función y, si hay `params`, que sea `type: "object"` con `properties` de tipos primitivos, sin `$ref`/`$id`/`$async`; se compila con Ajv (`coerceTypes`, `useDefaults`, `additionalProperties: false` forzado). Duplicado `plugin:id` lanza error.
- Se registra por plugin y se deshace al desactivar/fallar el `setup` (misma mecánica `track` que las demás registraciones).
- `PluginHost.viewsOf(plugin)` y `PluginHost.runView(plugin, id, query, context)` (valida y ejecuta; no aplica límites: eso es del servidor).

### 3.3 Detección en un core antiguo

`createMemoryPlugin` registra vistas con `api.views?.register(...)`. Sin `api.views` el plugin sigue funcionando (herramientas, hooks, `/memory`) y solo falta la pestaña (la web mostrará el error de «no disponible», §7.4).

### 3.4 Solo lectura: por contrato

Una vista **no debe** modificar estado. Ni el SDK ni el host lo imponen técnicamente (el plugin tiene acceso a su propia base y al sistema de archivos). Lo que sí impone el host: método `GET`, parámetros validados, timeout y tope de tamaño. Las vistas del plugin de memoria usan solo `SELECT` (prueba: el contador `access_count` y `updated_at` no cambian tras leer).

## 4. Fuentes de cada sección (plugin de memoria)

Vistas registradas (ids estables, contrato con la web):

| Vista | Parámetros | Respuesta |
|---|---|---|
| `records` | `type?` (enum de tipos), `q?` (≤ 200), `limit?` (1–50, def. 20), `cursor?` (opaco, ≤ 200) | `{ items: MemoryEntry[], total: number, next?: string }` |
| `summary` | — | `{ summary: { content, updatedAt, truncated } \| null }` |
| `context` | — | `{ context: { content, injectedAt, truncated } \| null }` |

`MemoryEntry` = `{ id, type, title, content, contentTruncated, scope, topicKey?, source?, pinned, createdAt, updatedAt, revisionCount, duplicateCount }` (`content` recortado a 10 000 caracteres por entrada; el valor completo sigue en `/memory show <id>`).

### 4.1 Saved in this chat (`records`)

`SELECT … FROM observations WHERE session_id = :session AND deleted_at IS NULL AND (project = :project OR scope = 'personal')`. Filtro `type`; búsqueda `q` con `LIKE` escapado sobre título, contenido y `topic_key` (funciona con consultas cortas, que el tokenizador trigram de FTS5 no admite). Orden `pinned DESC, updated_at DESC, id DESC`. `total` = filas que cumplen los filtros (sin cursor).

**Paginación por cursor (keyset)** sobre `(pinned, updated_at, id)`: el cursor es opaco (base64url de `[pinned, updatedAt, id]`). Las filas **añadidas** mientras se navega son más nuevas y quedan antes del cursor: no producen duplicados ni huecos en las páginas siguientes (aparecen al refrescar). Una fila **actualizada o fijada** mientras se navega puede saltar al principio: la web no la repite (dedupe por `id`) y el botón Refresh reinicia la lista. Un cursor mal formado → `400 validation_failed`.

Limitación conocida: un upsert por `topic_key` reasigna la fila a la última sesión que la tocó (§2), así que una entrada puede desaparecer de este chat si otro chat la actualiza.

### 4.2 Session summary (`summary`)

`SELECT summary, ended_at FROM memory_sessions WHERE id = :session AND project = :project AND summary IS NOT NULL`. Como máximo uno (§2). `truncated` si supera 50 000 caracteres (el almacén ya lo recorta).

### 4.3 Context loaded (`context`)

**Origen elegido: el plugin recuerda lo que inyectó.** En `api.session.onStart`, justo antes de devolver el texto, guarda `(session_id, project, content, created_at)` en la tabla nueva `injected_context` (migración `101`, `INSERT … ON CONFLICT DO UPDATE`). La vista lee esa fila. Ventajas: no depende del texto del mensaje (que la web no debe parsear), ni de una API nueva del SDK para leer el transcript, y refleja exactamente lo que el plugin devolvió.

Limitaciones (a documentar, `implementation-status.md`):

- Es lo que el plugin **devolvió**, no una confirmación de que el runner lo persistiera: si el runner se aborta entre `sessionStart` y el `append`, queda registrado un contexto que no llegó al transcript (el runner trunca además cada texto a `MAX_INJECT_CHARS`; la vista muestra el texto original).
- Las sesiones anteriores a esta versión no tienen fila: la sección muestra «no memory context was loaded».
- Solo el contexto de arranque. El contexto recuperado tras una compactación («Recovered memory») no se registra en v1.

## 5. Ruta del servidor

`GET /api/sessions/:sid/views/:plugin/:view?<params>` (en `routes/plugin-views.ts`).

Orden de comprobaciones (todas antes de ejecutar nada):

1. Host/Origin/cookie: las del servidor (comunes a todas las rutas `/api`). Los logs de petición solo llevan la ruta, sin query.
2. `sessions.get(sid)` → `404 not_found`.
3. El workspace de la sesión debe ser un workspace conocido (`workspaces.pathOf`) y existir (`sessions.app` → `workspace_missing`); si no, `404`.
4. El plugin debe existir en el catálogo de **ese** workspace con `enabled === true`; si no, `404 not_found` (misma respuesta que «vista desconocida», para no filtrar qué plugins existen).
5. La vista debe estar registrada por el plugin → si no, `404 not_found`.
6. Parámetros: ≤ 16 claves, valor ≤ 512 caracteres, claves duplicadas rechazadas; validación Ajv con el esquema de la vista (`400 validation_failed`, `details.fields`, nunca los valores).
7. Ejecución con timeout (`5 s`, `AbortSignal` al handler) → `504 view_timeout`; excepción `ViewParamsError` → `400 validation_failed`; cualquier otra excepción → `502 view_failed` con mensaje genérico (se registra solo el nombre del error, nunca parámetros ni contenido).
8. Respuesta: JSON serializable; si `JSON.stringify` supera `1 MiB` → `502 view_too_large`.

Respuesta correcta: `200` con el JSON de la vista tal cual (cabeceras de seguridad del servidor; `Cache-Control: no-store` ya aplica a `/api`).

Opciones de servidor (para pruebas): `ServerOptions.views = { timeoutMs?, maxBytes? }`.

## 6. Formas de respuesta

Ver §4. Errores: formato `ApiError` existente (`{ error: { code, message, details? }, correlationId }`).

## 7. Web

### 7.1 «Is plugin X enabled» (reutilizable)

`store/plugins.ts` (puro + una señal): `pluginsState` (`loading | ready | error` + lista) alimentada por la misma petición que ya hace `refreshPluginNames` (al abrir una sesión y en `catalog_changed` de ámbito `plugins`; no hay petición nueva). Selector `pluginStatus(state, id)` → `"enabled" | "disabled" | "loading" | "error"`; `isPluginEnabled(id)` es el booleano. Un fallo al refrescar conserva la última lista conocida (sin parpadeo); sin lista previa devuelve `error`.

### 7.2 Pestaña y fallback

`header` muestra `conversation`, `trajectory` y `memory` (solo si `pluginStatus(…, "memory") === "enabled"`). `sessionTab` admite `"memory"`. Un efecto de la app vuelve a `conversation` si la pestaña activa es `memory` y el estado pasa a `disabled`. Con `loading`/`error` no se cambia de pestaña (evita el rebote por fallos transitorios). Patrón ARIA de las pestañas actuales (`role="tablist"/"tab"`, `aria-selected`).

### 7.3 Carga perezosa

`MemoryTab` (`components/memory/MemoryTab.tsx`) se importa dinámicamente la primera vez que se abre la pestaña (mismo patrón que `LazyBtw`/`LazyChangelog`). Sus textos (D4), su store (`store/memory.ts`) y su CSS viajan en ese chunk. El bundle inicial solo añade: una clave de i18n, `store/plugins.ts`, un método genérico `api.sessionView`, el cargador perezoso y la condición de la pestaña.

### 7.4 Estados y reglas

- Tres secciones, cada una con su propia carga/error/reintento. Vacío general: «No memory stored for this chat yet».
- `records`: filtro por tipo (select), búsqueda con debounce (300 ms), tamaño de página 20 y «Load more» (cursor), total si la API lo da, botón Refresh manual (sin actualizaciones en vivo en v1).
- Cada entrada: tipo y título; resumen del contenido con expandir/contraer (botón con `aria-expanded`); marcas de tiempo (updated, o created si falta); productor (`source`); «Details» con el JSON bruto en un `<pre>` con scroll propio.
- **Descarte de respuestas obsoletas**: cada carga lleva un `AbortController` y un id de petición; cambiar de chat, de filtro o refrescar aborta la anterior y se ignora cualquier respuesta cuyo id/sesión ya no coincida (`store/memory.ts`, reductor puro probado).
- Responsive: una columna, contenido que envuelve, bloques de código/JSON con scroll interno; sin scroll horizontal de página.

## 8. Límites (resumen)

| Límite | Valor | Dónde |
|---|---|---|
| Timeout por vista | 5 s | servidor |
| Tamaño de respuesta | 1 MiB | servidor |
| Parámetros | ≤ 16 claves, valor ≤ 512 caracteres | servidor + esquema |
| Página de `records` | 20 por defecto, máx. 50 | plugin |
| `content` por entrada | 10 000 caracteres | plugin |
| Búsqueda `q` | ≤ 200 caracteres | plugin (esquema) |

## 9. Presupuesto del bundle

El inicial tenía ~0,3 KB gzip de margen (`pack:check`: 89,7 de 90,0 KB). Por eso el componente, su store, su CSS y sus textos son un chunk perezoso (§7.3) y la verificación incluye `pnpm pack:check` (resultado en el informe de entrega).

## 10. Criterios de aceptación y pruebas

| # | Criterio | Prueba |
|---|---|---|
| A1 | `api.views.register` valida id, descripción, esquema; duplicados fallan; se deshace con el plugin | `tests/plugin-views.test.ts` |
| A2 | Un plugin sin `api.views` (core antiguo) arranca sin error | `tests/plugin-views.test.ts` |
| A3 | La ruta exige autenticación, Host y Origin; sesión inexistente y workspace desconocido → 404 | `tests/server-plugin-views.test.ts` |
| A4 | Plugin deshabilitado, plugin o vista desconocidos → 404 uniforme | ídem |
| A5 | Parámetros inválidos → 400 sin eco de valores; tope de tamaño → 502 `view_too_large`; timeout → 504; excepción → 502 genérica | ídem |
| A6 | `records`: solo la sesión pedida, fijados primero, filtro por tipo, búsqueda, cursor sin duplicados ni huecos al añadir filas, solo lectura | `tests/memory-views.test.ts` |
| A7 | `summary` y `context` de la sesión; sin datos → `null`; el contexto coincide con lo que `onStart` devolvió | ídem |
| A8 | Selector de plugin habilitado (enabled/disabled/loading/error), visibilidad de la pestaña, fallback a Conversation | `tests/web-memory.test.ts` |
| A9 | Descarte de respuestas obsoletas al cambiar de chat; paginación sin repetir ids; filtros reinician la lista | ídem |
| A10 | Paridad EN/ES de los textos de la pestaña; chunk perezoso; `pack:check` dentro de presupuesto | `tests/web-memory.test.ts`, `pnpm pack:check` |
| A11 | Comprobación manual en Chromium (pestaña solo con el plugin; tres secciones; filtro/búsqueda/paginación; cambio de chat; deshabilitar en Settings → Plugins; móvil) | informe de entrega |

## 11. Riesgos y decisiones abiertas

- **Reasignación de sesión por upsert** (§4.1): una memoria con `topic_key` actualizada desde otro chat deja de aparecer en el primero. Alternativa (no hecha): tabla de historial de sesiones por observación. *Decisión del propietario.*
- **Contexto de compactación** no se muestra en v1 (§4.3). *Decisión del propietario si debe incluirse.*
- **Solo lectura por contrato**: un plugin malicioso o defectuoso puede escribir desde su vista; el host solo limita método, parámetros, tiempo y tamaño. Un handler síncrono que bloquee el bucle de eventos no se interrumpe con el timeout.
- **Disponibilidad de la vista** en un servidor/core más antiguo que el plugin: la web muestra el error con reintento (no oculta la pestaña).
- **Datos sensibles en pantalla**: la pestaña los muestra a quien tenga la cookie de sesión; `alisio serve` remoto sigue el modelo de seguridad de `docs/web.md`.
- **Contexto grande**: hasta 80 000 caracteres por sesión se almacenan en la base de memoria (presupuesto `injectBudgetTokens` × 4); se recorta a ese tamaño.

## 12. Documentación

`docs/web.md` y `docs/es/web.md` (sección «Memory tab» con captura), `docs/memory.md` y `docs/es/memory.md`, `docs/plugins.md` y `docs/es/plugins.md` (`api.views`), `docs/implementation-status.md` (límites; `docs/limitations.md` lo refleja). `pnpm docs:check` y `pnpm docs:build` en verde.
