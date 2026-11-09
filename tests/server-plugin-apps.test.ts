import type { BuiltinPlugin } from "@alisio/core";
import { type ApiError, definePlugin, type PluginAppInfo, type PluginInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createLogger } from "../packages/server/src/log.ts";
import { newSession, raw, startTestServer, type TestServer, until } from "./server-helpers.ts";

const events: string[] = [];
const workspaces: string[] = [];
const schema = {
  type: "object",
  properties: { text: { type: "string" } },
  additionalProperties: false,
};
const appsPlugin: BuiltinPlugin = {
  id: "appsy",
  name: "Appsy",
  description: "Apps",
  create: () =>
    definePlugin({
      id: "appsy",
      name: "Appsy",
      description: "Apps",
      version: "1.0.0",
      apiVersion: 1,
      setup(api) {
        api.apps?.register({
          id: "studio",
          label: { en: "Studio", es: "Estudio" },
          html: () =>
            '<!doctype html><script nonce="__ALISIO_NONCE__">a()</script><script nonce="__ALISIO_NONCE__">b()</script>',
          actions: {
            echo: {
              effect: "read",
              inputSchema: schema,
              handler: (input, ctx) => {
                workspaces.push(ctx.workspace);
                return { input, sessionId: ctx.sessionId, key: ctx.idempotencyKey };
              },
            },
            save: { effect: "write", inputSchema: schema, handler: () => ({ saved: true }) },
            big: {
              effect: "read",
              inputSchema: schema,
              handler: () => ({ blob: "x".repeat(5_000) }),
            },
            slow: {
              effect: "read",
              inputSchema: schema,
              handler: (_input, ctx) =>
                new Promise((_resolve, reject) => {
                  ctx.signal.addEventListener("abort", () => {
                    events.push("aborted");
                    reject(ctx.signal.reason);
                  });
                }),
            },
            boom: {
              effect: "read",
              inputSchema: schema,
              handler: () => {
                throw new Error("SELECT secret FROM private_table");
              },
            },
          },
        });
        api.apps?.register({ id: "huge", label: "Huge", html: () => "x".repeat(2_000) });
      },
    }),
};

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  events.length = 0;
  workspaces.length = 0;
});

async function start(extra: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer({
    ...extra,
    app: { builtins: [appsPlugin], trustProject: true, ...extra.app },
  });
  const session = await newSession(t);
  return { t, sid: session.id, wid: session.workspaceId };
}
const frame = (sid: string, plugin = "appsy", app = "studio") =>
  `/api/sessions/${sid}/apps/${plugin}/${app}/frame`;
const action = (sid: string, name: string, plugin = "appsy", app = "studio") =>
  `/api/sessions/${sid}/apps/${plugin}/${app}/actions/${name}`;
const codeOf = (res: { json<T>(): T }) => res.json<ApiError>().error.code;

describe("GET /api/workspaces/:wid/apps", () => {
  it("lists the apps of enabled plugins and nothing for disabled ones", async () => {
    const { t, wid } = await start();
    const list = (await t.api.get(`/api/workspaces/${wid}/apps`)).json<PluginAppInfo[]>();
    expect(list).toEqual([
      { plugin: "appsy", id: "huge", label: { en: "Huge" } },
      { plugin: "appsy", id: "studio", label: { en: "Studio", es: "Estudio" } },
    ]);
    const off = await t.api.patch(`/api/plugins/appsy?workspace=${wid}`, { enabled: false });
    expect(off.json<PluginInfo>().enabled).toBe(false);
    expect((await t.api.get(`/api/workspaces/${wid}/apps`)).json()).toEqual([]);
  });

  it("is an empty list without apps and 404 for an unknown workspace", async () => {
    t = await startTestServer({ app: { trustProject: true } });
    const session = await newSession(t);
    expect((await t.api.get(`/api/workspaces/${session.workspaceId}/apps`)).json()).toEqual([]);
    expect((await t.api.get("/api/workspaces/nope/apps")).status).toBe(404);
  });

  it("requires the session cookie", async () => {
    const { t, wid } = await start();
    expect((await raw(t.server.port, `/api/workspaces/${wid}/apps`)).status).toBe(401);
  });
});

