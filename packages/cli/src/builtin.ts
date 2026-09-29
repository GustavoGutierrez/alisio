/**
 * Built-in plugin registry wired by the CLI. Built-ins load through the trusted path of the
 * plugin host (unprefixed names, `internal` effect) and can be disabled by configuration
 * (`builtinPlugins.<id>.enabled: false`) or `--disable-plugin <id>`. Add a built-in by
 * appending an entry here. Dedicated model providers (DeepSeek, OpenCode Console, OpenCode Go)
 * are no longer built-ins: users install them independently via
 * `alisio install npm:@alisio/plugin-{deepseek,opencode,opencode-go}`.
 */
import type { BuiltinPlugin } from "@alisio/core";
import { createMemoryPlugin } from "@alisio/plugin-memory";
import { createOpenAICompatiblePlugin } from "@alisio/plugin-openai-compatible";
import { createSubagentsPlugin } from "@alisio/plugin-subagents";

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "openai-compatible",
    name: "OpenAI compatible",
    description: "OpenAI-compatible Chat Completions and Responses model provider",
    categories: ["model-provider"],
    defaultProvider: true,
    create: createOpenAICompatiblePlugin,
  },
  {
    id: "memory",
    name: "Memory",
    description: "Engram-style persistent memory (SQLite + FTS5), memory-aware compaction",
    create: createMemoryPlugin,
  },
  {
    id: "subagents",
    name: "Subagents",
    description: "Delegation to specialized subagents in child sessions (task tool, agent tree)",
    create: createSubagentsPlugin,
  },
];
