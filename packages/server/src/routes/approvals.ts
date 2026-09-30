import type { ApprovalDecision } from "@alisio/core";
import type { ApprovalBridge } from "../bridges/approval-bridge.ts";
import type { InteractionBridge } from "../bridges/interaction-bridge.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

/** Approvals and plugin interactions answered from the web (first answer wins). */
export function registerApprovalRoutes(
  router: Router,
  ctx: { approvals: ApprovalBridge; interactions: InteractionBridge },
): void {
  router.get("/api/approvals", ({ url }) => ({
    body: ctx.approvals.pending(url.searchParams.get("session") ?? undefined),
  }));

  router.post("/api/approvals/:aid", async ({ req, params }) => {
    const { decision } = validate<{ decision: ApprovalDecision }>(await readJson(req), {
      decision: { check: is.oneOf(["once", "session", "deny"]), required: true },
    });
    const outcome = ctx.approvals.resolve(params.aid ?? "", decision);
    if (outcome === "not_found") throw new HttpError("not_found", "Approval not found");
    if (outcome === "already_resolved")
      throw new HttpError("approval_resolved", "This approval was already answered");
    return { body: { resolved: true } };
  });

  router.post("/api/interactions/:iid", async ({ req, params }) => {
    const { answer } = validate<{ answer: unknown }>(await readJson(req), {
      answer: { check: is.any(), required: true },
    });
    const outcome = ctx.interactions.resolve(params.iid ?? "", answer);
    if (outcome === "not_found") throw new HttpError("not_found", "Interaction not found");
    if (outcome === "already_resolved")
      throw new HttpError("approval_resolved", "This interaction was already answered");
    if (outcome === "invalid")
      throw new HttpError("validation_failed", "Invalid answer", { fields: ["answer"] });
    return { body: { resolved: true } };
  });
}
