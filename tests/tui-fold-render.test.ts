import { afterEach, describe, expect, it, vi } from "vitest";
import { resetCapabilitiesCache } from "../packages/cli/node_modules/@earendil-works/pi-tui/dist/index.js";
import {
  AssistantBlock,
  clock,
  ToolBlock,
  ToolGroupBlock,
  TranscriptSync,
} from "../packages/cli/src/tui/components.ts";
import type { TranscriptItem } from "../packages/cli/src/tui/state.ts";
import {
  groupToolEntries,
  initialViewState,
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

const assistant = (
  extra: Partial<Extract<TranscriptItem, { kind: "assistant" }>>,
): Extract<TranscriptItem, { kind: "assistant" }> => ({
  kind: "assistant",
  text: "",
  reasoning: "",
  done: true,
  ...extra,
});

const tool = (
  extra: Partial<Extract<TranscriptItem, { kind: "tool" }>>,
): Extract<TranscriptItem, { kind: "tool" }> => ({
  kind: "tool",
  id: "c1",
  name: "read_file",
  args: "{}",
  summary: "a.ts",
  status: "ok",
  ...extra,
});

describe("AssistantBlock reasoning collapsible", () => {
  const head = (block: AssistantBlock, width = 80) => {
    const lines = plain(block.render(width));
    // Assistant rows start with a blank spacer line; the reasoning header follows it.
    return { lines, header: lines[1] ?? "" };
  };

  it("collapses finished reasoning to `+ Thought · 2.9s`", () => {
    const block = new AssistantBlock(
      assistant({
        reasoning: "let me think",
        text: "answer",
        reasoningStartedAt: 1_000,
        reasoningDoneAt: 3_900,
      }),
    );
    block.fold = { expanded: false, kind: "reasoning" };
    const { lines, header } = head(block);
    expect(header).toBe("+ Thought · 2.9s");
    expect(lines.some((l) => l.includes("let me think"))).toBe(false); // collapsed body
    expect(lines.at(-1)).toContain("/copy");
  });

  it("expands to the reasoning text bounded, with a truncation note for long sections", () => {
    const reasoning = Array.from({ length: 60 }, (_, i) => `line ${i} of reasoning`).join("\n");
    const block = new AssistantBlock(assistant({ reasoning, text: "answer" }));
    block.fold = { expanded: true, kind: "reasoning" };
    const { lines, header } = head(block);
    expect(header).toBe("− Thought");
    expect(lines.some((l) => l.includes("line 0 of reasoning"))).toBe(true);
    expect(lines.some((l) => l.includes("reasoning truncated"))).toBe(true);
  });

  it("shows a collapsed header without duration for replayed history", () => {
    const block = new AssistantBlock(assistant({ reasoning: "r", text: "a" }));
    expect(head(block).header).toBe("+ Thought");
  });

  it("keeps the live thinking view while reasoning streams", () => {
    const block = new AssistantBlock(assistant({ reasoning: "thinking…", text: "", done: false }));
    const lines = plain(block.render(80));
    expect(lines.some((l) => l.includes("✻ thinking…"))).toBe(true);
    expect(lines.some((l) => l.includes("thinking…"))).toBe(true);
  });
});

describe("ToolBlock singleton rows", () => {
  it("displays the humanized tool name", () => {
    const lines = plain(
      new ToolBlock(tool({ name: "search_text", summary: '"x" in src' })).render(80),
    );
    expect(lines[0]).toContain("✓ Search Text");
    expect(lines[0]).not.toContain("search_text");
  });

  it("does not fold a preview that fits the collapsed cap", () => {
    const block = new ToolBlock(tool({ preview: "1\n2\n3" }));
    const lines = plain(block.render(80));
    expect(lines[1]).toContain("⎿ 1");
    expect(lines.some((l) => l.includes("more lines"))).toBe(false);
    expect(lines[0]).not.toContain("+");
  });

  it("folds a truncated preview with the cap, `… N more lines` and a `+` marker", () => {
    const block = new ToolBlock(tool({ preview: "1\n2\n3\n4\n5\n6\n7\n8" }));
    block.fold = { expanded: false, kind: "output" };
    const lines = plain(block.render(80));
    // Caps at 3 clean rows for ok status (plus the 7-3 more-lines footer).
    expect(lines.filter((l) => /^\s\s[⎿ ] \d$/.test(l))).toHaveLength(3);
    expect(lines.some((l) => l.includes("5 more lines"))).toBe(true);
    expect(lines.at(0)).toContain("+");
    expect(lines.some((l) => l.includes("4"))).toBe(false); // collapsed body hidden
  });

  it("expands to the full output and switches the marker to −", () => {
    const block = new ToolBlock(tool({ preview: "1\n2\n3\n4\n5" }));
    block.fold = { expanded: true, kind: "output" };
    const lines = plain(block.render(80));
    expect(lines.at(0)).toContain("−");
    expect(lines.some((l) => l.endsWith("5"))).toBe(true);
    expect(lines.some((l) => l.includes("more lines"))).toBe(false);
  });

  it("appends an exit-code line, green for 0 and red otherwise", () => {
    const ok = new ToolBlock(tool({ preview: "out", exitCode: 0 }));
    const okLine = ok.render(80).at(-1) ?? "";
    expect(strip(okLine)).toBe("  Command exited with code 0.");
    expect(okLine).toContain("\x1b[32m"); // green

    const fail = new ToolBlock(tool({ preview: "boom", exitCode: 1 }));
    const failLine = fail.render(80).at(-1) ?? "";
    expect(strip(failLine)).toBe("  Command exited with code 1.");
    expect(failLine).toContain("\x1b[31m"); // red
  });

  it("keeps edit diffs and error previews exactly as before", () => {
    const edit = new ToolBlock(
      tool({
        name: "write_file",
        args: JSON.stringify({ path: "n.ts", content: "a\nb\n" }),
        summary: "n.ts",
        preview: "wrote",
      }),
    );
    const lines = plain(edit.render(80));
    expect(lines[1]).toContain("+2");
    expect(lines.slice(2).some((l) => l.includes("+ a"))).toBe(true);

    const err = new ToolBlock(
      tool({
        name: "shell",
        summary: "ls",
        status: "error",
        preview: "e1\ne2\ne3\ne4\ne5\ne6\ne7\ne8",
      }),
    );
    const errLines = plain(err.render(80));
    expect(errLines.filter((l) => /^\s\s[⎿ ] e\d$/.test(l))).toHaveLength(6); // error cap
    expect(errLines.some((l) => l.includes("2 more lines"))).toBe(true);
  });

  it("keeps rich ui/image rendering in singleton rows", () => {
    const block = new ToolBlock(
      tool({
        name: "mcp_table",
        summary: "…",
        preview: "raw",
        ui: { kind: "table", columns: ["a"], rows: [["1"]] },
      }),
    );
    const lines = plain(block.render(80));
    expect(lines[0]).toContain("✓ MCP · Table");
    expect(lines.slice(1)).toContain("  a");
    expect(lines.some((l) => l.includes("raw"))).toBe(false); // rich replaces preview
  });
});

describe("ToolGroupBlock grouped rows", () => {
  const batch = () => {
    const items: TranscriptItem[] = [
      tool({ id: "c1", durationMs: 10 }),
      tool({ id: "c2", durationMs: 20 }),
      tool({ id: "c3", durationMs: 30 }),
    ];
    const entry = groupToolEntries(items)[0];
    if (!entry || entry.entry.kind !== "group") throw new Error("expected group");
    return entry.entry.group;
  };

  it("renders a collapsed aggregate header with count, kind word and total duration", () => {
    const block = new ToolGroupBlock(batch());
    block.fold = { expanded: false, kind: "group" };
    const lines = plain(block.render(80));
    expect(lines[0]).toContain("+ ✓ Read File — 3 reads · 60ms");
    expect(lines).toHaveLength(1);
  });

  it("expands into one detail row per call with machine names dimmed", () => {
    const block = new ToolGroupBlock(batch());
    block.fold = { expanded: true, kind: "group" };
    const lines = plain(block.render(80));
    expect(lines[0]).toContain("− ✓ Read File — 3 reads · 60ms");
    const detail = lines.slice(1);
    expect(detail).toHaveLength(3);
    expect(detail[0]).toContain("✓ Read File");
    expect(detail[0]).toContain("(read_file)"); // machine name kept in detail
    expect(detail[0]).toContain("10ms");
    expect(detail[0]).toContain("a.ts");
  });

  it("uses the kind verb for mixed-name batches and ✗ when any member failed", () => {
    const items: TranscriptItem[] = [
      tool({ id: "c1", summary: "a" }),
      tool({ id: "c2", name: "search_text", summary: '"x"', status: "error" }),
    ];
    const entry = groupToolEntries(items)[0];
    if (!entry || entry.entry.kind !== "group") throw new Error("expected group");
    const block = new ToolGroupBlock(entry.entry.group);
    const lines = plain(block.render(80));
    expect(lines[0]).toContain("Explored — 2 reads");
    expect(lines[0]).toContain("✗");
    expect(lines[0]).not.toContain("✓");
  });

  it("renders member previews capped and exit-code lines inside the detail", () => {
    const items: TranscriptItem[] = [
      tool({
        id: "c1",
        name: "shell",
        summary: "make",
        preview: "o1\no2\no3\no4",
        exitCode: 0,
      }),
      tool({
        id: "c2",
        name: "shell",
        summary: "test",
        preview: "t1\nt2\nt3\nt4\nt5",
        exitCode: 1,
      }),
    ];
    const entry = groupToolEntries(items)[0];
    if (!entry || entry.entry.kind !== "group") throw new Error("expected group");
    const block = new ToolGroupBlock(entry.entry.group);
    block.fold = { expanded: true, kind: "group" };
    const lines = plain(block.render(80));
    expect(lines[0]).toContain("− ✓ Shell — 2 commands");
    expect(lines.join("\n")).toContain("Command exited with code 0.");
    expect(lines.join("\n")).toContain("Command exited with code 1.");
    expect(lines.join("\n")).toContain("1 more lines"); // 4 vs 3-line cap per member
  });

  it("keeps rich ui rendering inside expanded group detail", () => {
    const items: TranscriptItem[] = [
      tool({ id: "c1", name: "mcp_table", summary: "…" }),
      tool({
        id: "c2",
        name: "mcp_kv",
        summary: "…",
        ui: { kind: "key-value", entries: [["k", "v"]] },
      }),
    ];
    const entry = groupToolEntries(items)[0];
    if (!entry || entry.entry.kind !== "group") throw new Error("expected group");
    const block = new ToolGroupBlock(entry.entry.group);
    block.fold = { expanded: true, kind: "group" };
    const lines = plain(block.render(80));
    expect(lines.at(0)).toContain("Queried — 2 calls");
    expect(lines.some((l) => l.includes("k  v"))).toBe(true);
  });
});

describe("TranscriptSync integration", () => {
  it("merges a finished batch of reads into one row and expands members on demand", () => {
    const sync = new TranscriptSync();
    const items: TranscriptItem[] = [
      tool({ id: "c1" }),
      tool({ id: "c2" }),
      tool({ id: "c3" }),
      { kind: "assistant", text: "done", reasoning: "r", done: true },
    ];
    sync.setFoldResolver((candidate) => candidate.key === "g:c1");
    sync.sync(items);
    const lines = plain(sync.container.render(80));
    // One group row (+ harness rows) and the assistant's collapsed thought header.
    expect(lines.at(0)).toContain("✓ Read File — 3 reads");
    expect(lines.some((l) => l.includes("+ Thought"))).toBe(true);

    // Toggling the group's fold state through the resolver re-renders the detail.
    sync.setFoldResolver((candidate) => candidate.key === "g:c1" || true);
    sync.sync(items);
    const expanded = plain(sync.container.render(80));
    expect(expanded.some((l) => l.includes("(read_file)"))).toBe(true);
  });

  it("merges singleton rows into a group once the batch finishes (row count shrinks)", () => {
    const sync = new TranscriptSync();
    const running = [tool({ id: "c1", status: "running" }), tool({ id: "c2", status: "running" })];
    sync.sync(running);
    expect(sync.container.render(80)).toHaveLength(2);

    const finished = running.map((i): TranscriptItem => ({ ...i, status: "ok" }));
    sync.sync(finished);
    expect(sync.container.render(80)).toHaveLength(1);
    expect(plain(sync.container.render(80))[0]).toContain("Read File — 2 reads");
  });

  it("caches rendered lines per content version and reuses them on later renders", () => {
    // Component level: a terminal singleton/group row returns the very same line array until
    // content changes — clock frames between events do no rendering work.
    const block = new ToolGroupBlock(
      (() => {
        const entry = groupToolEntries([tool({ id: "c1" }), tool({ id: "c2" })])[0];
        if (!entry || entry.entry.kind !== "group") throw new Error("expected group");
        return entry.entry.group;
      })(),
    );
    const first = block.render(80);
    const second = block.render(80);
    expect(second).toBe(first);
    // Version bump invalidates the cache for this row.
    block.version++;
    expect(block.render(80)).not.toBe(first);

    // Sync level: rows are reused by key, only changed content re-renders.
    const sync = new TranscriptSync();
    sync.sync([tool({ id: "c1" }), tool({ id: "c2" })]);
    sync.sync([tool({ id: "c1" }), tool({ id: "c2" }), { kind: "user", text: "next" }]);
    expect(sync.container.render(80).length).toBe(3); // group row + user block (spacer + line)
  });

  it("preserves externally added children (startup banner) across syncs", () => {
    const sync = new TranscriptSync();
    sync.sync([tool({ id: "c1" })]);
    const banner = { render: () => ["BANNER"], invalidate: () => {} };
    sync.container.addChild(banner);
    sync.sync([tool({ id: "c1" }), tool({ id: "c2" })]);
    const lines = plain(sync.container.render(80));
    expect(lines[0]).toBe("BANNER");
    expect(lines[1]).toContain("Read File — 2 reads");
  });

  it("maps clicks to fold candidates via entryAt", () => {
    const sync = new TranscriptSync();
    sync.sync([
      { kind: "assistant", text: "a", reasoning: "r", done: true }, // spacer, + Thought, answer, hint
      tool({ id: "c1" }),
      tool({ id: "c2" }),
    ]);
    // Row 1 = the `+ Thought` header (assistant header clickable over its two first rows).
    expect(sync.entryAt(1, 80)?.key).toBe("a:0");
    // Row 4 = the collapsed group header; rows in between are assistant body — no toggle.
    expect(sync.entryAt(2, 80)).toBeUndefined();
    expect(sync.entryAt(4, 80)).toMatchObject({ key: "g:c1", kind: "group" });
    // Clicking far past the end maps to nothing.
    expect(sync.entryAt(99, 80)).toBeUndefined();

    const single = new TranscriptSync();
    single.sync([tool({ id: "c9", preview: "1\n2\n3\n4" })]);
    expect(single.entryAt(0, 80)).toMatchObject({ key: "t:c9", kind: "output" });
    expect(single.entryAt(2, 80)).toBeUndefined(); // preview rows do not toggle
  });

  it("streaming state stays intact and running rows keep animating", () => {
    const sync = new TranscriptSync();
    const running = tool({ status: "running" });
    const block = new ToolBlock(running);
    const frameA = block.render(80);
    clock.frame++;
    const frameB = block.render(80);
    expect(frameA).not.toBe(frameB); // spinner advances on clock frames
    sync.sync([running]);
    expect(sync.container.render(80)).toHaveLength(1);
  });

  it("no regression on a full streaming view state round trip", () => {
    let view: ViewState = initialViewState("m");
    const ev = (type: string, data: unknown): never => {
      throw new Error("unused");
    };
    void ev;
    view = { ...view, streaming: true };
    const sync = new TranscriptSync();
    sync.sync(view.items);
    expect(sync.container.render(80)).toEqual([]);
  });
});

describe("cache and invalidation sanity", () => {
  it("keeps markdown invalidation working through collapse toggles", () => {
    const block = new AssistantBlock(
      assistant({ reasoning: "think", text: "**bold** answer", done: true }),
    );
    block.fold = { expanded: false, kind: "reasoning" };
    const collapsed = plain(block.render(60)).join("\n");
    expect(collapsed).not.toContain("think"); // reasoning body hidden
    expect(collapsed).toContain("bold answer"); // answer text unaffected
    block.fold = { expanded: true, kind: "reasoning" };
    const expanded = plain(block.render(60)).join("\n");
    expect(expanded).toContain("think");
    expect(expanded).toContain("bold answer");
    block.invalidate();
    expect(plain(block.render(60)).length).toBeGreaterThan(0);
  });
});
