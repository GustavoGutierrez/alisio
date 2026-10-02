import type { GoalInfo, ServerFrame } from "@alisio/sdk";

/**
 * What a stream frame says about the open session's goal: the goal (or `null` for none) from a
 * snapshot or a `goal_changed` frame of that session, `undefined` for any other frame.
 */
export function goalFromFrame(
  frame: ServerFrame,
  sessionId: string | undefined,
): GoalInfo | null | undefined {
  if (frame.t !== "snapshot" && frame.t !== "goal_changed") return undefined;
  if (frame.sessionId !== sessionId) return undefined;
  return frame.goal ?? null;
}
