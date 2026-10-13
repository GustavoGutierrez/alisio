---
layout: home

hero:
  name: Alisio
  text: Your coding agent, on the model you choose
  tagline: "Connect any OpenAI-compatible model to your project: it reads and edits code behind explicit permissions, runs JavaScript in isolation and Python for data analysis, and publishes dashboards. In your terminal, your browser or CI."
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
    title: "Code mode and dashboards"
    details: "Forja lets the agent solve with code: isolated JavaScript to combine tools, Python for data, AI and dashboards published as artifacts."
    link: "/forja"
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

<div class="alisio-whatis" data-component="whatis">

## What is Alisio?

<div class="whatis-intro whatis-item" style="--i: 0">
<div class="whatis-logo">
<img data-component="brand-banner" src="/assets/banner.webp" alt="Alisio — coding agent for any OpenAI-compatible model" width="1000" height="470" decoding="async" />
</div>
<div class="whatis-def">

Alisio is a coding agent with its own TypeScript core. It connects to any OpenAI-compatible
endpoint, drives its own tool loop and runs in your terminal, either as an interactive TUI or
headless for scripts and CI, or in your browser with `alisio serve`. When code is the faster route,
it writes and runs it with [Forja](/forja): isolated JavaScript, and Python for data analysis.

</div>
</div>

<div class="whatis-media">
<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="whatis-item whatis-card" style="--i: 1">
  <div data-component="preview-copy">
    <h3 id="alisio-web-ui-heading">Work across sessions in the Web UI</h3>
    <p>Run <code>alisio serve</code> for a local browser workspace with streaming conversations, approvals and file context.</p>
  </div>
  <figure>
    <div class="shot-frame">
    <img src="/assets/alisio-harness-web-ui.webp" alt="Alisio Harness Web UI showing workspace navigation, an active coding conversation and the file explorer" width="1833" height="990" loading="lazy" decoding="async" />
    <button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Close" aria-label="View the Web UI screenshot larger"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    </div>
    <figcaption>The same agent core, available in a focused multi-workspace browser interface.</figcaption>
  </figure>
</section>
<section data-component="video" aria-labelledby="alisio-cli-demo-heading" class="whatis-item whatis-card" style="--i: 2">
  <div data-component="video-copy">
    <h3 id="alisio-cli-demo-heading">See the CLI in action</h3>
    <p>A short look at Alisio running in the terminal, from a prompt to tool-assisted work.</p>
  </div>
  <div class="video-frame">
    <video autoplay playsinline loop muted preload="metadata" width="960" height="500" poster="/assets/alisio-cli-demo-poster.jpg">
      <source src="/assets/alisio-cli-demo.mp4" type="video/mp4" />
      Your browser does not support the Alisio CLI demonstration video.
    </video>
    <button type="button" class="media-btn media-expand" data-expand="video" hidden data-label-close="Close" aria-label="View the CLI demo larger"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    <button type="button" class="media-btn video-toggle" data-video-toggle hidden data-label-pause="Pause the CLI demo video" data-label-play="Play the CLI demo video" aria-label="Pause the CLI demo video">
      <svg class="icon-pause" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5v14M16 5v14" /></svg>
      <svg class="icon-play" viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M8 5l11 7-11 7z" /></svg>
    </button>
  </div>
</section>
</div>

<h3 class="whatis-sub whatis-item" style="--i: 3">Code mode with Forja: the language follows the goal</h3>

<div class="whatis-facts whatis-forge">

- **[JavaScript for everything else](/forja#language)** `js_run` combines several tool calls, filters and paginates results, and transforms JSON and text. It runs in a fresh QuickJS WebAssembly VM with no file, network or process access: it can only call Alisio tools, under the same permissions as the agent.
- **[Python for data analysis and AI](/forja#isolation)** `python_run` covers pandas and NumPy, statistics, scikit-learn, charts and custom dashboards. It runs in a container (`oci`) or in a restricted Pyodide WebAssembly process (`wasm`) when available; with `analysis.isolation: required` it never runs unsandboxed.
- **[Context on demand](/forja#forge-guide)** With `forge_guide`, the guide for each language loads only when the task needs it, adapted to the engines and packages actually installed, so the prompt stays small.

</div>

<h3 class="whatis-sub whatis-item" style="--i: 4">Under the hood</h3>

<div class="whatis-facts">

- **[Headless runs](/tui)** `alisio run` with JSONL events and session resume, for scripts and CI.
- **[Local tools](/tools)** Read, search, edit, run processes and Git, all gated by explicit permissions.
- **[Project context](/context)** Hierarchical `AGENTS.md` instructions and Agent Skills.

</div>

<div class="whatis-closing whatis-item" style="--i: 7">
<div class="whatis-note">

Alisio `__ALISIO_VERSION__` is a **stable** release, still pre-1.0: minor versions may include breaking changes (see [Stability and versioning](/publishing#stability-and-versioning)). Read [Known limitations](/limitations) before relying
on it. Alisio as a whole is **not a sandbox**: the shell, local tools and plugins run with your user
privileges. Only Forja isolates code (`js_run`, and Python on the `oci` or `wasm` backends), with the
limits documented in [Forja](/forja).

</div>
<div class="whatis-next">
<h3>Next steps</h3>

[Installation](/installation) [Quick start](/quick-start) [Configuration](/configuration)

</div>
</div>

</div>
