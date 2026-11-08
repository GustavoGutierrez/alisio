import { type BuiltinPlugin, ProviderSettingsStore } from "@alisio/core";
import type {
  ProviderAuthContext,
  ProviderAuthFlowView,
  ProviderOAuthCredential,
  ProvidersOverview,
} from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startServer } from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";
import { client, login, raw, startTestServer, type TestServer } from "./server-helpers.ts";

const ACCESS = "access-token-srv-0123456789";
const REFRESH = "refresh-token-srv-0123456789";
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";
const CRED: ProviderOAuthCredential = {
  type: "oauth",
  access: ACCESS,
  refresh: REFRESH,
  expires: 1_900_000_000_000,
  metadata: { clientId: "c-1" },
};

const hooks: {
  start: (ctx: ProviderAuthContext) => Promise<ProviderOAuthCredential>;
  unregister?: () => void;
  contexts: ProviderAuthContext[];
} = { start: async () => CRED, contexts: [] };

/** A plugin with a sign-in provider ("chatgpt") whose `start` the test controls, and a plain one. */
const fakeAuth: BuiltinPlugin = {
  id: "fake-auth",
  description: "test sign-in provider",
  create: () => ({
    id: "fake-auth",
    version: "1.0.0",
    apiVersion: 1,
    setup(api) {
      hooks.unregister = api.providers.register({
        id: "chatgpt",
        name: "ChatGPT",
        fields: [],
        auth: [
          {
            id: "browser",
            label: "Browser",
            kind: "oauth",
            description: "Sign in with your account",
            start: (ctx) => {
              hooks.contexts.push(ctx);
              return hooks.start(ctx);
            },
          },
          {
            id: "other-method",
            label: "Other",
            kind: "oauth",
            unofficial: true,
            start: hooks.start,
          },
        ],
        create: () => ({ id: "chatgpt", model: "m", async *stream() {} }),
      });
      api.providers.register({
        id: "plain",
        name: "Plain",
        fields: [{ key: "baseURL", label: "URL", kind: "text" }],
        create: () => ({ id: "plain", model: "m", async *stream() {} }),
      });
    },
  }),
};

let t: TestServer | undefined;
let logs: string[] = [];
let wid = "";
const bodies: string[] = [];

afterEach(async () => {
  await t?.close();
  t = undefined;
  hooks.start = async () => CRED;
  hooks.unregister = undefined;
  hooks.contexts.length = 0;
  logs = [];
  bodies.length = 0;
  vi.unstubAllEnvs();
});

async function begin(options: Record<string, unknown> = {}, app: Record<string, unknown> = {}) {
  logs = [];
  const { startOptions, profiles } = {
    startOptions: options,
    profiles: ["p", "q", "r", "s", "u"],
  };
  t = await startTestServer({
    logger: createLogger("debug", (line) => logs.push(line)),
    app: { builtins: [fakeAuth], ...app },
    ...startOptions,
  });
  const store = new ProviderSettingsStore();
  for (const name of profiles)
    await store.saveProfile(name, { provider: "chatgpt", values: {}, model: "m" });
  wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  // Opens the workspace app so its provider registry is loaded.
  await t.api.get(`/api/providers?workspace=${wid}`);
  return { t, store };
}

const rec = async (response: Promise<import("./server-helpers.ts").RawResponse>) => {
  const r = await response;
  bodies.push(`${JSON.stringify(r.headers)}\n${r.text}`);
  return r;
};
const start = (profile = "p", method = "browser") =>
  rec(
    (t as TestServer).api.post(`/api/providers/${profile}/auth/${method}/start`, {
      workspace: wid,
    }),
  );
const poll = (flowId: string, profile = "p", after = 0) =>
  rec((t as TestServer).api.get(`/api/providers/${profile}/auth/flows/${flowId}?after=${after}`));
async function flowId(profile = "p", method = "browser"): Promise<string> {
  const res = await start(profile, method);
  expect(res.status).toBe(202);
  return res.json<{ flowId: string }>().flowId;
}
async function until<T>(check: () => Promise<T | undefined | false>, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("condition not met");
    await new Promise((r) => setTimeout(r, 5));
  }
}
const view = async (id: string, profile = "p", after = 0) =>
  (await poll(id, profile, after)).json<ProviderAuthFlowView>();
const never = (signal: AbortSignal) =>
  new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));

