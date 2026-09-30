/**
 * One catalog of slash commands for every surface (TUI, web, API): built-ins, plugin commands,
 * prompt templates and skills, with the pure core handlers of `execution: "core"` commands.
 * The catalog reads its sources live from the host on each call, so plugin/template/skill
 * changes show up without rebuilding it.
 */
import type { CommandDescriptor, ToolDefinition } from "@alisio/sdk";
import { agentCatalogFromState, resolveActiveAgent } from "../agents/active.ts";
import type { PluginCatalogEntry } from "../application.ts";
import type { SessionStore } from "../core/contracts.ts";
import type { AgentRunner } from "../core/runner.ts";
import type { McpServerInfo } from "../mcp/connector.ts";
import type { PromptTemplate } from "../resources/prompts.ts";
import type { SkillCatalogEntry } from "../resources/skills.ts";
import {
  formatSideQuestion,
  SIDE_QUESTION_DESCRIPTION,
  SIDE_QUESTION_USAGE,
  type SideQuestions,
} from "../sessions/side-questions.ts";
import { BUILTIN_COMMANDS, type BuiltinCommand } from "./builtins.ts";

export { BUILTIN_COMMANDS, type BuiltinCommand };
export type CommandSurface = CommandDescriptor["surfaces"][number];
type PluginCommandHandler = (args: string, context?: { sessionId?: string }) => Promise<string>;
/**
 * What the catalog needs from an application. `createApplication()`'s result satisfies it; the
 * optional members only enable the matching sources and handlers.
 */
export interface CommandHost {
  workspace: string;
  store: SessionStore;
  runner: Pick<AgentRunner, "policy" | "approvals" | "compact" | "setModel">;
  registry: { list(): ToolDefinition[] };
  provider: { id: string };
  plugins?: {
    commands: ReadonlyMap<string, PluginCommandHandler>;
    commandInfo: ReadonlyMap<
      string,
      { plugin: string; description?: string; argumentHint?: string }
    >;
    pluginState?(plugin: string, key: string): unknown;
  };
  prompts?: { templates: ReadonlyMap<string, PromptTemplate> };
  skillCatalog?(): SkillCatalogEntry[];
  pluginCatalog?(): PluginCatalogEntry[];
  mcp?: { list(): McpServerInfo[] };
  config?: { agents: { active?: string; effort?: string } };
  updateSetting?(key: "agents.effort", value: unknown): Promise<string>;
  /** `/btw` side questions (tool-less, outside the conversation). */
  sideQuestions?: Pick<SideQuestions, "ask" | "history">;
}
export interface CommandExecutionContext {
  sessionId: string;
  signal?: AbortSignal;
}
export interface CommandResult {
  /** Markdown for the user. */
  text?: string;
  /** `notice` is a short status line; `info` (default) a report. */
  tone?: "info" | "notice";
  /** The session the surface should switch to (`clear`/`new`, `resume`). */
  sessionId?: string;
  /** Structured result for programmatic callers (e.g. a `CompactionResult`). */
  data?: unknown;
}
type Handler = (
  args: string,
  ctx: CommandExecutionContext,
  host: CommandHost,
) => Promise<CommandResult>;

const builtinDescriptor = (c: BuiltinCommand): CommandDescriptor => ({
  name: c.name,
  description: c.description,
  ...(c.aliases ? { aliases: [...c.aliases] } : {}),
  ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
  source: "builtin",
  surfaces: [...c.surfaces],
  execution: c.execution,
});
const ALL: CommandDescriptor["surfaces"] = ["tui", "web", "api"];

/** Root sessions of this workspace bound to the current provider, newest first (as the TUI). */
const workspaceSessions = (host: CommandHost) =>
  host.store
    .list()
    .filter((s) => s.workspace === host.workspace && s.provider === host.provider.id);
const firstPrompt = (host: CommandHost, id: string) => {
  const first = host.store.messages(id).find((m) => m.role === "user" && !m.summary);
  return first?.role === "user" ? first.text.replace(/\s+/g, " ").slice(0, 60) : "";
};

