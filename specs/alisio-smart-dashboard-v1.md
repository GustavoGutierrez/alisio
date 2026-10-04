# Especificación Técnica: Smart Dashboard Composer (dashboards deterministas a partir de un perfil de datos)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | **Implementada en 0.4.0** (2026-10-03). Puerta hacia 0.5.0 (§11.2) **no superada**: B −28,5 % de tokens de salida y −8,7 % de turnos frente a A (resultados en §14.1.1). |
| Fecha | 2026-10-03 |
| Paquetes afectados | `@alisio/sdk` (tipos `DashboardSpec`), `@alisio/core` (`packages/core/src/analysis/dashboard/*`, herramienta `dashboard_generate`, extracción de activos del runtime de gráficos, publicación con procedencia, texto de guía), `@alisio/web` (privado: progreso de la herramienta, procedencia del artefacto), `@alisio/alisio-code` (TUI: progreso de herramientas en curso) |
| Paquetes nuevos | Ninguno |
| Relación con otras especificaciones | Requiere `specs/alisio-decision-intelligence-v1.md` (0.3.0 publicada): consume `ToolContext.decisions?`, pero **funciona sin proveedor por diseño**. Precede a `specs/alisio-capability-routing-v1.md` (0.5.0, reutiliza el arnés de benchmark de esta entrega) y `specs/alisio-model-tier-router-v1.md` (0.6.0). Extiende el runtime de análisis descrito en `specs/archive/alisio-data-analysis-runtime-v1.2.md`. El plugin Laya vive en `../alisio-plugins/specs/alisio-plugin-laya-v1.md` (solo la variante C del benchmark lo necesita) |
| Superficies | Web y TUI con paridad funcional; headless (`alisio run`) usa la herramienta como cualquier otra |
| Política de versión | Funcionalidad nueva: **la siguiente minor en el momento de ejecución; esperada 0.4.0**. Aditivo. La versión del runtime Python (`alisio_runtime.__version__`) pasa de `"2"` a `"3"` |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. TDD estricto: la prueba que falla va primero, en `tests/*.test.ts` (vitest), sobre comportamiento en los límites de módulo. No hay pruebas de instantánea que repitan la implementación; las pruebas «golden» de §13 son comportamiento en un límite de módulo, pequeñas y revisadas a mano.
2. **(verificado)** = abrí el archivo el 2026-10-03; **(no verificado)** = deducido o externo sin fuente primaria ejecutada; **(nuevo)** = no existe.
3. **Orden obligatorio**: Fase 0 (arnés de benchmark y línea base A **antes de cambiar ningún texto de guía**) → el propietario confirma → Fases 1-9. Cada fase deja el repo verde (`pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`). Sin commit hasta que lo pida el propietario.
4. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun (solo `node:fs`, `node:child_process`, `node:sqlite`); ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del core; los plugins dependen solo de `@alisio/sdk`; preservar IDs de llamadas a herramientas, continuación del proveedor y consistencia de sesión; **un manifiesto de plugin o un subproceso no es un sandbox**.
5. Idioma: identificadores, rutas, claves, textos de UI y de dashboards generados en inglés/español según `locale`; esta especificación en español.
6. Los contratos son aditivos: ninguna ruta, evento ni columna existente cambia de semántica.
7. Las decisiones del propietario (O1..O9, §2.1) se aplican exactamente; las de diseño (D1..D18, §2.2) las tomó esta especificación y son vinculantes. Lo único que depende de resultados experimentales es lo marcado como dependiente de la Fase 0 (§14.1).

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

Que «adjuntar datos, pedir un dashboard y obtener una composición profesional, consistente y validada» no requiera que el LLM escriba código. Hoy el modelo debe decidir a la vez qué analizar, qué consultar, qué gráfico usar, cómo maquetar y cómo escribir el script Python (`python_run` + `alisio_runtime.charts`). La nueva herramienta `dashboard_generate` recibe la **intención** del usuario y construye el dashboard con un pipeline determinista: perfil → candidatos → plan → `DashboardSpec` → validación → consultas SQL controladas → renderizado en TypeScript → artefacto. Un Decision Provider, si existe, solo **refina** decisiones cerradas; sin él el resultado es válido y reproducible.

Principio rector: **el LLM expresa la intención; el código determinista planifica, consulta y renderiza; el proveedor de decisiones solo elige entre opciones conocidas.** El proveedor nunca escribe HTML, JavaScript, Python ni SQL.

### 1.2 Mapa de entregas (idéntico en las cuatro especificaciones)

| Orden | Entrega | Versión | Plan fuente |
|---|---|---|---|
| 1 | Decision Intelligence (contrato, servicio, observabilidad) | core 0.3.0 | Fases 1-3 |
| 2 | `@alisio/plugin-laya` (repo alisio-plugins) | plugin 0.1.0, peer sdk >=0.3.0 <0.7.0 | Fase 4 (§11, §15) |
| 3 | Smart Dashboard Composer + benchmark A/B/C | core 0.4.0 | Fases 0, 5-13 |
| 4 | Adaptive Capability Routing (tools + MCP) | core 0.5.0 | Fases 14-17 |
| 5 | Model Tier Router (experimental, opt-in) | core 0.6.0 | Fases 18-19 |

El «Release 1» del plan = entregas 1+2+3. Se divide porque los plugins viven en otro repositorio y solo compilan contra un SDK **publicado** (0.3.0 primero). Smart Dashboard funciona sin proveedor, así que 0.4.0 no se bloquea por Laya en funcionalidad; solo la variante C del benchmark necesita el plugin. Cada entrega posterior está condicionada: 0.5.0 empieza solo si la variante B del benchmark de 0.4.0 cumple la puerta de dashboards (≥ 50 % menos tokens de salida, ≥ 40 % menos turnos LLM frente a A, 100 % de specs válidos, 0 avisos de lint); 0.6.0 solo tras el de 0.5.0. Si se publica un parche entre medias, las minors se desplazan: los números son «la siguiente minor al ejecutar», esperados los de la tabla.

### 1.3 Alcance

Perfilador de columnas, constructor de candidatos, pack de decisiones `smart-dashboard-v1`, planificador «reglas primero, decisiones encima», `DashboardSpec` v1 y validador, planificador de consultas, renderizador TypeScript con el mismo contrato DOM que `alisio_runtime/charts.py`, herramienta `dashboard_generate`, texto de guía, progreso en TUI/web, arnés de benchmark A/B/C y documentación.

### 1.4 Fuera de alcance (las cuatro especificaciones)

| Excluido | Motivo |
|---|---|
| Fine-tuning de modelos de decisión | No es necesario para el valor buscado. |
| Plugin Jev | Release posterior. |
| Cascadas multi-proveedor | Un solo proveedor activo; cada feature define su fallback. |
| Router de agentes | Riesgo de coste y latencia; evaluar con datos. |
| Poda probabilística de contexto | Riesgo de ocultar contexto necesario. |
| Router de skills | La revelación progresiva ya limita el coste. |
| Decisiones de permisos | Nunca se concede un permiso por una decisión probabilística. |
| Router universal de prompts | No se infiere una decisión por mensaje. |

Fuera de alcance solo de esta entrega: filtros/segmentadores interactivos en el dashboard, edición manual de un `DashboardSpec` por el usuario, widgets ajenos al catálogo (mapas, embudos, tablas dinámicas), fechas no ISO (§3: solo se infiere `date` para ISO 8601), exportación a PDF, regeneración incremental con memoria del dashboard previo (cada llamada es independiente), joins entre hojas.

---

## 2. Decisiones

### 2.1 Decisiones del propietario (confirmadas el 2026-10-03; aplicar exactamente)

| # | Decisión |
|---|---|
| O1 | **Empaquetado**: 0.4.0 (Smart Dashboard) es un release estable **separado** de 0.3.0 (Decision Intelligence, `specs/alisio-decision-intelligence-v1.md`). |
| O2 | `@alisio/plugin-laya` es un plugin **externo** (repositorio `alisio-plugins`), nunca un integrado del core; defaults `model: "multilingual"`, `preload: true`. Esta entrega no lo instala ni lo nombra; solo la variante C del benchmark lo usa. |
| O3 | **Comportamiento por defecto**: la guía al agente prefiere `dashboard_generate`. Interruptor de apagado `analysis.smartDashboard` (booleano, por defecto `true`): con `false` la herramienta **no se ofrece** y los textos de guía **vuelven al flujo actual de Python** (§9). |
| O4 | **Privacidad**: el `state` del proveedor lleva solo el objetivo del usuario y metadatos de columna (etiqueta, rol, tipo inferido, cubo de cardinalidad). **Nunca** valores de celdas, valores frecuentes, mínimos/máximos ni muestras. |
| O5 | **Benchmarks**: endpoint y modelo son parámetros que el propietario entrega por variables de entorno en tiempo de ejecución; **todas las variantes de un mismo benchmark usan el mismo modelo**; el modelo y el *host* del endpoint se registran en el JSON de resultados (**nunca** la clave de API). |
| O6 | **Puerta hacia 0.5.0**: ≥ 50 % menos tokens de salida y ≥ 40 % menos turnos LLM que la variante A, 100 % de specs válidos y 0 avisos de `chart-lint`. Confirmada como puerta (se mide sobre la variante B; C se informa). |
| O7 | **Pruebas golden aceptadas, acotadas**: `tests/golden/dashboard/*.json` para unos pocos datasets pequeños, revisados a mano; el HTML solo con aserciones estructurales; **documentar la excepción en `CONTRIBUTING.md` es un entregable**. |
| O8 | **Documentación**: una página por release; en 0.4.0, `docs/smart-dashboard.md` + `docs/es/smart-dashboard.md`. |
| O9 | **Alcance de configuración**: `decisions.provider`, `decisions.telemetry`, `decisions.routing.*` y `modelTiers` solo del config global (§8.2 de la especificación 1). |

### 2.2 Decisiones de diseño de la especificación

