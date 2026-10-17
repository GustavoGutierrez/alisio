# Especificación Técnica: Context Governor — inventario, elisión determinista e invariantes del contexto

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 3 de 8** |
| Proyecto | Alisio |
| Estado | **Aprobada por el propietario (2026-10-15). NO implementada.** Decisiones O1..O8 confirmadas; sin preguntas abiertas. |
| Fecha | 2026-10-13 (aprobada 2026-10-15; base verificada re-auditada contra 0.8.0) |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: Fase 4 `ContextSegmentKind`, `ContextElisionReason`, `ContextUsageCounts`, `ContextGovernedData`; Fase 5 `ContextSegment`, `ContextReport`; `RunEventDataMap.context_reduced` gana campos opcionales; evento `context_governed`; sin `CompactionCheckpoint.invariants?`, D27), `@alisio/core` (nuevo `packages/core/src/context/*`; integración en `core/src/core/compaction.ts` y `core/src/core/runner.ts`; `resources/context.ts`; tool `context_explain`; `config.ts`; `commands/builtins.ts`), `@alisio/server` (ruta `GET /api/sessions/:sid/context`), `@alisio/web` (privado: panel de contexto, `src/i18n/{en,es}.ts`), `@alisio/alisio-code` (TUI: `/context`) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción. |
| Relación con otras especificaciones | Mide su efecto con `specs/archive/010-reliability-lab-v1.md` (suite `long-context`; puerta de promoción). Recibe invariantes de `specs/archive/011-proof-v1.md` (criterios vigentes) y de goal/plan. Los recuerdos de `specs/015-project-memory-v1.md` y las salidas de `specs/016-code-intelligence-v1.md` entran como segmentos con procedencia y criticidad. Se apoya en Forja (`js_run`, `forge_guide`, implementada en 0.6.0) como vía de exploración programática de contexto grande. Independiente de `specs/backlog/019-capability-routing-v1.md` (que reduce esquemas de herramientas, fuera de aquí) y de `specs/backlog/020-model-tier-router-v1.md`. |
| Superficies | Web, TUI y headless con paridad funcional; API HTTP de `alisio serve` |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar** (0.9.0 sobre la base 0.8.0). Aditiva: `context.governor` arranca en `off`; en `shadow` lo enviado al proveedor es byte-idéntico a la versión previa a esta spec (0.8.0). `RunEvent.schemaVersion` sigue en 1. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 (`main`, 0.6.0, `2e867c7`); **(no verificado)** = deducido o externo sin prueba ejecutada aquí; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Pruebas en `tests/*.test.ts` (vitest), sobre comportamiento en límites de módulo, sin instantáneas que repitan la implementación.
4. **Orden obligatorio**: Fase 0 (medición con el Reliability Lab o con un arnés mínimo) → el propietario revisa → Fases 1..7. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: Sonnet por defecto; Opus solo en los puntos de la §13.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo APIs portables de Node; ningún SDK de proveedor ni import de runtime en `@alisio/sdk` ni en contratos del core; plugins dependen solo de `@alisio/sdk`; **preservar IDs de tool calls, datos de continuación del proveedor y consistencia de la sesión persistida**; un manifiesto de plugin o un subproceso no es un sandbox.
7. Contratos **aditivos**; la proyección al proveedor puede cambiar con `governor: "on"`, pero el mensaje persistido nunca se altera (D1).
8. Idioma: identificadores, eventos y textos generados en inglés; UI en inglés y español; esta especificación en español. Documentación EN/ES en paridad; límites en `docs/implementation-status.md`.
9. Capturas Web UI: `docs/assets/web-ui/context_governor_web_ui.webp` (según `AGENTS.md`), en EN y ES.
10. Esta spec no necesita migración propia (D9). Si la Fase 6 decide persistir el ledger de uso, será «siguiente migración libre (v11 si es la primera en ejecutarse)».

## 1. Objetivo, usuarios y principio rector

### 1.1 Objetivo

Enviar al modelo el contexto **necesario y priorizado**, no solo el contexto que cabe: (1) inventariar los segmentos del prompt con tamaño, origen y criticidad; (2) eliminar de forma **determinista** lo redundante antes de recurrir a un resumen con modelo; (3) fijar **invariantes** que sobreviven a cualquier compactación; (4) explicar qué se descartó y por qué; (5) medir qué segmentos fueron realmente usados.

Hoy (verificado): `planCompaction()` corta solo en límites que no separan llamada/resultado (`boundaries()` en `core/src/core/compaction.ts`), `reduceMessagesToBudget()` recorta resultados de herramienta por tamaño (8 000 → 512 chars) y el checkpoint JSON conserva `goal, instructions, discoveries, accomplished, currentState, nextSteps, relevantFiles`. No hay inventario por segmento, ni elisión semántica (lecturas superadas), ni bloque de invariantes explícito, ni explicación de lo descartado más allá de `context_explain` (que explica la carga de AGENTS.md).

### 1.2 Usuarios

| ID | Persona | Qué le da el Governor |
| --- | --- | --- |
| U1 | Dev con sesiones largas | Menos tokens y menos olvidos de instrucciones tras compactar; ver qué se descartó. |
| U2 | Quien usa modelos locales o de contexto corto | Mejor uso de una ventana pequeña sin cambiar de modelo. |
| U3 | Quien mide y compara estrategias | Modo `shadow` y métrica observado/usado reproducibles con el Reliability Lab. |

### 1.3 Principio rector

> **El contexto es un presupuesto que se asigna con criterio y se explica; nunca se pierde en silencio lo que el usuario fijó.**

Reglas derivadas:

- Lo persistido no cambia; la elisión es una **proyección** al proveedor, determinista y reproducible (D1).
- Llamada y resultado nunca se separan; los IDs de tool calls se preservan (D2).
- Nunca se elide el último resultado de un path ni los resultados de la última vuelta (D3).
- Los invariantes no se resumen como texto prescindible (D4).
- Todo cambio de comportamiento por defecto está detrás de `shadow → on` con puerta de medición (D8).

### 1.4 Nombre

`Context Governor`, identificador `context` (config `context.governor`). Alternativas descartadas: `context-manager` (genérico), `budgeter` (solo cubre presupuesto).

### 1.5 Alcance

Inventario de segmentos; elisión por sustitución (lecturas superadas, `bg_output` antiguo, búsquedas duplicadas); bloque de invariantes (sin campo `invariants` en el checkpoint, D27); ledger observado/usado; política versionada `off|shadow|on`; `/context` en TUI y panel web; ampliación aditiva de `context_reduced`; pruebas de regresión de límites llamada/resultado; documentación.

### 1.6 Fuera de alcance

