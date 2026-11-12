/**
 * The write side of `tarball.ts`: a deterministic gzip + ustar writer for plugin packages, with no
 * external `tar`. Entries live under `package/` (what `npm pack` produces), are sorted by path, use
 * fixed modes (0644 files, no directory entries), a fixed owner and a fixed mtime, so the same
 * input always yields the same bytes. Paths that are absolute, contain `..`, backslashes or a drive
 * letter are refused, and the archive stays inside the reader's limits.
 *
 * `packDirectory` selects the files the way npm does for a package with a `files` list
 * (`package.json`, README, LICENSE and the listed paths) and refuses symbolic links.
 */
import { lstat, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { gzipSync } from "node:zlib";
import { MAX_EXPANDED_BYTES, MAX_TARBALL_BYTES, MAX_TARBALL_ENTRIES } from "./tarball.ts";

export class TarballWriteError extends Error {}

export interface TarballWriteEntry {
  /** Path inside the package (no `package/` prefix), `/`-separated. */
  path: string;
  data: Buffer;
}

export interface TarballWriteLimits {
  /** Cap of the compressed archive (default: the reader's 50 MB). */
  maxBytes?: number;
  maxEntries?: number;
  /** Cap of the uncompressed content. */
  maxExpandedBytes?: number;
}

/** npm's fixed timestamp for packed files (1985-10-26T08:15:00Z). */
const FIXED_MTIME = 499_162_500;

function safeEntryPath(raw: string): string {
  const path = raw.trim();
  if (
    !path ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    /^[A-Za-z]:/.test(path) ||
    path.split("/").some((part) => part === ".." || part === "." || part === "")
  )
    throw new TarballWriteError(`Unsafe path in the package: ${raw.slice(0, 80)}`);
  return path;
}

const octal = (value: number, width: number): string =>
  `${value.toString(8).padStart(width - 1, "0")}\0`;

/** Splits `name` into ustar `prefix` (<= 155 bytes) and `name` (<= 100 bytes) fields. */
function splitName(full: string): { name: string; prefix: string } {
  if (Buffer.byteLength(full) <= 100) return { name: full, prefix: "" };
  const parts = full.split("/");
  for (let i = 1; i < parts.length; i++) {
    const prefix = parts.slice(0, i).join("/");
    const name = parts.slice(i).join("/");
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  throw new TarballWriteError(`Path too long for the package: ${full.slice(0, 80)}`);
}

function header(path: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  const { name, prefix } = splitName(path);
  block.write(name, 0, "utf8");
  block.write(octal(0o644, 8), 100);
  block.write(octal(0, 8), 108);
  block.write(octal(0, 8), 116);
  block.write(octal(size, 12), 124);
  block.write(octal(FIXED_MTIME, 12), 136);
  block.write("        ", 148);
  block.write("0", 156);
  block.write("ustar\0", 257);
  block.write("00", 263);
  block.write(prefix, 345, "utf8");
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

/** The gzip ustar bytes of `entries` (sorted, deterministic). Throws `TarballWriteError`. */
export function tarGzBuffer(entries: TarballWriteEntry[], limits: TarballWriteLimits = {}): Buffer {
  const maxEntries = limits.maxEntries ?? MAX_TARBALL_ENTRIES;
  const maxExpanded = limits.maxExpandedBytes ?? MAX_EXPANDED_BYTES;
  const maxBytes = limits.maxBytes ?? MAX_TARBALL_BYTES;
  if (entries.length > maxEntries)
    throw new TarballWriteError(`The package has too many files (limit ${maxEntries})`);
  const sorted = entries
    .map((entry) => ({ path: safeEntryPath(entry.path), data: entry.data }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const parts: Buffer[] = [];
  let expanded = 0;
  for (let i = 0; i < sorted.length; i++) {
    const entry = sorted[i] as TarballWriteEntry;
    if (i > 0 && sorted[i - 1]?.path === entry.path)
      throw new TarballWriteError(`Duplicate path in the package: ${entry.path.slice(0, 80)}`);
    expanded += entry.data.length + 512;
    if (expanded > maxExpanded) throw new TarballWriteError("The package is too large");
    parts.push(header(`package/${entry.path}`, entry.data.length), entry.data);
    const pad = (512 - (entry.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad));
  }
  parts.push(Buffer.alloc(1024));
  // A fixed gzip header (no name, mtime 0) keeps the output byte-identical across runs.
  const out = gzipSync(Buffer.concat(parts), { level: 9 });
  if (out.length > maxBytes) throw new TarballWriteError("The package is too large");
  return out;
}

/** Writes the archive atomically (temp file + rename, mode 0600). */
export async function writeTarGz(
  file: string,
  entries: TarballWriteEntry[],
  limits: TarballWriteLimits = {},
): Promise<{ bytes: number }> {
  const bytes = tarGzBuffer(entries, limits);
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(temp, bytes, { mode: 0o600 });
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { bytes: bytes.length };
}

export interface PackDirectoryResult {
  /** Packed paths relative to the package root, sorted. */
  files: string[];
  /** Uncompressed bytes of the packed files. */
  bytes: number;
  /** Size of the written `.tgz`. */
  tarballBytes: number;
}

const ALWAYS = /^(readme|license|licence)(\.[a-z0-9]+)?$/i;

async function collect(root: string, rel: string, out: string[], budget: { left: number }) {
  const abs = join(root, rel);
  const stats = await lstat(abs);
  if (stats.isSymbolicLink())
    throw new TarballWriteError(`The package contains a symbolic link: ${rel}`);
  if (stats.isFile()) {
    if (--budget.left < 0) throw new TarballWriteError("The package has too many files");
    out.push(rel.split(sep).join("/"));
    return;
  }
  if (!stats.isDirectory()) return;
  for (const entry of (await readdir(abs)).sort()) {
    if (entry.startsWith(".") || entry === "node_modules") continue;
    await collect(root, join(rel, entry), out, budget);
  }
}

/**
 * Packs a package directory into `out`: `package.json`, any README or LICENSE file at the root and every
 * path of its `files` list (default `["src"]`), skipping dotfiles and `node_modules`.
 */
export async function packDirectory(
  dir: string,
  out: string,
  limits: TarballWriteLimits = {},
): Promise<PackDirectoryResult> {
  let manifest: { files?: unknown };
  try {
    manifest = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  } catch {
    throw new TarballWriteError("package.json is missing or is not valid JSON");
  }
  const listed = Array.isArray(manifest.files)
    ? manifest.files.filter((f): f is string => typeof f === "string")
    : ["src"];
  const budget = { left: limits.maxEntries ?? MAX_TARBALL_ENTRIES };
  const files: string[] = ["package.json"];
  for (const entry of (await readdir(dir)).sort())
    if (ALWAYS.test(entry) && (await lstat(join(dir, entry))).isFile()) files.push(entry);
  for (const raw of listed) {
    const rel = safeEntryPath(raw.replace(/^\.\//, "").replace(/\/+$/, ""));
    const abs = join(dir, rel);
    if (relative(dir, abs).startsWith("..")) throw new TarballWriteError(`Unsafe path: ${raw}`);
    const present = await lstat(abs).then(
      () => true,
      () => false,
    );
    if (present) await collect(dir, rel, files, budget);
  }
  const unique = [...new Set(files)].sort();
  const entries: TarballWriteEntry[] = [];
  let bytes = 0;
  for (const rel of unique) {
    const data = await readFile(join(dir, rel));
    bytes += data.length;
    entries.push({ path: rel, data });
  }
  const written = await writeTarGz(out, entries, limits);
  return { files: unique, bytes, tarballBytes: written.bytes };
}
