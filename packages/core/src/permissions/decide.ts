/**
 * The effect gate of a tool call as a pure decision (spec D-25). The runner, `availableTools`, the
 * legacy `execute` tool and the Forja nested-call dispatcher all ask this one function, so a call
 * made from inside a script gets exactly the decision a direct call would get; there is no second
 * permission system.
 *
 * Rules, kept from the runner they were extracted from:
 *  - `read` and `internal` always run; `write`, `process` and `external` run when the policy says so.
 *  - A tool with no declared effect is `external`.
 *  - A capability tool (`analysis.run`) also runs on the `--allow-analysis` flag alone, and on a
 *    stored grant; the grant never widens the effect.
 *  - Otherwise the call asks, but only for `write`, `process` and `external`, and only when a
 *    person can be asked. Anything else is denied.
 *
 * The policy is read by reference on purpose: an "allow for the session" answer widens the very
 * same object, and the next decision must see it.
 */
import type { ToolDefinition } from "@alisio/sdk";
import type { Policy } from "../core/contracts.ts";

export type EffectDecision =
  | { kind: "allow"; via: "effect" | "flag" | "grant" }
  | { kind: "ask" }
  | { kind: "deny" };

export interface DecideContext {
  /** Whether an interactive approval could be opened for this call. */
  approvals: boolean;
  /** Whether the tool's capability holds a stored grant for the session. */
  capabilityGranted: boolean;
}

/** The tool's effect; a tool that declares none is treated as `external`. */
export const effectOf = (tool: Pick<ToolDefinition, "effect">): string => tool.effect ?? "external";

/** Whether the policy lets an effect run without asking. */
export const effectAllowed = (policy: Policy, effect: string): boolean =>
  effect === "read" ||
  effect === "internal" ||
  ((effect === "write" || effect === "process" || effect === "external") && !!policy[effect]);

/** Whether an effect can ever be put to a person (`read` and `internal` never are). */
export const effectAskable = (effect: string): effect is "write" | "process" | "external" =>
  effect === "write" || effect === "process" || effect === "external";

/** A tool's capability is pre-allowed by the policy alone (`--allow-analysis`). */
export const capabilityFlagAllowed = (
  policy: Policy,
  tool: Pick<ToolDefinition, "capability">,
): boolean => tool.capability === "analysis.run" && !!policy.analysis;

export function decideEffect(
  policy: Policy,
  tool: Pick<ToolDefinition, "effect" | "capability">,
  context: DecideContext,
): EffectDecision {
  const effect = effectOf(tool);
  const byEffect = effectAllowed(policy, effect);
  if (tool.capability) {
    // A broad process grant or --allow-analysis: allowed, audited as a flag decision.
    if (byEffect || capabilityFlagAllowed(policy, tool)) return { kind: "allow", via: "flag" };
    if (context.capabilityGranted) return { kind: "allow", via: "grant" };
  } else if (byEffect) return { kind: "allow", via: "effect" };
  return context.approvals && effectAskable(effect) ? { kind: "ask" } : { kind: "deny" };
}
