# Especificación Técnica: Memoria de proyecto — procedencia, vigencia y relaciones

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 6 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador (propuesta, no implementada).** Decisiones O1–O8 pendientes de confirmar por el propietario. |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/plugin-memory` (`packages/plugin-memory/src/{store,tools,types,index,views,format}.ts`: migraciones propias, columnas y tabla nuevas, herramientas ampliadas, hooks de sesión), `@alisio/web` (privado: `packages/web/src/components/memory/{MemoryTab.tsx,strings.ts}` y `src/i18n/es.ts`), `@alisio/sdk` (solo tipos de vistas si hace falta; sin cambios en contratos de core), `@alisio/core` (ninguno obligatorio; opcional: etiqueta de procedencia del segmento inyectado, ver §8) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción (usa `node:sqlite` vía `api.storage.sqlite` y `node:child_process` solo para `git` acotado). |
| Relación con otras especificaciones | Reutiliza el formato de export/import de `specs/018-perimeter-v1.md` (Fase 5, `memory_export/import`): **el formato debe incluir los campos nuevos** de esta spec. Usa de forma opcional los IDs de evidencia de `specs/archive/011-proof-v1.md` (`evidence_ref`). Los recuerdos inyectados entran como segmento con procedencia en `specs/012-context-governor-v1.md`. Complementa a `specs/014-trust-boundaries-v1.md` (un recuerdo creado desde datos no confiables conserva `source_kind`). Medible con `specs/archive/010-reliability-lab-v1.md`. No se solapa con `specs/research/023-knowledge-vault-research.md` (RAG de documentos). |
| Superficies | Web (pestaña Memory), TUI y headless (herramientas `memory_*`) con paridad funcional |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**. Aditiva: columnas con valores por defecto y tablas nuevas; ninguna herramienta ni columna existente cambia de significado salvo el upsert por `topic_key` (§6.3, decisión O3). |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 (`main`, 0.6.0, `2e867c7`); **(no verificado)** = deducido o externo sin prueba ejecutada aquí; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts` (vitest; las existentes son `tests/memory.test.ts`, `tests/memory-views.test.ts` y `tests/web-memory.test.ts`), sobre comportamiento en límites de módulo. Sin pruebas de instantánea.
4. **Orden obligatorio**: Fase 0 (medición con memoria real y migración en seco) → el propietario revisa → Fases 1..6. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: Sonnet por defecto; Opus solo en los puntos de §12.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y Bun; solo APIs portables de Node; **el plugin depende solo de `@alisio/sdk` (peer) y no importa internos de `@alisio/core`**; sin SDK de proveedor en contratos; preservar IDs de tool calls y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Contratos **aditivos**: migraciones forward-only, columnas con `DEFAULT`, ninguna fila existente se reescribe ni se pierde.
8. Idioma: identificadores, claves y textos de herramientas en inglés; UI en inglés y español (`packages/web/src/i18n/es.ts`); esta spec en español; docs EN/ES en paridad (`docs/memory.md`); límites en `docs/implementation-status.md`; captura Web UI en `docs/assets/web-ui/memory_provenance_web_ui.webp` (reglas de `AGENTS.md`; reutilizar una captura existente de Memory si ya muestra la función).

## 1. Objetivo y principio rector

### 1.1 Objetivo

Que cada recuerdo sea **rastreable a una fuente** (sesión, commit, archivos, evidencia), tenga un **estado de vigencia** explícito, se **relacione** con otros recuerdos (reemplaza, contradice, corrige) y que el sistema **detecte y muestre** lo posiblemente obsoleto, sin sustituir SQLite + FTS5 ni introducir embeddings.

### 1.2 Principio rector

> **La memoria nunca presenta como verificado lo que no puede respaldar, y nunca borra ni reescribe en silencio lo que ya guardó.**

Reglas derivadas:

- El estado `verified` exige evidencia referenciable; sin ella el máximo es `observed`.
- Un chequeo de frescura solo **marca** (`may_be_stale`); nunca reescribe ni cambia el estado persistido por sí solo.
- Un upsert conserva la versión anterior enlazada (`supersedes`); la sobrescritura destructiva desaparece.
- Si no hay evidencia vigente suficiente, la búsqueda **se abstiene explícitamente** en lugar de devolver el mejor resultado débil como si fuera respuesta.

