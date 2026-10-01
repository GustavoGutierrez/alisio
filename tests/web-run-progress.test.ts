import type { RunEvent, ServerFrame } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  applyProgress,
  argumentSummary,
  describePhase,
  formatClock,
  type RunProgress,
  STALL_QUIET_MS,
  STALL_STALLED_MS,
  stallOf,
} from "../packages/web/src/store/progress.ts";
import { applyFrame, emptyTranscript, visibleItems } from "../packages/web/src/store/transcript.ts";

const SID = "s1";
const RUN = "r1";
let counter = 0;
const event = (type: string, data: unknown = {}): ServerFrame => ({
  t: "event",
  sessionId: SID,
  event: {
    schemaVersion: 1,
    runId: RUN,
    sessionId: SID,
    seq: ++counter,
    type,
    timestamp: new Date().toISOString(),
    data,
    eventId: String(counter),
  } satisfies RunEvent,
});
const delta = (extra: { text?: string; reasoning?: string; progress?: never[] | unknown[] }) =>
  ({ t: "delta", sessionId: SID, runId: RUN, ...extra }) as ServerFrame;

/** Applies `frames` at the given clock readings (a fake clock: nothing reads Date.now()). */
const play = (steps: Array<[number, ServerFrame]>): RunProgress | undefined =>
  steps.reduce<RunProgress | undefined>(
    (state, [at, frame]) => applyProgress(state, frame, at),
    undefined,
  );

describe("silent-request retry phase", () => {
  const retry = event("request_retry", {
    attempt: 1,
    of: 1,
    reason: "first_token_timeout",
    afterMs: 90_000,
  });
  it("shows the retry for the attempt and returns to the normal phases afterwards", () => {
    const phaseAt = (steps: Array<[number, ServerFrame]>) => {
      const state = play(steps);
      return state ? describePhase(state) : undefined;
    };
    const start: [number, ServerFrame] = [0, event("run_started", { model: "m" })];
    expect(phaseAt([start, [90_000, retry]])).toEqual({ kind: "retrying", attempt: 1, of: 1 });
    expect(phaseAt([start, [90_000, retry], [91_000, delta({ reasoning: "hmm" })]])).toEqual({
      kind: "thinking",
    });
    expect(phaseAt([start, [90_000, retry], [91_000, delta({ text: "ok" })]])).toEqual({
      kind: "writing",
    });
    expect(
      phaseAt([start, [90_000, retry], [95_000, event("turn_completed", { turn: 1, calls: 0 })]]),
    ).toEqual({ kind: "waiting" });
  });
  it("restarts the step clock and the quiet counter with the retried attempt", () => {
    const state = play([
      [0, event("run_started")],
      [90_000, retry],
    ]);
    expect(state?.phaseSince).toBe(90_000);
    expect(stallOf(state as RunProgress, 90_000 + STALL_QUIET_MS - 1).level).toBe("none");
    expect(stallOf(state as RunProgress, 90_000 + STALL_QUIET_MS).level).toBe("quiet");
  });
});

