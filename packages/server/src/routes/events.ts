import type { SessionService } from "../host/sessions.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import type { SseHub } from "../sse/hub.ts";

/**
 * `GET /api/events?session=<sid>&session=…`: one multiplexed SSE stream per tab. Every
 * (re)connection gets a full snapshot per session (v1 ignores `Last-Event-ID` beyond that:
 * the snapshot cursor tells the client which durable events it already has).
 */
export function registerEventRoutes(
  router: Router,
  ctx: {
    hub: SseHub;
    sessions: SessionService;
    maxStreams?: number;
    maxSessionsPerStream?: number;
  },
): void {
  const maxStreams = ctx.maxStreams ?? 16;
  const maxSessions = ctx.maxSessionsPerStream ?? 8;
  router.get("/api/events", ({ req, res, url }) => {
    const ids = [...new Set(url.searchParams.getAll("session").filter(Boolean))];
    if (ids.length > maxSessions)
      throw new HttpError("validation_failed", `At most ${maxSessions} sessions per stream`, {
        fields: ["session"],
      });
    for (const id of ids) ctx.sessions.get(id);
    if (ctx.hub.size >= maxStreams)
      throw new HttpError("stream_limit", `At most ${maxStreams} event streams at once`);
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();
    req.socket.setNoDelay(true);
    const detach = ctx.hub.attach(res, ids);
    res.on("close", detach);
    return undefined;
  });
}
