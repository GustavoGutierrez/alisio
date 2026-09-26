import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  configuredProviderModelItems,
  contextLevel,
  editSummary,
  fitSegments,
  formatContext,
  formatDuration,
  formatTokens,
  hostOf,
  initialViewState,
  itemsFromHistory,
  lastAssistantText,
  mcpServerItems,
  mcpToolItems,
  parseCommand,
  pluginCatalogItems,
  pluginToggleNeedsConfirmation,
  providerModelItems,
  reduceEvent,
  reservedCommandNames,
  resolveCommand,
  shortenPath,
  summarizeToolArgs,
} from "../packages/cli/src/tui/state.ts";

let seq = 0;
const ev = (type: string, data: unknown, at = "2026-01-01T00:00:00.000Z"): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp: at,
  data,
});

describe("formatters", () => {
  it("makes model ownership explicit in selector items", () => {
    expect(
      providerModelItems(
        "OpenCode Go",
        [{ id: "opencode-go/kimi-k3", name: "Kimi K3", contextWindow: 128000 }],
        "opencode-go/kimi-k3",
      ),
    ).toEqual([
      {
        value: "opencode-go/kimi-k3",
        label: "OpenCode Go · Kimi K3 (current)",
        description: "opencode-go/kimi-k3 · 128k context",
      },
    ]);
  });

  it("groups configured provider models, marks the active pair, and keeps failures visible", () => {
    expect(
      configuredProviderModelItems(
        [
          {
            profile: "deepseek",
            provider: "deepseek",
            title: "DeepSeek",
            configuredModel: "shared",
            models: [{ id: "shared", name: "Shared" }],
            unavailable: false,
          },
          {
            profile: "opencode",
            provider: "opencode",
            title: "OpenCode Console",
            configuredModel: "shared",
            models: [{ id: "shared", name: "Shared" }],
            unavailable: false,
          },
          {
            profile: "broken",
            provider: "broken",
            title: "Broken Provider",
            configuredModel: "broken-model",
            models: [],
            unavailable: true,
          },
          {
            profile: "manual",
            provider: "manual",
            title: "Manual Provider",
            configuredModel: "manual-model",
            models: [],
            unavailable: false,
          },
        ],
        { provider: "opencode", model: "shared" },
      ).map(({ label, description, unavailable }) => ({ label, description, unavailable })),
    ).toEqual([
      { label: "DeepSeek · Shared", description: "deepseek/shared", unavailable: false },
      {
        label: "OpenCode Console · Shared (current)",
        description: "opencode/shared",
        unavailable: false,
      },
      {
        label: "Broken Provider · unavailable",
        description: "broken · catalog refresh failed",
        unavailable: true,
      },
      {
        label: "Manual Provider · manual-model",
        description: "manual/manual-model",
        unavailable: false,
      },
    ]);
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_300)).toBe("45.3k");
    expect(formatTokens(128_000)).toBe("128k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
  });

  it("classifies context usage thresholds, red exactly at the compaction point", () => {
    expect(contextLevel(0)).toBe("ok");
    expect(contextLevel(59.9)).toBe("ok");
    expect(contextLevel(60)).toBe("warn");
    expect(contextLevel(84.9)).toBe("warn");
    expect(contextLevel(85)).toBe("danger");
    // The bar turns red where the engine auto-compacts: window threshold (default 85%)...
    expect(contextLevel(59.9, 85)).toBe("ok");
    expect(contextLevel(84.9, 85)).toBe("warn");
    expect(contextLevel(85, 85)).toBe("danger");
    // ...or 100% of the char-budget fallback when the window is unknown.
    expect(contextLevel(74.9, 100)).toBe("ok");
    expect(contextLevel(75, 100)).toBe("warn");
    expect(contextLevel(99.9, 100)).toBe("warn");
    expect(contextLevel(100, 100)).toBe("danger");
    // A custom low threshold moves the red point with it.
    expect(contextLevel(50, 50)).toBe("danger");
  });

  it("formats context used versus window, marking estimates", () => {
    expect(formatContext(12_300, 128_000, false)).toBe("12.3k / 128k (10%)");
    expect(formatContext(12_300, 128_000, true)).toBe("~12.3k / 128k (10%)");
    expect(formatContext(500, undefined, false)).toBe("500 / unknown");
  });

  it("marks the char-budget basis when there is no model window", () => {
    expect(formatContext(40_000, 40_000, true, "chars")).toBe("~40k / 40k (100%) char budget");
    expect(formatContext(12_300, 40_000, true, "chars")).toBe("~12.3k / 40k (31%) char budget");
    expect(formatContext(12_300, 128_000, false, "window")).toBe("12.3k / 128k (10%)");
  });

  it("formats durations", () => {
    expect(formatDuration(850)).toBe("850ms");
    expect(formatDuration(12_340)).toBe("12.3s");
    expect(formatDuration(125_000)).toBe("2m05s");
  });

  it("shortens paths and hides credentials in hosts", () => {
    expect(shortenPath("/home/u/work/project", "/home/u")).toBe("~/work/project");
    expect(shortenPath("/home/u/a/very/deep/nested/project", "/home/u", 20)).toBe(
      "…/nested/project",
    );
    expect(hostOf("https://api.deepseek.com/v1")).toBe("api.deepseek.com");
    expect(hostOf("http://127.0.0.1:8080/v1?key=secret")).toBe("127.0.0.1:8080");
    expect(hostOf("not a url")).toBe("unknown");
  });

  it("fits status segments to width by dropping low priority ones first", () => {
    const segments = [
      { text: "ctx 10k / 128k", priority: 10 },
      { text: "in 5k out 1k", priority: 5 },
      { text: "turns 3", priority: 1 },
      { text: "idle", priority: 9 },
    ];
    expect(fitSegments(segments, 200, " · ").map((s) => s.text)).toEqual([
      "ctx 10k / 128k",
      "in 5k out 1k",
      "turns 3",
      "idle",
    ]);
    const narrow = fitSegments(segments, 24, " · ");
    expect(narrow.map((s) => s.text)).toEqual(["ctx 10k / 128k", "idle"]);
    const tiny = fitSegments(segments, 8, " · ");
    expect(tiny).toHaveLength(1);
    expect(tiny[0]?.text.length).toBeLessThanOrEqual(8);
    expect(tiny[0]?.text.endsWith("…")).toBe(true);
  });
});