describe("phase derivation from run events", () => {
  it("follows a dashboard run: model, reasoning, Python, data, artifact, answer", () => {
    const phases: string[] = [];
    let state: RunProgress | undefined;
    const step = (frame: ServerFrame, at: number) => {
      state = applyProgress(state, frame, at);
      const phase = state ? describePhase(state) : undefined;
      phases.push(
        !phase
          ? "none"
          : phase.kind === "tool"
            ? `tool:${phase.category}:${phase.summary}`
            : phase.kind,
      );
    };
    step(event("run_started", { model: "m" }), 0);
    step(delta({ reasoning: "hmm" }), 1_000);
    step(delta({ text: "Let me look" }), 2_000);
    step(event("turn_completed", { turn: 1, calls: 1 }), 3_000);
    step(
      event("tool_started", {
        id: "c1",
        name: "data_inspect",
        arguments: '{"path":"data/sales.csv"}',
      }),
      3_100,
    );
    step(event("tool_completed", { id: "c1", name: "data_inspect", isError: false }), 4_000);
    step(
      event("tool_started", {
        id: "c2",
        name: "python_run",
        arguments: '{"code":"import pandas as pd","title":"analysis.py"}',
      }),
      5_000,
    );
    step(delta({ progress: [{ toolId: "c2", chunk: "loading" }] }), 6_000);
    step(event("tool_completed", { id: "c2", name: "python_run", isError: false }), 9_000);
    step(
      event("tool_started", {
        id: "c3",
        name: "artifact_create",
        arguments: '{"fileName":"dashboard.html","text":"<html>"}',
      }),
      9_500,
    );
    step(event("tool_completed", { id: "c3", name: "artifact_create", isError: false }), 9_900);
    step(delta({ text: "Done" }), 10_500);
    step(event("run_completed", { tokens: 1, text: "Done" }), 11_000);
    expect(phases).toEqual([
      "waiting",
      "thinking",
      "writing",
      "waiting",
      "tool:data:sales.csv",
      "waiting",
      "tool:python:analysis.py",
      "tool:python:analysis.py",
      "waiting",
      "tool:artifact:dashboard.html",
      "waiting",
      "writing",
      "none",
    ]);
  });

  it("shows the tool's own name for an unknown tool and the plugin tool without its prefix", () => {
    const state = play([
      [0, event("run_started")],
      [10, event("tool_started", { id: "c1", name: "p_0123456789_query-docs", arguments: "{}" })],
    ]);
    const phase = state && describePhase(state);
    expect(phase).toMatchObject({
      kind: "tool",
      category: "other",
      name: "p_0123456789_query-docs",
    });
  });

  it("tracks compaction and approvals, and returns to the tool afterwards", () => {
    let state = play([
      [0, event("run_started")],
      [10, event("compaction_started", { reason: "auto" })],
    ]);
    expect(state && describePhase(state).kind).toBe("compacting");
    state = applyProgress(state, event("compaction_completed", {}), 20);
    expect(state && describePhase(state).kind).toBe("waiting");
    state = applyProgress(
      state,
      event("tool_started", { id: "c1", name: "python_run", arguments: "{}" }),
      30,
    );
    state = applyProgress(state, event("approval_requested", { id: "c1", name: "python_run" }), 31);
    expect(state && describePhase(state)).toMatchObject({ kind: "approval", name: "python_run" });
    state = applyProgress(state, event("approval_resolved", { id: "c1", decision: "once" }), 40);
    expect(state && describePhase(state)).toMatchObject({ kind: "tool", category: "python" });
  });

  it("restarts the step clock only when the phase changes", () => {
    const state = play([
      [1_000, event("run_started")],
      [2_000, delta({ reasoning: "a" })],
      [9_000, delta({ reasoning: "b" })],
    ]);
    expect(state?.startedAt).toBe(1_000);
    expect(state?.phaseSince).toBe(2_000);
    expect(state?.lastActivityAt).toBe(9_000);
  });

  it("ignores events of other runs and frames that say nothing about the run", () => {
    const state = play([[0, event("run_started")]]);
    const other = {
      ...(event("run_completed") as Extract<ServerFrame, { t: "event" }>),
    };
    other.event = { ...other.event, runId: "other" };
    expect(applyProgress(state, other, 5)).toBe(state);
    expect(
      applyProgress(state, { t: "hello", protocolVersion: 1, streamId: "x", serverTime: 1 }, 5),
    ).toBe(state);
    expect(applyProgress(state, event("something_new_and_unknown"), 5)).toBe(state);
  });

  it("rebuilds the phase and the start time from a reload snapshot", () => {
    const frame: ServerFrame = {
      t: "snapshot",
      sessionId: SID,
      cursor: 1,
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
        runId: RUN,
        status: "running",
        startedAt: 500,
        text: "",
        reasoning: "thinking so far",
        tools: [],
      },
    };
    const state = applyProgress(undefined, frame, 90_000);
    expect(state?.startedAt).toBe(500);
    expect(state && describePhase(state).kind).toBe("thinking");
    expect(applyProgress(state, { ...frame, inflight: undefined }, 91_000)).toBeUndefined();
  });
});

