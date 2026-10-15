# Especificación Técnica: Context Governor — inventario, elisión determinista e invariantes del contexto

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 3 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador. Propuesta, no implementada.** Las decisiones O1..O8 están pendientes (propuesta, a confirmar por el propietario). |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: `ContextSegment`, `ContextReport`, `CompactionCheckpoint.invariants?`; `RunEventDataMap.context_reduced` gana campos opcionales; evento `context_governed`), `@alisio/core` (nuevo `packages/core/src/context/*`; integración en `core/src/core/compaction.ts` y `core/src/core/runner.ts`; `resources/context.ts`; tool `context_explain`; `config.ts`; `commands/builtins.ts`), `@alisio/server` (ruta `GET /api/sessions/:sid/context`), `@alisio/web` (privado: panel de contexto, `src/i18n/{en,es}.ts`), `@alisio/alisio-code` (TUI: `/context`) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción. |
| Relación con otras especificaciones | Mide su efecto con `specs/archive/010-reliability-lab-v1.md` (suite `long-context`; puerta de promoción). Recibe invariantes de `specs/archive/011-proof-v1.md` (criterios vigentes) y de goal/plan. Los recuerdos de `specs/015-project-memory-v1.md` y las salidas de `specs/016-code-intelligence-v1.md` entran como segmentos con procedencia y criticidad. Se apoya en Forja (`js_run`, `forge_guide`, implementada en 0.6.0) como vía de exploración programática de contexto grande. Independiente de `specs/backlog/019-capability-routing-v1.md` (que reduce esquemas de herramientas, fuera de aquí) y de `specs/backlog/020-model-tier-router-v1.md`. |
| Superficies | Web, TUI y headless con paridad funcional; API HTTP de `alisio serve` |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**. Aditiva: `context.governor` arranca en `off`; en `shadow` lo enviado al proveedor es byte-idéntico a 0.6.x. `RunEvent.schemaVersion` sigue en 1. |

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

Inventario de segmentos; elisión por sustitución (lecturas superadas, `bg_output` antiguo, búsquedas duplicadas); bloque de invariantes y campo `invariants` del checkpoint; ledger observado/usado; política versionada `off|shadow|on`; `/context` en TUI y panel web; ampliación aditiva de `context_reduced`; pruebas de regresión de límites llamada/resultado; documentación.

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
| `CompactionCheckpoint {goal, instructions, discoveries, accomplished, currentState, nextSteps, relevantFiles}` | `packages/sdk/src/index.ts` l.~710 | Gana `invariants?: string[]` aditivo. |
| `CompactionStart {sessionId, reason: manual\|auto\|budget, messages, focus?, signal}` y `CompactionHooks` | `sdk/src/index.ts` l.~720+ | Los hooks de plugins siguen invocándose; el Governor aporta invariantes por el mismo camino. |
| `context_reduced: { messages: number }` | `sdk/src/index.ts` l.665 | Se amplía con campos opcionales (`reason`, `elided`, `tokensSaved`). |
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

La sustitución conserva el mensaje `tool_result` con su `callId` y rol; solo cambia el contenido textual de la proyección (D2). La función es **monótona y estable**: dado el mismo historial produce la misma proyección y, al añadir mensajes, no reescribe elisiones anteriores salvo que un nuevo mensaje supere una lectura (así se protege la caché de prompt del proveedor).

### 3.3 Invariantes

`collectInvariants(session)` reúne: instrucciones vigentes del usuario (extraídas del campo `instructions` del último checkpoint y de mensajes marcados), aprobaciones de sesión (grants), objetivo de goal activo, plan aprobado, y criterios de `specs/archive/011-proof-v1.md` si existe `proof` (feature-detect). Se renderizan en un bloque `<invariants>` colocado **cerca del final del prompt** (mitiga «lost in the middle») y se reinyectan tras cada compactación. El checkpoint gana `invariants` y `renderCheckpoint()` los emite aparte; el resumen con modelo **no** los reescribe: se pasan literales (D4).

### 3.4 Ledger observado/usado