| # | Decisión |
|---|---|
| D1 | **Pipeline puro** en `packages/core/src/analysis/dashboard/`: `profile.ts` → `candidates.ts` → `pack.ts` → `planner.ts` → `spec.ts` → `validate.ts` → `query.ts` → `render.ts`, orquestado por `dashboard_generate` (`packages/core/src/tools/dashboard.ts`). Funciones puras con entradas explícitas; solo `query.ts` y la herramienta hacen E/S. |
| D2 | **Perfilador determinista** con roles `time \| measure \| dimension \| identifier \| boolean \| unknown` calculados a partir de `_alisio_columns` ya existentes (sin nueva pasada de ingesta; si la Fase 0 muestra que falta una estadística, se añade de forma aditiva a `stats.ts`). Listas cortas: medidas ≤ 8, dimensiones ≤ 8, tiempo ≤ 4. |
| D3 | **Planificador «reglas primero, decisiones encima»** (Estrategia + sobrescritura por decisión): `RuleBasedPlanner` calcula **siempre** un plan base completo; cuando `context.decisions?.tryDecide` devuelve respuestas utilizables, cada una sustituye a su valor por defecto; las claves rechazadas o ausentes conservan la regla. Hay un solo camino de código. El pack se construye dinámicamente y omite las preguntas que las reglas ya responden. (reducido a `purpose` por la evidencia de §14.1.1). Nota E7c: las reglas leen además qué columnas nombra el objetivo y planifican para ellas (§6.2, «Planificación según el objetivo»); sigue siendo código local y determinista, sin proveedor. |
| D4 | **Implementación de O4**: el `state` contiene el objetivo (truncado a 500 caracteres desde E7c; antes 300) y, por columna preseleccionada, `id` (alias), etiqueta (≤ 60), rol, tipo inferido y cubo de cardinalidad; una prueba con cadenas centinela sembradas en celdas, `top_values`, mínimos y máximos falla si aparecen. |
| D5 | **`DashboardSpec` v1** exportado desde `@alisio/sdk` (tipos) con validador en core. Widgets `kpi \| line \| area \| bar \| hbar \| pie \| donut \| scatter \| table`; layouts, agregaciones y `timeBucket` son enums cerrados; ninguna cadena libre llega a HTML o SQL salvo `title`/`label`, que se escapan. Límites: ≤ 12 widgets, ≤ 6 KPIs. |
| D6 | **Validador** con resultado `valid \| repaired \| fallback` y tabla de reparación determinista (§6.3). `fallback` = replanificar solo con reglas; si aún falla, la herramienta devuelve un error claro que indica usar `python_run`. Nunca se llama al LLM para reparar. |
| D7 | **Planificador de consultas**: cada widget se compila a un único `SELECT` desde un AST interno con identificadores tomados **solo** del catálogo de columnas del dataset y siempre entrecomillados; sin literales del proveedor ni del modelo; límites numéricos acotados. Ejecuta por `DatasetService.query()` (guarda SQL activa, lector de solo lectura, tiempo límite 5000 ms): defensa en profundidad. |
| D8 | **Renderizador en TypeScript** sin proceso Python, con el **mismo contrato DOM** que `charts.py`. Fuente única de activos: el CSS y el script de arranque (hoy constantes de cadena en `charts.py`) pasan a archivos del runtime junto a `chart.umd.min.js`; `charts.py` los lee y el renderizador TS los importa desde `ALISIO_RUNTIME_FILES`. Se sube la versión del runtime y se añade una prueba de paridad (se salta sin Python). |
| D9 | **Herramienta `dashboard_generate`**: entrada `{ datasetId: string; goal?: string; title?: string; locale?: "en" \| "es"; sheet?: string }` (`sheet` añadido al plan porque los XLSX tienen una tabla por hoja). Efecto `internal` (§7.2). Publica con `context.artifacts` y procedencia propia. Devuelve un resumen de texto corto, el bloque UI del artefacto y un resumen compacto del plan. Títulos y etiquetas salen de plantillas `en`/`es`, nunca de un LLM. |
| D10 | **Regeneración** = llamar de nuevo a la herramienta con otro `goal`; determinista para el mismo spec y los mismos datos. |
| D11 | **Guía al modelo** (O3): se actualizan los textos que empujan a Python para dashboards (lista exacta en §10) de modo que el modelo prefiera `dashboard_generate` y conserve `python_run` para lo que el catálogo no cubre. Cada cambio de §10.1 se aplica **solo si `analysis.smartDashboard` es `true`**; con `false` el texto es el actual. |
| D12 | **Progreso**: la herramienta emite líneas cortas con `context.emit` (`Analyzing dataset…`, `Planning dashboard…`, `Building N components…`, `Dashboard ready`); la web ya muestra la cola; la TUI hoy descarta `tool_progress` y gana un manejo mínimo que muestra la última línea de la herramienta en curso. Captura web obligatoria. |
| D13 | **Benchmark** en `scripts/bench-dashboard.ts` sobre la biblioteca común `scripts/bench/lib.ts` (**nueva en esta entrega**; la reutilizan las especificaciones de enrutado), con generadores deterministas con semilla (ventas, operaciones, inventario, tickets, nombres opacos; pequeño/mediano/grande) creados en tiempo de ejecución. Variantes A (flujo actual), B (Smart Dashboard sin proveedor), C (Smart Dashboard + Laya). Comando manual, no CI. Resultados en `docs/benchmark-dashboard.json` (excluido del sitio como `benchmark.json`). Parámetros por entorno según O5 (§11.1). **Fase 0 = construir el arnés y registrar la línea base A antes de tocar la guía.** |
| D14 | **Implementación de O7**: `tests/golden/dashboard/*.json` con el `DashboardSpec` esperado de ≤ 5 datasets de ≤ 40 filas definidos en la prueba (ADR-7); el HTML solo con aserciones estructurales; excepción documentada en `CONTRIBUTING.md` y `docs/contributing.md` (+ ES). |
| D15 | **Procedencia del artefacto**: `{ generator: "dashboard_generate", spec, planner: "rules" \| "rules+decisions", decisionProvider?, fallbacks }`. Se usa la clave `decisionProvider` y **no** `provider` porque `provider` ya es el proveedor del modelo de la sesión (`provenanceOf` en `application.ts`, y `ArtifactDetails.tsx` lo muestra); ver §3 y riesgos. |
| D16 | **Registro**: la herramienta se registra con `analysisEnabled && config.analysis.smartDashboard` (`analysisEnabled = config.analysis.enabled && !readOnly`, como `artifact_create`, porque publica artefactos); no requiere Python. Efecto `internal` (decisión técnica, ADR-4). **Limitación aceptada y documentada** (`docs/limitations.md` + ES e `implementation-status.md`): con `--read-only` la herramienta no existe. |
| D17 | **Documentación** (O8): `docs/smart-dashboard.md` + ES y actualización de `docs/analysis.md`, `docs/tools.md`, `docs/limitations.md` en ambos idiomas; capturas reales Playwright. |
| D18 | **Compatibilidad** (el plugin Laya, externo, declara peer `>=0.3.0 <0.7.0`): el contrato de decisiones (`api.decisions`, `ToolContext.decisions`) y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás; esta entrega no los modifica. |

---

## 3. Estado actual del código (verificado el 2026-10-03)

| Hecho | Dónde | Estado |
|---|---|---|
| Un dataset es un archivo SQLite con tabla `data` (XLSX: una `s_<hoja>` por hoja vía helper Python) y tabla `_alisio_columns(table_name, ordinal, name, label, inferred_type, nulls, distinct_count, distinct_exact, min, max, mean, text_fallbacks, top_values)` | `packages/core/src/analysis/data/stats.ts` (`META_SCHEMA`, `finalizeDatabase`) | verificado |
| Tipos inferidos: `integer \| real \| date \| boolean \| text`; **`date` solo para ISO 8601** (`YYYY-MM-DD`, con `T`/espacio y hora/zona opcionales); las fechas no ISO quedan como `text`; el tipo se infiere de las **primeras 1000 filas** (`TYPE_SAMPLE`) | `analysis/data/infer.ts` (`ISO_DATE`, `inferType`), `stats.ts` (`TYPE_SAMPLE = 1000`) | verificado |
| Los valores se guardan sin conversión: números como `INTEGER`/`REAL`, el resto como texto exacto; una columna `integer` por muestra puede contener texto más abajo | `infer.ts` (`convertCell`), `stats.ts` | verificado |
| Distintos y valores frecuentes: exactos hasta 1 000 000 filas, por muestra por encima (`distinct_exact`) | `stats.ts` (`EXACT_DISTINCT_ROWS`) | verificado |
| `DatasetService.detail(record)` devuelve `DatasetDetailWire` con `sheetDetails[].columns: DatasetColumnWire` (`name`, `label`, `type`, `nulls`, `distinct`, `distinctExact`, `min?`, `max?`, `mean?`, `textFallbacks`, `top`) | `analysis/data/datasets.ts` (~l. 460), `packages/sdk/src/index.ts` (~l. 163) | verificado |
| `DatasetService.query(record, sql, {maxRows, signal})` ejecuta `guardSql`, luego `engine.runQuery({guard:true, cellChars:2048, heapBytes})` con `limits.queryTimeoutMs` = 5000 y `maxRows` acotado a 1000; la ruta interna `runQuery({guard:false})` se usa solo en `sample`/`page` | `datasets.ts` (~l. 514-583, `DEFAULT_DATASET_LIMITS`) | verificado |
| El guardia léxico acepta una sola sentencia `SELECT`/`WITH` y rechaza palabras de escritura/esquema fuera de literales e identificadores entrecomillados | `analysis/data/sql-guard.ts` | verificado |
| `query-worker.ts` abre la conexión `readOnly` con `query_only=ON`, `trusted_schema=OFF`; el host mata el proceso al agotar el tiempo (sin interrupción en `node:sqlite`) | `analysis/data/query-worker.ts` | verificado |
| `quoteIdent(name)` y `sanitizeIdentifier` existen; los nombres de columna son `[a-z0-9_]`, ≤ 48 caracteres, sin empezar por dígito; `rowid`/`oid`/`_rowid_` están reservados | `analysis/data/infer.ts` | verificado |
| `data_inspect` y `data_query` son efecto `read` y se registran con `config.analysis.enabled` (también bajo `--read-only`) | `tools/data.ts`, `application.ts` (~l. 638-642) | verificado |
| `artifact_create` es efecto `internal`, publica con `context.artifacts.publishTextDetailed` y solo se registra con `analysisEnabled = config.analysis.enabled && !options.readOnly` | `tools/analysis.ts` (~l. 593-632), `application.ts` (~l. 596-606) | verificado |
| El efecto `read` o `internal` siempre está permitido por la política (`allowed(policy, effect)`), sin aprobación; los hijos en modo solo lectura excluyen solo `write/process/external` | `core/runner.ts` (l. 249), `sessions/children.ts` (l. 43, 113) | verificado |
| `describeArtifact` y `artifactBlocks` son privados de `tools/analysis.ts` (no exportados) | `tools/analysis.ts` (~l. 116-120) | verificado |
| `CoreArtifactPublisher.publishTextDetailed({fileName, title?, text})` **no admite procedencia por llamada** (sí `publishOutputs`); la procedencia base la fija la fábrica con `provenanceOf(session)` = `{model, provider}` | `core/contracts.ts` (~l. 254-277), `artifacts/publisher.ts`, `application.ts` (~l. 911-1006) | verificado |
| `GET /api/artifacts/:aid` devuelve la procedencia pública (filtra solo `sourcePath`, `previewable`, `sha256`) y la web la pinta en `ArtifactDetails.tsx`, que muestra `provenance.provider` como proveedor | `server/src/routes/artifacts.ts` (~l. 41-140), `web/src/components/artifacts/ArtifactDetails.tsx` | verificado |
| `chartWarnings(html)` avisa de SVG a mano, SVG de tamaño fijo y recursos de red; se invoca al publicar | `artifacts/chart-lint.ts`, `artifacts/store.ts` (~l. 540-555) | verificado |
| Los artefactos HTML (`kind: "dashboard"`) son previsualizables hasta 20 MB; el visor los sirve en un iframe aislado con `dashboardCsp()` (`default-src 'none'`, `script-src` inline, `connect-src 'none'`, `sandbox allow-scripts allow-downloads`) | `artifacts/kinds.ts`, `server/src/routes/artifact-view.ts` (~l. 33-47), `web/.../HtmlFrame.tsx` | verificado |
| `charts.py` contiene el CSS (`CSS`, ~l. 39-68) y el script de arranque (`_BOOT`, ~l. 70-147) como constantes de cadena; lee `chart.umd.min.js` con `Path(__file__).with_name(...)`; Chart.js 4.5.1 se incrusta una sola vez; `_json()` escapa `<`, `>` y `&` como `<` etc. | `analysis/python/alisio_runtime/charts.py` | verificado |
| Cada gráfico es `<figure class="ac-chart ac-pending" data-ac-chart="<kind>">` con `<figcaption>`, `div.ac-box` (altura `--ac-h`), `<canvas role="img" aria-label>`, `<details class="ac-data" open>` con tabla `data-v` y `<script type="application/json">` con el spec (`{v:1, kind, labels, series, fmt, …}`); `card`, `grid` (`--ac-min`), `kpis` (`.ac-kpis > .ac-kpi`) y la página (`html.page` + `CSS` + `scripts()`) | `charts.py` (`_fragment`, `_table`, `card`, `grid`, `kpis`, `page`), `alisio_runtime/html.py` | verificado |
| `ALISIO_RUNTIME_FILES` (generado) incluye `.py`, `.js` y `.txt`; el generador filtra por `/\.(py\|js\|txt)$/` y `tests/analysis-runtime-sources.test.ts` repite ese filtro; ambos hay que ampliar para `.css` | `scripts/analysis-runtime-sources.ts`, `tests/analysis-runtime-sources.test.ts`, `analysis/python/sources.ts` | verificado |
| `alisio_runtime.__version__ = "2"` | `analysis/python/alisio_runtime/__init__.py` | verificado |
| `pythonRunDescription()` empuja al modelo a `alisio_runtime.charts` para dashboards; `data_inspect`/`data_query`/`describeDataset` nombran `python_run` | `tools/analysis.ts` (~l. 166-205), `tools/data.ts` (l. 59, 164), `analysis/data/describe.ts` (cabecera) | verificado |
| `ToolContext.emit(data)` se convierte en `tool_progress` efímero; el servidor conserva la cola por herramienta en curso (`inflight.ts`); la TUI descarta `tool_progress` (`reduceEvent` no lo maneja) | `core/runner.ts` (~l. 851), `server/src/sse/inflight.ts` (~l. 71), `cli/src/tui/state.ts` | verificado |
| Que la web muestre la cola de progreso para cualquier herramienta (no solo `TerminalView`) | `web/src/store/progress.ts`, `web/src/renderers/terminal/view.tsx` | no verificado (comprobar en Fase 7) |
| `scripts/bench.ts` solo mide `--help`; no existe benchmark de tokens ni de tareas; no hay convención de pruebas golden | `scripts/bench.ts`, `tests/` | verificado |
| `tool_calls(session, call_id, status, result)` no guarda el nombre de la herramienta; los nombres están en los eventos `tool_started`; `turn_completed.usage` trae `input`, `output`, `cachedInput?` | `runtime/store.ts` (l. 35), `sdk/src/index.ts` | verificado |
| Cabeceras de la CLI: `--json` (JSONL), `--db`, `--cwd`, `--model`, `--base-url`, `--allow-analysis`; entorno `OPENAI_BASE_URL`, `ALISIO_MODEL`, `ALISIO_API_MODE` | `cli/src/main.ts`, `core/src/config.ts` | verificado |
| Helpers de prueba: `tests/data-helpers.ts` (`dataFixture`, `pythonCommand`), `tests/server-helpers.ts` (`fakeProvider`), `fixtures/scenarios.ts`; `tests/analysis-charts.test.ts` ejecuta el runtime incrustado con Python y se salta si falta | `tests/` | verificado |
| `strftime` de SQLite acepta ISO 8601 con `T`, `Z` y desplazamiento `±HH:MM` (lo normaliza a UTC), fracciones de segundo y devuelve `NULL` si no entiende la entrada | https://www.sqlite.org/lang_datefunc.html | no verificado (leído por resumen; la Fase 0 lo prueba en `node:sqlite`) |
| Chart.js 4: `indexAxis: 'y'` para barras horizontales, `cutout` para donuts, `interaction.mode: 'index'` con `axis: 'y'` en barras horizontales | https://www.chartjs.org/docs/latest/ (vía Context7) | no verificado (documentación consultada; no ejecutada) |

