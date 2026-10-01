import { describe, expect, it } from "vitest";
import { classifyArtifact, isPreviewable } from "../packages/core/src/artifacts/kinds.ts";

const bytes = (...values: number[]) => new Uint8Array(values);
const text = (value: string) => new TextEncoder().encode(value);
const PNG = bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13);
const PDF = text("%PDF-1.7\n");
const ZIP = bytes(0x50, 0x4b, 0x03, 0x04, 20, 0);

describe("classifyArtifact (extension AND bytes)", () => {
  it.each([
    ["report.md", text("# Title"), "document", "text/markdown; charset=utf-8"],
    ["index.html", text("<!doctype html>"), "dashboard", "text/html; charset=utf-8"],
    ["chart.svg", text("<svg/>"), "image", "image/svg+xml"],
    ["data.csv", text("a,b\n1,2"), "spreadsheet", "text/csv; charset=utf-8"],
    ["out.json", text("{}"), "data", "application/json"],
    ["notes.txt", text("hola año"), "code", "text/plain; charset=utf-8"],
    ["plot.png", PNG, "image", "image/png"],
    ["summary.pdf", PDF, "document", "application/pdf"],
    [
      "memo.docx",
      ZIP,
      "document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    ["bundle.zip", ZIP, "archive", "application/zip"],
  ])("%s → %s", (name, head, kind, mime) => {
    expect(classifyArtifact(name, head)).toEqual({ kind, mimeType: mime });
  });

  it("falls back to a download-only file when the bytes contradict the extension", () => {
    const fallback = { kind: "file", mimeType: "application/octet-stream" };
    expect(classifyArtifact("fake.png", text("<script>alert(1)</script>"))).toEqual(fallback);
    expect(classifyArtifact("page.html", PNG)).toEqual(fallback);
    expect(classifyArtifact("doc.pdf", text("not a pdf"))).toEqual(fallback);
    expect(classifyArtifact("binary.txt", bytes(0x41, 0x00, 0x42))).toEqual(fallback);
  });

  it("classifies unknown extensions as download-only files", () => {
    expect(classifyArtifact("model.bin", bytes(1, 2, 3)).kind).toBe("file");
    expect(classifyArtifact("README", text("hello")).kind).toBe("file");
  });
});

describe("isPreviewable", () => {
  it("applies the per-type size limits", () => {
    const md = classifyArtifact("a.md", text("x"));
    expect(isPreviewable("a.md", md, 1024)).toBe(true);
    expect(isPreviewable("a.md", md, 3 * 1024 * 1024)).toBe(false);
    const html = classifyArtifact("a.html", text("<p>"));
    expect(isPreviewable("a.html", html, 10 * 1024 * 1024)).toBe(true);
  });

  it("previews tables (CSV, TSV, XLSX) up to the ingestion limit, in any text encoding", () => {
    const latin1 = Uint8Array.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0x63, 0x61, 0x66, 0xe9]);
    const utf16 = Uint8Array.from([0xff, 0xfe, 0x61, 0x00, 0x2c, 0x00, 0x62, 0x00]);
    for (const [name, head] of [
      ["a.csv", latin1],
      ["a.csv", utf16],
      ["a.tsv", text("a\tb")],
      ["a.xlsx", ZIP],
    ] as const) {
      const type = classifyArtifact(name, head);
      expect(type.kind, name).toBe("spreadsheet");
      expect(isPreviewable(name, type, 150 * 1024 * 1024), name).toBe(true);
      expect(isPreviewable(name, type, 250 * 1024 * 1024), name).toBe(false);
    }
    expect(classifyArtifact("a.csv", bytes(0x41, 0x00, 0x42, 0x00, 0x00)).kind).toBe("file");
  });

  it("never previews documents without a web renderer, archives or plain files", () => {
    expect(isPreviewable("a.docx", classifyArtifact("a.docx", ZIP), 10)).toBe(false);
    expect(isPreviewable("a.zip", classifyArtifact("a.zip", ZIP), 10)).toBe(false);
    expect(isPreviewable("a.bin", classifyArtifact("a.bin", bytes(1)), 10)).toBe(false);
  });
});