`usageLedger` registra, por segmento, `observed` (estuvo en el prompt) y `used` (su path o símbolo reaparece después en `tool_started` o en una edición). Métrica `usedRatio = used / observed` por tipo de segmento, sin anotación manual. Solo se calcula en `shadow|on` y se acumula en memoria de sesión + evento (D9: sin tabla propia).

### 3.5 Política versionada

`context.governor: "off" | "shadow" | "on"` (config global/proyecto; default `off`). `context.policyVersion` entero que se emite en cada evento. `off`: sin cambios. `shadow`: calcula inventario, elisiones y métricas, **no** cambia lo enviado (byte-idéntico a 0.6.x). `on`: aplica la proyección. El paso a default `shadow` y luego `on` requiere la puerta de la Fase 6.

### 3.6 Explicación y superficies

`context_explain` (tool existente) se mantiene; `/context` (TUI/web) muestra segmentos, tamaños, criticidad, qué se elidió y la razón, `usedRatio` y los invariantes. `context_reduced` gana `reason: "elided"` y conteos; nuevo evento `context_governed {policyVersion, mode, segments, elided, tokensBefore, tokensAfter}` por vuelta (acotado, sin contenido).

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

- `CompactionCheckpoint.invariants?: string[]` (opcional; ausente en checkpoints antiguos).
- `RunEventDataMap.context_reduced`: `{ messages: number; reason?: "elided" | "budget"; elided?: number; tokensSaved?: number }`.
- `RunEventDataMap.context_governed`: ver §3.6.
- Ruta `GET /api/sessions/:sid/context` → `ContextReport` (solo lectura).
- Config: `context.governor`, `context.elide.minAgeTurns` (default 2), `context.invariants.maxChars` (default 4000).

## 5. Fases

Cada fase: Rojo → Verde → Refactor; repo verde al cerrar; sin commit hasta que lo pida el propietario.

### Fase 0 — Medición base (sin código de producción)

Trabajo: con `specs/archive/010-reliability-lab-v1.md` (Fase 0) o un arnés mínimo en `scripts/`, medir en sesiones sintéticas largas: tokens enviados por vuelta, proporción de resultados `read_file` superados, número de compactaciones y pérdida de instrucciones tras compactar (suite `long-context`). Fijar el umbral de «sin caída de éxito» (p. ej. ≤2 puntos).
Aceptación: línea base documentada en esta spec; umbral aprobado por el propietario.
Pruebas: ninguna de producción.

### Fase 1 — Inventario y regresión de límites

Trabajo: `core/src/context/{types,inventory}.ts`; clasificación de criticidad; prueba de regresión de que `planCompaction`/`reduceMessagesToBudget` nunca separan llamada y resultado.
Aceptación: (1) llamada y resultado nunca se separan en ninguna proyección (propiedad sobre historiales generados con `mulberry32` de `scripts/bench/lib.ts`); (2) el inventario explica cada segmento con kind, origen y criticidad; (3) con `off` nada cambia.
Pruebas: `tests/context-inventory.test.ts`, `tests/context-boundaries.test.ts` (propiedad: IDs emparejados tras cualquier corte).

### Fase 2 — Elisión determinista (proyección)

Trabajo: `context/elide.ts` con las tres reglas; integración en la construcción de mensajes del runner solo para `on`; `shadow` calcula sin aplicar.
Aceptación: (1) el último resultado de un path y la última vuelta nunca se elide; (2) la proyección es estable y monótona entre vueltas; (3) en `shadow` los bytes enviados son idénticos a 0.6.x; (4) el mensaje persistido no cambia.
Pruebas: `tests/context-elide.test.ts` (tabla de casos, estabilidad al añadir mensajes), `tests/context-shadow-identity.test.ts` (comparación byte a byte del payload con `off`).

### Fase 3 — Invariantes y checkpoint

Trabajo: `collectInvariants`, bloque `<invariants>`, campo `invariants` en el checkpoint, reinyección tras compactar; feature-detect de criterios de Proof.
Aceptación: los invariantes sobreviven a N compactaciones consecutivas (N≥5) sin duplicarse ni resumirse; un checkpoint sin `invariants` (sesión antigua) se lee sin error.
Pruebas: `tests/context-invariants.test.ts` (N compactaciones, límite `maxChars`, checkpoints antiguos), ampliación de las pruebas de compactación sin cambiar sus expectativas.

