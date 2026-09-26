import { createHash } from "node:crypto";
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
  ExtensionPoints,
  Message,
  PanelProvider,
  Plugin,
  PluginAPI,
  PluginMetadata,
  RunEvent,
  SelectRequest,
  SessionInfo,
} from "@alisio/sdk";
import { z } from "zod";
import type { HookFailure, RunnerExtensions } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { ExtensionRegistry } from "../extensions/registry.ts";
import type { ProviderRegistry } from "../providers/registry.ts";
import { readJson } from "../runtime/fs.ts";
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
  /** Binds interactive UI services (the TUI); without them select/askQuestions resolve undefined. */
  setInteractiveUI(ui: {
    select(request: SelectRequest): Promise<string | undefined>;
    askQuestions(request: AskQuestionsRequest): Promise<AskQuestionsResult>;
    open(sessionId: string): boolean;
  }) {
    this.uiImpl = ui;
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
  /** Binds the provider-agnostic completion service once a provider exists. */
  setCompleter(fn: (request: CompletionRequest & { signal: AbortSignal }) => Promise<string>) {
    this.completer = fn;
  }
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
      categories: z.array(z.literal("model-provider")).optional(),
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
        register: (tool) =>
          track(
            this.registry.register(
              builtin
                ? tool
                : {
                    ...tool,
                    name: `${pluginPrefix(plugin.id)}_${tool.name}`,
                    // Only built-ins may claim the always-allowed internal effect.
                    ...(tool.effect === "internal" ? { effect: "external" as const } : {}),
                  },
            ),
          ),
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
  async close(): Promise<void> {
    const errors: unknown[] = [];
    for (const { plugin, undo } of [...this.loaded.values()].reverse()) {
      try {
        await plugin.dispose?.();
      } catch (e) {
        errors.push(e);
      } finally {
        for (const fn of undo.reverse()) fn();
      }
    }
    this.loaded.clear();
    this.externalCount = 0;
    this.builtins.clear();
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
  return entries
    .filter(
      // A root may hold an `npm install --prefix` layout (`node_modules`, package.json/lock);
      // npm packages there are resolved through the configured `plugins` array instead.
      (e) =>
        e.name !== "node_modules" &&
        e.name !== "package.json" &&
        e.name !== "package-lock.json" &&
        ((e.isFile() && /\.[cm]?[jt]s$/.test(e.name)) || e.isDirectory()),
    )
    .map((e) => join(root, e.name))
    .sort();
}
