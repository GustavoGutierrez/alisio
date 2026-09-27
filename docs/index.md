---
layout: home

hero:
  name: Alisio
  text: Speed and efficiency for building
  tagline: An extensible, provider-agnostic coding-agent harness for your terminal.
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
  - title: Explicit permissions
    details: Reads are available by default. Writes, processes, MCP and agent messaging require flags or an interactive approval.
  - title: Context compaction
    details: Structured checkpoints replace old history without ever separating a tool call from its result.
  - title: Persistent memory
    details: A built-in, Engram-style memory plugin backed by SQLite and FTS5 that survives sessions and projects.
  - title: Typed plugin SDK
    details: Tools, commands, events, context, compaction and session hooks, model completions and a SQLite storage port.
  - title: Subagents
    details: Delegate to specialized agents in child sessions, with a live agent tree, parallel git worktrees and cascade cancellation.
  - title: MCP and Herdr
    details: An MCP client (stdio and Streamable HTTP) with lazy, consent-gated connections, plus a Herdr report integration.
---

## What is Alisio?

![Alisio banner](</assets/banner.png>)

Alisio is a coding-agent harness with its own TypeScript core. It connects to any OpenAI-compatible
endpoint, drives its own tool loop and runs in your terminal, either as an interactive TUI or
headless for scripts and CI.

It includes:

- An interactive TUI and a headless CLI (`alisio run`, JSONL events, session resume).
- Local tools for reading, searching, editing, running processes and Git, gated by explicit permissions.
- Context compaction and a built-in persistent memory plugin.
- Subagents: delegation to specialized agents in child sessions, with a live agent tree.
- Hierarchical [`AGENTS.md` instructions and Agent Skills](/context).
- An MCP client (stdio and Streamable HTTP) and a Herdr integration.
- A typed plugin SDK (`@alisio/sdk`) for tools, commands, hooks and storage.

Alisio is an **alpha** (`0.1.0-alpha.1`). Read [Known limitations](/limitations) before relying
on it, and remember that it is **not a sandbox**: tools and plugins run with your user privileges.

Next steps: [Installation](/installation) · [Quick start](/quick-start) · [Configuration](/configuration).
