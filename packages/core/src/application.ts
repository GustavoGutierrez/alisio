import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type {
  AvailableProviderModel,
  JsonValue,
  ModelInfo,
  ModelProvider,
  Plugin,
  PluginCategory,
  ProviderConfigurationValue,
  ResolvedProviderModel,
  RunEvent,
} from "@alisio/sdk";
import { AgentDefinitionService } from "./agents/service.ts";
import { CapabilityGrants } from "./analysis/capabilities.ts";
import { DatasetService } from "./analysis/data/datasets.ts";
import { AnalysisJanitor } from "./analysis/janitor.ts";
import { AnalysisJobs } from "./analysis/jobs.ts";
import { OciRuntime } from "./analysis/oci.ts";
import { AnalysisRerun } from "./analysis/rerun.ts";
import { AnalysisRuntimeManager } from "./analysis/runtime-manager.ts";
import { createArtifactPublisher } from "./artifacts/publisher.ts";
import { ArtifactStore } from "./artifacts/store.ts";
import { TaskJanitor } from "./background/janitor.ts";
import { subagentTasks } from "./background/mirror.ts";
import type { NotifierTiming, TaskWake } from "./background/notify.ts";
import { BackgroundTasks } from "./background/service.ts";
import {
  configFile,
  configHome,
  loadConfigWithProvenance,
  overridesSavedProviderProfile,
  type SettableSettingKey,
  setConfigValue,
  setGlobalMcpAllow,
  setMcpServerEnabled,
  setProjectPluginEnabled,
  setProjectSkillEnabled,
  stateHome,
} from "./config.ts";
import { completeText } from "./core/compaction.ts";
import type { ApprovalHandler } from "./core/contracts.ts";
import { HumanWaits } from "./core/human-wait.ts";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "./core/output-limit.ts";
import { ToolRegistry } from "./core/registry.ts";
import { AgentRunner, type CompactionSettings, type RunnerSettingsPatch } from "./core/runner.ts";
import {
  bindDecisions,
  DecisionMetrics,
  DecisionRegistry,
  DecisionService,
} from "./decisions/index.ts";
import { GoalService } from "./goal/service.ts";
import { GoalStore } from "./goal/store.ts";
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
import { type ExternalDirectoryHandler, PathAccess } from "./runtime/access.ts";
import { BlobStore } from "./runtime/blobs.ts";
import { isPathSpec } from "./runtime/modules.ts";
import { findWorkspace } from "./runtime/paths.ts";
import { SQLiteStore } from "./runtime/store.ts";
import { ChildSessions } from "./sessions/children.ts";
import { SideQuestions } from "./sessions/side-questions.ts";
import { registerGoalTools } from "./tools/goal.ts";

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/**
 * Cap per teardown stage of `app.close()`: exit must never wait longer than this on a hanging
 * component (MCP server, provider, plugin). Stages run in parallel where independent and
 * failures are swallowed, so teardown errors never replace the caller's result.
 */
const TEARDOWN_STAGE_TIMEOUT_MS = 2_500;
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
  /** Extra directories the tools may touch outside the workspace (per-run `--add-dir`). */
  addDirs?: string[];
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
  /** Pre-allow the `analysis.run` capability only (`--allow-analysis`); `--read-only` wins. */
  allowAnalysis?: boolean;
  /** `--python <path>`: the interpreter for `python_run` (no discovery). */
  python?: string;
  /** Embedders and tests: a ready Python runtime manager instead of the default one. */
  analysisRuntime?: AnalysisRuntimeManager;
  /** Embedders and tests: replaces the container engine collaborators (a fake CLI). */
  analysisOci?: Partial<import("./analysis/oci.ts").OciDeps>;
  /** Delay before the first background retention sweep (default 30 s; tests use a short one). */
  analysisSweepDelayMs?: number;
  /** Recorded as the source of interactive capability decisions (default `tui`). */
  approvalSource?: "tui" | "web";
  /**
   * Interactive approval for a tool path outside the workspace and every declared extra root,
   * scoped to the containing directory (allow once / session / deny); ignored in read-only mode.
   */
  approveExternalDirectory?: ExternalDirectoryHandler;
  /** Host hooks of the goal runtime (`/goal`). */
  goals?: {
    /** The goal of a session changed or was removed (`undefined`): UIs refresh. */
    onChange?: (
      sessionId: string,
      goal: import("./goal/machine.ts").GoalRecord | undefined,
    ) => void;
    /** A breaker observation (counts only). */
    onLog?: (sessionId: string, log: import("./goal/machine.ts").GoalLog) => void;
    /** Pause goals whose driving process is gone at startup (default true; tests turn it off). */
    recover?: boolean;
  };
  /** Host hooks of the background-task runtime (`bg_run`). */
  tasks?: {
    /**
     * Starts a run that tells the owner agent about finished tasks. Absent in headless hosts:
     * no wake-up is ever sent (the tools say so).
     */
    wake?: TaskWake;
    /** A task appeared or changed state (the server turns it into a `tasks_changed` frame). */
    onChange?: (task: import("@alisio/sdk").BackgroundTaskInfo, rootSession: string) => void;
    /** Notification timing (tests). */
    timing?: Partial<NotifierTiming>;
    /** Delay before the first retention sweep (default 30 s; tests use a short one). */
    sweepDelayMs?: number;
    /** Live tasks allowed across this process (default 16). */
    maxPerProcess?: number;
    /** SIGTERM → SIGKILL grace of a stop (default 3 s; tests use a short one). */
    killGraceMs?: number;
  };
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
/**
 * Per-profile optional context-window override, in tokens (for local OpenAI-compatible servers
 * like llama.cpp whose `GET /models` omits `context_window`). Numbers are used directly; strings
 * (for example hand-edited providers.json) are parsed. Absent or unparseable means "no override".
 */
