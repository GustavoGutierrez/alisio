import { UI_BLOCK_KINDS, type UiBlock } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { renderUiBlock } from "../packages/cli/src/tui/components.ts";
import { isUiBlock } from "../packages/cli/src/tui/state.ts";
import { renderUiBlockText } from "../packages/core/src/mcp/rich.ts";

/** Strips SGR/OSC escapes so assertions read the visible text only. */
const strip = (line: string) =>
  line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "");
const visible = (lines: string[]) => lines.map(strip).join("\n");

/** One representative block per kind; the mapped type makes a missing kind a type error. */
const samples: { [K in UiBlock["kind"]]: Extract<UiBlock, { kind: K }> } = {
  table: { kind: "table", columns: ["a"], rows: [["1"]] },
  "key-value": { kind: "key-value", entries: [["k", "v"]] },
  tree: { kind: "tree", nodes: [{ label: "root" }] },
  code: { kind: "code", lang: "ts", code: "const x = 1;" },
  markdown: { kind: "markdown", text: "# Title" },
  diff: {
    kind: "diff",
    path: "src/a.ts",
    patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old line\n+new line",
  },
  terminal: {
    kind: "terminal",
    command: "pnpm test",
    output: "\x1b[32mok\x1b[0m all good",
    exitCode: 1,
    durationMs: 1234,
  },
  mermaid: { kind: "mermaid", source: "graph TD; A-->B", title: "flow" },
  math: { kind: "math", latex: "e^{i\\pi} + 1 = 0", display: true },
  json: { kind: "json", value: { answer: 42, list: [1, 2] }, caption: "payload" },
  "test-results": {
    kind: "test-results",
    framework: "vitest",
    durationMs: 50,
    suites: [
      {
        name: "math",
        file: "tests/math.test.ts",
        cases: [
          { name: "adds", status: "passed", durationMs: 3 },
          { name: "divides", status: "failed", error: "expected 2", line: 12 },
          { name: "later", status: "skipped" },
        ],
      },
    ],
  },
  progress: {
    kind: "progress",
    title: "Deploy",
    steps: [
      { label: "build", status: "completed" },
      { label: "upload", status: "running", detail: "42%" },
      { label: "verify", status: "pending" },
      { label: "notify", status: "failed" },
      { label: "cleanup", status: "cancelled" },
    ],
  },
  artifact: {
    kind: "artifact",
    artifact: {
      id: "art_01JZ",
      sessionId: "s",
      title: "Report",
      fileName: "report.md",
      kind: "document",
      mimeType: "text/markdown; charset=utf-8",
      bytes: 2048,
      fileCount: 1,
      previewable: true,
      createdAt: 1,
      status: "ready",
    },
  },
};

const NEW_KINDS = [
  "diff",
  "terminal",
  "mermaid",
  "math",
  "json",
  "test-results",
  "progress",
  "artifact",
] as const satisfies readonly UiBlock["kind"][];

describe("UI_BLOCK_KINDS (SDK)", () => {
  it("lists every UiBlock kind exactly once", () => {
    expect([...UI_BLOCK_KINDS].sort()).toEqual(Object.keys(samples).sort());
    expect(new Set(UI_BLOCK_KINDS).size).toBe(UI_BLOCK_KINDS.length);
  });
});

