# Especificación Técnica: Goals por hitos — incrementos verificables, reanudación y efectos no idempotentes

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 8 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador.** Propuesta, no implementada. Decisiones O1–O8 pendientes (propuesta, a confirmar por el propietario). No se ejecuta hasta que `specs/011-proof-v1.md` tenga cerradas sus fases de ledger y verificadores. |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: `GoalMilestone`, `MilestoneStatus`, `EffectLedgerEntry`; campos opcionales en `GoalInfo`; nuevos códigos en `GoalReason`; nuevos eventos de goal), `@alisio/core` (`packages/core/src/goal/{machine,service,store,blockers,prompts,command,format,host}.ts`, `packages/core/src/tools/goal.ts` (`update_goal`), nuevo `packages/core/src/goal/milestones.ts` y `packages/core/src/goal/effects.ts`, `packages/core/src/runtime/store.ts` (migración)), `@alisio/server` (`packages/server/src/routes/goal.ts`, `packages/server/src/host/goal.ts`), `@alisio/web` (privado: panel de goal con hitos), `@alisio/alisio-code` (`packages/cli/src/tui/goal.ts`; CLI headless `alisio run --goal`) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción (los checkpoints usan `git` como subproceso con `runProcess`, `packages/core/src/runtime/process.ts`). |
| Relación con otras especificaciones | **Obligatoria**: `specs/011-proof-v1.md` (criterios y verificadores de cada hito). **Fuertes**: `specs/014-trust-boundaries-v1.md` (procedencia/taint de resultados y efectos externos), `specs/013-adaptive-execution-v1.md` (guardia de progreso reutilizada por hito). **De medición**: `specs/010-reliability-lab-v1.md` (mide reanudaciones). **Opcionales**: `specs/016-code-intelligence-v1.md` (diagnósticos como verificadores de hito), `specs/015-project-memory-v1.md` (los hitos cerrados pueden ser recuerdos con procedencia). Extiende de forma **aditiva** `specs/archive/003-modes-goal-background-v1.md` (`/goal` de 0.6.x). Respeta `specs/018-perimeter-v1.md` (no decide permisos). |
| Superficies | Web, TUI y headless (`alisio run`) con paridad funcional; API HTTP de `alisio serve` |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**; aditiva. Sin hitos, `/goal` se comporta **byte a byte como en 0.6.x** (criterio de aceptación transversal). |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 (`main`, 0.6.0); **(no verificado)** = deducido o externo; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Pruebas en `tests/*.test.ts` (vitest), en límites de módulo, **sin snapshots**. La máquina de estados (`goal/machine.ts`) se prueba con funciones puras, como hoy en `tests/goal-machine.test.ts`.
4. **Orden obligatorio**: Fase 0 (piloto de medición con goals largos actuales) → el propietario revisa → Fases 1–6. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: §13. Sonnet por defecto; Opus solo en los puntos listados.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y Bun; solo `node:fs`, `node:child_process`, `node:sqlite`; sin SDK de proveedor ni imports de runtime en `@alisio/sdk` ni en contratos del core; los plugins dependen solo de `@alisio/sdk` (peer); preservar IDs de llamadas a herramientas, continuación del proveedor y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Contratos **aditivos**: `RunEvent.schemaVersion` sigue en 1; las uniones solo ganan variantes; las columnas nuevas llevan valor por defecto; migraciones forward-only.
8. Idioma: identificadores, eventos, claves y mensajes de error en inglés; UI en inglés y español (`packages/web/src/i18n/es.ts` y el i18n de la TUI); esta especificación en español; docs EN/ES en paridad; límites en `docs/implementation-status.md`.
9. Esta especificación **no crea permisos ni cambia el gate**: un hito no concede ninguna autorización; la reanudación **preserva** exactamente la política vigente (§4.6).

## 1. Objetivo, no-objetivos y principio rector

### 1.1 Objetivo

Extender `/goal` para que un trabajo largo se descomponga en **hitos con entregables y criterios de salida verificables**, de modo que:

