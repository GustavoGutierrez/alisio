# Especificación Técnica: Adaptive Capability Routing (familias de herramientas y espacios de nombres MCP)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | **En pausa.** No se ejecuta: la puerta de `specs/alisio-smart-dashboard-v1.md` §11.2 no se superó en 0.4.0 (decisión del propietario, 2026-10-03). Se reabre cuando una entrega posterior reduzca el uso de `python_run` tras `dashboard_generate` y el benchmark B cumpla la puerta. |
| Fecha | 2026-10-03 |
| Paquetes afectados | `@alisio/sdk` (`ToolDefinition.family?`, evento `capability_routed`, evento `capability_routing_checked`), `@alisio/core` (`packages/core/src/routing/*`, herramienta `tools_expand`, gancho en `AgentRunner`, familias de las herramientas integradas y de MCP, configuración `decisions.routing.tools`, `/stats` y `/decisions`), `@alisio/plugin-memory` y `@alisio/plugin-subagents` (declaran su familia), `@alisio/web` (privado: estadísticas), `@alisio/alisio-code` (TUI: estadísticas) |
| Paquetes nuevos | Ninguno |
| Relación con otras especificaciones | Depende **solo** de `specs/alisio-decision-intelligence-v1.md` (0.3.0 publicada); no depende de Laya en concreto. Reutiliza el arnés de benchmark de `specs/alisio-smart-dashboard-v1.md` (0.4.0) y **solo empieza si la variante B del benchmark de 0.4.0 cumple la puerta confirmada por el propietario** (≥ 50 % menos tokens de salida, ≥ 40 % menos turnos LLM frente a la variante A, 100 % de specs válidos, 0 avisos de `chart-lint`; ver `specs/alisio-smart-dashboard-v1.md` §11.2). Precede a `specs/alisio-model-tier-router-v1.md` (0.6.0) |
| Superficies | Web, TUI y headless (`alisio run --json` recibe los eventos nuevos) |
| Política de versión | Funcionalidad nueva y desactivada por defecto: **la siguiente minor en el momento de ejecución; esperada 0.5.0** |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. TDD estricto (pruebas en `tests/*.test.ts`, vitest, en los límites de módulo, sin instantáneas que repitan la implementación).
2. **(verificado)** = abrí el archivo el 2026-10-03; **(no verificado)** = deducido o externo; **(nuevo)** = no existe.
3. **Orden obligatorio**: Fase 0 (arnés de tareas, línea base «catálogo completo», experimentos) → el propietario confirma → Fases 1-8. Cada fase deja el repo verde (`pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`). Sin commit hasta que lo pida el propietario.
4. Reglas del repo: solo pnpm; Node >=22.16 y Bun; solo APIs portables de Node; ningún SDK de proveedor ni import específico de runtime en el SDK o en los contratos del core; los plugins dependen solo de `@alisio/sdk`; preservar IDs de llamadas a herramientas, continuación del proveedor y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
5. Idioma: identificadores, claves, eventos y UI en inglés (más traducción ES); esta especificación en español.
6. Todo es aditivo y **apagado por defecto** (`"off"`): con el valor por defecto el comportamiento es idéntico al de 0.4.0.
7. Las decisiones del propietario (O1..O7, §2.1) se aplican exactamente; las de diseño (D1..D19, §2.2) las tomó esta especificación y son vinculantes. Lo único que depende de resultados experimentales es lo marcado como dependiente de la Fase 0 (§12.1).

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

A medida que Alisio acumula plugins y servidores MCP, cada petición al modelo incluye los esquemas de todas las herramientas disponibles aunque la tarea solo necesite, por ejemplo, ficheros y git. Se busca **mostrar al modelo solo las familias de herramientas razonablemente relacionadas con la tarea**, con un camino de retroceso siempre seguro, para reducir tokens de esquema, ruido y errores de selección. Si el benchmark no muestra un ahorro material, **la función se queda desactivada por defecto**.

Principio rector: el LLM razona; el motor de decisiones **selecciona** un conjunto cerrado (qué familias necesita la tarea); el código determinista **ejecuta** la reducción y **nunca toca permisos**.

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

Metadatos de familia (`ToolDefinition.family?`), asignación a todas las herramientas integradas, derivación para plugins y MCP, enrutador que decide **una vez por ejecución** con un `boolean` por familia candidata, herramienta `tools_expand` para ampliar, modos `off | shadow | on`, evento y métricas, benchmark de tareas y documentación.

### 1.4 Fuera de alcance (las cuatro especificaciones)

| Excluido | Motivo |
|---|---|
| Fine-tuning de modelos de decisión | No necesario. |
| Plugin Jev | Release posterior. |
| Cascadas multi-proveedor | Un solo proveedor activo. |
| Router de agentes | Riesgo de coste y latencia. |
| Poda probabilística de contexto | Riesgo de ocultar contexto necesario. |
| Router de skills | La revelación progresiva ya limita el coste. |
| Decisiones de permisos | Nunca se concede un permiso por una decisión probabilística. |
| Router universal de prompts | No se infiere una decisión por mensaje. |

Fuera de alcance solo de esta entrega: enrutado por turno (§2 D3), enrutado de sesiones hijas (subagentes), abrir conexiones MCP, estrechar las llamadas anidadas de `execute`, cambiar el orden o el contenido de las herramientas, familias definidas por el usuario en la configuración.

---

## 2. Decisiones

### 2.1 Decisiones del propietario (confirmadas el 2026-10-03; aplicar exactamente)

| # | Decisión |
|---|---|
| O1 | **Empaquetado**: esta entrega (0.5.0) es un release estable **separado** de 0.3.0 y 0.4.0, y solo empieza si se cumple la puerta de 0.4.0 (O5). |
| O2 | `@alisio/plugin-laya` es un plugin **externo** (`alisio-plugins`), nunca un integrado del core; defaults `model: "multilingual"`, `preload: true`. El enrutador funciona con cualquier proveedor que soporte `boolean`. |
| O3 | **El Tool Router puede activarse por defecto SOLO si** el benchmark muestra (a) ≥ 20 % de reducción del **coste efectivo de entrada** (contando `cachedInput`) **y** (b) exclusión errónea ≤ 2 % de las ejecuciones en `shadow`. Si no, se publica `off`. Métricas secundarias (caída de la tasa de éxito, `tools_expand` por ejecución) se informan pero **no** son puerta. |
| O4 | **Benchmarks**: endpoint y modelo son parámetros que el propietario entrega por variables de entorno al ejecutar; **todas las variantes de un benchmark usan el mismo modelo**; el modelo y el *host* del endpoint se registran en el JSON de resultados (**nunca** la clave de API). |
| O5 | **Puerta de entrada** (desde 0.4.0): la variante B de Smart Dashboard debe lograr ≥ 50 % menos tokens de salida y ≥ 40 % menos turnos LLM que A, 100 % de specs válidos y 0 avisos de `chart-lint`. |
| O6 | **Alcance de configuración**: `decisions.routing.*` (y `decisions.provider`, `decisions.telemetry`, `modelTiers`) solo del config global; un proyecto, aunque tenga confianza, no puede fijarlos; se ignoran con diagnóstico (§8, mecanismo en `specs/alisio-decision-intelligence-v1.md` §8.2). |
| O7 | **Documentación**: una página por release; en 0.5.0, `docs/capability-routing.md` + ES. |

