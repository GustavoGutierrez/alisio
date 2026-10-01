import type { DatasetRef } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  ACCEPT,
  applyDatasetOutcome,
  applyPolledDatasets,
  canSend,
  checkFile,
  isDatasetFile,
  MAX_ATTACHMENTS,
  type PendingAttachment,
  readyDatasets,
  readyRefs,
  updateAttachment,
} from "../packages/web/src/store/attachments.ts";

const MB = 1024 * 1024;
const pending = (id: string, extra: Partial<PendingAttachment> = {}): PendingAttachment => ({
  id,
  name: `${id}.png`,
  url: `blob:${id}`,
  bytes: 10,
  status: "uploading",
  ...extra,
});
const ref = (hash: string) => ({ hash, mimeType: "image/png", bytes: 10 });

describe("composer attachments", () => {
  it("accepts PNG, JPEG, GIF and WebP up to 10 MB, within the count limit", () => {
    expect(checkFile({ size: 1, type: "image/png" }, 0)).toBeUndefined();
    expect(checkFile({ size: 10 * MB, type: "image/webp" }, 0)).toBeUndefined();
    expect(checkFile({ size: 25 * MB, type: "image/png" }, 0)).toBe("too-large");
    expect(checkFile({ size: 1, type: "image/svg+xml" }, 0)).toBe("unsupported");
    expect(checkFile({ size: 1, type: "application/pdf" }, 0)).toBe("unsupported");
    expect(checkFile({ size: 0, type: "image/png" }, 0)).toBe("empty");
    expect(checkFile({ size: 1, type: "image/png" }, MAX_ATTACHMENTS)).toBe("too-many");
  });

  it("sends only uploaded references, and only once nothing is still uploading", () => {
    let list = [pending("a"), pending("b")];
    expect(canSend("hi", list)).toBe(false);
    list = updateAttachment(list, "a", { status: "ready", ref: ref("h1") });
    list = updateAttachment(list, "b", { status: "failed", error: "415" });
    expect(readyRefs(list)).toEqual([ref("h1")]);
    expect(canSend("", list)).toBe(true);
    expect(canSend("  ", [])).toBe(false);
    expect(canSend("text", [])).toBe(true);
    expect(canSend("", [pending("c", { status: "failed" })])).toBe(false);
  });
});

const dataset = (id: string, name: string): DatasetRef => ({
  id,
  name,
  format: "csv",
  bytes: 10,
  sha256: "x",
  sheets: [{ name: "data", table: "data", rows: 3, columns: 2 }],
});
const reading = (id: string, name: string): PendingAttachment => ({
  id,
  name,
  url: "",
  bytes: 10,
  status: "uploading",
  kind: "dataset",
});

describe("data file attachments", () => {
  it("accepts CSV, TSV, JSON, JSONL and XLSX by name, whatever the browser says their type is", () => {
    for (const name of ["a.csv", "A.TSV", "b.json", "c.jsonl", "d.ndjson", "e.xlsx"]) {
      expect(isDatasetFile({ name }), name).toBe(true);
      expect(
        checkFile({ size: 500 * MB, type: "application/vnd.ms-excel", name }, 0),
        name,
      ).toBeUndefined();
    }
    expect(checkFile({ size: 0, type: "", name: "a.csv" }, 0)).toBe("empty");
    expect(checkFile({ size: 1, type: "", name: "a.parquet" }, 0)).toBe("unsupported");
    expect(checkFile({ size: 1, type: "text/csv", name: "a.csv" }, MAX_ATTACHMENTS)).toBe(
      "too-many",
    );
    for (const ext of [".csv", ".tsv", ".json", ".jsonl", ".xlsx", "image/png"])
      expect(ACCEPT).toContain(ext);
  });

  it("keeps a dataset reading until its frame arrives, then makes it sendable", () => {
    let list = [reading("a", "sales.csv")];
    expect(canSend("", list)).toBe(false);
    list = applyDatasetOutcome(list, { ready: dataset("ds_1", "sales.csv") });
    expect(list[0]).toMatchObject({ status: "ready", dataset: { id: "ds_1" } });
    expect(readyDatasets(list).map((d) => d.id)).toEqual(["ds_1"]);
    expect(readyRefs(list)).toEqual([]);
    expect(canSend("", list)).toBe(true);
  });

  it("matches frames to uploads by file name and ignores other tabs' uploads", () => {
    const list = [reading("a", "x.csv"), reading("b", "y.csv"), reading("c", "x.csv")];
    const first = applyDatasetOutcome(list, { ready: dataset("ds_1", "x.csv") });
    expect(first.map((a) => a.status)).toEqual(["ready", "uploading", "uploading"]);
    const second = applyDatasetOutcome(first, { ready: dataset("ds_2", "x.csv") });
    expect(second.map((a) => a.status)).toEqual(["ready", "uploading", "ready"]);
    expect(applyDatasetOutcome(second, { ready: dataset("ds_3", "z.csv") })).toBe(second);
    const failed = applyDatasetOutcome(second, { failed: { name: "y.csv", error: "too big" } });
    expect(failed[1]).toMatchObject({ status: "failed", error: "too big" });
    expect(canSend("", failed)).toBe(true);
  });

  it("recovers from a missed frame by matching the session's dataset list", () => {
    const list = [reading("a", "x.csv"), reading("b", "y.csv")];
    const polled = applyPolledDatasets(list, [
      dataset("ds_1", "x.csv"),
      dataset("ds_9", "other.csv"),
    ]);
    expect(polled.map((a) => a.status)).toEqual(["ready", "uploading"]);
    // A dataset already taken by a chip is not assigned twice.
    const again = applyPolledDatasets(polled, [dataset("ds_1", "y.csv")]);
    expect(again.map((a) => a.status)).toEqual(["ready", "uploading"]);
  });
});
