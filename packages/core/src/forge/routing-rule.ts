/**
 * Layer 0 of the incremental context (spec §8.1, D12): a short routing rule, present in the system
 * prompt only when a Forja engine is registered and ready. With every engine off the prompt stays
 * byte for byte what it was. The rule is built, never stored: the lines follow the tools actually
 * registered and the session's real scratchpad path.
 */

/** Hard bound of the rule (spec §8.1). */
export const ROUTING_RULE_MAX_CHARS = 900;

export interface RoutingRuleInput {
  /** `js_run` is registered. */
  javascript: boolean;
  /** `python_run` is registered (Forja line for it only then). */
  python: boolean;
  /** `forge_guide` is registered: the rule tells the model to call it. */
  guide?: boolean;
  /** Absolute path of this session's scratchpad, when there is one. */
  scratchpad?: string | undefined;
}

export function buildRoutingRule(input: RoutingRuleInput): string {
  if (!input.javascript && !input.python) return "";
  const lines = ["# Code execution"];
  lines.push("- One tool call, or a few you can chain: call the tools directly.");
  if (input.javascript)
    lines.push(
      "- Many reads, paging, filtering or aggregating tool results, JSON/text transforms, light maths: `js_run` (sandboxed JS: `await tools.call(name, input)`, `return` a small JSON value).",
    );
  if (input.python)
    lines.push(
      "- Data analysis, statistics, ML, charts, XLSX/DOCX/PDF, special dashboards: `python_run`.",
    );
  if (input.guide) lines.push("- Call `forge_guide` before writing non-trivial code.");
  if (input.scratchpad) {
    // Which saved scripts the tools can run: only the tools that exist are named.
    const runs =
      input.javascript && input.python
        ? "; saved scripts: `js_run` `codePath` (.js), `python_run` `codePath` (.py)"
        : input.javascript
          ? "; saved scripts run with `js_run` `codePath`"
          : "; saved scripts run with `python_run` `codePath`";
    lines.push(`- Scratchpad (no approval for writes): ${input.scratchpad}${runs}.`);
  }
  const text = lines.join("\n");
  return text.length <= ROUTING_RULE_MAX_CHARS ? text : text.slice(0, ROUTING_RULE_MAX_CHARS);
}