1. Cada hito se cierra con **evidencia verificada de forma independiente**, no con la afirmación del implementador.
2. Una **interrupción** (reinicio, pausa, error, presupuesto) no invalida lo ya verificado: se reanuda **desde el último hito verificado**.
3. La reanudación **nunca repite en silencio un efecto externo no idempotente**: los conoce, los muestra y exige confirmación.
4. El usuario puede **volver a un hito** (acción explícita) y el resultado final **integra la evidencia de cada hito**.

### 1.2 Principio rector

> **Un hito está cerrado cuando un verificador independiente lo dice, no cuando el modelo lo dice. Reanudar es retomar desde lo verificado, y nunca repetir un efecto en el mundo sin que una persona lo sepa.**

Reglas derivadas: sin hitos, nada cambia; el modelo **propone** y el usuario **aprueba** los hitos (mismo patrón que Plan Review); el reporte de hitos nombra lo que no se pudo verificar (`unverified`) en el mismo plano que lo verificado.

### 1.3 No-objetivos

| Excluido | Motivo |
| --- | --- |
| Autonomía multi-día, sin supervisión, con garantías de finalización | Alisio promete reanudación honesta, no ausencia de humano. Los presupuestos (`maxTurns`, `maxWallMs`, `tokenBudget`) siguen siendo la contención. |
| Planificación automática de hitos sin aprobación del usuario | Decisión O2: aprobación humana obligatoria. |
| Orquestar varios goals en paralelo por sesión | `session_goals` es un goal por sesión (**verificado**); no cambia. |
| Rollback automático de efectos externos (deshacer un POST, un correo) | Imposible en general. El ledger **informa** y **frena**; no deshace. |
| Reescribir la historia de git del usuario (commits, ramas) | `docs/specification.md` §9 prohíbe commits como efecto colateral. Los checkpoints son refs ligeras en un espacio de nombres propio (§4.4), no commits en ramas del usuario. |
| Commit/PR automático al cerrar un hito | Mismo motivo. |
| Evaluación con un modelo «juez» sobre criterios subjetivos | Solo criterios con verificador determinista (de Proof) cierran un hito; los subjetivos requieren confirmación humana (`needs_review`). |

## 2. Base verificada

| Hecho (verificado en repo) | Dónde | Implicación |
| --- | --- | --- |
| Estados `active\|paused\|blocked\|budget_limited\|complete` y razones cerradas (`created`, `resumed`, `edited`, `user_paused`, `user_interrupt`, `model_complete`, `model_blocked`, `policy_denied`, `run_error`, `token_budget`, `max_turns`, `max_wall`, `no_progress`, `restart`) | `packages/sdk/src/index.ts` l.1155–1175 | Los hitos añaden razones sin tocar las existentes. |
| `GoalInfo` con `epoch` (compare-and-set), presupuestos, `summary`, `evidence?: GoalEvidence[]`, `actions`, `waiting` | `packages/sdk/src/index.ts` l.1182+ | Campos opcionales aditivos (`milestones?`, `activeMilestoneId?`). |
| `GoalEvidence {kind: file\|test\|log\|command\|denied\|other, detail}` en **texto libre**, sin enlace a eventos | `packages/sdk/src/index.ts` l.1177 | Insuficiente como prueba; Proof aporta evidencia tipada y enlazada. |
| `GoalRecord` con `noToolStreak`, `repeatStreak`, `blockedStreak`, `continuations`, `inflight`, `ownerPid`, `kickoffSent` | `packages/core/src/goal/machine.ts` l.52 | Los disyuntores existen **solo a nivel de goal**; por hito se añadirán contadores análogos. |
| Máquina pura: `newGoal`, `userPause/Resume/Edit/Budget`, `modelComplete`, `modelBlocked`, `systemRestart`, `breakerStage` | `packages/core/src/goal/machine.ts` | Se extiende con transiciones de hito, sin alterar las existentes. |
| `GoalService`, `GoalStore` (`goalFromRow`), `blockers.ts` (lista ordenada de esperas), `prompts.ts`, `command.ts` (`/goal`), `host.ts` | `packages/core/src/goal/*` | Puntos de extensión. |
| Herramienta del modelo `update_goal` (`complete`/`blocked` con `summary` y `evidence`) | `packages/core/src/tools/goal.ts` | Ganará la acción `propose_milestones` y `milestone_ready`. |
| Persistencia: `session_goals` creada en v7, columnas del runtime añadidas en v8; migraciones forward-only hasta **v10** | `packages/core/src/runtime/store.ts` l.199–255 | Nueva migración **«siguiente migración libre (v11 si es la primera en ejecutarse)»**; ver §4.7. |
| Host del goal en el servidor y en la TUI | `packages/server/src/host/goal.ts`, `packages/server/src/routes/goal.ts`, `packages/cli/src/tui/goal.ts` | Paridad de superficies. |
| Pruebas existentes de goal | `tests/goal-machine.test.ts`, `goal-controller.test.ts`, `goal-runner.test.ts`, `server-goal.test.ts`, `tui-goal.test.ts`, `web-goal.test.ts` | Línea base de no regresión (§6). |
| Un reinicio pausa los goals cuyo dueño murió (`systemRestart`, `ownerPid`) | `goal/machine.ts` l.391 | Punto de entrada de la reanudación (§4.5). |

