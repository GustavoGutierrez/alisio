import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";

let server: RunningServer | undefined;
beforeEach(() => {
  // The server opens the shared session database under the state home: keep it temporary.
  const home = mkdtempSync(join(tmpdir(), "alisio-auth-"));
  vi.stubEnv("ALISIO_STATE_HOME", join(home, "state"));
  vi.stubEnv("ALISIO_CONFIG_HOME", join(home, "config"));
});
afterEach(async () => {
  await server?.close();
  server = undefined;
  vi.unstubAllEnvs();
});

describe("server http foundation", () => {
  it("answers unknown API routes with an ApiError carrying the request correlation id", async () => {
    server = await startServer({ port: 0, logger: createLogger("silent") });
    const res = await fetch(`${server.url}/api/nope`, { headers: { "X-Request-Id": "req-1" } });
    expect(res.status).toBe(404);
    expect(res.headers.get("x-request-id")).toBe("req-1");
    expect(await res.json()).toEqual({
      error: { code: "not_found", message: expect.any(String) },
      correlationId: "req-1",
    });
  });

  it("replaces a malformed X-Request-Id with a generated one", async () => {
    server = await startServer({ port: 0, logger: createLogger("silent") });
    const res = await fetch(`${server.url}/api/nope`, { headers: { "X-Request-Id": "bad id!" } });
    const id = res.headers.get("x-request-id");
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(((await res.json()) as { correlationId: string }).correlationId).toBe(id);
  });

  it("writes structured JSON log lines", () => {
    const lines: string[] = [];
    const log = createLogger("info", (line) => lines.push(line));
    log.debug("hidden");
    log.info("shown", { correlationId: "c", status: 200 });
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      level: "info",
      msg: "shown",
      correlationId: "c",
      status: 200,
    });
  });
});