describe("TUI fallbacks for new UiBlock kinds (T-03)", () => {
  for (const kind of NEW_KINDS) {
    it(`renders non-empty text for ${kind}`, () => {
      const block = samples[kind];
      expect(isUiBlock(block)).toBe(true);
      for (const unicode of [true, false]) {
        const text = visible(renderUiBlock(block, 80, unicode));
        expect(text.trim().length).toBeGreaterThan(0);
      }
    });
  }

  it("shows a unified diff patch with its path", () => {
    const text = visible(renderUiBlock(samples.diff, 80, true));
    expect(text).toContain("src/a.ts");
    expect(text).toContain("-old line");
    expect(text).toContain("+new line");
  });

  it("labels before/after when a diff has no patch", () => {
    const text = visible(
      renderUiBlock({ kind: "diff", before: "one", after: "two", lang: "txt" }, 80, true),
    );
    expect(text).toContain("before");
    expect(text).toContain("one");
    expect(text).toContain("after");
    expect(text).toContain("two");
  });

  it("strips ANSI from terminal output and reports exit code and duration", () => {
    const lines = renderUiBlock(samples.terminal, 80, true).map(strip);
    const text = lines.join("\n");
    expect(text).toContain("pnpm test");
    expect(text).toContain("ok all good");
    expect(text).not.toContain("[32m");
    expect(text).toMatch(/exit 1 · 1\.2s|exit 1 · 1234ms/);
  });

  it("marks truncated terminal output", () => {
    const text = visible(
      renderUiBlock({ kind: "terminal", output: "partial", truncated: true }, 80, true),
    );
    expect(text).toContain("truncated");
  });

  it("keeps mermaid source and math LaTeX literal", () => {
    expect(visible(renderUiBlock(samples.mermaid, 80, true))).toContain("A-->B");
    expect(visible(renderUiBlock(samples.math, 80, true))).toContain("e^{i\\pi} + 1 = 0");
  });

  it("pretty-prints json values and truncates huge ones", () => {
    const text = visible(renderUiBlock(samples.json, 80, true));
    expect(text).toContain('"answer": 42');
    const huge = { kind: "json" as const, value: Array.from({ length: 5_000 }, (_, i) => i) };
    const lines = renderUiBlock(huge, 80, true).map(strip);
    expect(lines.length).toBeLessThan(400);
    expect(lines.join("\n")).toContain("truncated");
  });

  it("renders json values that JSON cannot serialize without throwing", () => {
    const text = visible(renderUiBlock({ kind: "json", value: undefined }, 80, true));
    expect(text).toContain("undefined");
  });

  it("tabulates test results with suite, case and status", () => {
    const text = visible(renderUiBlock(samples["test-results"], 120, true));
    expect(text).toContain("math");
    expect(text).toContain("adds");
    expect(text).toContain("failed");
    expect(text).toMatch(/1 passed/);
    expect(text).toMatch(/1 failed/);
  });

  it("lists progress steps with status glyphs (ASCII fallback without unicode)", () => {
    const unicode = visible(renderUiBlock(samples.progress, 80, true));
    expect(unicode).toContain("Deploy");
    expect(unicode).toContain("✓ build");
    expect(unicode).toContain("● upload");
    expect(unicode).toContain("42%");
    expect(unicode).toContain("○ verify");
    expect(unicode).toContain("✗ notify");
    const ascii = visible(renderUiBlock(samples.progress, 80, false));
    expect(ascii).not.toMatch(/[✓●○✗]/);
    expect(ascii).toContain("build");
  });

  it("announces an artifact on one line with its kind, name and size (ASCII without unicode)", () => {
    expect(visible(renderUiBlock(samples.artifact, 80, true))).toContain(
      "Document  report.md  2 KB",
    );
    expect(visible(renderUiBlock(samples.artifact, 80, false))).toContain("[M] Document");
    expect(isUiBlock({ kind: "artifact", artifact: { id: 1 } })).toBe(false);
  });

  it("falls back to text for an unknown kind instead of throwing", () => {
    const unknown = { kind: "hologram", payload: { x: 1 } } as unknown as UiBlock;
    expect(isUiBlock(unknown)).toBe(false);
    let lines: string[] = [];
    expect(() => {
      lines = renderUiBlock(unknown, 80, true);
    }).not.toThrow();
    expect(visible(lines)).toContain("hologram");
  });

  it("falls back to text for a malformed known kind instead of throwing", () => {
    const malformed = { kind: "diff", patch: 42 } as unknown as UiBlock;
    expect(isUiBlock(malformed)).toBe(false);
    expect(() => renderUiBlock(malformed, 80, true)).not.toThrow();
    expect(visible(renderUiBlock(malformed, 80, true))).toContain("diff");
  });

  it("rejects new kinds with invalid statuses", () => {
    expect(isUiBlock({ kind: "progress", steps: [{ label: "x", status: "exploded" }] })).toBe(
      false,
    );
    expect(
      isUiBlock({
        kind: "test-results",
        suites: [{ name: "s", cases: [{ name: "c", status: "maybe" }] }],
      }),
    ).toBe(false);
  });
});

describe("plain-text projection of UiBlocks (core)", () => {
  for (const kind of UI_BLOCK_KINDS) {
    it(`projects ${kind} to non-empty text`, () => {
      const text = renderUiBlockText(samples[kind]);
      expect(typeof text).toBe("string");
      expect(text.trim().length).toBeGreaterThan(0);
      expect(text).not.toContain("\x1b[");
    });
  }

  it("projects an unknown kind without throwing", () => {
    const text = renderUiBlockText({ kind: "hologram" } as unknown as UiBlock);
    expect(text).toContain("hologram");
  });
});
