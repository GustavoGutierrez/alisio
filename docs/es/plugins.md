# Escribir plugins

Un plugin es un módulo ES cuya exportación por defecto es un objeto `Plugin`. El contrato está en
[`@alisio/sdk`](https://www.npmjs.com/package/@alisio/sdk): tipos más dos utilidades
(`definePlugin`, `textResult`), sin dependencias de runtime ni SDKs de proveedores.

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  name: "Acme Hello",
  description: "Adds a friendly greeting tool",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.tools.register({
      name: "hello",
      description: "Greets the user.",
      effect: "read",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      async execute() {
        return textResult("Hello!");
      },
    });
  },
});
```

::: danger Los plugins son código de confianza
Los plugins se ejecutan en el mismo proceso con todos los privilegios del proceso de Alisio. Ni un
manifiesto de plugin ni un subproceso son un sandbox, y el campo `effect` no aísla nada. Cargue solo
código en el que confíe.
:::

## El objeto `Plugin`

| Miembro | Descripción |
| --- | --- |
| `id` | ID único que cumple `^[a-z0-9][a-z0-9.-]{0,63}$`, por ejemplo `acme.hello` |
| `version` | SemVer, por ejemplo `0.1.0` o `0.1.0-beta.1` |
| `apiVersion` | Siempre `1` |
| `name`, `description` | Texto opcional y legible para el catálogo de `/plugins` |
| `categories` | Categorías de catálogo opcionales (consulte la sección siguiente, Categorías de plugins). El host también deriva `model-provider` de los registros de proveedores |
| `setup(api)` | Registra todo; puede ser asíncrono. Si falla, se revierten los registros parciales |
| `extensions` | Opcional; proveedores declarativos para [puntos de extensión](#extension-points), registrados con prioridad 0 |
| `dispose()` | Opcional; libera recursos cuando Alisio se cierra. Se ejecuta solo al cerrar, nunca al deshabilitar un plugin ni con `/reload`, y lo limita `pluginHooks.disposeTimeoutMs` (consulte [Cierre](#shutdown)) |

`definePlugin` es una función de identidad que solo añade tipado. Se rechazan IDs de plugin duplicados.

## Categorías de plugins

`categories` es una lista de agrupaciones de catálogo. La TUI agrupa las filas de `/plugins` por la
primera categoría declarada y usa "General" cuando el plugin no declara ninguna; la vista de detalle
lista todas las categorías. Los autores de plugins pueden declarar cualquier valor aceptado; el host
solo deriva `model-provider` por su cuenta, a partir de los registros de proveedores. Las categorías
describen qué hace el plugin, así que un mismo plugin puede declarar varias.

| Categoría | Significado | Usada por los integrados |
| --- | --- | --- |
| `model-provider` | Registra proveedores de modelos | `openai-compatible` |
| `methodology-harness` | Agrupa un flujo de trabajo de metodología de desarrollo | — |
| `memory` | Memoria persistente, recuerdo y resúmenes de sesión | `memory` |
| `subagents` | Delegación, sesiones hijas y gestión de agentes | `subagents` |
| `search` | Proveedores de búsqueda web o vectorial | — |
| `tools` | Colecciones de herramientas de propósito general | — |
| `security` | Herramientas de auditoría, sandbox o permisos | — |
| `analytics` | Instrumentación de uso/métricas (estadísticas de sesión, costo) | — |
| `mcp` | Gestión de servidores MCP o utilidades para empaquetarlos | — |
| `storage` | Backends de almacenamiento durable más allá del SQLite por defecto | — |
| `ui` | Proveedores de presentación TUI (pantallas de inicio, mascotas, paneles) | — |
| `decisions` | Proveedores de [Decision Intelligence](/es/decision-intelligence) (`api.decisions.registerProvider`) | — |

El único proveedor de modelos integrado es `openai-compatible`. Los proveedores dedicados
(DeepSeek, OpenCode Console (Zen), OpenCode Go) son plugins independientes publicados desde el
monorepo [alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) e instalables con
`alisio install npm:@alisio/plugin-{deepseek,opencode,opencode-go}`; una vez instalados se
registran como plugins `model-provider` y aparecen en `/connect` y `/model`.

## Gestionar plugins en la TUI

Ejecute `/plugins` para abrir el catálogo filtrable. `[x]`, `[ ]`, `[!]` y `[*]`
significan activo, inactivo, fallido y reinicio necesario; las filas también distinguen los plugins
integrados de etiquetas de origen externas seguras. Seleccione una fila para ver la descripción
completa, la categoría y la acción disponible.

Los cambios actualizan atómicamente `.alisio/config.json` del proyecto actual y conservan los campos
JSON no relacionados. Se aplican deliberadamente al iniciar Alisio de nuevo: los registros, hooks,
almacenamiento y clientes de proveedor vivos no se eliminan parcialmente. Devolver un cambio al
estado original del runtime elimina `restart-required`. Los plugins externos requieren un proyecto
de confianza y confirmación explícita porque se ejecutan con todos los privilegios del proceso.
Alisio impide desactivar un plugin de proveedor mientras lo retenga el proveedor activo o cualquier
sesión enrutada viva, y también bloquea plugins con recursos de la sesión actual. Cambie de proveedor
y cierre las sesiones retenidas, o reinicie Alisio, primero. Los perfiles y credenciales siguen
siendo ajustes globales y nunca se copian a la configuración de plugins.

## Referencia de `PluginAPI`

Cada método `register`/`on` devuelve una función para anular el registro. Todo lo que registra un
plugin se elimina automáticamente cuando se descarga.

| Miembro | Descripción |
| --- | --- |
| `tools.register(tool)` | Registra una herramienta (`ToolDefinition`) |
| `commands.register(name, handler, options?)` | Registra un comando; `handler(args: string, context?: { sessionId? }) => Promise<string>` devuelve el texto que se muestra al usuario (`sessionId` es la sesión actual de la interfaz interactiva, cuando se conoce). `options`: `{ description?, argumentHint? }`, mostrados en `/help` y en el autocompletado |
| `events.on(handler)` | Observa los eventos versionados de ejecución (`RunEvent`: `schemaVersion`, `runId`, `sessionId`, `seq`, `type`, `timestamp`, `data`, más los opcionales `eventId` y `correlationId`). `KnownRunEvent` tipa el `data` de cada [evento que emite el núcleo](/es/architecture#run-events) |
| `context.register(provider)` | `() => Promise<string>`; añade texto al contexto del modelo |
| `resources.skills(path)` | Añade una raíz de Agent Skills (relativa al archivo del plugin) |
| `resources.agents(path)` | Añade un directorio de definiciones de agentes para plugins de delegación (consulte [Subagentes](/es/subagents#discovery-and-precedence)) |
| `resources.list(kind)` | Directorios registrados por todos los plugins para `skills`, `prompts` o `agents`, con el ID del plugin |
| `resources.prompts(path)` | Añade un directorio de [plantillas de prompts](/es/prompt-templates#templates-from-plugins) (`*.md`, relativo al archivo del plugin) |
| `state.get(key)` / `state.set(key, value)` | Estado JSON pequeño por plugin, persistido en la base de datos de sesiones |
| `storage.sqlite(path)` | Abre un archivo SQLite privado (0600), creando los directorios padre (0700). Devuelve el puerto de almacenamiento `SqlDatabase` |
| `views.register(view)` | Registra una [vista de datos](#data-views) con nombre y de solo lectura que los hosts, como la interfaz web, pueden leer. Ausente en un núcleo anterior: use `api.views?.register(...)` |
| `decisions.registerProvider(provider)` | Registra un proveedor de [Decision Intelligence](/es/decision-intelligence) (no lo activa); también `available()`, `activeProvider()` y `tryDecide(request, options?)`. Ausente en un núcleo anterior: use `api.decisions?.registerProvider(...)` |
| `paths` | `{ state, config, cache }`: directorios por plugin resueltos por el host y creados con modo `0700` en la primera lectura. Ausente en un núcleo anterior |
| `options` | `pluginOverrides[id].options` de solo lectura (o `{}`), congelado cuando se ejecuta `setup`. Ausente en un núcleo anterior |
| `compaction.register({ beforeCompact, afterCompact })` | Hooks de compactación, ver más abajo |
| `session.onStart(handler)` | El texto devuelto se inyecta una vez al comienzo de una sesión nueva y vacía (persistido en la sesión) |
| `session.onEnd(handler)` | Se llama cuando termina una sesión interactiva (`/clear`, `/exit`, salida) |
| `model.complete(request)` | Completado de texto agnóstico del proveedor: `{ system, messages, maxTokens?, model?, signal? }` → `Promise<string>` |
| `models.list()` / `models.resolve(reference)` | Lista modelos configurados sin credenciales y resuelve `proveedor/modelo` o un ID único sin proveedor |
| `providers.register(provider)` | Añade metadatos, campos de configuración/autenticación, capacidades y una factoría. Los registros coexisten; `/connect` selecciona uno |
| `extensions.register(point, provider, options?)` | Proporciona una implementación para un [punto de extensión](#extension-points) (`mascot`, `startup-screen`); `options`: `{ priority? }` |
| `ui.status(key, text, detail?)` | Texto breve en la barra de estado de la TUI; `detail` aparece en `/stats`; `text: undefined` lo elimina |
| `ui.panel(id, provider)` | Un panel en árbol plegable (`PanelProvider`), solo en interfaces interactivas |
| `ui.select(request)` | Pide al usuario que elija (`SelectRequest`: `title`, `options` con `value`, `label`, `description?`); resuelve `undefined` sin interfaz interactiva |
| `ui.open(sessionId)` | Abre una sesión en una vista de solo lectura; devuelve `false` sin interfaz interactiva |
| `ui.interactive()` | `true` cuando una interfaz interactiva puede responder a `select` |
| `sessions.*` | Sesiones hijas, ver [más abajo](#child-sessions) |

Los plugins de proveedores dependen solo de `@alisio/sdk`. Su factoría recibe por separado el
`profile` sin secretos, las `credentials` secretas y valores heredados opcionales. El núcleo controla
la persistencia y la activación. La limpieza del registro participa en el rollback del plugin; si
falla la creación de un proveedor, el proveedor activo permanece intacto.

### Herramientas

```ts
interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  effect?: "read" | "write" | "process" | "external" | "internal";
  paths?: (input: Record<string, unknown>) => string[];
  concurrent?: boolean;
  execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}