---

## 4. Decisiones de arquitectura (ADR-lite)

### 4.1 ADR-1: reglas primero, decisiones encima

- **Contexto.** El plan propone un «Decision Plan» o un fallback por reglas; ambos caminos duplicarían lógica y pruebas.
- **Decisión.** Un único planificador calcula siempre el plan completo por reglas (un valor por defecto para **cada** decisión del pack). La respuesta del proveedor sustituye valor a valor. «Funciona sin proveedor» es estructural: el camino sin proveedor **es** el camino base. Los fallos parciales son inocuos.
- **Alternativas descartadas.** Dos planificadores independientes; pedir al proveedor un plan completo y validarlo todo o nada (contradice ADR-2 de la especificación 1).
- **Consecuencias.** Las reglas son el techo de calidad garantizado y el suelo del resultado. Un solo juego de pruebas golden cubre ambos modos (con un proveedor falso que responde a todo, a nada o a medias).
- **Patrón.** Estrategia con sobrescritura por decisión.

### 4.2 ADR-2: renderizador en TypeScript con activos compartidos

- **Contexto.** El DOM de `charts.py` está respaldado por `chart-lint`, el visor, el tema y el comportamiento sin conexión. Un renderizador distinto los rompería o los duplicaría.
- **Decisión.** El renderizador TS emite **el mismo DOM**. Los activos (CSS y arranque) dejan de ser constantes de Python y pasan a archivos del runtime, de los que leen ambos lados (qué se mueve exactamente, en §8).
- **Alternativas descartadas.** (a) Lanzar Python desde la herramienta: contradice el objetivo «CSV → dashboard sin proceso adicional» y exige Python instalado. (b) Duplicar el script en TS: deriva garantizada. (c) Generar con otra librería (p. ej. SVG propio): pierde interactividad y el tema.
- **Consecuencias.** `sources.ts` crece unos kilobytes; hay que regenerarlo; la prueba de paridad vigila la deriva. Un arreglo del arranque beneficia a ambos caminos.
- **Patrón.** Fuente única de verdad + plantilla de fragmento.

### 4.3 ADR-3: consultas por AST con identificadores del catálogo

- **Decisión.** El `DashboardSpec` nunca contiene SQL. `query.ts` traduce widget → AST → `SELECT` con identificadores validados contra el catálogo del dataset y entrecomillados con `quoteIdent`; los únicos números son límites acotados. Aun así se ejecuta con la guarda SQL activa (defensa en profundidad), reutilizando `DatasetService.query()`.
- **Alternativas descartadas.** Parámetros enlazados para identificadores (SQLite no los admite); ejecutar por la ruta interna `guard:false` (quitaría una capa de defensa por un coste mínimo).
- **Consecuencias.** `maxRows` queda limitado a 1000 por consulta (suficiente: las agregaciones devuelven ≤ 400 filas); sin `WITH` ni subconsultas innecesarias.

### 4.4 ADR-4: efecto `internal` para `dashboard_generate`

- **Decisión.** Efecto `internal`, igual que `artifact_create`. Razonamiento en §7.2: no ejecuta código, no usa la red, no escribe en el workspace; solo lee un dataset **de la sesión** (como `data_query`, efecto `read`) y escribe en el almacén de artefactos de Alisio (como `artifact_create`). No requiere aprobación ni la debilita.
- **Alternativa descartada.** `read`: describe bien la lectura pero oculta que publica un artefacto; `internal` es el valor ya usado para publicar.

### 4.5 ADR-5: títulos y etiquetas por plantilla

- **Decisión.** Un módulo `labels.ts` con tablas `en`/`es` y reglas de formación («Total {metric}», «{metric} by {dimension}», «{metric} per {bucket}»). Los nombres de columna usan la etiqueta original (`label`) del dataset, escapada. Ninguna llamada a un LLM.
- **Consecuencia.** Determinismo y cero tokens; los títulos son menos «creativos» (se acepta).

### 4.6 ADR-6: procedencia con `decisionProvider`

- **Contexto.** La fábrica de artefactos fija `provenance = { model, provider }` (proveedor del *modelo*). Poner el proveedor de decisiones en la misma clave lo sobrescribiría.
- **Decisión.** Clave `decisionProvider`; `publishTextDetailed` gana un campo aditivo `provenance?` que el publicador fusiona tras la base (como ya hace `publishOutputs`).
- **Alternativa descartada.** Anidar bajo `dashboard.provider`: válido, pero la lista plana facilita el panel de detalles.

### 4.7 ADR-7: pruebas golden de `DashboardSpec`

- **Contexto.** `AGENTS.md` prohíbe pruebas de instantánea «que solo reformulan la implementación».
- **Decisión.** Se permiten **solo** archivos `tests/golden/dashboard/<caso>.json` con el `DashboardSpec` esperado para datasets de ≤ 40 filas definidos en la propia prueba. Es comportamiento observable en el límite del planificador (entrada: dataset + objetivo; salida: spec), pequeño y revisado a mano; el HTML nunca se compara por instantánea. Se documenta la excepción en `docs/contributing.md` (+ ES) y en `CONTRIBUTING.md`.
- **Consecuencias.** Un cambio de regla obliga a actualizar el golden con revisión humana (es lo buscado).

### 4.8 ADR-8: arnés de benchmark manual

- **Decisión.** `scripts/bench-dashboard.ts` no entra en `pnpm check` ni en CI: usa un endpoint de modelo real. Ejecuta `alisio run --json` por variante contra un `--db` temporal y deriva todas las métricas de lo persistido (eventos y tablas), no de la salida del modelo.

---

## 5. Contratos

### 5.1 SDK (`packages/sdk/src/index.ts`, aditivo) **(nuevo)**

```ts
// ---- Smart Dashboard. Types only: UIs and plugins may read the spec from artifact provenance. ----
export type DashboardPurpose = "executive" | "operational" | "analytical";
export type DashboardLayout = "executive-grid" | "operational-grid" | "analytical-grid";
export type DashboardAggregation = "sum" | "avg" | "min" | "max" | "count" | "count_distinct";
export type DashboardTimeBucket = "day" | "week" | "month" | "quarter" | "year";
export type DashboardLocale = "en" | "es";

interface WidgetBase { id: string /* ^[a-z][a-z0-9-]{0,39}$, unique */; title?: string /* <= 80 chars, escaped */ }
export interface KpiWidget extends WidgetBase { type: "kpi"; metric: string | "*"; aggregation: DashboardAggregation; label?: string }
export interface SeriesWidget extends WidgetBase {
  type: "line" | "area" | "bar" | "hbar" | "pie" | "donut";
  dimension: string;               // dataset column name (catalog), never free text
  metric: string | "*";            // "*" only with aggregation "count"
  aggregation: DashboardAggregation;
  timeBucket?: DashboardTimeBucket; // required when dimension is a time column
  limit?: number;                  // 1..20 (top-N; default 10)
  other?: boolean;                 // fold the rest into "Other" (sum/count only)
}
export interface ScatterWidget extends WidgetBase { type: "scatter"; x: string; y: string }
export interface TableWidget extends WidgetBase { type: "table"; columns: string[] /* 1..8 */; limit?: number /* 1..20 */ }
export type DashboardWidget = KpiWidget | SeriesWidget | ScatterWidget | TableWidget;

export interface DashboardSpec {
  version: 1;
  title: string;                   // <= 120 chars, escaped
  purpose: DashboardPurpose;
  layout: DashboardLayout;
  locale: DashboardLocale;
  sheet?: string;                  // table name of the sheet (XLSX); absent = `data`
  widgets: DashboardWidget[];      // 1..12, at most 6 kpi
}
/** Public provenance of an artifact made by dashboard_generate (artifact `provenance`). */
export interface DashboardProvenance {
  generator: "dashboard_generate";
  spec: DashboardSpec;
  planner: "rules" | "rules+decisions";
  decisionProvider?: string;       // id of the decision provider that answered at least one decision
  fallbacks: string[];             // human-readable, metadata only (e.g. "widget sales-trend dropped: query timeout")
}
```

### 5.2 Contratos internos de core (`packages/core/src/analysis/dashboard/`) **(nuevo)**

```ts
// profile.ts (pure)
export type ColumnRole = "time" | "measure" | "dimension" | "identifier" | "boolean" | "unknown";
export type CardinalityBucket = "binary" | "low" | "medium" | "high" | "very-high";
export interface ProfiledColumn {
  alias: string;                // "c1".."cN": opaque handle used toward the provider
  name: string; label: string;  // dataset column name / original header
  type: DatasetColumnWire["type"];
  role: ColumnRole; roleReason: string; // e.g. "name hint: id" (diagnostics, never sent)
  nullRatio: number; distinctRatio: number; cardinality: CardinalityBucket;
  span?: { days: number };      // time columns, from min/max
}
export function profileSheet(sheet: DatasetDetailWire["sheetDetails"][number]): ProfiledColumn[];

// candidates.ts (pure): shortlists measures<=8, dimensions<=8, time<=4, with a numeric score and tie-break by ordinal
export interface Candidates { measures: ProfiledColumn[]; dimensions: ProfiledColumn[]; time: ProfiledColumn[]; compositionDims: ProfiledColumn[] }
export function buildCandidates(columns: ProfiledColumn[]): Candidates;

// pack.ts (pure): the provider-agnostic Decision Pack (specs/alisio-decision-intelligence-v1.md, ADR-9)
export const SMART_DASHBOARD_PACK = { id: "smart-dashboard-v1", version: 1 } as const;
export function buildPack(input: { goal: string; locale: DashboardLocale; candidates: Candidates }): {
  request: DecisionRequest | null;                 // null when no question is worth asking
  interpret(response: DecisionResponse | null): Partial<PlanChoices>; // answers -> choices, by table, never by free text
};

// planner.ts (pure)
export interface PlanChoices { purpose: DashboardPurpose; primaryMeasure?: string; includeTrend: boolean; includeRanking: boolean;
  rankingDimension?: string; includeComposition: boolean; compositionDimension?: string; includeCorrelation: boolean }
export function ruleBasedChoices(input: { goal: string; candidates: Candidates }): PlanChoices;
export function planDashboard(input: { title: string; locale: DashboardLocale; choices: PlanChoices; candidates: Candidates; sheet?: string }): DashboardSpec;

// validate.ts (pure)
export type Validation = { result: "valid"; spec: DashboardSpec } | { result: "repaired"; spec: DashboardSpec; repairs: string[] } | { result: "fallback"; reasons: string[] };
export function validateSpec(spec: unknown, catalog: ProfiledColumn[]): Validation;

// query.ts (the only I/O besides the tool): AST -> SELECT, then DatasetService.query()
export type QueryAst = { table: string; select: SelectItem[]; where: Predicate[]; groupBy?: string[]; orderBy: Order[]; limit: number };
export function compileQuery(ast: QueryAst, catalog: ProfiledColumn[]): string;           // throws on any identifier outside the catalog
export function widgetQueries(spec: DashboardSpec, catalog: ProfiledColumn[], rows: number): WidgetQuery[];
export async function runQueries(queries: WidgetQuery[], run: (sql: string, maxRows: number) => Promise<QueryResult>, signal: AbortSignal): Promise<WidgetData[]>;

// render.ts (pure)
export function renderDashboard(spec: DashboardSpec, data: WidgetData[], assets: { css: string; boot: string; chartJs: string; baseCss: string }): string;
```

