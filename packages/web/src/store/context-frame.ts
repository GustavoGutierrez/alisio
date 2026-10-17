import type { ServerFrame } from "@alisio/sdk";

/**
 * Whether a stream frame is a `context_governed` event of the open session: the Context tab reads
 * its report again and appears. The report itself is its own chunk (`store/context-report.ts`).
 */
export const isContextGoverned = (frame: ServerFrame, sessionId: string | undefined): boolean =>
  frame.t === "event" && frame.sessionId === sessionId && frame.event.type === "context_governed";
