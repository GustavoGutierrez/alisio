/**
 * The Trajectory tab (RF-10): durable events grouped by run, each row with its turn, a one-line
 * summary and a duration when the event has one. Pure.
 */
import type { RunEvent } from "@alisio/sdk";

export interface TrajectoryRow {
  eventId: string;
  type: string;
  at: number;
  turn?: number;
  summary: string;
  durationMs?: number;
  error?: boolean;
}

export interface TrajectoryRun {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  startedAt: number;
  durationMs: number;
  turns: number;
  rows: TrajectoryRow[];
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const clip = (text: string, max = 140) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

function summarize(event: RunEvent): Pick<TrajectoryRow, "summary" | "durationMs" | "error"> {
  const d = (event.data ?? {}) as Record<string, unknown>;
  const duration = typeof d.durationMs === "number" ? { durationMs: d.durationMs } : {};
  switch (event.type) {
    case "run_started":
      return { summary: str(d.model) };
    case "turn_completed": {
      const usage = d.usage as { input?: number; output?: number } | undefined;
      const tokens = usage
        ? `in ${usage.input ?? 0} · out ${usage.output ?? 0}`
        : `${d.tokens ?? 0} tokens`;
      return { summary: clip(`${str(d.model)} · ${tokens}`), ...duration };
    }
    case "tool_started":
      return { summary: str(d.name) };
    case "tool_completed":
      return { summary: str(d.name), ...duration, ...(d.isError ? { error: true } : {}) };
    case "approval_requested":
      return { summary: clip(`${str(d.name)} · ${str(d.effect)}`) };
    case "approval_resolved":
      return {
        summary: `${str(d.name)} · ${str(d.decision)}`,
        ...(d.decision === "deny" ? { error: true } : {}),
      };
    case "run_completed":
      return { summary: clip(str(d.text)) };
    case "run_failed":
    case "run_cancelled":
      return { summary: clip(str(d.error)), error: event.type === "run_failed" };
    case "model_changed":
      return { summary: `${str(d.previous)} → ${str(d.model)}` };
    case "compaction_started":
    case "compaction_completed":
    case "compaction_skipped":
    case "compaction_failed":
      return {
        summary: clip([str(d.reason), str(d.detail), str(d.error)].filter(Boolean).join(" · ")),
        ...(event.type === "compaction_failed" ? { error: true } : {}),
      };
    case "session_context_injected":
      return { summary: clip((d.sources as string[] | undefined)?.join(", ") ?? "") };
    case "plugin_hook_failed":
      return { summary: clip(`${str(d.source)} · ${str(d.hook)} · ${str(d.error)}`), error: true };
    default:
      return { summary: "" };
  }
}

const END: Record<string, TrajectoryRun["status"]> = {
  run_completed: "completed",
  run_failed: "failed",
  run_cancelled: "cancelled",
};

/** Events (in `events.seq` order) grouped by run, in order of first appearance. */
export function trajectory(events: RunEvent[]): TrajectoryRun[] {
  const runs = new Map<string, TrajectoryRun & { endedAt: number }>();
  for (const event of events) {
    const at = Date.parse(event.timestamp) || 0;
    let run = runs.get(event.runId);
    if (!run) {
      run = {
        runId: event.runId,
        status: "running",
        startedAt: at,
        endedAt: at,
        durationMs: 0,
        turns: 0,
        rows: [],
      };
      runs.set(event.runId, run);
    }
    if (event.type === "turn_completed") {
      const n = (event.data as { turn?: number } | undefined)?.turn;
      run.turns = typeof n === "number" ? n : run.turns + 1;
    }
    const status = END[event.type];
    if (status) run.status = status;
    run.endedAt = Math.max(run.endedAt, at);
    run.durationMs = run.endedAt - run.startedAt;
    run.rows.push({
      eventId: event.eventId ?? String(event.seq),
      type: event.type,
      at,
      ...(run.turns ? { turn: run.turns } : {}),
      ...summarize(event),
    });
  }
  return [...runs.values()].map(({ endedAt: _ended, ...run }) => run);
}

/** Merges a newer page into the loaded events, skipping ids already present. */
export function appendEvents(current: RunEvent[], page: RunEvent[]): RunEvent[] {
  const last = Number(current.at(-1)?.eventId ?? 0);
  const fresh = page.filter((e) => Number(e.eventId ?? 0) > last);
  return fresh.length ? [...current, ...fresh] : current;
}

// ---------------------------------------------------------------------------------------------
// Execution timeline (trace waterfall)
// ---------------------------------------------------------------------------------------------

/** Lanes of the trace waterfall, in display order. */
export type TimelineLaneId = "model" | "tool" | "user";
/** What an interval is; decides its lane and its colour. */
export type TimelineKind = "model" | "tool" | "question" | "approval";

export interface TimelineInterval {
  kind: TimelineKind;
  label: string;
  /** Epoch ms; `end === start` is a zero-width instant (no recorded duration). */
  start: number;
  end: number;
  error?: boolean;
}

export interface TimelineLane {
  id: TimelineLaneId;
  intervals: TimelineInterval[];
}

/** Input/output tokens reported by each turn (input is the context size, not new tokens). */
export interface TurnTokens {
  turn: number;
  input: number;
  output: number;
}

export interface ToolDuration {
  name: string;
  durationMs: number;
  count: number;
  error: boolean;
}

export interface ExecutionTimeline {
  startAt: number;
  endAt: number;
  lanes: TimelineLane[];
  turns: TurnTokens[];
  tools: ToolDuration[];
}

const at = (event: RunEvent): number => Date.parse(event.timestamp) || 0;

/** A question to the user is shown in the user lane, not among the tools. */
const QUESTION_TOOL = "ask_user_question";

/**
 * The trace waterfall of a session's durable events: one interval per model turn, tool call and
 * user wait (approvals and questions), plus the per-turn tokens and the accumulated tool time.
 * Intervals are reconstructed from the completion timestamp and the recorded `durationMs`, so a
 * missing duration degrades to an instant instead of a wrong span. Pure.
 */
export function executionTimeline(events: RunEvent[]): ExecutionTimeline | undefined {
  const first = events[0];
  const last = events[events.length - 1];
  if (!first || !last) return undefined;
  const startAt = at(first);
  const endAt = at(last);
  const model: TimelineInterval[] = [];
  const tool: TimelineInterval[] = [];
  const user: TimelineInterval[] = [];
  const turns: TurnTokens[] = [];
  const tools = new Map<string, ToolDuration>();
  const approvals = new Map<string, { at: number; name: string }>();
  for (const event of events) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "approval_requested")
      approvals.set(str(d.id), { at: at(event), name: str(d.name) });
  }
  for (const event of events) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    const t = at(event);
    if (event.type === "turn_completed") {
      const duration = typeof d.durationMs === "number" ? d.durationMs : 0;
      model.push({
        kind: "model",
        label: str(d.model) || `#${String(d.turn ?? turns.length + 1)}`,
        start: t - duration,
        end: t,
      });
      const usage = d.usage as { input?: number; output?: number } | undefined;
      turns.push({
        turn: typeof d.turn === "number" ? d.turn : turns.length + 1,
        input: usage?.input ?? 0,
        output: usage?.output ?? 0,
      });
    } else if (event.type === "tool_completed") {
      const duration = typeof d.durationMs === "number" ? d.durationMs : 0;
      const name = str(d.name);
      const isQuestion = name === QUESTION_TOOL;
      (isQuestion ? user : tool).push({
        kind: isQuestion ? "question" : "tool",
        label: name,
        start: t - duration,
        end: t,
        ...(d.isError ? { error: true } : {}),
      });
      const entry = tools.get(name) ?? { name, durationMs: 0, count: 0, error: false };
      entry.durationMs += duration;
      entry.count += 1;
      entry.error = entry.error || !!d.isError;
      tools.set(name, entry);
    } else if (event.type === "approval_resolved") {
      const id = str(d.id);
      const requested = approvals.get(id);
      user.push({
        kind: "approval",
        label: str(d.name),
        start: requested?.at ?? t,
        end: t,
        ...(d.decision === "deny" ? { error: true } : {}),
      });
      approvals.delete(id);
    }
  }
  // Approvals still waiting when the session was captured: show the open wait to the last event.
  for (const waiting of approvals.values())
    user.push({ kind: "approval", label: waiting.name, start: waiting.at, end: endAt });
  return {
    startAt,
    endAt,
    lanes: [
      { id: "model", intervals: model },
      { id: "tool", intervals: tool },
      { id: "user", intervals: user },
    ],
    turns,
    tools: [...tools.values()].sort((a, b) => b.durationMs - a.durationMs),
  };
}
