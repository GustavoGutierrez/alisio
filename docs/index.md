---
layout: home

hero:
  name: Alisio
  text: Build with agents you control
  tagline: "A provider-agnostic agent harness with its own tool loop: terminal, web UI and headless, permissioned tools, plans, subagents, plugins and data dashboards."
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

# Home features (rendered by BentoFeatures.vue). Keep EN and ES identical in order and keys.
# featured: exactly 3 large cards; the 1st is the tall one. more: any number of compact tiles.
# icon: terminal browser chart api shield layers memory plugin agent plan subagent mcp (see the component).
featuresHeading: "What you get"
moreHeading: "Also built in"
featured:
  - icon: terminal
    title: "Terminal UI and headless mode"
    details: "A full TUI with streaming Markdown, tool blocks and approvals, plus a headless mode with JSONL events."
    link: "/tui"
  - icon: browser
    title: "Web UI with alisio serve"
    details: "A local, token-protected browser UI for several workspaces and sessions, on the same agent core."
    link: "/web"
  - icon: chart
    title: "Dashboards and charts"
    details: "Python analysis publishes dashboards and reports as artifacts, with offline interactive charts."
    link: "/smart-dashboard"
more:
  - icon: api
    title: "Any OpenAI-compatible API"
    details: "Chat Completions or Responses"
    link: "/configuration"
  - icon: shield
    title: "Explicit permissions"
    details: "Reads by default; writes ask first"
    link: "/tools#permission-flags"
  - icon: layers
    title: "Context compaction"
    details: "Old history becomes safe checkpoints"
    link: "/compaction"
  - icon: memory
    title: "Persistent memory"
    details: "SQLite and FTS5, across projects"
    link: "/memory"
  - icon: plugin
    title: "Typed plugin SDK"
    details: "Tools, commands, events and hooks"
    link: "/plugins"
  - icon: agent
    title: "Agents"
    details: "Markdown agents; switch with /agents"
    link: "/agents"
  - icon: plan
    title: "Plan mode and plan viewer"
    details: "Read-only plan you approve first"
    link: "/plan"
  - icon: subagent
    title: "Subagents"
    details: "Child sessions with a live agent tree"
    link: "/subagents"
  - icon: mcp
    title: "MCP and Herdr"
    details: "MCP over stdio and HTTP, plus Herdr"
    link: "/tools#mcp"
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
