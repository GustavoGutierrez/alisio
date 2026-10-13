# Especificación Técnica: Perímetro — declarar y verificar el alcance del agente

| Campo | Valor |
| --- | --- |
| Versión | 0.1 |
| Proyecto | Alisio |
| Estado | **Aprobada por el propietario (2026-10-12): decisiones O1–O10 confirmadas.** No se ejecuta hasta que hayan cerrado `specs/archive/009-forja-v1.md` (Fases 1–8) y `specs/archive/008-forja-python-v1.md` (P0–P4). |
| Fecha | 2026-10-12 |
| Paquetes afectados | `@alisio/sdk` (tipos aditivos: `PerimeterSnapshot`, `SurfaceDeclaration`, `ProbeResult`, `IsolationProbe`), `@alisio/core` (nuevo `packages/core/src/perimeter/*`, comando del reporte, evento `perimeter_snapshot`, auto-pruebas, export/import de memoria), `@alisio/server` (ruta `GET /api/perimeter`), `@alisio/web` (privado: tarjeta de perímetro), `@alisio/alisio-code` (TUI: panel `/perimeter`; CLI: `alisio perimeter`) |
| Paquetes nuevos | Ninguno. Sin dependencias nuevas de producción (las auto-pruebas reutilizan `run_process`, `read_file` y herramientas existentes; la Fase 4 puede reutilizar los backends `OciBackend`/`PyodideBackend` de Forja Python). |
| Relación con otras especificaciones | Depende de los contratos de `specs/archive/009-forja-v1.md` (`ExecutionKernel`, `IsolationLevel`, `CapabilityBroker`/gate D7, `EngineDescriptor`) y de `specs/archive/008-forja-python-v1.md` (`OciBackend`, backend selector, `analysis.isolation`). Independiente de `specs/019-capability-routing-v1.md` (pausada) y `specs/020-model-tier-router-v1.md` (no implementada). Complementaria de `specs/021-workspace-sources-v1.md`: cuando existan fuentes remotas, cada una declara su nivel en el mismo reporte. |
| Superficies | Web, TUI y headless (`alisio run`) con paridad funcional; API HTTP de `alisio serve` |
| Política de versión | Funcionalidad nueva: **la siguiente minor al ejecutar**, después de forja-v1 (esperado 0.6.0) y forja-python-v1 (esperado 0.7.0) → **esperado 0.8.0**. Si se publica un parche entre medias, las minors se desplazan: los números son «la siguiente minor al ejecutar» (mismo criterio que `009-forja-v1.md`). Aditiva; la Fase 4 introduce políticas **opt-in** que no cambian el comportamiento por defecto. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento.
2. Etiquetas: **(verificado)** = comprobado leyendo el repositorio o ejecutando una prueba el 2026-10-12; **(no verificado)** = deducido o externo sin prueba ejecutada en este repositorio; **(nuevo)** = no existe.
3. **TDD estricto Rojo → Verde → Refactor** (mismo criterio que Forja, §12). Ninguna línea de producción sin una prueba que falle antes. Pruebas en `tests/*.test.ts`, sobre comportamiento en límites de módulo. Sin pruebas de instantánea.
4. **Orden obligatorio**: Fase 0 (si el propietario la pide: medición de overhead y sondeo) → el propietario revisa → Fases 1–6. Cada fase deja el repo verde con `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check` y `pnpm docs:build`. No hagas commit hasta que lo pida el propietario.
5. **Asignación de modelos**: §13. Por defecto Sonnet 5.5; Opus 5.5 solo en los tres puntos listados.
6. Reglas del repo que no se rompen: solo pnpm; Node >=22.16 y debe funcionar en Bun; solo APIs portables de Node en los paquetes; ningún SDK de proveedor ni import específico de runtime en `@alisio/sdk` ni en los contratos del core; los plugins dependen solo de `@alisio/sdk`; preservar IDs de llamadas a herramientas, datos de continuación del proveedor y consistencia de sesión persistida; **un manifiesto de plugin o un subproceso no es un sandbox**.
7. Los contratos son **aditivos**: ninguna ruta, evento ni columna existente cambia de semántica, salvo lo indicado explícitamente.
8. Idioma: identificadores, claves, mensajes de error y textos generados en inglés; textos de UI en inglés y español (`src/i18n/en.ts` y `es.ts`); esta especificación en español.
9. Esta especificación **no crea permisos nuevos ni cambia el gate**: todo lo declarado depende de la política de permisos existente (`docs/tools.md`), que no se modifica en las Fases 1–3 ni 5–6.

## 1. Objetivo, usuarios y principio rector

### 1.1 Objetivo

Que **cualquier persona, en cualquier momento, pueda responder con evidencia** a tres preguntas sobre una sesión de Alisio:

1. **¿Qué puede alcanzar este agente ahora mismo?** — por superficie (sistema de archivos, procesos, red, MCP, plugins, skills, memoria, git, ejecución de código), con el nivel de aislamiento **declarado y verificado**, y con los huecos **nombrados**.
2. **¿Esto que declara es verdad en esta máquina, en este momento?** — auto-pruebas no destructivas que verifican cada declaración y reportan desvíos (drift). Nada se afirma por número de versión: se comprueba en vivo.
3. **¿Qué recuerda este agente de mí?** — memoria legible, exportable e importable, con metadatos de procedencia, sin renunciar a la búsqueda FTS5 existente.

La tesis de producto es: **Alisio no compite por tener más capacidades; compite por tener la capacidad de decir la verdad sobre sus propias capacidades, y por cerrar de forma verificable y opt-in los huecos que hoy lo dejan a la par de un arnés con sandbox parcial.** La comparativa verificada de la §2 justifica las decisiones O3–O8.

