# Especificación Técnica: Model Tier Router (enrutado experimental de perfil de modelo, opt-in)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | **NO implementada. No se ejecuta hasta que el propietario lo ordene** |
| Fecha | 2026-10-03 |
| Paquetes afectados | `@alisio/sdk` (evento `model_tier_routed`, ampliación de `summarizeDecisionEvents`), `@alisio/core` (`packages/core/src/routing/model-tier*.ts`, `RunOptions.modelOverride`, gancho en `AgentRunner`, config `modelTiers` y `decisions.routing.modelTier`, `/stats` y `/decisions`), `@alisio/web` (privado: estadísticas y etiquetas), `@alisio/alisio-code` (TUI: estadísticas) |
| Paquetes nuevos | Ninguno |
| Relación con otras especificaciones | Depende de `specs/alisio-decision-intelligence-v1.md` (0.3.0) y reutiliza el sub-bloque `decisions.routing` y el patrón de `specs/alisio-capability-routing-v1.md` (0.5.0). **Solo empieza tras registrar el benchmark de 0.5.0.** Arnés: `specs/alisio-smart-dashboard-v1.md` (`scripts/bench/lib.ts`, creado en la especificación de Smart Dashboard) |
| Superficies | Web, TUI y headless |
| Política de versión | Funcionalidad nueva, **experimental y opt-in**: **la siguiente minor en el momento de ejecución; esperada 0.6.0**. Desactivada por defecto; excluida de los valores por defecto hasta que el benchmark la justifique |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. TDD estricto, pruebas en `tests/*.test.ts` (vitest) en los límites de módulo, sin instantáneas que repitan la implementación.
2. **(verificado)** = abrí el archivo el 2026-10-03; **(no verificado)** = deducido o externo; **(nuevo)** = no existe.
3. **La Fase 0 es obligatoria y puede cancelar esta especificación** (§12.1): si cambiar de modelo entre ejecuciones de una misma sesión no conserva datos de continuación válidos, no se implementa nada más. Cada fase deja el repo verde (`pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`). Sin commit hasta que lo pida el propietario.
4. Reglas del repo: solo pnpm; Node >=22.16 y Bun; solo APIs portables; sin SDK de proveedor en SDK/core; plugins solo dependen de `@alisio/sdk`; **preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión persistida**; un manifiesto de plugin o un subproceso no es un sandbox.
5. Idioma: identificadores, claves y UI en inglés (más ES); esta especificación en español.
6. Aditivo y apagado por defecto: con los valores por defecto el comportamiento es idéntico al de 0.5.0.
7. Las decisiones del propietario (O1..O8, §2.1) se aplican exactamente; las de diseño (D1..D14, §2.2) las tomó esta especificación y son vinculantes. Lo único que depende de resultados experimentales es lo marcado como dependiente de la Fase 0 (§12.1).

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

Reducir el coste de las ejecuciones simples sin cambiar la experiencia de las difíciles: el motor de decisiones **no elige un modelo**, elige un **perfil** (`fast`, `standard`, `deep`) a partir de la tarea; **Alisio** decide qué modelo representa cada perfil (configuración del usuario). Sin proveedor, con perfil no configurado o con baja confianza se usa **el modelo de la sesión**. Puede sorprender al usuario, por eso es **opt-in** y de dos pasos (`suggest` informa; `on` aplica).

Principio rector: el LLM razona; el motor de decisiones clasifica la dificultad; el código determinista mapea perfil → modelo y no toca permisos.

### 1.2 Mapa de entregas (idéntico en las cuatro especificaciones)

| Orden | Entrega | Versión | Plan fuente |
|---|---|---|---|
| 1 | Decision Intelligence (contrato, servicio, observabilidad) | core 0.3.0 | Fases 1-3 |
| 2 | `@alisio/plugin-laya` (repo alisio-plugins) | plugin 0.1.0, peer sdk >=0.3.0 <0.7.0 | Fase 4 (§11, §15) |
| 3 | Smart Dashboard Composer + benchmark A/B/C | core 0.4.0 | Fases 0, 5-13 |
| 4 | Adaptive Capability Routing (tools + MCP) | core 0.5.0 | Fases 14-17 |
| 5 | Model Tier Router (experimental, opt-in) | core 0.6.0 | Fases 18-19 |

El «Release 1» del plan = entregas 1+2+3. Se divide porque los plugins viven en otro repositorio y solo compilan contra un SDK **publicado**. Smart Dashboard funciona sin proveedor, así que 0.4.0 no se bloquea por Laya; solo la variante C de su benchmark lo necesita. Cada entrega posterior está condicionada: 0.5.0 empieza solo si la variante B del benchmark de 0.4.0 cumple la puerta de dashboards (≥ 50 % menos tokens de salida, ≥ 40 % menos turnos LLM frente a A, 100 % de specs válidos, 0 avisos de lint); 0.6.0 solo tras el de 0.5.0. Si se publica un parche entre medias las minors se desplazan: los números son «la siguiente minor al ejecutar», esperados los de la tabla.

### 1.3 Alcance

Config `modelTiers` y `decisions.routing.modelTier`, pack `model-tier-v1` con tabla determinista, anulación de modelo **por ejecución** sin persistir `session.model`, evento `model_tier_routed`, estadísticas, benchmark y documentación explícita de su carácter experimental.