describe("sign-in flow over HTTP (OA-AC-19)", () => {
  it("start -> steps -> prompt -> input -> success, polling with after, and the credential lands in oauth[profile]", async () => {
    const { store } = await begin();
    hooks.start = async (ctx) => {
      ctx.show({ type: "progress", message: "Opening the browser" });
      ctx.show({ type: "auth_url", url: "https://auth.example.com/authorize", instructions: "Go" });
      const answer = await ctx.prompt({ message: "Paste the URL", secret: true });
      ctx.show({ type: "progress", message: `Received ${answer?.length}` });
      return CRED;
    };
    const id = await flowId();
    const waiting = await until(async () => {
      const v = await view(id);
      return v.status === "awaiting_input" ? v : undefined;
    });
    expect(waiting.steps.map((s) => s.n)).toEqual([1, 2]);
    expect(waiting.prompt).toMatchObject({ message: "Paste the URL", secret: true });
    expect((await view(id, "p", 1)).steps.map((s) => s.n)).toEqual([2]);

    const promptId = waiting.prompt?.id as string;
    const bad = await rec(
      (t as TestServer).api.post(`/api/providers/p/auth/flows/${id}/input`, {
        promptId: "nope",
        value: "x",
      }),
    );
    expect(bad.status).toBe(400);
    expect(bad.json()).toMatchObject({ error: { code: "validation_failed" } });
    const ok = await rec(
      (t as TestServer).api.post(`/api/providers/p/auth/flows/${id}/input`, {
        promptId,
        value: "the-pasted-answer-123",
      }),
    );
    expect(ok.status).toBe(200);
    const done = await until(async () => {
      const v = await view(id, "p", 2);
      return v.status === "succeeded" ? v : undefined;
    });
    expect(done.steps).toMatchObject([{ n: 3, type: "progress" }]);
    expect(done.credential).toEqual({
      configured: true,
      source: "file",
      kind: "oauth",
      state: "ok",
      expires: CRED.expires,
    });
    expect(await store.getOAuthEntry("p")).toMatchObject({
      method: "browser",
      provider: "chatgpt",
      access: ACCESS,
    });
    const noPrompt = await rec(
      (t as TestServer).api.post(`/api/providers/p/auth/flows/${id}/input`, {
        promptId,
        value: "late",
      }),
    );
    expect(noPrompt.status).toBe(400);
  });
});

describe("start, poll, input and cancel errors", () => {
  it("answers 404 for an unknown profile, method or flow, a flow of another profile, and 400 for invalid names", async () => {
    await begin();
    hooks.start = (ctx) => never(ctx.signal);
    expect((await start("ghost")).status).toBe(404);
    expect((await start("p", "nope")).status).toBe(404);
    expect((await start("p", "UPPER")).status).toBe(400);
    expect((await start("bad%20name")).status).toBe(400);
    const id = await flowId();
    expect((await poll("not-a-flow")).status).toBe(404);
    expect((await poll(id, "q")).status).toBe(404);
    expect((await poll(id, "p", -1)).status).toBe(400);
    expect((await poll(id, "p", 1.5 as never)).status).toBe(400);
    const wrongProfile = await rec(
      (t as TestServer).api.post(`/api/providers/q/auth/flows/${id}/input`, {
        promptId: "x",
        value: "y",
      }),
    );
    expect(wrongProfile.status).toBe(404);
    expect(
      (await rec((t as TestServer).api.delete(`/api/providers/q/auth/flows/${id}`))).status,
    ).toBe(404);
    const tooLong = await rec(
      (t as TestServer).api.post(`/api/providers/p/auth/flows/${id}/input`, {
        promptId: "x",
        value: "y".repeat(8_193),
      }),
    );
    expect(tooLong.status).toBe(400);
  });

  it("a profile on a provider without sign-in methods has no method to start", async () => {
    const { store } = await begin();
    await store.saveProfile("plainp", { provider: "plain", values: {}, model: "m" });
    expect((await start("plainp")).status).toBe(404);
  });

  it("DELETE cancels (idempotent), a second start replaces the first and a fifth active flow is refused", async () => {
    await begin();
    hooks.start = (ctx) => never(ctx.signal);
    const first = await flowId("p");
    const second = await flowId("p");
    expect((await view(first)).status).toBe("cancelled");
    expect((await view(second)).status).toBe("running");
    const del = await rec((t as TestServer).api.delete(`/api/providers/p/auth/flows/${second}`));
    expect(del.status).toBe(200);
    expect(del.json<ProviderAuthFlowView>().status).toBe("cancelled");
    expect(
      (await rec((t as TestServer).api.delete(`/api/providers/p/auth/flows/${second}`))).status,
    ).toBe(200);
    for (const profile of ["p", "q", "r", "s"]) await flowId(profile);
    const fifth = await start("u");
    expect(fifth.status).toBe(400);
    expect(fifth.json()).toMatchObject({
      error: { code: "validation_failed", details: { fields: ["flows"] } },
    });
  });
});

