/**
 * What the current run is doing right now, derived ONLY from frames the client really received
 * (run events, streamed deltas, snapshots). Pure functions with an injected clock: the reducer
 * `applyProgress(state, frame, now)` and the readers `describePhase` / `stallOf` are tested in
 * Node without a DOM. Nothing here invents activity: a quiet connection stays quiet.
 */
import type { ServerFrame } from "@alisio/sdk";

/** No frame for this long: the indicator starts showing how long it has been quiet. */
export const STALL_QUIET_MS = 15_000;
/** No frame for this long: the indicator says the run looks stuck and stresses Stop. */
export const STALL_STALLED_MS = 60_000;

/** What the model side of the run is doing between tool calls. */
type Stream = "waiting" | "thinking" | "writing";

export interface RunningTool {
  id: string;
  name: string;
  arguments: string;
  startedAt: number;
}

export interface RunProgress {
  runId: string;
  /** When the client first saw the run (or the server-reported start after a reload). */
  startedAt: number;
  /** The latest frame of this run (any event, delta or progress chunk). */
  lastActivityAt: number;
  stream: Stream;
  tools: RunningTool[];
  /** Approvals waiting for the user, by call id. */
  approvals: Record<string, string>;
  compacting: boolean;
  /**
   * The runner is sending the same request again after it stayed silent (`request_retry`);
   * cleared by the first thing the retried request produces, or by the end of the turn.
   */
  retry?: { attempt: number; of: number };
  /**
   * The response was cut off by the output limit and the turn is requested again in smaller
   * steps (`truncation_recovery`); cleared like `retry`.
   */
  recovery?: { attempt: number; of: number };
  /** Identity of the phase shown; `phaseSince` restarts when it changes. */
  phaseKey: string;
  phaseSince: number;
}

export type ToolCategory = "python" | "data" | "artifact" | "question" | "agent" | "other";

export type Phase =
  | { kind: "waiting" }
  | { kind: "thinking" }
  | { kind: "writing" }
  | { kind: "compacting" }
  | { kind: "retrying"; attempt: number; of: number }
  | { kind: "recovering"; attempt: number; of: number }
  | { kind: "approval"; name: string }
  | { kind: "tool"; name: string; category: ToolCategory; summary: string };

/**
 * Phases that are silent by design, so silence is never reported as a stall: waiting for the
 * user (approval, question) and delegated agents (their events belong to another session).
 */
export const silentByDesign = (phase: Phase): boolean =>
  phase.kind === "approval" ||
  (phase.kind === "tool" && (phase.category === "question" || phase.category === "agent"));

export const toolCategory = (name: string): ToolCategory => {
  const bare = name.replace(/^p_[0-9a-f]{10}_/, "");
  if (bare === "python_run") return "python";
  if (bare === "data_inspect" || bare === "data_query") return "data";
  if (bare === "artifact_create") return "artifact";
  if (bare === "ask_user_question") return "question";
  if (bare === "task" || bare === "task_wait") return "agent";
  return "other";
};

/** Argument keys worth showing; a file name, never free-form commands or URLs with secrets. */
const SUMMARY_KEYS = ["title", "fileName", "path", "file_path", "file", "name", "description"];

/**
 * A short, safe label from a tool call's JSON arguments: a title or file name only. Directories
 * are cut to the last segment; commands, queries, URLs and code are never shown.
 */
export function argumentSummary(args: string, max = 48): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const record = parsed as Record<string, unknown>;
  let value: string | undefined;
  for (const key of SUMMARY_KEYS) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) {
      value = candidate;
      break;
    }
  }
  if (value === undefined) {
    const inputs = record.inputs;
    const first = Array.isArray(inputs) ? (inputs[0] as Record<string, unknown>) : undefined;
    if (first && typeof first.path === "string") value = first.path;
  }
  if (!value) return "";
  const flat = (value.replace(/\\/g, "/").split("/").filter(Boolean).pop() ?? value)
    .replace(/\s+/g, " ")
    .trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The phase to show: the user's turn first, then running tools, compaction, then the stream. */
