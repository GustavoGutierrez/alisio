import type {
  PluginAppAction,
  PluginAppContext,
  PluginAppDefinition,
  PluginAppInfo,
} from "@alisio/sdk";
import Ajv, { type ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import type { Policy } from "../core/contracts.ts";
import { decideEffect } from "../permissions/decide.ts";

const APP_ID = /^[a-z][a-z0-9-]{0,39}$/;
const ACTION_NAME = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const APP_EFFECTS = new Set(["read", "write", "process"]);
const MAX_ACTIONS = 64;
const MAX_LABEL = 80;
export const APP_ACTION_TIMEOUT_MS = 30_000;

const ajv = new Ajv({ allErrors: true, strict: true });
const ajv2020 = new Ajv2020({ allErrors: true, strict: true });
const rejectReferences = (value: unknown): void => {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (["$ref", "$id", "$async"].includes(key))
      throw new Error(`Schema keyword ${key} is not supported`);
    rejectReferences(child);
  }
};

/** A failed app request: `code` is what the frame receives; the message never echoes inputs. */
export class PluginAppError extends Error {
  constructor(
    readonly code: "not_found" | "invalid_input" | "not_permitted" | "timeout" | "failed",
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "PluginAppError";
  }
}

interface AppEntry {
  plugin: string;
  app: PluginAppDefinition;
  label: Record<string, string>;
  actions: Map<string, { action: PluginAppAction; validate: ValidateFunction }>;
  disposed: boolean;
}

const normalizeLabel = (label: unknown): Record<string, string> => {
  const entries: Array<[string, string]> =
    typeof label === "string"
      ? [["en", label]]
      : label && typeof label === "object"
        ? Object.entries(label as Record<string, unknown>).flatMap(([locale, text]) =>
            typeof text === "string" ? [[locale, text] as [string, string]] : [],
          )
        : [];
  const out: Record<string, string> = {};
  for (const [locale, text] of entries) {
    const trimmed = text.trim();
    if (!/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(locale) || !trimmed)
      throw new Error("An app label needs non-empty text per locale");
    out[locale] = trimmed.slice(0, MAX_LABEL);
  }
  if (!out.en) {
    const first = Object.values(out)[0];
    if (!first) throw new Error("An app needs a label");
    out.en = first;
  }
  return out;
};

/**
 * Plugin apps of one workspace host, keyed `plugin:app`. Registration is validated up front;
 * `dispose` runs once (sync) when an app is unregistered, its plugin closes or setup rolls back.
 */
export class PluginAppRegistry {
  private entries = new Map<string, AppEntry>();

  register(plugin: string, app: PluginAppDefinition): () => void {
    if (!app || typeof app !== "object") throw new Error("An app needs a definition");
    if (!APP_ID.test(app.id)) throw new Error(`Invalid app id: ${String(app.id)}`);
    if (typeof app.html !== "function") throw new Error("An app needs an html function");
    for (const hook of ["busy", "dispose"] as const)
      if (app[hook] !== undefined && typeof app[hook] !== "function")
        throw new Error(`App ${hook} must be a function`);
    const key = `${plugin}:${app.id}`;
    if (this.entries.has(key)) throw new Error(`Duplicate app ${key}`);
    const label = normalizeLabel(app.label);
    const declared = Object.entries(app.actions ?? {});
    if (declared.length > MAX_ACTIONS) throw new Error("An app declares too many actions");
    const actions = new Map<string, { action: PluginAppAction; validate: ValidateFunction }>();
    for (const [name, action] of declared) {
      if (!ACTION_NAME.test(name)) throw new Error(`Invalid app action name: ${name}`);
      if (!action || !APP_EFFECTS.has(action.effect))
        throw new Error(`App action ${name} needs an effect of read, write or process`);
      if (typeof action.handler !== "function")
        throw new Error(`App action ${name} needs a handler`);
      if (!action.inputSchema || action.inputSchema.type !== "object")
        throw new Error(`App action ${name} input schema must be an object schema`);
      rejectReferences(action.inputSchema);
      const compiler =
        action.inputSchema.$schema === "https://json-schema.org/draft/2020-12/schema"
          ? ajv2020
          : ajv;
      actions.set(name, { action, validate: compiler.compile(action.inputSchema) });
    }
    const entry: AppEntry = { plugin, app, label, actions, disposed: false };
    this.entries.set(key, entry);
    return () => this.remove(key, entry);
  }

