/**
 * Datasets (spec §14.1, §17): raw upload of a CSV/TSV/JSON/JSONL/XLSX file into a session (kept in
 * the content-addressed blob store, ingested in the background into one SQLite file), the list
 * and schema of a session's datasets, and the keyset-paginated rows `SpreadsheetView` reads. A
 * spreadsheet artifact is ingested lazily on its first preview. Ingestion runs in the data
 * engine process, so the server keeps answering (health, SSE heartbeat) while a file is read.
 */
import { createReadStream } from "node:fs";
import { basename } from "node:path";
import { pipeline } from "node:stream/promises";
import {
  type ArtifactStore,
  BlobTooLarge,
  DataError,
  type DatasetRecord,
  type DatasetService,
  datasetFormat,
  PageParamError,
  type SQLiteStore,
  toDatasetRef,
} from "@alisio/core";
import type { DatasetRef, ServerFrame } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { queryInt } from "../schemas.ts";
import { attachmentDisposition } from "./artifacts.ts";

/** How long `POST /api/artifacts/:aid/dataset` waits for the ingestion before answering 202. */
const ARTIFACT_WAIT_MS = 15_000;

/** The HTTP shape of a data failure. */
export function dataHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  if (error instanceof PageParamError) return new HttpError("validation_failed", error.message);
  if (error instanceof DataError) {
    switch (error.code) {
      case "not_found":
        return new HttpError("not_found", error.message);
      case "dataset_unsupported":
        return new HttpError("dataset_unsupported", error.message);
      case "query_rejected":
      case "sql_error":
        return new HttpError("query_rejected", error.message);
      case "query_timeout":
        return new HttpError("query_timeout", error.message);
      case "ingest_limit":
        return new HttpError("payload_too_large", error.message);
      case "ingest_invalid":
        return new HttpError("validation_failed", error.message);
      case "cancelled":
        return new HttpError("cancelled", error.message);
      default:
        return new HttpError("internal", error.message);
    }
  }
  return new HttpError("internal", error instanceof Error ? error.message : String(error));
}

/** `X-File-Name` is percent-encoded (headers are ASCII); falls back to the raw text. */
function uploadName(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? (header[0] ?? "") : (header ?? "");
  let name = raw;
  try {
    name = decodeURIComponent(raw);
  } catch {
    /* keep the raw header */
  }
  return basename(name.replace(/\\/g, "/")).trim().slice(0, 255);
}

