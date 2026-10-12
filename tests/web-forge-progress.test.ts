/**
 * Web side of Forja progress (Forja spec §11.2): the `ForgeProgress` chunks of a `js_run` /
 * `python_run` call fold into one live view (nested calls by id), never leak into the text tail,
 * survive a reload through the inflight snapshot, and are coalesced to four updates per second
 * without ever dropping a terminal state. Pure reducers, no DOM.
 */
import type { ForgeProgress, ServerFrame } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { describePhase, toolCategory } from "../packages/web/src/store/progress.ts";
import { applyFrame, emptyTranscript } from "../packages/web/src/store/transcript.ts";
import {
  applyForgeProgress,
  callCounts,
  FORGE_FLUSH_MS,
  ForgeThrottle,
  forgeProgressLine,
  parseForgeChunk,
} from "../packages/web/src/util/forge.ts";

const SID = "s1";
const progress = (patch: Partial<ForgeProgress> = {}): ForgeProgress => ({
  kind: "forge",
  executionId: "ex1",
  engine: "javascript-quickjs",
  phase: "running",
  ...patch,
});
const call = (
  callId: number,
  status: "started" | "succeeded" | "failed" | "denied",
  extra: { tool?: string; durationMs?: number } = {},
): ForgeProgress =>
  progress({
    phase: "call",
    call: {
      callId,
      tool: extra.tool ?? "read_file",
      status,
      ...(extra.durationMs !== undefined ? { durationMs: extra.durationMs } : {}),
    },
  });
const chunk = (p: unknown): string => (typeof p === "string" ? p : JSON.stringify(p));
const delta = (toolId: string, ...chunks: unknown[]): ServerFrame => ({
  t: "delta",
  sessionId: SID,
  runId: "r1",
  progress: chunks.map((c) => ({ toolId, chunk: chunk(c) })),
});
const started = (id: string, name: string): ServerFrame => ({
  t: "event",
  sessionId: SID,
  event: {
    schemaVersion: 1,
    runId: "r1",
    sessionId: SID,
    seq: 1,
    type: "tool_started",
    timestamp: new Date(0).toISOString(),
    data: { id, name, arguments: "{}", effect: "read" },
    eventId: "1",
  },
});

describe("ForgeProgress folding", () => {
  it("recognizes only forge objects in a progress chunk", () => {
    expect(parseForgeChunk(JSON.stringify(progress()))).toMatchObject({ kind: "forge" });
    expect(parseForgeChunk('{"kind":"other"}')).toBeUndefined();
    expect(parseForgeChunk("Building 5 components…")).toBeUndefined();
    expect(parseForgeChunk("{not json")).toBeUndefined();
    expect(parseForgeChunk("123")).toBeUndefined();
  });

  it("keeps one row per nested call, in order of first appearance, updated in place", () => {
    let view = applyForgeProgress(undefined, call(1, "started", { tool: "list_files" }));
    view = applyForgeProgress(view, call(2, "started", { tool: "read_file" }));
    view = applyForgeProgress(view, call(1, "succeeded", { tool: "list_files", durationMs: 12 }));
    view = applyForgeProgress(view, call(3, "denied", { tool: "write_file" }));
    expect(view.calls).toEqual([
      { callId: 1, tool: "list_files", status: "succeeded", durationMs: 12 },
      { callId: 2, tool: "read_file", status: "started" },
      { callId: 3, tool: "write_file", status: "denied" },
    ]);
    expect(callCounts(view)).toEqual({ total: 3, running: 1, failed: 0, denied: 1 });
  });

  it("tracks phase, message and the completed/total counters without losing calls", () => {
    let view = applyForgeProgress(undefined, progress({ phase: "preparing", message: "Starting" }));
    view = applyForgeProgress(view, call(1, "started"));
    view = applyForgeProgress(view, progress({ completed: 3, total: 7, message: "Reading" }));
    expect(view).toMatchObject({ phase: "running", message: "Reading", completed: 3, total: 7 });
    expect(view.calls).toHaveLength(1);
    expect(forgeProgressLine(view)).toBe("Reading · 3/7");
    expect(forgeProgressLine(undefined)).toBe("");
  });

  it("starts over when a different execution reports (a new run of the same card)", () => {
    let view = applyForgeProgress(undefined, call(1, "succeeded"));
    view = applyForgeProgress(view, progress({ executionId: "ex2", phase: "preparing" }));
    expect(view.executionId).toBe("ex2");
    expect(view.calls).toEqual([]);
  });

  it("routes forge chunks to the call's live view and keeps them out of the text tail", () => {
    let state = applyFrame(emptyTranscript(SID), started("c1", "js_run"));
    state = applyFrame(
      state,
      delta("c1", "plain output\n", call(1, "started", { tool: "glob" }), { kind: "other", n: 1 }),
    );
    const tool = state.tools.c1;
    expect(tool?.forge?.calls).toEqual([{ callId: 1, tool: "glob", status: "started" }]);
    // Text and non-forge JSON still behave like any progress; the forge object never appears.
    expect(tool?.tail).toBe('plain output\n{"kind":"other","n":1}');
  });

  it("restores the latest progress of a running call from the inflight snapshot", () => {
    const latest = call(2, "started", { tool: "search_text" });
    const state = applyFrame(emptyTranscript(SID), {
      t: "snapshot",
      sessionId: SID,
      cursor: 5,
      session: {
        id: SID,
        workspaceId: "w",
        workspace: "/w",
        provider: "p",
        model: "m",
        status: "running",
      },
      messages: { items: [], hasMore: false },
      pending: { approvals: [], interactions: [] },
      inflight: {
        runId: "r1",
        status: "running",
        text: "",
        reasoning: "",
        tools: [
          {
            id: "c1",
            name: "js_run",
            arguments: "{}",
            effect: "read",
            startedAt: 0,
            tail: "",
            forge: latest,
          },
        ],
      },
    });
    expect(state.tools.c1?.forge?.calls).toEqual([
      { callId: 2, tool: "search_text", status: "started" },
    ]);
    expect(state.tools.c1?.forge?.engine).toBe("javascript-quickjs");
  });

  it("names the run phase of js_run as JavaScript, like python_run is Python", () => {
    expect(toolCategory("js_run")).toBe("javascript");
    expect(toolCategory("p_0123456789_js_run")).toBe("javascript");
    expect(toolCategory("python_run")).toBe("python");
    expect(toolCategory("execute")).toBe("other");
    const phase = describePhase({
      runId: "r1",
      startedAt: 0,
      lastActivityAt: 0,
      stream: "waiting",
      tools: [{ id: "c1", name: "js_run", arguments: '{"title":"Count files"}', startedAt: 0 }],
      approvals: {},
      compacting: false,
      phaseKey: "tool:c1",
      phaseSince: 0,
    });
    expect(phase).toMatchObject({ kind: "tool", category: "javascript", summary: "Count files" });
  });
});