### 2.2 Decisiones de diseño de la especificación

| # | Decisión |
|---|---|
| D1 | **`ToolDefinition.family?: string`** (aditivo en el SDK). Las familias integradas son una **lista cerrada documentada** asignada a **todas** las herramientas integradas (tabla §6.1). Las herramientas de plugin sin familia usan `plugin:<pluginId>`; las de MCP reciben `mcp:<server>` automáticamente. Los plugins no integrados no pueden reclamar las familias reservadas. |
| D2 | **Una decisión por ejecución, al inicio, a partir del mensaje del usuario; nunca por turno.** Motivos (ADR-1): cambiar la lista de herramientas a mitad de la ejecución invalida el prefijo de caché del proveedor y puede dejar un historial que cita herramientas ya no ofrecidas (coherencia de IDs de llamada y continuación). |
| D3 | **Dentro de una ejecución el conjunto solo puede ampliarse**: la herramienta integrada mínima `tools_expand` permite al modelo pedir una familia por nombre; surte efecto **desde el turno siguiente** (nunca en el turno en curso). |
| D4 | **Una decisión `boolean` por familia candidata** (multietiqueta), no un `select`. Candidatas preseleccionadas de forma determinista: ≤ 12 familias más ≤ 8 espacios MCP. |
| D5 | **Bandas de confianza**: `high` → familias seleccionadas; `medium` → seleccionadas + adyacentes (tabla §6.3); `low`, sin proveedor o **cualquier rechazo/ambigüedad** → catálogo completo (comportamiento actual). |
| D6 | **Conjunto siempre activo** (decisión técnica cerrada: la familia de lectura `workspace-read` es siempre activa porque leer ficheros es el retroceso más barato y excluirla causa los peores fallos): herramientas de interacción y aprobación, herramientas opt-in de plan/objetivo, puente MCP, `tools_expand`, skills, `workspace-read` y todo lo que el ejecutor necesita (§6.2). El enrutador **solo estrecha** lo que `toolFilter`, `optInTools` y la política ya permiten; permisos y aprobaciones no se tocan y se aplican después. |
| D7 | **Enrutado de MCP = el mismo mecanismo** (familias `mcp:<server>`), restringido a servidores ya conectados y autorizados; **el enrutador nunca abre una conexión**. Una familia que no estaba entre las candidatas al decidir (p. ej. un servidor conectado a mitad de la ejecución) se muestra siempre. |
| D8 | **Modos**: `decisions.routing.tools: "off" \| "shadow" \| "on"`. El valor por defecto del esquema es `"off"` y **solo pasa a `"on"` si el benchmark cumple la regla O3** (§11.2); la regla se aplica mecánicamente en la Fase 7 y el resultado queda en `docs/benchmark-routing.json`. `shadow` calcula la selección, expone igualmente el catálogo completo y registra si **todas** las herramientas realmente usadas estaban dentro de la selección (mide la exclusión errónea sin riesgo). Sin proveedor el modo efectivo es siempre catálogo completo. |
| D9 | **Selección «pegajosa» de sesión que solo se amplía** (mitigación de la caché, ADR-2): las ejecuciones siguientes de la misma sesión empiezan con la unión de las selecciones anteriores; el orden de las herramientas es siempre el del registro. Las ejecuciones con un objetivo `/goal` activo (herramientas de objetivo opt-in) reutilizan la selección sin nueva decisión. |
| D10 | **Eventos aditivos** emitidos por el core: `capability_routed` (al inicio, solo metadatos) y `capability_routing_checked` (al final de la ejecución en `shadow`/`on`). `/stats` y `/decisions` muestran el ahorro y la tasa de exclusión errónea. |
| D11 | **Riesgo crítico analizado explícitamente** (§4.2): una lista de herramientas distinta entre ejecuciones de la misma sesión rompe la caché entre ejecuciones del prefijo de herramientas y puede **cancelar** el ahorro. La métrica de la puerta O3 es el **coste efectivo de entrada** `uncachedInput + w·cachedInput`, no los tokens crudos de esquema; el benchmark informa ambos. |
| D12 | **Privacidad**: el `state` enviado al proveedor contiene el mensaje del usuario (truncado a 600 caracteres) y, por familia candidata, un alias, el nombre y una descripción fija; nunca texto descriptivo de herramientas remotas. Como `decisions.routing.*` es solo global (O6), un repositorio no puede activarlo; se documenta que se recomienda un proveedor local. |
| D13 | **No se enruta** en sesiones hijas (subagentes: ya tienen su propio filtrado), ni en las llamadas anidadas de `execute`, ni se cambia el catálogo para `compact`/`side questions`. |
| D14 | **Rechazo en el ejecutor (modo `on`)**: una llamada a una herramienta fuera del conjunto actual se rechaza con un error que indica usar `tools_expand` (igual que `toolFilter`, verificado en `runner.ts` ~l. 699). En `shadow` nunca se rechaza. |
| D15 | **Configuración**: `decisions.routing: { tools: "off"\|"shadow"\|"on" }` se añade al bloque `decisions` (estricto, especificación 1) y a `GLOBAL_ONLY_DECISIONS` (§8); clave ajustable en vivo `decisions.routing.tools` con etiquetas EN/ES. La especificación 4 añade `modelTier` al mismo sub-bloque. |
| D16 | **Benchmark** con la biblioteca común `scripts/bench/lib.ts` (creada en `specs/alisio-smart-dashboard-v1.md`; aquí solo se reutiliza): suite de tareas × {catálogo completo, `shadow`, `on`}, parámetros y registro según O4, regla de default según O3 (§11.2). |
| D17 | **Familias de herramientas del core se asignan en su registro**; las de MCP en `McpConnector` (donde se registra `mcp_<server>_<tool>`); las de plugin por el anfitrión (`toolOwners`). Ninguna lista de familias vive en el enrutador salvo la tabla de adyacencia y de siempre-activas. |
| D18 | **Compatibilidad** (el plugin Laya, externo, declara peer `>=0.3.0 <0.7.0`): el contrato de decisiones (`api.decisions`, `ToolContext.decisions`) y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás. Esta entrega añade solo `ToolDefinition.family?` y dos eventos. |
| D19 | **Plugin de decisiones agnóstico**: el enrutador usa `ToolContext`-independiente `DecisionService` (spec 1) y es válido con cualquier proveedor que soporte `boolean`; sin la capacidad `boolean` el proveedor no se llama (`unsupported`) y se usa el catálogo completo. |

---

## 3. Estado actual del código (verificado el 2026-10-03)

