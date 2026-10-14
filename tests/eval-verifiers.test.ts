/** Deterministic verifiers of the reliability lab (specs/010 D4, Phase 1). Real temp dirs, no network. */
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EvalVerifier } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  runVerifier,
  runVerifiers,
  snapshotTree,
  type ToolEvent,
  type VerifierContext,
} from "../packages/core/src/eval/verifiers.ts";

let root: string;
let cwd: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "eval-verifiers-"));
  cwd = join(root, "work");
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(cwd, "src", "b.ts"), "export const b = 2;\n");
  writeFileSync(join(cwd, "README.md"), "hello\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const ctx = (extra: Partial<VerifierContext> = {}): VerifierContext => ({ cwd, ...extra });
const node = (script: string) => [process.execPath, "-e", script];

describe("file verifiers", () => {
  it("file-equals passes on a matching hash, fails on a different one", async () => {
    const ok: EvalVerifier = {
      kind: "file-equals",
      id: "eq",
      path: "README.md",
      sha256: sha("hello\n"),
    };
    expect((await runVerifier(ok, ctx())).status).toBe("pass");
    const bad = { ...ok, sha256: sha("other") };
    const result = await runVerifier(bad, ctx());
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/sha256/);
  });

  it("file-equals fails (not error) when the file is missing, errors when it cannot be read", async () => {
    const missing: EvalVerifier = {
      kind: "file-equals",
      id: "m",
      path: "nope.txt",
      sha256: sha(""),
    };
    expect((await runVerifier(missing, ctx())).status).toBe("fail");
    const dir: EvalVerifier = { kind: "file-equals", id: "d", path: "src", sha256: sha("") };
    expect((await runVerifier(dir, ctx())).status).toBe("error");
  });

  it("file-contains passes, fails on absent text and on a missing file", async () => {
    const v = (path: string, text: string): EvalVerifier => ({
      kind: "file-contains",
      id: "c",
      path,
      text,
    });
    expect((await runVerifier(v("src/a.ts", "const a"), ctx())).status).toBe("pass");
    expect((await runVerifier(v("src/a.ts", "const z"), ctx())).status).toBe("fail");
    expect((await runVerifier(v("src/none.ts", "x"), ctx())).status).toBe("fail");
  });

  it("file-absent passes when missing and fails when present", async () => {
    const v = (path: string): EvalVerifier => ({ kind: "file-absent", id: "ab", path });
    expect((await runVerifier(v("gone.txt"), ctx())).status).toBe("pass");
    expect((await runVerifier(v("README.md"), ctx())).status).toBe("fail");
  });

  it("a verifier path that escapes the working directory is an error, never a pass or fail", async () => {
    writeFileSync(join(root, "secret.txt"), "top");
    for (const path of ["../secret.txt", join(root, "secret.txt")]) {
      const result = await runVerifier(
        { kind: "file-contains", id: "x", path, text: "top" },
        ctx(),
      );
      expect(result.status).toBe("error");
      expect(result.detail).toMatch(/relative|\.\./);
    }
    // an absent-check must not report "pass" for a path it was not allowed to look at
    expect(
      (await runVerifier({ kind: "file-absent", id: "y", path: "../secret.txt" }, ctx())).status,
    ).toBe("error");
  });

  it("a symlink that points outside the working directory is an error", async () => {
    writeFileSync(join(root, "secret.txt"), "top");
    symlinkSync(join(root, "secret.txt"), join(cwd, "link.txt"));
    const result = await runVerifier(
      { kind: "file-contains", id: "x", path: "link.txt", text: "top" },
      ctx(),
    );
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/symlink/);
  });
});

describe("command verifier", () => {
  const cmd = (
    command: string[],
    extra: Partial<Extract<EvalVerifier, { kind: "command" }>> = {},
  ) => ({ kind: "command", id: "cmd", command, timeoutMs: 10_000, ...extra }) as EvalVerifier;

  it("passes on exit 0 (the default expectation) and fails on another exit code", async () => {
    expect((await runVerifier(cmd(node("process.exit(0)")), ctx())).status).toBe("pass");
    const failed = await runVerifier(cmd(node("process.exit(3)")), ctx());
    expect(failed.status).toBe("fail");
    expect(failed.detail).toMatch(/exit 3/);
  });

  it("honours expectExit and expectStdoutIncludes", async () => {
    expect((await runVerifier(cmd(node("process.exit(3)"), { expectExit: 3 }), ctx())).status).toBe(
      "pass",
    );
    const out = node("console.log('all green')");
    expect((await runVerifier(cmd(out, { expectStdoutIncludes: "all green" }), ctx())).status).toBe(
      "pass",
    );
    expect((await runVerifier(cmd(out, { expectStdoutIncludes: "red" }), ctx())).status).toBe(
      "fail",
    );
  });

  it("runs in the working directory", async () => {
    const v = cmd(node("process.exit(require('node:fs').existsSync('README.md') ? 0 : 1)"));
    expect((await runVerifier(v, ctx())).status).toBe("pass");
  });

  it("runs with a clean environment: secrets of the parent are not inherited", async () => {
    process.env.EVAL_TEST_SECRET = "s3cret";
    try {
      const v = cmd(node("process.exit(process.env.EVAL_TEST_SECRET === undefined ? 0 : 1)"));
      expect((await runVerifier(v, ctx())).status).toBe("pass");
    } finally {
      delete process.env.EVAL_TEST_SECRET;
    }
  });

  it("a command that cannot start is an error, not a fail", async () => {
    const result = await runVerifier(cmd(["definitely-not-a-real-binary-xyz"]), ctx());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/could not start/i);
  });

  it("a command that exceeds timeoutMs is killed and reported as a fail (the agent's check hung)", async () => {
    const started = Date.now();
    const result = await runVerifier(
      cmd(node("setTimeout(() => {}, 30000)"), { timeoutMs: 200 }),
      ctx(),
    );
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/timed out after 200 ms/);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("an empty command is an error", async () => {
    expect((await runVerifier(cmd([]), ctx())).status).toBe("error");
  });

  it("a missing working directory is an error", async () => {
    const result = await runVerifier(cmd(node("process.exit(0)")), { cwd: join(root, "missing") });
    expect(result.status).toBe("error");
  });
});

