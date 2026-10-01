# Especificación Técnica: Alisio Analysis Runtime y artefactos descargables

| Campo | Valor |
|---|---|
| Versión | 1.2 (revisada) |
| Proyecto | Alisio |
| Estado | Especificación técnica ejecutable |
| Fecha | 2026-10-01 |
| Paquetes afectados | `@alisio/sdk`, `@alisio/core`, `@alisio/server`, `@alisio/web` (privado), `@alisio/alisio-code` (CLI/TUI) |
| Paquetes nuevos | Ninguno en las fases 1–3 (ver ADR-01). |
| Relación con la v1.2 original | Reescritura. El original (`alisio-data-analysis-runtime-v1.2.md`, raíz del repositorio) se conserva sin cambios. Se mantienen sus ideas de valor (tres dominios de archivos, scripts internos separados de los artefactos, aprobación con alcance por ejecución o por chat, revocación, auditoría, procedencia, rerun, retención) y se corrigen los supuestos que contradicen el código real. El Apéndice A mapea cada sección original a su destino. |
| Referencia visual | Captura del chat con la tarjeta de artefacto descargable y el panel de workspace a la derecha (título con desplegable; botones Descargar, Pantalla completa y Cerrar). |

## 0. Cómo usar este documento (para agentes de código)

1. **Lee primero** `AGENTS.md` y `CONTRIBUTING.md`. Sus reglas prevalecen sobre este documento.
2. **Trabaja por fases** (§21). Cada fase es una porción vertical que deja el repositorio verde y no cambia el comportamiento existente de la CLI, la TUI, el modo headless ni la web.
3. **Rutas**: una ruta sin marca existe hoy. Una ruta marcada **(nuevo)** debe crearse. Una afirmación marcada **(verificar)** no se pudo confirmar al redactar: compruébala en el código antes de apoyarte en ella.
4. **Nombres**: identificadores, rutas, eventos, rutas HTTP, tipos TypeScript y textos de UI en inglés; la prosa, en español. En el código Alisio llama **sesión** (`session`) a lo que el original llama "chat". Este documento usa "sesión"; "chat" solo aparece en textos de UI.
5. **Contratos aditivos**: nunca cambies la semántica de una columna, un evento, un `UiBlock` o un tipo existentes. Todo lo nuevo es opcional o una variante nueva de una unión.
6. Antes de entregar cada fase: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check`, `pnpm docs:build`.
7. Documenta limitaciones y alcance de verificación en `docs/implementation-status.md` y mantén la paridad EN/ES (`docs/<page>.md` y `docs/es/<page>.md`, comprobada por `scripts/docs-check.ts`).

---

## 1. Visión y alcance

### 1.1 Visión

El agente puede **escribir un script Python y ejecutarlo** en un entorno administrado por Alisio, fuera del repositorio. Todo lo que el script deja en su carpeta de salida se **publica como artefacto descargable**: un dashboard HTML, un informe Markdown, un PDF, un DOCX, una hoja XLSX o CSV, gráficos PNG/SVG, JSON, un ZIP o cualquier otro archivo. La web muestra cada artefacto como una tarjeta en el chat y, si su tipo es previsualizable, lo abre en un panel lateral redimensionable. La TUI anuncia el artefacto, lo lista y lo abre con la aplicación del sistema. El análisis de datos tabulares (CSV/Excel, `SpreadsheetView`, consultas sobre `node:sqlite`) se construye **encima** de esta base, no al revés.

### 1.2 Dentro del alcance

| Área | Contenido |
|---|---|
| Ejecución | Herramienta `python_run` sobre `runProcess` (`packages/core/src/runtime/process.ts`), con runtime Python administrado (`managed`) y, opcionalmente, contenedor OCI (`oci`). |
| Artefactos | `ArtifactStore` en core: staging → validación → publicación, manifiesto, registro de tipos/MIME, procedencia, descarga individual o ZIP. |
| Permisos | Capability `analysis.run` como refinamiento del efecto `process`, con alcances `once` / `session` / `deny`, grants persistidos en SQLite, revocación y auditoría. |
| Web | `ArtifactCard` en el transcript; `ArtifactPanel` redimensionable con renderers por tipo, iframe aislado para HTML, pantalla completa, descarga y cierre. |
| TUI | Anuncio compacto, `/artifacts` con picker filtrable y acciones (abrir con el sistema, copiar ruta, mostrar carpeta, exportar al workspace, vista previa en terminal para tipos de texto), `/permissions`. |
| Headless | Evento durable `artifact_published` en el JSONL de `alisio run --json`; nada se abre automáticamente. |
| Datos tabulares (fase 3) | Adjuntos CSV/TSV/JSON/JSONL/XLSX, `SpreadsheetView` virtualizada, herramientas `data_inspect` / `data_query` sobre **`node:sqlite`** (un archivo SQLite por dataset, legible también con `sqlite3` de Python). Ningún motor de base de datos adicional. |

### 1.3 Fuera del alcance y diferido

| Elemento del original | Decisión | Motivo |
|---|---|---|
| Afirmar que el runtime administrado "aísla" | **Eliminado** | Un subproceso no es un sandbox (`AGENTS.md`, `docs/tools.md#not-a-sandbox`). Solo el modo OCI aporta aislamiento, y se documenta con sus límites. |
| Docker como dependencia | **Opcional** | El modo por defecto es `managed`. OCI se activa por configuración global. |
| `capability.check` / `capability.request` como herramientas del modelo | **Eliminado** | La comprobación la hace el runner antes de ejecutar; el modelo no debe poder "pedir permisos" por su cuenta. |
| Alcances `workspace` / `global` | **Diferido** | Igual que el original. |
| Política configurable `cancel-current-execution` al revocar | **Eliminado** | Se fija `allow-current-execution`; cancelar sigue disponible con Stop. |
| DuckDB como motor de datos | **Eliminado** | Binarios nativos por plataforma, peso de instalación y complejidad de desarrollo; `node:sqlite` (ya integrado) + `sqlite3` de la biblioteca estándar de Python cubren el caso con un único formato (§17). |
| pandas, Polars, PyArrow, SciPy, statsmodels, scikit-learn en el runtime base | **Extras opcionales** (`analysis`, `science`) instalados con aprobación explícita | El entorno base es solo la biblioteca estándar: funciona sin red y en cualquier plataforma con Python ≥ 3.10. |
| Plantillas de artefacto (`executive-dashboard`, …) | **Diferido (fase 4+)** | No bloquean el valor; el modelo puede generar HTML directamente. |
| Selección de librería de visualización (Plotly/Vega/ECharts/D3) | **Simplificado** | Base: SVG generado con `alisio_runtime.svg` (sin dependencias). Con los extras: Matplotlib y Plotly, cuyo JS se incrusta localmente porque el visor bloquea la red. |
| `XLS`, `XLSB`, `ODS`, `Parquet` como adjuntos | **Diferido (fase 4)** | P0 = CSV, TSV, XLSX. |
| Pool de workers Python caliente | **Diferido** | Igual que el original: solo tras medir el arranque real. |
| Previsualizar DOCX/XLSX/PPTX en la web | **Fuera** | Solo descarga. XLSX puede verse en `SpreadsheetView` desde la fase 3. |
| `/data inspect`, `/data profile`, `/data sheets`, `/artifact sources`, `/artifact promote` como comandos separados | **Simplificado** | Un solo `/artifacts` con acciones (§16) y `/permissions`. |
| Mostrar `stdout` en vivo como lista de pasos (`AnalysisExecutionView`) | **Simplificado** | Se reutiliza el bloque `terminal` existente en la fila de la herramienta. |

---

## 2. Estado actual frente a lo que se necesita

| Necesidad | Existe hoy (ruta) | Brecha | Decisión |
|---|---|---|---|
| Contrato de herramienta | `ToolDefinition`, `ToolContext`, `ToolResult` en `packages/sdk/src/index.ts` | `ToolContext` no expone `runId`, `callId` ni un publicador de artefactos | Campos opcionales nuevos (§11). |
| Categorías de permiso | `Effect = "read" \| "write" \| "process" \| "external" \| "internal"` (SDK) | No hay capabilities más finas que un efecto | `capability` opcional en `ToolDefinition` (§10). |
| Aprobación interactiva | `ApprovalDecision = "once" \| "session" \| "deny"`, `ApprovalRequest`, `ApprovalHandler` (`packages/core/src/core/contracts.ts`); flujo en `packages/core/src/core/runner.ts` | Las aprobaciones `session` viven en memoria (`policy[effect] = true`) y se pierden al cerrar el proceso | Grants persistidos solo para capabilities (§10). |
| Respuesta de aprobaciones | TUI: `approve` en `packages/cli/src/tui/app.ts` (Picker con *Allow once* / *Always allow … in this session* / *Deny*). Web: `ApprovalBridge` (`packages/server/src/bridges/approval-bridge.ts`), `POST /api/approvals/:aid`, `ApprovalPanel.tsx` | Sin texto específico de capability | Etiquetas por capability, mismas tres decisiones. |
| Flags | `--allow-write`, `--allow-process`, `--allow-external`, `--read-only`, `--add-dir` (`packages/cli/src/main.ts`; mapeo en `packages/core/src/application.ts`) | No hay permiso solo para Python | Flag nueva `--allow-analysis` (§10.3). |
| Subprocesos | `runProcess` (`packages/core/src/runtime/process.ts`): `spawn` con grupo de procesos, `AbortSignal` + timeout (30 s por defecto), SIGTERM→SIGKILL, `maxBytes` 32 000, entorno en lista blanca | Límite de salida pensado para shell, no para scripts largos | Reutilizar con opciones propias (§8). |
| Persistencia | `SQLiteStore` (`packages/core/src/runtime/store.ts`), migraciones en línea `has(n)` hasta **v5**; archivo `join(stateHome(), "sessions.sqlite")` | Sin tablas de artefactos, ejecuciones ni grants | Migración **v6** aditiva (§13). |
| Directorios | `stateHome()` / `configHome()` en `packages/core/src/config.ts` (XDG; `ALISIO_STATE_HOME`, `ALISIO_CONFIG_HOME`) | **No existe `ALISIO_HOME`** | Todo bajo `stateHome()` (§6). |
| Blobs | `BlobStore` (`packages/core/src/runtime/blobs.ts`) en `<stateHome>/blobs/sha256/…`, tabla `blobs`; `POST/GET /api/blobs` solo imágenes ≤ 10 MB | Solo imágenes; sin borrado | Reutilizar para adjuntos de datos (fase 3); los artefactos usan su propio almacén (ADR-04). |
| Adjuntos | `Attachment { kind: "image" }`, `Message.attachments` | Solo imágenes | `DataAttachmentRef` (fase 3). |
| Concepto "artefacto" | **No existe** (lo más parecido: `SessionChange` del Dock y `UiBlock`) | — | Nuevo. |
| Bloques de UI | `UiBlock` (SDK): `table`, `key-value`, `tree`, `code`, `markdown`, `diff`, `terminal`, `mermaid`, `math`, `json`, `test-results`, `progress`; las partes `ui` se persisten en `tool_calls.result` | — | Variante nueva `{ kind: "artifact" }` (§11). |
| Eventos | `RunEvent` con `type` en **snake_case** (`run_started`, `tool_completed`, `approval_requested`, …) y `RunEventDataMap` | El original usaba `analysis.started`, `approval.granted` (convención incorrecta) | `artifact_published` (snake_case) y campos opcionales en `approval_*` (§14.3). |
| SSE | `GET /api/events` (`packages/server/src/routes/events.ts`, `SseHub`), `ServerFrame` discriminado por `t`, snapshot en cada reconexión | — | Frame nuevo `capabilities_changed` (§14.3). |
| Rutas HTTP | `node:http` + `Router` propio (`packages/server/src/http/router.ts`): solo `:param`, **sin comodines**; prefijo `/api` sin versión | El visor multiarchivo necesita rutas con subruta | Soporte de segmento final `*` en el router (§14.2). |
| Auth | `AuthGuard` (`packages/server/src/auth/guard.ts`): token de lanzamiento → cookie `HttpOnly; SameSite=Strict`, `checkHost`, `checkOrigin`, JSON obligatorio en escrituras | El iframe aislado no puede usar la cookie | Token de visualización firmado (§14.2). |
| Cabeceras | `securityHeaders()` (`packages/server/src/index.ts`): CSP de `contentSecurityPolicy()` (`http/static.ts`, con `frame-src 'self'` y `frame-ancestors 'none'`), `X-Frame-Options: DENY`, CORP/COOP `same-origin` | Impiden enmarcar el visor | Cabeceras propias solo para la ruta del visor (§14.2). |
| Panel derecho web | `Dock` (`packages/web/src/components/dock/Dock.tsx`, `store/dock.ts`): pestañas Files/Changes/Preview, hoja inferior bajo 900 px, sin redimensionado | — | Una sola ranura derecha compartida (ADR-07). |
| Transcript | `Transcript.tsx`, `ToolRow.tsx`, `markdown/view.tsx`, registro de renderers `renderers/registry.ts` + `renderers/kinds.ts` (`LAZY_KINDS`) | — | `ArtifactCard` + kind `artifact`. |
| Estado web, i18n, iconos | Signals en `store/*.ts`; `t()` con `i18n/en.ts` (`MessageKey`) y `i18n/es.ts`; `components/icons.tsx` (`download`, `expand`, `shrink`, `folder`, …); preferencias con `readPref`/`writePref` (`store/storage.ts`, prefijo `alisio.`) | — | Reutilizar. |
| Maximizar | `AgentsModal.tsx` (`MAXIMIZED_PREF = "alisio.agents.maximized"`, iconos `expand`/`shrink`) | — | Mismo patrón para "expandir panel". |
| TUI | `@earendil-works/pi-tui`; `Picker` filtrable (`tui/app.ts`), `InteractiveQueue` (`tui/queue.ts`), `Markdown` y `renderTableBlock` (`tui/components.ts`), `copyText` / OSC 52 (`tui/clipboard.ts`), `openBrowser` (`cli/src/serve.ts`) | No hay "revelar archivo" ni "abrir con la app del sistema" genérico | Helper `openPath` portable (§16). |
| Comandos | `BUILTIN_COMMANDS` (`packages/core/src/commands/builtins.ts`) con `surfaces` y `execution`; catálogo `commands/catalog.ts`; despacho TUI en `tui/app.ts` | **No existe `/permissions`** | `/artifacts` y `/permissions` nuevos. |
| Configuración | Esquema zod `configObjectSchema` (`packages/core/src/config.ts`), `SETTABLE_KEYS` para la web | — | Sección `analysis` (§18). |
| Motor de datos | `node:sqlite` vía `openDatabase` (`packages/core/src/runtime/sqlite.ts`), Node ≥ 22.16 y Bun | En Node 22.19 `DatabaseSync` no tiene `interrupt()`, *progress handler* ni *authorizer*; `prepare()` ignora sentencias adicionales | Reutilizar con workers y guardia SQL (§17.3). Sin DuckDB. |
| Python / Docker | **Nada** (solo resaltado de sintaxis) | — | Nuevo. |

---

## 3. Análisis de la versión original

### 3.1 Contradicciones y conflictos con la arquitectura

| # | Problema en el original | Por qué es un problema | Corrección |
|---|---|---|---|
| C1 | "ejecutar análisis complejos mediante scripts Python **aislados**" con runtime administrado | Un subproceso con los permisos del usuario no está aislado: puede leer `~/.ssh`, el repositorio y la red. `AGENTS.md`: *"Never treat a plugin manifest or a subprocess as a sandbox."* | `managed` se declara **no aislado** (§8.4). Solo `oci` ofrece aislamiento parcial. |
| C2 | La aprobación pide permiso para **escribir en el almacenamiento de Alisio** (`analysis.external_storage.write`) | Escribir estado propio de Alisio ya es el efecto `internal` (siempre permitido). El riesgo real es **ejecutar código arbitrario**. Pedir permiso por "almacenamiento" mientras se ejecuta Python sin restricciones induce a error. | Capability `analysis.run`, refinamiento del efecto `process` (§10). |
| C3 | `ALISIO_HOME/config`, `ALISIO_HOME/state/state.db` | No existen. Alisio usa XDG: `configHome()` y `stateHome()`, y la base es `sessions.sqlite`. | Rutas reales bajo `stateHome()` (§6). |
| C4 | Eventos `analysis.started`, `approval.granted`, `analysis_artifact.ready` | La convención real es snake_case en `RunEvent.type` y frames `t:` en SSE. `approval_requested`/`approval_resolved` ya existen. | §14.3. |
| C5 | Rutas `/api/chats/:chatId/...` | No hay "chats": hay `/api/sessions/:sid`. | §14.1. |
| C6 | Herramientas `data.inspect`, `analysis.python.execute` | Los nombres de herramienta son snake_case sin puntos (`read_file`, `run_process`); muchos proveedores rechazan puntos. | `python_run`, `artifact_list`, … (§12). |
| C7 | `capability_grants` con `UNIQUE` implícito por `(capability, workspace, chat, execution)` y `decision = 'deny'` persistido | Un `deny` persistido bloquearía para siempre sin UI para deshacerlo; además mezcla auditoría con estado vigente. | `deny` se audita pero no es pegajoso (§10.4). |
| C8 | `@tanstack/preact-table` + TanStack Virtual | Comprobado el 2026-10-01: el registro npm **sí** publica `@tanstack/preact-table@9.2.4` (la afirmación original era falsa), pero la web evita dependencias de componentes (ADR-03 de `specs/alisio-ui.md`) y la paginación keyset del servidor no necesita un modelo de tabla en el cliente. | Virtualización propia mínima (§17.3). |
| C9 | DuckDB "en el backend" sin decir cómo, y pandas/Polars/PyArrow como base | Un binding de DuckDB es un binario nativo por plataforma: rompe la portabilidad Node/Bun, añade peso de instalación y complejidad de desarrollo. Exigir pandas/PyArrow obliga a una instalación con red y wheels por plataforma. | DuckDB **eliminado**: `node:sqlite` en Node y `sqlite3` estándar en Python sobre el mismo archivo (ADR-06, §17). pandas y compañía pasan a extras opcionales. |
| C10 | "Abrir en un nuevo tab" sin aislamiento | Una página HTML generada por el modelo abierta como documento de primer nivel en el origen de Alisio tendría la cookie y el DOM de la app. | Cabecera CSP `sandbox` también en la navegación de primer nivel (§14.2). |

### 3.2 Huecos

- No define **cómo** el script entrega sus salidas (variables de entorno, carpeta, metadatos) ni qué ocurre con salidas parciales tras un fallo.
- No define límites concretos (tiempo, bytes, número de archivos, tamaño de ZIP).
- No define el comportamiento **headless** ni con `--read-only`, ni la relación con `--allow-process` y los presets web.
- No define qué ocurre con **sesiones hijas** (subagentes): ¿heredan el grant de la sesión raíz?
- No define CSP, atributos `sandbox` ni cómo se sirven los recursos de un dashboard multiarchivo.
- Sin criterios de aceptación verificables; la DoD es una lista de capacidades sin pruebas asociadas.
- Solo contempla dashboards HTML; no hay registro de tipos ni comportamiento para tipos no previsualizables.
- No cubre accesibilidad, pantallas estrechas ni la convivencia con el Dock y los modales existentes.

### 3.3 Sobreingeniería para v1

`capability.check`/`capability.request` como herramientas, tres capas de servicios (`CapabilityService → ApprovalService → AnalysisRuntimeService`) para una sola capability, `artifact.output.mode`, seis plantillas, cuatro librerías de visualización, siete formatos de entrada, una vista de pasos de análisis propia y once comandos slash. Todo se reduce o difiere (§1.3).

### 3.4 Cambios respecto a la versión original

1. **Alcance generalizado**: de "dashboards de datos" a "Python que produce cualquier artefacto descargable", con registro de tipos y fallback de solo descarga (§7).
2. **Permiso honesto**: la capability protege la **ejecución** (`analysis.run`, bajo `process`), no la escritura en el almacenamiento interno; se declara explícitamente que `managed` no es un sandbox (§8.4, §10).
3. **Anclado al código real**: `stateHome()`, `sessions.sqlite` con migración v6, `RunEvent` snake_case, `/api/sessions/:sid`, `runProcess`, `ApprovalBridge`, `Picker`, `BUILTIN_COMMANDS`.
4. **Visor seguro y concreto**: ruta con token firmado, `sandbox="allow-scripts"` sin `allow-same-origin`, CSP con `connect-src 'none'` y directiva `sandbox` también en la pestaña nueva (§14.2).
5. **UX definida**: `ArtifactCard` y `ArtifactPanel` especificados con estados, teclado, a11y y estrecho; TUI diseñada para terminal y separada de la web (§15, §16).
6. **DuckDB eliminado**: requería binarios nativos por plataforma, aumentaba el peso de instalación y la complejidad de desarrollo y prueba. Se sustituye por `node:sqlite`, ya integrado, más `sqlite3` de la biblioteca estándar de Python, que leen el mismo archivo por dataset (ADR-06, §17). El runtime Python base es solo biblioteca estándar; pandas, Matplotlib, etc. son extras opcionales con aprobación.
7. **Plan por fases** con valor desde la fase 1 (ejecutar Python y descargar el resultado), criterios web y TUI separados, pruebas de comportamiento y documentación EN/ES por fase (§21).
8. **Menos superficie**: dos herramientas en la fase 1, dos comandos slash, una capability, sin servicios intermedios innecesarios.