| Hecho | Dónde | Estado |
|---|---|---|
| `ToolDefinition { name, description, inputSchema, effect?, concurrent?, paths?, capability?, execute }`: **sin campo de familia ni categoría** | `packages/sdk/src/index.ts` (~l. 444) | verificado |
| `ToolRegistry` es un `Map` en orden de inserción; `list()` devuelve ese orden; no tiene familias | `packages/core/src/core/registry.ts` | verificado |
| `AgentRunner.availableTools(run, sessionId)` filtra `registry.list()` por `RunOptions.toolFilter`, `optInAllows(...)` y política (`allowed`, capacidades, aprobaciones); el resultado va a `provider.stream({ tools })` en cada turno (`this.availableTools(options, sessionId)` ~l. 1171) | `core/runner.ts` (~l. 379-392, 1171, 1281) | verificado |
| El ejecutor repite el filtro: una llamada fuera de `toolFilter` u opt-in lanza «Tool X is not available in this session» | `core/runner.ts` (~l. 697-702) | verificado |
| `toolFilter` es por ejecución y solo estrecha (los hijos lo usan: `ChildSessions.filter`) | `core/runner.ts` (`RunOptions`), `sessions/children.ts` (~l. 101-118, 192) | verificado |
| `OPT_IN_TOOLS = {exit_plan, get_goal, update_goal}`; una ejecución con objetivo activo añade las herramientas de objetivo a `optInTools` (`goalTools`) | `core/opt-in.ts`, `server/src/host/sessions.ts` (~l. 196), `cli/src/tui/app.ts` (~l. 1850) | verificado |
| `toolsText(tools)` y `estimateTokens` existen en el runner (`contextBudget` ya estima el coste del catálogo) | `core/runner.ts` (~l. 20, 427-440) | verificado |
| `session.model` se lee una vez por ejecución; el modelo/proveedor no cambia a mitad (relevante para la caché) | `core/runner.ts` (~l. 1115) | verificado |
| `tool_progress` y las demás herramientas reciben `ToolContext.runId` y `callId` | `core/runner.ts` (~l. 840-860) | verificado |
| Herramientas integradas (nombre → efecto): `read_file`, `list_files`, `search_text`, `git_status`, `git_diff`, `skill_load`, `skill_search`, `skill_resource`, `context_explain`, `ask_user_question`, `exit_plan` → `read`; `write_file`, `edit_file`, `artifact_export` → `write`; `run_process`, `shell`, `execute`, `bg_run`, `bg_list`, `bg_output`, `bg_stop`, `python_run` → `process`; `webfetch`, `websearch`, `herdr_*` (4), `mcp_connect`, `mcp_resource`, `mcp_prompt`, herramientas remotas MCP → `external`; `artifact_create`, `get_goal`, `update_goal`, `memory_*` (7), `task`, `task_status`, `task_wait`, `send_message` → `internal`; `data_inspect`, `data_query`, `artifact_list`, `artifact_read` → `read` | `tools/standard.ts`, `tools/background.ts`, `tools/analysis.ts`, `tools/data.ts`, `tools/artifacts.ts`, `tools/goal.ts`, `plan/exit-plan.ts`, `integrations/herdr.ts`, `mcp/connector.ts`, `plugin-memory/src/tools.ts`, `plugin-subagents/src/index.ts` | verificado |
| Herramientas remotas MCP: se registran **al conectar** como `mcp_<server>_<tool>` con efecto `external`; las tres de puente (`mcp_connect`, `mcp_resource`, `mcp_prompt`) se registran siempre; el conector conoce `registeredNames(server)` | `mcp/connector.ts` (~l. 76-100, 145-190, 394-422) | verificado |
| `PluginHost` guarda `toolOwners: Map<toolName, pluginId>` (privado) y los plugins no integrados registran sus herramientas con prefijo `pluginPrefix(id)_` y efecto `internal` degradado a `external` | `plugins/host.ts` (~l. 298-325) | verificado |
| `execute` (code mode) llama a cualquier herramienta del registro por nombre, sin pasar por `toolFilter`/opt-in salvo `OPT_IN_TOOLS`, y su contexto anidado no lleva `artifacts` ni `decisions` | `tools/execute.ts` (~l. 59-100) | verificado |
| La caché de proveedor: `Usage.cachedInput` se informa en `turn_completed`; las estadísticas ya lo agregan (`cacheHit`) | `sdk/src/index.ts`, `web/src/store/stats.ts` | verificado |
| Cómo cada proveedor cachea el prefijo (orden: instrucciones → herramientas → mensajes) y su política de invalidación | Documentación de proveedores | no verificado (la Fase 0 lo mide con el proveedor configurado) |
| `fixtures/mcp-server.ts` existe como servidor MCP de pruebas | `fixtures/mcp-server.ts` | verificado |
| `ModelProvider.stream({ tools })` recibe la lista de herramientas por petición | `core/runner.ts` (~l. 1281) | verificado |

---

## 4. Decisiones de arquitectura (ADR-lite)

### 4.1 ADR-1: una decisión por ejecución, solo ampliable

- **Contexto.** El plan habla de «por turno» pero cambiar herramientas entre turnos de una ejecución tiene dos costes: invalida el prefijo en caché del proveedor (las herramientas preceden a los mensajes) y puede dejar mensajes que citan herramientas que el modelo ya no ve (el historial conserva llamadas con sus IDs; la coherencia de continuación del proveedor exige que las herramientas citadas existan).
- **Decisión.** Decidir una sola vez, tras añadir el mensaje del usuario y antes del primer turno. Dentro de la ejecución el conjunto crece pero nunca decrece (`tools_expand`). Entre ejecuciones de una misma sesión, la selección pegajosa solo se amplía.
- **Alternativas descartadas.** (a) Por turno: caro y arriesgado, sin ventaja clara. (b) Decidir en cada ejecución de forma independiente: la lista oscilaría entre ejecuciones y destruiría la caché (ADR-2). (c) Una vez por sesión: pierde el ahorro de tareas distintas.
- **Consecuencias.** La primera ejecución de una sesión fija el suelo; una tarea posterior distinta amplía y paga una invalidación de caché por ampliación. El benchmark mide ese coste.
- **Patrón.** Decisión al inicio + Estrategia de conjunto monótono (solo se amplía).

### 4.2 ADR-2: riesgo de caché del prefijo de herramientas y mitigaciones

