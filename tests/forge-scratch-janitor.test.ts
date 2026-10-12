/**
 * Retention of the volatile session directories (spec §9.4, FJ-AC-33): a folder goes when its root
 * session no longer exists or its last activity is older than `retentionDays`; only folders whose
 * marker matches, under a verified root, and never through a symlink.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ScratchJanitor } from "../packages/core/src/analysis/janitor.ts";
import { ensureSessionDir, type SessionDir } from "../packages/core/src/forge/session-dir.ts";

const DAY = 86_400_000;
const posix = process.platform !== "win32";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function setup(options: { retentionDays?: number; live?: string[] } = {}) {
  const base = await mkdtemp(join(tmpdir(), "alisio-scratch-janitor-"));
  dirs.push(base);
  const tmp = join(base, "tmp");
  const state = join(base, "state");
  const clock = { now: Date.now() };
  const live = new Set(options.live ?? []);
  let retentionDays = options.retentionDays ?? 7;
  const session = (id: string, workspace = "/w/one"): Promise<SessionDir> =>
    ensureSessionDir({
      rootSessionId: id,
      workspace,
      workspaceKey: "0123456789abcdef",
      stateHome: state,
      env: { ALISIO_TMPDIR: tmp },
    });
  const sharedRoot = join(tmp, posix ? `alisio-${process.getuid?.()}` : "alisio");
  const janitor = async (extraRoots: string[] = []) => {
    const root = sharedRoot;
    return new ScratchJanitor({
      stateRoot: state,
      roots: () => [root, ...extraRoots],
      sessionExists: (id) => live.has(id),
      retentionDays: () => retentionDays,
      now: () => clock.now,
    });
  };
  /** Back-dates every entry of a folder, as if nothing touched it for `days`. */
  const age = async (dir: string, days: number) => {
    const when = new Date(clock.now - days * DAY);
    const { readdir } = await import("node:fs/promises");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await age(path, days);
      else await utimes(path, when, when);
    }
    await utimes(dir, when, when);
  };
  return {
    base,
    tmp,
    state,
    clock,
    live,
    session,
    janitor,
    age,
    setRetention: (days: number) => {
      retentionDays = days;
    },
  };
}