### Fase 4 — Ledger observado/usado y eventos

Trabajo: `usageLedger`; eventos `context_governed` y ampliación de `context_reduced`; resumen en `/stats`.
Aceptación: `usedRatio` se calcula sin anotación manual; los eventos no incluyen contenido, solo conteos e IDs.
Pruebas: `tests/context-usage.test.ts`, prueba de esquema de eventos.

### Fase 5 — Superficies

Trabajo: ruta `GET /api/sessions/:sid/context`; panel web; `/context` en TUI; salida en headless (`--json` emite `context_governed`); i18n EN/ES; captura `context_governor_web_ui.webp`.
Aceptación: TUI, Web y JSONL muestran los mismos segmentos y razones desde el mismo `ContextReport`.
Pruebas: `tests/context-routes.test.ts`, pruebas de componente web del panel.

### Fase 6 — Puerta de medición y promoción

Trabajo: ejecutar la suite `long-context` del Lab con `off` vs `on` (y `shadow`); medir tokens por tarea, éxito, `cachedInput` del proveedor y latencia; decidir default.
Aceptación: reducción de tokens medida **sin caída de éxito mayor al umbral de la Fase 0** y sin degradación de `cachedInput` relevante; si no se cumple, el default queda `off` y se documenta el resultado. Resultados reportados como medidos (no estimados).
Pruebas: el propio Lab; sin pruebas unitarias nuevas.

### Fase 7 — Documentación y estado

Trabajo: `docs/context-governor.md` EN/ES en paridad; `docs/implementation-status.md` con límites; entrada de changelog.
Aceptación: `pnpm docs:check` y `pnpm docs:build` en verde.

## 6. Seguridad y privacidad

- El Governor no decide permisos ni modifica grants; solo lee su estado para el bloque de invariantes.
- Los stubs y eventos no incluyen contenido de archivos; solo `path`, `sha8` y conteos.
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

## 8. Decisiones del propietario (O1..O8, pendientes: propuesta, a confirmar)

| ID | Pregunta | Recomendación |
| --- | --- | --- |
| O1 | ¿Default inicial de `context.governor`? | `off`; pasar a `shadow` en la siguiente minor y a `on` solo tras la puerta de la Fase 6. |
| O2 | ¿Umbral de «sin caída de éxito»? | ≤2 puntos porcentuales en `long-context`, fijado en la Fase 0. |
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
- **D6** `shadow` es byte-idéntico a 0.6.x en lo enviado.
- **D7** Todo evento es acotado y sin contenido de archivos.
- **D8** Ningún cambio de default sin pasar la puerta de medición de la Fase 6.
- **D9** Sin migración de base de datos en esta versión.

## 10. Criterios de aceptación globales

1. Llamada y resultado nunca se separan (prueba de regresión).
2. La política explica qué segmentos seleccionó o elidió y por qué.
3. Los invariantes sobreviven a N compactaciones.
4. En `shadow`, lo enviado es byte-idéntico a 0.6.x.
5. El Lab muestra reducción de tokens sin caída de éxito mayor al umbral de la Fase 0.

## 11. Pruebas transversales

- Propiedad: para cualquier historial generado, la proyección conserva el emparejamiento `tool_call`/`tool_result`.
- Identidad `off` y `shadow` contra el payload de 0.6.x (proveedor scripted).
- Compatibilidad de sesiones persistidas anteriores (checkpoints sin `invariants`).
- Cada plugin con `CompactionHooks` sigue funcionando sin cambios.

## 12. Estado de implementación

Estado: **Borrador (2026-10-13).** Nada implementado. Actualizar `docs/implementation-status.md` al cerrar cada fase.

## 13. Asignación de modelos

Sonnet por defecto. Opus solo en: (1) diseño de la proyección monótona y estable (Fase 2); (2) revisión de la interacción con compactación e invariantes (Fase 3).
