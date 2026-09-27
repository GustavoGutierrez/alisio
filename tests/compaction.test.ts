import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  checkpointInstructions,
  effectiveContextBudget,
  estimateTokens,
  MAX_TRUSTED_WINDOW,
  parseCheckpointOutput,
  planCompaction,
  reduceMessageSizes,
  reduceMessagesToBudget,
  renderCheckpoint,
  serializeForSummary,
  shouldCompact,
  shouldCompactContext,
} from "../packages/core/src/core/compaction.ts";

const call = (id: string, name = "read_file") => ({ id, name, arguments: `{"path":"${id}.ts"}` });
const tool = (callId: string, text = "ok"): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }] },
});
const history: Message[] = [
  { role: "user", text: "first request" },
  { role: "assistant", text: "", calls: [call("c1"), call("c2")] },
  tool("c1"),
  tool("c2"),
  { role: "assistant", text: "first answer", calls: [] },
  { role: "user", text: "second request" },
  { role: "assistant", text: "", calls: [call("c3")] },
  tool("c3"),
  { role: "assistant", text: "second answer", calls: [] },
  { role: "user", text: "third request" },
  { role: "assistant", text: "third answer", calls: [] },
];

function assertPaired(messages: Message[]) {
  const results = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])));
  const calls = new Set(
    messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : [])),
  );
  for (const id of calls) expect(results.has(id)).toBe(true);
  for (const id of results) expect(calls.has(id)).toBe(true);
}

describe("planCompaction", () => {
  it("keeps the most recent turns intact and cuts at a user boundary", () => {
    const plan = planCompaction(history, { keepTurns: 1 });
    expect(plan).toBeDefined();
    expect(plan?.kept[0]).toEqual({ role: "user", text: "third request" });
    expect(plan?.summarized).toHaveLength(9);
    expect(plan?.kept).toHaveLength(2);
  });

  it("never separates an assistant tool call from its results and keeps IDs", () => {
    for (const keepTurns of [1, 2]) {
      const plan = planCompaction(history, { keepTurns });
      if (!plan) throw new Error("expected a plan");
      assertPaired(plan.summarized);
      assertPaired(plan.kept);
      expect([...plan.summarized, ...plan.kept]).toEqual(history);
    }
    const plan = planCompaction(history, { keepTurns: 2 });
    expect(plan?.kept.flatMap((m) => (m.role === "tool" ? [m.callId] : []))).toEqual(["c3"]);
  });

  it("falls back to an assistant boundary inside one long tool loop", () => {
    const loop: Message[] = [{ role: "user", text: "single long task" }];
    for (let i = 0; i < 8; i++) {
      loop.push({ role: "assistant", text: "", calls: [call(`l${i}`)] }, tool(`l${i}`, "x"));
    }
    const plan = planCompaction(loop, { keepTurns: 2, minKeepMessages: 4 });
    if (!plan) throw new Error("expected a plan");
    expect(plan.kept[0]?.role).toBe("assistant");
    expect(plan.kept.length).toBeGreaterThanOrEqual(4);
    assertPaired(plan.summarized);
    assertPaired(plan.kept);
  });

  it("keeps at least the latest turn intact when history has fewer turns than requested", () => {
    const twoTurns = history.slice(5);
    const shifted: Message[] = [
      { role: "user", text: "zero" },
      { role: "assistant", text: "a", calls: [] },
      ...twoTurns,
    ];
    const plan = planCompaction(shifted, { keepTurns: 5 });
    expect(plan?.kept[0]).toEqual({ role: "user", text: "third request" });
  });

  it("refuses when history has unanswered tool calls or nothing to summarize", () => {
    expect(planCompaction(history.slice(0, 3), { keepTurns: 1 })).toBeUndefined();
    expect(planCompaction(history.slice(9), { keepTurns: 1 })).toBeUndefined();
  });
});