### 1.3 Alcance

Columnas aditivas de procedencia y estado en `observations`, tabla `observation_links`, historial de revisiones, chequeo de frescura por `git`, abstención en `memory_search`, detección de conflictos al guardar `decision|architecture`, consolidación propuesta de fin de sesión, vistas web y TUI, export/import ampliado, documentación EN/ES.

### 1.4 Fuera de alcance

| Excluido | Motivo |
| --- | --- |
| Memoria vectorial o semántica (embeddings) | Ya excluida en `docs/memory.md` (sin embeddings, sin red). |
| RAG de documentos del usuario | Es `specs/research/023-knowledge-vault-research.md`. |
| Resolución automática de contradicciones por modelo | Violaría el principio rector; solo se detectan y se muestran. |
| Sincronización entre máquinas | Local-first; el export/import de Perímetro cubre el intercambio manual. |
| Memoria entre proyectos con grafo global | `scope: "personal"` ya existe; no se amplía. |
| Reescritura masiva de la base existente | Las filas previas quedan como `observed` sin procedencia (`source_kind = 'legacy'`). |

## 2. Base verificada

| Hecho | Cita (repo) | Implicación |
| --- | --- | --- |
| Almacén SQLite propio del plugin con tablas `observations`, `observations_fts` (FTS5, tokenizer `trigram`), `memory_sessions`, `user_prompts`, `injected_context` | `packages/plugin-memory/src/store.ts` (`migrateBase`, l.~104–140) | Base sobre la que se añaden columnas y tablas. |
| Migraciones **propias del plugin**, numeradas 100 (`MEMORY_SCHEMA_VERSION`) y 101 (`INJECTED_CONTEXT_VERSION`) en `schema_migrations`, independientes de la serie del store del core | `store.ts` (l.21–23, `applied()`, `migrate()`) | Las nuevas migraciones continúan esta serie (102+), no la del core (v11+). Ver §7. |
| `observations` guarda `topic_key`, `normalized_hash`, `revision_count`, `duplicate_count`, `pinned`, `access_count`, `last_accessed_at`, `scope`, `session_id`, `tool_name` | `store.ts` (l.106–114) | `session_id` y `tool_name` ya dan procedencia parcial. |
| `save()` hace upsert por `scope + topic_key (+ project)` y **sobrescribe** título, tipo y contenido, incrementando `revision_count` | `store.ts` `save()` (l.~150–185) | La versión anterior se pierde; se sustituye por revisión con historial (§6.3). |
| `MEMORY_TYPES` = decision, bugfix, discovery, pattern, architecture, config, preference, learning; `MemoryScope` = `project|personal` | `packages/plugin-memory/src/types.ts` | Los tipos `decision|architecture` activan la detección de conflictos. |
| Herramientas `memory_save`, `memory_search`, `memory_get`, `memory_context`, `memory_timeline`, `memory_pin`, `memory_forget`, todas con efecto `internal` | `packages/plugin-memory/src/tools.ts` | Se amplían de forma aditiva; el efecto no cambia. |
| `memory_search` busca con modo `all` y reintenta `any` si no hay resultados, y devuelve `{mode, results}` | `tools.ts` (l.98–128) | No hay abstención ni umbral; siempre devuelve lo que haya. |
| Hooks `api.session.onStart` / `onEnd` y `api.compaction.register` ya usados por el plugin | `packages/plugin-memory/src/index.ts` (l.126, 176, 189) | Puntos de enganche para la consolidación de fin de sesión. |
| Vistas web `records|summary|context` y pestaña Memory | `packages/plugin-memory/src/views.ts`, `packages/web/src/components/memory/MemoryTab.tsx` | Aquí se muestran estado y procedencia. |
| `redactPrivate()` se aplica a título y contenido antes de guardar | `store.ts` `save()` | Base de la política de secretos (§6.8). |

## 3. Decisiones

### 3.1 Decisiones del propietario (pendientes de confirmar)

