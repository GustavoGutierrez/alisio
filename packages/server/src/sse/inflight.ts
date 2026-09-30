import type { Effect, InflightState, RunEvent } from "@alisio/sdk";

const MAX_TEXT = 1_000_000;
const MAX_TAIL = 4_096;

interface Inflight {
  runId: string;
  status: "queued" | "running";
  text: string;
  reasoning: string;
  tools: Map<string, InflightState["tools"][number]>;
}

/** A tool progress payload as text (strings verbatim, anything else as JSON). */
export const progressChunk = (data: unknown): string =>
  typeof data === "string" ? data : JSON.stringify(data);

/**
 * In-flight state of each session's current run, rebuilt from the runner's events, so a
 * snapshot can carry what the durable store does not have yet: streamed text since the last
 * turn, reasoning (never persisted) and running tools with their output tail.
 */
export class InflightTracker {
  private runs = new Map<string, Inflight>();

  /** A scheduled run waiting for a slot (or started but not yet streaming). */
  mark(sessionId: string, runId: string, status: "queued" | "running"): void {
    const current = this.runs.get(sessionId);
    if (current && current.runId === runId) current.status = status;
    else this.runs.set(sessionId, { runId, status, text: "", reasoning: "", tools: new Map() });
  }

  clear(sessionId: string, runId?: string): void {
    if (!runId || this.runs.get(sessionId)?.runId === runId) this.runs.delete(sessionId);
  }

  apply(event: RunEvent): void {
    const sessionId = event.sessionId;
    if (event.type === "run_started") {
      this.mark(sessionId, event.runId, "running");
      return;
    }
    const run = this.runs.get(sessionId);
    if (!run || run.runId !== event.runId) return;
    const data = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case "text_delta":
        run.text = (run.text + String(data.delta ?? "")).slice(-MAX_TEXT);
        break;
      case "reasoning_delta":
        run.reasoning = (run.reasoning + String(data.delta ?? "")).slice(-MAX_TEXT);
        break;
      case "turn_completed":
        run.text = "";
        run.reasoning = "";
        break;
      case "tool_started":
        run.tools.set(String(data.id), {
          id: String(data.id),
          name: String(data.name ?? ""),
          arguments: String(data.arguments ?? ""),
          effect: (data.effect as Effect) ?? "external",
          startedAt: Date.parse(event.timestamp) || Date.now(),
          tail: "",
        });
        break;
      case "tool_progress": {
        const tool = run.tools.get(String(data.id));
        if (tool) tool.tail = (tool.tail + progressChunk(data.data)).slice(-MAX_TAIL);
        break;
      }
      case "tool_completed":
        run.tools.delete(String(data.id));
        break;
      case "run_completed":
      case "run_failed":
      case "run_cancelled":
      case "run_turns_exceeded":
        this.runs.delete(sessionId);
        break;
    }
  }

  get(sessionId: string): InflightState | undefined {
    const run = this.runs.get(sessionId);
    if (!run) return undefined;
    return {
      runId: run.runId,
      status: run.status,
      text: run.text,
      reasoning: run.reasoning,
      tools: [...run.tools.values()].map((tool) => ({ ...tool })),
    };
  }
}
