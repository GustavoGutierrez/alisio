import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WorkspaceInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  type Application,
  WorkspaceHost,
  workspaceId,
} from "../packages/server/src/host/workspace-host.ts";
import {
  gatedProvider,
  newSession,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

const dir = async (name: string) => {
  const path = join(await realpath(await mkdtemp(join(tmpdir(), "alisio-ws-"))), name);
  await mkdir(path);
  return path;
};

/** A host with a fake `createApplication` that records its options. */
function fakeHost(options: Partial<ConstructorParameters<typeof WorkspaceHost>[0]> = {}) {
  const created: Array<Record<string, unknown>> = [];
  const closed: string[] = [];
  let clock = 1_000;
  const catalog = new SQLiteStore(":memory:");
  const host = new WorkspaceHost({
    base: {},
    catalog,
    now: () => clock,
    create: (async (opts: Record<string, unknown>) => {
      created.push(opts);
      return { close: async () => void closed.push(String(opts.cwd)) } as unknown as Application;
    }) as never,
    ...options,
  });
  return { host, created, closed, tick: (ms: number) => (clock += ms) };
}

describe("WorkspaceHost (T-18)", () => {
  it("creates one application lazily per workspace and reuses it", async () => {
    const { host, created } = fakeHost();
    const a = await dir("a");
    expect(host.openCount).toBe(0);
    const [first, second] = await Promise.all([host.openPath(a), host.openPath(a)]);
    expect(first).toBe(second);
    expect(created).toHaveLength(1);
    expect(created[0]?.cwd).toBe(a);
    expect(first.id).toBe(workspaceId(a));
  });

  it("evicts the least recently used idle workspace at the limit", async () => {
    const { host, closed, tick } = fakeHost({ maxOpen: 2 });
    const [a, b, c] = await Promise.all([dir("a"), dir("b"), dir("c")]);
    await host.openPath(a);
    tick(10);
    await host.openPath(b);
    tick(10);
    host.touch(workspaceId(a));
    await host.openPath(c);
    expect(closed).toEqual([b]);
    expect(
      host
        .entries()
        .map((w) => w.path)
        .sort(),
    ).toEqual([a, c].sort());
  });

  it("answers 503 workspace_limit when every open workspace is busy", async () => {
    const { host } = fakeHost({ maxOpen: 1, busy: () => true });
    await host.openPath(await dir("a"));
    await expect(host.openPath(await dir("b"))).rejects.toMatchObject({
      code: "workspace_limit",
      status: 503,
    });
  });

  it("closes idle applications after idleEvictMs but keeps busy ones", async () => {
    let busy = "";
    const { host, closed, tick } = fakeHost({ idleEvictMs: 100, busy: (id) => id === busy });
    const [a, b] = await Promise.all([dir("a"), dir("b")]);
    await host.openPath(a);
    await host.openPath(b);
    busy = workspaceId(b);
    tick(50);
    expect(await host.sweep()).toBe(0);
    tick(100);
    expect(await host.sweep()).toBe(1);
    expect(closed).toEqual([a]);
  });

  it("opens a directory with untrusted project resources without them (the web never grants trust)", async () => {
    const { host, created } = fakeHost();
    const a = await dir("a");
    await mkdir(join(a, ".alisio"));
    await writeFile(join(a, ".alisio", "config.json"), "{}");
    const opened = await host.openPath(a);
    expect(created[0]?.trustProject).toBe(false);
    expect(opened).toMatchObject({ trusted: false, untrustedResources: true });
    expect(await host.info(a)).toMatchObject({ trusted: false, untrustedResources: true });
  });

  it("keeps explicit launch trust (--trust-project) for every workspace", async () => {
    const { host, created } = fakeHost({ base: { trustProject: true } });
    await host.openPath(await dir("a"));
    expect(created[0]?.trustProject).toBe(true);
  });

  it("rejects opening a workspace whose folder no longer exists with workspace_missing", async () => {
    const { host, created } = fakeHost();
    const gone = await dir("gone");
    await rm(gone, { recursive: true });
    await expect(host.openPath(gone)).rejects.toMatchObject({
      code: "workspace_missing",
      status: 404,
      message: expect.stringContaining(gone),
    });
    expect(created).toHaveLength(0);
  });

  it("rejects reusing an open workspace after its folder was deleted", async () => {
    const { host } = fakeHost();
    const a = await dir("a");
    await host.openPath(a);
    await rm(a, { recursive: true });
    await expect(host.openPath(a)).rejects.toMatchObject({ code: "workspace_missing" });
  });

  it("reports whether each known workspace folder exists", async () => {
    const { host } = fakeHost();
    const [a, gone] = await Promise.all([dir("a"), dir("gone")]);
    await host.openPath(a);
    await host.openPath(gone);
    await host.close(workspaceId(gone));
    await rm(gone, { recursive: true });
    const list = await host.list();
    expect(list.find((w) => w.path === a)).toMatchObject({ exists: true });
    expect(list.find((w) => w.path === gone)).toMatchObject({ exists: false, open: false });
  });
});

describe("workspace routes (T-18)", () => {
  it("lists the default workspace without opening it, then opens it on POST", async () => {
    t = await startTestServer();
    const canonical = await realpath(t.workspace);
    const list = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    expect(list).toEqual([
      expect.objectContaining({ path: canonical, open: false, pinned: false }),
    ]);
    expect((await t.api.get("/api/metrics")).json()).toMatchObject({ openWorkspaces: 0 });
    const opened = await t.api.post("/api/workspaces", { path: t.workspace });
    expect(opened.status).toBe(200);
    expect(opened.json<WorkspaceInfo>()).toMatchObject({
      id: workspaceId(canonical),
      path: canonical,
      open: true,
      trusted: false,
    });
    expect((await t.api.get("/api/metrics")).json()).toMatchObject({ openWorkspaces: 1 });
  });

  it("validates the path: relative is 400, missing is 404", async () => {
    t = await startTestServer();
    const relative = await t.api.post("/api/workspaces", { path: "some/dir" });
    expect(relative.status).toBe(400);
    expect(relative.json()).toMatchObject({
      error: { code: "validation_failed", details: { fields: ["path"] } },
    });
    const missing = await t.api.post("/api/workspaces", { path: join(t.root, "nope") });
    expect(missing.status).toBe(404);
    const unknown = await t.api.post("/api/workspaces", { path: t.workspace, extra: 1 });
    expect(unknown.json()).toMatchObject({ error: { details: { fields: ["extra"] } } });
  });

  it("patches label and pin of a known workspace and 404s an unknown id", async () => {
    t = await startTestServer();
    const [info] = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    const patched = await t.api.patch(`/api/workspaces/${info?.id}`, {
      label: "Main",
      pinned: true,
    });
    expect(patched.json()).toMatchObject({ label: "Main", pinned: true });
    expect((await t.api.patch("/api/workspaces/ffff", { pinned: true })).status).toBe(404);
  });

  it("evicts the least recently used idle workspace when --max-workspaces is reached", async () => {
    t = await startTestServer({ maxOpenWorkspaces: 1 });
    const other = join(t.root, "other");
    await mkdir(other);
    await t.api.post("/api/workspaces", { path: t.workspace });
    await t.api.post("/api/workspaces", { path: other });
    const list = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    expect(list.filter((w) => w.open).map((w) => w.path)).toEqual([await realpath(other)]);
  });
  it("never answers 500 for a known workspace whose folder was deleted", async () => {
    t = await startTestServer();
    const other = join(t.root, "other");
    await mkdir(other);
    const opened = (await t.api.post("/api/workspaces", { path: other })).json<WorkspaceInfo>();
    const created = await t.api.post("/api/sessions", { workspace: opened.id });
    expect(created.status).toBe(201);
    const { id: sid } = created.json<{ id: string }>();
    await rm(other, { recursive: true });

    const list = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    expect(list.find((w) => w.id === opened.id)).toMatchObject({ exists: false });
    expect(list.find((w) => w.id !== opened.id)).toMatchObject({ exists: true });

    const again = await t.api.post("/api/sessions", { workspace: opened.id });
    expect(again.status).toBe(404);
    expect(again.json()).toMatchObject({
      error: { code: "workspace_missing", message: expect.stringContaining(opened.path) },
    });
    const prompt = await t.api.post(`/api/sessions/${sid}/prompts`, {
      requestId: "r-1",
      text: "hi",
    });
    expect(prompt.status).toBe(404);
    expect(prompt.json()).toMatchObject({ error: { code: "workspace_missing" } });
    const tree = await t.api.get(`/api/workspaces/${opened.id}/tree`);
    expect(tree.json()).toMatchObject({ error: { code: "workspace_missing" } });
    // The session itself stays readable.
    expect((await t.api.get(`/api/sessions/${sid}`)).status).toBe(200);
  });
});

describe("archived workspaces", () => {
  it("archives a workspace: hidden from the default list, listed with ?archived=true|all", async () => {
    t = await startTestServer();
    const [info] = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    expect(info).toMatchObject({ archived: false });
    const patched = await t.api.patch(`/api/workspaces/${info?.id}`, { archived: true });
    expect(patched.status).toBe(200);
    expect(patched.json()).toMatchObject({ id: info?.id, archived: true });
    expect((await t.api.get("/api/workspaces")).json()).toEqual([]);
    expect((await t.api.get("/api/workspaces?archived=true")).json()).toEqual([
      expect.objectContaining({ id: info?.id, archived: true }),
    ]);
    expect((await t.api.get("/api/workspaces?archived=all")).json()).toHaveLength(1);
    expect((await t.api.get("/api/workspaces?archived=maybe")).status).toBe(400);
    const restored = await t.api.patch(`/api/workspaces/${info?.id}`, { archived: false });
    expect(restored.json()).toMatchObject({ archived: false });
    expect((await t.api.get("/api/workspaces")).json()).toHaveLength(1);
  });

  it("closes the idle app, keeps sessions readable and rejects new sessions with 409", async () => {
    t = await startTestServer();
    const created = await t.api.post("/api/sessions", { workspace: t.workspace });
    const session = created.json<{ id: string; workspaceId: string }>();
    expect((await t.api.get("/api/metrics")).json()).toMatchObject({ openWorkspaces: 1 });
    const archived = await t.api.patch(`/api/workspaces/${session.workspaceId}`, {
      archived: true,
    });
    expect(archived.json()).toMatchObject({ archived: true, open: false });
    expect((await t.api.get("/api/metrics")).json()).toMatchObject({ openWorkspaces: 0 });
    expect((await t.api.get(`/api/sessions/${session.id}`)).status).toBe(200);
    const listed = (await t.api.get("/api/sessions?archived=all")).json<{
      items: Array<{ id: string }>;
    }>();
    expect(listed.items.map((s) => s.id)).toContain(session.id);
    for (const workspace of [session.workspaceId, t.workspace]) {
      const again = await t.api.post("/api/sessions", { workspace });
      expect(again.status).toBe(409);
      expect(again.json()).toMatchObject({ error: { code: "workspace_archived" } });
    }
  });

  it("refuses to archive a workspace with an active run (409 runs_active)", async () => {
    const gate = gatedProvider();
    t = await startTestServer({ provider: gate.provider });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r-1", text: "go" });
    await gate.started;
    const busy = await t.api.patch(`/api/workspaces/${session.workspaceId}`, { archived: true });
    expect(busy.status).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "runs_active" } });
    gate.release();
    await settled(t, session.id);
    const done = await t.api.patch(`/api/workspaces/${session.workspaceId}`, { archived: true });
    expect(done.status).toBe(200);
  });

  it("archives a missing folder known only from sessions, and reopening it unarchives", async () => {
    t = await startTestServer();
    const other = join(t.root, "gone");
    await mkdir(other);
    const opened = (await t.api.post("/api/workspaces", { path: other })).json<WorkspaceInfo>();
    await t.api.post("/api/sessions", { workspace: opened.id });
    // Forget the workspaces row: the workspace is now known only from its sessions.
    const store = new SQLiteStore(t.db);
    store.db.prepare("DELETE FROM workspaces WHERE path=?").run(opened.path);
    store.close();
    await rm(other, { recursive: true });
    const archived = await t.api.patch(`/api/workspaces/${opened.id}`, { archived: true });
    expect(archived.status).toBe(200);
    expect(archived.json()).toMatchObject({ exists: false, archived: true });
    expect(
      (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>().map((w) => w.id),
    ).not.toContain(opened.id);
    // Explicitly opening an archived (existing) folder again brings it back.
    const [main] = (await t.api.get("/api/workspaces")).json<WorkspaceInfo[]>();
    await t.api.patch(`/api/workspaces/${main?.id}`, { archived: true });
    const reopened = await t.api.post("/api/workspaces", { path: t.workspace });
    expect(reopened.json()).toMatchObject({ id: main?.id, archived: false });
  });
});