### 5.3 Herramienta

```ts
registry.register({
  name: "dashboard_generate", effect: "internal",
  inputSchema: objectSchema({
    datasetId: { type: "string", minLength: 1, maxLength: 64 },
    goal: { type: "string", maxLength: 500 },
    title: { type: "string", maxLength: 120 },
    locale: { type: "string", enum: ["en", "es"] },
    sheet: { type: "string", maxLength: 200 },
  }, ["datasetId"]),
  execute(input, context): Promise<ToolResult>,
});
```

Resultado: texto `Dashboard created: <title> — 4 KPIs · 3 charts · 1 ranking` (plantilla `en`/`es`), el bloque UI del artefacto (`artifactBlocks`, hay que extraerlo de `tools/analysis.ts` a un módulo compartido, §12) y un resumen compacto del plan (lista de widgets con título y tipo; sin probabilidades). Errores: `dataset_not_found` (de `getFor`), `no_usable_columns`, `plan_failed` (con la instrucción «use python_run»), `query_failed`. Un error nunca deja un artefacto parcial.

---

## 6. Algoritmos

### 6.1 Perfilador: reglas de rol (en este orden; la primera que aplica gana)

Definiciones: `rows` = filas de la hoja; `nonNull = rows - nulls`; `nullRatio = nulls / rows`; `distinctRatio = distinct / nonNull`; cubo de cardinalidad por `distinct`: `binary` = 2, `low` 3-8, `medium` 9-30, `high` 31-200, `very-high` > 200.

| # | Condición | Rol |
|---|---|---|
| 1 | `nonNull = 0` o `nullRatio > 0.95` | `unknown` |
| 2 | `type = date` | `time` |
| 3 | `type = boolean` | `boolean` |
| 4 | Nombre normalizado coincide con `(^\|_)(id\|uuid\|guid\|code\|codigo\|sku\|ref\|key\|folio\|nro\|num)(_\|$)` o termina en `_id`, y `distinctRatio ≥ 0.5` | `identifier` |
| 5 | `type = integer` y `distinctRatio ≥ 0.98` y `rows ≥ 20` (clave sustituta) | `identifier` |
| 6 | `type = integer` y `distinct ≤ 12` y el nombre no indica magnitud (tabla de pistas) | `dimension` (p. ej. trimestre, puntuación) |
| 7 | `type ∈ {integer, real}` | `measure` |
| 8 | `type = text` y `distinctRatio ≥ 0.9` y `rows ≥ 20` | `identifier` (identificador o texto libre) |
| 9 | `type = text` y `2 ≤ distinct ≤ 200` | `dimension` |
| 10 | resto (texto de cardinalidad muy alta, `distinct ≤ 1`) | `unknown` |

Pistas de nombre (normalizadas sin acentos, en inglés y español), en una tabla del módulo con pruebas propias: *magnitud* (`amount, total, sales, revenue, price, cost, profit, margin, qty, quantity, units, venta(s), ingreso(s), monto, importe, precio, costo, ganancia, utilidad, margen, cantidad, unidades`), *negativas para medida* (`lat, lon, lng, latitude, longitude, zip, postal, phone, telefono, year, anio`), *dimensión* (`category, status, type, region, channel, segment, seller, country, city, categoria, estado, tipo, canal, segmento, vendedor, pais, ciudad`), *tiempo preferente* (`date, fecha, time, created, order, pedido`).

**Puntuación para las listas cortas** (determinista; empate por `ordinal` ascendente): medida = `(1 - nullRatio) + 0.3·[pista de magnitud] - 0.5·[pista negativa] + 0.2·[min ≠ max]`; dimensión = `(1 - nullRatio) + 0.5·[distinct ∈ 3..12] + 0.25·[distinct ∈ 13..30] + 0.3·[pista de dimensión] - 0.5·[distinct > 100]`; tiempo = `(1 - nullRatio) + 0.3·[pista de tiempo] + 0.1·min(1, span.days/365)`. `span.days` sale de `Date.parse(min)`/`Date.parse(max)` (cadenas ISO del catálogo); si no se pueden interpretar, la columna se degrada a `unknown`. Dimensiones de composición: las de `2 ≤ distinct ≤ 8`.

### 6.2 Pack `smart-dashboard-v1` (dinámico) y reglas por defecto

Decisiones (≤ 8; cada una se omite si las reglas ya la resuelven o no hay candidatos), con claves de opción **alias** (`c1`..`c8`) para no depender de nombres de columna:

| Clave | Tipo | Se pregunta si | Valor por defecto por reglas |
|---|---|---|---|
| `purpose` | `select` (executive / operational / analytical) | siempre | Palabras del objetivo (en/es): «executive, overview, resumen, ejecutivo, kpi» → executive; «operational, monitor, status, operativo, estado» → operational; «analy, compar, explor, análisis» → analytical; si ninguna → executive |
| `primaryMeasure` | `select` (medidas) | ≥ 2 medidas | Primera medida aditiva (no tasa) que el objetivo nombra (§6.2, «Planificación según el objetivo»); si no, medida cuyo `label`/`name` coincide con el objetivo (tabla de sinónimos: sales/ventas/ingresos/revenue; profit/rentabilidad/utilidad/ganancia/margin; cost/costo/gasto; quantity/cantidad/unidades); si no, la de mayor puntuación |
| `includeTrend` | `boolean` | hay columna de tiempo y una medida | `true` |
| `includeRanking` | `boolean` | hay dimensión y (medida o recuento) | `true` |
| `rankingDimension` | `select` | ≥ 2 dimensiones | La de mayor puntuación con `distinct ≥ 3` |
| `includeComposition` | `boolean` | hay dimensión de composición | `true` si `purpose ≠ analytical` o la dimensión tiene ≤ 5 categorías |
| `compositionDimension` | `select` | ≥ 2 candidatas de composición | La de mayor puntuación distinta de `rankingDimension` si es posible |
| `includeCorrelation` | `boolean` | ≥ 2 medidas | `true` solo si `purpose = analytical` |

Desviación del plan: `includeKpis` **no** se pregunta (siempre se incluyen 2-4 KPIs si hay medidas, y solo el recuento de filas si no las hay: el código determinista basta, pregunta 7 de la regla de admisión). Cada `select` lleva `instruction` fija en inglés; el campo `language` de la petición es el `locale`. `state`: `{ goal: <objetivo truncado a 500 caracteres>, columns: [{ id, label (≤ 60), role, type, cardinality }] }`.

**Composición del plan** (`planDashboard`): KPIs: la medida principal con `sum`, más hasta 3 medidas adicionales (`sum` o `avg` según pista: precios/tasas → `avg`) y siempre «Rows» = `count(*)`; máximo 6. Tendencia: `line` (o `area` si `purpose = executive` y una sola serie) con `timeBucket` según el tramo: `span ≤ 60 d → day`, `≤ 420 d → week`, `≤ 1800 d → month`, `≤ 5400 d → quarter`, si no `year` (≤ 60 cubos). Ranking: `hbar` con `limit = 10`, `aggregation = sum` sobre la medida principal (o `count` si no hay medida). Composición: `donut` (2-5 categorías) con `limit = 5` y `other` (≤ 8 categorías: `hbar`). Correlación: `scatter` de las dos mejores medidas. Si `purpose ≠ executive` y quedan huecos, se añade `table` (hasta 8 columnas no identificadoras, 10 filas). **Orden por layout**: `executive-grid` = KPIs, tendencia, ranking+composición; `operational-grid` = KPIs, tabla, ranking, tendencia; `analytical-grid` = KPIs, tendencia, ranking, composición, dispersión, tabla.

**Planificación según el objetivo (E7c, `goal.ts`).** Las reglas leen qué columnas del catálogo nombra el objetivo (primeros 2 000 caracteres; el objetivo nunca llega a SQL: solo identificadores del catálogo). Una columna está nombrada cuando **todas** las palabras de su nombre para mostrar, su cabecera original o su nombre normalizado (salvo unidades como `cop`, `pct`) son palabras del objetivo, o cuando una de sus palabras es una palabra del objetivo que ninguna otra columna tiene (las palabras genéricas, como `total`, `net` o `amount`, nunca valen solas). Coincidencia por palabra completa, sin distinguir mayúsculas ni acentos, singular o plural y sinónimos simples en/es (tablas `MEASURE_SYNONYMS` y `DIMENSION_SYNONYMS` de `hints.ts`: seller/vendedor/salesperson, category/categoría, status/estado, discount/descuento...). Se conserva el orden del objetivo. Efectos: (1) medidas nombradas → KPIs (hasta 5 medidas + «Rows», máx. 6) y la primera aditiva pasa a ser la medida principal (gana a la de por defecto); una tasa nombrada es KPI `avg` pero nunca principal; (2) dimensiones nombradas → un gráfico cada una, en el orden del objetivo y antes de los extras por defecto, con la medida principal: `donut` si tiene 2-5 categorías, `hbar` (límite 10) en otro caso, y la dimensión que sería el ranking por defecto sigue siendo ese ranking; (3) una columna de tiempo nombrada manda en la tendencia; (4) los identificadores y las columnas sin valores nunca se usan como dimensión; (5) las palabras que nombran una columna no cuentan para elegir el `purpose` (una columna `status` no vuelve operativo el dashboard); (6) límite de 12 componentes: el planificador conserva el orden del objetivo y deja fuera, enteros, los gráficos que no caben, que aparecen en la línea `Not shown:` del resultado. Con un objetivo que no nombra columnas el plan no cambia.

### 6.3 Validador (tabla de reparación)

Validaciones de esquema (tipos, enums, ids únicos, límites 12/6), de datos (la columna existe en el catálogo; la medida es de rol `measure`; la dimensión temporal es de rol `time`; `metric: "*"` solo con `count`; `scatter` con dos medidas distintas) y de UX/seguridad (sin HTML, JS, SQL, rutas ni comandos: los campos de texto libre son solo `title`/`label` y se escapan). Reparaciones deterministas:

| Defecto | Reparación |
|---|---|
| `pie`/`donut` con > 6 categorías (`distinct` del catálogo, o `limit` > 6 sin `other`) | Convertir a `hbar` |
| Widget duplicado (mismo tipo, dimensión, métrica y agregación) | Eliminar el posterior |
| > 12 widgets o > 6 KPIs | Recortar por el orden de prioridad del layout |
| `limit` fuera de 1..20 | Acotar |
| Identificador usado como dimensión | Eliminar el widget |
| `scatter` sin dos medidas distintas | Eliminar el widget |
| Medida con `aggregation` no numérica (`sum`/`avg` sobre dimensión) | Cambiar a `count_distinct` o eliminar |
| `timeBucket` ausente con dimensión temporal | Calcularlo por el tramo (§6.2) |
| Spec sin ningún widget válido tras reparar | `fallback` |

`fallback` → replanificar con reglas puras (`ruleBasedChoices`); si también falla → error `plan_failed`. **Nunca se llama al LLM** para reparar.

### 6.4 Planificador de consultas (SQLite)

Todas las consultas: `FROM "<tabla>"`; el nombre de tabla es `data` o el de la hoja (del catálogo). Las medidas filtran `typeof("m") IN ('integer','real')` (una columna `integer` por muestra puede contener texto más adelante, §3). Los nulos de la dimensión se excluyen con `"d" IS NOT NULL`.

| Widget | Consulta | Notas |
|---|---|---|
| KPI `sum/avg/min/max` | `SELECT SUM("m") AS v FROM "t" WHERE typeof("m") IN ('integer','real')` | Sin filas válidas → KPI «—» |
| KPI recuento | `SELECT COUNT(*) AS v FROM "t"` | `count_distinct`: `COUNT(DISTINCT "d")` |
| Ranking / barras | `SELECT "d" AS k, SUM("m") AS v FROM "t" WHERE "d" IS NOT NULL AND typeof("m") IN (…) GROUP BY "d" ORDER BY v DESC, k ASC LIMIT <N>` | Desempate por `k` (determinismo). Con `other` y agregación `sum`/`count`: segunda consulta con el total y `Other = total − Σ top-N`; para `avg/min/max/count_distinct` no hay «Other» (nota «Top N of M») |
| Composición | Igual con `LIMIT 5` + «Other» | `pie`/`donut` solo con valores > 0 |
| Tendencia | `SELECT <cubo> AS k, SUM("m") AS v FROM "t" WHERE <cubo> IS NOT NULL AND typeof("m") IN (…) GROUP BY k ORDER BY k ASC LIMIT 400` | Solo cubos con datos (sin relleno de huecos); las fechas con zona horaria se agrupan en UTC (límite documentado) |
| Dispersión | `SELECT "x", "y" FROM "t" WHERE typeof("x") IN (…) AND typeof("y") IN (…) AND rowid % <stride> = 0 ORDER BY rowid LIMIT 500` | `stride = max(1, ceil(rows/500))`, muestreo determinista |
| Tabla | `SELECT "c1", … FROM "t" ORDER BY rowid LIMIT <N>` | ≤ 8 columnas, ≤ 20 filas |

