import type { Message, RunEvent, ServerFrame, SessionDetailWire } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  addLocalNote,
  applyFrame,
  applyFrames,
  emptyTranscript,
  failEcho,
  localEcho,
  prependOlder,
  type TranscriptState,
  visibleItems,
} from "../packages/web/src/store/transcript.ts";

const SID = "s1";
const session: SessionDetailWire = {
  id: SID,
  workspaceId: "w1",
  workspace: "/ws",
  provider: "fake",
  model: "m",
  status: "idle",
};
const user = (text: string, extra: Partial<Extract<Message, { role: "user" }>> = {}): Message => ({
  role: "user",
  text,
  ...extra,
});
const assistant = (text: string, calls: Array<{ id: string; name: string }> = []): Message => ({
  role: "assistant",
  text,
  calls: calls.map((c) => ({ ...c, arguments: '{"path":"README.md"}' })),
});
const tool = (callId: string, text: string, isError = false): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }], ...(isError ? { isError } : {}) },
});

const snapshot = (
  items: Array<{ seq: number; message: Message }>,
  extra: Partial<Extract<ServerFrame, { t: "snapshot" }>> = {},
): ServerFrame => ({
  t: "snapshot",
  sessionId: SID,
  cursor: 10,
  session,
  messages: { items: items.map((i) => ({ ...i, compacted: false })), hasMore: false },
  pending: { approvals: [], interactions: [] },
  ...extra,
});
let eventSeq = 100;
const event = (type: string, data: unknown, runId = "r1"): ServerFrame => {
  eventSeq++;
  const e: RunEvent = {
    schemaVersion: 1,
    runId,
    sessionId: SID,
    seq: eventSeq,
    type,
    timestamp: new Date(0).toISOString(),
    data,
    eventId: String(eventSeq),
  };
  return { t: "event", sessionId: SID, event: e };
};
const delta = (fields: Partial<Extract<ServerFrame, { t: "delta" }>>): ServerFrame => ({
  t: "delta",
  sessionId: SID,
  runId: "r1",
  ...fields,
});
const message = (seq: number, m: Message): ServerFrame => ({
  t: "message",
  sessionId: SID,
  seq,
  message: m,
});
const kinds = (state: TranscriptState) =>
  visibleItems(state).map((i) => (i.kind === "tool" ? `tool:${i.tool.name}` : i.kind));