### 1.4 Fuera de alcance (las cuatro especificaciones)

| Excluido | Motivo |
|---|---|
| Fine-tuning de modelos de decisión | No necesario. |
| Plugin Jev | Release posterior. |
| Cascadas multi-proveedor | Un solo proveedor de decisiones activo. |
| Router de agentes | Riesgo de coste y latencia. |
| Poda probabilística de contexto | Riesgo de ocultar contexto necesario. |
| Router de skills | La revelación progresiva ya limita el coste. |
| Decisiones de permisos | Nunca se concede un permiso por una decisión probabilística. |
| Router universal de prompts | No se infiere una decisión por mensaje fuera de este caso acotado. |

Fuera de alcance solo de esta entrega: cambiar de modelo **a mitad de una ejecución o de una llamada a herramienta**, migrar una sesión entera sin indicación del usuario, cambiar subagentes o sesiones hijas, enrutado entre **proveedores/perfiles distintos** (salvo que la Fase 0 pruebe que es seguro, §D5), tablas de precios incorporadas.

---

## 2. Decisiones

### 2.1 Decisiones del propietario (confirmadas el 2026-10-03; aplicar exactamente)

| # | Decisión |
|---|---|
| O1 | **Empaquetado**: 0.6.0 es un release estable **separado** y solo empieza tras registrar el benchmark de 0.5.0 (`specs/alisio-capability-routing-v1.md`). La función es experimental y opt-in. |
| O2 | `@alisio/plugin-laya` es un plugin **externo** (`alisio-plugins`), nunca un integrado del core; defaults `model: "multilingual"`, `preload: true`. |
| O3 | **Una elección explícita del modelo por el usuario desactiva el enrutado en esa sesión** (D9). |
| O4 | **Umbrales de promoción fuera de «experimental»**: ≥ 30 % de ahorro de coste, caída de la tasa de éxito ≤ 2 puntos y ≥ 85 % de acierto de perfil en `suggest`. Si no se cumplen, la función **sigue experimental y `off`**. |
| O5 | **Benchmarks**: endpoint y modelo son parámetros por variables de entorno que entrega el propietario al ejecutar; todas las variantes de un benchmark usan el mismo modelo; el modelo y el *host* del endpoint se registran en el JSON (**nunca** la clave de API). Particularidad de esta entrega en §11. |
| O6 | **Alcance de configuración**: `modelTiers`, `decisions.routing.*`, `decisions.provider` y `decisions.telemetry` solo del config global; un proyecto (aunque tenga confianza) no puede fijarlos; se ignoran con diagnóstico (§8; mecanismo en `specs/alisio-decision-intelligence-v1.md` §8.2). |
| O7 | **Privacidad**: el `state` de los proveedores nunca lleva valores de datos; aquí solo el mensaje del usuario truncado (D12). |
| O8 | **Documentación**: una página por release; en 0.6.0, `docs/model-tiers.md` + `docs/es/model-tiers.md`. |

### 2.2 Decisiones de diseño de la especificación

| # | Decisión |
|---|---|
| D1 | **Configuración**: `modelTiers: { fast?, standard?, deep? }` (cada uno una referencia `provider/model` o id de modelo resuelta por el resolvedor existente) y `decisions.routing.modelTier: "off" \| "suggest" \| "on"`, por defecto `"off"`. Ambos **solo globales** (O6): se añaden a `GLOBAL_ONLY_ROOT` (`modelTiers`) y `GLOBAL_ONLY_DECISIONS` (`routing`) de `config.ts`. |
| D2 | **Resolvedor**: se reutiliza `resolveModel(reference)` de `createApplication` (`application.ts` ~l. 815), que delega en `resolveProviderModel(catalogs, input)` (`providers/routing.ts` l. 33): acepta `provider/model` canónico o un id único, y lanza si es ambiguo o el proveedor no está disponible. Un fallo se trata como «perfil no configurado». |
| D3 | **Decisión solo al inicio de la ejecución** (`session.model` se lee una vez por ejecución; verificado). Nunca a mitad de una ejecución, de un turno ni de una llamada a herramienta. |
| D4 | **Pack `model-tier-v1`**: `complexity` (`ordinal`), `needsDeepReasoning` (`boolean`), `needsLargeContext` (`boolean`), mapeado a un perfil por una **tabla determinista** (§6.2). El proveedor elige perfil; Alisio mapea perfil → modelo. |
| D5 | **Restricción de proveedor**: en la v1 solo se admiten perfiles cuyo modelo pertenece **al mismo proveedor y perfil de conexión que la sesión** (el runtime enlazado a la sesión), salvo que la Fase 0 demuestre que cambiar de proveedor conserva la continuación. |
| D6 | **Anulación por ejecución**: campo aditivo `RunOptions.modelOverride?: string` (id de modelo enviado al proveedor). **No** persiste `session.model`, **no** emite `model_changed` ni cambia nada a nivel de sesión. Evento nuevo `model_tier_routed`. |
| D7 | **Retrocesos al modelo de la sesión**: sin proveedor, perfil no configurado o no resoluble, baja confianza o **cualquier** respuesta rechazada/ausente, proveedor distinto (D5), ventana de contexto insuficiente (§6.3), objetivo `/goal` en reutilización fallida, o decisión en modo `suggest`. |
| D8 | **Subagentes y sesiones hijas no se tocan** (el enrutado se aplica solo a sesiones raíz); las llamadas explícitas a otro modelo de los subagentes (`task`, definiciones de agente) siguen igual. |
| D9 | **Implementación de O3**: cualquier `setModel` posterior a la creación (`/model`, `PATCH` de sesión, `--model` sobre sesión existente, modelo de una definición de agente activada) marca la sesión como «modelo fijado» hasta que termine el proceso (en memoria; ADR-5). |
| D10 | **Modos**: `suggest` calcula y **solo informa** del perfil que elegiría (evento con `applied: false`); `on` aplica la anulación. |
| D11 | **Experimental y gobernada por la regla O4**: se documenta como experimental, no entra en valores por defecto y no se recomienda activar sin los resultados de §11; solo si el benchmark cumple O4 se retira la etiqueta «experimental» de la documentación (el valor por defecto del esquema sigue siendo `"off"`; cambiarlo exigiría una orden nueva del propietario). |
| D12 | **Privacidad** (O7): igual que `specs/alisio-capability-routing-v1.md` D12 (el mensaje del usuario truncado a 600 caracteres va al proveedor; solo global; se recomienda proveedor local). |
| D13 | **Compatibilidad** (el plugin Laya, externo, declara peer `>=0.3.0 <0.7.0`; 0.6.0 es la última minor cubierta): el contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás. |
| D14 | **Experimento de continuidad obligatorio** (§12.1 E1): si falla, esta entrega se cancela o se limita a modelos que lo soporten (lista blanca por proveedor/modo de API). |

