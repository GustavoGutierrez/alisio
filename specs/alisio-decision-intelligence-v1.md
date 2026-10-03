# Especificación Técnica: Decision Intelligence (contrato de decisiones, servicio y observabilidad)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | **Implementada en 0.3.0** (2026-10-03). Fase 0 ejecutada contra Laya 0.3.24; resultados en §14.1.1. |
| Fecha | 2026-10-03 |
| Paquetes afectados | `@alisio/sdk` (tipos `DecisionProvider` y `DecisionProviderError`, `api.decisions?`, `api.paths?`, `api.options?`, `ToolContext.decisions?`, eventos, categoría `decisions`, helper puro `summarizeDecisionEvents`), `@alisio/core` (`packages/core/src/decisions/*`, config `decisions` y `pluginOverrides[id].options`, directorios por plugin, cierre acotado de plugins, comando `/decisions`, sección en `/stats`, eventos), `@alisio/server` (sin rutas nuevas; el comando viaja por `routes/commands.ts`), `@alisio/web` (privado: sección de decisiones en las estadísticas, etiquetas de ajustes), `@alisio/alisio-code` (CLI/TUI: `/decisions`, `statsReport`; `alisio run` gestiona SIGTERM/SIGHUP) |
| Paquetes nuevos | Ninguno en este repositorio. El primer adaptador (`@alisio/plugin-laya`) vive en el repositorio `alisio-plugins` (ver §10) |
| Relación con otras especificaciones | Primera de cuatro: `specs/alisio-smart-dashboard-v1.md` (0.4.0), `specs/alisio-capability-routing-v1.md` (0.5.0), `specs/alisio-model-tier-router-v1.md` (0.6.0). Plugin Laya: `../alisio-plugins/specs/alisio-plugin-laya-v1.md` (repositorio `alisio-plugins`; su §13 son los requisitos G1..G9 resueltos en §10 de este documento). Fuente de producto: `alisio-decision-intelligence-plan-1.md`. Convive con `specs/alisio-workspace-sources-v1.md` (migración v9 de esa especificación: esta no añade migraciones) |
| Superficies | Web, TUI y headless (`alisio run --json` recibe los eventos nuevos) con paridad funcional |
| Política de versión | Funcionalidad nueva: **la siguiente minor en el momento de ejecución; esperada 0.3.0** (reglas 0.x de `CHANGELOG.md`: una minor puede romper; esta no rompe nada). Todo es aditivo; `apiVersion` del plugin sigue en 1 |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. TDD estricto: la prueba que falla va primero, en `tests/*.test.ts` (vitest), probando comportamiento en los límites de módulo; sin pruebas de instantánea que repitan la implementación.
2. **(verificado)** = abrí el archivo y lo comprobé el 2026-10-03. **(no verificado)** = deducido o procedente de una fuente externa no confirmada en fuente primaria: compruébalo antes de apoyarte en ello. **(nuevo)** = no existe todavía.
3. Orden obligatorio: Fase 0 (experimentos desechables, §14.1) → el propietario confirma → Fases 1–6. Cada fase deja el repositorio verde (`pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`). No se hace commit hasta que lo pida el propietario.
4. Reglas de repositorio que esta especificación cumple y que no debes romper: solo pnpm; Node >=22.16 y debe funcionar en Bun (solo `node:fs`, `node:child_process`, `node:sqlite`, sin globales de Bun); ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del núcleo; los plugins dependen solo de `@alisio/sdk` (peer) y nunca importan el core; preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión persistida; **un manifiesto de plugin o un subproceso nunca es un sandbox**.
5. Idioma: identificadores, rutas, claves de configuración, eventos y textos de UI en inglés (con su traducción ES en `docs/es/` y en `packages/web/src/i18n/es.ts`); esta especificación en español.
6. Contratos aditivos: ningún evento, tipo, ruta ni columna existente cambia de semántica. Las uniones solo ganan variantes.
7. Las decisiones del propietario (O1..O5, §2.1) se aplican exactamente; las de diseño (D1..D26, §2.2) las tomó esta especificación y son vinculantes para la ejecución. Si el código real las contradice, está anotado en §3 y en el registro de riesgos (§15). Lo único que depende de resultados experimentales es lo marcado como dependiente de la Fase 0 (§14.1).

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

Dar a Alisio una capacidad **integrada, opcional, extensible, medible y segura** para resolver *decisiones cerradas* (elegir entre opciones conocidas, sí/no, nivel ordinal) sin gastar una generación completa del LLM, con un contrato de puertos y adaptadores: el core define el puerto `DecisionProvider`; los motores concretos (Laya primero) son plugins. **Alisio funciona igual sin ningún proveedor.**

Principio rector del plan: **el LLM genera y razona; el Decision Engine selecciona y clasifica; el código determinista ejecuta.** Esta entrega construye solo la infraestructura (contrato, servicio, configuración, observabilidad, packs). Los consumidores son las otras tres especificaciones.

### 1.2 Mapa de entregas (idéntico en las cuatro especificaciones)

| Orden | Entrega | Versión | Plan fuente |
|---|---|---|---|
| 1 | Decision Intelligence (contrato, servicio, observabilidad) | core 0.3.0 | Fases 1-3 |
| 2 | `@alisio/plugin-laya` (repo alisio-plugins) | plugin 0.1.0, peer sdk >=0.3.0 <0.7.0 | Fase 4 (§11, §15) |
| 3 | Smart Dashboard Composer + benchmark A/B/C | core 0.4.0 | Fases 0, 5-13 |
| 4 | Adaptive Capability Routing (tools + MCP) | core 0.5.0 | Fases 14-17 |
| 5 | Model Tier Router (experimental, opt-in) | core 0.6.0 | Fases 18-19 |

El «Release 1» del plan = entregas 1+2+3. Se divide porque los plugins viven en otro repositorio y solo pueden compilar contra un SDK **publicado**: el contrato debe salir primero (0.3.0). Smart Dashboard funciona sin proveedor por diseño, de modo que 0.4.0 no se bloquea por Laya; solo la variante C del benchmark necesita el plugin. Cada entrega posterior está condicionada: 0.5.0 empieza solo si la variante B del benchmark de 0.4.0 cumple la puerta de dashboards (≥ 50 % menos tokens de salida, ≥ 40 % menos turnos LLM frente a A, 100 % de specs válidos, 0 avisos de lint); 0.6.0 solo tras el de 0.5.0. Si entre medias se publica un parche, las minors se desplazan: los números son «la siguiente minor en el momento de ejecución», esperados los de la tabla.

### 1.3 Alcance de esta entrega

- Contrato SDK (`DecisionProvider`, `DecisionRequest`, respuestas, `api.decisions?`, `ToolContext.decisions?`).
- `DecisionService` con registro, validación **por decisión**, tiempo límite, disyuntor y métricas.
- Bloque de configuración `decisions` (estricto, con valor por defecto).
- Eventos `decision_completed` y `decision_fallback` (solo metadatos) y su lectura en `/stats` y `/decisions`.
- Concepto de **Decision Pack** (constructor tipado, versionado, agnóstico del proveedor, en código) y la regla de admisión de 7 preguntas como regla de contribución.
- Lo que el plugin Laya necesita del core (§10, G1..G9): directorios y opciones por plugin, ciclo de vida del proveedor, errores tipados, cierre acotado de plugins y exportación completa del SDK. Aplazado: cancelación/progreso en comandos (G3).

### 1.4 Fuera de alcance (las cuatro especificaciones)

| Excluido | Motivo |
|---|---|
| Fine-tuning de modelos de decisión | No hace falta para capturar el valor; añade datasets, ciclo de vida de checkpoints y mantenimiento. |
| Plugin Jev | Release posterior; debe poder añadirse sin cambiar core (es la prueba de la abstracción). |
| Cascadas multi-proveedor (Laya → Jev → LLM) | Un solo proveedor activo; cada feature define su propio fallback. |
| Router de agentes | Delegación equivocada aumenta coste y latencia; evaluar con datos reales. |
| Poda probabilística de contexto | El riesgo de ocultar contexto necesario supera el beneficio. |
| Router de skills | La revelación progresiva de skills ya limita su coste. |
| Decisiones de permisos | Una decisión probabilística **nunca** concede permisos. |
| Router universal de prompts | No se infiere una decisión en cada mensaje. |

Fuera de alcance solo de esta entrega: interfaz de administración de proveedores (`/decisions` es de solo lectura), carga de packs desde archivos o packs definidos por el usuario (YAGNI: los packs son código), instalación del runtime de Laya (es del plugin), siete páginas de documentación (§D16).

---

## 2. Decisiones

### 2.1 Decisiones del propietario (confirmadas el 2026-10-03; aplicar exactamente)

| # | Decisión |
|---|---|
| O1 | **Empaquetado**: 0.3.0 (Decision Intelligence) y 0.4.0 (Smart Dashboard) son releases estables **separados**. Esta entrega no contiene dashboards. |
| O2 | **`@alisio/plugin-laya` es un plugin externo** del repositorio `alisio-plugins`, **nunca un integrado del core** (no entra en `BUILTIN_PLUGINS` de `packages/cli/src/builtin.ts`). Valores por defecto del plugin: `model: "multilingual"`, `preload: true`. |
| O3 | **Privacidad**: el `state` que llega a un proveedor lleva solo el objetivo del usuario y metadatos de columnas (etiqueta, rol, tipo inferido, cubo de cardinalidad); **nunca** valores de celdas, valores frecuentes, mínimos/máximos ni muestras. El contrato (ADR-7) y las pruebas con cadenas centinela lo imponen. |
| O4 | **Documentación**: una página por release; en 0.3.0, `docs/decision-intelligence.md` + `docs/es/decision-intelligence.md`. |
| O5 | **Alcance de configuración**: `decisions.provider`, `decisions.telemetry`, `decisions.routing.*` y `modelTiers` se leen **solo** de la configuración global del usuario; un archivo de proyecto, aunque tenga confianza, no puede fijarlos. Mecanismo y comportamiento (ignorado con diagnóstico, sin fallo de arranque) en §8.2. |

### 2.2 Decisiones de diseño de la especificación

