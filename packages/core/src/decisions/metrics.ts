import type { DecisionFallbackReason } from "@alisio/sdk";

const LATENCY_RING = 200;
const MAX_SESSIONS = 200;

export type DecisionMetricEntry =
  | {
      status: "completed";
      decisionId: string;
      pack?: { id: string; version: number };
      provider: string;
      latencyMs: number;
    }
  | {
      status: "fallback";
      decisionId: string;
      pack?: { id: string; version: number };
      provider: string;
      latencyMs: number;
      reason: DecisionFallbackReason;
    };

export interface DecisionMetricsSnapshot {
  requests: number;
  completed: number;
  fallbacks: number;
  avgLatencyMs?: number;
  p95LatencyMs?: number;
  lastFallback?: { reason: DecisionFallbackReason; decisionId: string; at: string };
  packs: Record<string, number>;
  provider?: string;
}

class Tally {
  completed = 0;
  fallbacks = 0;
  provider: string | undefined;
  lastFallback: DecisionMetricsSnapshot["lastFallback"];
  packs = new Map<string, number>();
  /** Ring of the last completed latencies. */
  private latencies: number[] = [];
  private next = 0;

  add(entry: DecisionMetricEntry, at: string): void {
    this.provider = entry.provider;
    if (entry.pack) this.packs.set(entry.pack.id, (this.packs.get(entry.pack.id) ?? 0) + 1);
    if (entry.status === "completed") {
      this.completed++;
      if (this.latencies.length < LATENCY_RING) this.latencies.push(entry.latencyMs);
      else this.latencies[this.next] = entry.latencyMs;
      this.next = (this.next + 1) % LATENCY_RING;
    } else {
      this.fallbacks++;
      this.lastFallback = { reason: entry.reason, decisionId: entry.decisionId, at };
    }
  }

  snapshot(): DecisionMetricsSnapshot {
    const out: DecisionMetricsSnapshot = {
      requests: this.completed + this.fallbacks,
      completed: this.completed,
      fallbacks: this.fallbacks,
      packs: Object.fromEntries(this.packs),
    };
    if (this.latencies.length) {
      const sorted = [...this.latencies].sort((a, b) => a - b);
      out.avgLatencyMs = Math.round(sorted.reduce((sum, v) => sum + v, 0) / sorted.length);
      out.p95LatencyMs = sorted[Math.ceil(0.95 * sorted.length) - 1] as number;
    }
    if (this.lastFallback) out.lastFallback = { ...this.lastFallback };
    if (this.provider) out.provider = this.provider;
    return out;
  }
}

/** In-memory, per-process decision metrics with an optional per-session view. Never persisted. */
export class DecisionMetrics {
  private process = new Tally();
  private sessions = new Map<string, Tally>();

  constructor(private now: () => number = () => Date.now()) {}

  record(entry: DecisionMetricEntry, sessionId?: string): void {
    const at = new Date(this.now()).toISOString();
    this.process.add(entry, at);
    if (!sessionId) return;
    let tally = this.sessions.get(sessionId);
    if (!tally) {
      if (this.sessions.size >= MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value;
        if (oldest !== undefined) this.sessions.delete(oldest);
      }
      tally = new Tally();
      this.sessions.set(sessionId, tally);
    }
    tally.add(entry, at);
  }

  /** The session's view, or the whole process when no session is given. */
  snapshot(sessionId?: string): DecisionMetricsSnapshot {
    if (sessionId === undefined) return this.process.snapshot();
    return (this.sessions.get(sessionId) ?? new Tally()).snapshot();
  }
}
