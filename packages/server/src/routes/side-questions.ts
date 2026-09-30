import { SIDE_QUESTION_MAX_CHARS } from "@alisio/core";
import type { SideQuestionEntry } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

/**
 * `/btw` side questions (tool-less answers about a session outside its conversation):
 * `GET /api/sessions/:sid/btw` lists the session's side questions (oldest first),
 * `POST /api/sessions/:sid/btw {question}` answers one, and `POST .../btw/cancel` cancels the
 * session's in-flight ones. A client that closes the request also cancels it. Side questions
 * never produce durable events, messages or runs, and never wait for the session to be idle.
 */
export function registerSideQuestionRoutes(
  router: Router,
  ctx: { sessions: SessionService },
): void {
  const { sessions } = ctx;
  const inflight = new Map<string, Set<AbortController>>();

  router.get("/api/sessions/:sid/btw", async ({ params }) => {
    const session = sessions.get(params.sid ?? "");
    const opened = await sessions.app(session);
    return { body: opened.app.sideQuestions.history(session.id) satisfies SideQuestionEntry[] };
  });

  router.post("/api/sessions/:sid/btw", async ({ req, res, params }) => {
    const session = sessions.get(params.sid ?? "");
    const input = validate<{ question: string }>(await readJson(req), {
      question: { check: is.nonEmpty(SIDE_QUESTION_MAX_CHARS), required: true },
    });
    const opened = await sessions.app(session);
    const controller = new AbortController();
    // The client went away before the answer: stop the provider call.
    const onClose = () => {
      if (!res.writableFinished) controller.abort(new Error("Side question cancelled"));
    };
    res.on("close", onClose);
    const running = inflight.get(session.id) ?? new Set<AbortController>();
    running.add(controller);
    inflight.set(session.id, running);
    try {
      const entry = await opened.app.sideQuestions.ask(session.id, input.question, {
        signal: controller.signal,
      });
      return { body: entry satisfies SideQuestionEntry };
    } catch (error) {
      if (controller.signal.aborted) throw new HttpError("cancelled", "Side question cancelled");
      throw new HttpError(
        "provider_unavailable",
        error instanceof Error ? error.message : "Side question failed",
      );
    } finally {
      res.off("close", onClose);
      running.delete(controller);
      if (!running.size) inflight.delete(session.id);
    }
  });

  router.post("/api/sessions/:sid/btw/cancel", async ({ params }) => {
    const session = sessions.get(params.sid ?? "");
    const running = [...(inflight.get(session.id) ?? [])];
    for (const controller of running) controller.abort(new Error("Side question cancelled"));
    return { body: { cancelled: running.length > 0 } };
  });
}