describe("command verifier hardening", () => {
  const cmd = (script: string, timeoutMs = 10_000) =>
    ({
      kind: "command",
      id: "cmd",
      command: [process.execPath, "-e", script],
      timeoutMs,
    }) as EvalVerifier;

  it("points HOME and TMPDIR at the run tmp dir when one is given, and leaves them unset otherwise", async () => {
    const tmp = join(root, "run-tmp");
    mkdirSync(tmp);
    const script =
      "process.exit(process.env.HOME === process.argv[1] && process.env.TMPDIR === process.argv[1] ? 0 : 7)";
    const verifier = {
      kind: "command",
      id: "env",
      command: [process.execPath, "-e", script, tmp],
      timeoutMs: 10_000,
    } as EvalVerifier;
    expect((await runVerifier(verifier, ctx({ tmpDir: tmp }))).status).toBe("pass");
    const unset = cmd(
      "process.exit(process.env.HOME === undefined && process.env.TMPDIR === undefined ? 0 : 9)",
    );
    expect((await runVerifier(unset, ctx())).status).toBe("pass");
  });

  it.skipIf(process.platform === "win32")(
    "kills the whole process group on timeout, grandchildren included",
    async () => {
      const pidFile = join(root, "grandchild.pid");
      const script = `const { spawn } = require("node:child_process");
        const c = spawn("sleep", ["30"], { stdio: "ignore" });
        require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
        setTimeout(() => {}, 30000);`;
      const result = await runVerifier(cmd(script, 700), ctx());
      expect(result.status).toBe("fail");
      const pid = Number(readFileSync(pidFile, "utf8"));
      await new Promise((resolve) => setTimeout(resolve, 200));
      const alive = (() => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      })();
      if (alive) process.kill(pid, "SIGKILL");
      expect(alive).toBe(false);
    },
  );
});

describe("tree-diff-within", () => {
  const within = (allowed: string[]): EvalVerifier => ({
    kind: "tree-diff-within",
    id: "tree",
    allowed,
  });

  it("passes when nothing changed, and when only allowed files changed", async () => {
    const baseline = snapshotTree(cwd);
    expect((await runVerifier(within(["src/a.ts"]), ctx({ baseline }))).status).toBe("pass");
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 99;\n");
    expect((await runVerifier(within(["src/a.ts"]), ctx({ baseline }))).status).toBe("pass");
  });

  it("detects a file modified outside the allowed list and names it", async () => {
    const baseline = snapshotTree(cwd);
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 99;\n");
    writeFileSync(join(cwd, "README.md"), "tampered\n");
    const result = await runVerifier(within(["src/a.ts"]), ctx({ baseline }));
    expect(result.status).toBe("fail");
    expect(result.detail).toContain("README.md");
    expect(result.detail).not.toContain("src/a.ts");
  });

  it("detects added and deleted files outside the allowed list", async () => {
    const baseline = snapshotTree(cwd);
    writeFileSync(join(cwd, "new.txt"), "x");
    unlinkSync(join(cwd, "src", "b.ts"));
    const result = await runVerifier(within(["src/a.ts"]), ctx({ baseline }));
    expect(result.status).toBe("fail");
    expect(result.detail).toMatch(/added.*new\.txt/s);
    expect(result.detail).toMatch(/deleted.*src\/b\.ts/s);
  });

  it("a trailing slash allows a whole directory", async () => {
    const baseline = snapshotTree(cwd);
    writeFileSync(join(cwd, "src", "a.ts"), "changed");
    writeFileSync(join(cwd, "src", "c.ts"), "new");
    expect((await runVerifier(within(["src/"]), ctx({ baseline }))).status).toBe("pass");
    // "src" without a slash is the file named src, not the directory
    expect((await runVerifier(within(["src"]), ctx({ baseline }))).status).toBe("fail");
  });

  it("ignores .git and node_modules", async () => {
    const baseline = snapshotTree(cwd);
    mkdirSync(join(cwd, ".git"));
    writeFileSync(join(cwd, ".git", "HEAD"), "ref");
    mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
    writeFileSync(join(cwd, "node_modules", "x", "i.js"), "1");
    expect((await runVerifier(within([]), ctx({ baseline }))).status).toBe("pass");
  });

  it("without a fixture snapshot the verifier cannot run: error", async () => {
    const result = await runVerifier(within(["src/a.ts"]), ctx());
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/snapshot/);
  });

  it("an allowed entry that escapes the working directory is an error", async () => {
    const baseline = snapshotTree(cwd);
    expect((await runVerifier(within(["../x"]), ctx({ baseline }))).status).toBe("error");
  });

  it("snapshots are content hashes: equal trees give equal hashes, any change moves it", () => {
    const first = snapshotTree(cwd);
    expect(snapshotTree(cwd).hash).toBe(first.hash);
    expect(first.files["src/a.ts"]).toBe(sha("export const a = 1;\n"));
    writeFileSync(join(cwd, "src", "a.ts"), "different");
    expect(snapshotTree(cwd).hash).not.toBe(first.hash);
  });
});

