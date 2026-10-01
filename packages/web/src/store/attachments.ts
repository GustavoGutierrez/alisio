/**
 * Composer attachments: images (RF-06; client-side checks that mirror the server's, 10 MB,
 * PNG/JPEG/GIF/WebP, the server still sniffs the bytes) and data files (phase 3: CSV, TSV, JSON,
 * JSONL, XLSX, uploaded as a dataset that the server ingests in the background and announces with
 * a `dataset_ready` or `dataset_failed` frame). The pending-upload list and its transitions. Pure.
 */
import type { BlobRef, DatasetRef } from "@alisio/sdk";

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ATTACHMENTS = 8;
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Extensions of the data files a prompt can attach (the server decides the format by name). */
export const DATASET_EXTENSIONS = [".csv", ".tsv", ".tab", ".json", ".jsonl", ".ndjson", ".xlsx"];
/** `accept` of the file picker: images plus the data files. */
export const ACCEPT = [...IMAGE_TYPES, ...DATASET_EXTENSIONS].join(",");

export const isDatasetFile = (file: { name?: string }): boolean => {
  const name = (file.name ?? "").toLowerCase();
  return DATASET_EXTENSIONS.some((ext) => name.endsWith(ext));
};

export type Rejection = "too-large" | "unsupported" | "too-many" | "empty";

export interface PendingAttachment {
  id: string;
  name: string;
  /** Object URL of the local file (thumbnail of an image; empty for a dataset). */
  url: string;
  bytes: number;
  status: "uploading" | "ready" | "failed";
  /** `dataset` for a data file (default: an image). */
  kind?: "image" | "dataset";
  ref?: BlobRef;
  dataset?: DatasetRef;
  error?: string;
}

/** Why a file cannot be attached (undefined when it can). Data files have no client-side size cap. */
export function checkFile(
  file: { size: number; type: string; name?: string },
  count: number,
): Rejection | undefined {
  if (count >= MAX_ATTACHMENTS) return "too-many";
  if (isDatasetFile(file)) return file.size === 0 ? "empty" : undefined;
  if (!IMAGE_TYPES.includes(file.type)) return "unsupported";
  if (file.size === 0) return "empty";
  if (file.size > MAX_ATTACHMENT_BYTES) return "too-large";
  return undefined;
}

export const updateAttachment = (
  list: PendingAttachment[],
  id: string,
  patch: Partial<PendingAttachment>,
): PendingAttachment[] => list.map((a) => (a.id === id ? { ...a, ...patch } : a));

export const readyRefs = (list: PendingAttachment[]): BlobRef[] =>
  list.flatMap((a) => (a.status === "ready" && a.kind !== "dataset" && a.ref ? [a.ref] : []));

/** Datasets whose ingestion finished. */
export const readyDatasets = (list: PendingAttachment[]): DatasetRef[] =>
  list.flatMap((a) => (a.status === "ready" && a.dataset ? [a.dataset] : []));

/** Text or at least one uploaded image or dataset, and no upload still running. */
export const canSend = (text: string, list: PendingAttachment[]): boolean =>
  !list.some((a) => a.status === "uploading") &&
  (text.trim().length > 0 || readyRefs(list).length > 0 || readyDatasets(list).length > 0);

/** A `dataset_ready` / `dataset_failed` frame (or a polled dataset) applied to the pending list. */
export type DatasetOutcome = { ready: DatasetRef } | { failed: { name: string; error: string } };

/**
 * The first dataset upload still running with this file name becomes `ready` (with its dataset)
 * or `failed`. A name nothing is waiting for changes nothing (another tab's upload).
 */
export function applyDatasetOutcome(
  list: PendingAttachment[],
  outcome: DatasetOutcome,
): PendingAttachment[] {
  const name = "ready" in outcome ? outcome.ready.name : outcome.failed.name;
  const index = list.findIndex(
    (a) => a.kind === "dataset" && a.status === "uploading" && a.name === name,
  );
  if (index < 0) return list;
  return list.map((a, i) =>
    i !== index
      ? a
      : "ready" in outcome
        ? { ...a, status: "ready" as const, dataset: outcome.ready }
        : { ...a, status: "failed" as const, error: outcome.failed.error },
  );
}

/** Polling fallback: uploading datasets whose name now appears in the session's dataset list. */
export function applyPolledDatasets(
  list: PendingAttachment[],
  datasets: DatasetRef[],
  alreadyUsed: ReadonlySet<string> = new Set(),
): PendingAttachment[] {
  let next = list;
  const used = new Set([...alreadyUsed, ...readyDatasets(list).map((d) => d.id)]);
  for (const dataset of datasets) {
    if (used.has(dataset.id)) continue;
    const updated = applyDatasetOutcome(next, { ready: dataset });
    if (updated !== next) used.add(dataset.id);
    next = updated;
  }
  return next;
}
