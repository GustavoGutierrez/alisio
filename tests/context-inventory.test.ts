import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../packages/core/src/context/inventory.ts";
import type { ContextSegment } from "../packages/core/src/context/types.ts";
import { estimateTokens } from "../packages/core/src/core/compaction.ts";

const user = (text: string): Message => ({ role: "user", text });
const asst = (text: string, calls: Array<[string, string, object]> = []): Message => ({
  role: "assistant",
  text,
  calls: calls.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});
const result = (callId: string, text: string, isError = false): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
});
const readOut = (path: string, sha256: string) =>
  JSON.stringify({ path, sha256, startLine: 1, content: "1: x", truncated: false });

/** Finds the one segment of `kind` whose origin matches, optionally the nth (0-based). */
function find(
  segments: ContextSegment[],
  kind: ContextSegment["kind"],
  origin: string,
  nth = 0,
): ContextSegment {
  const hit = segments.filter((s) => s.kind === kind && s.origin === origin)[nth];
  if (!hit) throw new Error(`no ${kind} segment with origin ${origin} (#${nth})`);
  return hit;
}

/** An old turn followed by a closing turn so earlier messages are outside the last turn. */
const closing: Message[] = [user("next"), asst("done")];

describe("buildInventory kinds, origins and tokens", () => {
  it("classifies every message and explains it", () => {
    const messages: Message[] = [
      user("fix it"),
      asst("looking", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "h1")),
      asst("all good"),
    ];
    const { segments } = buildInventory(messages);
    expect(segments.map((s) => [s.kind, s.origin])).toEqual([
      ["user", "user"],
      ["assistant", "assistant"],
      ["tool_call", "a.ts"],
      ["tool_result", "a.ts"],
      ["assistant", "assistant"],
    ]);
    for (const s of segments) expect(s.reason?.length).toBeGreaterThan(0);
  });

  it("uses the tool name as origin when the call has no path", () => {
    const { segments } = buildInventory([
      user("run"),
      asst("", [["c1", "bg_output", { id: "t1" }]]),
      result("c1", "{}"),
    ]);
    expect(find(segments, "tool_call", "bg_output")).toBeDefined();
    expect(find(segments, "tool_result", "bg_output")).toBeDefined();
  });

  it("marks injected checkpoint summaries as checkpoint segments", () => {
    const { segments } = buildInventory([{ role: "user", text: "summary body", summary: true }]);
    expect(segments[0]?.kind).toBe("checkpoint");
  });

  it("keeps a result without a known call as an unattributed tool_result", () => {
    const { segments } = buildInventory([result("ghost", "orphan")]);
    expect(segments[0]).toMatchObject({ kind: "tool_result", origin: "tool" });
  });

  it("estimates tokens with the shared estimator", () => {
    const { segments } = buildInventory([user("x".repeat(40))]);
    expect(segments[0]?.tokens).toBe(estimateTokens("x".repeat(40)));
  });

  it("is deterministic", () => {
    const messages = [user("a"), asst("b", [["c", "read_file", { path: "p" }]]), result("c", "r")];
    expect(buildInventory(messages)).toEqual(buildInventory(messages));
  });
});

describe("buildInventory pinned context", () => {
  it("emits pinned segments for invariants, checkpoint instructions and the goal", () => {
    const { segments } = buildInventory([user("hi")], {
      invariants: ["never touch prod"],
      checkpointInstructions: ["use pnpm"],
      goal: "ship phase 1",
    });
    const pinned = segments.filter((s) => s.criticality === "pinned");
    expect(pinned.map((s) => s.kind).sort()).toEqual(["checkpoint", "instructions", "invariant"]);
    for (const s of pinned) expect(s.reason).toBeTruthy();
  });

  it("emits nothing extra without a context", () => {
    expect(buildInventory([user("hi")]).segments).toHaveLength(1);
  });
});