- **Hecho.** Con el catálogo completo, el prefijo (instrucciones + herramientas) es idéntico entre ejecuciones, así que el proveedor puede reutilizarlo (`cachedInput` > 0). Con enrutado, dos ejecuciones con listas distintas **no comparten prefijo**; la segunda paga todo el historial como entrada no cacheada. Con precios de entrada en caché inferiores (descuento dependiente del proveedor, **no verificado**), un ahorro de esquema de, por ejemplo, 3 000 tokens por petición puede ser menor que la pérdida de caché de un historial de 40 000 tokens.
- **Decisión.** (1) **Orden estable**: la lista filtrada conserva siempre el orden del registro (nunca reordenada por selección). (2) **Selección pegajosa que solo se amplía** (D9): las listas de ejecuciones sucesivas son una cadena creciente; solo cambia el prefijo al ampliar. (3) **Métrica de aceptación = coste efectivo de entrada**: `uncachedInput + w·cachedInput`, con `w` el peso de la entrada en caché (parámetro del benchmark `ALISIO_BENCH_CACHE_WEIGHT`, por defecto 0,1, registrado en el JSON); el benchmark informa también los tokens crudos de esquema y de salida, pero **la regla de activar por defecto (O3) usa el coste efectivo de entrada**. (4) Si no se cumple la regla O3, la función se publica `off`.
- **Alternativas consideradas.** Mantener la lista completa cuando la sesión ya tiene historial largo (política «no enrutar si hay caché caliente»): se deja como **experimento** (E4) porque quizá sea la mejor mitigación; no se implementa sin datos.
- **Consecuencias.** Este riesgo puede invalidar toda la función; por eso el modo `shadow` y la puerta del benchmark existen.

### 4.3 ADR-3: un `boolean` por familia (multietiqueta)

- **Decisión.** Una decisión `boolean` por familia candidata en lugar de un `select` sobre combinaciones. Una tarea suele necesitar varias familias a la vez; un `select` obligaría a enumerar combinaciones (explosión) o a elegir una sola.
- **Consecuencias.** Hasta 12 + 8 = 20 decisiones, por encima del tope del contrato de decisiones (**16**, spec 1 D5). Por eso las candidatas se **reparten en dos peticiones** como máximo (familias integradas/plugin ≤ 12; espacios MCP ≤ 8) y se ejecutan secuencialmente (cada una ≤ 16). Si cualquiera de las dos falla o rechaza alguna clave, la banda es `low`.
- **Alternativa descartada.** Subir el tope del contrato a 20: cambiaría un contrato ya publicado para un único consumidor.

### 4.4 ADR-4: el enrutador solo estrecha

- **Decisión.** El orden es: registro → `toolFilter` → opt-in → política/aprobaciones (todo existente, intacto) → **enrutado** → lista final. El enrutador recibe como candidatas solo las herramientas ya ofrecibles. Una herramienta oculta por el enrutador **no se puede llamar** (D14) pero la política sigue gobernando las demás sin cambios. Cero cambios de permisos y cero herramientas ejecutadas sin aprobación (criterio del plan §32).
- **Patrón.** Decorador de la lista de herramientas.

### 4.5 ADR-5: dónde se engancha

- **Decisión.** `AgentRunner.run` (`core/runner.ts` ~l. 1127-1170): después de `emit("run_started", …)` y antes del bucle de turnos, `const routing = await this.options.routing?.begin({ sessionId, runId, prompt, options, candidates: this.availableTools(options, sessionId) })`. `availableTools` gana un tercer parámetro opcional `routing?: RunRouting`; si está presente y el modo es `on`, filtra `routing.visible(tool)`. El ejecutor (`executeCall`, ~l. 697-702) aplica `routing.allows(tool)` con el error de D14. `tools_expand` actúa vía `router.expand(runId, family)`, indexado por `ToolContext.runId` (verificado). En `finally` de `run()`, antes de liberar la sesión, se emite `capability_routing_checked`.
- **Alternativas descartadas.** Un `toolFilter` nuevo en `RunOptions` por quien llama (obligaría a UI, servidor y CLI a cablearlo); modificar el registro (es compartido por sesiones y subagentes).

---

## 5. Contratos

### 5.1 SDK (`packages/sdk/src/index.ts`, aditivo) **(nuevo)**

```ts
export interface ToolDefinition {
  // ...existing fields unchanged...
  /**
   * Capability family used by adaptive routing (e.g. "git", "data"). Optional: plugin tools without
   * one belong to `plugin:<pluginId>`; remote MCP tools to `mcp:<server>`. Plugins cannot use the
   * reserved families of the core (the host replaces them with the default).
   * Format: `^[a-z][a-z0-9-]{0,31}(:[A-Za-z0-9._-]{1,64})?$`.
   */
  family?: string;
}

// RunEventDataMap gains (additive; schemaVersion stays 1):
capability_routed: {
  mode: "shadow" | "on";
  band: "high" | "medium" | "low" | "unavailable";   // "unavailable" = no provider / disabled / failure
  reason?: DecisionFallbackReason | "disabled" | "no_candidates" | "goal_reuse";
  families: string[];            // selected family ids (built-in names, plugin:<id>, mcp:<server>)
  catalogBefore: number;         // tools offerable before routing
  catalogAfter: number;          // tools actually offered (= before in shadow)
  selectedTools: number;         // tools inside the selection
  schemaTokensBefore: number;    // estimate (runner.toolsText + estimateTokens)
  schemaTokensAfter: number;     // estimate of the selected set (in shadow: what "on" would offer)
  provider?: string;
  latencyMs?: number;
  sticky: boolean;               // the selection was widened with the session's earlier selection
};
capability_routing_checked: {
  mode: "shadow" | "on";
  calledTools: number;
  outside: string[];             // tools called that were NOT in the selection (shadow) or rejected (on)
  expansions: string[];          // families requested with tools_expand
  insideSelection: boolean;      // calledTools all inside the selection
};
```

### 5.2 Core (`packages/core/src/routing/`) **(nuevo)**

```ts
// families.ts (pure)
export const ALWAYS_ON_FAMILIES: ReadonlySet<string>;          // §6.2
export const ADJACENCY: Readonly<Record<string, readonly string[]>>; // §6.3
export function familyOf(tool: ToolDefinition, owner?: string): string; // explicit family > mcp:<server> > plugin:<id> > "plugin:unknown"
export function candidatesOf(tools: ToolDefinition[], owner: (name: string) => string | undefined): CandidateFamily[]; // <=12 + <=8
// pack.ts (pure) — Decision Pack "capability-routing-v1" (spec 1, ADR-9)
export const CAPABILITY_ROUTING_PACK = { id: "capability-routing-v1", version: 1 } as const;
export function buildRoutingRequests(input: { message: string; candidates: CandidateFamily[]; language?: string }): { requests: DecisionRequest[]; aliases: Map<string, string> };
export function interpretRouting(responses: Array<DecisionResponse | null>, candidates: CandidateFamily[]): { band: "high" | "medium" | "low"; selected: Set<string>; reason?: string };
// router.ts
export class CapabilityRouter {
  constructor(deps: { decisions: DecisionService; config: () => DecisionsConfig["routing"]; ownerOf: (tool: string) => string | undefined; estimate: (tools: ToolDefinition[]) => number });
  begin(input: { sessionId: string; runId: string; prompt: string; goalActive: boolean; candidates: ToolDefinition[]; emit: Emit }): Promise<RunRouting | undefined>;
  expand(runId: string, family: string): { ok: true; added: string[] } | { ok: false; error: string };
  finish(runId: string, called: string[], emit: Emit): void;
  forgetSession(sessionId: string): void;
}
export interface RunRouting { visible(tool: ToolDefinition): boolean; allows(tool: ToolDefinition): boolean; /* shadow: always true */ }
// tools_expand (tools/routing.ts): effect "internal", family "core"
inputSchema: { family: string (enum filled with the candidate families at registration time is NOT used: free string validated at run time) }
```

