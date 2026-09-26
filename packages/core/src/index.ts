/** @alisio/core public API: embed the Alisio agent programmatically. */
export * from "@alisio/sdk";
export {
  type AppOptions,
  type BuiltinContext,
  type BuiltinPlugin,
  createApplication,
  enabledBuiltins,
} from "./application.ts";
export {
  type Config,
  configFile,
  configHome,
  configSchema,
  loadConfig,
  stateHome,
} from "./config.ts";
export {
  checkpointInstructions,
  completeText,
  estimateTokens,
  parseCheckpointOutput,
  planCompaction,
  renderCheckpoint,
  serializeForSummary,
  shouldCompact,
} from "./core/compaction.ts";
export type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  ContextSource,
  HookFailure,
  Policy,
  RunnerExtensions,
  Session,
  SessionStore,
} from "./core/contracts.ts";
export { ToolRegistry } from "./core/registry.ts";
export {
  AgentRunner,
  type CompactionResult,
  defaultTokenBudget,
  type RunnerOptions,
  type RunOptions,
} from "./core/runner.ts";
export { type ExtensionConflict, ExtensionRegistry } from "./extensions/registry.ts";
export { HerdrBridge } from "./integrations/herdr.ts";
export { McpConnector } from "./mcp/connector.ts";
export {
  discoverPlugins,
  PluginHost,
  type PluginHostOptions,
  pluginPrefix,
} from "./plugins/host.ts";
export { OpenAICompatibleProvider } from "./providers/openai-compatible.ts";
export {
  type InstructionFile,
  ProjectContext,
  type ProjectContextOptions,
} from "./resources/context.ts";
export {
  expandSlashPrompt,
  loadPromptTemplates,
  type PromptDiagnostic,
  type PromptRequirement,
  type PromptSource,
  type PromptSourceKind,
  type PromptTemplate,
  parsePromptTemplate,
  promptSources,
  renderPromptTemplate,
  splitArguments,
} from "./resources/prompts.ts";
export {
  type Skill,
  type SkillRoot,
  type SkillScope,
  Skills,
  skillRoots,
} from "./resources/skills.ts";
export { exists, fileSize, readHead, readJson, readText, which } from "./runtime/fs.ts";
export {
  defaultGlobalRoots,
  isPathSpec,
  PLUGIN_KEYWORD,
  resolvePluginSpec,
} from "./runtime/modules.ts";
export { findWorkspace, safePath } from "./runtime/paths.ts";
export { type ProcessResult, runProcess } from "./runtime/process.ts";
export { isSqliteExperimentalWarning, openDatabase } from "./runtime/sqlite.ts";
export { SQLiteStore } from "./runtime/store.ts";
export { ChildSessions, type ChildSessionsOptions } from "./sessions/children.ts";
export {
  composeSideBySide,
  DefaultAlisioMascot,
  DefaultStartupScreen,
  infoSection,
  mascotSection,
  padEnd,
  pluginsSection,
  renderStartup,
  type StartupDiagnostic,
  type StartupInput,
  type StartupResult,
  sanitizeLine,
  shortenPath,
  startupTips,
  stripAnsi,
  tipsSection,
  titleSection,
  truncate,
  visibleWidth,
  welcomeSection,
} from "./startup/index.ts";
export { hash, objectSchema, registerStandard } from "./tools/standard.ts";