export function registerDatasetRoutes(
  router: Router,
  ctx: {
    sessions: SessionService;
    catalog: SQLiteStore;
    artifacts: ArtifactStore;
    blobs: import("@alisio/core").BlobStore;
    toSession: (sessionId: string, frame: ServerFrame) => void;
  },
): void {
  const { sessions } = ctx;

  /** The dataset service of the workspace that owns a root session. */
  async function serviceOf(sessionId: string): Promise<{
    datasets: DatasetService;
    analysis: boolean;
    workspace: string;
    root: string;
  }> {
    const session = sessions.get(sessionId);
    const opened = await sessions.app(session);
    return {
      datasets: opened.app.datasets,
      analysis: opened.app.config.analysis.enabled,
      workspace: session.workspace,
      root: sessions.rootOf(session.id),
    };
  }

  /** The record of a dataset id and the service of its owner. */
  async function find(id: string): Promise<{ record: DatasetRecord; datasets: DatasetService }> {
    const row = ctx.catalog.db
      .prepare("SELECT session, root_session FROM datasets WHERE id=?")
      .get(id) as { session: string; root_session: string } | undefined;
    if (!row) throw new HttpError("not_found", "Dataset not found");
    const { datasets } = await serviceOf(row.root_session);
    const record = datasets.get(id);
    if (!record) throw new HttpError("not_found", "Dataset not found");
    return { record, datasets };
  }

  const ingestInBackground = (
    datasets: DatasetService,
    root: string,
    name: string,
    work: Promise<{ record: DatasetRecord }>,
  ) => {
    work.then(
      ({ record }) =>
        ctx.toSession(root, { t: "dataset_ready", sessionId: root, dataset: toDatasetRef(record) }),
      (error: unknown) =>
        ctx.toSession(root, {
          t: "dataset_failed",
          sessionId: root,
          name,
          error: error instanceof Error ? error.message : String(error),
        }),
    );
    void datasets;
  };

  router.post("/api/sessions/:sid/datasets", async ({ req, params }) => {
    const target = await serviceOf(params.sid ?? "");
    const type = String(req.headers["content-type"] ?? "")
      .split(";")[0]
      ?.trim()
      .toLowerCase();
    if (type !== "application/octet-stream") {
      req.resume();
      throw new HttpError(
        "unsupported_media_type",
        "Upload the file as the raw body with Content-Type: application/octet-stream",
      );
    }
    const name = uploadName(req.headers["x-file-name"]);
    if (!name || !datasetFormat(name)) {
      req.resume();
      throw new HttpError(
        "dataset_unsupported",
        "Upload a CSV, TSV, JSON, JSONL or XLSX file (send its name in X-File-Name)",
      );
    }
    if (!target.analysis) {
      req.resume();
      throw new HttpError("validation_failed", "Data analysis is disabled (analysis.enabled)");
    }
    const limit = target.datasets.limits.maxUploadBytes;
    const declared = Number(req.headers["content-length"] ?? Number.NaN);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      throw new HttpError(
        "payload_too_large",
        `The file exceeds ${limit} bytes (analysis.data.maxUploadBytes)`,
      );
    }
    let blob: Awaited<ReturnType<typeof ctx.blobs.putStream>>;
    try {
      blob = await ctx.blobs.putStream(req, "application/octet-stream", { maxBytes: limit });
    } catch (error) {
      if (error instanceof BlobTooLarge) {
        req.resume();
        throw new HttpError(
          "payload_too_large",
          `The file exceeds ${limit} bytes (analysis.data.maxUploadBytes)`,
        );
      }
      throw error;
    }
    if (blob.bytes === 0) throw new HttpError("validation_failed", "The upload is empty");
    const session = sessions.get(params.sid ?? "");
    const work = target.datasets.ingest({
      rootSessionId: target.root,
      sessionId: session.id,
      workspace: target.workspace,
      path: ctx.blobs.path(blob.hash),
      name,
      blobHash: blob.hash,
    });
    // A file already ingested in this session answers immediately.
    const existing = target.datasets.list(target.root).find((d) => d.sha256 === blob.hash);
    work.catch(() => undefined);
    ingestInBackground(target.datasets, target.root, name, work);
    if (existing)
      return {
        status: 200,
        body: { dataset: toDatasetRef(existing), pending: false } satisfies {
          dataset: DatasetRef | null;
          pending: boolean;
        },
      };
    return { status: 202, body: { dataset: null, pending: true } };
  });

  router.get("/api/sessions/:sid/datasets", async ({ params }) => {
    const target = await serviceOf(params.sid ?? "");
    return { body: { items: target.datasets.list(target.root).map(toDatasetRef) } };
  });

  router.get("/api/datasets/:did", async ({ params }) => {
    const { record, datasets } = await find(params.did ?? "");
    try {
      return { body: datasets.detail(record) };
    } catch (error) {
      throw dataHttpError(error);
    }
  });

  // The original file of a dataset uploaded from the web (the blob store keeps it untouched).
  router.get("/api/datasets/:did/download", async ({ params, res }) => {
    const { record } = await find(params.did ?? "");
    if (!record.blobHash)
      throw new HttpError(
        "not_found",
        "This dataset has no uploaded original (use the artifact download)",
      );
    const file = ctx.blobs.path(record.blobHash);
    res.writeHead(200, {
      "Content-Type": "application/octet-stream",
      "Content-Length": record.bytes,
      "Content-Disposition": attachmentDisposition(record.name),
      "Cache-Control": "private, no-store",
    });
    await pipeline(createReadStream(file), res);
    return undefined;
  });

  router.get("/api/datasets/:did/rows", async ({ params, url }) => {
    const { record, datasets } = await find(params.did ?? "");
    const dir = url.searchParams.get("dir");
    if (dir !== null && dir !== "asc" && dir !== "desc")
      throw new HttpError("validation_failed", "Invalid query parameter", { fields: ["dir"] });
    const text = (name: string) => url.searchParams.get(name) ?? undefined;
    const sheet = text("sheet");
    const after = text("after");
    const sort = text("sort");
    const filter = text("filter");
    const column = text("column");
    try {
      const page = await datasets.page(record, {
        ...(sheet !== undefined ? { sheet } : {}),
        ...(after ? { after } : {}),
        ...(queryInt(url, "offset", 0) ? { offset: queryInt(url, "offset", 0) as number } : {}),
        limit: queryInt(url, "limit", 200, 500) ?? 200,
        ...(sort ? { sort } : {}),
        ...(dir ? { dir } : {}),
        ...(filter ? { filter } : {}),
        ...(column !== undefined ? { column } : {}),
      });
      return { body: page };
    } catch (error) {
      throw dataHttpError(error);
    }
  });

  // A spreadsheet artifact (CSV/TSV/XLSX) is ingested the first time it is previewed.
  router.post("/api/artifacts/:aid/dataset", async ({ params }) => {
    const record = ctx.artifacts.get(params.aid ?? "");
    if (!record || record.status !== "ready")
      throw new HttpError("artifact_not_found", "Artifact not found");
    if (record.kind !== "spreadsheet")
      throw new HttpError("validation_failed", "Only spreadsheet artifacts open as datasets");
    const file = await ctx.artifacts.resolveFile(record, record.entry ?? record.fileName);
    if (!file) throw new HttpError("artifact_not_found", "The artifact file was not found");
    const target = await serviceOf(record.sessionId);
    if (!target.analysis)
      throw new HttpError("validation_failed", "Data analysis is disabled (analysis.enabled)");
    const work = target.datasets.ingest({
      rootSessionId: target.root,
      sessionId: record.sessionId,
      workspace: target.workspace,
      path: file.abs,
      name: record.fileName,
      sourcePath: file.abs,
    });
    work.catch(() => undefined);
    const outcome = await Promise.race([
      work.then((done) => ({ done })),
      new Promise<{ done?: undefined }>((resolve) =>
        setTimeout(() => resolve({}), ARTIFACT_WAIT_MS),
      ),
    ]).catch((error: unknown) => {
      throw dataHttpError(error);
    });
    if (!outcome.done) return { status: 202, body: { dataset: null, pending: true } };
    return { body: { dataset: toDatasetRef(outcome.done.record), pending: false } };
  });
}
