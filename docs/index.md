---
layout: home

hero:
  name: Alisio
  text: "Your work. With more possibilities."
  tagline: "AI that works with you."
  image:
    src: /assets/logo.png
    alt: Alisio mascot
  actions:
    - theme: brand
      text: Download Alisio
      link: /#download
    - theme: alt
      text: See how it works
      link: /#how-it-works

# Lead paragraph right after the hero (rendered by HomeIntro.vue).
intro: "Work with documents and data, find apps for your tasks and build your own plugins by describing what you need. Alisio brings artificial intelligence to your daily work, from a desktop app."

# Home features (rendered by BentoFeatures.vue). Keep EN and ES identical in order and keys.
# featured: exactly 3 large cards; the 1st is the tall one. more: any number of compact tiles.
# A featured item takes either `link` (whole card) or `links` (+ optional `chips`, the plugin visual labels).
# icon: terminal browser chart api shield layers memory plugin agent plan subagent mcp (see the component).
featuresHeading: "What Alisio gives you"
moreHeading: "Also included"
featured:
  - icon: plugin
    title: "Find tools for your work"
    details: "Explore the plugin catalog and install what you need in one click: thesis writing, literature research, printable math exams, certificates and cards. Installed plugins can be updated or removed from the same screen."
    chips: ["Thesis", "Exams", "Certificates", "Research", "Web search"]
    links:
      - text: "Plugin catalog in the app"
        link: "/web#plugin-catalog"
      - text: "Browse the plugin catalog"
        link: "https://gustavogutierrez.github.io/alisio-plugins/"
        external: true
  - icon: agent
    title: "Build a helper made for you"
    details: "Describe a task you repeat, in your own words. The plugin creator builds the plugin, checks it and lets you decide when to install it, even with its own screen in the Apps menu."
    link: "/plugin-creator"
  - icon: chart
    title: "Get results you can use"
    details: "Work with your documents and data and get PDFs, spreadsheets, charts, reports and dashboards you can review, adjust, open, print or share."
    link: "/smart-dashboard"
more:
  - icon: mcp
    title: "Connect a tool or service"
    details: "A catalog with guided sign-in and a connection check"
    link: "/mcp-catalog"
  - icon: shield
    title: "You approve the changes"
    details: "Alisio asks before it changes files or runs programs"
    link: "/tools#permission-flags"
  - icon: api
    title: "The model you choose"
    details: "An online service or a model on your own computer"
    link: "/configuration"
  - icon: plan
    title: "A plan before acting"
    details: "Review and approve the steps first"
    link: "/plan"
  - icon: memory
    title: "It remembers what matters"
    details: "Notes that carry across your projects"
    link: "/memory"
  - icon: browser
    title: "Also in your browser"
    details: "The same interface, opened in your browser"
    link: "/web"
  - icon: terminal
    title: "Advanced: terminal and scripts"
    details: "A terminal interface and a mode for scripts"
    link: "/tui"
  - icon: plugin
    title: "Advanced: write plugins in code"
    details: "A typed plugin kit for developers"
    link: "/plugins"
---

<div class="alisio-whatis" data-component="whatis">

## What is Alisio?

<div class="whatis-intro whatis-item" style="--i: 0">
<div class="whatis-logo">
<img data-component="brand-banner" src="/assets/banner.webp" alt="Alisio — AI that works with you" width="1000" height="470" decoding="async" />
</div>
<div class="whatis-def">