| Excluido | Motivo |
| --- | --- |
| Reducir esquemas/herramientas expuestas al modelo | Es `specs/backlog/019-capability-routing-v1.md`. |
| RAG / búsqueda semántica sobre documentos | Es la investigación aparte `specs/research/023-knowledge-vault-research.md`. |
| Embeddings, recuperación vectorial | Excluida en memoria y en el producto (sin red, sin embeddings). |
| Elegir modelo por tarea | Es `specs/backlog/020-model-tier-router-v1.md`. |
| Modificar el historial persistido | Viola D1 y la consistencia de sesión. |
| Resumir con un modelo distinto | La compactación existente (`CompactionHooks`) conserva su comportamiento; solo se extiende. |

## 2. Base verificada del código

| Hecho (verificado) | Ubicación | Implicación |
| --- | --- | --- |
| `planCompaction()`, `boundaries()`, `reduceMessagesToBudget()`, `renderCheckpoint()`, `checkpointInstructions()` | `packages/core/src/core/compaction.ts` (l.~95, ~242, ~363, ~376) | Puntos de extensión; la regla llamada/resultado ya existe y solo requiere prueba de regresión. |
| `CompactionCheckpoint {goal, instructions, discoveries, accomplished, currentState, nextSteps, relevantFiles}` | `packages/sdk/src/index.ts` l.~710 | No cambia: los invariantes viven en `sessions.options.contextInvariants`, no en el checkpoint (D27). |
| `CompactionStart {sessionId, reason: manual\|auto\|budget, messages, focus?, signal}` y `CompactionHooks` | `sdk/src/index.ts` l.~720+ | Los hooks de plugins siguen invocándose; el Governor aporta invariantes por el mismo camino. |
| `context_reduced: { messages: number }` | `sdk/src/index.ts` l.665 | Gana solo `reason?: "budget"` y `tokensSaved?` (Fase 4); la elisión nunca se informa aquí (D25). |
| Presupuesto y reducción en el bucle (`contextBudget`, `estimateContext`) | `core/src/core/runner.ts` (l.~1290–1365) | Punto de proyección y medición. |
| `ProjectContext` (AGENTS.md jerárquico + `beforePaths`); tool `context_explain` | `core/src/resources/context.ts` | Fuente de segmentos de instrucciones; `/context` se coordina con `context_explain`. |
| `read_file` devuelve `sha256`; `startLine`/`limit` | `tools/standard.ts` | Permite reconocer lecturas superadas por `(path, sha256)`. |
| `bg_output`, `search_text` y herramientas de lectura emiten resultados reconocibles por nombre | `tools/*` | Candidatos a elisión por sustitución. |
| Lotes paralelos y `executeCall()` preservan `callId` | `core/src/core/runner.ts` | La proyección debe respetar emparejamiento por `callId`. |
| `/stats` existe | `core/src/commands/builtins.ts` | Se añade resumen del Governor. |
| No existe inventario por segmento ni ledger observado/usado | — | **(nuevo)** `core/src/context/*`. |

## 3. Diseño

### 3.1 Inventario de segmentos

`buildInventory(messages, ctx)` (puro) devuelve `ContextSegment[]`. Cada segmento tiene `id` estable (`hash(role, callId|index, contentHash)`), `kind` (`system | instructions | user | assistant | tool_call | tool_result | checkpoint | invariant | memory | other`), `origin` (path, nombre de herramienta, `memory:<id>`), `tokens` (estimación existente), `criticality` y `elision` (cómo/por qué si se elidió). Criticidad: `pinned` (invariantes, instrucciones vigentes, objetivo), `high` (última vuelta, último resultado por path, aprobaciones), `normal`, `low` (lecturas superadas, salidas antiguas de fondo, duplicados).

### 3.2 Elisión por sustitución (determinista)

Reglas en `context/elide.ts`, aplicadas solo a la proyección y solo a segmentos `low` de vueltas **anteriores** a la última:

1. **Lectura superada**: dos `read_file` del mismo `path` con distinto `sha256`, o un `write_file/edit_file` posterior al mismo `path`: el resultado anterior se sustituye por `[elided: read_file <path>@<sha8>; re-read to view]`.
2. **`bg_output` antiguo**: salidas de la misma tarea de fondo anteriores a la más reciente.
3. **Búsquedas duplicadas**: mismo `search_text` (patrón + opciones) con resultado idéntico (`outputHash`).
4. Nunca se elide: el último resultado de un `path`; los resultados de la última vuelta; resultados con `isError` de la última vuelta; mensajes de usuario; cualquier segmento `pinned`.

**Correcciones de la Fase 2 (2026-10-16, confirmadas por el propietario):**

- **Regla 1, formato del stub (3.2.1):** el `path` se cita como JSON (`[elided: read_file "src/a.ts"@<sha8>; re-read to view]`) para que una ruta con comillas o saltos de línea no rompa la línea ni el análisis; si la lectura pidió `startLine`/`limit`, se añade ` lines <startLine>+<limit>` antes del `;`; sin `sha256` (archivo de más de 1 MiB) el stub dice `@unknown`.
- **Regla 2, `bg_output` (3.2.2), estrechada:** la lectura literal «anteriores a la más reciente» destruiría información, porque `bg_output` es incremental (`offset`/`next_offset`). Solo se elide si existe un `bg_output` posterior de la misma tarea con argumentos normalizados idénticos (`offset` por defecto 0, `limit` por defecto el de la herramienta) **o** si el resultado anterior es una consulta vacía (`text === ""`) y existe una posterior.
- **Regla 3, búsquedas duplicadas (3.2.3):** el `outputHash` se calcula sobre el código de salida y las líneas `match`/`context` del JSON de ripgrep, no sobre el texto crudo, porque `elapsed` aparece en las líneas `summary`/`end` y haría que dos búsquedas idénticas nunca coincidieran. Si el texto no se puede interpretar, se usa el hash del texto crudo. El inventario usa el mismo predicado.
- **Todas las reglas son existenciales** («existe un resultado posterior»), con el testigo más temprano, y el testigo debe ser un resultado sin error. Esto corrige el parpadeo de `a → b → a` que tenía la comparación «última lectura posterior» de la Fase 1 y hace el conjunto de candidatos monótono al añadir mensajes.
- **Antigüedad y épocas:** la antigüedad es el número de mensajes del asistente posteriores dentro del prefijo elegible; un resultado dentro de la ventana protegida se elide más tarde **por envejecimiento**, una sola vez. Con `epochMessages` E > 0 solo el prefijo `floor(n / E) * E` es elegible.

La sustitución conserva el mensaje `tool_result` con su `callId` y rol; solo cambia el contenido textual de la proyección (D2). La función es **monótona y estable**: dado el mismo historial produce la misma proyección y, al añadir mensajes, no reescribe elisiones anteriores salvo que un nuevo mensaje supere una lectura (así se protege la caché de prompt del proveedor).

### 3.3 Invariantes