---

## 4. Principios y restricciones

### 4.1 Reglas heredadas de `AGENTS.md` (obligatorias)

| Regla | Consecuencia en este diseño |
|---|---|
| Solo APIs Node portables (`node:fs`, `node:child_process`, `node:sqlite`); sin globales de Bun | El runtime se lanza con `runProcess`; el ZIP se escribe con `node:zlib`; sin addons nativos. |
| Sin SDKs de proveedores ni imports dependientes del runtime en los contratos del SDK y de agent-core | Los tipos nuevos del SDK son datos puros. |
| Los plugins dependen solo de `@alisio/sdk` | ADR-01 explica por qué esto vive en core. |
| Un manifiesto de plugin o un subproceso no es un sandbox | §8.4 lo declara en la UI, la documentación y la descripción de la herramienta. |
| Preservar IDs de llamadas, datos de continuación y consistencia de sesiones | Cada artefacto guarda `callId` y `runId`; el texto que recibe el modelo no cambia de forma. |
| Pruebas de comportamiento en las fronteras de módulo; sin snapshots que repitan la implementación | §21 lista pruebas por comportamiento observable. |
| Documentar limitaciones en `docs/implementation-status.md`; paridad EN/ES | Cada fase lista las páginas que actualiza. |

### 4.2 Reglas propias de esta especificación

- **R1. Separación por construcción**: el script, sus logs y los intermedios nunca están en la carpeta del artefacto. El publicador **copia** desde `staging/`; no existe una ruta que publique otra carpeta.
- **R2. El texto manda**: el modelo recibe solo la proyección de texto del resultado (como hoy). Las partes `ui` (`artifact`) son para clientes ricos.
- **R3. Fail-closed**: sin decisión en una aprobación web (pestaña cerrada 30 s, cancelación, 10 min) la respuesta es `deny`, como hoy en `ApprovalBridge`.
- **R4. Zero overhead y cero configuración**: Python se **autodescubre**; no hace falta configurar nada ni ejecutar un comando de preparación para que `python_run` funcione. Al arrancar solo se buscan candidatos en `PATH` con `stat` (sin lanzar procesos); la versión se verifica en la primera llamada y se cachea (§8.1). Si `analysis.enabled` es `false` o se usa `--read-only`, no se registra ninguna herramienta nueva. Sin Python, `python_run` **sí** se registra para poder responder con las instrucciones de instalación del sistema del usuario (§8.1.1).

---

## 5. Decisiones de arquitectura (ADR-lite)

### ADR-01 — Core, no plugin

- **Contexto**: un plugin solo ve `PluginAPI` (`@alisio/sdk`): no puede registrar rutas HTTP, no accede a `SQLiteStore`, a `runProcess` ni al flujo de aprobación del runner, y el efecto `internal` solo se respeta en built-ins.
- **Decisión**: el runtime, el almacén de artefactos y los grants viven en `@alisio/core` (`packages/core/src/analysis/` y `packages/core/src/artifacts/`, nuevos). El servidor añade rutas; la web y la TUI añaden presentación. Las dependencias pesadas opcionales (pandas, Matplotlib, Plotly) viven en el entorno Python como extras, no en `node_modules`; los datos usan `node:sqlite`, ya integrado. Core no gana dependencias npm de runtime.
- **Alternativa descartada**: `@alisio/plugin-data-analysis`. Exigiría ampliar `PluginAPI` con almacén de artefactos, capabilities persistidas y rutas HTTP, convirtiendo a un plugin no aislado en un servidor de red (mismo argumento que ADR-02 de `specs/alisio-ui.md`).
- **Consecuencia**: el SDK solo gana tipos y un publicador opcional en `ToolContext` (`ctx.artifacts?.publish`), de modo que **otros** plugins y servidores MCP envueltos puedan publicar artefactos sin depender de core.

### ADR-02 — `analysis.run` como refinamiento de `process`

- **Contexto**: ejecutar Python es ejecución arbitraria de código, igual que `run_process`. Pero aprobar Python no debe aprobar `shell`.
- **Decisión**: `python_run` declara `effect: "process"` y `capability: "analysis.run"`. Cualquier permiso amplio de `process` (flag, preset `full-access`, aprobación `session` del efecto) cubre `analysis.run`; una aprobación de `analysis.run` **no** concede `process`. Las aprobaciones de capability con alcance `session` se **persisten**.
- **Consecuencia**: no hay un permiso nuevo de "almacenamiento"; escribir en el área administrada es `internal`.

### ADR-03 — Runtime `managed` por defecto, `oci` opcional

- **Decisión**: `managed` = el Python ≥ 3.10 que Alisio **autodescubre** en la máquina (o el indicado con la flag `--python <path>`), sin configuración ni paso de preparación. La ejecución base usa **solo la biblioteca estándar** más el paquete `alisio_runtime` (Python puro, distribuido con core y copiado junto al script), así que no necesita red ni entorno virtual. Solo los extras crean un entorno virtual propio bajo `stateHome()`. Los extras (`analysis`, `science`) se instalan solo con aprobación explícita y desde wheels con hash. `oci` = `docker` o `podman` con una imagen preconstruida configurada globalmente. Nunca se instala nada durante una ejecución sin aprobación ni se hace `docker build` por análisis.
- **Consecuencia**: el aislamiento solo existe con `oci` y se documenta como parcial (§8.4).

### ADR-04 — Almacén de artefactos propio, no `BlobStore`

- **Contexto**: `BlobStore` es direccionable por contenido y sin borrado; los artefactos tienen nombre, carpeta multiarchivo, retención y borrado.
- **Decisión**: `ArtifactStore` (nuevo) con carpeta por artefacto y fila en la tabla `artifacts`. `BlobStore` se reutiliza para los adjuntos de datos (fase 3).

### ADR-05 — Visor aislado por token y `sandbox`

- **Decisión**: el HTML se sirve desde `GET /artifact-view/:token/*` (fuera de `/api`, sin cookie), con un token HMAC ligado al artefacto y caducidad corta; el iframe usa `sandbox="allow-scripts"` **sin** `allow-same-origin`, y la respuesta lleva CSP con `connect-src 'none'` y la directiva `sandbox`. Detalle en §14.2.
- **Alternativa diferida**: un segundo puerto (origen distinto). Aporta aislamiento de origen real incluso si alguien añade `allow-same-origin`, pero duplica el listener y el chequeo de `Host`. Queda como decisión abierta (§23).

### ADR-06 — `node:sqlite` como único motor de datos (sin DuckDB)

- **Contexto**: restricción del propietario: ningún motor de base de datos adicional ni instalación nativa extra; Alisio debe seguir siendo portable en Linux, Windows y macOS.
- **Decisión**: cada dataset se ingiere en **su propio archivo SQLite** con `node:sqlite` (ya integrado). `data_inspect`, `data_query` y `SpreadsheetView` consultan ese archivo desde workers de Node. Python lee el mismo archivo con el `sqlite3` de su biblioteca estándar. XLSX se convierte con un helper Python que solo usa la biblioteca estándar (§17.6).
- **Alternativas descartadas**: DuckDB (binario nativo por plataforma, peso de instalación, complejidad de desarrollo y de pruebas en tres SO); DuckDB dentro de Python (obliga a una instalación con red antes de poder consultar un CSV).
- **Consecuencias**: CSV/TSV/JSON/JSONL funcionan **sin Python**. Sin índices ni funciones analíticas avanzadas: las consultas complejas van a `python_run`. Los límites de `node:sqlite` se documentan (§17.3).

### ADR-07 — Una sola ranura derecha en la web

- **Decisión**: el `Dock` existente y el nuevo `ArtifactPanel` comparten una ranura derecha (`rightPanel` signal: `"dock" | "artifact" | null`). Abrir uno cierra el otro; el ancho redimensionable es común. Se evita tener tres columnas en pantallas medianas.

---

## 6. Dominios de archivos

### 6.1 Tres dominios

| Dominio | Ubicación | Visible para el usuario | Descargable | Lo escribe |
|---|---|---|---|---|
| **Repositorio** (workspace) | `sessions.workspace` | Sí (Files, Changes) | Sí (`/api/workspaces/:wid/file`) | Herramientas `write`; `artifact_export` con aprobación |
| **Artefactos** | `<stateHome>/artifacts/<workspaceKey>/<rootSessionId>/<slug>--<artifactId>/` | Sí | Sí | Solo `ArtifactStore.publish` |
| **Jobs internos** | `<stateHome>/analysis/jobs/<workspaceKey>/<rootSessionId>/<executionId>/` | No por defecto | Solo con la acción explícita "Fuentes del análisis" | `python_run` (proceso Python) |

`<stateHome>` es `stateHome()` de `packages/core/src/config.ts`, o `dirname(--db)` cuando se pasa `--db` (mismo criterio que `BlobStore` en `application.ts`). `workspaceKey` es la función `workspaceId()` que hoy vive en `packages/server/src/host/workspace-host.ts` (16 hex del sha256 de la ruta): se **mueve** a `packages/core/src/runtime/paths.ts` y el servidor la reexporta, para que core y servidor nombren igual las carpetas.

### 6.2 Estructura

```text
<stateHome>/
├── sessions.sqlite                    (existe)
├── blobs/sha256/…                     (existe; adjuntos de datos en la fase 3)
├── runtimes/python/discovery.json     (nuevo) caché del intérprete descubierto (§8.1)
├── runtimes/python/<runtimeVersion>/  (nuevo, solo con extras) venv/ + runtime.json
├── artifacts/<workspaceKey>/<rootSessionId>/
│   └── sales-dashboard--art_01JZYF8V2X9Q/
│       ├── manifest.json              metadatos públicos (sin rutas internas)
│       └── files/                     solo salidas publicadas
│           ├── index.html
│           └── assets/…
├── analysis/datasets/<workspaceKey>/<rootSessionId>/<datasetId>.sqlite   (fase 3, §17)
└── analysis/jobs/<workspaceKey>/<rootSessionId>/<executionId>/
    ├── job.json                       manifiesto interno
    ├── script/main.py                 código del modelo (inmutable tras crearse)
    ├── input/                         enlaces o copias de solo lectura
    ├── work/                          intermedios (cwd del proceso)
    ├── staging/                       salidas candidatas ($ALISIO_OUTPUT_DIR)
    └── logs/stdout.log, stderr.log
```

- La carpeta del artefacto separa `manifest.json` de `files/`: la URL del visor solo resuelve dentro de `files/`, por lo que el manifiesto nunca se sirve como contenido del artefacto.
- Los IDs son `art_<ULID>` y `exec_<ULID>` (ULID con `crypto.randomUUID` no sirve; usar un generador ULID propio de ~20 líneas en `packages/core/src/runtime/ids.ts` (nuevo), sin dependencias). `slug` = título en minúsculas, `[a-z0-9-]`, máx. 48 caracteres.
- Las sesiones hijas (subagentes) usan la **sesión raíz** (`rootSessionId`) para carpetas y grants, igual que `PendingApproval.rootSessionId`.

---

## 7. Registro de tipos de artefacto

El tipo se decide en el publicador por extensión **y** bytes mágicos (como `sniffImage` en `packages/server/src/routes/images.ts`); si no coinciden, gana el tipo más restrictivo (`file`, solo descarga). El `Content-Type` servido sale siempre del registro, nunca del script.

| Extensiones | `kind` | MIME servido | Etiqueta en (en / es) | Previsualizable (web) | Renderer web | TUI |
|---|---|---|---|---|---|---|
| `.html`, `.htm` (o carpeta con `index.html`) | `dashboard` | `text/html; charset=utf-8` | Dashboard / Dashboard | Sí | `HtmlFrame` (iframe aislado, §14.2) | Abrir externamente |
| `.md`, `.markdown` | `document` | `text/markdown; charset=utf-8` | Document / Documento | Sí | `Markdown` existente (`markdown/view.tsx`; Mermaid y KaTeX diferidos) | Vista previa Markdown |
| `.pdf` | `document` | `application/pdf` | Document / Documento | Sí | `PdfFrame` (visor del navegador, §15.3) | Abrir externamente |
| `.docx`, `.odt`, `.pptx` | `document` | MIME oficial | Document / Documento | **No** | Fallback de descarga | Abrir externamente |
| `.csv`, `.tsv` | `spreadsheet` | `text/csv` / `text/tab-separated-values` | Spreadsheet / Hoja de cálculo | Sí (≤ 200 MiB, el límite de ingesta; los bytes pueden ser UTF-8, UTF-16 con BOM o windows-1252) | Fase 1–2: renderer `code`; fase 3 (implementado): `SpreadsheetView` | Tabla (`renderTableBlock`), truncada |
| `.xlsx` | `spreadsheet` | MIME oficial | Spreadsheet / Hoja de cálculo | Sí (≤ 200 MiB; fase 3) | `SpreadsheetView` (filas vía helper Python) | Abrir externamente |
| `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp` | `image` | según bytes | Image / Imagen | Sí | `<img>` | Abrir externamente |
| `.svg` | `image` | `image/svg+xml` | Image / Imagen | Sí | `<img>` (los scripts de SVG no se ejecutan en `<img>`) | Abrir externamente |
| `.json`, `.geojson` | `data` | `application/json` | Data / Datos | Sí (≤ 2 MB) | Renderer `json` existente | Vista previa de texto |
| `.txt`, `.log`, `.sql`, `.yaml`, `.yml`, `.xml`, `.py`, `.js`, `.ts`, `.r` | `code` | `text/plain; charset=utf-8` | Text / Texto | Sí (≤ 2 MB) | Renderer `code` (Shiki) | Vista previa de texto |
| `.zip` | `archive` | `application/zip` | Archive / Archivo comprimido | **No** | Fallback de descarga | Abrir externamente |
| Cualquier otro | `file` | `application/octet-stream` | File / Archivo | **No** | Fallback de descarga | Abrir externamente |

Reglas:

- **Previsualizable** = `kind` y tamaño lo permiten (texto/JSON/código ≤ 2 MB, como el Preview actual del Dock; HTML ≤ 20 MB; imágenes ≤ 20 MB; PDF ≤ 50 MB). Por encima: solo descarga, con el motivo visible.
- Un `.py` como **artefacto** solo existe si el script lo escribió en `staging/` a propósito; el script del job nunca se publica automáticamente (R1).
- Fallback de descarga: icono del tipo, nombre, tamaño, botón **Download** y el texto `This file type can't be previewed.` / `Este tipo de archivo no se puede previsualizar.`.
- Todo `Content-Type` va con `X-Content-Type-Options: nosniff`; los tipos no previsualizables se sirven siempre con `Content-Disposition: attachment`.
- Excepción (implementado en la fase 2): el visor aislado (§14.2) sirve los archivos de un dashboard multiarchivo con su tipo real por extensión (`viewerContentType()` en `artifacts/kinds.ts`: `text/javascript`, `text/css`, fuentes, imágenes…), porque con `nosniff` un script servido como `text/plain` no se ejecuta. Solo esa ruta aislada usa esa tabla; `files/*` y `download` siguen usando el registro.

---

## 8. Runtime Python

### 8.1 Detección, preparación y extras

**Cero configuración.** `python_run` funciona sin editar configuración y sin ejecutar ningún comando previo: el código descubre el intérprete. La única forma de fijarlo es la flag `--python <path>` (en `alisio`, `alisio run`, `alisio resume` y `alisio serve`), que tiene prioridad sobre el descubrimiento y se valida igual (versión ≥ 3.10). No hay clave de configuración para el intérprete.

**Descubrimiento** (`AnalysisRuntimeManager.discover()`, nuevo), en este orden:

| # | Fuente | Linux | macOS | Windows |
|---|---|---|---|---|
| 0 | Flag `--python <path>` (si se pasa, no se prueba nada más; si no existe o es < 3.10, `python_run` responde con el motivo y las instrucciones de §8.1.1, y `alisio doctor` lo indica) | ✔ | ✔ | ✔ |
| 1 | `uv python find ">=3.10"` si `uv` está en `PATH` | ✔ | ✔ | ✔ (`uv.exe`) |
| 2 | Lanzador `py -3` | — | — | ✔ |
| 3 | `python3` | ✔ | ✔ | ✔ |
| 4 | `python` | ✔ | ✔ | ✔, descartando el alias de Microsoft Store (`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`), que abre la tienda en lugar de ejecutar Python |

| Momento | Qué hace | Coste |
|---|---|---|
| Arranque de Alisio | Busca los ejecutables candidatos en los directorios de `PATH` (y `PATHEXT` en Windows) con `fs.stat`; **no lanza procesos**. Registra `python_run` en cualquier caso; sin candidatos, su descripción indica que Python no está instalado. | Microsegundos |
| Primera llamada a `python_run` | Ejecuta el primer candidato con `-c` imprimiendo `json.dumps([list(sys.version_info[:3]), sys.executable])`, acepta el primero con versión ≥ 3.10 y guarda `{ executable, version, mtime }` en `<stateHome>/runtimes/python/discovery.json`. | Una vez |
| Llamadas siguientes | Reutiliza la caché si el ejecutable existe y su `mtime` no cambió; si no, vuelve a descubrir. | Un `stat` |
| Ningún candidato válido | `python_run` devuelve un error (`runtime_unavailable`) con el motivo y las **instrucciones de instalación para el sistema detectado** (§8.1.1). Alisio **no** instala Python por su cuenta. Solo se cachean resultados positivos: tras instalar Python, la siguiente llamada lo descubre sin reiniciar Alisio (salvo que el `PATH` del proceso no incluya la nueva ruta; en ese caso las instrucciones lo dicen). | Un `stat` por llamada |

- La ruta y la versión descubiertas se muestran en `alisio doctor`, `alisio analysis status`, Settings y el texto de la aprobación (riesgo R9).

**Ejecución base (sin entorno virtual).**

| Elemento | Especificación |
|---|---|
| Intérprete | El descubierto (o `--python`), lanzado con `-E -s -B -u -X utf8` (ignora variables `PYTHON*` del usuario y el *site* de usuario; sin `.pyc`; salida sin búfer y UTF-8 también en Windows). |
| `alisio_runtime` | Paquete Python puro (`packages/core/src/analysis/python/alisio_runtime/*.py`, fuente de verdad; se incrusta como cadenas en `python/sources.ts`, generado por `scripts/analysis-runtime-sources.ts`, porque el paquete npm y el binario solo llevan JavaScript) que se copia en `script/` de cada job, así que `import alisio_runtime` funciona sin instalar nada: `outputs` (escribe `outputs.json`), `html` (plantilla HTML autocontenida), `svg` (gráficos de barras, líneas y dispersión en SVG sin dependencias), `datasets` (abre los archivos SQLite de §17 en solo lectura), `xlsx_to_sqlite` (§17.6). |
| Red | No se necesita. |

**Extras (opcionales, entorno virtual propio).**

| Elemento | Especificación |
|---|---|
| Conjuntos | `analysis`: `pandas`, `numpy`, `matplotlib`, `openpyxl`, `python-docx`, `reportlab`, `plotly`, `jinja2` (decisión D5). `science`: `analysis` + `scipy`, `statsmodels`, `scikit-learn`. |
| Ubicación | `<stateHome>/runtimes/python/<runtimeVersion>/venv`, creado desde el intérprete descubierto con `uv venv` si hay `uv` o con `<python> -m venv`. Intérprete: `venv/bin/python` (POSIX) o `venv\Scripts\python.exe` (Windows), construido con `node:path`. Cuando existe, `python_run` lo usa en lugar del intérprete base. |
| Instalación | Siempre explícita: `alisio analysis setup --extras analysis\|science` (opcional, nunca necesario para la ejecución base) o, desde el chat, la capability `analysis.install` (fase 4, §10.1). Con `uv pip install` o `pip install`, `--require-hashes` y `--only-binary=:all:` (sin compilar; si no hay wheel para la plataforma, error claro). Lockfiles `requirements/analysis.txt` y `science.txt` en core. |
| Versión | `runtimeVersion` = hash corto de los lockfiles + versión de Python; un cambio crea un venv nuevo. |
| Estado | `runtime.json` = `{ runtimeVersion, python, pythonVersion, extras: string[], createdAt, ok }`; `ok` solo tras importar los extras. |

**Otros casos.**