Alisio is a desktop app with artificial intelligence that helps you with tasks from your work, your
studies and your daily life. Describe what you need: Alisio organizes the steps, uses the tools
available and helps you reach a result you can review and use. It works with the files in the folder
you choose, asks before it changes anything and lets you add [apps for your work](#apps), from the
catalog or built by you. Teachers, students, office staff, accountants and anyone at home can start
without learning new technical terms; programming is still possible, as an advanced use.

</div>
</div>

<div class="whatis-media">
<section data-component="web-ui-preview" aria-labelledby="alisio-web-ui-heading" class="whatis-item whatis-card" style="--i: 1">
  <div data-component="preview-copy">
    <h3 id="alisio-web-ui-heading">Conversation, files and approvals in one window</h3>
    <p>Ask in your own words, see what Alisio is doing and approve each change. The desktop app shows this interface in its own window; it also opens in your browser.</p>
  </div>
  <figure>
    <div class="shot-frame">
    <img src="/assets/alisio-harness-web-ui.webp" alt="The Alisio interface showing the project list, an active conversation about code and the file explorer" width="1833" height="990" loading="lazy" decoding="async" />
    <button type="button" class="media-btn media-expand" data-expand="image" hidden data-label-close="Close" aria-label="View the Web UI screenshot larger"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7" /></svg></button>
    </div>
    <figcaption>The Alisio interface: your projects on the left, the conversation in the middle and your files on the right.</figcaption>
  </figure>
</section>
<section data-component="video" aria-labelledby="alisio-cli-demo-heading" class="whatis-item whatis-card" style="--i: 2">
  <div data-component="video-copy">
    <h3 id="alisio-cli-demo-heading">For advanced use: the terminal</h3>
    <p>Programming is an advanced, optional use. This short clip shows Alisio in the terminal, the path for developers and scripts.</p>
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

<h3 class="whatis-sub whatis-item" style="--i: 3">What can it help you with?</h3>

<div class="whatis-facts">

- **[Turn a spreadsheet into a report](/smart-dashboard)** Attach a CSV or Excel table and ask for a summary with charts. You get a dashboard or a report you can open, check and share.
- **[Prepare a printable exam](/about#who-it-is-for)** With the Evalúa plugin, a teacher prepares a school **math** exam as a printable document, reviews it and reuses its format. Today it covers school math only.
- **[Make certificates and cards](/about#who-it-is-for)** With the Cardsmith plugin, office staff prepare certificates, cards and charts from their own data.

</div>

## How you work with Alisio {#how-it-works}

<div class="whatis-facts home-steps">

- **1. Choose** Open the folder you want to work on and describe the task in your own words, or open an app from the **Apps** menu.
- **2. Provide** Add the files and data that are missing. Alisio reads the folder you opened and, in the **Ask** permission mode, asks before it changes a file, runs a program or uses the internet.
- **3. Review** The result appears as a document, table, chart or app. Check it, ask for corrections, then save, print or share it. You keep the final word.

</div>

## Apps for your work {#apps}

<div class="home-lead">

Plugins add tools and apps for a profession. You find them in **Settings → Plugins → Plugin
catalog**, install a private one from a file, or create your own with the
[plugin creator](/plugin-creator). Connections to other tools and services come from the
[MCP catalog](/mcp-catalog), with guided sign-in, a connection check and one-click removal.

</div>

<div class="home-table">

| What you want to do | What it uses | Status |
| --- | --- | --- |
| Analyze CSV and Excel tables, charts, reports and dashboards | Built in ([Smart Dashboard](/smart-dashboard), [Forja](/forja)) | Included |
| Designed PDF documents | Built in ([Designed PDFs](/documents)) | Included |
| Printable exams | `@alisio/plugin-evalua` | Plugin to install; school math only |
| Thesis writing and literature research | `@alisio/plugin-thesis`, `@alisio/plugin-literature-research` | Plugins to install |
| Certificates, cards and charts | `@alisio/plugin-cardsmith` | Plugin to install |
| A helper for your own task | [Plugin creator](/plugin-creator) | Included |
| Connect a tool or service | [MCP catalog](/mcp-catalog) | Included |

</div>

<div class="home-note">

The quality of a result depends on the plugin, the model and the services you use. In health,
accounting, education or any sensitive decision, Alisio supports your work; it does not replace your
professional judgment.

</div>

## Your data and permissions {#data-and-permissions}

<div class="whatis-facts home-trust">

- **You choose the folder.** Alisio works with the folder you open. In the **Ask** permission mode
  it asks before it changes a file, runs a program or uses the internet; other modes let more run
  without asking, and you can switch at any time. See [Permission modes](/tools#permission-modes).
- **Working with local files is not the same as keeping everything on your computer.** Your
  conversations and settings are saved on your computer, but what Alisio reads to answer you is sent
  to the model you configured. With an online service, that service receives it; connected tools
  and services receive what they need for their task.
- **Keys stay protected.** Keys are stored as credentials, never in plain configuration files.
- **Not a sandbox.** Plugins and programs run with your user's permissions; install only what you
  trust.

</div>

## Requirements and frequently asked questions {#faq}

<h3 class="whatis-sub">Requirements</h3>

<div class="whatis-facts home-reqs">

- **Operating system** <span class="home-chips"><span>Windows 10 or 11 (x64)</span> <span>macOS (Apple Silicon or Intel)</span> <span>Linux (x86_64)</span></span>
- **A model to work with** A key from an online model service, or a compatible model server on your own computer.
- **Extra programs** Some tasks need extra programs, for example Python 3.10 or newer to read Excel files; Alisio tells you what is missing.
- **First launch** The installers are not signed, so the first launch needs one extra step (see [Desktop app](/desktop#unsigned)).

</div>

<h3 class="whatis-sub">Frequently asked questions</h3>

<div class="home-faq">

<details class="home-faq-item">
<summary>Do I need to know how to program?</summary>

No. You install the app, connect a model in **Settings → Models**, open a folder and describe the
task. Plugins install from the catalog and the plugin creator builds new ones from a description.
Current limits: some services in the MCP catalog still need manual setup.

</details>

<details class="home-faq-item">
<summary>Is it free?</summary>

Alisio is free and open source, under the MIT license. The model you connect may have its own cost:
online model services charge according to their own prices, and some connected services require an
account. A model running on your own computer has no service fee.

</details>

<details class="home-faq-item">
<summary>Do my files leave my computer?</summary>

It depends on what you connect. Alisio and your sessions live on your computer, but the content it
reads to help you is sent to the model you configured and, when you use them, to the connected tools
and services. With a model on your own computer, that content stays on it, except for tools that use
the internet.

</details>

<details class="home-faq-item">
<summary>Does it work without internet?</summary>

It depends on the model and the tool. With an online model you need internet. With a model running
on your own computer, Alisio can work offline, but installing plugins, refreshing the catalogs, web
search and online services need a connection.

</details>

<details class="home-faq-item">
<summary>Can I use it in my job?</summary>

Yes, for the tasks in [Apps for your work](#apps): data analysis and reports, designed PDFs, school
math exams, thesis writing, certificates and cards. For other tasks, check whether a plugin exists or
build one with the plugin creator. Review every result before you use it.

</details>

</div>

<h3 class="whatis-sub whatis-item" style="--i: 4">Advanced use: code mode with Forja</h3>

<div class="whatis-facts whatis-forge">

- **[JavaScript for everything else](/forja#language)** `js_run` combines several tool calls, filters and paginates results, and transforms JSON and text. It runs in a fresh QuickJS WebAssembly VM with no file, network or process access: it can only call Alisio tools, under the same permissions as the agent.
- **[Python for data analysis and AI](/forja#isolation)** `python_run` covers pandas and NumPy, statistics, scikit-learn, charts and custom dashboards. It runs in a container (`oci`) or in a restricted Pyodide WebAssembly process (`wasm`) when available; with `analysis.isolation: required` it never runs unsandboxed.
- **[Context on demand](/forja#forge-guide)** With `forge_guide`, the guide for each language loads only when the task needs it, adapted to the engines and packages actually installed, so the prompt stays small.

</div>

<h3 class="whatis-sub whatis-item" style="--i: 5">For developers and advanced use</h3>

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
<h3>Next step</h3>

[Download Alisio](/desktop#download-and-install) [Quick start](/quick-start) [Installation](/installation)

</div>
</div>

</div>