export function describePhase(progress: RunProgress): Phase {
  const approval = Object.values(progress.approvals)[0];
  if (approval !== undefined) return { kind: "approval", name: approval };
  const tool = progress.tools.at(-1);
  if (tool)
    return {
      kind: "tool",
      name: tool.name,
      category: toolCategory(tool.name),
      summary: argumentSummary(tool.arguments),
    };
  if (progress.compacting) return { kind: "compacting" };
  if (progress.retry) return { kind: "retrying", ...progress.retry };
  if (progress.recovery) return { kind: "recovering", ...progress.recovery };
  return { kind: progress.stream };
}

const keyOf = (progress: Omit<RunProgress, "phaseKey" | "phaseSince">): string => {
  const approval = Object.keys(progress.approvals)[0];
  if (approval !== undefined) return `approval:${approval}`;
  const tool = progress.tools.at(-1);
  if (tool) return `tool:${tool.id}`;
  if (progress.compacting) return "compacting";
  if (progress.recovery) return `recovery:${progress.recovery.attempt}`;
  return progress.retry ? `retry:${progress.retry.attempt}` : progress.stream;
};

/** The same progress without a pending retry (anything the retried request produced ends it). */
const settled = <T extends { retry?: RunProgress["retry"]; recovery?: RunProgress["recovery"] }>(
  progress: T,
): Omit<T, "retry" | "recovery"> => {
  const { retry: _retry, recovery: _recovery, ...rest } = progress;
  return rest;
};

const settle = (
  base: Omit<RunProgress, "phaseKey" | "phaseSince">,
  previous: RunProgress | undefined,
  now: number,
): RunProgress => {
  const phaseKey = keyOf(base);
  return {
    ...base,
    phaseKey,
    phaseSince: previous && previous.phaseKey === phaseKey ? previous.phaseSince : now,
  };
};

const fresh = (runId: string, now: number, startedAt = now): RunProgress =>
  settle(
    {
      runId,
      startedAt,
      lastActivityAt: now,
      stream: "waiting",
      tools: [],
      approvals: {},
      compacting: false,
    },
    undefined,
    now,
  );

const str = (value: unknown): string =>
  value === undefined || value === null ? "" : String(value);

/**
 * Applies one server frame. Returns `undefined` when no run is live. Frames that say nothing
 * about the run (heartbeats, other sessions, catalog changes) are ignored and do not count as
 * activity.
 */