| Caso | Comportamiento |
|---|---|
| Sin Python | `python_run` responde con las instrucciones de §8.1.1 (el modelo las transmite y la web/TUI las muestran como bloque `markdown`). Siguen funcionando `artifact_create`, `/artifacts` y `data_inspect`/`data_query` sobre CSV/TSV/JSON/JSONL (Node). XLSX responde `dataset_unsupported` con el remedio. |
| Modo `oci` | Opcional y global: `analysis.runtime: "oci"`, `analysis.oci.engine` (`docker`\|`podman`) e `analysis.oci.image` (digest `@sha256:` obligatorio). `alisio analysis setup --oci` hace `pull` una vez y verifica el digest. La imagen trae los extras. |
| Rutas en Windows | Argumentos siempre en array (sin shell), rutas con espacios y no ASCII admitidas; IDs cortos para no acercarse a `MAX_PATH` (riesgo R8). `stateHome()` en Windows resuelve a `~/.local/state/alisio` (comprobado en `config.ts`: `homedir()` + `.local/state`, salvo `XDG_STATE_HOME`/`ALISIO_STATE_HOME`). |

#### 8.1.1 Instrucciones de instalación por sistema

Cuando no hay un Python ≥ 3.10 utilizable, Alisio genera instrucciones **para el sistema donde se ejecuta** con la función pura `pythonInstallHints({ platform, arch, osRelease, hasUv, hasWinget, hasBrew, found? })` (`packages/core/src/analysis/install-hints.ts`, nuevo). La detección usa `process.platform`, `process.arch`, `/etc/os-release` (`ID`, `ID_LIKE`) en Linux y la búsqueda en `PATH` de `uv`, `winget` y `brew`, sin lanzar procesos.

| Sistema detectado | Instrucción principal | Alternativas |
|---|---|---|
| Windows | `winget install Python.Python.3.12` | Instalador de python.org (marcar **Add python.exe to PATH**); `uv python install 3.12` si hay `uv`. Avisa de que el alias de Microsoft Store no cuenta y de que hay que abrir una terminal nueva tras instalar. |
| macOS con Homebrew | `brew install python@3.12` | Instalador de python.org; `uv python install 3.12`. |
| macOS sin Homebrew | Instalador de python.org (enlace a la página de descargas de macOS) | `uv python install 3.12`; `xcode-select --install` solo si el usuario prefiere el Python de las herramientas de línea de comandos (puede ser < 3.10: se indica). |
| Debian / Ubuntu (`ID`/`ID_LIKE` contiene `debian`) | `sudo apt install python3` | Si la versión de la distribución es < 3.10: `uv python install 3.12`. |
| Fedora / RHEL (`fedora`, `rhel`) | `sudo dnf install python3` | `uv python install 3.12`. |
| Arch (`arch`) | `sudo pacman -S python` | — |
| openSUSE (`suse`) | `sudo zypper install python3` | — |
| Alpine (`alpine`) | `sudo apk add python3` | — |
| Otro Linux / BSD | Gestor de paquetes del sistema (`python3`) | `uv python install 3.12`. |
| Python encontrado pero < 3.10 | Las mismas instrucciones, encabezadas por `Found Python {version} at {path}; Alisio needs 3.10 or newer.` | `--python <path>` si ya hay otra versión instalada. |

Formato y lugares donde aparece:

- **Resultado de `python_run`** (texto para el modelo, en inglés como el resto de mensajes de herramienta): `Python 3.10+ was not found on this machine (Linux · Ubuntu 22.04 · x86_64). To install it: sudo apt install python3 …  After installing, ask again; no Alisio restart is needed. To use a specific interpreter, start Alisio with --python <path>.` Se añade un bloque `{ kind: "markdown" }` con la misma información para la web y la TUI.
- **`alisio doctor`** y **`alisio analysis status`**: la misma guía bajo la línea del runtime.
- **Web**: la página **Data analysis** de Settings muestra el estado `settings.analysis.notFound` y la guía (claves i18n `settings.analysis.installHint.*`, en/es).
- **TUI**: el bloque `markdown` del resultado de la herramienta; no se muestra ningún aviso al arrancar (no se molesta a quien no usa análisis).
- Los comandos se muestran, **nunca** se ejecutan automáticamente.

### 8.2 Contrato de ejecución

Entrada del proceso (las rutas de jobs son las de §6.2):

| Variable | Valor |
|---|---|
| `ALISIO_INPUT_DIR` | `input/` (solo lectura por convención en `managed`; montaje `ro` en `oci`) |
| `ALISIO_OUTPUT_DIR` | `staging/` |
| `ALISIO_WORK_DIR` | `work/` (también `cwd`) |
| `ALISIO_EXECUTION_ID` | `exec_…` |
| `MPLBACKEND` | `Agg` |
| `PYTHONDONTWRITEBYTECODE`, `PYTHONUNBUFFERED`, `PYTHONNOUSERSITE` | `1` |
| Entorno restante | La lista blanca de `runProcess` (`PATH`, `HOME`, `TMPDIR`, `LANG`, …). `HOME` y `TMPDIR` apuntan a `work/` para que las librerías no escriban en el home del usuario. **Nunca** se pasan claves de proveedor ni variables `ALISIO_*` de configuración. |

Salida declarativa opcional: `staging/outputs.json`

```json
{ "artifacts": [
  { "path": "sales-dashboard", "title": "Sales dashboard", "entry": "index.html" },
  { "path": "summary.pdf", "title": "Executive summary" }
] }
```

Sin `outputs.json`, cada archivo de primer nivel de `staging/` es un artefacto, y cada carpeta de primer nivel que contiene `index.html` es un dashboard multiarchivo; otras carpetas se publican como un único artefacto `archive` (ZIP generado en la publicación).

Proceso:

```text
python_run(input)
  → resolver capability (§10)                    deny → error de herramienta
  → crear job (job.json, script/main.py, input/)  internal
  → runProcess(python, [script/main.py], { cwd: work/, signal, timeoutMs, maxBytes: 256 KiB, env })
       stdout/stderr → logs/*.log completos; últimos 256 KiB → bloque "terminal" vía ctx.emit
  → si exitCode = 0 (o allowPartial y hay salidas): publicar staging/ (§9)
  → resultado: texto (resumen) + bloque "terminal" + un bloque "artifact" por artefacto
```

- `runProcess` hoy **mata** el proceso al superar `maxBytes`. Se añade la opción `onOverflow: "kill" | "truncate"` (nuevo, por defecto `"kill"` para no cambiar `run_process`): `python_run` usa `"truncate"` y escribe el flujo completo en `logs/` hasta `analysis.limits.maxLogBytes`.
- Cancelación: el `AbortSignal` del run (Stop en web/TUI) ya provoca SIGTERM al grupo y SIGKILL tras 5 s; la ejecución queda `cancelled` y **no** publica.
- Timeout: `analysis.limits.timeoutMs` (por defecto 120 000, máximo 900 000); el modelo puede pedir menos, nunca más. Estado `timed_out`.
- Salida parcial: con `exitCode ≠ 0` no se publica nada salvo que la entrada lleve `publishOnError: true`; en ese caso los artefactos llevan `provenance.partial = true` y la tarjeta muestra `Partial` / `Parcial`.

### 8.3 Modo OCI

```text
<engine> run --rm --network=none --read-only --cap-drop=ALL --security-opt=no-new-privileges
  --pids-limit=256 --memory=<memoryMb>m --cpus=<cpus> --user <uid>:<gid>
  -v <job>/script:/job/script:ro -v <job>/input:/job/input:ro
  -v <job>/work:/job/work:rw -v <job>/staging:/job/out:rw --tmpfs /tmp:size=256m
  -e ALISIO_INPUT_DIR=/job/input -e ALISIO_OUTPUT_DIR=/job/out -e ALISIO_WORK_DIR=/job/work
  -w /job/work <image@sha256:…> python /job/script/main.py
```

- La cancelación ejecuta además `<engine> kill <name>` (el nombre del contenedor es `alisio-<executionId>`), porque matar el cliente `docker` no detiene siempre el contenedor.
- Implementado en `analysis/oci.ts` (`ociRunArgs`): además de lo anterior, `--name alisio-<id>`, `--label alisio=analysis` (para localizar contenedores sobrantes), `--memory-swap` igual a la memoria y `HOME`/`TMPDIR`/`MPLCONFIGDIR` dentro del contenedor. Los montajes de ruta con `:` (fuera del prefijo de unidad de Windows) se rechazan con un mensaje; con SELinux en modo enforcing se añade `,z`.
- `--user <uid>:<gid>` solo en Linux. Se omite en macOS y Windows (Docker Desktop) porque su capa de uso compartido de archivos asigna el propietario y `getuid` no existe en Windows: **no verificado** en esos sistemas (solo hay pruebas de construcción de argumentos). En Linux está verificado con Docker (los archivos publicados son del usuario). Con motor sin root: Docker no lleva `--user` (el usuario ya se mapea a root) y Podman usa `--userns=keep-id --user`; **no verificado** con Podman.
- No se monta el repositorio. Los adjuntos se copian a `input/`.

### 8.4 Límites honestos de aislamiento

| Garantía | `managed` | `oci` |
|---|---|---|
| Lectura de archivos del usuario fuera del job | **No impedida** | Impedida (solo montajes) |
| Escritura fuera del job | **No impedida** | Impedida salvo `work/` y `staging/` |
| Red | **No impedida** | Bloqueada (`--network=none`) |
| Límite de memoria/CPU | **No** (solo timeout) | Sí |
| Procesos huérfanos | Grupo de procesos; un proceso que haga `setsid` puede escapar | Contenidos en el contenedor |
| Escape del contenedor | — | Posible ante vulnerabilidades del kernel/motor; no es una frontera para código hostil |

La descripción de `python_run`, el texto de aprobación y `docs/analysis.md` dicen literalmente: *"Managed Python is not a sandbox: the script runs with your user permissions and can read your files and use the network."* / *"Python administrado no es un sandbox: el script se ejecuta con tus permisos y puede leer tus archivos y usar la red."*

---

## 9. Publicación de artefactos

### 9.1 Pipeline

```text
staging/  →  scan  →  validate  →  classify (§7)  →  copy to artifacts/<…>/files/  →  write manifest.json
          →  INSERT artifacts  →  RunEvent artifact_published  →  UiBlock { kind: "artifact" }
```

| Paso | Regla |
|---|---|
| scan | `lstat` recursivo; se **rechazan** enlaces simbólicos, hard links con `nlink > 1`, dispositivos, FIFOs y sockets (el motivo va al texto del resultado). |
| validate | Nombres normalizados NFC, sin `..`, sin rutas absolutas, sin componentes que empiecen por `.` salvo `.nojekyll`; profundidad ≤ 8. |
| límites | `analysis.limits.maxFiles` (200), `maxFileBytes` (100 MiB), `maxOutputBytes` (500 MiB por ejecución). Superarlos falla la publicación entera con un mensaje claro; nunca se publica a medias. |
| HTML | No se reescribe ni se "sanea": se trata como no confiable y se aísla en el visor (§14.2). Se comprueba que las referencias relativas de `index.html` (`src`, `href`) apunten a archivos existentes; las ausentes generan un aviso, no un fallo. |
| copia | `copyFile` con `COPYFILE_EXCL` a un directorio temporal hermano y `rename` atómico de la carpeta (mismo criterio que las escrituras atómicas existentes). |
| hash | sha256 por archivo y del conjunto (manifiesto ordenado). |
| idempotencia | Republicar la misma ejecución no duplica: `UNIQUE(execution_id, source_path)`. |

### 9.2 Manifiesto público (`manifest.json`)

```json
{
  "schemaVersion": 1,
  "id": "art_01JZYF8V2X9Q",
  "title": "Sales dashboard",
  "fileName": "sales-dashboard.html",
  "kind": "dashboard",
  "mimeType": "text/html; charset=utf-8",
  "entry": "index.html",
  "files": [{ "path": "index.html", "bytes": 48211, "sha256": "…" }],
  "bytes": 48211,
  "createdAt": 1790000000000,
  "provenance": {
    "sessionId": "…", "runId": "…", "callId": "…", "executionId": "exec_…",
    "runtime": { "mode": "managed", "runtimeVersion": "a1b2c3d4", "python": "3.12.6", "extras": [] },
    "scriptSha256": "…", "inputs": [{ "name": "sales.xlsx", "sha256": "…" }],
    "model": "…", "provider": "…", "partial": false
  }
}
```

No contiene rutas absolutas ni el código del script.

---

## 10. Capabilities y aprobaciones

### 10.1 Capability

| Campo | Valor |
|---|---|
| ID | `analysis.run` |
| Efecto base | `process` |
| Cubre | Ejecutar el script del modelo en el runtime configurado y escribir en el job y en el almacén de artefactos de la sesión. |
| No cubre | `write` (repositorio), `external` (herramientas de red), `shell`/`run_process`, `artifact_export`, instalación de paquetes o plugins. Cada uno mantiene su propia aprobación. |

Capability secundaria (fase 4, implementada): `analysis.install` — instalar los extras de §8.1 desde el chat. Implica red y ejecución (`pip`/`uv`), así que **siempre pregunta**, solo admite `once` (no se persiste un permiso para instalar), ninguna flag la concede y en headless no existe (el remedio opcional es `alisio analysis setup --extras …`). La aprobación muestra los paquetes, el tamaño estimado de descarga y que requiere red.

### 10.2 Alcances

| Decisión UI (en / es) | `ApprovalDecision` | Persistencia | Duración |
|---|---|---|---|
| Allow once / Permitir esta vez | `once` | Fila de auditoría `scope='once'` con `call_id` | Solo esa llamada |
| Allow for this session / Permitir en esta sesión | `session` | Fila `scope='session'`, `decision='allow'` | Hasta revocar o borrar la sesión; **sobrevive a reinicios** (diferencia deliberada con las aprobaciones de efecto, que siguen en memoria) |
| Deny / Denegar | `deny` | Fila `decision='deny'` (solo auditoría) | Esa llamada; la próxima vuelve a preguntar |

### 10.3 Resolución (en `runner.ts`, antes de pedir aprobación de efecto)

| Estado | TUI | Web | Headless (`run`, `resume`, `--json`) |
|---|---|---|---|
| `--read-only` | `python_run` no se registra | Igual | Igual |
| `--allow-process` o `--allow-analysis` (nuevo) | Permitido; auditado con `source='flag'` | Permitido si el flag está en `alisio serve` y el preset lo permite (implementado: `--allow-analysis` cuenta solo con `full-access`, el preset que quiere procesos) | Permitido |
| Grant `session` vigente para la sesión raíz | Permitido sin preguntar | Igual | Permitido (el grant persiste) |
| Aprobación `session` del efecto `process` en memoria | Permitido | Igual | — |
| Ninguno | Pregunta (3 opciones) | Pregunta vía `ApprovalBridge` | **No disponible** (como cualquier `process` sin flag) |

- `--allow-analysis` (nuevo) concede solo `analysis.run`; `--read-only` gana sobre él.
- En headless con un grant persistido de una sesión que se reanuda (`resume`), el grant **sí** aplica: el usuario lo concedió para esa sesión. Esto se documenta en `docs/tools.md`.
- `execute` (Code Mode) puede llamar a `python_run` solo si ya está permitido; nunca abre una aprobación (regla existente).

### 10.4 Persistencia, revocación y auditoría

- Tabla `capability_grants` (§13). La consulta de vigencia es: `capability=? AND session=<root> AND scope='session' AND decision='allow' AND revoked_at IS NULL`.
- **Revocar**: `/permissions` (TUI y web), popover de permisos de la cabecera web (§15.5) o `DELETE /api/sessions/:sid/capabilities/:grantId`. Fija `revoked_at` y `revoked_by` (`tui`\|`web`); no borra artefactos; una ejecución en curso **termina** (`allow-current-execution`), la siguiente vuelve a preguntar.
- **Borrar una sesión** revoca sus grants.
- **Auditoría**: toda decisión crea una fila (`source`: `tui`, `web`, `flag`, `headless-grant`; `correlation_id` del run). Los eventos durables existentes `approval_requested` y `approval_resolved` ganan el campo opcional `capability` (§14.3). La revocación emite el frame `capabilities_changed`.
- **Copia de texto en la aprobación** (web `ApprovalPanel`, TUI `approve`): título `Run Python analysis?` / `¿Ejecutar análisis en Python?`; cuerpo con el modo (`managed`/`oci`), la advertencia de §8.4 en `managed`, las primeras 40 líneas del script y la frase *"Repository files are not modified by this step."* / *"Este paso no modifica archivos del repositorio."* (cierto por diseño en `oci`; en `managed` va precedida de la advertencia de que el script **podría** hacerlo).

---

## 11. Contratos del SDK (`packages/sdk/src/index.ts`, aditivos)

```ts
/** Kind of a published artifact; decides the icon, the label and the renderer (§7). */
export type ArtifactKind =
  | "dashboard" | "document" | "spreadsheet" | "image" | "data" | "code" | "archive" | "file";

/** Public reference to a published artifact. Never carries absolute paths. */
export interface ArtifactRef {
  id: string;                 // "art_<ULID>"
  sessionId: string;          // root session
  title: string;
  fileName: string;           // download name, e.g. "report.md"; multi-file artifacts use "<folder>.zip"
  kind: ArtifactKind;
  mimeType: string;
  bytes: number;
  fileCount: number;          // > 1 for multi-file dashboards
  previewable: boolean;       // decided server/core side with the §7 rules
  createdAt: number;
  partial?: boolean;
  status: "ready" | "deleted" | "expired";
}

/** Input of ToolContext.artifacts.publish: files already written by the caller. */
export interface ArtifactPublishInput {
  /** Absolute path of a file or a directory owned by the caller (staging). */
  source: string;
  title?: string;
  /** Entry file for a directory; defaults to "index.html" when present. */
  entry?: string;
}

export interface ArtifactPublisher {
  /** Validates, copies and registers; throws with a user-readable message on rejection. */
  publish(input: ArtifactPublishInput): Promise<ArtifactRef>;
  /** Creates a single-file artifact from text the tool already holds (used by artifact_create). */
  publishText(input: { fileName: string; title?: string; text: string }): Promise<ArtifactRef>;
}

export interface ToolContext {
  // … existing fields unchanged …
  /** Run and tool call that issued this execution (new, optional). */
  runId?: string;
  callId?: string;
  /** Present when the host has an artifact store for this session (new, optional). */
  artifacts?: ArtifactPublisher;
}

/** Capabilities known in v1 (closed union; extended additively). */
export type AnalysisCapability = "analysis.run" | "analysis.install";

export interface ToolDefinition {
  // … existing fields unchanged …
  /**
   * Finer-grained permission inside `effect` (new, optional). A broad grant of `effect` covers
   * it; a grant of the capability never widens `effect`. Ignored for external plugins in v1.
   */
  capability?: AnalysisCapability;
}

/** New UiBlock variant (additive). The TUI renders it as one line (§16.1). */
export type UiBlock =
  | /* … existing variants … */
  | { kind: "artifact"; artifact: ArtifactRef };

/** RunEventDataMap additions (durable). */
export interface RunEventDataMap {
  // … existing …
  /** `path`: absolute path of the file (or entry) for local consumers (TUI, JSONL); the web ignores it. */
  artifact_published: { artifact: ArtifactRef; path: string; callId?: string; executionId?: string };
  approval_requested: { /* existing fields */ capability?: AnalysisCapability };
  approval_resolved: { /* existing fields */ capability?: AnalysisCapability; persisted?: boolean };
}

/** Persisted capability grant as exposed by the API. */
export interface CapabilityGrantWire {
  id: string;
  capability: AnalysisCapability;
  sessionId: string;
  scope: "once" | "session";
  decision: "allow" | "deny";
  source: "tui" | "web" | "flag" | "headless-grant";
  createdAt: number;
  revokedAt?: number;
}

/** ServerFrame addition. */
//  | { t: "capabilities_changed"; sessionId: string }

/** Phase 3. */
export interface DatasetRef {
  id: string;                 // "ds_<ULID>"
  name: string;               // original file name
  format: "csv" | "tsv" | "json" | "jsonl" | "xlsx";
  bytes: number;
  sha256: string;
  sheets: Array<{ name: string; table: string; rows: number; columns: number }>;
}
```

- `PendingApproval` (y `ApprovalRequest` en core) gana `capability?: AnalysisCapability`, `preview?: string` (primeras 40 líneas del script) y `runtime?: "managed" | "oci"`; el resto no cambia.
- `PermissionPresetId` no cambia.
- `tests/run-events-contract.test.ts` se amplía con los campos nuevos (contrato, no snapshot).

---

## 12. Herramientas

| Herramienta | Fase | `effect` | `capability` | Propósito |
|---|---|---|---|---|
| `python_run` | 1 | `process` | `analysis.run` | Escribe y ejecuta un script; publica lo que deje en `$ALISIO_OUTPUT_DIR`. |
| `artifact_create` | 1 | `internal` (comprobado: el runner permite `internal` siempre y solo el host de plugins lo degrada para plugins externos) | — | Publica un artefacto de texto que el modelo ya tiene (Markdown, HTML, CSV, JSON, SVG). Funciona **sin Python**. |
| `artifact_list` | 1 | `read` | — | Lista los artefactos de la sesión raíz. |
| `artifact_read` | 2 | `read` | — | Lee un artefacto de texto (≤ 64 KiB, truncado y marcado). |
| `artifact_export` | 2 | `write` | — | Copia un artefacto al workspace (promoción). Usa `resolvePath` y la aprobación `write` existente. |
| `data_inspect` | 3 | `read` | — | Ingiere (si hace falta) y describe un CSV/TSV/JSON/JSONL/XLSX: hojas, columnas, tipos, estadísticas, muestra. |
| `data_query` | 3 | `read` | — | Ejecuta un `SELECT` de solo lectura sobre el dataset (§17.3). |

