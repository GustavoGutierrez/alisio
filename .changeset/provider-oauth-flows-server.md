---
"@alisio/server": minor
---

Provider sign-in flows over HTTP. `POST /api/providers/:profile/auth/:method/start` (202 with a
`flowId`), `GET .../auth/flows/:flowId?after=n` (steps, the one pending prompt and the outcome, never a
token, authorization code or prompt answer), `POST .../input` and `DELETE .../flows/:flowId`, behind the
existing Host, Origin, cookie and JSON checks; the three that change state are refused under
`--read-only`. `GET /api/providers` adds `types[].auth` (no functions) and a synthetic `oauth`
credential with `state` and `expires` and no tail. `DELETE .../credentials` also cancels the active
flow and removes the session, and a `PUT` that changes a profile's provider type cancels its flow. New
`localBrowser` server option (declarative: the browser runs on this machine, set by the desktop app).
SSE frames, `ApiError` messages and log lines are now redacted for known token values and JWTs.