## 3. Decisiones

### Decisiones del propietario (propuesta, a confirmar)

| ID | Decisión | Recomendación |
| --- | --- | --- |
| O1 | ¿Los hitos son opt-in por goal o por configuración global? | **Opt-in por goal**: sin `milestones` el goal es el de 0.6.x. Opción de configuración `goal.milestones.enabled` (global) que habilita la herramienta. |
| O2 | ¿Quién fija los hitos? | El modelo **propone** con `update_goal`; el usuario **aprueba o edita** antes de arrancar (patrón Plan Review). También puede escribirlos él mismo (`/goal milestones add`). |
| O3 | ¿Qué checkpoint por hito? | **Ref git ligera** en `refs/alisio/goals/<goalId>/<milestoneId>` apuntando a un **árbol de trabajo sintético** (commit huérfano creado con `git write-tree`/`commit-tree` sobre un índice temporal, sin tocar el índice ni las ramas del usuario). Sin repositorio git: snapshot de archivos modificados en el blob store (`runtime/blobs.ts`). |
| O4 | ¿«Volver al hito» restaura archivos? | **Sí, solo por acción explícita del usuario**, mostrando el diff antes y requiriendo confirmación; nunca automático. Restaura únicamente rutas tocadas por el goal. |
| O5 | ¿Evaluación independiente en subagente? | **Por defecto, re-ejecución determinista de verificadores** (sin modelo). Opción `goal.milestones.independentReview: "subagent"` para criterios `needs_review`, con el subagente en modo read-only (`plugin-subagents`). |
| O6 | ¿Qué efectos se registran en el ledger? | Todo `effect: "external"` (**verificado**: `Effect = read\|write\|process\|external\|internal`) y las llamadas MCP; los `process` solo si el verificador o el usuario los marca como externos. Idempotencia declarada por herramienta (`idempotent?: boolean` en el registro) con **desconocida = no idempotente**. |
| O7 | ¿Presupuesto por hito? | **Sí, opcional**: `maxTurns`/`tokenBudget` por hito, además del global; el global siempre manda. |
| O8 | ¿Retención del ledger y refs? | Se borran al **borrar el goal** (`clear`) o a los 30 días tras `complete` (configurable); nunca se borra un ledger de goal activo. |

### Decisiones de diseño (vinculantes)