```

`concurrent: true` permite que una llamada se ejecute a la vez que otras llamadas de lectura o
concurrentes del mismo turno (las herramientas de delegación lo usan). `ToolContext` proporciona
`signal`, `workspace`, `emit(data)` y `session`. Devuelva
`textResult(text, isError?)`. El efecto controla los permisos ([Herramientas y permisos](/es/tools)):
las operaciones desconocidas o de plugins usan `external` por defecto; declare `read` solo para
herramientas sin efectos secundarios.

### Resultados enriquecidos (bloques `ui`) {#ui-blocks}

Un resultado de herramienta puede añadir partes `{ type: "ui", block }` junto a su texto. Un
`UiBlock` son solo datos; los plugins nunca envían código de renderizado. Conserve siempre también
una parte de texto: los proveedores, la compactación y la salida headless solo ven la proyección de
texto, y el bloque es una indicación de presentación.

```ts
return {
  content: [
    { type: "text", text: "2 passed, 1 failed" },
    {
      type: "ui",
      block: {
        kind: "test-results",
        framework: "vitest",
        suites: [{ name: "math", cases: [{ name: "adds", status: "passed" }] }],
      },
    },
  ],
};
```

| Kind | Campos | Renderizado en la TUI |
| --- | --- | --- |
| `table` | `columns`, `rows`, `caption?` | Columnas alineadas |
| `key-value` | `entries`, `caption?` | Dos columnas |
| `tree` | `nodes` (`label`, `children?`, `meta?`) | Glifos de rama |
| `code` | `code`, `lang?`, `caption?` | Código resaltado |
| `markdown` | `text` | Markdown |
| `diff` | `patch?` o `before?`/`after?`, `path?`, `lang?`, `caption?` | Parche unificado como código `diff`; si no, `before`/`after` etiquetados |
| `terminal` | `output`, `command?`, `cwd?`, `exitCode?`, `durationMs?`, `truncated?` | Salida sin ANSI más `exit <código> · <tiempo>` |
| `mermaid` | `source`, `title?` | Fuente como código `mermaid` |
| `math` | `latex`, `display?` | LaTeX literal |
| `json` | `value`, `collapsedDepth?`, `caption?` | JSON indentado, truncado |
| `test-results` | `suites` (`name`, `file?`, `cases`), `framework?`, `durationMs?` | Tabla de suite, caso, estado y tiempo, más los fallos |
| `progress` | `steps` (`label`, `status`, `detail?`), `title?` | Una línea por paso con un glifo de estado |

`UI_BLOCK_KINDS` lista todos los kinds. Acote los tamaños (unos 200 KB para un diff y 256 KB para la
salida de terminal o el JSON serializado). Un kind que la versión de Alisio en ejecución no conoce, o
un bloque mal formado, se muestra como JSON etiquetado en lugar de fallar, de modo que versiones
anteriores pueden reproducir transcripciones más nuevas.

### Reglas de nombres y prefijos

| Elemento | Plugin externo | Plugin integrado |
| --- | --- | --- |
| Nombre de herramienta | `p_<hash>_<name>` (10 caracteres hexadecimales del SHA-256 del ID del plugin), para evitar colisiones y cumplir los límites de nombres del proveedor | Sin prefijo |
| Comando | `<plugin id>:<name>`, invocado como `/command acme.hello:name args` o `/acme.hello:name`; también desde `alisio run "/acme.hello:name args"`, que imprime el resultado sin llamar al modelo (`--json` imprime una línea `command_result`), y desde la paleta web | Sin prefijo (por ejemplo `/memory`) |
| Efecto `internal` | Se degrada a `external` | Permitido |

### Hooks de compactación {#compaction-hooks}

```ts
export default definePlugin({
  id: "my.notes",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    api.compaction.register({
      async beforeCompact() {
        return { outputFields: { notes: "array of short strings worth keeping" } };
      },
      async afterCompact({ extracted }) {
        const notes = Array.isArray(extracted.notes) ? extracted.notes : [];
        return { report: { summary: `notes: ${notes.length}` } };
      },
    });
  },
});
```

- `beforeCompact(input)` recibe `sessionId`, `reason` (`manual` o `auto`), los `messages` que van a
  reemplazarse, `focus` y `signal`. Puede devolver `instructions` (añadidas a las instrucciones del
  resumidor) y `outputFields` (campos JSON adicionales de primer nivel, nombre → descripción,
  solicitados en la misma llamada al resumidor).
- `afterCompact(result)` recibe además `model`, `replaced`, `structured`, `checkpoint`,
  `checkpointText` y `extracted` (los campos de este plugin, **sin validar**: valídelos usted mismo).
  Puede devolver `injectContext` (texto añadido tras el checkpoint; manténgalo dentro de un
  presupuesto) y `report` (`summary` se muestra literalmente).

### Hooks de sesión y completados del modelo

```ts
api.session.onStart(async (info) => `Project notes for ${info.workspace}`);
api.session.onEnd(async (info) => {
  const summary = await api.model.complete({
    system: "Summarize the session in one sentence.",
    messages: [{ role: "user", text: `${info.messages.length} messages` }],
    maxTokens: 200,
    signal: info.signal,
  });
  api.state.set("lastSummary", summary);
});
```

`SessionInfo` contiene `sessionId`, `model`, `workspace`, `reason` (`start`, `clear` o `exit`),
`messages` y `signal`. `model.complete` usa el proveedor configurado (el modelo de la sesión cuando el
plugin lo pasa) y no descuenta del presupuesto `limits.maxTokens`.

### Puerto de almacenamiento

```ts
const db = api.storage.sqlite("/path/to/notes.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
db.transaction(() => db.prepare("INSERT INTO notes (text) VALUES (?)").run("hello"));
const rows = db.prepare("SELECT * FROM notes").all();
```

`SqlDatabase` es síncrono: `exec(sql)`, `prepare(sql)` (las sentencias se cachean por texto SQL y
ofrecen `run`, `get`, `all`), `transaction(fn)` (transacción inmediata; las llamadas anidadas se unen
a la exterior) y `close()`. FTS5 está disponible. El host proporciona el driver, por lo que los
plugins nunca dependen de un runtime concreto.

### Vistas de datos {#data-views}

Una vista de datos es una función con nombre que devuelve JSON para una sesión y que los hosts leen
sin ejecutar una herramienta. `alisio serve` las expone a la interfaz web (el plugin de memoria
integrado alimenta así la [pestaña Memoria](/es/web#memory-tab)).

```ts
import { definePlugin } from "@alisio/sdk";

export default definePlugin({
  id: "notes",
  version: "1.0.0",
  apiVersion: 1,
  setup(api) {
    // `views` is absent on an older core: feature-detect it and keep working without it.
    api.views?.register({
      id: "recent",
      description: "Recent notes of the session",
      params: {
        type: "object",
        properties: { limit: { type: "integer", minimum: 1, maximum: 50, default: 20 } },
      },
      // `params` is already validated and coerced; `loadNotes` is your own storage code.
      handler: (params, { sessionId }) => ({ items: loadNotes(sessionId, Number(params.limit)) }),
    });
  },
});
```

- `id` son letras minúsculas, dígitos y guiones (hasta 40 caracteres) y es único dentro del plugin;
  `description` es obligatoria. `params` es un objeto JSON Schema de primitivos (`string`,
  `integer`, `number`, `boolean`; sin `$ref`) cuyas claves desconocidas se rechazan. Las cadenas de
  consulta se convierten a los tipos declarados y se aplican los valores por defecto antes de
  ejecutar `handler(params, { sessionId, workspace, signal })`. `ViewParamsError` convierte un
  parámetro que el esquema no puede expresar en un `400`.
- Por HTTP una vista es `GET /api/sessions/:sid/views/:plugin/:view?<params>`, con la misma cookie
  de sesión y las mismas reglas de Host y Origin que el resto de rutas. Solo responden los plugins
  habilitados, la sesión debe existir y su workspace también, y una vista de otro plugin o de uno
  deshabilitado es un `404`. Se aceptan como máximo 16 parámetros de consulta de 512 caracteres.
- La respuesta es JSON de como máximo 1 MiB (`view_too_large`, 502) y el handler tiene 5 segundos
  (`view_timeout`, 504; `signal` aborta). Cualquier otro fallo es un `view_failed` genérico (502):
  su mensaje y los parámetros nunca se envían ni se registran, porque pueden contener datos del
  proyecto.
- **Las vistas son de solo lectura por contrato, no por aislamiento.** El host solo controla el
  método, los parámetros validados, el tiempo y el tamaño; no puede impedir que el código de un
  plugin escriba, y un handler que bloquee el bucle de eventos no se interrumpe con el timeout. Un
  plugin no es un sandbox.

### Decision Intelligence, rutas y opciones {#decision-intelligence}

`api.decisions`, `api.paths` y `api.options` son **opcionales**: un núcleo anterior los omite, así
que detecte cada uno por presencia y siga funcionando sin él.

```ts
setup(api) {
  api.decisions?.registerProvider(myProvider); // Registering never activates it.
  const cache = api.paths?.cache; // Per-plugin directory, created on first read.
  const device = api.options?.device ?? "cpu"; // From `pluginOverrides[id].options`.
}
```

- **`api.decisions`** registra un proveedor de decisiones y permite que una herramienta de plugin
  pida decisiones. El usuario activa un proveedor con `decisions.provider` en la configuración
  global; instalar el plugin no basta. El contrato, los errores y el ciclo de vida están en
  [Decision Intelligence](/es/decision-intelligence#writing-a-provider). Las herramientas reciben el
  lado consumidor como `context.decisions?.tryDecide(...)`, ligado a la ejecución actual.
- **`api.paths`** ofrece `state` (`<raíz de estado>/plugins/<id>`), `config`
  (`<config home>/plugins/<id>`) y `cache` (`<raíz de estado>/plugins/<id>/cache`). La raíz de estado
  es la que usan el análisis y los artefactos, así que respeta `--db`. Úselas en lugar de resolver
  usted mismo las rutas XDG o `ALISIO_*`.
- **`api.options`** contiene el JSON que usted o el usuario pusieron en `pluginOverrides[id].options`
  de la configuración global (consulte [`pluginOverrides`](/es/configuration#plugins)). Es solo
  global, de como máximo 8 KB, y una instantánea tomada en `setup`: cambiarlo requiere reiniciar. No
  guarde secretos ahí.

### Sesiones hijas {#child-sessions}

`api.sessions` es un servicio genérico para trabajo delegado: una sesión hija es una conversación
separada y persistida (contexto nuevo) con un vínculo a su padre, ejecutada por el mismo runner con
permisos **reducidos**. Un hijo nunca puede obtener una capacidad, herramienta o aprobación que su
padre no tenga, y abortar la ejecución de un padre aborta sus descendientes en ejecución. El núcleo no
contiene lógica de agentes; el plugin de [subagentes](/es/subagents) está construido sobre este
servicio.

| Miembro | Descripción |
| --- | --- |
| `spawn(spec)` | Crea una sesión hija (`ChildSessionSpec`) y devuelve `ChildSessionInfo` |
| `create(spec)` | Resuelve `spec.model`, si existe, y crea un hijo vinculado al proveedor; úselo para reemplazos de modelo |
| `run(id, prompt, { signal? })` | Ejecuta un turno en el hijo; resuelve un `ChildRunResult` (`status`, `text`, `usage`, `error?`) |
| `get(id)`, `children(parentId)` | Información de la sesión (`id`, `parentId`, `depth`, `agent`, `title`, `status`, `model`, `workspace`, `usage`, `capabilities`, marcas de tiempo) |
| `ancestors(id)` | IDs de los ancestros, del más cercano al más lejano |
| `cancel(id)` | Cancela una ejecución y todos sus descendientes en ejecución; devuelve cuántos estaban en ejecución |
| `enqueue(id, text)` | Encola un mensaje de usuario para el siguiente turno de la sesión (o la siguiente ejecución si está inactiva) |
| `isRunning(id)` | Si la sesión está en ejecución |
| `capabilities(id)` | `write`, `process`, `approvals` y `readOnly` efectivos |
| `model(id)`, `workspace(id)` | Modelo que heredaría un hijo nuevo; workspace de la sesión |
| `setStatus(id, status)` | Establece un `SessionStatus`: `queued`, `running`, `completed`, `failed`, `cancelled` o `interrupted` |

Campos de `ChildSessionSpec`: `parentId`, `id?`, `title`, `agent` (etiqueta que se muestra en las
interfaces y las aprobaciones), `instructions?`, `tools?: { allow?, deny? }` (`*` permite todas las
herramientas del padre), `model?`, `readOnly?`, `permission?: { write?, process? }` (`allow`, `ask`
o `deny`), `workspace?` (por ejemplo, un worktree de git), `maxTurns?`, `timeoutMs?` y `maxTokens?`.

`sessions.run` resuelve con `{ id, status, text, usage, error? }`. Un hijo que agota su tope de
turnos NO es un fallo: resuelve con `status: "completed"` y `turnsExceeded: true`, y `text` contiene
un informe parcial utilizable (solo los errores reales, las cancelaciones y los tiempos de espera
producen un estado de fallo).

```ts
api.tools.register({
  name: "second_opinion",
  description: "Ask a read-only child session to review a file.",
  effect: "external",
  concurrent: true,
  inputSchema: {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    if (!ctx.session) return textResult("needs a session", true);
    const child = api.sessions.spawn({
      parentId: ctx.session,
      title: `Review ${String(input.path)}`,
      agent: "reviewer",
      instructions: "Review the file and report bugs only.",
      tools: { allow: ["read_file", "search_text"] },
      readOnly: true,
      maxTurns: 10,
    });
    const result = await api.sessions.run(child.id, `Review ${String(input.path)}`, {
      signal: ctx.signal,
    });
    return textResult(result.text || result.error || result.status, result.status !== "completed");
  },
});
```

`PanelProvider` tiene un `title`, `nodes({ sessionId })`, que devuelve `PanelNode`s (`id`,
`parentId?`, `label`, `color?`, `status`, `startedAt?`, `endedAt?`, `tokens?`, `detail?`,
`sessionId?`), y un `action("cancel" | "background", nodeId, { sessionId })` opcional.

### Timeouts de hooks y aislamiento de fallos

- Los hooks de compactación y de inicio de sesión se ejecutan con `pluginHooks.timeoutMs` (por
  defecto 15 000 ms); los de fin de sesión, con `pluginHooks.sessionEndTimeoutMs` (por defecto
  10 000 ms).
- Cada hook recibe un `AbortSignal` que se aborta cuando vence el tiempo límite.
- Un fallo o timeout se registra como evento `plugin_hook_failed` y el núcleo continúa sin la
  contribución de ese plugin.
- Los hooks se ejecutan en el mismo proceso: el timeout detiene la espera y señala el `AbortSignal`,
  pero no puede detener código síncrono bloqueante.

### Cierre {#shutdown}

- `dispose()` se ejecuta cuando Alisio se cierra: salir de la interfaz de terminal, `SIGINT`,
  `SIGTERM` y `SIGHUP` (interfaz de terminal, `alisio serve` y `alisio run`) y el final de una
  ejecución. **No** se ejecuta al deshabilitar un plugin ni con `/reload`, porque ambos requieren
  reiniciar.
- Los plugins se liberan en paralelo y cada uno está limitado por `pluginHooks.disposeTimeoutMs`
  (2000 ms por defecto, de 100 a 10000); un `dispose()` lento o colgado no retrasa a los demás, y su
  fallo se informa sin detenerlos. Termine con holgura dentro de ese límite.
- Una muerte súbita (`SIGKILL`, una caída) no puede cubrirse: un plugin que posee un proceso del
  sistema operativo debe limpiar por sí mismo los que queden huérfanos.

## Puntos de extensión {#extension-points}

Los puntos de extensión permiten que un plugin reemplace una parte del host con su propio proveedor.
Están tipados en `ExtensionPoints`; los puntos nuevos se añaden ahí sin romper los existentes.

| Punto | Tipo de proveedor | Por defecto |
| --- | --- | --- |
| `mascot` | `MascotProvider`: `{ id, render(ctx: MascotContext) }` que devuelve un `string` o `string[]` | `DefaultAlisioMascot` (`alisio.default`) |
| `startup-screen` | `StartupScreenProvider`: `{ id, render(ctx: StartupContext): string[] }` | `DefaultStartupScreen` (`alisio.default`) |
| `websearch` | `SearchProvider`: `{ id, search(query, options?: { signal? }): Promise<SearchResult[]> }`, `SearchResult = { title, url, snippet }` | La cadena integrada: un `websearch.provider` configurado, o si no una instancia pública de SearXNG (véase [Herramientas y permisos](/es/tools#websearch)) |

Registre un proveedor de forma imperativa, o declárelo en el objeto del plugin:

```ts
import { definePlugin } from "@alisio/sdk";
import { kiteMascot } from "./kite.js";

// Imperative, with a priority
export default definePlugin({
  id: "kite-mascot",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    const dispose = api.extensions.register("mascot", kiteMascot, { priority: 10 });
    // dispose() unregisters it; everything is also removed when the plugin unloads.
  },
});

