/**
 * Published artifacts: staging → scan → validate → classify → copy → manifest → row. A tool never
 * publishes a folder in place: files are COPIED into `<root>/artifacts/<workspaceKey>/<root
 * session>/<slug>--<id>/files/`, next to a public `manifest.json` without absolute paths or code.
 * Publishing several outputs is all-or-nothing: on any rejection no folder and no row remains.
 */
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ArtifactKind, ArtifactPublishInput, ArtifactRef, SqlDatabase } from "@alisio/sdk";
import { newId } from "../runtime/ids.ts";
import { inside, workspaceKey } from "../runtime/paths.ts";
import { writeZip } from "../runtime/zip.ts";
import { chartWarnings } from "./chart-lint.ts";
import { classifyArtifact, isPreviewable } from "./kinds.ts";

export interface ArtifactLimits {
  maxFiles: number;
  maxFileBytes: number;
  /** Total bytes of one publication (one execution). */
  maxOutputBytes: number;
}
export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = {
  maxFiles: 200,
  maxFileBytes: 100 * 1024 * 1024,
  maxOutputBytes: 500 * 1024 * 1024,
};

/** Who publishes: the session (and its root), the call that produced the files, provenance. */
export interface ArtifactOwner {
  sessionId: string;
  rootSessionId: string;
  workspace: string;
  runId?: string;
  callId?: string;
  executionId?: string;
  partial?: boolean;
  /** Extra public provenance (runtime, script hash, inputs, model, provider). No paths. */
  provenance?: Record<string, unknown>;
}

export interface PublishedArtifact {
  artifact: ArtifactRef;
  /** Absolute path of the file, or of the entry of a multi-file artifact. */
  path: string;
  /** Non-fatal notes (e.g. a dashboard reference to a missing file). */
  warnings: string[];
}

export interface ArtifactFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface ArtifactRecord extends ArtifactRef {
  entry?: string;
  executionId?: string;
  runId?: string;
  callId?: string;
  provenance: Record<string, unknown>;
  /** Folder relative to the store root. */
  relDir: string;
}

/** A rejected publication: the message is user-readable and names the offending path. */
export class ArtifactRejected extends Error {}

interface Candidate {
  /** Absolute source file or directory. */
  source: string;
  /** Path relative to the staging folder (idempotency key), when published from one. */
  sourceRel?: string;
  title?: string;
  entry?: string;
  /** Download name of a multi-file folder with an entry (default: `<folder>.zip`). */
  fileName?: string;
}

interface ScannedFile {
  rel: string;
  abs: string;
  bytes: number;
}

interface Planned {
  candidate: Candidate;
  files: ScannedFile[];
  directory: boolean;
  /** Entry of a directory (dashboards), relative to its root. */
  entry?: string;
}

const MAX_DEPTH = 8;
/** HTML larger than this is not scanned for chart mistakes. */
const MAX_LINT_BYTES = 8 * 1024 * 1024;
const HEAD_BYTES = 8192;

/** `title` → `[a-z0-9-]`, at most 48 characters (`artifact` when nothing remains). */
export function slugify(title: string): string {
  const slug = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/, "");
  return slug || "artifact";
}

