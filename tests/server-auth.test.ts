import { mkdtempSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthInfo } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type RunningServer, startServer } from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";
import { client, login, raw } from "./server-helpers.ts";

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
const start = async (extra: Parameters<typeof startServer>[0] = {}) => {
  server = await startServer({ port: 0, logger: createLogger("silent"), ...extra });
  return server;
};

describe("server auth (T-07)", () => {
  it("rejects API calls without the session cookie", async () => {
    const s = await start();
    const res = await raw(s.port, "/api/metrics");
    expect(res.status).toBe(401);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("unauthorized");
  });

  it("exchanges the launch token for an HttpOnly SameSite=Strict cookie and redirects with 303", async () => {
    const s = await start();
    const res = await raw(s.port, `/?token=${s.token}`);
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe("/");
    const cookie = String(res.headers["set-cookie"]);
    expect(cookie).toMatch(new RegExp(`^alisio_session_${s.port}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toContain(s.token);
    const authed = await raw(s.port, "/api/metrics", { headers: { Cookie: cookie.split(";")[0] } });
    expect(authed.status).toBe(200);
    expect(authed.json()).toMatchObject({ activeRuns: 0, openWorkspaces: 0 });
  });

  it("rejects a wrong launch token", async () => {
    const s = await start();
    expect((await raw(s.port, "/?token=nope")).status).toBe(401);
  });

  it("rejects a foreign Host header with 403 forbidden_host (DNS rebinding)", async () => {
    const s = await start();
    const res = await raw(s.port, "/api/health", { headers: { Host: `evil.test:${s.port}` } });
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("forbidden_host");
    const local = await raw(s.port, "/api/health", { headers: { Host: `localhost:${s.port}` } });
    expect(local.status).toBe(200);
  });

  it("rejects effectful requests with a foreign or missing Origin with 403 forbidden_origin", async () => {
    const s = await start();
    const cookie = await login(s.port, s.token);
    const foreign = await raw(s.port, "/api/workspaces", {
      method: "POST",
      body: {},
      headers: { Cookie: cookie, Origin: "http://evil.test", "Content-Type": "application/json" },
    });
    expect(foreign.status).toBe(403);
    expect(foreign.json<{ error: { code: string } }>().error.code).toBe("forbidden_origin");
    const missing = await raw(s.port, "/api/workspaces", {
      method: "POST",
      body: {},
      headers: { Cookie: cookie, "Content-Type": "application/json" },
    });
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("forbidden_origin");
  });

  it("requires application/json on effectful requests", async () => {
    const s = await start();
    const cookie = await login(s.port, s.token);
    const res = await raw(s.port, "/api/workspaces", {
      method: "POST",
      body: "x",
      headers: {
        Cookie: cookie,
        Origin: `http://127.0.0.1:${s.port}`,
        "Content-Type": "text/plain",
      },
    });
    expect(res.status).toBe(415);
  });

  it("refuses to bind a non-loopback address without allowRemote", async () => {
    await expect(startServer({ host: "0.0.0.0", port: 0 })).rejects.toThrow(/--allow-remote/);
  });

  it("serves an unauthenticated health report with the protocol version and capabilities", async () => {
    const s = await start({ version: "9.9.9" });
    const res = await raw(s.port, "/api/health");
    expect(res.status).toBe(200);
    const health = res.json<HealthInfo>();
    expect(health).toMatchObject({ name: "alisio", version: "9.9.9", protocolVersion: 1 });
    expect(health.capabilities.sse).toBe(true);
    expect(health.capabilities.websocket).toBe(false);
    expect(health.capabilities.uiBlocks).toContain("diff");
  });

  it("reports readiness and metrics to authenticated clients", async () => {
    const s = await start();
    const api = client(s.port, await login(s.port, s.token));
    expect((await api.get("/api/ready")).json()).toEqual({
      ready: true,
      workspaces: 0,
      activeRuns: 0,
    });
    expect(Object.keys((await api.get("/api/metrics")).json<object>()).sort()).toEqual(
      [
        "activeRuns",
        "openWorkspaces",
        "pendingApprovals",
        "queuedRuns",
        "sseDropped",
        "subscribers",
      ].sort(),
    );
  });

  it("sends the security headers and no-store on API responses", async () => {
    const s = await start();
    const res = await raw(s.port, "/api/health");
    expect(res.headers["content-security-policy"]).toContain("default-src 'self'");
    expect(res.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["cross-origin-opener-policy"]).toBe("same-origin");
    expect(res.headers["cross-origin-resource-policy"]).toBe("same-origin");
    expect(res.headers["cache-control"]).toBe("no-store");
  });
});

describe("static web assets", () => {
  it("serves a placeholder page when the web build is absent", async () => {
    const s = await start({ webRoot: join(tmpdir(), "alisio-no-such-web-root") });
    expect(s.webInstalled).toBe(false);
    const res = await raw(s.port, "/");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    expect(res.text).toContain("Alisio server is running");
  });

  it("serves the build with an SPA fallback, hashes inline scripts in the CSP and never escapes the root", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-web-"));
    await mkdir(join(root, "assets"));
    const inline = "document.documentElement.dataset.theme='dark'";
    await writeFile(join(root, "index.html"), `<html><script>${inline}</script></html>`);
    await writeFile(join(root, "assets", "app.js"), "console.log(1)");
    await writeFile(join(root, "..", "secret.txt"), "secret");
    const s = await start({ webRoot: root });
    expect(s.webInstalled).toBe(true);
    const index = await raw(s.port, "/sessions/abc");
    expect(index.text).toContain(inline);
    expect(index.headers["content-security-policy"]).toMatch(/script-src 'self' 'sha256-[^']+'/);
    const asset = await raw(s.port, "/assets/app.js");
    expect(asset.headers["content-type"]).toContain("text/javascript");
    expect(asset.headers["cache-control"]).toContain("immutable");
    const escape = await raw(s.port, "/..%2fsecret.txt");
    expect(escape.text).not.toContain("secret");
    expect((await raw(s.port, "/missing.js")).status).toBe(404);
  });
});
