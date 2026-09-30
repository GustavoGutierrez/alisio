# Known limitations

This page is an English translation of the limitations and pending work recorded in
[`docs/implementation-status.md`](https://github.com/GustavoGutierrez/alisio/blob/main/docs/implementation-status.md).
That Spanish file in the repository is the source of truth; the
[Spanish version of this page](/es/limitations) includes it verbatim.

Alisio `__ALISIO_VERSION__` is a functional alpha. The original specification sets the product direction;
it is not a statement that all of its release criteria are met.

## Pending to stabilize v0.1

- Run and tune a Windows/macOS matrix; current CI covers Linux and does not certify other systems.
- Validate real providers and models with the user's credentials.
- Validate Herdr with a real server/PTY; add a native launcher/resumer if Herdr allows it.
- Session checkpoints/rewind and vector memory: they do not exist.
- Interactive onboarding; configurable color themes; expandable reasoning view.
- First real npm publication and release with binaries: the `pnpm publish` script
  (`scripts/publish.ts`, see [Publishing](/publishing)) is implemented and unit-tested but has not
  been run against the real registry; SemVer ranges for plugins and reload in an idle session.
- Automatic discovery of Pi paths and incremental watch.
- Interactive MCP OAuth and MCP multimedia capabilities. `/mcps` supports explicit reconnect and
  environment-referenced bearer tokens, but not browser authentication flows.
  Configured servers connect lazily and stdio runs with the user's privileges; neither MCP nor its
  subprocess transport is a sandbox. Semantic names and descriptions improve model routing but do
  not guarantee automatic tool selection; explicitly name `server/tool` when the call is required.
  Repeated-consent behavior is now configurable: the global `mcp.allow` preference grants MCP
  consent persistently and auto-connects enabled servers at every start; a per-session TUI grant is
  the alternative when `mcp.allow` is unset. Granting persists across sessions: a server that
  auto-connects at startup runs unsandboxed under your user privileges whenever enabled.
  Large tool catalogs are a deployment choice: a server exposing dozens of tools inflates every
  request and is not counted against the post-compaction context budget (see
  [the tool catalog is not counted](/compaction#the-tool-catalog-is-not-counted)), so manage
  oversized catalogs with `/plugins` (disable the
  server) rather than expecting the runner to shrink them.
- Remote OpenTelemetry, memory metrics and large-repository benchmarks.
- Hardening against hostile processes and filesystem races. No OS sandbox is offered.
- **Persistent MCP consent**: `mcp.allow: true` grants MCP process/network consent for this user
  across sessions and auto-connects enabled servers at every start (TUI and headless). It is only
  read from the global configuration layer and is never overridden by a project value; `--read-only`
  still hard-blocks MCP. TUI grants ("session only") never touch the configuration file.

## Known limits

- **Runtime**: Node does not load `.env` automatically (Bun does); use environment variables or
  `node --env-file=.env`. Local `.ts` plugins require Bun or Node >= 22.18; npm plugin packages must
  be published as JavaScript. The `alisio-source` export condition is only used in development
  inside the monorepo and is not published.
- **Provider credentials**: `credentials.json` is local plaintext protected with mode `0600`, not
  encrypted and not an OS keychain. Provider/model changes start a fresh session; compatible old
  sessions remain stored, but opaque continuation state is never transplanted across providers.
  Cross-provider selectors only see global profiles created through `/connect`; legacy root
  configuration is not a hidden catalog. Catalog discovery is cached for up to 15 seconds per
  process.
- **License**: MIT.
- **Memory**: search uses the trigram tokenizer, so terms shorter than 3 characters are ignored. No
  semantic search. The automatic end-of-session summary only runs in the TUI (not in headless `run`)
  and is bounded by `pluginHooks.sessionEndTimeoutMs`; if it expires, exit continues without a
  summary. The end-of-session summary replaces the archived checkpoint of the same session (one
  summary per session). User prompts are copied to the memory database (with `<private>` redacted)
  on compaction and on exit; the database is local with 0600 permissions.
- **Memory implementation details**: the sessions table is named `memory_sessions` (the database may
  share a file with Alisio's sessions); there is no FTS over prompts; a `topic_key` in `personal` scope
  upserts across projects (so preferences are truly personal); context lines include `#id` for
  `memory_get`; the compaction checkpoint is archived as a session summary rather than as a
  `session/compaction-recovery` observation, and recovery is injected deterministically without
  asking the model to call tools. There is no cloud sync, relations, conflict judgment or review
  cycle.
- **`internal` effect**: memory tools do not modify the workspace or the network and are allowed even
  with `--read-only`. If you prefer a strictly write-free mode, use `--disable-plugin memory`.
- **Plugins**: `model.complete` uses the configured provider (the session model when the plugin passes
  it) and does not count against the `limits.maxTokens` budget. Hooks run in-process: the timeout
  aborts the wait and signals the `AbortSignal`, but it cannot stop blocking synchronous code.
  `/plugins` persists enable/disable overrides but intentionally requires a restart; reverting the
  desired state to the original runtime state clears that requirement. Hot removal cannot yet
  guarantee cleanup of every live registration and provider/session resource. External management
  requires project trust. A model-provider retained by the active provider or any live routed
  session, and plugins with live session-owned resources, are protected from disable actions.
- **Plugin installation** (`alisio install`, host tool `plugin_install`): npm-only and GLOBAL —
  packages land in `<config home>/plugins` via `npm install --prefix`, and their npm names are
  persisted in the global `plugins` array. Installing is a per-user action; loading follows the
  existing executable-plugin policy (a project's own config/plugins need project trust;
  `--read-only` disables loading entirely). There is no script sandboxing: `npm install` may run
  lifecycle scripts with your privileges and Alisio only warns/asks (headless runs require
  `--yes`/`--trust-plugin`). Registry/git/file URLs are not supported, and Alisio does no own
  dependency resolution — the package must declare the `alisio-plugin` keyword to be loadable.
- **Startup screen**: the TUI chrome itself (header, bars) still uses Unicode glyphs under
  `TERM=dumb`; only the startup screen falls back to ASCII. Width counting treats every code point as
  one column, so wide East Asian or emoji glyphs in custom mascots may misalign.
- **Subagents**: messages sent with `send_message` wait in an in-memory inbox and are lost if the
  process exits; a background completion is delivered with the parent's next turn (with your next
  message when the parent is idle); `skills` in a definition are loaded through a `skill_load`
  instruction, not pre-injected; `/agents merge` needs a clean working tree; worktrees are only
  created when write-capable children actually overlap; the agent panel and `/agents` show the tasks
  started in the current process.
- **Prompt templates**: no template includes or partials, no shell execution or file injection in
  templates, `$10` and higher are not supported, and positional arguments are plain text only.
- **Clipboard**: OSC 52 cannot be confirmed; the TUI reports it as unverified.
- **Paste and attachments**: image clipboard access needs a native platform helper (or `wl-paste`
  on Wayland); it is commonly unavailable over plain SSH. There is no capability check before
  sending an image to a model: an unsupported model's own rejection surfaces as a normal inline
  error. Attachments are capped at 4 per message and 5 MB raw bytes each, enforced by the TUI, not
  by `@alisio/core` (an embedder calling the runner directly can send larger or more attachments).
  Multi-line paste in `--no-tui` (readline) mode is not atomic: Node's `readline` has no
  bracketed-paste support, so each embedded newline submits its own message instead of one
  combined message; single-line paste is unaffected. Images are not supported at all in `--no-tui`
  mode.
- **TUI**: `/stats` covers only the current TUI process for the active session; it is not rebuilt from
  persisted events. The TUI needs a terminal with an alternate screen; otherwise use `--no-tui` or
  `run`.
- `provider.contextWindow` applies only to the configured model; after `/model`, the window comes
  from the active `/connect` profile's `values.contextWindow` override (asked in `/connect` when
  the catalog does not report the selected model's window, meant for local servers like llama.cpp
  that omit `context_window`; it wins over the catalog by user intent), from
  `GET /models` (the catalog loads lazily at startup and refreshes after every provider/model
  switch), or stays unknown. Auto-compaction uses ONE effective budget: with a known window it
  triggers at `threshold` of that window only; with an unknown window (or one declared beyond
  `2_000_000` tokens) it falls back to `limits.maxContextChars` (est. tokens at `maxContextChars / 4`),
  which also stays as the post-compaction hard limit. The hard limit measures only **reducible
  content** (instructions + transcript): the fixed tool catalog is not counted against it, so a
  huge MCP catalog can never corrupt or fake-fail a small transcript — manage oversized catalogs
  with `/plugins` instead. The TUI context bar reflects the same budget.
  Coverage uses saved profiles and `/connect` activation with fake catalogs; the interactive
  `/connect` input is verified by types and manually, not by UI tests.
- **Compaction** uses the current provider; its token usage is not added to the `limits.maxTokens`
  budget. Before/after estimates are approximate (about 4 characters per token). Responses opaque
  items of the summarized span are discarded; kept ones do not change. A session with uncertain tool
  results is not compacted until it is recovered.
- **Truncated responses**: when a response is cut by `limits.maxOutputTokens` (or the compaction
  summary by `compaction.maxOutputTokens`), the produced text is kept as-is. A cut response completes
  the run with a warning and a `truncated` flag; a cut summary becomes a **partial checkpoint** —
  information produced before the cut is preserved, but a truncated summary may omit later context.
  The summarizer independently estimates tokens (≈4 characters per token), so a summary near its
  budget can be cut even when the model itself is not near *its* limit; the exact budget consumed is
  provider-reported and cannot be checked in advance.
- **Approvals**: only for `write` and `process` effects and only in the TUI; "allow for the session"
  lasts while the process lives. The wait counts within `limits.timeoutMs`. The `Policy` contract did
  not change: approval is an additional `RunnerOptions` option.
- A `resume` with a different model no longer fails: the session is the source of the model and
  `--model` switches it explicitly for the following turns.
- In-process plugins can block the event loop or bypass mediated services. Only trusted code; engine
  timeouts cannot stop hostile synchronous code.
- The SQLite lock by PID is designed for local processes on one host, not for a database shared over a
  network. PID reuse may require user intervention.
- Path validation is not OS isolation. The shell and plugins have the user's permissions.
- Statistics depend on the provider. If it does not send usage, the token limit is not exact; the
  limits on turns, time, context length and per-request output still apply.
- The chat adapter supports text and function tools; private reasoning blocks from third-party
  providers are not normalized. For OpenAI continuation, use Responses.
- The session restores the active history (compacted history stays archived). Migrations are forward
  and idempotent (v1 → v2); there are no backward migrations.
- Text reading/editing is limited to 1 MiB. Large searches/outputs are truncated explicitly.
- The Herdr integration allows exchanges through terminals; it does not promise full multi-agent
  autonomy or distributed planning.
- **Web server (`alisio serve`)**: single-host session locks (a session another process uses answers
  `409 session_locked`, and the web does not see a TUI's changes live); no TLS (`--allow-remote` is
  meant for SSH tunnels; a wildcard bind also accepts IP-literal `Host` headers); the provider is per
  workspace, so only the model changes per session; idempotency of prompts queued while a run is
  active is in memory; every SSE reconnection receives a full snapshot; the standalone binary serves
  only the API and a placeholder page. Activating a provider profile from the web changes one
  workspace application and is refused while it has runs; a plugin switch applies when the
  workspace next has no runs (its application is reloaded); plugins cannot be installed from the
  web. The files panel browses the workspace only (no `--add-dir`
  roots, symbolic links never followed) and uploaded images are not garbage-collected. The UI does not watch the stream with a 45 s
  timer (the server heartbeat is an SSE comment that `EventSource` does not expose); command output,
  notices and reasoning exist only while the page is open. `Ctrl+K` focuses the sidebar search
  (there is no separate session palette) and finished turns are not folded into an "N steps"
  summary.

Per-session routing was verified with fake provider profiles and concurrent parent/child runs,
including canonical, unique, missing and ambiguous selectors, continuation isolation, agent/task
overrides and stable/distinct OpenCode session headers. No real credentials were used.

## Verification scope

The source file records a dedicated verification-scope section for each area below; the summary
here links to it with an absolute GitHub URL (the file is excluded from this site):

- **Runtime and packaging** — tests under Node and Bun, the built CLI, the standalone binary, packs.
- **Subagents, AGENTS.md and skills** — precedence, limits, cascade cancellation, git worktrees.
- **Prompt templates and `/init`** — sources, arguments, trust and diagnostics.
- **Startup screen and extensions** — mascot, extension points and `TERM=dumb`/`NO_COLOR`.
- **TUI and compaction** — pseudo-terminal runs, manual and automatic compaction.
- **Agent output-token budget** — truncation handling across the four adapters.
- **Context limit versus tool catalog and output speed** — what the post-compaction budget counts.
- **Memory and plugins** — FTS5 search, end-of-session summary, plugin install.
- **Paste and image attachments** — clipboard helpers per platform and limits.
- **`ask_user_question`** — the shared interactive queue and stepped prompts.
- **Network tools (webfetch, websearch, execute)** — mocked providers and no network sandbox.
- **Project trust and default permissions** — trust store, approvals and `--read-only`.
- **Event and UI block contracts** — typed run events, `eventId`, new `ui` block fallbacks.
- **v4 persistence, blobs and command catalog** — v3 → v4 migration, run journal, blob store, TUI
  command parity.
- **Web server (`alisio serve`)** — auth, workspaces, prompts, SSE, approvals, commands, models,
  context, export and shutdown against a real server on an ephemeral port; zero-overhead startup
  traced under Node; serve smoke in the Node CLI and the Bun binary. The web UI's reducers, SSE
  client, incremental Markdown and EN/ES key parity are unit-tested without a DOM, and the UI was
  exercised manually in Chromium (Playwright) with a simulated provider: streaming, tool rows,
  approvals by keyboard, the `/` palette, light and dark themes and a 390 px width, and in phase 5
  Mermaid and KaTeX (valid and malformed), every Settings page, a write-only credential, provider
  activation and plugin/skill switches refreshing the palette. Screen readers,
  Firefox/Safari and real network drops were not verified.

The full detail (in Spanish) is in the source file linked at the top of this page, which the
[Spanish version of this page](/es/limitations) includes verbatim.

Runtime and packaging: unit and integration tests run under Node (a subset also on Bun); `test:cli`
runs the built CLI on Node (verified on 22.19 and the 22.16.0 minimum) and `test:compiled` runs the
Bun binary, both against a simulated provider; `pack:check` validates the nine publishable packages; a real
global npm install from local tarballs was smoke-tested; `scripts/install.sh` was tested against a
local mirror (checksum install and rejection of a tampered binary). No npm publication or release
was executed, the release and Pages workflows were not run on GitHub, and macOS/Windows/arm64
binaries (Bun cross-compilation) were not tested.

The expanded DeepSeek/OpenCode Console/OpenCode Go integrations were verified with fake keys and
mocked/local inference only; no live credential inference or live OpenCode account was used. The
public unauthenticated Zen and Go catalogs were checked separately. Provider tests use a
deterministic local HTTP server, not an external account. MCP is tested with the
real server SDK over local processes/HTTP. The Linux binary runs a full cycle, loads an external
plugin with a dependency and keeps the session. The TUI was verified manually in a pseudo-terminal on
Linux against a simulated provider, but not on Windows/macOS or in other real terminal
emulators (kitty, iTerm2, Windows Terminal). Real copies through `xclip`/`wl-copy`/`pbcopy`/Windows
and an automatic compaction with a real provider were not verified. The full detail is in the
source file linked above.

Truncation handling was verified with mocked providers only (Vitest, no network):
the four adapters (the built-in OpenAI-compatible adapter and the DeepSeek, OpenCode Console and
OpenCode Go plugin adapters) emit
`completed` with `truncated: true` when a cut (`finish_reason` `length`, `response.incomplete`
or `stop_reason` `max_tokens`) left usable text with complete tool calls, and still throw on
empty text, partial tool calls or an abrupt end; the runner completes a cut no-tool-call turn
with the `response_truncated` event and `truncated: true` in `run_completed`, executes tool calls
from a cut turn and continues, accepts a cut-but-usable summary as a partial checkpoint
(`partial: true` in `compaction_completed`), fails with an actionable `compaction.maxOutputTokens`
message when the summary produced nothing usable, and uses `compaction.maxOutputTokens` (default
16000 in the config schema, 4096 when the runner is built without configuration), never the agent
loop budget; the TUI shows the warning notice and the `partial` marker (event-reduction Vitest);
and the config schema accepts the new field with its default.

The coherent context metric was verified with mocked providers (Vitest, no network): the runner
auto-compacts on the char-budget fallback when the window is unknown, does NOT compact early when a
large window is known (the DeepSeek ~1M-window vs 800k-char mismatch), compacts at `window ×
threshold`, and treats declared windows beyond 2M tokens as unknown; `app.contextBudget` reports
the model window when the catalog exposes it (lazily loaded, refreshed on model switch) and an
honest `basis: "unknown"` with no fabricated total otherwise, and the TUI bar renders `~9.9k / ?`
for that case (formatting Vitest). The publish script is covered by focused
unit tests (ordering, leak check, dry-run side effects, version bump, unknown package) with temp
dirs and no network; `docs/assets/Flujo de Ejecución de Herramientas y Modelo de Permisos.webp`
(the tool-flow diagram referenced from the tools pages) is an untracked binary asset that must be
added to git before committing.

**Active agent and effort.** The effort is resolved against the ACTIVE model's catalog in the TUI
(async `GET /models` load): until the catalog arrives — or when the query fails — no effort is sent
(honest degradation, never a fabricated level) and the effort segment is omitted; a repaint happens
when the catalog lands. Headless modes (`run`, `resume`, `--no-tui`) never send effort (it is a TUI
feature); the active agent itself IS applied there (system prompt and read-only narrowing).
Switching agents persists `agents.active` in the user layer, but an agent-declared model follows
`/model` semantics (a fresh session), and an explicit later `/model` choice wins until the agent is
re-selected. `reasoning_effort`/`reasoning.effort` are sent verbatim (validated against the active
model's `supportedLevels`); the remote provider is the final authority and may reject a level its
catalog no longer advertises — acceptance per level was verified against the test server, not the
public API. The reserved `agents` name was previously owned by the subagents plugin command: the
task-management verbs (with an argument) still route to the plugin, but the editor autocomplete and
`/help` show only the TUI command; task management stays reachable as `/agents <verb>` and
`/command agents <verb>`. The picker interactions of `/agents` and `/effort` were not verified in a
pseudo-terminal (their pure logic and status-line parts were).