- **D1.** Todo es **aditivo y opcional**: sin hitos, ningún código nuevo se ejecuta en el camino del goal (prueba de equivalencia, §6).
- **D2.** Un hito pasa a `verified` **solo** si todos sus criterios con verificador determinista pasan en una **re-ejecución limpia** hecha por el servicio (no por el modelo) y la evidencia queda enlazada a eventos del run. Criterios sin verificador pasan por `needs_review` (humano).
- **D3.** El modelo no puede marcar un hito `verified`. Solo puede pedir `milestone_ready`; el servicio verifica.
- **D4.** La reanudación reutiliza la **política vigente** en ese momento (modo de permisos, `--read-only`, grants); **nunca** hereda aprobaciones del run anterior. Un goal creado con restricciones no puede reanudarse con menos.
- **D5.** Un efecto del ledger con idempotencia desconocida o `false`, **ya ejecutado** en el hito en curso, nunca se repite sin confirmación explícita del usuario por entrada.
- **D6.** Los refs de git viven solo bajo `refs/alisio/goals/`; no se crean ramas, tags ni commits en el historial del usuario; se limpian al borrar el goal.
- **D7.** El estado de hitos y ledger es durable en SQLite (`node:sqlite`) con compare-and-set por `epoch`, igual que el goal.
- **D8.** La evidencia final integra la de cada hito (§4.8); la afirmación de completitud del modelo (`model_complete`) solo es válida si todos los hitos están `verified` o `skipped` por el usuario.

## 4. Diseño

### 4.1 Modelo de datos (`@alisio/sdk`, aditivo)

```ts
export type MilestoneStatus =
  | "proposed"      // el modelo/usuario lo propuso; sin aprobar
  | "pending"       // aprobado, aún no iniciado
  | "active"        // en curso
  | "needs_review"  // verificadores pasaron; faltan criterios que exigen humano
  | "verified"      // verificado de forma independiente
  | "failed"        // la verificación falló; requiere acción
  | "skipped";      // el usuario lo omitió explícitamente

export interface GoalMilestone {
  id: string;                 // estable: `m1`, `m2`, ...
  title: string;
  /** Criterios en el formato de Proof (`specs/011-proof-v1.md`); ids de criterio, no texto libre. */
  criteria: string[];
  status: MilestoneStatus;
  checkpointRef?: string;     // `refs/alisio/goals/<goalId>/<id>` o `blob:<id>`
  budget?: { maxTurns?: number; tokenBudget?: number };
  turnsUsed: number;
  tokensUsed: number;
  verifiedAt?: number;
  evidenceRefs?: string[];    // ids de evidencia Proof enlazados a eventos
}

export interface EffectLedgerEntry {
  id: string;
  goalId: string;
  milestoneId?: string;
  tool: string;               // nombre de la herramienta (preserva `callId` del run)
  callId: string;             // ID de llamada original, sin alterar
  fingerprint: string;        // hash(tool + argumentos canónicos), sin guardar secretos
  idempotent: boolean | "unknown";
  outcome: "ok" | "error" | "unknown";
  at: number;
  confirmedRepeat?: boolean;  // el usuario aceptó repetirlo al reanudar
}
```

`GoalInfo` gana `milestones?: GoalMilestone[]`, `activeMilestoneId?: string` y `pendingEffects?: EffectLedgerEntry[]` (solo en la vista de reanudación). `GoalReason` gana `milestone_failed`, `milestone_budget`, `effect_confirmation` (códigos cerrados; las UIs los traducen en `en`/`es`). Eventos nuevos (aditivos): `goal_milestones_proposed`, `goal_milestone_changed`, `goal_effect_recorded`, `goal_resume_review`.

### 4.2 Máquina de estados (`goal/machine.ts` y `goal/milestones.ts`)

Funciones puras, sin E/S, en el estilo de `userPause`/`modelBlocked`:

- `proposeMilestones(goal, milestones, now)` → `proposed` (solo `active` o `paused`; si hay hitos aprobados, rechaza con `GoalRefusal`).
- `approveMilestones(goal, ids|edits, now)` → `pending`; el primero pasa a `active` al arrancar.
- `milestoneReady(goal, id, now)` → solicita verificación (el servicio la ejecuta).
- `settleMilestone(goal, id, verdict, now)` → `verified|needs_review|failed` según los resultados de verificadores.
- `skipMilestone(goal, id, now)` (acción del usuario) y `revertToMilestone(goal, id, now)` (§4.4).
- Disyuntores por hito reutilizando `breakerStage` (`noToolStreak`, `repeatStreak`) con contadores propios del hito, y el `no_progress` de `specs/013-adaptive-execution-v1.md` cuando exista.
- El presupuesto global sigue gobernando: si el global se agota, estado `budget_limited` con razón existente; si lo hace el del hito, `paused` con `milestone_budget`.
- Invariante: como máximo un hito `active`; el orden es lineal por `id` (sin grafos de dependencias en v1, ver §8).

