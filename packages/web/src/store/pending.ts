/**
 * Approvals and plugin interactions waiting for this tab (RF-08, RF-18). Pure reducers: a
 * snapshot replaces the pending items of its session; `approval`/`interaction` frames add,
 * `*_withdrawn` frames remove.
 */
import type {
  PendingApproval,
  PendingInteraction,
  ServerFrame,
  SessionDetailWire,
} from "@alisio/sdk";

export interface PendingState {
  approvals: PendingApproval[];
  interactions: PendingInteraction[];
}

export const emptyPending = (): PendingState => ({ approvals: [], interactions: [] });

export function applyPending(state: PendingState, frame: ServerFrame): PendingState {
  switch (frame.t) {
    case "snapshot": {
      const root = frame.sessionId;
      const ids = new Set(frame.pending.interactions.map((i) => i.interactionId));
      return {
        approvals: [
          ...state.approvals.filter((a) => a.rootSessionId !== root),
          ...frame.pending.approvals,
        ],
        interactions: [
          ...state.interactions.filter((i) => !ids.has(i.interactionId)),
          ...frame.pending.interactions,
        ],
      };
    }
    case "approval":
      return {
        ...state,
        approvals: [
          ...state.approvals.filter((a) => a.approvalId !== frame.approval.approvalId),
          frame.approval,
        ],
      };
    case "approval_withdrawn":
      return {
        ...state,
        approvals: state.approvals.filter((a) => a.approvalId !== frame.approvalId),
      };
    case "interaction":
      return {
        ...state,
        interactions: [
          ...state.interactions.filter((i) => i.interactionId !== frame.interaction.interactionId),
          frame.interaction,
        ],
      };
    case "interaction_withdrawn":
      return {
        ...state,
        interactions: state.interactions.filter((i) => i.interactionId !== frame.interactionId),
      };
    default:
      return state;
  }
}

/** What the session view shows: its tree's approvals and its workspace's interactions. */
export function visiblePending(
  state: PendingState,
  session: Pick<SessionDetailWire, "id" | "workspaceId"> | undefined,
): PendingState {
  if (!session) return emptyPending();
  return {
    approvals: state.approvals.filter((a) => a.rootSessionId === session.id),
    interactions: state.interactions.filter(
      (i) => i.workspaceId === session.workspaceId && (!i.sessionId || i.sessionId === session.id),
    ),
  };
}

/** Drops an item this tab answered (the server also withdraws it). */
export const resolveLocal = (state: PendingState, id: string): PendingState => ({
  approvals: state.approvals.filter((a) => a.approvalId !== id),
  interactions: state.interactions.filter((i) => i.interactionId !== id),
});