describe("GET /api/sessions/:sid/apps/:plugin/:app/frame", () => {
  it("serves the HTML with a fresh nonce in every marker, the strict CSP and no caching", async () => {
    const { t, sid } = await start();
    const first = await t.api.get(frame(sid));
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toContain("text/html");
    expect(first.headers["cache-control"]).toBe("no-store");
    expect(first.headers["x-frame-options"]).toBeUndefined();
    const nonce = /nonce="([^"]+)"/.exec(first.text)?.[1] ?? "";
    expect(nonce.length).toBeGreaterThan(10);
    expect(first.text).not.toContain("__ALISIO_NONCE__");
    expect(first.text.split(`nonce="${nonce}"`)).toHaveLength(3);
    const csp = String(first.headers["content-security-policy"]);
    for (const directive of [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      "img-src data: blob:",
      "font-src data: blob:",
      "media-src data: blob:",
      "connect-src blob:",
      "worker-src blob:",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'self'",
    ])
      expect(csp).toContain(directive);
    expect(csp).not.toContain("allow-same-origin");
    const second = await t.api.get(frame(sid));
    expect(/nonce="([^"]+)"/.exec(second.text)?.[1]).not.toBe(nonce);
  });

  it("requires the cookie, a known Host and a same-origin Origin", async () => {
    const { t, sid } = await start();
    expect((await raw(t.server.port, frame(sid))).status).toBe(401);
    const rebound = await raw(t.server.port, frame(sid), {
      headers: { Cookie: t.cookie, Host: "evil.example" },
    });
    expect(codeOf(rebound)).toBe("forbidden_host");
    const foreign = await raw(t.server.port, frame(sid), {
      headers: { Cookie: t.cookie, Origin: "http://evil.example" },
    });
    expect(codeOf(foreign)).toBe("forbidden_origin");
  });

  it("answers the same 404 for unknown sessions, plugins, apps and disabled plugins", async () => {
    const { t, sid, wid } = await start();
    const unknown = await t.api.get(frame(sid, "ghost"));
    const missing = await t.api.get(frame(sid, "appsy", "ghost"));
    expect([unknown.status, missing.status]).toEqual([404, 404]);
    expect(unknown.json<ApiError>().error.message).toBe(missing.json<ApiError>().error.message);
    expect((await t.api.get(frame("no-such-session"))).status).toBe(404);
    await t.api.patch(`/api/plugins/appsy?workspace=${wid}`, { enabled: false });
    expect((await t.api.get(frame(sid))).status).toBe(404);
    await t.api.patch(`/api/plugins/appsy?workspace=${wid}`, { enabled: true });
    expect((await t.api.get(frame(sid))).status).toBe(200);
  });

  it("refuses an app larger than the HTML limit", async () => {
    const { t, sid } = await start({ apps: { limits: { htmlBytes: 1_000 } } });
    const res = await t.api.get(frame(sid, "appsy", "huge"));
    expect(res.status).toBe(502);
    expect(codeOf(res)).toBe("app_result_too_large");
  });
});

