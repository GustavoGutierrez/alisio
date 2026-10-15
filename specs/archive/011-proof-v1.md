# Especificación Técnica: Proof — criterios de aceptación con evidencia verificable

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 2 de 8** |
| Proyecto | Alisio |
| Estado | **Implementada (fases 0-8)**. Ver `docs/implementation-status.md`. |
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

### Fase 0: informe (2026-10-14)

Ejecutada solo la auditoría y la Fase 0; sin código de producción. Artefactos: `scripts/proof-phase0.ts` (medición y huella; `node --experimental-strip-types scripts/proof-phase0.ts`) y `tests/proof-ledger-contract.test.ts` (contrato de tipos pendiente).

**Auditoría de la §2 contra `main` (0.7.0, `4619bae`) (verificado 2026-10-14).** Líneas y símbolos de la §2 coinciden (`tool_completed` l.546, `GoalEvidence` l.1177, `executeCall` l.669, `publisher.ts`, `plan/{exit-plan,manifest}.ts`, `runProcess`/`shell`/`bg_run`/`data_query` existentes). No existe código de Proof (`packages/core/src/proof` no existe; ningún símbolo `Proof*` en `packages/`). Desvíos:

1. **Versión**: la spec etiqueta «0.6.0, `2e867c7`»; el repo está en 0.7.0 (Reliability Lab). La «siguiente minor» pasa a 0.8.0. Sin otro efecto.
2. **Migración**: `schema_migrations` llega a v10; v11 sigue libre. Ninguna otra spec la ha consumido (la 015 usa la serie propia 100+ del plugin). Las specs 012, 013, 014 y 017 también reclaman «v11 si es la primera en ejecutarse»: Proof es la segunda en orden de ejecución, se renumera al ejecutar.
3. **Redactor existente (cierra el «no verificado» de la §3.3)**: `redactSecrets`/`findSecrets` en `packages/core/src/eval/secrets.ts`, reexportados por `core/src/index.ts`.
4. **Hallazgo de captura, más fuerte que la §2**: el resultado de `run_process`/`shell` es el JSON `{stdout, stderr, exitCode, truncated}`; `exitCode` va al final y `preview` se corta a 2 000 caracteres, así que con salida larga el código de salida se pierde. Además, tras 48 000 caracteres `executeCall` reemplaza el resultado por texto truncado que ya no es JSON. El `ProofRecorder` debe leer el `ToolResult` crudo justo después de `p.tool.execute(...)` y antes de ese acotado, no suscribirse al evento `tool_completed`. `bg_run` entrega el código de salida de forma asíncrona vía `bg_output`: Fase 2 debe tratarlo aparte.

**Medición (a)** (Node 22.19, linux/x64; sesiones sintéticas, mezcla de herramientas supuesta, no telemetría). 200 sesiones x 60 llamadas: 3 597 `tool_completed` de `run_process|shell` (30 %, mediana 18 por sesión, máx. 29). Costo de captura por llamada frente a un proceso real:

| Salida | Proceso (ms) | `outputHash` + extracto ≤4 KB | Salida completa redactada |
| --- | --- | --- | --- |
| 512 B | 18,2 | 0,06 % | 0,07 % |
| 4 KB | 18,3 | 0,12 % | 0,14 % |
| 32 KB | 18,4 | 0,31 % | 0,56 % |
| 47 KB | 19,1 | 0,32 % | 0,75 % |

Ambos diseños quedan muy por debajo del 5 %. Límite de la medición: SQLite en memoria (sin fsync) y proceso mínimo; comandos reales (`pnpm test`) son más lentos, lo que reduce el porcentaje. **Sin ajuste de diseño**; se mantiene `outputHash` + extracto ≤4 KB (la salida completa no aporta y aumenta la superficie de secretos).

**Decisión (b), huella v1**: `sha256(JSON.stringify({v:1, argv, cwd}))`. `run_process`: `argv = [command, ...args]`; `shell`: `argv = ["sh","-c", comando normalizado]`, donde normalizar = recortar y colapsar espacios fuera de comillas; `cwd` relativo al workspace con `/` y `"."` por defecto. Sin entorno. `run_process` y `shell` equivalentes no comparten huella (deliberado). Implementada y comprobada en el script (6 comprobaciones). **Redactor**: reutilizar `redactSecrets`; no se crea `proof/redact.ts`. Reglas actuales cubren `sk-`, `ghp_`, `github_pat_`, AKIA, Slack, Bearer, PEM y `*_API_KEY=`; no cubren `password=` ni `TOKEN=` genéricos: en Fase 2 se amplían las reglas del mismo módulo (aditivo) con prueba dedicada.

