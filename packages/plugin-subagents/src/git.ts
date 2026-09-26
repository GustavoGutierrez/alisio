/** Minimal git plumbing for worktree isolation (argument arrays, never a shell). */
import { execFile } from "node:child_process";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}
export function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...env },
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
export async function repoRoot(dir: string): Promise<string | undefined> {
  const r = await git(dir, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : undefined;
}
export async function isDirty(root: string): Promise<boolean> {
  const r = await git(root, ["status", "--porcelain"]);
  return r.code === 0 && r.stdout.trim().length > 0;
}
export async function head(root: string): Promise<string> {
  const r = await git(root, ["rev-parse", "HEAD"]);
  if (r.code) throw new Error(`git rev-parse HEAD failed: ${r.stderr.trim()}`);
  return r.stdout.trim();
}
export async function addWorktree(root: string, path: string, branch: string): Promise<string> {
  const base = await head(root);
  const r = await git(root, ["worktree", "add", "-b", branch, path, base]);
  if (r.code) throw new Error(`git worktree add failed: ${r.stderr.trim()}`);
  return base;
}
/** Identity used only when the repository has none configured. */
async function identity(cwd: string): Promise<NodeJS.ProcessEnv> {
  const email = await git(cwd, ["config", "user.email"]);
  return email.code === 0 && email.stdout.trim()
    ? {}
    : {
        GIT_AUTHOR_NAME: "Alisio",
        GIT_AUTHOR_EMAIL: "alisio@localhost",
        GIT_COMMITTER_NAME: "Alisio",
        GIT_COMMITTER_EMAIL: "alisio@localhost",
      };
}
/** Commits everything in a worktree; returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, ["add", "-A"]);
  const staged = await git(cwd, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return false;
  const r = await git(cwd, ["commit", "-q", "-m", message], await identity(cwd));
  if (r.code) throw new Error(`git commit failed: ${r.stderr.trim()}`);
  return true;
}
export async function diffSummary(
  root: string,
  base: string,
  branch: string,
): Promise<{ files: string[]; stat: string }> {
  const names = await git(root, ["diff", "--name-only", `${base}..${branch}`]);
  const stat = await git(root, ["diff", "--stat", `${base}..${branch}`]);
  return {
    files: names.stdout.split("\n").filter(Boolean),
    stat: stat.stdout.trim(),
  };
}
/** `git merge --no-ff`; on conflict the merge is aborted and conflicting files are reported. */
export async function merge(
  root: string,
  branch: string,
  message: string,
): Promise<{ ok: true } | { ok: false; conflicts: string[]; message: string }> {
  if (await isDirty(root))
    return {
      ok: false,
      conflicts: [],
      message: "Working tree has uncommitted changes; commit or stash them first.",
    };
  const r = await git(root, ["merge", "--no-ff", "-m", message, branch], await identity(root));
  if (r.code === 0) return { ok: true };
  const conflicts = (await git(root, ["diff", "--name-only", "--diff-filter=U"])).stdout
    .split("\n")
    .filter(Boolean);
  await git(root, ["merge", "--abort"]);
  return {
    ok: false,
    conflicts,
    message: (r.stdout + r.stderr).trim().split("\n").slice(-3).join(" "),
  };
}
export async function removeWorktree(
  root: string,
  path: string,
  branch: string,
  deleteBranch: boolean,
) {
  await git(root, ["worktree", "remove", "--force", path]);
  if (deleteBranch) await git(root, ["branch", "-D", branch]);
  await git(root, ["worktree", "prune"]);
}
