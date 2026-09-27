/**
 * Built-in subagents plugin. Everything delegation-specific lives here; the core only offers
 * generic child sessions, a tree panel, a select prompt and concurrent tools.
 */
import { isAbsolute, join, resolve } from "node:path";
import { definePlugin, type JsonSchema, type Plugin, textResult } from "@alisio/sdk";
import { type SubagentsConfig, subagentsConfigSchema } from "./config.ts";
import { type AgentDefinition, discoverAgents } from "./definitions.ts";
import * as gitOps from "./git.ts";
import { SubagentManager } from "./manager.ts";
import { loadVersion } from "./version.ts";

export type { AgentDefinition } from "./definitions.ts";
export { BUILTIN_AGENTS, discoverAgents, parseAgentDefinition } from "./definitions.ts";
export { SubagentManager } from "./manager.ts";

/** Plugin-state key under which the plugin publishes main-session-capable (mode primary/all) agents. */
export const MAIN_AGENTS_STATE_KEY = "mainAgents";

export interface SubagentsPluginContext {
  workspace: string;
  stateHome: string;
  configHome: string;
  configDir: string;
  home: string;
  trusted: boolean;
}
const schema = (properties: Record<string, JsonSchema>, required: string[]): JsonSchema => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
});
const str = { type: "string", minLength: 1 };

function describeAgents(agents: Map<string, AgentDefinition>): string {
  return [...agents.values()]
    .filter((a) => a.mode !== "primary" && !a.hidden)
    .map((a) => `- ${a.name}: ${a.description}${a.readOnly ? " (read-only)" : ""}`)
    .join("\n");
}