describe("guards of the flow routes (OA-AC-28)", () => {
  it("refuses start, input and delete under readOnly with capability_ceiling", async () => {
    await begin({}, { readOnly: true });
    const s = await start();
    expect(s.status).toBe(403);
    expect(s.json()).toMatchObject({ error: { code: "capability_ceiling" } });
    const i = await rec(
      (t as TestServer).api.post("/api/providers/p/auth/flows/x/input", {
        promptId: "a",
        value: "b",
      }),
    );
    expect(i.status).toBe(403);
    expect(i.json()).toMatchObject({ error: { code: "capability_ceiling" } });
    const d = await rec((t as TestServer).api.delete("/api/providers/p/auth/flows/x"));
    expect(d.status).toBe(403);
    expect(d.json()).toMatchObject({ error: { code: "capability_ceiling" } });
  });

  it("enforces Origin, cookie, Host and the JSON content type", async () => {
    await begin();
    const port = (t as TestServer).server.port;
    const path = "/api/providers/p/auth/browser/start";
    const cookie = (t as TestServer).cookie;
    const origin = `http://127.0.0.1:${port}`;
    const json = { "Content-Type": "application/json" };
    const foreignOrigin = await raw(port, path, {
      method: "POST",
      body: {},
      headers: { Cookie: cookie, Origin: "http://evil.example", ...json },
    });
    expect([foreignOrigin.status, foreignOrigin.json()]).toMatchObject([
      403,
      { error: { code: "forbidden_origin" } },
    ]);
    const noCookie = await raw(port, path, {
      method: "POST",
      body: {},
      headers: { Origin: origin, ...json },
    });
    expect([noCookie.status, noCookie.json()]).toMatchObject([
      401,
      { error: { code: "unauthorized" } },
    ]);
    const foreignHost = await raw(port, path, {
      method: "POST",
      body: {},
      headers: { Host: "evil.example", Cookie: cookie, Origin: origin, ...json },
    });
    expect([foreignHost.status, foreignHost.json()]).toMatchObject([
      403,
      { error: { code: "forbidden_host" } },
    ]);
    const noType = await raw(port, path, {
      method: "POST",
      body: "{}",
      headers: { Cookie: cookie, Origin: origin },
    });
    expect([noType.status, noType.json()]).toMatchObject([
      415,
      { error: { code: "unsupported_media_type" } },
    ]);
    const getNoCookie = await raw(port, "/api/providers/p/auth/flows/x");
    expect(getNoCookie.status).toBe(401);
  });
});

describe("loopback availability (OA-AC-25)", () => {
  async function loopbackSeen(options: Record<string, unknown>): Promise<{
    offered: boolean;
    view: ProviderAuthFlowView;
  }> {
    await begin(options);
    hooks.start = (ctx) => never(ctx.signal);
    const id = await flowId();
    await until(async () => (hooks.contexts.length ? true : undefined));
    return {
      offered: typeof hooks.contexts[0]?.loopback === "function",
      view: await view(id),
    };
  }

  it("is offered, as an assumption, on a loopback bind", async () => {
    const seen = await loopbackSeen({});
    expect(seen.offered).toBe(true);
    expect(seen.view.loopback).toBe("assumed");
  });

  it("is offered, as declared, when the host says the browser is local", async () => {
    const seen = await loopbackSeen({ localBrowser: true });
    expect(seen.offered).toBe(true);
    expect(seen.view.loopback).toBe("declared");
  });

  it("is not offered on a remote bind", async () => {
    const seen = await loopbackSeen({ host: "0.0.0.0", allowRemote: true });
    expect(seen.offered).toBe(false);
    expect(seen.view.loopback).toBeUndefined();
  });
});

