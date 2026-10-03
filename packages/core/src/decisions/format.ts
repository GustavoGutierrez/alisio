import type { DecisionStats } from "@alisio/sdk";
import type { DecisionMetricsSnapshot } from "./metrics.ts";
import type { DecisionStatus, DecisionsConfig } from "./service.ts";

/** `12:04:31 UTC`: deterministic, independent of the viewer's time zone. */
const clock = (iso: string): string => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : `${date.toISOString().slice(11, 19)} UTC`;
};
const latency = (s: { avgLatencyMs?: number; p95LatencyMs?: number }): string | undefined =>
  s.avgLatencyMs === undefined ? undefined : `avg ${s.avgLatencyMs} ms · p95 ${s.p95LatencyMs} ms`;
const packsLine = (packs: Record<string, number>): string =>
  Object.entries(packs)
    .map(([id, count]) => `${id} (${count})`)
    .join(", ");
const lastFallbackLine = (f: NonNullable<DecisionStats["lastFallback"]>): string =>
  `Last fallback: ${f.reason} (${f.decisionId}) at ${clock(f.at)}`;

/**
 * The "Decision Intelligence" block of `/stats` (spec §9.2), shared by the core handler and the
 * TUI report. `undefined` when no decision happened, so the section is omitted.
 */
export function formatDecisionStatsSection(stats: DecisionStats): string | undefined {
  if (stats.requests <= 0) return undefined;
  const lat = latency(stats);
  const packs = packsLine(stats.packs);
  return [
    "**Decision Intelligence**",
    "",
    ...(stats.provider ? [`- Provider: ${stats.provider}`] : []),
    `- Requests: ${stats.requests} · completed ${stats.completed} · fallbacks ${stats.fallbacks}`,
    ...(lat ? [`- Latency: ${lat}`] : []),
    ...(stats.lastFallback ? [`- ${lastFallbackLine(stats.lastFallback)}`] : []),
    ...(packs ? [`- Packs: ${packs}`] : []),
  ].join("\n");
}

const MESSAGE_LIMIT = 200;

/** The `/decisions` report (spec §9.1). */
export function formatDecisionsReport(input: {
  status: DecisionStatus;
  config: Pick<DecisionsConfig, "timeoutMs" | "minConfidence" | "telemetry">;
  session: DecisionMetricsSnapshot;
  process: DecisionMetricsSnapshot;
}): string {
  const { status, config, session, process } = input;
  let head: string;
  if (!status.enabled) head = "disabled";
  else if (status.configured === null)
    head = "enabled · no provider configured (set decisions.provider)";
  else if (!status.active) head = `enabled · provider "${status.configured}" is not registered`;
  else {
    const health = status.health
      ? `${status.health.status}${status.health.detail ? ` (${status.health.detail})` : ""}`
      : "unknown";
    head = `enabled · provider: ${status.active.id} (${status.active.name}) · health: ${health}`;
  }
  const caps = status.active
    ? Object.entries(status.active.capabilities)
        .filter(([, on]) => on === true)
        .map(([name]) => name)
    : [];
  const err = status.lastLifecycleError;
  const row = (label: string, m: DecisionMetricsSnapshot) =>
    `| ${label} | ${m.requests} | ${m.completed} | ${m.fallbacks} |`;
  const lat = [
    latency(session) ? `session ${latency(session)}` : undefined,
    latency(process) ? `process ${latency(process)}` : undefined,
  ].filter(Boolean);
  const fallback = session.lastFallback ?? process.lastFallback;
  const packScope = Object.keys(session.packs).length ? session.packs : process.packs;
  const packs = packsLine(packScope);
  return [
    "**Decision Intelligence**",
    "",
    `- Status: ${head}`,
    ...(caps.length ? [`- Capabilities: ${caps.join(", ")}`] : []),
    ...(status.active ? [`- Circuit: ${status.circuit}`] : []),
    `- Timeout: ${config.timeoutMs} ms · min confidence: ${config.minConfidence} · telemetry: ${config.telemetry ? "on" : "off"}`,
    ...(err
      ? [
          `- Lifecycle error: ${err.phase} of ${err.provider} failed: ${err.message.slice(0, MESSAGE_LIMIT)}`,
        ]
      : []),
    "",
    ...(process.requests > 0
      ? [
          "| Scope | Requests | Completed | Fallbacks |",
          "| --- | --- | --- | --- |",
          row("This session", session),
          row("Process", process),
          "",
          ...(lat.length ? [`- Latency: ${lat.join("; ")}`] : []),
          ...(fallback ? [`- ${lastFallbackLine(fallback)}`] : []),
          ...(packs
            ? [`- Packs${Object.keys(session.packs).length ? "" : " (process)"}: ${packs}`]
            : []),
        ]
      : ["No decisions yet in this process."]),
  ].join("\n");
}
