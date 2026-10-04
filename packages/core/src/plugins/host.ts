import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  CommandContext,
  CommandOptions,
  CompactionHooks,
  CompletionRequest,
  DecisionActivationOptions,
  ExtensionPoints,
  JsonValue,
  Message,
  PanelProvider,
  Plugin,
  PluginAPI,
  PluginMetadata,
  RunEvent,
  SelectRequest,
  SessionInfo,
  ToolContext,
  ViewContext,
  ViewDefinition,
} from "@alisio/sdk";
import Ajv, { type ValidateFunction } from "ajv";
import { z } from "zod";
import type { HookFailure, RunnerExtensions } from "../core/contracts.ts";
import type { HumanWaits } from "../core/human-wait.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { requestDecisionActivation } from "../decisions/activation.ts";
import type { DecisionRegistry } from "../decisions/registry.ts";
import type { DecisionService, DecisionsConfig } from "../decisions/service.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { exists, readJson } from "../runtime/fs.ts";
import { resolvePluginSpec } from "../runtime/modules.ts";
import { inside } from "../runtime/paths.ts";
import { openDatabase } from "../runtime/sqlite.ts";
export const pluginPrefix = (id: string) =>
  `p_${createHash("sha256").update(id).digest("hex").slice(0, 10)}`;
