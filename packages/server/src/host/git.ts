/**
 * Read-only git queries for the file routes (tree filtering, change marks, diffs). `spawn`
 * without a shell, a 2 s timeout, bounded output, and options that keep git from running
 * repository-configured programs (no fsmonitor, no external diff or textconv) or taking locks.
 */
import { spawn } from "node:child_process";
import { relative, resolve, sep } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
}

const BASE = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "--no-optional-locks"];

/** Runs git in `cwd`; resolves with code -1 when git is missing, times out or overflows. */
export function runGit(
  cwd: string,
  args: string[],
  /** `literal`: pathspecs are plain paths (no globs or magic); unsupported by check-ignore. */
  options: { input?: string; timeoutMs?: number; maxBytes?: number; literal?: boolean } = {},
): Promise<GitResult> {
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  return new Promise((done) => {
    let settled = false;
    const finish = (result: GitResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done(result);
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(
        "git",
        [...BASE, ...(options.literal ? ["--literal-pathspecs"] : []), ...args],
        {
          cwd,
          stdio: ["pipe", "pipe", "ignore"],
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
        },
      );
    } catch {
      finish({ code: -1, stdout: "" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: -1, stdout: "" });
    }, options.timeoutMs ?? 2_000);
    const chunks: Buffer[] = [];
    let size = 0;
    child.stdout?.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        child.kill("SIGKILL");
        finish({ code: -1, stdout: "" });
        return;
      }
      chunks.push(chunk);
    });
    child.on("error", () => finish({ code: -1, stdout: "" }));
    child.on("close", (code) =>
      finish({ code: code ?? -1, stdout: Buffer.concat(chunks).toString("utf8") }),
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.input ?? "");
  });
}

/** Top-level directory of the repository containing `cwd`, or undefined outside git. */
export async function gitRoot(cwd: string): Promise<string | undefined> {
  const r = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : undefined;
}

const toPosix = (path: string) => path.split(sep).join("/");

/**
 * `git status --porcelain=v1 -z` of the repository as `workspace-relative path → code` (`M`,
 * `A`, `D`, `R`, `??`…). Paths outside `workspace` (sibling directories of a monorepo) are left out.
 */
export async function gitStatus(workspace: string, top: string): Promise<Map<string, string>> {
  const marks = new Map<string, string>();
  const r = await runGit(workspace, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (r.code !== 0) return marks;
  const fields = r.stdout.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] as string;
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const path = field.slice(3);
    if (xy[0] === "R" || xy[0] === "C") i++; // the next field is the original path
    const code = xy === "??" ? "??" : ((xy[0] !== " " ? xy[0] : xy[1]) ?? "M");
    const rel = relative(workspace, resolve(top, path));
    if (rel.startsWith("..")) continue;
    marks.set(toPosix(rel), code);
  }
  return marks;
}

/** The subset of workspace-relative `paths` (directories end in `/`) that git ignores. */
export async function gitIgnored(workspace: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const r = await runGit(workspace, ["check-ignore", "-z", "--stdin"], {
    input: `${paths.join("\0")}\0`,
  });
  // 0: some ignored, 1: none, anything else: not a repository or an error (show everything).
  if (r.code !== 0) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}