describe("POST /api/sessions/:sid/apps/:plugin/:app/actions/:action", () => {
  it("runs the action in the session of the route and never trusts the input for it", async () => {
    const { t, sid } = await start();
    const other = await newSession(t);
    const res = await t.api.post(action(sid, "echo"), {
      input: { text: "hi" },
      idempotencyKey: "k-1",
    });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ result: { input: { text: "hi" }, sessionId: sid, key: "k-1" } });
    const b = await t.api.post(action(other.id, "echo"), { input: {} });
    expect(b.json<{ result: { sessionId: string } }>().result.sessionId).toBe(other.id);
    const forged = await t.api.post(action(sid, "echo"), { input: { sessionId: other.id } });
    expect(forged.status).toBe(400);
    expect(workspaces).toHaveLength(2);
  });

  it("requires the cookie, a known Host and a same-origin Origin", async () => {
    const { t, sid } = await start();
    const path = action(sid, "echo");
    const origin = `http://127.0.0.1:${t.server.port}`;
    const json = { "Content-Type": "application/json" };
    const anonymous = await raw(t.server.port, path, {
      method: "POST",
      body: {},
      headers: { Origin: origin, ...json },
    });
    expect(anonymous.status).toBe(401);
    const rebound = await raw(t.server.port, path, {
      method: "POST",
      body: {},
      headers: { Cookie: t.cookie, Origin: origin, Host: "evil.example", ...json },
    });
    expect(codeOf(rebound)).toBe("forbidden_host");
    const foreign = await raw(t.server.port, path, {
      method: "POST",
      body: {},
      headers: { Cookie: t.cookie, Origin: "http://evil.example", ...json },
    });
    expect(codeOf(foreign)).toBe("forbidden_origin");
  });

  it("rejects invalid input with a code, never echoing the values", async () => {
    const { t, sid } = await start();
    const secret = "my-private-text";
    const res = await t.api.post(action(sid, "echo"), { input: { text: 5, extra: secret } });
    expect(res.status).toBe(400);
    expect(codeOf(res)).toBe("validation_failed");
    expect(res.text).not.toContain(secret);
    expect((await t.api.post(action(sid, "echo"), [1])).status).toBe(400);
  });

  it("rejects an effect the session has not granted, and allows it when granted", async () => {
    const { t, sid } = await start();
    const denied = await t.api.post(action(sid, "save"), { input: {} });
    expect(denied.status).toBe(403);
    expect(codeOf(denied)).toBe("app_action_denied");
    await t.close();
    const granted = await start({ app: { allowWrite: true } });
    const ok = await granted.t.api.post(action(granted.sid, "save"), { input: {} });
    expect(ok.json()).toEqual({ result: { saved: true } });
  });

  it("answers 404 for unknown actions, plugins and disabled plugins, re-checked per call", async () => {
    const { t, sid, wid } = await start();
    expect((await t.api.post(action(sid, "ghost"), {})).status).toBe(404);
    expect((await t.api.post(action(sid, "echo", "ghost"), {})).status).toBe(404);
    expect((await t.api.post(action(sid, "bad%20name"), {})).status).toBe(404);
    expect((await t.api.post(action(sid, "echo"), { input: {} })).status).toBe(200);
    await t.api.patch(`/api/plugins/appsy?workspace=${wid}`, { enabled: false });
    expect((await t.api.post(action(sid, "echo"), { input: {} })).status).toBe(404);
  });

  it("maps handler failures to a generic code and never logs inputs or messages", async () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    const { t, sid } = await start({ logger });
    await t.api.post(action(sid, "echo"), { input: { text: "confidential-needle" } });
    const boom = await t.api.post(action(sid, "boom"), { input: {} });
    expect(boom.status).toBe(502);
    expect(codeOf(boom)).toBe("app_action_failed");
    expect(boom.text).not.toMatch(/secret|private_table/);
    expect(lines.join("")).not.toMatch(/confidential-needle|private_table|secret/);
  });

  it("times out an action and aborts its signal", async () => {
    const { t, sid } = await start({ apps: { actionTimeoutMs: 40 } });
    const res = await t.api.post(action(sid, "slow"), { input: {} });
    expect(res.status).toBe(504);
    expect(codeOf(res)).toBe("app_action_timeout");
    await until(() => events.includes("aborted"));
  });

  it("caps the request and the result sizes", async () => {
    const { t, sid } = await start({
      apps: { limits: { requestBytes: 2_000, resultBytes: 1_000 } },
    });
    const large = await t.api.post(action(sid, "echo"), { input: { text: "a".repeat(5_000) } });
    expect(large.status).toBe(413);
    expect(codeOf(large)).toBe("payload_too_large");
    const result = await t.api.post(action(sid, "big"), { input: {} });
    expect(result.status).toBe(502);
    expect(codeOf(result)).toBe("app_result_too_large");
  });

  it("accepts bodies beyond the default 1 MiB JSON limit", async () => {
    const { t, sid } = await start();
    const res = await t.api.post(action(sid, "echo"), { input: { text: "a".repeat(2_000_000) } });
    expect(res.status).toBe(200);
  });
});
