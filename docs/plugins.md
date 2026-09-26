# Writing plugins

A plugin is an ES module whose default export is a `Plugin` object. The contract lives in
[`@alisio/sdk`](https://www.npmjs.com/package/@alisio/sdk): types plus two helpers
(`definePlugin`, `textResult`), with no runtime dependencies and no provider SDKs.

```ts
import { definePlugin, textResult } from "@alisio/sdk";

export default definePlugin({
  id: "acme.hello",
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
| `setup(api)` | Registers everything; may be async. If it fails, partial registrations are rolled back |
| `extensions` | Optional; declarative providers for [extension points](#extension-points), registered at priority 0 |
| `dispose()` | Optional; releases resources when Alisio closes |

`definePlugin` is an identity function that only adds typing. Duplicate plugin IDs are rejected.

## `PluginAPI` reference

Every `register`/`on` method returns an unregister function. Everything a plugin registers is
removed automatically when it is unloaded.

| Member | Description |
| --- | --- |
| `tools.register(tool)` | Registers a tool (`ToolDefinition`) |
| `commands.register(name, handler, options?)` | Registers a command; `handler(args: string, context?: { sessionId? }) => Promise<string>` returns the text shown to the user (`sessionId` is the interactive UI's current session, when known). `options`: `{ description?, argumentHint? }`, shown in `/help` and autocompletion |
| `events.on(handler)` | Observes versioned run events (`RunEvent`: `schemaVersion`, `runId`, `sessionId`, `seq`, `type`, `timestamp`, `data`) |
| `context.register(provider)` | `() => Promise<string>`; adds text to the model context |
| `resources.skills(path)` | Adds an Agent Skills root (relative to the plugin file) |
| `resources.agents(path)` | Adds a directory of agent definitions for delegation plugins (see [Subagents](/subagents#discovery-and-precedence)) |
| `resources.list(kind)` | Directories registered by every plugin for `skills`, `prompts` or `agents`, with the plugin ID |
| `resources.prompts(path)` | Adds a directory of [prompt templates](/prompt-templates#templates-from-plugins) (`*.md`, relative to the plugin file) |
| `state.get(key)` / `state.set(key, value)` | Small JSON state per plugin, persisted in the session database |
| `storage.sqlite(path)` | Opens a private (0600) SQLite file, creating parent directories (0700). Returns the storage port `SqlDatabase` |
| `compaction.register({ beforeCompact, afterCompact })` | Compaction hooks, see below |
| `session.onStart(handler)` | Returned text is injected once at the start of a new, empty session (persisted in the session) |
| `session.onEnd(handler)` | Called when an interactive session ends (`/clear`, `/exit`, quit) |
| `model.complete(request)` | Provider-agnostic text completion: `{ system, messages, maxTokens?, model?, signal? }` → `Promise<string>` |
| `extensions.register(point, provider, options?)` | Provides an implementation for an [extension point](#extension-points) (`mascot`, `startup-screen`); `options`: `{ priority? }` |
| `ui.status(key, text, detail?)` | Short status text in the TUI status bar; `detail` appears in `/stats`; `text: undefined` clears it |
| `ui.panel(id, provider)` | A collapsible tree panel (`PanelProvider`), interactive UIs only |
| `ui.select(request)` | Asks the user to choose (`SelectRequest`: `title`, `options` with `value`, `label`, `description?`); resolves `undefined` without an interactive UI |
| `ui.open(sessionId)` | Opens a session in a read-only view; returns `false` without an interactive UI |
| `ui.interactive()` | `true` when an interactive UI can answer `select` |
| `sessions.*` | Child sessions, see [below](#child-sessions) |

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

### Naming and prefix rules

| Item | External plugin | Built-in plugin |
| --- | --- | --- |
| Tool name | `p_<hash>_<name>` (10 hex characters of the SHA-256 of the plugin ID), avoiding collisions and meeting provider name limits | Unprefixed |
| Command | `<plugin id>:<name>`, invoked as `/command acme.hello:name args` or `/acme.hello:name` | Unprefixed (for example `/memory`) |
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

### Child sessions {#child-sessions}

`api.sessions` is a generic service for delegated work: a child session is a separate, persisted
conversation (fresh context) with a parent link, run by the same runner with **narrowed**
permissions. A child can never gain a capability, tool or approval its parent lacks, and aborting a
parent run aborts its running descendants. The core contains no agent logic; the
[subagents](/subagents) plugin is built on this service.

| Member | Description |
| --- | --- |
| `spawn(spec)` | Creates a child session (`ChildSessionSpec`) and returns `ChildSessionInfo` |
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
    "@alisio/sdk": "^0.1.0-alpha.1"
  },
  "devDependencies": {
    "@alisio/sdk": "^0.1.0-alpha.1",
    "typescript": "^5.9.0"
  }
}
```

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
