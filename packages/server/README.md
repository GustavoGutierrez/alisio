# @alisio/server

**The local HTTP + SSE server behind `alisio serve`.** It gives a browser multi-workspace,
multi-session access to the [Alisio](https://github.com/GustavoGutierrez/alisio) agent core.

## What it is

- `node:http` only (no web framework, no WebSocket): JSON routes under `/api` and one multiplexed
  Server-Sent Events stream per browser tab (`GET /api/events`).
- One `@alisio/core` `Application` per open workspace, created lazily and evicted when idle.
- Local security model: binds `127.0.0.1` by default, a per-process launch token exchanged for an
  `HttpOnly; SameSite=Strict` cookie, strict `Host`/`Origin` checks, a strict CSP and fail-closed
  approvals (no answer means deny).
- Runs on Node.js >= 22.16 and on Bun, with portable Node APIs only.

The CLI loads it with a dynamic `import("@alisio/server")` inside `alisio serve`, so `alisio`,
`alisio run` and the TUI never load it.

## Usage

Most people run it through the CLI:

```sh
alisio serve              # prints http://127.0.0.1:4317/?token=… and opens the browser
alisio serve --no-open --port 0 --allow-write
```

Embedding it directly:

```ts
import { startServer } from "@alisio/server";

const server = await startServer({ port: 0, app: { allowWrite: true } });
console.log(server.launchUrl);
// …
await server.close();
```

Plugins are not sandboxed: a trusted project's plugins run inside the server process with its
operating-system permissions. Remote access (`--host` other than loopback) requires
`--allow-remote` and has no TLS; prefer an SSH tunnel.

Documentation: <https://gustavogutierrez.github.io/alisio/web>.

## License

MIT
