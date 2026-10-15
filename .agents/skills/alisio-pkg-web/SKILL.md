---
name: alisio-pkg-web
description: "Working in packages/web (@alisio/web): the Preact + signals browser UI served by `alisio serve`: store, components, UI-block renderers, markdown, i18n EN/ES, accessibility, CSS modules, size budget and tests. Use this skill whenever you edit anything under packages/web, build or change a Web UI feature, renderer, panel or UI string."
---

# `@alisio/web` (private)

Preact 10 + `@preact/signals`, Vite build, CSS modules. Not React: JSX is `jsxImportSource: preact`.
Talks only to `@alisio/server` over HTTP/SSE; imports only types from `@alisio/sdk`
(`import type`), never `@alisio/core`. Related: `alisio-pkg-server`, `alisio-docs-screenshots`.

## Layout (`src/`)

| Dir | Role |
|---|---|
| `main.tsx`, `app.tsx` | bootstrap and shell |
| `store/` | signals over pure reducers; one module per area (`app.ts` controller, `sessions.ts`, `events.ts`, `goal.ts`, `modes.ts`, ...) |
| `net/` | `api.ts` (typed fetch client), `events.ts` (SSE client with reconnect) |
| `components/` | feature folders (`composer/`, `sidebar/`, `transcript/`, `settings/`, `plan/`, `tasks/`...), each with `*.module.css` |
| `renderers/` | UI block renderers (`registry.ts`, `RendererHost.tsx`; code, diff, json, terminal, mermaid, math...); unknown kinds fall back to labeled JSON |
| `markdown/` | incremental markdown + fences; sanitized with DOMPurify |
| `i18n/` | `en.ts` (source of keys, in the initial bundle), `es.ts` (lazy chunk), `t()` |
| `styles/` | `tokens.css`, `base.css` |

## Rules

- All user-visible text goes through `t()` with a key in BOTH `en.ts` and `es.ts` (same keys and
  placeholders; `es` is typed `Record<MessageKey, string>`). Settings labels: `components/settings/labels.ts`.
- Accessibility: semantic elements, labels and `aria-*` for controls, keyboard operable, visible
  focus, `lang` kept in sync (`setLocale`), respect reduced motion; do not rely on color alone.
- Security: render model/tool text only through the sanitizing markdown path or text nodes; never
  `dangerouslySetInnerHTML` with unsanitized data. CSP has no inline script and no `data:` fonts.
- Size budget (`pnpm web:size`): initial JS <= 90 KB gzip, CSS <= 20 KB gzip. Heavy libs (shiki,
  mermaid, katex) stay dynamic imports.
- Keep state logic in pure functions/reducers (testable without a DOM); components stay thin.
- Server data shape changes: update SDK types, `net/api.ts`, store, i18n, docs EN/ES, and add a
  screenshot per `alisio-docs-screenshots`.
- Persist only small per-user prefs via `store/storage.ts` (`readPref`/`writePref`).

## Proof card
`components/proof/` (`ProofView.tsx` is hook-free and pure, `ProofCard.tsx` wraps it as thread card and
dock tab, `strings.ts` EN/ES) and `store/proof.ts` are lazy chunks; the initial bundle only has
`store/proof-frame.ts`, `proofCount`/`proofTick` and the `/proof` hook. Tests walk the VNode tree of
`ProofView` (no DOM) in `tests/web-proof.test.ts`. Plan-review criteria choices: `store/plan-criteria.ts`.

## Testing

Vitest runs in Node (no DOM environment): test pure models, reducers and stores
(`tests/web-*.test.ts`, e.g. `web-composer`, `web-events`, `web-renderers`, `web-i18n`,
`web-layout-contract`). Typecheck the web separately: `pnpm typecheck` includes
`tsc -p packages/web --noEmit`. Build: `pnpm build` (Vite). Visual checks: Playwright against a
built `alisio serve`.
