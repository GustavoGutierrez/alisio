# Especificación Técnica: Carpetas en la nube como workspace (orígenes remotos, Google Drive primero)

| Campo | Valor |
|---|---|
| Versión | 1.0 |
| Proyecto | Alisio |
| Estado | Especificación técnica ejecutable. **NO implementada. No se ejecuta hasta que el propietario lo ordene**, y nunca antes de cerrar la Fase 0 (§16.1). |
| Fecha | 2026-10-03 |
| Paquetes afectados | `@alisio/sdk` (tipos y capacidad aditiva `api.sources`, subruta `@alisio/sdk/testing/sources`), `@alisio/core` (motor de sincronización, OAuth, almacén de tokens, migración v9, herramientas, opción de raíz exacta), `@alisio/server` (rutas `/api/sources/*`, tramas SSE, apertura de workspace por ruta exacta), `@alisio/web` (privado: asistente, Ajustes, insignia, revisión de envíos), `@alisio/alisio-code` (CLI/TUI: `/source`, `alisio source …`, registro del integrado) |
| Paquetes nuevos | `@alisio/plugin-google-drive` (publicado, integrado en `BUILTIN_PLUGINS`, desactivable) |
| Relación con otras especificaciones | Extiende `alisio-ui.md` (protocolo web v1, formato de error, Origin), `alisio-data-analysis-runtime-v1.2.md` (ADR-01 «core, no plugin», ADR-02 «capacidad refina efecto», `capability_grants`) y `alisio-modes-goal-background-v1.md` (modos `ask`/`auto`/`full`, patrón `owner_pid`, Ajustes). Todo es aditivo. |
| Superficies | Web y TUI con paridad funcional; headless (`alisio source status|sync`) para scripts. |
| Política de versión | Es una funcionalidad nueva: sale en **0.2.0** (reglas 0.x de `CHANGELOG.md`: una minor puede romper; esta no rompe nada). Changeset por paquete publicado. |

## 0. Cómo usar este documento (para agentes de código)

1. Lee primero `AGENTS.md` y `CONTRIBUTING.md`; prevalecen sobre este documento. TDD estricto: la prueba que falla va primero.
2. **(verificado)** = comprobado en el código o en la documentación oficial al redactar (2026-10-03). **(no verificado)** = deducido o con fuentes contradictorias: compruébalo antes de apoyarte en ello. **(nuevo)** = archivo o símbolo a crear.
3. **Orden obligatorio**: Fase 0 (prueba desechable fuera del repo, §16.1) → el propietario confirma los resultados → Fases 1–5. Cada fase deja el repo verde (`pnpm check` completo) y no se hace commit hasta que lo pida el propietario.
4. **Un plugin no es un sandbox y un subproceso tampoco** (`AGENTS.md`). El aislamiento del token (§4.3) reduce fugas accidentales; no es una garantía de seguridad y ningún texto lo presenta así.
5. Idioma: identificadores, rutas, eventos, tipos y textos de UI en inglés (con su traducción ES donde se indica); esta especificación en español; docs ES en español neutro.
6. Contratos aditivos: ninguna columna, evento, tipo o ruta existente cambia de semántica. Las uniones solo ganan variantes.

---

## 1. Objetivo, alcance y principio rector

### 1.1 Objetivo

Que una persona **no técnica** conecte una carpeta de Google Drive y trabaje con el agente sobre sus documentos como si fuera un workspace local: el agente lee, entiende y (con aprobación explícita) propone cambios que se envían a Drive. Todo el andamiaje es **agnóstico del proveedor**: Google Drive es el primer adaptador; OneDrive, Dropbox, WebDAV/Nextcloud o S3 se añaden como paquetes sin tocar core.

### 1.2 Principio del usuario no técnico (criterio de aceptación transversal)

- Conectar en **≤ 4 pasos** sin terminal, sin Google Cloud, sin copiar claves.
- Todo error se explica en lenguaje llano con **una** acción siguiente.
- Nada sale de su equipo hacia Drive sin que lo vea (diff) y lo apruebe; nada se borra de forma definitiva.
- Siempre puede desconectar y revocar desde Alisio.

### 1.3 Alcance v1 (Fases 1–4)

Conexión OAuth con el cliente de Alisio o uno propio; espejo local gestionado; lectura de binarios y nativos (Docs→Markdown, Sheets→XLSX, Slides→texto, Drawings→PNG); propuesta y envío por lotes aprobados (Fase 3); papelera en lugar de borrado; conflictos con copia; sondeo por la Changes API; unidades compartidas; recuperación tras caída; edición precisa de Docs con `batchUpdate` (Fase 4).

### 1.4 Fuera de alcance (v1)

| Excluido | Motivo |
|---|---|
| Sistema de archivos virtual / montaje FUSE | ADR-1 (§4.1). |
| rclone como motor; Google Drive para escritorio como dependencia | ADR-1. |
| Sincronización automática de escrituras (write-through) | D4: nunca. |
| Sobrescribir documentos nativos existentes con una reimportación | D5 (salvo que la Fase 0 lo pruebe seguro, y entonces solo con aviso de pérdida explícito). |
| Accesos directos (shortcuts) de Drive | Se omiten en v1 (sin enlaces simbólicos: `safePath` los prohíbe). |
| Notificaciones push (`changes.watch`) | Exigen un webhook HTTPS público (verificado); se sondea. |
| Compartir/cambiar permisos de archivos, comentarios de Drive | No los pide el caso de uso. |
| Varias cuentas por conexión, cifrado de extremo a extremo, colaboración en tiempo real | Fuera de v1. |
| Materializar `.alisio/` o `.agents/agents/` remotos | Seguridad (§9). |

---

## 2. Decisiones del propietario (confirmadas el 2026-10-03; aplicar exactamente)

| # | Decisión |
|---|---|
| D1 | **Arquitectura A**: espejo local + motor de sincronización agnóstico en core; la carpeta se materializa en un directorio gestionado que es el `cwd` real del workspace. «Solo MCP» queda documentado como alternativa avanzada; el FS virtual y rclone-como-motor se descartan (ADR-1). |
| D2 | **Permiso `drive.file`** (no sensible) con el selector de escritorio de Google («OnePick»). En paralelo el propietario solicita la verificación del permiso completo `drive`, que se habilita cuando Google apruebe (§8.1). **Antes de implementar**, la Fase 0 (2–3 días) resuelve qué concede elegir una carpeta, qué pasa al reimportar Markdown sobre un Doc y si funciona el plan B de pegar la URL. |
| D3 | **Cliente OAuth propiedad de Alisio, verificado por Google**, incluido en la app («Iniciar sesión con Google» en dos clics). Usuarios avanzados y empresas pueden usar **su propio client id** desde Ajustes (evita la verificación). Lista del propietario en §8.9, instrucciones BYO en §8.10. |
| D4 | **Escritura**: Fase 2 solo lectura. Fase 3 añade por conexión «leer y proponer cambios»: el agente trabaja en la copia local; el usuario ve «N cambios listos para enviar a Drive» con diff y aprueba el lote. Borrar = papelera y **siempre pregunta, incluso en `full`**. Nada se sube sin aprobación. Nunca sincronización automática de escrituras. |
| D5 | **Nativos**: v1 los lee (Docs→Markdown, Sheets→XLSX, Slides→texto, Drawings→PNG); el agente puede **crear** documentos nuevos desde Markdown; **nunca sobrescribe** nativos existentes. Edición precisa con Docs API (`batchUpdate`) en Fase 4. Reimportar Markdown sobre un Doc no se ofrece (salvo §16.1 lo pruebe seguro, y solo con aviso de pérdida). |
| D6 | **Privacidad**: el asistente dice claramente que lo que Alisio lee se envía al proveedor de modelo configurado y el usuario **confirma** que su proveedor no entrena con esos datos. Si Google lo exige al verificar, se pasa a una lista de proveedores permitidos (punto de extensión §5.1 `declaresNoTrainingOnUserData`; no se inventan declaraciones de proveedores). El propietario debe obtener **asesoría legal**: esto no fue verificable más allá del texto de la política de Google. |
| D7 | Espejo **oculto** en `<stateHome>/sources/<connId>/mirror` con botón «Open local folder». |
| D8 | Proveedor Google en el paquete integrado **`@alisio/plugin-google-drive`**, registrado en `BUILTIN_PLUGINS` y desactivable. |
| D9 | Tokens en el **llavero del sistema mediante herramientas del propio sistema**, sin módulos nativos (macOS `security`, Linux `secret-tool` si existe, Windows DPAPI vía PowerShell); fallback archivo **0600** con aviso visible. |
| D10 | AGENTS.md y skills de una carpeta remota se cargan **solo tras una confirmación específica** («This folder includes instructions for the agent»). `.alisio/` remoto **nunca** se materializa. |

Adaptaciones de esta especificación (revisables por el propietario):

- **A1.** D10 se extiende a **`.agents/agents/`**: tampoco se materializa, porque `trust.ts` lo trata como recurso de proyecto del mismo nivel que `.alisio/agents` (definiciones de agente con herramientas). Las skills (`.agents/skills`, `.claude/skills`) sí quedan bajo la confirmación de D10.
- **A2.** El agente **no envía** nunca: solo puede pedir que se abra la revisión (`source_push_request`, §9.4). El envío lo dispara siempre una persona (botón o aprobación `once`).
- **A3.** Drive v3 no ofrece escritura condicional fiable (sin `If-Match` documentado en `files.update`, **no verificado**): el adaptador declara `conditionalWrite: "preflight"` y el motor comprueba la versión justo antes de escribir; la carrera residual queda en el registro de riesgos (§17.2).

Pendientes abiertos: resultados de la Fase 0 (§16.1), verificación de Google del permiso `drive` (§8.9), asesoría legal sobre D6, disponibilidad real de `secret-tool` en Linux.

---

## 3. Estado actual del código (re-verificado el 2026-10-03)