describe("transcript reducer", () => {
  it("replaces all state from a snapshot, rebuilding tool rows from calls and results", () => {
    const state = applyFrame(
      emptyTranscript(SID),
      snapshot([
        { seq: 1, message: user("read it") },
        { seq: 2, message: assistant("", [{ id: "c1", name: "read_file" }]) },
        { seq: 3, message: tool("c1", "# Title") },
        { seq: 4, message: assistant("Done.") },
      ]),
    );
    expect(state.cursor).toBe(10);
    expect(state.session?.id).toBe(SID);
    expect(kinds(state)).toEqual(["user", "tool:read_file", "assistant"]);
    expect(state.tools.c1).toMatchObject({ status: "completed", name: "read_file" });
    expect(state.tools.c1?.result?.content[0]).toEqual({ type: "text", text: "# Title" });
  });

  it("skips empty assistant text and shows compaction checkpoints as a summary notice", () => {
    const state = applyFrame(
      emptyTranscript(SID),
      snapshot([
        { seq: 1, message: user("summary of earlier work", { summary: true }) },
        { seq: 2, message: user("/init", { display: "/init" }) },
      ]),
    );
    const items = visibleItems(state);
    expect(items[0]).toMatchObject({ kind: "notice", code: "summary" });
    expect(items[1]).toMatchObject({ kind: "user", text: "/init" });
  });

  it("restores the in-flight run of a snapshot (text, reasoning and running tools)", () => {
    const state = applyFrame(
      emptyTranscript(SID),
      snapshot([{ seq: 1, message: user("go") }], {
        inflight: {
          runId: "r1",
          status: "running",
          text: "partial",
          reasoning: "thinking",
          tools: [
            {
              id: "c9",
              name: "shell",
              arguments: "{}",
              effect: "process",
              startedAt: 0,
              tail: "out",
            },
          ],
        },
      }),
    );
    expect(state.live).toMatchObject({ runId: "r1", text: "partial", reasoning: "thinking" });
    expect(state.tools.c9).toMatchObject({ status: "running", tail: "out" });
    expect(kinds(state)).toEqual(["user", "think", "tool:shell", "streaming"]);
  });

  it("concatenates coalesced deltas and progress into the live run", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = applyFrames(state, [
      event("run_started", { model: "m" }),
      delta({ reasoning: "Let me " }),
      delta({ reasoning: "look", text: "Hel" }),
      delta({ text: "lo" }),
    ]);
    expect(state.live).toMatchObject({ text: "Hello", reasoning: "Let me look" });
    state = applyFrames(state, [
      event("tool_started", { id: "c1", name: "shell", arguments: "{}", effect: "process" }),
      delta({ progress: [{ toolId: "c1", chunk: "line1\n" }] }),
      delta({ progress: [{ toolId: "c1", chunk: "line2\n" }] }),
    ]);
    expect(state.tools.c1).toMatchObject({ status: "running", tail: "line1\nline2\n" });
  });

  it("replaces the live text with the durable message and keeps its reasoning as Think", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([{ seq: 1, message: user("hi") }]));
    state = applyFrames(state, [
      event("run_started", { model: "m" }),
      delta({ reasoning: "ponder", text: "Hello" }),
      message(2, assistant("Hello")),
    ]);
    expect(state.live?.text).toBe("");
    expect(state.live?.reasoning).toBe("");
    const items = visibleItems(state);
    expect(items.at(-1)).toMatchObject({ kind: "assistant", text: "Hello", think: "ponder" });
    state = applyFrame(state, event("run_completed", { tokens: 3, text: "Hello" }));
    expect(state.live).toBeUndefined();
  });

  it("attaches tool completion and results to rows regardless of arrival order", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = applyFrames(state, [
      event("run_started", { model: "m" }),
      message(1, assistant("", [{ id: "c1", name: "read_file" }])),
      event("tool_started", {
        id: "c1",
        name: "read_file",
        arguments: '{"path":"a"}',
        effect: "read",
      }),
      event("tool_completed", {
        id: "c1",
        name: "read_file",
        isError: true,
        durationMs: 12,
        preview: "nope",
      }),
      {
        t: "tool_result",
        sessionId: SID,
        runId: "r1",
        callId: "c1",
        result: { content: [{ type: "text", text: "nope" }], isError: true },
      },
    ]);
    expect(state.tools.c1).toMatchObject({ status: "failed", durationMs: 12, preview: "nope" });
    // The row shows once, under its assistant message, not again in the live section.
    expect(kinds(state).filter((k) => k === "tool:read_file")).toHaveLength(1);
  });

  it("replaces the local echo with the durable user message", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = localEcho(state, {
      localId: "l1",
      requestId: "q1",
      text: "expanded",
      display: "/greet",
    });
    expect(kinds(state)).toEqual(["echo"]);
    state = applyFrame(state, message(1, user("expanded", { display: "/greet" })));
    expect(state.echoes).toEqual([]);
    expect(kinds(state)).toEqual(["user"]);
  });

  it("keeps a failed echo visible with its error and drops echoes a snapshot already has", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = localEcho(state, { localId: "l1", requestId: "q1", text: "one" });
    state = localEcho(state, { localId: "l2", requestId: "q2", text: "two" });
    state = failEcho(state, "l2", "Session is busy");
    state = applyFrame(state, snapshot([{ seq: 1, message: user("one") }]));
    expect(state.echoes).toEqual([
      expect.objectContaining({ localId: "l2", state: "failed", error: "Session is busy" }),
    ]);
  });

  it("ignores duplicate message frames and events of other sessions", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([{ seq: 5, message: user("a") }]));
    state = applyFrame(state, message(5, user("a")));
    state = applyFrame(state, { ...message(6, user("b")), sessionId: "other" } as ServerFrame);
    expect(kinds(state)).toEqual(["user"]);
  });

  it("turns failure, truncation and model change events into notices", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = applyFrames(state, [
      event("run_started", { model: "m" }),
      event("model_changed", { model: "b", previous: "a" }),
      event("response_truncated", { turn: 1, maxOutputTokens: 100 }),
      event("run_failed", { error: "boom" }),
    ]);
    const notices = visibleItems(state).filter((i) => i.kind === "notice");
    expect(notices.map((n) => n.kind === "notice" && n.code)).toEqual([
      "model_changed",
      "response_truncated",
      "run_failed",
    ]);
    expect(notices[2]).toMatchObject({ tone: "error", params: { error: "boom" } });
    expect(state.live).toBeUndefined();
  });

  it("shows context injection rows and advances the cursor with durable events", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = applyFrame(
      state,
      event("session_context_injected", { tokens: 5, sources: ["AGENTS.md"] }),
    );
    expect(visibleItems(state)[0]).toMatchObject({ kind: "context", sources: ["AGENTS.md"] });
    expect(state.cursor).toBe(eventSeq);
  });

  it("keeps local notes across a new snapshot, anchored after the message they followed", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([{ seq: 1, message: user("a") }]));
    state = addLocalNote(state, "**Session statistics**");
    state = applyFrame(
      state,
      snapshot([
        { seq: 1, message: user("a") },
        { seq: 2, message: user("b") },
      ]),
    );
    expect(kinds(state)).toEqual(["user", "note", "user"]);
  });

  it("prepends older pages and records whether more history exists", () => {
    let state = applyFrame(
      emptyTranscript(SID),
      snapshot([{ seq: 10, message: user("new") }], {
        messages: { items: [{ seq: 10, message: user("new"), compacted: false }], hasMore: true },
      }),
    );
    expect(state.hasMore).toBe(true);
    expect(state.oldestSeq).toBe(10);
    state = prependOlder(state, {
      items: [
        { seq: 8, message: user("old"), compacted: false },
        { seq: 9, message: assistant("reply"), compacted: false },
      ],
      hasMore: false,
    });
    expect(visibleItems(state).map((i) => ("text" in i ? i.text : i.kind))).toEqual([
      "old",
      "reply",
      "new",
    ]);
    expect(state.hasMore).toBe(false);
    expect(state.oldestSeq).toBe(8);
  });

  it("updates the session status from session_status frames", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = applyFrame(state, {
      t: "session_status",
      sessionId: SID,
      workspaceId: "w1",
      status: "running",
      title: "New title",
    });
    expect(state.session).toMatchObject({ status: "running", title: "New title" });
  });
});