**Decisión (c)**: el contrato vive en `tests/proof-ledger-contract.test.ts` (`expectTypeOf` + `it.todo` de D1, D2, D5). Lleva `// @ts-nocheck` temporal porque los tipos aún no existen en `@alisio/sdk`, por lo que `pnpm typecheck`, `lint` y `test` siguen en verde. Sin el `@ts-nocheck` falla con 8 errores TS2305/TS2339 (tipos y eventos inexistentes): estado rojo comprobado. Activación en Fase 1: añadir los tipos al SDK y borrar esa línea sin editar las expectativas.

**Decisiones cerradas**: O1..O8 sin cambios; hook de captura dentro de `executeCall` sobre el resultado crudo; huella v1; redactor reutilizado; diseño `outputHash` + extracto; migración «siguiente libre».

**Pregunta para la puerta (una sola)**: ¿apruebas pasar a la Fase 1 con el hook de captura en `executeCall` (sobre el `ToolResult` crudo, antes del acotado de 48 000 caracteres) en lugar de suscribirse a `tool_completed`, tal como recomienda este informe?

### Fase 1 — Núcleo del ledger y persistencia

Trabajo: `core/src/proof/{types,ledger,store}.ts`; estado derivado puro (`deriveStatus`); migración; tipos en `@alisio/sdk`.
Aceptación: (1) un criterio sin verificador queda `not_checked`; (2) `verified` exige evidencia existente con `runId/callId`; (3) la evidencia es append-only; (4) migración forward-only sobre una base v10 existente conserva los datos.
Pruebas: `tests/proof-ledger.test.ts` (derivación de estados por tabla de casos), `tests/proof-store.test.ts` (migración, append-only, borrado en cascada de sesión).

### Fase 1: informe (2026-10-14)

Implementada solo la Fase 1; Fase 2 no iniciada. Sin commit. Estado de la spec sin cambios.

- **SDK** (`packages/sdk/src/index.ts`, aditivo): `ProofStatus`, `ProofVerifierSpec`, `ProofCriterion`, `ProofEvidence`, `ProofLedger`, `proof_updated` y `proof_divergence` en `RunEventDataMap`, `GoalEvidence.evidenceId?`. `PluginAPI.proof?` no se tocó (Fase 6). `tests/proof-ledger-contract.test.ts` activado quitando solo el `@ts-nocheck`; `tests/run-events-contract.test.ts` gana las dos entradas de eventos (su tipo mapeado lo exige).
- **Core** (`packages/core/src/proof/{types,ledger,store,index}.ts`, reexportado desde `core/src/index.ts`): `deriveStatus` puro (D1, D2, D4, D5), `buildLedger` y `ProofStore` (`addCriterion`, `criterion`, `markNotApplicable`, `appendEvidence`, `ledger`).
- **Migración**: **v11** en `runtime/store.ts` (`proof_criteria` con `ON DELETE CASCADE` a `sessions`; `proof_evidence` con cascada a su criterio y trigger `BEFORE UPDATE` que aborta). Aditiva y forward-only.
- **Decisiones de detalle** que la spec no fijaba: una edición en el mismo instante que la evidencia (`lastEditAt >= capturedAt`) la caduca (ante la duda, no `verified`); una evidencia fallida caducada pasa a `not_checked` sin marca `stale` (que solo aplica a éxitos caducados); evidencia sin `runId`, `callId` o fecha válida no respalda ningún estado (D2) y además `appendEvidence` la rechaza; con empate de `capturedAt` gana la fila posterior; el borrado no tiene trigger porque la cascada de sesión debe poder borrar evidencia. `deriveStatus` recibe `lastEditAt` como parámetro; la Fase 3 lo alimentará.
- **Pruebas**: `tests/proof-ledger.test.ts` (tabla de 16 casos más 3), `tests/proof-store.test.ts` (migración sobre base v10 con datos e idempotencia, solo anexado, rechazo de evidencia sin `runId/callId`, cascada, `not_applicable` con motivo).
- **Docs**: `docs/implementation-status.md`, `docs/{,es/}architecture.md` (v11) y changeset `.changeset/proof-ledger-core.md`.

### Fase 2 — Captura automática desde el runner

Trabajo: `ProofRecorder` suscrito a `tool_completed` en `core/src/core/runner.ts`; huella de comando; redacción; verificador `command`; evento `proof_updated`.
Aceptación: ejecutar `pnpm test` mediante `run_process` con un criterio ligado a ese comando produce evidencia sin que el modelo declare nada; un comando distinto no la produce; el modelo no puede crear evidencia vía texto.
Pruebas: `tests/proof-recorder.test.ts` con proveedor scripted (patrón de `tests/runner-gate-characterization.test.ts`): éxito, fallo (exit≠0), comando no coincidente, llamadas en lote paralelo `read` sin interferencia, orden estable por `callId`.