Esquemas (JSON Schema plano, construidos con `objectSchema(...)` como en `tools/standard.ts`):

```ts
// python_run
{
  code: string;                 // ≤ 200 000 chars; written to script/main.py
  title?: string;               // default title for the outputs
  inputs?: Array<{ path: string } | { datasetId: string }>; // workspace paths via ctx.resolvePath
  timeoutMs?: number;           // ≤ analysis.limits.timeoutMs
  publishOnError?: boolean;     // default false
  extras?: Array<"analysis" | "science">; // phase 4: missing extras trigger analysis.install
}
// result text (what the model sees):
// "exit 0 in 4.2s · published 2 artifacts: sales-dashboard.html (dashboard, 48 KB, art_…),
//  summary.pdf (document, 120 KB, art_…)\n--- stdout (last 4 KB) ---\n…"
// result parts: text, { kind: "terminal" }, one { kind: "artifact" } per artifact

// artifact_create
{ fileName: string; title?: string; text: string /* ≤ 5 MB */ }

// artifact_list
{ kind?: ArtifactKind; limit?: number /* ≤ 100 */ }

// artifact_read
{ id: string; path?: string /* file inside a multi-file artifact */; maxBytes?: number }

// artifact_export
{ id: string; target: string /* workspace-relative directory */; overwrite?: boolean }

// data_inspect
{ path?: string; datasetId?: string; sheet?: string; sampleRows?: number /* ≤ 20 */ }

// data_query
{ datasetId: string; sql: string; maxRows?: number /* ≤ 1000, default 200 */ }
```

- Las descripciones de herramienta incluyen el contrato de §8.2 (variables, `outputs.json`), la advertencia de §8.4 y la lista de módulos disponibles según los extras instalados (leída de `runtime.json`; sin extras, solo la biblioteca estándar y `alisio_runtime`).
- `python_run` con `inputs[].path`: el archivo se **copia** a `input/` (o se enlaza con `link` duro si está en el mismo sistema de archivos y es de solo lectura). Rutas fuera del workspace siguen el flujo de directorios externos existente (`PathAccess`).
- Ninguna herramienta permite al modelo publicar `script/`, `logs/` ni `work/`.

---

## 13. Persistencia: migración v6 (aditiva)

En `SQLiteStore.migrate()` (`packages/core/src/runtime/store.ts`), bloque `if (!has(6))` dentro de `transaction`, idempotente:

```sql
CREATE TABLE IF NOT EXISTS analysis_executions(
  id TEXT PRIMARY KEY,                 -- exec_<ULID>
  session TEXT NOT NULL,
  root_session TEXT NOT NULL,
  workspace TEXT NOT NULL,             -- same value as sessions.workspace (path)
  run_id TEXT, call_id TEXT,
  runtime TEXT NOT NULL CHECK(runtime IN ('managed','oci')),
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','timed_out')),
  script_sha256 TEXT NOT NULL,
  exit_code INTEGER, error TEXT,
  rel_dir TEXT NOT NULL,               -- relative to stateHome
  rerun_of TEXT,                       -- phase 4
  created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE INDEX IF NOT EXISTS analysis_executions_session ON analysis_executions(root_session, created_at);

CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY,                 -- art_<ULID>
  session TEXT NOT NULL, root_session TEXT NOT NULL, workspace TEXT NOT NULL,
  run_id TEXT, call_id TEXT,
  execution_id TEXT REFERENCES analysis_executions(id),
  source_path TEXT,                    -- path inside staging, for idempotency
  title TEXT NOT NULL, file_name TEXT NOT NULL,
  kind TEXT NOT NULL, mime TEXT NOT NULL,
  bytes INTEGER NOT NULL, file_count INTEGER NOT NULL DEFAULT 1,
  sha256 TEXT NOT NULL, entry TEXT,
  rel_dir TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('ready','deleted','expired')),
  provenance TEXT NOT NULL,            -- JSON of manifest.provenance
  created_at INTEGER NOT NULL, deleted_at INTEGER,
  UNIQUE(execution_id, source_path)
);
CREATE INDEX IF NOT EXISTS artifacts_session ON artifacts(root_session, created_at);

CREATE TABLE IF NOT EXISTS capability_grants(
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  session TEXT NOT NULL,               -- root session
  workspace TEXT NOT NULL,
  scope TEXT NOT NULL CHECK(scope IN ('once','session')),
  decision TEXT NOT NULL CHECK(decision IN ('allow','deny')),
  source TEXT NOT NULL CHECK(source IN ('tui','web','flag','headless-grant')),
  call_id TEXT, run_id TEXT, correlation_id TEXT,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER, revoked_by TEXT
);
CREATE INDEX IF NOT EXISTS capability_grants_lookup
  ON capability_grants(capability, session, scope, decision, revoked_at);

-- phase 3
CREATE TABLE IF NOT EXISTS datasets(
  id TEXT PRIMARY KEY,                 -- ds_<ULID>
  session TEXT NOT NULL, root_session TEXT NOT NULL,
  name TEXT NOT NULL, format TEXT NOT NULL,
  sha256 TEXT NOT NULL, bytes INTEGER NOT NULL,
  blob_hash TEXT,                      -- when uploaded through the web (BlobStore)
  source_path TEXT,                    -- when read from the workspace
  db_rel_path TEXT NOT NULL,           -- per-dataset SQLite file, relative to stateHome
  ingest_version INTEGER NOT NULL,
  sheets TEXT NOT NULL,                -- JSON of DatasetRef.sheets
  created_at INTEGER NOT NULL
);
INSERT OR IGNORE INTO schema_migrations VALUES(6);
```

- La tabla `datasets` se crea en v6 aunque se use desde la fase 3, para no necesitar una v7 (decisión revisable). Fase 3: v6 no se tocó (la tabla ya existía desde la fase 1, sin publicar) y no hay índice adicional; la reutilización por `sha256` consulta `root_session` + `sha256` sobre una tabla pequeña.
- Ninguna tabla existente cambia. Prueba nueva: `tests/store-migration-v6.test.ts` (base v5 con datos → migra → los datos previos siguen intactos; segunda apertura no repite nada).
- Borrar una sesión: **no existe esa operación** en core ni en el servidor (comprobado; las sesiones solo se archivan), así que la fase 1 no limpia artefactos ni grants por sesión. Si se añade, debe marcar `artifacts.status='deleted'`, revocar grants y borrar las carpetas fuera de la transacción.

---

## 14. Protocolo HTTP y eventos

### 14.1 Rutas REST (`packages/server/src/routes/artifacts.ts`, nuevo)

Todas bajo `AuthGuard` (cookie, `Host`, `Origin` y JSON en escrituras), igual que las existentes.

| Método y ruta | Fase | Respuesta |
|---|---|---|
| `GET /api/sessions/:sid/artifacts?kind=&cursor=` | 1 | `{ items: ArtifactRef[], next?: string }` de la sesión raíz, más recientes primero. |
| `GET /api/artifacts/:aid` | 1 | `ArtifactRef` + `files` (lista) + `provenance` (sin rutas). |
| `GET /api/artifacts/:aid/download` | 1 | Un archivo: bytes con `Content-Disposition: attachment; filename*=UTF-8''…`. Multiarchivo: ZIP generado en streaming con `node:zlib` (`deflateRaw`) por `writeZip` de `packages/core/src/runtime/zip.ts` (nuevo, sin dependencias; el servidor lo reutiliza). Nunca incluye `manifest.json` salvo `?manifest=1`. |
| `GET /api/artifacts/:aid/files/*` | 2 | Archivo individual de un artefacto (Markdown con imágenes relativas, JSON, texto) para el panel; `inline` solo para tipos previsualizables no HTML. Confinado a `files/` con `realpath` y a las rutas del manifiesto. Implementado: tipo del registro (extensión + bytes) y `Content-Security-Policy: default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox`, que deja inerte el archivo si se abre como documento en el origen de la app. |
| `POST /api/artifacts/:aid/view` | 2 | `{ url: "/artifact-view/<token>/<entry>", expiresAt }` para `dashboard` y `pdf`. Implementado: otros tipos → `400 validation_failed`; no previsualizable por tamaño → `413 artifact_too_large`. |
| `POST /api/artifacts/:aid/export` `{ target, overwrite? }` | 2 | Copia al workspace; el servidor la ejecuta **como llamada de herramienta** `artifact_export` en la sesión para que pase por el gate `write` y quede en `Changes`. `409 runs_active` si la sesión está ejecutando. Implementado: responde `202 { runId, status }` (la aprobación, si hace falta, llega por SSE como cualquier otra); el run se encola en `RunScheduler` con `tool`; `Changes` toma las rutas copiadas del resultado de `artifact_export` (`exportedPaths()`), porque la llamada no lleva `path`. |
| `GET /api/artifacts/:aid/sources` | 2 | ZIP con `script/main.py`, `job.json` y, con `?logs=1`, `logs/`. Acción explícita del usuario; nunca la usa el modelo. |
| `DELETE /api/artifacts/:aid` | 2 | `status='deleted'` y borrado de la carpeta. Implementado: `404` si ya no está `ready`. |
| `GET /api/sessions/:sid/capabilities` | 1 | `{ items: CapabilityGrantWire[] }` (vigentes y últimas 50 de auditoría). |
| `DELETE /api/sessions/:sid/capabilities/:gid` | 1 | Revoca; emite `capabilities_changed`. |
| `GET /api/datasets/:did/download` | 3 | Original subido desde la web (blob). `404` si el dataset no tiene original (los de artefactos usan la descarga del artefacto). |
| `POST /api/artifacts/:aid/rerun` | 4 | Ejecuta de nuevo el análisis del artefacto (`python_run { rerunOf }` de su sesión, mismo gate de capability): `202 { runId, status }`; `409 runs_active`, `404` si no existe o está eliminado, `400` si no viene de `python_run`, `403` sin la herramienta. |
| `GET /api/analysis?workspace=` | 4 | `AnalysisStatus` (SDK): modo, intérprete y extras, motor e imagen OCI, límites y retención; solo lectura. |
| `POST /api/artifacts/:aid/dataset` | 3 | Ingiere un artefacto `spreadsheet` en su primera vista previa: `200 { dataset }`, o `202 { pending }` si tarda más de 15 s (se repite la petición; comparte la ingesta en curso). |
| `POST /api/sessions/:sid/datasets` | 3 | Cuerpo crudo (como `/api/blobs`), cabecera `X-File-Name`; ≤ `analysis.data.maxUploadBytes`. Guarda en `BlobStore`, ingiere en segundo plano y responde `202 { dataset: DatasetRef \| null, pending: true }`. |
| `GET /api/sessions/:sid/datasets` · `GET /api/datasets/:did` | 3 | Lista / esquema y estadísticas. |
| `GET /api/datasets/:did/rows?sheet=&after=&limit=&sort=&dir=&filter=` | 3 | Página de filas (§17.4). |

`ApiErrorCode` gana: `artifact_not_found`, `artifact_too_large`, `runtime_unavailable`, `dataset_unsupported` (415), `query_rejected` (400), `query_timeout` (408). La subida exige `Content-Type: application/octet-stream` (no simple en CORS, como `/api/blobs`) y `X-File-Name` codificado con `encodeURIComponent`; `200` si el contenido ya estaba en la sesión.

### 14.2 Ruta del visor aislado

`GET /artifact-view/:token/*` (fuera de `/api`, registrada antes del fallback SPA de `StaticAssets`).

| Aspecto | Especificación |
|---|---|
| Router | `http/router.ts` admite un `*` final que captura el resto de la ruta en `params["*"]` (nuevo, con prueba). |
| Token | `base64url(artifactId · expiresAt · HMAC-SHA256(serverSecret, artifactId‖expiresAt))`. `serverSecret` = secreto por proceso de `auth/token.ts` (`newSecret()`); caduca en 10 min (renovable con otro `POST …/view`). No da acceso a nada más que a `files/` de ese artefacto, solo `GET`/`HEAD`. |
| Auth | No usa la cookie (el iframe aislado no la envía). Mantiene `checkHost`. Implementado: tampoco aplica `checkOrigin` (un documento de origen opaco envía `Origin: null`); solo `GET`/`HEAD`; router propio (`viewRouter`) atendido antes del fallback SPA; token inválido o caducado → `403`; los errores usan cabeceras de base no enmarcables (`frame-ancestors 'none'`, `X-Frame-Options: DENY`, `sandbox`); los logs del servidor sustituyen el token por `[token]` (`redactViewPath`). |
| Confinamiento | `realpath` dentro de `files/`; enlaces simbólicos imposibles por §9.1. |
| Cabeceras | Sustituyen a `securityHeaders()` en esta ruta: sin `X-Frame-Options`; `Cross-Origin-Resource-Policy: cross-origin` (el documento con origen opaco debe poder cargar sus propios recursos); `Referrer-Policy: no-referrer`; `X-Content-Type-Options: nosniff`; `Cache-Control: private, no-store`. |
| CSP (HTML) | `default-src 'none'; script-src <base> 'unsafe-inline'; style-src <base> 'unsafe-inline'; img-src <base> data: blob:; font-src <base> data:; media-src <base> data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors <origin>; sandbox allow-scripts allow-downloads` donde `<origin>` es `http://<Host>` validado y `<base>` = `<origin>/artifact-view/<token>/`. `'self'` no se usa porque en un documento con origen opaco su interpretación varía entre navegadores. |
| CSP (PDF) | `default-src 'none'; frame-ancestors <origin>`, sin directiva `sandbox` (el visor PDF de Chromium no carga en contextos aislados). |
| Pestaña nueva | Como la directiva `sandbox` va en la cabecera, abrir la URL como documento de primer nivel también queda aislado (origen opaco, sin cookie, sin red). |

Iframe en la web:

```html
<iframe src="/artifact-view/<token>/index.html" title="<artifact title>"
        sandbox="allow-scripts allow-downloads"
        referrerpolicy="no-referrer" allow="" loading="lazy"></iframe>
```

- **Nunca** `allow-same-origin`, `allow-top-navigation*`, `allow-popups`, `allow-forms` ni `allow-modals`.
- La CSP de la app (`contentSecurityPolicy()`) ya tiene `frame-src 'self'`; no cambia.
- El visor no envía `Access-Control-Allow-Origin`: las peticiones en modo CORS de un origen opaco (scripts `type="module"`, fuentes `@font-face` desde archivos) fallan. Los dashboards usan scripts clásicos y fuentes `data:` (documentado en `docs/web.md`).
- Consecuencias para los scripts: sin red, sin `localStorage` (origen opaco), sin `fetch` de `data.json` (`connect-src 'none'`). Los datos deben ir incrustados en el HTML o cargarse como `<script src="data.js">`. La descripción de `python_run` lo dice, y, con los extras `analysis`, `alisio_runtime.html.inline_plotly()` incrusta el `plotly.min.js` que trae el propio paquete `plotly` (MIT). Sin extras, `alisio_runtime.svg` genera gráficos SVG en línea.

### 14.3 Eventos

| Nombre | Tipo | Cuándo | Datos |
|---|---|---|---|
| `artifact_published` | `RunEvent` durable (nuevo) | Tras cada publicación | `{ artifact: ArtifactRef, path, callId?, executionId? }`; `path` es la ruta absoluta local (TUI y JSONL) |
| `approval_requested` | `RunEvent` existente | Aprobación de capability | + `capability?` |
| `approval_resolved` | `RunEvent` existente | Decisión | + `capability?`, `persisted?` |
| `capabilities_changed` | `ServerFrame` (nuevo) | Revocación o grant persistido | `{ sessionId }`; la web recarga `GET …/capabilities` |
| `dataset_ready` / `dataset_failed` | `ServerFrame` (nuevos, fase 3) | Fin de una ingesta subida desde la web | `{ sessionId, dataset }` / `{ sessionId, name, error }` |

- El progreso de `python_run` usa el `tool_progress` existente (bloque `terminal` en streaming).
- `artifact_published` aparece en el JSONL de `alisio run --json` sin cambios en el emisor (todos los `RunEvent` durables ya se emiten).
- Los clientes que no conocen el tipo lo ignoran (comprobado: el contrato de `RunEvent` en el SDK exige ignorar tipos desconocidos y `tests/run-events-contract.test.ts` cubre `artifact_published`).

---

## 15. Web UI (`packages/web`)

Esta sección solo aplica a la web. La TUI tiene su propio diseño (§16) y **no** imita la tarjeta, el hover ni el panel.

### 15.1 Fuente de datos (`store/artifacts.ts`, nuevo)

- `artifactsBySession: Signal<Record<string, ArtifactRef[]>>`, cargado con `GET /api/sessions/:sid/artifacts` al abrir la sesión y actualizado con cada `RunEvent` `artifact_published` recibido por `net/events.ts`.
- Las tarjetas del transcript salen de los bloques `{ kind: "artifact" }` de los resultados de herramienta (se persisten en `tool_calls.result`, así que sobreviven a recargas) y se **reconcilian** por `id` con el estado de la lista (para mostrar `deleted`/`expired`).
- Acciones: `openArtifact(id, opener?: HTMLElement)`, `closeArtifactPanel()`, `downloadUrl(id)`, `requestViewUrl(id)` (cachea la URL hasta 30 s antes de `expiresAt`).

### 15.2 `ArtifactCard` (`components/artifacts/ArtifactCard.tsx`, nuevo)

Ubicación: el `Transcript` la muestra **debajo de las filas de herramientas del turno** que la produjo, fuera de la fila plegable (las filas pueden empezar plegadas según Appearance), una por artefacto, en orden de publicación. Dentro del detalle de `ToolRow` se repite en forma compacta.

Anatomía (coincide con la referencia visual):

```text
┌──────────────────────────────────────────────────────────┐
│ [icono]  sales-dashboard.html                       [⤓]  │
│          Dashboard            ← en reposo                │
│          Open file            ← hover/foco, solo si previewable
└──────────────────────────────────────────────────────────┘
```

| Elemento | Especificación |
|---|---|
| Contenedor | `div` con `role="group"` y `aria-label="{fileName}"`. Ancho máximo 520 px; borde `--border`, radio y fondo `--surface` de `styles/tokens.css`. |
| Acción principal | Un `<button>` que ocupa icono, nombre y subtítulo. Previsualizable: abre el panel. No previsualizable: descarga (mismo efecto que el botón de descarga). |
| Icono | `Icon` de `components/icons.tsx`, uno por `kind` (iconos nuevos: `fileChart`, `fileText`, `fileTable`, `fileImage`, `fileCode`, `fileArchive`, `file`). |
| Nombre | `fileName`, una línea, `text-overflow: ellipsis`; el nombre completo en `title`. |
| Subtítulo en reposo | Etiqueta del tipo (`artifact.kind.<kind>`): *Dashboard*, *Documento*, *Hoja de cálculo*, *Imagen*, *Datos*, *Texto*, *Archivo comprimido*, *Archivo*. Con `partial`, sufijo ` · Parcial`. |
| Subtítulo en hover/foco | `Open file` / `Abrir archivo` **solo** si `previewable`. Se implementa en CSS con dos `span` (`:hover` y `:focus-visible` del botón principal, o `:focus-within` con `:has(:focus-visible)`), sin estado JS, sin desplazar el layout (ambos ocupan la misma celda de grid). Un artefacto no previsualizable **nunca** muestra "Abrir archivo". |
| Botón de descarga | `<a href="/api/artifacts/:id/download" download>` con `Icon name="download"`, **visible siempre** (también en reposo), `aria-label="Download {fileName}"`, zona táctil ≥ 32×32 px. No propaga el clic: descarga sin abrir el panel. |
| Teclado | `Tab` recorre acción principal → descarga. `Enter`/`Space` en la principal abren (o descargan). El estado de foco visible es idéntico al de hover. |
| `aria` | Principal: `aria-label="Open {fileName}, {kindLabel}"` (previsualizable) o `"Download {fileName}, {kindLabel}"`; `aria-describedby` con tamaño y fecha. Cuando el panel muestra ese artefacto: `aria-expanded="true"` y `aria-controls="artifact-panel"`. |
| Estado `loading` | Mientras la lista de la sesión aún no reconcilió el artefacto tras una recarga: subtítulo en esqueleto, acción principal deshabilitada, descarga habilitada. |
| Estado `error` | Si abrir falla (`404`/`410`, `POST …/view` fallido): subtítulo `Unavailable` / `No disponible` en `--danger`, `role="status"` con el motivo y botón `Retry` / `Reintentar`. |
| Estado `expired` / `deleted` | Tarjeta atenuada, subtítulo `Expired` / `Caducado` o `Deleted` / `Eliminado`, acción principal con `aria-disabled="true"`, sin botón de descarga. |
| Movimiento | Transición de subtítulo ≤ 120 ms y desactivada con `prefers-reduced-motion`. |

