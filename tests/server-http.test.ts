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

describe("router trailing wildcard", () => {
  it("captures the rest of the path in params['*'] and keeps exact routes exact", async () => {
    const { Router } = await import("../packages/server/src/http/router.ts");
    const router = new Router();
    const files = () => ({ body: "files" });
    const one = () => ({ body: "one" });
    router.get("/api/artifacts/:aid/files/*", files);
    router.get("/api/artifacts/:aid", one);
    const matched = router.match("GET", "/api/artifacts/art_1/files/assets/app%20v2.js");
    expect(matched).toMatchObject({
      handler: files,
      params: { aid: "art_1", "*": "assets/app v2.js" },
    });
    // Decoding happens per segment: an encoded slash never creates a segment.
    expect(router.match("GET", "/api/artifacts/a/files/x%2Fy")).toMatchObject({
      params: { "*": "x/y" },
    });
    // The wildcard needs at least one segment, and other methods only match the path.
    expect(router.match("GET", "/api/artifacts/a/files")).toBeUndefined();
    expect(router.match("POST", "/api/artifacts/a/files/x")).toBe("method");
    expect(router.match("GET", "/api/artifacts/a")).toMatchObject({ handler: one });
    // A malformed escape does not match (404) instead of throwing.
    expect(router.match("GET", "/api/artifacts/a/files/%E0%A4%A")).toBeUndefined();
  });
});
