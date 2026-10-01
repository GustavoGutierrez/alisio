import type { RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  initialViewState,
  QUIET_MS,
  quietFor,
  reduceEvent,
  runPhase,
  STALLED_MS,
  type ViewState,
} from "../packages/cli/src/tui/state.ts";

let seq = 0;
const at = (ms: number) => new Date(1_700_000_000_000 + ms).toISOString();
const ev = (type: string, ms: number, data: unknown = {}): RunEvent => ({
  schemaVersion: 1,
  runId: "r",
  sessionId: "s",
  seq: ++seq,
  type,
  timestamp: at(ms),
  data,
});
const T0 = Date.parse(at(0));
const play = (events: RunEvent[]): ViewState =>
  events.reduce(reduceEvent, initialViewState("m", T0));

describe("TUI run phase (footer)", () => {
  it("follows the events: model, thinking, writing, Python, publishing", () => {
    const labels: string[] = [];
    let view = initialViewState("m", T0);
    const step = (e: RunEvent) => {
      view = reduceEvent(view, e);
      labels.push(runPhase(view).label);
    };
    step(ev("run_started", 0, { model: "m" }));
    step(ev("reasoning_delta", 1_000, { delta: "hmm" }));
    step(ev("text_delta", 2_000, { delta: "Looking" }));
    step(ev("turn_completed", 3_000, { turn: 1, calls: 1 }));
    step(
      ev("tool_started", 3_100, {
        id: "c1",
        name: "python_run",
        arguments: '{"title":"analysis.py","code":"x"}',
        effect: "process",
      }),
    );
    step(ev("tool_completed", 8_000, { id: "c1", name: "python_run", isError: false }));
    step(
      ev("tool_started", 8_100, {
        id: "c2",
        name: "artifact_create",
        arguments: '{"fileName":"dashboard.html","text":"<h1>"}',
        effect: "internal",
      }),
    );
    step(ev("tool_completed", 8_500, { id: "c2", name: "artifact_create", isError: false }));
    expect(labels).toEqual([
      "waiting for the model",
      "thinking",
      "writing the answer",
      "waiting for the model",
      "running Python (analysis.py)",
      "waiting for the model",
      "publishing the artifact (dashboard.html)",
      "waiting for the model",
    ]);
  });

  it("never puts a command or URL in the label", () => {
    const view = play([
      ev("run_started", 0),
      ev("tool_started", 10, {
        id: "c",
        name: "shell",
        arguments: '{"command":"curl -H Authorization:abc https://x"}',
      }),
    ]);
    expect(runPhase(view).label).toBe("running Shell");
  });

  it("reports compaction and the user's turn", () => {
    expect(runPhase(play([ev("run_started", 0), ev("compaction_started", 5)])).label).toBe(
      "compacting context",
    );
    const waiting = play([
      ev("run_started", 0),
      ev("tool_started", 1, { id: "c", name: "python_run", arguments: "{}" }),
      ev("approval_requested", 2, { id: "c", name: "python_run" }),
    ]);
    expect(runPhase(waiting)).toMatchObject({ silentByDesign: true });
  });
});

describe("TUI silent-request retry", () => {
  const retry = ev("request_retry", 90_000, {
    attempt: 1,
    of: 1,
    reason: "first_token_timeout",
    afterMs: 90_000,
  });
  it("shows the retry in the footer until the retried request produces output", () => {
    const retrying = play([ev("run_started", 0), retry]);
    expect(runPhase(retrying)).toEqual({
      label: "the model did not respond; retrying (1/1)",
      silentByDesign: false,
    });
    expect(
      runPhase(reduceEvent(retrying, ev("reasoning_delta", 91_000, { delta: "x" }))).label,
    ).toBe("thinking");
    expect(runPhase(reduceEvent(retrying, ev("turn_completed", 91_000, { turn: 1 }))).label).toBe(
      "waiting for the model",
    );
  });
  it("forgets the retry when the run ends", () => {
    const ended = reduceEvent(play([ev("run_started", 0), retry]), ev("run_failed", 91_000, {}));
    expect(ended.retry).toBeUndefined();
  });
});

describe("TUI output-truncation recovery", () => {
  const recovery = ev("truncation_recovery", 5_000, {
    attempt: 1,
    of: 2,
    reason: "empty_response",
    maxOutputTokens: 16384,
  });
  it("shows the recovery in the footer until the new request produces output", () => {
    const recovering = play([ev("run_started", 0), recovery]);
    expect(runPhase(recovering)).toEqual({
      label: "the response was cut off; retrying in smaller steps (1/2)",
      silentByDesign: false,
    });
    expect(
      runPhase(reduceEvent(recovering, ev("reasoning_delta", 6_000, { delta: "x" }))).label,
    ).toBe("thinking");
  });
  it("forgets the recovery when the run ends", () => {
    const ended = reduceEvent(play([ev("run_started", 0), recovery]), ev("run_failed", 6_000, {}));
    expect(ended.recovery).toBeUndefined();
  });
});

describe("TUI quiet detection with a fake clock", () => {
  const view = play([ev("run_started", 0), ev("reasoning_delta", 1_000, { delta: "x" })]);
  it("is zero until the quiet threshold and then reports the silence", () => {
    expect(quietFor(view, T0 + 1_000 + QUIET_MS - 1)).toBe(0);
    expect(quietFor(view, T0 + 1_000 + QUIET_MS)).toBe(QUIET_MS);
    expect(quietFor(view, T0 + 1_000 + STALLED_MS)).toBe(STALLED_MS);
  });
  it("any event restarts it, and a finished run has none", () => {
    const fresh = reduceEvent(view, ev("text_delta", 50_000, { delta: "y" }));
    expect(quietFor(fresh, T0 + 60_000)).toBe(0);
    const ended = reduceEvent(fresh, ev("run_completed", 51_000, { tokens: 1, text: "" }));
    expect(ended.lastEventAt).toBeUndefined();
    expect(quietFor(ended, T0 + 10 * 60_000)).toBe(0);
  });
  it("does not call a sub-agent wait or an approval a stall", () => {
    const agent = play([
      ev("run_started", 0),
      ev("tool_started", 1, { id: "t", name: "task", arguments: "{}" }),
    ]);
    expect(quietFor(agent, T0 + 10 * 60_000)).toBe(0);
  });
});