---

## 6. Algoritmos y tablas

### 6.1 Familias de las herramientas integradas (lista cerrada; asignadas en el registro de cada herramienta)

| Familia | Herramientas | Siempre activa |
|---|---|---|
| `core` | `ask_user_question`, `skill_load`, `skill_search`, `skill_resource`, `context_explain`, `tools_expand` | sí |
| `workspace-read` | `read_file`, `list_files`, `search_text` | sí (decisión técnica cerrada: la lectura es el retroceso más barato y excluirla causa los peores fallos) |
| `workspace-write` | `write_file`, `edit_file` | no |
| `git` | `git_status`, `git_diff` | no |
| `process` | `run_process`, `shell`, `execute` | no |
| `web` | `webfetch`, `websearch` | no |
| `background` | `bg_run`, `bg_list`, `bg_output`, `bg_stop` | no |
| `data` | `data_inspect`, `data_query`, `dashboard_generate` | no |
| `analysis` | `python_run` | no |
| `artifacts` | `artifact_create`, `artifact_list`, `artifact_read`, `artifact_export` | no |
| `memory` | `memory_save`, `memory_search`, `memory_get`, `memory_context`, `memory_timeline`, `memory_pin`, `memory_forget` (declarada por `@alisio/plugin-memory`) | no |
| `subagents` | `task`, `task_status`, `task_wait`, `send_message` (declarada por `@alisio/plugin-subagents`) | no |
| `herdr` | `herdr_agents`, `herdr_read`, `herdr_prompt`, `herdr_wait` | no |
| `plan` | `exit_plan` (opt-in) | sí (sujeta a opt-in) |
| `goal` | `get_goal`, `update_goal` (opt-in) | sí (sujeta a opt-in) |
| `mcp-bridge` | `mcp_connect`, `mcp_resource`, `mcp_prompt` | sí |
| `plugin:<id>` | herramientas de plugins sin familia declarada | no |
| `mcp:<server>` | herramientas remotas `mcp_<server>_<tool>` (el conector fija la familia al registrar) | no |

Una prueba recorre `registry.list()` de una aplicación completa y falla si **alguna herramienta integrada queda sin familia** (también cubre herramientas nuevas futuras) o si una herramienta de plugin intenta una familia reservada (`core`, `workspace-read`, `plan`, `goal`, `mcp-bridge`).

### 6.2 Candidatas y siempre activas

1. Entrada: la lista ya filtrada por `toolFilter`, opt-in y política (`availableTools`).
2. Las familias siempre activas (tabla) nunca se ocultan.
3. **Candidatas**: las demás familias con ≥ 1 herramienta ofrecible. Tope **12** familias integradas/de plugin por prioridad determinista (orden de la tabla §6.1, luego `plugin:*` por número de herramientas descendente y por id) y **8** espacios `mcp:*` (orden alfabético). Las familias por encima del tope **nunca se ocultan** (conservador).
4. Una herramienta cuya familia no estaba entre las candidatas al decidir (registrada después) se muestra siempre.

### 6.3 Tabla de adyacencia (banda `medium`)

| Familia | Adyacentes |
|---|---|
| `workspace-write` | `git`, `process` |
| `git` | `workspace-write`, `process` |
| `process` | `workspace-write`, `background`, `git` |
| `background` | `process` |
| `data` | `analysis`, `artifacts` |
| `analysis` | `data`, `artifacts`, `workspace-write` |
| `artifacts` | `data`, `analysis`, `workspace-write` |
| `web` | `artifacts` |
| `memory`, `subagents`, `herdr` | (ninguna) |
| `plugin:*`, `mcp:*` | (ninguna) |

### 6.4 Pack `capability-routing-v1` y bandas

Para cada candidata, una decisión `boolean` con clave alias (`f1`..`f12`, `m1`..`m8`), `instruction` «Does completing the user's request likely require the tools of this capability family: <descripción fija de la familia>?», `trueMeaning` «needed», `falseMeaning` «not needed». `state`: `{ message: <≤ 600 caracteres>, families: [{ id, name, description }] }`; `language` = idioma detectado del mensaje si el contrato lo permite, si no ausente. Las descripciones de las familias de plugin y MCP son **fijas** («tools from the plugin <id>», «tools from the MCP server <name>»): nunca se envía el texto descriptivo remoto de una herramienta MCP (es dato no confiable).

Interpretación (en `interpretRouting`), con `confidence` según el contrato (spec 1, D18) y los umbrales `minConfidence` del core y `HIGH = 0.8` (constante del módulo, valor inicial que calibra E5):

| Condición | Banda | Conjunto |
|---|---|---|
| Sin respuesta (`null`), proveedor sin capacidad `boolean`, o **alguna** clave rechazada o ausente (`low_confidence`, `invalid`, `unsupported`, `missing`) en **cualquiera** de las peticiones | `low` | Catálogo completo (comportamiento actual) |
| Todas respondidas y todas con `confidence ≥ HIGH` | `high` | siempre-activas ∪ familias con `value = true` |
| Todas respondidas, alguna con `confidence ∈ [minConfidence, HIGH)` | `medium` | `high` ∪ adyacentes de las seleccionadas ∪ familias con `value = false` y `confidence < HIGH` |
| Ninguna candidata (sin plugins ni MCP ni familias opcionales) | — | No se llama (`reason: "no_candidates"`) |

Con `high` y todas las respuestas `false`, el conjunto es solo las siempre activas (tarea de pura conversación); el modelo puede pedir más con `tools_expand`.

### 6.5 `tools_expand`

Descripción corta (la guía vive en el catálogo): «Request more tools. Pass the family name (for example git, data, web, mcp:github). The tools become available from your next step.». Efecto `internal`, familia `core`. Entrada `{ family: string }`. Resultado: éxito con la lista de nombres de herramientas añadidas, o error «Unknown family; available: <lista>» (la lista de familias no seleccionadas ofrecibles). Solo amplía el conjunto de **esta ejecución** (y la selección pegajosa de la sesión); nunca añade herramientas que `toolFilter`, opt-in o política excluyen. Sin enrutado activo (modo `off` o catálogo completo) responde «All tools are already available» sin efecto. Para que el modelo conozca las familias, la descripción de la herramienta no lista nada (estática, cacheable); el mensaje de error y una nota breve añadida a las instrucciones del sistema cuando hay enrutado (`Some tools are hidden for this task; call tools_expand if you need a capability you do not see.`) lo cubren (**la nota es un cambio de prefijo por ejecución; se mide en E3**).

### 6.6 Selección pegajosa y orden

`Map<sessionId, Set<family>>` en memoria del router. Ejecución nueva: `selected = sticky ∪ nueva`; la nueva selección **no** se reduce nunca. Se olvida al borrar/cerrar la sesión (`/clear` crea sesión nueva). La lista visible = `registry.list()` filtrada por pertenencia (orden del registro).