- **O1 — Estados de vigencia.** **Recomendación:** `observed | verified | obsolete | contradicted` (cuatro valores; `may_be_stale` es calculado en lectura y no se persiste).
- **O2 — Quién puede marcar `verified`.** **Recomendación:** solo el usuario (UI/herramienta con confirmación) o una evidencia referenciable (`evidence_ref` de `specs/archive/011-proof-v1.md` cuando exista); el modelo no se autopromueve a `verified`.
- **O3 — Cambio de semántica del upsert por `topic_key`.** **Recomendación:** pasar a «nueva revisión + enlace `supersedes` + fila anterior conservada (`obsolete`)»; es el único cambio de comportamiento visible y se documenta en `docs/memory.md`.
- **O4 — Conflicto al guardar `decision|architecture`.** **Recomendación:** si hay similitud FTS alta con otra observación vigente sin el mismo `topic_key`, **devolver candidatos** y no guardar hasta que el modelo/usuario elija (`replace`, `link`, `keep_both`); umbral configurable, con default conservador.
- **O5 — Chequeo de frescura por `git`.** **Recomendación:** activo por defecto solo en lectura de `memory_get`/`memory_context`/vista web (no en cada `memory_search`), con caché por `HEAD` y presupuesto de tiempo corto; `memory.freshness: "off" | "on"`.
- **O6 — Abstención.** **Recomendación:** `memory_search` devuelve `{ evidence: "none", results: [] }` cuando ningún resultado vigente supera un umbral de rango BM25; el umbral se calibra en Fase 0.
- **O7 — Consolidación de fin de sesión.** **Recomendación:** propone (no guarda) candidatos de `decision|architecture|learning` en una cola `pending`; el usuario aprueba en Web/TUI; en headless queda `pending` sin bloquear.
- **O8 — Datos existentes.** **Recomendación:** migración sin reescritura: filas previas con `status='observed'`, `source_kind='legacy'`, sin `git_commit`; sin intento de adivinar procedencia retroactiva.

### 3.2 Decisiones de diseño (vinculantes)

- **D1** Todas las columnas nuevas son nullable o tienen `DEFAULT`; la migración es forward-only y transaccional, y el plugin sigue arrancando con una base 100/101.
- **D2** FTS5 y BM25 no se tocan; los campos nuevos no se indexan en `observations_fts` salvo que la Fase 0 demuestre beneficio (cualquier cambio a FTS se hace con reconstrucción controlada).
- **D3** El chequeo de frescura es de **solo lectura** y acotado: `git diff --name-only <git_commit>..HEAD -- <files>` con límite de archivos y de tiempo; fallo o ausencia de git ⇒ sin marca (nunca error).
- **D4** `evidence_ref` es un identificador opaco (`string`) del ledger de Proof; el plugin no importa tipos de core ni valida su existencia (feature-detect por presencia de la API).
- **D5** Ningún valor que parezca credencial se persiste (`redactPrivate` + comprobación adicional, §6.8); las observaciones creadas a partir de datos no confiables guardan `source_kind` acorde para trazabilidad.
- **D6** El export/import conserva todos los campos y relaciones; importar nunca eleva el estado a `verified` salvo que el archivo traiga `evidence_ref` y el usuario lo confirme.
- **D7** La API de herramientas se mantiene retrocompatible: los parámetros nuevos son opcionales y las respuestas ganan campos, no pierden ninguno.

## 4. Modelo de datos (nuevo)

### 4.1 Columnas aditivas en `observations`

| Columna | Tipo | Default | Significado |
| --- | --- | --- | --- |
| `status` | TEXT | `'observed'` | `observed | verified | obsolete | contradicted` |
| `source_kind` | TEXT | `'legacy'` | `agent | user | compaction | consolidation | import | legacy` |
| `git_commit` | TEXT NULL | NULL | `HEAD` al guardar (si hay repo) |
| `files` | TEXT NULL | NULL | JSON array de rutas relativas al workspace (máx. 20) |
| `evidence_ref` | TEXT NULL | NULL | ID opaco de evidencia (`specs/archive/011-proof-v1.md`) |
| `status_changed_at` | INTEGER NULL | NULL | Marca de la última transición |
| `status_reason` | TEXT NULL | NULL | Motivo breve de la transición |

