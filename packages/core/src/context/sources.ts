import type { AnalysisCapability, ProofCriterion } from "@alisio/sdk";
import type { GoalRecord } from "../goal/machine.ts";
import type { PlanState } from "../plan/state.ts";
import type { InvariantSources } from "./invariants.ts";

const CAPABILITIES: readonly AnalysisCapability[] = ["analysis.run", "analysis.install"];
const LIVE_GOAL = new Set(["active", "paused", "blocked", "budget_limited"]);
const LIVE_PLAN = new Set(["approved", "implementing"]);

export interface InvariantSourceDeps {
  goal(sessionId: string): Pick<GoalRecord, "goalId" | "objective" | "status"> | undefined;
  plan(sessionId: string): PlanState | undefined;
  /** Proof criteria of the session; absent Proof is expressed by not wiring this source at all. */
  criteria(
    sessionId: string,
  ): readonly Pick<ProofCriterion, "criterionId" | "text" | "required" | "notApplicableReason">[];
  capabilities?: { granted(capability: AnalysisCapability, sessionId: string): boolean };
  /** How many external directories are approved; paths are never exposed. */
  externalDirectories(): number;
}

/**
 * Adapts the live stores to the runner's `invariantSources`: only material that still binds the
 * session is reported (a finished goal, a pending plan or a not-applicable criterion is not).
 */
export function createInvariantSources(deps: InvariantSourceDeps): InvariantSources {
  return {
    goal(sessionId) {
      const goal = deps.goal(sessionId);
      return goal && LIVE_GOAL.has(goal.status)
        ? { goalId: goal.goalId, objective: goal.objective }
        : undefined;
    },
    plan(sessionId) {
      const plan = deps.plan(sessionId);
      return plan && LIVE_PLAN.has(plan.status)
        ? {
            planId: plan.planId,
            revision: plan.revision,
            hash: plan.hash,
            title: plan.title,
            ...(plan.artifactId ? { artifactId: plan.artifactId } : {}),
          }
        : undefined;
    },
    criteria(sessionId) {
      return deps
        .criteria(sessionId)
        .filter((c) => !c.notApplicableReason)
        .map(({ criterionId, text, required }) => ({ criterionId, text, required }));
    },
    grants(sessionId) {
      return {
        capabilities: CAPABILITIES.filter((c) => deps.capabilities?.granted(c, sessionId)),
        externalDirectories: deps.externalDirectories(),
      };
    },
  };
}
