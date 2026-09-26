import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelInfo, ModelProvider, Plugin, RunEvent } from "@alisio/sdk";
import { configFile, configHome, loadConfig, stateHome } from "./config.ts";
import { completeText } from "./core/compaction.ts";
import type { ApprovalHandler } from "./core/contracts.ts";
import { ToolRegistry } from "./core/registry.ts";
import { AgentRunner } from "./core/runner.ts";
import { HerdrBridge } from "./integrations/herdr.ts";
import { McpConnector } from "./mcp/connector.ts";
import { discoverPlugins, PluginHost } from "./plugins/host.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { ProjectContext } from "./resources/context.ts";
import { expandSlashPrompt, loadPromptTemplates, promptSources } from "./resources/prompts.ts";
import { Skills, skillRoots } from "./resources/skills.ts";
import { isPathSpec } from "./runtime/modules.ts";
import { findWorkspace } from "./runtime/paths.ts";
import { SQLiteStore } from "./runtime/store.ts";
import { ChildSessions } from "./sessions/children.ts";
export interface AppOptions {
  cwd?: string;
  config?: string;
  trustProject?: boolean;
  plugin?: string[];
  allowWrite?: boolean;
  allowProcess?: boolean;
  allowMcp?: boolean;
  readOnly?: boolean;
  allowAgents?: boolean;
  noHerdr?: boolean;
  model?: string;
  baseURL?: string;
  apiMode?: string;
  db?: string;
  provider?: ModelProvider;
  onEvent?: (event: RunEvent) => void;
  /** First-party plugins activated through the trusted path (the CLI passes its registry). */
  builtins?: BuiltinPlugin[];
  /** Prompt templates shipped by the embedder (lowest precedence). */
  builtinPrompts?: Array<{ name: string; text: string }>;
  /** Names templates may not take (e.g. the UI's own slash commands). */
  reservedPromptNames?: string[];
  /** Options merged over `builtinPlugins.<id>` from the configuration (e.g. CLI flags). */
  pluginOptions?: Record<string, Record<string, unknown>>;
  /** Built-in plugin ids to disable (e.g. `memory`). */
  disablePlugins?: string[];
  /** Interactive approval for write/process tools; ignored in read-only mode. */
  approve?: ApprovalHandler;
}
export interface BuiltinContext {
  workspace: string;
  cwd: string;
  stateHome: string;
  configHome: string;
  home: string;
  /** Project-level resources may load (--trust-project or an explicit --config). */
  trusted: boolean;
  /** Directory of the configuration file, for relative paths in plugin options. */
  configDir: string;
}
export interface BuiltinPlugin {
  id: string;
  description: string;
  /** `options` is the raw `builtinPlugins.<id>` object; the plugin validates it. */
  create(options: unknown, context: BuiltinContext): Plugin;
}
/** A built-in runs unless its config sets `enabled: false` or it is disabled by id. */
export function enabledBuiltins(
  available: BuiltinPlugin[],
  config: Record<string, { enabled?: boolean } & Record<string, unknown>>,
  disabled: string[] = [],
): BuiltinPlugin[] {
  for (const id of [...Object.keys(config), ...disabled])
    if (!available.some((p) => p.id === id)) throw new Error(`Unknown built-in plugin: ${id}`);
  return available.filter((p) => config[p.id]?.enabled !== false && !disabled.includes(p.id));
}
export async function createApplication(options: AppOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd()),
    workspace = await findWorkspace(cwd);
  const config = await loadConfig(workspace, {
    file: options.config,
    trustProject: options.trustProject,
    model: options.model,
    baseURL: options.baseURL,
    apiMode: options.apiMode,
  });
  const store = new SQLiteStore(options.db ?? join(stateHome(), "sessions.sqlite"));
  const registry = new ToolRegistry(),
    skills = new Skills(),
    context = new ProjectContext(workspace, {
      globalDir: configHome(),
      cwd,
      claudeMdFallback: config.context.claudeMdFallback,
      maxBytes: config.context.maxBytes,
    }),
    plugins = new PluginHost(registry, store, config.pluginHooks),
    mcp = new McpConnector(config.mcp.servers, registry, workspace);
  const herdr = options.noHerdr
    ? new HerdrBridge({}, async () => "")
    : HerdrBridge.fromEnvironment(workspace, (error) => process.stderr.write(`${error}\n`));
  try {
    // First-party built-ins load through the trusted path, also under --read-only.
    const builtinContext = {
      workspace,
      cwd,
      stateHome: stateHome(),
      configHome: configHome(),
      home: homedir(),
      trusted: !!options.trustProject || !!options.config,
      configDir: dirname(
        configFile(
          workspace,
          options.config ? { file: options.config } : { trustProject: options.trustProject },
        ),
      ),
    };
    for (const builtin of enabledBuiltins(
      options.builtins ?? [],
      config.builtinPlugins,
      options.disablePlugins,
    ))
      await plugins.activate(
        builtin.create(
          {
            ...(config.builtinPlugins[builtin.id] ?? {}),
            ...(options.pluginOptions?.[builtin.id] ?? {}),
          },
          builtinContext,
        ),
        workspace,
        { builtin: true },
      );
    if (!options.readOnly) {
      const paths = [
        ...(options.plugin ?? []).map((p) => (isPathSpec(p) ? resolve(cwd, p) : p)),
        ...config.plugins,
        ...(await discoverPlugins(join(configHome(), "plugins"))),
        ...(options.trustProject
          ? await discoverPlugins(join(workspace, ".alisio", "plugins"))
          : []),
      ];
      // Package names resolve from the workspace, then global node_modules.
      for (const spec of [...new Set(paths)]) await plugins.load(spec, { from: workspace });
    }
    // Project skills follow the config trust model (--trust-project or an explicit --config).
    await skills.discover(
      skillRoots({
        workspace,
        cwd,
        home: homedir(),
        configHome: configHome(),
        trusted: !!options.trustProject || !!options.config,
        configSkills: config.skills,
        pluginRoots: plugins.skillRoots,
      }),
    );
    context.extras.push(async () => skills.catalog(), ...plugins.contexts);
    const { registerStandard } = await import("./tools/standard.ts");
    registerStandard(registry, workspace, skills, context);
    if (options.allowMcp && !options.readOnly) mcp.register();
    if (options.allowAgents && !options.readOnly) herdr.registerTools(registry);
    const provider = options.provider ?? new OpenAICompatibleProvider(config.provider);
    plugins.setCompleter((request) => completeText(provider, request));
    const models = new Map<string, ModelInfo>();
    // Priority: explicit configuration for the configured model, then GET /models.
    const contextWindow = (model: string) =>
      (model === config.provider.model ? config.provider.contextWindow : undefined) ??
      models.get(model)?.contextWindow;
    const loadModels = async (signal: AbortSignal): Promise<ModelInfo[]> => {
      if (!provider.listModels) return [];
      const list = await provider.listModels(signal);
      models.clear();
      for (const m of list) models.set(m.id, m);
      return list;
    };
    const runner = new AgentRunner({
      provider,
      registry,
      store,
      context,
      workspace,
      policy: {
        write: !!options.allowWrite && !options.readOnly,
        process: !!options.allowProcess && !options.readOnly,
        external:
          !options.readOnly &&
          (!!options.allowMcp ||
            !!options.allowAgents ||
            plugins.externalCount > 0 ||
            registry.list().some((t) => t.name.startsWith("p_"))),
      },
      ...config.limits,
      compaction: config.compaction,
      extensions: plugins,
      contextWindow,
      ...(options.approve && !options.readOnly ? { approve: options.approve } : {}),
      onEvent: (event) => {
        herdr.event(event);
        plugins.emit(event);
        options.onEvent?.(event);
      },
    });
    // Child sessions (generic delegation service for plugins). Contexts are cached per workspace
    // so a child in a git worktree reads that worktree's AGENTS.md files.
    const contexts = new Map<string, ProjectContext>([[workspace, context]]);
    plugins.setSessions(
      new ChildSessions({
        store,
        runner,
        providerId: provider.id,
        rootPolicy: () => runner.policy,
        rootApprovals: runner.approvals,
        readOnly: !!options.readOnly,
        contextFor: (root) => {
          let found = contexts.get(root);
          if (!found) {
            found = new ProjectContext(root, {
              globalDir: configHome(),
              claudeMdFallback: config.context.claudeMdFallback,
              maxBytes: config.context.maxBytes,
            });
            found.extras.push(...context.extras);
            contexts.set(root, found);
          }
          return found;
        },
      }),
    );
    // Project prompts follow the config trust model: --trust-project or an explicit --config.
    const prompts = await loadPromptTemplates(
      promptSources({
        builtin: options.builtinPrompts ?? [],
        plugins: plugins.promptSources,
        userDir: join(configHome(), "prompts"),
        projectDir: join(workspace, ".alisio", "prompts"),
        trusted: !!options.trustProject || !!options.config,
      }),
      { reserved: [...(options.reservedPromptNames ?? []), ...plugins.commands.keys()] },
    );
    /**
     * `/name args` → rendered template text, or undefined when not a template. Throws when the
     * template requires a capability that is neither allowed nor approvable.
     */
    const expandPrompt = (input: string) => {
      const expanded = expandSlashPrompt(input, prompts.templates);
      if (!expanded) return undefined;
      for (const need of expanded.template.requires) {
        const flag = need === "write" ? "--allow-write" : "--allow-process";
        if (options.readOnly)
          throw new Error(
            `/${expanded.name} needs ${need} access, which --read-only disables. Run it without --read-only (and with ${flag}, or approve the calls in the TUI).`,
          );
        if (!runner.policy[need] && !runner.approvals)
          throw new Error(`/${expanded.name} needs ${need} access: rerun with ${flag}.`);
      }
      return expanded;
    };
    return {
      workspace,
      config,
      prompts,
      expandPrompt,
      store,
      registry,
      context,
      skills,
      plugins,
      mcp,
      provider,
      runner,
      herdr,
      contextWindow,
      loadModels,
      /** Runs session-end plugin hooks (bounded by the host timeout). */
      async endSession(sessionId: string, reason: "clear" | "exit") {
        if (!plugins.hasSessionEndHooks) return { failures: [] };
        const session = store.get(sessionId);
        return plugins.sessionEnd({
          sessionId,
          model: session.model,
          workspace,
          reason,
          messages: store.messages(sessionId),
        });
      },
      async close() {
        try {
          await herdr.close();
          await mcp.close();
        } finally {
          try {
            await plugins.close();
          } finally {
            store.close();
          }
        }
      },
    };
  } catch (e) {
    await herdr.close();
    await mcp.close();
    await plugins.close();
    store.close();
    throw e;
  }
}
