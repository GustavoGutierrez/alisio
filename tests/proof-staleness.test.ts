/**
 * Proof phase 3 (specs/011 3.4, D5, D7): a successful write_file/edit_file expires the evidence of
 * the criteria whose scope covers the edited path. Evaluation stays pure: the edit time is data,
 * the status is derived on every read. The runner is real; the provider and the clock are scripted.
 */
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunEvent, ToolDefinition } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { PERMISSION_MODE_TABLE } from "../packages/core/src/permissions/modes.ts";
import { ProofRecorder } from "../packages/core/src/proof/recorder.ts";
import { scopeMatches } from "../packages/core/src/proof/scope.ts";
import { ProofStore } from "../packages/core/src/proof/store.ts";
import { treeFingerprint } from "../packages/core/src/proof/tree.ts";
import { effectTool, gateFixture, type ScriptedCall } from "./forge-gate-helpers.ts";

const fixtures: Array<{ close(): Promise<void> }> = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.close();
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const START = Date.parse("2026-10-14T10:00:00.000Z");

/** Every `now()` of the recorder advances the clock one second: strictly ordered captures. */
function open(options: { failEdits?: boolean } = {}) {
  return (async () => {
    const events: RunEvent[] = [];
    let tick = 0;
    const edit = (name: string) =>
      effectTool(name, "write", {
        async execute() {
          if (options.failEdits) throw new Error("boom");
          return { content: [{ type: "text" as const, text: '{"sha256":"x"}' }] };
        },
      });
    const tools: ToolDefinition[] = [
      effectTool("run_process", "process", {
        async execute() {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0, truncated: false }),
              },
            ],
          };
        },
      }),
      edit("write_file"),
      edit("edit_file"),
    ];
    const fx = await gateFixture({
      policy: { ...PERMISSION_MODE_TABLE.full.policy },
      tools,
      onEvent: (e) => events.push(e),
      proof: (store) => new ProofRecorder(store.db, { now: () => new Date(START + ++tick * 1000) }),
    });
    fixtures.push(fx);
    const proof = new ProofStore(fx.store.db);
    const criterion = (scope?: string[], command = "pnpm test") =>
      proof.addCriterion({
        sessionId: fx.session,
        text: `criterion ${command}`,
        origin: "user",
        required: true,
        verifier: { kind: "command", command },
        ...(scope ? { scope } : {}),
      });
    const updates = () => events.filter((e) => e.type === "proof_updated").map((e) => e.data);
    const status = (index = 0) => proof.ledger(fx.session).criteria[index];
    return { fx, proof, events, criterion, updates, status };
  })();
}
const test: ScriptedCall = {
  name: "run_process",
  arguments: { command: "pnpm", args: ["test"] },
};
const write = (path: string, name = "write_file"): ScriptedCall => ({
  name,
  arguments: { path, content: "x" },
});

describe("scopeMatches", () => {
  it.each([
    [undefined, "any/file.ts", true],
    [[], "any/file.ts", true],
    [["src/**"], "src/a/b.ts", true],
    [["src/**"], "src/a.ts", true],
    [["src/**"], "docs/a.md", false],
    [["src/**"], "src", true],
    [["src"], "src/a/b.ts", true],
    [["src/"], "src/a.ts", true],
    [["src"], "srcs/a.ts", false],
    [["*.md"], "README.md", true],
    [["*.md"], "docs/README.md", false],
    [["**/*.md"], "docs/a/README.md", true],
    [["**/*.md"], "README.md", true],
    [["src/*.ts"], "src/a.ts", true],
    [["src/*.ts"], "src/deep/a.ts", false],
    [["src/?.ts"], "src/a.ts", true],
    [["src/?.ts"], "src/ab.ts", false],
    [["{src,lib}/**"], "lib/x.ts", true],
    [["{src,lib}/**"], "test/x.ts", false],
    [["./src/**"], "src/a.ts", true],
    [["docs/**", "src/**"], "src/a.ts", true],
    [["docs/**", "src/**"], "other/a.ts", false],
    [["src/**"], "src\\a\\b.ts", true],
    [["src/a.ts"], "src/a.ts", true],
    [["src/a.ts"], "src/b.ts", false],
    [["packages/*/src/**"], "packages/core/src/x.ts", true],
    [["a.b"], "aXb", false],
  ])("scope %j against %j is %s", (scope, path, expected) => {
    expect(scopeMatches(scope, path)).toBe(expected);
  });
});