| Hecho | Dónde | Estado |
|---|---|---|
| Tabla `workspaces(path TEXT PRIMARY KEY, label, pinned, last_opened_at)` (v4) + `archived_at` (v5); `SQLiteStore.workspaces()` une rutas de sesiones raíz y la tabla; `recordWorkspace(path, patch)` | `packages/core/src/runtime/store.ts` | verificado |
| Migraciones aditivas e idempotentes en `SQLiteStore.migrate()`; la **última es v8** (columnas de `session_goals`). La siguiente es **v9** | ídem | verificado |
| `sessions.workspace` guarda la ruta | ídem (DDL inicial) | verificado |
| `workspaceKey(path)` = 16 hex de sha256; el servidor lo usa como `workspaceId` | `runtime/paths.ts`, `host/workspace-host.ts` (`workspaceId`) | verificado |
| `findWorkspace(cwd)`: realpath y **sube hasta encontrar `.git`**; si no hay, devuelve realpath(cwd) | `runtime/paths.ts` | verificado |
| `findWorkspace` se llama en **dos** sitios relevantes: `WorkspaceHost.canonical()` y **`createApplication()`** (`workspace = await findWorkspace(cwd)`, `application.ts:228`). Corrige el análisis previo, que solo citaba el primero | `server/src/host/workspace-host.ts`, `core/src/application.ts` | verificado |
| `WorkspaceHost.openPath(path)` comprueba `workspaceExists`, crea la `Application` con `cwd: path` y `trustProject` según `resolveTrust` | `host/workspace-host.ts` | verificado |
| Recursos de confianza: `.alisio/config.json`, `.alisio/plugins`, `.alisio/agents`, `.agents/agents`, `.alisio/skills`, `.alisio/prompts` (`PROJECT_RESOURCE_RELATIVE_PATHS`); `trust.json` en `stateHome()` | `core/src/trust.ts` | verificado |
| **AGENTS.md se carga sin confianza**: `ProjectContext` se construye siempre (`application.ts:269`) y lee `AGENTS.override.md > AGENTS.md > AGENT.md` desde la raíz hasta el cwd, 32 KiB en total | `core/src/resources/context.ts` | verificado |
| **Skills de proyecto ya dependen de la confianza** (`skillRoots({ trusted: !!trustProject || !!config })`, `application.ts:451`). Corrige el análisis previo, que no lo distinguía | `core/src/application.ts`, `resources/skills.ts` | verificado |
| `safePath` prohíbe enlaces simbólicos segmento a segmento; `PathAccess.resolve` añade raíces extra y aprobación de directorios externos | `runtime/paths.ts`, `runtime/access.ts` | verificado |
| Herramientas sobre disco real: `read_file` (rechaza binarios con `\0`, devuelve `sha256`, 1 MiB), `write_file`/`edit_file` (`expectedHash`, 1 MiB), `list_files`/`search_text` ejecutan `rg` con `cwd: c.workspace`, `run_process`/`shell`, `git_status`/`git_diff` ejecutan `git` | `core/src/tools/standard.ts` | verificado |
| `Effect = "read" \| "write" \| "process" \| "external" \| "internal"`; `ToolDefinition.capability?: AnalysisCapability` (solo para herramientas integradas); `AnalysisCapability = "analysis.run" \| "analysis.install"` | `packages/sdk/src/index.ts` | verificado |
| `ApprovalRequest { effect; capability?: AnalysisCapability; preview?; install? }`; `Policy { write; process; external; analysis? }` | `core/src/core/contracts.ts` | verificado |
| `capability_grants`: CHECK en `scope ('once','session')`, `decision ('allow','deny')`, `source ('tui','web','flag','headless-grant')`; **sin CHECK en `capability`**; `session` y `workspace` NOT NULL | `runtime/store.ts` (v6), `analysis/capabilities.ts` (`CapabilityGrants`) | verificado |
| Modos: `ask` (nada sin preguntar), `auto` (`write`), `full` (`write`, `process`, `external`); `--read-only` bloquea | `core/src/permissions/modes.ts` | verificado |
| `PluginAPI`: `tools`, `commands`, `events`, `context`, `resources`, `state`, `compaction`, `session`, `model`, `models`, `providers.register`, **`storage: { sqlite(path) }`**, `views?`, `extensions`, `sessions`, `ui`. Patrón de detección: `api.views?.register` | `packages/sdk/src/index.ts` (~l. 1233) | verificado |
| `ProviderRegistration { id; name; fields: ProviderConfigurationField[] (kind incl. "secret"); capabilities?; create(request) }`; core guarda secretos en `ProviderSettingsStore` (`configHome()/credentials.json`, 0600, escritura atómica); `maskSecret()` | `sdk/src/index.ts`, `core/src/providers/settings.ts` | verificado |
| `configHome()` = `ALISIO_CONFIG_HOME` o `$XDG_CONFIG_HOME/alisio` o `~/.config/alisio`; `stateHome()` = `ALISIO_STATE_HOME` o `$XDG_STATE_HOME/alisio` o `~/.local/state/alisio` | `core/src/config.ts` | verificado |
| No existe llavero ni almacenamiento cifrado | búsqueda en `packages/*/src` | verificado |
| `BUILTIN_PLUGINS` (openai-compatible, memory, subagents) en el CLI; desactivables con `builtinPlugins.<id>.enabled:false` o `--disable-plugin`; las opciones `builtinPlugins.<id>` llegan al plugin | `packages/cli/src/builtin.ts`, `core/src/application.ts` | verificado |
| ADR-01: los plugins no registran rutas HTTP, no acceden a `SQLiteStore` ni al flujo de aprobación | `specs/alisio-data-analysis-runtime-v1.2.md` | verificado |
| Datasets: CSV/TSV/JSON/JSONL/XLSX (XLSX con helper Python de stdlib) | `core/src/analysis/data/datasets.ts` | verificado |
| Tareas en segundo plano con `owner_pid` y estado `lost` para dueños muertos; `TaskJanitor` con temporizador sin referencia | `core/src/background/{store,janitor}.ts` | verificado |
| `core/src/background/mirror.ts` ya existe (espejo de **tareas** de subagentes): los nuevos módulos usan otro directorio (`core/src/sources/`) | ídem | verificado |
| SSE: `ServerFrame` (`hello`, `snapshot` por sesión, …, `catalog_changed` por workspace, `tasks_changed`); `SseHub.broadcast(frame)` | `sdk/src/index.ts`, `server/src/sse/hub.ts` | verificado |
| `run-scheduler.busyWorkspace(workspaceId)` indica trabajo en curso en un workspace | `server/src/host/run-scheduler.ts` | verificado |
| Origin obligatorio en peticiones con efectos; servidor solo en loopback salvo `--allow-remote` | `server/src/auth/guard.ts`, `cli/src/serve.ts` | verificado |
| Web: carga perezosa con `import()` en `app.tsx` (Settings, Agents, Memory…); presupuesto inicial **90 KB gzip JS / 20 KB CSS** (`scripts/web-size.ts`) | `packages/web/src/app.tsx`, `scripts/web-size.ts` | verificado; tamaño actual (~80 KB) no verificado |
| Etiquetas de ajustes: **`SETTING_LABELS` en `packages/web/src/components/settings/labels.ts`**; `tests/web-i18n.test.ts` exige etiqueta EN y ES por cada clave de `settableSettings()` y prohíbe etiquetas huérfanas. Corrige el análisis previo, que hablaba de claves `setting.*` | ídem | verificado |
| Claves ajustables: `SETTABLE_KEYS` en `core/src/config.ts` | ídem | verificado |
| Capturas de la web en `docs/assets/web-ui/*.webp` | `docs/assets/web-ui/` | verificado |
| Versión actual de todos los paquetes: 0.1.1 | `packages/*/package.json` | verificado |

---

## 4. Decisiones de arquitectura (ADR-lite)

### 4.1 ADR-1: espejo local frente a alternativas

| Opción | Veredicto | Motivo |
|---|---|---|
| **A. Espejo local + motor propio** | **Elegida (D1)** | Las herramientas (`rg`, `sha256`, procesos, Python, AGENTS.md) asumen disco real; con el espejo funcionan sin cambios. Control total de aprobaciones, papelera, auditoría. Paquete npm puro. |
| B. FS virtual en core | Descartada | Rompe `rg`, `run_process`, `shell`, `execute`, `bg_run`, `python_run`, `data_*`, `git_*`; más de 15 herramientas a reescribir sin valor para el usuario. |
| C. Solo MCP | Alternativa avanzada documentada | Sin semántica de workspace (ni AGENTS.md ni skills), onboarding imposible para no técnicos (proyecto de Google Cloud y Developer Preview para el MCP oficial). Ya es posible hoy con `McpConnector`. |
| D. rclone como motor | Descartada | Binario externo (~32 MB por plataforma), `rclone config`, y **el client id compartido de rclone se retira en 2026**: cada usuario necesitaría su propio cliente. Se usa como referencia de diseño (capacidades opcionales). |
| E. Drive para escritorio | Descartada | No existe en Linux; los nativos son punteros `.gdoc` que no se pueden copiar ni leer; sin control de envíos. |

### 4.2 Dónde vive cada pieza

| Capa | Contenido |
|---|---|
| `@alisio/sdk` | Tipos (§5.1), `api.sources?.register()`, `SourceCapability`, nuevas variantes de unión aditivas, subruta `@alisio/sdk/testing/sources` (proveedor en memoria + casos de conformidad, sin dependencias). |
| `@alisio/core` | `SourceRegistry`, `ConnectionRepository`, `MirrorStateRepository`, `SyncJournal`, `TokenVault` y estrategias, `OAuthBroker`, `SyncEngine`/`SyncCycle`, `PathMapper`, `ConflictResolver`, `CodecRegistry`, decoradores de `fetch`/proveedor, `SourceService` (fachada), herramientas `source_status` y `source_push_request`, migración v9, opción `AppOptions.exactWorkspaceRoot`, opción `ProjectContext.projectInstructions`. |
| `@alisio/server` | Rutas `/api/sources/*`, escucha loopback efímera de OAuth (servidor `node:http` aparte), tramas `source_status`/`source_changes`, apertura de workspace por ruta exacta, códigos de error. |
| `@alisio/web` | Asistente (import dinámico), página Ajustes → Cloud folders, insignia en Sidebar, panel de revisión de envíos, store `sources.ts`. |
| CLI/TUI | `/source`, `alisio source connect|status|sync|disconnect`, entrada en `BUILTIN_PLUGINS`. |
| `@alisio/plugin-google-drive` | Adaptador REST con `fetch`, capa anticorrupción, codecs, descriptor OAuth con el client id de Alisio u opciones BYO. Solo depende de `@alisio/sdk`. |

### 4.3 ADR-2: confianza del plugin y aislamiento del token

- El plugin **nunca ve el refresh token ni el vault**. Recibe `SourceProviderContext.fetch`, un `fetch` **ya autenticado y decorado** (token de acceso de vida corta, reintentos, límite de ritmo, auditoría, redacción) que **solo** acepta URLs bajo los `apiOrigins` declarados en el registro; cualquier otro origen lanza `SourceError("origin_not_allowed")`.
- `ctx.auth.accessToken()` existe para APIs que lo exijan en cabecera propia, con la misma vida corta.
- Esto evita fugas accidentales (logs, errores); **no es un sandbox**: el código del plugin corre con los privilegios del proceso. Los proveedores de terceros se instalan con la confianza explícita existente (`alisio install`, `--trust-plugin`).
- ADR-01 se mantiene: el plugin no abre rutas, no accede a SQLite de core ni a aprobaciones.

### 4.4 ADR-3: patrones y su motivo

| Patrón | Dónde | Motivo |
|---|---|---|
| Puertos y adaptadores | `SourceProvider` | Core no conoce Google. |
| Registro + fábrica abstracta | `SourceRegistry`, `registration.create(ctx)` | Proveedores enchufables, sin `switch`. |
| Estrategia | `AuthDescriptor`, `TokenVault`, `ConflictResolver`, `DocumentCodec`, `ChangeDetector` (cursor vs. reescaneo) | Variar por proveedor o plataforma. |
| Decorador | `retrying`, `rateLimited`, `audited`, `redacted`, `originGuarded` sobre `fetch` | Preocupaciones transversales fuera de los adaptadores. |
| Método plantilla | `SyncCycle.run()` | Un único ciclo correcto para todos. |
| Repositorio | `ConnectionRepository`, `MirrorStateRepository`, `SyncJournal` | Igual que `CapabilityGrants`. |
| Capa anticorrupción | `plugin-google-drive/src/acl.ts` | Ningún tipo de Google cruza al SDK. |
| Negociación de capacidades | `SourceCapabilities` | UI y motor se degradan (sin papelera → no se ofrece borrar). |
| Unidad de trabajo | `PushBatch` | Lote aprobado de una vez, aplicado con diario reanudable. |
| Registro de comandos | `sync_journal` | Auditoría y deshacer. |
| Observador | `SourceService.on("status"|"changes")` → SSE/TUI | Interfaces en vivo. |

---

## 5. Contratos

### 5.1 SDK (`packages/sdk/src/index.ts`, aditivo)