// Declarative, at priority 0
export const declarative = definePlugin({
  id: "kite-mascot-declarative",
  version: "0.1.0",
  apiVersion: 1,
  extensions: { mascot: kiteMascot },
  setup() {},
});
```

- `api.extensions.register(point, provider, { priority })` devuelve una función que anula el
  registro. `priority` es un número finito, `0` por defecto; un proveedor necesita un `id` (lo
  único que comparten todos los puntos); un punto renderizable como `mascot` además necesita un
  `render` que funcione, comprobado cuando el host lo llama de verdad, igual que hoy un `render`
  que lanza excepción ya recurre al valor por defecto.
- El campo declarativo `Plugin.extensions` es azúcar sintáctico para
  `api.extensions.register(point, provider)` con prioridad `0`, aplicado antes de ejecutar `setup`.

### Resolución

Para cada punto, el host elige exactamente un proveedor, de forma determinista:

1. la mayor `priority`;
2. después, el `id` del plugin en orden lexicográfico (los plugins se identifican por `id`, no por el
   nombre del paquete);
3. después, el orden de registro dentro del mismo plugin.

El orden de carga entre plugins nunca influye. Los valores por defecto integrados solo se usan cuando
no hay nada registrado, o como reemplazo de un proveedor que falla. Cuando varios proveedores empatan
en la prioridad ganadora, el host informa un diagnóstico `extension_conflict` con `point`, `winner` y
`losers` (como IDs `plugin/provider`). Los conflictos y los proveedores resueltos se muestran en
`/stats` y en `alisio plugins doctor`:

```sh
alisio plugins doctor --plugin ./dist/index.js
```

### Contextos tipados

| Tipo | Campos |
| --- | --- |
| `TerminalCapabilities` | `color` (ANSI SGR permitido), `unicode` (no ASCII permitido), `columns`, `interactive` |
| `MascotContext` | `terminal`, `version` |
| `PluginMetadata` | `id`, `version`, `builtin` |
| `StartupFact` | `label`, `value` |
| `StartupContext` | `version`, `cwd` (ya abreviado), `model?`, `provider?` (solo el host, nunca credenciales), `userName?`, `terminal`, `plugins` (`PluginMetadata[]`), `mascot` (la mascota resuelta y validada), `tips`, `facts?` (datos del host como el acceso y el estado de la memoria) |

`StartupContext.mascot` siempre puede llamarse con seguridad: una pantalla personalizada puede
reutilizar la mascota ganadora.

### Reglas de seguridad

- Los proveedores reciben **solo su contexto**: no deben leer globales, variables de entorno ni el
  sistema de archivos. Respete `terminal.color`, `terminal.unicode` y `terminal.columns`.
- Un proveedor que lanza una excepción, devuelve algo distinto de un string o un array de strings,
  devuelve demasiadas líneas (12 para una mascota, 60 para una pantalla) o tarda más de 250 ms se
  reemplaza por el valor por defecto, y se registra un diagnóstico `plugin_hook_failed`. El
  renderizado es síncrono, así que un proveedor lento no puede interrumpirse: su salida se descarta
  después.
- La salida se sanea: solo se conservan las secuencias de color SGR, y solo cuando `color` es true; se
  eliminan las demás secuencias de escape y los caracteres de control; los tabuladores se convierten
  en espacios; los caracteres no ASCII se convierten en `?` cuando `unicode` es false. Cada línea se
  recorta a `columns`.
- La pantalla por defecto se construye con funciones de sección reutilizables que exporta
  `@alisio/core`: `titleSection`, `welcomeSection`, `infoSection`, `pluginsSection`, `tipsSection`,
  `mascotSection`, `composeSideBySide`, `shortenPath` y `startupTips` (determinista para una semilla
  dada). Muestra la mascota junto a la información cuando la terminal es lo bastante ancha, y apiladas
  en caso contrario.

### Ejemplo: mascota cometa

El repositorio incluye un paquete de ejemplo en
[`examples/plugins/custom-mascot`](https://github.com/GustavoGutierrez/alisio/tree/main/examples/plugins/custom-mascot)
(`alisio-plugin-kite-mascot`, `id` de plugin `kite-mascot`). Solo depende de `@alisio/sdk`
(dependencia peer) y distribuye JavaScript.

```ts
import { definePlugin, type MascotProvider, type StartupScreenProvider } from "@alisio/sdk";