### Fase 2: informe (2026-10-14)

Implementada solo la Fase 2; Fase 3 no iniciada. Sin commit. Estado de la spec sin cambios.

- **Hook**: `RunnerOptions.proof?: ProofRecorder`; `executeCall` llama a `proof.capture(...)` justo después de `p.tool.execute(...)` y antes del acotado de 48 000 caracteres (decisión de la Fase 0). Un fallo del recorder se traga: nunca rompe la llamada. `createApplication` lo conecta siempre; sin `proof` el runner no cambia. Los `proof_updated` se emiten después de `tool_completed`.
- **Cierre de la pregunta abierta de la Fase 1**: antes de anexar, el recorder comprueba que `(sessionId, callId, runId, name)` exista en el diario `tool_calls` (lo escribe el runner antes de ejecutar). Una llamada denegada (`--read-only`) lanza antes de ejecutar y nunca llega al hook, así que los criterios `command` quedan `not_checked` sin código extra.
- **D7**: sin criterios `command` la única diferencia es una lectura indexada por `session_id`, y solo en `run_process|shell|bg_run|bg_output`; el resto de herramientas retorna antes. Prueba de caracterización: mismos mensajes y mismos tipos de evento que un runner sin recorder, sin filas ni `proof_updated`.
- **Huella**: `proof/command.ts` (`commandFingerprint`, `normalizeShell`, `criterionFingerprints`). Decisión: un criterio acepta tanto la forma `run_process` (argv, si la línea no usa operadores de shell) como la forma `shell`; así `pnpm test` coincide con `run_process pnpm test` (criterio de aceptación). Las huellas de las llamadas siguen sin compartirse entre herramientas.
- **Redacción**: `redactOutput` en `eval/secrets.ts` añade asignaciones genéricas (`password=`, `TOKEN=`, `"api_token": ...`) sin tocar `RULES`, porque una regla nueva allí haría que `findSecrets` rechace cassettes del Reliability Lab. Se redacta antes de recortar y el extracto son los últimos 4096 bytes (el final de un test suele traer el resumen).
- **`bg_run`**: se recuerda la tarea en memoria (tope 256); la evidencia nace del primer `bg_output` con `exit_code`, una vez por tarea, y su `outputHash`/extracto cubren solo la ventana leída. `data_query`/`data-check` queda para la Fase 6; `treeFingerprint` ("") y `filesTouched` ([]) quedan para la Fase 3.
- **Pruebas**: `tests/proof-recorder.test.ts` (15) y `tests/proof-command.test.ts` (7); `tests/forge-gate-helpers.ts` gana la opción `proof`. Docs: `docs/implementation-status.md`, changeset `.changeset/proof-recorder.md`, fila Proof en la skill `alisio-pkg-core`. Sin cambios EN/ES porque no hay superficie de usuario aún.

### Fase 3 — Caducidad y detector de divergencia

Trabajo: `treeFingerprint`; invalidez tras `write_file/edit_file` dentro del `scope`; `detectDivergence`; evento `proof_divergence`.
Aceptación: (1) una edición posterior en el alcance marca la evidencia como caducada; (2) una edición fuera del alcance no; (3) la divergencia «tests pass» sin criterio `verified` se reporta y no altera estados.
Pruebas: `tests/proof-staleness.test.ts`, `tests/proof-divergence.test.ts` (afirmaciones EN/ES, falsos positivos en citas y código).

### Fase 3: informe (2026-10-14)

Implementada solo la Fase 3; Fase 4 no iniciada. Sin commit. Estado de la spec sin cambios.