| # | Decisión |
|---|---|
| D1 | **Puertos y adaptadores.** `DecisionProvider` es un puerto en `@alisio/sdk`; los adaptadores son plugins. El core no nombra a ningún proveedor: una prueba busca `laya` y `jev` (insensible a mayúsculas) en `packages/core/src` y `packages/sdk/src` y falla si aparecen. |
| D2 | **Contrato SDK exacto** de §5.1. `api.decisions?` es un miembro opcional detectado por presencia (precedente `views?`). `apiVersion` sigue en 1. `ToolContext.decisions?` ofrece la misma superficie de consumo sin `registerProvider`, ligada por el core a la ejecución actual. |
| D3 | **Fallback por decisión.** El core valida cada respuesta por separado; la inválida, no soportada, ausente o bajo `minConfidence` se elimina de `decisions` y se lista en `rejected`. `tryDecide` devuelve `null` solo ante fallo de infraestructura (desactivado, sin proveedor, tiempo agotado, error de transporte, el proveedor lanzó o rechazó rápido con `DecisionProviderError` `not_ready`/`unavailable`, cancelación por el proveedor, disyuntor abierto) o cuando todas las respuestas fueron rechazadas. El consumidor aplica su fallback por clave. |
| D4 | Una **petición malformada** (límites superados, versión desconocida, `decisions` vacío) es un error de programación del consumidor: se lanza `DecisionRequestError` (subclase de `TypeError`), nunca se traga. Una cancelación iniciada por quien llama se propaga como cancelación. |
| D5 | **Límites de petición** aplicados por el core antes de llamar (G9): ≤ 16 decisiones con claves `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; ≤ 20 opciones por `select` con claves no vacías y únicas y descripciones no vacías; ≤ 12 niveles `ordinal` no vacíos y únicos; `state` serializado ≤ 16 KB **y** petición completa serializada (instrucciones y opciones incluidas) ≤ 32 KB. |
| D6 | **Un solo proveedor activo**, elegido solo por configuración (`decisions.provider`). Registrar no activa. Un id desconocido produce `available() === false` y un diagnóstico en `/decisions`, nunca un fallo de arranque. Sin cascadas. |
| D7 | **Bloque `decisions`** (estricto, con valor por defecto): `{ enabled: true, provider: null, timeoutMs: 1500 (50..10000), minConfidence: 0.6 (0..1), telemetry: true }`. `provider` y `telemetry` son solo globales (O5, §8.2). Claves ajustables en vivo: `decisions.enabled`, `decisions.provider`, `decisions.timeoutMs`, `decisions.minConfidence`, `decisions.telemetry`. |
| D8 | **Tiempo límite aplicado por el core** con `AbortSignal` (por defecto 1500 ms; fijado por la Fase 0: en CPU Laya tarda ≈ 80 ms por pregunta); un proveedor que ignore la señal no retrasa a quien llama (carrera con temporizador). |
| D9 | **Disyuntor** (G7): 3 fallos consecutivos de los que *cuentan* abren el circuito 30 s; después medio abierto con una sola sonda. **Cuentan** solo `timeout`, `invalid_response`, `internal` y los errores sin tipo (transporte o lanzados sin `DecisionProviderError`). **No cuentan** `not_ready` ni `unavailable` (ya fallan rápido): son fallback con `reason` registrado pero no abren el circuito. El core **nunca llama a `health()` en la ruta de `decide`**: solo `/decisions` (y su vista web) la llama, con su propio tiempo límite corto. El arranque en frío es trabajo del proveedor en segundo plano (`activate`). |
| D10 | **Eventos aditivos emitidos solo por el core**: `decision_completed` y `decision_fallback`. **No** hay `decision_started` (desviación deliberada del plan, ADR-3). Carga útil solo de metadatos; nunca `state`, instrucciones con datos, etiquetas derivadas de datos, prompts ni valores de columnas. `telemetry: false` desactiva la persistencia de estos eventos pero no las métricas en memoria. |
| D11 | Los eventos se emiten solo cuando la llamada ocurre dentro de una ejecución (vía `ToolContext.decisions`). Las llamadas por `api.decisions` fuera de una ejecución solo actualizan métricas. |
| D12 | **Sin proveedor activo, o con `enabled: false`, el servicio es un objeto nulo silencioso**: devuelve `null`, no registra métricas ni eventos (no hubo intento). Los fallbacks contabilizados son fallos reales de un proveedor activo. |
| D13 | **`/decisions`** (comando integrado, `execution: "core"`, todas las superficies), solo lectura: habilitado/deshabilitado, proveedor activo, salud, capacidades, métricas de la sesión y del proceso, último fallback, packs usados. **`/stats`** gana la sección «Decision Intelligence» en las tres rutas que pintan estadísticas (manejador del core, `statsReport` de la TUI, `computeStats` de la web), solo si hubo al menos una decisión, todas derivadas de la misma semántica de eventos (helper puro compartido, ADR-6). |
| D14 | Categoría de plugin `"decisions"` añadida a la unión del SDK y al enum zod del host. |
| D15 | **Decision Pack**: constructor tipado, versionado, agnóstico del proveedor, que produce un `DecisionRequest` con `pack: { id, version }`. Los packs son código (sin cargador de archivos). Se documenta la regla de admisión de 7 preguntas (plan §47) y el flujo de salvaguarda (plan §40) como regla de contribución en `CONTRIBUTING.md` y en la documentación. |
| D16 | **Una sola página de documentación** `docs/decision-intelligence.md` (+ ES) (O4): resumen, proveedores, packs, fallback y confianza. No el árbol de siete archivos del plan §44: el coste de mantener la paridad EN/ES por siete páginas no se justifica sin contenido. |
| D17 | Los requisitos G1..G9 de `alisio-plugins` (§13 de `../alisio-plugins/specs/alisio-plugin-laya-v1.md`) están **resueltos en §10** (decisión + motivo): se aceptan G1, G2, G4, G5 (con entregable), G6, G7, G8, G9; se difiere G3; se declina `DecisionProviderResult.meta`. |
| D18 | **Semántica de `DecisionAnswer.confidence`**: la mejor estimación del proveedor, en [0,1], de que la respuesta sea correcta; el core no asume que esté calibrada y `minConfidence` es un filtro heurístico (Fase 0, E2). Cada adaptador elige qué campo nativo la alimenta (el adaptador de Laya usa `answer_confidence`, no `confidence`, que es una entropía normalizada sin calibrar). `minConfidence` compara contra este campo. |
| D19 | **`api.paths?: { state: string; config: string; cache: string }`** (G1): directorios por plugin resueltos por el host, creados con `0700`, detectados por presencia (§10, ADR-10). |
| D20 | **`api.options?: Readonly<Record<string, JsonValue>>`** (G2): opciones de plugins externos desde `pluginOverrides[id].options` (global-only), `{}` si no hay, detectado por presencia. No existe ningún miembro de `PluginAPI` llamado `options` (verificado). |
| D21 | **Ganchos de ciclo de vida** `DecisionProvider.activate?()` / `deactivate?()` (G4), llamados por el core cuando el proveedor pasa a ser / deja de ser el activo; acotados por tiempo, fallos registrados y nunca fatales, nunca esperados en la ruta de arranque. |
| D22 | **`DecisionProviderError`** tipado con `code: "not_ready" \| "unavailable" \| "timeout" \| "invalid_response" \| "internal"` (G7). |
| D23 | **`DecisionRequest.language?: string`** (G6): pista BCP 47 opcional; los proveedores pueden ignorarla. |
| D24 | **Cierre acotado de plugins** (G5): `PluginHost.close()` acota cada `dispose()` con su propio tiempo límite y los ejecuta en paralelo; `alisio run` gestiona SIGTERM/SIGHUP. Entregable de 0.3.0 con pruebas (§10, ADR-12). |
| D25 | **Exportación completa** (G8): todos los tipos `Decision*` y `JsonValue` (ya exportado, verificado) salen de la raíz de `@alisio/sdk`. **El SDK 0.3.0 debe estar PUBLICADO antes de que empiece la implementación de `plugin-laya`.** |
| D26 | **Compatibilidad hacia atrás**: el plugin Laya declara peer `@alisio/sdk >=0.3.0 <0.7.0`. El contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás durante 0.4, 0.5 y 0.6. Valores por defecto confirmados por el propietario para el plugin: `model: "multilingual"`, `preload: true`. |

---

## 3. Estado actual del código (verificado el 2026-10-03)

| Hecho | Dónde | Estado |
|---|---|---|
| `Plugin { id, version, apiVersion: 1, name?, description?, categories?, extensions?, setup(api), dispose? }` | `packages/sdk/src/index.ts` (`interface Plugin`, ~l. 1333) | verificado |
| `PluginAPI` tiene `tools, commands, events.on, context, resources, state, compaction, session, model, models, providers.register, storage.sqlite, views?, extensions, sessions, ui`; `views?` es el precedente de miembro opcional detectado por presencia | `packages/sdk/src/index.ts` (~l. 1233-1276) | verificado |
| `PluginCategory` es una unión cerrada de 11 valores duplicada como `z.enum([...])` en `PluginHost.validate` | `packages/sdk/src/index.ts` (~l. 806), `packages/core/src/plugins/host.ts` (~l. 262) | verificado |
| `ToolContext { signal, workspace, emit, session?, label?, resolvePath?, runId?, callId?, emitEvent?, artifacts?, approveInstall? }`; `emit` pasa a `tool_progress` (efímero); `emitEvent` solo para `plan_proposed`/`plan_decided` | `packages/sdk/src/index.ts` (~l. 410), `packages/core/src/core/runner.ts` (~l. 851-862) | verificado |
| `RunEvent.schemaVersion: 1`; cargas tipadas en `RunEventDataMap`; efímeros: `text_delta`, `reasoning_delta`, `tool_progress`; los plugins solo observan (`events.on`) | `packages/sdk/src/index.ts` (~l. 466-680) | verificado |
| `tests/run-events-contract.test.ts` declara `contract: { [K in RunEventType]: Check }`: añadir un tipo al mapa obliga a enseñarle su carga a esa prueba | `tests/run-events-contract.test.ts` | verificado |
| El emisor del runner persiste los eventos no efímeros con `store.event(...)` (tabla `events`) y llama a `onEvent`; `application.ts` los reenvía a `plugins.emit` y a `options.onEvent` | `core/runner.ts` (`emitter`, ~l. 346), `application.ts` (~l. 1012) | verificado |
| Registros creados en `createApplication`: `ToolRegistry`, `ProviderRegistry`, `PluginHost` (`new PluginHost(registry, store, config.pluginHooks, providers)`); setters `plugins.setSessions/setModels/setCompleter` son el patrón para inyectar servicios | `packages/core/src/application.ts` (~l. 282-291), `plugins/host.ts` (~l. 123-209) | verificado |
| Los plugins no integrados envuelven `execute` y le quitan `artifacts` y `approveInstall` del contexto; el resto del contexto pasa | `plugins/host.ts` (~l. 298-318) | verificado |
| `ToolRegistry` no tiene concepto de familia ni de proveedor de decisiones | `core/registry.ts` | verificado |
| Config: `.strict()` en la raíz y en cada bloque; no existe clave `decisions`; `goal` es la plantilla de bloque estricto con valor por defecto | `packages/core/src/config.ts` (~l. 376-392) | verificado |
| Superposición de capas: una capa seleccionada reemplaza claves de primer nivel completas salvo casos especiales (`plugins`, `skills`, `pluginOverrides`, `builtinPlugins`, `analysis`, `tasks`, `mcp`); `analysis.runtime` y `tasks.retentionDays` son solo globales | `config.ts` (~l. 628-700) | verificado |
| Que la capa de proyecto solo se aplique con confianza explícita: se deduce de `trustProject`/`file` en `configFile` | `config.ts` (~l. 540-565) | no verificado (comprobar en `loadConfig` antes de apoyarse en ello) |
| Precedente global-only: `GLOBAL_ONLY_ANALYSIS` (l. 89), `ignored` calculado sobre el objeto crudo de la capa (l. 611-615), expuesto como `provenance.ignored` → `configDiagnostics` (`application.ts` l. 1128) e impreso por la CLI (`cli/src/main.ts` l. 442); una clave ignorada no falla el arranque | `config.ts`, `application.ts`, `cli/src/main.ts` | verificado |
| Claves ajustables: `SETTABLE_SECTIONS`/`SETTABLE_KEYS`; `settableSettings()` las enumera; `tests/web-i18n.test.ts` exige etiqueta EN y ES por clave en `SETTING_LABELS` | `config.ts` (~l. 846-930), `packages/web/src/components/settings/labels.ts` | verificado |
| `updateSetting` aplica en vivo con un `switch` por clave (precedente `goal.*`: `config.goal = {...}`) | `application.ts` (~l. 1310-1420) | verificado |
| `agents.effort` es ajustable y admite borrarse con el valor `!clear` (precedente para `decisions.provider`) | `config.ts` (l. 881), `commands/catalog.ts` (`effort`) | verificado |
| `stateHome()` = `ALISIO_STATE_HOME` o `$XDG_STATE_HOME/alisio` o `~/.local/state/alisio` | `config.ts` (~l. 535) | verificado |
| Comandos integrados: descriptores en `BUILTIN_COMMANDS`; manejadores `execution: "core"` en `CommandCatalog.execute` (`stats` incluido); el catálogo recibe la `Application` como host (`new CommandCatalog(app)`); la web los ejecuta en `routes/commands.ts` | `commands/builtins.ts`, `commands/catalog.ts`, `server/src/routes/commands.ts` | verificado |
| El manejador `stats` del core solo usa `store.runs` (tokens), no eventos | `commands/catalog.ts` (~l. 186) | verificado |
| La TUI pinta sus propias estadísticas con `statsReport()` a partir de `view.stats` derivado de eventos en `reduceEvent` | `packages/cli/src/tui/app.ts` (~l. 3199), `tui/state.ts` (~l. 765-1050) | verificado |
| La web calcula estadísticas con `computeStats(events)` y las pinta en `StatsLine` | `packages/web/src/store/stats.ts`, `components/stats/StatsLine.tsx` | verificado |
| `tests/command-catalog-tui-parity.test.ts` exige `COMMANDS` `toStrictEqual(LEGACY_COMMANDS)`: añadir `/decisions` obliga a añadirlo a esa lista de prueba | `tests/command-catalog-tui-parity.test.ts` (~l. 192) | verificado |
| Ejemplos de `Usage` con `cachedInput` en `turn_completed.usage` | `sdk/src/index.ts`, `web/src/store/stats.ts` | verificado |
| Plugins externos no reciben opciones (`pluginOverrides[id]` es `{enabled}` estricto) y la API no ofrece directorio de datos por plugin (solo `storage.sqlite(path)` con ruta libre y `state.get/set`) | `config.ts` (l. 122), `sdk/src/index.ts` (`PluginAPI`) | verificado |
| Los plugins integrados reciben `builtinPlugins.<id>` como opciones | `application.ts` (~l. 327-340), `packages/cli/src/builtin.ts` | verificado |
| `JsonValue` ya existe y se exporta desde la raíz del SDK (`export type JsonValue`) | `sdk/src/index.ts` (l. 341) | verificado |
| `CommandContext` solo tiene `sessionId?`; el manejador de comando es `(args, context?) => Promise<string>` y `CommandOptions` solo `description`/`argumentHint`: **sin `AbortSignal` ni sumidero de progreso** (G3) | `sdk/src/index.ts` (~l. 1192-1198, 1238) | verificado |
| `PluginHost.close()` hace `await plugin.dispose?.()` en orden inverso y **secuencial, sin tiempo límite por plugin**; `app.close()` lo mete en una etapa con tope global `TEARDOWN_STAGE_TIMEOUT_MS = 2_500` junto con el cierre del proveedor | `core/src/plugins/host.ts` (~l. 751), `application.ts` (~l. 76, 1590-1625) | verificado |
| `/exit` y Ctrl+C doble de la TUI llaman a `shutdown()` (topes `EXIT_PENDING_CAP_MS = 3000`, `EXIT_SESSION_END_CAP_MS = 1500`) y luego `app.close()`; `SIGTERM` y `SIGHUP` de la TUI ejecutan `shutdown()` | `cli/src/tui/exit.ts`, `tui/app.ts` (~l. 1888, 3810) | verificado |
| `alisio serve`: SIGINT/SIGTERM → `server.close()` y red de seguridad `process.exit(1)` a los 8 s; `WorkspaceHost.close` cierra cada `app` | `cli/src/serve.ts` (~l. 64-128), `server/src/host/workspace-host.ts` (~l. 212) | verificado |
| `alisio run` solo registra `SIGINT` (aborta el controlador y luego `app.close()` en `finally`); **no gestiona SIGTERM/SIGHUP**: un `kill` por defecto no ejecuta `dispose()` | `cli/src/main.ts` (~l. 186, 290-296) | verificado |
| Deshabilitar un plugin en caliente solo persiste la anulación (`status: "restart-required"`); `/reload` recarga agentes, skills, prompts, configuración y MCP, **no plugins**: `dispose()` no se llama en esos caminos, solo al cerrar | `application.ts` (~l. 1163-1210, 1456) | verificado |
| La raíz de estado de la aplicación es `dirname(options.db)` si se pasó `--db`, si no `stateHome()` (la usan análisis y artefactos); no existe `cacheHome` ni `XDG_CACHE_HOME` en el core | `application.ts` (~l. 498), búsqueda en `packages/*/src` | verificado |
| `setPluginEnabled` reescribe `raw.pluginOverrides[id] = { enabled }` (perdería cualquier `options`) | `config.ts` (~l. 1043-1048) | verificado |
| `pluginOverrides` se fusiona por clave en las capas (la capa seleccionada gana por id, entrada completa) | `config.ts` (~l. 653-660) | verificado |
| Ningún miembro de `PluginAPI` se llama `options` | `sdk/src/index.ts` (`PluginAPI`) | verificado |
| Versión actual de todos los paquetes: 0.2.1 | `package.json` raíz | verificado |
| API de Laya (`POST /v1/systemone`, tipos `choice`/`score`/`noul`, campos `confidence`, `answer_confidence`, `probabilities`, `abstention`, `min_confidence`, `laya[serve]`, límite ≈ 20 opciones por `choice`, enlace por defecto `0.0.0.0:8000`; cada punto de control pesa ≈ 0,64-0,84 GB; `device` admite también `mps`; `laya-ts` no está en npm; `confidence` es entropía normalizada sin calibrar y el adaptador debe usar `answer_confidence`) | https://github.com/NandhaKishorM/laya y §14 de `../alisio-plugins/specs/alisio-plugin-laya-v1.md` | **no verificado** (resumen de página externa y de la especificación hermana; la Fase 0 lo prueba con un servidor real) |

---

## 4. Decisiones de arquitectura (ADR-lite)

### 4.1 ADR-1: puerto en el SDK, adaptadores como plugins

- **Contexto.** Se quiere un motor de decisiones intercambiable (Laya hoy, Jev después) sin que el core dependa de ninguno.
- **Decisión.** `DecisionProvider` vive en `@alisio/sdk`; el core ofrece `DecisionService` y `DecisionRegistry`; el plugin registra su proveedor con `api.decisions?.registerProvider`. El vocabulario del contrato es de Alisio (`select`/`boolean`/`ordinal`), no el de Laya (`choice`/`noul`/`score`); el adaptador traduce.
- **Alternativas descartadas.** (a) Punto de extensión `extensions.register("decisions", …)`: el mapa `ExtensionPoints` está pensado para sustituir un comportamiento por *prioridad* (gana uno), y aquí además hay que listar, activar por configuración y exponer salud; un registro propio lo expresa mejor. (b) Que el core hable HTTP con Laya: acopla el core y su ciclo de despliegue al de Laya. (c) Contrato con los tipos de Laya: filtraría terminología y obligaría a Jev a imitarla.
- **Consecuencias.** El adaptador es responsable de la traducción y de su ciclo de vida. El core queda probable con un doble de prueba en memoria. La prueba «el core no menciona laya/jev» protege la frontera.
- **Patrón.** Puertos y adaptadores (hexagonal) + Registro.

### 4.2 ADR-2: fallback por decisión, no por petición

- **Contexto.** Una petición puede llevar varias decisiones; el proveedor puede acertar unas y fallar otras (baja confianza, tipo no soportado).
- **Decisión.** Validación independiente por clave; el resultado parcial es válido. `tryDecide` devuelve `null` solo ante fallo de infraestructura o rechazo total; si no, devuelve lo utilizable y `rejected` explica el resto. Cada consumidor completa lo que falta con su regla determinista.
- **Alternativas descartadas.** (a) Todo o nada: obliga a descartar respuestas buenas por una mala y complica el consumidor. (b) Reintentar las rechazadas con el LLM: reintroduce el coste que se quería evitar y rompe «el LLM no decide aquí».
- **Consecuencias.** El consumidor debe tener un valor por defecto para cada clave (lo exige la regla de admisión, pregunta 4). Las pruebas cubren combinaciones parciales.
- **Patrón.** Objeto nulo + Estrategia con sustitución por clave.

### 4.3 ADR-3: sin evento `decision_started`

- **Contexto.** El plan lista `decision_started`, `decision_completed`, `decision_fallback`.
- **Decisión.** Solo los dos últimos. Una llamada típica dura < 100 ms; un evento de inicio duplicaría el volumen persistido (cada evento es una fila SQLite y un frame SSE) sin valor diagnóstico: `latencyMs` ya está en el evento final y una llamada colgada la corta el tiempo límite. **Desviación consciente del plan.**
- **Alternativas descartadas.** Emitir `decision_started` efímero (no persistido): no aporta a `/stats` ni a la trayectoria, y obliga a UIs a manejar otro tipo.
- **Consecuencias.** No se puede pintar «decidiendo…» en la UI; si hiciera falta, la feature consumidora ya emite su propio `tool_progress`.
- **Patrón.** Observabilidad mínima suficiente (YAGNI).

### 4.4 ADR-4: disyuntor y tiempo límite en el core

- **Contexto.** Un proveedor local caído o lento no debe encarecer cada decisión.
- **Decisión.** El core fuerza el tiempo límite con `Promise.race` y `AbortSignal.any([opts.signal, AbortSignal.timeout(timeoutMs)])`; la promesa huérfana se atrapa con `.catch(() => {})`. El disyuntor cuenta solo los fallos que *cuestan tiempo o indican un proveedor roto*: `timeout`, `DecisionProviderError` con `invalid_response` o `internal`, y los errores sin tipo (transporte, excepciones ajenas). **No cuentan** los rechazos rápidos `DecisionProviderError` `not_ready`/`unavailable` (ya fallan rápido y un arranque en frío no debe abrir el circuito), ni los rechazos por decisión ni la baja confianza; esos son fallback con `reason` registrado. El core **no llama a `health()` en la ruta de `decide`** (añadiría latencia y otro modo de fallo): solo `/decisions` la llama. Estados: cerrado → abierto 30 s → medio abierto (una sonda; las llamadas concurrentes devuelven `circuit_open`). Se reinicia al cambiar de proveedor activo. El reloj es inyectable para pruebas.
- **Alternativas descartadas.** Reintentos automáticos (multiplican la latencia; el fallback ya es barato); delegar el tiempo límite al proveedor (no es fiable).
- **Consecuencias.** Una ráfaga de fallos hace que las siguientes 30 s sean instantáneas (`circuit_open`) y se contabilicen como fallbacks.
- **Patrón.** Circuit Breaker.

### 4.5 ADR-5: configuración como única vía de activación

- **Decisión.** Instalar un plugin no lo activa. `decisions.provider` nombra un id registrado; `null` desactiva. El id desconocido no falla el arranque: `/decisions` muestra «provider X not registered».
- **Alternativas descartadas.** Activación automática por el primer plugin que se registre (sorpresa y orden no determinista); varios proveedores con prioridad (cascadas, fuera de alcance).
- **Consecuencias.** El plugin Laya necesita decirle al usuario cómo activarlo (`decisions.provider = "laya"` en `/settings`, ver D7 y §10).

### 4.6 ADR-6: semántica única de estadísticas mediante un helper puro en el SDK

- **Contexto.** Tres rutas pintan estadísticas con código distinto (core: `store.runs`; TUI: reductor; web: `computeStats`).
- **Decisión.** Un helper puro `summarizeDecisionEvents(events: RunEvent[]): DecisionStats` en `@alisio/sdk` (precedente de código ejecutable en el SDK: `isEphemeralRunEventType`, `ViewParamsError`). Las tres rutas lo invocan. El manejador del core lo alimenta con `store.eventsPage(session)` filtrado por tipo (verificado: existe en `runtime/store.ts`).
- **Alternativas descartadas.** Reimplementarlo tres veces (deriva garantizada); ponerlo en core (la web no importa core).
- **Consecuencias.** El SDK gana ~40 líneas puras sin dependencias.

### 4.7 ADR-7: privacidad por construcción

- **Decisión (O3, confirmada por el propietario).** `DecisionResponse`, eventos y métricas nunca contienen `state`, instrucciones, etiquetas de opciones ni valores devueltos por el consumidor. `decisionId` es el `request.id`, que debe ser un identificador no sensible del sitio de llamada (p. ej. `smart-dashboard-v1`) validado con `^[a-z0-9][a-z0-9._-]{0,127}$`. El `state` solo sale del proceso si el adaptador lo decide: el contrato indica que **el proveedor puede ser remoto en el futuro**, así que los consumidores solo ponen en `state` lo mínimo (regla de admisión, §11).
- **Consecuencias.** Una prueba compara el JSON de los eventos persistidos con una lista de cadenas centinela sembradas en `state` y falla si aparecen.

### 4.8 ADR-8: `ToolContext.decisions` ligado a la ejecución

- **Decisión.** El runner recibe una fábrica `decisions?: (call) => ToolDecisions` análoga a la fábrica `artifacts` de `RunnerOptions`. Cada llamada de herramienta obtiene un envoltorio que invoca `DecisionService.attempt(req, opts, { sessionId })` y emite el evento correspondiente con el `emit` de la ejecución. Las llamadas anidadas de `execute` (code mode) no reciben `decisions` (su contexto se construye aparte en `tools/execute.ts`, verificado).
- **Alternativas descartadas.** Un singleton global que emita eventos sin ejecución (sin atribución de sesión).

### 4.9 ADR-9: Decision Packs como código

- **Decisión.** Un pack es una función pura `buildX(input): DecisionRequest` con `pack: { id, version }`, más una tabla determinista que traduce respuestas a valores del consumidor. Sin cargador YAML ni packs de usuario. Los packs oficiales viven junto a su feature (p. ej. `analysis/dashboard/pack.ts`), no en `decisions/`.
- **Consecuencias.** Añadir un pack es un cambio de código con revisión y la regla de admisión (§11) como lista de comprobación del PR.

### 4.10 ADR-10: directorios y opciones por plugin (G1, G2)

- **Contexto.** El plugin Laya necesita un lugar para su entorno virtual, caché y configuración, y opciones (`device`, `model`, `preload`); hoy un plugin externo debe reimplementar la resolución XDG/`ALISIO_*` (puede divergir de la del host) y no recibe opciones.
- **Decisión.** `PluginAPI.paths?: { state; config; cache }`, resueltos por el host y creados con `0700` al leerlos por primera vez: `state = <stateRoot>/plugins/<id>`, `config = <configHome()>/plugins/<id>`, `cache = <stateRoot>/plugins/<id>/cache`. `stateRoot` es la **misma raíz que usan análisis y artefactos**: `dirname(options.db)` si hay `--db`, si no `stateHome()` (verificado en `application.ts` ~l. 498); no existe `cacheHome` en el core, por eso la caché cuelga del estado. El id del plugin ya está restringido a `^[a-z0-9][a-z0-9.-]{0,63}$` (valida `PluginHost.validate`), que no puede producir `.` ni `..` ni separadores. `PluginAPI.options?: Readonly<Record<string, JsonValue>>` se alimenta de `pluginOverrides[id].options`; para los integrados, de `builtinPlugins.<id>` sin la clave `enabled` (los integrados siguen recibiendo además el argumento `options` de `create`, sin cambios). El valor es una **instantánea congelada en el momento de `setup`**; cambiarlo requiere reiniciar, igual que habilitar o deshabilitar un plugin (verificado: `restart-required`).
- **Esquema.** `pluginOverrides: z.record(z.string(), z.object({ enabled: z.boolean().optional(), options: z.record(z.string(), jsonValueSchema).optional() }).strict())`. Las configuraciones existentes (`{ "enabled": false }`) siguen siendo válidas porque `options` es opcional y `enabled` solo se relaja a opcional (todo el código lee `?.enabled !== false`; se comprueba con una prueba de regresión). `setPluginEnabled` pasa a **conservar** `options` (`{ ...existing, enabled }`; hoy lo sobrescribiría). En la superposición de capas, `options` es **solo global** (un repositorio no debe inyectar opciones en un plugin con acceso al sistema): la entrada seleccionada se fusiona como `{ ...global[id], ...selected[id], options: global[id]?.options }`. Tope: `options` serializado ≤ 8 KB; claves `^[A-Za-z][A-Za-z0-9_.-]{0,63}$`; sin secretos (los secretos del plugin van por `ProviderSettingsStore` si el plugin es de proveedor; para otros, a documentar).
- **Alternativas descartadas.** Un bloque `pluginOptions` paralelo (dos fuentes de verdad para el mismo id); pasar el objeto de configuración completo al plugin (filtra datos ajenos).
- **Patrón.** Inyección de dependencias por capacidad opcional (detección por presencia, precedente `views?`).

### 4.11 ADR-11: ciclo de vida del proveedor activo (G4)

- **Decisión.** `DecisionProvider.activate?(): void | Promise<void>` y `deactivate?(): void | Promise<void>`. El `DecisionService` los llama cuando el proveedor *pasa a ser* el activo (arranque, cambio de `decisions.provider` en vivo por `updateSetting`, registro tardío de un proveedor ya nombrado en la configuración) y cuando *deja de serlo* (cambio de configuración, `enabled: false`, des-registro, `app.close()`). Cada llamada: acotada por `pluginHooks.timeoutMs` (verificado en la configuración; por defecto 15 s) con `AbortSignal`; los fallos se capturan, se guardan como `lastLifecycleError` (visible en `/decisions`) y **nunca son fatales**; **nunca se espera en la ruta de arranque** (se dispara tras el `setup` de plugins y no bloquea `createApplication`); las transiciones de un mismo proveedor se serializan (cola por proveedor) para que `deactivate` no cruce con `activate`. `decide` no espera a `activate` (un proveedor que aún arranca responde `DecisionProviderError("not_ready")`).
- **Motivo.** Permite que `preload` arranque y pare el servidor exactamente mientras el proveedor está activo, sin que el plugin tenga que adivinar `decisions.provider`.
- **Alternativa descartada.** `api.decisions.onActiveChange(cb)`: expone eventos de configuración a todos los plugins sin un caso de uso más.

### 4.12 ADR-12: cierre acotado de plugins (G5)

- **Hallazgo (verificado, §3).** `dispose()` se llama solo al cerrar la aplicación (`/exit`, Ctrl+C doble, SIGTERM/SIGHUP de la TUI, SIGINT/SIGTERM de `serve`, fin de `alisio run` por SIGINT); deshabilitar un plugin y `/reload` no lo llaman porque requieren reinicio. Pero (a) `PluginHost.close()` es secuencial y **sin tiempo límite por plugin**: un `dispose()` lento consume los 2,5 s de la etapa y deja sin cerrar a los demás; (b) `alisio run` no gestiona SIGTERM/SIGHUP, de modo que un `kill` no ejecuta `dispose()`; (c) `SIGKILL` o una caída no pueden cubrirse (el plugin debe llevar su propio limpiador de PID, como ya planea Laya).
- **Decisión (entregable de 0.3.0).** `PluginHost.close()` ejecuta los `dispose()` en **paralelo**, cada uno con su propio tope (`pluginHooks.disposeTimeoutMs`, **(nuevo)**, entero 100..10000, por defecto 2000, menor que el tope de etapa de 2,5 s; ajustable en vivo) y registra los fallos sin impedir el resto; `deactivate()` del proveedor activo se ejecuta antes (mismo tope). `alisio run` registra `SIGTERM` y `SIGHUP` con el mismo manejador que `SIGINT` (aborta y cierra por `finally`). Se documenta el contrato: «`dispose()` debe terminar en menos de `pluginHooks.disposeTimeoutMs`; las rutas cubiertas son: salida interactiva, SIGINT/SIGTERM/SIGHUP, fin de `run`, cierre de `serve`; no hay `dispose()` en habilitar/deshabilitar ni en `/reload` (requieren reinicio); una muerte súbita no se cubre».
- **Pruebas.** Un plugin de prueba con `dispose()` colgado no impide el `dispose()` de otro ni retrasa `close()` más de su tope; `alisio run` con `SIGTERM` simulado (proceso hijo en `fixtures/cli-e2e.ts`) deja constancia de `dispose()` (archivo centinela).

---

## 5. Contratos

### 5.1 SDK (`packages/sdk/src/index.ts`, aditivo) **(nuevo)**

```ts
// ---- Decision Intelligence. Additive; feature-detect api.decisions. ----
export interface DecisionsApi {
  /** Registers a provider (does NOT activate it; activation is `decisions.provider` in config). */
  registerProvider(p: DecisionProvider): () => void;
  /** True when decisions are enabled and the configured provider is registered. */
  available(): boolean;
  activeProvider(): { id: string; name: string } | null;
  /**
   * Never throws for infrastructure problems: resolves null (disabled, no provider, timeout,
   * provider error, circuit open, or every answer rejected). Throws DecisionRequestError (a
   * TypeError) for a malformed request and rethrows an abort requested by the caller.
   */
  tryDecide(req: DecisionRequest, opts?: DecisionOptions): Promise<DecisionResponse | null>;
}
/** What a tool receives in `ToolContext.decisions`: the consumer side, bound to the run. */
export type ToolDecisions = Omit<DecisionsApi, "registerProvider">;