describe("commands", () => {
  it("parses slash commands and arguments", () => {
    expect(parseCommand("/model deepseek-chat")).toEqual({ name: "model", args: "deepseek-chat" });
    expect(parseCommand("/compact   focus on tests  ")).toEqual({
      name: "compact",
      args: "focus on tests",
    });
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
    expect(parseCommand("hello /model")).toBeUndefined();
    expect(parseCommand("/")).toBeUndefined();
    expect(parseCommand("/skill:review check it")).toEqual({
      name: "skill:review",
      args: "check it",
    });
  });

  it("resolves aliases and rejects unknown commands", () => {
    expect(resolveCommand("quit")).toBe("exit");
    expect(resolveCommand("exit")).toBe("exit");
    expect(resolveCommand("new")).toBe("clear");
    expect(resolveCommand("nope")).toBeUndefined();
    expect(resolveCommand("copy")).toBe("copy");
    expect(resolveCommand("connect")).toBe("connect");
    expect(resolveCommand("models")).toBe("model");
    expect(resolveCommand("plugin")).toBe("plugins");
    expect(resolveCommand("skill")).toBe("skills");
    expect(resolveCommand("skills")).toBe("skills");
    expect(resolveCommand("mcp")).toBe("mcp");
    expect(reservedCommandNames()).toContain("mcp");
  });
});

describe("MCP manager presentation", () => {
  it("groups only real sources and exposes accessible lifecycle markers", () => {
    const items = mcpServerItems([
      {
        name: "global",
        displayName: "Global server",
        source: { kind: "global" },
        status: "connected",
        enabled: true,
        runtimePermission: "granted",
        counts: { tools: 2 },
      },
      {
        name: "project",
        displayName: "Project server",
        source: { kind: "project" },
        status: "needs-authentication",
        enabled: true,
        runtimePermission: "not-granted",
        counts: { tools: 0 },
      },
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "User · [x] Global server",
      "Project · [?] Project server",
    ]);
    expect(items[0]?.description).toBe(
      "configured enabled · permission granted · connected · 2 tools loaded",
    );
    expect(items[1]?.description).toBe(
      "configured enabled · permission not-granted · needs-authentication · 0 tools loaded",
    );
    expect(JSON.stringify(items)).not.toContain("Built-in");
  });

  it("shows declared annotations without inventing destructive status", () => {
    const items = mcpToolItems([
      { name: "plain", description: "No hints" },
      {
        name: "delete",
        title: "Delete item",
        annotations: { destructive: true, openWorld: true },
      },
    ]);
    expect(items[0]?.description).toBe("No hints");
    expect(items[0]?.description).not.toContain("destructive");
    expect(items[1]).toMatchObject({
      label: "Delete item · delete",
      description: "destructive · open-world",
    });
  });
});

