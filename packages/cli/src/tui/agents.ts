/**
 * The ACTIVE (main-session) agent logic lives in `@alisio/core` (`agents/active.ts`) so every
 * surface (TUI, headless, server) resolves agents the same way. Re-exported for compatibility.
 */
export {
  type ActiveAgent,
  type AgentPickerItem,
  activeAgentCatalog,
  agentCatalogFromState,
  agentPickerItems,
  agentRunOptions,
  BUILTIN_AGENTS,
  DEFAULT_AGENT_ID,
  type MainCapableAgentRecord,
  mainAgentFromRecord,
  resolveActiveAgent,
} from "@alisio/core";