`collectInvariants(input)` reúne, en este orden fijo: (1) las **instrucciones del usuario** guardadas, (2) el objetivo del goal vigente (`active|paused|blocked|budget_limited`), (3) el plan aprobado (`approved|implementing`: título, revisión y prefijo del hash), (4) los criterios de `specs/archive/011-proof-v1.md` si existe `proof` (feature-detect; texto y `[required]`/`[optional]`, sin estado en vivo y sin los que tienen `notApplicableReason`) y (5) los permisos de sesión: solo efectos aprobados para la sesión, capacidades concedidas para la sesión y un **recuento** de directorios externos (nunca rutas, scripts ni argumentos; sin modo de permisos). Se deduplica por texto exacto con espacios normalizados (gana el primero).

Las instrucciones **no** son «mensajes marcados» ni se extraen del campo `instructions` del checkpoint (el resumidor las parafrasea). Cuando el governor está en `on`, el resumidor recibe un campo extra de nivel superior `alisio_invariants`: citas literales de mensajes del usuario. Solo se aceptan las citas que son **subcadena exacta** (con espacios colapsados) de un mensaje `user` normal (no `summary`) de los que se resumen; se descartan paráfrasis, citas del asistente, de resultados y de checkpoints. Se guardan, con tope de 20 elementos de 500 caracteres (con la lista llena se conservan las más antiguas y se cuentan los rechazos), en `sessions.options.contextInvariants` (`{version: 1, instructions, compactions, updatedAt}`, clave del servidor, sin migración, D9) antes de `store.compact`. `renderCheckpoint()` **no** emite invariantes y el esquema del checkpoint descarta cualquier `invariants` que el modelo ponga dentro de `checkpoint`; el resumen con modelo nunca recibe el bloque (D4).

Se renderizan en un bloque `<invariants policy="1">` (cabecera fija, secciones en orden fijo, cada elemento una línea `JSON.stringify` con `</invariants` escapado, nunca cortado; límite `context.invariants.maxChars`, pie `[N invariants omitted: context.invariants.maxChars]`). El bloque es un último mensaje `user` **transitorio**: se construye en cada petición, nunca se guarda, se añade tras la proyección de la Fase 2 y antes del aviso de recuperación, y no entra en el array que recibe `projectContext` (jamás es candidato a elisión). Se inyecta solo si el historial activo empieza por un checkpoint de compactación (`messages[0].summary` y texto que empieza por `[Checkpoint of`) o `contextInvariants.compactions > 0`; nunca antes de la primera compactación. Las sesiones con checkpoints de texto antiguos no se analizan: reciben solo las fuentes en vivo.

### 3.4 Ledger observado/usado

`UsageLedger` (`context/usage.ts`, puro y determinista) mide, por **resultado de herramienta** (unidad = un `tool_result` con su `callId`), si el agente actuó después sobre el mismo **path**. Solo se calcula en `shadow|on`, vive en memoria del runner por sesión (D9, O5, D37) y nunca decide elisión: es una métrica orientativa y la puerta de la Fase 6 no la usa.

- **Atribuible:** resultados de efecto `read` con paths: `read_file` (su `path`), `list_files` (los archivos listados), `search_text` (los paths de las líneas `match` de ripgrep; el argumento `path`, casi siempre `.`, se ignora) y herramientas que declaran `ToolDefinition.paths`. Todo lo demás (`bg_output`, web, salida de `run_process`/`shell`, resultados de escritura, errores, texto de usuario/asistente) es `unattributed` y nunca entra en un cociente. El cociente se muestra por herramienta (`byTool`); `byKind` solo tiene `tool_result` en v1.
- **Normalización:** ruta POSIX, sin `./`, relativa al workspace si está dentro (ripgrep devuelve rutas absolutas), sin `/` final, sin plegar mayúsculas; fuera del workspace queda absoluta.
- **Observado:** la primera vez que su resultado está en el historial enviado. En `on`, un resultado visto por primera vez como stub es `stubOnly` y no cuenta como observado; uno visto completo y elidido después sigue observado (D31). En `shadow` el modelo vio todo, así que `stubOnly` es 0.
- **Decidible:** solo entra en el denominador cuando existe una petición posterior; lo observado únicamente en la última petición es `pending`.
- **Usado:** una llamada del asistente que aparece por primera vez en una petición posterior a la que contenía el resultado, que nombra un path de sus claves (argumento `path`, `paths(args)` declarado o, para `run_process`/`shell`, el path como palabra completa del comando con delimitadores de espacio, comillas o `=:(),;`, heurística documentada). No cuentan la llamada propia del resultado ni **releer** el mismo path con `read_file`, que se registra en `rereads` (D30).
- **Límites honestos:** «usado» significa que el agente actuó sobre ese sujeto después, no que ese contenido exacto hiciera falta. Falsos positivos (lectura superada seguida de edición del mismo archivo, un path ajeno dentro de un comando, una llamada iniciada por la UI que parece del modelo) y falsos negativos (respuesta en texto, hechos usados en otro archivo, símbolos (spec 016), rutas renombradas, herramientas sin paths, la respuesta final sin petición posterior). Las cifras cubren este proceso y esta sesión; topes: 4096 entradas por sesión, 32 claves por entrada, 64 sesiones por runner (D36).

### 3.5 Política versionada

`context.governor: "off" | "shadow" | "on"` (config global/proyecto; default `off`). `context.policyVersion` entero que se emite en cada evento. `off`: sin cambios. `shadow`: calcula inventario, elisiones y métricas, **no** cambia lo enviado (byte-idéntico a la base 0.8.0). `on`: aplica la proyección. El paso a default `shadow` y luego `on` requiere la puerta de la Fase 6.

### 3.6 Explicación y superficies

`context_explain` (tool existente) se mantiene; `/context` (TUI/web) muestra segmentos, tamaños, criticidad, qué se elidió y la razón, `usedRatio` y los invariantes. `context_reduced` conserva su único punto de emisión (recorte en sitio por presupuesto) y gana `reason?: "budget"` y `tokensSaved?`; la elisión **solo** se informa en el evento `context_governed` (forma de `ContextGovernedData`, §4), uno por **petición al modelo** en `shadow|on` (no por reintento silencioso; una recuperación por truncamiento es una petición nueva), duradero y acotado (enteros, claves de enumeración, nombres de herramienta e IDs de llamada; los IDs son solo los recién elididos, máximo 32, más `elidedCallIdsOmitted`).

### 3.7 Exploración de contexto grande

Cuando un resultado supera el umbral, el stub sugiere releer por rango (`read_file startLine/limit`) o explorarlo programáticamente con `js_run` (Forja) usando `forge_guide`; el Governor no ejecuta código por sí mismo.

## 4. Contratos y tipos (SDK, aditivos)