const HANDLERS: Record<string, Handler> = {
  async tools(_args, _ctx, host) {
    const policy = host.runner.policy;
    const rows = host.registry
      .list()
      .map((t) => {
        const effect = t.effect ?? "external";
        const state =
          effect === "read" || effect === "internal" || policy[effect]
            ? "enabled"
            : host.runner.approvals && (effect === "write" || effect === "process")
              ? "ask"
              : "disabled";
        return `| \`${t.name}\` | ${effect} | ${state} |`;
      })
      .join("\n");
    return {
      text: `**Tools**\n\n| Tool | Effect | State |\n| --- | --- | --- |\n${rows}\n\n\`ask\` prompts before running (allow once / session / deny). Use --allow-write / --allow-process to pre-allow; --read-only disables them. Paths outside the workspace ask per directory; pre-allow with --add-dir or the \`additionalDirectories\` config key. \`internal\` tools (built-in plugins) only write Alisio's own state.`,
    };
  },
  async sessions(_args, ctx, host) {
    const list = workspaceSessions(host).slice(0, 20);
    if (!list.length) return { text: "No sessions in this workspace", tone: "notice" };
    return {
      text: [
        "**Recent sessions** (use `/resume <id-prefix>`)",
        "",
        ...list.map(
          (s) =>
            `- \`${s.id}\` ${s.id === ctx.sessionId ? "**(current)** " : ""}${s.model} · ${host.store.messages(s.id).length} msgs · ${firstPrompt(host, s.id) || "_empty_"}`,
        ),
      ].join("\n"),
      data: list,
    };
  },
  async resume(args, _ctx, host) {
    const target = args.trim();
    if (!target) throw new Error("Usage: /resume <id>");
    const matches = workspaceSessions(host).filter((s) => s.id.startsWith(target));
    if (matches.length !== 1)
      throw new Error(
        matches.length
          ? `Ambiguous session prefix: ${target}`
          : `No session in this workspace matches ${target}`,
      );
    const found = matches[0] as (typeof matches)[number];
    return { text: `Resumed session ${found.id}`, tone: "notice", sessionId: found.id };
  },
  async clear(_args, ctx, host) {
    const model = host.store.get(ctx.sessionId).model;
    const created = host.store.create(host.workspace, host.provider.id, model);
    return { text: `New session ${created.id}`, tone: "notice", sessionId: created.id };
  },
  async compact(args, ctx, host) {
    const result = await host.runner.compact(ctx.sessionId, {
      ...(args.trim() ? { focus: args.trim() } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return result
      ? {
          text: `Compacted ${result.replaced} messages: ~${result.before} → ~${result.after} tokens`,
          tone: "notice",
          data: result,
        }
      : { text: "Not enough history to compact", tone: "notice" };
  },
  async model(args, ctx, host) {
    const model = args.trim();
    if (!model) throw new Error("Usage: /model <model id>");
    host.runner.setModel(ctx.sessionId, model);
    return { text: `Model set to \`${model}\``, tone: "notice", data: { model } };
  },
  async effort(args, _ctx, host) {
    const level = args.trim();
    if (!level)
      return {
        text: `Reasoning effort: ${host.config?.agents.effort ?? "model default"}`,
        tone: "notice",
      };
    if (!host.updateSetting) throw new Error("Effort changes are unavailable here");
    const value = level === "!clear" ? undefined : level;
    await host.updateSetting("agents.effort", value);
    return {
      text: value ? `Reasoning effort set to ${value}` : "Reasoning effort cleared",
      tone: "notice",
      data: { effort: value },
    };
  },
  async stats(_args, ctx, host) {
    const session = host.store.get(ctx.sessionId);
    const runs = host.store.runs?.(ctx.sessionId) ?? [];
    const tokens = runs.reduce(
      (sum, r) => ({
        input: sum.input + (r.usage?.input ?? 0),
        output: sum.output + (r.usage?.output ?? 0),
      }),
      { input: 0, output: 0 },
    );
    return {
      text: [
        "**Session statistics**",
        "",
        `- Session: \`${session.id}\``,
        `- Model: \`${session.model}\``,
        `- Messages: ${host.store.messages(session.id).length}`,
        `- Runs: ${runs.length}`,
        `- Tokens: in ${tokens.input} · out ${tokens.output}`,
      ].join("\n"),
      data: { session, runs: runs.length, tokens },
    };
  },
  async skills(_args, _ctx, host) {
    const skills = host.skillCatalog?.() ?? [];
    if (!skills.length) return { text: "No skills found", tone: "notice" };
    const state = (s: SkillCatalogEntry) =>
      s.effective ? "enabled" : s.shadowedBy ? `shadowed by ${s.shadowedBy}` : "disabled";
    return {
      text: `**Skills**\n\n| Skill | Scope | State |\n| --- | --- | --- |\n${skills
        .map((s) => `| \`${s.displayId}\` | ${s.scope} | ${state(s)} |`)
        .join("\n")}`,
      data: skills,
    };
  },
  async plugins(_args, _ctx, host) {
    const plugins = host.pluginCatalog?.() ?? [];
    if (!plugins.length) return { text: "No plugins loaded", tone: "notice" };
    return {
      text: `**Plugins**\n\n| Plugin | Status | Enabled |\n| --- | --- | --- |\n${plugins
        .map((p) => `| \`${p.id}\` | ${p.status} | ${p.enabled ? "yes" : "no"} |`)
        .join("\n")}`,
      data: plugins,
    };
  },
  async mcps(_args, _ctx, host) {
    const servers = host.mcp?.list() ?? [];
    if (!servers.length) return { text: "No MCP servers configured", tone: "notice" };
    return {
      text: `**MCP servers**\n\n| Server | Status | Tools |\n| --- | --- | --- |\n${servers
        .map((s) => `| \`${s.name}\` | ${s.status} | ${s.counts.tools} |`)
        .join("\n")}`,
      data: servers,
    };
  },
  async btw(args, ctx, host) {
    const question = args.trim();
    const side = host.sideQuestions;
    if (!question) {
      const history = side?.history(ctx.sessionId) ?? [];
      const latest = history.at(-1);
      if (!latest)
        return {
          text: `${SIDE_QUESTION_USAGE}\n${SIDE_QUESTION_DESCRIPTION}`,
          tone: "notice",
          data: { history },
        };
      return {
        text: formatSideQuestion(latest, history.length, history.length),
        data: { history, entry: latest },
      };
    }
    if (!side) throw new Error("Side questions are unavailable here");
    const entry = await side.ask(ctx.sessionId, question, ctx.signal ? { signal: ctx.signal } : {});
    const total = side.history(ctx.sessionId).length;
    return { text: formatSideQuestion(entry, total, total), data: { entry } };
  },
  async agents(args, ctx, host) {
    // With arguments, `/agents <verb>` belongs to the subagents plugin's own command (as in the
    // TUI); without them it lists the active-agent catalog.
    const plugin = args.trim() ? host.plugins?.commands.get("agents") : undefined;
    if (plugin) return { text: await plugin(args.trim(), { sessionId: ctx.sessionId }) };
    let state: unknown;
    try {
      state = host.plugins?.pluginState?.("subagents", "mainAgents");
    } catch {
      /* agent contributions are best-effort */
    }
    const agents = agentCatalogFromState(state);
    const active = resolveActiveAgent(agents, host.config?.agents.active);
    return {
      text: [
        "**Agents**",
        "",
        ...agents.map(
          (a) =>
            `- **${a.name}**${a.id === active.id ? " (current)" : ""}${a.readOnly ? " · read-only" : ""} — ${a.description}`,
        ),
      ].join("\n"),
      data: { agents, active: active.id },
    };
  },
};

export class CommandCatalog {
  constructor(private readonly host?: CommandHost) {}
  private builtins(): CommandDescriptor[] {
    return BUILTIN_COMMANDS.map(builtinDescriptor);
  }
  /** Every descriptor (optionally for one surface). Precedence: builtin > plugin > prompt > skill. */
  list(surface?: CommandSurface): CommandDescriptor[] {
    const out = this.builtins();
    const taken = new Set(out.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const push = (descriptor: CommandDescriptor) => {
      if (taken.has(descriptor.name)) return;
      taken.add(descriptor.name);
      out.push(descriptor);
    };
    const host = this.host;
    if (host?.plugins)
      for (const [name, info] of host.plugins.commandInfo)
        push({
          name,
          description: info.description ?? `plugin ${info.plugin}`,
          ...(info.argumentHint ? { argumentHint: info.argumentHint } : {}),
          source: "plugin",
          owner: info.plugin,
          surfaces: [...ALL],
          execution: "core",
        });
    if (host?.prompts)
      for (const template of host.prompts.templates.values())
        push({
          name: template.name,
          description: template.description,
          ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
          source: "prompt",
          owner: template.source,
          surfaces: [...ALL],
          execution: "surface",
        });
    for (const skill of host?.skillCatalog?.() ?? [])
      if (skill.effective && skill.enabled)
        push({
          name: `skill:${skill.id}`,
          description: skill.description,
          source: "skill",
          ...(skill.owner ? { owner: skill.owner.id } : {}),
          surfaces: [...ALL],
          execution: "surface",
        });
    return surface ? out.filter((c) => c.surfaces.includes(surface)) : out;
  }
  /** A command by name or alias (built-in names and aliases are case-insensitive). */
  resolve(name: string): CommandDescriptor | undefined {
    const lower = name.toLowerCase();
    const all = this.list();
    return (
      all.find((c) => c.source === "builtin" && (c.name === lower || c.aliases?.includes(lower))) ??
      all.find((c) => c.source !== "builtin" && c.name === name)
    );
  }
  /** Runs an `execution: "core"` command. Surface commands and unknown names throw. */
  async execute(name: string, args: string, ctx: CommandExecutionContext): Promise<CommandResult> {
    const descriptor = this.resolve(name);
    if (!descriptor) throw new Error(`Unknown command /${name}. Type /help.`);
    if (descriptor.execution !== "core")
      throw new Error(`/${descriptor.name} is handled by each surface, not by the core catalog`);
    const host = this.host;
    if (!host) throw new Error(`/${descriptor.name} needs an application host`);
    if (descriptor.source === "plugin") {
      const handler = host.plugins?.commands.get(descriptor.name);
      if (!handler) throw new Error(`Unknown plugin command: ${descriptor.name}`);
      return { text: await handler(args, { sessionId: ctx.sessionId }) };
    }
    const handler = HANDLERS[descriptor.name];
    if (!handler) throw new Error(`/${descriptor.name} has no core handler`);
    return handler(args, ctx, host);
  }
}
