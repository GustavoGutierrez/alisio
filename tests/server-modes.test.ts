/**
 * Phase 1 of the modes spec over HTTP: stable agent order, `/permission`, `/reload`,
 * `/changelog` and their auth rules.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentInfo,
  ChangelogView,
  CommandOutcome,
  ReloadReport,
  SessionDetail,
} from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import { PROTOCOL_VERSION } from "../packages/server/src/index.ts";
import {
  gatedProvider,
  newSession,
  openStream,
  raw,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

async function start(
  options: {
    readOnly?: boolean;
    provider?: ReturnType<typeof gatedProvider>;
    version?: string;
  } = {},
) {
  const home = await mkdtemp(join(tmpdir(), "alisio-modes-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  t = await startTestServer({
    ...(options.provider ? { provider: options.provider.provider } : {}),
    ...(options.version ? { version: options.version } : {}),
    app: {
      trustProject: true,
      ...(options.readOnly ? { readOnly: true } : {}),
      builtins: BUILTIN_PLUGINS.filter((p) => p.id === "subagents"),
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { t, wid };
}

const command = (sid: string, name: string, args?: string) =>
  t?.api.post(`/api/sessions/${sid}/commands`, {
    requestId: `r${Math.random().toString(36).slice(2, 10)}`,
    name,
    ...(args ? { args } : {}),
  }) as Promise<{ status: number; json<T>(): T }>;

describe("agent cycle order", () => {
  it("lists build, plan, then custom agents by name, however they were created", async () => {
    const { t, wid } = await start();
    for (const name of ["Zeta Agent", "Alpha Agent"])
      expect(
        (
          await t.api.post("/api/agents", {
            workspace: wid,
            name,
            description: `${name} agent`,
            instructions: "Help.",
            model: "fake-model",
          })
        ).status,
      ).toBe(201);
    const agents = (await t.api.get(`/api/agents?workspace=${wid}`)).json<AgentInfo[]>();
    expect(agents.map((a) => a.id)).toEqual(["build", "plan", "alpha-agent", "zeta-agent"]);
  });
});

describe("/permission", () => {
  it("sets the session preset from a mode and refuses unknown arguments", async () => {
    const { t } = await start();
    const session = await newSession(t);
    expect(session.preset).toBe("workspace-write");

    const ask = (await command(session.id, "permission", "ask")).json<CommandOutcome>();
    expect(ask).toMatchObject({ tone: "notice", effects: ["preset"] });
    expect(ask.output).toContain("**Ask**");
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<SessionDetail>().preset).toBe(
      "ask",
    );

    const full = (await command(session.id, "permissions", "full")).json<CommandOutcome>();
    expect(full.output).toContain("not a sandbox");
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<SessionDetail>().preset).toBe(
      "full-access",
    );

    const auto = await command(session.id, "permission", "auto");
    expect(auto.status).toBe(200);
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<SessionDetail>().preset).toBe(
      "workspace-write",
    );

    const bad = await command(session.id, "permission", "yolo");
    expect(bad.status).toBe(400);
  });

  it("reports the status and the saved permissions to API callers", async () => {
    const { t } = await start();
    const session = await newSession(t);
    const status = (await command(session.id, "permission", "status")).json<CommandOutcome>();
    expect(status.output).toContain("Permission mode: **auto**");
    expect(status.output).toContain("- process: ask");
    expect(status.output).toContain("No saved permissions in this session.");
    // The bare command and the old name give the same menu text (the web opens a popover).
    const bare = (await command(session.id, "permissions")).json<CommandOutcome>();
    expect(bare.output).toContain("Permission mode:");
  });

  it("is locked under --read-only: modes need the server's ceiling", async () => {
    const { t } = await start({ readOnly: true });
    const session = await newSession(t);
    const refused = await command(session.id, "permission", "full");
    expect(refused.status).toBe(403);
    expect(
      (await command(session.id, "permission", "status")).json<CommandOutcome>().output,
    ).toContain("locked");
  });
});

describe("/reload", () => {
  it("reports what was refreshed, announces every catalog and keeps the session", async () => {
    const { t, wid } = await start();
    const session = await newSession(t);
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await stream.next((e) => e.frame.t === "hello");
    await writeFile(join(t.workspace, "AGENTS.md"), "# project\n");
    const outcome = (await command(session.id, "reload")).json<CommandOutcome>();
    expect(outcome.output).toContain("**Reload complete**");
    expect(outcome.output).toContain("**Needs a restart**");
    expect(outcome.effects).toEqual(["catalog"]);
    for (const scope of ["commands", "plugins", "skills", "agents", "mcp", "models"])
      await stream.next(
        (e) =>
          e.frame.t === "catalog_changed" && e.frame.scope === scope && e.frame.workspaceId === wid,
      );
    stream.close();
    // The same session keeps working through the new application.
    expect((await t.api.get(`/api/sessions/${session.id}`)).status).toBe(200);
    expect((await command(session.id, "tools")).status).toBe(200);
  });

  it("answers the dedicated route with the structured report", async () => {
    const { t, wid } = await start();
    await newSession(t);
    const res = await t.api.post(`/api/workspaces/${wid}/reload`, {});
    expect(res.status).toBe(200);
    const report = res.json<ReloadReport>();
    expect(report.refreshed.map((r) => r.area)).toEqual([
      "config",
      "agents",
      "skills",
      "prompts",
      "mcp",
      "plugins",
    ]);
    expect((await t.api.post("/api/workspaces/nope/reload", {})).status).toBe(404);
  });

  it("validates before applying: a broken project config changes nothing", async () => {
    const { t, wid } = await start();
    const session = await newSession(t);
    await (await import("node:fs/promises")).mkdir(join(t.workspace, ".alisio"), {
      recursive: true,
    });
    await writeFile(join(t.workspace, ".alisio", "config.json"), "{ not json");
    const res = await t.api.post(`/api/workspaces/${wid}/reload`, {});
    expect(res.status).toBe(400);
    expect(res.json<{ error: { code: string; message: string } }>().error.message).toContain(
      "the current session is unchanged",
    );
    // The workspace is still open and serving.
    expect((await t.api.get(`/api/sessions/${session.id}`)).status).toBe(200);
    expect((await command(session.id, "tools")).status).toBe(200);
  });

  it("is refused while a turn runs, then works once it ends", async () => {
    const gated = gatedProvider();
    const { t, wid } = await start({ provider: gated });
    const session = await newSession(t);
    const run = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "run00001",
      text: "hello",
    });
    expect(run.status).toBe(202);
    await gated.started;
    const viaCommand = await command(session.id, "reload");
    expect(viaCommand.status).toBe(409);
    const viaRoute = await t.api.post(`/api/workspaces/${wid}/reload`, {});
    expect(viaRoute.status).toBe(409);
    expect(viaRoute.json<{ error: { code: string } }>().error.code).toBe("runs_active");
    gated.release();
    await settled(t, session.id);
    await until(
      async () => (await t?.api.post(`/api/workspaces/${wid}/reload`, {}))?.status === 200,
    );
  });

  it("uses the same auth and Origin rules as the other routes", async () => {
    const { t, wid } = await start();
    const anonymous = await raw(t.server.port, `/api/workspaces/${wid}/reload`, {
      method: "POST",
      body: {},
      headers: {
        Origin: `http://127.0.0.1:${t.server.port}`,
        "Content-Type": "application/json",
      },
    });
    expect(anonymous.status).toBe(401);
    const foreign = await raw(t.server.port, `/api/workspaces/${wid}/reload`, {
      method: "POST",
      body: {},
      headers: {
        Cookie: t.cookie,
        Origin: "http://evil.test",
        "Content-Type": "application/json",
      },
    });
    expect(foreign.status).toBe(403);
    const notJson = await raw(t.server.port, `/api/workspaces/${wid}/reload`, {
      method: "POST",
      body: "x",
      headers: { Cookie: t.cookie, Origin: `http://127.0.0.1:${t.server.port}` },
    });
    expect(notJson.status).toBe(415);
  });
});

describe("/changelog", () => {
  it("lists the newest entries, finds a version and reports news since lastSeen", async () => {
    const { t } = await start({ version: "0.1.0-alpha.28" });
    const all = (await t.api.get("/api/changelog")).json<ChangelogView>();
    expect(all).toMatchObject({ current: "0.1.0-alpha.28", found: true });
    expect(all.entries.length).toBeLessThanOrEqual(5);
    expect(all.entries[0]?.version).toBe("0.2.1");
    expect(all.news).toBeUndefined();

    const one = (await t.api.get("/api/changelog?version=alpha.26")).json<ChangelogView>();
    expect(one.entries.map((e) => e.version)).toEqual(["0.1.0-alpha.26"]);
    const missing = (await t.api.get("/api/changelog?version=9.9.9")).json<ChangelogView>();
    expect(missing).toMatchObject({ found: false, entries: [] });

    const news = (await t.api.get("/api/changelog?lastSeen=0.1.0-alpha.25")).json<ChangelogView>();
    expect(news.news).toEqual({
      latest: "0.1.0-alpha.28",
      versions: ["0.1.0-alpha.28", "0.1.0-alpha.27", "0.1.0-alpha.26"],
    });
    expect(
      (await t.api.get("/api/changelog?lastSeen=0.1.0-alpha.28")).json<ChangelogView>().news,
    ).toBeUndefined();
  });

  it("reports the stable release as news to anyone coming from an alpha", async () => {
    const { t } = await start({ version: "0.1.0" });
    const news = (await t.api.get("/api/changelog?lastSeen=0.1.0-alpha.28")).json<ChangelogView>();
    expect(news.news).toEqual({ latest: "0.1.0", versions: ["0.1.0"] });
    expect(
      (await t.api.get("/api/changelog?lastSeen=0.1.0")).json<ChangelogView>().news,
    ).toBeUndefined();
  });

  it("is also a slash command for API callers and needs the session cookie", async () => {
    const { t } = await start({ version: "0.1.0-alpha.28" });
    const session = await newSession(t);
    const out = (await command(session.id, "changelog", "alpha.27")).json<CommandOutcome>();
    expect(out.output).toContain("## 0.1.0-alpha.27");
    expect((await command(session.id, "changelog", "9.9.9")).status).toBe(400);
    expect((await raw(t.server.port, "/api/changelog")).status).toBe(401);
    expect(PROTOCOL_VERSION).toBe(1);
  });
});