```ts
export type ContextSegmentKind =
  | "system" | "instructions" | "user" | "assistant"
  | "tool_call" | "tool_result" | "checkpoint" | "invariant" | "memory" | "other";
export type ContextCriticality = "pinned" | "high" | "normal" | "low";

export interface ContextSegment {
  id: string;
  kind: ContextSegmentKind;
  origin?: string;           // path, tool name or memory:<id>
  callId?: string;
  tokens: number;
  criticality: ContextCriticality;
  elided?: { reason: "superseded_read" | "stale_bg_output" | "duplicate_search"; replacedBy?: string };
  used?: boolean;
}

export interface ContextReport {
  sessionId: string;
  policyVersion: number;
  mode: "off" | "shadow" | "on";
  segments: ContextSegment[];
  tokensBefore: number;
  tokensAfter: number;
  invariants: string[];
  usedRatioByKind: Partial<Record<ContextSegmentKind, number>>;
}
```

- Sin `CompactionCheckpoint.invariants?` (D27): el campo se retira de esta spec.
- Fase 4 (SDK, solo tipos de evento): `ContextSegmentKind`, `ContextElisionReason`, `ContextUsageCounts` y `ContextGovernedData` (`{policyVersion, mode, request, messages, segments, elided, byReason, tokensBefore, tokensAfter, tokensSaved, elidedCallIds?, elidedCallIdsOmitted?, invariants?, usage?}`). `ContextSegment` y `ContextReport` llegan en la Fase 5. `schemaVersion` sigue en 1.
- `RunEventDataMap.context_reduced`: `{ messages: number; reason?: "budget"; tokensSaved?: number }`.
- `RunEventDataMap.context_governed`: `ContextGovernedData` (ver §3.6).
- Ruta `GET /api/sessions/:sid/context` → `ContextReport` (solo lectura).
- Config: `context.governor`, `context.elide.minAgeTurns` (default 2), `context.invariants.maxChars` (default 4000).

## 5. Fases

Cada fase: Rojo → Verde → Refactor; repo verde al cerrar; sin commit hasta que lo pida el propietario.

### Fase 0 — Medición base (sin código de producción)

Trabajo: con `specs/archive/010-reliability-lab-v1.md` (Fase 0) o un arnés mínimo en `scripts/`, medir en sesiones sintéticas largas: tokens enviados por vuelta, proporción de resultados `read_file` superados, número de compactaciones y pérdida de instrucciones tras compactar (suite `long-context`). Fijar el umbral de «sin caída de éxito» (p. ej. ≤2 puntos).
Aceptación: línea base documentada en esta spec; umbral aprobado por el propietario.
Pruebas: ninguna de producción.

#### Registro de la Fase 0 (2026-10-15/16; **cerrada por el propietario el 2026-10-16**)

Estado: **Fase 0 CERRADA (2026-10-16).** El propietario revisó el registro y aprobó el protocolo de la puerta (sustituto de O2). Todo es de la jornada del 2026-10-15, harness 0.8.0, modo live, `--seed 12`, y se reporta como medido salvo donde se marca otra cosa.

**Decisiones de la Fase 0 (propietario, 2026-10-15).** Variante `small-context` = `limits.maxContextChars: 40000` (`STRESS_COMPACTION_LIMIT_CHARS`); `maxTokens` 450000 por run; se usa el incidente `compaction` existente (sin `measured.compactions` ni cambios en `@alisio/sdk`); la línea base oficial usa la API directa `deepseek-flash`; la Fase 1 no arranca antes de esta revisión.

**1. Línea base oficial: `long-context-stress` v1.0.0 (4 tareas), `deepseek-flash` (API directa de DeepSeek, nombre de DeepSeek-V4.1-Flash), `eval variants`, k=5, 40 runs, `--allow-write`.** 0 errores de infraestructura, 0 `HTTP 400`.

| Tarea | `default-limit` | `small-context` | Compactaciones por run (`small-context`) | Veredicto del Lab |
| --- | --- | --- | --- | --- |
| `chain-walk-format-rule` | 5/5 [56,6%, 100%] | **2/5** [11,8%, 76,9%] | 1,8 | inconcluso (intervalos solapados) |
| `frozen-area-tickets` | 5/5 | 5/5 | 2,4 | inconcluso |
| `order-ledger-reconcile` | 5/5 | 5/5 | 1,0 | inconcluso |
| `sequential-config-edits` | 5/5 | 5/5 | 0,6 | inconcluso |
| **Total** | **20/20** | **17/20** | | |

- `configHash`: `default-limit` `sha256:61333653…08b4c0`; `small-context` `sha256:3ff71449…be3c1ee`. Con `default-limit` no hubo ninguna compactación (0 en las 20 runs).
- Tokens de entrada por run (media): `default-limit` 155k a 254k; `small-context` 136k a 268k. **No se comparan** deltas de tokens: los de compactación no entran en el main loop (el Lab lo declara no comparable). Los tokens del resumidor siguen sin medirse.
- **Señal (corregida, ver punto 5):** la brecha (−3 de 20 runs, −60 pp en esa tarea) viene de `chain-walk-format-rule` (5/5 → 2/5), pero el análisis de las sesiones muestra que **no es pérdida de la regla**: es una mala lectura de un enunciado ambiguo tras la paráfrasis del resumen. Con k=5 el Lab no declara dirección y Fisher da p≈0,08 (una cola, cálculo propio, no del Lab).
- **Saturación:** tres de las cuatro tareas pasan 5/5 en ambas variantes y no discriminan, y la cuarta mide ambigüedad (punto 5); `sequential-config-edits` compacta solo 0,6 veces por run. Ninguna tarea de la suite 1.0.0 sirve como control positivo.
- **Consecuencia para O2:** un umbral de ≤2 pp no es medible (con 5/5 el intervalo de Wilson es [56,6%, 100%] y haría falta del orden de miles de runs por brazo). Se propone sustituirlo por el **protocolo de la puerta de la Fase 6** (más abajo), aprobado por el propietario el 2026-10-16.

**2. Suite `long-context` v1.0.0 (3 tareas, k=5), `opencode-go/deepseek-v4.1-flash`.** 14/14 juzgados pasan (1 error `HTTP 400`); ~3 turnos y ~18k tokens de entrada por run; sin compactación. **Saturada**: no sirve como puerta de la Fase 6 y no se modificó, para conservar su línea base.

**3. `HTTP 400` en OpenCode (causa no determinada).** En el piloto con `opencode-go/deepseek-v4.1-flash` (k=2, 16 runs), 4 terminaron en `OpenCode request failed: HTTP 400` entre los turnos 1 y 3. El plugin externo `@alisio/plugin-opencode-go` 0.1.6 descarta el cuerpo de error (`dist/provider.js:56`). Con la API directa no apareció en 14 runs de diagnóstico (2 + 12, con capturador de `fetch`) ni en los 40 de la línea base: es consistente con un fallo del plugin o del proveedor OpenCode, **no demostrado**. Los resultados de OpenCode y de la API directa no son comparables entre sí.

