# Especificación Técnica: Proof — criterios de aceptación con evidencia verificable

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 2 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador. Propuesta, no implementada.** Las decisiones O1..O8 están pendientes (propuesta, a confirmar por el propietario). |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos `ProofCriterion`, `ProofEvidence`, `ProofVerifier`, `ProofLedger`; eventos `proof_updated`; `GoalEvidence.evidenceId?`; `PluginAPI.proof?`), `@alisio/core` (nuevo `packages/core/src/proof/*`; suscripción en `core/src/core/runner.ts`; ampliación aditiva de `core/src/plan/{exit-plan,manifest}.ts` y `core/src/goal/{service,machine,store}.ts`; publicación vía `core/src/artifacts/publisher.ts`; migración en `runtime/store.ts`), `@alisio/server` (`packages/server/src/routes/proof.ts`: `GET /api/sessions/:sid/proof`), `@alisio/web` (privado: tarjeta y panel Proof, `src/i18n/{en,es}.ts`), `@alisio/alisio-code` (TUI: `/proof`; CLI: `alisio run --proof`, `alisio proof show|export`) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción. |
| Relación con otras especificaciones | Complementa `specs/018-perimeter-v1.md` (Perímetro declara el alcance; Proof declara qué se verificó; no se solapan y Proof no decide permisos). Extiende `003-modes-goal-background-v1.md` (goal y plan review) de forma aditiva. Consume el patrón de artefactos de `002-data-analysis-runtime-v1.md`. Es prerequisito de `specs/017-goal-milestones-v1.md` (obligatoria), y aporta IDs de evidencia a `specs/015-project-memory-v1.md`, `specs/013-adaptive-execution-v1.md` (contrato de resultado de subagentes) y `specs/016-code-intelligence-v1.md` (verificadores `typecheck|lint|test`). Su costo se mide con `specs/archive/010-reliability-lab-v1.md`. Aporta el segmento de invariantes «criterios vigentes» a `specs/012-context-governor-v1.md`. |
| Superficies | Web, TUI y headless (`alisio run --json`) con paridad funcional, desde la misma fuente (el ledger); API HTTP de `alisio serve` |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**. Aditiva: sin criterios, goal ni plan, el comportamiento es byte-idéntico a 0.6.x. `RunEvent.schemaVersion` sigue en 1. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 (`main`, 0.6.0, `2e867c7`); **(no verificado)** = deducido o externo sin prueba ejecutada aquí; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts` (vitest), sobre comportamiento en límites de módulo. Sin pruebas de instantánea que repitan la implementación.
4. **Orden obligatorio**: Fase 0 (medición) → el propietario revisa → Fases 1..8. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: Sonnet por defecto; Opus solo en los puntos de la §13.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo `node:fs`, `node:child_process`, `node:sqlite` en los paquetes; ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del core; los plugins dependen solo de `@alisio/sdk` (peer) y nunca importan internos de `@alisio/core`; preservar IDs de tool calls, datos de continuación del proveedor y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Los contratos son **aditivos**: las uniones solo ganan variantes; ninguna ruta, evento ni columna existente cambia de semántica.
8. Idioma: identificadores, eventos, claves y textos generados en inglés; UI en inglés y español (`packages/web/src/i18n/{en,es}.ts` y equivalentes TUI); esta especificación en español. Documentación EN/ES en paridad (`pnpm docs:check`); límites en `docs/implementation-status.md`.
9. Capturas Web UI: según `AGENTS.md`, con Playwright contra `alisio serve` con proveedor falso y datos sintéticos, en `docs/assets/web-ui/proof_web_ui.webp` (<150 KB), en las páginas EN y ES.
10. Numeración de migración: **siguiente migración libre (v11 si es la primera en ejecutarse)**; las migraciones de otras specs se renumeran al ejecutar.

## 1. Objetivo, usuarios y principio rector

### 1.1 Objetivo

Que toda tarea (un run, un plan aprobado o un goal) pueda terminar con un **ledger**: criterios de aceptación → verificadores → evidencias inmutables, con estados `verified | failed | not_checked | manual_review | not_applicable`, mostrado igual en TUI, Web y headless, y exportable a Markdown y JSON.

Hoy (verificado) la única noción de evidencia es `GoalEvidence {kind, detail}` en `packages/sdk/src/index.ts` (l.~1177): texto libre que el modelo declara con `update_goal`, sin enlace a eventos ni a ejecuciones. `exit_plan` (`core/src/plan/exit-plan.ts`) no tiene criterios. Nada impide que el modelo escriba «los tests pasan» sin haberlos corrido.

### 1.2 Usuarios

| ID | Persona | Qué le da Proof |
| --- | --- | --- |
| U1 | Dev auto-hospedado que delega tareas largas | Ver, por criterio, si algo se comprobó de verdad, con qué comando y cuándo; no depender de la narrativa del modelo. |
| U2 | Quien corre `alisio run` en CI | `--proof` devuelve código de salida distinto de 0 si un criterio requerido no está `verified`; artefacto `proof.json` estable. |
| U3 | Quien audita una sesión | Evidencia inmutable con `runId/callId`, huella del comando, código de salida y caducidad. |

### 1.3 Principio rector

> **«Hecho» es lo que una evidencia existente y vigente respalda, no lo que el modelo afirma.**

Reglas derivadas:

- Un criterio sin verificador queda `not_checked`, aunque el modelo diga que está cumplido (D1).
- `verified` solo existe apuntando a una evidencia real, con `runId`, `callId` y fecha (D2).
- La evidencia se **captura** de eventos del runner; el modelo no la fabrica (D3).
- Proof **no decide permisos** y no ejecuta comandos que el gate no permitiría (D6).

### 1.4 Nombre

`Proof` (identificador `proof`). Alternativas descartadas: `acceptance` (largo), `receipts` (colisiona con la jerga de otros productos), `evidence` (solo cubre la mitad).

### 1.5 Alcance

Modelo de datos del ledger y su persistencia; captura automática de evidencia desde `tool_completed`; verificadores incorporados (`command`, `file`, `typecheck|lint|test` como alias de `command`, `data-check`, `coverage` opt-in); caducidad de evidencia; detector de divergencia afirmación/evidencia; criterios en `exit_plan` y en `update_goal`; ruta HTTP, tarjeta web, `/proof` TUI, `--proof` headless; API opcional de verificadores para plugins; export Markdown/JSON como artefacto; documentación y capturas.

### 1.6 Fuera de alcance

| Excluido | Motivo |
| --- | --- |
| Pruebas formales o verificación de programas | Proof registra evidencia operativa, no prueba corrección. |
| Decidir permisos o aprobar acciones | El gate existente (`permissions/decide.ts`) es la única autoridad (D6). |
| Generación automática de tests con modelo | Solo el verificador `coverage` opt-in (Fase 7) y sin escribir tests por sí mismo. |
| Evaluación con juez-LLM como verificador | Un verificador narrativo viola D2; si se pide, queda `manual_review`. |
| Medir fiabilidad entre ejecuciones | Es `specs/archive/010-reliability-lab-v1.md`. |
| Milestones, checkpoints y reanudación | Es `specs/017-goal-milestones-v1.md`, que reutiliza los IDs de evidencia. |
| Sandbox de los comandos verificadores | Un subproceso no es un sandbox; se ejecutan con el mismo gate que cualquier `run_process`. |

## 2. Base verificada del código

| Hecho (verificado) | Ubicación | Implicación |
| --- | --- | --- |
| `tool_completed` expone `id`, `name`, `isError`, `durationMs`, `preview` (≤2 000 chars) | `packages/sdk/src/index.ts` l.~546 | Fuente de captura, pero `preview` no incluye código de salida ni salida completa: hay que capturar más en el runner. |
| `GoalEvidence {kind: file\|test\|log\|command\|denied\|other; detail}` | `sdk/src/index.ts` l.~1177 | Se amplía de forma aditiva con `evidenceId?`; `detail` sigue siendo texto libre. |
| Estados de goal `active\|paused\|blocked\|budget_limited\|complete`; razones incl. `no_progress` | `core/src/goal/machine.ts`, `service.ts`, `store.ts` | Un goal con criterios `failed` no podrá pasar a `complete` sin marca explícita. |
| `exit_plan` y manifiesto de plan | `core/src/plan/{exit-plan,manifest}.ts` | Ganan `acceptanceCriteria[]` opcional; Plan Review los aprueba. |
| `AgentRunner.executeCall()` es el único punto de ejecución de llamadas | `core/src/core/runner.ts` (l.~669) | Punto único de captura: los hijos, Forja anidada y herramientas de plugins pasan por ahí. |
| `Effect = read\|write\|process\|external\|internal`; `run_process`, `shell`, `bg_run` son `process` | `sdk/src/index.ts`, `tools/standard.ts` | Verificadores `command` se ejecutan con efecto `process` y el gate normal. |
| `read_file` devuelve `sha256`; `write_file/edit_file` con precondición sha256 | `tools/standard.ts` | Base de la caducidad por archivo. |
| `artifacts/publisher.ts` publica artefactos de sesión | `core/src/artifacts/publisher.ts` | Camino de `proof.md` / `proof.json`. |
| Migraciones forward-only hasta v10 en `SQLiteStore` | `packages/core/src/runtime/store.ts` | Nueva migración para `proof_criteria` y `proof_evidence`. |
| No hay marcado de afirmaciones ni ledger de criterios | — | **(nuevo)** todo el módulo `proof/*`. |
| Plugins: `PluginAPI` sin `proof` | `sdk/src/index.ts` | **(nuevo)** `api.proof?` opcional con feature-detect. |

## 3. Diseño

### 3.1 Modelo conceptual

```
Criterion  1 ── n  Verifier binding  1 ── n  Evidence (inmutable)
   │                                             │
   └── estado derivado (D4) ◄───────────────────┘ + caducidad
```

- **Criterio**: enunciado verificable, `required` (booleano), origen (`plan | goal | user | inferred`), alcance de archivos opcional (`scope: string[]` de globs).
- **Verificador**: cómo se comprueba. Tipos incorporados: `command` (comando exacto + criterio de éxito por código de salida y, opcional, patrón en salida), `file` (existencia/hash/contenido por regex), `data-check` (reconciliación de totales sobre `data_query`: suma, conteo, igualdad contra la fuente), `coverage` (opt-in, Fase 7), `manual` (siempre `manual_review`).
- **Evidencia**: registro inmutable `{evidenceId, criterionId, verifierKind, runId, callId, commandFingerprint?, exitCode?, durationMs, outputHash, capturedAt, treeFingerprint, filesTouched[]}`. Nunca se edita; una nueva ejecución crea otra evidencia.

### 3.2 Estado derivado (D4)

El estado de un criterio se **calcula**, no se escribe:

| Estado | Condición |
| --- | --- |
| `verified` | Existe evidencia exitosa más reciente que toda edición del alcance del criterio. |
| `failed` | La evidencia más reciente vigente es un fallo. |
| `not_checked` | Sin verificador o sin evidencia. Variante de presentación `stale` si había evidencia exitosa y una edición posterior tocó su alcance (D5). |
| `manual_review` | Verificador `manual` o criterio que el usuario debe revisar. |
| `not_applicable` | Marcado por el usuario con motivo (nunca por el modelo). |

### 3.3 Captura automática de evidencia

`ProofRecorder` (nuevo, `core/src/proof/recorder.ts`) se suscribe al bus del runner. Para cada `tool_completed` de `run_process`, `shell`, `bg_run`/`bg_output` y `data_query`, si existe un criterio activo con verificador `command` o `data-check` cuya huella coincida, registra la evidencia. La huella del comando es `sha256(argv normalizado + cwd relativo)`; la salida se guarda como `outputHash` y un extracto acotado (≤4 KB) en la fila, con redacción de valores que parezcan credenciales (reutilizar el redactor existente del core si lo hay; si no, **(no verificado)** y se añade uno mínimo en `proof/redact.ts`).

### 3.4 Caducidad (D5)

Cada evidencia guarda `treeFingerprint` = hash de `git diff` (acotado) + `sha256` de los archivos de `filesTouched`. Tras `write_file`/`edit_file` exitoso, el recorder recorre los criterios cuyo `scope` intersecta la ruta editada (si no hay `scope`, el alcance es todo el workspace) y la evidencia anterior queda caducada. La caducidad se evalúa al leer, de forma pura y determinista.

### 3.5 Divergencia afirmación/evidencia

`detectDivergence(finalText, ledger)` (puro) busca afirmaciones por patrones cerrados y multilingües simples («tests pass», «typecheck ok», «lint clean», «los tests pasan») y las cruza con criterios de tipo equivalente. Devuelve `{claim, expected, actualState}`. Solo se **muestra** (aviso en las tres superficies); nunca corrige el texto ni cambia estados. Es heurístico y se documenta como señal, no garantía.

### 3.6 Integración con plan y goal

- `exit_plan` gana `acceptanceCriteria?: {text, verifier?, required?, scope?}[]`. Si el modelo no los da, el sistema puede proponer un **borrador** inferido (origen `inferred`) que el usuario aprueba o edita en Plan Review (O3).
- `update_goal` con estado `complete` adjunta el ledger; si hay criterios requeridos `failed` o `not_checked`, la transición exige `override: {reason}` explícito del usuario (no del modelo) o queda en `blocked`/`active`. Sin criterios, `/goal` se comporta como en 0.6.x.
- `GoalEvidence.evidenceId?` enlaza evidencia declarada por el modelo con evidencia capturada; una declaración sin `evidenceId` sigue siendo texto libre y **no** cuenta para `verified`.

### 3.7 Modo CI

`alisio run --json --proof` (o `proof.ci: true`): al terminar, emite el ledger como evento final y devuelve código de salida ≠0 si algún criterio requerido no está `verified`. Códigos propuestos: 0 = todo verificado, 10 = hay requeridos `failed`, 11 = hay requeridos `not_checked|manual_review`. Para que haya criterios en headless sin plan, se aceptan por `--criterion "texto" --verify "comando"` repetibles y por archivo `--proof-file proof.json` (O4).

### 3.8 Verificadores de plugins

`api.proof?.registerVerifier({id, describe, run(input, ctx): Promise<ProofResult>})`, con feature-detect (un plugin sigue funcionando en un core sin Proof). Debe devolver evidencia referenciable (`outputHash`, `callId` opcional); un resultado sin evidencia se degrada a `manual_review`. Los verificadores de plugins no ganan permisos: sus llamadas internas pasan por las herramientas del core.

## 4. Contratos y tipos (SDK, aditivos)

```ts
export type ProofStatus = "verified" | "failed" | "not_checked" | "manual_review" | "not_applicable";
export type ProofVerifierSpec =
  | { kind: "command"; command: string; cwd?: string; successExitCodes?: number[]; outputPattern?: string }
  | { kind: "file"; path: string; sha256?: string; pattern?: string }
  | { kind: "data-check"; datasetId: string; check: "row_count" | "sum" | "equals"; column?: string; expected: number | string }
  | { kind: "coverage"; command: string; minPercent: number }
  | { kind: "manual" }
  | { kind: "plugin"; verifierId: string; input?: unknown };

export interface ProofCriterion {
  criterionId: string;
  sessionId: string;
  goalId?: string;
  text: string;
  required: boolean;
  origin: "plan" | "goal" | "user" | "inferred" | "cli";
  verifier?: ProofVerifierSpec;
  scope?: string[];
  status: ProofStatus;
  stale?: boolean;
  evidenceIds: string[];
  notApplicableReason?: string;
}

export interface ProofEvidence {
  evidenceId: string;
  criterionId: string;
  verifierKind: ProofVerifierSpec["kind"];
  runId: string;
  callId: string;
  ok: boolean;
  commandFingerprint?: string;
  exitCode?: number;
  durationMs: number;
  outputHash: string;
  excerpt?: string;
  treeFingerprint: string;
  filesTouched: string[];
  capturedAt: string;
}

export interface ProofLedger {
  sessionId: string;
  criteria: ProofCriterion[];
  evidence: ProofEvidence[];
  divergences: { claim: string; criterionId?: string; actual: ProofStatus }[];
  generatedAt: string;
}
```

Eventos nuevos (aditivos en `RunEventDataMap`): `proof_updated: { criterionId: string; status: ProofStatus; stale: boolean; evidenceId?: string }` y `proof_divergence: { claim: string; criterionId?: string; actual: ProofStatus }`.

Ruta: `GET /api/sessions/:sid/proof` → `ProofLedger`; `POST /api/sessions/:sid/proof/criteria` (alta/edición por el usuario), `POST .../criteria/:id/not-applicable` (con motivo), `GET .../proof/export?format=md|json`. Auth y límites como el resto de rutas de sesión.

Migración (siguiente migración libre; v11 si es la primera en ejecutarse): tablas `proof_criteria(criterion_id PK, session_id, goal_id, text, required, origin, verifier_json, scope_json, na_reason, created_at)` y `proof_evidence(evidence_id PK, criterion_id, run_id, call_id, ok, verifier_kind, fingerprint, exit_code, duration_ms, output_hash, excerpt, tree_fingerprint, files_json, captured_at)` con índices por `session_id` y `criterion_id`. `proof_evidence` es append-only (sin UPDATE; el borrado es solo por borrado de sesión).

## 5. Fases

Cada fase: Rojo → Verde → Refactor, repo verde al cerrar (`pnpm typecheck|lint|test|build|test:cli|test:compiled|pack:check|docs:check|docs:build`). Sin commit hasta que lo pida el propietario.

### Fase 0 — Medición y contrato (sin código de producción)

Trabajo: (a) inventariar con un script en `scripts/` cuántos `tool_completed` de `run_process|shell` hay en sesiones sintéticas y cuánto pesa capturar salida completa vs. `outputHash`; (b) fijar el formato de huella de comando y el redactor de credenciales; (c) escribir el contrato `ProofLedger` como pruebas de tipos; (d) decidir O1..O8 con el propietario.
Aceptación: informe corto en la propia spec (sección de decisiones cerradas); costo de captura medido (<5 % de latencia por llamada en la muestra) o ajuste de diseño; propietario aprueba pasar a Fase 1.
Pruebas: ninguna de producción; las pruebas de contrato de tipos fallan antes de implementar.

### Fase 1 — Núcleo del ledger y persistencia

Trabajo: `core/src/proof/{types,ledger,store}.ts`; estado derivado puro (`deriveStatus`); migración; tipos en `@alisio/sdk`.
Aceptación: (1) un criterio sin verificador queda `not_checked`; (2) `verified` exige evidencia existente con `runId/callId`; (3) la evidencia es append-only; (4) migración forward-only sobre una base v10 existente conserva los datos.
Pruebas: `tests/proof-ledger.test.ts` (derivación de estados por tabla de casos), `tests/proof-store.test.ts` (migración, append-only, borrado en cascada de sesión).

### Fase 2 — Captura automática desde el runner

Trabajo: `ProofRecorder` suscrito a `tool_completed` en `core/src/core/runner.ts`; huella de comando; redacción; verificador `command`; evento `proof_updated`.
Aceptación: ejecutar `pnpm test` mediante `run_process` con un criterio ligado a ese comando produce evidencia sin que el modelo declare nada; un comando distinto no la produce; el modelo no puede crear evidencia vía texto.
Pruebas: `tests/proof-recorder.test.ts` con proveedor scripted (patrón de `tests/runner-gate-characterization.test.ts`): éxito, fallo (exit≠0), comando no coincidente, llamadas en lote paralelo `read` sin interferencia, orden estable por `callId`.

### Fase 3 — Caducidad y detector de divergencia

Trabajo: `treeFingerprint`; invalidez tras `write_file/edit_file` dentro del `scope`; `detectDivergence`; evento `proof_divergence`.
Aceptación: (1) una edición posterior en el alcance marca la evidencia como caducada; (2) una edición fuera del alcance no; (3) la divergencia «tests pass» sin criterio `verified` se reporta y no altera estados.
Pruebas: `tests/proof-staleness.test.ts`, `tests/proof-divergence.test.ts` (afirmaciones EN/ES, falsos positivos en citas y código).

### Fase 4 — Plan y goal

Trabajo: `acceptanceCriteria` en `exit_plan` y manifiesto; borrador inferido aprobado en Plan Review; `update_goal complete` con ledger y `override` del usuario; `GoalEvidence.evidenceId?`.
Aceptación: (1) un goal con criterios requeridos `failed` no queda `complete` sin override del usuario; (2) sin criterios, el comportamiento es idéntico a 0.6.x (prueba de caracterización); (3) los criterios inferidos nunca se activan sin aprobación.
Pruebas: `tests/proof-goal.test.ts`, `tests/proof-plan.test.ts`, ampliación de las pruebas existentes de goal sin cambiar sus expectativas.

### Fase 5 — Superficies: servidor, Web, TUI, headless

Trabajo: ruta `GET /api/sessions/:sid/proof` (+ alta/edición); SSE de `proof_updated`; tarjeta Proof en el hilo y panel; `/proof` TUI; `--proof`, `--criterion`, `--verify`, `--proof-file`; códigos de salida 10/11; export `proof.md`/`proof.json` vía `artifacts/publisher.ts`; i18n EN/ES.
Aceptación: (1) TUI, Web y JSONL muestran los mismos estados desde el mismo ledger; (2) `--proof` devuelve exit ≠0 con requeridos no verificados; (3) el export JSON es estable y versionado (`proof/v1`).
Pruebas: `tests/proof-routes.test.ts`, `tests/proof-cli.test.ts` (salida y códigos), pruebas de componente web de la tarjeta; captura `proof_web_ui.webp` en docs EN/ES.

### Fase 6 — Verificadores `file`, `data-check` y API de plugins

Trabajo: verificador `file`; `data-check` (conteo, suma, igualdad contra `data_query`) usando `data_inspect|data_query`; `api.proof?.registerVerifier` con feature-detect.
Aceptación: un `data-check` con total distinto produce `failed` con evidencia; un plugin sin evidencia referenciable degrada a `manual_review`; un core sin `api.proof` no rompe plugins que la usan opcionalmente.
Pruebas: `tests/proof-verifiers.test.ts`, `tests/proof-plugin-api.test.ts`.

### Fase 7 — Verificador `coverage` (opt-in, tardía)

Trabajo: verificador `coverage` que ejecuta el comando de cobertura configurado, parsea el porcentaje (formatos `lcov`/resumen de vitest y `coverage.py`) y compara con `minPercent`; no genera tests.
Aceptación: desactivado por defecto (`proof.coverage.enabled: false`); con él, un porcentaje bajo produce `failed` con evidencia.
Pruebas: `tests/proof-coverage.test.ts` con salidas de muestra fijas.

### Fase 8 — Documentación, estado y puerta de medición

Trabajo: `docs/proof.md` EN/ES en paridad; `docs/implementation-status.md` con límites; entrada de changelog; ejecutar la comparación con `specs/archive/010-reliability-lab-v1.md` si ya existe (costo de tokens/latencia con y sin Proof).
Aceptación: `pnpm docs:check` y `pnpm docs:build` en verde; límites documentados (heurística de divergencia, huella de árbol acotada).

## 6. Seguridad y privacidad

- Proof no concede permisos: los verificadores `command` usan `run_process` bajo el gate y los modos (`ask|auto|full`, `--read-only`); en `--read-only` los verificadores `command` quedan `not_checked` con razón visible.
- Los extractos de salida se redactan; no se guardan variables de entorno ni cabeceras.
- Un resultado de herramienta no puede crear, editar ni marcar `not_applicable` un criterio: solo el usuario y la política de plan/goal.
- El ledger vive en la base de la sesión; nada sale de la máquina salvo export explícito.

## 7. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Falsos `verified` con verificador débil | El verificador declara qué cubre; `verified` solo con evidencia fechada y vigente; documentar que no prueba corrección. |
| Costo extra de ejecutar comandos | Reutilizar evidencia vigente; nunca re-ejecutar sin permiso `process`. |
| Ruido en tareas triviales | Proof solo se activa con criterios, goal o plan (D7). |
| Heurística de divergencia con falsos positivos | Solo muestra; sin efecto sobre estados; corpus de pruebas EN/ES. |
| Huella de árbol cara en repos grandes | `git diff` acotado y hash de archivos tocados; cachear por `treeFingerprint`. |
| Secretos en extractos | Redacción y límite de tamaño; prueba dedicada. |

## 8. Decisiones del propietario (O1..O8, pendientes: propuesta, a confirmar)

| ID | Pregunta | Recomendación |
| --- | --- | --- |
| O1 | ¿Proof se activa solo con criterios/goal/plan o también un ledger vacío en cada run? | Solo con criterios, goal o plan (D7); evita ruido. |
| O2 | ¿`not_applicable` lo puede marcar solo el usuario? | Sí, solo el usuario, con motivo. |
| O3 | ¿Los criterios inferidos se generan por modelo o por plantilla? | Por el modelo en `exit_plan`, siempre como borrador aprobado por el usuario; sin plan, solo manuales/CLI. |
| O4 | ¿Fuente de criterios en headless? | `--criterion/--verify` repetibles y `--proof-file`; sin inferencia automática. |
| O5 | ¿Códigos de salida 10/11 son adecuados? | Sí; configurables por `proof.exitCodes`. |
| O6 | ¿Un goal con criterios requeridos no verificados debe bloquearse o solo avisar? | Bloquear el paso a `complete` sin override del usuario. |
| O7 | ¿Verificadores de plugins en esta versión? | Sí, opcionales con feature-detect (Fase 6). |
| O8 | ¿`coverage` entra en esta versión? | Sí, opt-in y al final (Fase 7); si se retrasa, no bloquea el cierre. |

## 9. Decisiones de diseño (D1..D8, vinculantes)

- **D1** Un criterio sin verificador es `not_checked`.
- **D2** `verified` exige evidencia existente con `runId`, `callId` y fecha.
- **D3** La evidencia se captura de eventos del runner; el modelo no la fabrica.
- **D4** El estado se calcula, no se almacena como verdad independiente.
- **D5** Una edición posterior en el alcance caduca la evidencia afectada.
- **D6** Proof no decide permisos ni ejecuta lo que el gate no permitiría.
- **D7** Sin criterios, goal ni plan, el comportamiento es byte-idéntico a 0.6.x.
- **D8** La divergencia afirmación/evidencia solo se muestra; nunca se corrige en silencio.

## 10. Criterios de aceptación globales

1. Un criterio sin verificador queda `not_checked` aunque el modelo diga que está hecho.
2. Todo `verified` apunta a evidencia existente con `runId/callId` y fecha.
3. Una edición posterior marca la evidencia afectada como caducada.
4. TUI, Web y JSONL muestran los mismos estados desde la misma fuente.
5. `--proof` devuelve código ≠0 con criterios requeridos no verificados.
6. Sin criterios/goal/plan, un run es indistinguible de 0.6.x (prueba de caracterización).

## 11. Pruebas transversales

- Caracterización de 0.6.x intacta para runs sin Proof.
- Proveedor scripted para todas las pruebas del runner; sin red.
- Pruebas de contrato del SDK (tipos aditivos) y de la ruta HTTP.
- Prueba de que un `tool_result` con texto «mark criterion verified» no altera el ledger.

## 12. Estado de implementación

Estado: **Borrador (2026-10-13).** Nada implementado. Actualizar `docs/implementation-status.md` al cerrar cada fase.

## 13. Asignación de modelos

Sonnet por defecto en todas las fases. Opus solo en: (1) diseño del estado derivado y la caducidad (Fases 1 y 3, razonamiento sobre invariantes); (2) revisión de la integración con `update_goal`/máquina de estados de goal (Fase 4).
