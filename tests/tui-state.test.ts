import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  COMMANDS,
  configuredProviderModelItems,
  contextLevel,
  editSummary,
  fitSegments,
  formatContext,
  formatDuration,
  formatTokens,
  GROUP_HEADER_PREFIX,
  hostOf,
  initialViewState,
  isGroupHeader,
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
  type SkillCompletionEntry,
  shortenPath,
  skillCompletions,
  skipGroupHeaders,
  slashCompletionCommands,
  summarizeToolArgs,
  visibleGroupedItems,
} from "../packages/cli/src/tui/state.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";
import { createSubagentsPlugin } from "../packages/plugin-subagents/src/index.ts";

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
        "Custom Provider",
        [{ id: "custom/kimi-k3", name: "Kimi K3", contextWindow: 128000 }],
        "custom/kimi-k3",
      ),
    ).toEqual([
      {
        value: "custom/kimi-k3",
        label: "Custom Provider · Kimi K3 (current)",
        description: "custom/kimi-k3 · 128k context",
      },
    ]);
  });

  it("groups configured provider models, marks the active pair, and keeps failures visible", () => {
    expect(
      configuredProviderModelItems(
        [
          {
            profile: "provider-a",
            provider: "provider-a",
            title: "Provider A",
            configuredModel: "shared",
            models: [{ id: "shared", name: "Shared" }],
            unavailable: false,
          },
          {
            profile: "provider-b",
            provider: "provider-b",
            title: "Provider B",
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
        { provider: "provider-b", model: "shared" },
      ).map(({ label, description, unavailable }) => ({ label, description, unavailable })),
    ).toEqual([
      { label: "Provider A · Shared", description: "provider-a/shared", unavailable: false },
      {
        label: "Provider B · Shared (current)",
        description: "provider-b/shared",
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

  it("shows an honest ? (no percentage) when the model window is unknown", () => {
    expect(formatContext(9_900, undefined, true, "unknown")).toBe("~9.9k / ?");
    expect(formatContext(40_000, undefined, false, "unknown")).toBe("40k / ?");
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
    expect(hostOf("https://api.example.test/v1")).toBe("api.example.test");
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
    expect(parseCommand("/model example-chat")).toEqual({ name: "model", args: "example-chat" });
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
    expect(resolveCommand("plugin")).toBeUndefined();
    expect(resolveCommand("skill")).toBeUndefined();
    expect(resolveCommand("skills")).toBe("skills");
    expect(resolveCommand("mcp")).toBeUndefined();
    expect(resolveCommand("mcps")).toBe("mcps");
    expect(resolveCommand("settings")).toBe("settings");
    expect(resolveCommand("prefs")).toBe("settings");
    expect(reservedCommandNames()).toContain("mcps");
    expect(reservedCommandNames()).not.toEqual(expect.arrayContaining(["plugin", "skill", "mcp"]));
  });

  it("lists /settings with its alias so autocomplete and /help discover it", () => {
    const settings = COMMANDS.find((c) => c.name === "settings");
    expect(settings).toMatchObject({ description: "Open the settings menu", aliases: ["prefs"] });
    expect(parseCommand("/settings")).toEqual({ name: "settings", args: "" });
    expect(parseCommand("/prefs")).toEqual({ name: "prefs", args: "" });
    expect(reservedCommandNames()).toContain("settings");
    expect(reservedCommandNames()).toContain("prefs");
  });
});

describe("skill slash autocompletion", () => {
  const docx: SkillCompletionEntry = {
    id: "docx",
    name: "docx",
    displayId: "docx",
    description: "Create, read and edit Word documents",
    enabled: true,
    locked: false,
    effective: true,
  };
  const pdf: SkillCompletionEntry = {
    id: "pdf",
    name: "pdf",
    displayId: "pdf",
    description: "Extract and generate PDF files",
    enabled: false,
    locked: false,
    effective: true,
  };
  const archive: SkillCompletionEntry = {
    id: "memory:archive",
    name: "archive",
    displayId: "memory:archive",
    description: "Archive observations to persistent memory",
    enabled: true,
    locked: true,
    effective: true,
  };
  const docxShadow: SkillCompletionEntry = {
    id: "docx#shadow-1",
    name: "docx",
    displayId: "docx",
    description: "A duplicated user copy",
    enabled: true,
    locked: false,
    effective: false,
  };

  it("suggests the whole catalog on an empty prefix with ids as values and display names as labels", () => {
    expect(skillCompletions([docx, pdf, archive, docxShadow], "")).toEqual([
      { value: "docx", label: "docx", description: "Create, read and edit Word documents" },
      {
        value: "pdf",
        label: "pdf",
        description: "disabled · Extract and generate PDF files",
      },
      {
        value: "memory:archive",
        label: "memory:archive",
        description: "locked by plugin · Archive observations to persistent memory",
      },
      {
        value: "docx#shadow-1",
        label: "docx",
        description: "shadowed · A duplicated user copy",
      },
    ]);
  });

  it("filters by prefix ignoring case on names, display ids and description keywords", () => {
    expect(skillCompletions([docx, pdf, archive, docxShadow], "DOC").map((i) => i.value)).toEqual([
      "docx",
      "docx#shadow-1",
    ]);
    expect(skillCompletions([docx, pdf, archive, docxShadow], "Word").map((i) => i.value)).toEqual([
      "docx",
    ]);
    expect(
      skillCompletions([docx, pdf, archive, docxShadow], "persistent").map((i) => i.value),
    ).toEqual(["memory:archive"]);
    expect(
      skillCompletions([docx, pdf, archive, docxShadow], " memory ").map((i) => i.value),
    ).toEqual(["memory:archive"]);
  });

  it("respects the limit and caps the description length", () => {
    const long = {
      ...docx,
      id: "long",
      name: "long",
      displayId: "long",
      description: "x".repeat(200),
    };
    const items = skillCompletions([docx, pdf, archive, docxShadow, long], "", 2);
    expect(items.map((i) => i.value)).toEqual(["docx", "pdf"]);
    const described = skillCompletions([long], "");
    expect(described[0]?.description?.length).toBeLessThanOrEqual(80);
    expect(described[0]?.description?.endsWith("…")).toBe(true);
    // The disabled marker is prepended before truncating, so it survives the cap.
    const marked = skillCompletions([{ ...long, enabled: false }], "");
    expect(marked[0]?.description).toMatch(/^disabled · x+x…$/);
    expect(marked[0]?.description?.length).toBeLessThanOrEqual(80);
  });

  it("returns no suggestions for an empty catalog or a non-matching prefix", () => {
    expect(skillCompletions([], "doc")).toEqual([]);
    expect(skillCompletions([docx, pdf], "zzz")).toEqual([]);
  });

  it("wires argument completions to /skills and /resume only", () => {
    const long = "x".repeat(200);
    const commands = slashCompletionCommands(
      [
        {
          name: "skills",
          description: "Browse and manage effective skills",
        },
        { name: "resume", description: "Resume a session by ID or prefix", argumentHint: "<id>" },
        { name: "help", description: "Show commands and keys" },
      ],
      {
        sessions: (prefix) =>
          [{ value: "s1", label: "s1", description: "m1" }].filter((s) =>
            s.value.startsWith(prefix),
          ),
        skills: [docx, { ...docx, id: "long", name: "long", displayId: "long", description: long }],
      },
    );
    expect(commands.map((c) => c.name)).toEqual([
      "skills",
      "resume",
      "help",
      "skill:docx",
      "skill:long",
    ]);
    const skills = commands[0]!;
    expect(skills.name).toBe("skills");
    expect(skills.getArgumentCompletions?.("DOC")).toEqual([
      {
        value: "docx",
        label: "docx",
        description: "Create, read and edit Word documents",
      },
    ]);
    const resume = commands[1]!;
    expect(resume.getArgumentCompletions?.("s")).toEqual([
      { value: "s1", label: "s1", description: "m1" },
    ]);
    expect(resume.getArgumentCompletions?.("z")).toEqual([]);
    expect((commands[2]! as Record<string, unknown>).getArgumentCompletions).toBeUndefined();
    // The appended skill entries are plain slash commands: inserting the name is enough, submitting
    // routes `skill:<id>` to skill load, and they must not steal argument completions.
    const skillEntry = commands[3]!;
    expect(skillEntry.name).toBe("skill:docx");
    expect(skillEntry.description).toBe("Create, read and edit Word documents");
    expect((skillEntry as Record<string, unknown>).getArgumentCompletions).toBeUndefined();
    expect((commands[4]! as Record<string, unknown>).getArgumentCompletions).toBeUndefined();
  });

  it("adds a first-class skill:<id> slash entry per catalog skill with scope marker, status and truncated description", () => {
    const long = "x".repeat(200);
    const catalog: SkillCompletionEntry[] = [
      { ...docx, scope: "user" },
      { ...pdf, scope: "project" },
      { ...archive, scope: "plugin" },
      { ...docxShadow, scope: "user" },
      {
        ...docx,
        id: "config:docx",
        name: "docx",
        displayId: "config:docx",
        scope: "config",
        description: long,
      },
    ];
    const commands = slashCompletionCommands(
      [{ name: "help", description: "Show commands and keys" }],
      { skills: catalog },
    );
    expect(commands.map((c) => c.name)).toEqual([
      "help",
      "skill:docx",
      "skill:pdf",
      "skill:memory:archive",
      "skill:docx#shadow-1",
      "skill:config:docx",
    ]);
    expect(commands[1]?.description).toBe("[u] Create, read and edit Word documents");
    expect(commands[2]?.description).toBe("[p] disabled · Extract and generate PDF files");
    expect(commands[3]?.description).toBe(
      "[l] locked by plugin · Archive observations to persistent memory",
    );
    expect(commands[4]?.description).toBe("[u] shadowed · A duplicated user copy");
    // The scope marker and status survive the truncation cap.
    expect(commands[5]?.description?.startsWith("[c] x")).toBe(true);
    expect(commands[5]?.description?.endsWith("…")).toBe(true);
    expect(commands[5]?.description?.length).toBeLessThanOrEqual(80);
  });

  it("keeps skill: entries filterable for a /ski-type prefix, case-insensitively", () => {
    const commands = slashCompletionCommands(
      [
        { name: "skills", description: "Browse and manage effective skills" },
        { name: "help", description: "Show commands and keys" },
      ],
      {
        skills: [
          { ...docx, scope: "user" },
          {
            ...docx,
            id: "branch-pr",
            name: "branch-pr",
            displayId: "branch-pr",
            scope: "user",
            description: "Create Gentle AI pull requests with issue-first checks",
          },
          {
            ...docx,
            id: "chained-pr",
            name: "chained-pr",
            displayId: "chained-pr",
            scope: "user",
            description: "Trigger: PRs over 400 lines, stacked PRs, review slices",
          },
        ],
      },
    );
    // The provider fuzzy-matches names with all prefix characters in order, case-insensitively;
    // emulate that contract here instead of importing pi-tui internals.
    const matches = (name: string, prefix: string) => {
      const query = prefix.toLowerCase();
      const text = name.toLowerCase();
      let at = 0;
      for (const char of query) {
        const hit = text.indexOf(char, at);
        if (hit === -1) return false;
        at = hit + 1;
      }
      return true;
    };
    const names = (prefix: string) =>
      commands.filter((c) => matches(c.name, prefix)).map((c) => c.name);
    expect(names("ski")).toContain("skill:branch-pr");
    expect(names("ski")).toContain("skill:chained-pr");
    expect(names("ski")).toContain("skills");
    expect(names("SKI")).toContain("skill:branch-pr");
    expect(names("skill:b")).toEqual(["skill:branch-pr"]);
    expect(names("branch")).toEqual(["skill:branch-pr"]);
    expect(names("zzz")).toEqual([]);
  });

  it("contributes no skill entries for an empty catalog", () => {
    const commands = slashCompletionCommands(
      [{ name: "help", description: "Show commands and keys" }],
      { skills: [] },
    );
    expect(commands.map((c) => c.name)).toEqual(["help"]);
    expect(commands.some((c) => c.name.startsWith("skill:"))).toBe(false);
  });

  it("skillEntries:false gates only the standalone skill: entries and keeps /skills argument completion", () => {
    const commands = slashCompletionCommands(
      [
        { name: "skills", description: "Browse and manage effective skills" },
        { name: "help", description: "Show commands and keys" },
      ],
      { skills: [docx, pdf] },
      { skillEntries: false },
    );
    expect(commands.map((c) => c.name)).toEqual(["skills", "help"]);
    expect(commands.some((c) => c.name.startsWith("skill:"))).toBe(false);
    // The /skills manager still offers argument completions from the same catalog.
    expect(commands[0]!.getArgumentCompletions?.("")).toHaveLength(2);
    // Default (omitted) keeps the skill: entries.
    const defaulted = slashCompletionCommands(
      [{ name: "help", description: "Show commands and keys" }],
      { skills: [docx] },
    );
    expect(defaulted.map((c) => c.name)).toContain("skill:docx");
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

  it("shows a gentle notice, not an error block, when the turn limit is reached", () => {
    let s = initialViewState("m1");
    s = reduceEvent(s, ev("run_started", { model: "m1" }));
    s = reduceEvent(
      s,
      ev("run_turns_exceeded", { turns: 20, maxTurns: 20 }, "2026-01-01T00:00:05.000Z"),
    );
    expect(s.streaming).toBe(false);
    const item = s.items.at(-1);
    expect(item?.kind).toBe("notice");
    expect(item && "text" in item ? item.text : "").toContain("may be incomplete");
    expect(item && "text" in item ? item.text : "").toContain("limits.maxTurns");
    expect(s.items.some((i) => i.kind === "error")).toBe(false);
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
      text: "Response cut by max output tokens — the answer may be incomplete. Raise limits.maxOutputTokens (/settings → Agent max output tokens) to allow longer answers.",
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
      expect.arrayContaining(["help", "quit", "new", "copy", "plugins", "skills", "mcps"]),
    );
    expect(reservedCommandNames()).not.toEqual(expect.arrayContaining(["plugin", "skill", "mcp"]));
    expect(reservedCommandNames()).not.toContain("init");
  });

  it("formats plugin navigation with non-color status markers and a grouped General heading", () => {
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
      { value: "__group:General", label: "General ›" },
      expect.objectContaining({
        label: "  [x] Memory · built-in",
        description: expect.stringContaining("Persistent memory"),
      }),
      expect.objectContaining({ label: "  [ ] Acme · project package: @acme/plugin" }),
    ]);
    expect(pluginToggleNeedsConfirmation(builtin)).toBe(false);
    expect(pluginToggleNeedsConfirmation(external)).toBe(true);
  });

  it("groups the real memory and subagents built-ins under their own headers", () => {
    // The real plugin definitions declare their categories, so the catalog must group them
    // under "memory" and "subagents" headings instead of the "General" fallback.
    const context = {
      workspace: "/w",
      stateHome: "/s",
      configHome: "/c",
      configDir: "/c",
      home: "/h",
      trusted: false,
    };
    const view = (plugin: {
      id: string;
      name?: string;
      description?: string;
      categories?: string[];
    }) => ({
      id: plugin.id,
      name: plugin.name ?? plugin.id,
      description: plugin.description ?? "",
      categories: plugin.categories ?? [],
      builtin: true,
      source: "built-in",
      status: "active" as const,
      enabled: true,
      manageable: true,
    });
    const items = pluginCatalogItems([
      view(createMemoryPlugin({}, context)),
      view(createSubagentsPlugin({}, context)),
    ]);
    expect(items.map((item) => item.label)).toEqual([
      "memory ›",
      "  [x] Memory · built-in",
      "subagents ›",
      "  [x] Subagents · built-in",
    ]);
    expect(items.map((item) => item.value)).toEqual([
      "__group:memory",
      "memory",
      "__group:subagents",
      "subagents",
    ]);
  });

  it("groups plugins by first category with a non-selectable header per group", () => {
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
      "model-provider ›",
      "  [x] Alpha · built-in",
      "  [x] Delta · built-in",
      "memory ›",
      "  [x] Beta · built-in",
      "tools ›",
      "  [x] Gamma · built-in",
    ]);
    expect(items.map((item) => item.value)).toEqual([
      "__group:model-provider",
      "a",
      "d",
      "__group:memory",
      "b",
      "__group:tools",
      "c",
    ]);
  });

  it("falls back to General for empty categories with the header emitted once", () => {
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
      "General ›",
      "  [ ] Memory · built-in",
      "  [ ] Plugin X · project",
      "  [ ] Plugin Y · project",
    ]);
    expect(items.map((item) => item.value)).toEqual(["__group:General", "m", "x", "y"]);
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
      "memory ›",
      "  [x] Third · built-in",
      "  [x] Fourth · built-in",
      "model-provider ›",
      "  [x] First · built-in",
      "  [x] Second · built-in",
    ]);
    expect(items.map((item) => item.value)).toEqual([
      "__group:memory",
      "third",
      "fourth",
      "__group:model-provider",
      "first",
      "second",
    ]);
  });

  it("recognizes group headers by their reserved prefix", () => {
    const check: Array<{ value: string; label: string }> = [
      { value: "__group:memory", label: "memory ›" },
      { value: "__group:General", label: "General ›" },
      { value: "memory", label: "  [x] Memory · built-in" },
      { value: "model-provider", label: "  [x] Alpha · built-in" },
    ];
    expect(isGroupHeader(check[0]!)).toBe(true);
    expect(isGroupHeader(check[1]!)).toBe(true);
    expect(isGroupHeader(check[2]!)).toBe(false);
    expect(isGroupHeader(check[3]!)).toBe(false);
    expect(GROUP_HEADER_PREFIX).toBe("__group:");
  });

  it("skips group headers when navigating up/down, wrapping at the edges", () => {
    const items: Array<{ value: string }> = [
      { value: "__group:model-provider" },
      { value: "a" },
      { value: "d" },
      { value: "__group:memory" },
      { value: "b" },
      { value: "__group:tools" },
      { value: "c" },
    ];
    const down = skipGroupHeaders(items, -1, 1);
    expect(down).toBe(1);
    // Down steps row by row inside a group (headers only exist between groups).
    expect(skipGroupHeaders(items, 1, 1)).toBe(2);
    // Down from the last row of a group jumps the next group's header to its first row.
    expect(skipGroupHeaders(items, 2, 1)).toBe(4);
    expect(skipGroupHeaders(items, 4, 1)).toBe(6);
    // Down from the last row wraps to the first row (never onto a header).
    expect(skipGroupHeaders(items, 6, 1)).toBe(1);
    // Up from the first row wraps to the last row, skipping every header on the way.
    expect(skipGroupHeaders(items, 1, -1)).toBe(6);
    // Up jumps the header above back to the previous group's last row.
    expect(skipGroupHeaders(items, 4, -1)).toBe(2);
    expect(skipGroupHeaders(items, 6, -1)).toBe(4);
    // Empty lists never move; a header-free list behaves like a plain list.
    expect(skipGroupHeaders([], 0, 1)).toBe(-1);
    const plain = [{ value: "x" }, { value: "y" }];
    expect(skipGroupHeaders(plain, 0, -1)).toBe(1);
    expect(skipGroupHeaders(plain, 1, 1)).toBe(0);
  });

  it("keeps the header of a group with visible rows and drops headers of filtered-out groups", () => {
    const items = [
      { value: "__group:model-provider", label: "model-provider ›" },
      { value: "provider-a", label: "  [x] Provider A" },
      { value: "openai", label: "  [x] OpenAI" },
      { value: "__group:memory", label: "memory ›" },
      { value: "memory", label: "  [x] Memory" },
      { value: "__group:subagents", label: "subagents ›" },
      { value: "methodology-harness", label: "  [x] Methodology" },
    ] as const;
    // Empty filter keeps every row and every header, in original order.
    expect(visibleGroupedItems(items, "").map((i) => i.value)).toEqual([
      "__group:model-provider",
      "provider-a",
      "openai",
      "__group:memory",
      "memory",
      "__group:subagents",
      "methodology-harness",
    ]);
    // "mem" matches only the memory rows: its header stays, the other headers disappear.
    expect(visibleGroupedItems(items, "mem").map((i) => i.value)).toEqual([
      "__group:memory",
      "memory",
    ]);
    // Case-insensitive prefix matching, same as the SelectList filter.
    expect(visibleGroupedItems(items, "PROV").map((i) => i.value)).toEqual([
      "__group:model-provider",
      "provider-a",
    ]);
    // "openai" keeps its own group header even though the sibling provider-a row vanished.
    expect(visibleGroupedItems(items, "openai").map((i) => i.label)).toEqual([
      "model-provider ›",
      "  [x] OpenAI",
    ]);
    // No matches: no headers, no rows.
    expect(visibleGroupedItems(items, "zzz")).toEqual([]);
  });
});