**4. Archivos añadidos en esta fase (sin commit).** `tests/fixtures/eval/long-context-stress/` (suite, `compare.json`, fixtures), `scripts/eval-gen-long-context-stress.ts` (`pnpm eval:gen-stress`), referencias en `scripts/eval-record-bundled.ts`, pruebas en `tests/eval-bundled-suites.test.ts` y `tests/eval-ci.test.ts`, y docs EN/ES en `docs/eval.md`, `docs/es/eval.md`, `docs/limitations.md` y `docs/implementation-status.md`. Verificado el 2026-10-15: `pnpm build`, `pnpm test` (4520 pruebas), `typecheck`, `lint`, `docs:check` y `docs:build` en verde; **pendientes** `test:cli`, `test:compiled` y `pack:check`.

**5. Corrección de la señal de `chain-walk-format-rule` (2026-10-16).** Se repitió la tarea con `deepseek-flash`, `small-context`, 6 runs y `--keep` (semilla 40: 3 pasan, 3 fallan; acumulado con `small-context` 6/14) y se leyeron las 6 sesiones conservadas. El checkpoint de compactación **conserva la regla casi literal** en las 6, también en las que fallaron. Los 3 fallos escriben `01|CODE: amber-meadow-21` (con `CODE:` literal): la regla del prompt dice «exact form NN|CODE:» con ese `CODE:` literal, y el resumen la parafrasea como `NN|CODE: <value>`. **La tarea mide una mala lectura de un enunciado ambiguo tras una paráfrasis, no pérdida de reglas**; la lectura «fallar es perder la regla tras compactar» de los puntos de arriba queda corregida. No es válida como puerta. Evidencia: sesiones temporales (`/tmp/alisio-eval-*`), no persistidas.

**6. Criba de modelos (2026-10-16; `chain-walk-format-rule`, `small-context`, k=5, perfil `opencode-go`).** `glm-5.3-flash` 5/5 (5 compactaciones en todos los runs) y `mimo-v2.6-flash` 5/5 (1 a 6), sin errores: tampoco pierden la regla. `qwen3.8-flash`: 5 de 5 runs con `HTTP 401` («Go requires a credential») en la ruta `/zen/go/v1/messages`; causa probable sin verificar: el plugin solo envía `Bearer` y `anthropic-version` en esa ruta. El catálogo `GET /zen/go/v1/models` respondió 200 con 37 modelos y no informa de la ventana de contexto.

**7. Suite 1.1.0 y piloto de `chain-walk-rules` (2026-10-16).** Se añadió la tarea `chain-walk-rules` (5 instancias, tres reglas sin ambigüedad con un verificador por regla, `--instances`; suite `long-context-stress` 1.1.0, 9 tareas; las 4 originales intactas). Piloto con `deepseek-flash`, `eval variants`, k=2 por instancia: `default-limit` 10/10 y `small-context` 10/10 (0,7 compactaciones por run), 0 errores. **No discrimina**: con reglas sin ambigüedad el modelo las retiene. Es coherente con la criba (punto 6).

**Riesgo conocido.** Un modelo que usa `search_text` para saltar entre archivos puede resolver tareas con menos turnos y compactar menos. Los reportes crudos de la línea base viven en el scratchpad de la sesión (temporal); lo relevante está resumido arriba.

#### Protocolo de la puerta de la Fase 6 (**aprobado por el propietario el 2026-10-16**; T por fijar tras las Fases 1 y 2)

Sustituye el criterio «≤2 pp en `long-context`» de O2. Motivo (medido, ver el registro de la Fase 0): `long-context` está saturada, un umbral de 2 pp exigiría miles de runs por brazo, y la única tarea que parecía discriminar (`chain-walk-format-rule`) resultó medir la ambigüedad de su enunciado y no la pérdida de reglas. Los parámetros de abajo se fijan **antes** de medir; cambiarlos tras ver datos obliga a una nueva versión de este protocolo con la razón escrita.

**Tres afirmaciones, tres tipos de prueba.**

| ID | Afirmación | Tipo | Cómo se prueba |
| --- | --- | --- | --- |
| G1 | El Governor reduce los tokens enviados | Determinista | Reproducir sesiones largas grabadas con `off` y `on` y comparar tokens de entrada por vuelta y acumulados (medidos con el `usage` del proveedor cuando exista, estimados y etiquetados en otro caso). Umbral mínimo de reducción **T: por fijar por el propietario** con los datos de las Fases 1 y 2; no se inventa aquí. Sin estadística. |
| G2 | Se respetan las invariantes | Determinista | Pruebas de propiedad (llamada/resultado emparejados, D2, D3, D4) y criterios 1 a 4 de la sección 10. |
| G3 | El éxito no cae más de M | Estadística | Prueba de no inferioridad (abajo). Es un guardarraíl, no el objetivo. |

**G3: prueba de no inferioridad.**
- **Comparación primaria:** `context.governor=on` frente a `off`, ambos con `limits.maxContextChars: 40000` (la variante `small-context`), mismas tareas y semillas. `default-limit` es el techo de referencia, no el comparador.
- **Hipótesis:** H0: `p_on − p_off ≤ −M`. Se rechaza H0 (la puerta pasa) si el límite inferior del intervalo de confianza unilateral del 95% de `p_on − p_off` es mayor que `−M`. Intervalo: Newcombe (Wilson híbrido) para dos proporciones independientes; es un cálculo propio de `scripts/`, porque el veredicto del Lab («intervalos de Wilson disjuntos») es mucho más conservador y no es una prueba de no inferioridad.
- **Parámetros:** α = 0,05 unilateral; potencia 80%; **M = 10 pp** (confirmado por el propietario el 2026-10-16).
- **Tamaño de muestra (fijo de antemano, sin parada anticipada):** `n = ceil((1,645 + 0,8416)² · 2·p·(1−p) / M²)` por brazo, con `p` = tasa de éxito de `off` observada en un piloto previo, redondeado hacia arriba. Valores por brazo (M = 10 pp / M = 15 pp): p = 0,85: 158 / 71; p = 0,90: 112 / 50; p = 0,95: 59 / 27; p = 0,98: 25 / 11 (cálculo propio, verificado el 2026-10-16). Cada brazo debe tener al menos 30 runs y estar repartido en partes iguales entre las instancias de `chain-walk-rules` (`--instances` ≥ 5) y las demás tareas de la suite.
- **Modelos:** al menos dos de proveedores o familias distintos; el Governor debe pasar en **todos**. Primario: `deepseek-flash` (API directa). Segundo modelo: **`opencode-go/mimo-v2.6-flash`** (confirmado por el propietario el 2026-10-16; medido sin errores en la criba; `glm-5.3-flash` queda de reserva; `qwen3.*` y `minimax-*` descartados por `HTTP 401` en la ruta `messages` del plugin). Riesgo conocido: el plugin descarta el cuerpo de los errores, así que un `HTTP 400` no se podría diagnosticar sin el capturador de `fetch`.
- **Control negativo (validez):** `default-limit` debe superar el 85% de éxito con cada modelo; si no, ese modelo no es válido para la puerta.
- **Runs con error:** se excluyen de las tasas (es la regla del Lab), pero si superan el 10% de un brazo la medición no es válida: se arregla la causa y se repite el brazo completo.
- **Decisión:** puerta superada = G1 (≥ T) y G2 y G3 en todos los modelos, sin degradación relevante de `cachedInput` (sección Fase 6). En cualquier otro caso el default queda `off` y se documenta el resultado. No hay estado «inconcluso»: con n fijado de antemano, un intervalo ambiguo se informa como no superada.
- **Entregable de la Fase 6:** `scripts/governor-gate.ts` (calcula n, el intervalo de Newcombe y el veredicto a partir de los `runs.jsonl` del Lab), con pruebas unitarias sobre tablas de casos conocidos.

