# Especificación Técnica: Ejecución adaptativa — estrategia, guardia de progreso y contratos de delegación

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Origen | 🔬 **Investigación arXiv** (`specs/research/022-arxiv-features-research.md`) · **Orden de ejecución: 4 de 8** |
| Proyecto | Alisio |
| Estado | **Borrador. Propuesta, no implementada.** Decisiones O1–O9 pendientes de confirmar por el propietario. No se ejecuta hasta que exista al menos el núcleo de `specs/archive/010-reliability-lab-v1.md` (Fases 1–3 y la suite `smoke-coding`). |
| Fecha | 2026-10-13 |
| Paquetes afectados | `@alisio/sdk` (aditivo: eventos `strategy_selected` y `run_stalled` en `RunEventDataMap`, `StrategyName`, `StrategySignals`, `ChildResultContract`, campos opcionales en `ChildRunResult`), `@alisio/core` (nuevo `packages/core/src/core/progress-guard.ts` y `packages/core/src/strategy/*`; cambios acotados en `core/runner.ts`, `goal/machine.ts`, `commands/builtins.ts`, `core/run-stats.ts`, `config.ts`), `@alisio/plugin-subagents` (`src/index.ts`, `src/manager.ts`: contrato de resultado y coste de coordinación), `@alisio/server` (los eventos nuevos viajan por el SSE existente), `@alisio/web` (privado: tarjeta de estancamiento y de estrategia en el hilo), `@alisio/alisio-code` (TUI: mensajes de estancamiento y de estrategia; `alisio run --json` ya emite los eventos nuevos) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción. |
| Relación con otras especificaciones | **Depende de** `specs/archive/010-reliability-lab-v1.md` (Fase 0 de medición y puerta de promoción de cada comportamiento activo). **Consume opcionalmente** `specs/011-proof-v1.md` (los IDs de evidencia en el contrato de resultado de los hijos; sin Proof el campo queda como texto). **Deja la señal `strategy`** lista para `specs/backlog/020-model-tier-router-v1.md`, que sigue siendo dueña del enrutado de modelos; esta spec **no** elige modelos. **No toca** `specs/018-perimeter-v1.md` (Perímetro no decide permisos; esta spec tampoco). Opcionalmente usa Decision Intelligence (`ToolContext.decisions?.tryDecide`), nunca como requisito. |
| Superficies | Web, TUI y headless (`alisio run`, JSONL) con paridad funcional: el mismo evento y el mismo texto de razón en las tres. |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**. Aditiva. **Todo el comportamiento activo es opt-in** (`off` o `shadow` por defecto) hasta que el propietario promueva cada pieza tras pasar su puerta de medición (§11). El default de cada release es byte-idéntico al anterior salvo por el registro `shadow`. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio el 2026-10-13 sobre `main` (0.6.0, `2e867c7`); **(no verificado)** = deducido o externo sin prueba ejecutada aquí; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor.** Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts` (vitest), sobre comportamiento en límites de módulo. Sin pruebas de instantánea.
4. **Orden obligatorio**: Fase 0 (medición con el laboratorio) → el propietario revisa → Fases 1..7. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: §14. Por defecto Sonnet; Opus solo en los puntos listados.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo `node:fs`, `node:child_process`, `node:sqlite`; ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del core; los plugins dependen solo de `@alisio/sdk` (peer) y **no importan internals de `@alisio/core`**; preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión persistida; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Contratos **aditivos**: las uniones solo ganan variantes; `RunEvent.schemaVersion` sigue en 1; ningún `RunStatus` existente cambia de semántica.
8. Idioma: identificadores, eventos, claves y mensajes de error en inglés; UI en inglés y español (`src/i18n/en.ts` y `es.ts`, `packages/web/src/i18n/es.ts`); esta especificación en español. Docs EN/ES en paridad; límites en `docs/implementation-status.md`; capturas Web UI en `docs/assets/web-ui/<feature>_web_ui.webp` (§AGENTS.md).
9. Esta especificación **no crea permisos ni modifica el gate** (`permissions/decide.ts`, `permissions/modes.ts`). La estrategia y la guardia **informan y detienen el bucle**; nunca aprueban ni deniegan una herramienta.

## 1. Objetivo, usuarios y principio rector

### 1.1 Objetivo

Tres problemas observables hoy, resueltos por piezas independientes y medibles:

1. **Elegir la estrategia más simple suficiente.** No existe un selector `direct | planned | delegated`; solo hay un agente `plan` que el usuario activa a mano y la herramienta `task`, que el modelo puede lanzar libremente **(verificado)**: `core/agents/active.ts` (`PLAN_AGENT_ID`, `DEFAULT_AGENT_ID`) y `plugin-subagents/src/index.ts` (`task`). Resultado: tareas pequeñas que gastan subagentes o planes, y tareas grandes sin plan.
2. **Detectar estancamiento en cualquier run.** Los disyuntores de progreso (`noToolTurnsLimit` = 3, respuestas idénticas, `breakerStage()`) existen **solo para goals** (`core/goal/machine.ts`); el runner normal solo se detiene por `maxTurns` (def. 100) o presupuesto de tokens, sin detector de estancamiento **(verificado)**. Un modelo puede repetir la misma llamada fallida cien veces.
3. **Que la delegación no oculte fallos ni costos.** El resultado de un hijo es texto libre `<task state=...>` sin contrato estructurado; `ChildRunResult` trae `status`, `text`, `usage`, `error?`, `turnsExceeded?` pero el padre no obtiene evidencia ni «archivos cambiados», y el costo de coordinación no aparece en `/stats` **(verificado)**.

### 1.2 Usuarios

| ID | Persona | Escenario | Qué obtiene |
| --- | --- | --- | --- |
| U1 | **Dev en terminal/Web con un modelo de costo/latencia relevante** | Pide «renombra esta variable» o «corrige este typo» y el agente abre un plan o un subagente. | Estrategia `direct` por defecto para tareas pequeñas; aviso (no bloqueo) si el modelo intenta delegar trabajo pequeño. |
| U2 | **Dev que lanza tareas largas o en segundo plano** (incl. `alisio run` en CI) | El modelo entra en un bucle de llamadas idénticas o de fallos repetidos y consume el presupuesto. | Parada con razón visible, un empujón previo (nudge) y estado terminal explicado, en TUI/Web/JSONL. |
| U3 | **Quien usa subagentes en paralelo** | Un hijo falla o devuelve algo parcial y el padre «resume» como si hubiera ido bien. | `failed` real en el padre, evidencia y archivos cambiados declarados, coste de coordinación visible en `/stats`. |
| U4 | **El mantenedor** | Quiere saber si una política mejora de verdad. | Modo `shadow` + medición con `alisio eval` antes de activar nada. |

### 1.3 Principio rector

> **La estrategia más simple que alcance, el bucle que sabe cuándo está atascado y la delegación que dice la verdad sobre su resultado. Ninguna política activa entra sin medición, y ninguna toca permisos.**

Reglas derivadas:

- Las heurísticas son **deterministas y baratas**, sobre señales observables; no hay llamada a un modelo para decidir la estrategia (D2). Decision Intelligence puede afinar, nunca ser requisito (D9).
- El registro de decisiones guarda **señales y versión de política**, no cadenas de razonamiento del modelo (D4).
- **Todo comportamiento activo nace en `off` o `shadow`** y solo se promueve con la puerta de §11 (D12).
- Los bucles legítimos de espera (`bg_output`, `task_wait`) no son estancamiento (D6).

### 1.4 Nombre

**Ejecución adaptativa**, identificador `adaptive` (config `adaptive.*`, módulo `core/strategy`). Eventos públicos: `strategy_selected`, `run_stalled`. Alternativa descartada: `orchestration` (sugiere un orquestador multiagente nuevo, que esta spec no introduce).

### 1.5 Alcance

Selector de estrategia determinista con override y registro; guardia de progreso del runner extraída y compartida con `goal/machine.ts`; presupuestos por run de llamadas y tiempo; contrato estructurado de resultado de subagente; agregación de uso del hijo en el padre y vista «coordination cost»; política `delegation.minScope`; eventos y UI en las tres superficies; documentación EN/ES.

### 1.6 Fuera de alcance

| Excluido | Motivo |
| --- | --- |
| Elegir **modelo** por tarea (cascadas, RouteLLM, FrugalGPT) | Es de `specs/backlog/020-model-tier-router-v1.md`; aquí solo se emite la señal `strategy` que esa spec podrá consumir. |
| Un orquestador multiagente nuevo o paralelismo adicional | Las lecturas paralelas (`readConcurrency`, lotes `effect:"read"`/`concurrent`) y el aislamiento de escrituras de subagentes (`worktree\|serial\|shared`) ya existen **(verificado)**. |
| Optimización automática de workflows (AFlow/DSPy) | Costo alto y sin base de medición; la comparación manual de variantes vive en el laboratorio. |
| Cambiar permisos, el gate o el modo `ask\|auto\|full` | Regla §0.9. |
| Razonamiento del modelo como señal (reasoning traces) | `reasoning_delta` es solo de visualización y no se persiste ni se reproduce **(verificado)** (`ProviderEvent`). |
| Terminar goals por la guardia del runner | Los goals conservan su máquina de estados; la guardia comparte funciones con ella pero no cambia sus transiciones (D7). |

## 2. Base verificada

| Hecho | Evidencia | Implicación |
| --- | --- | --- |
| `AgentRunner` tiene `maxTurns` (def. 100), presupuesto acumulado de tokens `defaultTokenBudget()`, y `executeCall()` como gate único | `packages/core/src/core/runner.ts` (bucle ~l.1264, `executeCall` ~l.669) | Único punto donde enganchar la guardia sin tocar el gate. |
| Lotes paralelos de llamadas `read`/`concurrent` con `readConcurrency` (def. 4) | `runner.ts` (~l.1631) | La guardia debe contar llamadas por lote, no por orden de llegada. |
| `RunStatus = queued \| running \| completed \| turns_exceeded \| failed \| cancelled \| interrupted` | `packages/core/src/core/contracts.ts` | Un fin por estancamiento necesita razón aditiva (§5.3), no un status nuevo si se puede evitar (O3). |
| Disyuntores de goal: `noToolTurnsLimit: 3`, `replyFingerprint()`, `breakerStage(count, limit)` → `none\|log\|nudge\|pause`, `pendingNudge()` | `packages/core/src/goal/machine.ts` | Se extrae el concepto de etapas a `core/progress-guard.ts` y `goal/machine.ts` lo reutiliza sin cambiar su semántica. |
| Agente activo y agente de plan | `packages/core/src/agents/active.ts` (`DEFAULT_AGENT_ID="build"`, `PLAN_AGENT_ID="plan"`, `BUILTIN_AGENTS`) | La estrategia `planned` activa el agente `plan` ya existente; no se crea otro. |
| Subagentes: `task` (internal, concurrent, background, `model` por hijo, `task_id`), `task_status`, `task_wait`, `send_message`; `SubagentManager` con cola acotada, `maxDepth`, aislamiento `worktree\|serial\|shared`; `DELEGATION_TOOLS` | `packages/plugin-subagents/src/{index,manager}.ts` | El contrato de resultado se añade en `task`/`manager` con feature-detect. |
| `ChildRunResult { id, status, text, usage:{input,output}, error?, turnsExceeded? }` | `packages/sdk/src/index.ts` (~l.967) | Se añaden campos opcionales; ninguno existente cambia. |
| `RunEventDataMap` incluye `decision_fallback`, `decision_completed`, `goal_changed` (SSE); `/stats` existe | `packages/sdk/src/index.ts`, `commands/builtins.ts` (`stats`), `core/run-stats.ts` | Los eventos nuevos y el desglose de coordinación se integran donde ya viven las estadísticas. |
| `ToolContext.decisions?.tryDecide(request, options)` opcional (feature-detect) | `packages/sdk/src/index.ts` (~l.1399); `core/src/decisions/service.ts` | Camino opcional de la §6.4; si no existe, se ignora. |
| No hay marcado de procedencia/taint de resultados | `mcp/connector.ts` (solo etiqueta de descripciones) | Fuera de alcance aquí; es de `specs/014-trust-boundaries-v1.md`. |

## 3. Decisiones

### 3.1 Decisiones del propietario (propuestas, a confirmar)

| ID | Decisión propuesta |
| --- | --- |
| O1 | La guardia de progreso del runner entra primero (Fases 1–2): es la pieza con menor riesgo y valor inmediato. |
| O2 | El selector de estrategia nace en modo `shadow` (solo registra `strategy_selected`); su promoción a `suggest` exige la puerta de §11. |
| O3 | El fin por estancamiento se expresa como `RunStatus: "failed"` con `reason: "stalled"` y el evento `run_stalled`, **sin nuevo valor de `RunStatus`**, para no romper consumidores de la unión. |
| O4 | La política `delegation.minScope` arranca en `off`; `warn` solo tras medición; `enforce` solo por decisión explícita del propietario. |
| O5 | El contrato de resultado del hijo es **opt-in por parte del hijo** (bloque estructurado) con degradación a texto cuando el hijo no lo emite. |
| O6 | Los presupuestos de llamadas/tiempo por run existen pero con valores por defecto «sin límite nuevo» hasta que la Fase 0 fije valores sensatos. |
| O7 | El nudge de estancamiento se inyecta **una vez** por tipo de síntoma; el segundo disparo termina el run. |
| O8 | Los presupuestos de §11 son objetivos, no garantías; una puerta incumplida entrega sin promoción. |
| O9 | Orden de ejecución: tras el laboratorio; independiente de Proof (consume evidencia solo si existe). |

### 3.2 Decisiones de diseño (vinculantes)

| ID | Decisión |
| --- | --- |
| D1 | Estrategias: `direct` (el agente actual responde y usa herramientas), `planned` (se activa el agente `plan`, `PLAN_AGENT_ID`, antes de ejecutar) y `delegated` (se permite/sugiere `task` para partes independientes). La estrategia es **informativa en `shadow`**, **sugerida en `suggest`** (se añade una línea al contexto del turno, nunca bloqueo) y **aplicada solo si el usuario la fija por override** (`/strategy`, `--strategy`). Nunca se cambia el agente activo sin que el usuario lo haya pedido, salvo el modo `auto` promovido por el propietario (O2). |
| D2 | El selector es una **función pura y determinista** `selectStrategy(signals, policy) → {strategy, policyVersion}` sin red ni modelo. Señales (§5.1): tamaño del prompt (caracteres), número de rutas mencionadas, número de símbolos/identificadores entre comillas o con extensión, archivos en `git status` (acotado, solo conteo), agente activo, existencia de goal, `hasPlan`. Mismas señales + misma política = misma estrategia. |
| D3 | El **override del usuario** (`/strategy direct\|planned\|delegated\|auto`, o `--strategy` en `alisio run`) gana siempre sobre el selector y se registra como `source: "override"`. |
| D4 | `strategy_selected` y `run_stalled` guardan **señales, versión de política y razón corta codificada**, nunca texto de razonamiento del modelo. `policyVersion` es un entero que sube cuando cambian umbrales o reglas, para poder comparar mediciones del laboratorio entre versiones. |
| D5 | **Guardia de progreso** (`core/progress-guard.ts`, función pura + estado por run): cuenta tres síntomas — (a) misma llamada (nombre de herramienta + hash estable del input canónico) repetida N veces seguidas; (b) M fallos consecutivos de la misma herramienta; (c) K vueltas consecutivas sin efecto ni información nueva (sin llamadas a herramientas con salida distinta de las anteriores y sin cambios de archivos). Etapas reutilizan el vocabulario de `breakerStage`: `none → log → nudge → stop`. Umbrales por defecto a fijar en la Fase 0 (O6). |
| D6 | **Exclusiones de la guardia**: `bg_output`, `task_wait`, `task_status` y cualquier herramienta marcada de espera con backoff no cuentan como repetición mientras el resultado cambie o el estado de la tarea esté `running`; se evita el falso positivo de polling legítimo. La lista de exclusión es configuración, no código fijo. |
| D7 | **Extracción, no reescritura**: `goal/machine.ts` pasa a importar de `core/progress-guard.ts` las funciones comunes (`breakerStage`, `fingerprint`) sin cambiar el comportamiento de los goals; las pruebas de caracterización de goals existentes deben seguir verdes sin modificación. |
| D8 | Etapa `nudge`: se inyecta **una vez** un mensaje de sistema corto («repeated identical call to X; change approach or explain the blocker») en el siguiente turno. Etapa `stop`: el run termina con `status: "failed"`, `reason: "stalled"`, `stalledKind: "repeat" \| "failure" \| "no_progress"` y el evento `run_stalled {kind, tool?, count, stage, policyVersion}`. El resto de la sesión queda utilizable (el usuario puede continuar con otro mensaje). |
| D9 | Camino opcional: si `ToolContext.decisions?.tryDecide` existe, el selector **puede** pedir una decisión de afinado cuando la estrategia está en el margen de dos umbrales; si devuelve `null` o no existe, se usa el resultado determinista. Nunca es requisito y nunca bloquea. |
| D10 | **Presupuestos por run**: `adaptive.budget.maxToolCalls` y `adaptive.budget.maxWallMs` (además de tokens y `maxTurns`). Al agotarse: el run termina con `reason: "budget"` y un mensaje que **sugiere** escalar a `plan`/dividir; no cambia el agente por sí solo. Por defecto sin límite adicional (O6). |
| D11 | **Contrato de resultado del subagente** (`ChildResultContract`): el hijo termina con un bloque estructurado `{status: "done"\|"partial"\|"failed"\|"blocked", summary, filesChanged[], evidence[]}`. El plugin lo extrae de la respuesta final del hijo (bloque JSON delimitado) y lo valida; si falta o es inválido, degrada a `status` derivado de `ChildRunResult.status` y `summary = text` con `contract: "absent"`. `evidence[]` acepta IDs de `specs/011-proof-v1.md` si existen, o texto. |
| D12 | **Todo comportamiento activo exige puerta**: la promoción de `shadow → suggest/enforce` requiere una comparación `alisio eval compare` (laboratorio) que cumpla §11 sobre `smoke-coding`; sin ella el valor por defecto sigue siendo `off`/`shadow`. |
| D13 | `failed` real en el padre: si el contrato del hijo dice `failed` (o `ChildRunResult.status` es de fallo, o `error` existe), la herramienta `task`/`task_wait` devuelve `isError: true` con el resumen, no un texto que parezca éxito. `partial` e `blocked` no son error pero se marcan en el texto de la herramienta y en el panel. |
| D14 | **Coste de coordinación**: el `usage` de cada hijo se agrega a las estadísticas del run padre (`core/run-stats.ts`) en un contador separado `coordination` y `/stats` lo muestra («coordination cost»: tokens de hijos, número de hijos, tiempo). No se suma silenciosamente al consumo del padre sin etiqueta. |
| D15 | **`delegation.minScope`** (`off\|warn\|enforce`, default `off`): cuando el selector clasificó la tarea como pequeña y el modelo llama a `task`, `warn` devuelve un aviso adicional en el resultado de la herramienta (no bloquea); `enforce` devuelve error de herramienta explicando que la tarea es pequeña y debe hacerse directo, **salvo** que el usuario haya fijado `delegated` por override. Nunca aplica a tareas de fondo ya aprobadas por el usuario. |
| D16 | **Feature-detect en plugins**: `plugin-subagents` no importa internals del core; consulta capacidades por el SDK (`context.decisions?`, presencia de los campos nuevos en `ChildRunResult`). Con un core antiguo el plugin funciona sin contrato ni agregación (degradación a texto). |
| D17 | **Con un único modelo todo funciona igual**: la estrategia no requiere varios modelos; `task` con `model` por hijo sigue siendo opcional. |
| D18 | Persistencia: la estrategia elegida y los eventos de estancamiento se guardan como eventos de sesión (el almacén de eventos existente). **No se crea tabla nueva** en la v1; si más adelante hace falta consultar estadísticas históricas, se usa «la siguiente migración libre (v11 si es la primera en ejecutarse)» y se coordina con las demás specs. |
| D19 | Cada fase actualiza `docs/implementation-status.md`. |

## 4. Concepto

```
                     ┌──────────────────────────────────────────┐
 prompt + señales ──►│ selectStrategy()  (puro, determinista)   │──► strategy_selected
                     │ direct | planned | delegated  (D1–D4)   │    {strategy, policyVersion, signals}
                     └──────────────────────┬───────────────────┘
                                            │ shadow: solo registra · suggest: línea de contexto
                                            ▼
        AgentRunner turn loop ──► progress-guard (D5–D8) ──► log → nudge (una vez) → stop
              │                      repeat | failure | no_progress   → run_stalled, reason "stalled"
              │ task(...)
              ▼
   plugin-subagents ──► hijo termina con ChildResultContract (D11)
              │            done | partial | failed | blocked + filesChanged + evidence
              ▼
   padre: isError real en failed (D13) · usage del hijo → "coordination cost" en /stats (D14)
