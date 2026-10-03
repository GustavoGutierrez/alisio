# Arquitectura

Alisio es un monorepo pnpm con nueve paquetes publicables. El adaptador del SDK de OpenAI vive en
`@alisio/plugin-openai-compatible`; el núcleo solo contiene contratos, el registro aditivo, la
activación y la persistencia de proveedores.

<div class="architecture-diagram" role="region" aria-label="Diagrama desplazable de la arquitectura de paquetes de Alisio" tabindex="0">
  <img src="/assets/architecture.es.svg" alt="Dependencias entre paquetes de Alisio: la CLI conecta el núcleo, el SDK, memoria y subagentes; el núcleo depende del SDK y los plugins usan el SDK como peer dependency." width="714" height="1028" />
</div>

| Paquete | Función | Depende de |
| --- | --- | --- |
| `@alisio/sdk` | Contrato público de plugins: tipos más `definePlugin` y `textResult`. Sin imports de runtime ni de proveedores | Nada |
| `@alisio/core` | Runner agnóstico del proveedor, registro/activación/persistencia de proveedores, herramientas, adaptadores de runtime, host de plugins, sesiones hijas, configuración y MCP | `@alisio/sdk`, cliente MCP, `ajv`, `yaml`, `zod` |
| `@alisio/plugin-openai-compatible` | Adaptador integrado Chat Completions/Responses y descubrimiento de modelos | `@alisio/sdk` (peer), `openai` |
| `@alisio/plugin-memory` | Plugin integrado de memoria persistente | `@alisio/sdk` (peer), `zod` |
| `@alisio/plugin-subagents` | Plugin integrado de [subagentes](/es/subagents): definiciones de agentes, herramientas de delegación, límites, worktrees de git y el árbol de agentes | `@alisio/sdk` (peer), `yaml`, `zod` |
| `alisio` | CLI, TUI y registro que conecta los plugins integrados de proveedor, memoria y subagentes | `@alisio/core`, todos los plugins integrados, `@alisio/sdk`, `@earendil-works/pi-tui`, `commander` |

Los proveedores dedicados de modelos (DeepSeek, OpenCode Console (Zen), OpenCode Go) son paquetes
`@alisio/plugin-*` publicados desde el monorepo
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) e instalables por separado con
`alisio install npm:@alisio/plugin-...`.

Los SDKs de proveedores y los imports específicos de un runtime quedan fuera del SDK público y de los
contratos del núcleo del agente.

## Puerto de almacenamiento

Los plugins nunca importan un driver SQLite. `api.storage.sqlite(path)` devuelve el puerto
`SqlDatabase` definido en `@alisio/sdk` (`exec`, `prepare`, `transaction`, `close`), implementado por
`@alisio/core` sobre `node:sqlite` con FTS5. El plugin de memoria está escrito únicamente contra este
puerto, y por eso solo depende del SDK y de `zod`.

## Plugins integrados y externos

| | Integrado | Externo |
| --- | --- | --- |
| Origen | Registro en la CLI (`packages/cli/src/builtin.ts`) | `--plugin`, configuración `plugins`, directorios de plugins globales o de proyecto de confianza |
| Ruta de confianza | Ruta de confianza del host, también con `--read-only`, sin `--trust-project` | Solo confianza explícita; desactivados por `--read-only` |
| Nombres | Herramientas y comandos sin prefijo | Prefijo `p_<hash>_` en herramientas, comandos `id:name` |
| Efecto `internal` | Permitido | Se degrada a `external` |
| Configuración | `builtinPlugins.<id>`; se desactiva con `enabled: false` o `--disable-plugin <id>` | Específica de cada plugin |

El núcleo no contiene referencias a la memoria: la CLI pasa su registro a `createApplication`. Añadir
otro plugin integrado consiste en agregar una entrada a ese registro.

## Sesiones hijas

