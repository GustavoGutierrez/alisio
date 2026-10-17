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