describe("staleness after write_file/edit_file", () => {
  it("a later edit inside the scope expires the evidence (stale) and announces it", async () => {
    const t = await open();
    const crit = t.criterion(["src/**"]);
    await t.fx.play([test]);
    expect(t.status()).toMatchObject({ status: "verified" });
    const evidenceId = t.proof.ledger(t.fx.session).evidence[0]?.evidenceId;
    expect(t.updates()).toEqual([
      { criterionId: crit.criterionId, status: "verified", stale: false, evidenceId },
    ]);

    await t.fx.play([write("src/a.ts")]);

    expect(t.status()).toMatchObject({ status: "not_checked", stale: true });
    expect(t.updates().at(-1)).toEqual({
      criterionId: crit.criterionId,
      status: "not_checked",
      stale: true,
    });
  });

  it("an edit outside the scope changes nothing and emits nothing", async () => {
    const t = await open();
    t.criterion(["src/**"]);
    await t.fx.play([test]);
    const announced = t.updates().length;

    await t.fx.play([write("docs/readme.md"), write("README.md", "edit_file")]);

    expect(t.status()).toMatchObject({ status: "verified" });
    expect(t.status()?.stale).toBeUndefined();
    expect(t.updates()).toHaveLength(announced);
  });

  it("without a scope the whole workspace counts, absolute paths included", async () => {
    const t = await open();
    t.criterion();
    await t.fx.play([test]);
    await t.fx.play([write(join(t.fx.root, "anything", "x.txt"))]);
    expect(t.status()).toMatchObject({ status: "not_checked", stale: true });
  });

  it("an edit outside the workspace never touches the ledger", async () => {
    const t = await open();
    t.criterion();
    await t.fx.play([test]);
    await t.fx.play([write("../elsewhere.txt"), write("/etc/hosts-copy")]);
    expect(t.status()).toMatchObject({ status: "verified" });
  });

  it("re-running the command after the edit verifies again", async () => {
    const t = await open();
    t.criterion(["src/**"]);
    await t.fx.play([test]);
    await t.fx.play([write("src/a.ts", "edit_file")]);
    expect(t.status()?.status).toBe("not_checked");
    await t.fx.play([test]);
    expect(t.status()).toMatchObject({ status: "verified" });
    expect(t.status()?.stale).toBeUndefined();
  });

  it("only the criteria whose scope intersects are expired", async () => {
    const t = await open();
    t.criterion(["src/**"], "pnpm test");
    t.criterion(["docs/**"], "pnpm lint");
    await t.fx.play([
      test,
      { name: "run_process", arguments: { command: "pnpm", args: ["lint"] } },
    ]);
    await t.fx.play([write("docs/guide.md")]);
    expect(t.proof.ledger(t.fx.session).criteria.map((c) => c.status)).toEqual([
      "verified",
      "not_checked",
    ]);
  });

  it("an expired failure is not_checked without stale; the announcement says so once", async () => {
    const t = await open();
    const crit = t.criterion();
    t.fx.store.db
      .prepare("UPDATE proof_criteria SET verifier_json=? WHERE criterion_id=?")
      .run(
        JSON.stringify({ kind: "command", command: "pnpm test", successExitCodes: [7] }),
        crit.criterionId,
      );
    await t.fx.play([test]);
    expect(t.status()).toMatchObject({ status: "failed" });

    await t.fx.play([write("a.ts")]);

    expect(t.status()?.status).toBe("not_checked");
    expect(t.status()?.stale).toBeUndefined();
    expect(t.updates().at(-1)).toMatchObject({ status: "not_checked", stale: false });
    const announced = t.updates().length;
    await t.fx.play([write("b.ts")]);
    expect(t.updates()).toHaveLength(announced);
  });

  it("a failed edit (the tool threw) records nothing", async () => {
    const t = await open({ failEdits: true });
    t.criterion();
    await t.fx.play([test]);
    const out = await t.fx.play([write("src/a.ts")]);
    expect(out[0]?.isError).toBe(true);
    expect(t.status()).toMatchObject({ status: "verified" });
    expect(t.fx.store.db.prepare("SELECT * FROM proof_edits").all()).toEqual([]);
  });

  it("the expiry survives a new process: it is read back from the database, purely", async () => {
    const t = await open();
    t.criterion(["src/**"]);
    await t.fx.play([test]);
    await t.fx.play([write("src/a.ts")]);
    const fresh = new ProofStore(t.fx.store.db);
    const a = fresh.ledger(t.fx.session, "2030-01-01T00:00:00.000Z");
    const b = fresh.ledger(t.fx.session, "2031-06-01T00:00:00.000Z");
    expect(a.criteria).toEqual(b.criteria);
    expect(a.criteria[0]).toMatchObject({ status: "not_checked", stale: true });
  });

  it("an edit at the very same instant as the evidence expires it (fail safe)", async () => {
    const t = await open();
    const crit = t.criterion();
    const ev = t.proof.appendEvidence({
      criterionId: crit.criterionId,
      verifierKind: "command",
      runId: "r",
      callId: "c",
      ok: true,
      durationMs: 1,
      outputHash: "h",
      treeFingerprint: "t",
      filesTouched: [],
      capturedAt: "2026-10-14T12:00:00.000Z",
    });
    t.proof.recordEdit(t.fx.session, "a.ts", "2026-10-14T12:00:00.000Z");
    expect(t.proof.ledger(t.fx.session).criteria[0]).toMatchObject({
      status: "not_checked",
      stale: true,
      evidenceIds: [ev.evidenceId],
    });
    t.proof.recordEdit(t.fx.session, "a.ts", "2026-10-14T11:59:00.000Z");
    // an older edit never rewinds the newest one for that path
    expect(t.proof.ledger(t.fx.session).criteria[0]?.stale).toBe(true);
  });

  it("D7: a session without command criteria records no edits and announces nothing", async () => {
    const t = await open();
    await t.fx.play([write("src/a.ts"), write("b.ts", "edit_file")]);
    expect(t.fx.store.db.prepare("SELECT * FROM proof_edits").all()).toEqual([]);
    expect(t.updates()).toEqual([]);
    t.proof.addCriterion({ sessionId: t.fx.session, text: "m", origin: "user" });
    await t.fx.play([write("src/a.ts")]);
    expect(t.fx.store.db.prepare("SELECT * FROM proof_edits").all()).toEqual([]);
  });

  it("keeps one row per edited path (bounded growth) and cascades with the session", async () => {
    const t = await open();
    t.criterion();
    await t.fx.play([write("a.ts"), write("a.ts"), write("b.ts")]);
    expect(t.fx.store.db.prepare("SELECT path FROM proof_edits ORDER BY path").all()).toEqual([
      { path: "a.ts" },
      { path: "b.ts" },
    ]);
    const bare = t.fx.store.create(t.fx.root, "test", "m").id;
    t.proof.recordEdit(bare, "x.ts", "2026-10-14T10:00:00.000Z");
    t.fx.store.db.prepare("DELETE FROM sessions WHERE id=?").run(bare);
    expect(t.proof.edits(bare)).toEqual([]);
    expect(t.proof.edits(t.fx.session)).toHaveLength(2);
  });
});

