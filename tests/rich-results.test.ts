import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Message,
  type RunEvent,
  type ToolCall,
  type ToolResult,
  textProjection,
  textResult,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { reduceMessageSizes, serializeForSummary } from "../packages/core/src/core/compaction.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { mapMcpCallResult } from "../packages/core/src/mcp/rich.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** A realistic MCP-ish result through the real adapter: plain text + image + a table block. */
const richMcpResult = mapMcpCallResult({
  content: [
    { type: "text", text: "bench summary" },
    { type: "image", mimeType: "image/png", data: PNG_1PX },
  ],
  structuredContent: {
    columns: ["name", "ms"],
    rows: [
      ["parse", "12"],
      ["render", "300"],
    ],
  },
});

const richToolResult: ToolResult = {
  content: [
    { type: "text", text: "ignored by compaction" },
    {
      type: "ui",
      block: { kind: "key-value", entries: [["a", "1"]] },
    },
    { type: "image", mimeType: "image/png", data: PNG_1PX },
  ],
};

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "alisio-rich-"));
  const store = new SQLiteStore(join(root, "store.sqlite"));
  const registry = new ToolRegistry();
  return {
    root,
    store,
    registry,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const completed = (
  text: string,
  calls: ToolCall[] = [],
): Extract<Message, { role: "assistant" }> => ({ role: "assistant", text, calls });

const recorder = () => {
  const events: RunEvent[] = [];
  return { events, onEvent: (event: RunEvent) => events.push(event) };
};

describe("textProjection (SDK)", () => {
  it("keeps only text parts, in order, and preserves isError", () => {
    const result = textResult("first");
    result.content.push({ type: "ui", block: { kind: "markdown", text: "# x" } });
    result.content.push({ type: "text", text: "last" });
    result.isError = true;
    expect(textProjection(result)).toEqual({
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "last" },
      ],
      isError: true,
    });
  });
});

describe("store persistence (ui/image parts survive endCall and replay)", () => {
  it("round-trips rich parts through endCall/callResult and appended messages", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      fx.store.beginCall(session.id, { id: "c1", name: "rich", arguments: "{}" });
      fx.store.endCall(session.id, { id: "c1", name: "rich", arguments: "{}" }, richMcpResult);
      const replayed = fx.store.callResult(session.id, "c1");
      expect(replayed).toEqual(richMcpResult);
      expect(replayed?.content.some((p) => p.type === "ui")).toBe(true);
      expect(replayed?.content.some((p) => p.type === "image")).toBe(true);

      fx.store.append(session.id, { role: "tool", callId: "c1", result: richMcpResult });
      const messages = fx.store.messages(session.id);
      const tool = messages.find((m) => m.role === "tool");
      const replay = tool && tool.role === "tool" ? tool.result : undefined;
      expect(replay?.content).toEqual(richMcpResult.content);
    } finally {
      await fx.close();
    }
  });

  it("resolves callResult only for completed calls", async () => {
    const fx = await fixture();
    try {
      const session = fx.store.create(fx.root, "test", "test");
      fx.store.beginCall(session.id, { id: "c1", name: "rich", arguments: "{}" });
      expect(fx.store.callResult(session.id, "c1")).toBeUndefined();
      fx.store.endCall(session.id, { id: "c1", name: "rich", arguments: "{}" }, textResult("ok"));
      expect(fx.store.callResult(session.id, "c1")?.content[0]).toEqual({
        type: "text",
        text: "ok",
      });
    } finally {
      await fx.close();
    }
  });
});