- **Caducidad**: tras un `write_file`/`edit_file` correcto, `ProofRecorder.captureEdit` anota la ruta (relativa al workspace) y la hora; `ProofStore.ledger` deriva `lastEditAt` por criterio con `scopeMatches` (`proof/scope.ts`, globs propios, sin dependencias; un directorio cubre su contenido; sin `scope`, todo el workspace) y `deriveStatus` no cambia. `proof_updated` se emite solo si cambia el estado o `stale`.
- **Persistencia**: el diario `tool_calls` no guarda la ruta de entrada, así que derivarlo de ahí era imposible; hizo falta la migración **v12** `proof_edits(session_id, path, edited_at)`, una fila por ruta (la edición más reciente), cascada con la sesión. Solo se anotan ediciones si la sesión tiene criterios `command` (D7); una edición anterior a la creación del criterio no puede caducar evidencia posterior, así que no se pierde nada.
- **`treeFingerprint`** (`proof/tree.ts`): sha256 de `{v:1, diff, archivos}`; `git diff HEAD` acotado a 1 MiB y 3 s (sin `HEAD` usa el índice; fuera de git, constante), `--no-ext-diff --no-textconv`; archivos tocados ordenados, hasta 200. Es un ancla de auditoría y no decide la caducidad. Interpretación del «cachear por huella»: se calcula una vez por llamada y los hashes de archivo se cachean por ruta, tamaño y mtime; el diff no se puede cachear sin conocer su invalidación.
- **Divergencia** (`proof/divergence.ts`): patrones cerrados EN/ES con listas coordinadas, descarte de código, citas y negaciones/condicionales del tramo previo; equivalencia por comando del criterio o, sin verificador de comando, por su texto. Sin criterios devuelve vacío (D7); con criterios pero sin uno equivalente informa `not_checked`. Decisión de detalle: `expected` es el literal `"verified"`.
- **Runner**: emite `proof_divergence` antes de `run_completed` del turno final; un fallo del detector se traga.
- **Pruebas**: `tests/proof-staleness.test.ts` y `tests/proof-divergence.test.ts`; `gateFixture` gana `finalText`; las pruebas de migración v4..v7 pasan a esperar la versión 12.
- **Pregunta abierta para la Fase 4/5**: los cambios por `shell` o `js_run` no caducan la evidencia (solo `write_file`/`edit_file`, como dice la §3.4); comparar el `treeFingerprint` actual con el de la evidencia lo cubriría, pero cuesta un `git diff` por lectura y rompe la pureza de la lectura. Se deja documentado como límite.

### Fase 4 — Plan y goal

Trabajo: `acceptanceCriteria` en `exit_plan` y manifiesto; borrador inferido aprobado en Plan Review; `update_goal complete` con ledger y `override` del usuario; `GoalEvidence.evidenceId?`.
Aceptación: (1) un goal con criterios requeridos `failed` no queda `complete` sin override del usuario; (2) sin criterios, el comportamiento es idéntico a 0.6.x (prueba de caracterización); (3) los criterios inferidos nunca se activan sin aprobación.
Pruebas: `tests/proof-goal.test.ts`, `tests/proof-plan.test.ts`, ampliación de las pruebas existentes de goal sin cambiar sus expectativas.

### Fase 4: informe (2026-10-14)

Implementada solo la Fase 4; Fase 5 no iniciada. Sin commit. Estado de la spec sin cambios.

- **Plan (O3)**: `exit_plan` gana `acceptanceCriteria?`, validado en `plan/criteria.ts` (verificadores `command|file|manual`, alcance relativo al workspace, máx. 20). Los borradores viven en `PlanState.criteria`, se muestran en `PlanReview.acceptanceCriteria` y `plan.json`, y entran en el hash del plan solo cuando existen (sin criterios el hash no cambia). Solo la aprobación del usuario (`decidePlan`, una vez) crea criterios (`origin: inferred`) vía `ProofStore`; cualquier otra decisión, una revisión nueva o una sesión sin revisión posible los descarta.
- **Goal (O6)**: `GoalService.report` lee el ledger en la misma transacción y rechaza `complete` con criterios requeridos `failed|not_checked` (el goal sigue `active`; el modelo recibe `unmet`). Instantánea al completar en `session_goals.proof_json` (migración **v13**). El override es `GoalService.overrideComplete`, un método solo de usuario sin ruta desde el modelo; deja `reason: user_override`.
- **`evidenceId`**: se conserva solo si resuelve a evidencia de la sesión; si no, se descarta (texto libre).
- **Invariantes elegidos (revisión Opus pendiente)**: (1) criterios aplicables = los de `goalId` igual o sin `goalId`; (2) solo `failed|not_checked` bloquean, no `manual_review`; (3) el rechazo deja el goal `active` y no toca rachas ni topes; (4) override solo desde `active|paused|blocked`, nunca desde `budget_limited|complete`, y solo si hay algo que anular; (5) el override conserva `inflight` como `modelComplete`; (6) el veredicto y la escritura ocurren en una sola transacción `BEGIN IMMEDIATE`; (7) `evidenceId` nunca altera un estado.
- **Pregunta abierta para Fase 5**: ¿qué superficie y qué acción de `GoalAction` expone el override (hoy no se añadió para no cambiar `actions` de los goals existentes)? Y la edición/rechazo individual de borradores en Plan Review (hoy es todo o nada).
- **Pruebas**: `tests/proof-goal.test.ts` (19) y `tests/proof-plan.test.ts` (17). Las migraciones v4..v7, `integration` y `plan-diagrams-config` actualizan su expectativa por la versión 13 y el campo nuevo.