### 4.3 Herramienta `update_goal` (extensión, `packages/core/src/tools/goal.ts`)

Nuevas acciones, manteniendo `complete`/`blocked` intactas:

| Acción | Efecto | Quién la ve |
| --- | --- | --- |
| `propose_milestones` `{ milestones: [{title, criteria}] }` | Crea hitos `proposed`; el goal queda en espera de aprobación (`waiting: "user_input"`, ya existente en `GoalWaiting`). | Usuario aprueba/edita |
| `milestone_ready` `{ id, summary }` | Solicita verificación independiente del hito activo; **no** lo marca verificado. | Servicio |

`complete` con hitos pendientes es **rechazado** con un mensaje que nombra los hitos faltantes (D8). El prompt del goal (`goal/prompts.ts`) añade la sección de hitos solo cuando existen.

### 4.4 Checkpoints (`goal/checkpoint.ts`, nuevo)

- Al pasar un hito a `verified`: crear el checkpoint (O3). Con git: índice temporal (`GIT_INDEX_FILE` en un directorio de la sesión), `git add -A -- <rutas>` limitado al árbol de trabajo, `git write-tree`, `git commit-tree` (sin padres), `git update-ref refs/alisio/goals/<goalId>/<id>`. **No** toca `HEAD`, el índice real, ramas ni stash. Se ejecuta con `runProcess`, sin shell.
- «Volver al hito» (O4): calcula el diff entre el árbol actual y el checkpoint, lo muestra, pide confirmación (gate normal, efecto `write`) y restaura **solo** rutas tocadas por el goal usando escritura atómica con precondición sha256 (`atomicWrite`, **verificado** como patrón en `write_file`/`edit_file`). Los hitos posteriores pasan a `pending`.
- Limpieza: al `clear` del goal se borran los refs y blobs (D6, O8). Un fallo de limpieza se registra, no bloquea.

### 4.5 Reanudación

1. `systemRestart` (ya existente) pausa el goal huérfano; con hitos, el servicio calcula el **plan de reanudación**: último hito `verified`, hito en curso y efectos del ledger sin confirmar.
2. El usuario ve en una pantalla única (Web/TUI/headless con `--resume-review`): hitos verificados (no se rehacen), hito en curso, **lista de efectos ya ejecutados en este hito** con su idempotencia, y la política vigente.
3. Continuar requiere: confirmar cada efecto no idempotente que el modelo pueda querer repetir (o marcarlos «no repetir»). Las confirmaciones se guardan (`confirmedRepeat`).
4. El prompt de continuación incluye un resumen factual del estado (hitos verificados, efectos ya hechos), nunca el historial completo; reutiliza el checkpoint de compactación existente (`core/compaction.ts`).
5. En headless sin posibilidad de confirmar, la reanudación **se detiene** con `effect_confirmation` (no repite): comportamiento seguro por defecto.

### 4.6 Preservación de permisos y restricciones

La reanudación calcula la política de nuevo (`permissions/decide.ts`, `permissions/modes.ts`); un goal guardado con `--read-only` o modo `ask` no sube de privilegios. Los grants persistidos del `CapabilityGate` siguen su semántica; el ledger **no** concede nada. Prueba específica (§5, Fase 5).

### 4.7 Persistencia (migración)

Nueva migración forward-only, **siguiente migración libre (v11 si es la primera en ejecutarse)**; coordinar con `specs/011-proof-v1.md` y `specs/014-trust-boundaries-v1.md`, que también la pueden necesitar. Contenido:

