# Known limitations

This page is an English translation of the limitations and pending work recorded in
[`docs/implementation-status.md`](https://github.com/GustavoGutierrez/alisio/blob/main/docs/implementation-status.md).
That Spanish file in the repository is the source of truth; the
[Spanish version of this page](/es/limitations) includes it verbatim.

Alisio `0.1.0-alpha.1` is a functional alpha. The original specification sets the product direction;
it is not a statement that all of its release criteria are met.

## Pending to stabilize v0.1

- Run and tune a Windows/macOS matrix; current CI covers Linux and does not certify other systems.
- Validate real providers and models with the user's credentials.
- Validate Herdr with a real server/PTY; add a native launcher/resumer if Herdr allows it.
- Session checkpoints/rewind and vector memory: they do not exist.
- Interactive onboarding; configurable color themes; expandable reasoning view.
- First real npm publication and release with binaries (workflows prepared, not executed); SemVer
  ranges for plugins and reload in an idle session.
- Automatic discovery of Pi paths and incremental watch.
- Interactive MCP OAuth, explicit reconnection in the CLI and MCP multimedia capabilities.
- Remote OpenTelemetry, memory metrics and large-repository benchmarks.
- Hardening against hostile processes and filesystem races. No OS sandbox is offered.

## Known limits

- **Runtime**: Node does not load `.env` automatically (Bun does); use environment variables or
  `node --env-file=.env`. Local `.ts` plugins require Bun or Node >= 22.18; npm plugin packages must
  be published as JavaScript. The `alisio-source` export condition is only used in development
  inside the monorepo and is not published.
- Provisional MIT license (holder: Gustavo Gutiérrez), pending confirmation.
- **Memory**: search uses the trigram tokenizer, so terms shorter than 3 characters are ignored. No
  semantic search. The automatic end-of-session summary only runs in the TUI (not in headless `run`)
  and is bounded by `pluginHooks.sessionEndTimeoutMs`; if it expires, exit continues without a
  summary. The end-of-session summary replaces the archived checkpoint of the same session (one
  summary per session). User prompts are copied to the memory database (with `<private>` redacted)
  on compaction and on exit; the database is local with 0600 permissions.
- **Differences with Engram**: the sessions table is named `memory_sessions` (the database may share a
  file with Alisio's sessions); there is no FTS over prompts; a `topic_key` in `personal` scope
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
- `provider.contextWindow` applies only to the configured model; after `/model`, the window comes from
  `GET /models` or stays unknown (and threshold-based automatic compaction is disabled for that
  model, except through `limits.maxContextChars`).
- **Compaction** uses the current provider; its token usage is not added to the `limits.maxTokens`
  budget. Before/after estimates are approximate (about 4 characters per token). Responses opaque
  items of the summarized span are discarded; kept ones do not change. A session with uncertain tool
  results is not compacted until it is recovered.
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

## Verification scope

Runtime and packaging: unit and integration tests run under Node (a subset also on Bun); `test:cli`
runs the built CLI on Node (verified on 22.19 and the 22.16.0 minimum) and `test:compiled` runs the
Bun binary, both against a simulated provider; `pack:check` validates the four packages; a real
global npm install from local tarballs was smoke-tested; `scripts/install.sh` was tested against a
local mirror (checksum install and rejection of a tampered binary). No npm publication or release
was executed, the release and Pages workflows were not run on GitHub, and macOS/Windows/arm64
binaries (Bun cross-compilation) were not tested.

Provider tests use a deterministic local HTTP server, not an external account. MCP is tested with the
real server SDK over local processes/HTTP. The Linux binary runs a full cycle, loads an external
plugin with a dependency and keeps the session. The TUI was verified manually in a pseudo-terminal on
Linux (and against a real DeepSeek model), but not on Windows/macOS or in other real terminal
emulators (kitty, iTerm2, Windows Terminal). Real copies through `xclip`/`wl-copy`/`pbcopy`/Windows
and an automatic compaction with a real provider were not verified. The full detail is in the
source file linked above.