export interface DecisionProvider {
  /** `^[a-z0-9][a-z0-9.-]{0,63}$`, unique among registered providers. */
  id: string;
  name: string;
  capabilities: { select: boolean; boolean: boolean; ordinal: boolean };
  /** Called ONLY by /decisions (own 1 s timeout), never on the decide path. */
  health?(signal?: AbortSignal): Promise<{ status: "ready" | "starting" | "unavailable"; detail?: string }>;
  /** Called when this provider becomes the active one. Bounded, never fatal, never awaited at startup. Cold start belongs here. */
  activate?(): void | Promise<void>;
  /** Called when it stops being the active one (config change, unregister, shutdown). */
  deactivate?(): void | Promise<void>;
  /** Fail fast with DecisionProviderError("not_ready" | "unavailable") instead of waiting. */
  decide(
    request: DecisionRequest,
    context: { signal: AbortSignal; timeoutMs: number },
  ): Promise<DecisionProviderResult>;
}

export interface DecisionRequest {
  version: 1;
  /** BCP 47 hint (e.g. "es-CO"); providers may ignore it. */
  language?: string;
  /** Non-sensitive call-site label (becomes `decisionId` in events), e.g. "smart-dashboard-v1". Never data-derived. */
  id: string;
  pack?: { id: string; version: number };
  /** JSON sent to the provider. Keep it minimal; a provider may be remote. <= 16 KB serialized (the whole request <= 32 KB). */
  state: JsonValue;
  /** 1..16 decisions keyed by `^[A-Za-z][A-Za-z0-9_]{0,63}$`. */
  decisions: Record<string, DecisionDefinition>;
}
export type DecisionDefinition =
  | { type: "select"; instruction: string; options: Record<string, string> } // 2..20 options
  | { type: "boolean"; instruction: string; trueMeaning?: string; falseMeaning?: string }
  | { type: "ordinal"; instruction: string; levels: string[] }; // 2..12 unique levels

