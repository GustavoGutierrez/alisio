import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const fresh = () => new SQLiteStore(join(mkdtempSync(join(tmpdir(), "alisio-meta-")), "s.sqlite"));

describe("SQLiteStore web metadata (additive, v4 columns)", () => {
  it("lists workspaces as root-session workspaces plus recorded ones, with metadata", () => {
    const store = fresh();
    store.create("/w/a", "p", "m");
    store.create("/w/a", "p", "m");
    const root = store.create("/w/b", "p", "m");
    store.createChild({
      parentId: root.id,
      workspace: "/w/child-only",
      provider: "p",
      model: "m",
      agent: "x",
      title: "t",
      depth: 1,
      options: {},
    });
    store.recordWorkspace("/w/c", { label: "Cee", lastOpenedAt: 5 });
    store.recordWorkspace("/w/a", { pinned: true });
    const list = store.workspaces();
    expect(list.map((w) => w.path).sort()).toEqual(["/w/a", "/w/b", "/w/c"]);
    expect(list.find((w) => w.path === "/w/a")).toMatchObject({ pinned: true, sessions: 2 });
    expect(list.find((w) => w.path === "/w/c")).toMatchObject({
      label: "Cee",
      pinned: false,
      lastOpenedAt: 5,
      sessions: 0,
    });
    store.recordWorkspace("/w/c", { label: null });
    expect(store.workspaces().find((w) => w.path === "/w/c")?.label).toBeUndefined();
  });

  it("updates root session title, pin, archive and merged options", () => {
    const store = fresh();
    const s = store.create("/w", "p", "m");
    store.updateSessionMeta(s.id, { title: "Hello", pinned: true, options: { preset: "ask" } });
    store.updateSessionMeta(s.id, { archived: true, options: { effort: "high" } });
    const got = store.get(s.id);
    expect(got).toMatchObject({
      title: "Hello",
      pinned: true,
      options: { preset: "ask", effort: "high" },
    });
    expect(got.archivedAt).toEqual(expect.any(Number));
    store.updateSessionMeta(s.id, { archived: false, pinned: false });
    expect(store.get(s.id).archivedAt).toBeUndefined();
    expect(store.get(s.id).pinned).toBeUndefined();
  });

  it("reports the latest event id of a session (the SSE snapshot cursor)", () => {
    const store = fresh();
    const s = store.create("/w", "p", "m");
    expect(store.lastEventId(s.id)).toBe(0);
    store.event(s.id, "r", "run_started", {});
    const second = store.event(s.id, "r", "run_completed", {});
    expect(store.lastEventId(s.id)).toBe(second);
  });

  it("reports a live foreign lock owner, ignoring its own process and dead owners", async () => {
    const store = fresh();
    const s = store.create("/w", "p", "m");
    expect(store.lockedBy(s.id)).toBeUndefined();
    store.acquire(s.id);
    expect(store.lockedBy(s.id)).toBeUndefined();
    store.release(s.id);
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10000)"]);
    try {
      store.db
        .prepare("UPDATE sessions SET locked_pid=? WHERE id=?")
        .run(child.pid as number, s.id);
      expect(store.lockedBy(s.id)).toBe(child.pid);
    } finally {
      child.kill();
      await new Promise((done) => child.on("close", done));
    }
    expect(store.lockedBy(s.id)).toBeUndefined();
  });
});