```ts
// ---- Workspace sources (remote folders mirrored locally). Additive; feature-detect api.sources. ----
export type SourceAccess = "read" | "propose";              // D4: read-only or read-and-propose
export type SourceCapability = "source.push" | "source.trash";
// AnalysisCapability is unchanged; places that accept a capability widen to:
export type ToolCapability = AnalysisCapability | SourceCapability;

export type AuthDescriptor =
  | {
      kind: "oauth2-pkce-loopback";
      authorizeUrl: string;
      tokenUrl: string;
      revokeUrl?: string;
      clientId: string;
      /** Installed-app secret: NOT confidential (Google native-app docs). Optional. */
      clientSecret?: string;
      scopes: Record<SourceAccess, string[]>;
      extraParams?: Record<string, string>;          // e.g. { trigger_onepick: "true", prompt: "consent", access_type: "offline" }
      /** Redirect query parameter that carries the user's selection (Google: picked_file_ids). */
      selectionParam?: string;
    }
  | { kind: "oauth2-device"; deviceUrl: string; tokenUrl: string; clientId: string; scopes: Record<SourceAccess, string[]> }
  | { kind: "credentials"; fields: ProviderConfigurationField[] }   // WebDAV basic, S3 keys, API keys
  | { kind: "service-account"; fields: ProviderConfigurationField[] };

export interface SourceCapabilities {
  write: boolean;
  trash: boolean;
  move: boolean;
  createNative: boolean;                                 // can convert Markdown into a native document
  changeFeed: "cursor" | "none";
  conditionalWrite: "etag" | "revision" | "preflight" | "none";
  contentHash?: "md5" | "sha256" | "dropbox" | "quickxor";
  nativeDocuments: boolean;
  sharedDrives: boolean;
  duplicateNames: boolean;
  caseSensitive: boolean;
  /** A picked folder grants its descendants (Google drive.file: settled by Phase 0). */
  folderGrantIsRecursive: boolean;
  maxUploadBytes?: number;
  maxExportBytes?: number;                               // Google: 10 MB
}

export interface RemoteVersion {
  etag?: string;
  revision?: string;
  hash?: string;
  /** Monotonic provider counter when it exists (Google `version`). */
  counter?: string;
  modifiedAt: number;
}
export type RemoteKind = "folder" | "file" | "native" | "shortcut";
export interface RemoteNode {
  id: string;
  parentIds: string[];
  name: string;                                          // provider name, unmapped
  kind: RemoteKind;
  mime: string;
  size?: number;
  version: RemoteVersion;
  /** Provider-neutral native type: "document" | "spreadsheet" | "presentation" | "drawing" | other. */
  native?: { type: string; exportable: string[] };
  can: { edit: boolean; trash: boolean; addChildren: boolean };
  driveId?: string;                                      // shared drive id when relevant
}
export type RemoteChange =
  | { type: "upsert"; node: RemoteNode }
  | { type: "removed"; id: string; trashed: boolean };

export interface SourceWrite {
  parentId: string;
  name: string;
  /** Replace this node's content (binary files only; never a native document, D5). */
  replace?: RemoteNode;
  /** Create a native document from the body (createNative capability). */
  convertTo?: string;
  ifMatch?: RemoteVersion;
  body: ReadableStream<Uint8Array>;
  size: number;
  mime: string;
}

export interface SourceProvider {
  readonly capabilities: SourceCapabilities;
  account(signal: AbortSignal): Promise<{ label: string }>;          // e-mail or user name for the UI
  stat(id: string, signal: AbortSignal): Promise<RemoteNode | undefined>;
  list(folderId: string, signal: AbortSignal): AsyncIterable<RemoteNode>;
  read(node: RemoteNode, as: string | undefined, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
  write?(op: SourceWrite, signal: AbortSignal): Promise<RemoteNode>;
  trash?(node: RemoteNode, signal: AbortSignal): Promise<void>;
  move?(node: RemoteNode, parentId: string, name: string, signal: AbortSignal): Promise<RemoteNode>;
  startCursor?(signal: AbortSignal): Promise<string>;
  changes?(cursor: string, signal: AbortSignal): Promise<{ changes: RemoteChange[]; cursor: string }>;
  dispose?(): void | Promise<void>;
}

export interface DocumentCodec {
  nativeType: string;                                     // "document"
  /** Local file suffix appended to the mapped name: ".md", ".xlsx", ".slides.txt", ".png". */
  localSuffix: string;
  exportAs: string;                                       // mime passed to read()
  /** Mime used by write(convertTo) to CREATE a new native document; absent = read-only. */
  createFrom?: { localSuffix: string; mime: string; convertTo: string };
  /** Plain-language notes shown before a lossy operation (EN keys; host translates). */
  lossy?: string[];
}

export class SourceError extends Error {
  constructor(
    readonly code:
      | "auth_expired" | "auth_revoked" | "forbidden" | "not_found" | "conflict"
      | "too_large" | "rate_limited" | "quota" | "offline" | "origin_not_allowed" | "unsupported",
    message: string,
    readonly retryAfterMs?: number,
  ) { super(message); this.name = "SourceError"; }
}

export interface SourceProviderContext {
  /** Authenticated, decorated fetch limited to `apiOrigins`. The refresh token never reaches the plugin. */
  fetch: typeof fetch;
  auth: { accessToken(signal: AbortSignal): Promise<string> };
  connection: { id: string; rootId: string; access: SourceAccess; options: Readonly<Record<string, unknown>> };
}

export interface SourceProviderRegistration {
  id: string;                                             // "google-drive"
  name: string;                                           // "Google Drive"
  description?: string;
  apiOrigins: string[];                                   // e.g. ["https://www.googleapis.com"]
  auth: AuthDescriptor[];                                 // first usable one is the default
  codecs?: DocumentCodec[];
  /** Plain-language strings the host renders in the wizard (EN and ES). */
  help?: Record<"en" | "es", { connect: string; choose: string; permissions: string }>;
  create(ctx: SourceProviderContext): SourceProvider | Promise<SourceProvider>;
}
// PluginAPI (additive, optional): sources?: { register(provider: SourceProviderRegistration): () => void };

/** D6 extension point. Absent/false = unknown. Never filled in by Alisio on a provider's behalf. */
export interface ProviderRegistration { /* existing fields… */ declaresNoTrainingOnUserData?: boolean }

// Web protocol additions
export type SourceStatus = "connecting" | "syncing" | "idle" | "attention" | "needs-auth" | "offline" | "disconnected";
export interface SourceInfo {
  id: string; provider: string; providerName: string; label: string; accountLabel?: string;
  access: SourceAccess; status: SourceStatus; lastSyncAt?: number;
  counts: { files: number; pendingPush: number; conflicts: number; tooLarge: number; excluded: number };
  instructions: "none" | "pending-confirmation" | "confirmed" | "declined";
  vault: "os-keychain" | "file";
  error?: { code: string; message: string };
}
// WorkspaceInfo gains: source?: SourceInfo   (optional; absent for local workspaces)
// ServerFrame gains:
//   | { t: "source_status"; source: SourceInfo; workspaceId: string }
//   | { t: "source_changes"; sourceId: string; workspaceId: string; pull: number; pendingPush: number; conflicts: string[] }
// RunEvent approval_requested/approval_resolved: `capability?: ToolCapability`; new optional `push?: PushPreview`.
export interface PushPreview { creates: number; updates: number; trashes: number; moves: number; paths: string[] /* ≤ 50 */ }
```

`@alisio/sdk/testing/sources` (nuevo, sin dependencias): `createInMemorySourceProvider(opts)` y `sourceConformanceCases(): Array<{ name: string; requires?: Partial<SourceCapabilities>; run(p: SourceProvider, fx: Fixture): Promise<void> }>` (independiente de vitest).

### 5.2 Puertos internos de core (`packages/core/src/sources/`, nuevo)

```ts
export interface TokenSet { accessToken: string; refreshToken?: string; expiresAt: number; scope: string; tokenType: "Bearer" }
export interface TokenVault {
  readonly kind: "os-keychain" | "file";
  get(ref: string): Promise<TokenSet | undefined>;
  set(ref: string, tokens: TokenSet): Promise<void>;
  delete(ref: string): Promise<void>;
}
export interface PathMapper {
  /** Deterministic local relative path for a node among its siblings (dedupe, sanitize, codec suffix). */
  toLocal(node: RemoteNode, siblings: readonly RemoteNode[], codec?: DocumentCodec): string;
  /** Remote name for a NEW local file (inverse sanitize; never returns reserved names). */
  toRemoteName(localName: string): string;
}
export type ConflictKind = "both-modified" | "modified-vs-removed" | "removed-vs-modified" | "name-collision";
export interface Conflict { connection: string; relPath: string; remoteId?: string; kind: ConflictKind }
export interface ConflictResolver { resolve(c: Conflict): "keep-remote-and-copy-local" | "keep-local" | "ask" }
export interface ConnectionRepository {
  create(input: NewConnection): SourceConnectionRow;
  get(id: string): SourceConnectionRow | undefined;
  byMirrorPath(path: string): SourceConnectionRow | undefined;
  list(): SourceConnectionRow[];
  update(id: string, patch: Partial<SourceConnectionRow>): void;
  remove(id: string): void;                         // rows of nodes and journal kept for audit, connection marked disconnected
}
export abstract class SyncCycle {
  /** Template Method: lock → scan → plan → apply → journal → unlock. Never applies while a run is active. */
  async run(trigger: "open" | "manual" | "poll" | "push"): Promise<CycleReport> { /* fixed order */ }
  protected abstract scan(): Promise<ScanResult>;
  protected abstract plan(scan: ScanResult): SyncPlan;
  protected abstract apply(plan: SyncPlan): Promise<void>;
}
export interface RunGate { busy(workspacePath: string): boolean; onIdle(workspacePath: string, cb: () => void): () => void }
```

`RunGate` lo implementa el host (servidor: `scheduler.busyWorkspace`; TUI: el runner de su `Application`).

---

## 6. Modelo de datos y disco

### 6.1 Migración v9 (`SQLiteStore.migrate()`, aditiva)

```sql
CREATE TABLE IF NOT EXISTS source_connections(
  id TEXT PRIMARY KEY,                               -- src_<ULID>
  provider TEXT NOT NULL,                            -- registration id
  label TEXT NOT NULL,
  account_label TEXT,                                -- never a token
  root_id TEXT NOT NULL,
  root_name TEXT,
  granted_ids TEXT NOT NULL DEFAULT '[]',            -- JSON ids returned by the picker (drive.file)
  access TEXT NOT NULL CHECK(access IN ('read','propose')),
  mirror_path TEXT NOT NULL UNIQUE,                  -- = workspaces.path
  vault_ref TEXT NOT NULL,
  vault_kind TEXT NOT NULL CHECK(vault_kind IN ('os-keychain','file')),
  client TEXT NOT NULL CHECK(client IN ('alisio','custom')),
  cursor TEXT,
  status TEXT NOT NULL CHECK(status IN
    ('connecting','syncing','idle','attention','needs-auth','offline','disconnected')),
  error_code TEXT, error_message TEXT,
  instructions TEXT NOT NULL DEFAULT 'none' CHECK(instructions IN
    ('none','pending-confirmation','confirmed','declined')),
  egress_confirmed_at INTEGER,                       -- D6 confirmation
  options TEXT,                                      -- JSON, non-secret
  owner_pid INTEGER,                                 -- process running the current cycle
  created_at INTEGER NOT NULL, last_sync_at INTEGER, disconnected_at INTEGER);
CREATE TABLE IF NOT EXISTS source_nodes(
  connection TEXT NOT NULL REFERENCES source_connections(id),
  remote_id TEXT NOT NULL,
  parent_id TEXT,
  remote_name TEXT NOT NULL,
  rel_path TEXT NOT NULL,                            -- POSIX separators, relative to the mirror
  kind TEXT NOT NULL CHECK(kind IN ('folder','file','native','shortcut')),
  native_type TEXT, codec TEXT,
  remote_version TEXT NOT NULL,                      -- JSON RemoteVersion at last sync
  base_sha256 TEXT,                                  -- bytes of the local file at last sync
  size INTEGER,
  state TEXT NOT NULL CHECK(state IN ('synced','local-modified','remote-modified','conflict',
    'local-new','local-deleted','pending-push','excluded','too-large','skipped')),
  reason TEXT,                                       -- excluded/skipped/too-large reason key
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(connection, remote_id),
  UNIQUE(connection, rel_path));
CREATE INDEX IF NOT EXISTS source_nodes_parent ON source_nodes(connection, parent_id);
CREATE INDEX IF NOT EXISTS source_nodes_state ON source_nodes(connection, state);
CREATE TABLE IF NOT EXISTS source_local_new(              -- local files not yet on the remote
  connection TEXT NOT NULL REFERENCES source_connections(id),
  rel_path TEXT NOT NULL, sha256 TEXT NOT NULL, size INTEGER NOT NULL,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY(connection, rel_path));
CREATE TABLE IF NOT EXISTS sync_journal(
  id TEXT PRIMARY KEY,                               -- sj_<ULID>
  connection TEXT NOT NULL,
  batch_id TEXT,                                     -- push batch (unit of work)
  op TEXT NOT NULL CHECK(op IN ('pull','push-create','push-update','push-create-native',
    'trash','move','conflict-copy','local-trash')),
  rel_path TEXT, remote_id TEXT,
  before TEXT, after TEXT,                           -- JSON {version, sha256, name, parent}
  status TEXT NOT NULL CHECK(status IN ('planned','applied','failed','undone','abandoned')),
  approved_by TEXT CHECK(approved_by IN ('web','tui','headless')),
  session TEXT, run_id TEXT, owner_pid INTEGER,
  error TEXT, created_at INTEGER NOT NULL, applied_at INTEGER);
CREATE INDEX IF NOT EXISTS sync_journal_conn ON sync_journal(connection, created_at);
CREATE INDEX IF NOT EXISTS sync_journal_open ON sync_journal(status, owner_pid);
INSERT OR IGNORE INTO schema_migrations VALUES(9);
```

- `workspaces` **no cambia**: el workspace de un origen es la fila con `path = mirror_path` (creada con `recordWorkspace(mirrorPath, { label })`). `WorkspaceHost.info()` añade `source` uniendo por `mirror_path`.
- Los workspaces locales no tienen fila en `source_connections` y se comportan exactamente igual que hoy.
- `capability_grants` se reutiliza sin migración (sin CHECK en `capability`).