### 15.3 `ArtifactPanel` (`components/artifacts/ArtifactPanel.tsx`, nuevo)

#### Ranura y división

- `store/layout.ts` (nuevo): `rightPanel = signal<"dock" | "artifact" | null>`, que sustituye a `dockOpen` en `app.tsx` (`dockOpen` se mantiene como `computed` para no romper `store/dock.ts`; la preferencia `alisio.dock` sigue funcionando). Abrir el panel de artefactos cierra el Dock y viceversa (ADR-07).
- `components/layout/Resizer.tsx` (nuevo, compartido con el Dock): asa vertical entre el chat y el panel.

| Comportamiento | Especificación |
|---|---|
| Ancho por defecto | `clamp(360px, 42vw, 880px)` |
| Mínimo / máximo | 320 px / `viewport − anchoSidebar − 360 px` (el chat nunca baja de 360 px). Si no caben, se pasa al modo estrecho. |
| Arrastre | Pointer Events con `setPointerCapture`; durante el arrastre el iframe recibe `pointer-events: none` (si no, se traga los eventos). |
| Doble clic en el asa | Restablece el ancho por defecto. |
| Teclado en el asa | `role="separator"`, `aria-orientation="vertical"`, `aria-valuenow/min/max`, `tabindex="0"`, `aria-label` `Resize panel` / `Redimensionar panel`. `←`/`→` ±16 px, con `Shift` ±64 px, `Home`/`End` mínimo/máximo, `Enter` restablece. Implementado: `aria-valuenow` es el ancho del panel; como el asa está en su borde izquierdo, `←` lo ensancha y `→` lo estrecha. |
| Persistencia | `alisio.rightPanel.width` (px) con `readPref`/`writePref` de `store/storage.ts`, escrito al soltar (no en cada movimiento). Toda lectura/escritura va en `try/catch` (`storage.ts` ya lo hace: comprobado, se reutiliza) y el panel funciona igual sin almacenamiento. |
| Expandir | Opción del menú del título `Expand panel` / `Expandir panel`: el panel ocupa toda la columna del chat (la sidebar se mantiene). Patrón de `AgentsModal` (`styles.maximized`, iconos `expand`/`shrink`); preferencia `alisio.artifactPanel.expanded`. Implementado: mientras haya una aprobación o una pregunta pendiente el chat vuelve a mostrarse (si no, el `ApprovalPanel` quedaría oculto). |

#### Cabecera

```text
[icono Título del artefacto ▾]                      [⤓] [⛶] [✕]
```

| Elemento | Especificación |
|---|---|
| Título con desplegable | Botón con icono del tipo, título truncado y chevron; `aria-haspopup="listbox"`, `aria-expanded`. Abre una lista de los artefactos de la sesión (más recientes primero) con icono, título y etiqueta de tipo; el actual con `aria-selected="true"`; campo de filtro cuando hay más de 8; flechas, `Enter`, `Esc` y escritura para saltar. Un artefacto publicado mientras el panel está abierto aparece con un punto "nuevo" y **no** cambia la vista ni roba el foco. |
| Menú secundario (al final de la lista) | `Open in new tab` (solo `dashboard` y PDF), `Expand panel` / `Restore panel`, `Download analysis sources` (solo si viene de `python_run`), `Copy to workspace…` (fase 2), `Delete` (con confirmación). |
| Descargar | `Icon name="download"`, mismo enlace que la tarjeta. |
| Pantalla completa | `Element.requestFullscreen()` sobre el panel; icono `expand` ↔ `shrink`; `aria-pressed`. Sin soporte de la API: actúa como `Expand panel`. |
| Cerrar | `Icon name="close"`; devuelve el foco a la tarjeta que abrió el panel (o al compositor). |
| Orden | Descargar, Pantalla completa, Cerrar (como la referencia). Todos con `aria-label` y `title`. |

#### Renderers por tipo (`components/artifacts/renderers/*`, carga diferida como `renderers/registry.ts`)

| Tipo | Componente | Datos | Detalles |
|---|---|---|---|
| `dashboard` | `HtmlFrame` | `POST /api/artifacts/:id/view` → iframe (§14.2) | Esqueleto hasta el evento `load`; si no carga en 15 s, error con `Reload`. Fondo blanco fijo (el HTML generado no conoce el tema). |
| Markdown | `Markdown` existente (`markdown/view.tsx`) | `GET /api/artifacts/:id/files/<entry>` | DOMPurify como hoy; Mermaid y KaTeX diferidos como hoy; imágenes relativas reescritas a `/api/artifacts/:id/files/…`; enlaces externos con `rel="noopener noreferrer"` y `target="_blank"`. |
| PDF | `PdfFrame` | URL del visor | `<iframe>` sin atributo `sandbox` (ver §14.2 y riesgo R6); si el navegador no muestra PDF embebido, fallback de descarga. Implementado: se detecta con `navigator.pdfViewerEnabled === false`. |
| Imagen (incl. SVG) | `ImageView` | `/api/artifacts/:id/files/<entry>` | `<img>` con `alt` = título; conmutador `Fit` / `100 %`. |
| CSV/TSV | Fases 1–2: renderer `code`; fase 3: `SpreadsheetView` (§17.5) | `files/` o `GET /api/datasets/…` | — |
| JSON | Renderer `json` existente (`LAZY_KINDS`) | `files/` | ≤ 2 MB |
| Texto/código | Renderer `code` existente (Shiki) | `files/` | Lenguaje por extensión; ≤ 2 MB |
| Resto / demasiado grande | `DownloadFallback` | — | Icono, nombre, tamaño, motivo y botón `Download`. |

#### Estados del panel

`loading` (esqueleto), `ready`, `error` (mensaje + `Retry`), `expired`/`deleted` (mensaje y lista para elegir otro), `empty` (sesión sin artefactos al abrir con `/artifacts`).

### 15.4 Pantallas estrechas, `Esc` y convivencia

| Situación | Comportamiento |
|---|---|
| Ancho < 900 px (mismo corte que sidebar y Dock) | El panel es una hoja a pantalla completa (`role="dialog"`, `aria-modal="true"`, `aria-labelledby` = título), sin asa ni `Expand`; foco atrapado; `Close` vuelve al chat. |
| `Esc` con el foco en el panel | Cierra primero el desplegable abierto; si no hay, cierra el panel y devuelve el foco. En pantalla completa, el primer `Esc` lo consume el navegador para salir de ella. |
| `Esc` con el foco dentro del iframe | No llega a la app (aislamiento). Se documenta; el botón Cerrar sigue disponible. |
| `Esc` en el compositor | No cierra el panel (el compositor lo usa para la paleta `/`). |
| Varios artefactos | Un panel, un artefacto visible; abrir otra tarjeta cambia el contenido; el desplegable permite cambiar. No hay pestañas. |
| Cambio de sesión | Se cierra el panel de artefactos (son por sesión); el Dock no cambia de comportamiento. |
| Sidebar | Independiente; plegarla aumenta el máximo del panel. |
| Settings / Agents (modales) | Se superponen al panel; mientras están abiertos el panel recibe `inert`. El panel no se desmonta (no se recarga el iframe). |
| Aprobaciones / `/btw` | Sin cambios: el `ApprovalPanel` sustituye al compositor en la columna del chat; `BtwPanel` flota por encima. |

### 15.5 Permisos de la sesión (web)

- Un botón de llave nuevo en la cabecera (`components/header/PermissionsPopover.tsx`; la insignia de preset ya abre el selector de agentes) abre un popover (nuevo) **Session permissions** / **Permisos de la sesión** con los grants vigentes (`GET /api/sessions/:sid/capabilities`): `Python analysis · Allowed for this session · since 10:42` y botón `Revoke` / `Revocar` (`DELETE …`). Se refresca con `capabilities_changed`.
- `ApprovalPanel.tsx`: si `PendingApproval.capability` existe, muestra el título y la advertencia de §10.4, las primeras 40 líneas del script en un bloque `code` plegable, y las mismas tres decisiones y teclas (`D`, `O`, `S`) con las etiquetas `Allow for this session` / `Permitir en esta sesión`.

### 15.6 Claves i18n (añadir a `i18n/en.ts` y `i18n/es.ts`; `MessageKey` obliga a la paridad)

| Clave | en | es |
|---|---|---|
| `artifact.kind.dashboard` | Dashboard | Dashboard |
| `artifact.kind.document` | Document | Documento |
| `artifact.kind.spreadsheet` | Spreadsheet | Hoja de cálculo |
| `artifact.kind.image` | Image | Imagen |
| `artifact.kind.data` | Data | Datos |
| `artifact.kind.code` | Text | Texto |
| `artifact.kind.archive` | Archive | Archivo comprimido |
| `artifact.kind.file` | File | Archivo |
| `artifact.open` | Open file | Abrir archivo |
| `artifact.openNamed` | Open {name}, {kind} | Abrir {name}, {kind} |
| `artifact.download` | Download | Descargar |
| `artifact.downloadNamed` | Download {name} | Descargar {name} |
| `artifact.partial` | Partial | Parcial |
| `artifact.expired` | Expired | Caducado |
| `artifact.deleted` | Deleted | Eliminado |
| `artifact.unavailable` | Unavailable | No disponible |
| `artifact.retry` | Retry | Reintentar |
| `artifact.noPreview` | This file type can't be previewed. | Este tipo de archivo no se puede previsualizar. |
| `artifact.tooLarge` | Too large to preview ({size}). | Demasiado grande para previsualizar ({size}). |
| `artifactPanel.label` | Artifact viewer | Visor de artefactos |
| `artifactPanel.switch` | Switch artifact | Cambiar de artefacto |
| `artifactPanel.filter` | Filter artifacts | Filtrar artefactos |
| `artifactPanel.new` | New | Nuevo |
| `artifactPanel.empty` | No artifacts in this session yet. | Aún no hay artefactos en esta sesión. |
| `artifactPanel.fullscreen` | Full screen | Pantalla completa |
| `artifactPanel.exitFullscreen` | Exit full screen | Salir de pantalla completa |
| `artifactPanel.close` | Close | Cerrar |
| `artifactPanel.expand` | Expand panel | Expandir panel |
| `artifactPanel.restore` | Restore panel | Restaurar panel |
| `artifactPanel.resize` | Resize panel | Redimensionar panel |
| `artifactPanel.openNewTab` | Open in new tab | Abrir en una pestaña nueva |
| `artifactPanel.sources` | Download analysis sources | Descargar fuentes del análisis |
| `artifactPanel.export` | Copy to workspace… | Copiar al workspace… |
| `artifactPanel.delete` | Delete | Eliminar |
| `artifactPanel.deleteConfirm` | Delete {name}? This can't be undone. | ¿Eliminar {name}? No se puede deshacer. |
| `artifactPanel.loadFailed` | Couldn't load the preview. | No se pudo cargar la vista previa. |
| `artifactPanel.reload` | Reload | Recargar |
| `approval.analysisRun.title` | Run Python analysis? | ¿Ejecutar análisis en Python? |
| `approval.analysisRun.notSandboxed` | Managed Python is not a sandbox: the script runs with your user permissions and can read your files and use the network. | Python administrado no es un sandbox: el script se ejecuta con tus permisos y puede leer tus archivos y usar la red. |
| `approval.analysisRun.container` | Runs in a container without network access. | Se ejecuta en un contenedor sin acceso a la red. |
| `approval.allowForSession` | Allow for this session | Permitir en esta sesión |
| `permissions.title` | Session permissions | Permisos de la sesión |
| `permissions.analysisRun` | Python analysis | Análisis en Python |
| `permissions.allowedSession` | Allowed for this session · since {time} | Permitido en esta sesión · desde {time} |
| `permissions.revoke` | Revoke | Revocar |
| `permissions.none` | No saved permissions in this session. | No hay permisos guardados en esta sesión. |
| `settings.analysis.title` | Data analysis | Análisis de datos |
| `settings.analysis.runtime` | Python runtime | Runtime de Python |
| `settings.analysis.notFound` | No Python 3.10+ found on this machine. | No se encontró Python 3.10+ en esta máquina. |
| `settings.analysis.installHint.title` | How to install Python on this system | Cómo instalar Python en este sistema |
| `settings.analysis.installHint.afterInstall` | After installing, no restart is needed. | Tras instalarlo no hace falta reiniciar. |
| `settings.analysis.detected` | Python {version} · {path} (detected automatically) | Python {version} · {path} (detectado automáticamente) |
| `settings.analysis.timeout` | Execution timeout | Tiempo máximo de ejecución |
| `dataset.uploading` | Reading {name}… | Leyendo {name}… |
| `dataset.failed` | Couldn't read {name}: {error} | No se pudo leer {name}: {error} |

---

## 16. TUI (`packages/cli`)

Diseñada para la terminal sobre los patrones reales: `Picker` filtrable e `InteractiveQueue` (`tui/app.ts`, `tui/queue.ts`), `Markdown` y `renderTableBlock` (`tui/components.ts`), `copyText` (`tui/clipboard.ts`) y el patrón de `openBrowser` (`serve.ts`). No hay tarjetas, hover ni panel.

### 16.1 Anuncio en el chat

El bloque `{ kind: "artifact" }` se renderiza en `tui/components.ts` (función nueva `renderArtifactBlock`) como dos líneas por artefacto, debajo del bloque de la herramienta:

```text
  ▤ Dashboard  sales-dashboard.html  48 KB
    ~/.local/state/alisio/artifacts/3f2a…/7c1d…/sales-dashboard--art_01JZ…/files/index.html
```

- Icono Unicode o ASCII (`[D]`, `[M]`, `[T]`, `[I]`, `[J]`, `[C]`, `[Z]`, `[F]`) según `terminalCapabilities()` (`banner.ts`); sin color con `NO_COLOR`.
- La ruta abrevia el home con `~`, se recorta por el centro si excede el ancho y es la ruta real del archivo (o del `index.html` en un dashboard multiarchivo).
- Al final del turno, si hubo artefactos, una línea tenue: `/artifacts to open, copy or reveal`.
- `tests/ui-blocks-fallback.test.ts` se amplía: todo `UiBlock` nuevo tiene representación TUI en el mismo PR (regla de `specs/alisio-ui.md`).

### 16.2 `/artifacts [filtro]`

- Entrada nueva en `BUILTIN_COMMANDS` (`packages/core/src/commands/builtins.ts`): `{ name: "artifacts", description: "Browse this session's artifacts", argumentHint: "[filter]", surfaces: ["tui"], execution: "surface" }` en la fase 1; la fase 2 añade `web` (abre el panel con el desplegable abierto).
- `Picker` filtrable titulado `Artifacts · {n}`; filas `Dashboard  sales-dashboard.html  48 KB  4 min`, más recientes primero; el filtro (`match` propio) busca en nombre, título y tipo. Sin artefactos: aviso `No artifacts in this session yet.`.
- Al elegir uno, un segundo `Picker` de acciones (solo las aplicables):

| Acción | Disponible | Comportamiento |
|---|---|---|
| `Preview here` | Markdown, CSV/TSV, JSON, texto/código | Vista acotada (§16.4). |
| `Open with default app` | Siempre | `openPath(path)` (§16.3). |
| `Copy path` | Siempre | `copyText` (con OSC 52 como hace hoy el portapapeles); aviso `Path copied`. |
| `Reveal in folder` | Siempre | `revealPath(path)` (§16.3). |
| `Copy to workspace…` | Fase 2 | Pide el directorio destino (entrada de texto) y ejecuta `artifact_export` por el gate `write`: aprobación TUI existente si no hay `--allow-write`; `--read-only` la oculta. |
| `Reveal analysis sources` | Solo artefactos de `python_run` | Abre la carpeta del job (acción explícita del usuario). |
| `Delete` | Siempre | Confirmación en un `Picker` `Delete / Cancel`. |

`Esc` vuelve al picker anterior; un segundo `Esc` lo cierra.

### 16.3 Abrir y revelar de forma portable (`packages/cli/src/tui/open-path.ts`, nuevo)

`openBrowser`/`browserCommand` de `serve.ts` inspiran este módulo; en la fase 1 `serve.ts` **no** cambia (abre URLs generadas por el servidor y tiene pruebas propias de su comando), y `open-path.ts` solo abre archivos:

| SO | Abrir | Revelar |
|---|---|---|
| Linux/BSD | `xdg-open <path>`; si falla al lanzar, `gio open <path>` | `xdg-open <dirname>` |
| macOS | `open <path>` | `open -R <path>` |
| Windows | `explorer.exe <path>` | `explorer.exe /select,<path>` |

- `spawn(command, args, { detached: true, stdio: "ignore", shell: false, windowsHide: true })` y `unref()`; **nunca** `cmd /c start` ni un shell (evita inyección por nombres de archivo).
- Sin entorno gráfico (Linux sin `DISPLAY`/`WAYLAND_DISPLAY`, o `SSH_CONNECTION`/`SSH_TTY` definidos), o si el comando no existe (`error` `ENOENT`): no se lanza nada; aviso `Can't open files here (no desktop session). Path: <path>` y se ofrece `Copy path`.
- Solo se abren rutas que devuelve `ArtifactStore` (nunca una ruta propuesta por el modelo).

### 16.4 Vista previa en la terminal

Componente `ArtifactPreview` (nuevo, `tui/artifact-preview.ts`), mostrado como panel en el lugar del picker:

| Tipo | Render | Límite |
|---|---|---|
| Markdown | `Markdown` existente con `markdownTheme` | Primeros 256 KiB |
| CSV/TSV | `renderTableBlock` | 200 filas × 20 columnas; leyenda `showing 200 of 12,480 rows · 20 of 31 columns` |
| JSON | Pretty-print con el resaltado de código existente | 256 KiB |
| Texto/código | Resaltado por extensión | 2 000 líneas |

- Desplazamiento con `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End`; `o` abre con la app del sistema, `c` copia la ruta, `Esc` o `q` cierra. Pie con `truncated` explícito cuando se recorta.
- Dashboards, PDF, imágenes, DOCX, XLSX y ZIP **nunca** se renderizan en la terminal (aunque el terminal soporte protocolos de imagen); solo `Open with default app`.

### 16.5 Aprobaciones y `/permissions`

- La capability usa el `approve` existente vía `InteractiveQueue`: título `Run Python analysis (managed · not sandboxed)?` (u `(container · no network)`), `detail` con las primeras 40 líneas del script, opciones `Allow once` (`once`), `Allow for this session` (`session`), `Deny` (`deny`); `Esc` = deny, como hoy.
- `/permissions` (nuevo en `BUILTIN_COMMANDS`, `surfaces: ["tui", "web"]`, `execution: "surface"`): `Picker` con los grants persistidos de la sesión raíz (`Python analysis · allowed for this session · since 10:42 (web)`); elegir uno ofrece `Revoke` / `Cancel`. Sin grants: `No saved permissions in this session.`. `tests/command-catalog-tui-parity.test.ts` se actualiza.

### 16.6 Modos no interactivos

| Modo | Comportamiento |
|---|---|
| `alisio run --json` / `resume --json` | Cada artefacto produce una línea JSONL `{"type":"artifact_published", …, "data":{"artifact":{…},"path":"/abs/path","callId":"…"}}`. `path` solo existe en el evento local (§14.3). |
| `--no-tui` (readline) | Una línea por artefacto: `artifact: Dashboard sales-dashboard.html (48 KB) → /abs/path`. Va a stderr. `--quiet` solo oculta la pantalla de inicio y las pistas (comprobado), así que no oculta esta línea. |
| Todos | Nada se abre automáticamente; no hay aprobaciones: `python_run` solo existe con `--allow-process`, `--allow-analysis` o un grant persistido de la sesión reanudada. |

---

## 17. Datos tabulares sobre `node:sqlite` (fase 3)

Restricción del propietario: **ningún motor de base de datos adicional** (ni DuckDB ni otro) y ninguna instalación nativa extra. Se usa solo `node:sqlite` (ya integrado en `packages/core/src/runtime/sqlite.ts`, disponible en Node ≥ 22.16 y en Bun) y, en Python, el módulo `sqlite3` de la biblioteca estándar. Un único formato compartido: **un archivo SQLite por dataset**.

### 17.1 Flujo

```text
CSV/TSV/JSON/JSONL ── Node (proceso del motor + node:sqlite) ─┐
XLSX ── runtime Python (stdlib: zipfile + xml.etree + sqlite3) ┤──► <dataset>.sqlite (solo lectura)
                                                                │        │
              data_inspect / data_query / SpreadsheetView ◄─────┘        └──► python_run lo lee con sqlite3
```