export type DecisionAnswer =
  | { type: "select"; value: string; confidence: number; probabilities?: Record<string, number> }
  | { type: "boolean"; value: boolean; confidence: number; probability: number }
  | { type: "ordinal"; level: string; index: number; confidence: number; distribution?: number[] };
// `confidence`: the provider's best CALIBRATED estimate, in [0,1], that the answer is correct.
// Each adapter chooses the native field that feeds it (Laya: `answer_confidence`). minConfidence compares to it.

export interface DecisionProviderResult {
  decisions: Record<string, DecisionAnswer>;
  usage?: { inputUnits?: number; outputUnits?: number };
}
export interface DecisionOptions {
  timeoutMs?: number; // default: config decisions.timeoutMs
  minConfidence?: number; // default: config decisions.minConfidence
  signal?: AbortSignal;
}
export type DecisionRejection = "low_confidence" | "invalid" | "unsupported" | "missing";
export interface DecisionResponse {
  provider: string;
  latencyMs: number;
  /** Only validated answers that reached `minConfidence`. */
  decisions: Record<string, DecisionAnswer>;
  rejected: Record<string, DecisionRejection>;
  usage?: { inputUnits?: number; outputUnits?: number };
}
export type DecisionFallbackReason =
  | "timeout" | "not_ready" | "unavailable" | "invalid_response" | "provider_error"
  | "circuit_open" | "unsupported" | "all_rejected";