describe("evidence carries the tree fingerprint and the files touched", () => {
  it("fills both from the session's edits; the fingerprint is a stable sha256", async () => {
    const t = await open();
    t.criterion();
    await mkdir(join(t.fx.root, "src"), { recursive: true });
    await writeFile(join(t.fx.root, "src", "a.ts"), "one");
    await t.fx.play([write("src/a.ts"), write("z.ts"), test]);
    const ev = t.proof.ledger(t.fx.session).evidence[0];
    expect(ev?.filesTouched).toEqual(["src/a.ts", "z.ts"]);
    expect(ev?.treeFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd,
    stdio: "pipe",
  });
const hasGit = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();
async function workdir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "alisio-tree-"));
  dirs.push(dir);
  return dir;
}

describe("treeFingerprint", () => {
  it("is deterministic, and independent of the order of the touched files", async () => {
    const dir = await workdir();
    await writeFile(join(dir, "a.txt"), "A");
    await writeFile(join(dir, "b.txt"), "B");
    const one = treeFingerprint(dir, ["a.txt", "b.txt"]);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(treeFingerprint(dir, ["a.txt", "b.txt"])).toBe(one);
    expect(treeFingerprint(dir, ["b.txt", "a.txt"])).toBe(one);
  });

  it("changes with the content of a touched file, and a missing file is a stable value", async () => {
    const dir = await workdir();
    await writeFile(join(dir, "a.txt"), "A");
    const before = treeFingerprint(dir, ["a.txt", "gone.txt"]);
    await writeFile(join(dir, "a.txt"), "A2");
    const after = treeFingerprint(dir, ["a.txt", "gone.txt"]);
    expect(after).not.toBe(before);
    expect(treeFingerprint(dir, ["a.txt", "gone.txt"])).toBe(after);
  });

  it("degrades outside a git repository: still a stable fingerprint, never a throw", async () => {
    const dir = await workdir();
    expect(treeFingerprint(dir, [])).toBe(treeFingerprint(dir, []));
    expect(treeFingerprint(join(dir, "does-not-exist"), ["a"])).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(!hasGit)(
    "includes the git diff: an untouched-file change moves the fingerprint",
    async () => {
      const dir = await workdir();
      git(dir, "init", "-q");
      await writeFile(join(dir, "tracked.txt"), "v1\n");
      git(dir, "add", ".");
      git(dir, "commit", "-q", "-m", "init");
      const clean = treeFingerprint(dir, []);
      expect(treeFingerprint(dir, [])).toBe(clean);
      await writeFile(join(dir, "tracked.txt"), "v2\n");
      const dirty = treeFingerprint(dir, []);
      expect(dirty).not.toBe(clean);
      expect(treeFingerprint(dir, [])).toBe(dirty);
      git(dir, "checkout", "--", "tracked.txt");
      expect(treeFingerprint(dir, [])).toBe(clean);
    },
  );

  it.skipIf(!hasGit)("is bounded: a huge diff is hashed without reading it all", async () => {
    const dir = await workdir();
    git(dir, "init", "-q");
    await writeFile(join(dir, "big.txt"), "x\n");
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "init");
    await writeFile(join(dir, "big.txt"), "line of text to inflate the diff\n".repeat(400_000));
    const started = Date.now();
    const first = treeFingerprint(dir, ["big.txt"]);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(treeFingerprint(dir, ["big.txt"])).toBe(first);
  });

  it("works from a repository with no commit yet", async () => {
    if (!hasGit) return;
    const dir = await workdir();
    git(dir, "init", "-q");
    await writeFile(join(dir, "a.txt"), "A");
    expect(treeFingerprint(dir, ["a.txt"])).toMatch(/^[0-9a-f]{64}$/);
  });
});