describe("buildInventory criticality", () => {
  it("protects the last turn: last assistant, its results and the trailing user message", () => {
    const messages: Message[] = [
      user("old"),
      asst("", [["c1", "bg_output", { id: "t" }]]),
      result("c1", "old out"),
      asst("", [["c2", "bg_output", { id: "t" }]]),
      result("c2", "new out"),
      user("trailing"),
    ];
    const { segments } = buildInventory(messages);
    const results = segments.filter((s) => s.kind === "tool_result");
    expect(results[0]?.criticality).toBe("low"); // older bg_output of the same task
    expect(results[1]?.criticality).toBe("high");
    expect(results[1]?.reason).toMatch(/last turn/i);
    expect(segments.at(-1)).toMatchObject({ kind: "user", criticality: "high" });
  });

  it("a superseded read (later read with a different sha256) is low", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "old")),
      asst("", [["c2", "read_file", { path: "a.ts" }]]),
      result("c2", readOut("a.ts", "new")),
      ...closing,
    ]);
    const first = find(segments, "tool_result", "a.ts", 0);
    const second = find(segments, "tool_result", "a.ts", 1);
    expect(first.criticality).toBe("low");
    expect(first.reason).toMatch(/superseded/i);
    expect(second.criticality).toBe("high");
    expect(second.reason).toMatch(/latest result/i);
  });

  it("a re-read with the same sha256 does not supersede the earlier read", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "same")),
      asst("", [["c2", "read_file", { path: "a.ts" }]]),
      result("c2", readOut("a.ts", "same")),
      ...closing,
    ]);
    expect(find(segments, "tool_result", "a.ts", 0).criticality).toBe("normal");
  });

  it("a read followed by an edit_file of the same path is low", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "h1")),
      asst("", [["c2", "edit_file", { path: "a.ts" }]]),
      result("c2", JSON.stringify({ path: "a.ts", sha256: "h2" })),
      ...closing,
    ]);
    expect(find(segments, "tool_result", "a.ts", 0)).toMatchObject({ criticality: "low" });
    expect(find(segments, "tool_result", "a.ts", 1).criticality).toBe("high");
  });

  it("a failed edit does not supersede the earlier read", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "h1")),
      asst("", [["c2", "edit_file", { path: "a.ts" }]]),
      result("c2", "precondition failed", true),
      ...closing,
    ]);
    expect(find(segments, "tool_result", "a.ts", 0).criticality).toBe("normal");
  });

  it("reads of different paths do not supersede each other", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "read_file", { path: "a.ts" }]]),
      result("c1", readOut("a.ts", "h1")),
      asst("", [["c2", "read_file", { path: "b.ts" }]]),
      result("c2", readOut("b.ts", "h2")),
      ...closing,
    ]);
    expect(find(segments, "tool_result", "a.ts").criticality).toBe("high"); // last result for a.ts
    expect(find(segments, "tool_result", "b.ts").criticality).toBe("high");
  });

  it("an identical search_text repeated with the same output makes the older one low", () => {
    const args = { pattern: "foo", path: "src" };
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "search_text", args]]),
      result("c1", "match"),
      asst("", [["c2", "search_text", args]]),
      result("c2", "match"),
      ...closing,
    ]);
    const results = segments.filter((s) => s.kind === "tool_result");
    expect(results[0]).toMatchObject({ criticality: "low" });
    expect(results[0]?.reason).toMatch(/duplicate/i);
    expect(results[1]?.criticality).toBe("normal");
  });

  it("a search_text with the same arguments but different output is not a duplicate", () => {
    const args = { pattern: "foo" };
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "search_text", args]]),
      result("c1", "one"),
      asst("", [["c2", "search_text", args]]),
      result("c2", "two"),
      ...closing,
    ]);
    expect(segments.filter((s) => s.kind === "tool_result").map((s) => s.criticality)).toEqual([
      "normal",
      "normal",
    ]);
  });

  it("an older bg_output of the same task is low; another task is untouched", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "bg_output", { id: "t1" }]]),
      result("c1", "x"),
      asst("", [["c2", "bg_output", { id: "t2" }]]),
      result("c2", "y"),
      asst("", [["c3", "bg_output", { id: "t1" }]]),
      result("c3", "z"),
      ...closing,
    ]);
    const crits = segments.filter((s) => s.kind === "tool_result").map((s) => s.criticality);
    expect(crits).toEqual(["low", "normal", "normal"]);
  });

  it("protects an error result of the last turn with its own reason", () => {
    const { segments } = buildInventory([
      user("a"),
      asst("", [["c1", "run_command", { command: "false" }]]),
      result("c1", "exit 1", true),
    ]);
    const r = find(segments, "tool_result", "run_command");
    expect(r.criticality).toBe("high");
    expect(r.reason).toMatch(/error/i);
  });

  it("never marks user messages low, even in old turns", () => {
    const { segments } = buildInventory([
      user("old request"),
      asst("a"),
      user("mid"),
      asst("b"),
      user("new"),
      asst("c"),
    ]);
    for (const s of segments.filter((x) => x.kind === "user"))
      expect(s.criticality).not.toBe("low");
  });

  it("pinned beats every other rule", () => {
    const { segments } = buildInventory([user("a")], { goal: "g" });
    expect(segments.find((s) => s.kind === "instructions")?.criticality).toBe("pinned");
  });
});

describe("buildInventory ids and totals", () => {
  const base: Message[] = [
    user("a"),
    asst("b", [["c1", "read_file", { path: "a.ts" }]]),
    result("c1", readOut("a.ts", "h1")),
  ];

  it("produces the same ids for the same input", () => {
    expect(buildInventory(base).segments.map((s) => s.id)).toEqual(
      buildInventory(structuredClone(base)).segments.map((s) => s.id),
    );
  });

  it("does not change earlier ids when a message is appended", () => {
    const before = buildInventory(base).segments.map((s) => s.id);
    const after = buildInventory([...base, user("more"), asst("ok")]).segments.map((s) => s.id);
    expect(after.slice(0, before.length)).toEqual(before);
  });

  it("gives distinct ids to distinct segments and 12 hex chars", () => {
    const ids = buildInventory(base).segments.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes the id when content changes", () => {
    const a = buildInventory([user("a")]).segments[0]?.id;
    const b = buildInventory([user("b")]).segments[0]?.id;
    expect(a).not.toBe(b);
  });

  it("totals add up to the sum of segment tokens, by kind and by criticality", () => {
    const inv = buildInventory([...base, ...closing], { invariants: ["keep"], goal: "g" });
    const sum = inv.segments.reduce((n, s) => n + s.tokens, 0);
    expect(inv.totalTokens).toBe(sum);
    const sumBy = (rec: Record<string, { count: number; tokens: number }>) =>
      Object.values(rec).reduce((n, t) => n + t.tokens, 0);
    const countBy = (rec: Record<string, { count: number; tokens: number }>) =>
      Object.values(rec).reduce((n, t) => n + t.count, 0);
    expect(sumBy(inv.byKind)).toBe(sum);
    expect(sumBy(inv.byCriticality)).toBe(sum);
    expect(countBy(inv.byKind)).toBe(inv.segments.length);
    expect(countBy(inv.byCriticality)).toBe(inv.segments.length);
  });
});
