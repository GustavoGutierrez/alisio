import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ModelInfo, ModelProvider, RunEvent } from "@alisio/sdk";
import { configFile, configHome, loadConfig, stateHome } from "./config.ts";
import { completeText } from "./core/compaction.ts";
import type { ApprovalHandler } from "./core/contracts.ts";
import { ToolRegistry } from "./core/registry.ts";
import { AgentRunner } from "./core/runner.ts";
import { HerdrBridge } from "./integrations/herdr.ts";
import { McpConnector } from "./mcp/connector.ts";
import { enabledBuiltins } from "./plugins/builtin/index.ts";
import { discoverPlugins, PluginHost } from "./plugins/host.ts";
import { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
import { ProjectContext } from "./resources/context.ts";
import { Skills } from "./resources/skills.ts";
import { findWorkspace } from "./runtime/paths.ts";
import { SQLiteStore } from "./runtime/store.ts";
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
  /** Built-in plugin ids to disable (e.g. `memory`). */
  disablePlugins?: string[];
  /** Interactive approval for write/process tools; ignored in read-only mode. */
  approve?: ApprovalHandler;
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
    context = new ProjectContext(workspace, join(configHome(), "AGENTS.md"), cwd),
    plugins = new PluginHost(registry, store, config.pluginHooks),
    mcp = new McpConnector(config.mcp.servers, registry, workspace);
  const herdr = options.noHerdr
    ? new HerdrBridge({}, async () => "")
    : HerdrBridge.fromEnvironment(workspace, (error) => process.stderr.write(`${error}\n`));
  try {
    // First-party built-ins load through the trusted path, also under --read-only.
    const builtinContext = {
      workspace,
      stateHome: stateHome(),
      configDir: dirname(
        configFile(
          workspace,
          options.config ? { file: options.config } : { trustProject: options.trustProject },
        ),
      ),
    };
    for (const builtin of enabledBuiltins(config.builtinPlugins, options.disablePlugins))
      await plugins.activate(
        builtin.create(config.builtinPlugins[builtin.id] ?? {}, builtinContext),
        workspace,
        { builtin: true },
      );
    if (!options.readOnly) {
      const paths = [
        ...(options.plugin ?? []).map((p) => resolve(cwd, p)),
        ...config.plugins,
        ...(await discoverPlugins(join(configHome(), "plugins"))),
        ...(options.trustProject
          ? await discoverPlugins(join(workspace, ".alisio", "plugins"))
          : []),
      ];
      for (const path of [...new Set(paths)]) await plugins.load(path);
    }
    const skillRoots = [...config.skills];
    let scope = cwd;
    while (true) {
      skillRoots.push(join(scope, ".agents", "skills"));
      if (scope === workspace) break;
      scope = dirname(scope);
    }
    await skills.discover([
      ...skillRoots,
      join(homedir(), ".agents", "skills"),
      ...plugins.skillRoots,
    ]);
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
    return {
      workspace,
      config,
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