/** A kite riding the trade winds. Honors unicode/color/columns from the context only. */
export const kiteMascot: MascotProvider = {
  id: "kite",
  render({ terminal }) {
    if (terminal.columns < 40) return terminal.unicode ? "◇~ kite" : "<>~ kite";
    const art = terminal.unicode
      ? ["   ◢◣", "  ◢██◣", "  ◥██◤", "   ◥◤", "    ╲", "     ∿∿"]
      : ["   /\\", "  /  \\", "  \\  /", "   \\/", "    \\", "     ~~"];
    return terminal.color ? art.map((line) => `\u001b[35m${line}\u001b[0m`) : art;
  },
};

/** Optional compact screen that reuses whichever mascot won resolution. */
export const compactScreen: StartupScreenProvider = {
  id: "kite.compact",
  render(ctx) {
    const mascot = [ctx.mascot.render({ terminal: ctx.terminal, version: ctx.version })].flat();
    return [
      ...mascot,
      `Alisio ${ctx.version} · ${ctx.model ?? "no model"} · ${ctx.plugins.length} plugin(s)`,
      ...ctx.tips.slice(0, 1),
    ];
  },
};

export default definePlugin({
  id: "kite-mascot",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    // Priority 10 beats plugins registering at the default priority 0.
    api.extensions.register("mascot", kiteMascot, { priority: 10 });
    // Uncomment to also replace the whole startup screen:
    // api.extensions.register("startup-screen", compactScreen);
  },
});
```

```sh
npm run build
alisio --plugin ./examples/plugins/custom-mascot/dist/index.js
```

### Ejemplo: proveedor de búsqueda personalizado

[`examples/plugins/custom-websearch`](https://github.com/GustavoGutierrez/alisio/tree/main/examples/plugins/custom-websearch)
(`alisio-plugin-brave-websearch`, `id` de plugin `brave-websearch`) envuelve
[Brave Search](https://api.search.brave.com/) con una clave de API proporcionada por el usuario
mediante el punto de extensión `websearch` — una referencia copiable para "traiga su propio motor
de búsqueda":

```ts
import { definePlugin, type SearchProvider, type SearchResult } from "@alisio/sdk";