describe("tool presentation", () => {
  it("summarizes arguments per tool", () => {
    expect(summarizeToolArgs("read_file", '{"path":"src/a.ts"}')).toBe("src/a.ts");
    expect(summarizeToolArgs("shell", '{"command":"ls -la"}')).toBe("ls -la");
    expect(summarizeToolArgs("run_process", '{"command":"git","args":["status","-s"]}')).toBe(
      "git status -s",
    );
    expect(summarizeToolArgs("search_text", '{"pattern":"foo","path":"src"}')).toBe('"foo" in src');
    expect(summarizeToolArgs("custom", "{not json")).toBe("{not json");
    expect(summarizeToolArgs("memory_save", '{"title":"Chose SQLite","type":"decision"}')).toBe(
      "Chose SQLite",
    );
  });

  it("builds a line diff summary for edits and writes", () => {
    const edit = editSummary(
      "edit_file",
      JSON.stringify({ path: "a.ts", oldText: "a\nb\nc", newText: "a\nB\nc\nd" }),
    );
    expect(edit).toMatchObject({ added: 2, removed: 1 });
    expect(edit?.lines).toEqual([
      { sign: "-", text: "b" },
      { sign: "+", text: "B" },
      { sign: "+", text: "d" },
    ]);
    expect(
      editSummary("write_file", JSON.stringify({ path: "n.ts", content: "x\ny\n" })),
    ).toMatchObject({ added: 2, removed: 0 });
    expect(editSummary("read_file", "{}")).toBeUndefined();
  });
});