export function applyProgress(
  state: RunProgress | undefined,
  frame: ServerFrame,
  now: number,
): RunProgress | undefined {
  if (frame.t === "snapshot") {
    const inflight = frame.inflight;
    if (!inflight) return undefined;
    const approvals: Record<string, string> = {};
    for (const approval of frame.pending?.approvals ?? [])
      if (approval.rootSessionId === frame.sessionId)
        approvals[approval.callId ?? approval.approvalId] = approval.name ?? approval.approvalId;
    const base = {
      runId: inflight.runId,
      startedAt: inflight.startedAt ?? state?.startedAt ?? now,
      // A reload cannot know when the last frame arrived; "now" is the honest lower bound.
      lastActivityAt: now,
      stream: inflight.text ? "writing" : inflight.reasoning ? "thinking" : "waiting",
      tools: inflight.tools.map((t) => ({
        id: t.id,
        name: t.name,
        arguments: t.arguments,
        startedAt: t.startedAt,
      })),
      approvals,
      compacting: false,
    } satisfies Omit<RunProgress, "phaseKey" | "phaseSince">;
    return settle(base, state?.runId === inflight.runId ? state : undefined, now);
  }
  if (frame.t === "delta") {
    const current = state?.runId === frame.runId ? state : fresh(frame.runId, now);
    const stream: Stream = frame.text ? "writing" : frame.reasoning ? "thinking" : current.stream;
    return settle(
      { ...settled(current), stream, lastActivityAt: now, compacting: false },
      current,
      now,
    );
  }
  if (frame.t !== "event") return state;
  const event = frame.event;
  const data = (event.data ?? {}) as Record<string, unknown>;
  switch (event.type) {
    case "run_started":
      return fresh(event.runId, now);
    case "run_completed":
    case "run_failed":
    case "run_cancelled":
    case "run_turns_exceeded":
      return state && state.runId !== event.runId ? state : undefined;
  }
  const current = state?.runId === event.runId ? state : fresh(event.runId, now);
  const touched = { ...current, lastActivityAt: now };
  switch (event.type) {
    case "tool_started": {
      const id = str(data.id);
      const tools = current.tools.some((t) => t.id === id)
        ? current.tools
        : [
            ...current.tools,
            { id, name: str(data.name), arguments: str(data.arguments), startedAt: now },
          ];
      return settle({ ...settled(touched), tools, compacting: false }, current, now);
    }
    case "tool_completed": {
      const id = str(data.id);
      const { [id]: _gone, ...approvals } = current.approvals;
      return settle(
        {
          ...settled(touched),
          tools: current.tools.filter((t) => t.id !== id),
          approvals,
          // The tool's results go back to the model: from here on it is the model's turn.
          stream: "waiting",
        },
        current,
        now,
      );
    }
    case "tool_progress":
      return { ...touched };
    case "approval_requested":
      return settle(
        {
          ...touched,
          approvals: { ...current.approvals, [str(data.id)]: str(data.name) },
        },
        current,
        now,
      );
    case "approval_resolved": {
      const { [str(data.id)]: _gone, ...approvals } = current.approvals;
      return settle({ ...touched, approvals }, current, now);
    }
    case "compaction_started":
      return settle({ ...settled(touched), compacting: true }, current, now);
    case "compaction_completed":
    case "compaction_failed":
    case "compaction_skipped":
      return settle({ ...settled(touched), compacting: false, stream: "waiting" }, current, now);
    case "turn_completed":
      return settle({ ...settled(touched), stream: "waiting" }, current, now);
    case "request_retry":
      return settle(
        {
          ...touched,
          stream: "waiting",
          retry: { attempt: Number(data.attempt) || 1, of: Number(data.of) || 1 },
        },
        current,
        now,
      );
    case "truncation_recovery":
      return settle(
        {
          ...settled(touched),
          stream: "waiting",
          recovery: { attempt: Number(data.attempt) || 1, of: Number(data.of) || 1 },
        },
        current,
        now,
      );
    case "artifact_published":
    case "plugin_hook_failed":
    case "context_reduced":
    case "session_context_injected":
    case "response_truncated":
      return touched;
    default:
      // Unknown or unrelated event types say nothing about this run.
      return state;
  }
}

export type StallLevel = "none" | "quiet" | "stalled";

export interface Stall {
  level: StallLevel;
  /** Milliseconds since the last frame of the run. */
  idleMs: number;
}

/**
 * How long the run has been silent. Phases that are silent by design are never a stall. `quiet` after `STALL_QUIET_MS`, `stalled` after `STALL_STALLED_MS`.
 */
export function stallOf(
  progress: RunProgress,
  now: number,
  thresholds: { quietMs: number; stalledMs: number } = {
    quietMs: STALL_QUIET_MS,
    stalledMs: STALL_STALLED_MS,
  },
): Stall {
  const idleMs = Math.max(0, now - progress.lastActivityAt);
  if (silentByDesign(describePhase(progress))) return { level: "none", idleMs };
  if (idleMs >= thresholds.stalledMs) return { level: "stalled", idleMs };
  if (idleMs >= thresholds.quietMs) return { level: "quiet", idleMs };
  return { level: "none", idleMs };
}

/** `m:ss` (`0:07`, `12:30`); `h:mm:ss` from an hour. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `${h}:${two(m)}:${two(s)}` : `${m}:${two(s)}`;
}
