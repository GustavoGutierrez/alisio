/** @alisio/core public API: embed the Alisio agent programmatically. */
export * from "@alisio/sdk";
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
} from "./agents/active.ts";
export {
  type AppOptions,
  type BuiltinContext,
  type BuiltinPlugin,
  createApplication,
  enabledBuiltins,
  type PluginCatalogEntry,
  type PluginCatalogStatus,
} from "./application.ts";
export {
  BUILTIN_COMMANDS,
  type BuiltinCommand,
  CommandCatalog,
  type CommandExecutionContext,
  type CommandHost,
  type CommandResult,
  type CommandSurface,
} from "./commands/catalog.ts";
export {
  type Config,
  type ConfigLoadResult,
  type ConfigProvenance,
  configFile,
  configHome,
  configSchema,
  isSettableSettingKey,
  type LoadedConfig,
  loadConfig,
  loadConfigWithProvenance,
  type McpServerSource,
  overridesSavedProviderProfile,
  type SettableSettingKey,
  setConfigValue,
  setGlobalMcpAllow,
  setMcpServerEnabled,
  setProjectPluginEnabled,
  setProjectSkillEnabled,
  stateHome,
} from "./config.ts";
export {
  type ContextBudget,
  checkpointInstructions,
  completeText,
  effectiveContextBudget,
  estimateTokens,
  MAX_TRUSTED_WINDOW,
  parseCheckpointOutput,
  planCompaction,
  renderCheckpoint,
  serializeForSummary,
  shouldCompact,
  shouldCompactContext,
  summarize,
} from "./core/compaction.ts";
export type {
  ApprovalDecision,
  ApprovalHandler,
  ApprovalRequest,
  BeginRunInput,
  ContextSource,
  EndRunInput,
  EventPage,
  HookFailure,
  MessagePage,
  PageOptions,
  Policy,
  RunnerExtensions,
  RunRecord,
  RunStatus,
  Session,
  SessionStore,
  StoredEvent,
  TerminalRunStatus,
  ToolCallMeta,
} from "./core/contracts.ts";
export { ToolRegistry } from "./core/registry.ts";
export {
  AgentRunner,
  type CompactionResult,
  defaultTokenBudget,
  type RunnerOptions,
  type RunnerSettingsPatch,
  type RunOptions,
} from "./core/runner.ts";
export { type ExtensionConflict, ExtensionRegistry } from "./extensions/registry.ts";
export { HerdrBridge } from "./integrations/herdr.ts";
export {
  McpConnector,
  type McpServerInfo,
  type McpStatus,
  type McpToolInfo,
} from "./mcp/connector.ts";
export {
  discoverPlugins,
  PluginHost,
  type PluginHostOptions,
  pluginPrefix,
} from "./plugins/host.ts";
export {
  type CliInstallOptions,
  cliInstall,
  INSTALL_TIMEOUT_MS,
  type InstallPluginInput,
  type InstallPluginResult,
  type InstallRunner,
  installedNpmPlugins,
  installPlugin,
  npmInstallTarget,
  type PluginSpec,
  parsePluginSpec,
  pluginTrustRemark,
  printInstallResult,
  registerPluginInstallTool,
  sanitizeNpmError,
} from "./plugins/install.ts";
export { ActiveProvider, ProviderRegistry, UnconfiguredProvider } from "./providers/registry.ts";
export {
  availableProviderModels,
  type ProviderModelCatalog,
  resolveProviderModel,
} from "./providers/routing.ts";
export {
  type ProviderProfile,
  type ProviderSettings,
  ProviderSettingsStore,
} from "./providers/settings.ts";
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
  type SkillCatalogEntry,
  type SkillRoot,
  type SkillScope,
  Skills,
  skillRoots,
} from "./resources/skills.ts";
export {
  type ExternalDirectoryDecision,
  type ExternalDirectoryHandler,
  type ExternalDirectoryRequest,
  PathAccess,
  type PathAccessOptions,
  type ResolvePathOptions,
} from "./runtime/access.ts";
export { BlobStore, type BlobStoreOptions } from "./runtime/blobs.ts";
export { clipLines, unifiedPatch } from "./runtime/diff.ts";
export { exists, fileSize, readHead, readJson, readText, which } from "./runtime/fs.ts";
export {
  defaultGlobalRoots,
  isPathSpec,
  PLUGIN_KEYWORD,
  resolvePluginSpec,
} from "./runtime/modules.ts";
export { findWorkspace, inside, outsideRootsMessage, safePath } from "./runtime/paths.ts";
export {
  isMissingCommand,
  type ProcessResult,
  RIPGREP_INSTALL_HINT,
  runProcess,
} from "./runtime/process.ts";
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
export {
  getTrust,
  hashProjectConfig,
  hasProjectResources,
  listTrust,
  resolveTrust,
  revokeTrust,
  setTrust,
  type TrustEntry,
  type TrustListing,
  type TrustResolution,
  trustStorePath,
} from "./trust.ts";