- Archivo: `<stateHome>/analysis/datasets/<workspaceKey>/<rootSessionId>/<datasetId>.sqlite`, **fuera** de `sessions.sqlite`. Mismo dominio interno que los jobs (§6).
- Orígenes: subida web (`POST /api/sessions/:sid/datasets` → `BlobStore`) o archivo del workspace (`data_inspect { path }`, resuelto con `ctx.resolvePath`; la TUI no necesita adjuntar: el modelo inspecciona la ruta).
- El original siempre se conserva (blob o archivo del workspace); el `.sqlite` es una derivación regenerable (`ingest_version`).
- Dentro de una sesión, un mismo `sha256` reutiliza el dataset existente.

### 17.2 Ingesta en Node (`packages/core/src/analysis/data/ingest.ts` + `ingest-worker.ts`)

| Aspecto | Especificación |
|---|---|
| Proceso | **Proceso hijo** con el runtime actual (`process.execPath`; el binario Bun compilado se relanza con `BUN_BE_BUN=1`) en lugar de `worker_threads`, para no bloquear el bucle de eventos. Comprobado en Node 22.19 y Bun 1.4.2: `worker.terminate()` **no** interrumpe una llamada nativa de SQLite (una CTE recursiva infinita deja el hilo vivo y `terminate()` no resuelve), mientras que matar un proceso siempre funciona; `node:sqlite` funciona dentro de workers y de procesos hijos de Bun. El motor es un único script ES empaquetado (`engine-source.ts`, generado por `scripts/analysis-data-engine.ts` con `bun build`; el binario no lleva archivos sueltos), que el host escribe una vez en `<stateHome>/analysis/engine/` y ejecuta; habla JSON por líneas por stdin/stdout. |
| Parser CSV/TSV | Propio (`csv.ts`, sin dependencias), en streaming sobre `createReadStream` (la codificación se decide en una pasada previa con `TextDecoder` `fatal`): RFC 4180 (comillas, comillas dobladas, saltos de línea dentro de campos, CRLF/LF), BOM UTF-8 eliminado, BOM UTF-16 detectado; si los bytes no son UTF-8 válido (`TextDecoder` con `fatal: true`), se reintenta como `windows-1252` y se anota en `_alisio_meta`. Delimitador detectado entre `,` `;` `\t` `\|` en los primeros 64 KiB. Filas irregulares: se rellenan o recortan y se cuentan. |
| JSON / JSONL | JSONL en streaming por líneas; JSON (array de objetos) con `JSON.parse` hasta 50 MiB. Valores anidados se guardan como texto JSON. Columnas = unión de claves en orden de aparición. |
| Identificadores | Columnas `[a-z_][a-z0-9_]*` en minúsculas, sin acentos (NFKD), deduplicadas (`_2`, `_3`) y sin colisionar con `rowid`/`oid`/`_rowid_` (que ocultarían el rowid); el nombre original se guarda como `label`. Tabla `data` (CSV/JSON) o `s_<hoja>` (XLSX). Encabezado ausente (primera fila toda numérica) → `column_1…`. |
| Inferencia de tipos | Sobre las primeras 1 000 filas **ya almacenadas** (clase de almacenamiento y valor, para que CSV, JSON y XLSX den el mismo resultado): `integer`, `real`, `date` (ISO 8601), `boolean`, `text` (cualquier mezcla de números y texto es `text`). El tipo se guarda como **pista** en `_alisio_columns.inferred_type`. |
| Almacenamiento sin pérdida | Columnas declaradas **sin tipo** (afinidad BLOB: SQLite no convierte nada). La conversión la hace el parser: un valor se guarda como número solo si cumple la gramática numérica sin ceros a la izquierda ni separadores de miles y cabe en el rango seguro (`Number.isSafeInteger` para enteros); en cualquier otro caso se guarda **el texto exacto** (`"007"`, `"1,234"`, `"$12"`, `"N/A"`) y se cuenta en `text_fallbacks`. Fechas y booleanos quedan como texto. Celda vacía → `NULL`. Se documenta la única normalización: `"1.50"` se guarda como `1.5`. Comprobado: `node:sqlite` enlaza **todo** número JS como `REAL` (también en Bun), así que los enteros seguros se enlazan como `BigInt` para quedar como `INTEGER`. `text_fallbacks` = celdas de texto de una columna con algún número; en una columna solo de texto, las que parecen numéricas (con dígitos y sin letras: `007`, `$12`) salvo en columnas de fechas. |
| Escritura | `INSERT` preparado multi-fila (lotes de 500 filas, ≤ 32 766 parámetros), `BEGIN`/`COMMIT` cada 5 000 filas, `PRAGMA journal_mode=OFF` y `synchronous=OFF` sobre un archivo temporal `<id>.sqlite.tmp`; al terminar, estadísticas, `VACUUM` opcional (> 50 MiB no), cierre y `rename` al nombre final. En Windows el destino se borra antes del `rename` y toda conexión se cierra antes de borrar (bloqueo de archivos). En POSIX el archivo queda `0o400`. |
| Límites | `analysis.data.maxUploadBytes` (200 MiB), `maxRows` (5 000 000), 1 000 columnas, 1 MiB por celda. Superarlos detiene la ingesta con un error claro; no queda un dataset parcial. |
| Estadísticas | Por columna: filas, nulos, distintos (exacto hasta 1 000 000 filas; si no, recuento sobre una muestra —cota inferior— marcado `distinct_exact=0`), mín./máx., media (numéricas), 5 valores más frecuentes. Las calcula un único `finalizeDatabase` en SQL tras la ingesta de Node **y** tras el helper de Python, por lo que XLSX y su CSV dan estadísticas idénticas. |

Esquema del archivo (contrato compartido con el helper Python, versión `ingest_version = 1`):

```sql
CREATE TABLE _alisio_meta(key TEXT PRIMARY KEY, value TEXT);
-- keys: ingest_version, format, source_name, source_sha256, encoding, delimiter, created_at
CREATE TABLE _alisio_sheets(ordinal INTEGER PRIMARY KEY, name TEXT NOT NULL,
  table_name TEXT NOT NULL, rows INTEGER NOT NULL, columns INTEGER NOT NULL);
CREATE TABLE _alisio_columns(table_name TEXT NOT NULL, ordinal INTEGER NOT NULL,
  name TEXT NOT NULL, label TEXT NOT NULL, inferred_type TEXT NOT NULL,
  nulls INTEGER, distinct_count INTEGER, distinct_exact INTEGER,
  min TEXT, max TEXT, mean REAL, text_fallbacks INTEGER, top_values TEXT,
  PRIMARY KEY(table_name, ordinal));
CREATE TABLE "data"("region", "revenue", …);   -- rowid = original row order
```

### 17.3 Consultas de solo lectura (`data_query`; `query.ts`, `query-worker.ts`, `sql-guard.ts`)

| Capa | Medida |
|---|---|
| Validación previa (`sql-guard.ts`) | Tokenizador que respeta `'…'`, `"…"`, `` `…` ``, `[…]` y comentarios. **Una sola sentencia**: solo se admite un `;` final (comprobado en Node 22.19: `DatabaseSync.prepare()` ignora en silencio el texto tras la primera sentencia, así que la comprobación es obligatoria). Primera palabra clave `SELECT` o `WITH`. Rechazo de palabras clave fuera de literales: `ATTACH`, `DETACH`, `PRAGMA`, `INSERT`, `UPDATE`, `DELETE`, `REPLACE`, `CREATE`, `DROP`, `ALTER`, `VACUUM`, `REINDEX`, `ANALYZE`, `BEGIN`, `COMMIT`, `ROLLBACK`, `SAVEPOINT`, `RELEASE`, y de la función `load_extension`. Error `query_rejected` con el motivo. |
| Conexión | Conexión **separada** en el worker: `new DatabaseSync(path, { readOnly: true })`, después `PRAGMA query_only=ON` y `PRAGMA trusted_schema=OFF`; las extensiones siguen deshabilitadas (valor por defecto de `node:sqlite`). Solo se abre el archivo del dataset de la sesión; un `datasetId` de otra sesión responde `not_found`. |
| Límite de filas | `iterate()` y corte en `maxRows + 1` (por defecto 200, máximo 1 000) para indicar truncado; en el texto para el modelo, cada celda se recorta a 2 KiB. |
| Tiempo | `analysis.data.queryTimeoutMs` (5 000 ms): el host **mata el proceso** del motor (`SIGKILL`/`TerminateProcess`) y la consulta siguiente arranca otro; `worker.terminate()` no sirve (ver §17.2). El archivo está abierto en solo lectura, así que matar no lo corrompe. |
| Memoria | `--max-old-space-size` del proceso (solo Node) y `PRAGMA hard_heap_limit` (el SQLite de Node 22.19 y Bun 1.4.2 lo acepta; su efecto no se verificó con una consulta que lo supere). |
| Resultado | Texto tabular para el modelo + bloque `{ kind: "table" }` existente para la web y la TUI. |

Lo que `node:sqlite` **no** puede hacer (Node 22.16–22.19, verificado en 22.19; revisar en versiones nuevas):

- No hay `interrupt()`, *progress handler* ni *authorizer* en `DatabaseSync`: el tiempo máximo se impone terminando el worker, y la seguridad depende de la conexión de solo lectura más la validación léxica.
- `prepare()` acepta y descarta sentencias adicionales sin error (de ahí la validación de sentencia única).
- No hay lectura de CSV ni funciones de ventana extra más allá de las de SQLite; no hay `COPY` ni lectura de archivos externos (y no debe haberla).
- El API es síncrono; sin workers bloquearía el servidor.
- Sigue marcado como experimental en Node 22 (el aviso ya se suprime en `sqlite.ts`).

### 17.4 Paginación para `SpreadsheetView`

`GET /api/datasets/:did/rows?sheet=&after=&limit=&sort=&dir=&filter=&column=`:

- Sin orden: *keyset* por `rowid` (`WHERE rowid > ? ORDER BY rowid LIMIT ?`), `limit` ≤ 500. El `rowid` es denso (1..N en el orden del archivo), así que saltar a una fila sin orden ni filtro tampoco usa `OFFSET`; con ellos se usa `offset` ≤ 100 000.
- Con orden: *keyset* compuesto `WHERE ("col", rowid) > (?, ?) ORDER BY "col", rowid` (valores de fila, SQLite ≥ 3.15); el cursor `after` es opaco (base64 de `[rowid]`: el valor de la clave se recupera con una subconsulta sobre ese `rowid`, así no depende del recorte de celdas ni de los tipos y los NULL ordenan primero en ascendente y últimos en descendente, con desempate por `rowid` ascendente).
- Filtro: `column` + `filter` → `"col" LIKE ? ESCAPE '\'` (texto escapado). Sin `column`, solo en tablas ≤ 100 000 filas (todas las columnas de texto).
- Orden y filtro se desactivan por encima de `analysis.data.maxInteractiveRows` (1 000 000) con un aviso, porque no hay índices (el archivo es de solo lectura). `LIMIT/OFFSET` solo se usa para saltar a una fila concreta (≤ 100 000).
- El recuento total sale de `_alisio_sheets` (sin `COUNT(*)` por página).

### 17.5 `SpreadsheetView` (web, `components/artifacts/SpreadsheetView.tsx`, chunk diferido)

- Virtualización propia (sin TanStack): altura de fila fija de 28 px, solo filas visibles + 10 de margen; cabecera y columna de números de fila fijas (`position: sticky`); scroll horizontal.
- Selector de hoja, orden por clic en la cabecera (`aria-sort`), barra con columna + texto de filtro, copiar celda (`Ctrl/Cmd+C`) y fila, anchos de columna redimensionables con puntero y teclado, `Download original`.
- Accesibilidad: `role="grid"`, `aria-rowcount`/`aria-colcount`, `aria-rowindex` en las filas renderizadas, *roving tabindex* y flechas entre celdas.
- Caché LRU de 20 páginas de 200 filas.
- Se usa para datasets adjuntos y para artefactos `spreadsheet` (CSV/TSV/XLSX), que se ingieren de forma perezosa en la primera vista previa (`datasets.source_path` apunta al archivo del artefacto).
- En la TUI no existe: §16.4 muestra una tabla recortada.

### 17.6 XLSX: decisión

| Opción | Evaluación |
|---|---|
| **A. Dependencia JS pura** | SheetJS CE: licencia Apache-2.0, pero la copia del registro npm (`xlsx@0.18.5`) está desactualizada y con avisos de seguridad publicados; las versiones corregidas solo se distribuyen desde la CDN del proveedor, lo que rompe `pnpm-lock.yaml` reproducible (comprobado el 2026-10-01: `xlsx@0.18.5` sigue siendo `latest` en npm y `npm audit` lo marca como *high*: contaminación de prototipo y ReDoS). ExcelJS: MIT, pero arrastra varias dependencias transitivas y carga el libro en memoria (comprobado el 2026-10-01: `exceljs@4.4.0` instala 78 paquetes y 36 MB en `node_modules`). Ambas añaden superficie de parseo a core. |
| **B. Delegar al runtime Python** | Helper `alisio_runtime/xlsx_to_sqlite.py` **solo con la biblioteca estándar** (`zipfile`, `xml.etree.ElementTree.iterparse`, `sqlite3`): cadenas compartidas e *inline*, números, booleanos, fechas por `numFmtId` 14–22 y 45–47 o formatos personalizados con `d`/`m`/`y`/`h`/`s`, épocas 1900/1904, fórmulas → valor en caché, celdas combinadas → valor en la esquina superior izquierda. Límites anti zip-bomb: 1 GiB descomprimido y ratio 100:1. Escribe las tablas de datos, `_alisio_sheets` y los nombres de `_alisio_columns` con las mismas reglas de conversión (también las celdas de cadena pasan por la gramática numérica, como en un CSV); `finalizeDatabase` del motor completa tipos, estadísticas y `_alisio_meta`. Además rechaza XML con `DOCTYPE`/`ENTITY` y omite las filas sin valores. Implementado y probado con Python 3.10. |
| C. Lector propio en Node | `node:zlib` (`inflateRaw`) + tokenizador XML en streaming, ~500 líneas, sin dependencias y sin Python. Más código propio que mantener. |

**Recomendación: B** en la fase 3. No añade ninguna dependencia de runtime a core, reutiliza el runtime que la fase 1 ya detecta y no requiere openpyxl ni pandas. Sin Python, `data_inspect` sobre un `.xlsx` responde `dataset_unsupported` con el remedio *"Export the sheet as CSV, or install Python 3.10+."* La opción C queda como mejora si el propietario quiere Excel sin Python (§23).

El helper es código fijo de Alisio, no código del modelo: `data_inspect` mantiene el efecto `read` aunque lance un subproceso (decisión abierta sobre `--read-only`, §23).

### 17.7 Interoperabilidad con Python

- `python_run { inputs: [{ datasetId }] }` **copia** el `.sqlite` (clon `FICLONE` si el sistema de archivos lo permite; nunca un enlace, para que el script no altere el original) a `input/<name>.sqlite` y lo lista en `input/inputs.json`.
- `alisio_runtime.datasets.open(name)` devuelve `sqlite3.connect("file:<path>?mode=ro&immutable=1", uri=True)` y `columns(name)` lee `_alisio_columns`. Con los extras instalados, `pandas.read_sql_query` funciona sobre la misma conexión; sin ellos, el script usa `csv`, `statistics` y SQL.

---

## 18. Configuración

Sección nueva `analysis` en `configObjectSchema` (`packages/core/src/config.ts`):

```ts
analysis: z.object({
  enabled: z.boolean().default(true),
  runtime: z.enum(["managed", "oci"]).default("managed"),                  // global only
  oci: z.object({                                                          // global only
    engine: z.enum(["docker", "podman"]).default("docker"),
    image: z.string().regex(/@sha256:[a-f0-9]{64}$/).optional(),
    memoryMb: z.number().int().min(256).max(65536).default(2048),
    cpus: z.number().min(0.5).max(64).default(2),
  }).default({}),
  limits: z.object({
    timeoutMs: z.number().int().min(1000).max(900000).default(120000),
    maxFiles: z.number().int().min(1).max(1000).default(200),
    maxFileBytes: z.number().int().positive().default(100 * 1024 * 1024),
    maxOutputBytes: z.number().int().positive().default(500 * 1024 * 1024),
    maxLogBytes: z.number().int().positive().default(10 * 1024 * 1024),
  }).default({}),
  data: z.object({
    maxUploadBytes: z.number().int().positive().default(200 * 1024 * 1024),
    maxRows: z.number().int().positive().default(5_000_000),
    queryTimeoutMs: z.number().int().min(100).max(60000).default(5000),
    maxInteractiveRows: z.number().int().positive().default(1_000_000),
  }).default({}),
  retention: z.object({
    jobsDays: z.number().int().min(0).max(3650).default(30),
    intermediateDays: z.number().int().min(0).max(3650).default(7),
    artifactsDays: z.number().int().min(0).max(3650).default(0),          // 0 = keep
  }).default({}),
}).default({})
```

- **Solo configuración global** (como `mcp.allow`): `analysis.runtime` y `analysis.oci.*`. No existe clave para el intérprete: se autodescubre o se fija con `--python` (§8.1). Un `.alisio/config.json` de proyecto, aunque sea de confianza, no puede elegir el runtime ni la imagen (evita que un repositorio apunte a un binario propio). Se ignoran con un diagnóstico si aparecen en una capa de proyecto.
- Fase 1 (implementado): solo `analysis.enabled` y `analysis.limits.*`. Fase 3 (implementado): `analysis.data.*`. Fase 4 (implementado, 2026-10-01): `runtime`, `oci.*` y `retention.*`. La expresión regular de `oci.image` se ancla al inicio con un carácter alfanumérico (`^[a-zA-Z0-9][^\s@]*@sha256:[a-f0-9]{64}$`) para que un valor nunca se lea como opción de la CLI del contenedor.
- **Desviación (fase 4)**: `retention.*` también es **solo global** (además de `runtime` y `oci.*`): el barrido borra datos de todos los workspaces y una capa de proyecto no debe poder acortarlo. Las claves ignoradas de una capa de proyecto o `--config` se listan en `ConfigProvenance.ignored`, en `alisio doctor` y en `app.configDiagnostics`. En `jobsDays` e `intermediateDays`, `0` significa, igual que en `artifactsDays`, "no borrar nunca".
- `SETTABLE_KEYS` (con la página de Settings; **no** forma parte del alcance de la fase 2 de §21, así que se asigna a la fase 4 junto con la retención que configuran, pendiente de confirmación del propietario): `analysis.enabled`, `analysis.limits.timeoutMs`, `analysis.retention.jobsDays`, `analysis.retention.intermediateDays`, `analysis.retention.artifactsDays`. `setConfigValue` ya escribe claves de dos y tres niveles (`seccion.grupo.hoja`) conservando las hermanas (fase 4, implementado).
- Settings web (implementado en la fase 4; el estado sale de `GET /api/analysis`, que no estaba en §14.1): página nueva **Data analysis** (`components/settings/AnalysisPage.tsx`) con el estado del runtime (solo lectura: modo, versión de Python, extras instalados, `runtimeVersion`, remedio), el interruptor, el tiempo máximo y la retención. TUI: las mismas claves en `tui/settings-menu.ts`.
- Flags nuevas: `--allow-analysis` y `--python <path>` (CLI y `alisio serve`).

---

## 19. Retención, rerun y procedencia

| Tema | Especificación | Fase |
|---|---|---|
| Procedencia | `manifest.provenance` (§9.2) y columna `artifacts.provenance`. La web la muestra en `Details` / `Detalles` del menú del panel (fecha, modelo, proveedor, runtime, entradas con hash, ejecución); la TUI, como acción `Details` en `/artifacts`. Nunca muestra el script completo ahí. | 2 |
| Fuentes | `GET /api/artifacts/:aid/sources` y `Reveal analysis sources` en la TUI: acciones explícitas del usuario. | 2 |
| Retención | `AnalysisJanitor.sweep()` (nuevo) como máximo una vez cada 24 h, lanzado en segundo plano tras el arranque (temporizador `unref`, no retrasa el inicio; marca en `<stateHome>/analysis/.last-sweep`). Borra `work/` tras `intermediateDays`; `logs/` y `staging/` tras `jobsDays`; `script/` y `job.json` se conservan mientras algún artefacto de esa ejecución esté `ready`. Con `artifactsDays > 0`, los artefactos más antiguos pasan a `expired` (carpeta borrada, fila conservada; `ArtifactStore.markExpired`). Los datasets se borran tras `jobsDays` sin uso (no existe borrar sesión, §13), junto con su original subido en `blobs/` (y las subidas sin dataset, p. ej. una ingesta fallida). Implementado (fase 4): `input/` se conserva junto a `script/` (un rerun lo necesita) y se borra con ellos; el "último uso" de un dataset es la fecha de modificación de su archivo, que `DatasetService` actualiza al usarlo (como máximo cada 10 min), para no añadir una migración v7; un `running` de más de 24 h se considera huérfano de un proceso caído. | 4 |
| Rerun | Acción `Rerun` (web y TUI) sobre artefactos de `python_run`: nueva ejecución con el mismo `script/main.py` y las mismas entradas (verificadas por sha256; si falta una, se informa y no se ejecuta; implementado así: las entradas son las copias que guardó el trabajo original en `input/`, verificadas contra el hash registrado en `job.json`, y un dataset debe seguir existiendo con el mismo `sha256`. Una ejecución se pide con `python_run { rerunOf }`, y la nueva ejecución y sus artefactos llevan `provenance.rerunOf`), mismo gate de capability, nuevos artefactos con `rerun_of`; **nunca** sobrescribe la ejecución ni los artefactos anteriores. Se ejecuta con la primitiva `runToolCall` (§20). | 4 |

