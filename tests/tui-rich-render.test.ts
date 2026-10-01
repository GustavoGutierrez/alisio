import type { Message, RunEvent, ToolResult } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
// Tests must not import `@earendil-works/pi-tui` by name (the root package does not declare
// it); the cli package's copy is ESM and module-identical to the one components.ts uses, so
// capability overrides here apply to the very module the ToolBlock reads.
import {
  resetCapabilitiesCache,
  setCapabilities,
} from "../packages/cli/node_modules/@earendil-works/pi-tui/dist/index.js";
import { renderUiBlock, ToolBlock } from "../packages/cli/src/tui/components.ts";
import {
  initialViewState,
  isUiBlock,
  itemsFromHistory,
  reduceEvent,
  type TranscriptItem,
  type ViewState,
} from "../packages/cli/src/tui/state.ts";

const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
  resetCapabilitiesCache();
});
const setEnv = (key: string, value: string | undefined = undefined) => {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
};

/** Strips SGR/OSC escapes so alignment can be asserted without color noise. */
const strip = (line: string) =>
  line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "");
const plain = (lines: string[]) => lines.map(strip);

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const tool = (
  extra: Partial<Extract<TranscriptItem, { kind: "tool" }>>,
): Extract<TranscriptItem, { kind: "tool" }> => ({
  kind: "tool",
  id: "c1",
  name: "mcp_table",
  args: "{}",
  summary: "…",
  status: "ok",
  ...extra,
});

describe("renderUiBlock — table", () => {
  it("aligns columns and emphasizes the header", () => {
    const lines = plain(
      renderUiBlock(
        {
          kind: "table",
          columns: ["name", "count"],
          rows: [
            ["parse", "12"],
            ["render", "300"],
          ],
        },
        80,
        true,
      ),
    );
    expect(lines[0]).toBe("name   | count");
    expect(lines[1]).toContain("─");
    expect(lines.slice(2).map((l) => l.trim())).toContain("parse  | 12");
    expect(lines.slice(2).map((l) => l.trim())).toContain("render | 300");
  });

  it("wraps long cells to the column width instead of losing them", () => {
    const lines = plain(
      renderUiBlock(
        {
          kind: "table",
          columns: ["k", "v"],
          rows: [["short", "a very long value that cannot fit in the narrow column"]],
        },
        30,
        true,
      ),
    );
    // The long value is preserved but split across wrapped continuation rows.
    expect(lines.join("\n")).toContain("a very long value");
    expect(lines.join("\n")).toContain("cannot fit");
    expect(lines.length).toBeGreaterThan(4); // header + separator + at least two value rows
  });

  it("renders an optional dim caption first", () => {
    const lines = renderUiBlock(
      { kind: "table", columns: ["a"], rows: [["1"]], caption: "bench" },
      80,
      true,
    );
    expect(strip(lines[0] ?? "")).toBe("bench");
    expect(lines[0]).toContain("\x1b[2m"); // dim
  });
});

describe("renderUiBlock — key-value", () => {
  it("renders two aligned columns", () => {
    const lines = plain(
      renderUiBlock(
        {
          kind: "key-value",
          entries: [
            ["name", "alisio"],
            ["turns", "3"],
          ],
        },
        60,
        true,
      ),
    );
    expect(lines.map((l) => l.trim())).toEqual(["name   alisio", "turns  3"]);
  });
});