### Fase 5 — Superficies: servidor, Web, TUI, headless

Trabajo: ruta `GET /api/sessions/:sid/proof` (+ alta/edición); SSE de `proof_updated`; tarjeta Proof en el hilo y panel; `/proof` TUI; `--proof`, `--criterion`, `--verify`, `--proof-file`; códigos de salida 10/11; export `proof.md`/`proof.json` vía `artifacts/publisher.ts`; i18n EN/ES.
Aceptación: (1) TUI, Web y JSONL muestran los mismos estados desde el mismo ledger; (2) `--proof` devuelve exit ≠0 con requeridos no verificados; (3) el export JSON es estable y versionado (`proof/v1`).
Pruebas: `tests/proof-routes.test.ts`, `tests/proof-cli.test.ts` (salida y códigos), pruebas de componente web de la tarjeta; captura `proof_web_ui.webp` en docs EN/ES.

### Fase 5: informe (2026-10-14)

Implementada solo la Fase 5; Fase 6 no iniciada. Sin commit. Estado de la spec sin cambios.

- **Servidor**: `routes/proof.ts` (GET del ledger, alta/edición, `not-applicable` con motivo, export `md|json`) y `POST /goal/override`; las lecturas usan la conexión propia del servidor y las escrituras la app del workspace. `proof_updated`/`proof_divergence` ya viajaban como frames `event`; el snapshot gana `proof: {criteria}` solo con criterios.
- **Decisiones donde la spec no decide**: (1) la edición de un criterio cambia solo texto y `required`; verificador y alcance son fijos porque la evidencia es inmutable. (2) POST único para alta y edición (`criterionId` distingue). (3) Los criterios HTTP son opcionales por defecto; los de CLI, requeridos. (4) `--criterion`/`--verify` se emparejan por posición (commander pierde el orden entre flags); un `--verify` sobrante es error. (5) Con `--proof` el prompt lleva un resumen de criterios y comandos, porque sin él el modelo no sabría qué ejecutar; sin criterios el prompt no cambia. (6) Precedencia de salida: un error de ejecución (1) gana; luego `failed` (10) sobre `unverified` (11). (7) Evento final `{"type":"proof_ledger","schema":"proof/v1",exitCode,ledger}`, fuera de `RunEvent`. (8) Override de usuario: ruta, `/goal override <motivo>` y botón web; no se añadió `GoalAction` para no cambiar `actions` de los goals existentes (la web lo ofrece según el ledger). (9) Web: tarjeta compacta sobre el compositor y pestaña Proof del panel, ambas en chunk propio; el presupuesto inicial sube ~0,3 KB (88,7/90).
- **(a) Override**: cerrado por las tres superficies; el modelo no tiene ruta (`update_goal` no lo acepta).
- **(b) Revisión de plan**: web por criterio (conservar, editar texto, `required`, rechazar) mediante la clave de respuesta `plan:criteria`; un selección mal formada no activa nada. El TUI se queda en todo o nada: una selección por criterio exigiría una vista nueva dentro del panel de tres opciones; ahora lista los borradores en el transcript.
- **(c) Reintentos de `complete`**: refusals en 3 ejecuciones distintas pausan el goal (`no_progress`, `completion_refused`); contador en memoria, reiniciado por `/goal resume`.
- **Pruebas**: `proof-export`, `proof-routes`, `proof-cli`, `tui-proof`, `web-proof`, `proof-surfaces-parity` y ampliaciones de plan, goal y revisión; escenario `run --proof` en `test:cli`. Captura `docs/assets/web-ui/proof_web_ui.webp`; `docs/proof.md` EN/ES (la Fase 8 lo completa).
- **Preguntas abiertas**: ¿añadir una selección por criterio al TUI (vista nueva)? ¿`GoalAction: "override"` visible en `actions` cuando haya criterios sin cumplir? ¿persistir las divergencias en el ledger en vez de leerlas del diario?

### Fase 6 — Verificadores `file`, `data-check` y API de plugins

Trabajo: verificador `file`; `data-check` (conteo, suma, igualdad contra `data_query`) usando `data_inspect|data_query`; `api.proof?.registerVerifier` con feature-detect.
Aceptación: un `data-check` con total distinto produce `failed` con evidencia; un plugin sin evidencia referenciable degrada a `manual_review`; un core sin `api.proof` no rompe plugins que la usan opcionalmente.
Pruebas: `tests/proof-verifiers.test.ts`, `tests/proof-plugin-api.test.ts`.