---

## 3. Estado actual del código (verificado el 2026-10-03)

| Hecho | Dónde | Estado |
|---|---|---|
| `AgentRunner.run` lee `const model = session.model` **una vez** tras `store.get(sessionId)`; ese valor alimenta `run_started`, `contextWindow(model)`, `outputLimit(model)`, `effortLevels(model)`, la compactación automática y `provider.stream({ model })` en cada turno | `packages/core/src/core/runner.ts` (~l. 1111-1160, 1198-1203, 1247, 1284, 1374, 1416) | verificado |
| `setModel(sessionId, id)` persiste (`store.setModel`), limpia el contexto reportado y emite `model_changed {model, previous}`; lo llaman `/model` (`commands/catalog.ts`), `PATCH` de sesión (`server/routes/sessions.ts`), `--model` (`cli/main.ts`, `tui/app.ts`) y la activación de un agente con modelo (`server/host/agents.ts`) | `runner.ts` (~l. 509-517), `commands/catalog.ts` (l. 167) y los demás | verificado |
| Antes del enrutado se comprueba `session.provider !== provider.id` y se lanza «Session provider/workspace mismatch»: **la sesión está ligada a un proveedor**; `providerFor(session)` devuelve el runtime enlazado | `runner.ts` (~l. 1113), `application.ts` (~l. 870-905) | verificado |
| Cambiar de proveedor desde la UI crea **una sesión nueva** (`switchModel` → `createSession(reference)`), no cambia la existente; `setModel` solo cambia el id de modelo dentro del mismo proveedor | `application.ts` (~l. 1503-1575) | verificado |
| El runtime se crea por `${profile}\0${model.id}` (`runtimeFor`) y la sesión guarda `runtime.id` como `session.provider`; qué contiene `runtime.id` (¿incluye el perfil o el host?) | `application.ts` (~l. 826-857) | no verificado (E3) |
| `ModelProvider.stream({ model, ... })` recibe el modelo **por petición**; el proveedor OpenAI-compatible usa `request.model \|\| this.model` en chat y en Responses | `core/runner.ts` (~l. 1284), `plugin-openai-compatible/src/provider.ts` (l. 111, 208) | verificado |
| En modo Responses los mensajes de asistente guardan `providerData` (la salida cruda, con elementos de razonamiento y `include: ["reasoning.encrypted_content"]`, `store: false`) y se reenvían tal cual; si falta se lanza «Missing provider continuation data» | `sdk/src/index.ts` (l. 286), `plugin-openai-compatible/src/provider.ts` (~l. 203-215) | verificado |
| Que el contenido cifrado de razonamiento de un modelo sea válido para otro modelo del mismo proveedor | Documentación del proveedor | no verificado (E1 lo prueba; es el riesgo principal) |
| `RunOptions` no tiene campo de modelo; hay `toolFilter`, `optInTools`, `policy`, `instructions`, `maxTurns`, `reasoningEffort`, etc. | `core/runner.ts` (~l. 193-225) | verificado |
| `beginRun` registra `model: o.store.get(sessionId).model` **antes** de añadir el mensaje del usuario (la fila `runs` guardaría el modelo de la sesión, no el enrutado) | `core/runner.ts` (~l. 1102-1106) | verificado |
| `turn_completed` incluye `model` y `usage`; la TUI y la web ya acumulan los modelos usados (`stats.models`) | `sdk/src/index.ts`, `cli/src/tui/state.ts` (~l. 788), `web/src/store/stats.ts` | verificado |
| Que la TUI/web traten `run_started.model` como «modelo de la sesión» (p. ej. cambiando el selector) | `cli/src/tui/state.ts`, `web/src/store/*` | no verificado (E5) |
| Los subagentes eligen modelo por la entrada de `task`, la definición del agente o el padre (`sessions.create` con selector) | `plugin-subagents`, `sessions/children.ts` | verificado (parcial; ver §D8) |
| `resolveProviderModel`, `availableProviderModels` y `ConfiguredProviderCatalog` ya filtran por perfiles configurados con `/connect` | `providers/routing.ts` | verificado |
| Config: `.strict()` en raíz y bloques; `agents.effort` ajustable con `!clear`; la superposición de capas permite claves solo globales (precedente `analysis.runtime`) | `config.ts` | verificado |
| `tests/model-routing.test.ts` prueba referencias de modelo y enrutado por sesión (precedente de pruebas del resolvedor) | `tests/model-routing.test.ts` | verificado |
| No hay tabla de precios de modelos en el repositorio | búsqueda en `packages/*/src` | verificado |