describe("renderUiBlock — tree", () => {
  it("uses branch glyphs on Unicode terminals and ASCII fallbacks otherwise", () => {
    setEnv("LANG", "en_US.UTF-8");
    const unicode = renderUiBlock(
      { kind: "tree", nodes: [{ label: "root", children: [{ label: "leaf", meta: "2" }] }] },
      80,
      true,
    );
    expect(plain(unicode).join("\n")).toContain("└─ root");
    expect(plain(unicode).join("\n")).toContain("   └─ leaf (2)");

    const ascii = renderUiBlock(
      { kind: "tree", nodes: [{ label: "root", children: [{ label: "leaf" }] }] },
      80,
      false,
    );
    expect(plain(ascii).join("\n")).toContain("`- root");
    expect(plain(ascii).join("\n")).toContain("   `- leaf");
  });

  it("uses ├─ for non-last siblings", () => {
    const lines = plain(
      renderUiBlock({ kind: "tree", nodes: [{ label: "a" }, { label: "b" }] }, 80, true),
    );
    expect(lines[0]).toBe("├─ a");
    expect(lines[1]).toBe("└─ b");
  });
});

describe("renderUiBlock — code and markdown", () => {
  it("reuses the syntax highlighter inside a dim fence", () => {
    const lines = renderUiBlock({ kind: "code", lang: "json", code: '{"a": 1}' }, 80, true);
    expect(strip(lines[0] ?? "")).toBe("```json");
    expect(strip(lines.at(-1) ?? "")).toBe("```");
    expect(plain(lines).join("\n")).toContain('"a"'); // property + string tokens survive
    expect(lines.some((l) => l.includes("\x1b[96m") || l.includes("\x1b[32m"))).toBe(true);
  });

  it("renders markdown blocks through the Markdown renderer", () => {
    const lines = plain(
      renderUiBlock({ kind: "markdown", text: "# Title\n\nrow **bold**" }, 60, true),
    );
    expect(lines.join(" ")).toContain("Title");
    expect(lines.join(" ")).toContain("bold");
  });
});

describe("ToolBlock rich rendering", () => {
  it("renders a ui table block indented under the tool head", () => {
    const lines = plain(
      new ToolBlock(
        tool({
          ui: { kind: "table", columns: ["a", "b"], rows: [["1", "2"]] },
          preview: "raw projection line that must NOT render",
        }),
      ).render(80),
    );
    expect(lines[0]).toContain("✓");
    expect(lines.slice(1)).toContain("  a | b");
    expect(lines.slice(1)).toContain("  1 | 2");
    // Native block replaces the plain preview.
    expect(lines.some((l) => l.includes("raw projection line"))).toBe(false);
  });

  it("shows an image placeholder when the terminal cannot render images", () => {
    setCapabilities({ images: null, trueColor: false, hyperlinks: false });
    const lines = plain(
      new ToolBlock(tool({ image: { mimeType: "image/png", data: PNG_1PX } })).render(80),
    );
    const placeholder = lines.find((l) => l.includes("[image: image/png"));
    expect(placeholder).toBeDefined();
    expect(placeholder).toContain("1x1"); // natural dimensions from the PNG header
  });

  it("emits an inline image escape when the terminal supports iterm2 images", () => {
    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const lines = new ToolBlock(tool({ image: { mimeType: "image/png", data: PNG_1PX } })).render(
      80,
    );
    expect(lines.join("\n")).toContain("\x1b]1337");
  });

  it("falls back to the placeholder under NO_COLOR even when images are supported", () => {
    setEnv("NO_COLOR", "1");
    setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: false });
    const lines = new ToolBlock(tool({ image: { mimeType: "image/png", data: PNG_1PX } })).render(
      80,
    );
    expect(lines.join("\n")).toContain("[image: image/png");
    expect(lines.join("\n")).not.toContain("\x1b]1337");
  });

  it("renders ui blocks without color when NO_COLOR is set before first import", async () => {
    // The theme styles read NO_COLOR at module load, so simulate a fresh process with NO_COLOR.
    setEnv("NO_COLOR", "1");
    setEnv("LC_ALL");
    setEnv("LC_CTYPE");
    setEnv("LANG", "en_US.UTF-8"); // the glyphs asserted below need a Unicode locale, not the host's
    vi.resetModules();
    const fresh = await import("../packages/cli/src/tui/components.ts");
    const lines = new fresh.ToolBlock(
      tool({
        ui: { kind: "tree", nodes: [{ label: "a", children: [{ label: "b", meta: "2" }] }] },
      }),
    ).render(80);
    expect(lines.join("\n")).not.toContain("\x1b");
    expect(plain(lines).join("\n")).toContain("└─ a");
    expect(plain(lines).join("\n")).toContain("└─ b (2)");
  });

  it("keeps the plain preview when no ui/image parts exist", () => {
    const lines = plain(new ToolBlock(tool({ preview: "plain preview" })).render(80));
    expect(lines.some((l) => l.includes("plain preview"))).toBe(true);
  });
});