describe("scratch janitor", () => {
  it("deletes the folder of a root session that no longer exists and keeps a live one", async () => {
    const { session, janitor, live } = await setup();
    const gone = await session("gone");
    const kept = await session("kept");
    live.add("kept");
    await writeFile(join(gone.scratchpad, "a.js"), "x".repeat(10));
    const report = await (await janitor()).sweep();
    expect(existsSync(gone.root)).toBe(false);
    expect(existsSync(kept.root)).toBe(true);
    expect(report).toMatchObject({ sessionsDeleted: 1, errors: 0 });
    expect(report.bytesFreed).toBeGreaterThanOrEqual(10);
  });

  it("deletes a live session's folder only after retentionDays without activity", async () => {
    const { session, janitor, live, age, clock } = await setup();
    live.add("s");
    const dir = await session("s");
    await writeFile(join(dir.scratchpad, "a.js"), "x");
    await age(dir.root, 6);
    expect(await (await janitor()).sweep({ force: true })).toMatchObject({ sessionsDeleted: 0 });
    expect(existsSync(dir.root)).toBe(true);
    clock.now += 2 * DAY; // 8 days of inactivity
    expect(await (await janitor()).sweep({ force: true })).toMatchObject({ sessionsDeleted: 1 });
    expect(existsSync(dir.root)).toBe(false);
  });

  it("counts activity deep inside the folder, not only on the folder itself", async () => {
    const { session, janitor, live, age } = await setup();
    live.add("s");
    const dir = await session("s");
    await mkdir(join(dir.scratchpad, "sub"));
    await writeFile(join(dir.scratchpad, "sub", "edited.py"), "x");
    await age(dir.root, 30);
    const now = new Date();
    await utimes(join(dir.scratchpad, "sub", "edited.py"), now, now); // edited in place today
    expect(await (await janitor()).sweep({ force: true })).toMatchObject({ sessionsDeleted: 0 });
    expect(existsSync(dir.root)).toBe(true);
  });

  it("deletes nothing at all when retentionDays is 0", async () => {
    const { session, janitor, age } = await setup({ retentionDays: 0 });
    const dir = await session("gone");
    await age(dir.root, 365);
    expect(await (await janitor()).sweep({ force: true })).toMatchObject({ sessionsDeleted: 0 });
    expect(existsSync(dir.root)).toBe(true);
  });

  it("leaves a folder alone when its marker is missing or names another session", async () => {
    const { session, janitor } = await setup();
    const noMarker = await session("no-marker");
    await rm(join(noMarker.root, ".alisio-session"));
    const wrong = await session("wrong");
    await writeFile(
      join(wrong.root, ".alisio-session"),
      JSON.stringify({ sessionId: "someone-else", workspaceKey: "k", createdAt: 1 }),
    );
    const foreign = join(dirname(noMarker.root), "not-ours");
    await mkdir(foreign);
    await writeFile(join(foreign, "keep.txt"), "x");
    const report = await (await janitor()).sweep();
    expect(report.sessionsDeleted).toBe(0);
    for (const path of [noMarker.root, wrong.root, join(foreign, "keep.txt")])
      expect(existsSync(path), path).toBe(true);
  });

  it("removes the workspace folder once its last session is gone", async () => {
    const { session, janitor } = await setup();
    const dir = await session("only");
    await (await janitor()).sweep();
    expect(existsSync(dirname(dir.root))).toBe(false);
  });

  it("sweeps the fallback root too", async () => {
    const { session, janitor, state } = await setup();
    const fallbackRoot = join(state, "scratch");
    const id = "fb";
    const root = join(fallbackRoot, "0123456789abcdef", id);
    await mkdir(join(root, "scratchpad"), { recursive: true });
    await writeFile(
      join(root, ".alisio-session"),
      JSON.stringify({ sessionId: id, workspaceKey: "0123456789abcdef", createdAt: 1 }),
    );
    await session("also-gone");
    const report = await (await janitor([fallbackRoot])).sweep();
    expect(report.sessionsDeleted).toBe(2);
    expect(existsSync(root)).toBe(false);
  });

  it.skipIf(!posix)("never follows a symlink, in the layout or inside a session", async () => {
    const { session, janitor, base } = await setup();
    const outside = join(base, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "precious.txt"), "keep");

    // A symlink inside a deleted session points at a folder outside.
    const gone = await session("gone");
    await symlink(outside, join(gone.scratchpad, "link"));
    // A session folder that is itself a symlink to a folder with a valid marker.
    const decoy = join(base, "decoy");
    await mkdir(decoy);
    await writeFile(
      join(decoy, ".alisio-session"),
      JSON.stringify({ sessionId: "decoy", workspaceKey: "k", createdAt: 1 }),
    );
    await symlink(decoy, join(dirname(gone.root), "decoy"));
    // A workspace folder that is a symlink to a folder holding a session-like folder.
    const mirror = join(base, "mirror");
    await mkdir(join(mirror, "victim"), { recursive: true });
    await writeFile(
      join(mirror, "victim", ".alisio-session"),
      JSON.stringify({ sessionId: "victim", workspaceKey: "k", createdAt: 1 }),
    );
    await symlink(mirror, join(dirname(dirname(gone.root)), "mirror-link"));

    const report = await (await janitor()).sweep();
    expect(existsSync(gone.root)).toBe(false);
    expect(await readFile(join(outside, "precious.txt"), "utf8")).toBe("keep");
    expect(existsSync(join(decoy, ".alisio-session"))).toBe(true);
    expect(existsSync(join(mirror, "victim", ".alisio-session"))).toBe(true);
    expect(report.sessionsDeleted).toBe(1);
  });

  it.skipIf(!posix)("skips a configured root that is a symlink", async () => {
    const { session, base } = await setup();
    const dir = await session("gone");
    const linked = join(base, "linked-root");
    await symlink(dirname(dirname(dir.root)), linked);
    // The configured root is a symlink to the real one: nothing is verified, nothing is deleted.
    const swept = await new ScratchJanitor({
      stateRoot: join(base, "state2"),
      roots: () => [linked],
      sessionExists: () => false,
      retentionDays: () => 7,
    }).sweep();
    expect(swept.sessionsDeleted).toBe(0);
    expect(existsSync(dir.root)).toBe(true);
  });

  it("sweeps at most once every 24 hours, unless forced", async () => {
    const { session, janitor, clock } = await setup();
    const janitorA = await janitor();
    await session("first");
    expect((await janitorA.sweep()).sessionsDeleted).toBe(1);
    const again = await session("second");
    expect(await janitorA.sweep()).toMatchObject({ skipped: "recent", sessionsDeleted: 0 });
    expect(existsSync(again.root)).toBe(true);
    clock.now += DAY + 1;
    expect((await janitorA.sweep()).sessionsDeleted).toBe(1);
    await session("third");
    expect((await janitorA.sweep({ force: true })).sessionsDeleted).toBe(1);
  });

  it("does not sweep while another process holds the lock", async () => {
    const { session, janitor, state } = await setup();
    const dir = await session("gone");
    await mkdir(join(state, "forge"), { recursive: true });
    await writeFile(join(state, "forge", ".scratch-sweep.lock"), "1\n");
    expect(await (await janitor()).sweep()).toMatchObject({ skipped: "locked" });
    expect(existsSync(dir.root)).toBe(true);
  });
});
