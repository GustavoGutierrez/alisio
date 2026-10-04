# Writing plugins

A plugin is an ES module whose default export is a `Plugin` object. The contract lives in
[`@alisio/sdk`](https://www.npmjs.com/package/@alisio/sdk): types plus two helpers
(`definePlugin`, `textResult`), with no runtime dependencies and no provider SDKs.

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

::: danger Plugins are trusted code
Plugins run in-process with the full privileges of the Alisio process. A plugin manifest or a
subprocess is not a sandbox, and the `effect` field does not isolate anything. Only load code you
trust.
:::

## The `Plugin` object

| Member | Description |
| --- | --- |
| `id` | Unique ID matching `^[a-z0-9][a-z0-9.-]{0,63}$`, for example `acme.hello` |
| `version` | SemVer, for example `0.1.0` or `0.1.0-beta.1` |
| `apiVersion` | Always `1` |
| `name`, `description` | Optional human-friendly catalog text used by `/plugins` |
| `categories` | Optional catalog categories (see [Plugin categories](#plugin-categories)). The host also derives `model-provider` from provider registrations |
| `setup(api)` | Registers everything; may be async. If it fails, partial registrations are rolled back |
| `extensions` | Optional; declarative providers for [extension points](#extension-points), registered at priority 0 |
| `dispose()` | Optional; releases resources when Alisio closes. It runs only on close, never when a plugin is disabled or on `/reload`, and is limited by `pluginHooks.disposeTimeoutMs` (see [Shutdown](#shutdown)) |

`definePlugin` is an identity function that only adds typing. Duplicate plugin IDs are rejected.

## Plugin categories

`categories` is a list of catalog groupings. The TUI groups `/plugins` rows by the first declared
category and falls back to "General" when a plugin declares none; the detail view lists every
category. Plugin authors may declare any accepted value; the host only ever derives
`model-provider` by itself, from provider registrations. Categories describe what a plugin does,
so a single plugin may declare several.

| Category | Meaning | Used by built-ins |
| --- | --- | --- |
| `model-provider` | Registers model providers | `openai-compatible` |
| `methodology-harness` | Bundles a development-methodology workflow | — |
| `memory` | Persistent memory, recollection and session summaries | `memory` |
| `subagents` | Delegation, child sessions and agent management | `subagents` |
| `search` | Web or vector search providers | — |
| `tools` | General-purpose tool collections | — |
| `security` | Audit, sandbox or permission tooling | — |
| `analytics` | Usage/metrics instrumentation (session stats, cost tracking) | — |
| `mcp` | MCP-server management or bundling helpers | — |
| `storage` | Durable storage backends beyond the default SQLite state | — |
| `ui` | TUI presentation providers (startup screens, mascots, panels) | — |
| `decisions` | [Decision Intelligence](/decision-intelligence) providers (`api.decisions.registerProvider`) | — |

The only built-in model provider is `openai-compatible`. Dedicated providers (DeepSeek, OpenCode
Console (Zen), OpenCode Go) are separate plugins published from the
[alisio-plugins](https://github.com/GustavoGutierrez/alisio-plugins) monorepo and installed with
`alisio install npm:@alisio/plugin-{deepseek,opencode,opencode-go}`; once installed they register
as `model-provider` plugins and appear in `/connect` and `/model`.

## Managing plugins in the TUI

Run `/plugins` to open the filterable catalog. `[x]`, `[ ]`, `[!]` and `[*]` mean
active, inactive, failed and restart required; rows also distinguish built-ins from safe external
source labels. Select a row for its full description, category and available action.

Toggles update the current project's `.alisio/config.json` atomically and preserve unrelated JSON
fields. They deliberately take effect on the next Alisio start: live registrations, hooks, storage
and provider clients are not partially removed. Returning a toggle to its original runtime state
clears `restart-required`. External plugins require a trusted project and an explicit confirmation
because they execute with full process privileges. Alisio blocks disabling a model-provider plugin
while the active provider or any live routed session retains it, and blocks plugins that own current
session resources. Switch provider and close retained sessions, or restart Alisio, first. Provider
profiles and credentials remain global settings and are never copied into plugin configuration.

## `PluginAPI` reference

Every `register`/`on` method returns an unregister function. Everything a plugin registers is
removed automatically when it is unloaded.

| Member | Description |
| --- | --- |
| `tools.register(tool)` | Registers a tool (`ToolDefinition`) |
| `commands.register(name, handler, options?)` | Registers a command; `handler(args: string, context?: { sessionId? }) => Promise<string>` returns the text shown to the user (`sessionId` is the interactive UI's current session, when known). `options`: `{ description?, argumentHint? }`, shown in `/help` and autocompletion |
| `events.on(handler)` | Observes versioned run events (`RunEvent`: `schemaVersion`, `runId`, `sessionId`, `seq`, `type`, `timestamp`, `data`, plus the optional `eventId` and `correlationId`). `KnownRunEvent` types the `data` of every [event the core emits](/architecture#run-events) |
| `context.register(provider)` | `() => Promise<string>`; adds text to the model context |
| `resources.skills(path)` | Adds an Agent Skills root (relative to the plugin file) |
| `resources.agents(path)` | Adds a directory of agent definitions for delegation plugins (see [Subagents](/subagents#discovery-and-precedence)) |
| `resources.list(kind)` | Directories registered by every plugin for `skills`, `prompts` or `agents`, with the plugin ID |
| `resources.prompts(path)` | Adds a directory of [prompt templates](/prompt-templates#templates-from-plugins) (`*.md`, relative to the plugin file) |
| `state.get(key)` / `state.set(key, value)` | Small JSON state per plugin, persisted in the session database |
| `storage.sqlite(path)` | Opens a private (0600) SQLite file, creating parent directories (0700). Returns the storage port `SqlDatabase` |
| `views.register(view)` | Registers a named, read-only [data view](#data-views) hosts such as the web UI can read. Absent on a core that predates it: use `api.views?.register(...)` |
| `decisions.registerProvider(provider)` | Registers a [Decision Intelligence](/decision-intelligence) provider (it does not activate it); also `available()`, `activeProvider()` and `tryDecide(request, options?)`. Absent on a core that predates it: use `api.decisions?.registerProvider(...)` |
| `paths` | `{ state, config, cache }`: per-plugin directories resolved by the host and created with mode `0700` on first read. Absent on a core that predates it |
| `options` | Read-only `pluginOverrides[id].options` (or `{}`), frozen when `setup` runs. Absent on a core that predates it |
| `compaction.register({ beforeCompact, afterCompact })` | Compaction hooks, see below |
| `session.onStart(handler)` | Returned text is injected once at the start of a new, empty session (persisted in the session) |
| `session.onEnd(handler)` | Called when an interactive session ends (`/clear`, `/exit`, quit) |
| `model.complete(request)` | Provider-agnostic text completion: `{ system, messages, maxTokens?, model?, signal? }` → `Promise<string>` |
| `models.list()` / `models.resolve(reference)` | Lists credential-free configured models and resolves canonical `provider/model` or a unique bare ID |
| `providers.register(provider)` | Adds provider metadata, configuration/auth fields, capabilities and a factory. Registrations coexist; `/connect` selects one |
| `extensions.register(point, provider, options?)` | Provides an implementation for an [extension point](#extension-points) (`mascot`, `startup-screen`); `options`: `{ priority? }` |
| `ui.status(key, text, detail?)` | Short status text in the TUI status bar; `detail` appears in `/stats`; `text: undefined` clears it |
| `ui.panel(id, provider)` | A collapsible tree panel (`PanelProvider`), interactive UIs only |
| `ui.select(request)` | Asks the user to choose (`SelectRequest`: `title`, `options` with `value`, `label`, `description?`); resolves `undefined` without an interactive UI |
| `ui.open(sessionId)` | Opens a session in a read-only view; returns `false` without an interactive UI |
| `ui.interactive()` | `true` when an interactive UI can answer `select` |
| `sessions.*` | Child sessions, see [below](#child-sessions) |

Provider plugins depend only on `@alisio/sdk`. Their factory receives separate non-secret `profile`,
secret `credentials`, and optional legacy values. Core owns persistence and activation. Registration
cleanup participates in plugin rollback; failed provider creation leaves the active provider intact.

### Tools

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

`concurrent: true` lets a call run concurrently with other read or concurrent calls of the same turn
(the delegation tools use it). `ToolContext` provides `signal`, `workspace`, `emit(data)` and
`session`. Return
`textResult(text, isError?)`. The effect controls permissions ([Tools & permissions](/tools)):
unknown or plugin operations default to `external`; only declare `read` for side-effect-free tools.

### Rich results (`ui` blocks) {#ui-blocks}

A tool result may add `{ type: "ui", block }` parts next to its text. A `UiBlock` is plain data;
plugins never ship rendering code. Always keep a text part too: providers, compaction and headless
output only see the text projection, and the block is a display hint.

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

| Kind | Fields | TUI rendering |
| --- | --- | --- |
| `table` | `columns`, `rows`, `caption?` | Aligned columns |
| `key-value` | `entries`, `caption?` | Two columns |
| `tree` | `nodes` (`label`, `children?`, `meta?`) | Branch glyphs |
| `code` | `code`, `lang?`, `caption?` | Highlighted code |
| `markdown` | `text` | Markdown |
| `diff` | `patch?` or `before?`/`after?`, `path?`, `lang?`, `caption?` | Unified patch as `diff` code; otherwise labeled `before`/`after` |
| `terminal` | `output`, `command?`, `cwd?`, `exitCode?`, `durationMs?`, `truncated?` | Output without ANSI plus `exit <code> · <time>` |
| `mermaid` | `source`, `title?` | Source as `mermaid` code |
| `math` | `latex`, `display?` | Literal LaTeX |
| `json` | `value`, `collapsedDepth?`, `caption?` | Indented JSON, truncated |
| `test-results` | `suites` (`name`, `file?`, `cases`), `framework?`, `durationMs?` | Table of suite, case, status and time, plus failures |
| `progress` | `steps` (`label`, `status`, `detail?`), `title?` | One line per step with a status glyph |

`UI_BLOCK_KINDS` lists every kind. Keep payloads bounded (about 200 KB for a diff and 256 KB for
terminal output or serialized JSON). A kind that the running Alisio does not know, or a malformed
block, is shown as labeled JSON instead of failing, so older builds can replay newer transcripts.

### Naming and prefix rules

| Item | External plugin | Built-in plugin |
| --- | --- | --- |
| Tool name | `p_<hash>_<name>` (10 hex characters of the SHA-256 of the plugin ID), avoiding collisions and meeting provider name limits | Unprefixed |
| Command | `<plugin id>:<name>`, invoked as `/command acme.hello:name args` or `/acme.hello:name`; also from `alisio run "/acme.hello:name args"`, which prints the result without calling the model (`--json` prints one `command_result` line), and from the web palette | Unprefixed (for example `/memory`) |
| `internal` effect | Downgraded to `external` | Allowed |

### Compaction hooks {#compaction-hooks}

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

- `beforeCompact(input)` receives `sessionId`, `reason` (`manual` or `auto`), the `messages` about to
  be replaced, `focus` and `signal`. It may return `instructions` (appended to the summarizer
  instructions) and `outputFields` (extra top-level JSON fields, name → description, requested in the
  same summarizer call).
- `afterCompact(result)` also receives `model`, `replaced`, `structured`, `checkpoint`,
  `checkpointText` and `extracted` (this plugin's fields, **unvalidated**: validate them yourself). It
  may return `injectContext` (text appended after the checkpoint; keep it budgeted) and `report`
  (`summary` is displayed verbatim).

### Session hooks and model completions

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

`SessionInfo` contains `sessionId`, `model`, `workspace`, `reason` (`start`, `clear` or `exit`),
`messages` and `signal`. `model.complete` uses the configured provider (the session model when the
plugin passes it) and does not count against `limits.maxTokens`.

### Storage port

```ts
const db = api.storage.sqlite("/path/to/notes.sqlite");
db.exec("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT)");
db.transaction(() => db.prepare("INSERT INTO notes (text) VALUES (?)").run("hello"));
const rows = db.prepare("SELECT * FROM notes").all();
```

`SqlDatabase` is synchronous: `exec(sql)`, `prepare(sql)` (statements are cached per SQL text and
offer `run`, `get`, `all`), `transaction(fn)` (immediate transaction; nested calls join the outer
one) and `close()`. FTS5 is available. The host provides the driver, so plugins never depend on a
specific runtime.

### Data views {#data-views}

A data view is a named function that returns JSON for one session, which hosts read without
running a tool. `alisio serve` exposes them to the web UI (the built-in memory plugin feeds the
[Memory tab](/web#memory-tab) this way).

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

- `id` is lowercase letters, digits and dashes (up to 40 characters) and unique within the plugin;
  `description` is required. `params` is a JSON Schema object of primitives (`string`, `integer`,
  `number`, `boolean`; no `$ref`) whose unknown keys are rejected. Query strings are coerced to the
  declared types and defaults are applied before `handler(params, { sessionId, workspace, signal })`
  runs. `ViewParamsError` turns a parameter the schema cannot express into a `400`.
- Over HTTP a view is `GET /api/sessions/:sid/views/:plugin/:view?<params>`, behind the same
  session cookie, Host and Origin rules as every other route. Only enabled plugins answer, the
  session must exist and its workspace must still exist, and a view of another plugin or a disabled
  one is a `404`. At most 16 query parameters of 512 characters each are accepted.
- The response is JSON of at most 1 MiB (`view_too_large`, 502) and the handler has 5 seconds
  (`view_timeout`, 504; `signal` aborts). Any other failure is a generic `view_failed` (502): its
  message and the parameters are never sent or logged, because they may carry project data.
- **Views are read-only by contract, not by isolation.** The host only controls the method, the
  validated parameters, the time and the size; it cannot stop a plugin's code from writing, and a
  handler that blocks the event loop is not interrupted by the timeout. A plugin is not a sandbox.

### Decision Intelligence, paths and options {#decision-intelligence}

`api.decisions`, `api.paths` and `api.options` are **optional**: a core that predates them leaves
them out, so feature-detect each one and keep working without it.

```ts
setup(api) {
  api.decisions?.registerProvider(myProvider); // Registering never activates it.
  const cache = api.paths?.cache; // Per-plugin directory, created on first read.
  const device = api.options?.device ?? "cpu"; // From `pluginOverrides[id].options`.
}
```

- **`api.decisions`** registers a decision provider and lets a plugin tool ask for decisions. The
  user activates a provider with `decisions.provider` in the global configuration; installing the
  plugin is not enough. The contract, the errors and the lifecycle are in
  [Decision Intelligence](/decision-intelligence#writing-a-provider). Tools receive the consumer
  side as `context.decisions?.tryDecide(...)`, bound to the current run.
- **`api.paths`** gives `state` (`<state root>/plugins/<id>`), `config`
  (`<config home>/plugins/<id>`) and `cache` (`<state root>/plugins/<id>/cache`). The state root is
  the one analysis and artifacts use, so it follows `--db`. Use these instead of resolving XDG or
  `ALISIO_*` paths yourself.
- **`api.options`** holds the JSON you or the user put in `pluginOverrides[id].options` of the
  global configuration (see [`pluginOverrides`](/configuration#plugins)). It is global only, at most
  8 KB, and a snapshot taken at `setup`: changing it needs a restart. Do not keep secrets there.

### Child sessions {#child-sessions}

`api.sessions` is a generic service for delegated work: a child session is a separate, persisted
conversation (fresh context) with a parent link, run by the same runner with **narrowed**
permissions. A child can never gain a capability, tool or approval its parent lacks, and aborting a
parent run aborts its running descendants. The core contains no agent logic; the
[subagents](/subagents) plugin is built on this service.

| Member | Description |
| --- | --- |
| `spawn(spec)` | Creates a child session (`ChildSessionSpec`) and returns `ChildSessionInfo` |
| `create(spec)` | Resolves `spec.model`, if present, then creates a provider-bound child; use this for model overrides |
| `run(id, prompt, { signal? })` | Runs a turn in the child; resolves a `ChildRunResult` (`status`, `text`, `usage`, `error?`) |
| `get(id)`, `children(parentId)` | Session info (`id`, `parentId`, `depth`, `agent`, `title`, `status`, `model`, `workspace`, `usage`, `capabilities`, timestamps) |
| `ancestors(id)` | Ancestor IDs, nearest first |
| `cancel(id)` | Cancels a run and all running descendants; returns how many were running |
| `enqueue(id, text)` | Queues a user message for the session's next turn (or next run when idle) |
| `isRunning(id)` | Whether the session is running |
| `capabilities(id)` | Effective `write`, `process`, `approvals` and `readOnly` |
| `model(id)`, `workspace(id)` | Model a new child would inherit; the session's workspace |
| `setStatus(id, status)` | Sets a `SessionStatus`: `queued`, `running`, `completed`, `failed`, `cancelled` or `interrupted` |

`ChildSessionSpec` fields: `parentId`, `id?`, `title`, `agent` (label shown in UIs and approvals),
`instructions?`, `tools?: { allow?, deny? }` (`*` allows every parent tool), `model?`, `readOnly?`,
`permission?: { write?, process? }` (`allow`, `ask` or `deny`), `workspace?` (for example a git
worktree), `maxTurns?`, `timeoutMs?` and `maxTokens?`.

`sessions.run` resolves with `{ id, status, text, usage, error? }`. A child that exhausts its turn
cap is NOT a failure: it resolves with `status: "completed"` and `turnsExceeded: true`, and `text`
holds a usable partial report (only real errors, cancellations and timeouts set a failure status).

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

`PanelProvider` has a `title`, `nodes({ sessionId })` returning `PanelNode`s (`id`, `parentId?`,
`label`, `color?`, `status`, `startedAt?`, `endedAt?`, `tokens?`, `detail?`, `sessionId?`) and an
optional `action("cancel" | "background", nodeId, { sessionId })`.

### Hook timeouts and failure isolation

- Compaction and session-start hooks run with `pluginHooks.timeoutMs` (default 15 000 ms);
  session-end hooks with `pluginHooks.sessionEndTimeoutMs` (default 10 000 ms).
- Each hook receives an `AbortSignal` that is aborted when the timeout expires.
- A failure or timeout is recorded as a `plugin_hook_failed` event and the core continues without
  that plugin's contribution.
- Hooks run in-process: a timeout stops the wait and signals the `AbortSignal`, but it cannot stop
  blocking synchronous code.

### Shutdown {#shutdown}

- `dispose()` runs when Alisio closes: leaving the terminal UI, `SIGINT`, `SIGTERM` and `SIGHUP`
  (terminal UI, `alisio serve` and `alisio run`) and the end of a run. It does **not** run when a
  plugin is disabled or on `/reload`, because both need a restart.
- Plugins are disposed in parallel and each one is limited by `pluginHooks.disposeTimeoutMs`
  (default 2000 ms, 100 to 10000); a slow or hung `dispose()` does not delay the others, and its
  failure is reported without stopping them. Finish well within that limit.
- A sudden death (`SIGKILL`, a crash) cannot be covered: a plugin that owns an operating-system
  process must clean up stale ones itself.

## Extension points {#extension-points}

Extension points let a plugin replace a piece of the host with its own provider. They are typed in
`ExtensionPoints`; new points are added there without breaking existing ones.

| Point | Provider type | Default |
| --- | --- | --- |
| `mascot` | `MascotProvider`: `{ id, render(ctx: MascotContext) }` returning a `string` or `string[]` | `DefaultAlisioMascot` (`alisio.default`) |
| `startup-screen` | `StartupScreenProvider`: `{ id, render(ctx: StartupContext): string[] }` | `DefaultStartupScreen` (`alisio.default`) |
| `websearch` | `SearchProvider`: `{ id, search(query, options?: { signal? }): Promise<SearchResult[]> }`, `SearchResult = { title, url, snippet }` | The built-in chain: a configured `websearch.provider`, else a public SearXNG instance (see [Tools & permissions](/tools#websearch)) |

Register a provider imperatively, or declare it on the plugin object:

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

- `api.extensions.register(point, provider, { priority })` returns a disposer that unregisters it.
  `priority` is a finite number, default `0`; a provider needs an `id` (that is the one thing every
  point shares — a renderable point like `mascot` additionally needs a working `render`, checked
  when the host actually calls it, the same way a throwing `render` already falls back today).
- The declarative `Plugin.extensions` field is sugar for `api.extensions.register(point, provider)`
  at priority `0`, applied before `setup` runs.

### Resolution

For each point the host picks exactly one provider, deterministically:

1. highest `priority`;
2. then plugin `id`, lexicographically (plugins are identified by `id`, not by package name);
3. then registration order within the same plugin.

Load order across plugins never matters. The built-in defaults are only used when nothing is
registered, or as a replacement for a failing provider. When several providers tie at the winning
priority, the host reports an `extension_conflict` diagnostic with `point`, `winner` and `losers`
(as `plugin/provider` IDs). Conflicts and the resolved providers are shown in `/stats` and in
`alisio plugins doctor`:

```sh
alisio plugins doctor --plugin ./dist/index.js
```

### Typed contexts

| Type | Fields |
| --- | --- |
| `TerminalCapabilities` | `color` (ANSI SGR allowed), `unicode` (non-ASCII allowed), `columns`, `interactive` |
| `MascotContext` | `terminal`, `version` |
| `PluginMetadata` | `id`, `version`, `builtin` |
| `StartupFact` | `label`, `value` |
| `StartupContext` | `version`, `cwd` (already shortened), `model?`, `provider?` (host only, never credentials), `userName?`, `terminal`, `plugins` (`PluginMetadata[]`), `mascot` (the resolved, validated mascot), `tips`, `facts?` (host facts such as access and memory state) |

`StartupContext.mascot` is always safe to call: a custom screen can reuse whichever mascot won.

### Safety rules

- Providers receive **only their context**: they must not read globals, environment variables or the
  filesystem. Honor `terminal.color`, `terminal.unicode` and `terminal.columns`.
- A provider that throws, returns something other than a string or an array of strings, returns
  too many lines (12 for a mascot, 60 for a screen) or takes longer than 250 ms is replaced by the
  default, and a `plugin_hook_failed` diagnostic is recorded. Rendering is synchronous, so a slow
  provider cannot be preempted: its output is discarded afterwards.
- Output is sanitized: only SGR color sequences are kept, and only when `color` is true; other escape
  sequences and control characters are removed; tabs become spaces; non-ASCII characters become `?`
  when `unicode` is false. Every line is clamped to `columns`.
- The default screen is built from reusable section functions exported by `@alisio/core`:
  `titleSection`, `welcomeSection`, `infoSection`, `pluginsSection`, `tipsSection`, `mascotSection`,
  `composeSideBySide`, `shortenPath` and `startupTips` (deterministic for a given seed). It shows the
  mascot side by side with the information when the terminal is wide enough, and stacked otherwise.

### Example: kite mascot

The repository ships an example package in
[`examples/plugins/custom-mascot`](https://github.com/GustavoGutierrez/alisio/tree/main/examples/plugins/custom-mascot)
(`alisio-plugin-kite-mascot`, plugin `id` `kite-mascot`). It depends only on `@alisio/sdk` (peer
dependency) and ships JavaScript.

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

### Example: custom websearch provider

[`examples/plugins/custom-websearch`](https://github.com/GustavoGutierrez/alisio/tree/main/examples/plugins/custom-websearch)
(`alisio-plugin-brave-websearch`, plugin `id` `brave-websearch`) wraps
[Brave Search](https://api.search.brave.com/) with a user-supplied API key behind the `websearch`
extension point — a copyable reference for "bring your own search engine":

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

## Loading plugins {#loading-plugins}

Plugins are only loaded from explicitly trusted sources. Alisio never installs or downloads plugins.

| Source | Trust |
| --- | --- |
| `--plugin <path>`, `--plugin <package>` | Explicit trust for that entry and its dependencies |
| `plugins` in the configuration file | The file itself is trusted (global config, `--config` or `--trust-project`) |
| `<config home>/plugins/` (files or directories) | Global plugins: personal trusted code |
| `<workspace>/.alisio/plugins/` | Only with `--trust-project` |

```sh
alisio --plugin ./my-plugin.js
alisio --plugin alisio-plugin-foo
```

```json
{ "plugins": ["alisio-plugin-foo"] }
```

`--read-only` disables executable (external) plugins. Built-in plugins are not affected.

**Resolution.** An entry that looks like a path (starts with `.`, is absolute, contains `\`, ends in
a JS/TS extension, or contains `/` without a leading `@`) is a file or directory. Anything else is an
npm package name, looked up in `node_modules` from the project directory upwards, then in the global
roots: `NODE_PATH` entries and the global prefix of the running Node/npm.

**The `alisio-plugin` keyword is required.** A package without `"keywords": ["alisio-plugin"]` in its
`package.json` is rejected, so a typo cannot load an unrelated package. The entry is taken from
`exports["."]` (`import`, `node` or `default` conditions), then `main`, then `./index.js`.

A directory given as a path must contain an `alisio-plugin.json` manifest declaring its entry (a
package may ship one too); the entry must stay inside the directory:

```json
{ "apiVersion": 1, "entry": "./index.js" }
```

Check what a plugin registers with:

```sh
alisio plugins list
alisio plugins doctor --plugin ./my-plugin.js
```

## Installing plugins from npm {#installing-plugins-from-npm}

The CLI can install an npm package into Alisio's GLOBAL plugins directory
(`<config home>/plugins`, for example `~/.config/alisio/plugins`) and record its npm NAME in the
global configuration's `plugins` array — the same entry you can write by hand today:

```sh
alisio install npm:plugin-openrouter          # latest version
alisio install npm:@scope/plugin-x@1.2.3      # a pinned version
alisio install plugin-openrouter              # bare names are the same as npm:
alisio install npm:plugin-openrouter --update # refresh an installed plugin to @latest
alisio install --update                       # refresh ALL installed plugins in one npm call
```

The spec is validated before any network operation: `npm:<package>[@<version>]`, or a bare package
name; only letters, digits, `.`, `_`, `-` are allowed, plus `/` for scoped names and `@` for a
version. Unknown prefixes (`git:`, `file:`, `registry:` URLs, ...) are rejected with a clear error.
**A failed install never reruns npm silently** and a failed npm output is sanitized (no
tokens/secrets); the error names the package and the exact retry command.

**Where it lands.** The package is installed with `npm install --prefix <config home>/plugins` into
`<config home>/plugins/node_modules/<package>`, and its NAME (never the resolved filesystem path)
is added to the `plugins` array of `<config home>/config.json` (atomic write, unrelated fields
preserved, no duplicates). `alisio plugins list` shows installed packages alongside file/plugin
directories.

| Aspect | Behavior |
| --- | --- |
| Global scope | One install serves every project the user runs Alisio from |
| Loading | The plugin loads as in-process, executable code wherever global plugins load; it must declare the `alisio-plugin` keyword to be loadable at all |
| Project trust | A project's OWN configuration and plugins still load only in trusted projects (`--trust-project` or the one-time trust prompt) |
| `--read-only` | Installing is refused and the plugin never loads (executable plugins are disabled) |
| Reinstall | If the package is already installed, the command reports it and suggests `--update` instead of rerunning npm |
| Scripts | `npm install` may run the package's lifecycle scripts with your privileges — Alisio warns and requires confirmation on an interactive terminal |
| Headless / `--json` | Never prompts: without an explicit `--yes` (or `--trust-plugin`) it fails with an actionable error before running npm |
| Errors | Sanitized npm output, package name and exact retry command in the final message |
| `--update` without a spec | Refreshes every plugin installed in the global plugins directory to `@latest` in a single `npm install --prefix` call; same confirmation, `--yes` and `--read-only` rules; with no installed plugins it says so and exits 0 |

The install is a global, per-user action: it grants nothing to any project. Loading follows the
existing executable-plugin policy — the one-time trust prompt (or `--trust-project`) is what lets a
project load its own configuration and plugins, and `--read-only` disables executable plugins
entirely.

### Peer dependency conflicts (`ERESOLVE`)

Older installed plugins can pin an older `@alisio/sdk` through their peer range, so npm refuses to
install a newer plugin that needs a newer SDK (`ERESOLVE ... Conflicting peer dependency`). Alisio
then explains the cause, lists the installed plugins involved and does not show the generic retry
line, because the retry would fail the same way. Update all installed plugins together (updating
them one by one keeps hitting the same conflict), then run the original install again:

```sh
alisio install --update
alisio install npm:@alisio/plugin-laya
```

Alisio never suggests `--force` or `--legacy-peer-deps` for this.

### The agent can install a plugin for you

In the TUI the model can install a plugin on request through the host-owned `plugin_install` tool:
it validates the spec, runs the **same** install routine as `alisio install`, and answers with the
package name, installed version, config entry and path, plus the trust remark. The tool uses the
`process` effect, so it goes through the ordinary permission gate — the approval prompt in the TUI,
or `--allow-process` headless — and is never available under `--read-only`. See
[Tools & permissions](/tools#plugin-install).

```text
You:   install the plugin plugin-openrouter
Agent: (calls plugin_install with spec "npm:plugin-openrouter", you approve it)
Agent: Installed plugin "plugin-openrouter" v1.2.3 at
       ~/.config/alisio/plugins/node_modules/plugin-openrouter and added it to the
       "plugins" array of ~/.config/alisio/config.json. The plugin loads as trusted
       personal code; --read-only keeps it from loading. Run `alisio plugins list`
       to inspect.
```

## TypeScript plugins

- Plugins published to npm **must ship JavaScript**.
- Local `.ts` plugins loaded with `--plugin` work on Bun (and the standalone binary) and on
  Node.js >= 22.18 through type stripping, which only supports erasable syntax (no `enum`,
  `namespace` or parameter properties).
- On older Node.js versions Alisio fails with a clear error asking for Bun, Node.js >= 22.18 or a
  JavaScript build.

## Example plugin package

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

Use the latest published `@alisio/sdk` version when you scaffold your own plugin — check
`npm view @alisio/sdk version` for the current one. Plugins should declare `@alisio/sdk` as a
**peer** dependency with `^0.2.0`: while Alisio is 0.x, a caret range accepts only its own minor,
because a new minor may include breaking changes, so you opt in to each minor explicitly. A plugin
that must support both lines can declare `"^0.1.0 || ^0.2.0"`; plugins published for 0.1 (such as
`@alisio/plugin-deepseek`) declare `^0.1.0` until they are updated.

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

Build and try it:

```sh
npm install
npm run build
alisio --plugin ./dist/index.js         # local build, as an explicit path
npm publish                             # then: npm i -g alisio-plugin-hello
alisio --plugin alisio-plugin-hello     # or add it to "plugins" in the configuration
```

In the TUI the command is available as `/acme.hello:greetings`, and the model sees the tool under its
prefixed name.