### 6.2 Disco

| Ruta | Contenido | Permisos |
|---|---|---|
| `<stateHome>/sources/<connId>/mirror/` | El workspace (cwd real) | 0700 dir |
| `<stateHome>/sources/<connId>/base/<sha256>` | Bytes de la última sincronización (base de la comparación a tres bandas), deduplicados por hash | 0600 |
| `<stateHome>/sources/<connId>/trash/<ISO>/<relPath>` | Copias locales de lo borrado o reemplazado en remoto, retenidas `sources.trashRetentionDays` | 0600 |
| `<stateHome>/sources/<connId>/staging/` | Descargas en curso (atómicas: `rename` al final) | 0700 |
| Llavero del SO, servicio `alisio-sources`, cuenta `<connId>` | `TokenSet` serializado | SO |
| `<configHome>/source-credentials.json` (fallback) | `{ version:1, entries: { <vaultRef>: TokenSet } }` | 0600, escritura atómica (`atomicJson` de `providers/settings.ts`) |

### 6.3 Regla de raíz exacta (obligatoria)

Un workspace respaldado por un origen se registra y abre con su **ruta exacta** (`mirror_path`) y **no sube buscando `.git`**:

- `AppOptions.exactWorkspaceRoot?: boolean` (nuevo): si es `true`, `createApplication` usa `workspace = realpath(cwd)` en vez de `findWorkspace(cwd)`.
- `WorkspaceHost.openSource(mirrorPath)` (nuevo) llama a `openPath` con `exactWorkspaceRoot: true`; nunca pasa por `canonical()`.
- El CLI, con `--cwd` dentro de un espejo conocido (`ConnectionRepository.byMirrorPath`), aplica lo mismo.
- Prueba: con `$HOME` como repo git y `ALISIO_STATE_HOME` bajo él, el workspace sigue siendo el espejo.

---

## 7. Semántica de sincronización

### 7.1 Ciclo (`SyncCycle.run`)

1. **lock**: adquiere `owner_pid = process.pid` en `source_connections` con `UPDATE … WHERE owner_pid IS NULL OR <owner muerto>` (`isProcessAlive`). Si otro proceso vivo lo tiene, devuelve `busy`.
2. **scan remoto**: con `changeFeed: "cursor"` y `cursor` → `changes(cursor)` hasta agotar; si no hay cursor, el cursor caducó (`not_found`) o `changeFeed: "none"` → **reescaneo completo** (recorrido BFS desde `root_id` y los `granted_ids`; concurrencia `sources.concurrency`). Un cambio está en alcance si su id está en `source_nodes`, en `granted_ids`, o alguno de sus `parentIds` es una carpeta conocida.
3. **scan local**: recorre el espejo (sin seguir enlaces; un enlace simbólico encontrado → `skipped`), calcula sha256 solo si `mtime`/tamaño cambiaron desde la última vez.
4. **plan**: tabla §7.2 por nodo; produce `pull`, `conflict`, `local-new`, `pending-push` (nunca envía en `poll`/`open`/`manual`).
5. **apply**: si `RunGate.busy(mirror)` → no aplica nada local, guarda el plan como pendiente y se registra `onIdle` para reintentar. Si no: descarga a `staging/`, verifica, `rename` atómico; mueve lo sustituido a `trash/`; actualiza `source_nodes` y `base/`.
6. **journal**: una fila `applied` por operación; emite `source_changes` y `source_status`.
7. **unlock**: `owner_pid = NULL`, `last_sync_at`.

Disparadores: al abrir el workspace; botón «Sync now» / `/source sync` / `alisio source sync`; sondeo cada `sources.pollMinutes` (0 = desactivado; temporizador sin referencia, solo mientras la app corre); tras un lote de envío.

### 7.2 Comparación a tres bandas

B = base (versión remota y sha256 locales al sincronizar), L = estado local, R = remoto actual.

| L respecto a B | R respecto a B | Acción |
|---|---|---|
| igual | igual | nada (`synced`) |
| igual | modificado | **pull** (sustituye local; el anterior a `trash/`) |
| igual | borrado/en papelera | mover local a `trash/`, borrar nodo (`pull`) |
| modificado | igual | `local-modified` → candidato a envío (solo `propose`) |
| modificado | modificado | **conflicto**: conserva remoto en la ruta, local como copia (§7.4) |
| modificado | borrado | **conflicto** `modified-vs-removed`: local queda como `local-new` con aviso |
| borrado | igual | `local-deleted` → candidato a papelera (solo `propose`, siempre pregunta) |
| borrado | modificado | **conflicto** `removed-vs-modified`: se restaura el remoto (pull) y se avisa |
| nuevo local (sin B) | — | `local-new` → candidato a creación |
| nuevo local | nuevo remoto en la misma ruta | `name-collision`: remoto conserva el nombre; local se renombra como copia |

Nodos nativos: L «modificado» de un nativo **nunca** se envía como actualización (D5); se ofrece «Save as a new Google Doc» (crea un nativo nuevo con `createFrom`) o descartar.

### 7.3 Máquina de estados de un nodo

```
            pull ok                 local edit                approve+push ok
 (new) ──▶ synced ◀──────────────────────────┐  ──▶ local-modified ──▶ pending-push ──▶ synced
   │         │ remote change                 │             │ remote change      │ preflight mismatch
   │         ▼                               │             ▼                    ▼
   │   remote-modified ──pull──▶ synced      └──────── conflict ◀───────────────┘
   │                                                       │ user resolves (keep remote / keep mine / both)
   ├──▶ too-large (size > maxFileMB or export > 10 MB) ────┤ (re-evaluated each cycle)
   ├──▶ excluded (.alisio/, .agents/agents/, provider-forbidden) — never materialized
   └──▶ skipped (shortcut, symlink, unexportable native e.g. Vids/Forms)
 local-new ──approve+push──▶ synced            local-deleted ──approve trash──▶ (row removed)
```

### 7.4 Conflictos

- Nombre de la copia: `<base> (conflict <YYYY-MM-DD HHmm> local)<ext>` en EN; la UI lo explica en ES. Si existe, añade ` 2`, ` 3`.
- La copia es `local-new` (puede enviarse como archivo nuevo tras aprobación).
- `ConflictResolver` por defecto: `keep-remote-and-copy-local` (nunca se pierde nada). La UI ofrece: «Keep the Drive version», «Keep my version» (marca `local-modified` para enviar), «Keep both».

### 7.5 Envío por lotes (Fase 3, unidad de trabajo)

1. `SourceService.preparePush(connId)` construye un `PushBatch` (`batch_id`) con todas las filas `local-modified`, `local-new`, `local-deleted` y renombres detectados (mismo sha256 en otra ruta → `move`).
2. La UI muestra el diff (texto: diff unificado; binario: tamaño y hash; nativo: «will be created as a new Google Doc»).
3. El usuario aprueba (o la aprobación `once` de §9.4). Se escriben filas `planned` con `approved_by`.
4. Para cada operación: **preflight** `stat(remoteId)`; si `version` ≠ base → `conflict` y la operación queda `abandoned`; si no → `write`/`trash`/`move`; `applied` + actualizar base. Las papeleras requieren además su propia aprobación explícita (`source.trash`), aunque vengan en el mismo lote.
5. Un fallo deja el resto del lote intacto; el lote se puede reintentar (operaciones `applied` no se repiten).

### 7.6 Papelera en lugar de borrado

Remoto: `trash` (nunca `delete`). Local: todo lo sustituido o eliminado va a `trash/`. «Undo» en la UI: restaurar desde `trash/` local, o enlace «Open Drive trash».

### 7.7 Renombrar y mover

Por `remote_id`, no por ruta: un cambio remoto de nombre o padre mueve el archivo local (`rename`) y actualiza `rel_path`. Uno local (mismo sha256 desaparecido en una ruta y aparecido en otra en el mismo escaneo) se propone como `move`.

### 7.8 Mapeo de rutas (`PathMapper`)

| Caso | Regla |
|---|---|
| Caracteres no válidos (`/ \ : * ? " < > |`, controles 0–31) | Sustituir por `_`; el nombre real queda en `remote_name`. |
| Nombres reservados de Windows (`CON PRN AUX NUL COM1–9 LPT1–9`, con o sin extensión) | Sufijo `_`. |
| Punto o espacio final | Eliminar (Windows). |
| Longitud | Segmento ≤ 200 bytes UTF-8; ruta relativa ≤ 1.000 (se recorta y se añade `~<6 hex del id>`). |
| Duplicados en una carpeta | Orden estable por `createdTime`, luego `id`: el primero conserva el nombre, los demás ` (2)`, ` (3)`. |
| Colisión por mayúsculas (FS insensible) | Igual que duplicados. |
| Sufijo de codec | `Report` (Doc) → `Report.md`; si ya existe `Report.md` binario, el nativo pasa a `Report (Google Doc).md`. |
| Unicode | NFC en disco; comparación NFC. |
| Determinismo | Misma entrada → misma salida (propiedad probada). |

### 7.9 Límites, unidades compartidas, cuotas, sin conexión, recuperación

- Tamaño: `> sources.maxFileMB` → `too-large`. Exportación de nativo > 10 MB (`files.export`) → `too-large` con explicación.
- Unidades compartidas: `supportsAllDrives=true`, `includeItemsFromAllDrives=true` en todas las llamadas; `driveId` en el nodo (Fase 4).
- Cuotas: decorador `retrying` (§8.7); concurrencia por conexión `sources.concurrency`.
- Sin conexión: `SourceError("offline")` → estado `offline`; el espejo sigue siendo usable; los envíos quedan `pending-push`.
- Recuperación: al arrancar, filas `planned` con `owner_pid` muerto → se re-verifica el remoto (`stat`): si el efecto ya está aplicado (versión/hash coinciden) → `applied`; si no → `abandoned` y el nodo vuelve a su estado previo. Descargas a medias en `staging/` se borran.
- **Nunca se aplican cambios remotos mientras hay una ejecución activa en ese workspace** (`RunGate`); se encolan y se aplican al quedar libre.

---

## 8. Especificidades de Google Drive

### 8.1 Permisos

| Etapa | Scopes | Requisitos |
|---|---|---|
| Lanzamiento (D2) | `https://www.googleapis.com/auth/drive.file` | No sensible: verificación de marca. OnePick **solo admite `drive.file` y no se combina con otros** (verificado). |
| Tras aprobación de Google | `https://www.googleapis.com/auth/drive` (restringido) | Verificación restringida (~6 semanas) y revisión anual; CASA salvo excepción de cliente local (no verificado si aplica). Se activa con la opción `builtinPlugins.google-drive.scope: "drive"` cuando el propietario confirme la aprobación. Con `drive`, OnePick no se usa: la carpeta se elige con un explorador propio servido por la web/TUI. |
| BYO (D3) | `drive.file` o `drive` según el cliente del usuario | Sin verificación de Alisio. |

Para `read` y `propose` el scope es el mismo (`drive.file` ya permite escribir): la diferencia de acceso la impone Alisio, no Google.

### 8.2 Endpoints OAuth

| Uso | URL |
|---|---|
| Autorización | `https://accounts.google.com/o/oauth2/v2/auth` |
| Token / refresco | `https://oauth2.googleapis.com/token` |
| Revocación | `https://oauth2.googleapis.com/revoke` (POST `token=`) |
| Cuenta (etiqueta) | `GET https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)` (que funcione con `drive.file`: **Fase 0**) |

### 8.3 Flujo OnePick (PKCE con loopback)

Parámetros de autorización: `client_id`, `redirect_uri=http://127.0.0.1:<port>`, `response_type=code`, `scope=…/drive.file`, `code_challenge`, `code_challenge_method=S256`, `state`, `access_type=offline`, `prompt=consent`, `trigger_onepick=true`, `allow_multiple=true`, `allow_folder_selection=true`. Respuesta: `?code=…&scope=…&state=…&picked_file_ids=id1,id2` (o `error=`).

Implementación (`core/src/sources/oauth.ts`, nuevo; solo `node:http`, `node:crypto`):