describe("tool-sequence", () => {
  const seq = (rule: Extract<EvalVerifier, { kind: "tool-sequence" }>["rule"]): EvalVerifier => ({
    kind: "tool-sequence",
    id: "seq",
    rule,
  });
  const ev = (tool: string, ok = true, argsKey?: string): ToolEvent => ({
    tool,
    ok,
    ...(argsKey === undefined ? {} : { argsKey }),
  });
  const run = (v: EvalVerifier, toolEvents?: ToolEvent[]) =>
    runVerifier(v, ctx(toolEvents ? { toolEvents } : {}));

  it("before: passes in order, fails when `then` comes first or `first` never happens", async () => {
    const rule = { type: "before", first: "read_file", then: "edit_file" } as const;
    expect((await run(seq(rule), [ev("read_file"), ev("edit_file")])).status).toBe("pass");
    expect((await run(seq(rule), [ev("edit_file"), ev("read_file")])).status).toBe("fail");
    expect((await run(seq(rule), [ev("edit_file")])).status).toBe("fail");
    expect((await run(seq(rule), [ev("grep")])).status).toBe("pass"); // `then` never happened
  });

  it("never: fails when the tool appears", async () => {
    const rule = { type: "never", tool: "shell" } as const;
    expect((await run(seq(rule), [ev("read_file")])).status).toBe("pass");
    expect((await run(seq(rule), [ev("read_file"), ev("shell")])).status).toBe("fail");
  });

  it("max-calls: allows up to max, fails above", async () => {
    const rule = { type: "max-calls", tool: "edit_file", max: 2 } as const;
    expect((await run(seq(rule), [ev("edit_file"), ev("edit_file")])).status).toBe("pass");
    const over = await run(seq(rule), [ev("edit_file"), ev("edit_file"), ev("edit_file")]);
    expect(over.status).toBe("fail");
    expect(over.detail).toMatch(/3.*2/);
  });

  it("no-repeat-failure: an identical call after it failed is a fail; a changed call is fine", async () => {
    const rule = { type: "no-repeat-failure", tool: "edit_file" } as const;
    expect(
      (await run(seq(rule), [ev("edit_file", false, "k1"), ev("edit_file", true, "k2")])).status,
    ).toBe("pass");
    expect(
      (await run(seq(rule), [ev("edit_file", false, "k1"), ev("edit_file", false, "k1")])).status,
    ).toBe("fail");
    expect(
      (await run(seq(rule), [ev("edit_file", true, "k1"), ev("edit_file", true, "k1")])).status,
    ).toBe("pass");
  });

  it("without the recorded events the verifier cannot run: error", async () => {
    const result = await run(seq({ type: "never", tool: "shell" }));
    expect(result.status).toBe("error");
    expect(result.detail).toMatch(/tool events/);
  });
});

describe("runVerifiers", () => {
  it("returns one result per verifier in order, keeping error apart from fail", async () => {
    const results = await runVerifiers(
      [
        { kind: "file-absent", id: "one", path: "README.md" },
        { kind: "file-absent", id: "two", path: "gone" },
        { kind: "tree-diff-within", id: "three", allowed: [] },
      ],
      ctx(),
    );
    expect(results.map((r) => [r.id, r.status])).toEqual([
      ["one", "fail"],
      ["two", "pass"],
      ["three", "error"],
    ]);
  });

  it("an unexpected exception inside a verifier becomes an error result", async () => {
    const result = await runVerifier({ kind: "mystery" } as unknown as EvalVerifier, ctx());
    expect(result.status).toBe("error");
  });
});