### 4.2 Tabla `observation_links`

```sql
CREATE TABLE observation_links(
  from_id INTEGER NOT NULL REFERENCES observations(id),
  to_id   INTEGER NOT NULL REFERENCES observations(id),
  kind    TEXT NOT NULL CHECK(kind IN ('supersedes','contradicts','relates','fixes')),
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,   -- 'agent' | 'user' | 'system'
  PRIMARY KEY(from_id, to_id, kind)
);
CREATE INDEX observation_links_to ON observation_links(to_id, kind);
```

### 4.3 Tabla `observation_revisions` (historial del upsert, O3)

```sql
CREATE TABLE observation_revisions(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  observation_id INTEGER NOT NULL REFERENCES observations(id),
  revision INTEGER NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL, type TEXT NOT NULL,
  session_id TEXT, git_commit TEXT, created_at INTEGER NOT NULL
);
```

### 4.4 Cola de consolidación

```sql
CREATE TABLE memory_proposals(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project TEXT NOT NULL, session_id TEXT, type TEXT NOT NULL,
  title TEXT NOT NULL, content TEXT NOT NULL, files TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | accepted | rejected
  created_at INTEGER NOT NULL
);
```

## 5. Arquitectura

```
memory_save ──► redact/secret check ──► conflict detect (decision|architecture)
      │                                   └─► candidates | save
      └─► observations (+provenance) ──► observation_links / observation_revisions
memory_get/context/vista ──► freshness check (git, cacheado por HEAD) ──► may_be_stale
memory_search ──► FTS5/BM25 ──► umbral ──► results | { evidence: "none" }
session.onEnd ──► propose() ──► memory_proposals(pending) ──► aprobación del usuario
```

Todo vive en `packages/plugin-memory/src/`; se añaden `provenance.ts` (git acotado, caché por commit), `conflicts.ts` (candidatos), `proposals.ts` (cola), sin tocar `@alisio/core`.

## 6. Contratos y comportamiento

### 6.1 Tipos (en `types.ts`, aditivos)

```ts
export type MemoryStatus = "observed" | "verified" | "obsolete" | "contradicted";
export type MemorySourceKind = "agent" | "user" | "compaction" | "consolidation" | "import" | "legacy";
export type LinkKind = "supersedes" | "contradicts" | "relates" | "fixes";

export interface MemoryProvenance {
  sessionId?: string;
  gitCommit?: string;
  files?: string[];
  evidenceRef?: string;
  sourceKind: MemorySourceKind;
}
export interface MemoryInput { /* ...existente... */ files?: string[]; evidenceRef?: string; status?: "observed" }
export interface MemoryRecord { /* ...existente... */ status: MemoryStatus; provenance: MemoryProvenance; mayBeStale?: boolean; staleFiles?: string[] }
export interface MemoryConflictCandidate { id: number; title: string; type: MemoryType; score: number; status: MemoryStatus }
```

`status` en `MemoryInput` solo admite `"observed"` desde el modelo (O2).

### 6.2 Procedencia al guardar

`memory_save` rellena `session_id` (ya existe), `source_kind`, `git_commit` (resolviendo `HEAD` del workspace con `git rev-parse HEAD` acotado, vacío si no hay repo) y `files` (parámetro opcional del modelo, validado a rutas relativas existentes dentro del workspace; máx. 20). `evidence_ref` solo si viene del ledger de Proof.

### 6.3 Upsert sin pérdida (O3)

Cuando `topic_key` coincide y el contenido cambia: se copia la fila vigente a `observation_revisions`, se incrementa `revision_count`, y la fila conserva su `id`; la respuesta devuelve `action: "updated"` (compatible) más `previousRevision`. Cuando el contenido es idéntico se mantiene `bump` (duplicado). El upsert nunca descarta el texto anterior.

### 6.4 Conflictos en `decision|architecture` (O4)

