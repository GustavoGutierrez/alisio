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
