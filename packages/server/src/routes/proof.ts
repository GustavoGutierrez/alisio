/**
 * Proof (specs/011 phase 5): the ledger of a session and what only the user may do to it. Reads
 * come from the server's own store connection (no workspace is opened to show a card); writes go
 * through the workspace application. The same auth, Host and Origin rules as every `/api` route.
 *
 * - `GET  /api/sessions/:sid/proof`                       the ledger (`ProofLedger`)
 * - `POST /api/sessions/:sid/proof/criteria`              create a criterion, or edit one
 *                                                          (`criterionId` + `text`/`required`)
 * - `POST /api/sessions/:sid/proof/criteria/:id/not-applicable`   `{reason}`; user only (O2)
 * - `GET  /api/sessions/:sid/proof/export?format=md|json` the `proof.md` / `proof/v1` download
 *
 * A tool result, a plan text or the model can never reach these: criteria change only here, in
 * the plan decision of the user (`exit_plan`) and through `--criterion`/`--proof-file`.
 */
import {
  type ProofStore,
  parseCriteriaInput,
  renderProofJson,
  renderProofMarkdown,
} from "@alisio/core";
import type { ProofLedger } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";
import { attachmentDisposition } from "./artifacts.ts";

const TEXT_MAX = 600;
const REASON_MAX = 500;
const SCOPE = is.array(is.nonEmpty(256), 20);

/** The field a criterion parsing error is about (its message names it), for validation details. */
const fieldOf = (reason: string): string =>
  /verifier|command|cwd|exit|pattern|path/i.test(reason)
    ? "verifier"
    : /scope/i.test(reason)
      ? "scope"
      : "text";

export function registerProofRoutes(router: Router, ctx: { sessions: SessionService }): void {
  const { sessions } = ctx;
  const read = (sid: string | undefined): ProofLedger => {
    const session = sessions.get(sid ?? "");
    return sessions.proof.view(session.id);
  };
  /** The session and the writable store of its workspace (user actions only). */
  const open = async (sid: string | undefined): Promise<{ id: string; proof: ProofStore }> => {
    const session = sessions.get(sid ?? "");
    if (session.parentId)
      throw new HttpError("validation_failed", "Criteria belong to a root session.", {
        fields: ["sid"],
      });
    if (session.archivedAt)
      throw new HttpError("validation_failed", "The session is archived.", { fields: ["sid"] });
    const { app } = await sessions.app(session);
    return { id: session.id, proof: app.proof };
  };

  router.get("/api/sessions/:sid/proof", ({ params }) => ({ body: read(params.sid) }));

  router.post("/api/sessions/:sid/proof/criteria", async ({ req, params }) => {
    const input = validate<{
      criterionId?: string;
      text?: string;
      required?: boolean;
      verify?: string;
      verifier?: Record<string, unknown>;
      scope?: string[];
    }>(await readJson(req), {
      criterionId: { check: is.nonEmpty(64) },
      text: { check: is.nonEmpty(TEXT_MAX) },
      required: { check: is.boolean() },
      verify: { check: is.nonEmpty(1_000) },
      verifier: { check: is.object() },
      scope: { check: SCOPE },
    });
    const { id, proof } = await open(params.sid);
    if (input.criterionId !== undefined) {
      // An edit changes the wording and the required flag only: evidence stays tied to what was
      // verified, so a different check is a new criterion.
      const forbidden = ["verify", "verifier", "scope"].filter(
        (key) => (input as Record<string, unknown>)[key] !== undefined,
      );
      if (forbidden.length)
        throw new HttpError("validation_failed", "A criterion's verifier and scope are fixed.", {
          fields: forbidden,
        });
      const current = proof.criterion(input.criterionId);
      if (!current || current.sessionId !== id)
        throw new HttpError("not_found", "Criterion not found");
      proof.updateCriterion(current.criterionId, {
        ...(input.text !== undefined ? { text: input.text } : {}),
        ...(input.required !== undefined ? { required: input.required } : {}),
      });
    } else {
      if (input.text === undefined)
        throw new HttpError("validation_failed", "A criterion needs text", { fields: ["text"] });
      const parsed = parseCriteriaInput(
        [
          {
            text: input.text,
            required: input.required ?? false,
            ...(input.verify !== undefined ? { verify: input.verify } : {}),
            ...(input.verifier !== undefined ? { verifier: input.verifier } : {}),
            ...(input.scope !== undefined ? { scope: input.scope } : {}),
          },
        ],
        { origin: "user", defaultRequired: false },
      );
      const failed = parsed.errors[0];
      const criterion = parsed.criteria[0];
      if (failed || !criterion)
        throw new HttpError("validation_failed", failed?.reason ?? "Invalid criterion", {
          fields: [fieldOf(failed?.reason ?? "")],
        });
      proof.addCriterion({ sessionId: id, ...criterion });
    }
    return { body: sessions.proof.view(id) };
  });

  router.post("/api/sessions/:sid/proof/criteria/:cid/not-applicable", async ({ req, params }) => {
    const input = validate<{ reason: string }>(await readJson(req), {
      reason: { check: is.nonEmpty(REASON_MAX), required: true },
    });
    const { id, proof } = await open(params.sid);
    const current = proof.criterion(params.cid ?? "");
    if (!current || current.sessionId !== id)
      throw new HttpError("not_found", "Criterion not found");
    proof.markNotApplicable(current.criterionId, input.reason);
    return { body: sessions.proof.view(id) };
  });

  router.get("/api/sessions/:sid/proof/export", ({ params, url, res }) => {
    const format = url.searchParams.get("format") ?? "json";
    if (format !== "json" && format !== "md")
      throw new HttpError("validation_failed", "format must be md or json", { fields: ["format"] });
    const ledger = read(params.sid);
    const markdown = format === "md";
    const body = markdown ? renderProofMarkdown(ledger) : renderProofJson(ledger);
    res.writeHead(200, {
      "Content-Type": markdown ? "text/markdown; charset=utf-8" : "application/json; charset=utf-8",
      "Content-Length": Buffer.byteLength(body),
      "Content-Disposition": attachmentDisposition(markdown ? "proof.md" : "proof.json"),
      "Cache-Control": "private, no-store",
    });
    res.end(body);
    return undefined;
  });
}
