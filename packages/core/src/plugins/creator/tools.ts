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
import type { PluginCreatorProjects } from "./projects.ts";
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
      "environment, time limit, no install). action 'build': validate + test + load check + " +
      "package (.tgz) so the person can install it. Not a sandbox: the code runs with the user's " +
      "privileges.",
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
          return textResult(
            JSON.stringify({
              ok: build.ok,
              ...(build.error ? { error: build.error } : {}),
              issues: build.issues,
              stats: build.stats,
              ...(build.tests && !build.tests.ok ? { testOutput: build.tests.output } : {}),
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