1. `verifier` = 64 caracteres base64url de `randomBytes(48)`; `challenge` = base64url(sha256(verifier)); `state` = base64url(`randomBytes(32)`).
2. `http.createServer` en `127.0.0.1`, puerto `0` (efímero, lo elige el SO); `redirect_uri` con ese puerto. Es un servidor **aparte** del de la web: no toca `AuthGuard`.
3. Acepta solo `GET /` con el `state` exacto (comparación en tiempo constante); un único uso; responde una página HTML mínima localizada («You can close this tab and return to Alisio») sin reflejar parámetros.
4. Expira a los **10 minutos** o al cancelar; cierra el servidor en todos los caminos.
5. Canjea `code` en `tokenUrl` (`grant_type=authorization_code`, `code_verifier`, `client_id`, `client_secret` si existe).
6. Guarda el `TokenSet` en el vault; `granted_ids` = `picked_file_ids`; si la selección es una sola carpeta → `root_id` = esa carpeta; si son varios elementos → `root_id` = carpeta virtual de la conexión (el espejo los coloca en su raíz).
7. **Plan B «pegar la URL»** (siempre visible tras 30 s, obligatorio con `--allow-remote` o TUI por SSH): el usuario pega la URL completa en la que terminó el navegador (`http://127.0.0.1:<port>/?state=…&code=…`); se valida `state` contra el flujo pendiente y se canjea igual. Funciona porque solo importan los parámetros (Fase 0 lo confirma).
8. Refresco: si `expiresAt − 60 s` ya pasó, `grant_type=refresh_token`; `invalid_grant` → estado `needs-auth` (no se reintenta). Un solo refresco simultáneo por conexión (promesa compartida).
9. Revocación al desconectar: POST a `revokeUrl`; luego borrar del vault (aunque la revocación falle, con aviso).

### 8.4 Llamadas Drive v3 y máscaras de campos

Base `https://www.googleapis.com/drive/v3`, subidas `https://www.googleapis.com/upload/drive/v3`. Todas con `supportsAllDrives=true`.

`FIELDS = id,name,mimeType,parents,size,md5Checksum,sha256Checksum,headRevisionId,version,modifiedTime,createdTime,trashed,driveId,shortcutDetails(targetId,targetMimeType),capabilities(canEdit,canTrash,canAddChildren),exportLinks`

| Operación | Llamada |
|---|---|
| stat | `GET /files/{id}?fields=${FIELDS}` |
| list | `GET /files?q='{folderId}' in parents and trashed=false&fields=nextPageToken,files(${FIELDS})&pageSize=1000&includeItemsFromAllDrives=true` |
| leer binario | `GET /files/{id}?alt=media` (stream) |
| exportar nativo | `GET /files/{id}/export?mimeType=…` (**límite 10 MB**, verificado) |
| crear (binario o nativo desde Markdown) | `POST /upload/drive/v3/files?uploadType=resumable` con metadatos `{name, parents:[parentId], mimeType?}` (para nativo: `mimeType: application/vnd.google-apps.document` y cuerpo `text/markdown`); luego `PUT` en trozos múltiplos de 256 KiB; ≤ 5 MB puede usar `uploadType=multipart` |
| actualizar binario | `PATCH /upload/drive/v3/files/{id}?uploadType=resumable` (nunca sobre nativos, D5) |
| papelera | `PATCH /files/{id}` con `{"trashed": true}` |
| mover/renombrar | `PATCH /files/{id}?addParents=…&removeParents=…` con `{"name": …}` |
| cursor | `GET /changes/startPageToken` |
| cambios | `GET /changes?pageToken=…&fields=nextPageToken,newStartPageToken,changes(fileId,removed,file(${FIELDS}))&includeItemsFromAllDrives=true&includeRemoved=true&pageSize=1000` |

### 8.5 Matriz de exportación y codecs

| Tipo Google (`mimeType`) | `native.type` | Archivo local | `exportAs` | Crear nuevo (`createFrom`) |
|---|---|---|---|---|
| `application/vnd.google-apps.document` | document | `<name>.md` | `text/markdown` | `.md` → `text/markdown` → document |
| `application/vnd.google-apps.spreadsheet` | spreadsheet | `<name>.xlsx` | xlsx (CSV solo trae la primera hoja: descartado) | no en v1 |
| `application/vnd.google-apps.presentation` | presentation | `<name>.slides.txt` | `text/plain` | no |
| `application/vnd.google-apps.drawing` | drawing | `<name>.png` | `image/png` | no |
| `…vid`, `…form`, `…site`, `…map`, otros | other | — (`skipped`) | — | — |
| `application/vnd.google-apps.shortcut` | — | — (`skipped`, v1) | — | — |
| `application/vnd.google-apps.folder` | — | directorio | — | sí (crear carpeta) |
| cualquier otro | — | tal cual | — | — |

### 8.6 Capa anticorrupción (`acl.ts`)

| Google | `RemoteNode` |
|---|---|
| `id`, `name`, `parents`, `mimeType`, `size` (string → number) | `id`, `name`, `parentIds`, `mime`, `size` |
| folder / shortcut / `vnd.google-apps.*` / otro | `kind`: folder / shortcut / native / file |
| `version`, `headRevisionId`, `md5Checksum` (o `sha256Checksum`), `modifiedTime` | `version.counter`, `version.revision`, `version.hash`, `version.modifiedAt` |
| `capabilities.canEdit/canTrash/canAddChildren` | `can.edit/trash/addChildren` |
| `driveId` | `driveId` |
| `exportLinks` keys | `native.exportable` |

`md5Checksum`/`headRevisionId` solo existen para archivos con contenido binario (no verificado hoy; alta confianza): para nativos manda `version.counter` + `modifiedAt`.

Capacidades que declara el adaptador: `write, trash, move, createNative: true`; `changeFeed: "cursor"`; `conditionalWrite: "preflight"` (A3); `contentHash: "md5"`; `nativeDocuments, sharedDrives, duplicateNames: true`; `caseSensitive: true`; `folderGrantIsRecursive`: **según Fase 0** (por defecto `false`); `maxExportBytes: 10_485_760`.

### 8.7 Reintentos y errores

| Respuesta | Acción |
|---|---|
| 429; 403 con `reason` `rateLimitExceeded`/`userRateLimitExceeded`; 500/502/503/504 | Espera `min(2^n · 1000 + rand(0..1000), 64000)` ms, máximo 6 intentos; respeta `Retry-After`. |
| 401 | Un refresco y un reintento; después `needs-auth`. |
| 403 `insufficientPermissions` / `appNotAuthorizedToFile` / `forbidden` | Sin reintento: `SourceError("forbidden")` → nodo `excluded` con motivo «not shared with Alisio». |
| 403 `storageQuotaExceeded` | `quota` → estado `attention`. |
| 404 | `not_found` → nodo eliminado remotamente. |
| 410 en `changes` (token inválido) | Reescaneo completo. |

Cuotas vigentes (verificado, desde 2026-05): 1.000.000 unidades/min por proyecto, 325.000/min por usuario; 750 GB/día de subida. El coste en unidades por llamada no está publicado (no verificado).

### 8.8 Documentación oficial verificada

Ver Apéndice B (fuentes 1–12).

### 8.9 Lista del propietario fuera del código (D3)

| # | Tarea | Notas |
|---|---|---|
| 1 | Proyecto de Google Cloud «Alisio»; **Drive API** habilitada (Docs API en Fase 4) | Cuenta de propietario con 2FA. |
| 2 | Cliente OAuth tipo **Desktop app** | El secreto de una app instalada no es confidencial (verificado); se distribuye en el plugin. |
| 3 | Pantalla de consentimiento / Branding: nombre «Alisio», logo, correo de soporte, página de inicio, política de privacidad, términos | Público «External». |
| 4 | **Dominio propio verificado** en Search Console (recomendado p. ej. `alisio.dev`) | Que `*.github.io` sirva para la verificación de marca **no está verificado**. |
| 5 | Política de privacidad con la frase literal: «The use of information received from Google Workspace APIs will adhere to the Google User Data Policy, including the Limited Use requirements.» y la sección de proveedores de modelo (D6) | Asesoría legal recomendada. |
| 6 | Data Access: solo `drive.file` en el lanzamiento | Sin alcances sensibles no hay pantalla de app no verificada. |
| 7 | Fase 0 en modo **Testing** | Hasta **100 usuarios de prueba**, autorizaciones que **caducan a los 7 días** (verificado). |
| 8 | Publicar «In production» con `drive.file` y pedir verificación de marca | ~2–3 días hábiles (verificado, FAQ de Google). |
| 9 | Solicitar en paralelo el scope `drive`: justificación, vídeo de demostración del flujo y del uso de datos, argumento de cliente local (los datos solo van al destino que configura el usuario) | ~6 semanas; revisión anual; CASA posible. |
| 10 | Vigilar el tope de 100 refresh tokens por cuenta y cliente | Reutilizar la conexión; no repetir consentimiento sin necesidad. |

### 8.10 Cliente propio (BYO) — instrucciones para la documentación

1. En Google Cloud Console: crear proyecto → habilitar Drive API → «Google Auth Platform» → Branding y Audience (External, añadirte como usuario de prueba, o «Internal» si es una organización de Workspace) → Clients → **Desktop app**.
2. En Alisio: Settings → Cloud folders → Advanced → «Use my own Google client» → pegar Client ID y Client secret. Se guardan como opciones `builtinPlugins.google-drive.{clientId,clientSecret,scope}`; el secreto, en el vault (no en `config.json`).
3. Aviso: en modo Testing las autorizaciones caducan a los 7 días; en Internal (Workspace) no.

---

## 9. Modelo de seguridad

### 9.1 Principios

- Mínimo privilegio: `drive.file`; acceso `read` por defecto.
- El contenido remoto es **dato no confiable**.
- Nada sale hacia Drive sin una aprobación humana; nada se borra de forma definitiva.
- Los tokens no aparecen en SSE, eventos, logs, errores ni en el contexto del modelo.

### 9.2 Vault (`core/src/sources/vault*.ts`)

| Estrategia | Plataforma | Comando (sin shell, con `runProcess` y `stdin` para el secreto) |
|---|---|---|
| `MacKeychainVault` | macOS | `security add-generic-password -U -s alisio-sources -a <ref> -w` (secreto por stdin; si la versión no lo acepta por stdin, **no verificado**, usar `-X` hex vía argumento como último recurso documentado); `find-generic-password -w`; `delete-generic-password` |
| `SecretToolVault` | Linux con `secret-tool` en PATH y un servicio Secret Service activo | `secret-tool store --label="Alisio cloud folder" service alisio-sources account <ref>` (secreto por stdin); `lookup`; `clear` |
| `DpapiFileVault` | Windows | PowerShell `[Security.Cryptography.ProtectedData]::Protect(…, CurrentUser)` sobre el JSON leído por stdin; el blob se guarda en `<configHome>/source-vault/<ref>.bin` (0600 equivalente vía ACL por defecto del perfil) |
| `FileVault` (fallback) | Todas | `<configHome>/source-credentials.json` 0600, atómico |

Selección: `sources.vault` = `auto` (prueba en orden, con un `set/get/delete` de sonda al conectar) | `keychain` | `file`. Con `file`, la UI muestra «Your sign-in is stored in a protected file on this computer (not in the system keychain)».

### 9.3 Redacción

Decorador `redacted`: elimina `Authorization`, `access_token`, `refresh_token`, `code`, `code_verifier`, `client_secret` de todo mensaje de error y del journal. `SourceInfo` nunca lleva secretos. Prueba de propiedad: ningún frame SSE ni evento serializado contiene un token sembrado.

### 9.4 Aprobaciones y capacidades

| Acción | Quién la inicia | Aprobación | Modos |
|---|---|---|---|
| Leer / sincronizar desde Drive | Sistema o usuario | Ninguna (lectura) | Todos (con `--read-only` también: solo baja) |
| Editar la copia local | Agente | Efecto `write` local existente | `auto`/`full` sin preguntar, `ask` pregunta |
| Enviar lote (crear/actualizar/mover) | **Usuario** (botón «Send to Drive») | El propio clic, tras ver el diff | Todos; desactivado con `--read-only` y en conexiones `read` |
| `source_push_request` (herramienta integrada, efecto `external`, `capability: "source.push"`) | Agente | Aprobación **`once`** con `PushPreview`; nunca `session`; **pregunta también en `full`** (como `analysis.install`) | Sin interfaz interactiva → denegada con mensaje accionable |
| Papelera remota | Usuario dentro del lote | Confirmación específica `source.trash` por lote (lista de archivos), **siempre**, incluso en `full` | — |

- `ToolCapability` amplía de forma aditiva `ToolDefinition.capability`, `ApprovalRequest.capability` y los eventos `approval_*`.
- Las decisiones se registran en `capability_grants` como filas de auditoría (`scope 'once'`; `source` `tui`/`web`). Un grant `session` de `source.*` se **rechaza** (como `analysis.install`).
- `source.push`/`source.trash` refinan `external`: un grant amplio de `external` **no** los cubre (excepción documentada al comentario actual de `ToolDefinition.capability`, igual que `analysis.install`).

