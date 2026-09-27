# @alisio/plugin-openai-compatible

**The built-in OpenAI-compatible model provider for [Alisio](https://github.com/GustavoGutierrez/alisio).**
Point it at any Chat Completions or Responses endpoint — OpenAI, a gateway, or a local server such
as llama.cpp — and use it from `/connect`.

## What it is

A `model-provider` plugin that registers the `openai-compatible` provider with the Alisio host. It
ships as a built-in of the `alisio` CLI and is enabled by default. Configuration and credentials
are supplied by the Alisio provider registry; the plugin does not persist secrets itself.

## Installation

Preinstalled in the `alisio` CLI. For an embedded host, register it through `createApplication`'s
`builtins` list.

## Using it: `/connect`

1. Run `alisio`, then `/connect` and choose **OpenAI compatible**.
2. Fields: **Base URL** (default `https://api.openai.com/v1`), **API key** (secret, optional),
   **API key environment variable** (default `OPENAI_API_KEY`), **API mode** (`chat` or
   `responses`), **Authentication** (`bearer` or `none`), **Token parameter** (`max_tokens`,
   `max_completion_tokens` or `omit`), **Stream usage** (boolean).
3. Pick a model from the discovered catalog — or enter one manually when the endpoint exposes no
   `GET /models` catalog (`/connect` then asks for an optional context window in tokens).

The key is read from the stored credential first, then from `process.env[apiKeyEnv]`:

```sh
export OPENAI_API_KEY=...   # never put the key in config files, profiles or READMEs
```

## Features

- Model discovery via `GET /models`; per-model context windows (overridable per profile).
- Chat Completions and Responses modes; bearer or no authentication; configurable token parameter.
- Tool calls, usage metadata, reasoning deltas and image attachments.
- Provider-native web search available when the API mode is `responses`.
- Legacy `provider` configuration (`baseURL`, `apiKeyEnv`, `model`, `apiMode`, `auth`,
  `tokenParameter`, `streamUsage`) keeps working for startup and headless runs.

While registered, the provider also appears in `/model` and `alisio doctor`.

## Docs

[Configuration](https://gustavogutierrez.github.io/alisio/configuration) ·
[Plugins](https://gustavogutierrez.github.io/alisio/plugins).

## Requirements

Node.js **>= 22.16** or Bun **>= 1.4.2**.

## License

MIT. Maintained by Gustavo Gutiérrez Mercado. Source: <https://github.com/GustavoGutierrez/alisio> ·
npm: <https://www.npmjs.com/settings/alisio/packages>.