Expresiones de cubo (SQLite): día `strftime('%Y-%m-%d', c)`; mes `strftime('%Y-%m', c)`; año `strftime('%Y', c)`; trimestre `strftime('%Y', c) \|\| '-Q' \|\| ((CAST(strftime('%m', c) AS INTEGER) + 2) / 3)`; semana (inicio en lunes) `date(c, '-6 days', 'weekday 1')`. **(no verificado)**: la documentación resumida sugiere `date(c,'weekday 1','-6 days')`, que por razonamiento da el lunes **anterior** cuando la fecha ya es lunes; la Fase 0 (E3) fija el idioma correcto con fechas límite (lunes, domingo, cambio de año) antes de implementar. Todo lo no entendido por SQLite devuelve `NULL` y queda fuera por el filtro.

Cada consulta se ejecuta secuencialmente por `DatasetService.query()` con el `AbortSignal` de la llamada; una consulta que supera el tiempo límite elimina **solo su widget** (anotado en `fallbacks`); si todas fallan → `query_failed`. Se emite progreso entre consultas.

---

## 7. Seguridad

### 7.1 Amenazas

| Amenaza | Mitigación |
|---|---|
| Inyección SQL desde el nombre de una columna (contenido de un CSV hostil) | Los nombres pasan por `sanitizeIdentifier` en la ingesta (`[a-z0-9_]`); además el planificador solo usa identificadores del catálogo y siempre `quoteIdent`; guarda SQL activa; lector de solo lectura |
| Inyección HTML/JS por etiquetas de columna, títulos o categorías | Todo texto pasa por escape HTML (`&`, `<`, `>`, `"`, `'`); el JSON del spec escapa `<`, `>`, `&` como `<`…; sin `eval`, sin `fetch`, sin CDN; el visor ya aísla con CSP y `sandbox` |
| El proveedor devuelve algo inesperado | Validación por clave del core (spec 1); los valores se traducen **por tabla** a alias de columnas; nunca texto libre al plan |
| Fuga de datos al proveedor | D4: solo etiquetas, rol, tipo y cubo de cardinalidad; nunca valores; el `state` está limitado y el core no lo registra |
| Lectura de un dataset ajeno | `datasets.getFor(id, rootOf(session))` (como `data_query`) |
| Denegación de servicio por datos enormes | Tiempo de 5000 ms por consulta, ≤ 1000 filas, ≤ ~20 consultas, 12 widgets, `rowid % stride` para la dispersión |
| Elevación de permisos | El efecto `internal` no abre ninguna capacidad nueva; no hay aprobación implícita |

### 7.2 Efecto de la herramienta (justificación)

`artifact_create` es `internal` y publica en el almacén de Alisio; `data_query` es `read` y lee un dataset de la sesión; ambos están siempre permitidos por `allowed(policy, effect)` (`core/runner.ts` l. 249) y los hijos en solo lectura no los excluyen (`children.ts` l. 113). `dashboard_generate` combina exactamente esas dos acciones sin añadir ninguna otra (ni proceso ni red ni escritura en el workspace), por tanto `internal` no debilita ningún permiso. Como publica artefactos, se registra bajo la condición de `artifact_create` (`analysisEnabled`), es decir, **no** aparece con `--read-only` ni con `analysis.enabled: false` (decisión D16). Desde `execute` (code mode) falla con «Artifacts are not available here» (el contexto anidado no lleva `artifacts`, verificado en `tools/execute.ts`).

---

## 8. Renderizador y extracción de activos

### 8.1 Qué se mueve (factible: verificado en `charts.py` y `html.py`)

| Origen (Python) | Destino | Efecto |
|---|---|---|
| `charts.py` `CSS = """…"""` (l. 39-68) | `alisio_runtime/charts.css` | `charts.py`: `CSS = _asset("charts.css")` |
| `charts.py` `_BOOT = r"""…"""` (l. 70-147) | `alisio_runtime/charts-boot.js` | `_BOOT = _asset("charts-boot.js")` |
| `html.py` `_CSS` (base de página) | `alisio_runtime/html-base.css` | `_CSS = _asset("html-base.css")` |
| — | `__init__.py` | `__version__ = "3"` |

`_asset(name)` lee `Path(__file__).with_name(name)` en UTF-8; si falta, avisa por `stderr` y devuelve `""` (mismo patrón que `library()`). `scripts/analysis-runtime-sources.ts` amplía el filtro a `/\.(py\|js\|txt\|css)$/` y `tests/analysis-runtime-sources.test.ts` también (más `charts.css`, `charts-boot.js`, `html-base.css` en `arrayContaining`). Se regenera `sources.ts` con `node --experimental-strip-types scripts/analysis-runtime-sources.ts`. La salida del Python debe ser **byte a byte** la de antes del cambio (prueba de no regresión: se compara `charts.page(...)` de una entrada fija antes/después en `tests/analysis-charts.test.ts`).

### 8.2 Contrato DOM del renderizador TS

Igual al de `charts.py` (§3): `figure.ac-chart.ac-pending[data-ac-chart=<kind>]` → `figcaption.ac-title`, `div.ac-box` con `--ac-h`, `canvas[role=img][aria-label]`, `details.ac-data[open]` con tabla (`td[data-v]` para números), `script[type="application/json"]` con `{v:1, kind, labels, series, fmt, …, stacked?, valueLabels?, smooth?, percents?, otherLast?, center?}`; `section.ac-card`, `div.ac-grid[style=--ac-min]`, `div.ac-kpis > div.ac-kpi`; página `<!doctype html>` con `<style>` (base + CSS), cuerpo y `<script>` de Chart.js (con `</script` escapado como `<\/script`) y `<script>` de arranque. Reglas heredadas que el renderizador debe replicar: `pie` solo valores > 0 y agrupa en «Other» con `otherLast`; `percents` redondeados a 2 decimales; `valueLabels` solo si `n·series ≤ 16`; alturas por defecto (`hbar`: `max(240, min(900, 56 + n·24))`; `pie/donut`: 340; resto 320). Formato de números: `fmt` (`{options, locale?, unit?}`) como `_fmt_spec`: `number` → `maximumFractionDigits: 2`; moneda y `percent` solo si una pista de nombre lo sugiere (si no, `number`). El renderizador añade `lang` según `locale`.

### 8.3 Prueba de paridad

`tests/dashboard-render-parity.test.ts`: para cada tipo de gráfico se genera el fragmento con Python (runtime incrustado, como `analysis-charts.test.ts`) y con el renderizador TS a partir de los mismos datos, y se compara **estructuralmente** (árbol de elementos, atributos `data-ac-chart`, clases, JSON del spec parseado, filas de la tabla), **no** por cadena. Se salta si no hay Python 3.10+.

### 8.4 Observación sobre el arranque heredado

El script de arranque usa `interaction: {mode:'index', intersect:false}` también para `hbar` sin `axis: 'y'`. Según la documentación de Chart.js el modo `index` busca por defecto en el eje x; para barras horizontales se recomienda `axis: 'y'` **(no verificado)**. No se cambia el comportamiento en esta entrega (la paridad con el runtime Python manda); se registra como mejora posible tras comprobarlo en la Fase 0 (E5).

---

## 9. Configuración (O3)

### 9.1 Clave nueva `analysis.smartDashboard`

```ts
// config.ts, dentro del bloque `analysis` (z.object(...).strict())
/** Smart Dashboard: offer dashboard_generate and steer the agent to it. false = the current Python flow. */
smartDashboard: z.boolean().default(true),
```

Se añade también `smartDashboard: true` al objeto de la función `.default(() => ({ ... }))` del bloque `analysis` si este enumera los valores por defecto (comprobar al editar). Las configuraciones existentes siguen siendo válidas (clave opcional con valor por defecto).

### 9.2 Superposición de capas

`analysis.smartDashboard` **no** es global-only (un proyecto puede apagar la herramienta). La rama `analysis` del bucle de capas reemplaza el bloque entero por el de la capa seleccionada, salvo `runtime`, `oci` y `retention` (verificado en `config.ts`, ~l. 672); eso haría que un bloque `analysis` de proyecto sin la clave restableciera `true` y deshiciera un `false` global. Se evita así: `parseLayer` devuelve el conjunto de claves crudas de `analysis` (`analysisKeys`, junto a `ignored`) y la rama usa `smartDashboard: analysisKeys.has("smartDashboard") ? selected.config.analysis.smartDashboard : global.config.analysis.smartDashboard`. Prueba en `config-layers.test.ts`: global `false` + proyecto con otro valor de `analysis` → sigue `false`; proyecto `false` + global `true` → `false`.

### 9.3 Ajuste en vivo

Clave ajustable `analysis.smartDashboard` (`SETTABLE_KEYS` ← `SETTABLE_SECTIONS.analysis.shape.smartDashboard`; etiqueta EN/ES obligatoria en `packages/web/src/components/settings/labels.ts`, exigida por `tests/web-i18n.test.ts`; entrada con descripción en `packages/cli/src/tui/settings.ts`, junto a `analysis.enabled`, ~l. 283). **Se aplica en el siguiente arranque de la aplicación**, igual que `tasks.enabled` y `analysis.enabled`: las herramientas y sus descripciones se construyen al crear la aplicación (verificado: comentario de `updateSetting` para `tasks.enabled`, `application.ts` ~l. 1369; la web recicla la aplicación del workspace). `updateSetting` gana el caso `analysis.smartDashboard` que actualiza `config.analysis`; la interfaz informa «applies the next time Alisio starts».

### 9.4 Efecto

| `analysis.smartDashboard` | Herramienta | Textos de guía (§10.1) |
|---|---|---|
| `true` (por defecto, con `analysis.enabled` y sin `--read-only`) | `dashboard_generate` registrada y ofrecida | Prefieren `dashboard_generate`; `python_run` queda para lo que el catálogo no cubre |
| `false` | No registrada (no aparece en `registry.list()` ni en `/tools`) | Idénticos a los de 0.3.0 (flujo Python), sin mención de `dashboard_generate` |

Los textos se generan con un parámetro `smartDashboard: boolean` en `AnalysisToolDeps` (`pythonRunDescription`, `artifact_create`), `DataToolDeps` (`data_inspect`/`data_query`) y `DatasetServiceOptions` (`describeDataset`/`promptSummary` reciben `{ maxChars, dashboard }`), de modo que el texto con `false` es **exactamente** el actual (prueba byte a byte contra constantes del test). El proveedor de decisiones sigue activándose solo por `decisions.provider` (spec 1).

---

## 10. Guía al modelo y progreso

### 10.1 Cadenas a cambiar (lista cerrada; cada una con prueba de contenido mínima)

| Archivo | Cadena | Cambio |
|---|---|---|
| `packages/core/src/tools/analysis.ts` (`pythonRunDescription`, ~l. 166-205) | «…charts (Chart.js bundled; pie/donut/bar/hbar/line/area/scatter…)…» y el párrafo de dashboards | Anteponer: «To build a dashboard from a dataset, prefer dashboard_generate (no code). Use python_run for analysis or visuals the dashboard catalog does not cover (statistical tests, custom or unsupported charts, joins, exports).»; el resto se mantiene |
| `packages/core/src/tools/data.ts` (`data_inspect`, l. ~59) | «…python_run { inputs: [{ datasetId }] }…» | Añadir «or dashboard_generate { datasetId }» |
| `packages/core/src/tools/data.ts` (`data_query`, l. ~164) | «Heavy analysis belongs in python_run.» | Añadir «A dashboard of a dataset: dashboard_generate.» |
| `packages/core/src/analysis/data/describe.ts` (`describeDataset`, línea de uso de la cabecera) | «Stored in SQLite: query it with data_query… or pass { datasetId } to python_run…» | Añadir «For a dashboard use dashboard_generate { datasetId, goal }.» |
| `packages/core/src/tools/analysis.ts` (`artifact_create`, ~l. 595) | «…dashboard.html…» | Añadir «For a data dashboard use dashboard_generate instead of writing the HTML.» |
| `packages/core/src/artifacts/chart-lint.ts` (`HELPERS`, aviso de recursos/SVG) | Nombra solo `alisio_runtime.charts`/`svg` | Añadir «or dashboard_generate» en los avisos |
| `packages/core/src/resources/context.ts` (PREAMBLE, vía `context.extras` en `application.ts`) y `packages/core/src/tools/dashboard.ts` | Prompt del sistema y descripción de `dashboard_generate` (añadido por E7, §14.1.1) | Añadir al prompt del sistema, solo con análisis activo e interruptor en `true`: «When the user asks for a dashboard (or KPIs and charts) of a dataset, call dashboard_generate first with the dataset id and the user's goal. Use python_run only if dashboard_generate returns an error or the request needs something its catalog does not cover (statistical tests, custom charts, joins, exports).»; en `python_run`, el párrafo de `alisio_runtime.charts` se sustituye por una línea (helpers `charts.*`/`svg.*` para visuales a medida más allá del catálogo); la descripción de `dashboard_generate` empieza por «Use this first whenever the user asks for a dashboard of a dataset.» |
| `docs/analysis.md` y `docs/es/analysis.md`, `docs/tools.md` y `docs/es/tools.md` | Flujo de dashboards con Python | Documentar el nuevo flujo y cuándo seguir usando `python_run` |