describe("summary input and thresholds", () => {
  it("serializes tool calls with IDs and truncates huge results", () => {
    const text = serializeForSummary(
      [{ role: "assistant", text: "", calls: [call("c9")] }, tool("c9", "y".repeat(10_000))],
      500,
    );
    expect(text).toContain("c9");
    expect(text).toContain("read_file");
    expect(text.length).toBeLessThan(1_500);
    expect(text).toContain("[truncated]");
  });

  it("drops opaque provider continuation data from the summary transcript", () => {
    const text = serializeForSummary([
      {
        role: "assistant",
        text: "visible",
        calls: [],
        providerData: [{ type: "reasoning", encrypted_content: "SECRET-OPAQUE" }],
      },
    ]);
    expect(text).toContain("visible");
    expect(text).not.toContain("SECRET-OPAQUE");
  });

  it("describes an attachment by mime type and dimensions, never its raw bytes", () => {
    const secretBase64 = "QQ==".repeat(1000);
    const text = serializeForSummary([
      {
        role: "user",
        text: "look at this",
        attachments: [
          {
            kind: "image",
            mimeType: "image/png",
            data: secretBase64,
            bytes: 4000,
            width: 800,
            height: 600,
          },
        ],
      },
    ]);
    expect(text).toContain("look at this");
    expect(text).toContain("ATTACHMENT: image/png 800x600, 4000 bytes");
    expect(text).not.toContain(secretBase64);
  });

  it("estimates tokens and applies thresholds only with a known window", () => {
    expect(estimateTokens("abcd".repeat(100))).toBe(100);
    expect(estimateTokens(history)).toBeGreaterThan(0);
    expect(shouldCompact(860, 1000, 0.85)).toBe(true);
    expect(shouldCompact(840, 1000, 0.85)).toBe(false);
    expect(shouldCompact(10_000_000, undefined, 0.85)).toBe(false);
  });

  it("drives auto-compaction from ONE effective budget (window or char fallback)", () => {
    // Known window (<= MAX_TRUSTED_WINDOW): triggers at used >= window * threshold only; the char
    // estimate is irrelevant on this branch.
    expect(shouldCompactContext(860, 0, 1000, 160_000, 0.85)).toBe(true);
    expect(shouldCompactContext(849, 0, 1000, 160_000, 0.85)).toBe(false);
    expect(shouldCompactContext(40_000, 0, 1000, 160_000, 0.85)).toBe(true); // over threshold
    // Unknown window: the raw char estimate (`chars / 4`) drives the fallback, so a provider's
    // token report can never push the session into needless compaction.
    expect(shouldCompactContext(40_000, 160_000, undefined, 160_000, 0.85)).toBe(true);
    expect(shouldCompactContext(40_000, 159_996, undefined, 160_000, 0.85)).toBe(false);
    // A known window does NOT use the char budget; the two never fight.
    expect(shouldCompactContext(39_999, 1_000_000, 1_000_000, 160_000, 0.85)).toBe(false);
  });

  it("treats absurdly large declared windows as unknown so the char fallback protects", () => {
    const huge = MAX_TRUSTED_WINDOW + 1;
    expect(effectiveContextBudget(huge, 160_000)).toEqual({ total: 40_000, basis: "chars" });
    expect(effectiveContextBudget(undefined, 160_000)).toEqual({ total: 40_000, basis: "chars" });
    expect(effectiveContextBudget(0, 160_000)).toEqual({ total: 40_000, basis: "chars" });
    // The guard kicks in before a huge window*s threshold could never be reached in practice.
    expect(shouldCompactContext(40_000, 160_000, huge, 160_000, 0.85)).toBe(true);
    expect(shouldCompactContext(40_000, 0, 1_000_000, 160_000, 0.85)).toBe(false);
    expect(effectiveContextBudget(1_000_000, 160_000)).toEqual({
      total: 1_000_000,
      basis: "window",
    });
  });
});