### 9.5 Contenido no confiable e inyección

- Toda lectura de un archivo dentro de un espejo añade al resultado el prefijo `[cloud folder content: untrusted data]`.
- El texto de un documento no puede subir permisos (el PREAMBLE ya lo dice).
- La herramienta `source_push_request` exige aprobación humana, así que una instrucción inyectada no puede publicar nada sola.
- `.alisio/` y `.agents/agents/` nunca se materializan (`excluded`); sus archivos no se envían aunque el agente los cree localmente (filtro de envío).
- **AGENTS.md / skills**: si el escaneo encuentra `AGENTS.md`, `AGENTS.override.md`, `AGENT.md` o directorios de skills (`.agents/skills`, `.claude/skills`, `.alisio/skills` queda excluido por `.alisio/`), la conexión pasa a `instructions: "pending-confirmation"` y la `Application` se crea con `ProjectContext({ projectInstructions: false })` (opción nueva) y `trusted: false` para skills. Al confirmar → `confirmed`, se recrea la app con `projectInstructions: true` y skills de proyecto activas. Un cambio posterior en esos archivos vuelve a pedir confirmación (hash, como `trust.json`).
- `resolveTrust` nunca concede confianza a un espejo: `WorkspaceHost.openSource` fuerza `trustProject: false`.

### 9.6 Salida de datos (D6)

En el asistente, antes de conectar: «What Alisio reads from this folder is sent to your model provider (<provider name>) to answer you.» + casilla obligatoria «My model provider does not train on this data». Se guarda `egress_confirmed_at`. Si el proveedor de modelo cambia, se vuelve a pedir al abrir el workspace. Punto de extensión: `ProviderRegistration.declaresNoTrainingOnUserData` (nunca rellenado por Alisio en nombre de terceros); si Google exige lista de permitidos, `sources.requireNoTrainingProvider: true` bloquea la apertura con proveedores sin la declaración.

### 9.7 Auditoría y deshacer

`sync_journal` (qué, cuándo, quién aprobó), `capability_grants` (aprobaciones del agente), papelera de Drive y revisiones de Drive (enlace «Open in Drive»), `trash/` local.

### 9.8 Amenazas

| Amenaza | Mitigación | Riesgo residual |
|---|---|---|
| Inyección indirecta en un documento que intenta publicar o borrar | Envío solo con aprobación humana; papelera con confirmación específica | El usuario aprueba sin leer el diff |
| Plugins o config ejecutables desde una carpeta compartida | `.alisio/`, `.agents/agents/` nunca se materializan; sin confianza automática | Ninguno conocido |
| AGENTS.md malicioso en la carpeta | Confirmación específica antes de cargar | El usuario confirma a ciegas |
| Fuga del refresh token por un plugin | Vault en core; `fetch` decorado limitado a `apiOrigins` | El plugin no es un sandbox |
| Token en logs o UI | Decorador `redacted`, pruebas de propiedad | — |
| Robo del archivo 0600 de fallback | Preferencia por llavero; aviso visible | Un malware con el mismo usuario puede leerlo |
| Sobrescribir cambios de un colaborador | Preflight de versión + conflicto con copia | Carrera entre preflight y escritura (A3) |
| Pérdida de datos local al hacer pull | Lo sustituido va a `trash/` | Disco lleno |
| Exfiltración al proveedor de modelo | Aviso D6 y confirmación | Política del proveedor fuera de nuestro control |
| CSRF contra las rutas nuevas | Mismas reglas de Origin y cookie; el callback OAuth va en un servidor aparte con `state` | — |
| Callback OAuth suplantado | `state` de 256 bits, un uso, 10 min, PKCE S256 | — |

---

## 10. Servidor y protocolo

### 10.1 Rutas (todas tras `AuthGuard`; las que tienen efectos exigen Origin)

| Método y ruta | Cuerpo / respuesta |
|---|---|
| `GET /api/sources/providers` | `[{ id, name, description, help, capabilities, auth: [{kind}] , client: "alisio"\|"custom"\|"missing" }]` |
| `POST /api/sources/connect` | `{ provider, access, label? }` → `{ flowId, authorizeUrl, expiresAt, pasteHint }` (abre la escucha loopback) |
| `GET /api/sources/connect/:flowId` | `{ state: "waiting"\|"completed"\|"failed"\|"expired", sourceId?, error? }` |
| `POST /api/sources/connect/:flowId/complete` | `{ url }` (plan B pegar la URL) → como arriba |
| `DELETE /api/sources/connect/:flowId` | cancela el flujo |
| `POST /api/sources/:sid/confirm` | `{ egress: true }` (D6) y/o `{ instructions: "confirmed"\|"declined" }` |
| `GET /api/sources` | `SourceInfo[]` |
| `GET /api/sources/:sid` | `SourceInfo` + `workspaceId` |
| `POST /api/sources/:sid/open` | abre el workspace (`openSource`) → `WorkspaceInfo` |
| `POST /api/sources/:sid/sync` | dispara un ciclo → `{ started: boolean, reason? }` |
| `GET /api/sources/:sid/changes` | lote propuesto: `{ batchId, items: [{ op, relPath, kind, sizeBefore, sizeAfter, native? }] }` |
| `GET /api/sources/:sid/changes/diff?path=` | diff unificado (≤ 256 KB) o metadatos |
| `POST /api/sources/:sid/changes/:batchId/approve` | `{ include: string[], trash: { confirmed: boolean, paths: string[] } }` → progreso por SSE |
| `POST /api/sources/:sid/conflicts/resolve` | `{ relPath, choice: "remote"\|"mine"\|"both" }` |
| `POST /api/sources/:sid/disconnect` | `{ deleteLocalCopy: boolean }` → revoca, borra el vault, marca `disconnected` |
| `POST /api/sources/:sid/reveal` | abre la carpeta local en el gestor de archivos (solo si el servidor es loopback; si no, `409 not_local`) |
| `PUT /api/sources/providers/:id/client` | `{ clientId, clientSecret?, scope? }` (BYO; secreto al vault) |

Códigos de error nuevos (`ApiErrorCode`, aditivo, mapeados en `http/errors.ts`): `source_not_found` 404, `source_auth_required` 409 (no 401, para no confundirlo con la sesión web), `source_busy` 409, `source_flow_expired` 410, `source_flow_state_mismatch` 400, `source_read_only` 409, `source_conflict` 409, `source_provider_unavailable` 503, `not_local` 409.

### 10.2 SSE

- `source_status` (broadcast a todos los clientes) al cambiar `SourceInfo`.
- `source_changes` tras cada ciclo o paso de un lote.
- Reconexión: el `hello` no cambia; el cliente reconstruye con `GET /api/sources` (snapshot), igual que hace con `GET /api/workspaces`. Sin replay de tramas antiguas.

### 10.3 `--allow-remote`

El navegador no llega al loopback del servidor: la UI muestra el plan B desde el principio («After signing in, copy the address of the page you land on and paste it here»). `reveal` está desactivado. La documentación recomienda un túnel SSH.

---

## 11. UX para usuarios no técnicos

### 11.1 Asistente (web: `components/sources/SourceWizard.tsx`, import dinámico; TUI: `tui/sources.ts`)

| Paso | EN | ES |
|---|---|---|
| 1 Conectar | **Connect a cloud folder.** Alisio will be able to read your documents and help you work with them. [Connect Google Drive] · *What will Alisio see?* | **Conecta una carpeta en la nube.** Alisio podrá leer tus documentos y ayudarte a trabajar con ellos. [Conectar Google Drive] · *¿Qué verá Alisio?* |
| Explicación de permisos (si Fase 0: sin descendientes) | Alisio only sees the **folders and files you share with it** in the next step, and the files it creates. You can add more later. | Alisio solo ve las **carpetas y archivos que compartas con él** en el siguiente paso, y los archivos que cree. Puedes añadir más después. |
| (si Fase 0: con descendientes) | Alisio sees the folder you choose and everything inside it. | Alisio ve la carpeta que elijas y todo lo que contiene. |
| 2 Elegir | Your browser will open. Sign in to Google and choose what to share with Alisio. · *Waiting for you to finish in the browser…* · (30 s) *Browser didn't open? Copy this link* · *Already signed in but stuck? Paste the address of the page you landed on* | Se abrirá tu navegador. Inicia sesión en Google y elige qué compartir con Alisio. · *Esperando a que termines en el navegador…* · (30 s) *¿No se abrió? Copia este enlace* · *¿Ya iniciaste sesión y no avanza? Pega la dirección de la página donde terminaste* |
| 3 Qué puede hacer | (•) **Read only** (recommended) — Alisio reads your documents and never changes them in Drive. ( ) **Read and propose changes** — Alisio works on a local copy; you review every change before it is sent to Drive. | (•) **Solo leer** (recomendado) — Alisio lee tus documentos y nunca los cambia en Drive. ( ) **Leer y proponer cambios** — Alisio trabaja en una copia local; revisas cada cambio antes de enviarlo a Drive. |
| Aviso D6 | What Alisio reads is sent to your model provider (**{provider}**) to answer you. ☐ My model provider does not train on this data. | Lo que Alisio lee se envía a tu proveedor de modelo (**{provider}**) para responderte. ☐ Mi proveedor de modelo no entrena con estos datos. |
| 4 Listo | Downloading your documents… (12 of 24) → **Ready.** [Start a chat in this folder] | Descargando tus documentos… (12 de 24) → **Listo.** [Empezar un chat en esta carpeta] |
| Instrucciones encontradas | **This folder includes instructions for the agent** (AGENTS.md). Load them? They could change how Alisio behaves. [Load] [Not now] | **Esta carpeta incluye instrucciones para el agente** (AGENTS.md). ¿Cargarlas? Podrían cambiar cómo se comporta Alisio. [Cargar] [Ahora no] |

### 11.2 Errores en lenguaje llano (una acción cada uno)

| Código | EN | ES |
|---|---|---|
| `needs-auth` | Google asked you to sign in again. [Reconnect] | Google pidió que vuelvas a iniciar sesión. [Volver a conectar] |
| `too-large` | This document is too large to read (over 10 MB). Open it in Drive. | Este documento es demasiado grande para leerlo (más de 10 MB). Ábrelo en Drive. |
| `excluded`/forbidden | This file isn't shared with Alisio yet. [Add files] | Este archivo aún no está compartido con Alisio. [Añadir archivos] |
| conflicto | You and someone else changed this file. We kept both versions. [Choose] | Tú y otra persona cambiaron este archivo. Guardamos ambas versiones. [Elegir] |
| `offline` | You're offline. You can keep working; changes will wait. | Estás sin conexión. Puedes seguir trabajando; los cambios esperarán. |
| `quota` | Your Google Drive is full. Free up space in Drive. | Tu Google Drive está lleno. Libera espacio en Drive. |
| vault file | Your sign-in is stored in a protected file on this computer (not in the system keychain). | Tu inicio de sesión se guarda en un archivo protegido de este equipo (no en el llavero del sistema). |

### 11.3 Revisión de envíos (Fase 3; `components/sources/PushReview.tsx`)

«**{n} changes ready to send to Drive**» / «**{n} cambios listos para enviar a Drive**». Lista con casillas por archivo (crear / actualizar / mover / **papelera** en rojo), diff al pulsar, nota para nativos («Will be created as a new Google Doc» / «Se creará como un nuevo documento de Google»). Botón [Send to Drive] / [Enviar a Drive]; si hay papeleras, segundo paso: «Move {n} files to the Drive trash? You can restore them from Drive's trash.» / «¿Mover {n} archivos a la papelera de Drive? Puedes restaurarlos desde la papelera de Drive.»

### 11.4 Otras superficies