**Límite conocido (no se oculta).** No existe hoy una tarea donde la compactación actual degrade el éxito de forma demostrada (no hay control positivo): con las suites medidas, la puerta puede probar que el Governor **no empeora** el éxito, no que lo **mejore**. El valor del Governor se demuestra en G1. Si más adelante se encuentra una tarea sin ambigüedad donde `small-context` pierda éxito de forma reproducible, se añadiría un contraste de superioridad (con 18 a 33 runs por brazo si el efecto es de 40% a 70–80%; cálculo propio), sin cambiar G1 a G3.

### Fase 1 — Inventario y regresión de límites

Trabajo: `core/src/context/{types,inventory}.ts`; clasificación de criticidad; prueba de regresión de que `planCompaction`/`reduceMessagesToBudget` nunca separan llamada y resultado.
Aceptación: (1) llamada y resultado nunca se separan en ninguna proyección (propiedad sobre historiales generados con `mulberry32` de `scripts/bench/lib.ts`); (2) el inventario explica cada segmento con kind, origen y criticidad; (3) con `off` nada cambia.
Pruebas: `tests/context-inventory.test.ts`, `tests/context-boundaries.test.ts` (propiedad: IDs emparejados tras cualquier corte).

### Fase 2 — Elisión determinista (proyección)

Trabajo: `context/elide.ts` con las tres reglas; integración en la construcción de mensajes del runner solo para `on`; `shadow` calcula sin aplicar.
Aceptación: (1) el último resultado de un path y la última vuelta nunca se elide; (2) la proyección es estable y monótona entre vueltas; (3) en `shadow` los bytes enviados son idénticos a 0.6.x; (4) el mensaje persistido no cambia.
Pruebas: `tests/context-elide.test.ts` (tabla de casos, estabilidad al añadir mensajes), `tests/context-shadow-identity.test.ts` (comparación byte a byte del payload con `off`).

### Fase 3 — Invariantes y checkpoint

Trabajo: `collectInvariants`, bloque `<invariants>` (sin campo `invariants` en el checkpoint, D27), reinyección tras compactar; feature-detect de criterios de Proof.
Aceptación: los invariantes sobreviven a N compactaciones consecutivas (N≥5) sin duplicarse ni resumirse; un checkpoint sin `invariants` (sesión antigua) se lee sin error.
Pruebas: `tests/context-invariants.test.ts` (N compactaciones, límite `maxChars`, checkpoints antiguos), ampliación de las pruebas de compactación sin cambiar sus expectativas.

Registro de implementación (2026-10-16): implementada en la rama `feat/eval-long-context-stress-phase0` (sin commit al escribir esto) con las decisiones D15 a D24. Ficheros: `context/invariants.ts`, `context/sources.ts`, `core/compaction.ts` (`INVARIANTS_FIELD` y tercer parámetro de `checkpointInstructions`), `core/runner.ts` (`invariantSources`, bloque transitorio, promoción en `compactLocked`, `clearInvariants`), `core/contracts.ts` (`mutateSessionOptions?` opcional), `config.ts`, `eval/engine.ts` y `application.ts`. Pruebas: `tests/context-invariants.test.ts`, `tests/context-invariants-runner.test.ts` (6 compactaciones consecutivas con SQLite real), `tests/context-sources.test.ts` y ampliaciones de `compaction`, `config-layers`, `eval-engine` y `context-shadow-identity` sin cambiar ninguna expectativa existente. `@alisio/sdk` no cambia; el campo `CompactionCheckpoint.invariants?` se retiró en la Fase 4 (D27).

### Fase 4 — Ledger observado/usado y eventos

Trabajo: `usageLedger`; eventos `context_governed` y ampliación de `context_reduced`; resumen en `/stats`.
Aceptación: `usedRatio` se calcula sin anotación manual; los eventos no incluyen contenido, solo conteos e IDs.
Pruebas: `tests/context-usage.test.ts`, `tests/context-governed-event.test.ts`, `tests/context-governed-runner.test.ts`, `tests/context-governor-stats.test.ts`, prueba de esquema de eventos (`tests/run-events-contract.test.ts`).

Registro de implementación (2026-10-16): implementada en la rama `feat/eval-long-context-stress-phase0` (sin commit al escribir esto) con las decisiones D25 a D39. Ficheros: `context/usage.ts`, `context/format.ts`, `context/governance.ts` (`segments`, `newlyElided`, `governedEventData`), `context/inventory.ts` (`countSegments`), `core/runner.ts` (alimentación del ledger y emisión en el punto del governor, `contextUsage()`), `commands/catalog.ts` y TUI (`/stats`), `packages/sdk/src/index.ts` (solo tipos de evento), `packages/web/src/store/trajectory.ts` (resumen de fila) y la retirada de `GovernedCheckpoint`. Se cambió una expectativa existente por exigencia del diseño: `tests/runner-truncation.test.ts` (dos aserciones de `context_reduced`, que ahora lleva `reason: "budget"` y `tokensSaved`).

### Fase 5 — Superficies

Trabajo: ruta `GET /api/sessions/:sid/context`; panel web; `/context` en TUI; salida en headless (`--json` emite `context_governed`); i18n EN/ES; captura `context_governor_web_ui.webp`.
Aceptación: TUI, Web y JSONL muestran los mismos segmentos y razones desde el mismo `ContextReport`.
Pruebas: `tests/context-routes.test.ts`, pruebas de componente web del panel.

### Fase 6 — Puerta de medición y promoción

Trabajo: ejecutar la suite `long-context` del Lab con `off` vs `on` (y `shadow`); medir tokens por tarea, éxito, `cachedInput` del proveedor y latencia; decidir default.
Aceptación: reducción de tokens medida **sin caída de éxito mayor al umbral de la Fase 0** y sin degradación de `cachedInput` relevante; si no se cumple, el default queda `off` y se documenta el resultado. Resultados reportados como medidos (no estimados).
Pruebas: el propio Lab; sin pruebas unitarias nuevas.

Ver el **Protocolo de la puerta de la Fase 6** (G1 a G3), aprobado por el propietario el 2026-10-16 bajo el registro de la Fase 0; es lo que cuenta como «umbral de la Fase 0» en esta fase y en la sección 10.