---

## 4. Decisiones de arquitectura (ADR-lite)

### 4.1 ADR-1: perfil, no modelo

- **Contexto.** Que un clasificador pequeño nombre modelos concretos acopla el motor de decisiones a catálogos que cambian y a credenciales del usuario.
- **Decisión.** El proveedor responde sobre **dificultad** (tres decisiones cerradas); la tabla del core produce un perfil; `modelTiers` (del usuario) lo traduce a un modelo. Los tres perfiles son opcionales: un perfil sin modelo equivale a «usar el de la sesión».
- **Alternativas descartadas.** Un `select` con los modelos configurados (filtra nombres de modelos al proveedor y exige reentrenar al añadir uno); lógica heurística por longitud de mensaje (no captura dificultad).
- **Patrón.** Estrategia + tabla de mapeo determinista.

### 4.2 ADR-2: anulación por ejecución en el runner

- **Decisión.** La decisión se toma después de añadir el mensaje del usuario y **antes** de `run_started`, porque este evento lleva el modelo: el orden es (1) decidir, (2) `const model = options.modelOverride ?? routed?.model ?? session.model`, (3) `emit("run_started", { model })`. Todo lo que hoy depende de `model` (ventana de contexto, límite de salida, niveles de esfuerzo, compactación, `provider.stream`) sigue la anulación sin más cambios. `session.model` **no se escribe**.
- **Consecuencias.** Para que `/stats` y el benchmark sean veraces se **registra el modelo enrutado por ejecución** (decisión técnica cerrada). Hoy `beginRun` guarda el modelo de la sesión **antes** de decidir (verificado) y su rama de actualización solo cambia el modelo si la fila estaba en cola. Forma mínima y aditiva, **sin migración** (la columna `runs.model` ya existe, la inserta `beginRun`): (1) `SessionStore.setRunModel?(runId: string, model: string): void` opcional en `core/contracts.ts` (como `beginRun?`); (2) `SQLiteStore.setRunModel` = `UPDATE runs SET model=? WHERE id=?`; (3) el runner la llama justo tras decidir, solo cuando se aplica una anulación, con el modelo anulado. El manejador `stats` del core muestra «Models used» con los `runs.model` distintos; la TUI y la web ya usan `turn_completed.model`. Prueba: la fila `runs` de una ejecución enrutada guarda el modelo anulado y `sessions.model` queda intacto.
- **Alternativa descartada.** Llamar a `setModel` y revertir al final: persistiría el cambio ante un fallo o corte y emitiría `model_changed` (rompe la regla «no a nivel de sesión»).

### 4.3 ADR-3: restricción al mismo proveedor y perfil

- **Contexto.** Una sesión está ligada a un runtime de proveedor (verificado) y el producto ya trata el cambio de proveedor como **sesión nueva**; los datos de continuación (`providerData`) son específicos del proveedor/API.
- **Decisión.** En la v1 un perfil solo se aplica si su modelo resuelto pertenece al runtime enlazado a la sesión (misma conexión). La comprobación vive en un cierre de `application.ts`: `resolveModel(ref)` → `runtimeFor(target)` → comparar con `providerFor(session)` por identificador público del proveedor y por perfil (E3 fija el criterio exacto). Si no coincide, `reason: "cross_provider"` y modelo de la sesión.
- **Alternativa descartada.** Migrar la sesión a otro proveedor: exigiría traducir o descartar `providerData` (prohibido: «preservar datos de continuación»).

### 4.4 ADR-4: retroceso conservador ante cualquier duda

- **Decisión.** Cualquier clave rechazada o ausente → modelo de la sesión (la dirección peligrosa es **bajar** a un modelo débil con información incompleta). Un perfil superior al de la sesión tampoco se aplica si la ventana del modelo candidato es menor que el contexto ya usado (§6.3).

### 4.5 ADR-5: una elección explícita gana

- **Decisión (O3, confirmada).** Si el usuario eligió modelo (`setModel`), el enrutado se desactiva en esa sesión: la intención explícita prevalece. Se implementa con un conjunto en memoria `pinned: Set<sessionId>` alimentado por un gancho `RunnerOptions.onModelSet?`.
- **Alternativa descartada.** Persistir la marca (sobrevive a reinicios): se prefiere en memoria por simplicidad; es una limitación documentada (tras reiniciar y reanudar la sesión, el enrutado vuelve a poder actuar).

---

## 5. Contratos

