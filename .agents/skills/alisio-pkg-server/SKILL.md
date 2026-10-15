---
name: alisio-pkg-server
description: "Working in packages/server (@alisio/server): the `alisio serve` HTTP + SSE API, router and route modules, launch-token auth, Host/Origin checks, request validation, workspace/session hosting, serving the web build. Use this skill whenever you add or change an HTTP route, SSE frame, auth rule, error code or anything under packages/server."
---

# `@alisio/server`

Depends only on `@alisio/core` and `@alisio/sdk`; `node:http` only, no HTTP or schema framework.
Entry: `src/index.ts` (`startServer(options): RunningServer`). Build copies `@alisio/web`'s dist
into `dist/web` (`scripts/copy-web.mjs`). Loaded lazily by the CLI (`packages/cli/src/serve.ts`).
Wire types come from `@alisio/sdk` (web protocol v1). Related: `alisio-pkg-web`, `alisio-architecture`.

## Layout (`src/`)

| Dir | Role |
|---|---|
| `http/` | `router.ts` (method + path with `:param` and trailing `*`), `errors.ts` (`HttpError`), `body.ts`, `static.ts` (CSP, SPA fallback to `index.html`) |
| `routes/` | one `register<Name>Routes(router, ctx)` per area (sessions, approvals, goal, tasks, files, providers, artifacts...); wired in `index.ts` |
| `host/` | multi-workspace hosting: `workspace-host.ts`, `sessions.ts` (`SessionService`), `run-scheduler.ts` |
| `auth/` | `guard.ts` (token cookie, `checkHost`, `checkOrigin`), `token.ts`, `view-token.ts` |
| `bridges/` | approval and interaction bridges (fail-closed approvals) |
| `sse/` | `hub.ts` (frame fan-out), `inflight.ts` (live run state for reconnects) |
| `schemas.ts` | hand-written request validation (`validation_failed` with field paths only) |

## Rules and gotchas

- Every `/api` route sits behind the same auth, Host and Origin rules; effectful requests need a
  matching `Origin`. Binding beyond loopback requires the explicit remote flag. Never weaken
  these checks or the CSP (`default-src 'self'`, no `data:` fonts).
- Errors are `HttpError(code, message)` with an `ApiErrorCode` from the SDK (add codes additively
  there). Never put secrets, request bodies, tokens or file contents in messages or logs.
- Responses carry `correlationId` (`X-Request-Id`), which also correlates run events.
- Approvals fail closed: no connected client means deny, never auto-allow.
- Add a route: create/extend `routes/<area>.ts`, register it in `index.ts`, add the wire type to
  the SDK if the web consumes it, add the call to `packages/web/src/net/api.ts`, docs EN/ES
  (`docs/web.md`), and a `tests/server-*.test.ts`.
- SSE frames are additive; clients ignore unknown frames.
- Added server work must stay free of runtime-specific APIs (Node and Bun).

## Proof routes (`routes/proof.ts`)
`GET /api/sessions/:sid/proof`, `POST …/proof/criteria` (create, or edit with `criterionId`),
`POST …/criteria/:id/not-applicable`, `GET …/proof/export?format=md|json`, and `POST
/api/sessions/:sid/goal/override` in `routes/goal.ts`. Reads use `SessionService.proof` (server store
connection); writes go through the workspace app (`app.proof`), refuse archived sessions and subagents,
and 404 a criterion of another session. The snapshot carries `proof: {criteria}` only when > 0.
Tests: `tests/proof-routes.test.ts`.

## Testing

`tests/server-helpers.ts` starts a real server on a free port with a scripted provider and issues
raw `node:http` requests (full header control, login helper). Cover: auth/Host/Origin refusal,
validation failures, happy path, 404 for foreign sessions, shutdown behavior. Reference tests:
`tests/server-http.test.ts`, `server-auth.test.ts`, `server-sse.test.ts`, `server-approvals.test.ts`.