export function braveSearchProvider(apiKey: string): SearchProvider {
  return {
    id: "brave-example",
    async search(query, options): Promise<SearchResult[]> {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", query);
      const res = await fetch(url, {
        headers: { "X-Subscription-Token": apiKey, Accept: "application/json" },
        signal: options?.signal,
      });
      if (!res.ok) throw new Error(`Brave Search request failed: HTTP ${res.status}`);
      const body = await res.json();
      return (body.web?.results ?? []).map((r: { title?: string; url?: string; description?: string }) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.description ?? "",
      }));
    },
  };
}

export default definePlugin({
  id: "brave-websearch",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    const apiKey = process.env.BRAVE_SEARCH_API_KEY;
    if (!apiKey) throw new Error("brave-websearch: set BRAVE_SEARCH_API_KEY");
    api.extensions.register("websearch", braveSearchProvider(apiKey), { priority: 10 });
  },
});
```

```sh
npm run build
export BRAVE_SEARCH_API_KEY=...
alisio --plugin ./examples/plugins/custom-websearch/dist/index.js --allow-external
```

## Cargar plugins {#loading-plugins}

Los plugins solo se cargan desde orígenes de confianza explícita. Alisio nunca instala ni descarga
plugins.

| Origen | Confianza |
| --- | --- |
| `--plugin <path>`, `--plugin <package>` | Confianza explícita en esa entrada y sus dependencias |
| `plugins` en el archivo de configuración | El propio archivo es de confianza (configuración global, `--config` o `--trust-project`) |
| `<config home>/plugins/` (archivos o directorios) | Plugins globales: código personal de confianza |
| `<workspace>/.alisio/plugins/` | Solo con `--trust-project` |

```sh
alisio --plugin ./my-plugin.js
alisio --plugin alisio-plugin-foo
```

```json
{ "plugins": ["alisio-plugin-foo"] }
```

`--read-only` desactiva los plugins ejecutables (externos). Los plugins integrados no se ven afectados.

**Resolución.** Una entrada con forma de ruta (empieza por `.`, es absoluta, contiene `\`, termina en
una extensión JS/TS, o contiene `/` sin empezar por `@`) es un archivo o directorio. Cualquier otra
cosa es un nombre de paquete npm, que se busca en `node_modules` desde el directorio del proyecto
hacia arriba y después en las raíces globales: las entradas de `NODE_PATH` y el prefijo global del
Node/npm en ejecución.

**La palabra clave `alisio-plugin` es obligatoria.** Un paquete sin `"keywords": ["alisio-plugin"]` en
su `package.json` se rechaza, para que un error tipográfico no cargue un paquete no relacionado. La
entrada se toma de `exports["."]` (condiciones `import`, `node` o `default`), después de `main` y, por
último, de `./index.js`.

Un directorio indicado como ruta debe contener un manifiesto `alisio-plugin.json` que declare su
entrada (un paquete también puede incluirlo); la entrada debe permanecer dentro del directorio:

```json
{ "apiVersion": 1, "entry": "./index.js" }
```

Compruebe lo que registra un plugin con:

```sh
alisio plugins list
alisio plugins doctor --plugin ./my-plugin.js
```

## Instalar plugins desde npm {#installing-plugins-from-npm}

La CLI puede instalar un paquete npm en el directorio GLOBAL de plugins de Alisio
(`<config home>/plugins`, por ejemplo `~/.config/alisio/plugins`) y registrar su NOMBRE npm en el
array `plugins` de la configuración global — la misma entrada que hoy puedes escribir a mano:

```sh
alisio install npm:plugin-openrouter          # última versión
alisio install npm:@scope/plugin-x@1.2.3      # una versión fijada
alisio install plugin-openrouter              # el nombre pelado es igual que npm:
alisio install npm:plugin-openrouter --update # actualiza un plugin instalado a @latest
```

La especificación se valida antes de cualquier operación de red: `npm:<paquete>[@<versión>]`, o un
nombre de paquete pelado; solo se permiten letras, dígitos, `.`, `_`, `-`, más `/` para nombres
scoped y `@` para una versión. Los prefijos desconocidos (`git:`, `file:`, URLs `registry:`, ...) se
rechazan con un error claro. **Un fallo de instalación nunca vuelve a ejecutar npm en silencio** y la
salida de npm fallida se sanea (sin tokens/secretos); el error nombra el paquete y el comando de
reintento exacto.

**Dónde aterriza.** El paquete se instala con `npm install --prefix <config home>/plugins` en
`<config home>/plugins/node_modules/<paquete>` y su NOMBRE (nunca la ruta resuelta en el filesystem)
se añade al array `plugins` de `<config home>/config.json` (escritura atómica, campos no relacionados
conservados, sin duplicados). `alisio plugins list` muestra los paquetes instalados junto a los
plugins de archivos/directorios.

| Aspecto | Comportamiento |
| --- | --- |
| Alcance global | Una instalación sirve a todos los proyectos desde los que ejecutes Alisio |
| Carga | El plugin se carga como código ejecutable en proceso dondequiera que carguen los plugins globales; debe declarar la keyword `alisio-plugin` para poder cargarse |
| Confianza del proyecto | La configuración y los plugins PROPIOS de un proyecto solo cargan en proyectos de confianza (`--trust-project` o el aviso de confianza de una sola vez) |
| `--read-only` | Se rechaza instalar y el plugin nunca carga (los plugins ejecutables están desactivados) |
| Reinstalación | Si el paquete ya está instalado, el comando lo indica y sugiere `--update` en lugar de volver a ejecutar npm |
| Scripts | `npm install` puede ejecutar scripts de ciclo de vida del paquete con tus privilegios — Alisio avisa y exige confirmación en terminal interactiva |
| Headless / `--json` | Nunca pregunta: sin un `--yes` explícito (o `--trust-plugin`) falla con un error accionable antes de ejecutar npm |
| Errores | Salida npm saneada, nombre del paquete y comando de reintento exacto en el mensaje final |

La instalación es una acción global del usuario: no concede nada a ningún proyecto. La carga sigue la
política existente de plugins ejecutables — el aviso de confianza de una sola vez (o `--trust-project`)
es lo que permite a un proyecto cargar su propia configuración y plugins, y `--read-only` desactiva
los plugins ejecutables por completo.

### El agente puede instalar un plugin por ti

En la TUI, el modelo puede instalar un plugin a petición mediante la herramienta del host
`plugin_install`: valida la especificación, ejecuta la **misma** rutina de instalación que
`alisio install` y responde con el nombre del paquete, la versión instalada, la entrada de
configuración y la ruta, más la nota de confianza. La herramienta usa el efecto `process`, así que
pasa por la compuerta de permisos habitual — el aviso de aprobación en la TUI, o `--allow-process`
en headless — y nunca está disponible con `--read-only`. Consulte
[Herramientas y permisos](/es/tools#plugin-install).

```text
Tú:    instala el plugin plugin-openrouter
Agente: (llama a plugin_install con spec "npm:plugin-openrouter", tú lo apruebas)
Agente: Instalado el plugin "plugin-openrouter" v1.2.3 en
        ~/.config/alisio/plugins/node_modules/plugin-openrouter y añadido al array
        "plugins" de ~/.config/alisio/config.json. El plugin carga como código
        personal de confianza; --read-only impide que cargue. Ejecuta `alisio plugins
        list` para inspeccionarlo.