/** Providers throw this. not_ready/unavailable are fast fallbacks that do NOT count toward the circuit breaker. */
export type DecisionProviderErrorCode = "not_ready" | "unavailable" | "timeout" | "invalid_response" | "internal";
export class DecisionProviderError extends Error {
  constructor(readonly code: DecisionProviderErrorCode, message?: string) { super(message ?? code); this.name = "DecisionProviderError"; }
}

export class DecisionRequestError extends TypeError {
  readonly code = "decision_invalid_request";
  constructor(message: string) { super(message); this.name = "DecisionRequestError"; }
}

// PluginAPI gains:    decisions?: DecisionsApi;
//                     paths?: { state: string; config: string; cache: string };       // G1, per plugin, 0700
//                     options?: Readonly<Record<string, JsonValue>>;                   // G2, from pluginOverrides[id].options ({} if none)
// (every `Decision*` type, DecisionProviderError, DecisionRequestError and JsonValue are exported from the SDK root: G8)
// ToolContext gains:  decisions?: ToolDecisions;
// PluginCategory gains: | "decisions"
```

Eventos (en `RunEventDataMap`, aditivos; `schemaVersion` sigue en 1):

```ts
decision_completed: {
  decisionId: string;
  pack?: { id: string; version: number };
  provider: string;
  latencyMs: number;
  decisionCount: number;   // accepted answers
  rejectedCount: number;
  confidenceMin: number;   // min confidence among accepted answers
};
decision_fallback: {
  decisionId: string;
  pack?: { id: string; version: number };
  provider: string;
  latencyMs: number;
  reason: DecisionFallbackReason;
};
```

Helper puro (SDK):

```ts
export interface DecisionStats {
  requests: number; completed: number; fallbacks: number;
  avgLatencyMs?: number; p95LatencyMs?: number;
  lastFallback?: { reason: DecisionFallbackReason; decisionId: string; at: string };
  packs: Record<string, number>; provider?: string;
}
/** Pure: the three stats surfaces call this with the session's events. */
export function summarizeDecisionEvents(events: readonly RunEvent[]): DecisionStats;
```

### 5.2 Puertos internos de core (`packages/core/src/decisions/`) **(nuevo)**

```ts
// registry.ts
export class DecisionRegistry {
  register(owner: string, provider: DecisionProvider): () => void; // throws on duplicate id / invalid id
  get(id: string): { owner: string; provider: DecisionProvider } | undefined;
  list(): Array<{ id: string; name: string; owner: string; capabilities: DecisionProvider["capabilities"] }>;
}
// service.ts
export interface DecisionAttempt {
  response: DecisionResponse | null;
  outcome?:
    | { status: "completed"; decisionId: string; pack?: {...}; provider: string; latencyMs: number; decisionCount: number; rejectedCount: number; confidenceMin: number }
    | { status: "fallback"; decisionId: string; pack?: {...}; provider: string; latencyMs: number; reason: DecisionFallbackReason };
}
export class DecisionService implements Omit<DecisionsApi, "registerProvider"> {
  constructor(deps: { registry: DecisionRegistry; config: () => DecisionsConfig; metrics: DecisionMetrics; now?: () => number });
  attempt(req: DecisionRequest, opts?: DecisionOptions, ctx?: { sessionId?: string }): Promise<DecisionAttempt>;
  /** Typed errors (DecisionError) instead of null; for diagnostics and tests. */
  decide(req: DecisionRequest, opts?: DecisionOptions): Promise<DecisionResponse>;
  tryDecide(req: DecisionRequest, opts?: DecisionOptions): Promise<DecisionResponse | null>;
  status(signal?: AbortSignal): Promise<DecisionStatus>; // for /decisions ONLY: enabled, active, registered, health (own 1 s timeout), circuit, lastLifecycleError
  /** Lifecycle (ADR-11): the app calls these on startup (not awaited), live config change, unregister and close. */
  syncActive(): void;
}
// validate.ts   pure
export function validateRequest(req: unknown): asserts req is DecisionRequest;       // throws DecisionRequestError
export function validateAnswers(req: DecisionRequest, provider: DecisionProvider, raw: unknown, minConfidence: number):
  { accepted: Record<string, DecisionAnswer>; rejected: Record<string, DecisionRejection> };
// breaker.ts    pure with injected clock; the service calls failure() only for the counting codes (D9)
export class CircuitBreaker { allow(): "closed" | "half-open" | "open"; success(): void; failure(): void; reset(): void; state(): ... }
// metrics.ts
export class DecisionMetrics { record(entry, sessionId?): void; snapshot(sessionId?): DecisionMetricsSnapshot }
```

Reglas de `validateAnswers` (todas deterministas y puras):

| Caso | Resultado |
|---|---|
| El proveedor no declara la capacidad del tipo de la decisión | La decisión **no se envía**; clave en `rejected: "unsupported"`. Si ninguna se puede enviar: no se llama, `fallback: unsupported`. |
| Petición: claves de decisión fuera de `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, claves de opción o niveles vacíos o duplicados, descripciones vacías, `language` no BCP 47 (`^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$`), petición serializada > 32 KB | `DecisionRequestError` (antes de llamar) |
| Clave pedida sin respuesta | `missing` |
| Clave devuelta que no se pidió | Se ignora (no aparece en `rejected`) |
| `type` de la respuesta distinto del de la definición; `value` fuera de `options`; `level` fuera de `levels` o `index !== levels.indexOf(level)`; `confidence` no finita o fuera de [0,1]; `probability` fuera de [0,1] | `invalid` |
| `probabilities`/`distribution` mal formadas (claves ajenas, valores fuera de [0,1], longitud distinta de `levels`) | Se **elimina** el campo informativo; la respuesta sigue siendo válida |
| `confidence < minConfidence` | `low_confidence` |
| Objeto de respuesta | Se **reconstruye** solo con los campos conocidos (nada ajeno al contrato llega a eventos ni consumidores) |
| `result` no es un objeto con `decisions` objeto | Fallo `invalid_response` (cuenta para el disyuntor) |

Qué cuenta como solicitud en métricas: toda llamada con petición válida y `enabled` con proveedor activo. `completed` = devolvió respuesta no nula; `fallbacks` = devolvió `null` por cualquier valor de `DecisionFallbackReason`. Mapeo de errores del proveedor: `DecisionProviderError` → su `code` (`timeout`, `not_ready`, `unavailable`, `invalid_response`; `internal` → `provider_error`); cualquier otra excepción o rechazo → `provider_error`; la cancelación de quien llama se propaga sin registrar. `p95` sobre un anillo de las últimas 200 latencias completadas.

---

## 6. Modelo de datos y persistencia

- **Sin migración.** Los eventos usan la tabla `events` existente (`store.event(...)`, verificado) como filas de tipo `decision_completed`/`decision_fallback`. Si se publica antes la especificación de carpetas en la nube, su migración v9 no entra en conflicto.
- **Métricas**: solo en memoria, por proceso (`DecisionMetrics`), con vista por sesión (`sessionId` opcional en `record`). No sobreviven a un reinicio; por eso `/stats` usa los eventos persistidos (solo con `telemetry: true`).
- **Disco**: ninguno. No se escriben datos de decisiones fuera de los eventos.

---

## 7. Modelo de seguridad

| Amenaza | Mitigación |
|---|---|
| Fuga de datos del usuario a un proveedor remoto futuro | El contrato pone `state` en manos del consumidor con límite de 16 KB; la regla de admisión exige declarar qué datos entran (§11); el adaptador, no el core, decide si sale del proceso. Smart Dashboard define su regla en `specs/alisio-smart-dashboard-v1.md`. |
| Fuga en eventos/logs | Carga solo de metadatos; reconstrucción de respuestas con campos conocidos; prueba con cadenas centinela (ADR-7). |
| Un proveedor concede permisos | Imposible por contrato: ninguna API de permisos acepta una `DecisionResponse`; fuera de alcance. Una prueba revisa que `runner.ts`/`permissions/*` no importan `decisions/`. |
| Proveedor que cuelga o inunda | Tiempo límite con carrera; disyuntor; límites de petición; el plugin corre en proceso (no es un sandbox: confianza explícita ya existente al instalar plugins). |
| Un proyecto elige el proveedor | `decisions.provider` y `telemetry` son solo globales (O5, §8.2); un proyecto que las escribe recibe un diagnóstico. |
| Respuesta maliciosa del proveedor | Validación por clave contra el conjunto cerrado de opciones; objetos reconstruidos; sin cadenas libres reenviadas al HTML o SQL (los consumidores traducen respuestas por tabla). |
| Prompt injection vía `state` | El `state` es solo entrada del proveedor (un clasificador sin herramientas); su salida está restringida a opciones cerradas. |

---

## 8. Configuración

### 8.1 Esquema (`packages/core/src/config.ts`) **(nuevo)**

```ts
decisions: z.object({
  enabled: z.boolean().default(true),
  provider: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/).nullable().default(null),
  timeoutMs: z.number().int().min(50).max(10_000).default(1500),
  minConfidence: z.number().min(0).max(1).default(0.6),
  telemetry: z.boolean().default(true),
}).strict().default(() => ({ enabled: true, provider: null, timeoutMs: 1500, minConfidence: 0.6, telemetry: true })),
```

### 8.2 Alcance global-only (O5)

**Precedente que se sigue (verificado):** `GLOBAL_ONLY_ANALYSIS = ["runtime","oci","retention"]` (`config.ts` l. 89). `parseLayer` calcula `ignored` comprobando `key in analysisRaw` sobre el objeto **crudo** (l. 611-615) y devuelve `ignored` junto a la capa; el bucle de capas reemplaza esas claves por las del global en la rama `analysis` (~l. 672); `loadConfig` expone `provenance.ignored` (l. 626-629, 731); `createApplication` lo publica como `configDiagnostics` (`application.ts` l. 1128) y la CLI lo imprime (`cli/src/main.ts` l. 442). Es decir: **una capa de proyecto o `--config` explícito (aunque tenga confianza) que contenga estas claves NO provoca fallo de arranque: se ignoran con un diagnóstico**. Esta especificación aplica exactamente el mismo comportamiento.

