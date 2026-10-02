import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinPlugin } from "@alisio/core";
import { type ApiError, definePlugin, type PluginInfo, ViewParamsError } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";
import { projectId, SQLiteMemoryStore } from "../packages/plugin-memory/src/store.ts";
import { createLogger } from "../packages/server/src/log.ts";
import {
  gatedProvider,
  newSession,
  raw,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

const aborted: string[] = [];
/** A first-party plugin with one view per behavior the route has to police. */
const viewer: BuiltinPlugin = {
  id: "viewer",
  name: "Viewer",
  description: "Data views",
  create: () =>
    definePlugin({
      id: "viewer",
      name: "Viewer",
      description: "Data views",
      version: "1.0.0",
      apiVersion: 1,
      setup(api) {
        api.views?.register({
          id: "echo",
          description: "Echoes the validated params and the session",
          params: {
            type: "object",
            properties: {
              n: { type: "integer", minimum: 1, maximum: 10, default: 3 },
              q: { type: "string", maxLength: 40 },
            },
          },
          handler: (params, context) => ({
            params,
            sessionId: context.sessionId,
            workspace: context.workspace,
          }),
        });
        api.views?.register({
          id: "big",
          description: "Answers more than the cap",
          handler: () => ({ blob: "x".repeat(5_000) }),
        });
        api.views?.register({
          id: "slow",
          description: "Waits for the abort signal",
          handler: (_params, context) =>
            new Promise((_resolve, reject) => {
              context.signal.addEventListener("abort", () => {
                aborted.push("slow");
                reject(context.signal.reason);
              });
            }),
        });
        api.views?.register({
          id: "boom",
          description: "Throws an internal error",
          handler: () => {
            throw new Error("SELECT secret FROM private_table");
          },
        });
        api.views?.register({
          id: "picky",
          description: "Rejects a parameter the schema cannot express",
          handler: () => {
            throw new ViewParamsError("Malformed cursor");
          },
        });
      },
    }),
};

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  aborted.length = 0;
});

async function start(
  extra: Parameters<typeof startTestServer>[0] = {},
): Promise<{ t: TestServer; sid: string; wid: string }> {
  t = await startTestServer({
    ...extra,
    app: { builtins: [viewer], trustProject: true, ...extra.app },
  });
  const session = await newSession(t);
  return { t, sid: session.id, wid: session.workspaceId };
}
const view = (sid: string, plugin = "viewer", id = "echo", query = "") =>
  `/api/sessions/${sid}/views/${plugin}/${id}${query}`;
const codeOf = (res: { json<T>(): T }) => res.json<ApiError>().error.code;