Antes de crear una observación nueva de esos tipos sin `topic_key` coincidente, se busca por FTS (top 3) entre observaciones vigentes del mismo proyecto. Si alguna supera el umbral `memory.conflictThreshold`, `memory_save` devuelve `{ saved: false, candidates: MemoryConflictCandidate[], hint }` y el modelo reintenta con `resolution: "replace" | "link" | "keep_both"` (+ `targetId`). `replace` aplica §6.3 sobre el destino y crea `supersedes`; `link` crea `relates`/`contradicts` y deja ambas vigentes (la contradicha pasa a `contradicted` solo si el usuario confirma).

### 6.5 Frescura al recuperar (O5, D3)

En `memory_get`, `memory_context` y la vista web: si el registro tiene `git_commit` y `files`, se ejecuta `git diff --name-only <commit>..HEAD -- <files>` (límite 20 archivos, 2 s, caché `Map<commit+HEAD, resultado>`). Resultado no vacío ⇒ `mayBeStale: true`, `staleFiles`. Commit inexistente o git ausente ⇒ sin marca. Nunca modifica la base.

### 6.6 Abstención (O6)

`memory_search` mantiene su comportamiento y gana `evidence: "current" | "stale_only" | "none"`. Con `none`, `results` vacío y un `hint` («no current evidence; do not assume»). `stale_only` indica que solo hay resultados `obsolete|contradicted` o marcados `mayBeStale`; estos se devuelven pero etiquetados. La inclusión de `obsolete|contradicted` en resultados requiere `include_inactive: true`.

### 6.7 Herramientas (cambios aditivos)

| Herramienta | Cambio |
| --- | --- |
| `memory_save` | Parámetros opcionales `files`, `resolution`, `target_id`; respuesta con `candidates` o `previousRevision`. |
| `memory_search` | Parámetro `include_inactive`; respuesta con `evidence`, `status`, `mayBeStale` por fila. |
| `memory_get` | Devuelve procedencia, estado, enlaces entrantes/salientes y `mayBeStale`. |
| `memory_link` (**nuevo**, efecto `internal`) | Crea un enlace `relates|fixes|contradicts|supersedes` entre dos IDs. |
| `memory_status` (**nuevo**, efecto `internal`) | Cambia estado a `obsolete|contradicted`; `verified` requiere confirmación del usuario o `evidence_ref` (O2). |
| `memory_forget` | Sin cambio de contrato; borra también enlaces y revisiones de la fila. |

### 6.8 Secretos

Además de `redactPrivate`, un detector determinista de patrones de credenciales (claves con prefijos conocidos, bloques PEM, `Authorization: Bearer ...`) rechaza guardar con error explicativo. Es una red de seguridad, no una garantía; se documenta. Perímetro ya avisa en su export.

### 6.9 Consolidación de fin de sesión (O7)

En `api.session.onEnd`, `proposals.ts` genera candidatos desde los recuerdos de la sesión (sin modelo, determinista: observaciones de tipo `decision|architecture|learning` con `source_kind='agent'` sin `topic_key` estable) y los deja en `memory_proposals`. Web/TUI listan pendientes y permiten aceptar (se convierten en observación `source_kind='consolidation'`) o rechazar. Headless no solicita nada.

## 7. Persistencia y migración

- El plugin tiene su **serie propia** en `schema_migrations` (hoy 100 y 101). Las nuevas migraciones usan la **siguiente migración libre del plugin (102 si es la primera en ejecutarse)**, una por bloque (columnas, `observation_links`, `observation_revisions`, `memory_proposals`) para poder repartir fases. **No** consumen la numeración del core («siguiente migración libre (v11 si es la primera en ejecutarse)» aplica a `runtime/store.ts`).
- Cada migración es transaccional y usa `ALTER TABLE ... ADD COLUMN` con `DEFAULT`; se prueba sobre una copia de una base 101.
- Reversión: no hay reversión automática; la Fase 0 exige un respaldo (`.bak`) del archivo antes de migrar en la prueba en seco.

## 8. Superficies