describe("structured checkpoint", () => {
  const checkpoint = {
    goal: "Add memory",
    instructions: ["Use pnpm"],
    discoveries: ["FTS5 ships with bun:sqlite"],
    accomplished: ["Store"],
    currentState: "Testing",
    nextSteps: ["Wire TUI"],
    relevantFiles: ["src/runtime/store.ts"],
  };
  it("parses JSON (fenced or bare) and returns only requested extension fields", () => {
    const value = { checkpoint, observations: [{ title: "x" }], stray: 1 };
    for (const raw of [
      JSON.stringify(value),
      `ok:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
    ]) {
      const out = parseCheckpointOutput(raw, ["observations"]);
      expect(out.structured).toBe(true);
      expect(out.extracted).toEqual({ observations: [{ title: "x" }] });
      expect(out.text).toBe(renderCheckpoint(checkpoint));
    }
  });
  it("falls back to text-only output when JSON is missing or invalid", () => {
    expect(parseCheckpointOutput("plain {oops", ["observations"])).toEqual({
      structured: false,
      extracted: {},
      text: "plain {oops",
    });
    expect(parseCheckpointOutput('{"checkpoint":{"goal":1}}').structured).toBe(false);
  });
  it("renders every section and lists extension fields in the instructions", () => {
    const text = renderCheckpoint(checkpoint);
    for (const heading of [
      "## Goal",
      "## User instructions/constraints",
      "## Discoveries",
      "## Accomplished",
      "## Current state",
      "## Next steps",
      "## Relevant files",
    ])
      expect(text).toContain(heading);
    const instructions = checkpointInstructions(["Extra guidance"], { notes: "array of strings" });
    expect(instructions).toContain('"notes": array of strings');
    expect(instructions).toContain("Extra guidance");
    expect(checkpointInstructions()).not.toMatch(/observations|memory/i);
  });
});

describe("proportional token budget", () => {
  it("scales with the context window, clamped, with a fallback when unknown", async () => {
    const { defaultTokenBudget } = await import("../packages/core/src/core/runner.ts");
    expect(defaultTokenBudget(undefined)).toBe(1_000_000);
    expect(defaultTokenBudget(32_000)).toBe(400_000);
    expect(defaultTokenBudget(128_000)).toBe(1_024_000);
    expect(defaultTokenBudget(1_048_576)).toBe(8_000_000);
  });
});

describe("reduceMessageSizes", () => {
  const marker = "… [truncated by context budget]";
  const bigTool = (callId: string): Message => ({
    role: "tool",
    callId,
    result: { content: [{ type: "text", text: "x".repeat(20_000) }] },
  });

  it("cuts oversized tool results and texts to the per-message caps with the marker", () => {
    const input: Message[] = [
      { role: "user", text: "u".repeat(20_000) },
      { role: "assistant", text: "a".repeat(40_000), calls: [] },
      bigTool("c1"),
    ];
    const { messages, truncated } = reduceMessageSizes(input);
    expect(truncated).toBe(3);
    const user = messages[0];
    const assistant = messages[1];
    const toolResult = messages[2];
    expect(user?.role).toBe("user");
    expect(assistant?.role).toBe("assistant");
    expect(toolResult?.role).toBe("tool");
    if (user?.role === "user" && assistant?.role === "assistant" && toolResult?.role === "tool") {
      expect(user.text.length).toBe(16_000 + marker.length + 1);
      expect(user.text).toContain(marker);
      expect(assistant.text.length).toBe(16_000 + marker.length + 1);
      expect(toolResult.result.content.find((p) => p.type === "text")?.text.length).toBe(
        8_000 + marker.length + 1,
      );
    }
  });

  it("respects custom caps, leaves small messages alone and keeps structure intact", () => {
    const input: Message[] = [
      { role: "user", text: "ok" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "hello", arguments: "{}" }] },
      bigTool("c1"),
      { role: "user", text: "u".repeat(5_000) },
    ];
    const { messages, truncated } = reduceMessageSizes(input, {
      maxToolResultChars: 1_000,
      maxTextChars: 2_000,
    });
    expect(truncated).toBe(2);
    expect(messages[0]).toEqual(input[0]);
    expect(messages[1]).toEqual(input[1]);
    const toolResult = messages[2];
    expect(toolResult && "result" in toolResult && toolResult.result.isError).toBeUndefined();
    expect(
      toolResult &&
        "result" in toolResult &&
        toolResult.result.content.find((p) => p.type === "text")?.text.length,
    ).toBe(1_000 + marker.length + 1);
    assertPaired(messages);
  });

  it("never truncates compaction checkpoints (summary messages)", () => {
    const input: Message[] = [
      { role: "user", summary: true, text: "c".repeat(30_000) },
      bigTool("c1"),
      { role: "assistant", text: "t".repeat(20_000), calls: [] },
    ];
    const { messages, truncated } = reduceMessageSizes(input);
    expect(truncated).toBe(2);
    expect(messages[0]).toEqual(input[0]);
    expect(messages[1] && "result" in messages[1]!).toBe(true);
  });

  it("returns the input untouched when nothing exceeds the caps", () => {
    const input = history;
    const { messages, truncated } = reduceMessageSizes(input);
    expect(truncated).toBe(0);
    expect(messages).toBe(input);
  });
});

describe("reduceMessagesToBudget", () => {
  const marker = "… [truncated by context budget]";
  const bigTool = (callId: string, size: number): Message => ({
    role: "tool",
    callId,
    result: { content: [{ type: "text", text: "t".repeat(size) }] },
  });
  const serialized = (messages: Message[]) => JSON.stringify(messages).length;
  const mediumTurn = (results: number, size: number): Message[] => [
    { role: "user", text: "task" },
    {
      role: "assistant",
      text: "",
      calls: Array.from({ length: results }, (_, i) => call(`c${i}`)),
    },
    ...Array.from({ length: results }, (_, i) => bigTool(`c${i}`, size)),
  ];

  it("brings many medium results (each under the 8k cap) under the target", () => {
    // 25 results of 7 000 chars: every one individually under MAX_TOOL_RESULT_CHARS, together
    // ~180k — the per-message reducer would report truncated: 0, the budget reducer must not.
    const input = mediumTurn(25, 7_000);
    expect(serialized(input)).toBeGreaterThan(170_000);
    const { messages, truncated } = reduceMessagesToBudget(input, 60_000);
    expect(truncated).toBeGreaterThan(0);
    expect(serialized(messages)).toBeLessThanOrEqual(60_000);
    expect(messages.map((m) => m.role)).toEqual(input.map((m) => m.role));
    assertPaired(messages);
  });

  it("clips the largest items first so the smallest changes achieve the target", () => {
    const input = mediumTurn(3, 0).slice(0, 2); // user + assistant with 3 calls
    input.push(bigTool("c0", 30_000), bigTool("c1", 20_000), bigTool("c2", 10_000));
    // ~61k total; clipping the two biggest to 8k (~27k) fits a 35k target.
    const { messages, truncated } = reduceMessagesToBudget(input, 35_000);
    expect(truncated).toBe(2);
    expect(serialized(messages)).toBeLessThanOrEqual(35_000);
    const texts = messages
      .filter((m) => m.role === "tool")
      .map((m) =>
        m.role === "tool"
          ? m.result.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : "",
      );
    expect(texts[0]).toContain(marker);
    expect(texts[1]).toContain(marker);
    expect(texts[2]).toBe("t".repeat(10_000)); // smallest result untouched
  });

  it("breaks ties by position (deterministic total order)", () => {
    const input: Message[] = [
      { role: "user", text: "task" },
      { role: "assistant", text: "", calls: [call("c0"), call("c1")] },
      bigTool("c0", 30_000),
      bigTool("c1", 30_000),
    ];
    const { messages, truncated } = reduceMessagesToBudget(input, serialized(input) - 20_000);
    expect(truncated).toBe(1);
    const texts = messages
      .filter((m) => m.role === "tool")
      .map((m) =>
        m.role === "tool"
          ? m.result.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
          : "",
      );
    expect(texts[0]).toContain(marker);
    expect(texts[1]).toBe("t".repeat(30_000));
  });

  it("is deterministic: same input and target yield the identical transcript", () => {
    const input = mediumTurn(25, 7_000);
    const a = reduceMessagesToBudget(input, 60_000);
    const b = reduceMessagesToBudget(input, 60_000);
    expect(b.messages).toEqual(a.messages);
    expect(b.truncated).toBe(a.truncated);
    expect(a.messages).toEqual(b.messages); // and toEqual is symmetric on the transcript
    const c = reduceMessagesToBudget([...input], 60_000);
    expect(c.messages).toEqual(a.messages);
  });

  it("never truncates summary checkpoints, even at the minimum caps", () => {
    const calls = Array.from({ length: 5 }, (_, i) => call(`c${i}`));
    const input: Message[] = [
      { role: "user", summary: true, text: "s".repeat(30_000) },
      { role: "assistant", text: "", calls },
      ...Array.from({ length: 5 }, (_, i) => bigTool(`c${i}`, 30_000)),
    ];
    const { messages, truncated } = reduceMessagesToBudget(input, 5_000);
    expect(truncated).toBe(5);
    expect(messages[0]).toEqual(input[0]);
    expect(messages[0]?.role).toBe("user");
    expect(messages[0] && "text" in messages[0] && messages[0].text).toBe("s".repeat(30_000));
    assertPaired(messages);
  });

  it("stops at the minimum caps (tool 512 / text 1024) when the target is unreachable", () => {
    const input: Message[] = Array.from({ length: 60 }, (_, i) =>
      i % 2 === 0 ? { role: "user" as const, text: "u".repeat(20_000) } : bigTool(`c${i}`, 20_000),
    );
    const { messages, truncated } = reduceMessagesToBudget(input, 1_000);
    expect(truncated).toBe(60);
    for (const m of messages) {
      if (m.role === "user") expect(m.text.length).toBeLessThanOrEqual(1024 + marker.length + 1);
      else if (m.role === "tool") {
        const text = m.result.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
        expect(text.length).toBeLessThanOrEqual(512 + marker.length + 1);
        expect(text).toContain(marker);
      }
    }
  });

  it("honors custom starting caps and descends from them", () => {
    const input = [...mediumTurn(1, 0).slice(0, 2), bigTool("c0", 20_000)]; // user + call + result
    const { messages, truncated } = reduceMessagesToBudget(input, 6_000, {
      maxToolResultChars: 1_000,
    });
    expect(truncated).toBe(1);
    const tool = messages[2];
    const text =
      tool && tool.role === "tool"
        ? tool.result.content
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : "";
    expect(text.length).toBe(1_000 + marker.length + 1);
    expect(text).toContain(marker);
  });

  it("returns the input untouched when the target already fits", () => {
    const input = history;
    const { messages, truncated } = reduceMessagesToBudget(input, 10_000);
    expect(truncated).toBe(0);
    expect(messages).toBe(input);
  });
});