### 5.1 SDK (aditivo) **(nuevo)**

```ts
// RunEventDataMap gains:
model_tier_routed: {
  mode: "suggest" | "on";
  tier: "fast" | "standard" | "deep" | null;   // null = no tier chosen
  applied: boolean;                            // true only in "on" and when the override was used
  model?: string;                              // reference of the chosen model (provider/model), when resolved
  sessionModel: string;                        // the model the session would have used
  reason?: "no_provider" | "low_confidence" | "decision_failed" | "tier_not_configured" | "tier_unresolvable"
         | "cross_provider" | "context_too_small" | "explicit_model" | "goal_reuse" | "same_model";
  confidenceMin?: number;
  latencyMs?: number;
  provider?: string;                           // decision provider id
};
// summarizeDecisionEvents (spec 1) gains `modelTier: { routed, applied, byTier: Record<string, number>, reasons: Record<string, number> }`.
```

### 5.2 Core **(nuevo)**

```ts
// RunOptions (core/runner.ts), additive:
/** Model id for THIS run only (never persisted). Callers must stay within the session's provider. */
modelOverride?: string;

// config.ts
modelTiers: z.object({ fast: ref.optional(), standard: ref.optional(), deep: ref.optional() }).strict().default({}),  // ref: z.string().trim().min(1).max(200)
decisions.routing.modelTier: z.enum(["off", "suggest", "on"]).default("off"),

// routing/model-tier.ts
export const MODEL_TIER_PACK = { id: "model-tier-v1", version: 1 } as const;
export type ModelTier = "fast" | "standard" | "deep";
export function buildTierRequest(input: { message: string; language?: string }): DecisionRequest;
export function tierFromAnswers(response: DecisionResponse | null): { tier: ModelTier } | { fallback: string };  // pure, table in §6.2
export class ModelTierRouter {
  constructor(deps: { decisions: DecisionService; config: () => { modelTier: "off" | "suggest" | "on"; tiers: Partial<Record<ModelTier, string>> };
                      resolve: (session: Session, reference: string) => Promise<{ id: string; reference: string; contextWindow?: number } | { reason: string }>;
                      usedTokens: (sessionId: string) => number });
  begin(input: { session: Session; runId: string; prompt: string; goalActive: boolean; emit: Emit }): Promise<{ model: string } | undefined>;
  pin(sessionId: string): void;       // explicit user model choice (D9)
  forget(sessionId: string): void;
}
// RunnerOptions: modelRouter?: ModelTierRouter;  onModelSet?(sessionId: string): void  (wired to router.pin)
```

---

## 6. Algoritmos

### 6.1 Pack `model-tier-v1`

| Clave | Tipo | Definición |
|---|---|---|
| `complexity` | `ordinal` | niveles `["trivial", "simple", "moderate", "complex", "very_complex"]` (5 ≤ 12); instrucción fija en inglés: «How complex is the user's request for an AI coding and analysis assistant?» |
| `needsDeepReasoning` | `boolean` | «Does the request require multi-step reasoning, careful debugging or design trade-offs?» |
| `needsLargeContext` | `boolean` | «Does the request require reading or reasoning over many files or long documents at once?» |

`state: { message: <≤ 600 caracteres> }` y `language` si se conoce. `request.id = "model-tier-v1"`. La petición es de **3 decisiones** (mucho menos que el tope de 16).

### 6.2 Tabla determinista respuesta → perfil

Orden `fast < standard < deep`. `tier = max(fromComplexity, fromReasoning, fromContext)` con:

| Respuesta | Perfil |
|---|---|
| `complexity ∈ {trivial, simple}` | `fast` |
| `complexity = moderate` | `standard` |
| `complexity ∈ {complex, very_complex}` | `deep` |
| `needsDeepReasoning = true` | `deep` (si es `false`: `fast`) |
| `needsLargeContext = true` | `standard` como mínimo (si es `false`: `fast`) |

Si **cualquiera** de las tres claves fue rechazada o falta, o `tryDecide` devolvió `null`: sin perfil → modelo de la sesión (ADR-4). Confianza insuficiente (por debajo de `decisions.minConfidence`, el core la rechaza) → `low_confidence`.

### 6.3 Aplicación

1. `modelTier = off` → nada (sin llamada, sin evento). `enabled=false` o sin proveedor → nada.
2. Sesión raíz sin `parentId`, no fijada (D9), no `goalActive` (con objetivo activo se reutiliza el perfil de la última decisión de la sesión sin llamar; si no hay, `reason: "goal_reuse"` y modelo de la sesión).
3. Decidir (§6.1-§6.2). Perfil → referencia en `modelTiers`; sin referencia → `tier_not_configured`.
4. `resolve(session, reference)`: `resolveModel` (D2) → mismo proveedor y conexión (D5) → si falla `tier_unresolvable`/`cross_provider`. Si el modelo resuelto es el de la sesión → `same_model`, sin cambios.
5. Ventana: si la ventana del candidato conocida (`contextWindow`) es menor que `usedTokens(session) × 1.25 + 4 000`, `context_too_small` → modelo de la sesión.
6. `suggest`: emitir `model_tier_routed` con `applied: false` y terminar. `on`: devolver `{ model }`; el runner lo usa (ADR-2) y emite `model_tier_routed` con `applied: true` **antes** de `run_started`.
7. Nunca se cambia el modelo dentro de la ejecución; el siguiente `run` decide de nuevo (con la salvedad de §9: oscilación).

