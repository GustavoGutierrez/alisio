import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BuiltinPlugin } from "@alisio/core";
import {
  type AgentInfo,
  type CommandDescriptor,
  definePlugin,
  type McpOverview,
  type PluginInfo,
  type SettingsOverview,
  type SkillInfo,
  textResult,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  gatedProvider,
  newSession,
  openStream,
  type SseEvent,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

/** A first-party plugin contributing one tool and one slash command. */
const demo: BuiltinPlugin = {
  id: "demo",
  name: "Demo",
  description: "Demo plugin",
  create: () =>
    definePlugin({
      id: "demo",
      name: "Demo",
      description: "Demo plugin",
      version: "1.2.3",
      apiVersion: 1,
      setup(api) {
        api.tools.register({
          name: "note",
          description: "Writes a note",
          inputSchema: { type: "object", properties: {} },
          effect: "read",
          execute: async () => textResult("noted"),
        });
        api.commands.register("demo-hello", async () => "hello", { description: "Say hello" });
      },
    }),
};
/** Disabled on the command line: listed but not manageable. */
const pinned: BuiltinPlugin = {
  id: "pinned",
  description: "Pinned off",
  create: () => definePlugin({ id: "pinned", version: "1.0.0", apiVersion: 1, setup() {} }),
};

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(
  options: { trusted?: boolean; provider?: ReturnType<typeof gatedProvider> } = {},
) {
  t = await startTestServer({
    ...(options.provider ? { provider: options.provider.provider } : {}),
    app: {
      builtins: [demo, pinned],
      disablePlugins: ["pinned"],
      ...(options.trusted === false ? {} : { trustProject: true }),
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { t, wid };
}

const catalogChanged = (scope: string) => (e: SseEvent) =>
  e.frame.t === "catalog_changed" && e.frame.scope === scope;

describe("management routes: plugins", () => {
  it("lists plugins with their contributions and requires a known workspace", async () => {
    const { t, wid } = await start();
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    const entry = list.find((p) => p.id === "demo");
    expect(entry).toMatchObject({
      name: "Demo",
      version: "1.2.3",
      builtin: true,
      status: "active",
      enabled: true,
      manageable: true,
      tools: ["note"],
      commands: ["demo-hello"],
    });
    expect(entry?.toolPrefix).toMatch(/^p_[0-9a-f]{10}$/);
    expect(list.find((p) => p.id === "pinned")).toMatchObject({
      manageable: false,
      diagnostic: expect.any(String),
    });
    expect((await t.api.get("/api/plugins")).status).toBe(400);
    expect((await t.api.get("/api/plugins?workspace=ffffffffffffffff")).status).toBe(404);
  });

  it("disables a plugin, recycles the idle workspace and refreshes the command catalog", async () => {
    const { t, wid } = await start();
    const commands = async () =>
      (await t.api.get(`/api/commands?workspace=${wid}`))
        .json<CommandDescriptor[]>()
        .map((c) => c.name);
    expect(await commands()).toContain("demo-hello");
    const stream = openStream(t.server.port, t.cookie);
    await stream.next((e) => e.frame.t === "hello");
    const off = await t.api.patch(`/api/plugins/demo?workspace=${wid}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.json<PluginInfo>()).toMatchObject({ enabled: false, status: "inactive" });
    await stream.next(catalogChanged("commands"));
    await stream.next(catalogChanged("plugins"));
    expect(await commands()).not.toContain("demo-hello");
    const config = JSON.parse(await readFile(join(t.workspace, ".alisio", "config.json"), "utf8"));
    expect(config.builtinPlugins.demo.enabled).toBe(false);
    const on = await t.api.patch(`/api/plugins/demo?workspace=${wid}`, { enabled: true });
    expect(on.json<PluginInfo>()).toMatchObject({ enabled: true, status: "active" });
    expect(await commands()).toContain("demo-hello");
    stream.close();
  });

  it("reports restart-required while runs are active and applies it once they finish", async () => {
    const gated = gatedProvider();
    const { t, wid } = await start({ provider: gated });
    const session = await newSession(t);
    const run = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "go",
    });
    await gated.started;
    const off = await t.api.patch(`/api/plugins/demo?workspace=${wid}`, { enabled: false });
    expect(off.json<PluginInfo>()).toMatchObject({ enabled: false, status: "restart-required" });
    gated.release();
    await settled(t, session.id, run.json<{ runId: string }>().runId);
    await until(async () => {
      const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
      return list.find((p) => p.id === "demo")?.status === "inactive";
    });
  });

  it("validates input and refuses plugins it may not manage", async () => {
    const { t, wid } = await start();
    const bad = await t.api.patch(`/api/plugins/demo?workspace=${wid}`, { enabled: "no" });
    expect(bad.status).toBe(400);
    expect(bad.json()).toMatchObject({ error: { details: { fields: ["enabled"] } } });
    expect(
      (await t.api.patch(`/api/plugins/nope?workspace=${wid}`, { enabled: true })).status,
    ).toBe(404);
    const pinnedRes = await t.api.patch(`/api/plugins/pinned?workspace=${wid}`, { enabled: true });
    expect(pinnedRes.status).toBe(403);
    expect(pinnedRes.json()).toMatchObject({ error: { code: "not_manageable" } });
  });

  it("does not manage plugins of an untrusted workspace (the web never grants trust)", async () => {
    const { t, wid } = await start({ trusted: false });
    const list = (await t.api.get(`/api/plugins?workspace=${wid}`)).json<PluginInfo[]>();
    expect(list.find((p) => p.id === "demo")).toMatchObject({
      manageable: false,
      diagnostic: expect.stringMatching(/trust/i),
    });
    const res = await t.api.patch(`/api/plugins/demo?workspace=${wid}`, { enabled: false });
    expect(res.status).toBe(403);
  });
});

describe("management routes: skills, MCP, agents and settings", () => {
  it("toggles a skill and removes it from the slash palette", async () => {
    const { t, wid } = await start();
    const dir = join(t.workspace, ".agents", "skills", "tidy");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "SKILL.md"),
      "---\nname: tidy\ndescription: Tidy the workspace\n---\nKeep it tidy.\n",
    );
    // Discovered when the workspace application opens (on this first request).
    const skills = (await t.api.get(`/api/skills?workspace=${wid}`)).json<SkillInfo[]>();
    expect(skills.find((s) => s.id === "tidy")).toMatchObject({ enabled: true, scope: "project" });
    expect(JSON.stringify(skills)).not.toContain(t.workspace);
    const stream = openStream(t.server.port, t.cookie);
    await stream.next((e) => e.frame.t === "hello");
    const off = await t.api.patch(`/api/skills/tidy?workspace=${wid}`, { enabled: false });
    expect(off.json<SkillInfo>()).toMatchObject({ id: "tidy", enabled: false });
    await stream.next(catalogChanged("skills"));
    await stream.next(catalogChanged("commands"));
    const names = (await t.api.get(`/api/commands?workspace=${wid}`))
      .json<CommandDescriptor[]>()
      .map((c) => c.name);
    expect(names).not.toContain("skill:tidy");
    expect(
      (await t.api.patch(`/api/skills/ghost?workspace=${wid}`, { enabled: true })).status,
    ).toBe(404);
    stream.close();
  });

  it("lists MCP servers without commands or arguments and requires explicit consent", async () => {
    const secretArg = "MCP-ARG-SECRET-9d8f7e";
    const t0 = await startTestServer({ app: { trustProject: true } });
    t = t0;
    await mkdir(join(t0.workspace, ".alisio"), { recursive: true });
    await writeFile(
      join(t0.workspace, ".alisio", "config.json"),
      JSON.stringify({
        mcp: {
          servers: {
            fixture: { command: "alisio-missing-mcp-bin", args: ["--token", secretArg] },
          },
        },
      }),
    );
    const wid = (await t0.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id;
    const overview = await t0.api.get(`/api/mcp?workspace=${wid}`);
    expect(overview.text).not.toContain(secretArg);
    expect(overview.text).not.toContain("alisio-missing-mcp-bin");
    expect(overview.json<McpOverview>()).toMatchObject({
      permission: "not-granted",
      servers: [{ name: "fixture", transport: "stdio", enabled: true, source: "project" }],
    });
    const connect = await t0.api.patch(`/api/mcp/fixture?workspace=${wid}`, {
      enabled: true,
      connect: true,
    });
    expect(connect.status).toBe(403);
    expect(connect.json()).toMatchObject({ error: { code: "mcp_not_permitted" } });
    const unconfirmed = await t0.api.post("/api/mcp/consent", { workspace: wid, confirmed: false });
    expect(unconfirmed.status).toBe(400);
    const granted = await t0.api.post("/api/mcp/consent", { workspace: wid, confirmed: true });
    expect(granted.json<McpOverview>()).toMatchObject({ permission: "granted", persisted: false });
    const off = await t0.api.patch(`/api/mcp/fixture?workspace=${wid}`, { enabled: false });
    expect(off.status).toBe(200);
    expect(off.text).not.toContain(secretArg);
    expect(off.json()).toMatchObject({ name: "fixture", enabled: false, status: "disabled" });
    expect((await t0.api.patch(`/api/mcp/nope?workspace=${wid}`, { enabled: true })).status).toBe(
      404,
    );
  });

  it("lists agent presets with the workspace default", async () => {
    const { t, wid } = await start();
    const agents = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(agents.map((a) => a.id)).toEqual(expect.arrayContaining(["build", "plan"]));
    expect(agents.find((a) => a.id === "build")).toMatchObject({
      default: true,
      source: "builtin",
    });
    expect(agents.find((a) => a.id === "plan")).toMatchObject({ readOnly: true, default: false });
  });

  it("reads and writes settings with validation and reports the configuration file", async () => {
    const { t, wid } = await start();
    const overview = (await t.api.get(`/api/settings?workspace=${wid}`)).json<SettingsOverview>();
    expect(overview.configPath).toBe(join(t.workspace, ".alisio", "config.json"));
    expect(overview.settingsPath).toBe(join(t.root, "config", "config.json"));
    expect(overview.providersPath).toBe(join(t.root, "config", "providers.json"));
    expect(overview.trusted).toBe(true);
    const turns = overview.settings.find((s) => s.key === "limits.maxTurns");
    expect(turns).toMatchObject({ kind: "number", value: expect.any(Number) });
    const ok = await t.api.patch("/api/settings", {
      workspace: wid,
      key: "limits.maxTurns",
      value: 12,
    });
    expect(ok.status).toBe(200);
    const after = (await t.api.get(`/api/settings?workspace=${wid}`)).json<SettingsOverview>();
    expect(after.settings.find((s) => s.key === "limits.maxTurns")?.value).toBe(12);
    const unknown = await t.api.patch("/api/settings", {
      workspace: wid,
      key: "provider.baseURL",
      value: "x",
    });
    expect(unknown.status).toBe(400);
    expect(unknown.json()).toMatchObject({ error: { details: { fields: ["key"] } } });
    const invalid = await t.api.patch("/api/settings", {
      workspace: wid,
      key: "limits.maxTurns",
      value: "many",
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { details: { fields: ["value"] } } });
  });
});
