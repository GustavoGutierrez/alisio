import { describe, expect, it } from "vitest";
import {
  diffLines,
  filesOf,
  parsePatch,
  splitRows,
} from "../packages/web/src/renderers/diff/model.ts";
import { childEntries, jsonPath, jsonPreview } from "../packages/web/src/renderers/json/model.ts";
import {
  parseAnsi,
  settleCarriageReturns,
  tailLines,
} from "../packages/web/src/renderers/terminal/ansi.ts";
import { failedOnly, summarize } from "../packages/web/src/renderers/tests/model.ts";

const PATCH = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 1111111..2222222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,4 @@ export function a() {",
  " one",
  "-two",
  "+TWO",
  "+two and a half",
  " three",
  "\\ No newline at end of file",
  "diff --git a/new.txt b/new.txt",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/new.txt",
  "@@ -0,0 +1 @@",
  "+hello",
].join("\n");

describe("diff model", () => {
  it("parses a multi-file unified patch with line numbers and counts", () => {
    const files = parsePatch(PATCH);
    expect(files.map((f) => f.path)).toEqual(["src/a.ts", "new.txt"]);
    const [a, created] = files;
    expect(a?.added).toBe(2);
    expect(a?.removed).toBe(1);
    expect(a?.hunks).toHaveLength(1);
    const lines = a?.hunks[0]?.lines ?? [];
    expect(lines.map((l) => l.type)).toEqual(["ctx", "del", "add", "add", "ctx", "note"]);
    expect(lines[0]).toMatchObject({ text: "one", oldNo: 1, newNo: 1 });
    expect(lines[1]).toMatchObject({ text: "two", oldNo: 2 });
    expect(lines[1]?.newNo).toBeUndefined();
    expect(lines[3]).toMatchObject({ text: "two and a half", newNo: 3 });
    expect(lines[4]).toMatchObject({ text: "three", oldNo: 3, newNo: 4 });
    expect(a?.hunks[0]?.header).toContain("export function a()");
    expect(created?.status).toBe("added");
    expect(created?.hunks[0]?.lines[0]).toMatchObject({ type: "add", text: "hello", newNo: 1 });
  });

  it("accepts bare hunks without file headers and names them after the block path", () => {
    const [file] = filesOf({ kind: "diff", path: "x.md", patch: "@@ -1 +1 @@\n-a\n+b" });
    expect(file?.path).toBe("x.md");
    expect(file?.added).toBe(1);
    expect(file?.removed).toBe(1);
  });

  it("returns no hunks for text that is not a patch (the view shows it plainly)", () => {
    expect(parsePatch("just some text\nwithout hunks").flatMap((f) => f.hunks)).toEqual([]);
  });

  it("computes a minimal line diff with context from before/after", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].join("\n");
    const after = ["a", "b", "c", "d", "E", "f", "g", "h", "i", "j", "k"].join("\n");
    const hunks = diffLines(before, after, 1);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]?.lines.map((l) => `${l.type}:${l.text}`)).toEqual([
      "ctx:d",
      "del:e",
      "add:E",
      "ctx:f",
    ]);
    expect(hunks[1]?.lines.map((l) => `${l.type}:${l.text}`)).toEqual(["ctx:j", "add:k"]);
    expect(hunks[0]?.lines[1]).toMatchObject({ oldNo: 5 });
    expect(hunks[0]?.lines[2]).toMatchObject({ newNo: 5 });
  });

  it("diffs a new file (no before) as all additions and identical text as no hunks", () => {
    const [file] = filesOf({ kind: "diff", path: "n.txt", after: "x\ny\n" });
    expect(file?.status).toBe("added");
    expect(file?.hunks[0]?.lines.map((l) => l.type)).toEqual(["add", "add"]);
    expect(diffLines("same\n", "same\n")).toEqual([]);
  });

  it("pairs deletions with additions for the side-by-side view", () => {
    const [file] = parsePatch("@@ -1,3 +1,3 @@\n keep\n-old1\n-old2\n+new1\n tail");
    const rows = splitRows(file?.hunks[0] ?? { header: "", lines: [] });
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ["keep", "keep"],
      ["old1", "new1"],
      ["old2", null],
      ["tail", "tail"],
    ]);
  });
});