---

## 7. Seguridad

| Amenaza | Mitigación |
|---|---|
| El enrutado cambia permisos o aprobaciones | No toca política, opt-in ni herramientas (el modelo no afecta a `allowed`); prueba de igualdad del conjunto permitido con `on` y `off` |
| El proyecto redirige a un modelo propio | `modelTiers` y `routing.modelTier` solo globales (D1); los perfiles solo resuelven modelos de conexiones `/connect` ya configuradas por el usuario |
| Fuga del mensaje al proveedor de decisiones | D12 (truncado, solo global, opt-in, documentado) |
| Corrupción de la continuación al cambiar de modelo | E1 obligatorio; restricción de proveedor (D5); en caso de fallo del proveedor tras un cambio, la ejecución falla como cualquier otra (`run_failed`) y la siguiente vuelve a decidir; se añade la lista blanca de la Fase 0 |
| Subir sin querer a un modelo caro | `suggest` previo; la referencia de `deep` la fija el usuario; el evento `model_tier_routed` registra cada aplicación |

---

## 8. Configuración

`modelTiers` (raíz) y `decisions.routing.modelTier` (sub-bloque de la especificación de enrutado de capacidades) son **solo globales** (O6): se sigue el precedente `GLOBAL_ONLY_ANALYSIS` de `config.ts` (l. 89) y su mecanismo `ignored` → `provenance.ignored` → `configDiagnostics` descritos en `specs/alisio-decision-intelligence-v1.md` §8.2. Un archivo de proyecto (aunque tenga confianza) o `--config` que contenga `modelTiers` o `decisions.routing` **no falla el arranque**: las claves se ignoran con diagnóstico y el bucle de capas conserva las del global (`continue` para la clave raíz `modelTiers`). Prueba en `model-tier-config.test.ts`. Claves ajustables en vivo: `decisions.routing.modelTier` (enum). `modelTiers.*` se edita por archivo de configuración (cadena libre validada al resolver; las etiquetas EN/ES de los ajustes se añaden si el propietario las quiere en el menú; propuesta: ajustables como cadenas con `!clear`). Ejemplo documentado:

```json
{
  "modelTiers": { "fast": "openai/gpt-small", "standard": "openai/gpt-default", "deep": "openai/gpt-reasoning" },
  "decisions": { "provider": "laya", "routing": { "modelTier": "suggest" } }
}
```

---

## 9. Observabilidad y experiencia

- `/stats` (core, TUI, web): línea «Model tiers» con ejecuciones enrutadas/aplicadas, reparto por perfil y razones de retroceso (vía `summarizeDecisionEvents`); `/decisions`: modo y últimos resultados.
- La web y la TUI muestran el modelo real de cada turno (`turn_completed.model`, ya acumulado en estadísticas); **no** cambian el selector de sesión (E5 lo verifica).
- **Oscilación y caché**: alternar `fast`/`deep` entre ejecuciones invalida la caché por modelo (cada modelo tiene su caché) y rompe `providerData` si E1 falla. La histéresis (no bajar de perfil mientras el historial supere N tokens) se incorpora o no según el resultado del experimento E2 de la Fase 0.

---

## 10. Archivos por paquete

| Paquete | Nuevo | Modificado |
|---|---|---|
| sdk | — | `src/index.ts` (`model_tier_routed`, `summarizeDecisionEvents`) |
| core | `src/routing/model-tier.ts` | `src/core/contracts.ts` y `src/runtime/store.ts` (`setRunModel?`), `src/core/runner.ts` (`RunOptions.modelOverride`, `RunnerOptions.modelRouter`/`onModelSet`, decisión antes de `run_started`), `src/application.ts` (cierre `resolve`, creación del router, `onModelSet`), `src/config.ts` (`modelTiers`, `decisions.routing.modelTier`, `GLOBAL_ONLY_ROOT`/`GLOBAL_ONLY_DECISIONS`), `src/commands/catalog.ts` (`/decisions`, «Models used» en `/stats`), `src/index.ts` |
| web / cli | — | estadísticas (`store/stats.ts`, `tui/state.ts`, `tui/app.ts`), etiquetas EN/ES |
| scripts | `scripts/bench-model-tier.ts` | `scripts/bench/lib.ts` |
| tests | `model-tier-pack.test.ts`, `model-tier-router.test.ts`, `model-tier-runner.test.ts`, `model-tier-security.test.ts`, `model-tier-config.test.ts` | `run-events-contract.test.ts`, `config-layers.test.ts` |
| docs | `docs/model-tiers.md`, `docs/es/model-tiers.md`, `docs/benchmark-model-tier.json` | `docs/.vitepress/config.ts`, `docs/{configuration,decision-intelligence,limitations}.md` + ES, `docs/implementation-status.md`, `scripts/docs-check.ts`, `CHANGELOG.md` |

---

## 11. Estrategia de pruebas y benchmark

