import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  CommandOptions,
  CompactionHooks,
  CompletionRequest,
  Message,
  Plugin,
  PluginAPI,
  RunEvent,
  SessionInfo,
} from "@alisio/sdk";
import { z } from "zod";
import type { HookFailure, RunnerExtensions } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { inside } from "../runtime/paths.ts";
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
  commands = new Map<string, (args: string) => Promise<string>>();
  commandInfo = new Map<string, CommandOptions & { plugin: string; builtin: boolean }>();
  /** Ids of active built-in plugins. */
  builtins = new Set<string>();
  /** Status entries contributed through `ui.status`, keyed `plugin:key`. */
  status = new Map<string, { plugin: string; text: string; detail?: string }>();
  onStatusChange?: () => void;
  /** Loaded plugins that did not come from the built-in registry. */
  externalCount = 0;
  private compactionHooks: Array<{ plugin: string; hooks: CompactionHooks }> = [];
  private startHandlers: Array<{ plugin: string; handler: StartHandler }> = [];
  private endHandlers: Array<{ plugin: string; handler: EndHandler }> = [];
  private fieldOwners = new Map<string, Map<string, string>>();
  private completer?: (request: CompletionRequest & { signal: AbortSignal }) => Promise<string>;
  observers = new Set<(event: Readonly<RunEvent>) => void>();
  contexts: Array<() => Promise<string>> = [];
  skillRoots: string[] = [];
  promptRoots: string[] = [];
  private loaded = new Map<string, { plugin: Plugin; undo: Array<() => void> }>();
  constructor(
    private registry: ToolRegistry,
    private state: {
      getState(plugin: string, key: string): unknown;
      setState(plugin: string, key: string, value: unknown): void;
    },
    private options: PluginHostOptions = {},
  ) {}
  /** Binds the provider-agnostic completion service once a provider exists. */
  setCompleter(fn: (request: CompletionRequest & { signal: AbortSignal }) => Promise<string>) {
    this.completer = fn;
  }
  async load(path: string): Promise<void> {
    path = resolve(path);
    if ((await stat(path)).isDirectory()) {
      const manifest = z
        .object({ entry: z.string(), apiVersion: z.literal(1) })
        .passthrough()
        .parse(await Bun.file(join(path, "alisio-plugin.json")).json());
      const entry = resolve(path, manifest.entry);
      if (!inside(path, entry)) throw new Error("Plugin entry escapes directory");
      path = entry;
    }
    // Caller must explicitly trust before import: module evaluation executes arbitrary code.
    const module = await import(pathToFileURL(path).href);
    await this.activate(module.default as Plugin, dirname(path));
  }
  /**
   * `builtin` is reserved for first-party plugins from the built-in registry: their tools and
   * commands keep unprefixed names and may declare the `internal` effect.
   */
  async activate(plugin: Plugin, base: string, options: { builtin?: boolean } = {}): Promise<void> {
    const builtin = !!options.builtin;
    z.object({
      id: z.string().regex(/^[a-z0-9][a-z0-9.-]{0,63}$/),
      version: z.string().regex(/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/),
      apiVersion: z.literal(1),
      setup: z.function(),
    })
      .passthrough()
      .parse(plugin);
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
          const p = resolve(base, path);
          this.skillRoots.push(p);
          track(() => {
            this.skillRoots = this.skillRoots.filter((x) => x !== p);
          });
        },
        prompts: (path) => {
          const p = resolve(base, path);
          this.promptRoots.push(p);
          track(() => {
            this.promptRoots = this.promptRoots.filter((x) => x !== p);
          });
        },
      },
      state: {
        get: (key) => this.state.getState(plugin.id, key),
        set: (key, value) => this.state.setState(plugin.id, key, value),
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
      ui: {
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
      await plugin.setup(api);
      this.loaded.set(plugin.id, { plugin, undo });
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
  get hasSessionEndHooks(): boolean {
    return this.endHandlers.length > 0;
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
    .filter((e) => (e.isFile() && /\.[cm]?[jt]s$/.test(e.name)) || e.isDirectory())
    .map((e) => join(root, e.name))
    .sort();
}