describe("argument summaries", () => {
  it("shows a title or a file name, never commands, URLs or code", () => {
    expect(argumentSummary('{"path":"/home/me/data/sales.csv"}')).toBe("sales.csv");
    expect(argumentSummary('{"inputs":[{"path":"C:\\\\data\\\\q3.xlsx"}],"code":"x"}')).toBe(
      "q3.xlsx",
    );
    expect(argumentSummary('{"title":"Margin by product","code":"print(1)"}')).toBe(
      "Margin by product",
    );
    expect(argumentSummary('{"command":"curl -H \'Authorization: Bearer abc\' https://x"}')).toBe(
      "",
    );
    expect(argumentSummary('{"url":"https://x.test/?token=abc"}')).toBe("");
    expect(argumentSummary("not json")).toBe("");
    expect(argumentSummary(`{"title":"${"a".repeat(200)}"}`).length).toBeLessThanOrEqual(48);
  });
});

describe("stall detection with a fake clock", () => {
  const live = (at = 0) => play([[at, event("run_started")]]) as RunProgress;

  it("is silent until the quiet threshold, then quiet, then stalled", () => {
    const state = live(1_000);
    const at = (ms: number) => stallOf(state, 1_000 + ms).level;
    expect(at(0)).toBe("none");
    expect(at(STALL_QUIET_MS - 1)).toBe("none");
    expect(at(STALL_QUIET_MS)).toBe("quiet");
    expect(at(STALL_STALLED_MS - 1)).toBe("quiet");
    expect(at(STALL_STALLED_MS)).toBe("stalled");
    expect(stallOf(state, 1_000 + 45_000).idleMs).toBe(45_000);
  });

  it("any frame of the run, including tool output, restarts the silence", () => {
    let state = live(0);
    state = applyProgress(state, delta({ reasoning: "x" }), 50_000) as RunProgress;
    expect(stallOf(state, 60_000).level).toBe("none");
    state = applyProgress(
      state,
      event("tool_started", { id: "c1", name: "shell", arguments: "{}" }),
      61_000,
    ) as RunProgress;
    state = applyProgress(
      state,
      delta({ progress: [{ toolId: "c1", chunk: "out" }] }),
      100_000,
    ) as RunProgress;
    expect(stallOf(state, 110_000).level).toBe("none");
    expect(stallOf(state, 100_000 + STALL_QUIET_MS).level).toBe("quiet");
  });

  it("never reports a stall while waiting for the user or for a sub-agent", () => {
    let state = live(0);
    state = applyProgress(
      state,
      event("tool_started", { id: "c1", name: "python_run", arguments: "{}" }),
      1,
    ) as RunProgress;
    state = applyProgress(
      state,
      event("approval_requested", { id: "c1", name: "python_run" }),
      2,
    ) as RunProgress;
    expect(stallOf(state, 10 * 60_000).level).toBe("none");
    const agent = applyProgress(
      live(0),
      event("tool_started", { id: "t", name: "task", arguments: "{}" }),
      1,
    ) as RunProgress;
    expect(stallOf(agent, 10 * 60_000).level).toBe("none");
  });

  it("honors custom thresholds", () => {
    expect(stallOf(live(0), 5_000, { quietMs: 5_000, stalledMs: 9_000 }).level).toBe("quiet");
  });
});

describe("clock formatting", () => {
  it("formats m:ss and h:mm:ss", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(7_400)).toBe("0:07");
    expect(formatClock(125_000)).toBe("2:05");
    expect(formatClock(3_725_000)).toBe("1:02:05");
    expect(formatClock(-5)).toBe("0:00");
  });
});

