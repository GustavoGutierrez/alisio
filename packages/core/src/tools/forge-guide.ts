/**
 * `forge_guide` (spec §8.3, D12): on-demand guidance for `js_run` and `python_run`, generated from
 * the live state of the engines. A read-only tool that never executes anything: it asks the
 * `GuideProvider` for one topic. It is registered only when a language has a ready engine, and its
 * `topic` enum lists only the topics that exist (the `python.*` ones need `python_run`).
 * `js.tools` lists the tools the CURRENT call could reach from a script, taken from the run's own
 * nested-call dispatcher, so it already respects the permission mode.
 */
import type { ToolContext, ToolDefinition, ToolResult } from "@alisio/sdk";
import { callInternals } from "../core/call-internals.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { type GuideProvider, UnknownGuideTopicError } from "../forge/guides/provider.ts";
import { effectOf } from "../permissions/decide.ts";

/** Hard bound of the description (spec §8.2 budget). */
export const FORGE_GUIDE_DESCRIPTION_MAX_CHARS = 300;

export function forgeGuideDescription(topics: readonly string[]): string {
  const js = topics.some((topic) => topic.startsWith("js."));
  const py = topics.some((topic) => topic.startsWith("python."));
  const about = [js ? "js_run" : "", py ? "python_run" : ""].filter(Boolean).join(" and ");
  return (
    `Live guidance for ${about}: limits, tools, backends, packages. Call it before writing ` +
    "non-trivial code. Send ifNoneMatch=etag to skip unchanged content."
  );
}

const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

export function registerForgeGuide(registry: ToolRegistry, provider: GuideProvider): void {
  const topics = provider.topics();
  if (topics.length === 0) return;
  const tool: ToolDefinition = {
    name: "forge_guide",
    effect: "read",
    concurrent: true,
    description: forgeGuideDescription(topics),
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["topic"],
      properties: {
        topic: { type: "string", enum: [...topics] },
        ifNoneMatch: { type: "string", maxLength: 64 },
      },
    },
    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const topic = String(input.topic);
      const catalog =
        topic === "js.tools"
          ? callInternals(context)
              ?.nested()
              .catalog()
              .map((candidate) => ({ name: candidate.name, effect: effectOf(candidate) }))
          : undefined;
      try {
        const answer = await provider.get({
          topic,
          ...(typeof input.ifNoneMatch === "string" ? { ifNoneMatch: input.ifNoneMatch } : {}),
          catalog,
        });
        if (answer.unchanged) return { content: [{ type: "text", text: JSON.stringify(answer) }] };
        return {
          content: [{ type: "text", text: `etag: ${answer.etag}\n\n${answer.content}` }],
        };
      } catch (error) {
        if (error instanceof UnknownGuideTopicError) return fail(error.message);
        throw error;
      }
    },
  };
  registry.register(tool);
}
