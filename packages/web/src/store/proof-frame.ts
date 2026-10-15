import type { ServerFrame } from "@alisio/sdk";

/**
 * What a stream frame says about the Proof ledger of the open session: how many criteria the
 * snapshot reports (`count`), or that a `proof_updated` event arrived (`changed`, the ledger is
 * read again). `undefined` for any other frame. The ledger itself is loaded on demand
 * (`store/proof.ts`, its own chunk): a session without criteria costs nothing here (D7).
 */
export function receiveProofFrame(
  frame: ServerFrame,
  sessionId: string | undefined,
): { count: number | undefined; changed: boolean } | undefined {
  if (!("sessionId" in frame) || frame.sessionId !== sessionId) return undefined;
  if (frame.t === "snapshot") return { count: frame.proof?.criteria ?? 0, changed: false };
  if (frame.t === "event" && frame.event.type === "proof_updated")
    return { count: undefined, changed: true };
  return undefined;
}
