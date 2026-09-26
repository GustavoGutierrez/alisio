import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AvailableProviderModel,
  ModelInfo,
  ModelProvider,
  Plugin,
  PluginCategory,
  ResolvedProviderModel,
  RunEvent,
} from "@alisio/sdk";
import {
  configFile,
  configHome,
  loadConfig,
  setMcpServerEnabled,
  setProjectPluginEnabled,
  stateHome,
} from "./config.ts";
import { completeText } from "./core/compaction.ts";
import type { ApprovalHandler } from "./core/contracts.ts";
import { ToolRegistry } from "./core/registry.ts";
import { AgentRunner } from "./core/runner.ts";
import { HerdrBridge } from "./integrations/herdr.ts";
import { McpConnector } from "./mcp/connector.ts";
import { discoverPlugins, PluginHost } from "./plugins/host.ts";
import { ActiveProvider, ProviderRegistry, UnconfiguredProvider } from "./providers/registry.ts";
import {
  availableProviderModels,
  resolveProviderModel as resolveConfiguredModel,
} from "./providers/routing.ts";
import { ProviderSettingsStore } from "./providers/settings.ts";
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
  /** Allow network tools (webfetch, websearch) and a provider-native search tool. */
  allowExternal?: boolean;
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
  name?: string;
  description: string;
  categories?: PluginCategory[];
  /** Marks the initial provider plugin used for legacy root provider configuration. */
  defaultProvider?: boolean;
  /** `options` is the raw `builtinPlugins.<id>` object; the plugin validates it. */
  create(options: unknown, context: BuiltinContext): Plugin;
}
export type PluginCatalogStatus = "active" | "inactive" | "failed" | "restart-required";
export interface PluginCatalogEntry {
  id: string;
  name: string;
  description: string;
  version?: string;
  categories: PluginCategory[];
  builtin: boolean;
  source: string;
  status: PluginCatalogStatus;
  enabled: boolean;
  manageable: boolean;
  diagnostic?: string;
}
export interface ConfiguredProviderCatalog {
  profile: string;
  provider: string;
  title: string;
  configuredModel: string;
  models: ModelInfo[];
  unavailable: boolean;
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
const nonBlank = (value: string | undefined): string | undefined => {
  const normalized = value?.trim();
  return normalized || undefined;
};
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
    providers = new ProviderRegistry(),
    plugins = new PluginHost(registry, store, config.pluginHooks, providers),
    mcp = new McpConnector(
      config.mcp.servers,
      registry,
      workspace,
      options.readOnly ? "read-only" : options.allowMcp ? "allowed" : "disabled",
      config.mcpSources,
    );
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
    const trustedProject = !!options.trustProject || !!options.config;
    const pluginCatalog = new Map<string, PluginCatalogEntry>();
    const runtimePluginEnabled = new Map<string, boolean>();
    const enabledBuiltinList = enabledBuiltins(
      options.builtins ?? [],
      config.builtinPlugins,
      options.disablePlugins,
    );
    const enabledBuiltinIds = new Set(enabledBuiltinList.map((item) => item.id));
    for (const builtin of options.builtins ?? []) {
      const enabled = enabledBuiltinIds.has(builtin.id);
      let instance: Plugin | undefined;
      try {
        instance = builtin.create(
          {
            ...(config.builtinPlugins[builtin.id] ?? {}),
            ...(options.pluginOptions?.[builtin.id] ?? {}),
          },
          builtinContext,
        );
        if (enabled) await plugins.activate(instance, workspace, { builtin: true });
        pluginCatalog.set(builtin.id, {
          id: builtin.id,
          name: instance.name ?? builtin.name ?? builtin.id,
          description: instance.description ?? builtin.description,
          version: instance.version,
          categories: instance.categories ?? builtin.categories ?? [],
          builtin: true,
          source: "built-in",
          status: enabled ? "active" : "inactive",
          enabled,
          manageable: !(options.disablePlugins ?? []).includes(builtin.id),
          ...((options.disablePlugins ?? []).includes(builtin.id)
            ? { diagnostic: "Disabled by command-line option" }
            : {}),
        });
        runtimePluginEnabled.set(builtin.id, enabled);
      } catch {
        pluginCatalog.set(builtin.id, {
          id: builtin.id,
          name: instance?.name ?? builtin.name ?? builtin.id,
          description: instance?.description ?? builtin.description,
          version: instance?.version,
          categories: instance?.categories ?? builtin.categories ?? [],
          builtin: true,
          source: "built-in",
          status: "failed",
          enabled,
          manageable: true,
          diagnostic: "Activation failed; registrations were rolled back",
        });
      }
    }
    if (!options.readOnly) {
      const external = [
        ...(options.plugin ?? []).map((p) => ({
          spec: isPathSpec(p) ? resolve(cwd, p) : p,
          source: "command line",
          manageable: false,
        })),
        ...config.plugins.map((spec) => ({
          spec,
          source: options.config
            ? "explicit configuration"
            : options.trustProject
              ? isPathSpec(spec)
                ? "project configuration"
                : `project package: ${spec}`
              : "global configuration",
          manageable: !!options.trustProject && !options.config,
        })),
        ...(await discoverPlugins(join(configHome(), "plugins"))).map((spec) => ({
          spec,
          source: "global plugin directory",
          manageable: false,
        })),
        ...(options.trustProject
          ? (await discoverPlugins(join(workspace, ".alisio", "plugins"))).map((spec) => ({
              spec,
              source: "project plugin directory",
              manageable: true,
            }))
          : []),
      ];
      // Import is isolated from setup so configured disabled plugins remain visible in the catalog.
      for (const entry of external.filter(
        (candidate, index, all) => all.findIndex((x) => x.spec === candidate.spec) === index,
      )) {
        let candidate: Awaited<ReturnType<PluginHost["inspect"]>> | undefined;
        try {
          candidate = await plugins.inspect(entry.spec, { from: workspace });
          const enabled = config.pluginOverrides[candidate.plugin.id]?.enabled !== false;
          if (enabled) await plugins.activate(candidate.plugin, candidate.base);
          pluginCatalog.set(candidate.plugin.id, {
            id: candidate.plugin.id,
            name: candidate.plugin.name ?? candidate.plugin.id,
            description: candidate.plugin.description ?? "No description provided",
            version: candidate.plugin.version,
            categories:
              candidate.plugin.categories ??
              plugins.metadata().find((metadata) => metadata.id === candidate?.plugin.id)
                ?.categories ??
              [],
            builtin: false,
            source: entry.source,
            status: enabled ? "active" : "inactive",
            enabled,
            manageable: entry.manageable,
          });
          runtimePluginEnabled.set(candidate.plugin.id, enabled);
        } catch {
          if (candidate) {
            pluginCatalog.set(candidate.plugin.id, {
              id: candidate.plugin.id,
              name: candidate.plugin.name ?? candidate.plugin.id,
              description: candidate.plugin.description ?? "No description provided",
              version: candidate.plugin.version,
              categories: candidate.plugin.categories ?? [],
              builtin: false,
              source: entry.source,
              status: "failed",
              enabled: true,
              manageable: entry.manageable,
              diagnostic: "Activation failed; registrations were rolled back",
            });
            continue;
          }
          const id = `unavailable-${pluginCatalog.size + 1}`;
          pluginCatalog.set(id, {
            id,
            name: "Unavailable plugin",
            description: "Plugin metadata could not be loaded",
            categories: [],
            builtin: false,
            source: entry.source,
            status: "failed",
            enabled: true,
            manageable: false,
            diagnostic: "Load failed; no path or credential details are shown here",
          });
        }
      }
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
    // `runner` is referenced lazily (constructed just below): safe because these accessors only
    // run once the tool is actually called, well after the runner exists.
    registerStandard(
      registry,
      workspace,
      skills,
      context,
      plugins.ui,
      {
        policy: () => runner.policy,
      },
      {
        config: config.websearch,
        resolveExtension: () => plugins.extensions.resolve("websearch"),
      },
    );
    if (options.allowMcp && !options.readOnly) mcp.register();
    if (options.allowAgents && !options.readOnly) herdr.registerTools(registry);
    const providerSettings = new ProviderSettingsStore();
    const saved = options.provider ? undefined : await providerSettings.active();
    const defaultProvider = (options.builtins ?? []).find((item) => item.defaultProvider);
    const legacyEndpointOverride =
      !!options.baseURL ||
      !!options.apiMode ||
      !!process.env.OPENAI_BASE_URL ||
      !!process.env.ALISIO_API_MODE ||
      !!options.config ||
      !!options.trustProject;
    const selectedSaved = legacyEndpointOverride ? undefined : saved;
    const supportsNativeSearch = (
      id: string | undefined,
      profile: Record<string, import("@alisio/sdk").ProviderConfigurationValue>,
    ) => {
      const capability = id ? providers.get(id)?.capabilities?.nativeWebSearch : undefined;
      return (
        capability === true ||
        (typeof capability === "object" &&
          capability.values.includes(profile[capability.field] ?? ""))
      );
    };
    let providerInfo = options.provider
      ? { id: options.provider.id, profile: {}, persisted: false, profileName: undefined }
      : selectedSaved
        ? {
            id: selectedSaved.profile.provider,
            profile: selectedSaved.profile.values,
            persisted: true,
            profileName: selectedSaved.name,
          }
        : defaultProvider
          ? {
              id: defaultProvider.id,
              profile: config.provider as Record<
                string,
                import("@alisio/sdk").ProviderConfigurationValue
              >,
              persisted: false,
              profileName: undefined,
            }
          : undefined;
    let providerError: string | undefined;
    let initial: ModelProvider = new UnconfiguredProvider();
    if (options.provider) initial = options.provider;
    else if (selectedSaved) {
      try {
        initial = await providers.create(selectedSaved.profile.provider, {
          profile: {
            ...selectedSaved.profile.values,
            model:
              nonBlank(options.model) ??
              nonBlank(process.env.ALISIO_MODEL) ??
              selectedSaved.profile.model,
          },
          credentials: selectedSaved.credentials,
        });
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
      }
    } else if (defaultProvider && config.provider.model) {
      try {
        initial = await providers.create(defaultProvider.id, {
          profile: {},
          credentials: {},
          legacy: config.provider,
        });
      } catch (error) {
        providerError = error instanceof Error ? error.message : String(error);
      }
    }
    const provider = new ActiveProvider(initial);
    if (config.websearch.provider === "native") {
      const id = selectedSaved?.profile.provider ?? defaultProvider?.id;
      const profile = selectedSaved
        ? selectedSaved.profile.values
        : (config.provider as Record<string, import("@alisio/sdk").ProviderConfigurationValue>);
      if (!supportsNativeSearch(id, profile))
        throw new Error(
          'websearch.provider is "native" but the active provider does not support native search',
        );
    }
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
    let catalogCache: { at: number; value: ConfiguredProviderCatalog[] } | undefined;
    const configuredCatalogs = async (
      signal: AbortSignal,
    ): Promise<ConfiguredProviderCatalog[]> => {
      if (catalogCache && Date.now() - catalogCache.at < 15_000) return catalogCache.value;
      const settings = await providerSettings.load();
      const value = await Promise.all(
        Object.entries(settings.profiles).map(async ([name, profile]) => {
          const registration = providers.get(profile.provider);
          const base = {
            profile: name,
            provider: profile.provider,
            title: registration?.name ?? profile.provider,
            configuredModel: profile.model,
          };
          if (!registration) return { ...base, models: [], unavailable: true };
          try {
            const resolved = await providerSettings.resolve(name);
            if (!resolved) return { ...base, models: [], unavailable: true };
            const candidate = await providers.create(profile.provider, {
              profile: { ...profile.values, model: profile.model },
              credentials: resolved.credentials,
            });
            try {
              return {
                ...base,
                models: (await candidate.listModels?.(signal)) ?? [],
                unavailable: false,
              };
            } finally {
              await candidate.dispose?.();
            }
          } catch {
            return { ...base, models: [], unavailable: true };
          }
        }),
      ).then((catalogs) => catalogs.sort((a, b) => a.title.localeCompare(b.title)));
      catalogCache = { at: Date.now(), value };
      return value;
    };
    const listAvailableModels = async (signal = AbortSignal.timeout(20_000)) =>
      availableProviderModels(await configuredCatalogs(signal));
    const resolveModel = async (
      reference: string,
      signal = AbortSignal.timeout(20_000),
    ): Promise<ResolvedProviderModel> =>
      resolveConfiguredModel(await configuredCatalogs(signal), reference);
    const sessionProviders = new Map<string, ModelProvider>();
    const targetProviders = new Map<string, Promise<ModelProvider>>();
    const retainedProviders = new Set<ModelProvider>();
    const runtimeFor = (target: ResolvedProviderModel): Promise<ModelProvider> => {
      const key = `${target.profile}\0${target.model.id}`;
      let pending = targetProviders.get(key);
      if (!pending) {
        pending = providerSettings.resolve(target.profile).then(async (saved) => {
          if (!saved || saved.profile.provider !== target.provider)
            throw new Error(
              `Configured provider "${target.provider}" is unavailable. Reconnect it with /connect.`,
            );
          try {
            return await providers.create(target.provider, {
              profile: { ...saved.profile.values, model: target.model.id },
              credentials: saved.credentials,
            });
          } catch {
            throw new Error(
              `Configured provider "${target.provider}" could not be activated. Reconnect it with /connect.`,
            );
          }
        });
        targetProviders.set(key, pending);
        pending.catch(() => targetProviders.delete(key));
      }
      return pending;
    };
    const bindProvider = async (sessionId: string, target: ResolvedProviderModel) => {
      const runtime = await runtimeFor(target);
      sessionProviders.set(sessionId, runtime);
      return runtime.id;
    };
    const providerFor = async (session: import("./core/contracts.ts").Session) => {
      const bound = sessionProviders.get(session.id);
      if (bound) return bound;
      if (session.parentId) {
        const parent = sessionProviders.get(session.parentId);
        if (parent && parent.id === session.provider) {
          sessionProviders.set(session.id, parent);
          return parent;
        }
      }
      const current = provider.currentProvider;
      if (current.id === session.provider) {
        sessionProviders.set(session.id, current);
        retainedProviders.add(current);
        return current;
      }
      // A persisted routed session may be resumed after another profile became the global default.
      // Recreate only configured runtimes whose catalog contains the recorded model, then match the
      // provider's stable public id. Credentials never leave this activation boundary.
      const candidates = (await listAvailableModels()).filter(
        (entry) => entry.model.id === session.model,
      );
      for (const target of candidates) {
        const runtime = await runtimeFor(target).catch(() => undefined);
        if (!runtime) continue;
        if (runtime.id !== session.provider) continue;
        sessionProviders.set(session.id, runtime);
        return runtime;
      }
      throw new Error(
        `Session provider "${session.provider}" is unavailable. Reconnect that provider or start a new session.`,
      );
    };
    plugins.setModels({ list: listAvailableModels, resolve: resolveModel });
    plugins.setCompleter(async (request) => {
      if (!request.model) {
        const runtime = request.sessionId
          ? await providerFor(store.get(request.sessionId))
          : provider.currentProvider;
        return completeText(runtime, request);
      }
      const target = await resolveModel(request.model, request.signal);
      return completeText(await runtimeFor(target), { ...request, model: target.model.id });
    });
    const runner = new AgentRunner({
      provider,
      providerFor,
      registry,
      store,
      context,
      workspace,
      policy: {
        write: !!options.allowWrite && !options.readOnly,
        process: !!options.allowProcess && !options.readOnly,
        external:
          !options.readOnly &&
          (!!options.allowExternal ||
            !!options.allowMcp ||
            !!options.allowAgents ||
            plugins.externalCount > 0 ||
            registry.list().some((t) => t.name.startsWith("p_"))),
      },
      ...config.limits,
      compaction: config.compaction,
      extensions: plugins,
      contextWindow,
      ...(options.approve && !options.readOnly ? { approve: options.approve } : {}),
      ...(config.websearch.provider === "native"
        ? { nativeTools: [{ type: config.websearch.nativeToolType }] }
        : {}),
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
        providerId: () => provider.id,
        resolveModel,
        bindProvider,
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
      /** Credential- and path-safe catalog for the current resolved plugin set. */
      pluginCatalog(): PluginCatalogEntry[] {
        return [...pluginCatalog.values()]
          .map((entry) => ({ ...entry, categories: [...entry.categories] }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      /** Persist a project-local override. Runtime registrations intentionally change on restart. */
      async setPluginEnabled(
        id: string,
        enabled: boolean,
        lifecycle: { liveSession?: boolean } = {},
      ): Promise<PluginCatalogEntry> {
        const entry = pluginCatalog.get(id);
        if (!entry) throw new Error(`Unknown plugin: ${id}`);
        if (!entry.manageable)
          throw new Error(
            entry.diagnostic ?? "This plugin is managed outside project configuration",
          );
        if (!entry.builtin && !trustedProject)
          throw new Error("Trust this project before enabling or disabling executable plugins");
        if (!enabled) {
          const activeRegistration = providers.get(providerInfo?.id ?? "");
          if (activeRegistration?.plugin === id)
            throw new Error(
              "Switch to a model from another provider, then start a fresh session before disabling this plugin",
            );
          if (
            [...sessionProviders.values()].some(
              (runtime) => providers.get(runtime.id)?.plugin === id,
            )
          )
            throw new Error(
              "A live routed session still uses this provider plugin; close those sessions or restart Alisio before disabling it",
            );
          if (lifecycle.liveSession && plugins.ownsSessionResources(id))
            throw new Error(
              "This plugin owns resources used by the current session; start a fresh session before disabling it",
            );
        }
        if (entry.enabled === enabled && entry.status !== "restart-required") return { ...entry };
        await setProjectPluginEnabled({
          workspace,
          id,
          enabled,
          builtin: entry.builtin,
          trusted: trustedProject,
        });
        const matchesRuntime = runtimePluginEnabled.get(id) === enabled;
        const updated: PluginCatalogEntry = {
          ...entry,
          enabled,
          status: matchesRuntime ? (enabled ? "active" : "inactive") : "restart-required",
          ...(matchesRuntime
            ? { diagnostic: undefined }
            : {
                diagnostic: enabled
                  ? "Enabled for the next Alisio start"
                  : "Disabled for the next Alisio start",
              }),
        };
        pluginCatalog.set(id, updated);
        return { ...updated, categories: [...updated.categories] };
      },
      mcp,
      /** Persist an MCP toggle in its defining layer, then safely update this process. */
      async setMcpEnabled(id: string, enabled: boolean, connect = false) {
        if (options.readOnly) throw new Error("MCP changes are unavailable under --read-only");
        const source = config.mcpSources[id];
        if (!source) throw new Error(`Unknown MCP server: ${id}`);
        await setMcpServerEnabled({ source, name: id, enabled });
        await mcp.setEnabled(
          id,
          enabled,
          connect && enabled && options.allowMcp ? AbortSignal.timeout(15_000) : undefined,
        );
        return mcp.info(id);
      },
      provider,
      providers,
      providerSettings,
      get providerError() {
        return providerError;
      },
      get providerInfo() {
        return providerInfo;
      },
      runner,
      herdr,
      contextWindow,
      loadModels,
      /** Creates a provider for validation/model discovery without changing the active provider. */
      async probeProvider(
        id: string,
        profile: Record<string, import("@alisio/sdk").ProviderConfigurationValue>,
        credentials: Record<string, string>,
        signal: AbortSignal,
      ) {
        const candidate = await providers.create(id, { profile, credentials });
        try {
          return (await candidate.listModels?.(signal)) ?? [];
        } finally {
          await candidate.dispose?.();
        }
      },
      /** Lists every plugin-configured profile without returning credentials or provider errors. */
      async configuredProviderCatalogs(signal: AbortSignal): Promise<ConfiguredProviderCatalog[]> {
        return configuredCatalogs(signal);
      },
      /** Lists credential-free models from globally configured `/connect` profiles. */
      listAvailableModels,
      /** Resolves `provider/model` or a unique bare model id without exposing credentials. */
      resolveModel,
      /** Creates and binds a fresh session to an optional configured model selector. */
      async createSession(reference?: string) {
        if (!reference) {
          const session = store.create(workspace, provider.id, provider.model);
          sessionProviders.set(session.id, provider.currentProvider);
          retainedProviders.add(provider.currentProvider);
          return session;
        }
        const target = await resolveModel(reference);
        const runtime = await runtimeFor(target);
        const session = store.create(workspace, runtime.id, target.model.id);
        sessionProviders.set(session.id, runtime);
        return session;
      },
      /** Persists and activates only after construction succeeds; programmatic overrides stay fixed. */
      async activateProvider(
        id: string,
        profile: Record<string, import("@alisio/sdk").ProviderConfigurationValue>,
        credentials: Record<string, string>,
        model: string,
        profileName = id,
      ) {
        if (options.provider) throw new Error("A programmatic provider override is active");
        if (config.websearch.provider === "native" && !supportsNativeSearch(id, profile))
          throw new Error("The selected provider configuration does not support native web search");
        const candidate = await providers.create(id, {
          profile: { ...profile, model },
          credentials,
        });
        try {
          await providerSettings.saveActive(
            profileName,
            { provider: id, values: profile, model },
            credentials,
          );
          const previous = provider.currentProvider;
          const retained = retainedProviders.has(previous);
          await provider.replace(candidate, !retained);
          providerError = undefined;
          providerInfo = { id, profile, persisted: true, profileName };
          models.clear();
          catalogCache = undefined;
        } catch (error) {
          await Promise.resolve(candidate.dispose?.()).catch(() => {});
          throw error;
        }
      },
      /** Activates a stored profile without exposing its credentials. Returns false for a no-op. */
      async activateProviderProfile(name: string, model: string): Promise<boolean> {
        const saved = await providerSettings.resolve(name);
        if (!saved) throw new Error("Configured provider profile is unavailable");
        if (
          providerInfo?.persisted &&
          saved.name === providerInfo.profileName &&
          saved.profile.provider === providerInfo.id &&
          provider.model === model
        )
          return false;
        await this.activateProvider(
          saved.profile.provider,
          saved.profile.values,
          saved.credentials,
          model,
          saved.name,
        );
        return true;
      },
      /** Resolves, globally activates, and creates the fresh session required by a main switch. */
      async switchModel(reference: string) {
        const target = await resolveModel(reference);
        const changed = await this.activateProviderProfile(target.profile, target.model.id);
        if (!changed) return undefined;
        return this.createSession(target.reference);
      },
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
            await provider.dispose();
            await Promise.allSettled(
              [
                ...new Set([
                  ...(await Promise.allSettled(targetProviders.values()))
                    .filter(
                      (x): x is PromiseFulfilledResult<ModelProvider> => x.status === "fulfilled",
                    )
                    .map((x) => x.value),
                  ...retainedProviders,
                ]),
              ]
                .filter((runtime) => runtime !== provider.currentProvider)
                .map((runtime) => Promise.resolve(runtime.dispose?.())),
            );
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
