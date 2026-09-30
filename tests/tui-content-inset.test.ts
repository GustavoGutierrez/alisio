import { describe, expect, it } from "vitest";
import { visibleWidth } from "../packages/cli/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
  AssistantBlock,
  ContentInset,
  contentInnerWidth,
  effectiveContentInset,
  MIN_CONTENT_WIDTH,
  TranscriptSync,
} from "../packages/cli/src/tui/components.ts";
import {
  defaultConfig,
  SETTINGS_DEFINITIONS,
  type SettingsMenuInput,
  settingsMenuRows,
} from "../packages/cli/src/tui/settings.ts";
import type { TranscriptItem } from "../packages/cli/src/tui/state.ts";

/** Strips SGR/OSC escapes so alignment can be asserted without color noise. */
const strip = (line: string) =>
  line
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b/g, "");
const plain = (lines: string[]) => lines.map(strip);

const rows = (overrides: Partial<SettingsMenuInput> = {}) =>
  settingsMenuRows(
    { config: defaultConfig, mcpAllowPersisted: false, readOnly: false, ...overrides },
    [],
  );

const assistant = (
  extra: Partial<Extract<TranscriptItem, { kind: "assistant" }>>,
): Extract<TranscriptItem, { kind: "assistant" }> => ({
  kind: "assistant",
  text: "",
  reasoning: "",
  done: true,
  ...extra,
});

describe("transcript content inset", () => {
  it("prefixes every transcript row with the configured inset", () => {
    const sync = new TranscriptSync();
    sync.sync([assistant({ text: "hello world" })]);
    const inset = 3;
    const lines = new ContentInset(sync.container, () => inset).render(80);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(strip(line).startsWith(" ".repeat(inset))).toBe(true);

    const textLine = plain(lines).find((line) => line.includes("hello world"));
    expect(textLine).toBeDefined();
    // Exactly the inset: the content starts one column after it, not floating at the border.
    expect(textLine?.startsWith(" ".repeat(inset))).toBe(true);
    expect(textLine?.[inset]).not.toBe(" ");
  });

  it("keeps every rendered line within the terminal width (no horizontal overflow)", () => {
    const sync = new TranscriptSync();
    sync.sync([
      assistant({ text: "A long answer. ".repeat(12) }),
      { kind: "user", text: "A user message that is long enough to wrap in narrow terminals" },
      {
        kind: "tool",
        id: "c1",
        name: "read_file",
        args: "{}",
        summary: "a.ts",
        status: "ok",
        preview: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"),
      },
    ]);
    for (const width of [120, 80, 60, 40, 30, 24, 21, 19]) {
      for (const inset of [0, 2, 6, 12]) {
        const lines = new ContentInset(sync.container, () => inset).render(width);
        for (const line of lines)
          expect(
            visibleWidth(line),
            `width=${width} inset=${inset} line=${JSON.stringify(strip(line))}`,
          ).toBeLessThanOrEqual(width);
      }
    }
  });

  it("respects the setting at 0 and at a larger value", () => {
    const inner = { render: (w: number) => ["content".slice(0, w)], invalidate: () => {} };
    expect(new ContentInset(inner, () => 0).render(40)).toEqual(["content"]);
    expect(plain(new ContentInset(inner, () => 4).render(40))).toEqual(["    content"]);

    // The shipped default is a real, non-zero inset, and the menu offers 0 and the max.
    expect(defaultConfig.tui.contentPaddingX).toBe(2);
    const row = rows().find((r) => r.id === "tui.contentPaddingX");
    expect(row?.current).toBe(2);
    expect(row?.values).toEqual(expect.arrayContaining([0, 12]));
  });

  it("clamps the effective inset on narrow terminals, keeping the inner width usable", () => {
    expect(MIN_CONTENT_WIDTH).toBe(20);
    // Plenty of room: the configured inset applies unchanged.
    expect(effectiveContentInset(80, 12)).toBe(12);
    expect(contentInnerWidth(80, 12)).toBe(56);
    // Narrowing clamps the inset so the inner column never drops below the floor.
    expect(effectiveContentInset(40, 12)).toBe(10);
    expect(contentInnerWidth(40, 12)).toBe(20);
    expect(effectiveContentInset(24, 12)).toBe(2);
    expect(contentInnerWidth(24, 12)).toBe(20);
    expect(effectiveContentInset(20, 12)).toBe(0);
    expect(contentInnerWidth(20, 12)).toBe(20);
    // Below the floor the inset degrades to 0 rather than overflowing; inner width stays positive.
    expect(effectiveContentInset(19, 12)).toBe(0);
    expect(contentInnerWidth(19, 12)).toBe(19);
    expect(contentInnerWidth(1, 12)).toBe(1);
    expect(contentInnerWidth(0, 12)).toBe(1);
  });

  it("hands children a stable reduced width so per-row caches stay effective", () => {
    const widths: number[] = [];
    const inner = {
      render: (w: number) => {
        widths.push(w);
        return ["row"];
      },
      invalidate: () => {},
    };
    const wrapped = new ContentInset(inner, () => 2);
    wrapped.render(60);
    wrapped.render(60);
    expect(widths).toEqual([56, 56]);
    // Only a terminal resize changes the width the block sees; its cache then invalidates.
    wrapped.render(70);
    expect(widths).toEqual([56, 56, 66]);

    // End to end: the assistant row's cached lines survive repeated wrapped renders at one width.
    const block = new AssistantBlock(assistant({ text: "answer" }));
    const blockWrapped = new ContentInset(block, () => 2);
    const first = blockWrapped.render(60);
    const second = blockWrapped.render(60);
    expect(plain(second)).toEqual(plain(first));
  });

  it("keeps the editor padding setting unchanged and independent from the content inset", () => {
    // `tui.paddingX` keeps its editor-only meaning, bounds and default.
    expect(defaultConfig.tui.paddingX).toBe(1);
    const editor = SETTINGS_DEFINITIONS.find((def) => def.id === "tui.paddingX");
    const content = SETTINGS_DEFINITIONS.find((def) => def.id === "tui.contentPaddingX");
    expect(editor?.label).toBe("Editor padding");
    expect(content?.label).toBe("Content inset");

    const configured = rows({
      config: {
        ...defaultConfig,
        tui: { paddingX: 4, contentPaddingX: 0, skillSlashCommands: true },
      },
    });
    // Reading one setting never derives from the other.
    expect(configured.find((r) => r.id === "tui.paddingX")?.current).toBe(4);
    expect(configured.find((r) => r.id === "tui.contentPaddingX")?.current).toBe(0);
  });
});