---

## 7. Seguridad

| Amenaza | Mitigación |
|---|---|
| Que el enrutado conceda o altere permisos | El enrutado ocurre **después** de política y opt-in y solo estrecha (ADR-4); una prueba verifica que con `on`, `shadow` y `off` el conjunto de herramientas **permitidas** es el mismo y que ninguna herramienta que antes pedía aprobación deja de pedirla |
| Un plugin se declara de una familia reservada para forzar visibilidad o evitar el enrutado | El anfitrión sustituye familias reservadas por `plugin:<id>` para plugins no integrados |
| Ocultar `ask_user_question` o los mecanismos de aprobación | Siempre activas (§6.1/§6.2); prueba de que ninguna selección las oculta |
| Fuga del mensaje del usuario al proveedor de decisiones | D12 y O6: solo global; opt-in explícito (`shadow` también envía el mensaje); mensaje truncado a 600 caracteres; documentado; el core no persiste el `state` |
| Texto de herramientas MCP remotas (datos no confiables) usado como instrucción del proveedor | Nunca se envía; descripciones fijas por familia |
| El router abre conexiones MCP no autorizadas | No hay llamada alguna a `connect`; solo se leen las herramientas ya registradas (D7) |
| Denegación de servicio por llamadas al proveedor | Una decisión por ejecución, ≤ 2 peticiones, tiempo y disyuntor del core (spec 1) |
| Un modelo llama a una herramienta oculta (alucinación) | Rechazo con error que indica `tools_expand` (D14); registrado en `capability_routing_checked.outside` |

---

## 8. Configuración

```ts
// config.ts (extiende el bloque `decisions` de la especificación 1)
decisions: z.object({
  /* enabled, provider, timeoutMs, minConfidence, telemetry: see spec 1 */
  routing: z.object({
    tools: z.enum(["off", "shadow", "on"]).default("off"),
  }).strict().default(() => ({ tools: "off" })),
}).strict()
```

Alcance global-only (O6): se añade `"routing"` a `GLOBAL_ONLY_DECISIONS` (creada en `specs/alisio-decision-intelligence-v1.md` §8.2, que sigue el precedente `GLOBAL_ONLY_ANALYSIS` de `config.ts` l. 89 y el mecanismo `ignored` → `provenance.ignored` → `configDiagnostics`). Un archivo de proyecto (aunque tenga confianza) o `--config` que contenga `decisions.routing` **no falla el arranque**: la clave se ignora con el diagnóstico `decisions.routing`, y la rama `decisions` del bucle de capas conserva `routing` del global. Prueba en `routing-config.test.ts` y `config-layers.test.ts`. Clave ajustable en vivo: `decisions.routing.tools` (enum; etiquetas EN/ES obligatorias en `SETTING_LABELS`); `updateSetting` actualiza `config.decisions.routing` y el router lee el modo por función en cada `begin`. El valor por defecto del esquema es `"off"`, salvo que la Fase 7 aplique la regla O3 (§11.2) y lo cambie a `"on"`. Con `decisions.enabled = false` o sin proveedor, el modo efectivo es catálogo completo (`off`) (no se llama a nadie): `capability_routed` se emite solo en `shadow`/`on` con proveedor activo; sin él no hay evento (el catálogo completo es el comportamiento normal).

---

## 9. Observabilidad

- `/stats` (core, TUI, web) gana, si hubo ≥ 1 `capability_routed`, una línea «Capability routing» con: modo, ejecuciones enrutadas, banda (`high/medium/low/unavailable`), tokens de esquema antes → después (media y total), ahorro estimado, `tools_expand` usados y, en `shadow`, la tasa de exclusión errónea (`ejecuciones con insideSelection=false / ejecuciones`). Se implementa ampliando `summarizeDecisionEvents` del SDK con `routing` (misma semántica en las tres rutas, spec 1 ADR-6).
- `/decisions` añade el modo de enrutado y los últimos resultados.
- **Coste efectivo de entrada** (§4.2) se calcula en el benchmark, no en `/stats` (necesita el peso de la caché por proveedor); `/stats` muestra también `cachedInput` por ejecución ya existente para que el usuario vea el efecto.

---

## 10. Archivos por paquete

| Paquete | Nuevo | Modificado |
|---|---|---|
| sdk | — | `src/index.ts` (`ToolDefinition.family?`, eventos, ampliación de `summarizeDecisionEvents`) |
| core | `src/routing/{families,pack,router,index}.ts`, `src/tools/routing.ts` (`tools_expand`) | `src/core/runner.ts` (`availableTools` tercer parámetro, `RunnerOptions.routing?`, `begin`/`finish`, rechazo en el ejecutor, nota de instrucciones), `src/tools/{standard,background,analysis,data,artifacts}.ts`, `src/tools/goal.ts`, `src/plan/exit-plan.ts`, `src/integrations/herdr.ts` (`family` en cada registro), `src/mcp/connector.ts` (`family: mcp:<server>`, puente `mcp-bridge`), `src/plugins/host.ts` (`ownerOf(tool)`, normaliza familias de plugins), `src/application.ts` (crea el router, `updateSetting`), `src/config.ts` (§8), `src/index.ts` |
| plugin-memory / plugin-subagents | — | `src/tools.ts` / `src/index.ts` (`family: "memory"` / `"subagents"`) |
| server | — | Ninguno funcional |
| web | — | `src/store/stats.ts`, `src/components/stats/StatsLine.tsx`, `src/components/settings/labels.ts`, `src/i18n/{en,es}.ts` |
| cli | — | `src/tui/state.ts`, `src/tui/app.ts` (`statsReport`) |
| scripts | `scripts/bench-routing.ts` | — (reutiliza `scripts/bench/lib.ts`, creado en la especificación de Smart Dashboard) |
| tests | `routing-families.test.ts`, `routing-pack.test.ts`, `routing-router.test.ts`, `routing-runner.test.ts`, `routing-expand.test.ts`, `routing-security.test.ts`, `routing-config.test.ts`, `routing-stats.test.ts` | `run-events-contract.test.ts` (nuevos eventos), `config-layers.test.ts`, `registry.test.ts` |
| docs | `docs/capability-routing.md`, `docs/es/capability-routing.md`, `docs/assets/web-ui/capability_routing_web_ui.webp`, `docs/benchmark-routing.json` | `docs/.vitepress/config.ts`, `docs/{configuration,tools,plugins,limitations,decision-intelligence}.md` + ES, `docs/implementation-status.md`, `CHANGELOG.md`, `docs/.vitepress/config.ts` y `scripts/docs-check.ts` (`srcExclude` de `benchmark-routing.json`) |

---

## 11. Estrategia de pruebas y benchmark

### 11.1 Pruebas