### Fase 7 — Documentación y estado

Trabajo: `docs/context-governor.md` EN/ES en paridad; `docs/implementation-status.md` con límites; entrada de changelog.
Aceptación: `pnpm docs:check` y `pnpm docs:build` en verde.

## 6. Seguridad y privacidad

- El Governor no decide permisos ni modifica grants; solo lee su estado para el bloque de invariantes.
- Los stubs incluyen `path` y `sha8`; los eventos no incluyen contenido ni paths: solo enteros, claves de enumeración, nombres de herramienta e IDs de llamada.
- Los invariantes pueden contener instrucciones del usuario: no se envían a ningún sitio distinto del proveedor ya configurado; el reporte web respeta el mismo control de acceso de sesión.
- Una proyección con elisión se rige por la política de la sesión; un resultado de herramienta no puede pedir que se desactive la elisión.

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Elidir algo que el modelo necesita | Stub con instrucción de releer; nunca elidir el último resultado por path ni la última vuelta; puerta de medición. |
| Romper la caché de prompt del proveedor | Elisión estable y monótona; medir `cachedInput`; si empeora, no se promueve. |
| Divergencia entre persistido y enviado | Documentada; la proyección es determinista y reproducible desde el historial. |
| Invariantes que inflan el prompt | Límite `invariants.maxChars` y deduplicación. |
| Estimación de tokens imprecisa | Etiquetar medido vs estimado; usar el `usage` real del proveedor cuando exista. |
| Heurística de «usado» con falsos negativos | Es métrica orientativa, no decide elisión. |

## 8. Decisiones del propietario (O1..O8, confirmadas el 2026-10-15)

| ID | Pregunta | Decisión confirmada |
| --- | --- | --- |
| O1 | ¿Default inicial de `context.governor`? | `off`; pasar a `shadow` en la siguiente minor y a `on` solo tras la puerta de la Fase 6. |
| O2 | ¿Umbral de «sin caída de éxito»? | Confirmado el 2026-10-15: ≤2 pp en `long-context`. **Sustituida el 2026-10-16 por el propietario** con el protocolo G1 a G3 de la Fase 6 (no inferioridad con M = 10 pp; ver el protocolo bajo la Fase 0), porque la Fase 0 mostró que ≤2 pp no es medible. |
| O3 | ¿Antigüedad mínima para elidir? | 2 vueltas (`minAgeTurns`), configurable. |
| O4 | ¿Los invariantes incluyen aprobaciones de sesión? | Sí, como texto breve («grants activos»), sin valores sensibles. |
| O5 | ¿Persistir el ledger observado/usado? | No en v1 (memoria de sesión + eventos); revisar tras la Fase 6. |
| O6 | ¿Mostrar `/context` en la TUI desde el inicio? | Sí (Fase 5), paridad con web. |
| O7 | ¿Aplicar a subagentes? | Sí, misma proyección por sesión hija, con su propio inventario. |
| O8 | ¿Elisión de resultados `webfetch`/`websearch` antiguos? | No en v1 (riesgo de perder fuentes); reevaluar con datos. |

## 9. Decisiones de diseño (D1..D9, vinculantes)