const parseProfileContextWindow = (
  value: ProviderConfigurationValue | undefined,
): number | undefined => {
  if (value === undefined) return undefined;
  const window = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(window) && window > 0 ? window : undefined;
};
export async function createApplication(options: AppOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd()),
    workspace = await findWorkspace(cwd);
  const { config, provenance: configProvenance } = await loadConfigWithProvenance(workspace, {
    file: options.config,
    trustProject: options.trustProject,
    model: options.model,
    baseURL: options.baseURL,
    apiMode: options.apiMode,
  });
  // Global-only consent: `mcp.allow` is read from the user layer; the merged config never carries
  // a project value (see loadConfigWithProvenance), so a project cannot grant itself MCP consent.
  const mcpAllow = config.mcp.allow === true;
  let persistedMcpAllow = mcpAllow;
  // Extra tool roots: config `additionalDirectories` (already canonicalized on load) plus per-run
  // `--add-dir` (resolved against the current directory). Ignored entirely under --read-only, so
  // the flag and the config key can never widen a locked session.
  const addDirs = options.readOnly
    ? []
    : await Promise.all(
        (options.addDirs ?? []).map((dir) =>
          realpath(resolve(cwd, dir)).catch(() => resolve(cwd, dir)),
        ),
      );
  // Waits for a person (approvals, questions, the plan review) do not count against the run's
  // time limit. One registry serves the runner, the plugin host's interactive UI and the
  // external-directory approval, so every host (TUI, web server, embedders) gets it for free.
  const humanWaits = new HumanWaits((session) => {
    try {
      return store.get(session).parentId ?? undefined;
    } catch {
      return undefined;
    }
  });
  const askExternalDirectory = options.approveExternalDirectory;
  const pathAccess = new PathAccess({
    workspace,
    extraRoots: [...config.additionalDirectories, ...addDirs],
    ...(askExternalDirectory && !options.readOnly
      ? {
          approve: (request) =>
            humanWaits.track(request.session, () => askExternalDirectory(request)),
        }
      : {}),
    readOnly: !!options.readOnly,
  });
  const store = new SQLiteStore(options.db ?? join(stateHome(), "sessions.sqlite"));
  // Content-addressed attachment bytes next to the session database (no I/O until `put`).
  const blobs = new BlobStore({
    root:
      options.db && options.db !== ":memory:"
        ? join(dirname(options.db), "blobs")
        : join(stateHome(), "blobs"),
    db: store.db,
  });
  const registry = new ToolRegistry(),
    skills = new Skills({ overrides: config.skillOverrides }),
    context = new ProjectContext(workspace, {
      globalDir: configHome(),
      cwd,
      claudeMdFallback: config.context.claudeMdFallback,
      maxBytes: config.context.maxBytes,
    }),
    providers = new ProviderRegistry(),
    plugins = new PluginHost(
      registry,
      store,
      {
        hookTimeoutMs: config.pluginHooks.timeoutMs,
        sessionEndTimeoutMs: config.pluginHooks.sessionEndTimeoutMs,
        disposeTimeoutMs: config.pluginHooks.disposeTimeoutMs,
      },
      providers,
    ),
    decisionRegistry = new DecisionRegistry(),
    decisionMetrics = new DecisionMetrics(),
    decisionService = new DecisionService({
      registry: decisionRegistry,
      // Read per call: `updateSetting("decisions.*")` mutates `config.decisions`.
      config: () => config.decisions,
      metrics: decisionMetrics,
      // Failures never reach the terminal (they would garble the TUI): they are kept as
      // `lastLifecycleError` in the service status.
      lifecycle: { timeoutMs: () => config.pluginHooks.timeoutMs },
    }),
    mcp = new McpConnector(
      config.mcp.servers,
      registry,
      workspace,
      options.readOnly ? "read-only" : options.allowMcp || mcpAllow ? "allowed" : "disabled",
      config.mcpSources,
    );
  let mcpRuntimePermission: "granted" | "not-granted" | "read-only" = options.readOnly
    ? "read-only"
    : options.allowMcp || mcpAllow
      ? "granted"
      : "not-granted";
  const herdr = options.noHerdr
    ? new HerdrBridge({}, async () => "")
    : HerdrBridge.fromEnvironment(workspace, (error) => process.stderr.write(`${error}\n`));
  // Decision providers and per-plugin directories/options are bound before any plugin loads.
  plugins.setDecisions({
    registry: decisionRegistry,
    service: decisionService,
    activation: {
      config: () => config.decisions,
      // Same atomic, field-preserving GLOBAL writer as `updateSetting("decisions.provider")`;
      // the live config only changes after the write succeeded.
      persist: async (providerId) => {
        if (options.readOnly) throw new Error("Settings changes are unavailable under --read-only");
        await setConfigValue({ key: "decisions.provider", value: providerId });
        config.decisions = { ...config.decisions, provider: providerId };
        decisionService.syncActive();
      },
    },
  });
  const stateRoot = options.db && options.db !== ":memory:" ? dirname(options.db) : stateHome();
  plugins.setPluginEnvironment({
    stateRoot,
    configHome: configHome(),
    options: (id, builtin) => {
      if (builtin) {
        const { enabled: _enabled, ...rest } = config.builtinPlugins[id] ?? {};
        return rest as Record<string, JsonValue>;
      }
      return config.pluginOverrides[id]?.options ?? {};
    },
  });
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
    /**
     * Plugin resources (`api.resources.agents`) register during activation, but the built-in
     * subagents plugin discovers agent files in its own setup, which runs BEFORE external plugins
     * (config, command line, plugin directories) are activated. Re-run its discovery once every
     * plugin has registered, so the first `/api/agents` (web selector and Agents page, TUI cycle)
     * already lists the plugin primary agents instead of waiting for a manual `/agents reload`.
     */
    const rediscoverAgents = plugins.commands.get("agents");
    if (rediscoverAgents) {
      try {
        await rediscoverAgents("reload");
      } catch {
        /* keeps the built-ins: agent discovery is best-effort */
      }
    }
    // Every plugin has registered its providers: start the configured one in the background
    // (`activate` is bounded, never fatal and never awaited here).
    decisionService.syncActive();
    // Project skills follow the config trust model (--trust-project or an explicit --config).
    await skills.discover(
      skillRoots({
        workspace,
        cwd,
        home: homedir(),
        configHome: configHome(),
        trusted: !!options.trustProject || !!options.config,
        configSkills: config.skills,
        pluginRoots: plugins.skillSources,
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
      pathAccess,
    );
    // Python analysis and artifacts live next to the session database (like attachment blobs).
    const artifacts = new ArtifactStore({
      root: stateRoot,
      db: store.db,
      dashboard: config.analysis.smartDashboard,
      limits: {
        maxFiles: config.analysis.limits.maxFiles,
        maxFileBytes: config.analysis.limits.maxFileBytes,
        maxOutputBytes: config.analysis.limits.maxOutputBytes,
      },
    });
    const capabilityGrants = new CapabilityGrants({
      db: store.db,
      rootOf: (id) => store.rootOf(id),
    });
    const analysisRuntime =
      options.analysisRuntime ??
      new AnalysisRuntimeManager({
        stateDir: stateRoot,
        ...(options.python ? { python: options.python } : {}),
      });
    const analysisJobs = new AnalysisJobs({ root: stateRoot, db: store.db });
    // Container mode (`analysis.runtime: "oci"`): read from the live config on every call.
    let ociRuntime: { key: string; runtime: OciRuntime } | undefined;
    const oci = {
      mode: () => config.analysis.runtime,
      runtime: () => {
        const key = JSON.stringify(config.analysis.oci);
        if (ociRuntime?.key !== key)
          ociRuntime = {
            key,
            runtime: new OciRuntime({ ...config.analysis.oci }, options.analysisOci),
          };
        return ociRuntime.runtime;
      },
    };
    // Tabular datasets (one SQLite file each); XLSX needs the discovered Python.
    const datasets = new DatasetService({
      root: stateRoot,
      db: store.db,
      limits: config.analysis.data,
      python: analysisRuntime,
      dashboard: config.analysis.smartDashboard,
    });
    const analysisRerun = new AnalysisRerun({ jobs: analysisJobs, store: artifacts, datasets });
    // Retention: a sweep at most every 24 h, launched in the background after the start.
    const janitor = new AnalysisJanitor({
      root: stateRoot,
      db: store.db,
      artifacts,
      datasets,
      blobs,
      retention: () => config.analysis.retention,
      ...(options.analysisSweepDelayMs !== undefined
        ? { initialDelayMs: options.analysisSweepDelayMs }
        : {}),
    });
    // Background tasks: a service over the shared database (state change = compare-and-set), logs
    // under `<state>/tasks/`. Tasks of a dead owner process (a previous run) become `lost` now.
    const tasks = new BackgroundTasks({
      db: store.db,
      stateRoot,
      rootOf: (id) => store.rootOf(id),
      limits: () => config.tasks,
      readOnly: !!options.readOnly,
      ...(options.tasks?.wake ? { wake: options.tasks.wake } : {}),
      ...(options.tasks?.onChange ? { onChange: options.tasks.onChange } : {}),
      ...(options.tasks?.timing ? { timing: options.tasks.timing } : {}),
      ...(options.tasks?.maxPerProcess ? { maxPerProcess: options.tasks.maxPerProcess } : {}),
      ...(options.tasks?.killGraceMs ? { killGraceMs: options.tasks.killGraceMs } : {}),
      mirror: (root) => subagentTasks(plugins.panels, root),
      onError: (error) =>
        process.stderr.write(
          `Background task error: ${error instanceof Error ? error.message : String(error)}\n`,
        ),
    });
    tasks.recover();
    const taskJanitor = new TaskJanitor({
      store: tasks.store,
      stateRoot,
      retentionDays: () => config.tasks.retentionDays,
      ...(options.tasks?.sweepDelayMs !== undefined
        ? { initialDelayMs: options.tasks.sweepDelayMs }
        : {}),
    });
    if (config.tasks.enabled) {
      const { registerBackgroundTools } = await import("./tools/background.ts");
      registerBackgroundTools(registry, { tasks, rootOf: (id) => store.rootOf(id) });
    }
    // Session goals (`/goal`): one service over the shared database. A goal left `active` by a
    // process that is gone pauses with reason `restart` now (never auto-resumed). The two goal
    // tools are opt-in: a run only sees them while its session has an active goal.
    const goals = new GoalService({
      store: new GoalStore(store.db),
      settings: () => config.goal,
      ...(options.goals?.onChange ? { onChange: options.goals.onChange } : {}),
      ...(options.goals?.onLog ? { onLog: options.goals.onLog } : {}),
    });
    if (options.goals?.recover !== false) goals.recover();
    registerGoalTools(registry, { goals });
    // R4: nothing is registered with analysis disabled or under --read-only. Startup only looks
    // for candidate interpreters with `stat`; no process is launched until the first call.
    const analysisEnabled = config.analysis.enabled && !options.readOnly;
    if (analysisEnabled) {
      const [candidates, active] = await Promise.all([
        analysisRuntime.candidates(),
        analysisRuntime.activeRuntime(),
      ]);
      const { registerAnalysisTools } = await import("./tools/analysis.ts");
      registerAnalysisTools(registry, {
        smartDashboard: config.analysis.smartDashboard,
        store: artifacts,
        jobs: analysisJobs,
        runtime: analysisRuntime,
        datasets,
        oci,
        rerun: analysisRerun,
        rootOf: (id) => store.rootOf(id),
        // Read live: a changed `analysis.limits.*` setting applies to the next call.
        limits: {
          get timeoutMs() {
            return config.analysis.limits.timeoutMs;
          },
          get maxLogBytes() {
            return config.analysis.limits.maxLogBytes;
          },
        },
        startup: { candidates: candidates.length > 0, extras: active?.extras ?? [] },
      });
      const { registerArtifactTools } = await import("./tools/artifacts.ts");
      registerArtifactTools(registry, { store: artifacts, rootOf: (id) => store.rootOf(id) });
      // Publishes artifacts (so it follows `artifact_create`) and needs no Python.
      if (config.analysis.smartDashboard) {
        const { DASHBOARD_PROMPT_RULE, registerDashboardTools } = await import(
          "./tools/dashboard.ts"
        );
        registerDashboardTools(registry, { datasets, rootOf: (id) => store.rootOf(id) });
        // Registered only with the tool: the `false` state keeps the system prompt byte for byte.
        context.extras.push(async () => DASHBOARD_PROMPT_RULE);
      }
    }
    // `exit_plan` (opt-in: only the plan agent's run sees it): the plan review hand-over.
    const { registerExitPlan } = await import("./plan/exit-plan.ts");
    registerExitPlan(registry, {
      store,
      ui: plugins.ui,
      readOnly: !!options.readOnly,
      diagrams: () => ({
        enabled: config.plan.diagrams,
        max: config.plan.diagrams ? config.plan.maxDiagrams : 0,
      }),
    });
    // Data tools only read (effect `read`): they stay available under --read-only.
    if (config.analysis.enabled) {
      const { registerDataTools } = await import("./tools/data.ts");
      registerDataTools(registry, {
        datasets,
        rootOf: (id) => store.rootOf(id),
        smartDashboard: config.analysis.smartDashboard,
      });
    }
    const sessionWorkspace = (sessionId: string) => {
      try {
        return store.get(sessionId).workspace;
      } catch {
        return workspace;
      }
    };
    const { registerPluginInstallTool } = await import("./plugins/install.ts");
    registerPluginInstallTool(registry, { readOnly: !!options.readOnly });
    if ((options.allowMcp || mcpAllow) && !options.readOnly) mcp.register();
    if (options.allowAgents && !options.readOnly) herdr.registerTools(registry);
    const providerSettings = new ProviderSettingsStore();
    const saved = options.provider ? undefined : await providerSettings.active();
    const defaultProvider = (options.builtins ?? []).find((item) => item.defaultProvider);
    const legacyEndpointOverride = overridesSavedProviderProfile(
      configProvenance,
      !!options.baseURL ||
        !!options.apiMode ||
        !!process.env.OPENAI_BASE_URL ||
        !!process.env.ALISIO_API_MODE,
    );
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
    // Lazily (re)loads the active provider's catalog exactly once, so the ACTIVE model's
    // contextWindow becomes known for the context bar without waiting for an explicit
    // /model picker or autocomplete call. Failed or absent discovery stays retryable.
    let modelsLoading: Promise<ModelInfo[]> | undefined;
    const ensureModels = (): Promise<ModelInfo[]> | undefined => {
      if (!provider.listModels || modelsLoading) return modelsLoading;
      modelsLoading = loadModels(AbortSignal.timeout(10_000));
      modelsLoading.catch(() => {
        if (modelsLoading) modelsLoading = undefined;
      });
      return modelsLoading;
    };
    // Priority: explicit configuration for the configured model, then the active saved profile's
    // per-model override (user intent for local servers that omit context_window), then GET /models.
    const contextWindow = (model: string) => {
      const explicit = model === config.provider.model ? config.provider.contextWindow : undefined;
      if (explicit !== undefined) return explicit;
      const override =
        providerInfo?.persisted && model === provider.model
          ? parseProfileContextWindow(providerInfo.profile.contextWindow)
          : undefined;
      if (override !== undefined) return override;
      const known = models.get(model)?.contextWindow;
      if (known !== undefined) return known;
      // Background prime: this call stays synchronous (the runner and the bar are sync), and
      // once the catalog lands the map is populated for every later lookup.
      void ensureModels();
      return undefined;
    };
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
    const runtimePolicy: import("./core/contracts.ts").Policy = {
      write: !!options.allowWrite && !options.readOnly,
      process: !!options.allowProcess && !options.readOnly,
      ...(options.allowAnalysis && !options.readOnly ? { analysis: true } : {}),
      external:
        !options.readOnly &&
        (!!options.allowExternal ||
          !!options.allowMcp ||
          mcpAllow ||
          !!options.allowAgents ||
          plugins.externalCount > 0 ||
          registry.list().some((t) => t.name.startsWith("p_"))),
    };
    /** Model and provider of a session, for the provenance of its artifacts. */
    const provenanceOf = (sessionId: string): Record<string, unknown> => {
      try {
        const session = store.get(sessionId);
        return {
          ...(session.model ? { model: session.model } : {}),
          ...(session.provider ? { provider: session.provider } : {}),
        };
      } catch {
        return {};
      }
    };
    /**
     * The maximum output a model's catalog declares (`ModelInfo.maxOutputTokens`), for the budget
     * of each request. Looks in the active provider's catalog first (loading it once, bounded, if
     * the first request comes before it); then in the catalogs of the configured profiles that
     * were already listed, taking the smallest declaration when several providers list the same
     * model id so a derived budget never exceeds any of them. Unknown stays unknown.
     */
    const declaredOutputLimit = async (model: string): Promise<number | undefined> => {
      if (!models.has(model)) {
        const loading = ensureModels();
        if (loading) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([
            loading.catch(() => undefined),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 2_000);
            }),
          ]);
          if (timer) clearTimeout(timer);
        }
      }
      const own = models.get(model)?.maxOutputTokens;
      if (own !== undefined) return own;
      const declared = catalogCache
        ? availableProviderModels(catalogCache.value)
            .filter((entry) => entry.model.id === model)
            .map((entry) => entry.model.maxOutputTokens)
            .filter((value): value is number => typeof value === "number" && value > 0)
        : [];
      return declared.length ? Math.min(...declared) : undefined;
    };
    plugins.setHumanWaits(humanWaits);
    const runner = new AgentRunner({
      humanWaits,
      provider,
      providerFor,
      registry,
      store,
      context,
      workspace,
      policy: runtimePolicy,
      ...config.limits,
      compaction: config.compaction,
      extensions: plugins,
      contextWindow,
      modelOutputLimit: declaredOutputLimit,
      fallbackMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
      effortLevels: (model: string) => {
        const known = models.get(model)?.effort;
        if (!known) void ensureModels();
        return known;
      },
      ...(options.approve && !options.readOnly ? { approve: options.approve } : {}),
      pathAccess,
      ...(analysisEnabled
        ? {
            capabilities: {
              granted: (capability, sessionId) => capabilityGrants.granted(capability, sessionId),
              record: (input) => {
                capabilityGrants.record({ ...input, workspace: sessionWorkspace(input.sessionId) });
              },
              source: options.approvalSource ?? "tui",
              get runtime() {
                return config.analysis.runtime;
              },
              // A rerun's approval shows the saved script (the input carries only its reference).
              preview: async (input: Record<string, unknown>, sessionId: string) =>
                typeof input.rerunOf === "string"
                  ? analysisRerun.script(input.rerunOf, store.rootOf(sessionId))
                  : undefined,
            },
          }
        : {}),
      decisions: (call, announce) =>
        bindDecisions(decisionService, () => config.decisions.telemetry, call, announce),
      artifacts: (call, announce) =>
        createArtifactPublisher(
          artifacts,
          {
            sessionId: call.sessionId,
            rootSessionId: store.rootOf(call.sessionId),
            workspace: sessionWorkspace(call.sessionId),
            runId: call.runId,
            callId: call.callId,
            // Public provenance of what produced the artifact (no paths, no keys).
            provenance: provenanceOf(call.sessionId),
          },
          announce,
        ),
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
    // Startup reconciliation: runs left queued/running by a dead process become `interrupted`
    // (runs of this process, e.g. another Application in a server, are kept). Child sessions are
    // reconciled by `interruptStale()` in the ChildSessions constructor right below.
    store.interruptRuns();
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
    // Startup auto-connect: when runtime permission is granted (--allow-mcp or global mcp.allow),
    // connect every enabled server exactly like pressing Connect for each. Failures are per-server,
    // sanitized and never fatal to startup.
    const mcpStartupFailures: string[] = [];
    if (mcpRuntimePermission === "granted") {
      for (const [name, server] of Object.entries(config.mcp.servers)) {
        if (!server.enabled) continue;
        try {
          await mcp.connect(name, AbortSignal.timeout(15_000));
        } catch {
          const diagnostic =
            mcp.info(name).diagnostic ??
            "Connection failed; inspect the server separately for details";
          mcpStartupFailures.push(`MCP server "${name}" did not auto-connect: ${diagnostic}`);
        }
      }
    }
    // Retention runs in the background (unreferenced timer); never for in-memory test databases.
    if (analysisEnabled && options.db !== ":memory:") janitor.start();
    // Retention is maintenance that deletes files: never under --read-only, never for `:memory:`.
    if (options.db !== ":memory:" && !options.readOnly) taskJanitor.start();
    return {
      workspace,
      pathAccess,
      config,
      prompts,
      expandPrompt,
      store,
      /** Uploaded attachment bytes; resolve a `BlobRef` with `blobs.attachment(ref)` before a run. */
      blobs,
      /** Published artifacts of every session (folders under `<state>/artifacts`). */
      artifacts,
      /** Persisted capability grants (`analysis.run`) and their audit rows. */
      capabilityGrants,
      /** Background tasks (`bg_*` tools, `/tasks` panels): admission, state, output, stop. */
      tasks,
      /** Session goals (`/goal`): state, user actions, the continuation controller. */
      goals,
      /** Python discovery and job folders of `python_run`; `enabled` is false under --read-only. */
      analysis: {
        enabled: analysisEnabled,
        runtime: analysisRuntime,
        jobs: analysisJobs,
        /** Container runtime of the current configuration (status, pull); mode `managed` ignores it. */
        oci,
        rerun: analysisRerun,
        janitor,
      },
      /** Keys a project layer set that only the user layer decides (ignored on load). */
      configDiagnostics: configProvenance.ignored ?? [],
      /** Tabular datasets of every session (ingestion, read-only queries, pages). */
      datasets,
      registry,
      /** Decision Intelligence: the provider catalog, the service and in-memory metrics. */
      decisions: { registry: decisionRegistry, service: decisionService, metrics: decisionMetrics },
      context,
      skills,
      /** Path- and content-safe metadata for the interactive skills manager. */
      skillCatalog() {
        const pluginStatus = new Map([...pluginCatalog.values()].map((entry) => [entry.id, entry]));
        return skills.catalogEntries().map((skill) => {
          const owner = skill.owner ? pluginStatus.get(skill.owner.id) : undefined;
          return {
            ...skill,
            ...(owner?.status === "restart-required"
              ? { source: "plugin (restart required)" }
              : {}),
          };
        });
      },
      /** Persist a project-local override and apply it to model-visible skills immediately. */
      async setSkillEnabled(id: string, enabled: boolean) {
        const current = skills.catalogEntries().find((skill) => skill.id === id && skill.effective);
        if (!current) throw new Error(`Unknown effective skill: ${id}`);
        if (!current.manageable || current.locked)
          throw new Error("This skill is locked by its plugin; use /plugins to manage the owner");
        await setProjectSkillEnabled({ workspace, id, enabled, trusted: trustedProject });
        return skills.setEnabled(id, enabled);
      },
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
      /** Current-process MCP grant; deliberately independent from persisted server enablement. */
      mcpRuntimePermission() {
        return mcpRuntimePermission;
      },
      /** Whether global MCP consent (`mcp.allow`) is persisted for this user right now. */
      mcpAllowPersisted() {
        return persistedMcpAllow;
      },
      /**
       * Sanitized per-server failures collected while auto-connecting enabled servers at startup
       * (only when runtime permission was granted). Never includes credentials or command paths.
       */
      mcpStartupFailures() {
        return [...mcpStartupFailures];
      },
      /**
       * Host-owned interactive consent boundary: the TUI and the web UI (`alisio serve`, after an
       * explicit confirmation dialog) may grant. Headless callers remain blocked unless flagged.
       */
      grantMcpRuntimePermission(request: {
        source: "interactive-tui" | "interactive-web";
        confirmed: boolean;
      }) {
        if (!request.confirmed) return mcpRuntimePermission;
        if (request.source !== "interactive-tui" && request.source !== "interactive-web")
          throw new Error("MCP runtime permission may only be granted by an interactive UI");
        if (options.readOnly) throw new Error("MCP is unavailable under --read-only");
        if (mcpRuntimePermission === "granted") return mcpRuntimePermission;
        mcp.grantRuntimePermission();
        runtimePolicy.external = true;
        mcpRuntimePermission = "granted";
        return mcpRuntimePermission;
      },
      /** Persist global consent atomically, then grant runtime permission for this process. */
      async rememberGlobalMcpConsent(
        source: "interactive-tui" | "interactive-web" = "interactive-tui",
      ): Promise<void> {
        if (options.readOnly) throw new Error("MCP is unavailable under --read-only");
        await setGlobalMcpAllow({ allow: true });
        persistedMcpAllow = true;
        this.grantMcpRuntimePermission({ source, confirmed: true });
      },
      /**
       * Clear the persisted global consent atomically and drop the runtime permission (disconnecting
       * servers as cleanup does). An explicit this-run `--allow-mcp` flag keeps the grant alive.
       */
      async revokeGlobalMcpConsent(): Promise<void> {
        if (options.readOnly) throw new Error("MCP is unavailable under --read-only");
        await setGlobalMcpAllow({ allow: false });
        persistedMcpAllow = false;
        if (options.allowMcp) return;
        if (mcpRuntimePermission !== "granted") return;
        await mcp.revokeRuntimePermission();
        mcpRuntimePermission = "not-granted";
        runtimePolicy.external =
          !!options.allowExternal ||
          !!options.allowAgents ||
          plugins.externalCount > 0 ||
          registry.list().some((t) => t.name.startsWith("p_"));
      },
      /** Persist an MCP toggle in its defining layer, then safely update this process. */
      async setMcpEnabled(id: string, enabled: boolean, connect = false) {
        if (options.readOnly) throw new Error("MCP changes are unavailable under --read-only");
        const source = config.mcpSources[id];
        if (!source) throw new Error(`Unknown MCP server: ${id}`);
        await setMcpServerEnabled({ source, name: id, enabled });
        await mcp.setEnabled(
          id,
          enabled,
          connect && enabled && mcpRuntimePermission === "granted"
            ? AbortSignal.timeout(15_000)
            : undefined,
        );
        return mcp.info(id);
      },
      /**
       * Persist one user-facing setting to the GLOBAL user config (`<config home>/config.json`)
       * and apply it to this process where the value can change live. Compaction and limits land
       * in the runner (honored by the next run/compact), `context.*` lands in the project context
       * (next instructions load), `websearch.provider` mutates the shared config object the search
       * chain reads per call, `pluginHooks.timeoutMs` lands in the plugin host (next hook call),
       * and `tui.*` is persisted for the host to apply. Nothing in this set requires a restart.
       * `agents.*` (active agent id and reasoning effort) is persisted for the TUI to consume:
       * the next `/agents`/`/effort` selection and the next prompt already read the live config.
       * `mcp.allow` is deliberately not routed here: it flows through
       * `rememberGlobalMcpConsent`/`revokeGlobalMcpConsent` instead.
       * Throws under `--read-only`. Returns the written config file.
       */
      async updateSetting(key: SettableSettingKey, value: unknown): Promise<string> {
        if (options.readOnly) throw new Error("Settings changes are unavailable under --read-only");
        const file = await setConfigValue({ key, value });
        const compactionLeaf = (leaf: string) => ({ [leaf]: value }) as Partial<CompactionSettings>;
        const limitLeaf = (leaf: string) => ({ [leaf]: value }) as RunnerSettingsPatch;
        switch (key) {
          case "compaction.auto":
          case "compaction.threshold":
          case "compaction.keepTurns":
          case "compaction.maxOutputTokens": {
            const patch = compactionLeaf(key.slice("compaction.".length));
            config.compaction = { ...config.compaction, ...patch };
            runner.applySettings({ compaction: patch });
            break;
          }
          case "context.claudeMdFallback":
            config.context = { ...config.context, claudeMdFallback: value === true };
            context.update({ claudeMdFallback: value === true });
            break;
          case "context.maxBytes":
            config.context = { ...config.context, maxBytes: Number(value) };
            context.update({ maxBytes: Number(value) });
            break;
          case "limits.maxTurns":
          case "limits.maxOutputTokens":
          case "limits.maxContextChars":
          case "limits.firstTokenTimeoutMs":
          case "limits.firstTokenRetries":
          case "limits.truncationRecoveries":
          case "limits.timeoutMs": {
            const patch = limitLeaf(key.slice("limits.".length));
            config.limits = { ...config.limits, ...patch };
            runner.applySettings(patch);
            break;
          }
          case "pluginHooks.timeoutMs":
            config.pluginHooks = { ...config.pluginHooks, timeoutMs: Number(value) };
            plugins.applyTimeoutSettings({ hookTimeoutMs: Number(value) });
            break;
          case "pluginHooks.disposeTimeoutMs":
            config.pluginHooks = { ...config.pluginHooks, disposeTimeoutMs: Number(value) };
            plugins.applyTimeoutSettings({ disposeTimeoutMs: Number(value) });
            break;
          case "decisions.enabled":
          case "decisions.telemetry": {
            // Read live by the service on its next call; `enabled` also drives the provider's
            // activate/deactivate lifecycle.
            const leaf = key.slice("decisions.".length);
            config.decisions = { ...config.decisions, [leaf]: value === true };
            decisionService.syncActive();
            break;
          }
          case "decisions.provider":
            // `!clear` (undefined) deactivates the feature.
            config.decisions = {
              ...config.decisions,
              provider: value === undefined || value === null ? null : String(value),
            };
            decisionService.syncActive();
            break;
          case "decisions.timeoutMs":
          case "decisions.minConfidence": {
            const leaf = key.slice("decisions.".length);
            config.decisions = { ...config.decisions, [leaf]: Number(value) };
            break;
          }
          case "tui.paddingX":
            config.tui = { ...config.tui, paddingX: Number(value) };
            break;
          case "tui.contentPaddingX":
            config.tui = { ...config.tui, contentPaddingX: Number(value) };
            break;
          case "tui.skillSlashCommands":
            config.tui = { ...config.tui, skillSlashCommands: value === true };
            break;
          case "agents.active":
            config.agents = { ...config.agents, active: String(value) };
            break;
          case "agents.effort":
            // Clearing (undefined) drops the leaf from the live config and the JSON file.
            config.agents =
              value === undefined
                ? { active: config.agents.active }
                : { ...config.agents, effort: String(value) };
            break;
          case "analysis.enabled":
            // Tools are registered when the application starts: the change applies to the next
            // application (a restart; the web recycles the workspace application).
            config.analysis = { ...config.analysis, enabled: value === true };
            break;
          case "analysis.smartDashboard":
            // Like `analysis.enabled`: the tool is registered when the application starts.
            config.analysis = { ...config.analysis, smartDashboard: value === true };
            break;
          case "analysis.limits.timeoutMs":
            // Read live by python_run on its next call.
            config.analysis = {
              ...config.analysis,
              limits: { ...config.analysis.limits, timeoutMs: Number(value) },
            };
            break;
          case "analysis.retention.jobsDays":
          case "analysis.retention.intermediateDays":
          case "analysis.retention.artifactsDays": {
            // Read by the next sweep.
            const leaf = key.slice("analysis.retention.".length);
            config.analysis = {
              ...config.analysis,
              retention: { ...config.analysis.retention, [leaf]: Number(value) },
            };
            break;
          }
          case "goal.enabled":
          case "goal.maxTurns":
          case "goal.maxMinutes":
          case "goal.repeatedReplyLimit":
          case "goal.noToolTurnsLimit":
          case "goal.blockedRepeats": {
            // Read live: the next continuation (or the next `/goal`) uses the new value. The caps
            // of a goal already running were snapshotted when it was created.
            const leaf = key.slice("goal.".length);
            config.goal = {
              ...config.goal,
              [leaf]: leaf === "enabled" ? value === true : Number(value),
            };
            break;
          }
          case "plan.diagrams":
            // Read live: `exit_plan` offers (or hides) its `diagrams` field on the next request.
            config.plan = { ...config.plan, diagrams: value === true };
            break;
          case "plan.maxDiagrams":
            config.plan = { ...config.plan, maxDiagrams: Number(value) };
            break;
          case "tasks.enabled":
            // Tools are registered when the application starts: the change applies to the next
            // application (a restart; the web recycles the workspace application).
            config.tasks = { ...config.tasks, enabled: value === true };
            break;
          case "tasks.maxPerSession":
          case "tasks.maxRunMs":
          case "tasks.maxOutputBytes":
          case "tasks.retentionDays": {
            // Read live: the next task (or the next sweep) uses the new value.
            const leaf = key.slice("tasks.".length);
            config.tasks = { ...config.tasks, [leaf]: Number(value) };
            break;
          }
          case "web.iconTheme":
            // Read live by the icon-theme routes on the next request; `"none"` clears the theme.
            config.web = { ...config.web, iconTheme: String(value) };
            break;
          case "websearch.provider":
            // Mutated in place (same object identity) so the tool chain's per-call
            // `websearchCtx.config` sees the new provider on the very next search call.
            config.websearch.provider =
              value === undefined ? undefined : (value as typeof config.websearch.provider);
            break;
        }
        return file;
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
      /** `/btw` side questions: tool-less answers about a session outside its conversation. */
      sideQuestions: new SideQuestions({ runner, state: store }),
      /**
       * User agent files (`<workspace>/.agents/agents`, `~/.agents/agents`). Every write asks the
       * subagents plugin (the runtime agent registry) to rediscover through its `/agents reload`
       * verb and reports whether the saved file is loaded; without the plugin nothing reloads.
       */
      agentDefinitions: new AgentDefinitionService({
        workspace,
        home: homedir(),
        registry: {
          async reload() {
            const handler = plugins.commands.get("agents");
            if (!handler) return false;
            await handler("reload");
            return Array.isArray(plugins.pluginState("subagents", "definitions"));
          },
          loadedPaths() {
            let state: unknown;
            try {
              state = plugins.pluginState("subagents", "definitions");
            } catch {
              return undefined;
            }
            if (!Array.isArray(state)) return undefined;
            return state
              .map((entry) => (entry as { path?: unknown })?.path)
              .filter((path): path is string => typeof path === "string");
          },
        },
      }),
      herdr,
      contextWindow,
      /** Effective context budget + compaction point shared by the runner and the TUI bar. */
      contextBudget: (model: string) => runner.contextBudget(model),
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
          modelsLoading = undefined;
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
        // Exit latency is user-facing: tear down herdr + MCP in parallel, then provider +
        // plugins (store last). Every stage is raced against a cap so a single hanging
        // component cannot stall /exit; teardown errors are swallowed for callers.
        const capped = (work: Promise<unknown>) =>
          Promise.race([work.catch(() => {}), delay(TEARDOWN_STAGE_TIMEOUT_MS)]);
        try {
          janitor.stop();
          taskJanitor.stop();
          datasets?.close();
          // Tasks first in the same stage: they end with Alisio (process groups killed).
          await capped(Promise.allSettled([herdr.close(), mcp.close(), tasks.close()]));
        } finally {
          try {
            await capped(
              (async () => {
                const runtimes = new Set([
                  ...(await Promise.allSettled(targetProviders.values()))
                    .filter(
                      (x): x is PromiseFulfilledResult<ModelProvider> => x.status === "fulfilled",
                    )
                    .map((x) => x.value),
                  ...retainedProviders,
                ]);
                await Promise.allSettled([
                  provider.dispose(),
                  ...[...runtimes]
                    .filter((runtime) => runtime !== provider.currentProvider)
                    .map((runtime) => Promise.resolve(runtime.dispose?.())),
                  // The active decision provider stops first (its own limit), then every plugin
                  // is disposed in parallel, each bounded by `pluginHooks.disposeTimeoutMs`.
                  decisionService
                    .shutdown(config.pluginHooks.disposeTimeoutMs)
                    .then(() => plugins.close()),
                ]);
              })(),
            );
          } finally {
            store.close();
          }
        }
      },
    };
  } catch (e) {
    await Promise.race([
      Promise.allSettled([
        herdr.close(),
        mcp.close(),
        decisionService.shutdown(config.pluginHooks.disposeTimeoutMs).then(() => plugins.close()),
      ]),
      delay(TEARDOWN_STAGE_TIMEOUT_MS),
    ]);
    store.close();
    throw e;
  }
}