### Fase 6: informe (2026-10-14)

Implementada solo la Fase 6; Fase 7 no iniciada. Sin commit. Estado de la spec sin cambios. Sin migración nueva.

- **Captura, no ejecución propia (D3, D6)**: `file` y `data-check` se capturan en `ProofRecorder` del resultado crudo de `read_file` y `data_query`, igual que `command`; ninguna ruta del core lee archivos ni datasets por su cuenta, así que el gate sigue siendo la única autoridad. Un `read_file` que lanza `File not found` es evidencia `failed`: el runner lo informa con `ProofRecorder.captureFailure` desde el `catch` de `executeCall`, porque un `throw` no llega a `capture`.
- **Decisiones donde la spec no decide**: (1) `data-check` solo acepta su **consulta canónica** (`COUNT(*)`, `TOTAL("col")`, `DISTINCT "col" LIMIT 2`; comparación sin mayúsculas, comillas ni `;`); una consulta distinta no produce evidencia, porque con SQL libre el modelo podría «cumplir» el criterio con `SELECT 42`. `equals` = la columna tiene un único valor y es `expected`. Se añadió `table?` opcional al `data-check` (aditivo) para XLSX. (2) `file`: `pattern` es regex con bandera `m` sobre el contenido sin prefijos `N: `; una lectura parcial solo confirma, nunca refuta; un archivo >1 MiB sin `sha256` no decide. (3) La verificación a demanda es `verifyCriterion` / `app.verifyCriterion`: acción solo de usuario (ninguna herramienta la expone); `file` y `data-check` ejecutan su llamada canónica con `runner.runToolCall` (que ahora devuelve también `callId`); no se añadió comando, botón ni ruta. (4) Plugins: los criterios se enlazan como `<pluginId>:<id>` (como los comandos); el resultado exige `ok` booleano y `outputHash` sha256; un `callId` debe existir en el diario de la sesión y entonces se toma su `runId` real. Sin evidencia trazable, el criterio pasa a `manual_review` con una evidencia `verifierKind: "manual"` (`deriveStatus` la lee como degradación; evita migración). Un verificador que lanza error o excede 60 s no registra nada (queda como estaba). Sin `callId` el host acuña un id `verify_<uuid>`: la evidencia es la palabra del plugin más el hash. (5) `ctx.callTool` es `runToolCall`: una llamada rechazada vuelve con `isError`, no rechaza la promesa. (6) Los borradores de plan y la entrada de usuario aceptan `data-check` y `plugin`. (7) El resumen de `--proof` indica la lectura o la consulta exacta.
- **`api.proof` ausente**: `PluginHost.setProofVerifiers` lo enlaza (`createApplication` siempre); sin él, `api.proof` es `undefined` y un plugin con `api.proof?.…` sigue funcionando.
- **Pruebas**: `tests/proof-verifiers.test.ts` (runner, gate, SQLite y dataset reales) y `tests/proof-plugin-api.test.ts`; ampliación de `proof-cli`. Docs: `docs/proof.md`, `docs/plugins.md` y sus versiones ES, `docs/implementation-status.md`, skills y changeset `.changeset/proof-verifiers.md`.
- **Preguntas abiertas**: ¿añadir una superficie (ruta `POST …/criteria/:id/verify`, `/proof verify`, botón) para `verifyCriterion`? ¿Un `file` sin `scope` debería caducar solo con ediciones de su propia ruta (hoy, como dice la §3.4, cualquier edición del workspace)? ¿Emitir `proof_updated` desde una verificación de plugin fuera de una ejecución?

### Fase 7 — Verificador `coverage` (opt-in, tardía)

Trabajo: verificador `coverage` que ejecuta el comando de cobertura configurado, parsea el porcentaje (formatos `lcov`/resumen de vitest y `coverage.py`) y compara con `minPercent`; no genera tests.
Aceptación: desactivado por defecto (`proof.coverage.enabled: false`); con él, un porcentaje bajo produce `failed` con evidencia.
Pruebas: `tests/proof-coverage.test.ts` con salidas de muestra fijas.

### Fase 7: informe (2026-10-14)

Implementada solo la Fase 7; Fase 8 no iniciada. Sin commit. Estado de la spec sin cambios. Sin migración nueva ni cambios de tipos en el SDK (`coverage` ya existía en `ProofVerifierSpec`).