describe("coalescing to four updates per second", () => {
  const texts = (frames: ServerFrame[]): string[] =>
    frames.flatMap((f) =>
      f.t === "delta" ? (f.progress ?? []).map((p) => p.chunk) : [`<${f.t}>`],
    );
  const parsed = (frames: ServerFrame[]) =>
    frames.flatMap((f) =>
      f.t === "delta"
        ? (f.progress ?? []).flatMap((p) => {
            const forge = parseForgeChunk(p.chunk);
            return forge ? [forge] : [];
          })
        : [],
    );

  it("passes the first update and holds the next ones for the rest of the window", () => {
    const gate = new ForgeThrottle();
    expect(FORGE_FLUSH_MS).toBe(250);
    const first = gate.admit(
      [delta("c1", progress({ message: "a", completed: 1, total: 9 }))],
      1000,
    );
    expect(parsed(first).map((p) => p.message)).toEqual(["a"]);
    const held = gate.admit(
      [
        delta("c1", progress({ message: "b", completed: 2, total: 9 })),
        delta("c1", progress({ message: "c", completed: 3, total: 9 })),
      ],
      1100,
    );
    expect(held).toEqual([]);
    expect(gate.nextFlushIn(1100)).toBe(150);
    // Only the latest state of the window survives, and it arrives when the window closes.
    expect(gate.flush(1100)).toEqual([]);
    expect(parsed(gate.flush(1250)).map((p) => p.message)).toEqual(["c"]);
    expect(gate.nextFlushIn(1250)).toBeUndefined();
  });

  it("never drops a terminal call state; it replaces the held start of the same call in place", () => {
    const gate = new ForgeThrottle();
    gate.admit([delta("c1", progress({ message: "go" }))], 0);
    expect(gate.admit([delta("c1", call(1, "started"))], 10)).toEqual([]);
    expect(gate.admit([delta("c1", call(2, "started"))], 20)).toEqual([]);
    const out = gate.admit([delta("c1", call(1, "succeeded", { durationMs: 5 }))], 30);
    const calls = parsed(out).map((p) => `${p.call?.callId}:${p.call?.status}`);
    // Held calls go out with the terminal, in the order the calls first appeared.
    expect(calls).toEqual(["1:succeeded", "2:started"]);
    // The terminal is applied immediately: the view already shows it.
    let view = undefined as ReturnType<typeof applyForgeProgress> | undefined;
    for (const p of parsed(out)) view = applyForgeProgress(view, p);
    expect(view?.calls.find((c) => c.callId === 1)).toMatchObject({
      status: "succeeded",
      durationMs: 5,
    });
  });

  it("flushes everything held before a frame that ends the call, so the end is never early", () => {
    const gate = new ForgeThrottle();
    gate.admit([delta("c1", progress({ message: "a" }))], 0);
    gate.admit([delta("c1", progress({ message: "b" }))], 50);
    const done: ServerFrame = {
      t: "tool_result",
      sessionId: SID,
      callId: "c1",
      result: { content: [{ type: "text", text: "status: succeeded" }] },
    } as ServerFrame;
    const out = gate.admit([done], 60);
    expect(texts(out)).toHaveLength(2);
    expect(out.at(-1)).toBe(done);
    expect(parsed(out).map((p) => p.message)).toEqual(["b"]);
  });

  it("lets text, other tools and non-forge chunks through untouched and in order", () => {
    const gate = new ForgeThrottle();
    gate.admit([delta("c1", progress({ message: "a" }))], 0);
    const frame: ServerFrame = {
      t: "delta",
      sessionId: SID,
      runId: "r1",
      text: "hello",
      progress: [
        { toolId: "c1", chunk: chunk(progress({ message: "held" })) },
        { toolId: "c2", chunk: "Building…" },
      ],
    };
    const out = gate.admit([frame], 10);
    expect(out).toEqual([
      {
        t: "delta",
        sessionId: SID,
        runId: "r1",
        text: "hello",
        progress: [{ toolId: "c2", chunk: "Building…" }],
      },
    ]);
    expect(parsed(gate.flush(300)).map((p) => p.message)).toEqual(["held"]);
  });

  it("windows each running call on its own", () => {
    const gate = new ForgeThrottle();
    gate.admit([delta("c1", progress({ message: "one" }))], 0);
    const other = gate.admit([delta("c2", progress({ message: "two" }))], 10);
    expect(parsed(other).map((p) => p.message)).toEqual(["two"]);
  });
});