- **Web (pestaña Memory):** cada registro muestra insignia de estado y `mayBeStale`, procedencia (sesión, commit corto, archivos, evidencia) y enlaces; acciones para marcar `obsolete`/`contradicted`/`verified` (con confirmación) y para aceptar/rechazar propuestas. Textos en `strings.ts` y `es.ts`. Captura en EN y ES.
- **TUI/headless:** las herramientas `memory_*` devuelven los nuevos campos; las propuestas quedan `pending` y se listan con un comando de plugin (`/memory proposals`, si el host lo permite; si no, solo vista web).
- **Contexto inyectado:** `memory_context` anota cada recuerdo con su estado y `mayBeStale`; si `specs/012-context-governor-v1.md` está activo, ese bloque entra como segmento con procedencia `memory`. Sin el gobernador, el formato solo gana la anotación.
- **Export/import:** el formato de `specs/018-perimeter-v1.md` (Fase 5) incluye `status`, `provenance`, `links` y `revisions`; se mantiene biyectivo.

## 9. Pruebas (estrategia)

- `tests/memory.test.ts` (ampliar): migración 101→102+ sin pérdida; upsert conserva revisión; estado por defecto; enlaces.
- `tests/memory-provenance.test.ts`: procedencia al guardar (con y sin repo git temporal), `files` validados, `evidence_ref` opaco.
- `tests/memory-freshness.test.ts`: repo git temporal con commits; archivo modificado ⇒ `mayBeStale`; commit inexistente o git ausente ⇒ sin marca; presupuesto de tiempo.
- `tests/memory-conflicts.test.ts`: candidatos para `decision|architecture`; `replace|link|keep_both`; sin conflicto ⇒ guarda directo.
- `tests/memory-abstention.test.ts`: `evidence: none|stale_only|current` con umbral calibrado.
- `tests/memory-proposals.test.ts`: cola `pending`, aceptar/rechazar, headless sin bloqueo.
- `tests/memory-views.test.ts` y `tests/web-memory.test.ts` (ampliar): render de estado, procedencia y acciones.
- `tests/memory-secrets.test.ts`: patrones rechazados, contenido benigno aceptado.
- Medición con `specs/archive/010-reliability-lab-v1.md`: suite de abstención/obsolescencia (recuerdo sembrado + cambio de código ⇒ el agente no lo presenta como vigente).

## 10. Fases

### Fase 0 — Medición y migración en seco (sin código de producción)

- Sobre una copia de una base real (anonimizada) medir: número de observaciones, proporción con `topic_key`, distribución de tipos, distribución de rangos BM25 de búsquedas reales de ejemplo (para calibrar O6 y O4), y tiempo de `git diff --name-only` en un repo mediano.
- Ensayar las migraciones propuestas sobre la copia (con respaldo).
- **Criterio de aceptación:** informe corto con umbrales propuestos para abstención y conflicto; el propietario fija O4–O6; sin cambios de producción.

### Fase 1 — Esquema y procedencia

- Migraciones 102+ (columnas), `provenance.ts`, `memory_save` rellena `source_kind`, `git_commit`, `files`; tipos aditivos; `memory_get` devuelve procedencia.
- **Aceptación:** AC1 (todo recuerdo nuevo es rastreable a sesión y commit cuando hay repo); filas previas intactas (`legacy`); toda la batería verde.
- **Pruebas:** `memory.test.ts` (migración), `memory-provenance.test.ts`.

### Fase 2 — Upsert sin pérdida y enlaces

- `observation_revisions`, `observation_links`, `memory_link`, `memory_status`; upsert crea revisión y `supersedes` (O3).
- **Aceptación:** AC4 (un upsert conserva la versión anterior enlazada); `memory_forget` limpia enlaces y revisiones.
- **Pruebas:** casos de upsert, enlaces, borrado.

### Fase 3 — Frescura y abstención

- Chequeo de frescura acotado y cacheado (O5), `mayBeStale`, `evidence` en `memory_search`, `include_inactive`.
- **Aceptación:** AC2 (una decisión cuyos archivos cambiaron desde su commit se muestra como posiblemente obsoleta); AC5 (búsqueda sin evidencia vigente devuelve abstención explícita).
- **Pruebas:** `memory-freshness`, `memory-abstention`.

### Fase 4 — Conflictos y secretos

