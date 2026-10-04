import type { Message, RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  entryKeyOf,
  exitCodeOf,
  type FoldCandidate,
  foldCandidateOf,
  foldCandidates,
  foldToggleKey,
  groupIdentity,
  groupToolEntries,
  humanizeToolName,
  initialViewState,
  itemsFromHistory,
  reasoningDurationMs,
  reduceEvent,
  type TranscriptItem,
  toolKindOf,
  type ViewState,
} from "../packages/cli/src/tui/state.ts";

describe("humanizeToolName", () => {
  it("turns snake_case into Title Case", () => {
    expect(humanizeToolName("read_file")).toBe("Read File");
    expect(humanizeToolName("search_text")).toBe("Search Text");
    expect(humanizeToolName("run_process")).toBe("Run Process");
    expect(humanizeToolName("write_file")).toBe("Write File");
    expect(humanizeToolName("list_files")).toBe("List Files");
    expect(humanizeToolName("ask_user_question")).toBe("Ask User Question");
    expect(humanizeToolName("git_status")).toBe("Git Status");
  });

  it("keeps known acronyms uppercase", () => {
    expect(humanizeToolName("http_fetch")).toBe("HTTP Fetch");
    expect(humanizeToolName("mcp_schema_search")).toBe("MCP · Schema Search");
    expect(humanizeToolName("web_search")).toBe("Web Search");
    expect(humanizeToolName("api_client_run")).toBe("API Client Run");
  });

  it("prefixes MCP server tools and humanizes the rest of the name", () => {
    expect(humanizeToolName("mcp_devforge_time_diff")).toBe("MCP · Devforge Time Diff");
    expect(humanizeToolName("mcp_table")).toBe("MCP · Table");
    expect(humanizeToolName("mcp_connect")).toBe("MCP · Connect");
  });

  it("handles numeric suffixes, dashes and already-human names", () => {
    expect(humanizeToolName("read_file_2")).toBe("Read File 2");
    expect(humanizeToolName("run-process")).toBe("Run Process");
    expect(humanizeToolName("Read File")).toBe("Read File");
    expect(humanizeToolName("v2_notes")).toBe("V2 Notes");
  });

  it("is total for edge inputs", () => {
    expect(humanizeToolName("")).toBe("");
    expect(humanizeToolName("task")).toBe("Task");
    expect(humanizeToolName("execute")).toBe("Execute");
    expect(humanizeToolName("2fa_issue")).toBe("2FA Issue");
  });
});

describe("toolKindOf", () => {
  it("derives kinds from the registry effect when present", () => {
    expect(toolKindOf("mcp_table", "external")).toBe("mcp"); // mcp_ prefix wins
    expect(toolKindOf("read_file", "read")).toBe("read");
    expect(toolKindOf("edit_file", "write")).toBe("write");
    expect(toolKindOf("shell", "process")).toBe("process");
    expect(toolKindOf("task", "internal")).toBe("internal");
    expect(toolKindOf("unknown_tool", "external")).toBe("other");
  });

  it("classifies dashboard_generate as an internal task, also in replayed history", () => {
    expect(toolKindOf("dashboard_generate")).toBe("internal");
    expect(humanizeToolName("dashboard_generate")).toBe("Generate Dashboard");
  });

  it("falls back to name heuristics for replayed history", () => {
    expect(toolKindOf("read_file")).toBe("read");
    expect(toolKindOf("search_text")).toBe("read");
    expect(toolKindOf("list_files")).toBe("read");
    expect(toolKindOf("git_diff")).toBe("read");
    expect(toolKindOf("write_file")).toBe("write");
    expect(toolKindOf("edit_file")).toBe("write");
    expect(toolKindOf("run_process")).toBe("process");
    expect(toolKindOf("shell")).toBe("process");
    expect(toolKindOf("execute")).toBe("process");
    expect(toolKindOf("task")).toBe("internal");
    expect(toolKindOf("some_plugin_tool")).toBe("other");
  });
});