- Tabla `goal_milestones(goal_id, id, ord, title, criteria_json, status, checkpoint_ref, budget_json, turns_used, tokens_used, verified_at, evidence_json, updated_at)`, PK `(goal_id, id)`.
- Tabla `effect_ledger(id, goal_id, milestone_id, tool, call_id, fingerprint, idempotent, outcome, at, confirmed_repeat)`, índice por `(goal_id, milestone_id)`.
- Sin cambios en `session_goals`. Bases existentes sin filas = sin hitos (D1).
- Acceso en `goal/store.ts` (`GoalStore`) con compare-and-set por `epoch`.

### 4.8 Resultado final integrado

Al completarse, el `summary` y la evidencia del goal incluyen, por hito: título, estado, criterios, evidencia Proof enlazada y omisiones del usuario (`skipped`). Los hitos `needs_review` sin resolver impiden `complete`.

## 5. Fases

Cada fase: pruebas primero (Rojo), mínimo para verde, refactor.

### Fase 0 — Piloto y línea base

- Con el Lab si existe (o un guion manual): ejecutar 5–8 goals largos sintéticos con el `/goal` actual, forzando interrupciones (reinicio, `max_turns`), y medir: trabajo rehecho, efectos externos duplicados (con un servidor MCP/HTTP falso que cuenta llamadas), éxito final.
- **Aceptación**: informe de baseline con semilla y escenarios reproducibles; el propietario fija el umbral (propuesta: 0 efectos duplicados no confirmados y ≥50 % menos trabajo rehecho tras interrupción).
- **Pruebas**: el arnés de escenarios es determinista (proveedor guionado, patrón de `tests/goal-runner.test.ts`).

### Fase 1 — Máquina de hitos y persistencia

- Tipos en el SDK, `goal/milestones.ts`, transiciones puras, migración y `GoalStore`.
- **Aceptación**: (1) sin hitos, la salida del store y de `goalFromRow` es idéntica a 0.6.x; (2) las transiciones respetan el invariante de un hito activo y devuelven `GoalRefusal` claro; (3) la migración sobre una base v10 con goals existentes conserva datos; (4) compare-and-set rechaza una escritura con `epoch` viejo.
- **Pruebas**: `tests/goal-milestones-machine.test.ts`, `tests/goal-milestones-store.test.ts` (SQLite temporal).

### Fase 2 — Propuesta y aprobación de hitos

- `update_goal` (`propose_milestones`), `/goal milestones …` (`goal/command.ts`), aprobación en Web/TUI/headless, rutas en `server/src/routes/goal.ts`.
- **Aceptación**: (1) el modelo solo propone; el goal espera aprobación; (2) el usuario edita/aprueba/rechaza; (3) el prompt incluye hitos solo si existen; (4) `complete` con hitos pendientes se rechaza con la lista.
- **Pruebas**: `tests/goal-milestones-tool.test.ts`, `tests/server-goal-milestones.test.ts`, `tests/tui-goal-milestones.test.ts`, `tests/web-goal-milestones.test.ts`.

### Fase 3 — Verificación independiente

- `milestone_ready` → el servicio re-ejecuta los verificadores de Proof en limpio (O5); estados `verified|needs_review|failed`; evidencia enlazada; subagente read-only opcional.
- **Aceptación**: (1) el modelo no puede forzar `verified` (D3); (2) un criterio que falla en limpio pero «pasó» según el modelo deja el hito `failed`; (3) criterios sin verificador producen `needs_review`; (4) la evidencia referencia eventos reales del run.
- **Pruebas**: `tests/goal-milestones-verify.test.ts` con verificadores falsos deterministas.

### Fase 4 — Checkpoints y «volver al hito»

- `goal/checkpoint.ts` (refs bajo `refs/alisio/goals/`), snapshot alternativo sin git, restauración con confirmación y precondición sha256.
- **Aceptación**: (1) el checkpoint no altera `HEAD`, índice real, ramas ni stash (prueba comparando `git status`/`git for-each-ref` antes y después); (2) volver restaura solo rutas del goal; (3) borrar el goal elimina refs y blobs; (4) sin git funciona con blobs.
- **Pruebas**: `tests/goal-checkpoint.test.ts` con repositorios temporales (`git init` en `tmp`).

### Fase 5 — Ledger de efectos y reanudación