Los textos de UI que citan `python_run` (`packages/cli/src/tui/settings.ts` l. 283, `packages/web/src/i18n/{en,es}.ts` ~l. 773-795) describen un ajuste, no guían al modelo: no cambian salvo que el propietario pida mencionar la herramienta (ajustes `analysis.enabled`).

**Orden obligatorio:** esta lista **no se toca hasta** haber registrado la línea base A (Fase 0). Todo cambio de la tabla está condicionado a `analysis.smartDashboard = true` (§9.4).

### 10.2 Progreso

`dashboard_generate` emite con `context.emit`: `Analyzing dataset…\n`, `Planning dashboard…\n`, `Building <N> components…\n` (entre consultas, `Query i/N…`), `Dashboard ready\n`. Web: se reutiliza la cola ya conservada por `inflight.ts`; comprobar en la Fase 7 cómo la pinta `progress.ts` para una herramienta no terminal **(no verificado)**. TUI: `reduceEvent` gana el caso `tool_progress`: `updateTool(state, d.id, { progress: <última línea no vacía de data.data, ≤ 80 caracteres> })` y `ToolItemView.progress?` se muestra junto al resumen mientras `status = "running"`; se borra al completar. Se añaden `humanName`/`kind` de `dashboard_generate` en `toolKindOf`/la tabla de nombres de la TUI.

---

## 11. Benchmark (plan §13, §28)

### 11.1 Arnés `scripts/bench-dashboard.ts` (manual; fuera de `pnpm check`)

- **Datasets** (generados con PRNG con semilla fija `mulberry32`, en un directorio temporal; nunca se versionan): `sales`, `operations`, `inventory`, `tickets` y `opaque` (columnas `col_a`..`col_m`), en tres tamaños (1 000, 50 000, 500 000 filas), con fechas ISO, identificadores, medidas y dimensiones.
- **Variantes:** A = flujo actual: `analysis.smartDashboard = false` (§9; la herramienta no se ofrece y la guía es la de Python; el arnés escribe un `config.json` temporal en un `ALISIO_CONFIG_HOME` aislado); B = `analysis.smartDashboard = true` con `decisions.provider = null`; C = B con `decisions.provider = "laya"` (necesita `@alisio/plugin-laya`, plugin externo de `alisio-plugins`, instalado y activo; defaults del plugin `model: "multilingual"`, `preload: true`).
- **Parámetros por entorno (O5), entregados por el propietario en el momento de ejecutar:** `ALISIO_BENCH_MODEL` (id del modelo) y `ALISIO_BENCH_BASE_URL` (endpoint compatible con OpenAI); la clave sigue el mecanismo que ya usa el proveedor (`apiKeyEnv`, por defecto `OPENAI_API_KEY`, verificado en `config.ts`): el arnés **nunca la lee, imprime ni guarda**. Sin las dos variables el arnés termina con error de uso. **Todas las variantes (A, B, C) usan el mismo modelo**: el arnés pasa `--model $ALISIO_BENCH_MODEL --base-url $ALISIO_BENCH_BASE_URL` a cada ejecución y, al terminar, aborta y descarta la serie si algún `turn_completed.model` difiere de `ALISIO_BENCH_MODEL`.
- **Ejecución:** por dataset y variante, `alisio run --json --db <tmp> --cwd <ws> --allow-analysis --model $ALISIO_BENCH_MODEL --base-url $ALISIO_BENCH_BASE_URL "<prompt de dashboard>"`, 3 repeticiones; el prompt está fijado en el arnés (en inglés y en español).
- **Métricas** derivadas de lo persistido (no de lo que dice el modelo): suma de `turn_completed.usage` (`input`, `output`, `cachedInput`), número de `turn_completed` (turnos LLM), número de eventos `tool_started` (los nombres no están en `tool_calls`, verificado), uso de `python_run`, tiempo hasta `artifact_published`, advertencias de `chartWarnings` sobre el HTML publicado, tasa de éxito (hay artefacto `dashboard` sin error), igualdad de spec entre repeticiones (B/C, por hash del `DashboardSpec` de la procedencia), componentes usados.
- **Salida:** `docs/benchmark-dashboard.json` (versionado, pequeño; excluido del sitio añadiéndolo a `srcExclude` de `docs/.vitepress/config.ts` y a `SITE_EXCLUDE` de `scripts/docs-check.ts`, como `benchmark.json`) con entorno (versión de Alisio, plataforma), **`model`** y **`endpointHost`** (solo `URL.host` del endpoint: sin esquema con credenciales, ruta ni consulta; **nunca la clave de API**) y una tabla A/B/C como la del plan §28. La biblioteca común (`scripts/bench/lib.ts`: lectura de parámetros, ejecución de `alisio run --json`, lectura de eventos persistidos, comprobación de modelo único, escritura del JSON sin secretos) es nueva en esta entrega y la reutilizan `bench-routing.ts` y `bench-model-tier.ts`. Una prueba unitaria de la biblioteca (`tests/bench-lib.test.ts`, sin red) comprueba que el JSON no contiene la clave sembrada en el entorno y que el host se recorta.

### 11.2 Puerta hacia 0.5.0 (O6, confirmada)

La especificación `specs/alisio-capability-routing-v1.md` solo empieza si la variante B cumple, frente a la variante A y con el mismo modelo, **todas** estas condiciones: (1) ≥ 50 % menos tokens de salida; (2) ≥ 40 % menos turnos LLM (conteo de `turn_completed`); (3) 100 % de los `DashboardSpec` ejecutados válidos; (4) 0 avisos de `chart-lint` sobre el HTML publicado. Métricas informadas sin puerta: tiempo hasta el artefacto, tokens de entrada, llamadas a herramientas, igualdad de spec entre repeticiones y la variante C (que depende de que el plugin exista; se marca «pendiente» si no está instalado y no bloquea la puerta). Los resultados se registran en `docs/benchmark-dashboard.json`; la utilidad de los dashboards se revisa a mano sobre una muestra y se anota.

---

## 12. Archivos por paquete

| Paquete | Nuevo | Modificado |
|---|---|---|
| sdk | — | `src/index.ts` (§5.1) |
| core | `src/analysis/dashboard/{profile,candidates,pack,planner,spec,validate,query,render,labels,hints,index}.ts`, `src/tools/dashboard.ts`, `src/tools/artifact-blocks.ts` (extrae `describeArtifact`/`artifactBlocks`), `src/analysis/python/alisio_runtime/{charts.css,charts-boot.js,html-base.css}` | `src/analysis/python/alisio_runtime/{charts.py,html.py,__init__.py}`, `src/analysis/python/sources.ts` (generado), `src/tools/{analysis,data}.ts`, `src/analysis/data/describe.ts`, `src/artifacts/chart-lint.ts`, `src/core/contracts.ts` + `src/artifacts/publisher.ts` (`provenance?` en `publishTextDetailed`), `src/application.ts` (registro bajo `analysisEnabled && config.analysis.smartDashboard`, `updateSetting`), `src/config.ts` (`analysis.smartDashboard`, `analysisKeys`, `SETTABLE_KEYS`), `src/index.ts` |
| server | — | Ninguno funcional |
| web | — | `src/components/settings/labels.ts` (etiqueta de `analysis.smartDashboard`), `src/store/progress.ts` (si hace falta, §10.2), `src/components/artifacts/ArtifactDetails.tsx` (fila «Dashboard» con planificador y `decisionProvider`), `src/i18n/{en,es}.ts` |
| cli | — | `src/tui/settings.ts` (descripción de `analysis.smartDashboard`), `src/tui/state.ts` (`tool_progress`, `ToolItemView.progress`, nombre de herramienta), `src/tui/app.ts` (pintado del progreso) |
| scripts | `scripts/bench-dashboard.ts`, `scripts/bench/lib.ts` | `scripts/analysis-runtime-sources.ts`, `scripts/docs-check.ts` |
| tests | `bench-lib.test.ts`, `dashboard-profile.test.ts`, `dashboard-candidates.test.ts`, `dashboard-pack.test.ts`, `dashboard-planner.test.ts`, `dashboard-validate.test.ts`, `dashboard-query.test.ts`, `dashboard-render.test.ts`, `dashboard-render-parity.test.ts`, `dashboard-tool.test.ts`, `dashboard-golden.test.ts`, `tests/golden/dashboard/*.json` | `analysis-runtime-sources.test.ts`, `analysis-charts.test.ts` (no regresión), `chart-lint.test.ts` |
| docs | `docs/smart-dashboard.md`, `docs/es/smart-dashboard.md`, `docs/benchmark-dashboard.json`, `docs/assets/web-ui/smart_dashboard_web_ui.webp`, `docs/assets/web-ui/smart_dashboard_progress_web_ui.webp` | `docs/.vitepress/config.ts`, `docs/{analysis,tools,limitations,contributing}.md` + ES, `docs/implementation-status.md`, `CONTRIBUTING.md`, `CHANGELOG.md` |

---

## 13. Estrategia de pruebas

| Nivel | Qué | Archivo |
|---|---|---|
| Perfil | Cada fila de §6.1: numérico, texto, fechas ISO y no ISO (→ `text`), identificadores (por nombre y por unicidad), columnas casi nulas, dimensiones de alta cardinalidad, enteros de baja cardinalidad, columna `integer` con texto tardío | `dashboard-profile.test.ts` |
| Candidatos | Listas ≤ 8/8/4, puntuación y desempate estables, orden idéntico entre ejecuciones | `dashboard-candidates.test.ts` |
| Pack | Omite preguntas sin candidatos (sin tiempo → sin `includeTrend`; una medida → sin `includeCorrelation`); opciones con alias; `state` **sin** valores de celdas ni `top_values` (centinelas sembradas en los datos); límites del contrato de decisiones | `dashboard-pack.test.ts` |
| Planificador | Sin proveedor = reglas; proveedor total, parcial (rechazos) y malicioso (alias inexistentes) producen specs válidos; resultado idéntico para el mismo dato y objetivo; sobrescritura clave a clave | `dashboard-planner.test.ts` |
| Validador | Cada fila de §6.3; spec con SQL/HTML en `title` se escapa o se rechaza; ids duplicados; límite 12/6; `fallback` → replanificación | `dashboard-validate.test.ts` |
| Consultas | Agregaciones, orden y desempate, nulos, `typeof`, `LIMIT`, «Other», cubos (incluidas fechas límite de semana/trimestre/cambio de año con `node:sqlite`), identificadores entrecomillados con nombres adversos, **cualquier identificador fuera del catálogo lanza**, la guarda SQL sigue activa (una consulta manipulada es rechazada por `guardSql`) | `dashboard-query.test.ts` |
| Renderizador | Estructura DOM (no instantáneas): figuras, `aria-label`, tabla accesible, JSON parseable, `</script` escapado, ningún `http(s)://` ni `fetch`/`eval`, textos escapados; pasa `chartWarnings` sin avisos; tema claro/oscuro presente | `dashboard-render.test.ts` |
| Paridad | §8.3 (salta sin Python); no regresión byte a byte de `charts.page` | `dashboard-render-parity.test.ts`, `analysis-charts.test.ts` |
| Herramienta (integración) | `dataset → plan → spec → consultas → HTML` con y sin proveedor, con el doble `tests/fixtures/decision-provider.ts` de la especificación 1 (modos `ok`, `partial`, `hang`, `throw`, `lowConfidence`): siempre hay artefacto válido; XLSX con `sheet`; dataset ajeno rechazado; procedencia con `decisionProvider`; bajo `--read-only` la herramienta no existe; progreso emitido | `dashboard-tool.test.ts` |
| Golden | 5 datasets de ≤ 40 filas (ventas, operaciones, inventario, tickets, opaco) × objetivos `en`/`es` → `DashboardSpec` esperado | `dashboard-golden.test.ts` |
| Interruptor (O3) | **`analysis.smartDashboard = true`**: la herramienta está registrada y los cinco textos de §10.1 contienen `dashboard_generate`; **`false`**: la herramienta no está en `registry.list()` y cada texto es **idéntico byte a byte** al actual (constantes del test) y no contiene `dashboard_generate`; capas (§9.2); clave ajustable con etiqueta EN/ES y `updateSetting` | `analysis-python-run.test.ts` (ampliado) o `dashboard-tool.test.ts` |
| TUI/web | `reduceEvent` con `tool_progress`; etiquetas EN/ES | `tui-*.test.ts` existentes, `web-i18n.test.ts` |