describe("exitCodeOf", () => {
  it("extracts exitCode from a run_process JSON preview", () => {
    expect(
      exitCodeOf(JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0, truncated: false })),
    ).toBe(0);
    expect(
      exitCodeOf(JSON.stringify({ stdout: "", stderr: "boom", exitCode: 1, truncated: false })),
    ).toBe(1);
  });

  it("survives an appended <instructions> block (read-effect tools)", () => {
    const json = JSON.stringify({ stdout: "x", stderr: "", exitCode: 0, truncated: false });
    expect(exitCodeOf(`${json}\n<instructions>\nContext changed\n</instructions>`)).toBe(0);
  });

  it("derives exitCode from multi-line JSON output (stdout with newlines)", () => {
    const json = JSON.stringify({ stdout: "a\nb\nc", stderr: "", exitCode: 2, truncated: false });
    expect(exitCodeOf(json)).toBe(2);
  });

  it("returns nothing for non-JSON or non-exitCode shapes", () => {
    expect(exitCodeOf("plain text output")).toBeUndefined();
    expect(exitCodeOf(JSON.stringify({ files: [], nextOffset: null }))).toBeUndefined();
    expect(exitCodeOf(undefined)).toBeUndefined();
    expect(exitCodeOf("[not json")).toBeUndefined();
  });
});

const tool = (
  extra: Partial<Extract<TranscriptItem, { kind: "tool" }>>,
): Extract<TranscriptItem, { kind: "tool" }> => ({
  kind: "tool",
  id: "c1",
  name: "read_file",
  args: "{}",
  summary: "x",
  status: "ok",
  ...extra,
});

describe("groupToolEntries", () => {
  it("merges consecutive same-kind finished calls into one group with a count", () => {
    const items: TranscriptItem[] = [
      tool({ id: "c1", name: "read_file", summary: "a", durationMs: 10 }),
      tool({ id: "c2", name: "read_file", summary: "b", durationMs: 20 }),
      tool({ id: "c3", name: "search_text", summary: '"x"' }),
    ];
    const entries = groupToolEntries(items);
    expect(entries).toHaveLength(1);
    const group = entries[0]?.entry;
    expect(group?.kind).toBe("group");
    if (group?.kind === "group") {
      expect(group.group.members.map((m) => m.id)).toEqual(["c1", "c2", "c3"]);
      // mixed names → kind verb
      expect(group.group.label).toBe("Explored");
      expect(group.group.word).toBe("reads");
      expect(group.group.status).toBe("ok");
      expect(group.group.totalMs).toBe(30);
    }
    expect(entries[0]?.at).toBe(0);
  });

  it("groups by shared humanized name when every call is the same tool", () => {
    const items = [tool({ id: "c1" }), tool({ id: "c2" })];
    const group = groupToolEntries(items)[0]?.entry;
    if (group?.kind === "group") {
      expect(group.group.label).toBe("Read File");
      expect(group.group.word).toBe("reads");
    }
  });

  it("keeps running calls as singletons until the whole batch finishes", () => {
    const running = [
      tool({ id: "c1", status: "running" }),
      tool({ id: "c2", status: "ok" }),
      tool({ id: "c3", status: "ok" }),
    ];
    // A running call in the batch suppresses partial merging: every call stays an individual row
    // with its own spinner/status. Once ALL of them finish, the batch collapses into one group.
    expect(groupToolEntries(running).map((e) => e.entry.kind)).toEqual(["tool", "tool", "tool"]);
    const finished = running.map(
      (i): TranscriptItem =>
        i.kind === "tool" && i.status === "running" ? { ...i, status: "ok" } : i,
    );
    expect(groupToolEntries(finished).map((e) => e.entry.kind)).toEqual(["group"]);
  });

  it("never merges approval items nor runs across kinds", () => {
    const approval = [tool({ id: "c1", status: "approval" }), tool({ id: "c2", status: "ok" })];
    expect(groupToolEntries(approval).map((e) => e.entry.kind)).toEqual(["tool", "tool"]);
    const mixed = [
      tool({ id: "c1", name: "read_file" }),
      tool({ id: "c2", name: "shell" }),
      tool({ id: "c3", name: "shell" }),
    ];
    // read + shell split the run; the two shells merge after the read.
    expect(groupToolEntries(mixed).map((e) => e.entry.kind)).toEqual(["tool", "group"]);
  });

  it("never merges across non-tool items", () => {
    const items: TranscriptItem[] = [
      tool({ id: "c1" }),
      { kind: "assistant", text: "", reasoning: "", done: true },
      tool({ id: "c2" }),
    ];
    const entries = groupToolEntries(items);
    expect(entries.map((e) => e.entry.kind)).toEqual(["tool", "assistant", "tool"]);
  });

  it("aggregates error status when any member failed", () => {
    const items = [
      tool({ id: "c1", name: "shell", summary: "a" }),
      tool({ id: "c2", name: "shell", summary: "b", status: "error" }),
    ];
    const group = groupToolEntries(items)[0]?.entry;
    if (group?.kind === "group") {
      expect(group.group.status).toBe("error");
      expect(group.group.label).toBe("Shell");
      expect(group.group.word).toBe("commands");
    }
  });

  it("groupIdentity reflects membership changes", () => {
    const groupOf = (items: TranscriptItem[]) => {
      const first = groupToolEntries(items)[0];
      if (!first || first.entry.kind !== "group") throw new Error("expected group");
      return first.entry.group;
    };
    const two = [tool({ id: "c1", durationMs: 10 }), tool({ id: "c2", durationMs: 20 })];
    const grown = [...two, tool({ id: "c3", durationMs: 30 })];
    const failed = [
      tool({ id: "c1", durationMs: 10 }),
      tool({ id: "c2", durationMs: 20, status: "error" }),
    ];
    expect(groupIdentity(groupOf(two))).toBe(groupIdentity(groupOf(two)));
    expect(groupIdentity(groupOf(grown))).not.toBe(groupIdentity(groupOf(two)));
    expect(groupIdentity(groupOf(failed))).not.toBe(groupIdentity(groupOf(two)));
  });
});