- **D1** La elisión es de proyección; el mensaje persistido no se altera.
- **D2** Llamada y resultado nunca se separan; los `callId` y datos de continuación del proveedor se preservan.
- **D3** Nunca se elide el último resultado de un `path`, la última vuelta ni los mensajes del usuario.
- **D4** Los invariantes se reinyectan literales y no se resumen.
- **D5** La proyección es determinista, estable y monótona.
- **D6** `shadow` es byte-idéntico a la base 0.8.0 en lo enviado.
- **D7** Todo evento es acotado y sin contenido de archivos.
- **D8** Ningún cambio de default sin pasar la puerta de medición de la Fase 6.
- **D9** Sin migración de base de datos en esta versión.
- **D10** (Fase 2, 2026-10-16) **Elisión por épocas:** `context.elide.epochMessages` (por defecto 32; 0 = inmediata). Solo el prefijo `floor(n / E) * E` del historial es elegible, para que la petición crezca solo añadiendo al final entre épocas y la caché de prompt del proveedor siga válida.
- **D11** (Fase 2) **`context.policyVersion` es una fijación opcional:** sin definir equivale a la versión actual (`CONTEXT_POLICY_VERSION`, hoy 1); el rango permitido es 1..versión actual y `policyVersion: 2` se rechaza hoy.
- **D12** (Fase 2) **Los `configHash` de la Fase 0 siguen siendo válidos:** `computeConfigHash` omite `governor`, `elide` y `policyVersion` cuando el governor es `off` y el resto son los valores por defecto. Una prueba fija el hash de la configuración por defecto. Fase 3: `context.invariants.maxChars` se une a esa exclusión (se omite con el governor en `off` y `maxChars` = 4000).
- **D13** (Fase 2; enmendada en la Fase 3) **El Governor solo proyecta lo que se envía al proveedor, y solo en `on`:** los disparadores de compactación, el límite duro, `estimateContext`/`contextBudget` y la entrada del resumidor siguen usando el historial **crudo**. Enmienda (D21): en `on`, la longitud del bloque `<invariants>` se suma al término de instrucciones de `chars()`, `charsConversation()` y del objetivo de `reduceInPlace`.
- **D14** (Fase 2) **La capa de proyecto sigue reemplazando la sección `context` completa** (precedencia existente); no se fusiona clave a clave.
- **D15** (Fase 3, 2026-10-16; acotada en la Fase 4) **Solo `on` envía o guarda mensajes u opciones de sesión:** `shadow` solo calcula recuentos (en `governance()`), no envía bloque, no cambia las instrucciones del resumidor, no promueve nada y no escribe en `sessions.options`; `off` no lee ni calcula nada. Las peticiones al modelo y al resumidor, los mensajes y las opciones de sesión son byte-idénticos en `off`, `shadow` y sin governor. Excepción de la Fase 4 (§3.4): `shadow` y `on` añaden filas duraderas `context_governed` al registro de eventos.
- **D16** (Fase 3) **El bloque se inyecta solo tras la primera compactación** (historial que empieza por un checkpoint, o `compactions > 0`).
- **D17** (Fase 3) **Tope de instrucciones: 20 elementos de 500 caracteres;** con la lista llena se conservan las más antiguas, se rechazan las nuevas y se cuentan los rechazos.
- **D18** (Fase 3) **El bloque es el último mensaje `user` transitorio,** construido en cada petición, nunca guardado, añadido tras la proyección y `textProjection` y antes del aviso de recuperación; no pasa por `projectContext`.
- **D19** (Fase 3) **El objetivo del goal nunca se recorta:** si no cabe, se omite y se cuenta.
- **D20** (Fase 3) **No se analizan los checkpoints de texto antiguos** para sembrar invariantes: las sesiones antiguas reciben solo fuentes en vivo.
- **D21** (Fase 3) **En `on`, el bloque cuenta como instrucciones** en `chars()`, `charsConversation()` y `reduceInPlace` (enmienda de D13).
- **D22** (Fase 3) **`clearInvariants(sessionId)` es solo del núcleo** (borra `contextInvariants` y las entradas en memoria); sin retirada por elemento hasta la Fase 5.
- **D23** (Fase 3) **Permisos:** solo efectos aprobados para la sesión (mapa nuevo del runner), capacidades de sesión y un recuento de directorios externos; nunca rutas, scripts ni argumentos; sin modo de permisos.
- **D24** (Fase 3) **Criterios:** texto y marca `required`, sin estado en vivo; se excluyen los que tienen `notApplicableReason`.
- **D25** (Fase 4, 2026-10-16) **La elisión nunca se informa con `context_reduced`:** vive solo en `context_governed`. `context_reduced` conserva su único punto de emisión (recorte en sitio por presupuesto) y gana `reason?: "budget"` y `tokensSaved?` (estimación de la diferencia de caracteres) en todos los modos.
- **D26** (Fase 4) **`context_governed` es duradero:** se persiste por el emisor normal y el SSE lo reenvía como cualquier evento duradero; no está en las fronteras de mensajes del hub porque la elisión no cambia los mensajes guardados.
- **D27** (Fase 4) **Se retira `CompactionCheckpoint.invariants?`** (y el tipo interno `GovernedCheckpoint`): los invariantes viven en `sessions.options.contextInvariants`. El SDK de la Fase 4 solo recibe tipos de evento.
- **D28** (Fase 4) **Un evento por petición al modelo en `shadow|on`,** desde el punto del governor y antes de `provider.stream`; nunca en `off`/sin governor, no por reintento silencioso; una recuperación por truncamiento es una petición nueva. `request` es el contador por ejecución.
- **D29** (Fase 4) **IDs del evento:** solo los `callId` recién elididos en esa petición (delta), máximo 32, más `elidedCallIdsOmitted`.
- **D30** (Fase 4) **«Usado» compara solo paths en v1** (los símbolos esperan a la spec 016); releer el mismo path con `read_file` no es uso y se cuenta en `rereads`; los paths nombrados en comandos de `run_process`/`shell` cuentan como uso con coincidencia por límite de palabra (heurística documentada).
- **D31** (Fase 4) **Atribuibles:** resultados de efecto `read` con paths (`read_file`, `list_files`, `search_text` y herramientas con `ToolDefinition.paths`); el resto es `unattributed`. En `on`, un resultado visto por primera vez como stub es `stubOnly` y no cuenta como observado; uno visto completo y elidido después sigue observado.
- **D32** (Fase 4) **El cociente se muestra por herramienta;** `byKind` solo contiene `tool_result` en v1.
- **D33** (Fase 4) **`/stats` lee la memoria del runner** (O5: sin persistencia); se pierde al reiniciar. La sección solo aparece en `shadow|on` con datos.
- **D34** (Fase 4) **El ledger es asesor:** no impulsa la elisión ni la puerta G1-G3 de la Fase 6, y un fallo suyo nunca falla una petición.
- **D35** (Fase 4) **Solo tipos de evento en el SDK** (`ContextSegmentKind`, `ContextElisionReason`, `ContextUsageCounts`, `ContextGovernedData` y los dos campos opcionales de `context_reduced`); `ContextSegment` y `ContextReport` esperan a la Fase 5.
- **D36** (Fase 4) **Topes del ledger:** 4096 entradas por sesión, 32 claves por entrada y LRU de 64 sesiones por runner; las entradas expulsadas se cuentan en `evicted`.
- **D37** (Fase 4) **Changeset:** `@alisio/sdk` y `@alisio/core` minor dentro de la 0.9.0 prevista.
- **D38** (Fase 4) **El resumen de trayectoria web** muestra una fila breve para `context_governed` para que `shadow` no deje filas vacías.
- **D39** (Fase 4) **El ledger no se borra al compactar ni al cambiar de modelo** (es acumulativo); solo `clearInvariants` lo borra.

## 10. Criterios de aceptación globales

1. Llamada y resultado nunca se separan (prueba de regresión).
2. La política explica qué segmentos seleccionó o elidió y por qué.
3. Los invariantes sobreviven a N compactaciones.
4. En `shadow`, lo enviado es byte-idéntico a la base 0.8.0.
5. Se supera el protocolo de la puerta de la Fase 6 (G1 a G3; reduce tokens y el éxito no cae más de M, medido en todos los modelos del protocolo). Aprobado el 2026-10-16.

## 11. Pruebas transversales

- Propiedad: para cualquier historial generado, la proyección conserva el emparejamiento `tool_call`/`tool_result`.
- Identidad `off` y `shadow` contra el payload de la base 0.8.0 (proveedor scripted).
- Compatibilidad de sesiones persistidas anteriores (opciones de sesión sin `contextInvariants`, o malformadas, y checkpoints de texto antiguos).
- Cada plugin con `CompactionHooks` sigue funcionando sin cambios.

## 12. Estado de implementación

Estado: **Aprobada (2026-10-15).** El 2026-10-15 el código del Governor no existía (verificado sobre 0.8.0). **Fase 0 cerrada el 2026-10-16 (protocolo de la puerta aprobado, sustituto de O2; T por fijar tras las Fases 1 y 2):** suite `long-context-stress` creada (sin commit) y línea base k=5 medida; ver el registro bajo la Fase 0 (§5). Actualizar `docs/implementation-status.md` al cerrar cada fase. **Fase 1 implementada (commit `bd247e9`) y Fase 2 implementada en la rama `feat/eval-long-context-stress-phase0` (sin commit al escribir esto):** la Fase 2 añade `context/elide.ts`, `context/governance.ts`, la configuración `context.governor|elide|policyVersion` y la conexión al runner (solo `on` cambia lo enviado); ver D10 a D14 y las correcciones de 3.2. **Fase 3 implementada en la misma rama (sin commit al escribir esto):** invariantes del contexto (`context/invariants.ts`, `context/sources.ts`), campo `alisio_invariants` del resumidor solo en `on`, bloque `<invariants>` transitorio y `context.invariants.maxChars`; ver D15 a D24 y la corrección de 3.3. **Fase 4 implementada en la misma rama (sin commit al escribir esto):** `UsageLedger`, evento duradero `context_governed`, campos opcionales de `context_reduced` y sección de `/stats`; ver D25 a D39 y las correcciones de 3.4 y 3.6. Medición con modelo pendiente de la puerta de la Fase 6.

## 13. Asignación de modelos

Sonnet por defecto. Opus solo en: (1) diseño de la proyección monótona y estable (Fase 2); (2) revisión de la interacción con compactación e invariantes (Fase 3).
