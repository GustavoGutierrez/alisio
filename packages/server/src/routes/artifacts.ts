/**
 * Published artifacts (spec §14.1): the list of a root session, one artifact with its files and
 * provenance, its download (the file, or a ZIP of a multi-file artifact streamed with
 * `node:zlib`) and, from phase 2, single files for the panel, signed links for the isolated
 * viewer, the copy into the workspace (a tool call of the session), the analysis sources and
 * deletion. Every route is behind the session cookie like the rest of `/api`.
 */
import { randomUUID } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type AnalysisJobs,
  type ArtifactRecord,
  type ArtifactStore,
  artifactFileType,
  artifactSlug,
  readArtifactHead,
  toRef,
  writeZip,
} from "@alisio/core";
import type { ArtifactKind } from "@alisio/sdk";
import { signViewToken, VIEW_TOKEN_TTL_MS } from "../auth/view-token.ts";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, queryInt, validate } from "../schemas.ts";

const KINDS: readonly ArtifactKind[] = [
  "dashboard",
  "document",
  "spreadsheet",
  "image",
  "data",
  "code",
  "archive",
  "file",
];
/** Provenance keys that only serve the store (never sent to clients). */
const PRIVATE = new Set(["sourcePath", "previewable", "sha256"]);

/** `attachment; filename="…"; filename*=UTF-8''…` with an ASCII fallback (RFC 6266/5987). */
export function attachmentDisposition(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(
    /['()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** The same header with `inline` (files the panel previews). */
const inlineDisposition = (fileName: string) =>
  attachmentDisposition(fileName).replace(/^attachment/, "inline");

/**
 * CSP of files served to the panel on the app origin: inert when opened as a document (opaque
 * origin, no scripts), harmless for `<img>` and `fetch()` which ignore it.
 */
export const FILE_CSP =
  "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

/** `/artifact-view/<token>/<path>` with every path segment encoded. */
export const viewUrl = (token: string, path: string): string =>
  `/artifact-view/${token}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** Whether the isolated viewer serves an artifact (HTML dashboards and PDFs). */
export const viewable = (record: Pick<ArtifactRecord, "kind" | "mimeType">): boolean =>
  record.kind === "dashboard" || record.mimeType === "application/pdf";

export function registerArtifactRoutes(
  router: Router,
  ctx: {
    artifacts: ArtifactStore;
    sessions: SessionService;
    scheduler?: RunScheduler;
    jobs?: AnalysisJobs;
    /** State root (job folders of `sources` are relative to it). */
    stateRoot?: string;
    /** Per-process secret that signs viewer links. */
    viewSecret?: string;
    now?: () => number;
  },
): void {
  const { artifacts, sessions } = ctx;
  const now = ctx.now ?? Date.now;
  const ready = (id: string): ArtifactRecord => {
    const record = find(id);
    if (record.status !== "ready")
      throw new HttpError("artifact_not_found", `Artifact ${record.status}`);
    return record;
  };
  function find(id: string): ArtifactRecord {
    const record = artifacts.get(id);
    if (!record) throw new HttpError("artifact_not_found", "Artifact not found");
    return record;
  }

  router.get("/api/sessions/:sid/artifacts", ({ params, url }) => {
    const session = sessions.get(params.sid ?? "");
    const kind = url.searchParams.get("kind");
    if (kind && !KINDS.includes(kind as ArtifactKind))
      throw new HttpError("validation_failed", "Invalid query parameter", { fields: ["kind"] });
    const limit = queryInt(url, "limit", 50, 200) ?? 50;
    const before = queryInt(url, "cursor", 0);
    const records = artifacts.list(sessions.rootOf(session.id), {
      ...(kind ? { kind: kind as ArtifactKind } : {}),
      limit,
      ...(before ? { before } : {}),
      includeDeleted: true,
    });
    const last = records.at(-1);
    return {
      body: {
        items: records.map(toRef),
        ...(records.length === limit && last ? { next: String(last.createdAt) } : {}),
      },
    };
  });

  router.get("/api/artifacts/:aid", async ({ params }) => {
    const record = find(params.aid ?? "");
    const files =
      record.status === "ready"
        ? (await artifacts.files(record).catch(() => [])).map(({ path, bytes }) => ({
            path,
            bytes,
          }))
        : [];
    const provenance = Object.fromEntries(
      Object.entries(record.provenance).filter(([key]) => !PRIVATE.has(key)),
    );
    return {
      body: {
        ...toRef(record),
        ...(record.entry ? { entry: record.entry } : {}),
        files,
        provenance,
      },
    };
  });

  router.get("/api/artifacts/:aid/download", async ({ params, url, res }) => {
    const record = find(params.aid ?? "");
    if (record.status !== "ready")
      throw new HttpError("artifact_not_found", `Artifact ${record.status}`);
    const files = await artifacts.files(record);
    const manifest = url.searchParams.get("manifest") === "1";
    if (files.length === 1 && !manifest) {
      const [file] = files as [(typeof files)[number]];
      res.writeHead(200, {
        // Always from the type registry, never from the script; downloads never render inline.
        "Content-Type": record.mimeType,
        "Content-Length": file.bytes,
        "Content-Disposition": attachmentDisposition(record.fileName),
        "Cache-Control": "private, no-store",
      });
      await pipeline(createReadStream(file.abs), res);
      return undefined;
    }
    const name = record.fileName.toLowerCase().endsWith(".zip")
      ? record.fileName
      : `${record.fileName.replace(/\.[^.]+$/, "")}.zip`;
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(name),
      "Cache-Control": "private, no-store",
    });
    await writeZip(
      [
        ...files.map((file) => ({ name: file.path, source: file.abs })),
        ...(manifest
          ? [{ name: "manifest.json", source: join(artifacts.folder(record), "manifest.json") }]
          : []),
      ],
      res,
    );
    res.end();
    return undefined;
  });

  router.get("/api/artifacts/:aid/files/*", async ({ params, res }) => {
    const record = ready(params.aid ?? "");
    const file = await artifacts.resolveFile(record, params["*"] ?? "");
    if (!file) throw new HttpError("artifact_not_found", "File not found in this artifact");
    // The registry type (extension and bytes); HTML and download-only types never render inline.
    const type = artifactFileType(file.path, await readArtifactHead(file.abs));
    const name = file.path.split("/").pop() ?? file.path;
    res.writeHead(200, {
      "Content-Type": type.mimeType,
      "Content-Length": file.bytes,
      "Content-Disposition": type.inline ? inlineDisposition(name) : attachmentDisposition(name),
      "Content-Security-Policy": FILE_CSP,
      "Cache-Control": "private, no-store",
    });
    await pipeline(createReadStream(file.abs), res);
    return undefined;
  });

  router.post("/api/artifacts/:aid/view", ({ params }) => {
    const record = ready(params.aid ?? "");
    if (!viewable(record))
      throw new HttpError("validation_failed", "Only dashboards and PDFs open in the viewer");
    if (!record.previewable)
      throw new HttpError("artifact_too_large", "This artifact is too large to preview");
    if (!ctx.viewSecret) throw new HttpError("not_found", "The viewer is not available");
    const expiresAt = now() + VIEW_TOKEN_TTL_MS;
    const token = signViewToken(ctx.viewSecret, record.id, expiresAt);
    return { body: { url: viewUrl(token, record.entry ?? record.fileName), expiresAt } };
  });

  /**
   * Queues a tool call of the artifact's session (no model): the same gates apply (write and
   * capability approvals arrive over SSE like any other). `409 runs_active` while it runs.
   */
  async function queueToolCall(
    record: ArtifactRecord,
    tool: { name: string; input: Record<string, unknown> },
    display: string,
    unavailable: string,
    correlationId: string,
  ) {
    const scheduler = ctx.scheduler;
    if (!scheduler) throw new HttpError("not_found", "This action is not available");
    const session = sessions.get(record.sessionId);
    if (sessions.lockedBy(session.id))
      throw new HttpError(
        "session_locked",
        "Another Alisio process (for example the TUI) is using this session",
      );
    const opened = await sessions.app(session);
    if (
      scheduler.job(session.id) ||
      scheduler.busy(session.id) ||
      opened.app.runner.isRunning(session.id)
    )
      throw new HttpError("runs_active", "Wait until the session finishes running");
    if (!opened.app.registry.list().some((candidate) => candidate.name === tool.name))
      throw new HttpError("permission_denied", unavailable);
    const { run } = sessions.beginRun({
      id: randomUUID(),
      session: session.id,
      status: "queued",
      correlationId,
      model: session.model,
    });
    const status = scheduler.submit({
      runId: run.id,
      sessionId: session.id,
      workspaceId: opened.id,
      app: opened.app,
      text: "",
      correlationId,
      display,
      tool,
      options: () => sessions.runOptions(session.id),
    });
    return { status: 202, body: { runId: run.id, status } };
  }

  router.post("/api/artifacts/:aid/export", async ({ req, params, correlationId }) => {
    const input = validate<{ target: string; overwrite?: boolean }>(await readJson(req), {
      target: { check: is.string(1024), required: true },
      overwrite: { check: is.boolean() },
    });
    const record = ready(params.aid ?? "");
    return queueToolCall(
      record,
      {
        name: "artifact_export",
        input: {
          id: record.id,
          target: input.target,
          ...(input.overwrite ? { overwrite: true } : {}),
        },
      },
      `Copy ${record.fileName} to the workspace (${input.target.trim() || "."})`,
      "Copying artifacts is unavailable (the server runs with --read-only or analysis is disabled)",
      correlationId,
    );
  });

  // Rerun (spec §19): the same script and inputs as a NEW execution with new artifacts. It is a
  // `python_run { rerunOf }` call of the session, so the `analysis.run` capability gate applies
  // (a web approval when nothing allows it) and nothing of the original is overwritten.
  router.post("/api/artifacts/:aid/rerun", async ({ params, correlationId }) => {
    const record = find(params.aid ?? "");
    if (record.status === "deleted")
      throw new HttpError("artifact_not_found", "The artifact was deleted");
    if (!record.executionId)
      throw new HttpError(
        "validation_failed",
        "This artifact was not produced by python_run, so there is no script to run again",
      );
    return queueToolCall(
      record,
      { name: "python_run", input: { rerunOf: record.id } },
      `Run the analysis of ${record.fileName} again`,
      "Running analyses is unavailable (the server runs with --read-only or analysis is disabled)",
      correlationId,
    );
  });

  router.get("/api/artifacts/:aid/sources", async ({ params, url, res }) => {
    const record = find(params.aid ?? "");
    const job = record.executionId ? ctx.jobs?.get(record.executionId) : undefined;
    if (!job || !ctx.stateRoot)
      throw new HttpError("artifact_not_found", "This artifact has no analysis sources");
    const folder = join(ctx.stateRoot, ...job.relDir.split(/[\\/]/));
    const entries = [
      { name: "script/main.py", source: join(folder, "script", "main.py") },
      { name: "job.json", source: join(folder, "job.json") },
      ...(url.searchParams.get("logs") === "1"
        ? ["stdout.log", "stderr.log"].map((name) => ({
            name: `logs/${name}`,
            source: join(folder, "logs", name),
          }))
        : []),
    ].filter((entry) => existsSync(entry.source));
    if (!entries.length)
      throw new HttpError("artifact_not_found", "The analysis sources were removed");
    res.writeHead(200, {
      "Content-Type": "application/zip",
      "Content-Disposition": attachmentDisposition(`${artifactSlug(record.title)}-sources.zip`),
      "Cache-Control": "private, no-store",
    });
    await writeZip(entries, res);
    res.end();
    return undefined;
  });

  router.delete("/api/artifacts/:aid", async ({ params }) => {
    const record = ready(params.aid ?? "");
    await artifacts.delete(record.id);
    return { body: { deleted: true } };
  });
}