---

## 20. Estructura de módulos

### `@alisio/sdk`

| Archivo | Cambio |
|---|---|
| `packages/sdk/src/index.ts` | Tipos de §11 (aditivos). |

### `@alisio/core`

| Archivo | Cambio |
|---|---|
| `src/runtime/ids.ts` | **(nuevo)** generador ULID sin dependencias. |
| `src/runtime/paths.ts` | `workspaceKey()` (movida desde el servidor). |
| `src/runtime/process.ts` | Opción `onOverflow: "kill" \| "truncate"` y `logFiles: { stdout, stderr }` + `maxLogBytes` opcionales. |
| `src/runtime/zip.ts` | **(nuevo)** escritor ZIP en streaming con `node:zlib` (bit UTF-8 de nombres activo, sin ZIP64 por debajo de 4 GiB). |
| `src/runtime/store.ts` | Migración v6 y métodos para `artifacts`, `analysis_executions`, `capability_grants`, `datasets`. |
| `src/artifacts/kinds.ts` | **(nuevo)** registro de §7 y detección por bytes. |
| `src/artifacts/store.ts` | **(nuevo)** `ArtifactStore`: `publish`, `publishText`, `list`, `get`, `resolveFile`, `delete`, `markExpired`. |
| `src/analysis/runtime-manager.ts` | **(nuevo)** `discover()` por SO (§8.1), `status()`, `setup()`, `installExtras()`. |
| `src/analysis/install-hints.ts` | **(nuevo)** `pythonInstallHints()` (§8.1.1), función pura. |
| `src/analysis/managed.ts`, `src/analysis/oci.ts` | **(nuevos)** lanzadores sobre `runProcess`. |
| `src/analysis/jobs.ts` | **(nuevo)** carpetas de job, `job.json`, copia de entradas. |
| `src/analysis/capabilities.ts` | **(nuevo)** `CapabilityGrants`: `resolve`, `record`, `revoke`, `list`. |
| `src/analysis/janitor.ts`, `oci.ts`, `rerun.ts`, `status.ts` | **(nuevos, fase 4; implementado)** `AnalysisJanitor` (barrido, marca `.last-sweep`, bloqueo `.sweep.lock`), `OciRuntime`/`ociRunArgs`, `AnalysisRerun` y `analysisStatus`. |
| `src/analysis/requirements.ts` | **(nuevo)** lockfiles de `analysis` y `science` con versiones y hashes (solo wheels, `uv pip compile --universal --generate-hashes --only-binary :all:`), incrustados como cadenas por la misma razón. |
| `src/analysis/python/alisio_runtime/*.py` | **(nuevos)** `__init__`, `outputs`, `html` (incl. `inline_plotly`), `svg` (gráficos simples sin dependencias), `datasets`; `xlsx_to_sqlite` llega en la fase 3. Se incrustan en `src/analysis/python/sources.ts` (generado; `tests/analysis-runtime-sources.test.ts` detecta desfases), porque `pack:check` solo admite `.js`/`.d.ts` y el binario Bun no lleva archivos sueltos. |
| `src/analysis/data/{csv,json,infer,sql-guard,stats,ingest-worker,query-worker,engine-entry,engine-types}.ts` | **(nuevos, fase 3; implementado)** El motor: se empaqueta en `engine-source.ts` (generado; `tests/analysis-data-engine-sources.test.ts` detecta desfases por hash de las fuentes sin espacios). |
| `src/analysis/data/{engine-client,datasets,rows,describe}.ts` | **(nuevos, fase 3)** `DataEngine` (proceso hijo, tiempo límite por muerte del proceso), `DatasetService` (ingesta, reutilización por sha256, consultas, páginas), SQL de páginas keyset y texto para el modelo. No hay `ingest.ts`/`query.ts` separados. |
| `src/tools/analysis.ts` | **(nuevo)** `python_run`. |
| `src/tools/artifacts.ts` | **(nuevo)** `artifact_create`, `artifact_list`, `artifact_read`, `artifact_export`. Implementado: `artifact_read` y `artifact_export` (fase 2) más `exportedPaths()`; `artifact_create` y `artifact_list` siguen en `src/tools/analysis.ts` desde la fase 1. |
| `src/tools/data.ts` | **(nuevo, fase 3)** `data_inspect`, `data_query` (registradas con `analysis.enabled`, también con `--read-only`). |
| `src/tools/standard.ts` | Registro condicionado (R4). |
| `src/core/contracts.ts` | `ApprovalRequest.capability?`, `Policy.analysis?`. |
| `src/core/runner.ts` | Resolución de capability antes del gate de efecto; `ctx.runId`, `ctx.callId`, `ctx.artifacts`. |
| `src/application.ts` | Cableado (`ArtifactStore`, `CapabilityGrants`, `AnalysisRuntimeManager`), `allowAnalysis`, y primitiva **`runToolCall(sessionId, name, input, source)`** (nuevo) que crea un run sin modelo con `run_started`/`tool_*`/`run_completed` (para exportar y rerun desde la UI). Comprobado: `SessionService` no tenía nada equivalente. Implementado como `AgentRunner.runToolCall(sessionId, name, input, options)` en `src/core/runner.ts` (sin `source`: la decisión de aprobación ya registra su origen), que comparte con `run()` el método `executeCall` (rutas externas, capability, gate de efecto con aprobación, diario de llamadas, publicador de artefactos, límite del resultado). Deja en la transcripción una nota de usuario (`display`), un mensaje del asistente con la llamada (id alfanumérico de 9 caracteres), el resultado y un resumen del asistente, para que el historial siga siendo válido para cualquier proveedor. |
| `src/config.ts` | Sección `analysis`, claves globales, `SETTABLE_KEYS`. |
| `src/commands/builtins.ts` | `artifacts`, `permissions`. |
| `src/index.ts` | Exportaciones nuevas. |

### `@alisio/server`

| Archivo | Cambio |
|---|---|
| `src/routes/artifacts.ts`, `src/routes/datasets.ts`, `src/routes/capabilities.ts` | **(nuevos)** §14.1. |
| `src/routes/artifact-view.ts`, `src/auth/view-token.ts` | **(nuevos)** §14.2. |
| `src/http/router.ts` | Segmento final `*`. |
| `src/index.ts` | Registro de rutas; cabeceras propias para `/artifact-view/`. |
| `src/bridges/approval-bridge.ts` | `capability` y `preview` en `PendingApproval`. |
| `src/sse/hub.ts` | Frames `capabilities_changed`, `dataset_ready`, `dataset_failed`. |
| `src/host/workspace-host.ts` | Reexporta `workspaceKey` como `workspaceId`. |

### `@alisio/web`

| Archivo | Cambio |
|---|---|
| `src/store/artifacts.ts`, `src/store/layout.ts` | **(nuevos)** |
| `src/components/artifacts/{ArtifactCard,ArtifactPanel,ArtifactMenu,DownloadFallback,HtmlFrame,PdfFrame,ImageView,SpreadsheetView}.tsx`, `artifacts.module.css` | **(nuevos)** |
| `src/components/layout/Resizer.tsx`, `resizer.module.css` | **(nuevos)** |
| `src/components/header/PermissionsPopover.tsx`, `src/components/settings/AnalysisPage.tsx` | **(nuevos)** |
| `src/app.tsx`, `src/store/dock.ts` | Ranura derecha única. |
| `src/components/transcript/Transcript.tsx`, `ToolRow.tsx` | Tarjetas por turno. |
| `src/components/approval/ApprovalPanel.tsx` | Variante de capability. |
| `src/components/icons.tsx`, `src/i18n/en.ts`, `src/i18n/es.ts` | Iconos y claves de §15.6. |
| `src/net/api.ts`, `src/net/events.ts`, `src/renderers/kinds.ts` | Cliente, eventos, kind `artifact`. |

### `@alisio/alisio-code` (CLI/TUI)

| Archivo | Cambio |
|---|---|
| `src/analysis.ts` | **(nuevo)** `alisio analysis status` (intérprete descubierto, extras, modo) y `alisio analysis setup [--extras analysis\|science] [--oci]`, solo para extras u OCI; nunca necesario para la ejecución base. |
| `src/tui/open-path.ts`, `src/tui/artifact-preview.ts` | **(nuevos)** §16.3, §16.4. |
| `src/main.ts` | `--allow-analysis`, `--python <path>`, subcomando `analysis`, línea en `doctor`, salida `--no-tui` de §16.6. |
| `src/tui/app.ts` | `/artifacts`, `/permissions`, `approve` con capability. |
| `src/tui/components.ts` | `renderArtifactBlock`. |
| `src/tui/settings-menu.ts` | Claves de §18. |
| `src/serve.ts` | Usa `open-path.ts`; acepta `--allow-analysis`. |

### Documentación y CI

- **(nuevos)** `docs/analysis.md` y `docs/es/analysis.md` (runtime, artefactos, límites de aislamiento, datos); entrada en `docs/.vitepress/config.ts`.
- Actualizar en EN y ES: `tools.md` (herramientas, `--allow-analysis`, capability), `web.md` (tarjeta, panel, rutas, eventos), `tui.md` (`/artifacts`, `/permissions`), `configuration.md` (`analysis`), `limitations.md` (aislamiento, `node:sqlite`, XLSX), `architecture.md`; y `docs/implementation-status.md`.
- `.github/workflows/ci.yml` hoy solo usa `ubuntu-latest`: añadir un job `portability` con `windows-latest` y `macos-latest` que ejecute las pruebas marcadas de §21 (descubrimiento de Python, rutas, `open-path`, ZIP, ingesta, `node:sqlite` en workers).

---

## 21. Plan de implementación por fases

Cada fase es una porción vertical utilizable. Criterios y pruebas se separan en **core/servidor**, **web** y **TUI/headless**. Todas las pruebas van en `tests/` con el patrón de nombres existente (`server-*.test.ts`, `web-*.test.ts`, `tui-*.test.ts`, `store-migration-vN.test.ts`) y prueban comportamiento observable en la frontera del módulo; **no** se añaden snapshots. Las pruebas que necesitan Python real se saltan con un motivo explícito si no hay intérprete, y el job `portability` (§20) las ejecuta en Linux, macOS y Windows.

### Fase 1 — Ejecutar Python y descargar el resultado

**Alcance.** Migración v6; `ids.ts`, `zip.ts`, `kinds.ts`, `ArtifactStore`; `AnalysisRuntimeManager` (autodescubrimiento sin configuración, ejecución base **solo biblioteca estándar** sin venv, `--python`, `alisio analysis status`, `alisio analysis setup --extras`, línea en `doctor`); `python_run`, `artifact_create`, `artifact_list`; capability `analysis.run` en el runner con grants persistidos; `--allow-analysis`; `artifact_published`; `/permissions` y `/artifacts` (TUI); rutas `GET …/artifacts`, `GET /api/artifacts/:aid[/download]`, `GET|DELETE …/capabilities`; `ArtifactCard` (solo descarga) y popover de permisos en la web; anuncio, picker y acciones de la TUI.

**Criterios — core/servidor**

1. En una máquina con Python ≥ 3.10 en `PATH`, **sin configuración ni comando previo**, con `--allow-analysis`, un run con el proveedor simulado de las pruebas (en la implementación: `AppOptions.provider` con un proveedor falso, como `tests/server-helpers.ts`; `tests/integration.test.ts` ejecuta escenarios de `fixtures/scenarios.ts`) cuyo `python_run` escribe `report.md` y `chart.svg` en `$ALISIO_OUTPUT_DIR` produce dos `artifact_published` en el JSONL, dos filas `ready` y dos carpetas cuyo contenido coincide byte a byte; `script/main.py` existe en el job y **ningún** `.py`, log ni `job.json` aparece bajo `artifacts/`.
2. Una carpeta de `staging/` con `index.html` + `assets/` se publica como un único `dashboard` multiarchivo; `GET …/download` devuelve un ZIP con exactamente esos archivos.
3. Un enlace simbólico, un `..` o superar `maxFiles`/`maxFileBytes` hace fallar la publicación completa con un motivo legible; no queda ninguna fila ni carpeta.
4. `exitCode ≠ 0` no publica; con `publishOnError: true` publica con `partial: true`. El timeout deja `timed_out` y no publica. Cancelar el run termina el árbol de procesos en ≤ 6 s y deja `cancelled`.
5. Matriz de §10.3: `--read-only` → `python_run` ausente de la lista de herramientas; headless sin flag → ausente; grant `session` persistido → no pregunta tras reiniciar el proceso y reanudar la sesión; revocado → vuelve a preguntar; `deny` → error de herramienta sin crear job; aprobar `analysis.run` **no** permite `shell`.
6. Sin Python: `python_run` devuelve `runtime_unavailable` con las instrucciones del sistema detectado (`pythonInstallHints` probado con `platform`/`os-release` inyectados para Windows, macOS con y sin Homebrew, Debian/Ubuntu, Fedora, Arch, openSUSE, Alpine y Python < 3.10); `alisio doctor` muestra la misma guía; ningún comando se ejecuta; `artifact_create` publica igualmente un `.md`. Tras instalar Python, la siguiente llamada lo descubre sin reiniciar. Con `--python /ruta/inexistente`: `python_run` responde con el motivo (sin probar otros candidatos) y `doctor` lo indica.
7. Autodescubrimiento: el arranque no lanza ningún proceso Python (comprobado con un `spawn` inyectado); la primera llamada lo hace una vez y escribe `discovery.json`; las siguientes no relanzan el sondeo; cambiar el ejecutable (`mtime`) fuerza un nuevo descubrimiento.
7. Rutas: sin cookie → `401`; un artefacto de otra sesión → `404`; `Content-Disposition` con `filename*` UTF-8 correcto para `informe año 2026.pdf`; `X-Content-Type-Options: nosniff` en todas.
8. Ningún cambio en el JSONL ni en el comportamiento de los runs que no usan las herramientas nuevas (pruebas existentes en verde).

**Criterios — web**

1. La tarjeta aparece debajo de las filas de herramientas del turno con icono, nombre y la etiqueta de tipo; el botón de descarga es visible en reposo.
2. En la fase 1 todos los artefactos se tratan como no previsualizables: el clic descarga y **nunca** aparece "Abrir archivo".
3. Tras recargar la página, la tarjeta sigue ahí (desde `tool_calls.result`) y refleja `deleted` si se borró.
4. `ApprovalPanel` muestra el título y la advertencia de `managed`; `S` persiste el grant; el popover de permisos lo lista y `Revoke` lo revoca; otra pestaña se actualiza con `capabilities_changed`.

**Criterios — TUI/headless**

1. El anuncio de §16.1 aparece con icono, tipo, nombre, tamaño y ruta; sin color con `NO_COLOR` y con iconos ASCII cuando el terminal no admite Unicode.
2. `/artifacts` lista y filtra; `Open with default app`, `Copy path`, `Reveal in folder` y `Delete` funcionan; en una sesión SSH, abrir muestra el aviso y ofrece copiar la ruta sin lanzar procesos.
3. La aprobación usa el picker existente con `Allow once` / `Allow for this session` / `Deny`; `Esc` deniega; `/permissions` revoca.
4. `--no-tui` imprime la línea `artifact: …`; `--json` incluye `path`; nada se abre solo.

**Criterios — portabilidad (Linux, macOS, Windows)**

1. Descubrimiento de Python probado con plataforma, `PATH`/`PATHEXT` e inspección de ejecutables inyectados: `--python` → `uv python find` → `py -3` (Windows) → `python3` → `python`; se descarta el alias de Microsoft Store (`%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe`); se exige ≥ 3.10.
2. El intérprete del venv se resuelve como `venv\Scripts\python.exe` en Windows y `venv/bin/python` en POSIX, con `node:path` (sin separadores escritos a mano); rutas con espacios y caracteres no ASCII funcionan (argumentos en array, sin shell).
3. La ejecución base funciona **sin red, sin venv y sin configuración** en las tres plataformas (`import alisio_runtime` desde `script/`).
4. Cancelar termina el árbol en Windows (`taskkill /T /F` existente) y en POSIX (grupo de procesos).
5. El ZIP generado pasa `python -m zipfile -t` en las tres plataformas y conserva nombres UTF-8.
6. `open-path.ts` construye `xdg-open`/`open`/`explorer.exe` según la plataforma y nunca usa un shell.

**Pruebas nuevas**: `store-migration-v6.test.ts`, `artifact-store.test.ts`, `artifact-kinds.test.ts` (extensión frente a bytes: conflicto → `file`), `zip-writer.test.ts`, `analysis-python-run.test.ts`, `analysis-capabilities.test.ts` (matriz de §10.3), `analysis-runtime-discovery.test.ts`, `analysis-install-hints.test.ts`, `server-artifacts.test.ts`, `server-capabilities.test.ts`, `web-artifacts-store.test.ts` (reconciliación por `id`, estados), `tui-artifacts.test.ts` (líneas del anuncio, acciones disponibles por tipo), `open-path.test.ts`. Ampliar: `run-events-contract.test.ts`, `ui-blocks-fallback.test.ts`, `command-catalog-tui-parity.test.ts`, `server-approvals.test.ts`.

**Documentación**: `docs/analysis.md` + `docs/es/analysis.md` (nuevas); `tools.md`, `tui.md`, `web.md`, `configuration.md`, `limitations.md` en EN y ES; `docs/implementation-status.md` (alcance verificado y lo que queda para la fase 2).

### Fase 2 — Panel de workspace y vistas previas

**Estado: implementada** (2026-10-01; recomendaciones del documento pendientes de confirmación del propietario). Desviaciones registradas en §7, §14.1, §14.2, §15.3, §18 y §20; alcance verificado en `docs/implementation-status.md`. La página **Data analysis** de Settings y las claves editables de `analysis` no están en el alcance de esta fase (§18).

**Alcance.** Comodín del router; `POST …/view`, `/artifact-view/:token/*`, `GET …/files/*`, `…/sources`, `…/export`, `DELETE`; `runToolCall`; `artifact_read`, `artifact_export`; `ArtifactPanel` completo con `Resizer` compartido con el Dock, renderers, desplegable, menú, pantalla completa, expandir, estrecho, `Details`; "Abrir archivo" en tarjetas previsualizables; `/artifacts` en la web; vista previa en terminal, `Copy to workspace…`, `Reveal analysis sources` y `Details` en la TUI.

**Criterios — core/servidor**

1. Respuesta de `/artifact-view/…` para HTML: CSP exactamente como §14.2 (incluye `connect-src 'none'` y `sandbox allow-scripts allow-downloads`), sin `X-Frame-Options`, `Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: private, no-store`.
2. Token caducado → `403`; token del artefacto A no sirve archivos de B; `..`, `%2e%2e%2f` y rutas absolutas → `404`; la ruta no exige cookie pero sí `Host` válido; solo `GET`/`HEAD`.
3. Los registros del servidor no contienen tokens de visualización (redactados).
4. `artifact_export` pasa por el gate `write` (pregunta sin `--allow-write`, no existe con `--read-only`), confina el destino al workspace y el archivo aparece en `Changes`.
5. `…/sources` devuelve `script/main.py` y `job.json`, y los logs solo con `?logs=1`.

**Criterios — web**

1. En reposo la tarjeta muestra la etiqueta de tipo; con hover **o** foco visible muestra "Abrir archivo"/"Open file" solo si es previsualizable; un `.docx` o `.zip` nunca lo muestra.
2. Clic en la tarjeta abre el panel con ese artefacto; clic en descargar descarga sin abrirlo; con el panel abierto, la tarjeta tiene `aria-expanded="true"`.
3. Asa: el ancho respeta 320 px y el máximo calculado; doble clic restablece; flechas ±16 px, `Shift` ±64 px, `Home`/`End`; el ancho persiste tras recargar; con `localStorage` lanzando excepciones el panel sigue funcionando con el ancho por defecto.
4. Cabecera: desplegable con los artefactos de la sesión y el actual marcado; Descargar, Pantalla completa y Cerrar con `aria-label`; Cerrar devuelve el foco a la tarjeta.
5. Cada tipo usa su renderer de §15.3; un artefacto > límite muestra el fallback con el motivo.
6. El iframe tiene exactamente `sandbox="allow-scripts allow-downloads"`; un dashboard de prueba que intenta `fetch("/api/sessions")`, leer `document.cookie`, `parent.document` y `localStorage` falla en los cuatro casos (comprobación manual documentada en `docs/implementation-status.md`, o E2E si el repositorio adopta un runner de navegador). Comprobado: el repositorio no tiene runner de navegador en sus pruebas (Vitest en Node); la comprobación se hizo a mano con Playwright y está registrada en `docs/implementation-status.md`.
7. Bajo 900 px el panel es un diálogo modal a pantalla completa; `Esc` sigue el orden de §15.4; abrir el Dock cierra el panel y viceversa; con Settings o Agents abiertos el panel queda `inert` y el iframe no se recarga.
8. `Open in new tab` abre el dashboard aislado (sin cookie, sin red).

