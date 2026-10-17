import type { ContextReport, ContextSegment } from "@alisio/sdk";
import type { GovernanceSnapshot } from "./governance.ts";
import type { UsageSummary } from "./usage.ts";

const REASONS = ["superseded_read", "stale_bg_output", "duplicate_search"] as const;

const percent = (used: number, observed: number) => Math.round((used / observed) * 100);

/**
 * The "Context Governor" block of `/stats`, shared by the core handler and the TUI report.
 * `undefined` when there is nothing to show (mode `off`, or no request has been measured yet), so
 * the section is omitted. Counts and ratios only; the usage figures are a path heuristic for this
 * process and session (spec 012 section 3.4).
 */
export function formatContextGovernorStatsSection(input: {
  governance?: GovernanceSnapshot;
  usage?: UsageSummary;
}): string | undefined {
  const { governance: g, usage: u } = input;
  const hasUsage = !!u && u.observed + u.pending + u.unattributed + u.stubOnly + u.rereads > 0;
  if (!g && !hasUsage) return undefined;
  const lines = ["**Context Governor**", ""];
  if (g) {
    lines.push(`- Mode: ${g.mode} · policy v${g.policyVersion}`);
    const reasons = REASONS.filter((r) => g.byReason[r] > 0).map((r) => `${r} ${g.byReason[r]}`);
    lines.push(
      `- Last request: ${g.messages} messages · ${g.elided} elided${
        reasons.length ? ` (${reasons.join(", ")})` : ""
      } · ~${g.tokensSaved} tokens saved (estimate)`,
    );
    const inv = g.invariants;
    if (inv.count > 0 || inv.chars > 0 || inv.omitted > 0)
      lines.push(`- Invariants: ${inv.count} (${inv.chars} chars, ${inv.omitted} omitted)`);
  }
  if (u && hasUsage) {
    if (u.observed > 0) {
      const tools = Object.entries(u.byTool)
        .filter(([, c]) => c.observed > 0)
        .sort(([an, a], [bn, b]) => b.observed - a.observed || (an < bn ? -1 : an > bn ? 1 : 0))
        .map(([name, c]) => `${name} ${c.used}/${c.observed}`);
      lines.push(
        `- Tool results used later: ${u.used} of ${u.observed} (${percent(u.used, u.observed)}%)${
          tools.length ? ` · ${tools.join(" · ")}` : ""
        }`,
      );
    }
    lines.push(
      `- Not attributable: ${u.unattributed} · pending: ${u.pending} · re-reads: ${u.rereads}${
        u.stubOnly > 0 ? ` · stub only: ${u.stubOnly}` : ""
      }`,
    );
  }
  lines.push(
    '- Counts cover this process only; "used" is a path heuristic, not a measure of what the model needed.',
  );
  return lines.join("\n");
}

const cell = (text: string) => text.replace(/[|\r\n]+/g, " ").trim();

/** The segments a reader needs explained: pinned, elided and low ones. The rest is counted. */
export const notableSegments = (report: ContextReport): ContextSegment[] =>
  report.segments.filter((s) => s.criticality === "pinned" || s.criticality === "low" || s.elided);

/**
 * `/context` as markdown, for the TUI and the core command catalog. It renders the same
 * `ContextReport` the web panel and the route show: every elided, pinned and low segment with its
 * reason, and counts for the rest. Ids, counts and estimates only.
 */
export function formatContextReport(report: ContextReport): string {
  if (report.mode === "off")
    return [
      "**Context**",
      "",
      "- The Context Governor is off, so nothing is measured for this session.",
      '- Set `context.governor` to `"shadow"` (measure only) or `"on"` (also elide) to see which segments the next request carries and why.',
    ].join("\n");
  const reasons = REASONS.filter((r) => report.byReason[r] > 0).map(
    (r) => `${r} ${report.byReason[r]}`,
  );
  const lines = [
    "**Context**",
    "",
    `- Mode: ${report.mode} · policy v${report.policyVersion}${
      report.request ? ` · latest request #${report.request}` : ""
    }`,
    `- History: ${report.messages} messages · ~${report.tokensBefore} tokens (estimate) -> ~${report.tokensAfter} after the policy (${
      report.mode === "on" ? "applied" : "measured only, not applied"
    })`,
    `- Elided${report.mode === "on" ? "" : " (would be)"}: ${report.elided}${
      reasons.length ? ` (${reasons.join(", ")})` : ""
    } · ~${report.tokensSaved} tokens saved (estimate)`,
  ];
  const ratios = Object.entries(report.usedRatioByKind).map(
    ([kind, ratio]) => `${kind} ${Math.round((ratio ?? 0) * 100)}%`,
  );
  if (ratios.length) lines.push(`- Used later: ${ratios.join(" · ")} (path heuristic)`);
  const inv = report.invariants;
  const kinds = Object.entries(inv.byKind).map(([kind, n]) => `${kind} ${n}`);
  lines.push(
    `- Invariants: ${inv.count}${inv.omitted ? ` (${inv.omitted} omitted)` : ""}${
      kinds.length ? ` · ${kinds.join(" · ")}` : ""
    } (counts only)`,
  );
  const notable = notableSegments(report);
  if (notable.length) {
    lines.push(
      "",
      "| Segment | Kind | Origin | Tokens | Criticality | Decision |",
      "| --- | --- | --- | --- | --- | --- |",
    );
    for (const s of notable) {
      const decision = s.elided
        ? `${report.mode === "on" ? "elided" : "would elide"}: ${s.elided.reason}${
            s.elided.replacedBy ? ` (replaced by ${cell(s.elided.replacedBy)})` : ""
          } · ~${s.elided.tokensSaved} saved`
        : (s.reason ?? "");
      lines.push(
        `| \`${s.id}\` | ${s.kind} | ${cell(s.origin ?? "")}${s.callId ? ` (${cell(s.callId)})` : ""} | ${s.tokens} | ${s.criticality} | ${cell(decision)} |`,
      );
    }
  }
  const rest = report.segments.length - notable.length + (report.segmentsOmitted ?? 0);
  if (rest > 0) lines.push("", `${rest} more segments are ordinary or recent and not listed.`);
  lines.push("", 'Token figures are estimates; "used" is a path heuristic for this process.');
  return lines.join("\n");
}
