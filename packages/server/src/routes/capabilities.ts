/**
 * Persisted capability grants of a root session (spec §14.1): list (live grants first, then
 * recent audit rows) and revoke. A revocation broadcasts `capabilities_changed` to the session.
 */
import { type CapabilityGrants, toGrantWire } from "@alisio/core";
import type { ServerFrame } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";

export function registerCapabilityRoutes(
  router: Router,
  ctx: {
    grants: CapabilityGrants;
    sessions: SessionService;
    toSession: (sessionId: string, frame: ServerFrame) => void;
  },
): void {
  router.get("/api/sessions/:sid/capabilities", ({ params }) => {
    const session = ctx.sessions.get(params.sid ?? "");
    return { body: { items: ctx.grants.list(session.id).map(toGrantWire) } };
  });

  router.delete("/api/sessions/:sid/capabilities/:gid", ({ params }) => {
    const session = ctx.sessions.get(params.sid ?? "");
    if (!ctx.grants.revoke(session.id, params.gid ?? "", "web"))
      throw new HttpError("not_found", "Grant not found or already revoked");
    const root = ctx.sessions.rootOf(session.id);
    ctx.toSession(root, { t: "capabilities_changed", sessionId: root });
    return { body: { revoked: true } };
  });
}
