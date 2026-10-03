import type { CommandDescriptor } from "@alisio/sdk";

/** A built-in slash command: a descriptor without `source`/`owner` (always `builtin`). */
export type BuiltinCommand = Omit<CommandDescriptor, "source" | "owner">;

const ALL: CommandDescriptor["surfaces"] = ["tui", "web", "api"];
const TUI: CommandDescriptor["surfaces"] = ["tui"];
const INTERACTIVE: CommandDescriptor["surfaces"] = ["tui", "web"];

/**
 * Built-in slash commands, in the order the TUI lists them. Names, aliases, descriptions and
 * argument hints are the TUI's `COMMANDS` moved here as data (the TUI re-exports them).
 * `execution: "core"` commands have a handler in `CommandCatalog.execute`; `surface` commands
 * (clipboard, exit, settings/connect wizards, help, `/ask`) are handled by each UI.
 */
export const BUILTIN_COMMANDS: readonly BuiltinCommand[] = [
  {
    name: "help",
    description: "Show commands and keys",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "connect",
    description: "Configure a provider and choose its active model",
    surfaces: TUI,
    execution: "surface",
  },
  {
    name: "model",
    description: "Switch provider and model",
    aliases: ["models"],
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "compact",
    description: "Summarize older history",
    argumentHint: "[focus]",
    surfaces: ALL,
    execution: "core",
  },
  { name: "stats", description: "Session statistics", surfaces: ALL, execution: "core" },
  {
    name: "clear",
    description: "Start a new session",
    aliases: ["new"],
    surfaces: ALL,
    execution: "core",
  },
  { name: "sessions", description: "List recent sessions", surfaces: ALL, execution: "core" },
  {
    name: "resume",
    description: "Resume a session by ID or prefix",
    argumentHint: "<id>",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "tools",
    description: "List tools and permission state",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "plugins",
    description: "Browse and manage project plugins",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "skills",
    description: "Browse and manage effective skills",
    surfaces: ALL,
    execution: "core",
  },
  { name: "mcps", description: "Browse and manage MCP servers", surfaces: ALL, execution: "core" },
  {
    name: "settings",
    description: "Open the settings menu",
    aliases: ["prefs"],
    surfaces: TUI,
    execution: "surface",
  },
  {
    name: "copy",
    description: "Copy the last assistant response to the clipboard",
    surfaces: TUI,
    execution: "surface",
  },
  {
    name: "agents",
    description: "List and switch the active agent (applies from the next prompt)",
    argumentHint: "[<verb>]",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "effort",
    description: "Set the reasoning effort level for the active model",
    argumentHint: "[level]",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "ask",
    description: "Ask the agent to turn your question into a multiple-choice ask_user_question",
    argumentHint: "<question>",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "btw",
    description: "Ask a side question about the session without adding to the conversation",
    argumentHint: "[question]",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "artifacts",
    description: "Browse this session's artifacts",
    argumentHint: "[filter]",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "permission",
    description:
      "Switch the permission mode (ask, auto, full access), see its status or manage saved permissions",
    aliases: ["permissions"],
    argumentHint: "[ask|auto|full|status]",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "reload",
    description:
      "Reload the configuration, agents, skills, prompt templates and MCP servers (between turns)",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "changelog",
    description: "Show what changed in recent Alisio releases",
    argumentHint: "[version]",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "tasks",
    description: "Show this session's background tasks (bg_run) with their output, and stop them",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "goal",
    description: "Start or manage the current Session Goal",
    argumentHint: "[objective | pause | resume | edit | clear | help | budget=<n>]",
    surfaces: INTERACTIVE,
    execution: "surface",
  },
  {
    name: "decisions",
    description: "Show Decision Intelligence status, provider health and session metrics",
    surfaces: ALL,
    execution: "core",
  },
  {
    name: "exit",
    description: "Exit Alisio",
    aliases: ["quit"],
    surfaces: TUI,
    execution: "surface",
  },
];