describe("foldCandidateOf / foldCandidates", () => {
  it("collapses finished reasoning, expands nothing while streaming reasoning", () => {
    const done: TranscriptItem = {
      kind: "assistant",
      text: "answer",
      reasoning: "let me think",
      done: true,
    };
    expect(foldCandidateOf(done, 3)).toEqual({
      key: "a:3",
      kind: "reasoning",
      defaultExpanded: false,
    });

    const streaming: TranscriptItem = {
      kind: "assistant",
      text: "",
      reasoning: "thinking…",
      done: false,
    };
    expect(foldCandidateOf(streaming, 0)).toBeUndefined();
  });

  it("marks truncated singleton outputs as foldable, leaves short/rich ones alone", () => {
    const long = tool({ preview: "1\n2\n3\n4" });
    expect(foldCandidateOf(long, 0)).toEqual({
      key: "t:c1",
      kind: "output",
      defaultExpanded: false,
    });
    const short = tool({ preview: "1\n2" });
    expect(foldCandidateOf(short, 0)).toBeUndefined();
    const rich = tool({ preview: "1\n2\n3\n4", ui: { kind: "code", code: "x" } });
    expect(foldCandidateOf(rich, 0)).toBeUndefined();
    const running = tool({ status: "running", preview: "1\n2\n3\n4" });
    expect(foldCandidateOf(running, 0)).toBeUndefined();
  });

  it("exposes every collapsible in order (keybinding targets the last)", () => {
    const items: TranscriptItem[] = [
      { kind: "assistant", text: "a1", reasoning: "r", done: true },
      // A truncated read tool and a non-mergeable write tool keep singleton output folds.
      tool({ id: "c1", preview: "1\n2\n3\n4" }),
      tool({ id: "c2", name: "write_file", summary: "n.ts", preview: "1\n2\n3\n4" }),
      { kind: "assistant", text: "a2", reasoning: "r2", done: true },
      // A batch of reads collapses into one group fold.
      tool({ id: "c3", name: "read_file", summary: "a" }),
      tool({ id: "c4", name: "read_file", summary: "b" }),
    ];
    const candidates = foldCandidates(items);
    expect(candidates.map((c) => c.key)).toEqual(["a:0", "t:c1", "t:c2", "a:3", "g:c3"]);
    expect(candidates.at(-1)?.kind).toBe("group");
  });
});

describe("entry keys", () => {
  it("keys groups and tools by stable ids, assistant rows by item index", () => {
    const group = groupToolEntries([tool({ id: "c1" }), tool({ id: "c2" })])[0];
    if (!group || group.entry.kind !== "group") throw new Error("expected group");
    expect(entryKeyOf(group.entry, group.at)).toBe("g:c1");
    expect(entryKeyOf(tool({ id: "c9" }), 4)).toBe("t:c9");
    expect(entryKeyOf({ kind: "assistant", text: "", reasoning: "", done: true }, 4)).toBe("a:4");
    expect(entryKeyOf({ kind: "user", text: "hi" }, 0)).toBe("u:0");
  });
});

