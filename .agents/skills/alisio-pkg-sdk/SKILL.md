---
name: alisio-pkg-sdk
description: "Editing packages/sdk (@alisio/sdk): the public plugin and wire contract (Plugin, PluginAPI, ToolDefinition, RunEvent, web protocol types), additive-change rules and what may live there. Use this skill whenever you change any type, helper or event in packages/sdk/src/index.ts, or add a field to something that crosses the server, web or plugin boundary."
---

# `@alisio/sdk`

Single file `packages/sdk/src/index.ts` (public contract, no dependencies). Used by core, server,
plugins and (types only) web. Plugin authoring guide: `alisio-plugins`.

## What lives here

- Plugin contract: `Plugin`, `PluginAPI`, `ToolDefinition`, `ToolContext`, `ViewDefinition`,
  extension point types, `ProviderRegistration`, `ModelProvider`, `SqlDatabase` port.
- Run events: `RunEvent`, `RunEventDataMap`, `KnownRunEvent`, ephemeral event helpers.
- Web protocol v1 wire types (`ServerFrame`, `ApiErrorCode`, `SessionDetailWire`...), Forja and
  dashboard types.
- Small runtime helpers only: `definePlugin`, `textResult`, `textProjection`, `UI_BLOCK_KINDS`,
  error classes (`OutputTruncatedError`, `ViewParamsError`, `DecisionProviderError`),
  `summarizeDecisionEvents`.

## Rules

- No provider SDKs, no runtime-specific imports, no Node-only modules, no new dependencies.
- Changes are additive: new fields optional, new event types allowed, nothing removed or renamed
  without a breaking-version decision by the owner. `RunEvent.schemaVersion` stays `1`.
- New host capabilities on `PluginAPI` are optional members (`views?`, `decisions?`, `paths?`, `proof?`) so
  plugins feature-detect on older cores.
- Consumers must ignore unknown fields/event types; document that in the type's comment.
- A type change usually needs: core implementation, server schema/route if on the wire, web
  store/i18n if shown, docs EN/ES, changeset (`pnpm changeset`), `docs/implementation-status.md`.
- Peer range: plugins pin `@alisio/sdk` to the current 0.x minor; a breaking change forces
  plugin republish, so keep the surface stable.

## Testing

Contract tests: `tests/run-events-contract.test.ts`, `tests/plugin-boundaries.test.ts`,
`tests/artifact-kinds.test.ts`. Typecheck (`pnpm typecheck`) is the main guard for pure types.