type StartHandler = (info: SessionInfo) => Promise<string | undefined | void>;
type EndHandler = (info: SessionInfo) => Promise<void>;
export interface PluginHostOptions {
  /** Timeout for compaction and session-start hooks. */
  hookTimeoutMs?: number;
  /** Timeout for session-end hooks (for example an automatic summary). */
  sessionEndTimeoutMs?: number;
  /** Per-plugin limit for `dispose()` on close (default 2000 ms). */
  disposeTimeoutMs?: number;
}
/** What the host needs to hand each plugin its `api.paths` and `api.options`. */
export interface PluginEnvironment {
  /** Root of the application state (the one analysis and artifacts use). */
  stateRoot: string;
  configHome: string;
  /** `pluginOverrides[id].options` (external) or `builtinPlugins.<id>` without `enabled`. */
  options(id: string, builtin: boolean): Record<string, JsonValue>;
}
const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
};
const VIEW_ID = /^[a-z][a-z0-9-]{0,39}$/;
const VIEW_PARAM_TYPES = new Set(["string", "integer", "number", "boolean"]);
/** Query strings arrive as text: coerce them to the declared primitives and apply defaults. */
const viewAjv = new Ajv({ allErrors: true, strict: true, coerceTypes: true, useDefaults: true });
const rejectSchemaReferences = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["$ref", "$id", "$async"].includes(key))
      throw new Error(`Schema keyword ${key} is not supported`);
    rejectSchemaReferences(child);
  }
};
/** A failed data view: the host maps `code` to an API error (never echoing parameter values). */
export class ViewRunError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_params" | "failed",
    message: string,
    readonly fields: string[] = [],
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "ViewRunError";
  }
}
export interface ViewInfo {
  id: string;
  description: string;
  params: Record<string, unknown>;
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
export class PluginHost implements RunnerExtensions {
  commands = new Map<string, (args: string, context?: CommandContext) => Promise<string>>();
  commandInfo = new Map<string, CommandOptions & { plugin: string; builtin: boolean }>();
  /** Ids of active built-in plugins. */
  builtins = new Set<string>();
  /** Status entries contributed through `ui.status`, keyed `plugin:key`. */
  status = new Map<string, { plugin: string; text: string; detail?: string }>();
  onStatusChange?: () => void;
  /** Providers for typed extension points (mascot, startup-screen, ...). */
  readonly extensions = new ExtensionRegistry();
  /** Loaded plugins that did not come from the built-in registry. */
  externalCount = 0;
  private compactionHooks: Array<{ plugin: string; hooks: CompactionHooks }> = [];
  private startHandlers: Array<{ plugin: string; handler: StartHandler }> = [];
  private endHandlers: Array<{ plugin: string; handler: EndHandler }> = [];
  private fieldOwners = new Map<string, Map<string, string>>();
  /** Registered tool name → contributing plugin id. */
  private toolOwners = new Map<string, string>();
  private completer?: (request: CompletionRequest & { signal: AbortSignal }) => Promise<string>;
  private modelsImpl?: PluginAPI["models"];
  observers = new Set<(event: Readonly<RunEvent>) => void>();
  contexts: Array<() => Promise<string>> = [];
  /** Skill directories registered by plugins, retaining trusted registration ownership. */
  skillSources: Array<{ plugin: string; name: string; dir: string }> = [];
  /** Prompt template directories registered by plugins, with their plugin id. */
  promptSources: Array<{ plugin: string; dir: string }> = [];
  /** Agent definition directories registered by plugins, with their plugin id. */
  agentSources: Array<{ plugin: string; dir: string }> = [];
  /** Read-only data views contributed by plugins, keyed `plugin:view`. */
  private views = new Map<
    string,
    {
      plugin: string;
      view: ViewDefinition;
      schema: Record<string, unknown>;
      validate: ValidateFunction;
    }
  >();
  /** Tree panels contributed by plugins, keyed `plugin:id`. */
  panels = new Map<string, { plugin: string; provider: PanelProvider }>();
  private sessionsImpl?: PluginAPI["sessions"];
  private uiImpl?: {
    select(request: SelectRequest): Promise<string | undefined>;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
    open(sessionId: string): boolean;
  };
  /** Binds the child session service once the runner exists. */
  setSessions(sessions: PluginAPI["sessions"]) {
    this.sessionsImpl = sessions;
  }
  /** Where waits for a person are opened (see `HumanWaits`); bound once the runner exists. */
  private humanWaits?: HumanWaits;
  setHumanWaits(waits: HumanWaits) {
    this.humanWaits = waits;
  }
  /**
   * Binds interactive UI services (the TUI, the web server); without them select/askQuestions
   * resolve undefined. Every question that reaches the person through here (plugins, the
   * `ask_user_question` tool, the plan review) is a human wait: the bound UI is wrapped ONCE so no
   * host and no caller can forget to mark it.
   */
  setInteractiveUI(ui: {
    select(request: SelectRequest): Promise<string | undefined>;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
    open(sessionId: string): boolean;
  }) {
    const wait = <T>(session: string | undefined, ask: () => Promise<T>): Promise<T> =>
      this.humanWaits ? this.humanWaits.track(session, ask) : ask();
    this.uiImpl = {
      select: (request) => wait(undefined, () => ui.select(request)),
      askQuestions: (request) => wait(request.session, () => ui.askQuestions(request)),
      open: (sessionId) => ui.open(sessionId),
    };
  }
  /**
   * Read-only view of one plugin's shared state (written through `api.state.set`). The host layer
   * uses this to consume plugin-published data (for example the main-capable agent definitions the
   * built-in subagents plugin publishes) without importing the plugin package.
   */
  pluginState(plugin: string, key: string): unknown {
    return this.state.getState(plugin, key);
  }
  get sessions(): PluginAPI["sessions"] {
    if (!this.sessionsImpl) throw new Error("Child sessions are not available yet");
    return this.sessionsImpl;
  }
  /**
   * Live accessor for core standard tools (e.g. `ask_user_question`), which are not "a plugin"
   * with an id and so cannot use the per-plugin `ui` wrapper built in `activate()`. Bound lazily
   * (reads `this.uiImpl` at call time) since `registerStandard` runs before the TUI calls
   * `setInteractiveUI`. `interactive()` reflects whether ANY interactive UI is bound at all,
   * never which session is asking, so child sessions under an interactive root TUI pass too.
   */
  get ui(): {
    interactive(): boolean;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
  } {
    return {
      interactive: () => !!this.uiImpl,
      askQuestions: (request) =>
        this.uiImpl
          ? this.uiImpl.askQuestions(request)
          : Promise.resolve(Object.fromEntries(request.questions.map((q) => [q.id, undefined]))),
    };
  }
  get promptRoots(): string[] {
    return this.promptSources.map((s) => s.dir);
  }
  get skillRoots(): string[] {
    return this.skillSources.map((source) => source.dir);
  }
  private loaded = new Map<string, { plugin: Plugin; undo: Array<() => void>; builtin: boolean }>();
  constructor(
    private registry: ToolRegistry,
    private state: {
      getState(plugin: string, key: string): unknown;
      setState(plugin: string, key: string, value: unknown): void;
    },
    private options: PluginHostOptions = {},
    private providers?: ProviderRegistry,
  ) {}
  /**
   * Live-update host-enforced hook timeouts so the NEXT hook call honors them without restarting.
   * Keeps the same options object reference the constructors of new hooks read at call time.
   */
  applyTimeoutSettings(patch: Partial<PluginHostOptions>): void {
    this.options = { ...this.options, ...patch };
  }
  /** Binds the provider-agnostic completion service once a provider exists. */
  setCompleter(fn: (request: CompletionRequest & { signal: AbortSignal }) => Promise<string>) {
    this.completer = fn;
  }
  /**
   * Binds Decision Intelligence. Plugins activated afterwards see `api.decisions`; without it the
   * member is absent, exactly like on a core that predates the feature.
   */
  setDecisions(decisions: {
    registry: DecisionRegistry;
    service: DecisionService;
    /**
     * Enables the optional `api.decisions.activate`: the live decisions config and the global,
     * atomic persistence of `decisions.provider`. Without it the member is absent.
     */
    activation?: { config: () => DecisionsConfig; persist: (providerId: string) => Promise<void> };
  }) {
    this.decisionsImpl = decisions;
  }
  private decisionsImpl?: {
    registry: DecisionRegistry;
    service: DecisionService;
    activation?: { config: () => DecisionsConfig; persist: (providerId: string) => Promise<void> };
  };
  /**
   * Binds the directories and options plugins receive (`api.paths`, `api.options`). Plugins
   * activated before this call, or on a host without it, see neither member.
   */
  setPluginEnvironment(environment: PluginEnvironment) {
    this.environment = environment;
  }
  private environment?: PluginEnvironment;
  /** Binds credential-free model discovery/resolution after provider startup is complete. */
  setModels(models: PluginAPI["models"]) {
    this.modelsImpl = models;
  }
  /**
   * Loads an explicitly trusted plugin: a file/directory path, or an npm package name resolved
   * from `from` (project) upwards and then global roots. Never called for untrusted input.
   */
  async load(spec: string, options: { from?: string; globalRoots?: string[] } = {}): Promise<void> {
    const candidate = await this.inspect(spec, options);
    await this.activate(candidate.plugin, candidate.base);
  }
  /** Imports and validates a trusted plugin without running setup, for cataloging disabled entries. */
  async inspect(
    spec: string,
    options: { from?: string; globalRoots?: string[] } = {},
  ): Promise<{ plugin: Plugin; base: string }> {
    let path = await resolvePluginSpec(spec, {
      from: options.from ?? process.cwd(),
      ...(options.globalRoots ? { globalRoots: options.globalRoots } : {}),
    });
    if ((await stat(path)).isDirectory()) {
      const manifest = z
        .object({ entry: z.string(), apiVersion: z.literal(1) })
        .passthrough()
        .parse(await readJson(join(path, "alisio-plugin.json")));
      const entry = resolve(path, manifest.entry);
      if (!inside(path, entry)) throw new Error("Plugin entry escapes directory");
      path = entry;
    }
    // Caller must explicitly trust before import: module evaluation executes arbitrary code.
    let module: { default?: unknown };
    try {
      module = await import(pathToFileURL(path).href);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ERR_UNKNOWN_FILE_EXTENSION")
        throw new Error(
          `Cannot load ${path}: TypeScript plugins need Bun or Node >=22.18 (type stripping); publish plugins as JavaScript.`,
        );
      throw error;
    }
    const plugin = module.default as Plugin;
    this.validate(plugin);
    return { plugin, base: dirname(path) };
  }
  private validate(plugin: Plugin): void {
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
      version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
      apiVersion: z.literal(1),
      name: z.string().min(1).optional(),
      description: z.string().min(1).optional(),
      categories: z
        .array(
          z.enum([
            "model-provider",
            "methodology-harness",
            "memory",
            "subagents",
            "search",
            "tools",
            "security",
            "analytics",
            "mcp",
            "storage",
            "ui",
            "decisions",
          ]),
        )
        .optional(),
      setup: z.function(),
    })
      .passthrough()
      .parse(plugin);
  }
  /**
   * `builtin` is reserved for first-party plugins from the built-in registry: their tools and
   * commands keep unprefixed names and may declare the `internal` effect.
   */
  async activate(plugin: Plugin, base: string, options: { builtin?: boolean } = {}): Promise<void> {
    const builtin = !!options.builtin;
    this.validate(plugin);
    if (this.loaded.has(plugin.id)) throw new Error(`Duplicate plugin: ${plugin.id}`);
    const undo: Array<() => void> = [];
    const statusKeys = new Set<string>();
    const track = (fn: () => void) => {
      undo.push(fn);
      return fn;
    };
    const api: PluginAPI = {
      tools: {
        register: (tool) => {
          const registered = builtin
            ? tool
            : (() => {
                // Only built-ins may claim the always-allowed internal effect, a capability
                // (finer than the effect) or the artifact publisher (decision D12, v1).
                const { capability: _capability, ...rest } = tool;
                return {
                  ...rest,
                  name: `${pluginPrefix(plugin.id)}_${tool.name}`,
                  ...(tool.effect === "internal" ? { effect: "external" as const } : {}),
                  execute: (input: Record<string, unknown>, context: ToolContext) => {
                    const {
                      artifacts: _artifacts,
                      approveInstall: _install,
                      ...narrowed
                    } = context;
                    return tool.execute(input, narrowed);
                  },
                };
              })();
          const unregister = this.registry.register(registered);
          this.toolOwners.set(registered.name, plugin.id);
          return track(() => {
            unregister();
            this.toolOwners.delete(registered.name);
          });
        },
      },
      commands: {
        register: (name, handler, info) => {
          const key = builtin ? name : `${plugin.id}:${name}`;
          if (this.commands.has(key)) throw new Error(`Duplicate command ${key}`);
          this.commands.set(key, handler);
          this.commandInfo.set(key, { ...info, plugin: plugin.id, builtin });
          return track(() => {
            this.commands.delete(key);
            this.commandInfo.delete(key);
          });
        },
      },
      events: {
        on: (handler) => {
          this.observers.add(handler);
          return track(() => {
            this.observers.delete(handler);
          });
        },
      },
      context: {
        register: (provider) => {
          this.contexts.push(provider);
          return track(() => {
            const i = this.contexts.indexOf(provider);
            if (i >= 0) this.contexts.splice(i, 1);
          });
        },
      },
      resources: {
        skills: (path) => {
          const entry = {
            plugin: plugin.id,
            name: plugin.name ?? plugin.id,
            dir: resolve(base, path),
          };
          this.skillSources.push(entry);
          track(() => {
            this.skillSources = this.skillSources.filter((x) => x !== entry);
          });
        },
        prompts: (path) => {
          const entry = { plugin: plugin.id, dir: resolve(base, path) };
          this.promptSources.push(entry);
          track(() => {
            this.promptSources = this.promptSources.filter((x) => x !== entry);
          });
        },
        agents: (path) => {
          const entry = { plugin: plugin.id, dir: resolve(base, path) };
          this.agentSources.push(entry);
          track(() => {
            this.agentSources = this.agentSources.filter((x) => x !== entry);
          });
        },
        list: (kind) =>
          (kind === "skills"
            ? this.skillSources
            : kind === "prompts"
              ? this.promptSources
              : this.agentSources
          ).map((x) => ({ ...x })),
      },
      state: {
        get: (key) => this.state.getState(plugin.id, key),
        set: (key, value) => this.state.setState(plugin.id, key, value),
      },
      storage: {
        sqlite: (file) => {
          const db = openDatabase(file);
          track(() => {
            try {
              db.close();
            } catch {
              /* Already closed by the plugin. */
            }
          });
          return db;
        },
      },
      views: {
        register: (view) => {
          if (!VIEW_ID.test(view.id)) throw new Error(`Invalid view id: ${view.id}`);
          if (typeof view.description !== "string" || !view.description.trim())
            throw new Error("A view needs a description");
          if (typeof view.handler !== "function") throw new Error("A view needs a handler");
          const key = `${plugin.id}:${view.id}`;
          if (this.views.has(key)) throw new Error(`Duplicate view ${key}`);
          const declared = view.params ?? { type: "object", properties: {} };
          if (declared.type !== "object") throw new Error("View params must be an object schema");
          rejectSchemaReferences(declared);
          const properties = (declared.properties ?? {}) as Record<string, { type?: unknown }>;
          for (const [name, spec] of Object.entries(properties))
            if (typeof spec?.type !== "string" || !VIEW_PARAM_TYPES.has(spec.type))
              throw new Error(`View param ${name} must be a string, integer, number or boolean`);
          const schema = { ...declared, additionalProperties: false };
          const entry = { plugin: plugin.id, view, schema, validate: viewAjv.compile(schema) };
          this.views.set(key, entry);
          return track(() => {
            if (this.views.get(key) === entry) this.views.delete(key);
          });
        },
      },
      ...(this.environment
        ? (({ stateRoot, configHome, options }) => {
            // The id is validated (`^[a-z0-9][a-z0-9.-]{0,63}$`): it cannot be `.`/`..` or hold a
            // separator, so these stay inside their roots. Created 0700 on first read.
            const state = join(stateRoot, "plugins", plugin.id);
            const directories = {
              state,
              config: join(configHome, "plugins", plugin.id),
              cache: join(state, "cache"),
            };
            const paths = {} as { state: string; config: string; cache: string };
            for (const key of ["state", "config", "cache"] as const)
              Object.defineProperty(paths, key, {
                enumerable: true,
                get: () => {
                  mkdirSync(directories[key], { recursive: true, mode: 0o700 });
                  return directories[key];
                },
              });
            return {
              paths: Object.freeze(paths),
              options: deepFreeze(structuredClone(options(plugin.id, builtin))),
            };
          })(this.environment)
        : {}),
      ...(this.decisionsImpl
        ? {
            decisions: (({ registry, service, activation }) => ({
              // Registering never activates: `decisions.provider` in the configuration does.
              registerProvider: (provider) => track(registry.register(plugin.id, provider)),
              available: () => service.available(),
              activeProvider: () => service.activeProvider(),
              tryDecide: (request, options) => service.tryDecide(request, options),
              ...(activation
                ? {
                    // Only providers THIS plugin registered; the user confirms once.
                    activate: (providerId: string, options?: DecisionActivationOptions) =>
                      requestDecisionActivation(
                        plugin.id,
                        providerId,
                        {
                          registry,
                          config: activation.config,
                          interactive: () => !!this.uiImpl,
                          ask: (request) =>
                            this.uiImpl ? this.uiImpl.askQuestions(request) : Promise.resolve({}),
                          persist: activation.persist,
                        },
                        options,
                      ),
                  }
                : {}),
            }))(this.decisionsImpl) satisfies PluginAPI["decisions"],
          }
        : {}),
      compaction: {
        register: (hooks) => {
          const entry = { plugin: plugin.id, hooks };
          this.compactionHooks.push(entry);
          return track(() => {
            this.compactionHooks = this.compactionHooks.filter((x) => x !== entry);
          });
        },
      },
      session: {
        onStart: (handler) => {
          const entry = { plugin: plugin.id, handler };
          this.startHandlers.push(entry);
          return track(() => {
            this.startHandlers = this.startHandlers.filter((x) => x !== entry);
          });
        },
        onEnd: (handler) => {
          const entry = { plugin: plugin.id, handler };
          this.endHandlers.push(entry);
          return track(() => {
            this.endHandlers = this.endHandlers.filter((x) => x !== entry);
          });
        },
      },
      model: {
        complete: async (request) => {
          if (!this.completer) throw new Error("Model completion is not available yet");
          const timeout = AbortSignal.timeout(120_000);
          return this.completer({
            ...request,
            signal: request.signal ? AbortSignal.any([request.signal, timeout]) : timeout,
          });
        },
      },
      models: {
        list: (signal) => {
          if (!this.modelsImpl) throw new Error("Model resolution is not available yet");
          return this.modelsImpl.list(signal);
        },
        resolve: (reference, signal) => {
          if (!this.modelsImpl) throw new Error("Model resolution is not available yet");
          return this.modelsImpl.resolve(reference, signal);
        },
      },
      providers: {
        register: (provider) => {
          if (!this.providers) throw new Error("Provider registry is not available");
          return track(this.providers.register(provider, { plugin: plugin.id, builtin }));
        },
      },
      extensions: {
        register: (point, provider, options) =>
          track(
            this.extensions.register(point, provider, {
              plugin: plugin.id,
              ...(options?.priority !== undefined ? { priority: options.priority } : {}),
            }),
          ),
      },
      sessions: {
        spawn: (spec) => this.sessions.spawn(spec),
        create: (spec) => this.sessions.create(spec),
        run: (id, prompt, options) => this.sessions.run(id, prompt, options),
        get: (id) => this.sessions.get(id),
        children: (parentId) => this.sessions.children(parentId),
        ancestors: (id) => this.sessions.ancestors(id),
        cancel: (id) => this.sessions.cancel(id),
        enqueue: (id, text) => this.sessions.enqueue(id, text),
        isRunning: (id) => this.sessions.isRunning(id),
        capabilities: (id) => this.sessions.capabilities(id),
        model: (id) => this.sessions.model(id),
        workspace: (id) => this.sessions.workspace(id),
        setStatus: (id, status) => this.sessions.setStatus(id, status),
      },
      ui: {
        panel: (id, provider) => {
          const key = `${plugin.id}:${id}`;
          this.panels.set(key, { plugin: plugin.id, provider });
          return track(() => {
            this.panels.delete(key);
          });
        },
        select: async (request) => (this.uiImpl ? this.uiImpl.select(request) : undefined),
        askQuestions: async (request) =>
          this.uiImpl
            ? this.uiImpl.askQuestions(request)
            : Object.fromEntries(request.questions.map((q) => [q.id, undefined])),
        open: (sessionId) => this.uiImpl?.open(sessionId) ?? false,
        interactive: () => !!this.uiImpl,
        status: (key, text, detail) => {
          const id = `${plugin.id}:${key}`;
          if (text === undefined) this.status.delete(id);
          else this.status.set(id, { plugin: plugin.id, text, ...(detail ? { detail } : {}) });
          if (!statusKeys.has(id)) {
            statusKeys.add(id);
            track(() => {
              this.status.delete(id);
            });
          }
          try {
            this.onStatusChange?.();
          } catch {
            /* UI observers cannot break plugins. */
          }
        },
      },
    };
    try {
      // Declarative sugar: `extensions: { mascot, "startup-screen" }` registers at priority 0.
      for (const [point, provider] of Object.entries(plugin.extensions ?? {}))
        if (provider) api.extensions.register(point as keyof ExtensionPoints, provider as never);
      await plugin.setup(api);
      this.loaded.set(plugin.id, { plugin, undo, builtin });
      if (builtin) this.builtins.add(plugin.id);
      else this.externalCount++;
    } catch (error) {
      for (const fn of undo.reverse()) fn();
      await plugin.dispose?.();
      throw error;
    }
  }
  /** Runs one hook with a host-enforced timeout; the hook receives an abort signal. */
  private async guarded<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const error = new Error(`Timed out after ${ms}ms`);
        controller.abort(error);
        reject(error);
      }, ms);
    });
    try {
      return await Promise.race([run(controller.signal), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  async beforeCompact(input: Parameters<RunnerExtensions["beforeCompact"]>[0]) {
    const instructions: string[] = [];
    const fields: Record<string, { source: string; description: string }> = {};
    const failures: HookFailure[] = [];
    const owners = new Map<string, string>();
    for (const { plugin, hooks } of this.compactionHooks) {
      if (!hooks.beforeCompact) continue;
      try {
        const result = await this.guarded(this.options.hookTimeoutMs ?? 15_000, (signal) =>
          Promise.resolve(hooks.beforeCompact?.({ ...input, signal })),
        );
        if (result?.instructions) instructions.push(result.instructions);
        for (const [name, description] of Object.entries(result?.outputFields ?? {})) {
          if (name === "checkpoint" || fields[name] || !/^[a-zA-Z][\w]{0,40}$/.test(name)) {
            failures.push({
              source: plugin,
              hook: "beforeCompact",
              error: `Output field rejected: ${name}`,
            });
            continue;
          }
          fields[name] = { source: plugin, description };
          owners.set(name, plugin);
        }
      } catch (error) {
        failures.push({ source: plugin, hook: "beforeCompact", error: message(error) });
      }
    }
    this.fieldOwners.set(input.sessionId, owners);
    return { instructions, fields, failures };
  }
  async afterCompact(input: Parameters<RunnerExtensions["afterCompact"]>[0]) {
    const inject: string[] = [];
    const reports: Record<string, Record<string, unknown>> = {};
    const failures: HookFailure[] = [];
    const owners = this.fieldOwners.get(input.sessionId) ?? new Map<string, string>();
    this.fieldOwners.delete(input.sessionId);
    for (const { plugin, hooks } of this.compactionHooks) {
      if (!hooks.afterCompact) continue;
      const extracted = Object.fromEntries(
        Object.entries(input.extracted).filter(([name]) => owners.get(name) === plugin),
      );
      try {
        const result = await this.guarded(this.options.hookTimeoutMs ?? 15_000, (signal) =>
          Promise.resolve(hooks.afterCompact?.({ ...input, extracted, signal })),
        );
        if (result?.injectContext?.trim()) inject.push(result.injectContext);
        if (result?.report) reports[plugin] = result.report;
      } catch (error) {
        failures.push({ source: plugin, hook: "afterCompact", error: message(error) });
      }
    }
    return { inject, reports, failures };
  }
  async sessionStart(input: Parameters<RunnerExtensions["sessionStart"]>[0]) {
    const inject: Array<{ source: string; text: string }> = [];
    const failures: HookFailure[] = [];
    for (const { plugin, handler } of this.startHandlers) {
      try {
        const text = await this.guarded(this.options.hookTimeoutMs ?? 15_000, (signal) =>
          handler({ ...input, reason: "start", messages: [], signal }),
        );
        if (typeof text === "string" && text.trim()) inject.push({ source: plugin, text });
      } catch (error) {
        failures.push({ source: plugin, hook: "sessionStart", error: message(error) });
      }
    }
    return { inject, failures };
  }
  /** Session end hooks run concurrently and are bounded by one host timeout. */
  async sessionEnd(input: {
    sessionId: string;
    model: string;
    workspace: string;
    reason: "clear" | "exit";
    messages: readonly Message[];
  }): Promise<{ failures: HookFailure[] }> {
    const failures: HookFailure[] = [];
    await Promise.all(
      this.endHandlers.map(async ({ plugin, handler }) => {
        try {
          await this.guarded(this.options.sessionEndTimeoutMs ?? 10_000, (signal) =>
            handler({ ...input, signal }),
          );
        } catch (error) {
          failures.push({ source: plugin, hook: "sessionEnd", error: message(error) });
        }
      }),
    );
    return { failures };
  }
  /** Loaded plugins (id, version, built-in flag), ordered by id. */
  metadata(): PluginMetadata[] {
    return [...this.loaded.values()]
      .map(({ plugin, builtin }) => ({
        id: plugin.id,
        version: plugin.version,
        builtin,
        ...(plugin.name ? { name: plugin.name } : {}),
        ...(plugin.description ? { description: plugin.description } : {}),
        ...((plugin.categories?.length ?? 0) > 0 ||
        this.providers?.list().some((provider) => provider.plugin === plugin.id)
          ? {
              categories: [
                ...new Set([
                  ...(plugin.categories ?? []),
                  ...(this.providers?.list().some((provider) => provider.plugin === plugin.id)
                    ? (["model-provider"] as const)
                    : []),
                ]),
              ],
            }
          : {}),
      }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /** Data views a plugin registered (without their handlers). */
  viewsOf(plugin: string): ViewInfo[] {
    return [...this.views.values()]
      .filter((entry) => entry.plugin === plugin)
      .map(({ view, schema }) => ({ id: view.id, description: view.description, params: schema }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
  /**
   * Validates `query` against the view's declared schema (coerced from strings) and runs it.
   * Timeouts and response caps are the caller's job (the server enforces both). Errors are
   * `ViewRunError`s whose messages never include parameter values or handler internals.
   */
  async runView(
    plugin: string,
    id: string,
    query: Record<string, string>,
    context: ViewContext,
  ): Promise<unknown> {
    const entry = this.views.get(`${plugin}:${id}`);
    if (!entry) throw new ViewRunError("not_found", "View not found");
    const params: Record<string, unknown> = { ...query };
    if (!entry.validate(params)) {
      const fields = [
        ...new Set(
          (entry.validate.errors ?? []).map((error) => {
            const p = error.params as { additionalProperty?: string; missingProperty?: string };
            return (
              p.additionalProperty ?? p.missingProperty ?? error.instancePath.replace(/^\//, "")
            );
          }),
        ),
      ].filter(Boolean);
      throw new ViewRunError("invalid_params", "Invalid view parameters", fields);
    }
    try {
      return await entry.view.handler(params, context);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "view_invalid_params")
        throw new ViewRunError("invalid_params", message(error), [], { cause: error });
      throw new ViewRunError("failed", "The view failed", [], { cause: error });
    }
  }
  /** Registered names of the tools a plugin contributes (namespaced unless built in). */
  toolsOf(plugin: string): string[] {
    return [...this.toolOwners].filter(([, owner]) => owner === plugin).map(([name]) => name);
  }
  get hasSessionEndHooks(): boolean {
    return this.endHandlers.length > 0;
  }
  /** Conservative ownership check used to protect a live session from plugin removal. */
  ownsSessionResources(plugin: string): boolean {
    return (
      this.startHandlers.some((entry) => entry.plugin === plugin) ||
      this.endHandlers.some((entry) => entry.plugin === plugin) ||
      [...this.panels.values()].some((entry) => entry.plugin === plugin)
    );
  }
  emit(event: RunEvent): void {
    for (const observer of this.observers) {
      try {
        observer(Object.freeze(structuredClone(event)));
      } catch {
        /* Observers cannot break runs. */
      }
    }
  }
  /**
   * Disposes every plugin in parallel, each bounded by `disposeTimeoutMs`: a slow or hung
   * `dispose()` neither delays the others nor holds the close past its limit. Registrations are
   * undone either way. Failures (including a timeout) are reported together afterwards.
   */
  async close(): Promise<void> {
    const limit = this.options.disposeTimeoutMs ?? 2000;
    const entries = [...this.loaded.entries()].reverse();
    this.loaded.clear();
    this.externalCount = 0;
    this.builtins.clear();
    const results = await Promise.allSettled(
      entries.map(async ([id, { plugin, undo }]) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => plugin.dispose?.()),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`Plugin ${id} dispose timed out after ${limit}ms`)),
                limit,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
          for (const fn of undo.reverse()) fn();
        }
      }),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Plugin disposal failed");
  }
}
export async function discoverPlugins(root: string): Promise<string[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const found = await Promise.all(
    entries
      .filter(
        // A root may hold an `npm install --prefix` layout (`node_modules`, package.json/lock);
        // npm packages there are resolved through the configured `plugins` array instead.
        (e) =>
          e.name !== "node_modules" &&
          e.name !== "package.json" &&
          e.name !== "package-lock.json" &&
          ((e.isFile() && /\.[cm]?[jt]s$/.test(e.name)) || e.isDirectory()),
      )
      .map(async (e) => {
        const path = join(root, e.name);
        // A directory is a plugin only with its manifest: `<config home>/plugins/<id>` is also
        // where `api.paths.config` puts a plugin's own files, and those are not plugins.
        if (e.isDirectory() && !(await exists(join(path, "alisio-plugin.json")))) return undefined;
        return path;
      }),
  );
  return found.filter((path): path is string => path !== undefined).sort();
}