### 1.2 Usuarios (identificados)

Esta especificación sirve a tres personas concretas. El público **primario** fue decidido por el propietario (O2, confirmada el 2026-10-12): **U1**. Esta sección documenta las personas y la evidencia que sostuvo la decisión.

| ID | Persona | Escenario real | Dolor actual (verificado) | Qué le da Perímetro | Lo que explícitamente NO es para esta persona |
| --- | --- | --- | --- | --- | --- |
| **U1** | **El dev auto-hospedado** (freelancer, estudiante, equipo pequeño). Quiere el poder de un agente de código sin cuenta de vendor, sin nube, con SU proveedor y SUS llaves. | Corre `alisio run` o la TUI sobre un repo propio, con plugins y un MCP local, a veces contra archivos con credenciales (`~/.ssh`, `.env`). | No puede responder «¿qué alcanzó ese agente?» ante un auditor, un cliente o sí mismo. El arnés pide aprobar, pero no muestra el perímetro completo. | Reporte de alcance por sesión, atestado JSON estable para CI/auditoría, cierre opt-in de `shell` con política fail-closed, memoria exportable. | No le interesa onboarding guiado ni lenguaje llano; ya vive en la terminal. |
| **U2** | **El profesional no técnico con datos propios** (analista de negocio, investigador, docente). Quiere análisis, estadística y dashboards sobre SUS archivos, sin Docker ni entorno de desarrollo. | Usa `python_run` sobre Excel/CSV propios para generar un dashboard. No sabe qué es un sandbox ni quiere saberlo. | El arnés exige configurar endpoint, API key y terminal (gap documentado: hoy no hay onboarding; `alisio setup` asume terminal). | Cuando U2 llega a una sesión (vía un perfil preconfigurado por un técnico), el reporte le habla en lenguaje llano: «esto se ejecuta aislado» / «esto no se ejecuta aislado» con colores y texto, sin jerga. | Esta especificación **no** resuelve el setup de U2 (provider + API key); eso es otra entrega. Con O2 confirmada (U1 primario), la vista avanzada del reporte es la base y la vista simplificada para U2 se difiere a una entrega posterior. |
| **U3** | **El técnico que audita** (security reviewer, lead de equipo). No es el usuario final: es una capacidad que U1 necesita. | Revisa qué podía tocar un agente en una ejecución de CI o en una sesión compartida. | No existe ningún artefacto máquina-legible honesto: Claude Code declara un sandbox parcial (fail-open, solo shell; ver §2) y Alisio no declara nada comparable. | `alisio perimeter --json` con esquema versionado `perimeter/v1`, garantía `--read-only`, `perimeter check` con resultado de drift. | Probar la ausencia de aislamiento más allá de lo que las auto-pruebas pueden sondear (sin kernel hardening). |

**Decisión O2 (confirmada por el propietario el 2026-10-12):** público primario **U1**, secundario **U2 con las porciones gobernadas ya existentes** (Forja/Python/Fase 4), **U3 como capacidad derivada de U1** (no como audiencia). Razón de fondo: U1 es donde el diferencial es visible hoy (el reporte no requiere ningún cambio de onboarding), y U3 es gratis una vez que `perimeter --json` existe. U2 exige resolver primero el setup, lo que está fuera de esta especificación.

### 1.3 Principio rector

> **Lo que el agente puede tocar y lo que recuerda se declara, se verifica y nunca excede lo ejecutable. Un reporte que afirma más de lo que la máquina puede probar es peor que ningún reporte.**

Deriva directamente del principio de Forja (§1.2: *«El script es una entrada no confiable; el núcleo es la única autoridad»*) y de la invariante común de las cinco specs: *«el código determinista ejecuta y nunca toca permisos»*. Perímetro añade la dirección inversa: **el código determinista también informa** — y el reporte incluye sus propios límites.

Reglas derivadas:

- El reporte **nombra los huecos** (superficies sin aislamiento declarado) en el mismo plano visual que las garantías. Un panel que solo muestra lo aislado y oculta lo demás está **prohibido** por esta especificación (D3).
- La **verificación nunca es un número de versión**: cada nivel declarado se prueba en la máquina actual con auto-pruebas no destructivas (D6). Donde la prueba no pueda correr, se declara `unverified` y se muestra como tal (D7).
- El **recién llegado no se arriesga**: el comportamiento por defecto de cada release es **byte-idéntico al anterior**; el cierre de huecos es opt-in con puerta de benchmark (D10, D13).
- **Nada de esta especificación decide permisos**: el gate existente es la única autoridad. Perímetro solo declara y verifica (O8).

### 1.4 Nombre

La funcionalidad se llamará **Perímetro**, identificador `perimeter`: el borde declarado y verificado de lo que el agente puede alcanzar. Alternativas evaluadas: `boundary` (colisiona con la jerga de red), `reach` (ambiguo: alcance de tarea vs. de superficie), `attestation` (solo cubre la mitad: atestado, no reporte). Los identificadores públicos que lo contienen: `perimeter` (config, evento, comando) y `perimeter_check` en el texto que ve el modelo cuando se le pide verificar (D14); renombrar cuesta poco porque no hay API pública además de estas.

### 1.5 Alcance

Reporte de alcance por sesión (declaraciones + verificación), auto-pruebas no destructivas, evento `perimeter_snapshot`, ruta `GET /api/perimeter`, panel TUI `/perimeter`, tarjeta web, CLI `alisio perimeter status|probe|check|memory export/import`, export/import biyectivo de memoria, configuración `perimeter` (global-only), documentación EN/ES y capturas.