  private remove(key: string, entry: AppEntry): void {
    if (this.entries.get(key) === entry) this.entries.delete(key);
    if (entry.disposed) return;
    entry.disposed = true;
    try {
      entry.app.dispose?.();
    } catch {
      /* A failing dispose cannot block unregistering. */
    }
  }

  /** Disposes and removes every app of `plugin` (the host also tracks each unregister). */
  removePlugin(plugin: string): void {
    for (const [key, entry] of [...this.entries])
      if (entry.plugin === plugin) this.remove(key, entry);
  }

  /** Apps a plugin registered (catalog items, without handlers). */
  appsOf(plugin: string): PluginAppInfo[] {
    return [...this.entries.values()]
      .filter((entry) => entry.plugin === plugin)
      .map((entry) => ({ plugin, id: entry.app.id, label: { ...entry.label } }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  has(plugin: string, id: string): boolean {
    return this.entries.has(`${plugin}:${id}`);
  }

  /** Whether any app reports background work (keeps the workspace from idle eviction). */
  busy(): boolean {
    for (const entry of this.entries.values()) {
      try {
        if (entry.app.busy?.()) return true;
      } catch {
        /* A throwing busy() is treated as idle. */
      }
    }
    return false;
  }

  async html(plugin: string, id: string): Promise<string> {
    const entry = this.entries.get(`${plugin}:${id}`);
    if (!entry) throw new PluginAppError("not_found", "App not found");
    try {
      const html = await entry.app.html();
      if (typeof html !== "string") throw new Error("html() must return a string");
      return html;
    } catch (error) {
      throw new PluginAppError("failed", "The app could not be loaded", { cause: error });
    }
  }

  /**
   * Validates `input`, authorizes the action's effect with the session `policy` (never opens an
   * approval) and runs it under a timeout. Errors never include the input or handler internals.
   */
  async run(
    plugin: string,
    id: string,
    name: string,
    input: unknown,
    context: Omit<PluginAppContext, "signal"> & { signal?: AbortSignal },
    options: { policy: Policy; timeoutMs?: number },
  ): Promise<unknown> {
    const entry = this.entries.get(`${plugin}:${id}`);
    const action = entry?.actions.get(name);
    if (!entry || !action) throw new PluginAppError("not_found", "App action not found");
    if (!action.validate(input)) throw new PluginAppError("invalid_input", "Invalid action input");
    if (
      decideEffect(options.policy, action.action, { approvals: false, capabilityGranted: false })
        .kind !== "allow"
    )
      throw new PluginAppError("not_permitted", "The session does not allow this action");
    const controller = new AbortController();
    const onAbort = () => controller.abort(context.signal?.reason);
    if (context.signal?.aborted) onAbort();
    else context.signal?.addEventListener("abort", onAbort, { once: true });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort(new Error("App action timed out"));
        reject(new PluginAppError("timeout", "The action took too long"));
      }, options.timeoutMs ?? APP_ACTION_TIMEOUT_MS);
    });
    try {
      return await Promise.race([
        Promise.resolve().then(() =>
          action.action.handler(input, {
            sessionId: context.sessionId,
            workspace: context.workspace,
            signal: controller.signal,
            ...(context.idempotencyKey ? { idempotencyKey: context.idempotencyKey } : {}),
          }),
        ),
        expired,
      ]);
    } catch (error) {
      if (error instanceof PluginAppError) throw error;
      throw new PluginAppError("failed", "The action failed", { cause: error });
    } finally {
      clearTimeout(timer);
      context.signal?.removeEventListener("abort", onAbort);
    }
  }
}
