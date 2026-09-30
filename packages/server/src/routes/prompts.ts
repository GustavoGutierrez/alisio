import { randomUUID } from "node:crypto";
import type { Attachment, BlobRef, PromptAccepted } from "@alisio/sdk";
import type { RunScheduler } from "../host/run-scheduler.ts";
import type { SessionService } from "../host/sessions.ts";
import { readJson } from "../http/body.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { is, validate } from "../schemas.ts";

/**
 * In-memory idempotency for requests that do not create a run (enqueued prompts, commands):
 * the last 100 request ids per session for 10 minutes. Lost on restart, like the runner's
 * own enqueue queue.
 */
export class RecentRequests {
  private seen = new Map<string, Map<string, number>>();
  constructor(
    private limit = 100,
    private ttlMs = 10 * 60_000,
  ) {}
  has(sessionId: string, requestId: string, now = Date.now()): boolean {
    const expires = this.seen.get(sessionId)?.get(requestId);
    return expires !== undefined && expires > now;
  }
  add(sessionId: string, requestId: string, now = Date.now()): void {
    const entries = this.seen.get(sessionId) ?? new Map<string, number>();
    entries.set(requestId, now + this.ttlMs);
    for (const [id, expires] of entries) if (expires <= now) entries.delete(id);
    while (entries.size > this.limit) entries.delete(entries.keys().next().value as string);
    this.seen.set(sessionId, entries);
  }
}

const isBlobRef = (value: unknown): boolean => {
  const ref = value as BlobRef;
  return (
    !!ref &&
    typeof ref === "object" &&
    typeof ref.hash === "string" &&
    /^[0-9a-f]{64}$/.test(ref.hash) &&
    typeof ref.mimeType === "string" &&
    typeof ref.bytes === "number"
  );
};

/** Prompts (idempotent by `requestId`), cancellation and manual compaction. */
export function registerPromptRoutes(
  router: Router,
  ctx: { sessions: SessionService; scheduler: RunScheduler; recent?: RecentRequests },
): void {
  const { sessions, scheduler } = ctx;
  const recent = ctx.recent ?? new RecentRequests();

  router.post("/api/sessions/:sid/prompts", async ({ req, params, correlationId }) => {
    const session = sessions.get(params.sid ?? "");
    const input = validate<{
      requestId: string;
      text: string;
      attachments?: BlobRef[];
      display?: string;
    }>(await readJson(req), {
      requestId: { check: is.requestId(), required: true },
      text: { check: is.string(200_000), required: true },
      attachments: { check: is.array(isBlobRef, 16) },
      display: { check: is.string(1_000) },
    });
    if (session.parentId)
      throw new HttpError("session_busy", "Child sessions run under their parent session");
    const duplicate = (): { status: number; body: PromptAccepted } | undefined => {
      const run = sessions.runByRequest(session.id, input.requestId);
      if (run) return { status: 200, body: { runId: run.id, status: run.status, duplicate: true } };
      if (recent.has(session.id, input.requestId))
        return { status: 202, body: { status: "enqueued", duplicate: true } };
      return undefined;
    };
    const again = duplicate();
    if (again) return again;
    if (sessions.lockedBy(session.id))
      throw new HttpError(
        "session_locked",
        "Another Alisio process (for example the TUI) is using this session",
      );
    const opened = await sessions.app(session);
    // Everything below runs in one tick: idempotency checks and the insert cannot interleave.
    const retried = duplicate();
    if (retried) return retried;
    const job = scheduler.job(session.id);
    if (job || scheduler.busy(session.id) || opened.app.runner.isRunning(session.id)) {
      if (job?.status === "queued" || scheduler.compacting(session.id))
        throw new HttpError("session_busy", "The session is waiting for or compacting a run");
      if (input.attachments?.length)
        throw new HttpError(
          "session_busy",
          "The session is running; only text can be queued (retry attachments when idle)",
        );
      opened.app.runner.enqueue(session.id, input.text);
      recent.add(session.id, input.requestId);
      return { status: 202, body: { status: "enqueued" } satisfies PromptAccepted };
    }
    const attachments: Attachment[] = [];
    for (const ref of input.attachments ?? [])
      try {
        attachments.push(opened.app.blobs.attachment(ref));
      } catch {
        throw new HttpError("validation_failed", "Unknown or invalid attachment", {
          fields: ["attachments"],
        });
      }
    const { run, created } = sessions.beginRun({
      id: randomUUID(),
      session: session.id,
      status: "queued",
      requestId: input.requestId,
      correlationId,
      model: session.model,
    });
    if (!created)
      return {
        status: 200,
        body: { runId: run.id, status: run.status, duplicate: true } satisfies PromptAccepted,
      };
    const status = scheduler.submit({
      runId: run.id,
      sessionId: session.id,
      workspaceId: opened.id,
      app: opened.app,
      text: input.text,
      correlationId,
      ...(attachments.length ? { attachments } : {}),
      ...(input.display ? { display: input.display } : {}),
      options: () => sessions.runOptions(session.id),
    });
    return { status: 202, body: { runId: run.id, status } satisfies PromptAccepted };
  });

  router.post("/api/sessions/:sid/cancel", async ({ req, params }) => {
    const session = sessions.get(params.sid ?? "");
    const { runId } = validate<{ runId?: string }>(await readJson(req), {
      runId: { check: is.nonEmpty(100) },
    });
    if (scheduler.cancel(session.id, runId)) return { body: { cancelled: true } };
    const opened = sessions.openApp(session);
    const aborted = !runId && !!opened?.app.runner.abort(session.id);
    return { body: { cancelled: aborted } };
  });

  router.post("/api/sessions/:sid/compact", async ({ req, params }) => {
    const session = sessions.get(params.sid ?? "");
    const { focus } = validate<{ focus?: string }>(await readJson(req), {
      focus: { check: is.string(2_000) },
    });
    if (sessions.lockedBy(session.id))
      throw new HttpError("session_locked", "Another Alisio process is using this session");
    const opened = await sessions.app(session);
    if (scheduler.busy(session.id) || opened.app.runner.isRunning(session.id))
      throw new HttpError("session_busy", "The session is running");
    const controller = new AbortController();
    const work = opened.app.runner.compact(session.id, {
      ...(focus?.trim() ? { focus: focus.trim() } : {}),
      signal: controller.signal,
    });
    scheduler.track(session.id, opened.id, work, {
      abort: () => controller.abort(new Error("Cancelled")),
      onDone: () => sessions.notify(session.id),
    });
    sessions.notify(session.id);
    return { status: 202, body: { status: "started" } };
  });
}
