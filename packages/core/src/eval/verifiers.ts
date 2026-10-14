/**
 * Deterministic, local verifiers of the reliability lab (specs/010 D4). A verifier answers
 * `pass`, `fail` or `error`; `error` means it could not run (bad path, missing input, command that
 * cannot start) and is never folded into `fail`. Details never echo file contents.
 *
 * `command` runs a subprocess with a clean environment and a timeout. A subprocess is NOT a
 * sandbox: suites are trusted repository code and the command runs with the user's privileges.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import type { EvalVerifier, ToolSequenceRule } from "@alisio/sdk";
import { EvalPathError, resolveInside, unsafeRelativeReason } from "./paths.ts";

export type VerifierStatus = "pass" | "fail" | "error";
export interface VerifierResult {
  id: string;
  status: VerifierStatus;
  detail?: string;
}

/** One tool call observed in a run, as the `tool-sequence` verifier needs it. */
export interface ToolEvent {
  tool: string;
  ok: boolean;
  /** Canonical key of the call arguments; two calls with the same key are "identical". */
  argsKey?: string;
}

/** Content hashes of a tree (relative POSIX path -> sha256) plus one hash of the whole. */
export interface TreeSnapshot {
  files: Record<string, string>;
  hash: string;
}

export interface VerifierContext {
  /** Working directory of the run; every verifier path is confined to it. */
  cwd: string;
  /** Snapshot of the fixture before the run; required by `tree-diff-within`. */
  baseline?: TreeSnapshot;
  /** Tool calls of the run in order; required by `tool-sequence`. */
  toolEvents?: ToolEvent[];
  /**
   * Run-private temporary directory. When set, `command` verifiers get HOME and TMPDIR pointing at
   * it so tooling caches and temp files stay inside the run; unset keeps the minimal environment.
   */
  tmpDir?: string;
}

const IGNORED_DIRS = new Set([".git", "node_modules"]);
const MAX_COMMAND_OUTPUT = 1_000_000;
const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

/**
 * Hashes every file under `dir` (symlinks by their target text, never followed). `.git` and
 * `node_modules` are skipped at any depth: they are tooling state, not task output.
 */
export function snapshotTree(dir: string): TreeSnapshot {
  const files: Record<string, string> = {};
  const walk = (current: string, prefix: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = join(current, entry.name);
      if (entry.isSymbolicLink()) files[rel] = sha256(`symlink:${readlinkSync(full)}`);
      else if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) walk(full, rel);
      } else if (entry.isFile()) files[rel] = sha256(readFileSync(full));
    }
  };
  walk(dir, "");
  const hash = sha256(
    Object.keys(files)
      .sort()
      .map((path) => `${path}\0${files[path]}`)
      .join("\n"),
  );
  return { files, hash };
}

const result = (v: { id: string }, status: VerifierStatus, detail?: string): VerifierResult => ({
  id: v.id,
  status,
  ...(detail === undefined ? {} : { detail }),
});

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function runCommand(v: Extract<EvalVerifier, { kind: "command" }>, cwd: string, tmpDir?: string) {
  return new Promise<VerifierResult>((resolve) => {
    const [bin, ...args] = v.command;
    if (bin === undefined) return resolve(result(v, "error", "command is empty."));
    if (!existsSync(cwd) || !statSync(cwd).isDirectory())
      return resolve(result(v, "error", "working directory does not exist."));
    const env: Record<string, string> = { PATH: process.env.PATH ?? "", NODE_NO_WARNINGS: "1" };
    if (process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
    if (tmpDir) {
      env.HOME = tmpDir;
      env.TMPDIR = tmpDir;
    }
    let stdout = "";
    let timedOut = false;
    let settled = false;
    const done = (value: VerifierResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // The child leads its own process group (POSIX) so a timeout can stop grandchildren too.
    const detached = process.platform !== "win32";
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "ignore"],
      shell: false,
      detached,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (detached && child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, v.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_COMMAND_OUTPUT) stdout += chunk.toString("utf8");
    });
    child.on("error", (error) =>
      done(result(v, "error", `command could not start: ${(error as Error).message}`)),
    );
    child.on("close", (code, signal) => {
      // The command is the task's own check running agent-written code: a hang is the agent's
      // failure, not an infrastructure error (a command that cannot start stays `error`).
      if (timedOut) return done(result(v, "fail", `command timed out after ${v.timeoutMs} ms.`));
      const expected = v.expectExit ?? 0;
      if (code !== expected)
        return done(
          result(
            v,
            "fail",
            signal ? `terminated by ${signal}.` : `exit ${code}, expected exit ${expected}.`,
          ),
        );
      if (v.expectStdoutIncludes !== undefined && !stdout.includes(v.expectStdoutIncludes))
        return done(result(v, "fail", "stdout does not include the expected text."));
      done(result(v, "pass"));
    });
  });
}

function readTarget(path: string): { data: Buffer } | { missing: true } {
  try {
    return { data: readFileSync(path) };
  } catch (error) {
    if (isMissing(error)) return { missing: true };
    throw error;
  }
}

