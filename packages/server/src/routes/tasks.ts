/**
 * Background tasks of a root session (`bg_run`): the list (with a read-only mirror of the
 * subagents), the incremental output of one task and the user's stop. The same auth, Host and
 * Origin rules as every other `/api` route apply. A task is addressed through the session that
 * owns it: another session's tasks (even in the same workspace) are `task_not_found`.
 *
 * Changes also travel as `tasks_changed` frames (see `index.ts`); the output is pulled with
 * `offset` (the client keeps its own offset, like the model does with `bg_output`).
 */
import {
  DEFAULT_READ_BYTES,
  MAX_READ_BYTES,
  TaskForeignError,
  TaskNotFoundError,
} from "@alisio/core";
import type { BackgroundTaskInfo, BackgroundTaskOutput } from "@alisio/sdk";
import type { SessionService } from "../host/sessions.ts";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";
import { queryInt } from "../schemas.ts";

export function registerTaskRoutes(router: Router, ctx: { sessions: SessionService }): void {
  const { sessions } = ctx;
  /** The root session of the path's session and the tasks service of its workspace. */
  const open = async (sid: string | undefined) => {
    const session = sessions.get(sid ?? "");
    const { app } = await sessions.app(session);
    return { app, root: sessions.rootOf(session.id) };
  };
  const mapped = <T>(work: () => T): T => {
    try {
      return work();
    } catch (error) {
      throw translate(error);
    }
  };
  const translate = (error: unknown): unknown => {
    if (error instanceof TaskNotFoundError) return new HttpError("task_not_found", error.message);
    if (error instanceof TaskForeignError) return new HttpError("session_locked", error.message);
    return error;
  };

  router.get("/api/sessions/:sid/tasks", async ({ params }) => {
    const { app, root } = await open(params.sid);
    return {
      body: { tasks: app.tasks.list(root, { limit: 200, mirror: true }) } satisfies {
        tasks: BackgroundTaskInfo[];
      },
    };
  });

  router.get("/api/sessions/:sid/tasks/:tid/output", async ({ params, url }) => {
    const { app, root } = await open(params.sid);
    const offset = queryInt(url, "offset", 0) ?? 0;
    const limit = queryInt(url, "limit", DEFAULT_READ_BYTES, MAX_READ_BYTES) ?? DEFAULT_READ_BYTES;
    try {
      const output = await app.tasks.read(root, params.tid ?? "", {
        offset,
        limit: Math.max(1, limit),
        reader: "user",
      });
      return { body: output satisfies BackgroundTaskOutput };
    } catch (error) {
      throw translate(error);
    }
  });

  router.post("/api/sessions/:sid/tasks/:tid/stop", async ({ params }) => {
    const { app, root } = await open(params.sid);
    // Validate ownership first so a stranger's id answers 404 without any side effect.
    mapped(() => app.tasks.get(root, params.tid ?? ""));
    try {
      const task = await app.tasks.stop(root, params.tid ?? "", "user");
      return { body: { task } };
    } catch (error) {
      throw translate(error);
    }
  });
}