| Nivel | Qué | Archivo |
|---|---|---|
| Pack/tabla | Cada combinación de §6.2 (puras); rechazos → sin perfil | `model-tier-pack.test.ts` |
| Router | `off` no llama; sin proveedor, baja confianza, perfil sin configurar, no resoluble, otro proveedor, ventana insuficiente, mismo modelo, sesión fijada, hija, objetivo activo → modelo de la sesión con el `reason` correcto; `suggest` no aplica | `model-tier-router.test.ts` |
| Runner | `on` usa el modelo anulado en `provider.stream` y en `run_started`; **`session.model` no cambia ni se emite `model_changed`**; `contextWindow`/límite de salida siguen al modelo anulado; la siguiente ejecución sin anulación vuelve al modelo de la sesión; IDs de llamada y `providerData` intactos tras la ejecución; **la fila `runs` guarda el modelo enrutado** (`setRunModel`) | `model-tier-runner.test.ts` |
| Seguridad | Conjunto permitido idéntico con `on`/`off`; `modelTiers` y el modo ignorados desde un proyecto; subagentes sin anulación | `model-tier-security.test.ts` |
| Config | Valores por defecto, `.strict()`, global-only con diagnóstico y sin fallo de arranque (proyecto de confianza y `--config`), ajuste en vivo | `model-tier-config.test.ts` |
| Contrato | Nuevo evento | `run-events-contract.test.ts` |

**Benchmark** (`scripts/bench-model-tier.ts`, manual, sobre `scripts/bench/lib.ts`): suite de ≈ 24 tareas de dificultad conocida (trivial → compleja) con comprobador automático; condiciones `off` (modelo de sesión), `suggest` (acierto del perfil frente a una etiqueta de dificultad hecha a mano) y `on`.

- **Parámetros (O5):** `ALISIO_BENCH_MODEL` (modelo de la sesión y perfil `standard`), `ALISIO_BENCH_BASE_URL`, y, por ser el objeto medido, `ALISIO_BENCH_MODEL_FAST` y `ALISIO_BENCH_MODEL_DEEP` (mismo proveedor y conexión, D5), más una tabla de precios por modelo entregada por el propietario (`ALISIO_BENCH_PRICES`, JSON con precio de entrada, entrada en caché y salida; no hay precios incorporados, verificado). Clave de API: mecanismo existente del proveedor, que el arnés no lee ni guarda.
- **Regla de modelo único:** `off` y `suggest` usan solo `ALISIO_BENCH_MODEL`; la condición `on` usa los tres modelos porque **es la variable medida** (la única excepción a «mismo modelo» de O5, por definición del benchmark; el modelo base y el endpoint son los mismos en todas las condiciones). El arnés comprueba contra `runs.model` y `turn_completed.model` que `off`/`suggest` no usaron otro modelo.
- **Registro:** el JSON lleva `model`, `modelFast`, `modelDeep` y `endpointHost` (solo `URL.host`; nunca la clave).
- **Métricas:** tasa de éxito por perfil, tokens por modelo (`runs.model` y `turn_completed.model` + `usage`), coste con la tabla de precios, cambios de modelo por sesión, `cachedInput` y acierto de perfil en `suggest`.
- **Regla de promoción (O4, confirmada):** se retira la etiqueta «experimental» solo si (a) el ahorro de coste de `on` frente a `off` es **≥ 30 %**, (b) la caída de la tasa de éxito es **≤ 2 puntos** y (c) el acierto de perfil en `suggest` es **≥ 85 %**. Si no, la función sigue experimental y `off`. El resultado (cumple / no cumple) se escribe en `docs/benchmark-model-tier.json` (excluido del sitio).

---

## 12. Plan por fases

### 12.1 Fase 0 — Experimentos (obligatoria; 2-3 días; puede cancelar la especificación)

| # | Experimento | Pasos | Resultado esperado / cómo cambia el diseño |
|---|---|---|---|
| E1 | Continuidad al cambiar de modelo | Con el proveedor configurado, en **modo chat y modo Responses**: sesión con historial que incluye llamadas a herramientas y (Responses) elementos de razonamiento cifrados; ejecutar la siguiente petición con **otro modelo del mismo proveedor** (`modelOverride` de prueba) | Si funciona: seguir. Si falla en Responses: restringir a modo chat o a una lista blanca, o cancelar. Si falla en ambos: **cancelar la especificación** |
| E2 | Caché al alternar | Medir `cachedInput` al alternar `fast`/`deep` en una sesión larga | Decide la histéresis (§9) y si la economía tiene sentido |
| E3 | Mismo proveedor y conexión | Inspeccionar `runtime.id`, `ResolvedProviderModel.profile/provider` y qué identifica la conexión de la sesión | Fija el criterio de D5/ADR-3 |
| E4 | Calidad del clasificador | Con el proveedor real, acierto de `complexity` frente a 40 tareas etiquetadas | Calibra la tabla (§6.2) y el umbral |
| E5 | Presentación | Ver cómo tratan la TUI y la web `run_started.model` cuando difiere del modelo de la sesión | Decide si hay que ajustar la presentación |
| E6 | Entre proveedores (opcional) | Intentar el mismo cambio entre dos perfiles/proveedores | Solo si E1 es limpio; podría relajar D5 |

**Entrega:** tabla confirmada por el propietario. Sin ese visto bueno no empieza la Fase 1.

### 12.2 Fase 1 — Configuración y resolución (S)
- **Entregables:** `modelTiers`, `decisions.routing.modelTier`, capas global-only, cierre `resolve`; pruebas de configuración.
- **Aceptación:** `model-tier-config` verde; `off` = 0.5.0.

