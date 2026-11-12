/**
 * The runtime shape of `PluginAPI` (every member and sub-member), checked against the SDK type at
 * compile time: adding or removing a `PluginAPI` member breaks the build until this list follows,
 * so the creator's probe always knows exactly the API of the SDK this Alisio was built with.
 * `"value"` marks data members (paths, options) rather than objects of functions.
 */
import type { PluginAPI } from "@alisio/sdk";

type Shape = {
  [K in keyof Required<PluginAPI>]: NonNullable<PluginAPI[K]> extends Record<string, string>
    ? "value"
    : K extends "options"
      ? "value"
      : { [M in keyof Required<NonNullable<PluginAPI[K]>>]: 1 };
};

export const PLUGIN_API_SHAPE = {
  tools: { register: 1 },
  commands: { register: 1 },
  events: { on: 1 },
  context: { register: 1 },
  resources: { skills: 1, prompts: 1, agents: 1, list: 1 },
  state: { get: 1, set: 1 },
  compaction: { register: 1 },
  session: { onStart: 1, onEnd: 1 },
  model: { complete: 1 },
  models: { list: 1, resolve: 1 },
  providers: { register: 1 },
  storage: { sqlite: 1 },
  views: { register: 1 },
  apps: { register: 1 },
  proof: { registerVerifier: 1 },
  decisions: { registerProvider: 1, available: 1, activeProvider: 1, activate: 1, tryDecide: 1 },
  semantic: {
    available: 1,
    active: 1,
    embed: 1,
    index: 1,
    search: 1,
    trySearch: 1,
    remove: 1,
    collections: 1,
    drop: 1,
    registerEmbedding: 1,
    registerStore: 1,
    activate: 1,
  },
  paths: "value",
  options: "value",
  extensions: { register: 1 },
  sessions: {
    spawn: 1,
    create: 1,
    run: 1,
    get: 1,
    children: 1,
    ancestors: 1,
    cancel: 1,
    enqueue: 1,
    isRunning: 1,
    capabilities: 1,
    model: 1,
    workspace: 1,
    setStatus: 1,
  },
  ui: { status: 1, panel: 1, select: 1, askQuestions: 1, open: 1, interactive: 1 },
} as const satisfies Shape;
