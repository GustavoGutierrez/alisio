/**
 * Registry of first-party plugins. They are activated through the trusted built-in path of
 * the plugin host (unprefixed names, `internal` effect) and never require --trust-project.
 * Add a built-in by appending an entry here.
 */
import type { Plugin } from "@alisio/sdk";
import { createMemoryPlugin } from "./memory/index.ts";

export interface BuiltinContext {
  workspace: string;
  stateHome: string;
  configDir: string;
}
export interface BuiltinPlugin {
  id: string;
  description: string;
  /** `options` is the raw `builtinPlugins.<id>` object; the plugin validates it. */
  create(options: unknown, context: BuiltinContext): Plugin;
}
export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "memory",
    description: "Engram-style persistent memory (SQLite + FTS5), memory-aware compaction",
    create: createMemoryPlugin,
  },
];
/** A built-in runs unless its config sets `enabled: false` or it is disabled by flag. */
export function enabledBuiltins(
  config: Record<string, { enabled?: boolean } & Record<string, unknown>>,
  disabled: string[] = [],
): BuiltinPlugin[] {
  for (const id of [...Object.keys(config), ...disabled])
    if (!BUILTIN_PLUGINS.some((p) => p.id === id))
      throw new Error(`Unknown built-in plugin: ${id}`);
  return BUILTIN_PLUGINS.filter((p) => config[p.id]?.enabled !== false && !disabled.includes(p.id));
}