describe("URL validation and device codes over HTTP (OA-AC-50, OA-AC-62)", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,x",
    "file:///etc/passwd",
    "http://example.com/x",
  ])("fails the flow with unsafe_url for %s and keeps the step out of the view", async (url) => {
    await begin();
    hooks.start = async (ctx) => {
      ctx.show({ type: "auth_url", url });
      return CRED;
    };
    const id = await flowId();
    const v = await until(async () => {
      const x = await view(id);
      return x.status === "failed" ? x : undefined;
    });
    expect(v.error?.code).toBe("unsafe_url");
    expect(v.steps).toEqual([]);
    expect(JSON.stringify(v)).not.toContain("passwd");
  });

  it("serves allowed URLs and the optional device_code fields", async () => {
    await begin();
    hooks.start = async (ctx) => {
      ctx.show({ type: "auth_url", url: "http://127.0.0.1:1455/x" });
      ctx.show({ type: "auth_url", url: "http://localhost/x" });
      ctx.show({
        type: "device_code",
        verificationUri: "https://auth.example.com/device",
        verificationUriComplete: "https://auth.example.com/device?c=1",
        userCode: "ABCD-1234",
        expiresInSeconds: 600,
        intervalSeconds: 5,
      });
      ctx.show({
        type: "device_code",
        verificationUri: "https://auth.example.com/device",
        userCode: "WXYZ-0000",
        expiresInSeconds: 60,
      });
      return CRED;
    };
    const id = await flowId();
    const v = await until(async () => {
      const x = await view(id);
      return x.status === "succeeded" ? x : undefined;
    });
    expect(v.steps).toHaveLength(4);
    expect(v.steps[2]).toMatchObject({
      type: "device_code",
      verificationUriComplete: "https://auth.example.com/device?c=1",
      intervalSeconds: 5,
    });
    expect(v.steps[3]).not.toHaveProperty("verificationUriComplete");
    expect(v.steps[3]).not.toHaveProperty("intervalSeconds");
  });
});

describe("GET /api/providers with sign-in state (OA-AC-17)", () => {
  it("projects methods without functions and the oauth credential without a tail", async () => {
    const { store } = await begin();
    await store.setOAuth("p", CRED, { method: "browser", provider: "chatgpt" });
    const g = (await store.setOAuth("q", CRED, {
      method: "browser",
      provider: "chatgpt",
    })) as number;
    await store.markOAuthState("q", "needs_sign_in", g);
    // A session left by another registration must not show up for this one.
    await store.setOAuth("r", CRED, { method: "browser", provider: "someone-else" });
    await store.saveProfile("plainp", { provider: "plain", values: {}, model: "m" });

    const res = await rec((t as TestServer).api.get(`/api/providers?workspace=${wid}`));
    const overview = res.json<ProvidersOverview>();
    const by = (name: string) => overview.profiles.find((x) => x.name === name);
    expect(by("p")?.credentials.oauth).toEqual({
      configured: true,
      source: "file",
      kind: "oauth",
      state: "ok",
      expires: CRED.expires,
    });
    expect(by("q")?.credentials.oauth).toEqual({
      configured: true,
      source: "file",
      kind: "oauth",
      state: "needs_sign_in",
      expires: CRED.expires,
    });
    expect(by("s")?.credentials.oauth).toEqual({ configured: false, kind: "oauth" });
    expect(by("r")?.credentials.oauth).toEqual({ configured: false, kind: "oauth" });
    expect(by("plainp")?.credentials).not.toHaveProperty("oauth");
    const chatgpt = overview.types.find((x) => x.id === "chatgpt");
    expect(chatgpt?.auth).toEqual([
      { id: "browser", label: "Browser", kind: "oauth", description: "Sign in with your account" },
      { id: "other-method", label: "Other", kind: "oauth", unofficial: true },
    ]);
    expect(overview.types.find((x) => x.id === "plain")?.auth).toBeUndefined();
    for (const leaked of [ACCESS, REFRESH, "start", "refresh"])
      expect(res.text).not.toContain(`"${leaked}"`);
    expect(res.text).not.toContain(ACCESS);
    expect(res.text).not.toContain(REFRESH);
    expect(res.text).not.toContain("tail");
  });
});