export function createSubagentsPlugin(
  rawOptions: unknown,
  context: SubagentsPluginContext,
): Plugin {
  const config: SubagentsConfig = subagentsConfigSchema.parse(rawOptions ?? {});
  if (config.worktreeDir && !isAbsolute(config.worktreeDir))
    config.worktreeDir = resolve(context.configDir, config.worktreeDir);
  let manager: SubagentManager | undefined;
  let warnings: string[] = [];
  return definePlugin({
    id: "subagents",
    name: "Subagents",
    description: "Delegation to specialized agents in isolated child sessions",
    version: loadVersion(import.meta.url),
    apiVersion: 1,
    async setup(api) {
      const found = await discoverAgents({
        workspace: context.workspace,
        home: context.home,
        configHome: context.configHome,
        trusted: context.trusted,
        cli: config.agents,
        plugins: api.resources.list("agents"),
      });
      warnings = found.warnings;
      // Publish the main-session-capable definitions (mode `primary`/`all`) for the TUI's `/agents`
      // picker. The host reads them through `pluginState`, so the TUI never imports this package.
      // Only the fields the ACTIVE agent needs are persisted; prompts stay bounded.
      api.state.set(
        MAIN_AGENTS_STATE_KEY,
        [...found.agents.values()]
          .filter((a) => a.mode !== "subagent" && !a.hidden)
          .map((a) => ({
            name: a.name,
            description: a.description,
            prompt: a.prompt.slice(0, 24_000),
            ...(a.model ? { model: a.model } : {}),
            ...(a.readOnly ? { readOnly: true } : {}),
            source: a.source,
            ...(a.path ? { path: a.path } : {}),
          })),
      );
      const m = new SubagentManager(api, config, context, found.agents);
      manager = m;
      const status = () => {
        const all = [...m.tasks.values()];
        const running = all.filter((t) => t.status === "running").length;
        const queued = all.filter((t) => t.status === "queued").length;
        api.ui.status(
          "agents",
          running || queued ? `agents ${running}▶${queued ? ` ${queued}⧗` : ""}` : undefined,
          `${all.length} subagent task(s) this process · ${running} running · ${queued} queued · ${found.agents.size} definitions`,
        );
      };
      m.refresh = status;
      api.events.on((event) => {
        m.observe(event);
      });
      api.tools.register({
        name: "task",
        effect: "internal",
        concurrent: true,
        description: `Delegate a task to a specialized subagent that works in a separate conversation (it does not see this conversation) and returns only its final report. Launch several in one turn to work in parallel. Use model to select a configured provider/model for only the child. Use background=true for long work: you will get a <task-notification> when it finishes (do not poll). Pass task_id to continue an earlier task with its full history.\nAvailable subagent_type values:\n${describeAgents(found.agents)}`,
        inputSchema: schema(
          {
            description: { type: "string", minLength: 1, maxLength: 120 },
            prompt: { type: "string", minLength: 1, maxLength: 100_000 },
            subagent_type: str,
            task_id: str,
            background: { type: "boolean" },
            model: { type: "string", minLength: 1 },
          },
          ["description", "prompt", "subagent_type"],
        ),
        async execute(input, ctx) {
          if (!ctx.session) return textResult("task requires a session", true);
          try {
            const result = await m.startTask({
              caller: ctx.session,
              agentName: String(input.subagent_type),
              title: String(input.description),
              prompt: String(input.prompt),
              ...(typeof input.task_id === "string" ? { taskId: input.task_id } : {}),
              ...(typeof input.background === "boolean" ? { background: input.background } : {}),
              ...(typeof input.model === "string" ? { model: input.model } : {}),
              signal: ctx.signal,
            });
            return textResult(result.text, result.isError);
          } catch (error) {
            return textResult(
              `<task state="failed">Error: ${error instanceof Error ? error.message : String(error)}</task>`,
              true,
            );
          }
        },
      });
      api.tools.register({
        name: "task_status",
        effect: "internal",
        concurrent: true,
        description: "Status of one of your subagent tasks (does not wait).",
        inputSchema: schema({ task_id: str }, ["task_id"]),
        async execute(input, ctx) {
          try {
            const task = m.assertDescendant(ctx.session ?? "", String(input.task_id));
            const info = api.sessions.get(task.id);
            return textResult(
              JSON.stringify({
                task_id: task.id,
                agent: task.agent.name,
                status: info?.status ?? task.status,
                background: task.background,
                tokens: task.tokens,
              }),
            );
          } catch (error) {
            return textResult(String(error instanceof Error ? error.message : error), true);
          }
        },
      });
      api.tools.register({
        name: "task_wait",
        effect: "internal",
        concurrent: true,
        description: `Wait (bounded, at most ${config.waitMaxMs}ms) for one of your subagent tasks and return its result, or its status on timeout.`,
        inputSchema: schema(
          { task_id: str, timeout_ms: { type: "integer", minimum: 0, maximum: config.waitMaxMs } },
          ["task_id"],
        ),
        async execute(input, ctx) {
          try {
            const r = await m.wait(
              ctx.session ?? "",
              String(input.task_id),
              Number(input.timeout_ms ?? 60_000),
            );
            return textResult(r.text, r.isError);
          } catch (error) {
            return textResult(String(error instanceof Error ? error.message : error), true);
          }
        },
      });
      api.tools.register({
        name: "send_message",
        effect: "internal",
        concurrent: true,
        description:
          "One-way message to one of your subagent tasks: queued for its next turn while it runs, or resumes it (in the background) when finished.",
        inputSchema: schema(
          { task_id: str, text: { type: "string", minLength: 1, maxLength: 50_000 } },
          ["task_id", "text"],
        ),
        async execute(input, ctx) {
          try {
            return textResult(
              m.sendMessage(ctx.session ?? "", String(input.task_id), String(input.text)),
            );
          } catch (error) {
            return textResult(String(error instanceof Error ? error.message : error), true);
          }
        },
      });
      api.ui.panel("agents", {
        title: "Agents",
        nodes: ({ sessionId }) => m.nodes(sessionId),
        action: (action, nodeId, { sessionId }) => {
          if (action === "cancel" && nodeId) m.cancel(nodeId);
          if (action === "background") m.backgroundAll(sessionId);
        },
      });
      const worktreeTask = (id: string) => {
        const task = m.tasks.get(id);
        if (!task?.worktree) throw new Error(`Task ${id} has no worktree in this process.`);
        return { task, wt: task.worktree };
      };
      api.commands.register(
        "agents",
        async (args, commandContext) => {
          const [verb = "", target = "", ...rest] = args.trim().split(/\s+/);
          const root = commandContext?.sessionId ?? "";
          const resolveId = (prefix: string) => {
            const matches = [...m.tasks.keys()].filter((k) => k.startsWith(prefix));
            if (matches.length !== 1)
              throw new Error(matches.length ? `Ambiguous id ${prefix}` : `Unknown task ${prefix}`);
            return matches[0] as string;
          };
          try {
            switch (verb) {
              case "":
              case "list": {
                const nodes = root ? m.nodes(root) : [];
                if (!nodes.length) return "No subagent tasks in this session.";
                const depth = (id: string | undefined): number =>
                  id ? 1 + depth(nodes.find((n) => n.id === id)?.parentId) : 0;
                return [
                  "**Subagents**",
                  "",
                  ...nodes.map(
                    (n) =>
                      `${"  ".repeat(depth(n.parentId))}- \`${n.id.slice(0, 8)}\` **${n.label}** ${n.status} · ${n.tokens ?? 0} tok · ${n.detail ?? ""}`,
                  ),
                  "",
                  "`/agents open|cancel|kill|resume <id>` · `/agents merge|discard <id>` (worktrees) · `/agents defs`",
                ].join("\n");
              }
              case "defs":
                return [
                  "**Agent definitions**",
                  "",
                  ...[...m.agents.values()].map(
                    (a) =>
                      `- \`${a.name}\` (${a.source}${a.path ? `: ${a.path}` : ""})${a.readOnly ? " read-only" : ""} — ${a.description}`,
                  ),
                  ...(warnings.length
                    ? ["", "**Warnings**", "", ...warnings.map((w) => `- ${w}`)]
                    : []),
                ].join("\n");
              case "open": {
                const id = resolveId(target);
                return api.ui.open(id)
                  ? `Opened ${id}.`
                  : "Opening a session view needs the interactive terminal.";
              }
              case "cancel":
              case "kill": {
                const id = resolveId(target);
                const n = m.cancel(id);
                return `Cancelled ${id} (${n} running session${n === 1 ? "" : "s"} stopped; tool processes get SIGTERM, then SIGKILL after the grace period).`;
              }
              case "resume": {
                const id = resolveId(target);
                const task = m.tasks.get(id);
                if (!task) throw new Error(`Unknown task ${id}`);
                return m.sendMessage(
                  task.parentSession,
                  id,
                  rest.join(" ") || "Continue where you left off.",
                );
              }
              case "merge": {
                const { task, wt } = worktreeTask(resolveId(target));
                const result = await gitOps.merge(
                  wt.root,
                  wt.branch,
                  `Merge ${wt.branch} (alisio task: ${task.title})`,
                );
                if (!result.ok)
                  return `Merge of ${wt.branch} did not complete: ${result.message}${result.conflicts.length ? `\nConflicting files: ${result.conflicts.join(", ")}` : ""}\nThe repository was left unchanged (merge aborted). Resolve manually with: git merge ${wt.branch}`;
                await gitOps.removeWorktree(wt.root, wt.path, wt.branch, true);
                task.worktree = undefined;
                return `Merged ${wt.branch} into the current branch with --no-ff and removed its worktree.`;
              }
              case "discard": {
                const { task, wt } = worktreeTask(resolveId(target));
                await gitOps.removeWorktree(wt.root, wt.path, wt.branch, true);
                task.worktree = undefined;
                return `Discarded ${wt.branch} and removed its worktree.`;
              }
              default:
                return "Usage: /agents [list|defs|open|cancel|kill|resume|merge|discard] [id]";
            }
          } catch (error) {
            return `Error: ${error instanceof Error ? error.message : String(error)}`;
          }
        },
        {
          description: "List and manage subagents (open, cancel, resume, merge, discard, defs)",
          argumentHint: "[open|cancel|kill|resume|merge|discard|defs] [id]",
        },
      );
      status();
    },
    dispose() {
      if (manager)
        for (const task of manager.tasks.values())
          if (task.status === "running") manager.cancel(task.id);
      manager = undefined;
    },
  });
}
export const subagentsWorktreeDir = (stateHome: string) => join(stateHome, "worktrees");