/** Validates one relative path component list; returns the NFC-normalized relative path. */
function checkName(rel: string): string {
  const parts = rel.split(/[\\/]/);
  if (parts.length > MAX_DEPTH)
    throw new ArtifactRejected(`${rel}: nested deeper than ${MAX_DEPTH} levels`);
  for (const part of parts) {
    if (!part || part === "." || part === "..")
      throw new ArtifactRejected(`${rel}: relative path components are not allowed`);
    if (part.startsWith(".") && part !== ".nojekyll")
      throw new ArtifactRejected(`${rel}: hidden files are not published`);
    if (/[\u0000-\u001f\u007f]/.test(part))
      throw new ArtifactRejected(`${rel}: control characters in file names`);
  }
  return parts.map((part) => part.normalize("NFC")).join("/");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** The first bytes of a file (the sample `classifyArtifact` needs). */
export async function readHead(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEAD_BYTES, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** Relative `src`/`href` references of an HTML page that point to files not in the set. */
function missingReferences(html: string, entryDir: string, present: Set<string>): string[] {
  const missing = new Set<string>();
  for (const match of html.matchAll(/\b(?:src|href)\s*=\s*["']([^"'#?]+)/gi)) {
    const ref = match[1]?.trim() ?? "";
    if (!ref || /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("/") || ref.startsWith("//"))
      continue;
    const joined = join(entryDir, decodeURIComponentSafe(ref)).split(sep).join("/");
    if (!present.has(joined)) missing.add(ref);
  }
  return [...missing];
}
const decodeURIComponentSafe = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const row = (r: Record<string, unknown>): ArtifactRecord => {
  const provenance = JSON.parse(String(r.provenance ?? "{}")) as Record<string, unknown>;
  return {
    id: String(r.id),
    sessionId: String(r.root_session),
    title: String(r.title),
    fileName: String(r.file_name),
    kind: String(r.kind) as ArtifactKind,
    mimeType: String(r.mime),
    bytes: Number(r.bytes),
    fileCount: Number(r.file_count),
    previewable: !!provenance.previewable,
    createdAt: Number(r.created_at),
    ...(provenance.partial ? { partial: true } : {}),
    status: String(r.status) as ArtifactRef["status"],
    ...(r.entry != null ? { entry: String(r.entry) } : {}),
    ...(r.execution_id != null ? { executionId: String(r.execution_id) } : {}),
    ...(r.run_id != null ? { runId: String(r.run_id) } : {}),
    ...(r.call_id != null ? { callId: String(r.call_id) } : {}),
    provenance,
    relDir: String(r.rel_dir),
  };
};

/** The public part of a record (what the SDK `ArtifactRef` carries). */
export const toRef = (record: ArtifactRecord): ArtifactRef => ({
  id: record.id,
  sessionId: record.sessionId,
  title: record.title,
  fileName: record.fileName,
  kind: record.kind,
  mimeType: record.mimeType,
  bytes: record.bytes,
  fileCount: record.fileCount,
  previewable: record.previewable,
  createdAt: record.createdAt,
  ...(record.partial ? { partial: true } : {}),
  status: record.status,
});

export class ArtifactStore {
  readonly limits: ArtifactLimits;
  private readonly now: () => number;

  constructor(
    private options: {
      /** State root (`stateHome()` or the folder of `--db`); artifacts live under `artifacts/`. */
      root: string;
      db: SqlDatabase;
      limits?: Partial<ArtifactLimits>;
      now?: () => number;
    },
  ) {
    this.limits = { ...DEFAULT_ARTIFACT_LIMITS, ...options.limits };
    this.now = options.now ?? Date.now;
  }

  get root(): string {
    return this.options.root;
  }

  /** Session folder of an owner (artifacts of child sessions live with their root). */
  private sessionDir(owner: ArtifactOwner): string {
    return join(this.options.root, "artifacts", workspaceKey(owner.workspace), owner.rootSessionId);
  }

  /**
   * Publishes the outputs a script left in `staging`: the entries of `staging/outputs.json`, or
   * else every top-level file (and every top-level folder; with `index.html` a multi-file
   * dashboard, otherwise one ZIP archive). Everything or nothing is published.
   */
  async publishOutputs(
    staging: string,
    owner: ArtifactOwner,
    defaults: { title?: string } = {},
  ): Promise<PublishedArtifact[]> {
    const candidates: Candidate[] = [];
    const declared = join(staging, "outputs.json");
    let manifest: unknown;
    try {
      manifest = JSON.parse(await readFile(declared, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new ArtifactRejected(
          `outputs.json is not valid JSON: ${error instanceof Error ? error.message : error}`,
        );
    }
    if (manifest !== undefined) {
      const list = (manifest as { artifacts?: unknown }).artifacts;
      if (!Array.isArray(list))
        throw new ArtifactRejected('outputs.json must be { "artifacts": [{ "path": … }] }');
      for (const item of list) {
        const entry = item as { path?: unknown; title?: unknown; entry?: unknown };
        if (typeof entry.path !== "string" || !entry.path)
          throw new ArtifactRejected("outputs.json: every artifact needs a relative path");
        const rel = checkName(entry.path.replace(/\\/g, "/"));
        if (rel === "outputs.json")
          throw new ArtifactRejected("outputs.json cannot publish itself");
        candidates.push({
          source: resolve(staging, rel),
          sourceRel: rel,
          ...(typeof entry.title === "string" && entry.title.trim()
            ? { title: entry.title.trim() }
            : {}),
          ...(typeof entry.entry === "string" ? { entry: entry.entry } : {}),
        });
      }
    } else {
      for (const name of (await readdir(staging)).sort()) {
        if (name === "outputs.json") continue;
        candidates.push({ source: join(staging, name), sourceRel: name });
      }
    }
    if (candidates.length === 1 && defaults.title && candidates[0] && !candidates[0].title)
      candidates[0].title = defaults.title;
    for (const candidate of candidates)
      if (!inside(staging, candidate.source))
        throw new ArtifactRejected(`${candidate.sourceRel}: outside the output folder`);
    return this.publishAll(candidates, owner);
  }

  /** Publishes one caller-owned file or directory. */
  async publish(
    input: ArtifactPublishInput & { fileName?: string },
    owner: ArtifactOwner,
  ): Promise<PublishedArtifact> {
    const [published] = await this.publishAll(
      [
        {
          source: resolve(input.source),
          ...(input.title ? { title: input.title } : {}),
          ...(input.entry ? { entry: input.entry } : {}),
          ...(input.fileName ? { fileName: checkName(input.fileName) } : {}),
        },
      ],
      owner,
    );
    return published as PublishedArtifact;
  }

  /** Publishes a single text file the caller holds in memory. */
  async publishText(
    input: { fileName: string; title?: string; text: string },
    owner: ArtifactOwner,
  ): Promise<PublishedArtifact> {
    const name = checkName(basename(input.fileName.replace(/\\/g, "/")));
    const scratch = join(this.options.root, "artifacts", ".incoming", newId("txt"));
    await mkdir(scratch, { recursive: true });
    try {
      const file = join(scratch, name);
      await writeFile(file, input.text, { flag: "wx" });
      return await this.publish(
        { source: file, ...(input.title ? { title: input.title } : {}) },
        owner,
      );
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  private async scan(candidate: Candidate): Promise<Planned> {
    const label = candidate.sourceRel ?? basename(candidate.source);
    let stats: Awaited<ReturnType<typeof lstat>>;
    try {
      stats = await lstat(candidate.source);
    } catch {
      throw new ArtifactRejected(`${label}: not found`);
    }
    const check = (rel: string, s: typeof stats) => {
      if (s.isSymbolicLink())
        throw new ArtifactRejected(`${rel}: symbolic links are not published`);
      if (s.isFile() && s.nlink > 1)
        throw new ArtifactRejected(`${rel}: hard-linked files are not published`);
      if (!s.isFile() && !s.isDirectory())
        throw new ArtifactRejected(`${rel}: only regular files and folders are published`);
    };
    check(label, stats);
    if (stats.isFile()) {
      const rel = checkName(basename(candidate.source));
      return {
        candidate,
        files: [{ rel, abs: candidate.source, bytes: stats.size }],
        directory: false,
      };
    }
    const files: ScannedFile[] = [];
    const walk = async (dir: string, prefix: string, depth: number) => {
      if (depth > MAX_DEPTH)
        throw new ArtifactRejected(`${label}: nested deeper than ${MAX_DEPTH} levels`);
      for (const name of (await readdir(dir)).sort()) {
        const abs = join(dir, name);
        const rel = prefix ? `${prefix}/${name}` : name;
        const s = await lstat(abs);
        check(`${label}/${rel}`, s);
        const normalized = checkName(rel);
        if (s.isDirectory()) await walk(abs, normalized, depth + 1);
        else files.push({ rel: normalized, abs, bytes: s.size });
        if (files.length > this.limits.maxFiles)
          throw new ArtifactRejected(
            `${label}: more than ${this.limits.maxFiles} files (analysis.limits.maxFiles)`,
          );
      }
    };
    await walk(candidate.source, "", 1);
    if (!files.length) throw new ArtifactRejected(`${label}: the folder is empty`);
    const names = new Set(files.map((f) => f.rel));
    if (names.size !== files.length)
      throw new ArtifactRejected(`${label}: two files have the same normalized name`);
    const entry = candidate.entry
      ? checkName(candidate.entry.replace(/\\/g, "/"))
      : names.has("index.html")
        ? "index.html"
        : undefined;
    if (entry && !names.has(entry))
      throw new ArtifactRejected(`${label}: entry ${entry} does not exist in the folder`);
    return { candidate, files, directory: true, ...(entry ? { entry } : {}) };
  }

  private async publishAll(
    candidates: Candidate[],
    owner: ArtifactOwner,
  ): Promise<PublishedArtifact[]> {
    if (!candidates.length) return [];
    // 1. Scan and validate everything before writing anything.
    const plans: Planned[] = [];
    let total = 0,
      count = 0;
    for (const candidate of candidates) {
      const plan = await this.scan(candidate);
      for (const file of plan.files) {
        if (file.bytes > this.limits.maxFileBytes)
          throw new ArtifactRejected(
            `${file.rel}: larger than ${this.limits.maxFileBytes} bytes (analysis.limits.maxFileBytes)`,
          );
        total += file.bytes;
      }
      count += plan.files.length;
      plans.push(plan);
    }
    if (count > this.limits.maxFiles)
      throw new ArtifactRejected(
        `${count} files exceed the limit of ${this.limits.maxFiles} (analysis.limits.maxFiles)`,
      );
    if (total > this.limits.maxOutputBytes)
      throw new ArtifactRejected(
        `${total} bytes exceed the limit of ${this.limits.maxOutputBytes} (analysis.limits.maxOutputBytes)`,
      );
    // Idempotency: a source already published by this execution is returned as is.
    const existing = new Map<string, ArtifactRecord>();
    if (owner.executionId)
      for (const plan of plans) {
        if (!plan.candidate.sourceRel) continue;
        const found = this.options.db
          .prepare("SELECT * FROM artifacts WHERE execution_id=? AND source_path=?")
          .get(owner.executionId, plan.candidate.sourceRel) as Record<string, unknown> | undefined;
        if (found) existing.set(plan.candidate.source, row(found));
      }
    // 2. Build each artifact in a temporary sibling folder, then rename them all into place.
    const sessionDir = this.sessionDir(owner);
    await mkdir(sessionDir, { recursive: true });
    const built: Array<{
      record: ArtifactRecord;
      path: string;
      warnings: string[];
      temp: string;
      final: string;
    }> = [];
    const results: PublishedArtifact[] = [];
    try {
      for (const plan of plans) {
        const known = existing.get(plan.candidate.source);
        if (known) {
          results.push({ artifact: toRef(known), path: this.localPath(known), warnings: [] });
          continue;
        }
        const item = await this.build(plan, owner, sessionDir);
        built.push(item);
        results.push({ artifact: toRef(item.record), path: item.path, warnings: item.warnings });
      }
      for (const item of built) await rename(item.temp, item.final);
      // 3. Register every row in one transaction.
      this.options.db.transaction(() => {
        for (const { record } of built)
          this.options.db
            .prepare(
              `INSERT INTO artifacts(id,session,root_session,workspace,run_id,call_id,execution_id,
                 source_path,title,file_name,kind,mime,bytes,file_count,sha256,entry,rel_dir,status,
                 provenance,created_at)
               VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            )
            .run(
              record.id,
              owner.sessionId,
              owner.rootSessionId,
              owner.workspace,
              owner.runId ?? null,
              owner.callId ?? null,
              owner.executionId ?? null,
              (record.provenance.sourcePath as string | undefined) ?? null,
              record.title,
              record.fileName,
              record.kind,
              record.mimeType,
              record.bytes,
              record.fileCount,
              String(record.provenance.sha256 ?? ""),
              record.entry ?? null,
              record.relDir,
              "ready",
              JSON.stringify(record.provenance),
              record.createdAt,
            );
      });
    } catch (error) {
      for (const item of built) {
        await rm(item.temp, { recursive: true, force: true });
        await rm(item.final, { recursive: true, force: true });
      }
      throw error;
    }
    // The final path replaces the temporary folder in every returned location.
    return results.map((result) => {
      const item = built.find((b) => b.record.id === result.artifact.id);
      return item ? { ...result, path: item.path.replace(item.temp, item.final) } : result;
    });
  }

  private async build(plan: Planned, owner: ArtifactOwner, sessionDir: string) {
    const id = newId("art", this.now());
    const label = plan.candidate.sourceRel ?? basename(plan.candidate.source);
    const baseName = basename(plan.candidate.source);
    const title =
      plan.candidate.title ??
      (plan.directory ? baseName : baseName.replace(/\.[^.]+$/, "") || baseName);
    const folder = `${slugify(title)}--${id}`;
    const temp = join(sessionDir, `.tmp-${id}`);
    const final = join(sessionDir, folder);
    const filesDir = join(temp, "files");
    await mkdir(filesDir, { recursive: true });
    const warnings: string[] = [];
    let kind: ArtifactKind,
      mimeType: string,
      fileName: string,
      entry: string | undefined,
      files: ArtifactFile[];
    try {
      if (!plan.directory || plan.entry) {
        // A file, or a folder with an entry (multi-file dashboard): copy verbatim.
        files = [];
        for (const file of plan.files) {
          const target = join(filesDir, ...file.rel.split("/"));
          await mkdir(dirname(target), { recursive: true });
          await copyFile(file.abs, target, constants.COPYFILE_EXCL);
          files.push({ path: file.rel, bytes: file.bytes, sha256: await sha256File(target) });
        }
        if (!plan.directory) {
          const only = files[0] as ArtifactFile;
          const type = classifyArtifact(only.path, await readHead(join(filesDir, only.path)));
          kind = type.kind;
          mimeType = type.mimeType;
          fileName = only.path;
          if (kind === "dashboard" && only.bytes <= MAX_LINT_BYTES)
            for (const note of chartWarnings(await readFile(join(filesDir, only.path), "utf8")))
              warnings.push(`${label}: ${note}`);
        } else {
          entry = plan.entry as string;
          const type = classifyArtifact(entry, await readHead(join(filesDir, ...entry.split("/"))));
          kind = type.kind;
          mimeType = type.mimeType;
          fileName =
            plan.candidate.fileName ?? (files.length > 1 ? `${baseName}.zip` : basename(entry));
          if (type.kind === "dashboard") {
            const html = await readFile(join(filesDir, ...entry.split("/")), "utf8");
            const entryDir = entry.includes("/") ? entry.slice(0, entry.lastIndexOf("/")) : "";
            const missing = missingReferences(html, entryDir, new Set(files.map((f) => f.path)));
            if (missing.length)
              warnings.push(`${label}: ${entry} references missing files: ${missing.join(", ")}`);
            for (const note of chartWarnings(html)) warnings.push(`${label}: ${entry} ${note}`);
          }
        }
      } else {
        // A folder without an entry: one ZIP archive of its files.
        fileName = `${baseName}.zip`;
        const target = join(filesDir, fileName);
        const out = createWriteStream(target, { flags: "wx" });
        const done = new Promise<void>((resolveDone, reject) => {
          out.once("finish", resolveDone);
          out.once("error", reject);
        });
        await writeZip(
          plan.files.map((file) => ({ name: file.rel, source: file.abs })),
          out,
        );
        out.end();
        await done;
        const { size } = await lstat(target);
        if (size > this.limits.maxFileBytes)
          throw new ArtifactRejected(`${label}: the archive exceeds analysis.limits.maxFileBytes`);
        files = [{ path: fileName, bytes: size, sha256: await sha256File(target) }];
        kind = "archive";
        mimeType = "application/zip";
      }
    } catch (error) {
      await rm(temp, { recursive: true, force: true });
      throw error;
    }
    const bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    const setHash = createHash("sha256")
      .update(
        [...files]
          .sort((a, b) => a.path.localeCompare(b.path))
          .map((f) => `${f.sha256}  ${f.path}\n`)
          .join(""),
      )
      .digest("hex");
    const type = { kind, mimeType };
    const previewable =
      kind !== "file" &&
      (entry ? isPreviewable(entry, type, bytes) : isPreviewable(fileName, type, bytes));
    const createdAt = this.now();
    const provenance: Record<string, unknown> = {
      sessionId: owner.sessionId,
      ...(owner.runId ? { runId: owner.runId } : {}),
      ...(owner.callId ? { callId: owner.callId } : {}),
      ...(owner.executionId ? { executionId: owner.executionId } : {}),
      ...(owner.provenance ?? {}),
      partial: !!owner.partial,
    };
    const manifest = {
      schemaVersion: 1,
      id,
      title,
      fileName,
      kind,
      mimeType,
      ...(entry ? { entry } : {}),
      files,
      bytes,
      sha256: setHash,
      createdAt,
      provenance,
    };
    await writeFile(join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const record: ArtifactRecord = {
      id,
      sessionId: owner.rootSessionId,
      title,
      fileName,
      kind,
      mimeType,
      bytes,
      fileCount: files.length,
      previewable,
      createdAt,
      ...(owner.partial ? { partial: true } : {}),
      status: "ready",
      ...(entry ? { entry } : {}),
      ...(owner.executionId ? { executionId: owner.executionId } : {}),
      ...(owner.runId ? { runId: owner.runId } : {}),
      ...(owner.callId ? { callId: owner.callId } : {}),
      // Stored only in the row (not the manifest): the idempotency key and flags for listings.
      provenance: {
        ...provenance,
        previewable,
        sha256: setHash,
        ...(plan.candidate.sourceRel ? { sourcePath: plan.candidate.sourceRel } : {}),
      },
      relDir: relative(this.options.root, final),
    };
    const local = join(temp, "files", ...(entry ?? fileName).split("/"));
    return { record, path: local, warnings, temp, final };
  }

  /** Artifacts of a root session, newest first. */
  list(
    rootSessionId: string,
    options: {
      kind?: ArtifactKind;
      limit?: number;
      before?: number;
      /** Also `deleted` and `expired` rows (the folder is gone, the row remains). */
      includeDeleted?: boolean;
      /** Also `expired` rows (retention), but not `deleted` ones. */
      includeExpired?: boolean;
    } = {},
  ): ArtifactRecord[] {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const rows = this.options.db
      .prepare(
        `SELECT * FROM artifacts WHERE root_session=?
           AND (? IS NULL OR kind=?) AND (? IS NULL OR created_at<?)
           AND (? = 1 OR status='ready' OR (? = 1 AND status='expired'))
         ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .all(
        rootSessionId,
        options.kind ?? null,
        options.kind ?? null,
        options.before ?? null,
        options.before ?? null,
        options.includeDeleted ? 1 : 0,
        options.includeExpired ? 1 : 0,
        limit,
      ) as Record<string, unknown>[];
    return rows.map(row);
  }

  get(id: string): ArtifactRecord | undefined {
    const found = this.options.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as
      | Record<string, unknown>
      | undefined;
    return found ? row(found) : undefined;
  }

  /** Absolute folder holding `manifest.json` and `files/`. */
  folder(record: ArtifactRecord): string {
    return join(this.options.root, record.relDir);
  }

  /** Absolute path of the file (or the entry of a multi-file artifact). */
  localPath(record: ArtifactRecord): string {
    return join(this.folder(record), "files", ...(record.entry ?? record.fileName).split("/"));
  }

  /** Files of an artifact from its manifest, with absolute paths (inside `files/`). */
  async files(record: ArtifactRecord): Promise<Array<ArtifactFile & { abs: string }>> {
    const manifest = JSON.parse(
      await readFile(join(this.folder(record), "manifest.json"), "utf8"),
    ) as {
      files: ArtifactFile[];
    };
    const root = join(this.folder(record), "files");
    return manifest.files.map((file) => {
      const abs = join(root, ...file.path.split("/"));
      if (!inside(root, abs)) throw new ArtifactRejected(`${file.path}: outside the artifact`);
      return { ...file, abs };
    });
  }

  /**
   * One file of a ready artifact by its manifest path (`files/` only, never `manifest.json`):
   * the path must be listed in the manifest and its real path must stay inside `files/`.
   */
  async resolveFile(
    record: ArtifactRecord,
    path: string,
  ): Promise<(ArtifactFile & { abs: string }) | undefined> {
    if (record.status !== "ready") return undefined;
    const wanted = path.replace(/\\/g, "/").normalize("NFC");
    let files: Array<ArtifactFile & { abs: string }>;
    try {
      files = await this.files(record);
    } catch {
      return undefined;
    }
    const file = files.find((candidate) => candidate.path === wanted);
    if (!file) return undefined;
    try {
      const root = await realpath(join(this.folder(record), "files"));
      const real = await realpath(file.abs);
      if (!inside(root, real) || real === root) return undefined;
      const info = await lstat(real);
      return info.isFile() ? { ...file, abs: real, bytes: info.size } : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Retention: marks a `ready` artifact `expired` and removes its folder; the row stays so cards
   * and listings keep showing it as `Expired`. False when it is not `ready`.
   */
  async markExpired(id: string): Promise<boolean> {
    const record = this.get(id);
    if (!record || record.status !== "ready") return false;
    this.options.db
      .prepare("UPDATE artifacts SET status='expired', deleted_at=? WHERE id=? AND status='ready'")
      .run(this.now(), id);
    await rm(this.folder(record), { recursive: true, force: true });
    return true;
  }

  /** Ready artifacts created before `cutoff` (epoch ms), oldest first (for the retention sweep). */
  readyBefore(cutoff: number): ArtifactRecord[] {
    return (
      this.options.db
        .prepare(
          "SELECT * FROM artifacts WHERE status='ready' AND created_at<? ORDER BY created_at",
        )
        .all(cutoff) as Record<string, unknown>[]
    ).map(row);
  }

  /** Marks an artifact deleted and removes its folder (the row stays for references). */
  async delete(id: string): Promise<boolean> {
    const record = this.get(id);
    if (!record || record.status !== "ready") return false;
    this.options.db
      .prepare("UPDATE artifacts SET status='deleted', deleted_at=? WHERE id=?")
      .run(this.now(), id);
    await rm(this.folder(record), { recursive: true, force: true });
    return true;
  }
}
