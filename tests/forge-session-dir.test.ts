/**
 * The volatile session directory on a real file system (spec §9.4, D19; FJ-AC-28/29/30/34):
 * private creation, the fallback when the shared root cannot be trusted, confinement of the
 * paths the model hands in, and the scratchpad quota.
 */
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import {
  ensureSessionDir,
  resolveScratchPath,
  type SessionDirOptions,
  scratchUsage,
  writeScratchFile,
} from "../packages/core/src/forge/session-dir.ts";

const posix = process.platform !== "win32";
const uid = posix ? (process.getuid?.() ?? 0) : 0;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "alisio-session-dir-"));
  dirs.push(root);
  const tmp = join(root, "tmp");
  const stateHome = join(root, "state");
  await mkdir(tmp, { recursive: true });
  const options = (overrides: Partial<SessionDirOptions> = {}): SessionDirOptions => ({
    rootSessionId: "root-session-1",
    workspace: "/home/ana/proj",
    workspaceKey: "0123456789abcdef",
    stateHome,
    env: { ALISIO_TMPDIR: tmp },
    ...overrides,
  });
  return { root, tmp, stateHome, options };
}

async function codeOf(action: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

const modeOf = async (path: string) => (await lstat(path)).mode & 0o777;

describe("session directory creation", () => {
  it("builds <root>/alisio-<uid>/<slug>/<rootSessionId> with scratchpad, tasks and a marker", async () => {
    const { tmp, options } = await sandbox();
    const dir = await ensureSessionDir(options());
    const base = posix ? `alisio-${uid}` : "alisio";
    expect(dir.root).toBe(join(tmp, base, "-home-ana-proj", "root-session-1"));
    expect(dir.scratchpad).toBe(join(dir.root, "scratchpad"));
    expect(dir.tasks).toBe(join(dir.root, "tasks"));
    expect(dir.fallback).toBe(false);
    expect(dir.diagnostic).toBeUndefined();
    const marker = JSON.parse(await readFile(join(dir.root, ".alisio-session"), "utf8"));
    expect(marker).toMatchObject({ sessionId: "root-session-1", workspaceKey: "0123456789abcdef" });
    expect(typeof marker.createdAt).toBe("number");
  });

  it.skipIf(!posix)("creates every level 0700 and the marker 0600 (FJ-AC-28)", async () => {
    const { tmp, options } = await sandbox();
    const dir = await ensureSessionDir(options());
    for (const path of [
      join(tmp, `alisio-${uid}`),
      join(tmp, `alisio-${uid}`, "-home-ana-proj"),
      dir.root,
      dir.scratchpad,
      dir.tasks,
    ])
      expect(await modeOf(path), path).toBe(0o700);
    expect(await modeOf(join(dir.root, ".alisio-session"))).toBe(0o600);
  });

  it("is idempotent and keeps the original marker", async () => {
    const { options } = await sandbox();
    const first = await ensureSessionDir(options());
    const marker = await readFile(join(first.root, ".alisio-session"), "utf8");
    await new Promise((r) => setTimeout(r, 5));
    const second = await ensureSessionDir(options());
    expect(second.root).toBe(first.root);
    expect(await readFile(join(second.root, ".alisio-session"), "utf8")).toBe(marker);
  });

  it("creates a temporary root that does not exist yet", async () => {
    const { root, options } = await sandbox();
    const missing = join(root, "not", "yet");
    const dir = await ensureSessionDir(options({ env: { ALISIO_TMPDIR: missing } }));
    expect(dir.root.startsWith(missing)).toBe(true);
    expect((await stat(dir.scratchpad)).isDirectory()).toBe(true);
  });

  it("takes the root from forge.scratch.root when ALISIO_TMPDIR is not set", async () => {
    const { tmp, options } = await sandbox();
    const dir = await ensureSessionDir(options({ env: {}, configRoot: tmp }));
    expect(dir.root.startsWith(tmp)).toBe(true);
  });

  it("refuses a root session id that is not a safe folder name", async () => {
    const { options } = await sandbox();
    expect(await codeOf(() => ensureSessionDir(options({ rootSessionId: "../escape" })))).toBe(
      "INVALID_INPUT",
    );
  });
});

describe.skipIf(!posix)(
  "an untrusted shared root falls back to the state folder (FJ-AC-29)",
  () => {
    it("does not use a symlinked alisio-<uid> and does not follow it", async () => {
      const { root, tmp, stateHome, options } = await sandbox();
      const target = join(root, "attacker");
      await mkdir(target, { mode: 0o700 });
      await symlink(target, join(tmp, `alisio-${uid}`));
      const dir = await ensureSessionDir(options());
      expect(dir.fallback).toBe(true);
      expect(dir.root).toBe(join(stateHome, "scratch", "0123456789abcdef", "root-session-1"));
      expect(dir.diagnostic).toMatch(/symlink/);
      expect(await readdir(target)).toEqual([]);
      expect((await lstat(join(tmp, `alisio-${uid}`))).isSymbolicLink()).toBe(true);
    });

    it("does not use a root with group or other permissions and does not chmod it", async () => {
      const { tmp, options } = await sandbox();
      const shared = join(tmp, `alisio-${uid}`);
      await mkdir(shared);
      await chmod(shared, 0o750);
      const dir = await ensureSessionDir(options());
      expect(dir.fallback).toBe(true);
      expect(dir.diagnostic).toMatch(/group or other/);
      expect(await modeOf(shared)).toBe(0o750);
      expect(await readdir(shared)).toEqual([]);
    });

    it("creates the fallback private too", async () => {
      const { tmp, options } = await sandbox();
      await mkdir(join(tmp, `alisio-${uid}`));
      await chmod(join(tmp, `alisio-${uid}`), 0o770);
      const dir = await ensureSessionDir(options());
      expect(await modeOf(dir.scratchpad)).toBe(0o700);
      expect(await modeOf(join(dir.root, ".alisio-session"))).toBe(0o600);
    });
  },
);

describe("scratchpad path confinement (FJ-AC-30)", () => {
  async function pad() {
    const box = await sandbox();
    const dir = await ensureSessionDir(box.options());
    return { ...box, dir };
  }

  it("resolves new and existing files inside the scratchpad", async () => {
    const { dir } = await pad();
    expect(await resolveScratchPath(dir.scratchpad, "a.js")).toBe(join(dir.scratchpad, "a.js"));
    await mkdir(join(dir.scratchpad, "sub"));
    await writeFile(join(dir.scratchpad, "sub", "b.py"), "x");
    expect(await resolveScratchPath(dir.scratchpad, join(dir.scratchpad, "sub", "b.py"))).toBe(
      join(dir.scratchpad, "sub", "b.py"),
    );
    // A folder that does not exist yet is fine: the write creates it.
    expect(await resolveScratchPath(dir.scratchpad, "new/deeper/c.js")).toBe(
      join(dir.scratchpad, "new", "deeper", "c.js"),
    );
  });

  it("rejects `..` and absolute paths outside", async () => {
    const { dir, root } = await pad();
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, "../tasks/x.log"))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, join(root, "other.js")))).toBe(
      "INVALID_INPUT",
    );
  });

  it.skipIf(!posix)("rejects a symlink inside the scratchpad that points outside", async () => {
    const { dir, root } = await pad();
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "secret.js"), "secret");
    await symlink(outside, join(dir.scratchpad, "link"));
    await symlink(join(outside, "secret.js"), join(dir.scratchpad, "file-link.js"));
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, "link/secret.js"))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, "link/new.js"))).toBe(
      "INVALID_INPUT",
    );
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, "file-link.js"))).toBe(
      "INVALID_INPUT",
    );
  });

  it.skipIf(!posix)("rejects a dangling symlink, which could be written through", async () => {
    const { dir, root } = await pad();
    await symlink(join(root, "does-not-exist"), join(dir.scratchpad, "dangling.js"));
    expect(await codeOf(() => resolveScratchPath(dir.scratchpad, "dangling.js"))).toBe(
      "INVALID_INPUT",
    );
  });

  it.skipIf(!posix)("accepts a symlink that stays inside", async () => {
    const { dir } = await pad();
    await writeFile(join(dir.scratchpad, "real.js"), "x");
    await symlink(join(dir.scratchpad, "real.js"), join(dir.scratchpad, "alias.js"));
    expect(await resolveScratchPath(dir.scratchpad, "alias.js")).toBe(
      join(dir.scratchpad, "alias.js"),
    );
  });
});