describe("compaction (text projection only, ui/image never clipped or summarized)", () => {
  it("clips only text parts and keeps ui/image parts intact", () => {
    const message: Message = {
      role: "tool",
      callId: "c1",
      result: {
        content: [
          { type: "text", text: "x".repeat(20_000) },
          { type: "ui", block: { kind: "tree", nodes: [{ label: "root" }] } },
          { type: "image", mimeType: "image/png", data: PNG_1PX },
        ],
      },
    };
    const { messages, truncated } = reduceMessageSizes([message], { maxToolResultChars: 1_000 });
    expect(truncated).toBe(1);
    const reduced = messages[0];
    expect(reduced && "result" in reduced ? reduced.result : undefined).toBeDefined();
    const result = reduced && "result" in reduced ? reduced.result : undefined;
    const text = result?.content.find((p) => p.type === "text");
    expect(text && "text" in text ? text.text : "").toContain("[truncated by context budget]");
    expect(text && "text" in text ? text.text.length : 0).toBeLessThanOrEqual(1000 + 31 + 1);
    // ui/image parts were never touched.
    expect(result?.content.some((p) => p.type === "ui")).toBe(true);
    expect(result?.content.some((p) => p.type === "image")).toBe(true);
  });

  it("does not count ui/image parts against the tool-result cap", () => {
    const messages: Message[] = [
      { role: "user", text: "u" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "rich", arguments: "{}" }] },
      { role: "tool", callId: "c1", result: richToolResult },
    ];
    const { messages: reduced, truncated } = reduceMessageSizes(messages, {
      maxToolResultChars: 100,
    });
    // The only text part ("ignored by compaction" = 19 chars) fits under 100: nothing clipped.
    expect(truncated).toBe(0);
    expect(reduced).toEqual(messages);
  });

  it("serializeForSummary keeps only the text projection (no bytes, no undefined)", () => {
    const messages: Message[] = [
      { role: "user", text: "list" },
      { role: "assistant", text: "", calls: [{ id: "c1", name: "rich", arguments: "{}" }] },
      { role: "tool", callId: "c1", result: richMcpResult },
    ];
    const summary = serializeForSummary(messages);
    expect(summary).toContain("TOOL RESULT c1");
    expect(summary).toContain("bench summary");
    expect(summary).toContain("| parse | 12 |"); // table projection
    expect(summary).toContain("[image: image/png"); // image marker, not bytes
    expect(summary).not.toContain(PNG_1PX);
    expect(summary).not.toContain("undefined");
  });
});

describe("runner (provider sees only the text projection; store keeps rich parts)", () => {
  it("streams tool results to the model as text while persisting ui/image parts", async () => {
    const fx = await fixture();
    try {
      fx.registry.register({
        name: "rich",
        effect: "read",
        description: "rich",
        inputSchema: { type: "object" },
        async execute() {
          return richMcpResult;
        },
      });
      let round = 0;
      const seen: Message[][] = [];
      const provider = {
        id: "test",
        model: "test",
        async *stream(request: { messages: Message[] }) {
          seen.push(request.messages);
          round++;
          if (round === 1)
            yield {
              type: "completed",
              message: completed("using rich", [{ id: "c1", name: "rich", arguments: "{}" }]),
            };
          else yield { type: "completed", message: completed("done", []) };
        },
      } as any;
      const session = fx.store.create(fx.root, "test", "test");
      const { events, onEvent } = recorder();
      const runner = new AgentRunner({
        provider,
        registry: fx.registry,
        store: fx.store,
        context: new ProjectContext(fx.root),
        workspace: fx.root,
        policy: { write: false, process: false, external: false },
        onEvent,
      });
      const result = await runner.run(session.id, "use the rich tool");
      expect(result.status).toBe("completed");

      const toolMessage = seen[1]?.find((m) => m.role === "tool");
      expect(toolMessage && "result" in toolMessage ? toolMessage.result : undefined).toBeDefined();
      const sent = toolMessage && "result" in toolMessage ? toolMessage.result : undefined;
      const types = sent?.content.map((p) => p.type);
      expect(types).toEqual(["text", "text"]); // plain text + canonical projection only
      const text = sent?.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("\n");
      expect(text).toContain("bench summary");
      expect(text).toContain("| parse | 12 |"); // canonical table projection
      expect(text).toContain("[image: image/png"); // marker, never bytes
      expect(text).not.toContain(PNG_1PX);

      // The persisted store message still carries the rich parts for TUI replay.
      const stored = fx.store.messages(session.id).find((m) => m.role === "tool");
      const storedResult = stored && "result" in stored ? stored.result : undefined;
      expect(storedResult?.content.some((p) => p.type === "ui")).toBe(true);
      expect(storedResult?.content.some((p) => p.type === "image")).toBe(true);

      // The event preview stays text-only (headless/JSONL consumers see no bytes).
      const completedEvent = events.find((e) => e.type === "tool_completed");
      expect(typeof completedEvent?.data).toBe("object");
      const data = (completedEvent?.data ?? {}) as Record<string, unknown>;
      expect(typeof data.preview).toBe("string");
      expect(String(data.preview)).toContain("bench summary");
      expect(String(data.preview)).not.toContain(PNG_1PX);
    } finally {
      await fx.close();
    }
  });
});