describe("foldToggleKey (hotkey routing)", () => {
  it("triggers on x/X with an empty, idle editor", () => {
    expect(foldToggleKey("x", { text: "", autocomplete: false })).toBe(true);
    expect(foldToggleKey("X", { text: "", autocomplete: false })).toBe(true);
  });

  it("never triggers with non-empty input or autocomplete", () => {
    expect(foldToggleKey("x", { text: "m", autocomplete: false })).toBe(false);
    expect(foldToggleKey("x", { text: "", autocomplete: true })).toBe(false);
    expect(foldToggleKey("c", { text: "", autocomplete: false })).toBe(false);
  });
});

let seq = 0;
const ev = (type: string, data: unknown, timestamp = "2026-01-01T00:00:00.000Z"): RunEvent => ({
  schemaVersion: 1,
  runId: "r1",
  sessionId: "s1",
  seq: ++seq,
  type,
  timestamp,
  data,
});

describe("event reduction carries the presentation model", () => {
  it("records effect-derived toolKind and JSON exit codes", () => {
    let view: ViewState = initialViewState("m");
    view = reduceEvent(
      view,
      ev("tool_started", {
        id: "c1",
        name: "read_file",
        effect: "read",
        arguments: '{"path":"a"}',
      }),
    );
    view = reduceEvent(
      view,
      ev("tool_completed", {
        id: "c1",
        name: "read_file",
        isError: false,
        preview: JSON.stringify({ stdout: "ok", stderr: "", exitCode: 0, truncated: false }),
      }),
    );
    view = reduceEvent(
      view,
      ev("tool_started", {
        id: "c2",
        name: "run_process",
        effect: "process",
        arguments: '{"command":"ls"}',
      }),
    );
    view = reduceEvent(
      view,
      ev("tool_completed", {
        id: "c2",
        name: "run_process",
        isError: false,
        preview: JSON.stringify({ stdout: "", stderr: "denied", exitCode: 1, truncated: false }),
      }),
    );
    view = reduceEvent(
      view,
      ev("tool_started", { id: "c3", name: "mcp_table", effect: "external", arguments: "{}" }),
    );
    view = reduceEvent(
      view,
      ev("tool_completed", { id: "c3", name: "mcp_table", isError: false, preview: "text" }),
    );
    const [read, run, mcp] = view.items.filter((i) => i.kind === "tool");
    expect(read).toMatchObject({ toolKind: "read", exitCode: 0 });
    expect(run).toMatchObject({ toolKind: "process", exitCode: 1 });
    expect(mcp).toMatchObject({ toolKind: "mcp" });
    if (mcp?.kind === "tool") expect(mcp.exitCode).toBeUndefined();
  });

  it("stamps the reasoning interval from delta timestamps", () => {
    let view: ViewState = initialViewState("m");
    view = reduceEvent(view, ev("reasoning_delta", { delta: "let " }, "2026-01-01T00:00:01.000Z"));
    view = reduceEvent(
      view,
      ev("reasoning_delta", { delta: "me think" }, "2026-01-01T00:00:02.000Z"),
    );
    view = reduceEvent(view, ev("reasoning_delta", { delta: " more" }, "2026-01-01T00:00:03.900Z"));
    view = reduceEvent(view, ev("text_delta", { delta: "Ans" }, "2026-01-01T00:00:04.000Z"));
    view = reduceEvent(view, ev("turn_completed", { usage: { input: 1, output: 1 } }));
    const item = view.items.at(-1);
    expect(item?.kind).toBe("assistant");
    if (item?.kind === "assistant") {
      expect(reasoningDurationMs(item)).toBe(2900); // 1.000s → 3.900s
      expect(item.reasoning).toBe("let me think more");
    }
  });

  it("replays toolKind and exit codes from history", () => {
    const messages: Message[] = [
      { role: "user", text: "go" },
      {
        role: "assistant",
        text: "ok",
        calls: [{ id: "c1", name: "shell", arguments: "{}" }],
      },
      {
        role: "tool",
        callId: "c1",
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({ stdout: "x", stderr: "", exitCode: 3, truncated: false }),
            },
          ],
        },
      },
    ];
    const item = itemsFromHistory(messages).find((i) => i.kind === "tool");
    expect(item).toMatchObject({ toolKind: "process", exitCode: 3 });
  });
});