let seq = 0;
const ev = (type: string, data: unknown): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp: "2026-01-01T00:00:00.000Z",
  data,
});

describe("state round trip (ui/image survive events and history)", () => {
  it("reduceEvent attaches ui/image from enriched tool_completed events", () => {
    let view: ViewState = initialViewState("m");
    view = reduceEvent(view, ev("tool_started", { id: "c1", name: "mcp_table", arguments: "{}" }));
    view = reduceEvent(
      view,
      ev("tool_completed", {
        id: "c1",
        name: "mcp_table",
        isError: false,
        preview: "text only",
        ui: { kind: "table", columns: ["a"], rows: [["1"]] },
        image: { mimeType: "image/png", data: PNG_1PX },
      }),
    );
    const item = view.items.find((i) => i.kind === "tool");
    expect(item).toMatchObject({
      kind: "tool",
      ui: { kind: "table", columns: ["a"], rows: [["1"]] },
      image: { mimeType: "image/png", data: PNG_1PX },
      preview: "text only",
    });
  });

  it("rejects malformed ui payloads (defensive guard)", () => {
    expect(isUiBlock({ kind: "table", columns: "nope", rows: [] })).toBe(false);
    expect(isUiBlock({ kind: "bogus" })).toBe(false);
    expect(isUiBlock({ kind: "tree", nodes: [{ label: "x", children: "bad" }] })).toBe(false);
    expect(isUiBlock({ kind: "key-value", entries: [["k"]] })).toBe(false);
    expect(isUiBlock({ kind: "code", code: "x" })).toBe(true);
    expect(isUiBlock({ kind: "markdown", text: "# t" })).toBe(true);
  });

  it("itemsFromHistory replays ui/image parts from persisted tool results", () => {
    const rich: ToolResult = {
      content: [
        { type: "text", text: "projection" },
        { type: "ui", block: { kind: "tree", nodes: [{ label: "root" }] } },
        { type: "image", mimeType: "image/png", data: PNG_1PX },
      ],
    };
    const messages: Message[] = [
      { role: "user", text: "list" },
      { role: "assistant", text: "ok", calls: [{ id: "c1", name: "rich", arguments: "{}" }] },
      { role: "tool", callId: "c1", result: rich },
    ];
    const items = itemsFromHistory(messages);
    const toolItem = items.find((i) => i.kind === "tool");
    expect(toolItem).toMatchObject({
      kind: "tool",
      status: "ok",
      ui: { kind: "tree", nodes: [{ label: "root" }] },
      image: { mimeType: "image/png", data: PNG_1PX },
      preview: "projection",
    });
  });

  it("itemsFromHistory keeps a text-only tool result free of ui/image fields", () => {
    const messages: Message[] = [
      { role: "user", text: "hi" },
      { role: "assistant", text: "ok", calls: [{ id: "c1", name: "plain", arguments: "{}" }] },
      { role: "tool", callId: "c1", result: { content: [{ type: "text", text: "out" }] } },
    ];
    const item = itemsFromHistory(messages).find((i) => i.kind === "tool");
    expect(item).toMatchObject({ kind: "tool", preview: "out" });
    if (item?.kind === "tool") {
      expect(item.ui).toBeUndefined();
      expect(item.image).toBeUndefined();
    }
  });
});