describe("GET /api/sessions/:sid/views/:plugin/:view", () => {
  it("runs the view with coerced params and the session context", async () => {
    const { t, sid } = await start();
    const res = await t.api.get(view(sid, "viewer", "echo", "?q=hello&n=7"));
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({
      params: { n: 7, q: "hello" },
      sessionId: sid,
      workspace: expect.any(String),
    });
    expect(res.headers["cache-control"]).toBe("no-store");
    // Defaults come from the declared schema.
    expect((await t.api.get(view(sid))).json<{ params: unknown }>().params).toEqual({ n: 3 });
  });

  it("scopes every call to the session in the URL (never another chat's data)", async () => {
    const { t, sid } = await start();
    const other = await newSession(t);
    const a = (await t.api.get(view(sid))).json<{ sessionId: string }>();
    const b = (await t.api.get(view(other.id))).json<{ sessionId: string }>();
    expect([a.sessionId, b.sessionId]).toEqual([sid, other.id]);
  });

  it("requires the session cookie, a known Host and a same-origin Origin", async () => {
    const { t, sid } = await start();
    const path = view(sid);
    const anonymous = await raw(t.server.port, path);
    expect(anonymous.status).toBe(401);
    expect(codeOf(anonymous)).toBe("unauthorized");
    const rebound = await raw(t.server.port, path, {
      headers: { Cookie: t.cookie, Host: "evil.example" },
    });
    expect(rebound.status).toBe(403);
    expect(codeOf(rebound)).toBe("forbidden_host");
    const foreign = await raw(t.server.port, path, {
      headers: { Cookie: t.cookie, Origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);
    expect(codeOf(foreign)).toBe("forbidden_origin");
  });

  it("only reads: other methods are not routed", async () => {
    const { t, sid } = await start();
    const res = await t.api.post(view(sid), {});
    expect(res.status).toBe(404);
  });

  it("answers 404 for an unknown session and for a workspace that no longer exists", async () => {
    const { t } = await start();
    expect((await t.api.get(view("no-such-session"))).status).toBe(404);
    const { mkdir } = await import("node:fs/promises");
    const gone = join(t.root, "gone");
    await mkdir(gone);
    const added = await t.api.post("/api/workspaces", { path: gone });
    expect(added.status).toBe(200);
    const session = await newSession(t, { workspace: gone });
    await rm(gone, { recursive: true });
    const res = await t.api.get(view(session.id));
    expect(res.status).toBe(404);
    expect(codeOf(res)).toBe("workspace_missing");
  });

  it("answers the same 404 for unknown plugins, unknown views and disabled plugins", async () => {
    const { t, sid, wid } = await start();
    const unknownPlugin = await t.api.get(view(sid, "ghost", "echo"));
    const unknownView = await t.api.get(view(sid, "viewer", "ghost"));
    expect([unknownPlugin.status, unknownView.status]).toEqual([404, 404]);
    expect(unknownPlugin.json<ApiError>().error.message).toBe(
      unknownView.json<ApiError>().error.message,
    );
    const off = await t.api.patch(`/api/plugins/viewer?workspace=${wid}`, { enabled: false });
    expect(off.json<PluginInfo>().enabled).toBe(false);
    const disabled = await t.api.get(view(sid));
    expect(disabled.status).toBe(404);
    expect(disabled.json<ApiError>().error.message).toBe(
      unknownView.json<ApiError>().error.message,
    );
    await t.api.patch(`/api/plugins/viewer?workspace=${wid}`, { enabled: true });
    expect((await t.api.get(view(sid))).status).toBe(200);
  });

  it("hides the views of a plugin disabled while it still runs (restart-required)", async () => {
    const gated = gatedProvider();
    const { t, sid, wid } = await start({ provider: gated.provider });
    const run = await t.api.post(`/api/sessions/${sid}/prompts`, { requestId: "r1", text: "go" });
    expect(run.status).toBe(202);
    await gated.started;
    const off = await t.api.patch(`/api/plugins/viewer?workspace=${wid}`, { enabled: false });
    expect(off.json<PluginInfo>().status).toBe("restart-required");
    expect((await t.api.get(view(sid))).status).toBe(404);
    gated.release();
  });

  it("rejects invalid params with field names only, never their values", async () => {
    const { t, sid } = await start();
    const secret = "my-private-search";
    for (const query of [
      "?n=99",
      "?n=abc",
      `?q=${secret.repeat(5)}`,
      `?extra=${secret}`,
      `?n=1&n=2`,
    ]) {
      const res = await t.api.get(view(sid, "viewer", "echo", query));
      expect(res.status, query).toBe(400);
      expect(codeOf(res)).toBe("validation_failed");
      expect(res.text).not.toContain(secret);
    }
    const fields = (await t.api.get(view(sid, "viewer", "echo", "?n=99"))).json<ApiError>().error
      .details as { fields: string[] };
    expect(fields.fields).toEqual(["n"]);
  });

  it("bounds the number and size of query parameters before validating", async () => {
    const { t, sid } = await start();
    const many = Array.from({ length: 17 }, (_, i) => `p${i}=1`).join("&");
    expect((await t.api.get(view(sid, "viewer", "echo", `?${many}`))).status).toBe(400);
    expect((await t.api.get(view(sid, "viewer", "echo", `?q=${"a".repeat(600)}`))).status).toBe(
      400,
    );
  });

  it("maps a handler's ViewParamsError to 400 and any other failure to a generic 502", async () => {
    const { t, sid } = await start();
    const picky = await t.api.get(view(sid, "viewer", "picky"));
    expect(picky.status).toBe(400);
    expect(picky.json<ApiError>().error).toMatchObject({
      code: "validation_failed",
      message: "Malformed cursor",
    });
    const boom = await t.api.get(view(sid, "viewer", "boom"));
    expect(boom.status).toBe(502);
    expect(codeOf(boom)).toBe("view_failed");
    expect(boom.text).not.toMatch(/secret|private_table/);
  });

  it("caps the response size", async () => {
    const { t, sid } = await start({ views: { maxBytes: 1_000 } });
    const res = await t.api.get(view(sid, "viewer", "big"));
    expect(res.status).toBe(502);
    expect(codeOf(res)).toBe("view_too_large");
    expect(res.text.length).toBeLessThan(500);
  });

  it("times out a view and aborts its signal", async () => {
    const { t, sid } = await start({ views: { timeoutMs: 40 } });
    const res = await t.api.get(view(sid, "viewer", "slow"));
    expect(res.status).toBe(504);
    expect(codeOf(res)).toBe("view_timeout");
    await until(() => aborted.includes("slow"));
  });

  it("never logs parameters, content or handler messages", async () => {
    const lines: string[] = [];
    const logger = createLogger("debug", (line) => lines.push(line));
    const { t, sid } = await start({ logger });
    await t.api.get(view(sid, "viewer", "echo", "?q=confidential-needle"));
    await t.api.get(view(sid, "viewer", "boom"));
    const log = lines.join("");
    expect(log).toContain("views");
    expect(log).not.toMatch(/confidential-needle|private_table|secret/);
  });
});

describe("memory plugin views through the real server", () => {
  it("serves the tab's three sections for the asked chat, from the plugin's own store", async () => {
    const memory: BuiltinPlugin = {
      id: "memory",
      name: "Memory",
      description: "Persistent memory",
      create: (options, context) => createMemoryPlugin(options, context),
    };
    t = await startTestServer({ app: { builtins: [memory], trustProject: true } });
    const a = await newSession(t);
    const b = await newSession(t);
    const store = new SQLiteMemoryStore(openDatabase(join(t.root, "state", "memory.sqlite")));
    const project = await projectId(t.workspace);
    store.save({
      project,
      scope: "project",
      type: "decision",
      title: "Chat A decision",
      content: "**What**: only chat A",
      session: a.id,
      source: "memory_save",
    });
    store.save({
      project,
      scope: "project",
      type: "bugfix",
      title: "Chat B bug",
      content: "**What**: only chat B",
      session: b.id,
    });
    store.saveSummary(project, a.id, "Summary of A");
    store.saveInjectedContext(project, a.id, "[Memory context] loaded for A");
    store.close();

    const records = (await t.api.get(view(a.id, "memory", "records"))).json<{
      items: Array<{ title: string }>;
      total: number;
    }>();
    expect(records.items.map((i) => i.title)).toEqual(["Chat A decision"]);
    expect(records.total).toBe(1);
    expect(
      (await t.api.get(view(b.id, "memory", "records"))).json<{ items: unknown[] }>().items,
    ).toHaveLength(1);
    expect(
      (await t.api.get(view(a.id, "memory", "summary"))).json<{ summary: { content: string } }>()
        .summary.content,
    ).toBe("Summary of A");
    expect((await t.api.get(view(b.id, "memory", "summary"))).json()).toEqual({ summary: null });
    expect(
      (await t.api.get(view(a.id, "memory", "context"))).json<{ context: { content: string } }>()
        .context.content,
    ).toBe("[Memory context] loaded for A");
    expect((await t.api.get(view(a.id, "memory", "records", "?type=bogus"))).status).toBe(400);
  });
});
