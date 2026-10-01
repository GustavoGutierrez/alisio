/**
 * The terminal preview of text-like artifacts (spec §16.4): which artifacts preview at all, the
 * bounds (Markdown 256 KiB, CSV/TSV 200 rows × 20 columns with a legend, JSON pretty-printed,
 * text 2 000 lines), the explicit `truncated` footer, scrolling keys and the o/c/Esc actions.
 */
import type { ArtifactRef } from "@alisio/sdk";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactPreview,
  buildPreview,
  previewKind,
} from "../packages/cli/src/tui/artifact-preview.ts";

const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "");
const ref = (patch: Partial<ArtifactRef>): ArtifactRef => ({
  id: "art_1",
  sessionId: "s",
  title: "t",
  fileName: "x.md",
  kind: "document",
  mimeType: "text/markdown; charset=utf-8",
  bytes: 10,
  fileCount: 1,
  previewable: true,
  createdAt: 1,
  status: "ready",
  ...patch,
});

describe("previewKind", () => {
  it("previews Markdown, CSV/TSV, JSON and text only", () => {
    expect(previewKind(ref({}))).toBe("markdown");
    expect(previewKind(ref({ kind: "spreadsheet", fileName: "a.csv" }))).toBe("table");
    expect(previewKind(ref({ kind: "spreadsheet", fileName: "a.tsv" }))).toBe("table");
    expect(previewKind(ref({ kind: "data", fileName: "a.json" }))).toBe("json");
    expect(previewKind(ref({ kind: "code", fileName: "a.py" }))).toBe("text");
    for (const other of [
      ref({ kind: "dashboard", fileName: "a.html" }),
      ref({ kind: "document", fileName: "a.pdf", mimeType: "application/pdf" }),
      ref({ kind: "image", fileName: "a.png" }),
      ref({ kind: "image", fileName: "a.svg" }),
      ref({ kind: "document", fileName: "a.docx", previewable: false }),
      ref({ kind: "spreadsheet", fileName: "a.xlsx", previewable: false }),
      ref({ kind: "archive", fileName: "a.zip", previewable: false }),
      ref({ kind: "file", fileName: "a.bin", previewable: false }),
    ])
      expect(previewKind(other), other.fileName).toBeUndefined();
  });
});