| Nivel | Qué | Archivo |
|---|---|---|
| Familias | Toda herramienta integrada tiene familia; las reservadas no se pueden reclamar; `mcp:<server>` automático; `plugin:<id>` por defecto; formato de familia | `routing-families.test.ts` |
| Pack | Una decisión por candidata; alias; ≤ 16 por petición (dos peticiones si hace falta); `state` sin descripciones remotas MCP; mensaje truncado | `routing-pack.test.ts` |
| Bandas | Cada fila de §6.4 con el doble de proveedor de la especificación 1 (`ok`, `partial`, `lowConfidence`, `hang`, `throw`): cualquier rechazo/ambigüedad → `low` y catálogo completo; `medium` añade adyacentes | `routing-router.test.ts` |
| Runner | `off` = comportamiento idéntico (lista de herramientas por petición igual a la de 0.4.0); `shadow` expone el catálogo completo y emite el evento; `on` estrecha y conserva el orden; la herramienta ocultada se rechaza con el mensaje de `tools_expand`; el conjunto solo se amplía a mitad de ejecución y surte efecto en el turno siguiente; **IDs de llamada y continuación del proveedor intactos** (ejecución con historial que cita una herramienta ocultada después de ampliar) | `routing-runner.test.ts` |
| `tools_expand` | Familia válida/inexistente; no excede `toolFilter`, opt-in ni política; sin enrutado responde sin efecto | `routing-expand.test.ts` |
| Seguridad | El conjunto **permitido** es el mismo en `off/shadow/on`; ninguna aprobación se evita; las siempre-activas nunca se ocultan; sesiones hijas y `execute` no enrutadas; un plugin no reclama familias reservadas; el router no llama a `McpConnector.connect` | `routing-security.test.ts` |
| Pegajosa | Sesión con dos ejecuciones: la segunda empieza con la unión; el orden relativo es el del registro; `goal` activo reutiliza la selección sin llamar al proveedor | `routing-router.test.ts` |
| Config | Valor por defecto `"off"`, `.strict()`, global-only, ajuste en vivo, etiquetas EN/ES | `routing-config.test.ts` |
| Estadísticas | Las tres rutas coinciden; tasa de exclusión errónea en `shadow` | `routing-stats.test.ts` |
| Contrato | Nuevos eventos en `run-events-contract.test.ts` | ídem |

### 11.2 Benchmark `scripts/bench-routing.ts` (manual; fuera de `pnpm check`)

- **Suite:** ≈ 24 tareas deterministas en un repositorio git temporal generado en tiempo de ejecución (más un servidor MCP de `fixtures/mcp-server.ts` y un conjunto de plugins sintéticos con familias propias para simular catálogos grandes): edición de ficheros, git (estado/diff/commit local), ejecución de pruebas, búsqueda web simulada, análisis de datos, dashboard, memoria, subagentes, MCP, y conversación pura. Cada tarea tiene un comprobador automático (estado del repo, contenido de archivos, regex de la respuesta).
- **Condiciones:** `off` (catálogo completo), `shadow`, `on`; × tamaños de catálogo (integrado solo; +20 herramientas de plugin; +3 servidores MCP) × 3 repeticiones; además un escenario de **sesión larga** (10 ejecuciones seguidas de tareas distintas) para medir el efecto de caché.
- **Métricas** (derivadas de lo persistido): tokens de esquema antes/después (`capability_routed`), `input`, `output`, `cachedInput` por `turn_completed.usage`, **coste efectivo de entrada** (`uncachedInput + w·cachedInput`, `w` = `ALISIO_BENCH_CACHE_WEIGHT`, por defecto 0,1, registrado en el JSON), tasa de éxito de las tareas, `capability_routing_checked.outside` y tasa de exclusión errónea, número de `tools_expand`, llamadas a herramientas, tiempo total.
- **Parámetros y registro (O4):** `ALISIO_BENCH_MODEL`, `ALISIO_BENCH_BASE_URL` (y la clave por el mecanismo ya existente del proveedor, que el arnés no lee ni guarda); **mismo modelo en `off`, `shadow` y `on`** (comprobado contra `turn_completed.model`); el JSON registra `model` y `endpointHost`, nunca la clave.
- **Regla de activación por defecto (O3, confirmada):** el esquema se publica con `decisions.routing.tools = "on"` por defecto **solo si**, en el benchmark, (a) la condición `on` reduce **≥ 20 %** el coste efectivo de entrada frente a `off`, agregando la suite en el tamaño de catálogo grande (+20 herramientas de plugin y +3 servidores MCP) y el escenario de sesión larga, **y** (b) en `shadow` la exclusión errónea es **≤ 2 % de las ejecuciones** (ejecuciones con `capability_routing_checked.insideSelection = false` / ejecuciones de `shadow`, sobre todas las condiciones). Si cualquiera falla, se publica `"off"`. **Métricas secundarias informadas, sin puerta:** caída de la tasa de éxito, `tools_expand` por ejecución, tokens de salida y tiempo. Estructuralmente, el modo `on` sigue disponible como opt-in en ambos casos.
- Resultados en `docs/benchmark-routing.json` (excluido del sitio).

---

## 12. Plan por fases

### 12.1 Fase 0 — Arnés, línea base y experimentos (3-4 días)

Crear `scripts/bench-routing.ts` sobre la biblioteca común `scripts/bench/lib.ts` (ya existe desde 0.4.0; parámetros de entorno y registro de modelo y *host* según O4) y registrar la línea base `off`.

| # | Experimento | Pasos | Resultado esperado |
|---|---|---|---|
| E1 | Peso real del catálogo | Medir `estimateTokens(toolsText(...))` del catálogo integrado, con +20 herramientas de plugin y con 3 servidores MCP | Cuantifica el ahorro máximo posible; si el catálogo base es < 3 000 tokens, el beneficio probable es bajo y la especificación puede cancelarse |
| E2 | Comportamiento de la caché | Con el proveedor configurado, dos peticiones con el mismo historial y listas de herramientas distintas: medir `cachedInput` | Confirma cuánto del historial se pierde al cambiar la lista (si el proveedor no cachea, el riesgo desaparece) |
| E3 | Nota de instrucciones | Medir `cachedInput` con y sin la nota «tools hidden» en las instrucciones | Si invalida demasiado, quitar la nota y depender del mensaje de error |
| E4 | Política «no enrutar con caché caliente» | Simular una sesión larga con enrutado solo cuando el historial < N tokens | Decide si N es una mitigación necesaria |
| E5 | Calidad del proveedor | Con el proveedor real (Laya o el doble) medir exactitud por familia sobre las tareas | Calibra `HIGH` y la tabla de adyacencia |
| E6 | Selección del modelo | Medir cuántas veces el modelo usa `tools_expand` con la guía mínima | Ajusta la nota o la descripción |

**Entrega:** tabla de resultados confirmada por el propietario; sin ese visto bueno no empieza la Fase 1.

### 12.2 Fase 1 — Metadatos de familia (M)

- **Entregables:** `ToolDefinition.family?`; asignación a todas las herramientas integradas, plugins integrados, MCP y derivación para plugins; prueba de cobertura.
- **Aceptación:** `routing-families` verde; ningún cambio de comportamiento (`off`); `registry.test.ts` verde.
- **Docs:** ninguna aún.

