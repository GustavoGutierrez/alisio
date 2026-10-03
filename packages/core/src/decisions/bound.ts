import type {
  DecisionOptions,
  DecisionRequest,
  DecisionResponse,
  RunEventDataMap,
  ToolDecisions,
} from "@alisio/sdk";
import type { DecisionOutcome, DecisionService } from "./service.ts";

/** Reports one decision event of the run that owns the call (never persisted by the caller). */
export type DecisionAnnouncer = <K extends "decision_completed" | "decision_fallback">(
  type: K,
  data: RunEventDataMap[K],
) => void;

/**
 * The event of one outcome. Fields are copied one by one on purpose (ADR-7): the payload is
 * metadata only, so nothing that rides along on the outcome can reach a persisted row.
 */
export function outcomeEvent(
  outcome: DecisionOutcome,
):
  | { type: "decision_completed"; data: RunEventDataMap["decision_completed"] }
  | { type: "decision_fallback"; data: RunEventDataMap["decision_fallback"] } {
  const identity = {
    decisionId: outcome.decisionId,
    ...(outcome.pack ? { pack: { id: outcome.pack.id, version: outcome.pack.version } } : {}),
    provider: outcome.provider,
    latencyMs: outcome.latencyMs,
  };
  if (outcome.status === "completed")
    return {
      type: "decision_completed",
      data: {
        ...identity,
        decisionCount: outcome.decisionCount,
        rejectedCount: outcome.rejectedCount,
        confidenceMin: outcome.confidenceMin,
      },
    };
  return { type: "decision_fallback", data: { ...identity, reason: outcome.reason } };
}

/**
 * `ToolContext.decisions` of one tool call (ADR-8): the consumer surface of the service, bound to
 * the run. Metrics are attributed to the session; the event is announced only while
 * `decisions.telemetry` is on (read per call, so a live change applies at once).
 */
export function bindDecisions(
  service: DecisionService,
  telemetry: () => boolean,
  call: { sessionId: string },
  announce: DecisionAnnouncer,
): ToolDecisions {
  return {
    available: () => service.available(),
    activeProvider: () => service.activeProvider(),
    async tryDecide(
      req: DecisionRequest,
      opts?: DecisionOptions,
    ): Promise<DecisionResponse | null> {
      const { response, outcome } = await service.attempt(req, opts, { sessionId: call.sessionId });
      if (outcome && telemetry()) {
        const event = outcomeEvent(outcome);
        // The observer path never invalidates a decision that already happened.
        try {
          announce(event.type, event.data as never);
        } catch {
          /* The consumer still gets its answer. */
        }
      }
      return response;
    },
  };
}