---

## 14. Plan por fases

### 14.1 Fase 0 — Línea base y experimentos (3-4 días)

**Entrega:** arnés `scripts/bench-dashboard.ts` y **línea base A registrada antes de cambiar la guía**; tabla de experimentos confirmada por el propietario.

| # | Experimento | Pasos | Resultado esperado |
|---|---|---|---|
| E1 | Estadísticas suficientes | Perfilar 5 datasets generados con el perfilador prototipo usando solo `_alisio_columns` | Si falta una estadística (p. ej. varianza), añadirla de forma aditiva a `stats.ts`; si no, ninguna pasada nueva |
| E2 | Coste de consultas | Ejecutar las consultas de §6.4 sobre 50 000 y 500 000 filas con `DatasetService.query` | Todas < 5000 ms; si no, bajar el número de widgets o usar muestreo y documentarlo |
| E3 | Cubos de fecha en `node:sqlite` | Probar `strftime`/`date` con ISO con `T`, `Z`, `+05:30`, fracciones, y lunes/domingo/31-dic | Fija la expresión de semana correcta (§6.4) y el comportamiento con zona horaria (UTC) |
| E4 | Equivalencia de fragmentos | Generar con Python un dashboard de cada tipo y comprobar qué atributos conserva el visor/lint | Fija la lista exacta del contrato DOM de §8.2 |
| E5 | Tooltip de `hbar` | Abrir en navegador el dashboard Python con `hbar` multi-serie | Decide si mejorar `interaction.axis` en una entrega aparte |
| E6 | Variante A | Ejecutar el arnés con el modelo y el endpoint que entregue el propietario (O5) y `analysis.smartDashboard = false` sobre los 15 datasets × 3 repeticiones | Línea base A en `docs/benchmark-dashboard.json` (con `model` y `endpointHost`) |
| E7 | Selección de la herramienta | Con la guía nueva y `analysis.smartDashboard = true`, medir cuántas veces el modelo elige `dashboard_generate` frente a `python_run` | Si < 80 %, reforzar el texto de §10.1 |

#### 14.1.1 Resultados de la Fase 0 (E1-E5 ejecutados el 2026-10-03; vinculantes para las Fases 1-9)

| # | Observado | Efecto en esta especificación |
|---|---|---|
| E1 | Las reglas de roles de D2 funcionan con las estadísticas actuales de `_alisio_columns` en 8 datasets (generados, los dos CSV de `examples/data` y una muestra 311). | `stats.ts` no cambia (D2 confirmado). |
| E2 | Consulta más lenta: 370 ms con 500 000 filas (límite 5000 ms). | Sin muestreo. Una tendencia con más de 400 cubos pierde la cola en silencio con `ORDER BY k LIMIT 400`: el planificador elige el `timeBucket` más grueso que deje ≤ 400 cubos (día → semana → mes → trimestre → año) en lugar de truncar. |
| E3 | `date(c,'-6 days','weekday 1')` acierta los 1461 días de 2020-2023; `date(c,'weekday 1','-6 days')` falla en los 1461. `+05:30` y `Z` se normalizan a UTC. Un texto como `"2024"` se interpreta como día juliano. | Expresión de semana de §6.4 **verificada**: `date(c,'-6 days','weekday 1')`. Todo cubo añade en el `WHERE` la guarda `c GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]*'`. |
| E4 | `chart-lint` y el visor no dependen del marcado `ac-*`; las 9 páginas generadas pasan el lint. El contrato DOM solo importa entre el renderizador y el script de arranque. | §8.2 confirmado; la lista exacta de elementos y atributos es la del script de arranque. |
| E5 | En `hbar` el tooltip falla en el eje y (al pasar sobre una fila muestra otra); `interaction.axis: 'y'` lo corrige en las 12 pruebas. | Fuera de esta entrega (paridad con Python): se corrige en un cambio aparte que toque ambos renderizadores. |
| Arnés | `scripts/bench/lib.ts`, `scripts/bench-dashboard.ts` y `tests/bench-lib.test.ts` (42 pruebas). Datasets: `sales-es-300` y `sales-es-4000` (de `examples/data`, leídos en su sitio), generados `sales`/`operations`/`inventory`/`opaque` (1 000, 50 000 y 500 000 filas) y `tickets-311` (descarga en tiempo de ejecución: NYC 311 de enero de 2019, primeras 50 000 filas por `unique_key`, SHA-256 fijado). El resultado registra el origen de cada dataset. | La variante A no escribe `analysis.smartDashboard` mientras la clave no exista (el esquema estricto la rechazaría); B y C se niegan hasta la Fase 5. La licencia del dataset 311 queda **pendiente de confirmación del propietario**; sin ella se usa el `tickets` generado. |
| P0.4 Laya real (2026-10-03) | Laya 0.3.24 real sobre 375 decisiones etiquetadas construidas exactamente como el pack `smart-dashboard-v1` (~la mitad en español; datos completos en `../alisio-plugins/specs/alisio-plugin-laya-v1.md` §16). `purpose` (select, checkpoint multilingüe): 90 % de acierto. Selects de columna (`primaryMeasure`, `rankingDimension`, `compositionDimension`) y booleanos (`includeTrend`, `includeRanking`, `includeComposition`, `includeCorrelation`, KPIs): cerca del azar; el multilingüe responde `true` el 78 % de las veces frente al 52 % de las etiquetas. Latencia en CPU creciente con el número de preguntas: una petición de ~7 decisiones p50 2,1 s / p95 3,1 s en una máquina ocupada (por encima del tiempo límite por defecto de 1500 ms); una sola decisión p50 0,30 s. | El proveedor solo recibe las preguntas donde la evidencia muestra que supera a las reglas: en v1, `purpose`. Lista explícita `PROVIDER_DECISIONS` en `pack.ts`; añadir una clave exige nueva evidencia medida (regla de admisión de `CONTRIBUTING.md`). Las reglas deciden el resto; una respuesta a una clave fuera de la lista se ignora (defensa en profundidad). La petición pasa a una decisión y cabe en el tiempo límite. El id `smart-dashboard-v1` no cambia (sin publicar). |
| E6 línea base A (2026-10-03) | 45 ejecuciones de `@alisio/alisio-code@0.3.0` publicado con `deepseek-flash` (`api.deepseek.com`), 15 datasets × 3. Medianas: 23 turnos, 30 llamadas a herramientas (todas usan `python_run`), 46 281 tokens de salida, 672 393 de entrada (643 072 en caché), 2 min 39 s hasta el dashboard; 0 avisos de lint. Éxito limpio 20/45; 13 publicaron y luego fallaron, 8 fallaron sin publicar, 4 terminaron sin publicar. Causa diagnosticada: el presupuesto acumulado de tokens por ejecución (`Token budget exhausted`, 1 000 000 por defecto cuando el proveedor no declara ventana de contexto, `runner.ts`); el flujo con Python consume 850 000-1 000 000 tokens por ejecución. Sin errores de proveedor. | La línea base es **válida y conservadora para la puerta de §11.2**: las ejecuciones cortadas por presupuesto infravaloran los tokens y turnos de A, lo que juega en contra de B. La tasa de éxito de A no se usa como argumento sin desglosar la causa. Para B y C el arnés registra el motivo de fallo por ejecución (`failureReason`, `failureClass`) y el agregado `failureReasons`. |
| E7 (2026-10-03) | 3 ejecuciones de humo con `deepseek-flash` y `analysis.smartDashboard: true`: `dashboard_generate` se ofreció en todas (verificado en la petición capturada) pero el modelo nunca la llamó; inspeccionó datos, ejecutó `data_query`, introspeccionó `alisio_runtime` con `python_run` (`inspect.getsource(charts.page)`) y construyó el dashboard a mano. El prompt del sistema (5 972 caracteres) no mencionaba `dashboard_generate` y la descripción de `python_run` conservaba el párrafo largo de `alisio_runtime.charts`. Selección < 80 %. | Decisión del responsable: reforzar en tres puntos, solo con `true` (el estado `false` no cambia, digests intactos): regla en el prompt del sistema (§10.1), párrafo de charts de `python_run` reducido a un puntero y descripción de `dashboard_generate` que empieza por «Use this first…». Se vuelve a medir E7 con 6 ejecuciones antes de cualquier benchmark completo. |
| E7b (2026-10-03) | 2 ejecuciones B con `--keep` (`sales` 1000, en, `deepseek-flash`), eventos persistidos reconstruidos. Secuencia en ambas: `memory_context`/`list_files`/`data_inspect`, 1-9 `data_query`, `dashboard_generate` (a veces un primer intento con `goal` > 500 caracteres, error de esquema), y **después** de un `dashboard_generate` correcto, 10-15 `python_run` (introspección de `alisio_runtime`, reconstrucción completa con `charts.*` y publicación de 1-3 dashboards adicionales, comprobaciones con `artifact_read`). Causa: el modelo escribe un `goal` con categorías, vendedores, descuentos y estado de pedido, pero el planificador de reglas ignora el `goal` y el layout ejecutivo recorta a 5 KPI + 3 gráficos (ingresos por mes, por región, por canal); el resultado («5 KPIs · 2 charts · 1 ranking», con la nota `decisions: no usable answer, rules used`, que suena a fallo) deja ver que faltan justo las dimensiones pedidas y el modelo lo reconstruye. | Cambio, solo con `true` (digests del estado `false` intactos): el resultado de `dashboard_generate` añade `Measures:` y `Dimensions:` (columnas realmente usadas), `Not shown:` (columnas que el `goal` nombra y el dashboard no usa, con la instrucción de decirlo en el resumen) y una línea final `Status:` («The dashboard is complete and already published. Next step: give the user a short summary of it. To change it, call dashboard_generate again with another goal; do not rebuild it with python_run.»; `Estado:` en es); las notas `decisions:` ya no se muestran al modelo (siguen en `provenance.fallbacks`). Re-medición B (4 ejecuciones): 1 de 4 sin `python_run` (4 turnos, 2 688 tokens de salida); las otras 3 siguen con 10-15 `python_run` y 19-24 turnos, así que **el texto no basta**: el modelo reconstruye porque el plan no cubre lo que pidió. Siguiente palanca (no aplicada): que el planificador de reglas promueva a gráficos las dimensiones que el `goal` nombra (hasta el límite de 12 componentes). |
| E7c (2026-10-03) | 4 ejecuciones B con `--keep` (`deepseek-flash`; `sales` 1000 en ×2 y `sales-es-300` es ×2) tras E7b. El `goal` del modelo nombra columnas concretas (categoría, vendedor, descuento, estado), pero el planificador de reglas las ignora: 5 KPI + gráficos por mes, región y canal, y el resultado las lista como «Not shown»; el modelo reconstruye todo con `python_run` (10-15 llamadas, dashboards extra). Una ejecución falló además porque el `goal` superaba el límite de 500 caracteres. Con el texto `Status:` solo 1 de 4 ejecuciones terminó limpia (medianas 21 311 tokens de salida y 18 turnos frente a 46 281 y 23 de la línea base A). | Cambio, solo con `true` (digests del estado `false` intactos): planificación según el objetivo en reglas, local y determinista (§6.2, «Planificación según el objetivo»): las medidas nombradas son KPI y la primera aditiva es la principal; cada dimensión nombrada recibe un gráfico en el orden del objetivo antes de los extras por defecto; los identificadores nunca son dimensión; lo que no cabe en 12 componentes se lista en `Not shown`. El `goal` admite 2 000 caracteres (más largo: se trunca con una nota, no es error) y al proveedor solo llegan los primeros 500. Se mantienen el texto `Status:` y `Not shown`. Re-medición B (4 ejecuciones, `sales` 1000 en ×2: 20 y 17 turnos, 41 748 y 27 721 tokens de salida, 1 y 2 `dashboard_generate`, 11 `python_run` cada una; `sales-es-300` es ×2: 8 y 8 turnos, 5 463 y 6 841 tokens, 2 `dashboard_generate`, 0 `python_run`; ninguna fallo). Medianas: 17 281 tokens de salida y 12,5 turnos frente a 46 281 y 23 de A. En `sales-es-300` el plan cubre lo pedido y el modelo ya no reconstruye. En `sales` 1000 el plan también cubre todas las dimensiones nombradas (solo falta `order_id`, un identificador) y el modelo reconstruye igualmente, porque su `goal` pide además métricas derivadas (margen, comparación interanual, tasa de cancelados, tabla cruzada) que el catálogo no tiene. |
| B/C (2026-10-03) | Diseño reducido por decisión del propietario: **B = 15 ejecuciones, 1 repetición por dataset** (A tuvo 45 = 3 repeticiones), C = 5 ejecuciones (`sales`, `opaque` e `inventory` de 1000 filas, `sales-es-300`, `tickets-311`), informativa; B y C en paralelo (el tiempo hasta el artefacto no es comparable y no es condición de la puerta); `deepseek-flash`, prompt en inglés, guía y planificador de E7b/E7c. Medianas B: 33 098 tokens de salida (A 46 281), 21 turnos (A 23), 29 llamadas, 502 399 de entrada (491 904 en caché), 12,9 s hasta el dashboard; 15/15 llamaron a `dashboard_generate`, 15/15 usaron además `python_run` (orden no registrado en B: no se conservaron las bases), 3 ejecuciones cortadas por `Token budget exhausted` tras publicar; 15/15 specs válidos; 0 avisos de lint. Medianas C: 28 904 tokens de salida, 17 turnos, 22 llamadas, 9,7 s; 5/5 `dashboard_generate`, 4/5 con `python_run` después; Laya respondió en 4/5 (`rules+decisions`, 271-561 ms) y 1/5 `all_rejected`; sin fallos. Totales (salida / entrada): A 2 285 446 / 30 789 204, B 571 920 / 9 320 647, C 194 413 / 2 163 938. Puerta §11.2 (solo B frente a A): (1) salida: -28,5 % frente a ≥ 50 % exigido, **FALLA**; (2) turnos: -8,7 % frente a ≥ 40 %, **FALLA**; (3) 100 % de `DashboardSpec` válidos: 15/15, **CUMPLE**; (4) 0 avisos de lint: 0, **CUMPLE**. **Veredicto: la puerta FALLA** (condiciones 1 y 2). | Con 1 repetición por dataset, las medianas de B son menos estables que las de A. La selección de la herramienta ya no es el problema (100 %); el ahorro se pierde porque el modelo sigue reconstruyendo con `python_run` tras un `dashboard_generate` correcto (pide métricas derivadas que el catálogo no tiene, E7c), y la línea base A está limitada por presupuesto, por lo que la reducción medida de B está subestimada (juega en contra de B, como se anticipó en E6). Decisión pendiente del propietario: iterar sobre la guía y el catálogo o aceptar el resultado. |