function diffTree(baseline: TreeSnapshot, current: TreeSnapshot) {
  const added: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  for (const [path, hash] of Object.entries(current.files)) {
    const before = baseline.files[path];
    if (before === undefined) added.push(path);
    else if (before !== hash) modified.push(path);
  }
  for (const path of Object.keys(baseline.files)) if (!(path in current.files)) deleted.push(path);
  return { added, deleted, modified };
}

/** `a/b.ts` allows exactly that file; `a/` allows everything below the directory `a`. */
const isAllowed = (path: string, allowed: string[]) =>
  allowed.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));

function checkSequence(
  rule: ToolSequenceRule,
  events: ToolEvent[],
): { ok: boolean; detail?: string } {
  switch (rule.type) {
    case "before": {
      const firstAt = events.findIndex((e) => e.tool === rule.first);
      const thenAt = events.findIndex((e) => e.tool === rule.then);
      if (thenAt === -1) return { ok: true };
      return firstAt !== -1 && firstAt < thenAt
        ? { ok: true }
        : { ok: false, detail: `"${rule.then}" was called without a prior "${rule.first}".` };
    }
    case "never":
      return events.some((e) => e.tool === rule.tool)
        ? { ok: false, detail: `"${rule.tool}" must never be called.` }
        : { ok: true };
    case "max-calls": {
      const calls = events.filter((e) => e.tool === rule.tool).length;
      return calls > rule.max
        ? { ok: false, detail: `"${rule.tool}" was called ${calls} times, maximum ${rule.max}.` }
        : { ok: true };
    }
    case "no-repeat-failure": {
      const failed = new Set<string>();
      for (const e of events) {
        if (e.tool !== rule.tool) continue;
        const key = e.argsKey ?? "";
        if (failed.has(key))
          return {
            ok: false,
            detail: `"${rule.tool}" repeated an identical call that had failed.`,
          };
        if (!e.ok) failed.add(key);
      }
      return { ok: true };
    }
  }
}

async function evaluate(v: EvalVerifier, ctx: VerifierContext): Promise<VerifierResult> {
  switch (v.kind) {
    case "command":
      return runCommand(v, ctx.cwd, ctx.tmpDir);
    case "file-equals": {
      const target = readTarget(resolveInside(ctx.cwd, v.path, "path"));
      if ("missing" in target) return result(v, "fail", `${v.path} does not exist.`);
      return sha256(target.data) === v.sha256.toLowerCase()
        ? result(v, "pass")
        : result(v, "fail", `${v.path} sha256 differs from the expected value.`);
    }
    case "file-contains": {
      const target = readTarget(resolveInside(ctx.cwd, v.path, "path"));
      if ("missing" in target) return result(v, "fail", `${v.path} does not exist.`);
      return target.data.toString("utf8").includes(v.text)
        ? result(v, "pass")
        : result(v, "fail", `${v.path} does not contain the expected text.`);
    }
    case "file-absent": {
      const absolute = resolveInside(ctx.cwd, v.path, "path");
      try {
        lstatSync(absolute);
      } catch (error) {
        if (isMissing(error)) return result(v, "pass");
        throw error;
      }
      return result(v, "fail", `${v.path} exists.`);
    }
    case "tree-diff-within": {
      if (!ctx.baseline)
        return result(v, "error", "no fixture snapshot was provided to compare against.");
      for (const entry of v.allowed) {
        const reason = unsafeRelativeReason(entry);
        if (reason) return result(v, "error", `allowed entry "${entry}" ${reason}.`);
      }
      const { added, deleted, modified } = diffTree(ctx.baseline, snapshotTree(ctx.cwd));
      const outside = (paths: string[]) => paths.filter((p) => !isAllowed(p, v.allowed)).sort();
      const parts = (
        [
          ["modified", outside(modified)],
          ["added", outside(added)],
          ["deleted", outside(deleted)],
        ] as const
      )
        .filter(([, paths]) => paths.length > 0)
        .map(([label, paths]) => `${label}: ${paths.join(", ")}`);
      return parts.length === 0
        ? result(v, "pass")
        : result(v, "fail", `changes outside the allowed list (${parts.join("; ")}).`);
    }
    case "tool-sequence": {
      if (!ctx.toolEvents) return result(v, "error", "no tool events were recorded for this run.");
      const checked = checkSequence(v.rule, ctx.toolEvents);
      return checked.ok ? result(v, "pass") : result(v, "fail", checked.detail);
    }
    default:
      return result(
        v as { id: string },
        "error",
        `unknown verifier kind "${(v as { kind?: string }).kind}".`,
      );
  }
}

/** Runs one verifier; anything that prevents a verdict (including exceptions) is `error`. */
export async function runVerifier(v: EvalVerifier, ctx: VerifierContext): Promise<VerifierResult> {
  try {
    return await evaluate(v, ctx);
  } catch (error) {
    const detail =
      error instanceof EvalPathError
        ? error.message
        : `verifier could not run: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
    return result(v, "error", detail);
  }
}

/** Runs the verifiers in order (sequentially: `command` verifiers may share the working directory). */
export async function runVerifiers(
  verifiers: EvalVerifier[],
  ctx: VerifierContext,
): Promise<VerifierResult[]> {
  const results: VerifierResult[] = [];
  for (const v of verifiers) results.push(await runVerifier(v, ctx));
  return results;
}