- **Captura, no ejecución propia (D3, D6)**: igual que `command`, la evidencia `coverage` nace en `ProofRecorder` del resultado crudo de `shell`/`run_process` cuya huella coincide con el comando del criterio (`proof/coverage.ts` aporta `parseCoverage` y `judgeCoverage`, puros). Excepción solicitada por la spec: `verifyCriterion` (acción solo de usuario) ejecuta el comando con `runner.runToolCall` (`shell`), es decir, bajo la misma compuerta; en `--read-only` no se ejecuta y el criterio queda `not_checked`.
- **Opt-in**: `proof.coverage.enabled` (por defecto `false`, `strict`). Desactivado, el recorder ignora esos criterios y `verifyCriterion` devuelve `coverage_disabled` sin llamar a ninguna herramienta.
- **Decisiones donde la spec no decide**: (1) `verified` exige código de salida 0, porcentaje global hallado y `>= minPercent` (inclusive); salida ilegible, comando con salida ≠0 o porcentaje bajo son `failed` con motivo en el extracto. (2) Formatos y prioridad: `Total coverage:`/fila `TOTAL` (`coverage.py`, pytest-cov), tabla de texto (fila `All files`, columna `% Lines`), resumen `Lines`, `lcov --summary`, `lcov` en bruto (ΣLH/ΣLF); las filas por archivo nunca valen como total; con varias coincidencias del mismo formato gana la última; se quitan secuencias ANSI. (3) El porcentaje de tablas y resúmenes es el de **líneas**. (4) El extracto lleva la salida redactada y, al final, el veredicto. (5) `--verify` sigue siendo atajo de `command`; un criterio `coverage` se expresa con `--proof-file`, el campo `verifier` de HTTP/Web y borradores de plan (`minPercent` 0..100). (6) Web y revisión de plan del TUI muestran el comando.
- **Motivo visible con la función desactivada**: lo dicen `alisio run` (stderr), el resumen de `--proof` y `verifyCriterion`; el ledger muestra `not_checked` sin campo de motivo, porque el servidor no conoce la configuración y añadir un campo exigiría un cambio de contrato.
- **Pruebas**: `tests/proof-coverage.test.ts` (29: muestras fijas, configuración, validación, runner/compuerta/SQLite reales, `verifyCriterion`). Docs: `docs/proof.md`, `docs/configuration.md` y sus versiones ES, `docs/implementation-status.md`, skill `alisio-pkg-core` y changeset `.changeset/proof-coverage.md`.
- **Preguntas abiertas**: ¿añadir un campo `reason` aditivo al criterio del ledger para mostrar «cobertura desactivada» en Web/TUI? ¿Admitir `cwd` y un tiempo propio en el verificador `coverage` (hoy usa los de `shell`)? ¿Permitir `--verify-coverage` en la CLI?

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

## 8. Decisiones del propietario (O1..O8, confirmadas el 2026-10-14)

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

### Fase 8: informe (2026-10-14)

Implementada solo la Fase 8; sin commit, sin subir versiones y sin cambiar el Estado de la spec.

- **Docs**: `docs/proof.md` y `docs/es/proof.md` completas y en paridad (conceptos, estados, verificadores `command|file|data-check|coverage|plugin|manual`, modo CI y códigos de salida, tabla de rutas HTTP, override del objetivo, claves de configuración, export `proof/v1`, notas de seguridad y límites). Ya estaban en la barra lateral (`proof`), enlazadas desde `docs/web.md`, `docs/configuration.md`, `docs/plugins.md` y ahora desde `README.md` y `docs/limitations.md`. La captura `proof_web_ui.webp` está incrustada en ambas páginas; no se rehízo: los componentes de `packages/web/src/components/proof/` no cambiaron después de la captura y el único archivo posterior (`store/proof.ts`) no altera lo que se ve.
- **`docs/implementation-status.md`**: las siete secciones por fase se consolidaron en una sola entrada de Proof (qué se entrega, límites conocidos, medición, verificación). `docs/limitations.md` (EN) queda alineado.
- **Changelog**: entrada `## [Unreleased]` en `CHANGELOG.md` y datos regenerados con `pnpm changelog:data`; no se tocó ninguna versión.
- **Puerta de medición** (proveedor scripted, sin red; Node 22.19 linux/x64; SQLite en disco; script desechable, no se conserva): turnos de 20 llamadas `run_process` instantáneas con salida de 4 KB sobre el runner real, 3 rondas de 20 turnos. Sin recorder: mediana 216-231 ms por turno; recorder sin criterios: 212-247 ms (indistinguible); recorder con 3 criterios `command`: 541-612 ms, es decir **+16 a +19 ms por llamada capturada**. **Esto no confirma el <5 % de la Fase 0** (medido con SQLite en memoria y solo hash/redacción): frente a una herramienta instantánea el coste relativo es alto; frente a un comando real o un turno del modelo es pequeño en términos absolutos. `treeFingerprint` cuesta ≈4 ms fuera de git y ≈31 ms en este repositorio; el resto no se desglosó. Tokens: el resumen de `--proof` añade ~324 caracteres (≈80 tokens, estimación) con 3 criterios y 0 sin criterios. No se midió coste de tokens ni latencia con un modelo real ni con `alisio eval`: el Reliability Lab no tiene variantes con Proof y compararlas exigiría grabar cassettes con un proveedor real (un cassette scripted no mide tokens).

