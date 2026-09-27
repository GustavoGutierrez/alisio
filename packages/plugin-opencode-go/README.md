# @alisio/plugin-opencode-go

**The built-in OpenCode Go model provider for [Alisio](https://github.com/GustavoGutierrez/alisio).**
Discover the unauthenticated OpenCode Go catalog and route each model to the protocol OpenCode Go
documents for it.

## What it is

A `model-provider` plugin that registers the `opencode-go` provider with the Alisio host. It ships
as a built-in of the `alisio` CLI and is enabled by default. Model references use the canonical
`opencode-go/<model-id>` form.

## Installation

Preinstalled in the `alisio` CLI. For an embedded host, register it through `createApplication`'s
`builtins` list.

## Using it: `/connect`

1. Run `alisio`, then `/connect` and choose **OpenCode Go**.
2. Enter the **API key** (secret, required). It is stored only in the global credentials store
   (`credentials.json`, mode 0600) — never in the profile or configuration.
3. Pick a model from the discovered catalog (`https://opencode.ai/zen/go/v1/models`).

There is no hard-coded default API-key environment variable for this provider: the key is entered
in `/connect` and kept out of configuration files.

## Features

- Unauthenticated catalog discovery of `opencode-go/<model-id>` entries.
- Fail-closed routing from the documented endpoint table: GPT, Grok and Muse through **Responses**;
  open compatible families through **Chat Completions**; MiniMax and Qwen through
  **Anthropic Messages**.
- Unknown catalog entries are hidden rather than guessed.
- Requests send `user-agent: alisio/<version>` and an opaque, stable `x-opencode-session`
  conversation ID that never includes a workspace path, prompt or credential.

While registered, the provider also appears in `/model` and `alisio doctor`.

## Docs

[Configuration](https://gustavogutierrez.github.io/alisio/configuration) ·
[Plugins](https://gustavogutierrez.github.io/alisio/plugins).

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.