E6 registrada (fila anterior; resultados en `docs/benchmark-dashboard.json`). E7 se ejecuta tras la Fase 6.

### 14.2 Fase 1 — Perfil, candidatos y pack (M)

- **Entregables:** `profile.ts`, `candidates.ts`, `hints.ts`, `pack.ts`; tipos SDK.
- **Aceptación:** `dashboard-profile`, `-candidates`, `-pack` verdes; el `state` no contiene valores de datos.
- **Docs:** ninguna aún.

### 14.3 Fase 2 — Planificador, `DashboardSpec` y validador (M)

- **Entregables:** `planner.ts`, `spec.ts`, `validate.ts`, `labels.ts`; golden de specs.
- **Entregables adicionales (O7):** `tests/golden/dashboard/*.json` (≤ 5 datasets de ≤ 40 filas) y la **excepción documentada** en `CONTRIBUTING.md` y `docs/contributing.md` + `docs/es/contributing.md` (paridad EN/ES).
- **Aceptación:** `dashboard-planner`, `-validate`, `-golden` verdes; el 100 % de los specs ejecutados pasan validación; un proveedor malicioso nunca produce un spec inválido.

### 14.4 Fase 3 — Planificador de consultas (M)

- **Entregables:** `query.ts`; ejecución por `DatasetService.query`.
- **Aceptación:** `dashboard-query.test.ts` verde; tiempos de E2 dentro del límite.

### 14.5 Fase 4 — Extracción de activos y renderizador (L)

- **Entregables:** §8 completo (archivos de activos, `charts.py`/`html.py` leyéndolos, `__version__ = "3"`, generador y prueba ampliados, `render.ts`).
- **Aceptación:** no regresión byte a byte del Python; `dashboard-render` y la paridad verdes; `chartWarnings` sin avisos.

### 14.6 Fase 5 — Herramienta `dashboard_generate` (M)

- **Entregables:** `tools/dashboard.ts`, `publishTextDetailed` con `provenance?`, registro bajo `analysisEnabled`, fila de procedencia en la web.
- **Aceptación:** `dashboard-tool.test.ts` verde con y sin proveedor; la herramienta no existe con `--read-only`; XLSX por `sheet`; el resultado cabe en el visor actual.

### 14.7 Fase 6 — Guía al modelo (S)

- **Entregables:** cambios de §10.1 (después de registrar A), todos condicionados a `analysis.smartDashboard` (§9): clave de configuración, superposición de capas (`analysisKeys`), ajuste en vivo con etiquetas EN/ES y descripción en la TUI, y parámetro `smartDashboard` en los generadores de texto.
- **Aceptación:** E7 ≥ 80 % de selección de `dashboard_generate` en el arnés; pruebas del interruptor en ambos estados verdes (§13); con `false` los textos son idénticos a los de 0.3.0.

### 14.8 Fase 7 — Progreso en TUI y web, capturas (M)

- **Entregables:** §10.2; capturas reales con Playwright contra un `alisio serve` construido y un proveedor falso con datos de ejemplo realistas (sin títulos de sesión, correos ni tokens reales): `smart_dashboard_web_ui.webp` (dashboard resultante) y `smart_dashboard_progress_web_ui.webp`; conversión a WebP (< 150 KB); borrar temporales y `.playwright-mcp/`; colocadas junto al párrafo correspondiente en EN y ES con texto alternativo y pie en cada idioma; sin reutilizar en secciones TUI.
- **Aceptación:** TUI muestra la última línea de progreso; la web muestra la cola; `pnpm web:size` dentro del presupuesto (90 KB gzip JS / 20 KB CSS).

### 14.9 Fase 8 — Benchmark B y C y documentación (M)

- **Entregables:** variantes B y C registradas en `docs/benchmark-dashboard.json` (C requiere `@alisio/plugin-laya` instalado y activo; si aún no existe, C se marca «pendiente» y no bloquea la release); tabla comparativa en `docs/smart-dashboard.md` (+ ES); `docs/analysis.md`, `tools.md`, `limitations.md` (+ ES); `docs/implementation-status.md` en español con límites (fechas no ISO sin tendencia, UTC en zonas horarias, un dataset por llamada, sin filtros interactivos).
- **Aceptación:** paridad EN/ES (mismos encabezados y bloques de código); `pnpm docs:check` y `docs:build` verdes.

### 14.10 Fase 9 — Release (S)

- **Entregables:** bump manual de los 7 paquetes publicados (+ `packages/web` privado y raíz) a la siguiente minor (esperada 0.4.0); entrada de `CHANGELOG.md` en inglés (`### Added`: «`dashboard_generate`: a deterministic dashboard builder; works without code and without a decision provider»; `### Improved`: guía de `python_run`); `pnpm changelog:data`; gate completo verde (`typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build`); publicación según `.agents/skills/alisio-publish/SKILL.md` (nunca `npm publish` directo).
- **Compatibilidad con `alisio-plugins`:** el contrato de decisiones y `api.options`/`api.paths` deben seguir siendo compatibles hacia atrás; **ejecutar el *smoke test* de `plugin-laya` contra la versión candidata antes de publicar**; cualquier cambio incompatible en esa superficie exige avisar antes a `alisio-plugins` (el plugin declara peer `>=0.3.0 <0.7.0`).

---

## 15. Definición de terminado y registro de riesgos

**Definición de terminado (por fase):** gate completo verde; pruebas primero; sin cambios de semántica en contratos existentes; paridad EN/ES; capturas reales para UI web; `docs/implementation-status.md` actualizado; el Python del runtime produce la misma salida que antes de la extracción; el core no nombra proveedores.

| Riesgo | Impacto | Cómo y cuándo se verifica |
|---|---|---|
| Las reglas producen dashboards «correctos pero planos» y el modelo prefiere `python_run` | La feature no se usa | E7 y benchmark B vs A (Fases 0, 6, 8) |
| El tipo `date` solo para ISO deja sin tendencia a CSV con fechas `dd/mm/aaaa` | Dashboards sin serie temporal | Documentado como límite; el benchmark incluye un dataset con fechas no ISO; mejora futura fuera de alcance |
| Una columna `integer` inferida por muestra contiene texto más abajo | Sumas erróneas | Filtro `typeof(...)` en toda medida (§6.4) y prueba específica |
| `date(c,'weekday 1','-6 days')` (resumen de la documentación) da el lunes anterior | Semanas desplazadas | E3 y prueba con fechas límite; se usa `date(c,'-6 days','weekday 1')` **(no verificado)** hasta entonces |
| Consultas > 5000 ms en datasets grandes | Widgets perdidos | E2; el widget se elimina y se anota en `fallbacks`; si todos fallan, `query_failed` |
| Deriva entre el renderizador TS y `charts.py` | UI inconsistente | Fuente única de activos + paridad estructural + no regresión byte a byte |
| La clave de procedencia `provider` ya existe (proveedor del modelo) | Sobrescribir/mostrar mal el proveedor | Se usa `decisionProvider` (D15, ADR-6); prueba de que `provider` del modelo se conserva |
| La procedencia incluye el spec completo y se expone por `GET /api/artifacts/:aid` | Etiquetas de columnas visibles al cliente (ya visibles en el dashboard) | Aceptado: el spec solo contiene nombres/etiquetas y números de configuración, no valores; revisar el tamaño (< 8 KB) |
| La TUI descarta `tool_progress` | Sin progreso en TUI | Se añade (Fase 7) |
| La web no pinta la cola para herramientas no terminales | Sin progreso en web | Se comprueba al inicio de la Fase 7 **(no verificado)** |
| Con `--read-only` la herramienta no existe (efecto `internal`, registro bajo `analysisEnabled`) | Quien usa solo lectura no tiene dashboards deterministas | Limitación aceptada (D16), documentada en `docs/limitations.md` (+ ES) e `implementation-status.md` |
| `analysis.smartDashboard` en `false` global deshecho por un bloque `analysis` de proyecto | Herramienta ofrecida contra la voluntad del usuario | §9.2 (`analysisKeys`) y prueba de capas |
| El arnés depende de un modelo real y de Python para la variante A | No reproducible en CI | Es manual por diseño; el entorno y el modelo se registran en el JSON de resultados |
| Resultados del benchmark con modelos distintos por variante | Comparación inválida | O5: modelo único por serie, comprobado contra `turn_completed.model`; el JSON registra modelo y `endpointHost` (nunca la clave) |
| Excepción de pruebas golden frente a `AGENTS.md` | Revisión de proceso | Aceptada (O7); documentada en `CONTRIBUTING.md` y `docs/contributing.md` (+ ES); solo specs pequeños, el HTML nunca por instantánea |
| Romper `api.decisions`/`api.paths`/`api.options` rompe el plugin Laya (peer `<0.7.0`) | Plugin roto | D18 y smoke test antes de publicar (§14.10) |

## Apéndice. Fuentes (consultadas el 2026-10-03)

1. Plan de producto: `alisio-decision-intelligence-plan-1.md` (§16-§28, §41, §42).
2. Código del repositorio citado en §3 (leído el 2026-10-03).
3. SQLite, funciones de fecha y hora (`strftime`, `date`, formatos ISO 8601, `NULL` ante entrada no válida): https://www.sqlite.org/lang_datefunc.html — resumen vía WebFetch, **no verificado** por ejecución (E3).
4. Chart.js (opciones `indexAxis`, `cutout`, `interaction.mode`/`axis`, ganchos de plugin): https://www.chartjs.org/docs/latest/ vía Context7 (`/websites/chartjs`) — **no verificado** por ejecución (E4, E5).
5. Laya (solo variante C): https://github.com/NandhaKishorM/laya y `../alisio-plugins/specs/alisio-plugin-laya-v1.md` — **no verificado**.
6. Convención de formato: `specs/alisio-workspace-sources-v1.md`, `specs/archive/alisio-plan-diagrams-viewer-v1.md`; especificación hermana `specs/alisio-decision-intelligence-v1.md`.
