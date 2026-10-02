/** @alisio/core public API: embed the Alisio agent programmatically. */
export * from "@alisio/sdk";
export {
  type ActiveAgent,
  AGENT_COMMAND_PREFIX,
  type AgentPickerItem,
  activeAgentCatalog,
  agentCatalogFromState,
  agentCommandDescriptors,
  agentCommandName,
  agentIdFromCommand,
  agentPickerItems,
  agentRunOptions,
  BUILTIN_AGENTS,
  cycleableAgents,
  DEFAULT_AGENT_ID,
  type MainCapableAgentRecord,
  mainAgentFromRecord,
  nextAgent,
  PLAN_AGENT_ID,
  resolveActiveAgent,
} from "./agents/active.ts";
export {
  agentModelCapabilities,
  agentModelLabels,
  agentModelOptions,
  DEFAULT_EFFORT_LEVELS,
  fitAgentSettings,
} from "./agents/capabilities.ts";
export {
  AGENT_AUTHORING_SKILL_NAMES,
  CREATE_AGENT_SKILL,
} from "./agents/create-agent-skill.ts";
export {
  AGENT_ID_PATTERN,
  AGENT_LIMITS,
  AGENT_REASONING_SUMMARIES,
  AGENT_TEXT_FORMATS,
  AGENT_VERBOSITIES,
  type AgentFieldError,
  AgentNotFoundError,
  AgentScopeStore,
  agentIdFromName,
  agentScopeDir,
  parseAgentFile,
  RESERVED_AGENT_IDS,
  slugify,
  validateAgentDefinitionInput,
} from "./agents/definitions.ts";
export {
  AGENT_DRAFT_INSTRUCTIONS,
  AGENT_DRAFT_MAX_DESCRIPTION,
  type AgentAuthoringGuidance,
  agentAuthoringGuidance,
  agentDraftRequest,
  generateAgentDraft,
  parseAgentDraft,
} from "./agents/draft.ts";
export {
  type AgentChange,
  AgentDefinitionService,
  type AgentDefinitionServiceOptions,
  type AgentRegistry,
  mergeAgentScopes,
} from "./agents/service.ts";
export { AGENT_TEMPLATES, agentTemplate } from "./agents/templates.ts";
export {
  CapabilityGrants,
  type GrantRecord,
  type GrantSource,
  toGrantWire,
} from "./analysis/capabilities.ts";
export { CsvParser, decodeTextBytes, detectDelimiter } from "./analysis/data/csv.ts";
export {
  type DatasetLimits,
  type DatasetRecord,
  DatasetService,
  DEFAULT_DATASET_LIMITS,
  datasetFormat,
  PageParamError,
  toDatasetRef,
  XLSX_REMEDY,
} from "./analysis/data/datasets.ts";
export {
  DataEngine,
  DataError,
  type DataErrorCode,
} from "./analysis/data/engine-client.ts";
export { guardSql } from "./analysis/data/sql-guard.ts";
export {
  detectHintHost,
  type HintHost,
  type InstallHints,
  installHintsMarkdown,
  installHintsText,
  parseOsRelease,
  pythonInstallHints,
} from "./analysis/install-hints.ts";
export {
  AnalysisJanitor,
  type RetentionPolicy,
  SWEEP_INTERVAL_MS,
  type SweepReport,
} from "./analysis/janitor.ts";
export {
  AnalysisJobs,
  type ExecutionDetails,
  type ExecutionStatus,
  type JobPaths,
} from "./analysis/jobs.ts";
export {
  containerName,
  type OciDeps,
  type OciEngine,
  OciRuntime,
  type OciSettings,
  type OciStatus,
  ociRunArgs,
  parseDigests,
} from "./analysis/oci.ts";
export {
  AnalysisRerun,
  type RerunPlan,
  type RerunPreparation,
} from "./analysis/rerun.ts";
export {
  AnalysisRuntimeManager,
  type DiscoveryDeps,
  type Extras,
  ExtrasInstallError,
  type InstallStep,
  installPreview,
  type PythonCandidate,
  type PythonResolution,
  type RuntimeState,
  setupCommand,
  venvInterpreter,
} from "./analysis/runtime-manager.ts";
export { analysisStatus } from "./analysis/status.ts";
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
  classifyArtifact,
  extensionOf,
  fileType as artifactFileType,
  isPreviewable,
  KIND_LABELS,
  viewerContentType,
} from "./artifacts/kinds.ts";
export { createArtifactPublisher } from "./artifacts/publisher.ts";
export {
  type ArtifactFile,
  type ArtifactLimits,
  type ArtifactOwner,
  type ArtifactRecord,
  ArtifactRejected,
  ArtifactStore,
  type PublishedArtifact,
  readHead as readArtifactHead,
  slugify as artifactSlug,
  toRef,
} from "./artifacts/store.ts";
export {
  changelogNews,
  compareVersions,
  formatChangelogMarkdown,
  isVersion,
  loadChangelog,
  type NewsDecision,
  parseChangelog,
  type SelectedEntries,
  selectEntries,
  UNRELEASED,
} from "./changelog/index.ts";
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
  OCI_IMAGE_PATTERN,
  overridesSavedProviderProfile,
  type SettableSettingInfo,
  type SettableSettingKey,
  setConfigValue,
  setGlobalMcpAllow,
  setMcpServerEnabled,
  setProjectPluginEnabled,
  setProjectSkillEnabled,
  settableSettings,
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
  ArtifactPublisherFactory,
  BeginRunInput,
  CapabilityGate,
  ContextSource,
  CoreArtifactPublisher,
  EndRunInput,
  EventPage,
  HookFailure,
  MessagePage,
  PageOptions,
  Policy,
  PublishedArtifactInfo,
  RunnerExtensions,
  RunRecord,
  RunStatus,
  Session,
  SessionStore,
  StoredEvent,
  TerminalRunStatus,
  ToolCallMeta,
} from "./core/contracts.ts";
export { EXIT_PLAN_TOOL, OPT_IN_TOOLS } from "./core/opt-in.ts";
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  describeOutputLimitSource,
  MAX_AUTO_OUTPUT_TOKENS,
  type OutputLimit,
  type OutputLimitSource,
  resolveMaxOutputTokens,
} from "./core/output-limit.ts";
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
  describePermissionStatus,
  type EffectState,
  effectState,
  FULL_ACCESS_WARNING,
  type ModeFlags,
  type ModePolicy,
  modeFromFlags,
  modeToPreset,
  PERMISSION_MODE_TABLE,
  PERMISSION_MODES,
  PERMISSION_MODES_LOCKED,
  PERMISSION_USAGE,
  type PermissionCommand,
  type PermissionModeLabel,
  type PermissionModeSpec,
  parsePermissionCommand,
  parsePermissionMode,
  presetToMode,
  READ_ONLY_POLICY,
} from "./permissions/modes.ts";
export {
  claimApprovedPlan,
  currentPlan,
  discardApprovedPlan,
  IMPLEMENTATION_AGENT_ID,
  implementationPrompt,
  PLAN_CONTEXT_MAX_CHARS,
  PLAN_OPTIONS,
  PLAN_QUESTION_ID,
  PLAN_REVIEW_TITLE,
  PLAN_TEXT_KEY,
  type PlanFollowUp,
  type PlanState,
  type PlanStatus,
  planHash,
  readPlanState,
  settlePlanRun,
  withdrawPendingPlan,
} from "./plan/state.ts";
export {
  discoverPlugins,
  PluginHost,
  type PluginHostOptions,
  pluginPrefix,
  type ViewInfo,
  ViewRunError,
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
  maskSecret,
  type ProviderProfile,
  type ProviderSettings,
  ProviderSettingsStore,
} from "./providers/settings.ts";
export {
  buildReloadReport,
  formatReloadReport,
  type ReloadableApp,
  ReloadFailedError,
  type ReloadInput,
  ReloadRefusedError,
  type ReloadSnapshot,
  reloadApplication,
  snapshotApplication,
  validateReloadConfig,
} from "./reload.ts";
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
export { BlobStore, type BlobStoreOptions, BlobTooLarge } from "./runtime/blobs.ts";
export { clipLines, unifiedPatch } from "./runtime/diff.ts";
export { exists, fileSize, readHead, readJson, readText, which } from "./runtime/fs.ts";
export { newId, ulid } from "./runtime/ids.ts";
export {
  defaultGlobalRoots,
  isPathSpec,
  PLUGIN_KEYWORD,
  resolvePluginSpec,
} from "./runtime/modules.ts";
export {
  findWorkspace,
  inside,
  outsideRootsMessage,
  safePath,
  workspaceKey,
} from "./runtime/paths.ts";
export {
  isMissingCommand,
  type ProcessResult,
  RIPGREP_INSTALL_HINT,
  runProcess,
} from "./runtime/process.ts";
export { isSqliteExperimentalWarning, openDatabase } from "./runtime/sqlite.ts";
export { SQLiteStore } from "./runtime/store.ts";
export { crc32, writeZip, type ZipEntry, type ZipSink } from "./runtime/zip.ts";
export { ChildSessions, type ChildSessionsOptions } from "./sessions/children.ts";
export {
  formatSideQuestion,
  SIDE_QUESTION_DESCRIPTION,
  SIDE_QUESTION_HISTORY_LIMIT,
  SIDE_QUESTION_INSTRUCTIONS,
  SIDE_QUESTION_MAX_CHARS,
  SIDE_QUESTION_USAGE,
  SIDE_QUESTIONS_NAMESPACE,
  type SideQuestionEntry,
  SideQuestions,
  type SideQuestionsOptions,
  sideTranscript,
} from "./sessions/side-questions.ts";
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
export { formatBytes, NOT_SANDBOXED } from "./tools/analysis.ts";
export { ARTIFACT_READ_MAX, exportedPaths } from "./tools/artifacts.ts";
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