describe("attachments in the transcript (phase 4)", () => {
  it("keeps attached images for thumbnails and replaces the echo that carried them", () => {
    const image = { kind: "image" as const, mimeType: "image/png", data: "iVBOR", bytes: 5 };
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = localEcho(state, {
      localId: "l1",
      requestId: "q1",
      text: "look",
      attachments: [{ hash: "a".repeat(64), mimeType: "image/png", bytes: 5 }],
      thumbs: ["blob:local"],
    });
    expect(visibleItems(state).find((i) => i.kind === "echo")).toMatchObject({
      echo: { thumbs: ["blob:local"] },
    });
    state = applyFrame(state, message(0, user("look", { attachments: [image] })));
    const items = visibleItems(state);
    expect(items.some((i) => i.kind === "echo")).toBe(false);
    expect(items.find((i) => i.kind === "user")).toMatchObject({
      attachments: 1,
      images: [{ mimeType: "image/png", data: "iVBOR" }],
    });
  });
});

describe("datasets in the transcript (phase 3)", () => {
  const dataset = {
    id: "ds_1",
    name: "sales.csv",
    format: "csv" as const,
    bytes: 10,
    sha256: "x",
    sheets: [{ name: "data", table: "data", rows: 3, columns: 2 }],
  };

  it("shows what the user typed with the dataset chips, and replaces the echo that carried them", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = localEcho(state, {
      localId: "l1",
      requestId: "q1",
      text: "what is in it?",
      datasets: [dataset],
    });
    expect(visibleItems(state).find((i) => i.kind === "echo")).toMatchObject({
      echo: { datasets: [{ id: "ds_1" }] },
    });
    // The server stores the model text (with the summary) and the typed text as `display`.
    state = applyFrame(
      state,
      message(
        0,
        user("what is in it?\n\n[Attached Dataset ds_1 …]", {
          display: "what is in it?",
          datasets: [dataset],
        }),
      ),
    );
    const items = visibleItems(state);
    expect(items.some((i) => i.kind === "echo")).toBe(false);
    expect(items.find((i) => i.kind === "user")).toMatchObject({
      text: "what is in it?",
      datasets: [{ id: "ds_1", name: "sales.csv" }],
    });
  });

  it("keeps the echo of a different prompt when only the typed text differs", () => {
    let state = applyFrame(emptyTranscript(SID), snapshot([]));
    state = localEcho(state, { localId: "l1", requestId: "q1", text: "one", datasets: [dataset] });
    state = applyFrame(
      state,
      message(0, user("two\n\n[Attached …]", { display: "two", datasets: [dataset] })),
    );
    expect(state.echoes).toHaveLength(1);
  });
});