describe("timeout failures in the transcript", () => {
  const run = (data: unknown) =>
    visibleItems(applyFrame(emptyTranscript(SID), event("run_failed", data))).find(
      (i) => i.kind === "notice",
    );

  it("turns a timeout into a localizable notice with the model, provider and seconds", () => {
    const notice = run({
      error: "english text",
      code: "timeout",
      timeout: {
        kind: "run",
        ms: 300_000,
        model: "deepseek-flash",
        provider: "api.deepseek.com",
        stage: "waiting_model",
        firstRequest: true,
      },
    });
    expect(notice).toMatchObject({
      code: "run_timeout_waiting",
      tone: "error",
      params: { who: "deepseek-flash (api.deepseek.com)", seconds: "300" },
    });
  });

  it("picks the variant for the first-token limit, a busy tool and an unknown stage", () => {
    expect(
      run({
        error: "x",
        code: "timeout",
        timeout: { kind: "first_token", ms: 90_000, model: "m" },
      }),
    ).toMatchObject({ code: "run_timeout_first_token", params: { seconds: "90" } });
    expect(
      run({
        error: "x",
        code: "timeout",
        timeout: { kind: "first_token", ms: 90_000, model: "m", attempts: 2 },
      }),
    ).toMatchObject({
      code: "run_timeout_first_token_retried",
      params: { seconds: "90", attempts: "2" },
    });
    expect(
      run({
        error: "x",
        code: "timeout",
        timeout: { kind: "run", ms: 60_000, stage: "tool", tool: "python_run" },
      }),
    ).toMatchObject({ code: "run_timeout_tool", params: { tool: "python_run" } });
    expect(
      run({ error: "x", code: "timeout", timeout: { kind: "run", ms: 60_000, stage: "other" } }),
    ).toMatchObject({ code: "run_timeout_other" });
  });

  it("keeps the plain failure notice for other errors and for payloads without details", () => {
    expect(run({ error: "boom" })).toMatchObject({ code: "run_failed", params: { error: "boom" } });
    expect(run({ error: "t", code: "timeout" })).toMatchObject({ code: "run_failed" });
  });
});

describe("output-truncation recovery phase and failure notice", () => {
  const recovery = event("truncation_recovery", {
    attempt: 1,
    of: 2,
    reason: "tool_call_cut",
    maxOutputTokens: 16384,
  });
  const phaseAt = (steps: Array<[number, ServerFrame]>) => {
    const state = play(steps);
    return state ? describePhase(state) : undefined;
  };
  const start: [number, ServerFrame] = [0, event("run_started", { model: "m" })];

  it("shows the recovery until the new request produces something", () => {
    expect(phaseAt([start, [5_000, recovery]])).toEqual({ kind: "recovering", attempt: 1, of: 2 });
    expect(phaseAt([start, [5_000, recovery], [6_000, delta({ reasoning: "hmm" })]])).toEqual({
      kind: "thinking",
    });
    expect(
      phaseAt([start, [5_000, recovery], [6_000, event("tool_started", { id: "c", name: "x" })]]),
    ).toMatchObject({ kind: "tool" });
  });

  it("has an English and a Spanish status line", async () => {
    const { en } = await import("../packages/web/src/i18n/en.ts");
    const { es } = await import("../packages/web/src/i18n/es.ts");
    expect(en["run.phase.recovering"]).toContain("cut off");
    expect(es["run.phase.recovering"]).toContain("{attempt}/{of}");
    expect(es["notice.run_output_truncated"]).toContain("{maxOutputTokens}");
  });

  it("turns the output_truncated failure into a localizable notice naming the model", () => {
    const notice = visibleItems(
      applyFrame(
        emptyTranscript(SID),
        event("run_failed", {
          error: "english text",
          code: "output_truncated",
          truncation: { attempts: 3, maxOutputTokens: 16384, model: "deepseek-flash" },
        }),
      ),
    ).find((i) => i.kind === "notice");
    expect(notice).toMatchObject({
      code: "run_output_truncated",
      params: { who: "deepseek-flash", attempts: "3", maxOutputTokens: "16384" },
    });
  });
});