### 1.6 Fuera de alcance (por qué NO se compite ahí)

La comparativa verificada de la §2 muestra dónde gana Claude Code por escala, no por diseño. Perseguir esas capacidades **contradice la tesis** (hipermercado de features) y **consume el núcleo** que sostiene la gobernanza. No-goals duros, sin revisión en esta especificación:

| Excluido | Motivo |
| --- | --- |
| Integración en IDEs (VS Code, JetBrains, Cursor) | Alcance de distribución; no es gobernanza. Claude Code ya lo tiene. No competir. |
| App de escritorio, web/móvil, Slack/Discord/Telegram/webhooks, Chrome | Superficies de alcance masivo; no es gobernanza. No competir. |
| Scheduling (cron, routines, `/loop`) | No es gobernanza. `bg_run` ya cubre tareas de fondo locales. |
| Commit/PR automático | **Decisión de diseño ya tomada**: `docs/specification.md` §9 prohíbe commits como efecto colateral; las tools de git son read-only (`git_status`, `git_diff`). Claude Code hace commits/PRs; Alisio no, por principio, no por falta de tiempo. |
| GitHub Actions / GitLab CI «actions» | Requiere cuenta de plataforma y mantenimiento externo; contradice el arnés local sin cuenta. El atestado `perimeter --json` cubre el caso de auditoría sin dependencias de plataforma (Fase 6). |
| SSO, RBAC, managed settings organizacionales, compliance API, CMEK | Capa enterprise de Claude Code; Alisio es single-user consciente. La configuración que decide es global-only (D12). |
| Memoria vectorial / semántica | Ya excluida (`docs/memory.md`: sin embeddings, sin red). Perímetro hace la memoria **legible**, no semántica. |
| OAuth interactivo de MCP | Ya excluido (pendientes 1.0.0). No se arrastra a esta especificación. |
| Sandbox completo de herramientas del host (Fase 4 incluida) | Hereda el límite explícito de forja-v1 §1.5: «Sandbox de herramientas del host (shell, MCP, plugins): no los vuelve aisladas». La Fase 4 **reduce y declara**, nunca promete aislamiento OS. |
| Windows/macOS certificados | CI sigue cubriendo solo Linux (pendiente 1.0.0). El reporte declara `platform: linux` y las probes se marcan como no verificadas en plataformas no cubiertas (D7). |

## 2. Base verificada: por qué esta es la jugada

Comparativa contra la documentación oficial de Claude Code, **verificada el 2026-10-12 en `code.claude.com/docs`** (no memoria). Cada afirmación de Claude Code tiene cita de página; cada afirmación de Alisio, cita de repo.

### 2.1 Donde Claude Code admite un perímetro parcial