`@alisio/core` proporciona un servicio genérico de sesiones hijas (`packages/core/src/sessions/children.ts`),
expuesto a los plugins como `api.sessions`. Una sesión hija es una conversación persistida con un
vínculo a su padre que se ejecuta con el mismo runner y permisos reducidos: las herramientas, las
capacidades y las aprobaciones se intersecan con las del padre, un padre de solo lectura hace que todo
el subárbol sea de solo lectura, y abortar un padre aborta sus descendientes en ejecución. Al arrancar,
los hijos que quedaron en ejecución o en cola se marcan como `interrupted`. El servicio no contiene
lógica de agentes: las definiciones, los límites, las colas, los worktrees de git y el árbol de agentes
están en `@alisio/plugin-subagents`, y la TUI solo renderiza paneles genéricos (`api.ui.panel`) y vistas
de sesión de solo lectura. Consulte [Sesiones hijas](/es/plugins#child-sessions).

## Registro de extensiones

`@alisio/core` mantiene un registro de extensiones tipado en el host de plugins
(`packages/core/src/extensions`). Los plugins registran proveedores para los puntos declarados en
`ExtensionPoints` de `@alisio/sdk` (`mascot`, `startup-screen`). La resolución es determinista e
independiente del orden de carga de los plugins: mayor prioridad, después ID del plugin y después
orden de registro dentro de un plugin; los empates en la prioridad ganadora se informan como
diagnósticos `extension_conflict`. `renderStartup` (`packages/core/src/startup`) resuelve los
proveedores, valida, sanea y recorta su salida, y recurre a `DefaultAlisioMascot` y
`DefaultStartupScreen` cuando un proveedor falla. La CLI (`packages/cli/src/banner.ts`) solo decide
cuándo mostrar la pantalla y detecta las capacidades de la terminal. Consulte
[Puntos de extensión](/es/plugins#extension-points).

## Runtime

Alisio se ejecuta en Node.js >= 22.16 o Bun >= 1.4.2. Ambos proporcionan `node:sqlite`, que guarda las
sesiones (conversación, eventos, journal de herramientas, estado de plugins, bloqueo de sesión) y la
memoria. Node.js 22.16 es el mínimo porque las compilaciones 22.x anteriores carecen de FTS5.

## Eventos de ejecución {#run-events}

El runner informa del progreso como `RunEvent`: a los integradores mediante `onEvent`, a los plugins
(`events.on`) y como JSONL con `alisio run --json`. `schemaVersion` sigue en `1` mientras los cambios
sean aditivos, por lo que los consumidores deben ignorar campos y tipos de evento desconocidos.

| Campo | Significado |
| --- | --- |
| `runId` | Una ejecución del bucle del agente. Los integradores pueden asignarlo de antemano (`RunOptions.runId`); si no, un UUID |
| `seq` | Contador por ejecución que empieza en 1; se reinicia en cada ejecución |
| `eventId` | Opcional. El `events.seq` global persistido como texto, único y creciente entre ejecuciones. Ausente en los eventos efímeros |
| `correlationId` | Opcional. Se copia de `RunOptions.correlationId` (por ejemplo, un id de petición HTTP) a todos los eventos de la ejecución |

`text_delta`, `reasoning_delta` y `tool_progress` son efímeros (`EphemeralRunEventType`): se
transmiten a los observadores pero nunca se guardan, así que no llevan `eventId`. Todos los demás
eventos se guardan antes de que los observadores los vean. `turn_completed` añade `durationMs` (de la
petición al proveedor a la respuesta completa) y `ttftMs` (tiempo hasta el primer delta transmitido,
ausente si el proveedor no transmitió nada). El límite de ejecución `limits.timeoutMs` cuenta **tiempo
activo**: el runner mantiene un reloj pausable por ejecución y toda espera de una persona
(aprobaciones de herramientas y de directorios externos, `ask_user_question`, la revisión del plan) lo
pausa mediante un único registro, `HumanWaits`, que comparten el runner, la interfaz interactiva del
host de plugins y la aprobación de directorios externos, así que un host que enlaza una interfaz
obtiene el comportamiento sin código adicional. Una sesión hija que espera a una persona también pausa
a sus ancestros; un padre que espera a su hijo no se pausa. `run_failed` es aditivo para los límites de tiempo: una
ejecución detenida por `limits.timeoutMs` o `limits.firstTokenTimeoutMs` termina como `failed` con
`code: "timeout"` y un objeto `timeout` (`kind`, `ms`, `model`, `provider`, `stage`, `tool`,
`firstRequest`, `attempts`); `error` es siempre una frase legible en inglés. Cuando una petición al
modelo permanece en silencio hasta `limits.firstTokenTimeoutMs`, el runner reenvía la misma petición
hasta `limits.firstTokenRetries` veces (por defecto 1) y emite `request_retry` (`attempt`, `of`,
`reason: "first_token_timeout"`, `afterMs`); un reintento no es un turno, no añade nada a la sesión y
solo ocurre mientras no llegó nada de la petición, de modo que los ids de llamadas a herramientas y la
sesión persistida siguen consistentes. `attempts` cuenta los envíos de la petición que finalmente falló.
El presupuesto de tokens de salida de cada petición se resuelve para el modelo de esa petición: gana un `limits.maxOutputTokens` explícito (o un valor por ejecución), si no el `maxOutputTokens` del catálogo del modelo con tope de 65536, si no 16384; `response_truncated` y el fallo `output_truncated` llevan el valor efectivo y su `source` (`user`, `model`, `default`).
Una respuesta cortada por el presupuesto de tokens de salida antes de ser útil (motivo de fin `length`, es
decir un mensaje `completed` con `truncated: true`, sin texto ni llamada a herramienta, o con una
llamada cuyos argumentos no son un JSON completo; o un fallo del proveedor con
`code: "output_truncated"`, el `OutputTruncatedError` tipado de `@alisio/sdk`, o el texto heredado de
plugins antiguos) se recupera hasta `limits.truncationRecoveries` veces (por defecto 2). El runner
descarta las llamadas cortadas (nunca se ejecutan ni se persisten, así que toda llamada guardada
conserva su resultado), conserva el texto visible como un mensaje normal del asistente, emite
`truncation_recovery` (`attempt`, `of`, `reason`: `tool_call_cut` o `empty_response`,
`maxOutputTokens`, `effort` si se bajó) y vuelve a pedir el mismo turno con un aviso de continuación
transitorio que nunca se guarda; no es un turno y no toca `maxTurns`. Al agotar las recuperaciones,
`run_failed` lleva `code: "output_truncated"` y un objeto `truncation` (`attempts`,
`maxOutputTokens`, `model`) con un mensaje legible. Las llamadas completas de una respuesta cortada
siguen ejecutándose, y una respuesta cortada con texto útil y sin llamadas termina con
`response_truncated`. Una detención del usuario sigue siendo
`run_cancelled`. `RunEventDataMap` y `KnownRunEvent` de `@alisio/sdk` tipan el payload de cada evento que emite el núcleo; `tests/run-events-contract.test.ts` comprueba el
runner contra ellos.

## Base de datos de sesiones (v4) {#session-database}

`SQLiteStore` migra solo hacia delante y de forma aditiva: una base escrita por un Alisio anterior se
abre en la versión 4 del esquema sin perder filas, y un binario anterior ignora las tablas y
columnas nuevas. La versión 4 añade:

| Adición | Propósito |
| --- | --- |
| Tabla `runs` | Una fila por `AgentRunner.run` (`id` = `RunEvent.runId`): `queued` → `running` → `completed`, `turns_exceeded`, `failed`, `cancelled` o `interrupted`, con modelo, uso, tiempos, error, proceso dueño y un `request_id` opcional único por sesión |
| Tabla `workspaces` | Metadatos opcionales de la UI (etiqueta, fijado, última apertura) |
| Tabla `blobs` | Metadatos de los bytes de adjuntos direccionados por contenido |
| Columnas nulables nuevas | Fijado/archivado de sesiones, `created_at`/`correlation_id` de eventos, `run_id`/`name`/`effect`/`started_at`/`ended_at` de llamadas a herramientas |

El runner registra cada ejecución cuando el store implementa los métodos opcionales de
`SessionStore` (`beginRun`, `endRun`, `runByRequest`, `runs`, `messagesPage`, `eventsPage`,
`interruptRuns`), así que también quedan registradas las ejecuciones de la TUI y del modo headless;
otras implementaciones de `SessionStore` siguen funcionando sin ellos. Reintentar `beginRun` con el
mismo `requestId` en una sesión devuelve la ejecución existente en lugar de crear otra. Al arrancar,
`createApplication` marca como `interrupted` las ejecuciones que un proceso muerto dejó en
`queued`/`running`, junto a la reconciliación existente de sesiones hijas. Las sesiones raíz ahora
registran `createdAt`/`updatedAt`.

## Blobs de adjuntos {#blobs}

`BlobStore` (`app.blobs`) guarda los bytes subidos en `<state home>/blobs/sha256/<aa>/<hash>`
(directorios `0700`, archivos `0600`, escritura atómica y deduplicación por SHA-256) y sus metadatos
en la tabla `blobs`. `Attachment.data` sigue siendo obligatorio, así que un blob nunca llega al runner
por referencia: el host convierte un `BlobRef` en un `Attachment` de imagen en base64 verificado con
`blobs.attachment(ref)` antes de `runner.run`. Por eso los mensajes siguen guardando base64, igual que
los adjuntos en línea, que siguen funcionando sin cambios.

## Catálogo de comandos {#command-catalog}

`CommandCatalog` lista, resuelve y ejecuta los comandos de barra para todas las superficies. Sus
fuentes son los comandos integrados (`BUILTIN_COMMANDS`), los comandos de plugins, las plantillas de
prompt y las skills efectivas (`skill:<id>`); ante una colisión de nombres gana la primera fuente en
ese orden. Cada `CommandDescriptor` declara sus `surfaces` (`tui`, `web`, `api`) y su `execution`: los
comandos `core` (`compact`, `model`, `effort`, `clear`/`new`, `sessions`, `resume`, `stats`, `tools`,
`skills`, `plugins`, `mcp`, `agents` y los comandos de plugins) se ejecutan con
`execute(name, args, { sessionId })`; los comandos `surface` (`help`, `connect`, `settings`, `copy`,
`ask`, `exit`, plantillas y skills) los gestiona cada UI. La TUI toma su lista de comandos y la
resolución de nombres del catálogo y le delega `/tools` y `/sessions`; su salida no cambia.

## Resolución de fuentes en desarrollo

Cada paquete exporta sus archivos compilados de `dist`, más una condición de exportación
`alisio-source`, solo para desarrollo, que apunta a `src/*.ts`. El `tsconfig.json` raíz define
`customConditions: ["alisio-source"]` y `pnpm dev` ejecuta Bun con `--conditions=alisio-source`, de
modo que los paquetes del workspace se resuelven a sus fuentes TypeScript sin compilar. La condición
se elimina de los `exports` publicados mediante `publishConfig`.

## Compilación y publicación

- **Compilación**: `pnpm build` ejecuta `tsc -p tsconfig.build.json` en cada paquete y emite
  JavaScript y declaraciones en `dist`.
- **Binario**: `pnpm build:binary` compila `packages/cli/dist/main.js` con `bun build --compile`.
- **Versionado**: [changesets](https://github.com/changesets/changesets). El workflow de release abre
  un PR de versión o publica en npm con provenance.
- **Binarios**: tras una publicación, el workflow de release compila de forma cruzada binarios
  independientes con Bun (`linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`),
  escribe `SHA256SUMS` y crea una GitHub Release (pre-release para versiones preliminares).
- **Documentación**: este sitio se construye con VitePress y se publica en GitHub Pages.
