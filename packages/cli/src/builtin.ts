/**
 * Built-in plugin registry wired by the CLI. Built-ins load through the trusted path of the
 * plugin host (unprefixed names, `internal` effect) and can be disabled by configuration
 * (`builtinPlugins.<id>.enabled: false`) or `--disable-plugin <id>`. Add a built-in by
 * appending an entry here.
 */
import type { BuiltinPlugin } from "@alisio/core";
import { createMemoryPlugin } from "@alisio/plugin-memory";

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "memory",
    description: "Engram-style persistent memory (SQLite + FTS5), memory-aware compaction",
    create: createMemoryPlugin,
  },
];