describe("scratchpad quota (FJ-AC-34)", () => {
  async function pad() {
    const box = await sandbox();
    return ensureSessionDir(box.options());
  }

  it("writes files 0600 and counts what the scratchpad holds", async () => {
    const dir = await pad();
    await writeScratchFile(dir.scratchpad, "a/one.js", "12345", { maxBytes: 100 });
    await writeScratchFile(dir.scratchpad, "two.js", Buffer.alloc(7), { maxBytes: 100 });
    expect(await scratchUsage(dir.scratchpad)).toBe(12);
    if (posix) expect(await modeOf(join(dir.scratchpad, "a", "one.js"))).toBe(0o600);
  });

  it("denies a write that would pass the limit with a clear error and deletes nothing", async () => {
    const dir = await pad();
    await writeScratchFile(dir.scratchpad, "keep.js", "x".repeat(60), { maxBytes: 100 });
    const error = await writeScratchFile(dir.scratchpad, "big.js", "y".repeat(41), {
      maxBytes: 100,
    }).catch((e: unknown) => e as ForgeError);
    if (typeof error === "string") throw new Error("the write was not denied");
    expect(error.code).toBe("BUDGET_EXCEEDED");
    expect(error.message).toMatch(/scratchpad.*100 bytes/);
    expect(await readFile(join(dir.scratchpad, "keep.js"), "utf8")).toBe("x".repeat(60));
    await expect(stat(join(dir.scratchpad, "big.js"))).rejects.toThrow();
    // Exactly at the limit is allowed.
    await writeScratchFile(dir.scratchpad, "fits.js", "y".repeat(40), { maxBytes: 100 });
  });

  it("counts an overwrite by its growth, not twice", async () => {
    const dir = await pad();
    await writeScratchFile(dir.scratchpad, "a.js", "x".repeat(80), { maxBytes: 100 });
    await writeScratchFile(dir.scratchpad, "a.js", "y".repeat(90), { maxBytes: 100 });
    expect(await scratchUsage(dir.scratchpad)).toBe(90);
    expect(
      await codeOf(() =>
        writeScratchFile(dir.scratchpad, "a.js", "z".repeat(101), { maxBytes: 100 }),
      ),
    ).toBe("BUDGET_EXCEEDED");
    expect(await readFile(join(dir.scratchpad, "a.js"), "utf8")).toBe("y".repeat(90));
  });

  it("does not write outside the scratchpad", async () => {
    const dir = await pad();
    expect(
      await codeOf(() => writeScratchFile(dir.scratchpad, "../escape.js", "x", { maxBytes: 100 })),
    ).toBe("INVALID_INPUT");
  });
});
