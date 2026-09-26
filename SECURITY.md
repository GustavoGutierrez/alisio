# Security Policy

Alisio is a coding-agent harness. It runs your local tools and model requests with
**your user privileges**, and plugins and subprocesses execute in your process — they are
**not sandboxes** (see [Tools & permissions](https://gustavogutierrez.github.io/alisio/tools)
and `docs/tools.md`). Please read the scope below before reporting.

## Supported versions

Alisio is currently in **alpha** (previous versions: `0.1.0-alpha.x`) and is evolving quickly.
Only the **latest published alpha** of `@alisio/alisio-code` receives security fixes. When
reporting, tell us which version you are on (`alisio --version`) and how you installed it
(npm package, standalone binary, or the repository `main` branch).

## Reporting a vulnerability

**Do not open a public issue that contains exploit details, credentials, or secrets.**

Please report privately through the repository's **GitHub Security Advisories** flow:

1. On <https://github.com/GustavoGutierrez/alisio>, open **Security** → **Report a vulnerability**.
2. Include:
   - The affected component (core, SDK, a plugin, CLI, MCP, or docs).
   - The version and install method.
   - A minimal reproduction, without embedding any real API key or credential.
   - The impact you believe it has.

You will get an acknowledgement within **3 business days**, and we will keep you updated
with the triage result and a target fix time. We follow coordinated disclosure: we will
not release details before a fix is available unless you tell us the issue is already public.

## Scope

- **In scope:** the TypeScript core (`packages/core`), the public SDK (`packages/sdk`),
  the published plugin packages (`packages/plugin-*`), the CLI (`packages/cli`), and the
  documentation when it misleads about security-relevant behavior.
- **Out of scope:** secrets mishandled by things Alisio does not control (your endpoint,
  your environment), denial-of-service by the model itself, and any behavior of third-party
  plugins or MCP servers you choose to load. A plugin manifest or a subprocess is **never**
  a security boundary: any code you load or run has your privileges.

## What we consider sensitive

- **Never post real API keys.** Alisio only reads keys from `credentials.json`
  (mode `0600`) or a configured environment variable; do not paste either into an issue,
  a log, or a gist. If you believe you leaked one, revoke it and report it privately.
- **Never post session databases or memory databases** (`sessions.sqlite`,
  `memory.sqlite`): they contain conversations and tool results.

## Security-relevant design notes

- Credentials are stored separately from profiles: `<config home>/credentials.json`
  (written atomically, mode `0600`, directory `0700` where POSIX permissions exist).
  This is filesystem protection, **not encryption**.
- Provider profiles remember the name of their API key environment variable
  (`values.apiKeyEnv`) so the environment fallback keeps working; keys themselves are
  only read from the credentials store or that environment variable.
- Direct MCP `env` values are passed only to that stdio child and are never shown in
  diagnostics.
- If you find that a diagnostic, event, or startup output reveals a credential or secret,
  report it as a vulnerability even if nothing was exploited.