```

## Plugins TypeScript

- Los plugins publicados en npm **deben distribuir JavaScript**.
- Los plugins `.ts` locales cargados con `--plugin` funcionan en Bun (y en el binario independiente) y
  en Node.js >= 22.18 mediante type stripping, que solo admite sintaxis borrable (sin `enum`,
  `namespace` ni parameter properties).
- En versiones anteriores de Node.js, Alisio falla con un error claro que pide Bun, Node.js >= 22.18 o
  una compilación a JavaScript.

## Paquete de plugin de ejemplo

```text
alisio-plugin-hello/
├── package.json
├── tsconfig.json
└── src/
    └── index.ts
```

`package.json`:

```json
{
  "name": "alisio-plugin-hello",
  "version": "0.1.0",
  "description": "Example Alisio plugin",
  "keywords": ["alisio-plugin"],
  "license": "MIT",
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "prepublishOnly": "npm run build"
  },
  "peerDependencies": {
    "@alisio/sdk": "^0.2.0"
  },
  "devDependencies": {
    "@alisio/sdk": "^0.2.0",
    "typescript": "^5.9.0"
  }
}
```

Usa la última versión publicada de `@alisio/sdk` al crear tu propio plugin — consulta
`npm view @alisio/sdk version` para saber cuál es. Los plugins deben declarar `@alisio/sdk` como
dependencia **peer** con `^0.2.0`: mientras Alisio sea 0.x, un rango con circunflejo solo acepta su
propia versión menor, porque una versión menor nueva puede incluir cambios incompatibles, así que
adoptas cada versión menor de forma explícita. Un plugin que deba funcionar con ambas líneas puede
declarar `"^0.1.0 || ^0.2.0"`; los plugins publicados para 0.1 (como `@alisio/plugin-deepseek`)
declaran `^0.1.0` hasta que se actualicen.

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

`src/index.ts`:

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
  version: "0.1.0",
  apiVersion: 1,
  setup(api) {
    let greetings = 0;

    api.tools.register({
      name: "hello",
      description: "Greets a person by name.",
      effect: "read",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      async execute(input) {
        greetings += 1;
        api.ui.status("greetings", `hello ${greetings}`);
        return textResult(`Hello, ${String(input.name)}!`);
      },
    });

    api.commands.register("greetings", async () => `Greetings so far: ${greetings}`, {
      description: "Show how many greetings were sent",
    });
  },
});
```

Compílelo y pruébelo:

```sh
npm install
npm run build
alisio --plugin ./dist/index.js         # local build, as an explicit path
npm publish                             # then: npm i -g alisio-plugin-hello
alisio --plugin alisio-plugin-hello     # or add it to "plugins" in the configuration
```

En la TUI el comando está disponible como `/acme.hello:greetings`, y el modelo ve la herramienta con su
nombre con prefijo.