- Detección en `decision|architecture` con candidatos y resolución (O4); detector de credenciales (§6.8).
- **Aceptación:** una decisión que choca con otra devuelve candidatos y no guarda hasta resolver; credenciales rechazadas con mensaje claro.
- **Pruebas:** `memory-conflicts`, `memory-secrets`.

### Fase 5 — Consolidación y vistas

- `proposals.ts` + cola; pestaña Memory con estado, procedencia, enlaces, acciones y propuestas; i18n EN/ES; TUI/plugin.
- **Aceptación:** AC3 (el usuario inspecciona y corrige estado y relaciones desde la UI); en headless las propuestas quedan `pending` sin bloqueo.
- **Pruebas:** `memory-proposals`, ampliación de `memory-views` y `web-memory`.

### Fase 6 — Export/import, medición y documentación

- Extender el formato de export/import de `specs/018-perimeter-v1.md` (coordinar el orden con esa spec; si Perímetro no se ha ejecutado, definir el esquema aquí y que Perímetro lo adopte); suite de abstención/obsolescencia en el laboratorio; docs EN/ES (`docs/memory.md`), `docs/implementation-status.md` (límites: frescura es heurística por archivos, no semántica), captura web en EN/ES.
- **Aceptación:** AC6 (round-trip export/import sin pérdida de estado, procedencia ni enlaces) y batería completa verde (`pnpm typecheck|lint|test|build|test:cli|test:compiled|pack:check|docs:check|docs:build`).

## 11. Criterios de aceptación globales

1. **AC1** Todo recuerdo nuevo es rastreable a sesión y commit (cuando hay repositorio).
2. **AC2** Una decisión incompatible con el commit actual (archivos referenciados cambiados) se muestra como posiblemente obsoleta, sin reescribirse.
3. **AC3** El usuario inspecciona y corrige estado y relaciones desde la UI.
4. **AC4** Un upsert por `topic_key` conserva la versión anterior enlazada (`supersedes`).
5. **AC5** Una búsqueda sin evidencia vigente devuelve una abstención explícita.
6. **AC6** Export/import conserva campos nuevos y relaciones (round-trip).
7. **AC7** Una base 100/101 migra sin pérdida y el plugin arranca con ella.

## 12. Asignación de modelos

Sonnet por defecto. **Opus solo en:** (a) diseño de la migración y de la semántica del upsert sin pérdida (Fases 1–2), (b) calibración y criterios de conflicto/abstención con los datos de Fase 0 (Fases 3–4), (c) revisión del texto de docs para no presentar la frescura como verificación semántica (Fase 6).

## 13. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Migración de bases existentes de usuarios | Forward-only, columnas con `DEFAULT`, ensayo en copia con respaldo, AC7. |
| Costo de `git` en cada recuperación | Solo en `get`/`context`/vista (no en `search`), caché por `HEAD`, límites de archivos y tiempo, `memory.freshness: "off"`. |
| Falsos «posiblemente obsoleto» (archivo tocado sin relevancia) | Es una marca informativa, no un cambio de estado; el usuario puede marcar `verified` con confirmación. |
| Falsos conflictos que molestan al guardar | Umbral conservador, `keep_both` siempre disponible; calibrar en Fase 0. |
| Secretos en memoria | `redactPrivate` + detector de patrones; documentado como red de seguridad, no garantía. |
| Crecimiento de la base por revisiones | Tope de revisiones por observación (p. ej. 20; las más antiguas se compactan al exportar), medido en Fase 0. |
| Interferencia con el export/import de Perímetro | Coordinar el esquema; D6 y AC6. |
| Plugin con core antiguo | Sin dependencias nuevas del core; `evidence_ref` y procedencia de segmento por feature-detect (D4). |

## 14. Decisiones abiertas (resumen)

Ver O1–O8 en §3.1. Las que bloquean la Fase 2 son **O3**; las de la Fase 3, **O5 y O6**; las de la Fase 4, **O4**; las de la Fase 5, **O7**. **O1, O2 y O8** pueden cerrarse durante la Fase 0.

## 15. Estado

**Borrador — 2026-10-13.** No se ejecuta hasta que el propietario confirme O1–O8 y revise el informe de la Fase 0.
