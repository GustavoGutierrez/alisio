# Especificación Técnica: Reliability Lab — evaluación reproducible, replay y regresiones

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 1 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador. Propuesta, no implementada.** Decisiones O1–O8 pendientes de confirmar por el propietario. |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: `EvalSuite`, `EvalTask`, `EvalVerifier`, `EvalRunRecord`, `EvalReport`, `Cassette`), `@alisio/core` (nuevo `packages/core/src/eval/*`: motor, verificadores, métricas, proveedor de replay, comparador), `@alisio/alisio-code` (CLI: `alisio eval run\|compare\|record\|replay\|list`), scripts (`scripts/eval-ci.ts` opcional) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción. Reutiliza `scripts/bench/lib.ts` (`readBenchParams`, `mulberry32`, `BenchUsageError`) moviendo lo común a `packages/core/src/eval/rng.ts` solo si hace falta; el bench de dashboards no se reemplaza. |
| Relación con otras especificaciones | **Habilitadora** de `specs/013-adaptive-execution-v1.md` (puerta de promoción y Fase 0), y de las futuras `specs/012-context-governor-v1.md`, `specs/014-trust-boundaries-v1.md` y `specs/016-code-intelligence-v1.md` (cada una usa una suite de este laboratorio como Fase 0). Consume `specs/011-proof-v1.md` cuando exista (verificadores y evidencia con ID) pero **no depende** de ella: define sus propios verificadores mínimos. Independiente de `specs/018-perimeter-v1.md`: ambas son aditivas; el laboratorio puede ejecutar una suite que verifique el reporte de perímetro. No sustituye a `specs/backlog/020-model-tier-router-v1.md`; solo le da la medición que esa spec necesita para decidir. |
| Superficies | Headless (`alisio eval`) como superficie primaria y única de ejecución; el reporte Markdown/JSON es consumible por CI. Web y TUI: solo lectura del último reporte (Fase 6, opcional); paridad no aplica a la ejecución porque el laboratorio es una herramienta de desarrollo y CI, no del flujo interactivo. |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar** (los números se desplazan si se publica otra minor antes). Aditiva: no cambia ningún comportamiento por defecto del agente; los comandos `alisio eval *` son nuevos y el modo replay solo se activa por flag explícito. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 sobre `main` (0.6.0, `2e867c7`); **(no verificado)** = deducido o externo sin prueba ejecutada aquí; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts` (vitest), sobre comportamiento en límites de módulo. Sin pruebas de instantánea que repitan la implementación.
4. **Orden obligatorio**: Fase 0 (medición de línea base) → el propietario revisa → Fases 1..6. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: §14. Por defecto Sonnet; Opus solo en los puntos listados.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo `node:fs`, `node:child_process`, `node:sqlite` en los paquetes; ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del core; los plugins dependen solo de `@alisio/sdk` (peer); preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión persistida; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Los contratos son **aditivos**: las uniones solo ganan variantes; `RunEvent.schemaVersion` sigue en 1.
8. Idioma: identificadores, claves, mensajes de error y textos generados en inglés; textos de UI (si los hay) en inglés y español; esta especificación en español. Docs EN/ES en paridad y límites en `docs/implementation-status.md`.
9. Esta especificación **no decide permisos** ni modifica el gate: toda ejecución del laboratorio corre bajo la política de permisos existente, declarada explícitamente por tarea (§5.3).

## 1. Objetivo, usuarios y principio rector

### 1.1 Objetivo

Que el propietario (y cualquier contribuidor) pueda **decidir con datos** si un cambio del arnés, una estrategia o un modelo mejora o empeora el comportamiento de Alisio, y **publicar resultados honestos**. Hoy no se puede: la única medición existente es `scripts/bench-dashboard.ts` (solo dashboards) y `scripts/bench.ts` (solo arranque del CLI) **(verificado)**. No hay suite de tareas, ni repeticiones, ni replay de proveedor; las pruebas usan proveedores «scripted» ad hoc (`tests/runner-gate-characterization.test.ts`, `tests/*-helpers.ts`) **(verificado)**.

El laboratorio ofrece cuatro capacidades:

1. **Suites de tareas** versionadas: repositorio fixture + prompt + presupuesto + verificadores deterministas.
2. **Repeticiones y métricas de fiabilidad**: `pass@k`, `pass^k` (consistencia), varianza, costo y latencia por éxito, incidentes; separando siempre lo **medido** de lo **estimado**.
3. **Comparación** baseline vs. candidato (dos configuraciones, estrategias o modelos) sobre las mismas tareas, en JSON y Markdown.
4. **Replay de proveedor** (cassettes): grabar las respuestas del proveedor de una ejecución y reproducirlas para detectar regresiones del *harness* (herramientas, compactación, gate) de forma determinista, sin red y sin costo.

### 1.2 Usuarios

| ID | Persona | Qué obtiene |
| --- | --- | --- |
| U1 | **El propietario/mantenedor** que decide qué entra en una release | Puertas de promoción medibles para S2/S4/S5 (cada spec dependiente declara «el éxito no cae más de X puntos»); reporte comparativo reproducible. |
| U2 | **El contribuidor** que toca el runner, la compactación o el gate | Replay determinista en CI: si su cambio altera lo que el harness pide al proveedor, el replay falla con un diff legible. |
| U3 | **El usuario avanzado** que elige proveedor/modelo para su flujo | `alisio eval compare` sobre sus propios proveedores y una suite incluida o propia; nada sale de su máquina. |

### 1.3 Principio rector

> **Un número sin condiciones de medición es una anécdota. Cada resultado del laboratorio lleva su versión de suite, su configuración efectiva, su modelo y su semilla; y nunca afirma determinismo donde solo hay repetición.**

Reglas derivadas:

- El laboratorio **mide el harness y el modelo juntos**; el modo replay mide **solo el harness**. Nunca se presenta un resultado de replay como evidencia de calidad del modelo.
- `measured` (tokens del proveedor, tiempo de pared, conteos de eventos) y `estimated` (costo en moneda a partir de tarifas configuradas, tokens aproximados) viajan en campos separados y la comparación no mezcla ambos (D7).
- Los verificadores son **deterministas y locales** (comandos, comparación de archivos, aserciones sobre el árbol resultante). No hay «LLM como juez» en la v1 (§2, fuera de alcance).
- El laboratorio **no se auto-promueve**: informa; la decisión de promover un cambio es del propietario (O7).

### 1.4 Nombre

**Reliability Lab**, identificador `eval` (comando `alisio eval`, módulo `core/eval`, directorio de fixtures `tests/fixtures/eval/`). Alternativas descartadas: `bench` (ya designa el bench de rendimiento puntual y se confundiría con él), `arena` (sugiere competencia entre modelos, que no es el objetivo).

### 1.5 Alcance

Motor de evaluación headless; suites incluidas pequeñas (`smoke-coding`, `tool-sequences`, `long-context`, y el hueco para `injection` que definirá `specs/014-trust-boundaries-v1.md`); verificadores; repeticiones; métricas; comparador; cassettes de replay; comando `alisio eval`; reporte JSON + Markdown; integración opcional en CI con replay; documentación EN/ES.

### 1.6 Fuera de alcance

| Excluido | Motivo |
| --- | --- |
| LLM como juez / evaluación subjetiva de calidad | No determinista y con costo; fuera de la v1 (decisión abierta O6 para una fase posterior). |
| Optimización automática de workflows o prompts (AFlow/DSPy) | Costo alto y sin base de medición previa; solo entra la **comparación manual de dos variantes declaradas** (§7). |
| Benchmarks públicos de terceros (SWE-bench, etc.) | Requieren infraestructura y datos externos; el formato de suite permite portarlos después, pero no se incluyen. |
| Enrutado multimodelo o cascadas | Es del dominio de `specs/backlog/020-model-tier-router-v1.md`; el laboratorio solo mide. |
| Subida de resultados a un servicio | Nada sale de la máquina; la exportación es un archivo local que el usuario comparte si quiere (D9). |
| Ejecutar suites contra el árbol de trabajo real del usuario | Toda ejecución corre en una copia temporal del fixture (D3). |
| UI interactiva de evaluación | Herramienta de CI/desarrollo; la lectura del reporte en Web/TUI es opcional (Fase 6). |

## 2. Base verificada

| Hecho | Evidencia | Implicación |
| --- | --- | --- |
| El bucle del agente es `AgentRunner` con `maxTurns` (def. 100), presupuesto de tokens y `executeCall()` como gate único | `packages/core/src/core/runner.ts` | El laboratorio puede ejecutar el runner completo y observar eventos sin duplicar lógica. |
| `ModelProvider.stream(request)` devuelve `AsyncIterable<ProviderEvent>` con `text_delta`, `reasoning_delta` y `completed {message, usage?}` | `packages/sdk/src/index.ts` (`ModelProvider`, `ProviderEvent`) | El replay es un `ModelProvider` que emite eventos grabados: no requiere tocar el runner. |
| `RunRecord` conserva `usage` por run | `packages/core/src/core/contracts.ts` | Costo/tokens **medidos** disponibles por ejecución. |
| `createApplication` construye la aplicación headless | `packages/core/src/application.ts` (exportado en `packages/core/src/index.ts`) | Punto de entrada del motor para correr una tarea en un directorio y configuración dados. |
| Bench actual: `readBenchParams`, `mulberry32`, `BenchUsageError`, datasets sintéticos | `scripts/bench/lib.ts`, `scripts/bench-dashboard.ts` | Patrón de parámetros por entorno y RNG con semilla reutilizable; el bench de dashboards sigue como está. |
| Proveedores «scripted» ad hoc en pruebas | `tests/runner-gate-characterization.test.ts`, `tests/*-helpers.ts` | Patrón base para el proveedor de replay; se unifica en `core/eval` sin reescribir esas pruebas. |
| `alisio run --json` emite JSONL de eventos y acepta `--allow-*` y `--read-only` | `packages/cli/src/main.ts` (`.command("run")`) | El CLI ya tiene el patrón headless; `alisio eval` lo reutiliza internamente en vez de lanzar subprocesos cuando es posible. |
| El goal tiene evidencia en texto libre (`GoalEvidence`) y no hay verificadores | `packages/sdk/src/index.ts` | Los verificadores del laboratorio son propios y mínimos; `02-alisio-proof.md` los unificará después (D12). |
| No existe replay de proveedor ni suite de evaluación de tareas | búsqueda en `tests/` y `scripts/` | Todo (nuevo). |

## 3. Decisiones

### 3.1 Decisiones del propietario (propuestas, a confirmar)

| ID | Decisión propuesta |
| --- | --- |
| O1 | El laboratorio entra **antes** que S2/S4/S5: su Fase 0–3 son requisito de las Fases 0 de esas specs. (Ver O1 en §12.) |
| O2 | Orden de entrega: núcleo (Fases 1–3) antes que replay (Fase 4); el replay es la pieza de mayor valor para CI y se prioriza si hay que recortar. |
| O3 | Los resultados incluyen **intervalos de confianza simples** (Wilson para proporciones) y no se afirma mejora con menos de `k=5` repeticiones por tarea. |
| O4 | Las suites incluidas viven en el repositorio (`tests/fixtures/eval/`) y se publican en el paquete solo si el propietario lo decide (O5). |
| O5 | El comando es `alisio eval`; el binario autónomo lo incluye solo si el peso adicional es < 150 KB. |
| O6 | Sin LLM como juez en la v1. |
| O7 | El laboratorio **informa; no promueve**: la decisión de promoción es humana. |
| O8 | Los presupuestos de §11 son objetivos, no garantías; una puerta incumplida entrega sin promoción y se reporta. |

### 3.2 Decisiones de diseño (vinculantes)

| ID | Decisión |
| --- | --- |
| D1 | Una **suite** es un directorio versionado con `suite.json` (`EvalSuite`) y fixtures por tarea. Una **tarea** (`EvalTask`) tiene: `id`, `prompt`, `fixture` (ruta relativa), `agent?`, `budget` (`maxTurns`, `maxTokens`, `maxWallMs`, `maxToolCalls`), `policy` (modo de permisos y `--allow-*` explícitos), `verifiers[]`. `suite.json` lleva `suiteVersion` (semver) y `schemaVersion: 1`. |
| D2 | Un **run de evaluación** (`EvalRunRecord`) conserva siempre: `suiteId`, `suiteVersion`, `taskId`, `repetition`, `seed`, `harnessVersion` (de `core/src/version.ts`), `configHash` (hash de la configuración efectiva sin secretos), `provider`, `model`, `mode` (`live\|replay`), `startedAt`, `endedAt`, resultado por verificador, `usage` (medido), `wallMs` (medido), `toolCalls`, `incidents[]`. Sin esos campos el reporte es inválido (criterio de aceptación 1). |
| D3 | Cada ejecución corre en una **copia temporal** del fixture (directorio bajo `os.tmpdir()` propio del run) y la limpia al terminar salvo `--keep`. Nunca se ejecuta sobre el árbol real. El git del fixture (si lo requiere) se inicializa dentro de la copia. |
| D4 | **Verificadores v1** (deterministas, locales): `command` (código de salida y/o salida esperada de un comando acotado por tiempo), `file-equals`, `file-contains`, `file-absent`, `tree-diff-within` (los archivos modificados están dentro de una lista permitida), `tool-sequence` (aserciones sobre la secuencia de eventos: orden, ausencia, máximo de llamadas). Cada verificador devuelve `{id, status: pass\|fail\|error, detail}`; `error` (el verificador no pudo correr) **no** cuenta como `fail` ni `pass` y se reporta aparte. |
| D5 | **Tarea pasa** si todos sus verificadores obligatorios dan `pass` y no excedió presupuesto duro. Si un presupuesto se excede, el run termina con `status: "budget_exceeded"` y cuenta como no-pass, con el motivo. |
| D6 | **Métricas por tarea sobre k repeticiones**: `passAtK` (≥1 éxito en k), `passPowK` (`pass^k`: éxito en las k), `successRate` con intervalo de Wilson, `varianceTokens`, `varianceWallMs`, `medianWallMs`, `tokensPerSuccess`, `wallMsPerSuccess`. **Costo en moneda es siempre `estimated`** (requiere tarifas en config; sin tarifas se omite, no se inventa). |
| D7 | El reporte tiene dos bloques separados: `measured` (usage del proveedor, tiempos, conteos de eventos) y `estimated` (costo monetario, tokens aproximados cuando el proveedor no reporta usage). La comparación calcula deltas dentro de cada bloque; **nunca** suma ni mezcla. |
| D8 | **Incidentes** por run: aprobaciones denegadas, errores de herramienta, `turns_exceeded`, compactaciones, y —cuando existan— bloqueos de `trust-boundaries` y `run_stalled` de `adaptive-execution`. Se leen de eventos (`RunEventDataMap`); no se infieren de texto. |
| D9 | Nada sale de la máquina. Los reportes se escriben en `<dataDir>/eval/<runId>/` (`report.json`, `report.md`, `runs.jsonl`) y el usuario decide compartirlos. `alisio eval export` produce un paquete sin rutas absolutas ni secretos (revisado por prueba). Sin telemetría. |
| D10 | **Cassettes**: formato JSONL versionado (`cassette/v1`) con un registro por llamada a `ModelProvider.stream`: `requestFingerprint` (hash canónico de `instructions`, `messages`, nombres+esquemas de `tools`, `maxOutputTokens`, `model`) y los `ProviderEvent` emitidos. Los secretos y `sessionId` se excluyen del fingerprint. |
| D11 | **Replay**: `ReplayProvider implements ModelProvider` sirve los eventos grabados en orden. Si el `requestFingerprint` de la llamada N no coincide con el grabado, **falla con un diff estructurado** (qué campo cambió: mensajes, herramientas, instrucciones) y no continúa. Una cassette consumida antes de tiempo, o con llamadas sobrantes, también falla. Replay no hace red ni requiere credenciales. |
| D12 | Los verificadores v1 son propios del laboratorio y **no** dependen de `02-alisio-proof.md`. Cuando Proof exista, se añade un adaptador (`EvalVerifier` ↔ verificador de Proof) en una fase posterior (O1 de §12); el formato de `EvalVerifier` queda con `kind` abierto para ello. |
| D13 | Pruebas de **secuencias con estado** (`tool-sequences`): la tarea define un entorno simulado mínimo (p. ej. archivos que solo pueden editarse tras leerse, un proceso en segundo plano que debe detenerse antes de borrar su directorio) y el verificador `tool-sequence` rechaza transiciones inválidas. El estado vive en el fixture + eventos; no hay servidor simulado nuevo. |
| D14 | `alisio eval compare <baseline> <candidate>` exige que ambos reportes compartan `suiteId` y `suiteVersion`; si difieren, rechaza con un mensaje claro (no compara peras con manzanas). La comparación declara qué cambió entre ambos (`configHash`, `model`, `harnessVersion`, `mode`). |
| D15 | La **comparación de dos estrategias** (F09 mínimo) se expresa como dos *variantes* en un `compare.json`: cada variante es un conjunto de overrides de configuración (p. ej. `{"compaction.threshold": 0.6}`) sobre la misma suite. Solo overrides de claves existentes de la configuración; sin código arbitrario. |
| D16 | El laboratorio nunca amplía permisos: la `policy` de cada tarea solo puede **igualar o restringir** lo que el invocador ya tiene; `alisio eval run` rechaza una suite que pida `full` sin `--allow-suite-full` explícito en la línea de comandos. |
| D17 | Sin dependencias nuevas de producción. Estadística (Wilson, varianza) implementada en `core/eval/stats.ts` con funciones puras. |
| D18 | Cada fase actualiza `docs/implementation-status.md` con lo medido y con lo no cubierto. |

## 4. Concepto

```
suite (versionada)              harness                         resultado
┌───────────────────┐   ┌────────────────────────────┐   ┌────────────────────────┐
│ tarea: prompt     │   │ copia temporal del fixture │   │ EvalRunRecord          │
│  fixture          │──►│ createApplication(config)  │──►│  condiciones (D2)      │
│  presupuesto      │   │ AgentRunner ◄─ ModelProvider│   │  verificadores (D4)    │
│  verificadores    │   │            (live | replay) │   │  measured / estimated  │
└───────────────────┘   └────────────────────────────┘   └───────────┬────────────┘
                                   │ eventos                          │ k repeticiones
                                   ▼                                  ▼
                             cassette/v1 ◄── record          report.json / report.md
                                                              compare baseline vs candidate
```

Dos modos del mismo motor:

| Modo | Proveedor | Mide | Uso |
| --- | --- | --- | --- |
| `live` | proveedor real configurado | harness + modelo (con varianza) | decidir estrategias y modelos; costo real |
| `replay` | `ReplayProvider` desde cassette | solo el harness (determinista) | CI barato; detectar regresiones del runner, herramientas, compactación y gate |

## 5. Contratos y tipos

### 5.1 Tipos del SDK (aditivos; solo tipos, sin imports de runtime)

```ts
export interface EvalBudget {
  maxTurns: number;
  maxTokens?: number;
  maxWallMs: number;
  maxToolCalls?: number;
}

export type EvalVerifier =
  | { kind: "command"; id: string; command: string[]; timeoutMs: number; expectExit?: number; expectStdoutIncludes?: string }
  | { kind: "file-equals"; id: string; path: string; sha256: string }
  | { kind: "file-contains"; id: string; path: string; text: string }
  | { kind: "file-absent"; id: string; path: string }
  | { kind: "tree-diff-within"; id: string; allowed: string[] }
  | { kind: "tool-sequence"; id: string; rule: ToolSequenceRule };

export type ToolSequenceRule =
  | { type: "before"; first: string; then: string }       // `first` debe ocurrir antes que `then`
  | { type: "never"; tool: string }
  | { type: "max-calls"; tool: string; max: number }
  | { type: "no-repeat-failure"; tool: string };

export interface EvalTask {
  id: string;
  prompt: string;
  fixture: string;
  agent?: string;
  budget: EvalBudget;
  policy: { mode: "ask" | "auto" | "full"; readOnly?: boolean; allow?: string[] };
  verifiers: EvalVerifier[];
  tags?: string[];
}

export interface EvalSuite {
  schemaVersion: 1;
  suiteId: string;
  suiteVersion: string;
  description: string;
  tasks: EvalTask[];
}

export interface EvalRunRecord {
  schemaVersion: 1;
  runId: string;
  suiteId: string;
  suiteVersion: string;
  taskId: string;
  repetition: number;
  seed: number;
  harnessVersion: string;
  configHash: string;
  provider: string;
  model: string;
  mode: "live" | "replay";
  startedAt: number;
  endedAt: number;
  status: "pass" | "fail" | "budget_exceeded" | "error";
  verifiers: Array<{ id: string; status: "pass" | "fail" | "error"; detail?: string }>;
  measured: { inputTokens?: number; outputTokens?: number; wallMs: number; turns: number; toolCalls: number };
  estimated?: { costUsd?: number; approxTokens?: number };
  incidents: Array<{ kind: string; count: number }>;
}
```

(nuevo) Todos los tipos. Ninguna unión existente cambia.

### 5.2 Métricas y reporte

```ts
export interface EvalTaskMetrics {
  taskId: string;
  k: number;
  successRate: { value: number; wilsonLow: number; wilsonHigh: number };
  passAtK: boolean;
  passPowK: boolean;
  measured: { medianWallMs: number; varianceWallMs: number; varianceTokens?: number; tokensPerSuccess?: number; wallMsPerSuccess?: number };
  estimated?: { costUsdPerSuccess?: number };
}

export interface EvalReport {
  schemaVersion: 1;
  suiteId: string;
  suiteVersion: string;
  conditions: { harnessVersion: string; configHash: string; provider: string; model: string; mode: "live" | "replay"; k: number; seedBase: number };
  tasks: EvalTaskMetrics[];
  runs: string[];                // IDs de EvalRunRecord (el detalle va en runs.jsonl)
  summary: { tasks: number; passed: number; errored: number; budgetExceeded: number };
}
```

### 5.3 Cassettes

```
cassette/v1 (JSONL)
{"v":1,"suiteId":"…","taskId":"…","harnessVersion":"…","recordedAt":…}      // cabecera
{"call":0,"fingerprint":"sha256:…","events":[{"type":"text_delta",…},{"type":"completed",…}]}
{"call":1,…}
```

Reglas: la grabación **no** incluye credenciales ni `sessionId`; el fingerprint se calcula sobre una forma canónica (claves ordenadas, sin campos volátiles). El `completed.message` conserva IDs de tool calls y datos de continuación del proveedor tal cual (se preservan por la regla del repo).

### 5.4 CLI

```
alisio eval list                                   # suites disponibles (incluidas + --suite-dir)
alisio eval run <suite> [--tasks id,id] [--k 5] [--seed N] [--mode live|replay]
                [--cassette-dir DIR] [--keep] [--json] [--out DIR]
alisio eval record <suite> [--tasks …]              # run live + escribe cassettes
alisio eval compare <reportA> <reportB> [--json] [--md]
alisio eval variants <suite> --variants compare.json [--k 5]   # dos variantes sobre la misma suite
alisio eval export <runId> --out FILE               # paquete sin rutas absolutas ni secretos
```

Salida `--json` en JSONL de `EvalRunRecord` + línea final `EvalReport`. Códigos de salida: `0` ejecución completa (independiente de pass/fail de tareas), `1` error de uso o de infraestructura, `2` replay con divergencia (`fingerprint` distinto), `3` `compare` con suites incompatibles.

## 6. Suites incluidas (v1, pequeñas)

| Suite | Contenido | Modo recomendado |
| --- | --- | --- |
| `smoke-coding` | 6–8 tareas sobre fixtures TypeScript mínimos: corregir una prueba que falla, añadir una función con prueba, renombrar un símbolo en 3 archivos, aplicar un cambio con `edit_file` respetando sha256. Verificadores `command` (`node --test`/script del fixture) y `tree-diff-within`. | `live` para decidir; `replay` en CI |
| `tool-sequences` | 4–6 tareas con estado (D13): leer antes de editar; detener un `bg_run` antes de borrar su directorio; no repetir una llamada fallida idéntica. | `replay` |
| `long-context` | 3 tareas con archivos largos y recortes de salida, para que `03-alisio-context-governor.md` mida elisión y compactación. Verificadores de conservación de información (`file-contains` sobre el resultado). | `live` |
| `injection` | **Hueco reservado**: lo define `specs/014-trust-boundaries-v1.md`; el laboratorio solo ejecuta el corpus que esa spec aporte (formato `EvalSuite` estándar). | `live`/`replay` |

Cada suite declara su versión; cambiar un fixture o un verificador sube `suiteVersion` y `compare` rechaza mezclar versiones (D14).

## 7. Comparación de variantes (F09 mínimo)

`compare.json`:

```json
{ "suite": "smoke-coding",
  "variants": [
    { "id": "baseline", "overrides": {} },
    { "id": "early-compaction", "overrides": { "context.compactionThreshold": 0.6 } }
  ] }
```

Cada variante corre las mismas tareas con las mismas semillas; el reporte incluye por tarea la diferencia de `successRate` con sus intervalos y marca **«no concluyente»** cuando los intervalos de Wilson se solapan (O3). Los nombres de claves se validan contra el esquema de configuración existente; una clave desconocida rechaza la variante. (no verificado: los nombres exactos de las claves de configuración se confirman en la Fase 0 contra `packages/core/src/config.ts`.)

## 8. Fases

Convención: cada fase termina con las nueve comprobaciones verdes (§0.4) y su entrada en `docs/implementation-status.md` (D18).

### Fase 0 — Línea base y arnés mínimo (Sonnet)

Entregable: medir **sin cambiar producción** cuánto cuesta y cuánto varía una tarea típica con el proveedor del propietario, para dimensionar `k` y presupuestos.

- Script `scripts/eval-baseline.ts` (desechable o promovido a Fase 1): ejecuta 3 tareas del tipo `smoke-coding` escritas a mano, `k=5`, y reporta tasa de éxito, mediana y varianza de tokens y tiempo, y número de fallos de infraestructura.
- Reutiliza `readBenchParams` (parámetros por entorno) y `mulberry32` (semilla).
- Documenta en `specs/research/` (o en el PR) los valores medidos que fijan los presupuestos de §11.

Criterios de aceptación: (1) los tres datos (éxito, varianza, infraestructura) quedan registrados; (2) el propietario aprueba `k` por defecto y presupuestos antes de la Fase 1.
Pruebas: ninguna de producción; el script tiene una prueba de humo con proveedor «scripted».

### Fase 1 — Contratos, suite loader y verificadores (Sonnet)

- `packages/sdk/src/index.ts`: tipos de §5.1–5.2 (solo tipos).
- `packages/core/src/eval/suite.ts`: `loadSuite(dir)` valida `schemaVersion`, ids únicos, fixtures existentes, rutas dentro del directorio de la suite (sin `..`).
- `packages/core/src/eval/verifiers.ts`: implementación de los seis `kind` (D4); `command` usa `node:child_process` con `timeoutMs` y entorno limpio; `tree-diff-within` compara contra un snapshot hash del fixture.
- `packages/core/src/eval/stats.ts`: Wilson, varianza, mediana, `passAtK`, `passPowK` (D6, D17).

Criterios de aceptación:
1. Una suite con id duplicado o fixture ausente se rechaza con error accionable.
2. Un verificador que no puede correr devuelve `error`, no `fail` (D4).
3. Wilson: casos conocidos (0/5, 5/5, 3/5) coinciden con valores de referencia calculados a mano en la prueba.
4. `tree-diff-within` detecta un archivo modificado fuera de la lista.

Pruebas (Rojo primero): `tests/eval-suite.test.ts`, `tests/eval-verifiers.test.ts`, `tests/eval-stats.test.ts`.

### Fase 2 — Motor de ejecución `live` y registro de condiciones (Sonnet; **Opus** para el diseño del aislamiento de ejecución, ver §14)

- `packages/core/src/eval/engine.ts`: `runTask(task, { provider, config, seed, repetition })` copia el fixture (D3), construye la aplicación con `createApplication`, ejecuta el prompt y recoge eventos; aplica presupuesto duro (D5) con `AbortSignal` y conteo de herramientas; calcula `configHash` y rellena `EvalRunRecord` (D2).
- Ejecuta verificadores y arma `incidents` desde eventos (D8).
- Política de permisos por tarea (D16): mapea `policy` a las mismas opciones que usa `alisio run`.

Criterios de aceptación:
1. Un run conserva todos los campos de D2 (criterio clave 1).
2. Una tarea que excede `maxToolCalls` termina `budget_exceeded` con motivo.
3. El directorio temporal se elimina salvo `--keep`; ningún archivo del árbol real cambia (prueba con un fixture que intenta escribir fuera).
4. `suite` que pide `full` sin `--allow-suite-full` se rechaza (D16).

Pruebas: `tests/eval-engine.test.ts` con un proveedor «scripted» (patrón de `tests/runner-gate-characterization.test.ts`); sin red.

### Fase 3 — Repeticiones, métricas, reporte y `compare` (Sonnet)

- `packages/core/src/eval/report.ts`: agrega runs en `EvalReport` (§5.2), separando `measured` y `estimated` (D7); render Markdown.
- `packages/core/src/eval/compare.ts`: `compareReports` (D14), deltas con marcado «no concluyente» (O3); variantes (§7, D15).
- CLI: `alisio eval list|run|compare|variants` en `packages/cli/src/main.ts`; salida `--json`; códigos de salida de §5.4.

Criterios de aceptación:
1. Reporte distingue medido de estimado (criterio clave 2): una prueba verifica que ningún campo de `estimated` aparece en `measured` y que sin tarifas no hay `costUsd`.
2. `compare` de dos estrategias sobre las mismas tareas produce deltas por tarea (criterio clave 3).
3. `compare` de suites con distinta `suiteVersion` sale con código 3.
4. Con intervalos solapados el reporte dice «no concluyente»; con `k<5` advierte baja potencia.

Pruebas: `tests/eval-report.test.ts`, `tests/eval-compare.test.ts`, `tests/cli-eval.test.ts` (patrón `pnpm test:cli`).

### Fase 4 — Cassettes y replay (Sonnet; **Opus** para la forma canónica del fingerprint)

- `packages/core/src/eval/cassette.ts`: escritura/lectura de `cassette/v1` (§5.3); `RecordingProvider` (envuelve un `ModelProvider` real y graba) y `ReplayProvider` (D10, D11).
- `fingerprint(request)`: canonicalización con claves ordenadas, sin `signal`, sin `sessionId`.
- `alisio eval record` / `--mode replay`; código de salida 2 con diff estructurado ante divergencia.

Criterios de aceptación:
1. **Replay reproduce byte a byte** una ejecución grabada sin red (criterio clave 5): prueba que graba con proveedor scripted, reproduce con red bloqueada (el proveedor de replay no importa módulos de red; la prueba lo verifica) y compara la secuencia de `RunEvent` con la original (ignorando timestamps y IDs generados por el runner, que se listan explícitamente en la prueba).
2. Si se cambia una herramienta (p. ej. su descripción) entre grabación y replay, el replay falla con un diff que nombra el campo.
3. Una cassette con llamadas sobrantes o faltantes falla.
4. Los IDs de tool calls y datos de continuación del proveedor se conservan idénticos.
5. La cassette no contiene claves de API ni `sessionId` (prueba de escaneo sobre patrones conocidos).

Pruebas: `tests/eval-cassette.test.ts`, `tests/eval-replay.test.ts`.

### Fase 5 — Suites incluidas y CI con replay (Sonnet)

- Fixtures en `tests/fixtures/eval/{smoke-coding,tool-sequences,long-context}/` con `suite.json`.
- Cassettes grabadas versionadas para `tool-sequences` y un subconjunto de `smoke-coding` (tamaño acotado; se miden en Fase 0).
- Prueba de humo en `pnpm test` que corre el replay de las cassettes incluidas; si el harness cambia lo que pide al proveedor, falla con el diff (criterio de U2).
- Suite `tool-sequences` con una transición inválida deliberada que el verificador detecta (criterio clave 4).

Criterios de aceptación: (1) una prueba de secuencia con estado detecta una transición inválida; (2) el replay de las cassettes incluidas pasa en `pnpm test` en menos de 10 s; (3) regrabar una cassette es un único comando documentado.
Pruebas: `tests/eval-bundled-suites.test.ts`.

### Fase 6 — Documentación, lectura en Web/TUI y cierre (Sonnet)

- `docs/eval.md` y `docs/es/eval.md` en paridad (cómo escribir una suite, `k`, lectura de `pass^k`, qué mide y qué no el replay, límites). `pnpm docs:check` y `pnpm docs:build` verdes.
- `docs/implementation-status.md`: qué está medido, qué no (no hay LLM juez, no hay benchmarks de terceros, no determinismo en `live`).
- Opcional (si el propietario lo pide, O de §12): vista de solo lectura del último reporte en la Web (`packages/web/src/components`) con captura `docs/assets/web-ui/eval_web_ui.webp` en ambos idiomas, siguiendo `AGENTS.md`. Si no se pide, se omite y la captura no aplica.

Criterios de aceptación: documentación EN/ES en paridad; el estado de implementación enumera las limitaciones de §1.6.

## 9. Pruebas (mapa)

| Frontera | Prueba | Qué comprueba |
| --- | --- | --- |
| Suite loader | `eval-suite.test.ts` | validación, rutas seguras, ids únicos |
| Verificadores | `eval-verifiers.test.ts` | `pass/fail/error`, límites de tiempo, snapshot de árbol |
| Estadística | `eval-stats.test.ts` | Wilson, varianza, `pass@k`, `pass^k` |
| Motor | `eval-engine.test.ts` | aislamiento de copia, presupuesto, condiciones D2, política D16 |
| Reporte/compare | `eval-report.test.ts`, `eval-compare.test.ts` | medido vs estimado, deltas, rechazo de versiones distintas, «no concluyente» |
| CLI | `cli-eval.test.ts` | flags, JSONL, códigos de salida |
| Replay | `eval-cassette.test.ts`, `eval-replay.test.ts` | byte a byte, divergencia con diff, conservación de IDs, sin secretos |
| Suites incluidas | `eval-bundled-suites.test.ts` | replay de cassettes en CI |

No se añaden pruebas de instantánea. Los proveedores de prueba son «scripted» y deterministas; ninguna prueba de `pnpm test` usa red ni credenciales.

## 10. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Costo de ejecutar LLM reales | Presupuestos duros por tarea (D5); `k` por defecto bajo; replay por defecto en CI; Fase 0 mide el costo antes de fijar `k`. |
| No-determinismo del modelo | Repeticiones + intervalos de Wilson; el reporte nunca afirma determinismo en `live` (§1.3); «no concluyente» explícito (O3). |
| Fixtures obsoletos o suites que se pudren | `suiteVersion` obligatoria; `compare` rechaza mezclar versiones (D14); las suites incluidas se ejercitan en CI. |
| Cassettes frágiles (cualquier cambio de prompt del harness las invalida) | Es el comportamiento buscado (detecta regresión), pero se ofrece `alisio eval record` de un solo comando y el diff estructurado indica qué cambió; se graba solo un subconjunto pequeño. |
| El replay da falsa confianza sobre la calidad del modelo | El reporte marca `mode: "replay"` en cabecera y la documentación lo dice: replay mide el harness, no el modelo (§4). |
| Fuga de secretos en cassettes o exportaciones | Exclusión por construcción (§5.3), prueba de escaneo (Fase 4) y paquete `export` revisado (D9). |
| Verificadores `command` ejecutan código del fixture | Subproceso con entorno limpio y timeout; **un subproceso no es un sandbox** (regla del repo): las suites son código confiable del repositorio, y `alisio eval run --suite-dir` sobre suites de terceros muestra una advertencia y exige confirmación. |
| Deriva entre el laboratorio y el comportamiento interactivo | El motor usa `createApplication` y `AgentRunner` reales; no hay un bucle paralelo. |

## 11. Presupuestos y puertas (objetivos, no garantías; O8)

- Replay de las cassettes incluidas en `pnpm test`: ≤ 10 s en total.
- Sobrecarga del motor sobre una ejecución equivalente de `alisio run`: ≤ 5 % del tiempo de pared (sin contar la copia del fixture).
- Copia del fixture: ≤ 500 ms para fixtures de hasta 5 MB.
- Tamaño de cassettes incluidas: ≤ 2 MB en total en el repositorio.
- Estabilidad: con la misma cassette, 100 replays consecutivos producen la misma secuencia de eventos (0 divergencias).
- Si una puerta no se cumple, la fase entrega sin promoción de la capacidad afectada y lo reporta.

## 12. Decisiones abiertas

| ID | Pregunta | Recomendación |
| --- | --- | --- |
| O1 | ¿Se adapta `EvalVerifier` a los verificadores de `specs/011-proof-v1.md` cuando exista? | **Sí, como fase posterior**; hoy `kind` queda abierto (D12) y no se bloquea el laboratorio por Proof. |
| O2 | ¿Se prioriza replay (Fase 4) sobre repeticiones/comparación (Fase 3) si hay que recortar? | **Mantener el orden 3 → 4**: sin comparación no hay puerta de promoción para S2/S4; el replay se adelanta solo si el propietario necesita CI primero. |
| O3 | ¿Umbral de `k` mínimo para afirmar mejora? | **`k=5`** por tarea y comparación solo con intervalos de Wilson no solapados; configurable. |
| O4 | ¿Las suites incluidas viajan en el paquete npm o solo en el repo? | **Solo en el repo** en la v1 (peso y mantenimiento); `alisio eval run --suite-dir` cubre suites propias. |
| O5 | ¿`alisio eval` entra en el binario autónomo (Bun)? | **Sí si el aumento es < 150 KB**; si no, solo vía npm. Medir en Fase 0. |
| O6 | ¿LLM como juez en una fase posterior? | **No en esta spec**; si se pide, spec aparte con calibración y costo declarados. |
| O7 | ¿Puede el laboratorio bloquear una release automáticamente? | **No**: informa; el propietario decide (consistente con O7 de §3.1). Un `scripts/eval-ci.ts` puede salir con código ≠ 0 en CI si el propietario lo habilita. |
| O8 | ¿Vista de solo lectura en Web/TUI del último reporte? | **Diferir**; la CLI y el Markdown bastan para U1/U2. Si se hace, una sola tarjeta en la Web con captura (Fase 6 opcional). |
| O9 | ¿Migración de persistencia para resultados históricos? | **No en la v1**: los reportes son archivos en `<dataDir>/eval/`. Si más adelante hace falta una tabla, usa «la siguiente migración libre (v11 si es la primera en ejecutarse)» y se coordina con las demás specs; esta spec **no** añade ninguna. |
| O10 | ¿Migrar `scripts/bench-dashboard.ts` al formato de suites? | **No ahora**; ambos conviven (el bench mide rendimiento puntual; el laboratorio mide fiabilidad de tareas). |

## 13. Orden de ejecución y dependencias

- Precede a: `specs/013-adaptive-execution-v1.md` (su Fase 0 y su puerta de promoción exigen al menos las Fases 1–3 de este laboratorio y la suite `smoke-coding`), y a las futuras specs de contexto, fronteras de confianza e interfaz de código.
- No depende de ninguna otra spec propuesta. Compatible con `specs/018-perimeter-v1.md` (sin solapamiento de archivos).
- Persistencia: **no requiere migración** (O9). Si una decisión posterior la exige: «siguiente migración libre (v11 si es la primera en ejecutarse)».
- Versión: la siguiente minor al ejecutar; aditiva.

## 14. Asignación de modelos

Por defecto **Sonnet**. **Opus** solo en tres puntos: (1) diseño del aislamiento de ejecución del motor (Fase 2: copia temporal, política por tarea y límites del subproceso de verificadores); (2) forma canónica del `requestFingerprint` (Fase 4: qué campos entran y cuáles son volátiles); (3) revisión final de la separación `measured`/`estimated` y de la validez estadística del comparador (Fase 3). El resto (loader, verificadores, CLI, documentación) es trabajo de ejecución en Sonnet.

## 15. Estado de implementación

| Fase | Estado |
| --- | --- |
| 0 — Línea base | Pendiente |
| 1 — Contratos y verificadores | Pendiente |
| 2 — Motor `live` | Pendiente |
| 3 — Métricas, reporte y compare | Pendiente |
| 4 — Cassettes y replay | Pendiente |
| 5 — Suites incluidas y CI | Pendiente |
| 6 — Documentación | Pendiente |

Estado del documento: **Borrador** (2026-10-13). Nada de lo descrito está implementado.