- **Ajustes → Cloud folders** (`CloudFoldersPage.tsx`, en el chunk perezoso de Settings): lista de conexiones (estado, cuenta, acceso, última sincronización, almacenamiento del token), [Sync now], [Add files], [Open local folder], [Change access], [Disconnect] (diálogo: «Also delete the local copy?»; enlace a `https://myaccount.google.com/permissions`), Avanzado: cliente propio.
- **Sidebar**: icono de nube y una insignia por workspace: `synced` ✓, `syncing` (animación con `prefers-reduced-motion`), `attention` (punto ámbar con contador de conflictos o cambios pendientes). Texto accesible en `aria-label`.
- **TUI**: `/source` (menú: status, sync, add files, review changes, disconnect); `alisio source connect [--provider google-drive] [--access read|propose]` (imprime URL, abre navegador si puede, acepta la URL pegada), `alisio source status [--json]`, `alisio source sync <id>`, `alisio source disconnect <id> [--delete-local]`; pie de estado con `api.ui.status`-equivalente interno: `☁ synced` / `☁ 3 to send`.
- **Accesibilidad**: foco gestionado en cada paso, `aria-live="polite"` para el progreso, todos los controles con teclado, contraste WCAG AA.
- **Carga perezosa**: el asistente, la revisión y la página de Ajustes son `import()`; los textos viven en `components/sources/strings.ts` (EN/ES, perezoso, como `memory/strings.ts`). El chunk inicial solo gana el store y la insignia (≤ 1,5 KB gzip). `pnpm web:size` debe seguir ≤ 90 KB.
- **Ayuda**: `docs/cloud-folders.md` y `docs/es/cloud-folders.md`, enlazadas desde «What will Alisio see?».

---

## 12. Configuración

Solo **global** (`<configHome>/config.json`); una config de proyecto nunca puede cambiar orígenes. Las claves ajustables entran en `SETTABLE_KEYS` y necesitan etiqueta EN y ES en `SETTING_LABELS` (`tests/web-i18n.test.ts` lo exige).

| Clave | Tipo, defecto, límites | Ajustable |
|---|---|---|
| `sources.enabled` | boolean, `true` | sí |
| `sources.pollMinutes` | int, `5`, 0–1440 (0 = sin sondeo) | sí |
| `sources.maxFileMB` | int, `100`, 1–2048 | sí |
| `sources.concurrency` | int, `4`, 1–8 | sí |
| `sources.trashRetentionDays` | int, `30`, 0–365 | sí |
| `sources.vault` | enum `auto`\|`keychain`\|`file`, `auto` | sí |
| `sources.requireNoTrainingProvider` | boolean, `false` | sí |
| `builtinPlugins.google-drive.enabled` | boolean, `true` | vía Plugins (existente) |
| `builtinPlugins.google-drive.clientId` / `.scope` (`drive.file`\|`drive`) | string / enum | vía la ruta BYO (§10.1), no en `SETTABLE_KEYS` |

---

## 13. Paquete `@alisio/plugin-google-drive`

```
packages/plugin-google-drive/
  package.json        # deps: none; peerDependencies: { "@alisio/sdk": "workspace:*" }
  README.md  LICENSE
  src/index.ts        # createGoogleDrivePlugin(options) → Plugin; api.sources?.register(...)
  src/registration.ts # AuthDescriptor (OnePick params), codecs, apiOrigins, help EN/ES
  src/client.ts       # SourceProvider over ctx.fetch (list, stat, read, write, trash, move, changes)
  src/upload.ts       # resumable upload (256 KiB chunks), multipart for ≤ 5 MB
  src/acl.ts          # Google file → RemoteNode; errors → SourceError
  src/fields.ts       # FIELDS mask, query builders (escaping of ' and \ in q)
  src/version.ts
```

- Registro: `BUILTIN_PLUGINS` añade `{ id: "google-drive", name: "Google Drive", description: "Google Drive cloud folders", categories: ["storage"], create: createGoogleDrivePlugin }`; `packages/cli/package.json` gana la dependencia.
- El client id de Alisio se incluye en `registration.ts` como constante; `options.clientId` lo sustituye (BYO).
- Puede: registrar el proveedor, traducir, llamar a `ctx.fetch`. No puede: abrir rutas, leer el vault, tocar SQLite de core, aprobar nada. Si `api.sources` no existe (core antiguo), no registra nada y no falla.
- **Un proveedor de terceros** (OneDrive/Graph `driveItem` con `eTag`/`cTag`; Dropbox con `content_hash`; WebDAV/Nextcloud con `ETag` y `PROPFIND`; S3 con `ETag` y `ListObjectsV2`) es un paquete que implementa lo mismo y declara sus `SourceCapabilities`; se instala con `alisio install npm:<paquete>`. **Core no cambia.**

### 13.1 Kit de conformidad (`@alisio/sdk/testing/sources`)

Casos (cada uno se salta si `requires` no se cumple):

1. `list` pagina y devuelve hijos directos. 2. `stat` de id inexistente → `undefined`. 3. `read` de binario devuelve los bytes exactos. 4. `read` de nativo con `exportAs` devuelve contenido. 5. `write` crea y devuelve una versión nueva. 6. `write replace` cambia la versión y el hash. 7. Escritura condicional con versión obsoleta → `SourceError("conflict")` (o el motor la detecta en preflight). 8. `trash` deja el nodo fuera de `list` y aparece como `removed` en `changes`. 9. `move` cambia padre y nombre conservando el id. 10. Duplicados en una carpeta se listan todos. 11. Nombres con `/`, `:`, emojis y NFD sobreviven a ida y vuelta. 12. `startCursor` + `changes` reportan upsert y removed en orden. 13. 429 simulado → el decorador reintenta. 14. 401 → refresco → éxito. 15. `account()` no devuelve secretos. 16. Ningún error contiene el token sembrado.

El proveedor en memoria pasa todos los casos y alimenta las pruebas de core sin red.

---

## 14. Archivos por paquete

| Paquete | Nuevo | Modificado |
|---|---|---|
| sdk | `src/testing/sources.ts` (+ export `./testing/sources` en `package.json`) | `src/index.ts` (§5.1) |
| core | `src/sources/{registry,service,connections,nodes,journal,cycle,engine,scan,plan,apply,path-mapper,conflicts,codecs,oauth,vault,vault-mac,vault-secret-tool,vault-dpapi,vault-file,fetch-decorators,run-gate,janitor,errors}.ts`, `src/tools/sources.ts` (`source_status` efecto `read`, `source_push_request`) | `src/runtime/store.ts` (v9), `src/application.ts` (`exactWorkspaceRoot`, cableado de `SourceService`, `projectInstructions`, prefijo de contenido no confiable), `src/plugins/host.ts` (`api.sources`), `src/resources/context.ts` (opción `projectInstructions`), `src/config.ts` (claves), `src/core/contracts.ts` (`ToolCapability`), `src/core/runner.ts` (aprobación `once` siempre para `source.*`), `src/analysis/capabilities.ts` (rechazo de `session` para `source.*`), `src/index.ts` |
| server | `src/routes/sources.ts`, `src/host/sources.ts` (flujos OAuth pendientes, RunGate) | `src/host/workspace-host.ts` (`openSource`, `info().source`), `src/index.ts`, `src/http/errors.ts`, `src/schemas.ts` |
| web | `src/components/sources/{SourceWizard,CloudFoldersPage,PushReview,SyncBadge}.tsx`, `strings.ts`, `sources.module.css`, `src/store/sources.ts` | `src/net/api.ts`, `src/components/sidebar/Sidebar.tsx`, `src/components/settings/{SettingsModal.tsx,labels.ts}`, `src/store/events.ts` (tramas) |
| cli | `src/tui/sources.ts`, `src/source-command.ts` | `src/main.ts` (subcomando), `src/builtin.ts`, `src/tui/app.ts` (`/source`), `package.json` |
| nuevo | `packages/plugin-google-drive/**` | `scripts/pack-check.ts` (enumera los paquetes publicados, verificado); `pnpm-workspace.yaml` no cambia (`packages/*`, verificado) |
| docs | `docs/cloud-folders.md`, `docs/es/cloud-folders.md`, `docs/assets/web-ui/cloud_folder_wizard_web_ui.webp`, `…/cloud_folder_review_web_ui.webp` | `docs/.vitepress/config.ts`, `docs/{plugins,configuration,web,tui,tools}.md` + ES, `docs/implementation-status.md`, `docs/limitations.md`, `CHANGELOG.md` |

---

## 15. Estrategia de pruebas

| Nivel | Qué | Archivos (`tests/`) |
|---|---|---|
| Unidad | `PathMapper` (tabla §7.8), plan a tres bandas (tabla §7.2 completa), máquina de estados, redacción, selección de vault (con `runProcess` simulado), PKCE (vectores RFC 7636), validación de `state` | `sources-path-mapper.test.ts`, `sources-plan.test.ts`, `sources-vault.test.ts`, `sources-oauth.test.ts` |
| Propiedades | Secuencias aleatorias de operaciones locales y remotas (crear, editar, borrar, renombrar, duplicar, caer a mitad) sobre el proveedor en memoria: invariantes «nunca se pierden bytes» (todo lo sustituido está en `trash/` o en remoto), «el espejo converge», «nada se envía sin aprobación», «determinismo del mapeo». Generador propio con semilla (sin dependencia nueva) | `sources-engine-properties.test.ts` |
| Conformidad | Kit §13.1 contra el proveedor en memoria y contra el adaptador de Google con un **servidor HTTP falso local** (`node:http`) que reproduce respuestas grabadas (fixtures JSON sin datos personales) | `sources-conformance.test.ts`, `google-drive-adapter.test.ts`, `fixtures/google-drive/*.json` |
| Core | Migración v9 sobre una base v8 con datos; regla de raíz exacta con `$HOME` git; `.alisio/` excluido; AGENTS.md pendiente de confirmación; aprobaciones `source.*` en `ask`/`auto`/`full`/headless; recuperación de `planned` con dueño muerto; no aplicar durante una ejecución | `sources-migration.test.ts`, `sources-workspace-root.test.ts`, `sources-security.test.ts`, `sources-approvals.test.ts`, `sources-recovery.test.ts` |
| Servidor | Rutas §10.1 con Origin/cookie, flujo OAuth contra un IdP falso local, plan B pegar URL, `state` incorrecto, expiración, tramas SSE, `--allow-remote` | `server-sources.test.ts` |
| TUI | Lógica de `/source` y del subcomando (salidas, `--json`) | `tui-sources.test.ts`, `fixtures/cli-e2e.ts` (caso headless) |
| Web | Store `sources.ts`, lógica del asistente y de la revisión; etiquetas EN/ES (prueba existente) | `web-sources-store.test.ts` |
| Manual (navegador) | Asistente completo con una cuenta de prueba real; captura `cloud_folder_wizard_web_ui.webp`; lector de pantalla en los cuatro pasos | lista en §16 |

CI nunca usa red: Google se simula siempre.

---

## 16. Plan por fases

### 16.1 Fase 0 — Prueba desechable (2–3 días; **fuera del repo**, antes de todo)

**Preparación:** proyecto de Google Cloud en Testing, cliente Desktop, Drive API habilitada, dos cuentas de prueba (A propietaria, B colaboradora). En Drive de A: carpeta `P0` con `doc1` (Doc con un comentario, una sugerencia, una tabla, una imagen), `sheet1` (3 hojas), `bin1.pdf`, subcarpeta `P0/sub` con `doc2`.

**Script** `phase0/probe.mjs` (Node ≥ 22, sin dependencias; en el directorio temporal del operador, **no** en el repo): servidor `node:http` en `127.0.0.1:0`, PKCE S256, `state`, imprime la URL con `trigger_onepick=true&allow_multiple=true&allow_folder_selection=true&prompt=consent&access_type=offline`, canjea el código, guarda tokens en memoria y ejecuta los experimentos; modo `--paste` que acepta la URL pegada en vez de escuchar.