```

Las tres piezas son independientes: se pueden promover por separado, cada una con su propia puerta.

## 5. Contratos y tipos

### 5.1 Señales y estrategia (SDK, aditivo; solo tipos)

```ts
export type StrategyName = "direct" | "planned" | "delegated";

export interface StrategySignals {
  promptChars: number;
  pathsMentioned: number;
  symbolsMentioned: number;
  changedFiles: number | null;        // conteo de `git status`; null si no es repo o no se pudo
  activeAgent: string;
  hasGoal: boolean;
  hasPlan: boolean;
}

export type StrategySource = "heuristic" | "decision" | "override";
```

### 5.2 Eventos (aditivos en `RunEventDataMap`)

```ts
strategy_selected: {
  strategy: StrategyName;
  source: StrategySource;
  policyVersion: number;
  mode: "shadow" | "suggest" | "auto";
  signals: StrategySignals;
};

run_stalled: {
  kind: "repeat" | "failure" | "no_progress";
  stage: "log" | "nudge" | "stop";
  tool?: string;
  count: number;
  policyVersion: number;
};
```

`RunEvent.schemaVersion` sigue en 1 (variantes nuevas de la unión de eventos).

### 5.3 Fin por estancamiento y presupuesto

El run termina con el `RunStatus` existente `"failed"` y un campo aditivo `reason?: "stalled" | "budget"` en el registro del run (`RunRecord` en `core/contracts.ts`), más `stalledKind?`. Las superficies muestran la razón con texto localizado; JSONL la emite en el evento `run_stalled` y en el evento terminal del run. (O3: si el propietario prefiere un `RunStatus` nuevo, se cambia en la Fase 2 con una prueba de compatibilidad.)

### 5.4 Contrato de resultado de hijo

```ts
export interface ChildResultContract {
  status: "done" | "partial" | "failed" | "blocked";
  summary: string;
  filesChanged: string[];
  evidence: Array<string | { evidenceId: string }>;   // IDs de Proof si existen
  contract: "present" | "absent" | "invalid";
}

