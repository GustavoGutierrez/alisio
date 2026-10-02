# Especificación Técnica: Modos, permisos, plan review, tareas en segundo plano y /goal

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | Especificación técnica ejecutable. **Fases 1 y 2 implementadas (2026-10-02)**; fases 3–4 pendientes |
| Fecha | 2026-10-02 |
| Paquetes afectados | `@alisio/sdk`, `@alisio/core`, `@alisio/server`, `@alisio/web` (privado), `@alisio/alisio-code` (CLI/TUI); `@alisio/plugin-subagents` solo en la fase 3 (lista de tareas unificada) |
| Paquetes nuevos | Ninguno |
| Relación con otras especificaciones | Extiende `alisio-ui.md` (comandos, presets, `InteractionBridge`) y `alisio-data-analysis-runtime-v1.2.md` (artefactos, grants, `/permissions`). No cambia ninguno de sus contratos: todo es aditivo. |
| Referencia externa | `minimax-code-0.6.2` (MIT, solo lectura): se replican **patrones**, nunca código (Apéndice A). |

## 0. Cómo usar este documento (para agentes de código)

1. **Lee primero** `AGENTS.md` y `CONTRIBUTING.md`. Sus reglas prevalecen sobre este documento.
2. **Trabaja por fases** (§6–§9). Cada fase es vertical, deja el repositorio verde y termina con pruebas, docs EN/ES, verificación y una comprobación en navegador. **No se hace commit hasta que lo pida el propietario.**
3. **Rutas**: una ruta sin marca existe hoy. **(nuevo)** = debe crearse. **(verificado)** = comprobado en el código al redactar. **(no verificado)** = deducido o tomado del mapa previo: compruébalo antes de apoyarte en ello.
4. **Idioma**: identificadores, rutas HTTP, eventos, tipos y textos de UI en inglés (con su traducción al español neutro donde se indica); la prosa de este documento, en español.
5. **Contratos aditivos**: nunca cambies la semántica de una columna, evento, `UiBlock`, comando o tipo existente. Todo es opcional o una variante nueva de una unión.
6. **Un subproceso o un modo de permisos NO es un sandbox** (`AGENTS.md`). Ningún texto, UI o doc presenta `ask`, `auto` o `full` como aislamiento.
7. Antes de entregar cada fase: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:cli`, `pnpm test:compiled`, `pnpm pack:check`, `pnpm docs:check`, `pnpm docs:build`. Si fallan pruebas de tiempos con la máquina cargada, repetir con `--maxWorkers=2` antes de darlas por fallidas.
8. Documenta limitaciones y alcance de verificación en `docs/implementation-status.md` (español) y mantén la paridad EN/ES (`docs/<page>.md` y `docs/es/<page>.md`, comprobada por `scripts/docs-check.ts`; `docs/limitations.md` refleja `implementation-status.md`).

---

## 1. Visión, alcance y decisiones del propietario

### 1.1 Visión

El mismo conjunto de capacidades en la **TUI** (`packages/cli`) y en la **web** (`packages/web` + `packages/server`): ciclar agentes principales, cambiar el modo de permisos en caliente, revisar un plan antes de implementarlo, ver novedades, recargar la configuración, lanzar tareas largas en segundo plano y fijar un objetivo de sesión (`/goal`) que el runtime continúa solo, con límites duros.

### 1.2 Decisiones del propietario (confirmadas el 2026-10-02; aplicar exactamente)

| # | Decisión | Fase |
|---|---|---|
| P1 | **Shift+Tab cicla los agentes principales**: `build → plan → otros principales (mode primary\|all de `.agents/agents`, etc.)` y vuelve a `build`. Los permisos son otro eje (`/permission`). Web: selector visible con el nombre del agente activo en el compositor **y** atajo Shift+Tab con el foco en el textarea (`preventDefault`; se ignora durante composición IME, con la paleta `/` abierta o con otros modificadores). El selector es la vía accesible; se documenta el coste de accesibilidad (Shift+Tab normalmente retrocede el foco). | 1 |
| P2 | `/permission` abre **un** menú: «Use ask mode», «Use auto mode», «Use full access mode», «Status» y «Manage saved permissions…» (lo que hoy hace `/permissions`). `/permissions` queda como alias del mismo menú. Subcomandos `/permission ask\|auto\|full\|status`. | 1 |
| P3 | **Auto = reglas fijas, sin clasificador de IA**: aprueba ediciones de archivos dentro del workspace; sigue preguntando por comandos, red y directorios externos (semántica del preset web `workspace-write`). **Ask** = pregunta por escritura/proceso/externo (preset `ask`). **Full** = preset `full-access` (advertencia clara: no es un sandbox). **Una sola tabla de mapeo en core** usada por los presets del servidor y por la TUI. | 1 |
| P4 | El agente `plan` termina llamando a una herramienta nueva (`exit_plan`) con el plan en Markdown. El plan completo se ve en el chat **y** se guarda como artefacto Markdown (sistema de artefactos existente) que la web abre en el panel lateral. La decisión usa la infraestructura de `ask_user_question` (TUI `tui/questions.ts`; web `InteractionBridge`/`InteractionPanel`): «Agree and start implementation» (cambia a `build` de forma atómica e inicia un turno de implementación con el plan aprobado), «Skip for now» (sigue en `plan`), «Add context» (el texto del usuario vuelve al modelo, que sigue planificando). El modo plan se **impone en el ejecutor** (política del runner, ya de solo lectura), nunca solo por prompt. | 2 |
| P5 | `/goal`: el **modelo** marca `complete` o `blocked` con `update_goal` y debe dar evidencia (archivos, pruebas, logs); solo el **usuario** pausa, reanuda, edita, borra o cambia el presupuesto. Límites **duros** en el runtime: presupuesto de tokens (`budget=50k`, sufijos K/M, `budget=clear`), turnos máximos y tiempo máximo. Disyuntores: pausa tras respuestas idénticas repetidas y tras N turnos consecutivos sin herramientas; `blocked` exige evidencia repetida. Nunca auto-continuar con una aprobación o pregunta pendiente, tareas en segundo plano activas de la sesión o agente en modo plan. Pausa al interrumpir el usuario. Sin modelo evaluador aparte en v1. Estados: `active`, `paused`, `blocked`, `budget_limited`, `complete`. | 4 |
| P6 | Tareas en segundo plano: runtime general en `@alisio/core`, tabla nueva en la **migración v7**, salida en archivos de log con offsets de lectura. Herramientas `bg_run`, `bg_list`, `bg_output`, `bg_stop` para comandos de shell, sujetas a la política `process` y a las aprobaciones existentes (iniciar, leer salida y parar pasan por la misma política). Al terminar, **una** notificación coalescida y limitada en frecuencia despierta al agente propietario (sin recordatorios por turno). Paneles: `/tasks` (TUI) y panel Tasks (web) con salida en vivo y botón de parar; los subagentes aparecen en la misma lista. Las tareas mueren al salir Alisio (se mata el grupo de procesos) y quedan `lost` en el siguiente arranque. No son *detached*. | 3 |
| P7 | `/reload`: solo **entre turnos** (se rechaza durante un turno); **valida todo antes de aplicar**, de modo que una configuración rota deja la sesión intacta; recarga capas de config, agentes, skills, plantillas de prompt y servidores MCP (la TUI reconstruye la aplicación; la web recicla el workspace); imprime un informe de lo refrescado y de lo que requiere reinicio (código de plugins ya importado). Re-registra el autocompletado y emite `catalog_changed` en la web. | 1 |
| P8 | `/changelog`: `CHANGELOG.md` curado en la raíz (solo cambios visibles), convertido en build a datos que viajan **dentro de `dist`** (pasa `scripts/pack-check.ts`; no se amplía la lista blanca), con un parser puro en core usado por ambas UIs. Funciona sin red. `/changelog [version]`. La web muestra un diálogo; la TUI, un panel desplazable. Tras una actualización, **una** línea discreta avisa de novedades (`lastSeenVersion` por visor: localStorage en la web con try/catch; estado de la TUI). Entradas iniciales escritas desde el historial git de las alphas. Se añade el paso «actualizar CHANGELOG» al skill `.agents/skills/alisio-publish/SKILL.md`. | 1 |
| P9 | Cuatro fases: (1) modos y permisos, `/reload`, `/changelog`; (2) plan review; (3) tareas en segundo plano; (4) `/goal`. Cada una cierra con pruebas, docs EN/ES, verificación y prueba en navegador. Sin commit hasta que lo pida el propietario. | todas |

### 1.3 Fuera de alcance (v1)

Evaluador de IA para `/goal`; clasificador de IA para el modo `auto`; tareas *detached* que sobrevivan al proceso; sandboxing real; watchers de archivos para recarga automática; recargar código de plugins ya importado; el flujo del GitHub Release (token npm inválido, fuera de alcance); compatibilidad V1/V2 y «liquidaciones» de 10 etapas del proyecto de referencia.

---

## 2. Estado actual verificado y correcciones al mapa previo

Cada fila se comprobó en el repositorio el 2026-10-02.

| Tema | Mapa previo | Realidad | Estado |
|---|---|---|---|
| Comandos | `CommandDescriptor`, `BUILTIN_COMMANDS`, `CommandCatalog` | Correcto. `/permissions` y `/artifacts` son `surface`; `INTERACTIVE = ["tui","web"]` en `commands/builtins.ts`. El test de paridad `tests/command-catalog-tui-parity.test.ts` compara `COMMANDS` con una lista `LEGACY_COMMANDS` y **hay que actualizarla** al añadir comandos. | (verificado) |
| Teclas TUI | «Verificar que el Editor no consume Shift+Tab antes que el listener» | `tui.addInputListener` corre **antes** que el componente enfocado (`pi-tui` `handleTerminalInput`: recorre `inputListeners` y solo después entrega al foco). `matchesKey(data, Key.shift("tab"))` reconoce `\x1b[Z` (`keys.js`). El Editor solo enlaza `tab`. Un listener que consume Shift+Tab es suficiente. | (verificado) |
| Agente activo (TUI) | `agents.active` global en config | Correcto (`app.updateSetting("agents.active")`). **Matiz nuevo**: `applyActiveAgent` llama a `app.switchModel` y **crea una sesión nueva** si el agente declara un modelo distinto. El ciclo con Shift+Tab **no** debe hacerlo (§6.4). | (verificado) |
| Agente activo (web) | `session.options.agent` vía `PATCH` | Correcto; además existe `/agent:<id>` (`host/agents.ts`) y el badge de cabecera abre `AgentPicker`. `GET /api/agents` devuelve el catálogo en orden de plugin; no es estable entre recargas. | (verificado) |
| Política | `Policy {write, process, external, analysis?}` solo estrecha | Correcto. El ejecutor (`executeCall`) deniega en el propio runner (`Capability denied`) aunque el modelo llame a la herramienta; `availableTools` además la oculta. `runtimePolicy.external` en la TUI vale `true` también por `allowMcp`, `allowAgents`, plugins externos o herramientas `p_*`; el **techo web** (`SessionService.ceiling`) **no** cuenta los plugins. La TUI y la web no parten del mismo `external`. | (verificado) |
| `session` en aprobaciones | «muta `policy[effect]` en memoria» | Correcto: en la TUI muta el objeto compartido de la aplicación; en la web, el objeto por sesión (`SessionService.policies`). Cambiar de modo debe **reiniciar** esas concesiones de sesión. | (verificado) |
| `--read-only` | Quita el handler de aprobación | Correcto (`...(options.approve && !options.readOnly ? { approve } : {})`). Un cambio de modo bajo `--read-only` se rechaza con explicación. | (verificado) |
| Presets web | `read-only`, `ask`, `workspace-write`, `full-access` | Correcto (`host/presets.ts`); `presetInfo` degrada por el techo (`alisio serve --allow-*`) y `analysis` solo se pre-permite si el preset permite procesos. | (verificado) |
| Plan | Solo restringe herramientas | Correcto: `agentRunOptions` da `policy {false,false,false}` y `approvals:false` a agentes `readOnly`. No hay `exit_plan` ni estado «plan pendiente». | (verificado) |
| `ask_user_question` | Funciona en TUI y web | Correcto, pero **solo ofrece opciones, sin texto libre**. «Add context» (P4) exige una extensión aditiva (§7.3). Falla en sesiones no interactivas (`ui.interactive()`). | (verificado) |
| Subagentes | `task`, `task_status`, `task_wait`; notifica con `<task-notification>` | Correcto (`plugin-subagents/src/index.ts`, `manager.ts#notifyParent`). La web **no** pinta el árbol. | (verificado) |
| `runner.enqueue` | «despierta al agente» | **No despierta una sesión inactiva**: el texto queda en el `inbox` y solo se drena dentro de `run` (`runner.ts` `drain`). Despertar exige iniciar un run: `RunScheduler.submit` (web) o `runPrompt`/`task` (TUI). | (verificado) |
| Esquema SQLite | versión 6 | Correcto (tablas: `sessions`, `messages`, `tool_calls`, `events`, `plugin_state`, `runs`, `workspaces`, `blobs`, `analysis_executions`, `artifacts`, `capability_grants`, `datasets`). `sessions.options` (TEXT JSON) existe desde v4. | (verificado) |
| Uso acumulado | «las sesiones no tienen uso acumulado» | Cierto para sesiones raíz: `runs.usage` guarda `{input, output}` por run; `sessions.usage` existe pero solo lo escriben las sesiones hijas. | (verificado) |
| Estados de run | `turns-exceeded` | `RunResult.status` usa `"turns-exceeded"` (guion) y la tabla `runs.status` y el evento durable usan `turns_exceeded`/`run_turns_exceeded` (guion bajo). | (verificado) |
| Reanudar el run siguiente | TUI `task()`/`runPrompt`; server `RunScheduler` | Correcto. Cada run reinicia `maxTurns`/`maxTokens`: `/goal` necesita contadores propios. | (verificado) |
| Recarga | `/agents reload`, `WorkspaceHost.recycle` | Correcto. `recycle` **cierra primero y abre después**: si la apertura falla, el workspace queda cerrado. La recarga necesita «construir primero, intercambiar después» (§6.7). Un import ESM ya hecho no se descarga. | (verificado) |
| Changelog | Sin `CHANGELOG.md`; versiones vía `loadVersion` | Correcto. La versión que ve el usuario es la del CLI (`alisio serve` la pasa al servidor). `pack-check` solo permite `package.json`, `README.md`, `LICENSE` y `dist/**/*.{js,d.ts}` (`dist/web/**` en el servidor): un `.json` en `dist` **no** pasa. Decisión: los datos del changelog se generan como **módulo TS embebido** (`packages/core/src/changelog/data.ts`), igual que `analysis/python/sources.ts`, y llegan a `dist` como `.js`. | (verificado) |
| Skill de publicación | `.opencode/skills/...` según `AGENTS.md` | El archivo real vive en `.agents/skills/alisio-publish/SKILL.md`. | (verificado) |
| Historial | «tags» | No hay tags git; las versiones salen de los commits `chore: bump …` (CLI `0.1.0-alpha.1`…`alpha.28`). | (verificado) |
| Pi-tui | `@earendil-works/pi-tui` 0.87.1 | Correcto (parcheado: `patches/`). | (verificado) |
| Referencia | `minimax-code-0.6.2` | No se relee aquí; los patrones del Apéndice A vienen del mapa previo. | (no verificado) |

---

## 3. Principios y restricciones

1. **Core decide, las UIs presentan.** Mapeo de modos, orden de ciclo, parser de changelog, validación de recarga, runtime de tareas y estado del goal viven en `@alisio/core` como funciones puras o servicios con pruebas de contrato; TUI y web solo los pintan.
2. **Fail-closed.** Cualquier ambigüedad (modo desconocido, techo del servidor, `--read-only`, config rota) se resuelve al lado más restrictivo y con un mensaje accionable.
3. **Aditivo.** Nada cambia semántica existente. Los presets web siguen siendo `read-only|ask|workspace-write|full-access`; `PermissionMode` es una vista compartida (`ask`→`ask`, `auto`→`workspace-write`, `full`→`full-access`).
4. **Aplicación atómica.** Un cambio de modo, agente o recarga se aplica entre turnos; nunca a mitad de una llamada a herramienta (preserva IDs de llamadas y consistencia de la sesión persistida).
5. **Mismas puertas para todo.** Las herramientas nuevas (`bg_*`, `exit_plan`, `update_goal`) pasan por `executeCall` y por la misma política, aprobaciones y registro que el resto.
6. **Sin sobreingeniería.** Un solo escritor por área; sin capas de compatibilidad; códigos de motivo cerrados; sin evaluador de IA.

---

## 4. Decisiones de arquitectura (ADR-lite)

| ADR | Decisión | Motivo |
|---|---|---|
| ADR-01 | `PermissionMode` y su tabla viven en `packages/core/src/permissions/modes.ts`; el tipo `PermissionMode` en `@alisio/sdk` (la web lo necesita sin importar core). `host/presets.ts` deja de definir la política: la deriva de la tabla. | Una única fuente de verdad (P3). |
| ADR-02 | El **modo** de la TUI es estado del proceso (se aplica con `AgentRunner.setPolicy`, que muta el objeto de política compartido); el de la web es el **preset de la sesión** (`session.options.preset`). | La TUI ya tiene una política de aplicación global; la web ya es por sesión. |
| ADR-03 | El ciclo de agentes usa `cycleableAgents()` (core) con orden estable: `build`, `plan`, resto por nombre. `GET /api/agents` devuelve ese orden y la web cicla el array recibido. | El orden de descubrimiento de plugins no es estable (verificado). |
| ADR-04 | La recarga es `reloadApplication({current, busy, create, swap})` en core: **guarda de inactividad → validación de config → construir la nueva aplicación → intercambiar → cerrar la antigua**. Si algo falla antes del intercambio, la aplicación vigente no se toca. | P7: la sesión sobrevive a una config rota. |
| ADR-05 | El changelog viaja como módulo TS generado desde `CHANGELOG.md` (script + prueba de «archivo desactualizado», como los demás generados). | `pack-check` solo admite `.js`/`.d.ts` en `dist`. |
| ADR-06 | `exit_plan` (fase 2) bloquea el run mientras espera la decisión (como `ask_user_question`) y devuelve la decisión como resultado de la herramienta; el *host* ejecuta el cambio a `build` **después** de que termine el run del plan. | Cambiar de agente a mitad de un run rompería la consistencia de la sesión. |
| ADR-07 | Las tareas en segundo plano son un servicio de core (`BackgroundTasks`) con tabla propia y logs en disco; los subagentes se **reflejan** en la misma lista (vista, no migración de su almacén). | P6 sin reescribir el plugin de subagentes. |
| ADR-08 | `bg_output` y `bg_stop` declaran `effect: "process"`. | Cierra el bypass de política de solo lectura (§8.5). |
| ADR-09 | El goal es un estado de sesión con CAS por `epoch` y un único bucle de continuación en core (`GoalController`), invocado por el *host* tras cada run (TUI `task()`, web `RunScheduler.onChange`). | Evita lógica duplicada por superficie. |

---

## 5. Contratos compartidos (`packages/sdk/src/index.ts`, aditivos)

```ts
/** The permission mode shared by the TUI and the web presets (ask/auto/full). */
export type PermissionMode = "ask" | "auto" | "full";
// PermissionPresetInfo gains an OPTIONAL `mode?: PermissionMode` (undefined for `read-only`).

export interface ChangelogSection { title: string; items: string[] }
export interface ChangelogEntry {
  version: string;            // "0.1.0-alpha.28" or "Unreleased"
  date?: string;              // "2026-10-01"
  unreleased?: boolean;
  sections: ChangelogSection[];
}
/** `GET /api/changelog` */
export interface ChangelogView {
  current: string;            // the running CLI version
  entries: ChangelogEntry[];  // newest first
  found: boolean;             // false when `version` was asked and does not exist
  news?: { latest: string; versions: string[] };   // set when `lastSeen` is older than `current`
}

export type ReloadArea = "config" | "agents" | "skills" | "prompts" | "mcp" | "plugins";
export interface ReloadAreaReport {
  area: ReloadArea;
  before: number;             // item count (config: sections that changed → see `added`)
  after: number;
  added: string[];
  removed: string[];
  changed?: string[];
}
export interface ReloadReport {
  refreshed: ReloadAreaReport[];
  restartRequired: string[];  // human sentences, e.g. imported plugin code
  warnings: string[];         // e.g. prompt-template diagnostics
}
```

Fases 2–4 añaden (todo opcional/aditivo): `RunEventDataMap["plan_proposed" | "plan_decided"]`, `QuestionOption.textInput?`, `ServerFrame` `background_task` y `goal_updated`, `BackgroundTaskInfo`, `GoalInfo`, `ApiErrorCode` `goal_*`/`task_*` (ver §8–§9 y §11).

---

## 6. FASE 1 — Modos, permisos, `/reload`, `/changelog` (IMPLEMENTADA EN ESTA ENTREGA)

### 6.1 Objetivos

Ciclar agentes principales (Shift+Tab y selector), `/permission` con modos `ask|auto|full`, `/reload` y `/changelog`, en TUI y web, con pruebas, docs EN/ES y comprobación en navegador. `alisio run` (headless) no cambia.

### 6.2 Distribución de módulos

| Ruta | Estado | Contenido |
|---|---|---|
| `packages/sdk/src/index.ts` | modificado | `PermissionMode`, `PermissionPresetInfo.mode?`, `Changelog*`, `Reload*` (§5). |
| `packages/core/src/permissions/modes.ts` | **nuevo** | Tabla `PERMISSION_MODE_TABLE`, `modeFromFlags`, `presetToMode`/`modeToPreset`, `describePermissionStatus`, `parsePermissionArgs`, `FULL_ACCESS_WARNING`. |
| `packages/core/src/agents/active.ts` | modificado | `cycleableAgents(agents)`, `nextAgent(agents, currentId, step)`. |
| `packages/core/src/core/runner.ts` | modificado | `AgentRunner.setPolicy(patch)`: muta en sitio `write/process/external` (nunca `analysis`). |
| `packages/core/src/reload.ts` | **nuevo** | `reloadApplication`, `snapshotApplication`, `buildReloadReport`, `formatReloadReport`, `ReloadRefusedError`, `ReloadFailedError`. |
| `packages/core/src/changelog/{parse,news,index}.ts` | **nuevo** | `parseChangelog`, `compareVersions`, `selectEntries`, `changelogNews`, `formatChangelogMarkdown`, `loadChangelog`. |
| `packages/core/src/changelog/data.ts` | **nuevo (generado)** | `CHANGELOG_DATA` desde `CHANGELOG.md`; lo regenera `scripts/changelog-data.ts`. |
| `packages/core/src/commands/builtins.ts` | modificado | `permission` (alias `permissions`), `reload`, `changelog`. |
| `packages/core/src/index.ts` | modificado | Exporta lo anterior. |
| `scripts/changelog-data.ts` | **nuevo** | Genera `data.ts` desde `CHANGELOG.md` y lo formatea con Biome. Lo ejecuta `pnpm changelog:data`, que el `build` raíz llama antes de compilar; un test compara los datos embebidos con el archivo. |
| `CHANGELOG.md` | **nuevo** | Entradas desde las alphas (§6.9). |
| `.agents/skills/alisio-publish/SKILL.md` | modificado | Paso «CHANGELOG». |
| `packages/server/src/host/presets.ts` | modificado | Política derivada de la tabla de core. |
| `packages/server/src/host/workspace-host.ts` | modificado | `reload(id)`: construir-primero, intercambiar-después. |
| `packages/server/src/routes/management.ts` | modificado | `POST /api/workspaces/:wid/reload` y `ReloadService`; `/api/agents` en orden estable. |
| `packages/server/src/routes/changelog.ts` | **nuevo** | `GET /api/changelog`. |
| `packages/server/src/routes/commands.ts` | modificado | `permission`, `reload`, `changelog` para clientes API y web; `reload` en `EXCLUSIVE`. |
| `packages/cli/src/tui/modes.ts` | **nuevo** | Lógica pura: `shiftTabDecision`, `permissionMenuItems`, `reloadGuard`. |
| `packages/cli/src/tui/viewer-state.ts` | **nuevo** | `lastSeenVersion` en `<stateHome>/tui-state.json`. |
| `packages/cli/src/tui/{app,components,state}.ts` | modificado | Cableado (`app` pasa a `let` para `/reload`), cabecera/estado, panel de changelog. |
| `packages/web/src/store/modes.ts` | **nuevo** | `shiftTabCycles`, `nextAgentId`, `modeOfPreset`. |
| `packages/web/src/store/app.ts`, `net/api.ts` | modificado | `submit()` (`permission`, `changelog`), `cycleAgent`, `changelogOpen`, `checkChangelogNews`, `api.changelog`. |
| `packages/web/src/components/composer/Composer.tsx` | modificado | Selector de agente + Shift+Tab. |
| `packages/web/src/components/header/PermissionsPopover.tsx`, `PermissionsMenu.tsx` | modificado / **nuevo** | El botón queda en el chunk inicial; el menú (modos + estado + «Manage saved permissions…») es un chunk perezoso. |
| `packages/web/src/store/{changelog,permission-modes}.ts` | **nuevo** | `newsAction` (toast y `lastSeenVersion`) y `modeChoices`. |
| `packages/cli/src/tui/scroll.ts` | **nuevo** | `scrollWindow` compartido por `/btw` y `/changelog`. |
| `packages/web/src/components/changelog/ChangelogDialog.tsx` | **nuevo** | Diálogo. |
| `packages/web/src/i18n/{en,es}.ts` | modificado | Claves (§6.8). |

### 6.3 Modos de permisos (P2, P3)

**Tabla única** (`PERMISSION_MODE_TABLE`; los presets web se derivan de ella y de la constante `read-only`):

| Modo | Preset web | `write` | `process` | `external` | Aprobaciones | Descripción |
|---|---|---|---|---|---|---|
| `ask` | `ask` | pregunta | pregunta | pregunta | sí | Todo efecto pregunta. |
| `auto` | `workspace-write` | **permite** | pregunta | pregunta | sí | Ediciones dentro del workspace sin preguntar; comandos, red y directorios externos preguntan. Reglas fijas, sin IA. |
| `full` | `full-access` | permite | permite | permite | sí | Sin preguntas. **No es un sandbox.** |
| (bloqueado) | `read-only` | no | no | no | no | Solo con `--read-only` o preset explícito web. |

Las rutas fuera del workspace siguen pasando por `PathAccess` (pregunta por directorio) en `ask` y `auto`; `full` no cambia `PathAccess` (los directorios externos se siguen aprobando por separado: el modo gobierna **efectos**, no el confinamiento de rutas). `analysis` nunca se toca por modo.

**TUI** — estado `permissionMode: PermissionMode | "custom" | "locked"`:
- Inicial (`modeFromFlags`): `--read-only` → `locked`; sin flags → `ask`; `--allow-write` solo → `auto`; `--allow-write --allow-process --allow-external` → `full`; cualquier otra combinación → `custom`. **No se aplica política al arrancar** (el comportamiento actual no cambia); solo se etiqueta.
- `setPermissionMode(mode)`: `app.runner.setPolicy(table[mode].policy)`; las concesiones «Allow for this session» se pierden (efecto documentado). Bajo `locked`: se rechaza con «Permission modes are locked: Alisio was started with --read-only.».
- Tras `/reload` se reaplica el modo elegido por el usuario (solo si no es `custom`/`locked`).
- `/permission status` muestra: modo, línea por efecto (`write: on|ask|off`, `process`, `external`), si hay aprobaciones, y una nota cuando `external` ya estaba permitido al arrancar por plugins/MCP.
- Cabecera: segmento `mode:<m>` (prioridad 10) junto a `write/process`; barra de estado bajo el editor: `agent: plan · mode: ask · <model> …` (rol nuevo `mode`, solo si se pasa `mode`).

**Web** — el modo es `session.options.preset`:
- Menú del compositor: los 4 presets existentes (sin cambios) con `mode` informativo; confirmación `window.confirm` al elegir `full-access` (no es un sandbox).
- `/permission` (sin argumentos) abre `PermissionsPopover`: grupo de radio con **Ask / Auto / Full access**, línea «Status» (modo, efectos que preguntan, techo del servidor) y botón «Manage saved permissions…» que despliega la lista de grants (el contenido actual).
- `/permission ask|auto|full|status` → `POST /api/sessions/:sid/commands` (`permission`): fija el preset (`modeToPreset`), `resetPolicy`, `effects:["preset"]`; respeta el techo (`capability_ceiling` si no está disponible).

### 6.4 Ciclo de agentes (P1)

- `cycleableAgents(catalog)`: `build`, `plan`, y el resto (agentes `primary|all`) ordenados por `name` sin distinguir mayúsculas y luego `id`. `nextAgent(list, currentId, step=1)` envuelve; un id desconocido empieza en `build`.
- **TUI**: listener `tui.addInputListener` (corre antes del Editor, verificado). `shiftTabDecision({data, busy, picker, autocomplete, panelFocus, atEditor})`:
  - no es `Key.shift("tab")` → `ignore`;
  - picker/panel con foco/autocompletado visible → `ignore` (no se consume);
  - turno en curso → `blocked` (hint «A turn is running: wait for it to finish before switching agents») y se consume;
  - en otro caso → `cycle`: persiste `agents.active` global (`updateSetting`), **sin** `switchModel` ni sesión nueva (si el agente declara otro modelo: hint «`<agent>` declares model `<m>`: run /agents to apply it»), y muestra `Agent: plan (read-only) · Shift+Tab cycles agents`. Se aplica desde el siguiente prompt.
- **Web**: selector visible `Agent: <name>` (componente `Menu`) con la lista de `GET /api/agents`; Shift+Tab en el textarea cicla con `activateAgent` (se aplica desde el siguiente prompt; no se bloquea durante un turno porque solo guarda `session.options.agent`). `shiftTabCycles({key, shiftKey, ctrlKey, altKey, metaKey, isComposing, paletteOpen})` es puro. **Accesibilidad**: Shift+Tab suele mover el foco hacia atrás; interceptarlo en el textarea rompe esa expectativa para usuarios de teclado. Mitigaciones: el selector es la vía accesible (alcanzable con Tab), el atajo solo actúa con el foco en el textarea, y el anuncio `aria-live` dice el agente activo; se documenta en `docs/web.md`.

### 6.5 `/reload` (P7)

`reloadApplication({ current, busy, create, swap, validate })` (core):

1. `busy()` devuelve un motivo (turno en curso, tarea de subagente en ejecución, run de otro session del workspace) → `ReloadRefusedError` (**no se cambia nada**).
2. `validate()`: carga la config con `loadConfigWithProvenance` (mismos flags) — error de sintaxis/esquema → `ReloadFailedError{stage:"config"}`.
3. `create()`: construye la nueva aplicación (`createApplication` con las mismas opciones). Si lanza → `ReloadFailedError{stage:"build"}`; la aplicación vigente sigue viva (`createApplication` ya limpia lo que abrió al fallar).
4. `swap(next)`: la UI cambia de aplicación (TUI: rebind; web: `WorkspaceHost` sustituye la entrada y llama a `onClose`/`onOpen`).
5. Cierra la aplicación antigua (errores tragados) y devuelve `ReloadReport` comparando `snapshotApplication` antes/después: secciones de config cambiadas, agentes, skills efectivas, plantillas, servidores MCP y plugins; `restartRequired` lista siempre el **código de plugins externos ya importado** (un `import` ESM no se descarga) y avisa de que los flags de lanzamiento (`--allow-*`, `--read-only`) no cambian; `warnings` recoge diagnósticos de plantillas.

- **TUI**: guarda: `busy` (turno), nodos de subagente `running`, cola interactiva con elementos. `swap`: reasigna `app`, `commandCatalog`, `activeProvider`, cachés de modelos, `setArtifactPathResolver`, `app.plugins.onStatusChange`, `setInteractiveUI`, reconstruye el autocompletado (`editor.setAutocompleteProvider(buildSlashCompletionProvider())`) y reaplica el modo de permisos. Imprime el informe como `info`.
- **Web**: `ReloadService.reload(workspaceId)` (`runs_active` si `scheduler.busyWorkspace`); `WorkspaceHost.reload(id)` hace construir-primero; emite `catalog_changed` para `commands`, `plugins`, `skills`, `agents`, `mcp`, `models`. La ruta de comandos añade `reload` a `EXCLUSIVE` (`session_busy`). El informe vuelve como `output` Markdown; la web lo pinta como nota local y un toast con el resumen.
- Solo interactivo: `alisio run` no tiene `/reload`.

### 6.6 `/changelog` (P8)

- `CHANGELOG.md` (formato Keep a Changelog reducido): `## [Unreleased]` y `## [0.1.0-alpha.N] - YYYY-MM-DD` con `### Added|Changed|Fixed`. El parser es puro y tolerante: ignora texto fuera de entradas, conserva el orden (más nueva primero), marca `unreleased`.
- `compareVersions(a,b)`: semver con prerelease numérico (`alpha.9 < alpha.10`); `Unreleased` > cualquier versión.
- `selectEntries(changelog, {version?, limit=5})`: sin versión → las `limit` más nuevas; con versión → esa (`found:false` si no existe; acepta `alpha.28` o `v0.1.0-alpha.28`).
- `changelogNews({changelog, current, lastSeen})`: `lastSeen` indefinido → `{show:false, record:current}` (primer arranque, silencioso); igual → nada; `current` más nueva y con entradas en `(lastSeen, current]` → `{show:true, versions, latest}`; `current` menor (downgrade) → nada y se registra. `Unreleased` nunca cuenta como novedad.
- **TUI**: `/changelog [version]` abre un panel desplazable (↑↓/PgUp/PgDn, Esc) en la ranura del picker (`MarkdownPanel`). Al arrancar: si hay novedades, **una** línea `notice` («Alisio updated to 0.1.0-alpha.29 · 3 new entries · /changelog») y se guarda `lastSeenVersion` en `<stateHome>/tui-state.json` (escritura atómica, errores ignorados).
- **Web**: `GET /api/changelog?version=&lastSeen=` → `ChangelogView`. `/changelog [version]` abre `ChangelogDialog`. Tras `init()`, `checkChangelogNews()` lee `localStorage["alisio.lastSeenVersion"]` (try/catch), llama a la API y, si `news`, muestra **un** toast discreto y guarda la versión.
- Sin red; solo inglés (el changelog no se traduce: las UIs en español muestran las entradas en inglés con la cromática traducida; documentado).

### 6.7 Rutas HTTP y contratos de servidor (Fase 1)

| Método y ruta | Cuerpo / respuesta | Reglas |
|---|---|---|
| `GET /api/changelog?version=&lastSeen=` **(nuevo)** | `ChangelogView` | Mismas reglas de auth/Host/Origin que el resto de `/api` (cookie, `checkHost`, `checkOrigin`). |
| `POST /api/workspaces/:wid/reload` **(nuevo)** | `ReloadReport` | `Content-Type: application/json`; `409 runs_active` si hay runs; `404` workspace desconocido; `400 validation_failed` con la config rota (`details.stage`); disponible también bajo `--read-only` (solo relee). |
| `POST /api/sessions/:sid/commands` | `permission \| reload \| changelog` | `reload` en `EXCLUSIVE`; `permission` fija el preset; `changelog` devuelve Markdown. |
| `GET /api/agents` | orden estable (`cycleableAgents`) | Cambio de orden, mismo contrato. |
| Frame `catalog_changed` | `scope` ∈ `commands\|plugins\|skills\|mcp\|models\|agents` | Tras `/reload` se emiten todos. |

### 6.8 Textos (EN / ES)

| Clave / contexto | EN | ES |
|---|---|---|
| Hint ciclo bloqueado (TUI) | `A turn is running: wait for it to finish before switching agents` | `Hay un turno en curso: espera a que termine antes de cambiar de agente` |
| Agente activo (TUI) | `Agent: plan (read-only) · Shift+Tab cycles agents` | — (la TUI es solo inglés) |
| `/permission` menú | `Use ask mode` · `Use auto mode` · `Use full access mode` · `Status` · `Manage saved permissions…` | (web) `Usar modo ask` · `Usar modo auto` · `Usar acceso total` · `Estado` · `Gestionar permisos guardados…` |
| Advertencia full | `Full access: writes, commands and network calls run without asking. This is not a sandbox: anything the agent runs has your user's permissions.` | `Acceso total: las escrituras, los comandos y la red se ejecutan sin preguntar. No es un sandbox: lo que ejecute el agente tiene los permisos de tu usuario.` |
| Bloqueado | `Permission modes are locked: Alisio was started with --read-only.` | `Los modos de permisos están bloqueados: Alisio se inició con --read-only.` |
| `/reload` rechazado | `Reload is only available between turns: wait for the current turn to finish.` | `La recarga solo está disponible entre turnos: espera a que termine el turno actual.` |
| `/reload` fallo | `Reload failed; the current session is unchanged: <reason>` | `La recarga falló; la sesión actual no ha cambiado: <motivo>` |
| Novedades | `Alisio updated to <v> · <n> new entries · /changelog` | `Alisio se actualizó a <v> · <n> novedades · /changelog` |
| Selector de agente (web) | `Agent: <name>` · `Switch agent (Shift+Tab cycles)` | `Agente: <nombre>` · `Cambiar de agente (Mayús+Tab alterna)` |

### 6.9 `CHANGELOG.md` inicial

Entradas cortas, visibles para el usuario, redactadas desde `git log` y los commits `chore: bump`: `Unreleased` (Fase 1), `alpha.28`…`alpha.20` y un resumen de `alpha.1–alpha.19`. Nada de rutas privadas ni detalles internos. Paso nuevo del skill de publicación: **«antes del bump, mueve `Unreleased` a `## [<versión CLI>] - <fecha>`, ejecuta `node --experimental-strip-types scripts/changelog-data.ts` y commitea ambos»**.

### 6.10 Criterios de aceptación y pruebas (Fase 1)

| Criterio | TUI | Web | Headless |
|---|---|---|---|
| Tabla modos→política única y presets coherentes | `tests/permission-modes.test.ts` (tabla, `modeFromFlags`, `--read-only`, `custom`) | `tests/server-presets.test.ts` (presets derivados, techo `serve`) | `alisio run` sin cambios (`pnpm test:cli`) |
| Ciclo de agentes estable y con envoltura (con agentes personalizados) | `tests/tui-modes.test.ts` (`shiftTabDecision`, bloqueos) | `tests/web-modes.test.ts` (`shiftTabCycles`, `nextAgentId`) | — |
| Transiciones de modo, bloqueo `--read-only`, aviso `full` | `tests/tui-modes.test.ts` + `runner.setPolicy` | ruta `permission` en `tests/server-modes.test.ts` | — |
| `/reload` valida antes de aplicar, guarda de inactividad | `tests/reload.test.ts` (core, config rota deja la app viva) | `tests/server-modes.test.ts` (`runs_active`, `catalog_changed`, auth) | no aplica |
| Changelog: versiones, ausente, `lastSeenVersion`, datos al día | `tests/changelog.test.ts` | idem + `GET /api/changelog` | no aplica |
| Paridad del catálogo | `tests/command-catalog-tui-parity.test.ts` actualizado | `tests/command-catalog.test.ts` | — |
| Docs EN/ES en paridad | `pnpm docs:check` | `pnpm docs:build` | — |
| Navegador | — | Chromium contra `alisio serve` con proveedor falso: ciclo (selector y Shift+Tab), modos y su efecto en una aprobación, `/reload`, `/changelog` | — |

### 6.11 Documentación (Fase 1)

`docs/tui.md`, `docs/web.md`, `docs/tools.md` (sección «Permission modes»), `docs/implementation-status.md` (+ espejo `docs/limitations.md`) y sus pares `docs/es/*`. `docs/configuration.md` **no cambia** (sin claves nuevas en la Fase 1). Se dice expresamente que `/reload` y `/changelog` son interactivos y que `alisio run` no cambia.

### 6.12 Qué necesita la Fase 2 de la Fase 1

`PermissionMode`/tabla (el plan se impone con la política de solo lectura ya existente y el modo no debe poder ampliarla), `cycleableAgents` (el agente `plan` es el primer destino del ciclo), `activateAgent`/`updateSetting("agents.active")` como cambio atómico a `build`, y la ruta `POST /api/workspaces/:wid/reload` como ejemplo de operación entre turnos.

---

## 7. FASE 2 — Plan mode con Plan Review (IMPLEMENTADA 2026-10-02)

### 7.1 Objetivos

El agente `plan` entrega un plan Markdown con `exit_plan`; el plan se ve completo en el chat y se guarda como artefacto `plan.md`; el usuario decide: **Agree and start implementation**, **Skip for now**, **Add context**. Ambas superficies (TUI y web); en `alisio run` degrada sin colgarse.

### 7.2 Hechos verificados que corrigen el borrador (lo marcado «(no verificado)» antes de implementar)

| Tema | Borrador | Realidad | Estado |
|---|---|---|---|
| Visibilidad de `exit_plan` | `toolFilter` en `agentRunOptions` que solo ofrece la herramienta a `plan` | `RunOptions.toolFilter` existe, pero `build` no lleva filtro (vería la herramienta), las sesiones hijas calculan su filtro aparte (`ChildSessions.filter`, la raíz devuelve `() => true`) y Code Mode (`execute`) llama a `registry` sin filtro. Solución: **herramienta opt-in** (`core/opt-in.ts`): oculta para todos y visible solo si la ejecución lista el nombre en `RunOptions.optInTools`; `agentRunOptions` lo añade solo al agente `plan` integrado y `execute` la rechaza. | (verificado) |
| Registro condicionado a `ui.interactive()` | En `tools/standard.ts` | `registerStandard` corre antes de que la TUI enlace la interfaz; `interactive()` se evalúa al llamar. Se registra siempre (`application.ts`, `registerExitPlan`) y la degradación se decide en la ejecución. | (verificado) |
| Eventos desde una herramienta | `plan_proposed`/`plan_decided` | `ToolContext.emit` solo produce `tool_progress` (efímero). Se añadió `ToolContext.emitEvent` (solo lo recibe `exit_plan`, tipado a esos dos eventos); los dos son durables. | (verificado) |
| Opciones de ejecución del servidor | Heredan `agentRunOptions` | `SessionService.runOptions` copia solo un subconjunto de campos: hubo que reenviar `optInTools`. | (verificado) |
| Artefacto | «publicar con `ArtifactStore`» | `ToolContext.artifacts.publishText` está disponible en toda llamada (no solo con análisis habilitado); queda enlazado a `runId`/`callId`. Un `plan.md` por llamada; título `<título> (revision N)` desde la 2ª. No se usa `python_run`. | (verificado) |
| Ruta `POST /api/sessions/:sid/plan/decision` | Reintento tras reconexión | **No se implementa.** La decisión viaja por `POST /api/interactions/:iid` (idempotente: la segunda respuesta devuelve `409 approval_resolved`) y la revisión pendiente se reenvía en el `snapshot` SSE (`pending.interactions`). Una ruta extra no aportaba nada. | (decisión) |
| Reanudar tras la decisión | `task()`/servidor al terminar el run | TUI: hook al final de `task()`; servidor: `RunScheduler.onChange("finished")` con el nuevo parámetro `{cancelled}`. `RunScheduler.submit` es la vía para iniciar el run. | (verificado) |
| `applyActiveAgent` (TUI) | No usar | Correcto: cambia el modelo y crea sesión. Se usa `app.updateSetting("agents.active","build")` con `agentOverride`, igual que el ciclo. | (verificado) |
| Ciclo bloqueado con la revisión pendiente | A verificar | TUI: el turno sigue `busy` y el panel ocupa la ranura del picker (`shiftTabDecision` → bloqueo o `ignore`). Web: la revisión sustituye al compositor; además `cycleAgent` se niega con una interacción pendiente (probado). | (verificado) |
| Tiempo máximo del run | — | `limits.timeoutMs` (10 min) corre durante la espera: una revisión sin respuesta puede acabar como «Skip». El puente web además omite tras 30 s sin clientes y a los 10 min. | (verificado, documentado) |

### 7.3 Módulos

| Ruta | Estado | Contenido |
|---|---|---|
| `packages/sdk/src/index.ts` | modificado | `QuestionOption.textInput?`, `PlanReview`, `AskQuestionsRequest.plan?`, `PendingInteraction.request.plan?`, `RunEventDataMap.plan_proposed/plan_decided`, `ToolContext.emitEvent?`. |
| `packages/core/src/core/opt-in.ts` | **nuevo** | `EXIT_PLAN_TOOL`, `OPT_IN_TOOLS`, `optInAllows`. |
| `packages/core/src/core/runner.ts` | modificado | `RunOptions.optInTools`; la herramienta opt-in se oculta (`availableTools`) y se rechaza en el ejecutor; `emitEvent` solo para `exit_plan`. |
| `packages/core/src/tools/execute.ts` | modificado | Code Mode rechaza herramientas opt-in. |
| `packages/core/src/plan/state.ts` | **nuevo** | Estado `sessions.options.plan` con compare-and-set (`proposePlan`, `decidePlan`, `claimApprovedPlan`, `discardApprovedPlan`, `withdrawPendingPlan`, `settlePlanRun`), `implementationPrompt`, constantes y opciones. |
| `packages/core/src/plan/exit-plan.ts` | **nuevo** | La herramienta. |
| `packages/core/src/runtime/store.ts` | modificado | `mutateSessionOptions` (lectura-modificación-escritura atómica, `BEGIN IMMEDIATE`). |
| `packages/core/src/agents/active.ts` | modificado | `PLAN_INSTRUCTIONS` (estructura del plan y uso de `exit_plan`); `agentRunOptions` devuelve `optInTools` para `plan`. |
| `packages/core/src/application.ts` | modificado | Registro de `exit_plan` (`readOnly` y `plugins.ui`). |
| `packages/server/src/bridges/interaction-bridge.ts` | modificado | Reenvía `plan`; acepta la clave `"<id>:text"` (≤ 20 000 caracteres) solo si una opción declara `textInput`. |
| `packages/server/src/host/{plan,run-scheduler,sessions}.ts`, `index.ts` | **nuevo/mod.** | Seguimiento tras el run (`followUpPlanRun`), `onChange(..., {cancelled})`, `runOptions.optInTools`. |
| `packages/cli/src/tui/plan-review.ts`, `components.ts` (`PlanReviewPanel`), `app.ts`, `state.ts` | **nuevo/mod.** | Reductor puro, panel, `askPlanReview`, `followUpPlan` en `task()`, etiqueta de espera. |
| `packages/web/src/store/plan-review.ts`, `components/approval/{PlanReviewPanel.tsx,plan.module.css}`, `app.tsx`, `ToolRow.tsx`, `store/app.ts`, `i18n/*` | **nuevo/mod.** | Panel perezoso (con respaldo al panel genérico si el chunk no carga), fila **Plan** abierta con el Markdown, refresco de la insignia del agente y guarda del ciclo. |
| `packages/web/src/components/settings/labels.ts` | **nuevo** | Etiquetas de ajustes fuera del diccionario inicial (presupuesto de bundle). |

### 7.4 Contratos

```ts
export interface QuestionOption { /* … */ textInput?: { placeholder?: string } }
export interface PlanReview { planId: string; revision: number; hash: string; title: string; markdown: string; artifact?: ArtifactRef }
// AskQuestionsRequest.plan?: PlanReview ; PendingInteraction.request (kind "questions").plan?: PlanReview
// AskQuestionsResult is unchanged: free text travels as the extra key "<questionId>:text".
// RunEventDataMap (durable):
//   plan_proposed: { callId; planId; revision; hash; title; artifactId? }
//   plan_decided:  { callId; planId; hash; decision: "approve" | "skip" | "context" }
```

**`exit_plan`** (`effect: "read"`, opt-in): entrada `{ plan: string (1–60 000), title?: string (≤ 120) }`. La pregunta tiene `id: "plan"`, título «Plan complete. What would you like to do?» y tres opciones con valor `approve` / `skip` / `context` y etiquetas exactas «Agree and start implementation», «Skip for now», «Add context» (`textInput`). Las UIs web localizan por **valor** (ES: «Aceptar y empezar la implementación», «Omitir por ahora», «Añadir contexto»; título «Plan completo. ¿Qué quieres hacer?»).

Resultado (siempre hay uno; JSON en la parte de texto, más el bloque `artifact` de la UI): `approved`, `skipped` (Skip, Esc, pantalla cerrada, run cancelado, contexto vacío, revisión ya no pendiente), `feedback` (+ `feedback: <texto>`; el modelo debe volver a llamar a `exit_plan`) y `unavailable` (sin UI interactiva o `--read-only`: se pide el plan completo como respuesta final). La llamada nunca cambia de agente ni inicia trabajo.

### 7.5 Estado, idempotencia y recuperación

- `sessions.options.plan = { planId, revision, hash, title, status, callId?, artifactId?, plan? , updatedAt }` con `status` ∈ `pending → approved → implementing`, o `skipped` / `feedback` / `cancelled`. `plan` (la instantánea) solo existe en `approved`. La revisión es `anterior + 1`.
- Cada transición es compare-and-set en `mutateSessionOptions`. `claimApprovedPlan` pasa `approved → implementing` y, en la misma transacción, fija `agent: "build"` en la web: una segunda reclamación (doble clic, otra pestaña, otro proceso) no encuentra nada. El run de implementación usa `requestId = plan-<planId>`: aunque hubiera otra vía, `beginRun` no crearía un segundo run.
- Turno de implementación: mensaje de usuario persistido con la instantánea (`<approved_plan …>`) y `display` «Implement the approved plan: <título>», ejecutado con `runner.run` normal (IDs de llamadas y datos de continuación intactos). El agente cambia **antes** de ese run y el modo de permisos no cambia.
- `settlePlanRun` (compartido por TUI y servidor) al terminar un run: una revisión sin respuesta cuenta como `skipped`; un run cancelado descarta la aprobación (`cancelled`); si no, reclama.
- Recarga web con revisión pendiente: el `snapshot` SSE trae `pending.interactions` con `plan`; el panel vuelve a mostrarse. Una respuesta tardía a una revisión retirada devuelve `409`.

### 7.6 UX

TUI: el plan se imprime completo en la transcripción antes del panel; el panel (`PlanReviewPanel`) muestra las tres opciones, `Esc` = skip, «Add context» abre una línea de texto (Enter envía, Esc vuelve), el artefacto figura en `/artifacts`. Web: fila **Plan** abierta con el Markdown, panel de decisión en el lugar del compositor con la tarjeta de `plan.md` (se abre en el panel lateral) y las tres opciones; «Añadir contexto» abre un `textarea` (Enter envía, Mayús+Enter salto de línea); Esc omite (en el `textarea`, vuelve a las opciones). Los botones se bloquean tras la primera decisión.

### 7.7 Criterios de aceptación (resultado)

| Criterio | Prueba |
|---|---|
| `exit_plan` solo en `plan`; el plan no escribe ni ejecuta con ningún modo | `tests/plan-review.test.ts` (visibilidad, ask/auto/full, Code Mode) |
| Aprobar / skip / contexto / cancelar devuelven resultado, sin llamadas colgadas | `tests/plan-review.test.ts`, `tests/server-plan-review.test.ts` |
| Aprobar dos veces = un turno; cambia a build antes y lleva la instantánea | ambas, más `settlePlanRun` |
| Degradación sin UI y con `--read-only` | `tests/plan-review.test.ts` |
| Artefacto por revisión | `tests/plan-review.test.ts`, `tests/server-plan-review.test.ts` |
| Trama de interacción, respuesta con texto, repetición tras reconexión, retirada al cancelar, auth/Origin | `tests/server-plan-review.test.ts` |
| Reductor y panel TUI, ciclo bloqueado, plan en transcripción | `tests/tui-plan-review.test.ts` |
| Web: reconocimiento, respuestas, recarga, carga perezosa, EN/ES, ciclo bloqueado | `tests/web-plan-review.test.ts` |
| Navegador | Comprobado en Chromium contra `alisio serve` con proveedor falso (plan → exit_plan → contexto → aprobación con doble clic → turno build que escribe un archivo; Esc; recarga con revisión pendiente; artefacto en el panel lateral) |

### 7.8 Qué necesita la Fase 3 de la Fase 2

La política del agente `plan` (`bg_*` son `process`: denegadas), `RunScheduler.onChange` con `{cancelled}` y el patrón «hook al terminar el run» para la notificación de tareas, `mutateSessionOptions` como ejemplo de CAS entre procesos, y la regla de presupuesto de bundle (≈ 100 bytes de margen: textos de los paneles Tasks en chunks perezosos).

---

## 8. FASE 3 — Tareas en segundo plano (pendiente)

### 8.1 Objetivos

Runtime general de tareas (`kind: shell` y espejo de subagentes), herramientas `bg_*`, notificación coalescida, paneles `/tasks` (TUI) y Tasks (web).

### 8.2 Módulos

| Ruta | Estado | Contenido |
|---|---|---|
| `packages/core/src/background/{service,store,output,notify}.ts` | **nuevo** | `BackgroundTasks` (admisión, CAS de estados, kill del grupo de procesos, watchdog con origen de abortado), almacén SQLite, almacén de salida con offsets, notificador coalescido. |
| `packages/core/src/runtime/store.ts` | modificado | **Migración v7** (§10). |
| `packages/core/src/tools/background.ts` | **nuevo** | `bg_run`, `bg_list`, `bg_output`, `bg_stop`. |
| `packages/core/src/application.ts` | modificado | Crea el servicio; marca `lost` al arrancar; cierre ordenado (bloquea admisiones, aborta, drena). |
| `packages/plugin-subagents/src/{index,manager}.ts` | modificado | Publica sus tareas en `pluginState("subagents","tasks")` para el espejo (sin cambiar sus herramientas). |
| `packages/server/src/routes/tasks.ts` | **nuevo** | Rutas §11. |
| `packages/cli/src/tui/tasks.ts`, `app.ts` | **nuevo/mod.** | `/tasks` (picker + visor de salida). |
| `packages/web/src/components/tasks/TasksPanel.tsx`, `store/tasks.ts` | **nuevo** | Panel con salida en vivo y botón Stop. |

### 8.3 Herramientas

```json
{ "name": "bg_run", "effect": "process",
  "inputSchema": { "type":"object","required":["command"],"additionalProperties":false,
    "properties": { "command":{"type":"string","minLength":1,"maxLength":8000},
                    "cwd":{"type":"string","description":"workspace-relative"},
                    "label":{"type":"string","maxLength":80},
                    "timeoutMs":{"type":"integer","minimum":1000,"maximum":86400000} } } }
{ "name": "bg_list",   "effect": "read",    "inputSchema": { "properties": { "status": {"enum":["running","completed","failed","stopped","timed_out","lost"]}, "limit":{"type":"integer","maximum":50} } } }
{ "name": "bg_output", "effect": "process", "inputSchema": { "required":["id"], "properties": { "id":{"type":"string"}, "offset":{"type":"integer","minimum":0}, "limit":{"type":"integer","maximum":65536} } } }
{ "name": "bg_stop",   "effect": "process", "inputSchema": { "required":["id"], "properties": { "id":{"type":"string"} } } }
```

`bg_output` devuelve `{text, nextOffset, eof, status, exitCode?}` (el modelo conserva su offset; no hay cursor oculto). Todas las llamadas pertenecen al árbol de sesiones del propietario (`root_session`): una tarea ajena es «not found». `bg_list` solo lista las del propietario.

### 8.4 Máquina de estados de tarea

| Desde | Evento | Hasta | Notas |
|---|---|---|---|
| (nueva) | admisión OK | `running` | Rechazada si se superan `background.maxTasks` o el servicio está cerrando. |
| `running` | proceso sale con 0 | `completed` | CAS `status='running'`. |
| `running` | proceso sale ≠0 | `failed` | `exit_code`. |
| `running` | `bg_stop`/usuario | `stopped` | `stop_origin` = `model`\|`user`; SIGTERM al grupo, SIGKILL tras 3 s. **Una parada pedida no se informa como fallo.** |
| `running` | watchdog | `timed_out` | `stop_origin='timeout'`. |
| `running` | Alisio sale | `stopped` | `stop_origin='shutdown'`; el grupo se mata. |
| `running` (otro proceso muerto) | arranque | `lost` | Recuperación: `owner_pid` ya no vive. |
Transiciones terminales no se sobrescriben (CAS). Una notificación por lote de finalizaciones (ventana `background.notifyMinIntervalMs`, máximo una por ventana, texto acotado); **nunca** si la sesión propietaria no existe, está archivada o ya consumió la notificación (`notified_at`).

### 8.5 Política y aprobaciones

`bg_run` pasa por `executeCall` como `process` (aprobación en `ask`/`auto`; permitido en `full`; denegado bajo `--read-only` y para agentes `readOnly`). `bg_output` y `bg_stop` también son `process` (ADR-08) para que ninguna política de solo lectura los alcance. Coste asumido: en `ask` el primer `bg_output` pide aprobación; «Allow for this session» lo cubre. Alternativa si resulta molesto: una capability `background.manage` (riesgo R2).

### 8.6 Pruebas y criterios

Proceso hijo que escribe y termina; parada limpia (no `failed`); `lost` tras reinicio simulado; muerte del grupo al salir; notificación coalescida y limitada; no despierta sesión terminada; `bg_*` denegadas en agente `plan` y bajo `--read-only`; lectura por offsets sin duplicar; salida acotada; Windows: `taskkill /T` en lugar de señales de grupo (no verificado). Docs: `docs/tools.md`, `docs/tui.md`, `docs/web.md`, `docs/configuration.md`.

---

## 9. FASE 4 — `/goal` (pendiente)

### 9.1 Objetivos

Objetivo de sesión con auto-continuación, límites duros e interruptores; solo el modelo marca `complete`/`blocked` (con evidencia); solo el usuario controla el resto.

### 9.2 Módulos

| Ruta | Estado | Contenido |
|---|---|---|
| `packages/core/src/goal/{controller,store,prompts,budget}.ts` | **nuevo** | `GoalController` (decide tras cada run), almacén CAS, textos, parser de presupuesto (`50k`, `1.5M`, `clear`). |
| `packages/core/src/tools/goal.ts` | **nuevo** | `update_goal`. |
| `packages/core/src/commands/builtins.ts` | modificado | `goal` (surface, TUI+web). |
| `packages/server/src/routes/goal.ts` | **nuevo** | `GET/PUT/DELETE /api/sessions/:sid/goal`, acciones. |
| `packages/server/src/host/run-scheduler.ts` | modificado | Hook `onRunEnd` que invoca al controlador (`done.finally`). |
| `packages/cli/src/tui/{goal,app}.ts` | **nuevo/mod.** | Banner de goal, tras `task()` llama al controlador. |
| `packages/web/src/components/goal/GoalBanner.tsx`, `store/goal.ts` | **nuevo** | Banner con estado, presupuesto y controles. |

### 9.3 Herramienta y subcomandos

```json
{ "name": "update_goal", "effect": "internal",
  "inputSchema": { "type":"object","required":["status","summary","evidence"],"additionalProperties":false,
    "properties": {
      "status": {"enum":["complete","blocked"]},
      "summary": {"type":"string","minLength":1,"maxLength":2000},
      "evidence": {"type":"array","minItems":1,"maxItems":20,"items":{"type":"object","required":["kind","detail"],
        "properties":{"kind":{"enum":["file","test","log","command","other"]},"detail":{"type":"string","maxLength":1000}}}} } } }
```

`/goal <objetivo>` crea (kickoff una vez, luego recordatorio corto); `/goal` sin args muestra estado; `pause`, `resume`, `edit <objetivo>`, `clear`, `help`, `budget=<n>` (K/M: `50k`, `2m`), `budget=clear`. La herramienta rechaza `complete` sin evidencia y `blocked` en el primer intento: exige evidencia **repetida** (`goal.blockedRepeats`, por defecto 2 llamadas consecutivas con evidencia distinta).

### 9.4 Máquina de estados del goal (CAS por `epoch`)

| Desde | Disparador | Hasta | Código de motivo |
|---|---|---|---|
| (ninguno) | `/goal <obj>` | `active` | `created` |
| `active` | `update_goal(complete)` con evidencia | `complete` | `model_complete` |
| `active` | `update_goal(blocked)` repetido | `blocked` | `model_blocked` |
| `active` | tokens ≥ presupuesto | `budget_limited` | `token_budget` |
| `active` | turnos ≥ `goal.maxTurns` | `paused` | `max_turns` |
| `active` | tiempo activo ≥ `goal.maxWallMs` | `paused` | `max_wall` |
| `active` | N respuestas idénticas | `paused` | `repeated_reply` |
| `active` | N turnos sin herramientas | `paused` | `no_tool_turns` |
| `active` | usuario interrumpe | `paused` | `user_interrupt` |
| `active` | aprobación/pregunta pendiente, tarea en segundo plano activa del owner o agente `plan` | `active` (**sin continuar**) | espera (no es estado) |
| `paused`\|`blocked`\|`budget_limited` | `resume` (o `budget=` mayor) | `active` | `resumed` |
| cualquiera | `clear` | (eliminado) | — |
Solo el **usuario** produce `paused` manual, `resume`, `edit`, `clear` y cambios de presupuesto. El presupuesto es **duro**: el controlador comprueba antes de cada continuación y el `maxTokens` de cada run se acota al restante. Una única lista ordenada de bloqueadores decide si se continúa.

### 9.5 Pruebas y criterios

Continuación hasta `complete`; presupuesto duro (no se sobrepasa); disyuntores; no continúa con aprobación pendiente / tarea activa / modo plan; pausa al interrumpir; el modelo no puede pausar/limpiar; CAS bajo concurrencia (dos superficies); reanudación tras reinicio; TUI/web/`run` (headless: `alisio run --goal` fuera de alcance v1; el controlador no corre en headless). Docs: `docs/tui.md`, `docs/web.md`, `docs/configuration.md`, `docs/tools.md`.

---

## 10. Migración v7 (aditiva; la introduce la Fase 3 y la Fase 4 solo la consume)

Una única migración forward-only con ambas tablas evita una v8 para la Fase 4 (la tabla `session_goals` queda sin lector hasta entonces). Prueba: `tests/store-migration-v7.test.ts` (patrón de `store-migration-v6.test.ts`).

```sql
CREATE TABLE IF NOT EXISTS background_tasks(
  id TEXT PRIMARY KEY,
  session TEXT NOT NULL, root_session TEXT NOT NULL, workspace TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('shell','subagent')),
  label TEXT NOT NULL, command TEXT, cwd TEXT,
  status TEXT NOT NULL CHECK(status IN ('running','completed','failed','stopped','timed_out','lost')),
  exit_code INTEGER, signal TEXT,
  pid INTEGER, owner_pid INTEGER NOT NULL,
  stop_origin TEXT CHECK(stop_origin IN ('user','model','timeout','shutdown')),
  log_path TEXT NOT NULL, bytes INTEGER NOT NULL DEFAULT 0,
  external_id TEXT, notified_at INTEGER,
  created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
CREATE INDEX IF NOT EXISTS background_tasks_owner ON background_tasks(root_session, created_at);
CREATE INDEX IF NOT EXISTS background_tasks_status ON background_tasks(status, owner_pid);
CREATE TABLE IF NOT EXISTS session_goals(
  session TEXT PRIMARY KEY REFERENCES sessions(id),
  objective TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('active','paused','blocked','budget_limited','complete')),
  reason TEXT, evidence TEXT,
  epoch INTEGER NOT NULL DEFAULT 1,
  token_budget INTEGER, tokens_used INTEGER NOT NULL DEFAULT 0,
  turns_used INTEGER NOT NULL DEFAULT 0,
  max_turns INTEGER NOT NULL, max_wall_ms INTEGER NOT NULL, active_ms INTEGER NOT NULL DEFAULT 0,
  no_tool_streak INTEGER NOT NULL DEFAULT 0, repeat_streak INTEGER NOT NULL DEFAULT 0,
  last_reply_hash TEXT, blocked_streak INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, completed_at INTEGER);
INSERT OR IGNORE INTO schema_migrations VALUES(7);
```

Salida de tareas: `<stateRoot>/tasks/<root_session>/<id>.log` (acotada por `background.maxOutputBytes`; se trunca por la **cabeza**, conservando la cola). `plan` (fase 2) no necesita tabla: usa `artifacts` y `sessions.options.plan`.

---

## 11. Rutas HTTP y frames SSE (fases 2–4; las de la fase 1 están en §6.7)

| Método y ruta | Fase | Resumen |
|---|---|---|
| ~~`POST /api/sessions/:sid/plan/decision`~~ | 2 | **No implementada** (§7.2): la decisión viaja por `POST /api/interactions/:iid` con `{answer: {plan, "plan:text"?}}`. |
| `GET /api/sessions/:sid/tasks` | 3 | Lista (`BackgroundTaskInfo[]`), incluye espejo de subagentes. |
| `GET /api/sessions/:sid/tasks/:tid/output?offset=&limit=` | 3 | `{text, nextOffset, eof}`; misma política que `bg_output` (`process`). |
| `POST /api/sessions/:sid/tasks/:tid/stop` | 3 | Parada del usuario (`stop_origin:"user"`). |
| `GET/PUT/DELETE /api/sessions/:sid/goal` | 4 | Estado; crear/editar/presupuesto; borrar. |
| `POST /api/sessions/:sid/goal/{pause,resume}` | 4 | Acciones del usuario (CAS por `epoch`; `409` si cambió). |
| Frame `{t:"background_task", sessionId, task}` | 3 | Altas y cambios de estado; el cliente refresca la salida con `offset`. |
| Frame `{t:"goal_updated", sessionId, goal}` | 4 | Estado actual (`GoalInfo`). |
| Códigos `ApiErrorCode` nuevos | 3–4 | `task_not_found`, `goal_conflict`, `goal_not_found`. |

Todas las rutas heredan auth, Host y Origin del servidor; los cuerpos son JSON; las acciones del usuario no están disponibles bajo `--read-only` cuando ejecutan procesos.

---

## 12. Claves de configuración (fases 3–4; la Fase 1 no añade ninguna)

| Clave | Por defecto | Fase | Nota |
|---|---|---|---|
| `background.maxTasks` | 8 | 3 | Concurrentes por sesión raíz. |
| `background.maxOutputBytes` | 5 242 880 | 3 | Por tarea (conserva la cola). |
| `background.defaultTimeoutMs` | 3 600 000 | 3 | Si `bg_run` no lo pide. |
| `background.notifyMinIntervalMs` | 5 000 | 3 | Coalescencia. |
| `goal.maxTurns` | 30 | 4 | Tope duro por goal. |
| `goal.maxWallMs` | 7 200 000 | 4 | Tiempo activo. |
| `goal.noToolTurns` | 3 | 4 | Disyuntor sin herramientas. |
| `goal.repeatReplies` | 3 | 4 | Disyuntor de respuestas idénticas. |
| `goal.blockedRepeats` | 2 | 4 | Evidencia repetida para `blocked`. |

Se añaden a `SETTABLE_KEYS` solo las que tengan sentido en caliente; las demás, solo en `config.json`.

---

## 13. Riesgos abiertos

| # | Riesgo | Mitigación / decisión |
|---|---|---|
| R1 | La TUI parte de `external:true` si hay plugins/MCP (verificado); la etiqueta de modo inicial (`ask`) puede no coincidir con la política real. | `/permission status` muestra la política **real** por efecto y lo explica; cambiar de modo la fija. |
| R2 | `bg_output`/`bg_stop` como `process` piden aprobación en `ask`. | Aceptado en v1; alternativa: capability `background.manage` con grants de sesión. |
| R3 | Recarga TUI reconstruye la aplicación completa (conexiones MCP y plugins se reinician). | Guarda estricta de inactividad; informe claro; código de plugins ya importado exige reinicio. |
| R4 | Shift+Tab web rompe la expectativa de navegación por teclado. | Selector accesible + documentación (§6.4). |
| R5 | Terminales que no envían Shift+Tab distinguible (`\x1b[Z`). | Todo es alcanzable con `/agents` y `/agent:<id>`; documentado. |
| R6 | Windows: matar el grupo de procesos (fase 3) y rutas del changelog. | `taskkill /T /F`; pruebas con rutas neutras; marcado «no verificado» hasta probar. |
| R7 | Presupuesto de `/goal` depende de que el proveedor reporte `usage`. | Sin `usage` se estima (`estimateTokens`) y se marca; el tope de turnos sigue siendo duro. |
| R8 | Dos aplicaciones del mismo workspace coexisten un instante durante la recarga. | La antigua está inactiva (guarda) y se cierra tras el intercambio; ambas comparten la base SQLite (ya soportado por el servidor). |
| R9 | El presupuesto de JS inicial de la web (90 KB gzip) quedó en ~89,7 KB tras la Fase 1 y en ~89,9 KB tras la Fase 2 (≈ 100 bytes de margen; se movieron las etiquetas de ajustes a un módulo perezoso) (hubo que dejar el menú de permisos y el diálogo de changelog como chunks perezosos y reutilizar claves i18n). | Las fases 2–4 deben cargar sus paneles de forma perezosa y, si hace falta, cargar el diccionario del idioma no activo bajo demanda. |

---

## Apéndice A0 — Reglas de documentación para todas las fases

Requisito del propietario (2026-10-02): en toda documentación nueva o actualizada, usar las capturas de la web de `docs/assets/web-ui/` donde ayuden a explicar una función de la **web** (nunca en secciones de la TUI), sin renombrarlas ni inventar capturas de funciones que aún no existen. Patrón: `<figure class="doc-shot"><img src="./assets/web-ui/<archivo>" alt="…" width height loading="lazy" decoding="async" /><figcaption>…</figcaption></figure>` (`../assets/…` en `docs/es/`), junto al párrafo que ilustra, con alt y pie en el idioma de la página, la misma imagen en EN y ES y como máximo dos usos por página; si la captura muestra interfaz en español, el pie en inglés añade «(Spanish interface)». Fase 1: `trajectory_web_ui.webp` en la pestaña Trayectoria de `web.md` y en el panel de artefactos de `analysis.md`; `dashboard_generated.webp` en `#artifacts` de `web.md` y en los tipos de artefacto de `analysis.md`; `Preview_of_tabular_data_in_CSV_and_Excel.webp` en `#tables` de `web.md` y en los datos tabulares de `analysis.md` (+ES).

## Apéndice A — Patrones adoptados y evitados del proyecto de referencia

| Adoptar (patrón) | Dónde |
|---|---|
| Cambios de modo «armados» que confirma el runtime; contadores de secuencia que ignoran resultados asíncronos obsoletos | §6.3 (aplicar y reetiquetar solo tras el éxito), §6.5 |
| Una función modos→política | §6.3 |
| Plan congelado como snapshot con decisión de 3 vías e implementación idempotente | §7.3 |
| Máquina de estados del goal con códigos de motivo cerrados y CAS por época; kickoff una vez y luego recordatorio corto; doble disyuntor; lista única ordenada de bloqueadores | §9 |
| Almacén de tareas + almacén de salida con offsets, CAS, estado `lost` al arrancar, *watchdog* con origen de abortado, mensaje de despertar con *batching* y límite de ráfaga, registro de admisión, cierre ordenado | §8, §10 |
| **Evitar**: sobreingeniería (liquidación de 10 etapas, capas V1/V2), un `/reload` limitado a la TUI, un Shift+Tab que no cicla modos reales | §1.3, §6 |
