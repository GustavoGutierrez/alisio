/**
 * The creator session's two narrow tools, registered only in a creator project's workspace:
 *
 * - `plugin_project` (`internal`): validate (static), stats and progress steps. It reads the
 *   project and writes only Alisio's own metadata record, never the workspace or the network.
 * - `plugin_project_run` (`process`): runs the project's tests or the full build. It executes the
 *   plugin's code with the user's privileges, so it goes through the normal process approval.
 *
 * A dedicated tool instead of the shell keeps the command fixed (`node --test` with a scrubbed
 * environment and a time limit, no npm, no install) so the model cannot widen what runs.
 */
import { textResult } from "@alisio/sdk";
import type { ToolRegistry } from "../../core/registry.ts";
import { MAX_BUILD_ATTEMPTS, type PluginCreatorProjects } from "./projects.ts";
import { PLUGIN_CREATOR_STEPS, PluginCreatorError } from "./types.ts";

const STATUSES = ["running", "done", "failed"] as const;

const errorResult = (error: unknown) =>
  textResult(
    JSON.stringify({
      ok: false,
      error: {
        code: error instanceof PluginCreatorError ? error.code : "internal",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
    true,
  );

export function registerPluginProjectTools(
  registry: ToolRegistry,
  deps: { projects: PluginCreatorProjects; projectId: string },
): void {
  const { projects, projectId } = deps;
  registry.register({
    name: "plugin_project",
    effect: "internal",
    description:
      "Plugin creator project helper. action 'validate': static checks of this plugin project " +
      "(manifest, imports, size, tests present) with stable issue codes. action 'stats': files, " +
      "size, version, last build and detected tables. action 'progress': report a step to the " +
      `person (step: ${PLUGIN_CREATOR_STEPS.join(", ")}; status: ${STATUSES.join(", ")}; note: ` +
      "one short plain sentence).",
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["validate", "stats", "progress"] },
        step: { type: "string", enum: [...PLUGIN_CREATOR_STEPS] },
        status: { type: "string", enum: [...STATUSES] },
        note: { type: "string", maxLength: 200 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input) {
      try {
        if (input.action === "validate") {
          const result = await projects.validate(projectId);
          return textResult(
            JSON.stringify({
              ok: result.ok,
              issues: result.issues,
              tests: result.tests,
              tables: result.schema.tables.map((t) => t.name),
            }),
          );
        }
        if (input.action === "stats") {
          const project = await projects.get(projectId);
          const files = await projects.listFiles(projectId);
          return textResult(
            JSON.stringify({
              packageName: project.packageName,
              pluginId: project.pluginId,
              version: project.version,
              files: files.count,
              bytes: files.bytes,
              lastBuild: project.lastBuild ?? null,
              tables: project.schema?.tables.map((t) => t.name) ?? [],
            }),
          );
        }
        if (input.action === "progress") {
          const step = input.step as (typeof PLUGIN_CREATOR_STEPS)[number];
          const status = input.status as (typeof STATUSES)[number];
          if (!PLUGIN_CREATOR_STEPS.includes(step) || !STATUSES.includes(status))
            return textResult(
              `progress needs step (${PLUGIN_CREATOR_STEPS.join(", ")}) and status (${STATUSES.join(", ")})`,
              true,
            );
          await projects.recordProgress(
            projectId,
            step,
            status,
            typeof input.note === "string" ? input.note : undefined,
          );
          return textResult(JSON.stringify({ ok: true, step, status }));
        }
        return textResult("action must be validate, stats or progress", true);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
  registry.register({
    name: "plugin_project_run",
    effect: "process",
    description:
      "Runs this plugin project's code. action 'test': node --test on test/*.test.js (scrubbed " +
      "environment, time limit, no install). action 'build': every delivery gate (validation, " +
      "syntax, tests, packaging, then Alisio's real host on an installed copy: activation, strict " +
      "tool schemas, one smoke call per tool, dispose and reactivation, a test per tool) and the " +
      "package (.tgz). A failed build lists the issues to fix. Not a sandbox: the code runs with " +
      "the user's privileges.",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: ["test", "build"] } },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, context) {
      try {
        if (input.action === "test") {
          const run = await projects.runTests(projectId, { signal: context.signal });
          return textResult(JSON.stringify(run), !run.ok);
        }
        if (input.action === "build") {
          const build = await projects.build(projectId, { signal: context.signal });
          const attempt = build.ok ? 0 : ((await projects.get(projectId)).failedBuilds ?? 1);
          return textResult(
            JSON.stringify({
              ok: build.ok,
              ...(build.error ? { error: build.error } : {}),
              issues: build.issues,
              stats: build.stats,
              ...(build.tests && !build.tests.ok ? { testOutput: build.tests.output } : {}),
              ...(build.ok
                ? { next: "Every check passed: report the package step as done." }
                : {
                    attempt,
                    maxAttempts: MAX_BUILD_ATTEMPTS,
                    next: build.issues.some((issue) => issue.code === "gate_unavailable")
                      ? "Stop: this Alisio cannot run its plugin checks, which is not a problem of the plugin. Do not change the plugin; tell the person to update or reinstall Alisio."
                      : attempt >= MAX_BUILD_ATTEMPTS
                        ? "Stop now: do not build again. Tell the person in one plain sentence that the plugin could not be finished and that they can press Try again."
                        : "The plugin is NOT ready: fix every error issue, run the tests and build again. Never say it is ready while a build fails.",
                  }),
            }),
            !build.ok,
          );
        }
        return textResult("action must be test or build", true);
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