// ChildRunResult gana campos opcionales (los existentes no cambian):
//   contract?: ChildResultContract;
//   coordination?: { wallMs: number };
```

Bloque en la respuesta final del hijo (delimitado para extracción fiable; `<task-result>` es un nombre de trabajo, a confirmar en la Fase 5):

```
<task-result>{"status":"partial","summary":"…","filesChanged":["src/a.ts"],"evidence":["…"]}</task-result>
```

### 5.5 Configuración (global-only para valores que amplían; proyecto solo puede endurecer)

```jsonc
"adaptive": {
  "strategy": { "mode": "shadow" },                 // off | shadow | suggest | auto
  "progress": {
    "enabled": true,                                // solo log/nudge/stop de la guardia
    "repeatLimit": 3, "failureLimit": 4, "noProgressLimit": 4,
    "ignoreTools": ["bg_output", "task_wait", "task_status"]
  },
  "budget": { "maxToolCalls": null, "maxWallMs": null },
  "delegation": { "minScope": "off" }               // off | warn | enforce
}
```

Los valores numéricos son marcadores de posición; la Fase 0 fija los definitivos (O6). `progress.enabled` nace en `shadow` interno (registra `run_stalled` con `stage: "log"` pero no inyecta nudge ni termina) hasta pasar la puerta (D12).

## 6. Diseño por pieza

### 6.1 Selector de estrategia (Fase 3)

- `packages/core/src/strategy/signals.ts`: calcula `StrategySignals` a partir del prompt, el estado de sesión y un `git status --porcelain` acotado (solo conteo, con timeout corto y sin fallar el turno si git falla: `changedFiles: null`).
- `packages/core/src/strategy/select.ts`: `selectStrategy(signals, policy)`. Reglas iniciales (a calibrar en Fase 0): prompt corto y ≤ 2 rutas → `direct`; prompt largo o ≥ 6 rutas o `changedFiles` alto → `planned`; varias rutas independientes sin dependencia declarada y `maxDepth > 0` → `delegated`. `hasGoal` o override fijan el resultado.
- Integración en `core/runner.ts` al inicio de cada run de usuario (no en cada turno): emite `strategy_selected`. En `suggest`, añade una línea corta al contexto del turno (no un cambio de agente). En `auto` (solo si el propietario lo promueve), activa `planned` mediante `agents/active.ts`.
- Comandos: `/strategy [auto|direct|planned|delegated]` en `commands/builtins.ts`; `--strategy` en `alisio run`.

### 6.2 Guardia de progreso (Fases 1–2)

- `core/progress-guard.ts`: `createGuard(policy)`, `observeCall(guard, {tool, inputHash, outputHash, isError})`, `observeTurn(guard, {hadEffect})`, que devuelven `{stage, kind, tool?, count}`. Pura; el estado es un objeto simple por run.
- Hash de input: JSON canónico (claves ordenadas) + SHA-256 truncado; el hash **no** se persiste con el contenido del input (privacidad, tamaño).
- Integración en el bucle de `runner.ts` justo después de recoger los resultados de cada lote (no dentro de `executeCall`, para no tocar el gate): una llamada denegada por el gate cuenta como fallo de esa herramienta.
- `goal/machine.ts` reutiliza `breakerStage` y `replyFingerprint` desde `progress-guard.ts` (D7).

### 6.3 Presupuestos por run (Fase 2)

Contador de llamadas a herramientas y reloj de pared por run (`core/run-clock.ts` ya existe **(verificado)**; se reutiliza). Al agotarse se aplica D10.

### 6.4 Decision Intelligence (Fase 3, opcional)

Solo si `ToolContext.decisions?.tryDecide` está disponible y la estrategia cae en el margen entre dos umbrales (banda configurable). La respuesta se interpreta contra un esquema cerrado `{strategy}`; cualquier otra cosa se descarta.

### 6.5 Subagentes (Fases 4–5)

- `plugin-subagents/src/index.ts`: la instrucción del hijo incluye el formato `<task-result>`; el resultado de `task`/`task_wait` se construye desde `ChildResultContract` (D11, D13).
- `plugin-subagents/src/manager.ts`: calcula `wallMs` y devuelve `usage`; expone el agregado al padre.
- `core/run-stats.ts` y `/stats`: contador `coordination` y su línea de salida.

## 7. Fases

### Fase 0 — Medición con el laboratorio (Sonnet; requiere `01-alisio-reliability-lab.md` Fases 1–3)

Entregable: números, no código de producción.

- Escribir en el laboratorio dos suites mínimas: `adaptive-loops` (tareas con fallos repetidos y llamadas idénticas inducidas por un proveedor «scripted») y reutilizar `smoke-coding` para medir regresión de éxito.
- Medir con `k=5`: frecuencia de bucles reales en `smoke-coding`, latencia/costo de tareas pequeñas con y sin plan/subagente, y cuántas veces el modelo llama a `task` en tareas pequeñas.
- Fijar umbrales por defecto de D5, presupuestos de D10 y la banda de D9; el propietario los aprueba.

Criterios de aceptación: (1) números registrados con las condiciones del laboratorio (D2 del laboratorio); (2) umbrales aprobados por el propietario antes de la Fase 1.
Pruebas: las del laboratorio.

### Fase 1 — `progress-guard` puro y extracción desde goals (Sonnet)

- Crear `packages/core/src/core/progress-guard.ts` con las funciones de §6.2.
- `goal/machine.ts` importa de él; las pruebas de goals existentes pasan **sin modificarse**.

Criterios de aceptación:
1. `breakerStage` y `replyFingerprint` mantienen exactamente su comportamiento (pruebas de caracterización existentes + nuevas tabulares).
2. Tres llamadas idénticas consecutivas → etapas `log`, `nudge`, `stop` según los límites; una llamada distinta intercalada reinicia la racha.
3. `bg_output` y `task_wait` repetidos con resultados cambiantes **no** disparan (D6).
4. Fallos consecutivos de la misma herramienta cuentan; un éxito reinicia.

Pruebas (Rojo primero): `tests/progress-guard.test.ts`, y las existentes de goal sin cambios.

### Fase 2 — Integración en el runner, eventos y presupuesto (Sonnet; **Opus** para la integración en el bucle, §14)

- `runner.ts`: observar llamadas y vueltas; en `shadow` emitir `run_stalled {stage:"log"}`; con la guardia activa, inyectar nudge una vez y terminar con `failed`/`reason:"stalled"` (D8).
- SDK: evento `run_stalled` y campos aditivos del run (§5.2–5.3).
- Presupuestos D10 con razón `budget`.
- Superficies: texto localizado de la razón en TUI (`src/i18n`), Web (`packages/web/src/i18n`, tarjeta en el hilo) y JSONL (`alisio run --json`). SSE ya transporta los eventos.

Criterios de aceptación:
1. Un bucle de llamadas idénticas se detiene con razón visible en TUI/Web/JSONL (criterio clave 5), con captura Web en `docs/assets/web-ui/adaptive_stalled_web_ui.webp` en ES y EN según `AGENTS.md`.
2. El nudge se inyecta exactamente una vez por síntoma (O7); el segundo disparo termina el run.
3. La sesión sigue utilizable tras `stalled`: un mensaje nuevo del usuario arranca un run normal.
4. IDs de tool calls y datos de continuación del proveedor se conservan en el run terminado por la guardia (prueba sobre el historial persistido).
5. Con `adaptive.progress.enabled=false` la salida del runner es byte-idéntica a la anterior (prueba de caracterización con proveedor scripted).

Pruebas: `tests/runner-progress-guard.test.ts` (patrón `tests/runner-gate-characterization.test.ts`), `tests/cli-run-stalled.test.ts`, prueba de componentes Web existente para la tarjeta.

### Fase 3 — Selector de estrategia en `shadow` + override (Sonnet)

- `core/strategy/{signals,select}.ts`; `strategy_selected` en `runner.ts`; `/strategy` y `--strategy`; `policyVersion`.
- Modo `shadow`: solo registra. Modo `suggest`: línea de contexto (D1).
- Opcional D9 detrás de feature-detect.

Criterios de aceptación:
1. Misma entrada, misma salida (determinismo): tabla de casos en la prueba.
2. El override gana y se registra con `source:"override"` (D3).
3. Con un único modelo y sin plugins, todo funciona igual (criterio clave 3).
4. `strategy_selected` se emite con `policyVersion` y señales, y no contiene texto de razonamiento (D4).
5. `changedFiles: null` cuando no es repo o git falla, sin romper el turno.

Pruebas: `tests/strategy-select.test.ts`, `tests/strategy-signals.test.ts`, `tests/strategy-command.test.ts`.

### Fase 4 — Agregación de uso y «coordination cost» (Sonnet)

- `plugin-subagents/src/manager.ts`: devolver `usage` y `wallMs` por hijo.
- `core/run-stats.ts`, `/stats`: contador `coordination` (D14); línea nueva en la salida.
- Feature-detect (D16): el plugin añade `coordination` solo si el core lo acepta.

Criterios de aceptación: (1) tras lanzar dos hijos, `/stats` muestra número de hijos y tokens de coordinación, separados del consumo del padre; (2) con un core sin el campo, el plugin funciona igual.
Pruebas: `tests/subagent-coordination.test.ts`, ampliación de las de `/stats`.

### Fase 5 — Contrato de resultado del subagente (Sonnet)

- Instrucción del hijo y extractor/validador de `<task-result>` en `plugin-subagents`.
- `task`/`task_wait`: `isError: true` en `failed` (D13); `partial`/`blocked` marcados; degradación `contract: "absent"`.
- `evidence[]` acepta IDs de Proof cuando existan (sin dependencia dura).

Criterios de aceptación:
1. Un hijo que falla aparece como fallo en el padre (`isError`) (criterio clave 4).
2. Un hijo sin bloque o con JSON inválido no rompe nada: `contract: "absent"|"invalid"` y el resultado conserva el texto.
3. El contrato no permite que el hijo declare `done` si `ChildRunResult.status` es de error (el estado del sistema gana sobre el declarado).
4. Con `filesChanged` declarado, el panel de subagentes lo muestra (Web/TUI).

Pruebas: `tests/subagent-contract.test.ts` (validador con casos válidos/ inválidos/ adversariales: JSON anidado, bloque duplicado).

### Fase 6 — `delegation.minScope` y escalamiento por presupuesto (Sonnet)

- Política `off|warn|enforce` (D15), apoyada en la estrategia de la Fase 3.
- Mensaje de sugerencia al agotar presupuesto (D10), con texto localizado.

Criterios de aceptación:
1. Con la política activa en `enforce`, una tarea pequeña no lanza subagentes automáticamente (criterio clave 1); con override `delegated` sí.
2. En `warn` se añade el aviso y la herramienta se ejecuta.
3. Decisiones y escaladas quedan registradas con `policyVersion` (criterio clave 2).

Pruebas: `tests/delegation-minscope.test.ts`.

### Fase 7 — Puerta de promoción, documentación y cierre (Sonnet)

- Ejecutar con el laboratorio la comparación `shadow` vs `suggest/enforce` y `progress` activo vs inactivo; reportar según §11. **Solo el propietario decide** qué pasa a default.
- `docs/adaptive-execution.md` y `docs/es/adaptive-execution.md` en paridad; capturas Web de la tarjeta de estrategia y del panel de subagentes con contrato (reutilizar capturas existentes si ya muestran la función).
- `docs/implementation-status.md`: qué quedó activo, qué quedó en `shadow`, límites (sin elección de modelo, heurística no aprendida, sin garantía de ausencia de falsos positivos).

Criterios de aceptación: informe de la puerta adjunto; docs EN/ES en paridad; `pnpm docs:check` y `pnpm docs:build` verdes.

## 8. Pruebas (mapa)

| Frontera | Prueba | Qué comprueba |
| --- | --- | --- |
| Guardia pura | `progress-guard.test.ts` | etapas, reinicios, exclusiones, caracterización de `breakerStage` |
| Runner | `runner-progress-guard.test.ts` | nudge único, terminación, razón, conservación de IDs, byte-identidad con la guardia off |
| CLI/JSONL | `cli-run-stalled.test.ts` | evento y razón en `alisio run --json` |
| Selector | `strategy-select.test.ts`, `strategy-signals.test.ts` | determinismo, override, señales, git ausente |
| Comando | `strategy-command.test.ts` | `/strategy` y `--strategy` |
| Subagentes | `subagent-coordination.test.ts`, `subagent-contract.test.ts` | agregación, contrato, degradación, `isError` |
| Delegación | `delegation-minscope.test.ts` | `off\|warn\|enforce` |
| Goal | pruebas existentes de goal | sin cambios (D7) |

Proveedores de prueba «scripted» deterministas; ninguna prueba usa red. Sin snapshots.

## 9. Riesgos

| Riesgo | Mitigación |
| --- | --- |
| Falsos positivos de la guardia en bucles legítimos (polling, reintentos esperados) | Exclusiones configurables (D6); nudge antes de parar; `shadow` primero; medir con `adaptive-loops` y `smoke-coding`; `k=5`. |
| Cambiar el comportamiento por defecto | Todo `off`/`shadow` hasta pasar la puerta (D12); prueba de byte-identidad con la guardia apagada. |
| Heurística de estrategia errónea en tareas atípicas | Solo sugiere (no cambia agente) salvo `auto` promovido; override siempre gana (D3); señales registradas para recalibrar con datos. |
| Romper `plugin-subagents` con cores antiguos | Feature-detect (D16); campos aditivos y opcionales; pruebas con un host que no los ofrece. |
| El hijo declara `done` sin haber terminado | El estado del sistema gana sobre el declarado (criterio Fase 5.3); evidencia con IDs de Proof cuando exista. |
| Inflar el contexto con nudges o líneas de estrategia | Mensajes cortos, una sola vez, ≤ 200 caracteres; medidos en el laboratorio. |
| `git status` lento en repos enormes | Timeout corto, solo conteo, `null` ante fallo; nunca bloquea el turno. |
| Solapamiento con el enrutado de modelos | Esta spec solo emite `strategy`; `020-model-tier-router-v1.md` es dueña de elegir modelo. |
| Estado de goal afectado por la extracción | D7 y pruebas de goal sin modificar. |

## 10. Compatibilidad y migración

Sin migración de base de datos (D18). Los eventos nuevos son variantes aditivas de la unión; consumidores que ignoran tipos desconocidos no cambian. `ChildRunResult` gana campos opcionales. La configuración `adaptive.*` es nueva y opcional. Si una fase posterior exigiera persistencia: «siguiente migración libre (v11 si es la primera en ejecutarse)».

## 11. Presupuestos y puertas (objetivos, no garantías; O8)

- Sobrecarga de la guardia: ≤ 0,5 ms por llamada a herramienta (p99) y 0 llamadas de red.
- Sobrecarga del selector: ≤ 5 ms por run (incluido el `git status` acotado con timeout ≤ 200 ms).
- **Puerta de promoción de `progress` activo**: sobre `smoke-coding` y `adaptive-loops` con `k=5`, el éxito de tareas no baja más de 2 puntos frente a la guardia en `shadow`, y la tasa de terminación por falso positivo ≤ 2 % de las tareas que terminan bien en baseline.
- **Puerta de `strategy: suggest`**: el éxito no baja más de 2 puntos y la mediana de tokens/latencia en tareas pequeñas no empeora; si mejora, se reporta con los intervalos del laboratorio.
- **Puerta de `delegation.minScope: warn/enforce`**: reducción medible de lanzamientos de `task` en tareas pequeñas sin caída de éxito > 2 puntos.
- Si una puerta no se cumple: la fase entrega sin promoción y lo reporta; el valor por defecto no cambia.

## 12. Decisiones abiertas

| ID | Pregunta | Recomendación |
| --- | --- | --- |
| O1 | ¿Qué pieza entra primero? | **Guardia de progreso (Fases 1–2)**: menor riesgo, valor inmediato, no depende del selector. |
| O2 | ¿Modo inicial del selector? | **`shadow`**; pasar a `suggest` solo con puerta superada; `auto` solo por decisión explícita. |
| O3 | ¿Fin por estancamiento con `RunStatus` nuevo o `failed` + `reason`? | **`failed` + `reason: "stalled"`**: no rompe la unión pública; se reevalúa si una superficie lo necesita. |
| O4 | ¿Valor por defecto de `delegation.minScope`? | **`off`**; `warn` tras medición; `enforce` nunca por defecto. |
| O5 | ¿El contrato del hijo es obligatorio? | **No**: opt-in con degradación a texto; endurecer más adelante si la medición lo justifica. |
| O6 | ¿Valores por defecto de umbrales y presupuestos? | **Fijarlos en la Fase 0** con datos del laboratorio; marcadores de posición de §5.5 hasta entonces. |
| O7 | ¿Cuántos nudges antes de parar? | **Uno** por síntoma, luego parada (D8). |
| O8 | ¿Banda de afinado con Decision Intelligence (D9)? | **Diferir**: implementarlo solo si la Fase 0 muestra tareas frecuentes en el margen; si no, omitir D9. |
| O9 | ¿Nombre del bloque `<task-result>`? | **Confirmar en la Fase 5** tras probar la extracción con distintos modelos (que no choque con markdown ni con `<task state=...>`). |
| O10 | ¿Los presupuestos de llamadas/tiempo por run deben aplicar también a hijos? | **Sí, heredados del padre con tope propio**, pero se decide en la Fase 2 con datos de coste de coordinación. |
| O11 | ¿Tarjeta Web de estrategia o solo línea en el hilo? | **Línea compacta** en el hilo (no tarjeta) para no ganar ruido visual; tarjeta solo para `run_stalled`. |

## 13. Orden de ejecución y dependencias

- Requiere antes: `specs/archive/010-reliability-lab-v1.md` (Fases 1–3 y suite `smoke-coding`) para la Fase 0 y la Fase 7.
- Consume si existe: `specs/011-proof-v1.md` (IDs de evidencia en el contrato de hijos). No bloquea.
- Alimenta: `specs/backlog/020-model-tier-router-v1.md` (la señal `strategy`; no se implementa enrutado aquí).
- Sin solapamiento de archivos con `specs/018-perimeter-v1.md`.
- Persistencia: sin migración (D18); si hiciera falta, «siguiente migración libre (v11 si es la primera en ejecutarse)».
- Versión: la siguiente minor al ejecutar; aditiva; comportamiento activo opt-in.

## 14. Asignación de modelos

Por defecto **Sonnet**. **Opus** solo en tres puntos: (1) integración de la guardia en el bucle de `runner.ts` (Fase 2: ubicación exacta respecto a lotes paralelos, denegaciones del gate y conservación de IDs de llamadas); (2) diseño de las reglas del selector y sus umbrales tras la Fase 0; (3) revisión del contrato de resultado del hijo y de su validador frente a entradas adversariales. El resto (extracción pura, CLI, i18n, estadísticas, documentación) es ejecución en Sonnet.

## 15. Estado de implementación

| Fase | Estado |
| --- | --- |
| 0 — Medición con el laboratorio | Pendiente (bloqueada por `01-alisio-reliability-lab.md`) |
| 1 — `progress-guard` y extracción | Pendiente |
| 2 — Integración en el runner y presupuesto | Pendiente |
| 3 — Selector en `shadow` + override | Pendiente |
| 4 — Coordination cost | Pendiente |
| 5 — Contrato de resultado del hijo | Pendiente |
| 6 — `delegation.minScope` | Pendiente |
| 7 — Puerta, documentación y cierre | Pendiente |

Estado del documento: **Borrador** (2026-10-13). Nada de lo descrito está implementado.