### 12.3 Fase 2 — Pack, tabla y modo `suggest` (M)
- **Entregables:** `routing/model-tier.ts`, evento `model_tier_routed` (solo `applied: false`), `/stats` y `/decisions`.
- **Aceptación:** `model-tier-pack` y `-router` verdes; en `suggest` el modelo usado nunca cambia.

### 12.4 Fase 3 — Modo `on` y anulación por ejecución (L)
- **Entregables:** `RunOptions.modelOverride`, gancho en el runner (ADR-2), `onModelSet`/pin, reutilización con objetivo activo, ventana de contexto.
- **Aceptación:** `model-tier-runner` y `-security` verdes; `session.model` intacto; `providerData` y IDs de llamada intactos.

### 12.5 Fase 4 — Benchmark y decisión (M)
- **Entregables:** `bench-model-tier.ts`, `docs/benchmark-model-tier.json` (con `model`, `modelFast`, `modelDeep`, `endpointHost`).
- **Aceptación:** resultados registrados; la regla O4 queda evaluada en el JSON (cumple / no cumple) y fija si la documentación conserva o retira la etiqueta «experimental».

### 12.6 Fase 5 — Documentación, capturas y release (M)
- **Entregables:** `docs/model-tiers.md` + ES (marcada **experimental** mientras no se cumpla la regla O4, con avisos de coste, privacidad y límites), actualización de páginas y `docs/implementation-status.md` (en español), captura real con Playwright de `/stats` con la línea «Model tiers» (`docs/assets/web-ui/model_tiers_web_ui.webp`, proveedor falso con datos de ejemplo, < 150 KB, EN y ES con alt y pie; borrar temporales y `.playwright-mcp/`); bump manual de los 7 paquetes publicados (+ `packages/web` privado y raíz) a la siguiente minor (esperada 0.6.0); `CHANGELOG.md` en inglés (`### Added`: «Model tier router (experimental, off by default)»); `pnpm changelog:data`; gate completo verde; publicación según `.agents/skills/alisio-publish/SKILL.md`.
- **Compatibilidad con `alisio-plugins`:** el contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás; **ejecutar el *smoke test* de `plugin-laya` contra la versión candidata antes de publicar**; cualquier cambio incompatible exige avisar antes a `alisio-plugins` (el plugin declara peer `>=0.3.0 <0.7.0`; 0.6.0 es la última minor cubierta).

---

## 13. Definición de terminado y registro de riesgos

**Definición de terminado:** gate completo verde; pruebas primero; `off` equivale a 0.5.0; permisos intactos; continuación del proveedor intacta; paridad EN/ES; documentación marcada experimental; `docs/implementation-status.md` actualizado.

| Riesgo | Impacto | Cómo y cuándo se verifica |
|---|---|---|
| El cambio de modelo rompe `providerData` cifrado (Responses) | Fallos de ejecución o sesión inutilizable | **E1** (puede cancelar); lista blanca por modo de API |
| La caché por modelo se pierde al alternar | Sin ahorro real | E2 y coste del benchmark; histéresis |
| El criterio «mismo proveedor y conexión» es ambiguo (`runtime.id` sin verificar) | Aplicar un modelo de otra conexión | E3 antes de la Fase 1 |
| Clasificar «fácil» una tarea difícil (bajar a un modelo débil) | Peor calidad | Retroceso conservador (ADR-4), `suggest` previo, acierto de perfil ≥ 85 % (O4) |
| Sorpresa del usuario (coste o calidad distintos) | Desconfianza | Opt-in en dos pasos, evento por ejecución, documentación experimental |
| `runs.model` guardaría el modelo de la sesión | Estadísticas de ejecuciones imprecisas | `setRunModel` opcional y aditivo (ADR-2); prueba de que la fila guarda el modelo enrutado y `sessions.model` queda intacto |
| Elección explícita del usuario solo en memoria | Tras reiniciar y reanudar, el enrutado puede volver a actuar | Limitación documentada (ADR-5); no se persiste |
| Mensaje enviado al proveedor de decisiones | Privacidad | Solo global, truncado, documentado |
| Último minor cubierto por el peer del plugin (`<0.7.0`) | La siguiente minor exige subir el rango | Aviso a `alisio-plugins` antes de cualquier 0.7.0 |
| Sin tabla de precios en el repo | Benchmark de coste manual | El arnés recibe precios como parámetro |

## Apéndice. Fuentes (consultadas el 2026-10-03)

1. Plan de producto: `alisio-decision-intelligence-plan-1.md` (§33, §35, §36, §42).
2. Código del repositorio citado en §3 (leído el 2026-10-03).
3. Especificaciones hermanas: `specs/alisio-decision-intelligence-v1.md`, `specs/alisio-capability-routing-v1.md`, `specs/alisio-smart-dashboard-v1.md`; plugin Laya: `../alisio-plugins/specs/alisio-plugin-laya-v1.md`.
4. Compatibilidad del contenido de razonamiento cifrado entre modelos: documentación del proveedor — **no verificado** (E1).
5. Convención de formato: `specs/alisio-workspace-sources-v1.md`, `specs/archive/alisio-plan-diagrams-viewer-v1.md`.
