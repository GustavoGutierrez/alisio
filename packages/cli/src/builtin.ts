/**
 * Built-in plugin registry wired by the CLI. Built-ins load through the trusted path of the
 * plugin host (unprefixed names, `internal` effect) and can be disabled by configuration
 * (`builtinPlugins.<id>.enabled: false`) or `--disable-plugin <id>`. Add a built-in by
 * appending an entry here.
 */
import type { BuiltinPlugin } from "@alisio/core";
import { createDeepSeekPlugin } from "@alisio/plugin-deepseek";
import { createMemoryPlugin } from "@alisio/plugin-memory";
import { createOpenAICompatiblePlugin } from "@alisio/plugin-openai-compatible";
import { createOpenCodePlugin } from "@alisio/plugin-opencode";
import { createOpenCodeGoPlugin } from "@alisio/plugin-opencode-go";
import { createSubagentsPlugin } from "@alisio/plugin-subagents";

export const BUILTIN_PLUGINS: BuiltinPlugin[] = [
  {
    id: "deepseek",
    name: "DeepSeek",
    description: "Dedicated DeepSeek Chat Completions and Responses provider",
    categories: ["model-provider"],
    create: createDeepSeekPlugin,
  },
  {
    id: "opencode",
    name: "OpenCode Console (Zen)",
    description: "Dedicated OpenCode Console (Zen) multi-protocol provider",
    categories: ["model-provider"],
    create: createOpenCodePlugin,
  },
  {
    id: "opencode-go",
    name: "OpenCode Go",
    description: "Dedicated OpenCode Go multi-protocol provider",
    categories: ["model-provider"],
    create: createOpenCodeGoPlugin,
  },
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