### 12.3 Fase 2 — Router y modo `shadow` (L)

- **Entregables:** `routing/*`, config `decisions.routing.tools`, gancho en `AgentRunner` (solo `shadow`: calcula y registra, expone todo), eventos, `/stats` y `/decisions`.
- **Aceptación:** `routing-router`, `-runner` (modo `shadow`), `-config`, `-stats`, contrato de eventos verdes; con `shadow` la lista enviada al proveedor es **idéntica** a la de `off`.
- **Docs:** ninguna aún.

### 12.4 Fase 3 — Modo `on` y `tools_expand` (L)

- **Entregables:** filtrado efectivo, rechazo en el ejecutor, `tools_expand`, selección pegajosa, reutilización con objetivo activo, nota de instrucciones (según E3).
- **Aceptación:** `routing-runner` (modo `on`), `-expand`, `-security` verdes; el conjunto permitido es el mismo en los tres modos.

### 12.5 Fase 4 — Enrutado de MCP (M)

- **Entregables:** familias `mcp:<server>` en candidatas y banda; prueba con `fixtures/mcp-server.ts`; el router no abre conexiones.
- **Aceptación:** servidor conectado a mitad de ejecución se muestra siempre; servidor no conectado no aparece ni se conecta.

### 12.6 Fase 5 — Benchmark (M)

- **Entregables:** `bench-routing.ts` completo, resultados en `docs/benchmark-routing.json`, informe con coste efectivo de entrada y la evaluación de la regla O3.
- **Aceptación:** resultados registrados con `model` y `endpointHost`; el resultado de la regla O3 (cumple / no cumple) queda escrito en el JSON y fija el valor por defecto del esquema.

### 12.7 Fase 6 — Documentación y capturas (M)

- **Entregables:** `docs/capability-routing.md` + ES (qué hace, cómo activar, privacidad, límites, resultados del benchmark), actualización de `docs/{configuration,tools,plugins,limitations,decision-intelligence}.md` + ES, `docs/implementation-status.md` (en español), captura real con Playwright de `/stats` con la sección de enrutado en la web (`docs/assets/web-ui/capability_routing_web_ui.webp`, contra un `alisio serve` construido y un proveedor falso con datos de ejemplo; < 150 KB; EN y ES con texto alternativo y pie; borrar temporales y `.playwright-mcp/`).
- **Aceptación:** `pnpm docs:check` y `docs:build` verdes; paridad EN/ES.

### 12.8 Fase 7 — Release (S)

- **Entregables:** bump manual de los 7 paquetes publicados (+ `packages/web` privado y raíz) a la siguiente minor (esperada 0.5.0); `CHANGELOG.md` en inglés (`### Added`: «Adaptive capability routing: show the model only the tool families a task needs» y, según la regla O3, «on by default» u «off by default»); `pnpm changelog:data`; gate completo verde; publicación según `.agents/skills/alisio-publish/SKILL.md`.
- **Compatibilidad con `alisio-plugins`:** el contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás; **ejecutar el *smoke test* de `plugin-laya` contra la versión candidata antes de publicar**; cualquier cambio incompatible en esa superficie exige avisar antes a `alisio-plugins` (peer `>=0.3.0 <0.7.0`).

### 12.9 Fase 8 — Aplicación de la regla de activación

Sin decisión adicional del propietario: si el JSON de la Fase 5 marca «cumple» (O3), el esquema, `docs/capability-routing.md` y `docs/configuration.md` (+ ES) reflejan `"on"` por defecto; si marca «no cumple», `"off"` y la documentación lo presenta como opt-in. Se aplica antes del release de la Fase 7.

---

## 13. Definición de terminado y registro de riesgos

**Definición de terminado (por fase):** gate completo verde; pruebas primero; `off` equivale exactamente a 0.4.0; permisos intactos; paridad EN/ES; capturas reales; `docs/implementation-status.md` actualizado.

| Riesgo | Impacto | Cómo y cuándo se verifica |
|---|---|---|
| **Invalidación de la caché del prefijo de herramientas** cancela el ahorro | La función no aporta o cuesta más | E2/E3/E4 y el coste efectivo del benchmark; si no mejora, queda `off` (D11, ADR-2) |
| Catálogo base pequeño: poco que ahorrar | Entrega sin valor | E1 puede cancelar la especificación antes de la Fase 1 |
| Exclusión errónea (el modelo necesitaba una familia oculta) | Peor tasa de éxito, más turnos | Modo `shadow` mide sin riesgo; `tools_expand`; puerta O3: ≤ 2 % de las ejecuciones |
| Más de 16 decisiones en una petición | Rechazo por el contrato | Dos peticiones (ADR-3) y prueba del tope |
| Enviar el mensaje del usuario a un proveedor remoto | Privacidad | Solo global; opt-in; documentado; recomendación de proveedor local (D12) |
| Historial que cita herramientas ocultadas | Fallo de continuación del proveedor | Solo se amplía dentro de la ejecución; una herramienta ya usada permanece en el conjunto; prueba específica de IDs y continuación |
| Plugins/MCP con muchos servidores superan el tope de candidatas | Familias no enrutadas | Familias por encima del tope nunca se ocultan (conservador) |
| `execute` (code mode) llama a herramientas ocultas | Conjunto efectivo mayor que el ofrecido | Aceptado (D13): `execute` ya está gobernado por política; documentado |
| Ejecuciones de `/goal` con prompt sintético | Decisión sin sentido | Reutiliza la selección sin proveedor (D9); detección por herramientas de objetivo en `optInTools` (verificado) |
| Anotar familias en cada registro puede olvidarse en herramientas nuevas | Herramienta sin familia | Prueba de cobertura (§6.1) |
| Romper `api.decisions`/`api.paths`/`api.options` rompe el plugin Laya (peer `<0.7.0`) | Plugin roto | D18 y smoke test antes de publicar (§12.8) |
| El benchmark depende del modelo y del proveedor reales | No reproducible en CI | Manual por diseño; se registran entorno y parámetros |

## Apéndice. Fuentes (consultadas el 2026-10-03)

1. Plan de producto: `alisio-decision-intelligence-plan-1.md` (§29-§32, §35, §36, §42).
2. Código del repositorio citado en §3 (leído el 2026-10-03).
3. Cachés de prefijo de proveedores (orden instrucciones → herramientas → mensajes; descuento de entrada en caché): documentación de cada proveedor — **no verificado** (E2 lo mide en el entorno real).
4. Especificaciones hermanas: `specs/alisio-decision-intelligence-v1.md`, `specs/alisio-smart-dashboard-v1.md`; plugin Laya (solo como proveedor de ejemplo): `../alisio-plugins/specs/alisio-plugin-laya-v1.md`.
5. Convención de formato: `specs/alisio-workspace-sources-v1.md`, `specs/archive/alisio-plan-diagrams-viewer-v1.md`.