**Aplicación (nuevo):**

- `const GLOBAL_ONLY_DECISIONS = ["provider", "telemetry"] as const;` junto a `GLOBAL_ONLY_ANALYSIS`. Las entregas posteriores añaden entradas: `"routing"` (0.5.0, `specs/alisio-capability-routing-v1.md`) y la clave raíz `modelTiers` (0.6.0, `specs/alisio-model-tier-router-v1.md`; se trata en una lista `GLOBAL_ONLY_ROOT`).
- `parseLayer`: lee `object.decisions` crudo y añade `decisions.<clave>` a `ignored` por cada clave presente de la lista (idéntico a `analysis.<clave>`); para `GLOBAL_ONLY_ROOT`, añade la clave raíz.
- Bucle de capas: rama `if (key === "decisions")` → `overlaid.decisions = { ...selected.config.decisions, provider: global.config.decisions.provider, telemetry: global.config.decisions.telemetry }`; para claves de `GLOBAL_ONLY_ROOT`, `continue` (se conserva la del global).
- El resto (`enabled`, `timeoutMs`, `minConfidence`) sigue la regla general (la capa seleccionada reemplaza el bloque; lo no escrito toma el valor por defecto, comportamiento ya vigente en `goal`).
- Pruebas (`decisions-config.test.ts`, `config-layers.test.ts`): proyecto de confianza con `decisions.provider`/`telemetry` → valores del global y `provenance.ignored` contiene `decisions.provider`/`decisions.telemetry`; ningún error de arranque; `--config` explícito igual; `enabled`/`timeoutMs`/`minConfidence` del proyecto sí se aplican.

### 8.3 Claves ajustables en vivo

`SETTABLE_SECTIONS.decisions` + cinco claves en `SETTABLE_KEYS`. `decisions.provider` se edita como cadena y se borra con `!clear` (precedente `agents.effort`; `settingLeaf` desenvuelve `nullable`). `updateSetting` gana el `case` `decisions.*` que muta `config.decisions`; el servicio lee la configuración por función (`config: () => DecisionsConfig`), así que se aplica a la siguiente llamada sin reinicio. Etiquetas EN/ES en `SETTING_LABELS` (obligatorias por `tests/web-i18n.test.ts`).

---

## 9. Comandos y observabilidad

### 9.1 `/decisions`

Descriptor en `BUILTIN_COMMANDS`: `{ name: "decisions", description: "Show Decision Intelligence status, provider health and session metrics", surfaces: ALL, execution: "core" }`. Manejador en `CommandCatalog` que usa `host.decisions?.status()` (nueva propiedad opcional de `CommandHost`; la `Application` la expone). Salida Markdown (el mismo texto en TUI y web):

```text
**Decision Intelligence**

- Status: enabled · provider: laya (Laya local) · health: ready
- Capabilities: select, boolean, ordinal
- Circuit: closed
- Timeout: 1500 ms · min confidence: 0.6 · telemetry: on

| This session | Process |
| Requests 12 · Completed 11 · Fallbacks 1 | Requests 87 · Completed 82 · Fallbacks 5 |
Latency: avg 51 ms · p95 94 ms
Last fallback: timeout (smart-dashboard-v1) at 12:04:31
Packs: smart-dashboard-v1 (12)
```

Sin proveedor: `Status: enabled · no provider configured (set decisions.provider)`; id desconocido: `provider "x" is not registered`. La salud se pide con `health(AbortSignal.timeout(1000))`; un fallo se muestra como `unavailable`.

### 9.2 `/stats`

Sección «Decision Intelligence» (solo si `requests > 0` en los eventos de la sesión) con las líneas de la tabla del plan §10.1 (proveedor, solicitudes, completadas, fallbacks, latencia media, P95). Las tres rutas llaman a `summarizeDecisionEvents`. Con `telemetry: false` la sección no aparece (los eventos no se persisten); `/decisions` sigue mostrando las métricas en memoria.

### 9.3 TUI y web

TUI: `statsReport()` acumula los eventos `decision_*` en `view.stats.decisions` dentro de `reduceEvent` (hoy descarta los tipos desconocidos, verificado) y añade la sección; `/decisions` se delega al catálogo como `tools`/`sessions`. Web: `computeStats` gana el campo opcional `decisions`; `StatsLine` lo añade al `title` de totales de sesión (no a la línea principal); `/decisions` aparece vía `routes/commands.ts` sin código nuevo en el servidor. Captura requerida (AGENTS.md): `docs/assets/web-ui/decisions_web_ui.webp` (§14, Fase 6).

---

## 10. Requisitos de alisio-plugins (resueltos)

Fuente: §13 de `../alisio-plugins/specs/alisio-plugin-laya-v1.md` (G1..G9) y sus correcciones de hechos (§14 de ese documento). Decisión del líder de producto + motivo; los detalles de diseño están en los ADR indicados.

