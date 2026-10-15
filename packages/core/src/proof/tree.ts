/**
 * Tree fingerprint of a Proof evidence (specs/011 3.4, D5, section 7): a hash of a bounded
 * `git diff` plus the sha256 of the files the session touched. It is an audit anchor stored with
 * the evidence, not the expiry mechanism (expiry reads the recorded edit times). Deterministic for
 * a given tree, bounded in cost, and safe outside git: no repository or no `git` binary just
 * means the diff part is a constant.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

/** Bytes of `git diff` that are read; the rest of a larger diff is not hashed. */
export const MAX_DIFF_BYTES = 1_048_576;
/** Files larger than this are fingerprinted by size only. */
const MAX_FILE_BYTES = 1_048_576;
/** Touched files that enter the fingerprint (sorted, so the cut is deterministic). */
export const MAX_FINGERPRINT_FILES = 200;
const GIT_TIMEOUT_MS = 3_000;
const HASH_CACHE_MAX = 512;

const sha256 = (data: string | Uint8Array): string =>
  createHash("sha256").update(data).digest("hex");

/** File hashes by `path|size|mtime`: an unchanged file is never read twice. */
const fileHashes = new Map<string, string>();

function fileDigest(workspace: string, path: string): string {
  const absolute = resolve(workspace, path);
  const rel = relative(workspace, absolute);
  if (rel.startsWith("..") || isAbsolute(rel)) return "outside";
  try {
    const info = statSync(absolute);
    if (!info.isFile()) return "missing";
    if (info.size > MAX_FILE_BYTES) return `large:${info.size}`;
    const key = `${absolute}\u0000${info.size}\u0000${info.mtimeMs}`;
    const known = fileHashes.get(key);
    if (known !== undefined) return known;
    const digest = sha256(readFileSync(absolute));
    if (fileHashes.size >= HASH_CACHE_MAX) fileHashes.clear();
    fileHashes.set(key, digest);
    return digest;
  } catch {
    return "missing";
  }
}

/** Digest of the working-tree diff against HEAD, or a constant when git cannot answer. */
function diffDigest(workspace: string): string {
  const run = (args: string[]) =>
    spawnSync("git", ["--no-pager", ...args], {
      cwd: workspace,
      maxBuffer: MAX_DIFF_BYTES,
      timeout: GIT_TIMEOUT_MS,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
  const flags = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];
  let result = run(["diff", ...flags, "HEAD", "--"]);
  // A repository with no commit has no HEAD: fall back to the index.
  if (
    result.status !== 0 &&
    /bad revision|unknown revision|ambiguous argument/.test(String(result.stderr))
  )
    result = run(["diff", ...flags, "--"]);
  const out = result.stdout;
  const overflow = result.error !== undefined && Buffer.isBuffer(out) && out.length > 0;
  if (!overflow && (result.error || result.status !== 0 || !Buffer.isBuffer(out))) return "nogit";
  const bytes = (out as Buffer).subarray(0, MAX_DIFF_BYTES);
  return `${overflow ? "truncated:" : "full:"}${sha256(bytes)}`;
}

/** The fingerprint of the tree at `workspace` given the files the session touched. */
export function treeFingerprint(workspace: string, filesTouched: readonly string[]): string {
  const files = [...new Set(filesTouched)].sort().slice(0, MAX_FINGERPRINT_FILES);
  return sha256(
    JSON.stringify({
      v: 1,
      diff: diffDigest(workspace),
      files: files.map((file) => [file, fileDigest(workspace, file)]),
    }),
  );
}
