/**
 * Live progress of a Forja execution (`js_run`, `python_run`) as the web shows it (Forja spec
 * §11.2). `ForgeProgress` objects arrive as JSON chunks of `tool_progress`; they fold into one
 * `ForgeView` per tool call (nested calls by id) and are coalesced to four updates per second
 * before they reach the transcript. A terminal state is never held back or dropped. Pure: no
 * DOM, no signals, so it is tested in Node.
 */
import type { EngineId, ForgeProgress, ServerFrame } from "@alisio/sdk";

export interface ForgeCallView {
  callId: number;
  tool: string;
  status: "started" | "succeeded" | "failed" | "denied";
  durationMs?: number;
}

/** What a card shows of a running (or just finished) Forja execution. */
export interface ForgeView {
  executionId: string;
  engine: EngineId;
  phase: ForgeProgress["phase"];
  message?: string;
  completed?: number;
  total?: number;
  /** Nested calls in order of first appearance, each updated in place. */
  calls: ForgeCallView[];
}

/** The `ForgeProgress` a progress chunk carries; any other text or JSON is ordinary output. */
export function parseForgeChunk(chunk: string): ForgeProgress | undefined {
  if (!chunk.startsWith("{")) return undefined;
  try {
    const value = JSON.parse(chunk) as Partial<ForgeProgress> | null;
    return value && typeof value === "object" && value.kind === "forge"
      ? (value as ForgeProgress)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Folds one progress object into the view of its execution (a new execution starts afresh). */
export function applyForgeProgress(view: ForgeView | undefined, p: ForgeProgress): ForgeView {
  const base: ForgeView =
    view && view.executionId === p.executionId
      ? view
      : { executionId: p.executionId, engine: p.engine, phase: p.phase, calls: [] };
  const next: ForgeView = { ...base, engine: p.engine, phase: p.phase };
  if (p.message !== undefined) next.message = p.message;
  if (p.completed !== undefined) next.completed = p.completed;
  if (p.total !== undefined) next.total = p.total;
  if (p.call) {
    const { callId, tool, status, durationMs } = p.call;
    const row: ForgeCallView = {
      callId,
      tool,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
    const at = base.calls.findIndex((c) => c.callId === callId);
    next.calls =
      at < 0 ? [...base.calls, row] : base.calls.map((c, index) => (index === at ? row : c));
  }
  return next;
}

export function callCounts(view: ForgeView): {
  total: number;
  running: number;
  failed: number;
  denied: number;
} {
  const count = (status: ForgeCallView["status"]) =>
    view.calls.filter((c) => c.status === status).length;
  return {
    total: view.calls.length,
    running: count("started"),
    failed: count("failed"),
    denied: count("denied"),
  };
}

/** The one-line progress of a header: the message and the `completed/total` counter. */
export function forgeProgressLine(view: ForgeView | undefined): string {
  if (!view) return "";
  const counter = view.total !== undefined ? `${view.completed ?? 0}/${view.total}` : undefined;
  return [view.message, counter].filter(Boolean).join(" · ");
}

/** The coalescing window: at most four progress updates per second and per call. */
export const FORGE_FLUSH_MS = 250;

type DeltaFrame = Extract<ServerFrame, { t: "delta" }>;

interface Window {
  /** When this call's progress last went out. */
  lastEmit?: number;
  held: Map<string, ForgeProgress>;
  sessionId?: string;
  runId: string;
}

/** A call state that ends something: it goes out at once and flushes what was held before it. */
const isTerminal = (p: ForgeProgress): boolean =>
  (p.call !== undefined && p.call.status !== "started") || p.phase === "collecting";

/** Frames that end or replace a call: whatever was held goes out first (or is superseded). */
const flushesBefore = (frame: ServerFrame): boolean =>
  frame.t === "tool_result" ||
  frame.t === "message" ||
  (frame.t === "event" &&
    (frame.event.type === "tool_completed" || frame.event.type.startsWith("run_")));

/**
 * Coalesces `ForgeProgress` chunks to one update per window and call: the first update of a window
 * goes through, later ones are held and only the latest state of each key (a call id, or the
 * overall counters) survives. Terminal call states, the end of the call and every non-forge frame
 * are never held, and held states always go out before them so the order stays true.
 */
export class ForgeThrottle {
  private windows = new Map<string, Window>();

  /** The frames to apply now, in order: forge chunks of an open window are held back. */
  admit(frames: ServerFrame[], now: number): ServerFrame[] {
    const out: ServerFrame[] = [];
    for (const frame of frames) {
      if (frame.t === "snapshot") {
        // The snapshot is authoritative: nothing held before it is still true.
        this.windows.clear();
        out.push(frame);
        continue;
      }
      if (frame.t !== "delta" || !frame.progress?.length) {
        if (flushesBefore(frame)) out.push(...this.release(now, true));
        out.push(frame);
        continue;
      }
      const kept: NonNullable<DeltaFrame["progress"]> = [];
      for (const entry of frame.progress) {
        const forge = parseForgeChunk(entry.chunk);
        if (!forge) {
          kept.push(entry);
          continue;
        }
        const win = this.windowOf(entry.toolId, frame);
        const key = forge.call ? `call:${forge.call.callId}` : "state";
        win.held.set(key, forge);
        const open = win.lastEmit === undefined || now - win.lastEmit >= FORGE_FLUSH_MS;
        if (open || isTerminal(forge)) {
          for (const held of win.held.values())
            kept.push({ toolId: entry.toolId, chunk: JSON.stringify(held) });
          win.held.clear();
          win.lastEmit = now;
        }
      }
      const { progress: _progress, ...rest } = frame;
      if (kept.length) out.push({ ...rest, progress: kept });
      else if (frame.text || frame.reasoning) out.push(rest);
    }
    return out;
  }

  /** Held updates whose window has closed, as delta frames. */
  flush(now: number): ServerFrame[] {
    return this.release(now, false);
  }

  /** Milliseconds until something held is due, or undefined when nothing is held. */
  nextFlushIn(now: number): number | undefined {
    let soonest: number | undefined;
    for (const win of this.windows.values()) {
      if (!win.held.size) continue;
      const due = Math.max(0, (win.lastEmit ?? now) + FORGE_FLUSH_MS - now);
      soonest = soonest === undefined ? due : Math.min(soonest, due);
    }
    return soonest;
  }

  private windowOf(toolId: string, frame: DeltaFrame): Window {
    let win = this.windows.get(toolId);
    if (!win) {
      win = { held: new Map(), runId: frame.runId };
      this.windows.set(toolId, win);
    }
    if (frame.sessionId !== undefined) win.sessionId = frame.sessionId;
    win.runId = frame.runId;
    return win;
  }

  private release(now: number, all: boolean): ServerFrame[] {
    const out: ServerFrame[] = [];
    for (const [toolId, win] of this.windows) {
      if (!win.held.size) continue;
      if (!all && now - (win.lastEmit ?? now) < FORGE_FLUSH_MS) continue;
      out.push({
        t: "delta",
        ...(win.sessionId !== undefined ? { sessionId: win.sessionId } : {}),
        runId: win.runId,
        progress: [...win.held.values()].map((held) => ({
          toolId,
          chunk: JSON.stringify(held),
        })),
      } as DeltaFrame);
      win.held.clear();
      win.lastEmit = now;
    }
    return out;
  }
}
