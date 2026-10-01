/**
 * Dataset frames (spec §14.3): `dataset_ready` and `dataset_failed` announce the end of an upload's
 * ingestion. The composer applies them to its pending chips (`applyDatasetOutcome`); this store
 * only keeps the latest ones, with a counter, so a component can process each exactly once.
 */
import type { DatasetRef, ServerFrame } from "@alisio/sdk";
import { signal } from "@preact/signals";

export interface DatasetNotice {
  n: number;
  /** Root session of the dataset. */
  sessionId: string;
  ready?: DatasetRef;
  failed?: { name: string; error: string };
}

/** The most recent notices (bounded), oldest first. */
export const datasetNotices = signal<DatasetNotice[]>([]);
let counter = 0;

/** Records a `dataset_*` frame; other frames are ignored. */
export function pushDatasetNotice(frame: ServerFrame): void {
  let notice: DatasetNotice | undefined;
  if (frame.t === "dataset_ready")
    notice = { n: ++counter, sessionId: frame.sessionId, ready: frame.dataset };
  else if (frame.t === "dataset_failed")
    notice = {
      n: ++counter,
      sessionId: frame.sessionId,
      failed: { name: frame.name, error: frame.error },
    };
  if (notice) datasetNotices.value = [...datasetNotices.value, notice].slice(-50);
}