**Criterios — TUI**

1. `Preview here` solo aparece para Markdown, CSV/TSV, JSON y texto; respeta los límites de §16.4 y muestra `truncated`.
2. Dashboards, PDF e imágenes solo ofrecen `Open with default app`.
3. `Copy to workspace…` usa la aprobación `write` existente y desaparece con `--read-only`.

**Criterios — portabilidad**: el destino de `artifact_export` acepta separadores `\` y `/` en Windows y se normaliza; `Reveal` usa `explorer.exe /select,` en Windows y `open -R` en macOS; el panel se valida manualmente en Chrome, Firefox y Safari (registro en `implementation-status.md`).

**Pruebas nuevas**: `server-artifact-view.test.ts`, `server-artifacts-export.test.ts`, ampliación de `server-http.test.ts` (comodín del router), `web-artifact-panel.test.ts` (funciones puras: `clampPanelWidth`, pasos de teclado, exclusividad de `rightPanel`, `cardSubtitle(artifact, active)`), `tui-artifact-preview.test.ts`, `artifact-tools.test.ts` (`artifact_read` truncado, `artifact_export` confinado).

**Documentación**: `web.md` (panel, seguridad del visor, limitaciones del iframe: `Esc` dentro del iframe, sin red ni almacenamiento), `tui.md`, `analysis.md`, en EN y ES; `implementation-status.md`.

### Fase 3 — Datos tabulares con `node:sqlite`

**Estado: implementada** (2026-10-01; recomendaciones del documento pendientes de confirmación del propietario). Desviaciones registradas en §7, §14.1, §17.2–17.4, §17.7, §18 y §20: motor en proceso hijo (no `worker_threads`), cursor `[rowid]`, ruta `…/dataset` de artefactos y `…/download`. La página **Data analysis** de Settings y las claves editables de `analysis` siguen asignadas a la fase 4 (§18; §21 no las incluye en esta fase). El resumen del prompt se añade al texto del mensaje (`display` conserva lo escrito) y los adaptadores de proveedor ignoran `datasets` (construyen sus campos explícitamente; comprobado en `plugin-openai-compatible`).

**Alcance.** §17 completo: ingesta en workers, `data_inspect`, `data_query`, guardia SQL, helper XLSX en Python (biblioteca estándar), rutas de datasets, frames `dataset_*`, subida desde el compositor web (el botón `+` acepta además CSV, TSV, JSON, JSONL y XLSX), chips de dataset, resumen de texto en el mensaje del usuario (esquema + 5 filas + estadísticas, ≤ 4 KB; el mensaje lleva `datasets?: DatasetRef[]` opcional para la UI; comprobado en la fase 3: los adaptadores de proveedor ignoran campos desconocidos de `Message`), `SpreadsheetView` para datasets y artefactos `spreadsheet`, interoperabilidad con `python_run`.

**Criterios — core/servidor**

1. Un CSV de 1 000 000 filas se ingiere sin bloquear el servidor: durante la ingesta `GET /api/health` responde en < 100 ms y el SSE mantiene su latido.
2. Sin pérdida: `"007"`, `"1,234"`, `"$12"` y `"N/A"` se leen tal cual; `text_fallbacks` los cuenta; las columnas numéricas limpias permiten `SUM`/`AVG`.
3. BOM UTF-8, BOM UTF-16, CRLF, `;` como delimitador y bytes `windows-1252` se ingieren correctamente.
4. Guardia: se rechazan `SELECT 1; DROP TABLE data`, `ATTACH 'x' AS y`, `PRAGMA writable_schema=1`, `WITH x AS (DELETE FROM data RETURNING *) SELECT * FROM x` y `SELECT load_extension('x')`; se aceptan `SELECT`/`WITH` válidos y palabras prohibidas dentro de literales.
5. `WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c) SELECT count(*) FROM c` termina con `query_timeout` en ≤ `queryTimeoutMs + 1 s` y la consulta siguiente funciona.
6. Un `datasetId` de otra sesión → `not_found`. Superar `maxRows` o `maxUploadBytes` no deja dataset parcial.
7. `python_run` con `inputs: [{ datasetId }]` lee el mismo archivo con `sqlite3` en modo solo lectura.
8. Un `.xlsx` de prueba y su exportación CSV producen las mismas columnas, tipos inferidos y estadísticas; sin Python, el `.xlsx` devuelve `dataset_unsupported` con el remedio.

**Criterios — web**: subir un CSV muestra `Reading sales.csv…` y luego un chip; `SpreadsheetView` pagina sin duplicados ni huecos al ordenar (keyset), desactiva orden y filtro por encima de `maxInteractiveRows` con aviso, es navegable con teclado (`role="grid"`) y copia celda y fila; un artefacto CSV se abre en `SpreadsheetView`.

**Criterios — TUI**: `data_inspect`/`data_query` muestran tablas con `renderTableBlock`; la TUI no adjunta archivos: el modelo usa `data_inspect { path }` sobre archivos del workspace (rutas externas siguen el flujo de directorios existente).

**Criterios — portabilidad**: ingesta y consulta pasan en Linux, macOS y Windows; en Windows se borran y reemplazan archivos `.sqlite` sin `EBUSY` (conexiones cerradas antes); las pruebas de datos también pasan bajo Bun (comprobado en la fase 3: `worker.terminate()` no interrumpe una llamada nativa de SQLite ni en Node ni en Bun, así que el motor es un proceso hijo; bajo Bun lo ejercita `pnpm test:compiled`).

**Pruebas nuevas**: `data-csv-parser.test.ts`, `data-ingest.test.ts`, `data-sql-guard.test.ts` (tabla de aceptadas/rechazadas), `data-query.test.ts`, `data-xlsx.test.ts`, `server-datasets.test.ts`, `web-spreadsheet.test.ts` (lógica de páginas y cursores), ampliación de `web-composer.test.ts` / `web-attachments.test.ts`.

**Documentación**: `analysis.md` (datos, formatos, límites de `node:sqlite`), `web.md` (adjuntos de datos), `limitations.md` (XLSX requiere Python; sin índices; orden desactivado en tablas grandes), en EN y ES; `implementation-status.md`.

### Fase 4 — OCI, extras bajo demanda, retención y rerun

**Estado: implementada** (2026-10-01; recomendaciones D1–D14 pendientes de confirmación del propietario, D10 = valores de retención de §18). Desviaciones registradas en §8.3, §18, §19 y aquí: `retention.*` solo global; la instalación desde el chat pasa por `ToolContext.approveInstall` (SDK, aditivo; el host de plugins lo retira de las herramientas externas) y la aprobación lleva `install` (`PendingApproval`, `ApprovalRequest`, `approval_requested`); `python_run` gana `extras` y `rerunOf` (con `rerunOf`, `code` es opcional y se exige exactamente uno); rutas nuevas `POST /api/artifacts/:aid/rerun` y `GET /api/analysis`; subcomandos `alisio analysis setup --oci [--image]` y `alisio analysis sweep`, en `packages/cli/src/analysis.ts`; el comprobador de wheels es `scripts/analysis-extras-wheels.ts` y corre en el job `extras-wheels` (Linux, todas las plataformas con `pip download --platform`) y, para la plataforma propia, en `portability`. Los artefactos expirados siguen listados (web y TUI) con `Details` y `Rerun`. **No implementados** (opcionales según §23, sus recomendaciones los difieren): origen separado para el visor (D8), lector XLSX en Node (D6, se mantiene B), plantillas de artefacto y XLS/ODS/Parquet. Verificado: Docker en Linux (red bloqueada, escritura fuera de `/job/out` y `/job/work` rechazada, cancelar no deja contenedores), instalación real de extras con `uv` y fallo limpio sin red, y las wheels de las 2 listas en 6 plataformas × Python 3.10/3.12/3.13 (huecos reales: Windows Arm antes de 3.13 para `science` y antes de 3.12 para `analysis`; Alpine/musl sin scikit-learn). No verificado: Podman, Docker Desktop en macOS y Windows, Windows y macOS en general (job `portability`).

**Alcance.** Runtime `oci`; capability `analysis.install` (instalación de extras desde el chat con aprobación de una sola vez); `AnalysisJanitor`; `Rerun`; opcionales según §23: origen separado para el visor, lector XLSX en Node, plantillas de artefacto, formatos XLS/ODS/Parquet (Parquet solo con extras).

**Criterios — core**

1. `oci`: un script que abre una conexión de red falla; escribir fuera de `/job/out` y `/job/work` falla; cancelar ejecuta `kill` y no quedan contenedores `alisio-*`; una imagen sin digest se rechaza en la carga de configuración.
2. Extras: `python_run { extras: ["analysis"] }` sin extras instalados pide `analysis.install` (solo `once`) en TUI y web; en headless falla con el remedio `alisio analysis setup --extras analysis` (comando opcional); la instalación usa `--require-hashes` y `--only-binary=:all:` (sin compilar nada).
3. Retención con reloj inyectado: `work/` se borra a los 7 días, logs a los 30, el script se conserva mientras haya artefactos `ready`; artefactos expirados muestran `Expired`.
4. Rerun: nueva ejecución con el mismo hash de script, artefactos nuevos con `rerun_of`, los anteriores intactos; entradas cambiadas → no se ejecuta y se informa.

**Criterios — web y TUI**: `Rerun` y `Details` disponibles en el menú del panel y en `/artifacts`; la aprobación de instalación muestra paquetes, tamaño estimado y que requiere red.

**Criterios — portabilidad**: OCI con Docker Desktop (macOS y Windows; montajes de rutas con espacios) y Podman sin root (Linux), verificados manualmente y anotados; disponibilidad de wheels de los extras para Linux/macOS/Windows en x64 y arm64 comprobada con `pip download --only-binary=:all:` en el job `portability`.

**Pruebas nuevas**: `analysis-oci.test.ts` (construcción de argumentos; ejecución real solo si hay motor, si no se salta con motivo), `analysis-extras.test.ts`, `analysis-janitor.test.ts`, `analysis-rerun.test.ts`.

**Documentación**: `analysis.md` (OCI, extras, retención, rerun), `configuration.md`, `limitations.md`, en EN y ES; `implementation-status.md`.

---

## 22. Definition of Done consolidada

1. `python_run` funciona **sin configuración**: autodescubre Python ≥ 3.10 (o usa `--python <path>`), ejecuta el script del modelo con solo la biblioteca estándar, fuera del repositorio, y publica todo lo que deja en `$ALISIO_OUTPUT_DIR`. Sin Python, responde con instrucciones de instalación para el sistema detectado y no ejecuta nada.
2. Los scripts, logs e intermedios viven en `analysis/jobs/…` y nunca aparecen en `artifacts/…`, en las descargas ni en el repositorio salvo acción explícita.
3. Cualquier tipo de archivo se publica; el registro de §7 decide tipo, MIME, etiqueta y si es previsualizable; los no previsualizables se descargan.
4. `artifact_create` publica artefactos de texto sin Python.
5. La ejecución exige `analysis.run` (o un permiso amplio de `process`); las decisiones `once`/`session`/`deny` funcionan en TUI y web; `session` persiste y sobrevive a reinicios; se revoca con `/permissions`, el popover web o la API; todo queda auditado.
6. `--read-only` elimina la herramienta; headless sin permiso no la ofrece; nada se abre ni se aprueba solo.
7. La UI y la documentación dicen que `managed` no es un sandbox.
8. Web: tarjeta con icono, nombre, etiqueta de tipo en reposo, "Abrir archivo" en hover/foco solo si es previsualizable, descarga siempre visible; estados `loading`, `error`, `expired`, `deleted`.
9. Web: panel redimensionable (mín./máx., doble clic, teclado, ancho persistido con tolerancia a fallos de almacenamiento, expandir), cabecera con desplegable de artefactos y Descargar/Pantalla completa/Cerrar, renderers por tipo, modo estrecho, `Esc`, convivencia con Dock y modales.
10. Los dashboards se muestran en un iframe `sandbox="allow-scripts allow-downloads"` servido por token con CSP sin red; también al abrirlos en una pestaña nueva.
11. TUI: anuncio compacto, `/artifacts` con filtro y acciones (abrir, copiar ruta, revelar, exportar con gate `write`, vista previa acotada para tipos de texto), sin renderizar dashboards, PDF ni imágenes.
12. Headless: `artifact_published` en JSONL con ruta; línea en `--no-tui`.
13. Descarga individual o ZIP sin fuentes; fuentes solo por acción explícita.
14. Datos: CSV/TSV/JSON/JSONL ingeridos con `node:sqlite` en un archivo por dataset, sin pérdida de valores, con consultas de solo lectura acotadas en filas y tiempo; XLSX vía Python estándar; `SpreadsheetView` virtualizada con paginación keyset.
15. Ningún motor de base de datos ni dependencia nativa nuevos; core no añade dependencias npm de runtime.
16. Procedencia en cada artefacto; rerun sin sobrescribir; retención configurable.
17. Linux, macOS y Windows cubiertos por el job `portability`; Bun verificado para las partes de Node.
18. Migración v6 aditiva probada; contratos del SDK aditivos; pruebas existentes en verde.
19. `pnpm typecheck`, `lint`, `test`, `build`, `test:cli`, `test:compiled`, `pack:check`, `docs:check`, `docs:build` en verde.
20. Documentación EN/ES en paridad y `docs/implementation-status.md` con el alcance verificado y las limitaciones.

---

## 23. Riesgos abiertos y decisiones del propietario

### 23.1 Riesgos

| # | Riesgo | Mitigación |
|---|---|---|
| R1 | El usuario asume que `managed` aísla | Advertencia en aprobación, descripción de la herramienta, Settings y documentación; recomendar `oci` para datos no confiables. |
| R2 | Inyección de instrucciones desde los datos lleva al modelo a escribir un script dañino | La aprobación muestra el script; `analysis.run` no se concede por defecto; `oci` sin red. |
| R3 | Exfiltración desde un dashboard | `connect-src 'none'`, `img-src` limitado a la ruta del token, sin `allow-popups` ni navegación superior; riesgo residual: descargas iniciadas por el dashboard (`allow-downloads`). |
| R4 | Fuga del token de visualización | Caducidad de 10 min, ligado a un artefacto, `no-referrer`, redacción en logs. |
| R5 | `node:sqlite` sigue siendo experimental y su API cambia entre versiones de Node y Bun | Adaptador único y pruebas en ambos runtimes; aprovechar `interrupt`/authorizer si aparecen, sin depender de ellos. |
| R6 | PDF embebido sin `sandbox` | Visor nativo del navegador con CSP mínima; alternativa: solo descarga o pdf.js (decisión D9). |
| R7 | Crecimiento de disco (jobs, datasets, artefactos) | Límites por ejecución, retención (fase 4) y tamaños visibles en `/artifacts` y en la web. |
| R8 | Rutas largas en Windows (`MAX_PATH`) | IDs cortos y estructura plana; prueba con nombres largos en el job `portability`. |
| R9 | Descubrimiento de un intérprete inesperado (shims de pyenv, conda) | Mostrar ruta y versión en `doctor`, Settings y la aprobación; `--python <path>` para fijarlo. |
| R10 | Memoria en ingestas grandes | Streaming, lotes, límites y worker con `resourceLimits`. |
| R11 | `'unsafe-inline'` en la CSP del visor | Necesario para HTML generado; solo dentro del origen opaco aislado. |

### 23.2 Decisiones que requieren al propietario

Estado: la fase 1 adoptó la recomendación de D1, D2, D3, D4, D5, D7, D8, D11, D12 y D14, y la fase 4 la de D10 (retención 30 / 7 días, artefactos sin caducidad), todas **pendientes de confirmación del propietario** (registrado en `docs/implementation-status.md`).

| # | Decisión | Recomendación de este documento |
|---|---|---|
| D1 | Core frente a plugin built-in `@alisio/plugin-data-analysis` | Core (ADR-01). |
| D2 | `analysis.enabled` activo por defecto o desactivado hasta optar | Activo: con Python autodescubierto, `python_run` aparece sin configuración. |
| D3 | ¿Un grant `session` persistido aplica en `resume` headless? | Sí, documentado. |
| D4 | Añadir la flag `--allow-analysis` | Sí. |
| D5 | Contenido de los extras `analysis` (p. ej. `reportlab` frente a otras librerías de PDF; incluir Plotly) | `pandas`, `numpy`, `matplotlib`, `openpyxl`, `python-docx`, `reportlab`, `plotly`, `jinja2`, solo con wheels para las tres plataformas. |
| D6 | XLSX: opción B (Python estándar) o C (lector propio en Node, Excel sin Python) | B en la fase 3; C solo si se necesita Excel sin Python. |
| D7 | ¿El helper XLSX (código fijo de Alisio) puede ejecutarse con `--read-only`? | Sí, como efecto `read`; alternativa: bloquearlo. |
| D8 | Origen separado (segundo puerto) para el visor | Diferido; el token + `sandbox` + CSP basta para v1. |
| D9 | PDF: visor nativo sin `sandbox`, solo descarga o pdf.js | Visor nativo con fallback de descarga. |
| D10 | Valores por defecto de retención (30 / 7 días / artefactos sin caducidad) | Los de §18. |
| D11 | Crear `datasets` en v6 o en una v7 de la fase 3 | v6. |
| D12 | Exponer `ctx.artifacts` a plugins externos y MCP en v1 | Solo built-ins en v1; abrirlo después. |
| D13 | Coste del job de CI en Windows y macOS | Solo las pruebas marcadas de portabilidad. |
| D14 | ¿Devolver imágenes publicadas al modelo (visión) automáticamente? | No en v1; el modelo usa `artifact_read` en texto. |

---

## Apéndice A — Destino de cada sección de la v1.2 original

| Secciones originales | Destino |
|---|---|
| 1 Objetivo | §1 (generalizado a cualquier artefacto). |
| 2–3 Tres dominios y regla de separación | §6 y R1 (§4.2), con rutas reales bajo `stateHome()`. |
| 4–9 Autorización, capability, permisos excluidos, scopes, persistencia, resolución | §10 (capability `analysis.run`; `deny` no pegajoso; sin `capability.*` como herramientas). |
| 10–11 Approval UI y TUI | §15.5 y §16.5 sobre `ApprovalPanel` y `approve` existentes. |
| 12 Revocación | §10.4, `/permissions`, popover web; política fija `allow-current-execution`. |
| 13 Audit trail | §10.4 y §14.3 (eventos existentes ampliados). |
| 14 Ejecución frente a artefacto | §6, §9, tablas `analysis_executions` y `artifacts`. |
| 15 Descargas | §14.1 (`download`, `sources`). |
| 16 Promoción | `artifact_export` (§12) bajo el gate `write`. |
| 17 `ALISIO_HOME` | §6.2 (`stateHome()`; `ALISIO_HOME` no existe). |
| 18–19 Manifiestos | §9.2 y `job.json` (§6.2). |
| 20–21 Ingesta y Data Attachment | §17.1–17.2 y `DatasetRef` (§11). |
| 22 SpreadsheetView | §17.5 (sin TanStack). |
| 23 Data engine (DuckDB/Polars/pandas) | **Eliminado DuckDB**; §17 con `node:sqlite` + `sqlite3` de Python; pandas/Polars como extras opcionales. |
| 24 Contexto del LLM | §21 fase 3 (resumen ≤ 4 KB) y `data_inspect`. |
| 25–26 Data tools y cuándo usar Python | §12 y §17. |
| 27–29 Runtimes | §8 (`managed`, `oci`; Pyodide descartado para v1). |
| 30–31 Staging y pipeline | §9.1. |
| 32–34 Dashboard output, visualización, plantillas | §8.2 (`outputs.json`), §14.2 (recursos locales), plantillas diferidas. |
| 35–38 Viewer, seguridad, vistas | §14.2, §15.2–15.4. |
| 39 SSE | §14.3 (snake_case). |
| 40 Endpoints | §14.1 (`/api/sessions/:sid`, `/api/artifacts/:aid`, `/api/datasets/:did`). |
| 41–44 Toolset y flujos | §12 y diagramas de §8.2, §9.1 y §17.1. |
| 45–46 TUI y slash commands | §16 (`/artifacts`, `/permissions`). |
| 47 SQLite | §13 (migración v6). |
| 48–50 Retención, rerun, procedencia | §19. |
| 51 Optimización | §4.2 R4, §17 (streaming, keyset, workers). |
| 52–53 Configuración y Settings | §18. |
| 54 DoD | §22. |
| 55–56 Arquitectura y decisión final | §5 (ADR) y §6. |
