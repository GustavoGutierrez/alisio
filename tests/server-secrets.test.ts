import { mkdir, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuiltinPlugin,
  ProviderSettingsStore,
  redactDeep,
  registerSecret,
} from "@alisio/core";
import { createOpenAICompatiblePlugin } from "@alisio/plugin-openai-compatible";
import type { ProviderModelsInfo, ProvidersOverview, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { jsonLine } from "../packages/cli/src/json-lines.ts";
import { HttpError, toApiError } from "../packages/server/src/http/errors.ts";
import { type RunningServer, startServer } from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";
import {
  client,
  fakeProvider,
  gatedProvider,
  login,
  newSession,
  openStream,
  type RawResponse,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

// T-14: provider credentials are write-only; no response (nor log line) ever carries them.
const SECRET = "sk-live-T14-7f3c9a1b2d4e6f80aZ71B";
const SECRET2 = "sk-live-T14-second-99aa88bb77cc66dQ9x";
const openai: BuiltinPlugin = {
  id: "openai-compatible",
  description: "test",
  defaultProvider: true,
  create: createOpenAICompatiblePlugin,
};

interface Fixture {
  server: RunningServer;
  api: ReturnType<typeof client>;
  responses: RawResponse[];
  logs: string[];
  config: string;
  workspace: string;
  wid: string;
  cookie: string;
}

let fixture: Fixture | undefined;
let test: TestServer | undefined;
afterEach(async () => {
  await fixture?.server.close();
  await test?.close();
  fixture = undefined;
  test = undefined;
  vi.unstubAllEnvs();
});

async function start(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "alisio-secrets-"));
  const config = join(root, "config");
  const workspace = join(root, "ws");
  await mkdir(workspace, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", config);
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  vi.stubEnv("HERDR_ENV", "0");
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("ALISIO_MODEL", "");
  vi.stubEnv("ALISIO_T14_KEY", "");
  await new ProviderSettingsStore(config).saveActive(
    "work",
    {
      provider: "openai-compatible",
      // Port 9 (discard) refuses connections: model listing fails fast and offline.
      values: {
        baseURL: "http://127.0.0.1:9/v1",
        apiMode: "chat",
        auth: "bearer",
        apiKeyEnv: "ALISIO_T14_KEY",
      },
      model: "work-model",
    },
    { apiKey: SECRET },
  );
  const logs: string[] = [];
  const server = await startServer({
    port: 0,
    logger: createLogger("debug", (line) => logs.push(line)),
    defaultWorkspace: workspace,
    app: { db: join(root, "state", "sessions.sqlite"), noHerdr: true, builtins: [openai] },
  });
  const cookie = await login(server.port, server.token);
  const raw = client(server.port, cookie);
  const responses: RawResponse[] = [];
  const record =
    <A extends unknown[]>(fn: (...args: A) => Promise<RawResponse>) =>
    async (...args: A) => {
      const res = await fn(...args);
      responses.push(res);
      return res;
    };
  const api = {
    get: record(raw.get),
    post: record(raw.post),
    patch: record(raw.patch),
    put: record(raw.put),
    delete: record(raw.delete),
  };
  const wid = (await api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  fixture = { server, api, responses, logs, config, workspace, wid, cookie };
  return fixture;
}

describe("provider credentials (T-14)", () => {
  it("never returns a stored secret from any management endpoint", async () => {
    const f = await start();
    const { api, wid } = f;
    const stream = openStream(f.server.port, f.cookie);
    await stream.next((e) => e.frame.t === "hello");
    const overview = (await api.get(`/api/providers?workspace=${wid}`)).json<ProvidersOverview>();
    expect(overview.active).toBe("work");
    expect(overview.current).toMatchObject({ provider: "openai-compatible", profile: "work" });
    const work = overview.profiles.find((p) => p.name === "work");
    expect(work).toMatchObject({
      provider: "openai-compatible",
      model: "work-model",
      active: true,
      credentials: { apiKey: { configured: true, source: "file", tail: "…71B" } },
    });
    expect(work?.values).not.toHaveProperty("apiKey");
    const type = overview.types.find((t) => t.id === "openai-compatible");
    expect(type?.fields.map((field) => field.key)).toContain("apiKey");

    const put = await api.put("/api/providers/work/credentials", { apiKey: SECRET2 });
    expect(put.status).toBe(200);
    expect(put.json()).toEqual({ configured: true, tail: "…Q9x" });
    const store = join(f.config, "credentials.json");
    expect((await stat(store)).mode & 0o777).toBe(0o600);
    expect(await readFile(store, "utf8")).toContain(SECRET2);

    // Every other management surface, including failures that name the profile.
    for (const path of [
      "/api/providers",
      `/api/models?workspace=${wid}`,
      `/api/settings?workspace=${wid}`,
      `/api/plugins?workspace=${wid}`,
      `/api/skills?workspace=${wid}`,
      `/api/mcp?workspace=${wid}`,
      `/api/agents?workspace=${wid}`,
      "/api/workspaces",
      `/api/commands?workspace=${wid}`,
      "/api/health",
    ])
      expect((await api.get(path)).status, path).toBeLessThan(500);
    const models = (await api.get(`/api/models?workspace=${wid}`)).json<ProviderModelsInfo[]>();
    expect(models.find((m) => m.profile === "work")).toMatchObject({ unavailable: true });
    const invalid = await api.put("/api/providers/work/credentials", { apiKey: `${SECRET} x` });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { details: { fields: ["apiKey"] } } });
    expect((await api.put("/api/providers/work/credentials", { token: SECRET })).status).toBe(400);
    expect((await api.put("/api/providers/work/credentials", {})).status).toBe(400);
    expect((await api.put("/api/providers/ghost/credentials", { apiKey: SECRET })).status).toBe(
      404,
    );
    const activated = await api.post("/api/providers/work/activate", {
      workspace: wid,
      model: "other-model",
    });
    expect(activated.json()).toEqual({ changed: true });
    await stream.next((e) => e.frame.t === "catalog_changed" && e.frame.scope === "models");
    const session = await api.post("/api/sessions", { workspace: wid });
    expect(session.json()).toMatchObject({ model: "other-model" });

    const bodies = [
      ...f.responses.map((r) => `${JSON.stringify(r.headers)}\n${r.text}`),
      JSON.stringify(stream.frames() satisfies ServerFrame[]),
      ...f.logs,
    ];
    for (const secret of [SECRET, SECRET2])
      for (const body of bodies) {
        expect(body).not.toContain(secret);
        expect(body).not.toContain(secret.slice(0, 16));
      }
    stream.close();
  });

  it("deletes stored credentials and reports an environment variable without a tail", async () => {
    const { api } = await start();
    const del = await api.delete("/api/providers/work/credentials");
    expect(del.json()).toEqual({
      configured: false,
    });
    expect((await api.delete("/api/providers/work/credentials")).status).toBe(404);
    let overview = (await api.get("/api/providers")).json<ProvidersOverview>();
    expect(overview.profiles[0]?.credentials.apiKey).toEqual({ configured: false });
    vi.stubEnv("ALISIO_T14_KEY", SECRET);
    overview = (await api.get("/api/providers")).json<ProvidersOverview>();
    expect(overview.profiles[0]?.credentials.apiKey).toEqual({ configured: true, source: "env" });
    expect(JSON.stringify(overview)).not.toContain(SECRET);
  });

  it("creates and updates profiles with non-secret values only", async () => {
    const { api, wid } = await start();
    const created = await api.put("/api/providers/lab", {
      workspace: wid,
      provider: "openai-compatible",
      values: { baseURL: "http://127.0.0.1:9/v1", apiMode: "chat", auth: "none" },
      model: "local-model",
    });
    expect(created.status).toBe(200);
    expect(created.json()).toMatchObject({
      name: "lab",
      active: false,
      credentials: { apiKey: { configured: false } },
    });
    const secretValue = await api.put("/api/providers/lab", {
      workspace: wid,
      provider: "openai-compatible",
      values: { baseURL: "http://127.0.0.1:9/v1", apiKey: SECRET },
      model: "m",
    });
    expect(secretValue.status).toBe(400);
    expect(secretValue.text).not.toContain(SECRET);
    expect(secretValue.json()).toMatchObject({ error: { details: { fields: ["values.apiKey"] } } });
    const badSelect = await api.put("/api/providers/lab", {
      workspace: wid,
      provider: "openai-compatible",
      values: { apiMode: "telepathy" },
      model: "m",
    });
    expect(badSelect.json()).toMatchObject({ error: { details: { fields: ["values.apiMode"] } } });
    const unknownType = await api.put("/api/providers/lab", {
      workspace: wid,
      provider: "nope",
      values: {},
      model: "m",
    });
    expect(unknownType.json()).toMatchObject({ error: { details: { fields: ["provider"] } } });
    expect(
      (
        await api.put("/api/providers/bad%20name", {
          workspace: wid,
          provider: "x",
          values: {},
          model: "m",
        })
      ).status,
    ).toBe(400);
  });
});