describe("terminal ANSI", () => {
  it("turns SGR sequences into styled spans and resets them", () => {
    const spans = parseAnsi("plain \x1b[1;31mred bold\x1b[0m back \x1b[4munder\x1b[24m end");
    expect(spans.map((s) => s.text).join("")).toBe("plain red bold back under end");
    expect(spans.find((s) => s.text === "red bold")).toMatchObject({ bold: true, fg: 1 });
    expect(spans.find((s) => s.text === " back ")?.fg).toBeUndefined();
    expect(spans.find((s) => s.text === "under")).toMatchObject({ underline: true });
    expect(spans.find((s) => s.text === " end")?.underline).toBeUndefined();
  });

  it("supports bright, 256-color and truecolor foregrounds and backgrounds", () => {
    const spans = parseAnsi("\x1b[92ma\x1b[38;5;196mb\x1b[48;2;1;2;3mc\x1b[39;49md\x1b[38;5;250me");
    expect(spans.map((s) => [s.text, s.fg, s.bg])).toEqual([
      ["a", 10, undefined],
      ["b", "rgb(255,0,0)", undefined],
      ["c", "rgb(255,0,0)", "rgb(1,2,3)"],
      ["d", undefined, undefined],
      ["e", "rgb(188,188,188)", undefined],
    ]);
  });

  it("drops other escapes (cursor moves, OSC titles) and never emits raw ESC", () => {
    const text = parseAnsi("\x1b]0;title\x07a\x1b[2Kb\x1b[?25lc\x1bd")
      .map((s) => s.text)
      .join("");
    expect(text).toBe("abcd");
  });

  it("settles carriage-return progress lines and keeps the visible tail", () => {
    expect(settleCarriageReturns("10%\r50%\r100%\ndone\r\n")).toBe("100%\ndone\n");
    const lines = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
    expect(tailLines(lines, 3)).toEqual({ text: "l7\nl8\nl9", hidden: 7 });
    expect(tailLines("a\nb", 3)).toEqual({ text: "a\nb", hidden: 0 });
  });
});

describe("json model", () => {
  it("builds JSONPath expressions for keys and indexes", () => {
    expect(jsonPath([])).toBe("$");
    expect(jsonPath(["a", 0, "b c", "_ok1"])).toBe('$.a[0]["b c"]._ok1');
  });

  it("lists children with a cap and previews collapsed values", () => {
    const big = Array.from({ length: 1500 }, (_, i) => i);
    const { entries, more } = childEntries(big, 1000);
    expect(entries).toHaveLength(1000);
    expect(more).toBe(500);
    expect(childEntries({ a: 1, b: [2] }).entries.map(([k]) => k)).toEqual(["a", "b"]);
    expect(childEntries("text").entries).toEqual([]);
    expect(jsonPreview({ a: 1, b: 2 })).toBe("{…} 2 keys");
    expect(jsonPreview([1])).toBe("[…] 1 item");
    expect(jsonPreview("x".repeat(200)).length).toBeLessThanOrEqual(82);
    expect(jsonPreview(null)).toBe("null");
  });
});

describe("test results model", () => {
  const block = {
    kind: "test-results" as const,
    suites: [
      {
        name: "a",
        cases: [
          { name: "1", status: "passed" as const },
          { name: "2", status: "failed" as const, error: "boom" },
        ],
      },
      {
        name: "b",
        cases: [
          { name: "3", status: "skipped" as const },
          { name: "4", status: "todo" as const },
        ],
      },
    ],
  };
  it("counts statuses and filters to failing suites and cases", () => {
    expect(summarize(block)).toEqual({ passed: 1, failed: 1, skipped: 1, todo: 1, total: 4 });
    expect(failedOnly(block.suites)).toEqual([
      { name: "a", cases: [{ name: "2", status: "failed", error: "boom" }] },
    ]);
  });
});