- `goal/effects.ts` registra `external`/MCP desde el ejecutor (`core/runner.ts`, `executeCall()`) mediante un gancho aditivo; plan de reanudación; confirmación por entrada; detención segura en headless.
- **Aceptación**: (1) tras reiniciar a mitad de un hito, los efectos ya hechos se listan y **no se repiten sin confirmación**; (2) la idempotencia desconocida se trata como no idempotente; (3) la reanudación no amplía permisos (D4; prueba con `--read-only` y modo `ask`); (4) un hito `verified` no se rehace; (5) `callId` original se conserva en el ledger.
- **Pruebas**: `tests/goal-effect-ledger.test.ts`, `tests/goal-resume.test.ts` con proveedor guionado y un efecto externo falso que cuenta invocaciones.

### Fase 6 — Presupuestos por hito, superficies, docs y medición

- Presupuesto por hito (O7), `no_progress` por hito, panel Web/TUI, CLI headless (`alisio run --goal … --resume-review`), docs EN/ES (`docs/…` sobre goals), límites en `docs/implementation-status.md`, capturas Web UI en `docs/assets/web-ui/goal_milestones_web_ui.webp` (EN y ES, datos sintéticos) según `AGENTS.md`.
- Repetir la Fase 0 con hitos y comparar con el umbral.
- **Aceptación**: `pnpm docs:check` pasa con paridad; informe A/B publicado (resultado negativo válido: queda opt-in); sin hitos, `/goal` idéntico a 0.6.x.
- **Pruebas**: paridad de superficies; prueba de equivalencia de las suites existentes de goal sin modificar.

## 6. Pruebas transversales

- **No regresión**: `tests/goal-machine.test.ts`, `goal-controller.test.ts`, `goal-runner.test.ts`, `server-goal.test.ts`, `tui-goal.test.ts` y `web-goal.test.ts` pasan **sin modificación**.
- Sin red: efectos externos simulados con servidores locales en memoria.
- Concurrencia: dos escrituras con el mismo `epoch` → una gana, la otra recibe conflicto.
- Seguridad: argumentos de `git` construidos sin shell; rutas validadas dentro del workspace.

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Prometer autonomía multi-día | No-objetivo explícito (§1.3); la documentación habla de reanudación, no de ausencia de humano. |
| Refs git que ensucian el repo | Espacio de nombres propio, sin ramas ni commits del usuario, limpieza al borrar (D6, O8); prueba de que no cambian `HEAD`/índice. |
| Reanudación que repite efectos | Ledger + confirmación por entrada; idempotencia desconocida = no idempotente; headless se detiene. |
| Fingerprint que filtra secretos | Hash de argumentos canónicos; no se almacenan valores; los argumentos sensibles se omiten. |
| Hitos mal definidos por el modelo | Aprobación humana (O2); criterios con verificador (Proof). |
| Complejidad de la máquina de estados | Funciones puras con pruebas; un solo hito activo; orden lineal; sin grafos en v1. |
| Dependencia de Proof | Esta spec no se ejecuta sin Proof; hasta entonces, solo Fase 0. |
| Competencia por el número de migración | «Siguiente migración libre»; se renumera al ejecutar. |

## 8. Fuera de esta entrega (candidatos)

Dependencias entre hitos (grafo), hitos paralelos, plantillas de hitos reutilizables, integración con memoria de proyecto (`specs/015-project-memory-v1.md`), deshacer efectos con compensaciones declaradas por herramienta.

## 13. Asignación de modelos

| Trabajo | Modelo |
| --- | --- |
| Tipos, persistencia, superficies, docs, pruebas de paridad | Sonnet 5.5 |
| Diseño de la máquina de estados y del plan de reanudación (§4.2, §4.5) | Opus 5.5 |
| Revisión de seguridad de checkpoints, ledger y preservación de permisos (§4.4, §4.6) | Opus 5.5 |

## 14. Estado

**Borrador (2026-10-13).** Pendiente de revisión del propietario: decisiones O1–O8 y umbral de la Fase 0. No se ejecuta hasta que `specs/011-proof-v1.md` haya cerrado ledger y verificadores.