describe("provider activation (P-01)", () => {
  it("answers 409 runs_active while a run is active in the workspace", async () => {
    const gated = gatedProvider();
    test = await startTestServer({ provider: gated.provider });
    const wid = (await test.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id;
    const session = await newSession(test);
    const run = await test.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "go",
    });
    await gated.started;
    const busy = await test.api.post("/api/providers/any/activate", { workspace: wid, model: "m" });
    expect(busy.status).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "runs_active" } });
    gated.release();
    await settled(test, session.id, run.json<{ runId: string }>().runId);
    const missing = await test.api.post("/api/providers/any/activate", {
      workspace: wid,
      model: "m",
    });
    expect(missing.status).toBe(404);
  });
});

// OA-AC-57: the same token never leaves through any output surface of the server and the CLI.
const JWT = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyLTEyMzQ1Njc4OSJ9.c2lnbmF0dXJlLXZhbHVlLTEyMzQ1";
const EXACT = "exact-live-token-OA57-0123456789";
describe("output surfaces redact credentials (OA-AC-57)", () => {
  it("redacts SSE frames, ApiError messages and log lines", async () => {
    registerSecret(EXACT);
    const logs: string[] = [];
    test = await startTestServer({
      provider: fakeProvider(() => reply(`the model echoed ${JWT} and ${EXACT} back`)),
      logger: createLogger("debug", (line) => logs.push(line)),
    });
    const { api } = test;
    const session = await newSession(test);
    const stream = openStream(test.server.port, test.cookie, [session.id]);
    await stream.next((e) => e.frame.t === "hello");
    const run = await api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "go",
    });
    await settled(test, session.id, run.json<{ runId: string }>().runId);
    await stream.next((e) => e.frame.t === "event" && JSON.stringify(e.frame).includes("redacted"));
    const frames = JSON.stringify(stream.frames());
    expect(frames).not.toContain(JWT);
    expect(frames).not.toContain(EXACT);
    expect(frames).toContain("the model echoed [redacted] and [redacted] back");
    stream.close();

    // An ApiError built from a thrown error with a token in its message and details.
    const { body } = toApiError(
      new HttpError("provider_unavailable", `cannot start: ${JWT} ${EXACT}`, {
        fields: [`values.${JWT}`],
      }),
      "cid",
    );
    expect(JSON.stringify(body)).not.toContain(JWT);
    expect(JSON.stringify(body)).not.toContain(EXACT);
    expect(body.error).toMatchObject({
      code: "provider_unavailable",
      message: "cannot start: [redacted] [redacted]",
    });

    // A route that carries a token in its path reaches the debug log redacted.
    await api.get(`/api/nothing/${JWT}`);
    expect(logs.length).toBeGreaterThan(0);
    for (const line of logs) {
      expect(line).not.toContain(JWT);
      expect(line).not.toContain(EXACT);
    }
  });

  it("redacts every string of a value without touching its shape, and keeps the reference when nothing matched", () => {
    registerSecret(EXACT);
    const clean = { a: 1, list: ["short", "fine and long enough"], nested: { ok: true } };
    expect(redactDeep(clean)).toBe(clean);
    const dirty = {
      type: "text_delta",
      delta: `x ${JWT} y`,
      list: [`${EXACT}`, 3],
      n: { v: EXACT },
    };
    const out = redactDeep(dirty);
    expect(out).toEqual({
      type: "text_delta",
      delta: "x [redacted] y",
      list: ["[redacted]", 3],
      n: { v: "[redacted]" },
    });
    expect(dirty.delta).toContain(JWT);
  });

  it("writes `alisio run --json` lines with redacted values and valid JSON", () => {
    registerSecret(EXACT);
    const line = jsonLine({ type: "error", data: { error: `failed: ${JWT} ${EXACT} \"quoted\"` } });
    expect(line.endsWith("\n")).toBe(true);
    expect(line).not.toContain(JWT);
    expect(line).not.toContain(EXACT);
    expect(JSON.parse(line)).toEqual({
      type: "error",
      data: { error: 'failed: [redacted] [redacted] "quoted"' },
    });
  });
});