describe("buildPreview bounds", () => {
  it("cuts Markdown at 256 KiB and says so", () => {
    const big = Buffer.from(`# Title\n${"word ".repeat(80_000)}`);
    const preview = buildPreview(ref({ bytes: big.length }), big);
    expect(preview.truncated).toBe(true);
    expect(preview.block.kind).toBe("markdown");
    expect(
      preview.block.kind === "markdown" && Buffer.byteLength(preview.block.text),
    ).toBeLessThanOrEqual(256 * 1024);
    const small = buildPreview(ref({}), Buffer.from("# Hi\n"));
    expect(small.truncated).toBe(false);
  });

  it("shows at most 200 rows × 20 columns of a CSV with a legend, quotes included", () => {
    const header = Array.from({ length: 31 }, (_, i) => `c${i}`).join(",");
    const rows = Array.from({ length: 12_480 }, (_, r) =>
      Array.from({ length: 31 }, (_, c) => (c === 0 ? `"r${r}, quoted"` : `${r * c}`)).join(","),
    );
    const csv = Buffer.from([header, ...rows].join("\r\n"));
    const preview = buildPreview(ref({ kind: "spreadsheet", fileName: "a.csv" }), csv);
    expect(preview.block.kind).toBe("table");
    if (preview.block.kind !== "table") return;
    expect(preview.block.columns).toHaveLength(20);
    expect(preview.block.rows).toHaveLength(200);
    expect(preview.block.rows[0]?.[0]).toBe("r0, quoted");
    expect(preview.legend).toBe("showing 200 of 12,480 rows · 20 of 31 columns");
    expect(preview.truncated).toBe(true);
    const tsv = buildPreview(
      ref({ kind: "spreadsheet", fileName: "a.tsv" }),
      Buffer.from("a\tb\n1\t2\n"),
    );
    expect(tsv.block.kind === "table" && tsv.block.rows).toEqual([["1", "2"]]);
    expect(tsv.truncated).toBe(false);
  });

  it("pretty-prints JSON and keeps invalid JSON as text", () => {
    const json = buildPreview(
      ref({ kind: "data", fileName: "a.json" }),
      Buffer.from('{"a":[1,2]}'),
    );
    expect(json.block).toMatchObject({ kind: "code", lang: "json" });
    expect(json.block.kind === "code" && json.block.code).toBe(
      '{\n  "a": [\n    1,\n    2\n  ]\n}',
    );
    const broken = buildPreview(ref({ kind: "data", fileName: "a.json" }), Buffer.from("{oops"));
    expect(broken.block.kind === "code" && broken.block.code).toBe("{oops");
  });

  it("shows the first 2 000 lines of text with highlighting by extension", () => {
    const text = Buffer.from(Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"));
    const preview = buildPreview(ref({ kind: "code", fileName: "run.py" }), text);
    expect(preview.block).toMatchObject({ kind: "code", lang: "python" });
    expect(preview.block.kind === "code" && preview.block.code.split("\n")).toHaveLength(2000);
    expect(preview.truncated).toBe(true);
  });
});

describe("ArtifactPreview component", () => {
  it("scrolls with arrows, PgUp/PgDn, Home/End and maps o, c, Esc and q", () => {
    const actions = { open: vi.fn(), copy: vi.fn(), close: vi.fn() };
    const text = Buffer.from(Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n"));
    const preview = new ArtifactPreview(
      ref({ kind: "code", fileName: "a.txt" }),
      buildPreview(ref({ kind: "code", fileName: "a.txt" }), text),
      { height: () => 10, ...actions },
    );
    const body = () => preview.render(80).map(strip).join("\n");
    expect(body()).toContain("line 0");
    expect(body()).not.toContain("line 20");
    // The code fence is the first line: two steps down leave "line 0" above the view.
    preview.handleInput("\x1b[B"); // ↓
    preview.handleInput("\x1b[B");
    expect(body()).not.toContain("line 0");
    preview.handleInput("\x1b[F"); // End
    expect(body()).toContain("line 99");
    preview.handleInput("\x1b[H"); // Home
    expect(body()).toContain("line 0");
    preview.handleInput("\x1b[6~"); // PgDn
    expect(body()).not.toContain("line 1\n");
    preview.handleInput("o");
    preview.handleInput("c");
    preview.handleInput("q");
    preview.handleInput("\x1b");
    expect(actions.open).toHaveBeenCalledTimes(1);
    expect(actions.copy).toHaveBeenCalledTimes(1);
    expect(actions.close).toHaveBeenCalledTimes(2);
  });

  it("marks a truncated preview in the footer", () => {
    const big = Buffer.from(Array.from({ length: 2500 }, (_, i) => `l${i}`).join("\n"));
    const artifact = ref({ kind: "code", fileName: "a.log" });
    const preview = new ArtifactPreview(artifact, buildPreview(artifact, big), {
      height: () => 10,
      open() {},
      copy() {},
      close() {},
    });
    expect(preview.render(80).map(strip).join("\n")).toMatch(/truncated/);
  });
});

describe("CSV preview reads what the ingestion reads (phase 3)", () => {
  const csv = (fileName = "a.csv") => ref({ kind: "spreadsheet", fileName });

  it("detects ; and | delimiters, quoted fields and CRLF", () => {
    const semi = buildPreview(csv(), Buffer.from('name;note\r\nAna;"a;b"\r\nLuis;x\r\n'));
    expect(semi.block).toMatchObject({
      kind: "table",
      columns: ["name", "note"],
      rows: [
        ["Ana", "a;b"],
        ["Luis", "x"],
      ],
    });
    expect(buildPreview(csv(), Buffer.from("a|b\n1|2\n")).block).toMatchObject({
      columns: ["a", "b"],
      rows: [["1", "2"]],
    });
  });

  it("decodes windows-1252 and UTF-16 files", () => {
    const latin = buildPreview(csv(), Buffer.from("city\nM\xe1laga\n", "latin1"));
    expect(latin.block).toMatchObject({ rows: [["Málaga"]] });
    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("a,b\n1,ñ\n", "utf16le")]);
    expect(buildPreview(csv(), utf16).block).toMatchObject({
      columns: ["a", "b"],
      rows: [["1", "ñ"]],
    });
  });
});