| Hecho de Claude Code | Cita (página oficial) | Implicación |
| --- | --- | --- |
| El sandbox de Bash está **apagado por defecto** | «The sandbox is off by default. To turn it on, run `/sandbox`» (sandboxing) | El aislamiento no es el estado por defecto. |
| Es **fail-open**: si faltan dependencias o la plataforma no soporta el sandbox, corre sin sandbox | «By default, if the sandbox can't start because a dependency is missing or the platform is unsupported, Claude Code runs commands without sandboxing» (sandboxing) | El peor caso (sin sandbox) no se distingue en la UI del caso aislado. |
| Cubre **solo shell** (Bash, PowerShell, Monitor) | «The sandbox covers shell commands only» (sandboxing) | Las tools de archivo y web corren fuera: «A `denyRead` entry doesn't stop the Read tool, and `allowedDomains` doesn't limit WebFetch» (sandboxing). |
| Dentro del sandbox, **las lecturas por defecto son la mayor parte de la máquina, incluidas credenciales** | «Reads \| Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`» (sandboxing) | Un comando «aislado» puede leer credenciales; la red sí parte vacía («allowed domains, which start empty»). |
| Windows nativo corre **sin sandbox** (necesita WSL2) | «On native Windows, Claude Code runs commands unsandboxed» (sandboxing) | Plataforma por plataforma, el nivel declarado cambia sin que se declare. |
| Auto memory: **ON por defecto**, markdown plano, índice cargado «primeras 200 líneas o 25 KB» | «Auto memory is on by default in local sessions»; «Loaded into: Every session (first 200 lines or 25KB)» (memory) | La memoria de Claude Code es auditable (markdown editable) pero **se trunca** y no se consulta. |
| Hace commit/PR automáticamente | «It stages changes, writes commit messages, creates branches, and opens pull requests» (overview) | Ver §1.6: Alisio lo excluye por decisión de diseño. |

### 2.2 Donde Alisio ya tiene la base y la esconde

| Hecho de Alisio (verificado en repo) | Cita | Implicación |
| --- | --- | --- |
| Efectos por tool: `read`/`write`/`process`/`external`/`internal`, con `--read-only` que gana a todo | `docs/tools.md` | La materia prima del reporte existe; no hay un artefacto que la exponga. |
| Escalera de aislamiento declarada por motor | `specs/archive/009-forja-v1.md` §5.1: `os-container > wasm-isolate > wasm-process > none`, con `EngineDescriptor.isolation` y `ready` | El nivel **ya es un dato** en el SDK; Perímetro lo agrega por superficie. |
| Fail-closed de Forja | forja-v1 D17: si `quickjs-wasi` no carga o el hash no coincide, `js_run` no se registra | El precedente de la política que la Fase 4 extiende a `shell`. |
| Máquina de MCP: `mcp list`, `alisio mcp doctor`, consent `mcp.allow` global | `docs/tools.md`, `docs/configuration.md` | El inventario de servidores existe; el reporte solo lo declara. |
| Memoria: SQLite FTS5 + BM25 + trigram, topic upserts, `memory_*` con efecto `internal` | `docs/memory.md` | La consulta existe y es superior en escala a Claude Code (que trunca); falta la legibilidad. |
| Telemetría: Alisio no recoge ninguna | `docs/tui.md` §Settings | La honestidad ya es un valor del producto; el reporte la hace visible. |

### 2.3 La conclusión que justifica O3–O8

- Claude Code no puede responder «¿qué alcanzó este agente?» con un artefacto honesto: su sandbox es opt-in, fail-open, solo-shell y con lecturas anchas por defecto (verificado §2.1). **No artificialmente: estructuralmente.**
- Alisio tiene la materia prima (efectos por tool, escalera por motor, fail-closed, sin telemetría) pero **no tiene el artefacto**. El artefacto es barato (aditivo, sin permisos nuevos) y es exactamente lo que U1/U3 necesitan.
- Una vez que el reporte existe, **cerrar los huecos se vuelve opt-in y medible**: la Fase 4 ataca el hueco más grande (shell) con la política inversa a Claude Code (fail-closed opt-in en lugar de fail-open por defecto).

## 3. Decisiones

### 3.1 Decisiones del propietario (confirmadas el 2026-10-12; se aplican exactamente)

| ID | Decisión (confirmada) |
| --- | --- |
| O1 | La funcionalidad se llama **Perímetro** (`perimeter`) (§1.4). |
| O2 | Público primario **U1**; U2 como secundario con porciones gobernadas; U3 como capacidad (§1.2). **DECIDIDO.** La vista avanzada del reporte es la base; la simplificada para U2 se difiere. |
| O3 | El reporte **declara también los huecos** en el mismo plano visual que las garantías. Sin huecos sin declarar (D3). |
| O4 | La **verificación es por auto-prueba en vivo**, nunca por número de versión; el resultado `unverified` se muestra como tal (D6, D7). |
| O5 | El comportamiento por defecto de cada release es **byte-idéntico al anterior**: todo el cierre es opt-in (D10, D13). |
| O6 | La **memoria legible entra como parte del perímetro de conocimiento** (Fase 5): export/import biyectivo, FTS5 sigue siendo la consulta. |
| O7 | El **atestado máquina-legible estable** (`perimeter --json`, esquema `perimeter/v1`) se diseña desde la Fase 1, no al final (D8). |
| O8 | **Nada de esta especificación decide permisos.** El gate existente es la única autoridad; Perímetro solo declara y verifica. |
| O9 | Los presupuestos de benchmark son **objetivos, no garantías** (§11); si una puerta no se cumple, la fase entrega sin promoción y lo reporta. |
| O10 | Orden de ejecución: tras cerrar forja-v1 y forja-python-v1; versión esperada 0.8.0 (§Política de versión). |

### 3.2 Decisiones de diseño (vinculantes)

| ID | Decisión |
| --- | --- |
| D1 | El reporte separa **cámara declarada** (config + políticas + declaraciones por superficie) de **cámara verificada** (resultados de auto-prueba). Un campo `status: "declared" \| "verified" \| "unverified" \| "drift"` por superficie. Nunca se mezclan. |
| D2 | Esquema JSON **versionado y estable** `perimeter/v1` (§5). Aditivo: los campos pueden crecer; ningún campo existente cambia de semántica. El CLI y la ruta HTTP emiten exactamente este esquema. |
| D3 | Cada superficie lleva `declaredLevel` **y** `gaps: string[]`. Las superficies sin nivel declarado aparecen con `declaredLevel: null` y un `gap` que lo dice («no isolation declared for surface shell»). La UI muestra los gaps con el mismo peso visual que las garantías. |
| D4 | Se reutiliza `IsolationLevel` de forja-v1 §5.1 (`os-container \| wasm-isolate \| wasm-process \| none`) para toda superficie. No se inventa una escalera nueva. Para superficies gobernadas solo por política (p. ej. `read_file`), el nivel declarado es `none` y la descripción aclara «policy-gated, not isolated». |
| D5 | Superficies del reporte (v1): `filesystem`, `process`, `network`, `mcp`, `plugins`, `skills`, `memory`, `git`, `execution` (motores Forja), `external`. Cada una con: `declaredLevel`, `verifiedLevel`, `status`, `gaps`, `policy` (comportamiento por defecto: `ask`/`allow-once`/`allow-session`/`disabled`), `probe` (resultado, `probedAt`, `probeId`). |
| D6 | **Auto-pruebas no destructivas** por superficie (§6). Toda prueba es read-only, con presupuesto de tiempo (D13, §11), y se marca `probeId` para reproducibilidad. Nunca escriben fuera del scratch temporal del propio proceso, nunca tocan la red, nunca inician procesos con efectos. |
| D7 | Una prueba que no puede correr (plataforma no cubierta, dependencia ausente, permiso de SO) produce `status: "unverified"` y el reporte lo dice con su motivo. **Prohibido** silenciar un `unverified`. La plataforma se declara (`os`, `node`, `runtime`) en el encabezado del reporte. |
| D8 | `alisio perimeter --json` emite `perimeter/v1` con el encabezado `{ schemaVersion, sessionId, gitRevision, workspaceRoot, platform, generatedAt }`. Garantizado **sin prompts y equivalente a `--read-only`** para su generación. Opcional `--hash` (metadatos solo) para detectar drift entre ejecuciones en CI. |
| D9 | El evento de sesión `perimeter_snapshot` es aditivo y se emite una vez por sesión en el arranque y bajo demanda (`/perimeter`). En headless JSONL, el reporte va como artefacto JSONL versionado y **nunca** como texto dentro del contexto del modelo salvo petición explícita del usuario o del modelo con una tool dedicada (D14). |
| D10 | **Cierre opt-in con política inversa a Claude Code.** Config `perimeter.closure.shell: "declare" \| "shadow" \| "limit" \| "os-container"` (§7), default `declare` = sin cambio de comportamiento, reporte veraz. `shadow` registra qué se habría bloqueado sin bloquear; `limit` aplica restricciones sin sandbox OS (scrub de env, capacidades de recursos, red denegada donde el SO lo permite y la sonda lo confirma); `os-container` reutiliza `OciBackend` de Forja Python. Y `perimeter.closure.failBehavior: "warn" \| "disable-surface"` (default `warn`): `disable-surface` es la **única** política fail-closed, y solo bloquea la superficie si la restricción no puede aplicarse. La promoción de `limit`/`os-container` a default **nunca** ocurre sin puerta de benchmark (D13). |
| D11 | La matriz `declared` se construye desde estado existente, no desde un modelo que lo infiera: flags `--allow-*`, modos de permiso, `mcp.allow`/manifiesto de servidores, plugins cargados, motores Forja (`EngineDescriptor.ready/isolation`), tamaños de memoria. El reporte es un **render** del estado, y el código que lo renderiza es determinista. |
| D12 | La configuración que decide es **global-only** (`perimeter.*`): los proyectos solo pueden **reducir** niveles (p. ej. forzar `shadow` cuando el global dice `limit`), nunca ampliarlos. Misma regla que la §1.2 de `workspace-sources` y D16 de forja. Un valor de proyecto que intenta ampliar produce diagnóstico y se ignora. |
| D13 | Presupuestos y puertas (§11): overhead del render ≤ 5 ms p99; sonda completa ≤ 2 s (default) con `--fast` ≤ 200 ms; export/import biyectivo (round-trip 100 %); la Fase 4 se promueve solo con paridad en shadow (éxito de tareas no cae > 2 puntos frente a baseline sin cierre). Si una puerta no se cumple, la fase entrega con la feature `off`/experimental y el resultado queda en `docs/benchmark-perimeter.json`. |
| D14 | Al modelo se le expone una tool **`perimeter_check`** (efecto `internal`, familia `core` en el futuro routing): devuelve el reporte renderizado corto (≤ 4 KB) a petición. El reporte completo nunca se incrusta en el prompt. La tool existe para que el modelo pueda responder «¿puedo tocar X?» con el render, no para que decida nada. |
| D15 | Memoria legible (§8): `memory_export` y `memory_import` (efecto `internal`, disponibles en `--read-only` para export). El export es markdown plano con frontmatter YAML (análogo al formato auditable de Claude Code) y round-trip con FTS5 garantizado por prueba (B3). `memory_import` es idempotente y nunca borra: solo agrega o actualiza por `topic_key` + `id`. |
| D16 | La Fase 5 añade al reporte la sección `memory`: número de observaciones, distribución por tipo, últimas `k` escrituras con `topic_key`, tamaño del archivo SQLite y un aviso textual cuando la memoria contiene contenido que el usuario podría querer exportar antes de compartir una sesión. |
| D17 | El panel TUI `/perimeter` y la tarjeta web reutilizan los patrones de Forja (badges de motor, lista de llamadas, tarjeta) sin duplicar componentes: los badges de ejecución muestran `isolation` de `EngineDescriptor` y los de superficie muestran `declaredLevel` + `status`. |
| D18 | Sin dependencias nuevas de producción. Las auto-pruebas usan herramientas existentes (`run_process` con `--read-only` equivalencia, `read_file`, `list_files`, `git`); la Fase 4 reutiliza backends existentes. Cualquier propuesta de dependencia nueva se discute con el propietario antes de entrar en una fase. |
| D19 | Cada fase actualiza `docs/implementation-status.md` (la fuente de verdad de límites) con lo entregado y con lo que sigue sin aislamiento. El reporte y ese archivo nunca se contradicen. |

## 4. Concepto

```
┌─────────────────────────── PERÍMETRO (perimeter/v1) ───────────────────────────┐
│ header: schemaVersion · sessionId · gitRevision · workspaceRoot · platform     │
│ surfaces: [                                                                     │
│   filesystem   declared=none(policy)  verified=none   probe=P-FS ✓   gaps:[]   │
│   process      declared=none          verified=none   probe=P-PROC ✓ gaps:[…]  │
│   network      declared=external-gate verified=none   probe=P-NET ✓  gaps:[…]  │
│   mcp          declared=none          verified=none   probe=P-MCP ✓ gaps:[…]   │
│   plugins      declared=none          verified=none   probe=P-PLUG ✓ gaps:[…]  │
│   skills       declared=read-only     verified=read   probe=P-SK ✓   gaps:[]   │
│   memory       declared=none          verified=none   probe=P-MEM ✓ gaps:[]   │
│   git          declared=read-only     verified=read   probe=P-GIT ✓ gaps:[]   │
│   execution    declared=wasm-isolate  verified=…      probe=P-FORGE ✓ gaps:[]  │
│   external     declared=external-gate verified=none   probe=P-XT ✓  gaps:[…]   │
│ ]                                                                                │
│ memory: count · byType · lastWrites · dbSizeBytes · exportAvailable: true       │
│ closure: { shell: "declare" (default) · failBehavior: "warn" }                  │
│ verifiedBy: [ probeId, probedAt, result ]                                       │
└──────────────────────────────────────────────────────────────────────────────────┘
```

El reporte es un **render determinista del estado** (D11) más los resultados de auto-prueba (D6). El único código que produce texto visible es el render; el único código que produce niveles verificados es la sonda. El LLM nunca participa en la construcción del reporte.

## 5. Contratos

### 5.1 Extensiones aditivas del SDK (`packages/sdk/src/index.ts`, aditivo)

```typescript
export type SurfaceId =
  | "filesystem" | "process" | "network" | "mcp" | "plugins"
  | "skills" | "memory" | "git" | "execution" | "external";