**Trazabilidad de la §10 (criterio de aceptación global → pruebas):**

| AC | Prueba(s) |
| --- | --- |
| 1. Sin verificador, `not_checked` aunque el modelo diga que está hecho | `tests/proof-ledger.test.ts` (tabla D1), `tests/proof-recorder.test.ts` (el modelo no crea evidencia con texto ni con otras herramientas), `tests/proof-plan.test.ts` (texto «mark criterion verified» en un `tool_result`), `tests/proof-divergence.test.ts` |
| 2. Todo `verified` apunta a evidencia con `runId/callId` y fecha | `tests/proof-ledger.test.ts`, `tests/proof-ledger-contract.test.ts`, `tests/proof-store.test.ts` (rechazo de evidencia sin `runId/callId`), `tests/proof-recorder.test.ts` (llamada inventada o ajena), `tests/proof-verifiers.test.ts`, `tests/proof-plugin-api.test.ts` |
| 3. Una edición posterior caduca la evidencia afectada | `tests/proof-ledger.test.ts` (`stale`), `tests/proof-staleness.test.ts` (alcance, sin alcance, fuera del workspace, reverificación, persistencia) |
| 4. TUI, Web y JSONL muestran los mismos estados desde la misma fuente | `tests/proof-surfaces-parity.test.ts`, `tests/proof-export.test.ts`, `tests/tui-proof.test.ts`, `tests/web-proof.test.ts`, `tests/proof-routes.test.ts` |
| 5. `--proof` devuelve código ≠0 con requeridos sin verificar | `tests/proof-cli.test.ts` (0/10/11 y códigos configurados), escenario `run --proof` de `fixtures/cli-e2e.ts` (`pnpm test:cli`) |
| 6. Sin criterios/goal/plan, un run es indistinguible de 0.6.x | `tests/proof-recorder.test.ts` (caracterización: mismos mensajes y eventos), `tests/proof-staleness.test.ts`, `tests/proof-divergence.test.ts`, `tests/proof-coverage.test.ts`, `tests/proof-goal.test.ts`, `tests/proof-cli.test.ts` (prompt byte-idéntico) |

Transversales de la §11: el caso «mark criterion verified» está en `tests/proof-plan.test.ts`; los contratos del SDK y de eventos en `tests/proof-ledger-contract.test.ts` y `tests/run-events-contract.test.ts`; la ruta HTTP en `tests/proof-routes.test.ts`.

**Preguntas abiertas para el propietario:**

1. El coste medido (+16 a +19 ms por llamada capturada con criterios, con SQLite en disco) contradice el <5 % de la Fase 0. ¿Se acepta, o se optimiza la captura (p. ej. diferir `treeFingerprint`, agrupar escrituras)? ¿Quieres una comparación con un modelo real (cassettes grabados) antes de publicar?
2. ¿Selección por criterio en la revisión de plan del TUI (vista nueva)?
3. ¿Superficie para `verifyCriterion` (ruta `POST …/criteria/:id/verify`, `/proof verify`, botón)? ¿Y emitir `proof_updated` desde una verificación de plugin fuera de una ejecución?
4. ¿`GoalAction: "override"` visible en `actions` cuando haya criterios sin cumplir?
5. ¿Un criterio `file` sin `scope` debe caducar solo con ediciones de su propia ruta?
6. ¿Campo `reason` aditivo en el criterio del ledger para mostrar «cobertura desactivada» en Web/TUI; `cwd` y tiempo propios para `coverage`; `--verify-coverage` en la CLI?
7. ¿Persistir las divergencias en el ledger en vez de leerlas del diario? ¿Caducar la evidencia por ediciones de `shell`/`js_run` comparando el `treeFingerprint`?
8. ¿Los criterios creados por HTTP deben ser requeridos por defecto, como los de la CLI?