| # | Experimento | Pasos | Resultado esperado / cómo cambia el diseño |
|---|---|---|---|
| E1 | ¿Elegir una carpeta concede sus descendientes? | Elegir **solo** `P0`; `files.list q='P0' in parents`; `files.get` de `doc1`, `doc2`; `export` de `doc1` | **Si lista y lee** → `folderGrantIsRecursive: true`; texto «the folder you choose and everything inside it». **Si no** (esperado según la comunidad) → `false`; texto «folders and files you share with Alisio»; el paso 2 recomienda abrir la carpeta y seleccionar todo; botón «Add files» siempre visible. |
| E2 | Selección múltiple dentro de la carpeta | Abrir `P0`, seleccionar todo (¿Ctrl/Cmd+A o mayúsculas?) | Documentar el gesto en la ayuda; si no hay «seleccionar todo», limitar la promesa del producto. |
| E3 | Archivos creados por la app | Crear `new.md` en `P0` con la app; luego B añade `fromB.docx` a `P0` | La app ve `new.md`; confirmar que **no** ve `fromB.docx` con `drive.file` → el texto de «Add files» lo explica. |
| E4 | Changes API con `drive.file` | `startPageToken`; editar `doc1` y crear algo en `P0` desde la UI de Drive; `changes.list` | Confirmar qué aparece; si no aparecen cambios de archivos concedidos, el sondeo usa reescaneo (`changeFeed: "none"`). |
| E5 | Reimportar Markdown sobre un Doc existente | Copia de `doc1`; `PATCH upload …?uploadType=media` con `text/markdown` | Observar comentario, sugerencia, tabla, imagen, historial. **Si algo se pierde** (esperado) → D5 se mantiene (no se ofrece). **Si todo se conserva** → el propietario puede habilitar «Replace content (may lose formatting)» con aviso. |
| E6 | Crear un Doc desde Markdown | `POST` con `mimeType` de Doc y cuerpo `text/markdown` | Debe crear el Doc → confirma `createFrom`. |
| E7 | Plan B pegar la URL | Detener el servidor antes de terminar el login; pegar la URL resultante en `--paste` | Si canjea → plan B válido. Si no → el plan B pasa a ser flujo de dispositivo (que solo admite `drive.file`/`drive.appdata` y **no** OnePick): con `--allow-remote` solo se podrán crear archivos nuevos. |
| E8 | `about.get` con `drive.file` | `GET /about?fields=user(...)` | Si falla → etiqueta de cuenta = «Google account» sin e-mail. |
| E9 | Escritura condicional | `files.update` de `bin1.pdf` con `If-Match` obsoleto | Si devuelve 412 → `conditionalWrite: "etag"` (elimina la carrera de A3). Si lo ignora → se mantiene `preflight`. |
| E10 | Caducidad en Testing | Anotar fecha; reintentar refresco a los 8 días | Debe fallar con `invalid_grant` → confirma el mensaje `needs-auth`. |

**Entrega:** una tabla de resultados (sí/no, evidencia) que el propietario confirma; se actualizan §8.6 (`folderGrantIsRecursive`, `changeFeed`, `conditionalWrite`), §11.1 y §17.2. Sin ese visto bueno no empieza la Fase 1.

### 16.2 Fase 1 — Contratos, motor y espejo sin red (L, 2–3 semanas)

- **Entregables:** tipos SDK (§5.1), `@alisio/sdk/testing/sources`, v9, `core/src/sources/*` (salvo OAuth real y vault de SO: stub en memoria), regla de raíz exacta, exclusión de `.alisio/`/`.agents/agents/`, `projectInstructions`, prefijo de contenido no confiable, `RunGate`, `alisio source status --json` contra el proveedor en memoria (bandera oculta de prueba).
- **Aceptación core/server:** el kit de conformidad pasa con el proveedor en memoria; las propiedades de §15 pasan con 500 secuencias por semilla; un workspace local existente no cambia (prueba de regresión de `workspaces()` y `openPath`); la migración v9 conserva todos los datos de una base v8.
- **Web/TUI:** sin UI visible (solo el campo opcional `source` en `WorkspaceInfo`).
- **Docs:** `docs/implementation-status.md` (estado «motor sin proveedor real»).

### 16.3 Fase 2 — Google Drive solo lectura + OAuth + asistente (L)

- **Entregables:** `@alisio/plugin-google-drive` (lectura, codecs §8.5), `OAuthBroker` con plan B, vaults de SO y archivo, rutas §10.1 (salvo cambios/aprobaciones), SSE, asistente web, Ajustes → Cloud folders, insignia, `/source` y `alisio source connect|status|sync|disconnect`, BYO, confirmaciones D6 y D10.
- **Aceptación:**
  - core/server: conectar → espejo → `data_inspect` lee el `.xlsx` de un Sheet; desconectar revoca y borra el vault; ningún token en SSE, logs o eventos (prueba de propiedad); `too-large` con mensaje.
  - web: un usuario de prueba no técnico conecta en ≤ 4 pasos sin ayuda; `pnpm web:size` ≤ 90 KB; lector de pantalla anuncia el progreso.
  - TUI: conexión por SSH con plan B pegar URL.
  - headless: `alisio source sync <id>` devuelve código 0/≠0 y JSON estable.
- **Docs:** `cloud-folders.md` EN/ES (con las instrucciones BYO), `configuration.md`, `plugins.md` (`api.sources`), `web.md`, `tui.md`, `implementation-status.md`; capturas reales `docs/assets/web-ui/cloud_folder_wizard_web_ui.webp` y `cloud_folders_settings_web_ui.webp`.
- **Release:** entrada en `CHANGELOG.md` bajo **0.2.0** (Added: Cloud folders (Google Drive, read-only)); changesets de sdk, core, server, cli y plugin-google-drive.

### 16.4 Fase 3 — Proponer y enviar con aprobaciones (L)

- **Entregables:** acceso `propose`, `PushBatch` y journal, preflight, papelera, mover, crear Docs desde Markdown, `source_push_request`, `PushReview`, resolución de conflictos en UI y TUI, `trash/` local con limpieza.
- **Aceptación:** ningún byte sale sin aprobación (prueba en `ask`, `auto`, `full` y headless); papelera siempre pregunta en `full`; versión remota cambiada → conflicto con copia, nunca sobrescritura; matar el proceso a mitad de un lote y reabrir → estado coherente; un nativo editado localmente nunca se envía como actualización.
- **Docs:** sección «Sending changes to Drive» EN/ES, `tools.md` (`source_push_request`), captura `cloud_folder_review_web_ui.webp`; CHANGELOG.

### 16.5 Fase 4 — Sondeo, unidades compartidas, robustez y edición precisa de Docs (M)

- **Entregables:** sondeo por cursor (o reescaneo según E4), unidades compartidas, reintentos completos, modo sin conexión, `TrashJanitor`, edición de Docs con `documents.batchUpdate` por párrafos (Docs API habilitada; scope cubierto por `drive.file` para archivos concedidos, **no verificado**; probar al inicio de la fase), activación del scope `drive` si Google aprobó.
- **Aceptación:** un cambio en Drive aparece en ≤ `pollMinutes` + 1 min; 429 simulado no rompe el ciclo; una edición de párrafo conserva comentarios y formato del resto (prueba manual documentada).

### 16.6 Fase 5 — Segundo proveedor (M)

- WebDAV/Nextcloud (lo más barato: `ETag`, sin nativos) como paquete nuevo `@alisio/plugin-webdav`.
- **Aceptación:** pasa el kit de conformidad y la prueba de extremo a extremo **sin cambios en core, server ni web** (comprobado por diff).

---

## 17. Definición de terminado y registro de riesgos

### 17.1 Definición de terminado (por fase)

`pnpm check` verde; pruebas nuevas primero (TDD); kit de conformidad verde; paridad EN/ES (`pnpm docs:check`); `docs/implementation-status.md` actualizado con alcance de verificación y limitaciones; capturas reales cuando haya UI; `pnpm web:size` dentro del presupuesto; changeset y entrada de CHANGELOG; ninguna regresión en workspaces locales; revisión manual del asistente con una persona no técnica (Fase 2).

### 17.2 Riesgos

| Riesgo | Impacto | Cómo y cuándo se verifica |
|---|---|---|
| `drive.file` no concede los descendientes de una carpeta (comunidad; contradictorio) | Promesa de producto más débil | Fase 0 E1–E3 |
| Pérdida de comentarios/sugerencias al reimportar Markdown | Pérdida de datos | Fase 0 E5 (D5 lo evita por defecto) |
| Plan B de pegar la URL no funciona | Sin conexión vía `--allow-remote`/SSH | Fase 0 E7 |
| Verificación de Google del scope `drive` (6 semanas, CASA, Limited Use) | Retraso de la semántica de carpeta completa | Trámite del propietario en paralelo |
| Limited Use y proveedores de modelo que entrenan | Rechazo de la verificación / legal | Asesoría legal; `requireNoTrainingProvider` listo |
| Carrera entre preflight y escritura (A3) | Sobrescritura rara | Fase 0 E9 |
| `secret-tool` ausente o sin servicio en Linux | Fallback a archivo | Prueba en Ubuntu/Fedora/Debian sin escritorio en Fase 2 |
| `security` sin secreto por stdin | Secreto visible en argumentos del proceso | Prueba en macOS en Fase 2 |
| Coste de cuota en «unidades» y facturación futura | Coste para el propietario | Monitorizar la consola tras el lanzamiento |
| Verificación de marca con `*.github.io` | Retraso | Usar dominio propio |
| Corrección del motor de sincronización | Pérdida o duplicación | Pruebas de propiedades y recuperación (Fases 1 y 3) |
| Docs API `batchUpdate` con `drive.file` | Fase 4 bloqueada | Prueba al inicio de la Fase 4 |

---

## Apéndice A. Glosario (para lectores no técnicos)

| Término | Significado |
|---|---|
| Workspace | La carpeta con la que trabaja Alisio en un chat. |
| Carpeta en la nube / origen | Una carpeta de Google Drive (u otro servicio) conectada a Alisio. |
| Copia local (espejo) | Una copia de esos documentos en tu equipo, gestionada por Alisio, donde trabaja el agente. |
| Sincronizar | Traer a la copia local lo que cambió en Drive. |
| Enviar | Subir a Drive los cambios que aprobaste. |
| Conflicto | Tú y otra persona cambiaron el mismo archivo; Alisio guarda ambas versiones. |
| Papelera | Donde Drive guarda lo borrado; se puede restaurar. |
| OAuth / iniciar sesión con Google | La forma segura de dar permiso a Alisio sin compartir tu contraseña. |
| Permiso `drive.file` | Alisio solo ve lo que compartes con él y lo que crea. |
| Llavero | El almacén seguro de contraseñas de tu sistema operativo. |
| Proveedor de modelo | El servicio de IA que responde (configurado en Alisio). |

## Apéndice B. Fuentes (consultadas el 2026-10-02/03)

1. Scopes de Drive (no sensible/restringido; `drive.file`): https://developers.google.com/workspace/drive/api/guides/api-specific-auth
2. Picker en escritorio (OnePick, `trigger_onepick`, `allow_folder_selection`, `picked_file_ids`, solo `drive.file`): https://developers.google.com/workspace/drive/picker/guides/desktop-mobile-picker
3. Visión general del Picker (web vs. escritorio): https://developers.google.com/workspace/drive/picker/guides/overview
4. OAuth para apps de escritorio (loopback, PKCE, secreto no confidencial, OOB retirado): https://developers.google.com/identity/protocols/oauth2/native-app
5. Flujo de dispositivo (scopes permitidos): https://developers.google.com/identity/protocols/oauth2/limited-input-device
6. Audiencia de la app (Testing: 7 días, usuarios de prueba): https://support.google.com/cloud/answer/15549945
7. Estados de la app OAuth (tope de 100 usuarios): https://developers.google.com/identity/protocols/oauth2/production-readiness/overview
8. Verificación de alcance restringido y CASA: https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
9. FAQ de verificación (plazos): https://support.google.com/cloud/answer/13463817
10. Política de datos de usuario de Workspace (Limited Use, IA): https://developers.google.com/workspace/workspace-api-user-data-developer-policy · https://support.google.com/cloud/answer/13805798
11. Formatos de exportación: https://developers.google.com/workspace/drive/api/guides/ref-export-formats · `files.export` (10 MB): https://developers.google.com/workspace/drive/api/reference/rest/v3/files/export
12. Changes API: https://developers.google.com/workspace/drive/api/guides/manage-changes · Límites y cuotas: https://developers.google.com/workspace/drive/api/guides/limits
13. Servidor MCP oficial de Drive (Developer Preview): https://developers.google.com/workspace/drive/api/guides/configure-mcp-server
14. rclone Drive (client id compartido retirado en 2026; formatos): https://rclone.org/drive/
15. Drive para escritorio (punteros `.gdoc`, sin Linux): https://knowledge.workspace.google.com/admin/drive/set-up-drive-for-desktop-for-your-organization
16. Importar Markdown a Docs (secundaria): https://workspaceupdates.googleblog.com/2024/07/import-and-export-markdown-in-google-docs.html · https://github.com/upstash/context7/issues/3036
17. `drive.file` y carpetas (comunidad, contradictoria): https://stackoverflow.com/questions/79702574 · https://groups.google.com/g/google-apps-script-community/c/_W-NKbttfbo · https://www.agenticfabriq.com/blog/google-drive-agent-access
18. Precedente de lista de proveedores de IA en verificación (secundaria): https://github.com/goakal/binder-landingpage/pull/24
19. Tamaños de paquetes npm (`googleapis` 215 MB, `@googleapis/drive` 2,5 MB): registro npm consultado el 2026-10-02.