| ID | Decisión | Motivo |
|---|---|---|
| G1 | **ACEPTADO.** `api.paths?: { state, config, cache }` opcional y detectado por presencia: `<stateRoot>/plugins/<id>`, `<configHome()>/plugins/<id>`, `<stateRoot>/plugins/<id>/cache`; `0700` (ADR-10, D19). | Evita que el plugin duplique la resolución XDG/`ALISIO_*` y deje un runtime de varios GB huérfano en una ruta distinta de la del host (respeta `--db`). |
| G2 | **ACEPTADO (mínimo).** `pluginOverrides[id].options` (global-only, ≤ 8 KB) expuesto como `api.options?: Readonly<Record<string, JsonValue>>`; `setPluginEnabled` conserva las opciones; las configuraciones existentes siguen válidas (ADR-10, D20). | Los integrados ya reciben opciones (`builtinPlugins.<id>`); los externos no. Reutiliza el bloque existente en vez de crear otra fuente de verdad. |
| G3 | **APLAZADO (no entra en 0.3.0).** Los manejadores de comando no reciben `AbortSignal` ni sumidero de progreso (verificado: `CommandContext` solo tiene `sessionId?`). Limitación conocida; se registra en `docs/implementation-status.md`. | Cambiar la firma de los comandos afecta a TUI, web y API por igual y no es necesario para el primer plugin: Laya ejecuta `/laya:setup` como trabajo en segundo plano y informa con `/laya:status` (y `api.ui.status`). |
| G4 | **ACEPTADO.** `activate?()`/`deactivate?()` en `DecisionProvider`, acotados por tiempo, nunca fatales ni esperados en el arranque (ADR-11, D21). | Permite que `preload` arranque y pare el servidor exactamente mientras el proveedor está activo y evita que el plugin deba inferir cambios de configuración. |
| G5 | **VERIFICADO + ENTREGABLE.** `dispose()` se llama al cerrar (salida interactiva, SIGINT/SIGTERM/SIGHUP de TUI y `serve`, fin de `run`); **no** en deshabilitar ni `/reload` (requieren reinicio). Faltas: cierre secuencial sin tope por plugin y `alisio run` sin SIGTERM/SIGHUP. Se corrigen en 0.3.0 con pruebas (ADR-12, D24). | Un plugin que posee un proceso del SO necesita un cierre garantizado y acotado; el parche es pequeño y local. |
| G6 | **ACEPTADO.** `DecisionRequest.language?: string` (BCP 47, opcional; los proveedores pueden ignorarlo) (D23). | Mejora el enrutado de puntos de control de Laya (`lang_guess`) sin coste para otros proveedores. |
| G7 | **ACEPTADO (crítico).** `DecisionProviderError` con `code: "not_ready" \| "unavailable" \| "timeout" \| "invalid_response" \| "internal"`. `not_ready`/`unavailable` son fallback con `reason` registrado pero **no cuentan** para el disyuntor; sí cuentan `timeout`, `invalid_response`, `internal` y los errores sin tipo. El core **nunca** llama a `health()` en la ruta de `decide` (solo `/decisions` y su vista web, con su propio tope de 1 s); el arranque en frío es del proveedor en segundo plano (`activate`). **DECLINADO** `DecisionProviderResult.meta` (D9, ADR-4). | Sin esto un arranque en frío abriría el circuito; el rechazo rápido ya es barato. `meta` no tiene consumidor en v1 (YAGNI); se añade de forma aditiva si aparece uno. |
| G8 | **ACEPTADO.** Todos los tipos `Decision*` y `JsonValue` (ya exportado, verificado) salen de la raíz del SDK. **El SDK 0.3.0 debe estar publicado antes de implementar `plugin-laya`** (D25). | El plugin importa solo del SDK; es la única dependencia admisible. |
| G9 | **ACEPTADO.** Claves de decisión `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; niveles ordinales no vacíos y únicos; claves de opción no vacías y únicas; petición completa ≤ 32 KB además del `state` ≤ 16 KB (D5). | Que todos los proveedores se comporten igual ante la misma petición. |
| Confianza | **DEFINIDO** en el contrato: `confidence` es la mejor estimación del proveedor, en [0,1], de que la respuesta sea correcta; el adaptador de Laya usa `answer_confidence`; `minConfidence` compara contra ese campo (D18). | Laya documenta `confidence` como entropía normalizada sin calibrar; compararla con un umbral sería engañoso. |
| Correcciones de hechos | Los puntos de control de Laya pesan ≈ 0,64-0,84 GB cada uno; `laya-ts` no está en npm; `device` admite también `mps`. Valores por defecto del plugin confirmados por el propietario: `model: "multilingual"`, `preload: true`. | Fuente: §14 de la especificación del plugin. Siguen **(no verificado)** hasta la Fase 0. |
| Rango de peer | El plugin declara `@alisio/sdk >=0.3.0 <0.7.0`. El contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás en 0.4, 0.5 y 0.6; antes de publicar cada una se ejecuta el *smoke test* de `plugin-laya` contra la versión candidata; un cambio incompatible en esa superficie exige avisar antes a `alisio-plugins` (D26). | El plugin no puede publicarse a la vez que cada minor del core. |

---

## 11. Regla de admisión y flujo de salvaguarda (contribución)

Se añade a `CONTRIBUTING.md` (sección «Decision Intelligence») y a `docs/decision-intelligence.md` (+ ES). Antes de crear un Decision Pack:

1. ¿La decisión tiene un conjunto cerrado de resultados? Si no → LLM o código normal.
2. ¿Aparece con suficiente frecuencia? Si no → no añadir.
3. ¿Resolverla aquí reduce tokens, coste, latencia o variabilidad? Si no → no añadir.
4. ¿Existe un fallback seguro? Si no → no automatizar.

Y la integración debe responder por escrito (plantilla de PR) las siete preguntas del plan §47: (1) qué decisión cerrada resuelve; (2) qué trabajo del LLM elimina; (3) qué métrica mejora; (4) cuál es su fallback; (5) qué ocurre sin proveedor; (6) cómo se valida su salida; (7) por qué el código determinista no bastaría. Añadida una octava propia de esta especificación: **qué datos van en `state` y por qué un proveedor remoto podría recibirlos**. Si no se responden con claridad, la feature no usa el Decision Engine. El código determinista tiene prioridad (p. ej. «tipo `date` → candidata a tiempo» no necesita IA).

---

## 12. Archivos por paquete

| Paquete | Nuevo | Modificado |
|---|---|---|
| sdk | — | `src/index.ts` (§5.1: tipos, `DecisionRequestError`, `DecisionProviderError`, `summarizeDecisionEvents`, `PluginAPI.decisions?`/`paths?`/`options?`, `ToolContext.decisions?`, `PluginCategory`, `RunEventDataMap`) |
| core | `src/decisions/{registry,service,validate,breaker,metrics,index}.ts` | `src/plugins/host.ts` (`api.decisions`, `api.paths`, `api.options`, `setDecisions`, enum `"decisions"`, `close()` con tope por plugin en paralelo), `src/application.ts` (crea el servicio, lo expone como `app.decisions`, fábrica para el runner, `updateSetting` `decisions.*`), `src/core/runner.ts` (`RunnerOptions.decisions?`, contexto de herramienta), `src/config.ts` (§8; `pluginOverrides[id].options`, `setPluginEnabled` que conserva opciones, capa global-only de `options`, `pluginHooks.disposeTimeoutMs`), `src/commands/{builtins,catalog}.ts` (`/decisions`, `CommandHost.decisions?`), `src/index.ts` (exports) |
| server | — | Ninguno funcional; `tests/server-*.test.ts` nuevos solo comprueban el comando |
| web | — | `src/store/stats.ts`, `src/components/stats/StatsLine.tsx`, `src/components/settings/labels.ts`, `src/i18n/{en,es}.ts` |
| cli | — | `src/tui/state.ts` (`reduceEvent`, `stats.decisions`), `src/tui/app.ts` (`statsReport`, despacho de `/decisions`), `src/main.ts` (`alisio run`: SIGTERM/SIGHUP) |
| tests | `decisions-service.test.ts`, `decisions-validate.test.ts`, `decisions-breaker.test.ts`, `decisions-events.test.ts`, `decisions-boundary.test.ts`, `decisions-config.test.ts`, `decisions-command.test.ts`, `decisions-stats.test.ts`, `decisions-lifecycle.test.ts` (activate/deactivate), `plugin-paths-options.test.ts` (G1/G2), `plugin-dispose.test.ts` (G5), `fixtures/decision-provider.ts` (doble de prueba) | `run-events-contract.test.ts` (nuevos tipos), `command-catalog-tui-parity.test.ts` (añadir `decisions` a `LEGACY_COMMANDS` con comentario «Added with Decision Intelligence»), `config-layers.test.ts` (capas y `pluginOverrides` con `options`), `settings*.test.ts`, `plugins-manager.test.ts` (`setPluginEnabled` conserva `options`), `fixtures/cli-e2e.ts` (SIGTERM de `run`) |
| docs | `docs/decision-intelligence.md`, `docs/es/decision-intelligence.md`, `docs/assets/web-ui/decisions_web_ui.webp` | `docs/.vitepress/config.ts` (barra lateral EN/ES), `docs/{plugins,configuration,tools,web,tui,architecture}.md` + ES (esquema `decisions`, `api.decisions`, comando), `docs/contributing.md` + ES y `CONTRIBUTING.md` (§11), `docs/implementation-status.md`, `docs/limitations.md`, `CHANGELOG.md` |
| repo | — | `package.json` versión (todos los paquetes: bump manual), `CHANGELOG.md`, `scripts/changelog-data.ts` (regenerar) |

---

## 13. Estrategia de pruebas

| Nivel | Qué | Archivo |
|---|---|---|
| Servicio | Sin proveedor → `null` sin métricas; con proveedor → respuesta; registrar no activa; proveedor duplicado lanza; id desconocido → `available() === false`; cambio de proveedor en caliente reinicia el disyuntor; tiempo límite con proveedor que ignora la señal (no retrasa a quien llama); cancelación de quien llama se propaga; cancelación del proveedor → `null`; petición malformada lanza `DecisionRequestError` | `decisions-service.test.ts` |
| Validación | Cada fila de la tabla de §5.2 (por decisión: inválida, no soportada, ausente, baja confianza, campos informativos eliminados, extras ignorados); límites (16 decisiones, 20 opciones, 12 niveles, 16 KB UTF-8); versión desconocida; `id` con datos | `decisions-validate.test.ts` |
| Disyuntor | 3 fallos abren; 30 s con reloj falso; sonda única en medio abierto; éxito cierra; rechazos por decisión no cuentan | `decisions-breaker.test.ts` |
| Eventos | Emitidos solo dentro de una ejecución real (runner con proveedor falso); `telemetry:false` no persiste pero sí cuenta en memoria; sin eventos con proveedor nulo; **ninguna cadena centinela del `state`, instrucciones u opciones aparece en `events.body`** | `decisions-events.test.ts` |
| Frontera | Busca `laya` y `jev` (sin distinguir mayúsculas) en `packages/core/src` y `packages/sdk/src`; `runner.ts` y `permissions/*` no importan `decisions/` | `decisions-boundary.test.ts` |
| Config | Valores por defecto, rangos, `.strict()`, capa de proyecto (con confianza y `--config`) no cambia `provider`/`telemetry` y los lista en `provenance.ignored` sin fallar el arranque, `updateSetting` en vivo | `decisions-config.test.ts` |
| Comando y estadísticas | `/decisions` con/sin proveedor, id desconocido, salud caída; `summarizeDecisionEvents` (puro); TUI `reduceEvent`; `computeStats`; las tres rutas coinciden con los mismos eventos | `decisions-command.test.ts`, `decisions-stats.test.ts` |
| Errores tipados (G7) | `not_ready`/`unavailable` → `null` con `reason` y **sin** abrir el circuito tras 10 repeticiones; `timeout`/`internal`/`invalid_response`/error sin tipo → abren a la tercera; `health()` **nunca** se llama durante `decide` (el doble cuenta llamadas) y sí desde `status()` con tope de 1 s; `meta` ausente del contrato | `decisions-service.test.ts`, `decisions-breaker.test.ts` |
| Higiene (G9, G6) | Claves, opciones y niveles vacíos/duplicados, petición > 32 KB, `language` inválido | `decisions-validate.test.ts` |
| Ciclo de vida (G4) | `activate` al arrancar sin bloquear `createApplication` (proveedor con `activate` colgado: la app arranca); `deactivate`/`activate` al cambiar `decisions.provider` en vivo, al des-registrar y al cerrar; tope y fallo no fatal con `lastLifecycleError`; transiciones serializadas | `decisions-lifecycle.test.ts` |
| Rutas y opciones (G1, G2) | `api.paths` en `<stateRoot>/plugins/<id>` respetando `--db`, `0700`, id sin escape de ruta; `api.options` `{}` sin configuración, instantánea congelada, global-only (la capa de proyecto no las cambia), config antigua `{enabled:false}` sigue válida, `setPluginEnabled` conserva `options`; núcleo antiguo (miembro ausente) simulado | `plugin-paths-options.test.ts` |
| Cierre (G5) | `dispose()` colgado no impide el de otro plugin ni retrasa `close()` más del tope; `alisio run` + SIGTERM ejecuta `dispose()` (centinela en disco) | `plugin-dispose.test.ts`, `fixtures/cli-e2e.ts` |
| Contrato | Los nuevos tipos en `run-events-contract.test.ts`; `Plugin` con `api.decisions` ausente (núcleo antiguo) no rompe: prueba de plugin que detecta por presencia | `run-events-contract.test.ts`, `plugin-boundaries.test.ts` |

Doble de prueba (`tests/fixtures/decision-provider.ts`): proveedor en memoria con modos `ok`, `slow`, `hang` (ignora la señal), `throw`, `garbage`, `lowConfidence`, `partial` y capacidades configurables. Casos del plan §41 cubiertos: sin proveedor, activo, tiempo límite, respuesta inválida, cancelación, cambio de proveedor, un solo proveedor. Inyección de fallos del plan §41 (proceso de Laya muerto, JSON inválido, etc.) pertenece al plugin.

---

## 14. Plan por fases

### 14.1 Fase 0 — Experimentos desechables (1-2 días; fuera del repo)

Requisitos: Python 3.10+, `pip install "laya[serve]"` en un entorno virtual temporal, un checkpoint inglés/multilingüe. Script `phase0/probe.mjs` (Node ≥ 22, sin dependencias) en un directorio temporal. Lanza el servidor con `LAYA_HOST=127.0.0.1 LAYA_PORT=<libre>`.

| # | Experimento | Pasos | Resultado esperado / cómo cambia el diseño |
|---|---|---|---|
| E1 | Mapeo de tipos | Enviar `POST /v1/systemone` con un `choice` (3 opciones), un `score` (3 niveles) y un `noul`; comparar con `select`/`ordinal`/`boolean` | Si `score` devuelve nivel esperado y no un índice, el adaptador convierte a `level` + `index`. Si `noul` devuelve probabilidad, `boolean.value = probability >= 0.5`. Si algo no encaja, ajustar `DecisionAnswer` **antes** de congelarlo. |
| E2 | Semántica de confianza | Comparar `confidence` (entropía normalizada) frente a `answer_confidence` (probabilidad calibrada) y `abstention` con 20 entradas ambiguas y 20 claras | La especificación del plugin ya fija `answer_confidence` (D18); el experimento comprueba que `minConfidence = 0.6` separa bien ambiguas de claras y, si no, propone otro umbral por defecto. |
| E3 | Latencia en caliente | 200 llamadas secuenciales con 4 decisiones, CPU y (si hay) GPU; p50/p95 | Si p95 en CPU > 800 ms, subir el `timeoutMs` por defecto o documentar que la CPU puede caer en fallback. |
| E4 | Límite de opciones | `choice` con 8, 20, 21 y 100 opciones | Confirma ≤ 20 (413 > 100, 422 al agotar tokens). Si el límite real es menor, bajar D5. |
| E5 | `min_confidence` del servidor | Enviar `min_confidence` y ver `abstention`/`low_confidence` | Confirma que el core filtra (D3; el adaptador no filtra). No se envía `min_confidence` al servidor para que el core sea la única autoridad. |
| E6 | Vinculación, seguridad y dispositivos | Arrancar sin `LAYA_HOST`; comprobar con `ss -ltn`; probar `LAYA_DEVICE` `cpu` y, si hay hardware, `cuda`/`mps` | Si enlaza a `0.0.0.0` por defecto (según el README), el plugin debe imponer `127.0.0.1` y `LAYA_API_KEY`. Confirmar que `mps` funciona y el tamaño real de los puntos de control (≈ 0,64-0,84 GB según la especificación del plugin). |
| E7 | Arranque en frío | Medir tiempo desde `laya-serve` hasta primera respuesta, con `LAYA_PRELOAD=1` y sin él | Dimensiona el estado `starting` de `health()` y si el core debe tolerar el primer fallback. |

**Entrega:** tabla sí/no con evidencia; el propietario confirma. Los resultados pueden modificar §5.1 (tipos de respuesta) y D5/D8. Sin ese visto bueno no empieza la Fase 1.

#### 14.1.1 Resultados de la Fase 0 (ejecutada el 2026-10-03; confirmados por el propietario)

Laya 0.3.24, checkpoint `multilingual` (`LAYA_REVISION=reviewed`), CPU (20 núcleos) y CUDA (RTX 4070 Laptop). Servidor siempre en `127.0.0.1` con token.

| # | ¿Se cumplió lo esperado? | Observado | Efecto en esta especificación |
|---|---|---|---|
| E1 | No para `score`; sí para `noul` | `score` devuelve el valor esperado (Σ i·pᵢ), `legend` y `probabilities` con claves índice; sin nivel ni índice. `noul` devuelve P(true). | §5.1 **sin cambios**: el adaptador deriva `index = argmax(probabilities)`, `level = levels[index]` y `distribution` en orden (falla cerrado si faltan probabilidades). Lo especifica `alisio-plugin-laya-v1.md`. |
| E2 | No | 14/20 aciertos en casos claros; `answer_confidence ≥ 0.6` no separa claros de ambiguos (AUC 0,34; muestra pequeña etiquetada a mano; el checkpoint no trae temperaturas ajustadas). | D18 deja de afirmar calibración: el core **no** asume que `confidence` esté calibrada y `minConfidence` es un filtro heurístico. `minConfidence` se mantiene en 0.6. La calidad se mide en la variante C del benchmark de `specs/alisio-smart-dashboard-v1.md`; comparar checkpoints es tarea de la especificación del plugin. |
| E3 | Sí (4 decisiones) | CPU p50 379 / p95 399 ms; CUDA p95 18 ms. Escala ≈ 80 ms por pregunta en CPU (16 preguntas: 1273 ms). | D7/D8: `timeoutMs` por defecto pasa de 800 a **1500 ms**, que cubre el tope de 16 decisiones en CPU. |
| E4 | Parcial | El servidor acepta hasta 100 opciones (101 → 413), 32 niveles y 64 preguntas. | Ninguno: los topes de D5 (20 opciones, 12 niveles, 16 decisiones) son del core y más estrictos. |
| E5 | Sí | `min_confidence` del servidor solo anota (`abstention`, `low_confidence`); no elimina respuestas. | Ninguno: D3 confirmado; no se envía. |
| E6 | Sí | Enlace por defecto `0.0.0.0`; `cpu` y `cuda` funcionan; checkpoint 647 MB; sin `trust_remote_code`; descargas sin fijar salvo `LAYA_REVISION`. | Ninguno en el core; el plugin impone `127.0.0.1`, token, `LAYA_REVISION=reviewed` y `LAYA_SHA256_DIGESTS`. |
| E7 | Sí | Arranque CPU con precarga 4,9 s; sin precarga la primera petición tarda ≈ 3,9 s. CUDA con precarga 11,4 s. | Ninguno: confirma el estado `starting`, el rechazo `not_ready` (que no abre el disyuntor) y el calentamiento en `activate()`. |

Propuesta G10 del plugin (pista `maxDecisionsPerRequest` o timeout por proveedor): **rechazada** para 0.3.0; con 1500 ms el tope de 16 decisiones cabe en CPU.

### 14.2 Fase 1 — Tipos del SDK (S)

- **Entregables:** §5.1 completo (tipos, `DecisionRequestError`, `DecisionProviderError`, `summarizeDecisionEvents`, `api.paths?`/`api.options?`, categoría, eventos en `RunEventDataMap`), todo exportado desde la raíz de `index.ts` (G8); `run-events-contract.test.ts` actualizado.
- **Aceptación:** `pnpm typecheck` verde; el SDK no importa nada nuevo; `summarizeDecisionEvents` pasa pruebas puras con eventos sintéticos.
- **Docs:** ninguna aún (se escribe en la Fase 6).
- **Release:** sin release; el repositorio queda verde.

### 14.3 Fase 2 — Registro, servicio, validación y disyuntor (L)

- **Entregables:** `decisions/*`, `api.decisions` en `PluginHost` (`setDecisions`, registro con `track` para deshacer al descargar el plugin), doble de prueba.
- **Aceptación:** pruebas de servicio, validación y disyuntor verdes; `decisions-boundary.test.ts` verde; un plugin de prueba registra un proveedor y `tryDecide` lo usa; descargar el plugin retira el proveedor y `available()` pasa a falso.
- **Docs:** ninguna.

### 14.4 Fase 3 — Configuración, rutas/opciones por plugin y cierre acotado (M)

- **Entregables:** §8 (esquema, capas, ajustes en vivo, etiquetas EN/ES); `api.paths`/`api.options` y el esquema `pluginOverrides[id].options` (ADR-10); `PluginHost.close()` en paralelo con tope por plugin y `pluginHooks.disposeTimeoutMs`; SIGTERM/SIGHUP en `alisio run` (ADR-12); ciclo de vida `activate`/`deactivate` (ADR-11).
- **Aceptación:** `decisions-config.test.ts`, `plugin-paths-options.test.ts, `plugin-dispose.test.ts`, `decisions-lifecycle.test.ts` y `tests/web-i18n.test.ts` verdes; un proyecto no puede cambiar `provider`, `telemetry` ni `options` (se ignoran con diagnóstico, sin fallo de arranque); una configuración 0.2.x válida sigue cargando sin cambios.

### 14.5 Fase 4 — Eventos y métricas dentro de una ejecución (M)

- **Entregables:** fábrica `decisions` en `RunnerOptions`, `ToolContext.decisions`, emisión de `decision_completed`/`decision_fallback`, métricas por sesión y proceso.
- **Aceptación:** `decisions-events.test.ts` verde (incluida la prueba de cadenas centinela); una herramienta de prueba que llama a `context.decisions.tryDecide` produce el evento correcto con la `sessionId` de la ejecución.

### 14.6 Fase 5 — `/decisions` y `/stats` en TUI y web (M)

- **Entregables:** §9 completo, incluida la actualización de `command-catalog-tui-parity.test.ts`.
- **Aceptación:** los tres cálculos de `/stats` coinciden (`decisions-stats.test.ts`); `pnpm web:size` dentro del presupuesto (90 KB gzip JS / 20 KB CSS, `scripts/web-size.ts`); `/decisions` funciona en TUI y web con y sin proveedor.

### 14.7 Fase 6 — Documentación y release 0.3.0 (M)

- **Entregables:** `docs/decision-intelligence.md` + ES (resumen, proveedores, packs, fallback y confianza, regla de admisión), actualizaciones de las páginas listadas en §12, captura real con Playwright de `/decisions` en la web contra un `alisio serve` construido y un proveedor falso con datos de ejemplo (nunca títulos de sesión, correos o tokens reales), convertida a WebP (< 150 KB) en `docs/assets/web-ui/decisions_web_ui.webp`, colocada junto al párrafo correspondiente en EN y ES, con texto alternativo y pie en cada idioma; borrar temporales y `.playwright-mcp/`.
- **Aceptación:** `pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build` verdes; paridad EN/ES (mismos encabezados y bloques de código); `docs/implementation-status.md` (en español) actualizado con límites y alcance de verificación.
- **Release:** bump manual de los 7 paquetes publicados (+ `packages/web` privado y la raíz) a la siguiente minor (esperada 0.3.0); entrada de `CHANGELOG.md` en inglés con `### Added` («Decision Intelligence: an optional provider contract, `/decisions` and decision metrics in `/stats`; Alisio works the same without a provider»); `pnpm changelog:data`; publicación según `.agents/skills/alisio-publish/SKILL.md` (nunca `npm publish` directo). **Aviso a `alisio-plugins`:** el SDK 0.3.0 debe estar **publicado** antes de empezar `plugin-laya` (G8); el plugin declara peer `@alisio/sdk >=0.3.0 <0.7.0` (D26). Se documenta en `docs/plugins.md` (+ ES) que `api.decisions`, `api.paths` y `api.options` son opcionales y se detectan por presencia.

---

## 15. Definición de terminado y registro de riesgos

**Definición de terminado (por fase):** gate completo verde; pruebas escritas primero; sin cambios de semántica en contratos existentes; paridad EN/ES; capturas reales cuando hay UI; `docs/implementation-status.md` actualizado; el core sigue sin nombrar a ningún proveedor.

| Riesgo | Impacto | Cómo y cuándo se verifica |
|---|---|---|
| El contrato no encaja con el protocolo real de Laya (p. ej. semántica de `confidence`, ordinal como nivel) | Re-trabajo del SDK ya publicado (minor siguiente) | Fase 0 E1/E2 antes de congelar; el contrato se publica en 0.3.0 solo tras el visto bueno |
| La API de Laya difiere de lo leído (resumen externo) | Mapeos erróneos | Fase 0 contra un servidor real; todo lo de Laya está **(no verificado)** hasta entonces |
| Laya enlaza a `0.0.0.0` por defecto | Servicio expuesto en la red | Fase 0 E6; requisito para el plugin (`LAYA_HOST=127.0.0.1`, `LAYA_API_KEY`) |
| Fuga de `state` a eventos/logs | Privacidad | Prueba con centinelas (Fase 4) |
| Un archivo de proyecto con `decisions.provider`/`telemetry` se ignora (el usuario puede no entender por qué) | Confusión | Diagnóstico en `provenance.ignored`/`configDiagnostics` (comportamiento del precedente `analysis.runtime`); prueba en la Fase 3 |
| G3 aplazado: el comando `/laya:setup` no se puede cancelar ni informa progreso | Mala UX en instalaciones largas (varios GB) | Limitación conocida registrada en `docs/implementation-status.md`; el plugin usa trabajo en segundo plano + `/laya:status` |
| `api.options` solo global y por instantánea: cambiar opciones exige reiniciar | Fricción | Coherente con habilitar/deshabilitar plugins (`restart-required`); documentado |
| Un `dispose()` de plugin sigue sin cubrir `SIGKILL` o caída | Procesos huérfanos (p. ej. servidor de Laya) | Fuera del alcance del core; el plugin lleva limpiador por PID (§13 del plugin) |
| Romper `api.decisions`/`api.paths`/`api.options` en 0.4-0.6 rompe el plugin (peer `<0.7.0`) | Plugin roto en producción | D26: compatibilidad hacia atrás, *smoke test* de `plugin-laya` contra cada candidata y aviso previo a `alisio-plugins` |
| Coste de mantener `summarizeDecisionEvents` en tres consumidores | Deriva | Helper único; prueba de equivalencia (Fase 5) |
| La especificación de carpetas en la nube dice 0.2.0, que ya está publicada | Numeración confusa | Las versiones de estas cuatro especificaciones son «la siguiente minor al ejecutar»; el propietario revisa `specs/alisio-workspace-sources-v1.md` |
| `tests/command-catalog-tui-parity.test.ts` se rompe al añadir `/decisions` | Falso fallo | Actualizar la lista legada en la misma fase (Fase 5) |
| Disyuntor oculta una recuperación del proveedor durante 30 s | Fallbacks innecesarios | Medio abierto con sonda; documentado en `/decisions` (estado del circuito) |

## Apéndice. Fuentes (consultadas el 2026-10-03)

1. Plan de producto: `alisio-decision-intelligence-plan-1.md` (§6-§11, §14, §40-§47).
2. Código del repositorio citado en §3 (leído el 2026-10-03).
3. Requisitos del plugin y correcciones de hechos: `../alisio-plugins/specs/alisio-plugin-laya-v1.md` (§13 y §14, leídos 2026-10-03).
4. Laya (README del repositorio; resumen obtenido con WebFetch, **no verificado** en fuente primaria ejecutable): https://github.com/NandhaKishorM/laya — endpoints `POST /v1/systemone`, `/v1/systemone/batch` (hasta 64 estados), tipos `choice`/`score`/`noul`, campos `confidence`, `answer_confidence`, `probabilities`, `abstention`, `min_confidence`, variables `LAYA_DEVICE`, `LAYA_PRELOAD`, `LAYA_HOST`, `LAYA_PORT`, `LAYA_API_KEY`, `laya[serve]`.
5. SQLite y Chart.js no se consultan en esta especificación.
6. Convención de formato: `specs/alisio-workspace-sources-v1.md`, `specs/archive/alisio-plan-diagrams-viewer-v1.md`.
