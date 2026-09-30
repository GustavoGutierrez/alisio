import type { SQLiteStore } from "@alisio/core";
import type { SessionContextUsage, SessionModels } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import type { Router } from "../http/router.ts";
import { storedToRunEvent } from "./sessions.ts";

/**
 * Per-session views the web composer and header need: the model catalog of the session's
 * provider (model + effort selector, RF-09), the context estimate (context ring) and the
 * session log download (RF-10).
 */
export function registerSessionViewRoutes(
  router: Router,
  ctx: { catalog: SQLiteStore; sessions: SessionService },
): void {
  const { catalog, sessions } = ctx;

  router.get("/api/sessions/:sid/models", async ({ params }) => {
    const session = sessions.get(params.sid ?? "");
    const { app } = await sessions.app(session);
    let models: SessionModels["models"] = [];
    let unavailable = false;
    try {
      models = await app.loadModels(AbortSignal.timeout(10_000));
    } catch {
      unavailable = true;
    }
    const effort = session.options?.effort;
    return {
      body: {
        provider: session.provider,
        model: session.model,
        ...(typeof effort === "string" ? { effort } : {}),
        models,
        unavailable,
      } satisfies SessionModels,
    };
  });

  router.get("/api/sessions/:sid/context", async ({ params }) => {
    const session = sessions.get(params.sid ?? "");
    const { app } = await sessions.app(session);
    const estimated = await app.runner.estimateContext(session.id);
    const budget = app.contextBudget(session.model);
    return {
      body: {
        estimated,
        ...(budget.total !== undefined ? { total: budget.total } : {}),
        basis: budget.basis,
        compactionAt: budget.compactionAt,
      } satisfies SessionContextUsage,
    };
  });

  // Session log: one `RunEvent` line per durable event (events.seq order, `alisio run --json`
  // format with the global `eventId`), then one `{"type":"message"}` line per stored message.
  router.get("/api/sessions/:sid/export", ({ params, res }) => {
    const session = sessions.get(params.sid ?? "");
    res.writeHead(200, {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Content-Disposition": `attachment; filename="alisio-${session.id}.jsonl"`,
    });
    let after = 0;
    for (;;) {
      const page = catalog.eventsPage(session.id, { after, limit: 5000 });
      for (const event of page.items)
        res.write(`${JSON.stringify(storedToRunEvent(session.id, event))}\n`);
      const last = page.items.at(-1);
      if (!page.hasMore || !last) break;
      after = Number(last.eventId);
    }
    let seq = -1;
    for (;;) {
      const page = catalog.messagesPage(session.id, { after: seq, limit: 1000, compacted: true });
      for (const item of page.items) res.write(`${JSON.stringify({ type: "message", ...item })}\n`);
      const last = page.items.at(-1);
      if (!page.hasMore || !last) break;
      seq = last.seq;
    }
    res.end();
    return undefined;
  });
}