export type PerimeterStatus = "declared" | "verified" | "unverified" | "drift";

export interface PerimeterHeader {
  schemaVersion: 1;            // esquema "perimeter/v1"
  sessionId: string;
  gitRevision: string | null;
  workspaceRoot: string;
  platform: { os: string; node: string; runtime: "node" | "bun" };
  generatedAt: string;         // ISO 8601
}

export interface SurfaceDeclaration {
  surface: SurfaceId;
  declaredLevel: IsolationLevel | null;   // null = sin aislamiento declarado (gap)
  policy: "ask" | "allow-once" | "allow-session" | "disabled";
  status: PerimeterStatus;
  gaps: string[];                        // D3: obligatorio que refleje la verdad
  probe?: ProbeResult;                   // cámara verificada (D1)
  details?: Record<string, unknown>;     // p. ej. motor: EngineDescriptor
}

export interface ProbeResult {
  probeId: string;                       // p. ej. "P-FS-linux-1"
  surface: SurfaceId;
  passed: boolean | null;                // null => unverified (D7)
  reason?: string;
  probedAt: string;
}

export interface PerimeterSnapshot {
  schemaVersion: 1;
  header: PerimeterHeader;
  surfaces: SurfaceDeclaration[];
  memory?: MemoryPerimeter;              // Fase 5 (D16)
  closure: { shell: string; failBehavior: string };
  verifiedBy: ProbeResult[];
}
```

`IsolationLevel` y `EngineDescriptor` se importan de los contratos de forja-v1 §5.1 (tipos puros, sin dependencias). `MemoryPerimeter` se define en la Fase 5 (aditivo).

### 5.2 Render

`PerimeterRenderer` (determinista) produce: versión compacta para TUI/CLI (< 40 líneas), versión JSON `perimeter/v1` (exacta, D2) y versión corta para la tool `perimeter_check` (≤ 4 KB, D14). Una sola fuente de verdad: `buildPerimeterSnapshot(ctx)`.

### 5.3 Evento y rutas

- Evento `perimeter_snapshot` (aditivo, D9): `{ sessionId, header, summary }` donde `summary` es el conteo por status (nunca el reporte completo).
- Ruta `GET /api/perimeter` (nuevo): devuelve `perimeter/v1` JSON. Sin parámetros con efectos; bajo `--read-only` existe igual (no toca nada).
- CLI: `alisio perimeter status` (render), `alisio perimeter --json` (D8), `alisio perimeter probe [--fast]`, `alisio perimeter check`, `alisio perimeter memory export|import <path>` (Fase 5).

## 6. Auto-pruebas (no destructivas, D6, D7)

| ID | Superficie | Qué comprueba | Cómo (read-only) |
| --- | --- | --- | --- |
| P-FS | filesystem | El límite del workspace declarado por política coincide con los directorios realmente accesibles por `allow-*`/`additionalDirectories` | `list_files`/`read_file` dentro del límite; intento de `stat` fuera del límite registrado como gap, sin escribir nada |
| P-PROC | process | El modo de permiso efectivo para procesos (ask/allow/disabled) y que `run_process` con flags `--read-only` no pueda escribir | inspección de configuración + `run_process --help`/invocación con comando inofensivo y timeout; nunca `shell` real con efectos |
| P-NET | network | Estado de consentimiento de red (`external` gate) y dominio de `webfetch`/`websearch` | lectura de config; **sin** tráfico de red fuera del proceso (ningún `fetch`) |
| P-MCP | mcp | Servidores configurados, conectados, y consent efectivo (`mcp.allow`/sesión) | `alisio mcp list`/`mcp doctor` internos, sin conectar nada nuevo |
| P-PLUG | plugins | Plugins cargados y su origen (trusted) | estado del plugin host; sin ejecutar código de plugin |
| P-SK | skills | Raíces de skills accesibles y conteo | `skill_search` con consulta vacía acotada |
| P-MEM | memory | Tamaño del SQLite y conteo de observaciones | apertura del store en modo solo lectura |
| P-GIT | git | Estado read-only de las tools (`git_status`, `git_diff` disponibles; no hay tool de escribir git) | inventario de tools registradas |
| P-FORGE | execution | Por motor: `EngineDescriptor.ready` e `isolation` declarado (forja) | `EngineSelector`/`describe()` contra el estado real; sin arrancar motores |
| P-XT | external | Cosecha de approvals `session`/`once` que amplían superfícies | estado del consent store |

Reglas: cada probe corre con timeout propio (total ≤ 2 s default, ≤ 200 ms con `--fast`, D13); ninguna probe dispara un prompt (en modo headless sin consent, la probe declara `unverified` con motivo en vez de esperar); el conjunto de probes es extensible con `probeId` versionado y la lista vive en `docs/benchmark-perimeter.json` + un fixture de pruebas.

## 7. Cierre opt-in de `shell` (Fase 4)

Hereda explícitamente el límite de forja-v1 §1.5: **no es un sandbox de herramientas del host**. La Fase 4 **reduce y declara**:

| `perimeter.closure.shell` | Comportamiento | Nivel declarado |
| --- | --- | --- |
| `declare` (default) | Sin cambio; el reporte muestra el hueco real | `none` + gap |
| `shadow` | Registra qué comandos se habrían bloqueado, sin bloquear | `none` + gap + `shadowed` |
| `limit` | Scrub de env sensible (excepto lo que la sesión pide), límites de recursos (CPU/RSS/timeout), red denegada solo donde una sonda confirma que el SO lo permite | `wasm-process`-equivalente con honestidad: se declara `limit` como nivel propietario **no** en la escalera Forja, con descripción que lo distingue de `os-container` |
| `os-container` | `shell` corre dentro de un contenedor OCI reutilizando `OciBackend` (Docker/Podman, digest-pinned, `--network=none`, `--read-only`, `--cap-drop=ALL`, `--pids-limit`) | `os-container` (escalera Forja) |

Regla de fallo (D10): si `limit` prometido no puede aplicarse (sin sonda de confirmación, sin permiso del SO), el default es `warn` y el reporte cambia a `status: "drift"` con el motivo. `failBehavior: "disable-surface"` es opt-in y la única política que bloquea `shell`/`bg_run` por completo cuando no se puede cumplir la restricción.

**Puerta de promoción (B4):** `limit` o `os-container` solo pasan de opt-in a configurable-por-defecto si, en `shadow` durante al menos una minor completa, el éxito de tareas de referencia no cae más de 2 puntos frente al baseline sin cierre (mismo arnés de referencia que forja). Si no cumple: se quedan experimentales y `declare` sigue siendo el default. El resultado queda en `docs/benchmark-perimeter.json`.

## 8. Memoria legible (Fase 5)

- `memory_export <format=markdown> [--filter type|topic]` → un directorio o archivo markdown con una observación por archivo (frontmatter YAML: `id`, `topic_key`, `type`, `title`, `created`, `updated`) y contenido `What/Why/Where/Learned`. Cobertura: 100 % de las observaciones.
- `memory_import <path> [--dry-run]` → agregar o actualizar por `id`/`topic_key`; **nunca borra**; idempotente; `--dry-run` lista el diff sin tocar.
- La búsqueda sigue siendo FTS5 (sin embeddings, sin red; no se toca `docs/memory.md`).
- El export está disponible bajo `--read-only` (D15); el import no.
- El reporte gana la sección `memory` (D16) con aviso honesto cuando el contenido podría contener datos personales («export before sharing a session»).

## 9. Superficies

| Superficie | TUI | Web | Headless | CLI |
| --- | --- | --- | --- | --- |
| `alisio perimeter status` | panel `/perimeter` (TUI) | tarjeta en la página de sesión | JSONL `perimeter_snapshot` (arranque) | `alisio perimeter status` |
| `alisio perimeter --json` | — | — | mismo esquema | `alisio perimeter --json` |
| `alisio perimeter probe/check` | línea de estado | botón «reverificar» | JSONL con `perimeter_check` | `alisio perimeter probe` |
| memoria | `/memory` (export) | vista de export | JSONL | `alisio perimeter memory export` |
| tool `perimeter_check` | — | — | disponible | disponible |

Toda superficie da **paridad funcional** en TUI, web y headless (misma regla que forja). El modelo ve la tool `perimeter_check` y el render corto (D14); nunca el reporte completo inline.

## 10. Configuración

```jsonc
// global-only (D12): los proyectos solo pueden REDUCIR niveles
{
  "perimeter": {
    "closure": { "shell": "declare", "failBehavior": "warn" }, // Fase 4
    "probe": { "fastMs": 200, "fullMs": 2000 },
    "memoryExportPath": "~/.alisio/memory-export"              // Fase 5
  }
}
```

Los valores que deciden (closure, failBehavior) son `GLOBAL_ONLY`; un proyecto que intenta ampliarlos produce diagnóstico y se ignora, igual que las reglas de workspace-sources §1.2 y forja D16.

## 11. Presupuestos, benchmarks y puertas

| ID | Métrica | Puerta | Nota |
| --- | --- | --- | --- |
| B1 | Overhead del render `buildPerimeterSnapshot` | p99 ≤ 5 ms | Objetivo, no garantía (O9). Medido con el arnés de bench existente. |
| B2 | Sonda completa (`alisio perimeter probe`) | ≤ 2 s default; `--fast` ≤ 200 ms | Sin efectos; en headless sin consent → `unverified` con motivo. |
| B3 | Export/import de memoria | round-trip 100 % de observaciones (fixture: 1 000 observaciones de tipos mezclados); import idempotente (correr dos veces → mismo estado) | |
| B4 | Cierre de `shell` (`limit`/`os-container`) | Paridad en `shadow` durante una minor: éxito de tareas no cae > 2 puntos vs baseline | Si no cumple: experimental, `declare` sigue default. |
| B5 | Atestado JSON | `perimeter/v1` estable entre dos ejecuciones en la misma sesión para las mismas entradas; cero prompts generados | |

Cada benchmark es **manual y reproducible** (scripts en `scripts/bench-*.ts`, siguiendo el patrón de capability-routing), y el resultado va a `docs/benchmark-perimeter.json`. Los benchmarks nunca se ejecutan en CI como puerta; se ejecutan en las fases y la decisión es del propietario.

## 12. Fases y orden

Cada fase deja el repo verde con la suite completa y actualiza `docs/implementation-status.md` (D19). **Fase 0 es opcional**: el propietario puede pedirla para medir overhead y sondeo antes de comprometer los contratos.

| Fase | Entregable | Puerta mínima |
| --- | --- | --- |
| 0 (opcional) | Medición de overhead y probes en un repo de referencia | Informe al propietario; nada se implementa todavía |
| 1 | Contratos: tipos SDK, `buildPerimeterSnapshot`, render declarativo, `alisio perimeter status`/`--json`, evento `perimeter_snapshot`, fixture `perimeter/v1` | B1 (p99 ≤ 5 ms); esquema congelado con revisión Opus |
| 2 | Auto-pruebas P-FS…P-XT, `alisio perimeter probe [--fast]`, `alisio perimeter check` (drift) | B2; probes deterministas sobre fixtures en CI |
| 3 | Superficies: panel TUI `/perimeter`, tarjeta web, cabecera/JSONL headless, tool `perimeter_check` | Paridad TUI/web/headless; capturas `perimeter_*_web_ui.webp` (< 150 KB cada una, regla AGENTS.md) |
| 4 | Cierre opt-in de `shell`: `shadow` → `limit` → `os-container` (reuso `OciBackend`), `failBehavior`, B4 | B4 en shadow durante una minor; `declare` sigue default si no se cumple |
| 5 | Memoria legible: `memory_export`/`memory_import`, sección `memory` del reporte | B3; export disponible en `--read-only` |
| 6 | Atestado y cierre: `perimeter --json` final, docs `perimeter.md` EN/ES, `docs/implementation-status.md`, capturas restantes, release 0.8.0 | B5; docs:check y docs:build verdes |

## 13. Asignación de modelos (mismo criterio que forja §13)

| Trabajo | Modelo |
| --- | --- |
| Codificación de las fases, probes, renders y tests | Sonnet 5.5 (default) |
| Definición del esquema `perimeter/v1` (Fase 1) | Opus 5.5 (un punto) |
| Puerta de la Fase 4 (política de cierre de `shell`) | Opus 5.5 (un punto) |

## 14. Riesgos y límites honestos

- **El reporte refleja la máquina en un instante.** Dos sesiones en la misma máquina pueden diferir (plugins, flags, consent). El header lleva `sessionId` + `generatedAt` y el atestado es por sesión, no por máquina.
- **Las probes no son un kernel-hardening.** Una probe confirma «hoy, aquí, con estos permisos»: no prueba la ausencia de vulnerabilidades. El reporte lo dice y la Fase 4 lo repite («no es un sandbox»).
- **Los huecos verdaderos se muestran primero.** En v1, la mayoría de las superficies del host (process, mcp, plugins, external) se declaran con `status: declared/unverified` y sus gaps visibles, hasta que la Fase 4 y los cierres futuros los reduzcan. Un usuario que quiera `shell` aislado hoy debe elegir `os-container` en la Fase 4 o usar Forja (`js_run`/`python_run`) que **ya** corre aislado.
- **Peligro de falsa seguridad percibida.** Un panel verde de superficies verificadas puede inducir a confianza: por eso los gaps y los `unverified` son obligatorios (D3, D7) y el reporte nunca dice «everything isolated».
- **Memoria legible expone datos.** El export la hace copiable fuera del store 0600: la UI advierte antes de exportar (Fase 5, D16) y el import nunca borra.
- **Windows/macOS sin certificar.** Las probes de plataformas no cubiertas producen `unverified` con motivo (D7); nunca se marcan como verificadas por analogía.
- **Riesgo de ceremonia.** Si el reporte no se usa (ni por humanos ni por `perimeter_check`), es peso muerto. Mitigación: B1 presupuesta overhead; la tool `perimeter_check` le da uso de modelo; `/perimeter` le da uso de humano; el atestado le da uso de CI.
- **Nada aquí es una puerta de seguridad nueva.** Esta especificación no añade un approvals nuevo ni cambia el gate. Si alguien necesita «el agente no puede X» hoy, la respuesta sigue siendo `--read-only` y las políticas de permisos existentes (verificadas en `docs/tools.md`).

## 15. Cierre y entrega

- Documentación `perimeter.md` EN y ES con paridad estricta (regla AGENTS.md), situada junto a `security`/`tools` en el sitio.
- Capturas de UI en WebP (< 150 KB) con proveedor de fachada y datos ficticios, nunca sesiones reales: `perimeter_panel_web_ui.webp`, `perimeter_attestation_web_ui.webp`, `perimeter_memory_export_web_ui.webp`.
- `docs/implementation-status.md` actualizado en cada fase (D19) y reconciliado en el cierre.
- Commit, push, PR y release: decisiones del propietario (regla del repo).

## 16. Fuentes

- Claude Code (oficial, verificado 2026-10-12): `code.claude.com/docs/en/sandboxing`, `/memory`, `/overview`, `/third-party-integrations` (enterprise).
- Repo: `specs/archive/009-forja-v1.md` (§1.2, §2, §5.1, D7, D17), `specs/archive/008-forja-python-v1.md` (P0, `OciBackend`, `wasm-process`), `specs/021-workspace-sources-v1.md` (§1.2, ADR-1), `specs/019-capability-routing-v1.md` (§1.1, ADR-4), `docs/tools.md`, `docs/memory.md`, `docs/limitations.md`, `docs/implementation-status.md`, `docs/specification.md` (§6, §9).