describe("DELETE credentials and PUT type change (OA-AC-31)", () => {
  it("deletes the session, cancels the active flow and answers configured:false; 404 when there was nothing", async () => {
    const { store } = await begin();
    await store.setOAuth("p", CRED, { method: "browser", provider: "chatgpt" });
    hooks.start = (ctx) => never(ctx.signal);
    const id = await flowId("p");
    const del = await rec((t as TestServer).api.delete("/api/providers/p/credentials"));
    expect(del.status).toBe(200);
    expect(del.json()).toEqual({ configured: false });
    expect(await store.getOAuthEntry("p")).toBeUndefined();
    expect((await view(id)).status).toBe("cancelled");
    expect((await rec((t as TestServer).api.delete("/api/providers/p/credentials"))).status).toBe(
      404,
    );
    const overview = (
      await rec((t as TestServer).api.get(`/api/providers?workspace=${wid}`))
    ).json<ProvidersOverview>();
    expect(overview.profiles.find((x) => x.name === "p")?.credentials.oauth).toEqual({
      configured: false,
      kind: "oauth",
    });
  });

  it("cancels a flow with no stored session and still answers 200", async () => {
    await begin();
    hooks.start = (ctx) => never(ctx.signal);
    const id = await flowId("q");
    const del = await rec((t as TestServer).api.delete("/api/providers/q/credentials"));
    expect(del.status).toBe(200);
    expect((await view(id, "q")).status).toBe("cancelled");
  });

  it("a flow that finishes after DELETE cannot bring the session back", async () => {
    const { store } = await begin();
    let release!: () => void;
    hooks.start = () =>
      new Promise((resolve) => {
        release = () => resolve(CRED);
      });
    const id = await flowId("p");
    await until(async () => (hooks.contexts.length ? true : undefined));
    await rec((t as TestServer).api.delete("/api/providers/p/credentials"));
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect(await store.getOAuthEntry("p")).toBeUndefined();
    expect((await view(id)).status).toBe("cancelled");
  });

  it("changing the provider type of a profile cancels its flow and drops its session", async () => {
    const { store } = await begin();
    await store.setOAuth("p", CRED, { method: "browser", provider: "chatgpt" });
    hooks.start = (ctx) => never(ctx.signal);
    const id = await flowId("p");
    const put = await rec(
      (t as TestServer).api.put("/api/providers/p", {
        workspace: wid,
        provider: "plain",
        values: {},
        model: "m2",
      }),
    );
    expect(put.status).toBe(200);
    expect((await view(id)).status).toBe("cancelled");
    expect(await store.getOAuthEntry("p")).toBeUndefined();
    // Same type again: nothing to cancel.
    hooks.start = (ctx) => never(ctx.signal);
    await store.saveProfile("q", { provider: "chatgpt", values: {}, model: "m" });
    const other = await flowId("q");
    await rec(
      (t as TestServer).api.put("/api/providers/q", {
        workspace: wid,
        provider: "chatgpt",
        values: {},
        model: "m3",
      }),
    );
    expect((await view(other, "q")).status).toBe("running");
  });
});

describe("removal of the registration (OA-AC-58)", () => {
  it("cancels the pending flow of a provider whose plugin registration is removed", async () => {
    const { store } = await begin();
    let aborted = false;
    hooks.start = async (ctx) => {
      ctx.signal.addEventListener("abort", () => {
        aborted = true;
      });
      return never(ctx.signal);
    };
    const id = await flowId("p");
    await until(async () => (hooks.contexts.length ? true : undefined));
    hooks.unregister?.();
    const v = await until(async () => {
      const x = await view(id);
      return x.status === "cancelled" ? x : undefined;
    });
    expect(v.status).toBe("cancelled");
    expect(aborted).toBe(true);
    expect(await store.getOAuthEntry("p")).toBeUndefined();
  });
});

describe("nothing secret leaves the server (OA-AC-29, OA-AC-30)", () => {
  it("keeps tokens, JWTs, prompt answers and tails out of every response and log of a complete flow", async () => {
    const { store } = await begin();
    hooks.start = async (ctx) => {
      ctx.show({ type: "progress", message: `working with ${JWT}` });
      const value = await ctx.prompt({ message: "Secret?", secret: true });
      if (value === "make-it-fail") throw new Error(`rejected ${JWT} ${ACCESS} ${value}`);
      return CRED;
    };
    const failing = await flowId("q");
    const ask = await until(async () => (await view(failing, "q")).prompt);
    await rec(
      (t as TestServer).api.post(`/api/providers/q/auth/flows/${failing}/input`, {
        promptId: ask.id,
        value: "make-it-fail",
      }),
    );
    const failed = await until(async () => {
      const x = await view(failing, "q");
      return x.status === "failed" ? x : undefined;
    });
    expect(failed.error?.message).toContain("[redacted]");

    const ok = await flowId("p");
    const ask2 = await until(async () => (await view(ok)).prompt);
    await rec(
      (t as TestServer).api.post(`/api/providers/p/auth/flows/${ok}/input`, {
        promptId: ask2.id,
        value: "another-secret-answer-1",
      }),
    );
    await until(async () => ((await view(ok)).status === "succeeded" ? true : undefined));
    await rec((t as TestServer).api.get(`/api/providers?workspace=${wid}`));
    await rec((t as TestServer).api.get(`/api/models?workspace=${wid}`));
    expect(await store.getOAuthEntry("p")).toBeDefined();
    for (const secret of [ACCESS, REFRESH, JWT, "make-it-fail", "another-secret-answer-1"])
      for (const body of [...bodies, ...logs]) expect(body).not.toContain(secret);
  });
});
