/**
 * `bg_run`, `bg_list`, `bg_output` and `bg_stop`: shell commands that keep running while the agent
 * works. All four declare `effect: "process"`, so they pass through the SAME gates as `shell` and
 * `run_process`: `--read-only` and the plan agent (no process effect) cannot start a task, and
 * also cannot read the output of one or stop one; the permission modes and approvals apply as for
 * any command. A task is not sandboxed and ends when Alisio exits.
 *
 * A task belongs to the root session of the session that started it; every call can only see the
 * tasks of its own session tree ("not found" otherwise).
 */
import { stat } from "node:fs/promises";
import { type BackgroundTaskInfo, type BackgroundTaskStatus, textResult } from "@alisio/sdk";
import { DEFAULT_READ_BYTES, MAX_READ_BYTES } from "../background/output.ts";
import type { BackgroundTasks } from "../background/service.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { safePath } from "../runtime/paths.ts";
import { objectSchema } from "./standard.ts";

export const BACKGROUND_TOOLS = ["bg_run", "bg_list", "bg_output", "bg_stop"] as const;
const STATUSES: BackgroundTaskStatus[] = [
  "queued",
  "running",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "lost",
];

/** The model-facing view of a task (snake_case, no paths). */
function brief(task: BackgroundTaskInfo): Record<string, unknown> {
  return {
    id: task.id,
    label: task.label,
    status: task.status,
    ...(task.exitCode !== undefined ? { exit_code: task.exitCode } : {}),
    ...(task.errorCode ? { error: task.errorCode } : {}),
    ...(task.abortOrigin ? { stopped_by: task.abortOrigin } : {}),
    output_bytes: task.bytes,
    ...(task.truncated ? { output_truncated: true } : {}),
    ...(task.cwd ? { cwd: task.cwd } : {}),
    created_at: new Date(task.createdAt).toISOString(),
    ...(task.endedAt ? { ended_at: new Date(task.endedAt).toISOString() } : {}),
  };
}

export function registerBackgroundTools(
  registry: ToolRegistry,
  deps: { tasks: BackgroundTasks; rootOf: (session: string) => string },
): void {
  const { tasks } = deps;
  const rootOf = (session: string | undefined): string => {
    if (!session) throw new Error("Background tasks need a session");
    return deps.rootOf(session);
  };
  registry.register({
    name: "bg_run",
    effect: "process",
    description:
      "Start a shell command in the background and return its task id at once; the agent keeps " +
      "working. Use it for long-running commands (servers, watchers, long builds or test suites). " +
      "Not sandboxed: the command runs with your permissions and ends when Alisio exits. The " +
      "output is stored in a log you read with bg_output. When the task finishes on its own you " +
      "get ONE notification message (no polling needed). `timeoutMs` is capped by the " +
      "tasks.maxRunMs setting (default 1 hour); a task that exceeds it is stopped and fails.",
    inputSchema: objectSchema(
      {
        command: { type: "string", minLength: 1, maxLength: 8000 },
        cwd: { type: "string", description: "Working directory, relative to the workspace." },
        label: { type: "string", maxLength: 80, description: "Short name shown in task lists." },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 86_400_000 },
      },
      ["command"],
    ),
    paths: (input) => (typeof input.cwd === "string" && input.cwd ? [input.cwd] : []),
    async execute(input, context) {
      const session = context.session;
      rootOf(session);
      const cwd =
        typeof input.cwd === "string" && input.cwd
          ? context.resolvePath
            ? await context.resolvePath(input.cwd)
            : await safePath(context.workspace, input.cwd)
          : context.workspace;
      let isDirectory = false;
      try {
        isDirectory = (await stat(cwd)).isDirectory();
      } catch {
        /* reported below */
      }
      if (!isDirectory) throw new Error(`The working directory does not exist: ${input.cwd}`);
      const task = tasks.start({
        session: session as string,
        workspace: context.workspace,
        command: String(input.command),
        cwd,
        ...(typeof input.label === "string" ? { label: input.label } : {}),
        ...(typeof input.timeoutMs === "number" ? { timeoutMs: input.timeoutMs } : {}),
      });
      return textResult(
        JSON.stringify({
          ...brief(task),
          timeout_ms: task.timeoutMs,
          note: tasks.notifies
            ? "Started in the background. You will get one notification when it finishes; use bg_output to read its output and bg_stop to stop it."
            : "Started in the background. Nothing notifies you here: use bg_output to read its output and bg_list to check its status. It ends when this Alisio process ends.",
        }),
      );
    },
  });
  registry.register({
    name: "bg_list",
    effect: "process",
    description: "List the background tasks of this session, newest first.",
    inputSchema: objectSchema({
      status: { enum: STATUSES },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }),
    async execute(input, context) {
      const root = rootOf(context.session);
      const listed = tasks.list(root, {
        ...(typeof input.status === "string"
          ? { status: [input.status as BackgroundTaskStatus] }
          : {}),
        limit: typeof input.limit === "number" ? input.limit : 20,
      });
      // Listing a finished task tells the agent it ended: it will not be announced as well.
      tasks.markSeen(
        listed
          .filter(
            (task) =>
              task.status !== "running" && task.status !== "queued" && task.status !== "stopping",
          )
          .map((task) => task.id),
      );
      return textResult(JSON.stringify({ tasks: listed.map(brief) }));
    },
  });
  registry.register({
    name: "bg_output",
    effect: "process",
    description:
      "Read the output of a background task incrementally. Pass `offset` 0 (or omit it) the first " +
      "time, then the `next_offset` of the previous call. `eof` is true only when the task has " +
      "ended and everything was read. At most 64 KiB per call (16 KiB by default); the log keeps " +
      "the first tasks.maxOutputBytes bytes and the last 32 KiB.",
    inputSchema: objectSchema(
      {
        id: { type: "string", minLength: 1 },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: MAX_READ_BYTES },
      },
      ["id"],
    ),
    async execute(input, context) {
      const root = rootOf(context.session);
      const out = await tasks.read(root, String(input.id), {
        offset: typeof input.offset === "number" ? input.offset : 0,
        limit: typeof input.limit === "number" ? input.limit : DEFAULT_READ_BYTES,
        reader: "model",
      });
      return textResult(
        JSON.stringify({
          id: String(input.id),
          status: out.status,
          ...(out.exitCode !== undefined ? { exit_code: out.exitCode } : {}),
          text: out.text,
          next_offset: out.nextOffset,
          eof: out.eof,
          ...(out.truncated ? { output_truncated: true } : {}),
        }),
      );
    },
  });
  registry.register({
    name: "bg_stop",
    effect: "process",
    description:
      "Stop a background task (SIGTERM to its process group, SIGKILL after 3 seconds; " +
      "taskkill /T on Windows). A stopped task ends `cancelled`, never `failed`. Stopping a task " +
      "that already ended returns its final state.",
    inputSchema: objectSchema({ id: { type: "string", minLength: 1 } }, ["id"]),
    async execute(input, context) {
      const root = rootOf(context.session);
      const task = await tasks.stop(root, String(input.id), "model");
      return textResult(JSON.stringify(brief(task)));
    },
  });
}
