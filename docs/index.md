---
layout: home

hero:
  name: Alisio
  text: Build with agents you control
  tagline: A provider-agnostic agent harness with its own tool loop: terminal, web UI and headless, permissioned tools, plans, subagents, plugins and data dashboards.
  image:
    src: /assets/logo.png
    alt: Alisio mascot
  actions:
    - theme: brand
      text: Quick start
      link: /quick-start
    - theme: alt
      text: Installation
      link: /installation
    - theme: alt
      text: Write a plugin
      link: /plugins

features:
  - title: Any OpenAI-compatible API
    details: Chat Completions or Responses, configurable base URL, model, key variable and token parameter. No bundled model or credentials.
  - title: Terminal UI and headless mode
    details: A full TUI with streaming Markdown, tool blocks, context bar and approvals, plus a headless run mode with versioned JSONL events.
  - title: Web UI with alisio serve
    details: A local, token-protected browser interface for several workspaces and sessions at once, with streaming, approvals, the / command palette and the same agent core as the terminal.
  - title: Explicit permissions
    details: Reads are available by default. Writes, processes, MCP and agent messaging require flags or an interactive approval.
  - title: Context compaction
    details: Structured checkpoints replace old history without ever separating a tool call from its result.
  - title: Persistent memory
    details: A built-in persistent memory plugin backed by SQLite and FTS5 that survives sessions and projects.
  - title: Typed plugin SDK
    details: Tools, commands, events, context, compaction and session hooks, model completions and a SQLite storage port.
  - title: Agents
    details: Create agents with the active model, from templates or by hand, store them as portable Markdown in .agents/agents and switch with /agents or /agent:&lt;id&gt; in the web UI and the TUI.
  - title: Plan mode and plan viewer
    details: A read-only plan agent proposes a plan you approve before anything changes, with optional Mermaid diagrams shown in a plan viewer in the web UI.
  - title: Dashboards and charts
    details: Python analysis publishes dashboards, reports and spreadsheets as artifacts; interactive charts are built with an embedded Chart.js, offline.
  - title: Subagents
    details: Delegate to specialized agents in child sessions, with a live agent tree, parallel git worktrees and cascade cancellation.
  - title: MCP and Herdr
    details: An MCP client (stdio and Streamable HTTP) with lazy, consent-gated connections, plus a Herdr report integration.
---

## What is Alisio?

<img data-component="brand-banner" src="/assets/banner.png" alt="Alisio — coding-agent harness" width="1447" height="680" />

Alisio is a coding-agent harness with its own TypeScript core. It connects to any OpenAI-compatible
endpoint, drives its own tool loop and runs in your terminal, either as an interactive TUI or
headless for scripts and CI.

<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading">
  <div data-component="preview-copy">
    <h2 id="alisio-web-ui-heading">Work across sessions in the Web UI</h2>
    <p>Run <code>alisio serve</code> for a local browser workspace with streaming conversations, approvals and file context.</p>
  </div>
  <figure>
    <img src="/assets/alisio-harness-web-ui.webp" alt="Alisio Harness Web UI showing workspace navigation, an active coding conversation and the file explorer" width="1833" height="990" loading="lazy" decoding="async" />
    <figcaption>The same agent core, available in a focused multi-workspace browser interface.</figcaption>
  </figure>
</section>

<section data-component="video" aria-labelledby="alisio-cli-demo-heading">
  <div data-component="video-copy">
    <h2 id="alisio-cli-demo-heading">See the CLI in action</h2>
    <p>A short look at Alisio running in the terminal, from a prompt to tool-assisted work.</p>
  </div>
  <video autoplay playsinline loop muted preload="auto" poster="/assets/alisio-cli-demo-poster.jpg">
    <source src="/assets/alisio-cli-demo.mp4" type="video/mp4" />
    Your browser does not support the Alisio CLI demonstration video.
  </video>
</section>

It includes:

- An interactive TUI and a headless CLI (`alisio run`, JSONL events, session resume).
- Local tools for reading, searching, editing, running processes and Git, gated by explicit permissions.
- Context compaction and a built-in persistent memory plugin.
- [Agents](/agents): model-assisted creation, templates, project/global `.agents/agents` files and switching from the web UI and the TUI.
- [Plan mode and plan review](/plan): a read-only plan agent, optional diagrams and a plan viewer in the web UI.
- Python analysis with dashboards and [charts](/analysis#charts) published as artifacts.
- Subagents: delegation to specialized agents in child sessions, with a live agent tree.
- Hierarchical [`AGENTS.md` instructions and Agent Skills](/context).
- An MCP client (stdio and Streamable HTTP) and a Herdr integration.
- A typed plugin SDK (`@alisio/sdk`) for tools, commands, hooks and storage.

Alisio `__ALISIO_VERSION__` is a **stable** release, still pre-1.0: minor versions may include breaking changes (see [Stability and versioning](/publishing#stability-and-versioning)). Read [Known limitations](/limitations) before relying
on it, and remember that it is **not a sandbox**: tools and plugins run with your user privileges.

Next steps: [Installation](/installation) · [Quick start](/quick-start) · [Configuration](/configuration).