describe("event reduction", () => {
  it("builds transcript items and statistics from runner events", () => {
    let s = initialViewState("m1");
    s = reduceEvent(s, ev("run_started", { model: "m1" }, "2026-01-01T00:00:00.000Z"));
    expect(s.streaming).toBe(true);
    s = reduceEvent(s, ev("reasoning_delta", { delta: "thinking" }));
    s = reduceEvent(s, ev("text_delta", { delta: "Hel" }));
    s = reduceEvent(s, ev("text_delta", { delta: "lo" }));
    s = reduceEvent(
      s,
      ev("turn_completed", {
        turn: 1,
        calls: 1,
        model: "m1",
        usage: { input: 1000, output: 200, cachedInput: 600 },
      }),
    );
    s = reduceEvent(
      s,
      ev("tool_started", { id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }),
    );
    expect(s.items.at(-1)).toMatchObject({ kind: "tool", status: "running", summary: "a.ts" });
    s = reduceEvent(
      s,
      ev("tool_completed", {
        id: "c1",
        name: "read_file",
        isError: false,
        durationMs: 12,
        preview: "content",
      }),
    );
    s = reduceEvent(s, ev("tool_started", { id: "c2", name: "shell", arguments: "{}" }));
    s = reduceEvent(s, ev("tool_completed", { id: "c2", name: "shell", isError: true }));
    s = reduceEvent(s, ev("text_delta", { delta: "Done" }));
    s = reduceEvent(
      s,
      ev("turn_completed", { turn: 2, calls: 0, model: "m1", usage: { input: 1500, output: 50 } }),
    );
    s = reduceEvent(s, ev("run_completed", { text: "Done" }, "2026-01-01T00:00:05.000Z"));

    expect(s.streaming).toBe(false);
    expect(s.items.map((i) => i.kind)).toEqual(["assistant", "tool", "tool", "assistant"]);
    expect(s.items[0]).toMatchObject({ kind: "assistant", text: "Hello", reasoning: "thinking" });
    expect(s.items[1]).toMatchObject({ status: "ok", durationMs: 12, preview: "content" });
    expect(s.items[2]).toMatchObject({ status: "error" });
    expect(s.stats).toMatchObject({
      input: 2500,
      output: 250,
      cached: 600,
      turns: 2,
      lastRunMs: 5000,
    });
    expect(s.stats.tools).toEqual({
      read_file: { calls: 1, errors: 0 },
      shell: { calls: 1, errors: 1 },
    });
    expect(s.context).toEqual({ used: 1550, estimated: false });
  });

  it("shows failures and compaction inline and tracks model changes", () => {
    let s = initialViewState("m1");
    s = reduceEvent(s, ev("run_started", { model: "m1" }));
    s = reduceEvent(s, ev("run_failed", { error: "boom" }));
    expect(s.items.at(-1)).toMatchObject({ kind: "error", text: "boom" });
    expect(s.streaming).toBe(false);
    s = reduceEvent(s, ev("compaction_started", { reason: "manual", before: 9000 }));
    expect(s.compacting).toBe(true);
    s = reduceEvent(
      s,
      ev("compaction_completed", { reason: "manual", before: 9000, after: 1200, replaced: 10 }),
    );
    expect(s.compacting).toBe(false);
    expect(s.context).toEqual({ used: 1200, estimated: true });
    expect(s.items.at(-1)?.kind).toBe("notice");
    s = reduceEvent(s, ev("model_changed", { model: "m2", previous: "m1" }));
    expect(s.model).toBe("m2");
    expect(s.stats.models).toEqual(["m1", "m2"]);
    s = reduceEvent(s, ev("run_started", {}));
    s = reduceEvent(s, ev("run_cancelled", { error: "Interrupted" }));
    expect(s.items.at(-1)).toMatchObject({ kind: "notice" });
  });

  it("shows plugin compaction reports, hook failures and injected context generically", () => {
    let s = initialViewState("m1");
    s = reduceEvent(
      s,
      ev("compaction_completed", {
        reason: "auto",
        before: 90_000,
        after: 4_000,
        replaced: 12,
        summarizedTokens: 60_000,
        checkpointTokens: 1_500,
        plugins: { memory: { summary: "memory: +2 new, 1 updated · archive confirmed" } },
      }),
    );
    const notice = s.items.at(-1);
    expect(notice?.kind).toBe("notice");
    expect(notice && "text" in notice ? notice.text : "").toContain(
      "checkpoint ~60k → ~1.5k tokens",
    );
    expect(notice && "text" in notice ? notice.text : "").toContain(
      "memory: +2 new, 1 updated · archive confirmed",
    );
    s = reduceEvent(
      s,
      ev("plugin_hook_failed", { source: "memory", hook: "afterCompact", error: "boom" }),
    );
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "Plugin memory afterCompact failed: boom (continued without it)",
    });
    s = reduceEvent(s, ev("session_context_injected", { tokens: 420, sources: ["memory"] }));
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "Context injected by memory (~420 tokens)",
    });
  });

  it("flags a truncated summary checkpoint in the compaction notice", () => {
    let s = initialViewState("m1");
    s = reduceEvent(
      s,
      ev("compaction_completed", {
        reason: "auto",
        before: 9_000,
        after: 1_200,
        replaced: 10,
        partial: true,
      }),
    );
    const notice = s.items.at(-1);
    expect(notice?.kind).toBe("notice");
    expect(notice && "text" in notice ? notice.text : "").toContain("partial");
    expect(notice && "text" in notice ? notice.text : "").toContain("compaction.maxOutputTokens");
  });

  it("shows a visible notice when a response was cut by max output tokens", () => {
    let s = initialViewState("m1");
    s = reduceEvent(s, ev("response_truncated", { turn: 1, maxOutputTokens: 4096 }));
    expect(s.items.at(-1)).toEqual({
      kind: "notice",
      text: "Response cut by max output tokens — the answer may be incomplete. Raise limits.maxOutputTokens to allow longer answers.",
    });
  });

  it("finds the last assistant response for /copy", () => {
    let s = initialViewState("m1");
    expect(lastAssistantText(s.items)).toBeUndefined();
    s = reduceEvent(s, ev("text_delta", { delta: "first" }));
    s = reduceEvent(s, ev("turn_completed", { turn: 1 }));
    s = reduceEvent(s, ev("tool_started", { id: "t", name: "shell", arguments: "{}" }));
    s = reduceEvent(s, ev("text_delta", { delta: "second **answer**" }));
    expect(lastAssistantText(s.items)).toBe("second **answer**");
  });

  it("shows the display text of expanded templates and reserves command names", () => {
    expect(
      itemsFromHistory([
        { role: "user", text: "Analyze this repository ...", display: "/init focus" },
        { role: "user", text: "plain" },
      ]),
    ).toEqual([
      { kind: "user", text: "/init focus" },
      { kind: "user", text: "plain" },
    ]);
    expect(reservedCommandNames()).toEqual(
      expect.arrayContaining([
        "help",
        "quit",
        "new",
        "copy",
        "plugins",
        "plugin",
        "skills",
        "skill",
      ]),
    );
    expect(reservedCommandNames()).not.toContain("init");
  });

  it("formats plugin navigation with non-color status, source markers and a General heading", () => {
    const builtin = {
      id: "memory",
      name: "Memory",
      description: "Persistent memory",
      categories: [] as string[],
      builtin: true,
      source: "built-in",
      status: "active" as const,
      enabled: true,
      manageable: true,
    };
    const external = {
      ...builtin,
      id: "acme",
      name: "Acme",
      builtin: false,
      source: "project package: @acme/plugin",
      status: "inactive" as const,
      enabled: false,
    };
    expect(pluginCatalogItems([builtin, external])).toEqual([
      expect.objectContaining({
        label: "General · [x] Memory · built-in",
        description: expect.stringContaining("Persistent memory"),
      }),
      expect.objectContaining({ label: "[ ] Acme · project package: @acme/plugin" }),
    ]);
    expect(pluginToggleNeedsConfirmation(builtin)).toBe(false);
    expect(pluginToggleNeedsConfirmation(external)).toBe(true);
  });

  it("groups plugins by first category with a heading only on the group's first row", () => {
    const base = {
      description: "Plugin",
      builtin: true,
      source: "built-in",
      status: "active" as const,
      enabled: true,
      manageable: true,
    };
    const items = pluginCatalogItems([
      { ...base, id: "a", name: "Alpha", categories: ["model-provider"] },
      { ...base, id: "b", name: "Beta", categories: ["memory"] },
      { ...base, id: "c", name: "Gamma", categories: ["tools"] },
      { ...base, id: "d", name: "Delta", categories: ["model-provider"] },
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "model-provider · [x] Alpha · built-in",
      "[x] Delta · built-in",
      "memory · [x] Beta · built-in",
      "tools · [x] Gamma · built-in",
    ]);
    expect(items.map((item) => item.value)).toEqual(["a", "d", "b", "c"]);
  });

  it("falls back to General for empty categories and keeps the heading off subsequent rows", () => {
    const base = {
      description: "Plugin",
      categories: [] as string[],
      builtin: false,
      source: "project",
      status: "inactive" as const,
      enabled: false,
      manageable: true,
    };
    const items = pluginCatalogItems([
      { ...base, id: "m", name: "Memory", builtin: true, source: "built-in" },
      { ...base, id: "x", name: "Plugin X" },
      { ...base, id: "y", name: "Plugin Y" },
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "General · [ ] Memory · built-in",
      "[ ] Plugin X · project",
      "[ ] Plugin Y · project",
    ]);
    expect(items.map((item) => item.value)).toEqual(["m", "x", "y"]);
  });

  it("preserves entry order within each group and keeps groups in first-seen order", () => {
    const base = {
      description: "Plugin",
      builtin: true,
      source: "built-in",
      status: "active" as const,
      enabled: true,
      manageable: true,
    };
    const items = pluginCatalogItems([
      { ...base, id: "third", name: "Third", categories: ["memory"] },
      { ...base, id: "first", name: "First", categories: ["model-provider"] },
      { ...base, id: "second", name: "Second", categories: ["model-provider"] },
      { ...base, id: "fourth", name: "Fourth", categories: ["memory"] },
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "memory · [x] Third · built-in",
      "[x] Fourth · built-in",
      "model-provider · [x] First · built-in",
      "[x] Second · built-in",
    ]);
    expect(items.map((item) => item.value)).toEqual(["third", "fourth", "first", "second"]);
  });
});
