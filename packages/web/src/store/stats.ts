/**
 * The per-session stats line (RF-16), derived from durable events: turns = `turn_completed`,
 * steps = `tool_completed`, LLM time = Σ turn `durationMs`, tool time = Σ tool `durationMs`,
 * TTFT = mean turn `ttftMs`, tok/s = Σ output / LLM time, cache = Σ cachedInput / Σ input over
 * the turns that report it (unknown, never 0 %, when none does). Pure.
 */
import type { RunEvent, Usage } from "@alisio/sdk";

export interface Stats {
  runs: number;
  turns: number;
  steps: number;
  llmMs: number;
  toolMs: number;
  ttftMs?: number;
  tokensPerSecond?: number;
  /** 0–1, or undefined when the provider never reported cached input. */
  cacheHit?: number;
  inputTokens: number;
  outputTokens: number;
}

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function computeStats(events: RunEvent[]): Stats {
  const runs = new Set<string>();
  let turns = 0;
  let steps = 0;
  let llmMs = 0;
  let toolMs = 0;
  let ttftSum = 0;
  let ttftCount = 0;
  let input = 0;
  let output = 0;
  let cachedInput = 0;
  let cacheBase = 0;
  let cacheReported = false;
  for (const event of events) {
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (event.type === "run_started") runs.add(event.runId);
    else if (event.type === "turn_completed") {
      runs.add(event.runId);
      turns++;
      llmMs += num(data.durationMs) ?? 0;
      const ttft = num(data.ttftMs);
      if (ttft !== undefined) {
        ttftSum += ttft;
        ttftCount++;
      }
      const usage = data.usage as Partial<Usage> | undefined;
      input += num(usage?.input) ?? 0;
      output += num(usage?.output) ?? 0;
      const cached = num(usage?.cachedInput);
      if (cached !== undefined) {
        cacheReported = true;
        cachedInput += cached;
        cacheBase += num(usage?.input) ?? 0;
      }
    } else if (event.type === "tool_completed") {
      steps++;
      toolMs += num(data.durationMs) ?? 0;
    }
  }
  return {
    runs: runs.size,
    turns,
    steps,
    llmMs,
    toolMs,
    ...(ttftCount ? { ttftMs: Math.round(ttftSum / ttftCount) } : {}),
    ...(llmMs > 0 && output > 0 ? { tokensPerSecond: Math.round(output / (llmMs / 1000)) } : {}),
    ...(cacheReported ? { cacheHit: cacheBase > 0 ? cachedInput / cacheBase : 0 } : {}),
    inputTokens: input,
    outputTokens: output,
  };
}

/** Stats of the latest run (the default view) and of the whole session (the hover). */
export function sessionStats(events: RunEvent[]): { last?: Stats; session: Stats } {
  const lastRun = events.at(-1)?.runId;
  return {
    ...(lastRun ? { last: computeStats(events.filter((e) => e.runId === lastRun)) } : {}),
    session: computeStats(events),
  };
}

/** `16ms`, `0.6s`, `11.9s`, `2m 5s` (under 100 ms, tenths of a second would read as 0). */
export function formatSeconds(ms: number): string {
  if (ms < 100) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m ${total % 60}s`;
}

/** `999`, `12.3k`, `2.5M`. */
export function compactNumber(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
