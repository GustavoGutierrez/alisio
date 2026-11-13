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
  PLUGIN_CREATOR_AGENT,
  PLUGIN_CREATOR_AGENT_ID,
  type PlanInstructionSettings,
  planInstructions,
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
  APP_CLOSE_BUDGET_MS,
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
export { TaskJanitor } from "./background/janitor.ts";
export { subagentTasks } from "./background/mirror.ts";
export {
  buildTaskNotification,
  DEFAULT_NOTIFIER_TIMING,
  type NotifierTiming,
  TaskNotifier,
  type TaskWake,
  type TaskWakeRequest,
  type WakeOutcome,
} from "./background/notify.ts";
export { DEFAULT_READ_BYTES, MAX_READ_BYTES } from "./background/output.ts";
export {
  BackgroundTasks,
  type BackgroundTasksOptions,
  type TaskAdmissionCode,
  TaskAdmissionError,
  TaskForeignError,
  TaskNotFoundError,
} from "./background/service.ts";
export {
  BackgroundTaskStore,
  isLive as isTaskLive,
  isTerminal as isTaskTerminal,
} from "./background/store.ts";
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
  type McpShadowedServer,
  OCI_IMAGE_PATTERN,
  overridesSavedProviderProfile,
  parseMcpServerEntry,
  type SettableSettingInfo,
  type SettableSettingKey,
  setConfigValue,
  setGlobalMcpAllow,
  setProjectPluginEnabled,
  setProjectSkillEnabled,
  settableSettings,
  stateHome,
} from "./config.ts";
export {
  formatContextGovernorStatsSection,
  formatContextReport,
  notableSegments,
} from "./context/format.ts";
export { buildContextReport, MAX_REPORT_SEGMENTS } from "./context/report.ts";
export {
  type ContextBudget,
  checkpointInstructions,
  completeText,
  effectiveContextBudget,
  estimateTokens,
  imageTokens,
  MAX_TRUSTED_WINDOW,
  measureChars,
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
  DecisionsFactory,
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
export { HumanWaits } from "./core/human-wait.ts";
export { EXIT_PLAN_TOOL, GOAL_TOOLS, OPT_IN_TOOLS } from "./core/opt-in.ts";
export {
  DEFAULT_MAX_OUTPUT_TOKENS,
  describeOutputLimitSource,
  MAX_AUTO_OUTPUT_TOKENS,
  type OutputLimit,
  type OutputLimitSource,
  resolveMaxOutputTokens,
} from "./core/output-limit.ts";
export { ToolRegistry } from "./core/registry.ts";
export { RunClock } from "./core/run-clock.ts";
export {
  AgentRunner,
  type CompactionResult,
  defaultTokenBudget,
  type RunnerOptions,
  type RunnerSettingsPatch,
  type RunOptions,
} from "./core/runner.ts";
export {
  CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  DECISION_LIMITS,
  DEFAULT_DECISIONS_CONFIG,
  type DecisionAttempt,
  DecisionError,
  type DecisionMetricEntry,
  DecisionMetrics,
  type DecisionMetricsSnapshot,
  type DecisionOutcome,
  DecisionRegistry,
  DecisionService,
  type DecisionServiceDeps,
  type DecisionStatus,
  type DecisionsConfig,
  formatDecisionStatsSection,
  formatDecisionsReport,
  HEALTH_TIMEOUT_MS,
  type RegisteredDecisionProvider,
  splitSupported,
  validateAnswers,
  validateRequest,
} from "./decisions/index.ts";
export { DocumentError } from "./documents/limits.ts";
export type {
  DocumentEngine,
  DomMeasurements,
  EngineCapabilities,
  Readiness,
  RenderJob,
  RenderOutput,
} from "./documents/ports.ts";
export { type DocumentEngineStatus, documentEngineStatus } from "./documents/status.ts";
export { canonicalJson, hashCanonical } from "./eval/canonical.ts";
export {
  CASSETTE_SUFFIX,
  type Cassette,
  type CassetteCall,
  CassetteFormatError,
  type CassetteHeader,
  type CassetteMeta,
  CassetteRecorder,
  CassetteWriteError,
  MAX_CASSETTE_BYTES,
  MAX_CASSETTE_DIR_BYTES,
  parseCassette,
  RecordingProvider,
  ReplayDivergenceError,
  ReplayExhausted,
  ReplayProvider,
  ReplayUnconsumedError,
  readCassette,
  serializeCassette,
  type WriteOptions,
  writeCassette,
} from "./eval/cassette.ts";
export {
  type Conditions,
  compareReports,
  compareVariants,
  EvalCompareError,
  type EvalComparison,
  type Interval,
  type MetricDelta,
  parseReport,
  renderComparisonMarkdown,
  renderVariantComparisonMarkdown,
  type TaskComparison,
  type TokenComparison,
  type VariantComparison,
  type Verdict,
} from "./eval/compare.ts";
export {
  CONFIG_HASH_COVERAGE,
  type ConfigHashExtras,
  checkTaskPolicy,
  computeConfigHash,
  type EvalApplication,
  EvalBudgetExceeded,
  type EvalRunMode,
  EvalRunRefusedError,
  type InvokerPermissions,
  type RunTaskOptions,
  runTask,
} from "./eval/engine.ts";
export {
  buildExportBundle,
  type EvalExportBundle,
  EvalExportRefusedError,
  type ExportContext,
} from "./eval/export.ts";
export {
  computeFingerprint,
  type FingerprintDiff,
  type FingerprintDiffEntry,
} from "./eval/fingerprint.ts";
export { EvalPathError, resolveInside } from "./eval/paths.ts";
export {
  interleaveVariants,
  mulberry32,
  type PlannedRun,
  planRuns,
  type VariantStep,
} from "./eval/plan.ts";
export {
  type BuildReportOptions,
  buildReport,
  EvalReportError,
  estimateRunCost,
  lowPowerTasks,
  MIN_POWER_K,
  renderReportMarkdown,
} from "./eval/report.ts";
export {
  type RunEvaluationOptions,
  type RunEvaluationResult,
  type RunVariantsOptions,
  runEvaluation,
  runVariantEvaluations,
} from "./eval/run-suite.ts";
export { findSecrets, redactSecrets } from "./eval/secrets.ts";
export {
  median,
  passAtK,
  passPowK,
  sampleVariance,
  wilsonInterval,
} from "./eval/stats.ts";
export {
  EvalSuiteError,
  type LoadedSuite,
  loadSuite,
  MAX_VERIFIER_TIMEOUT_MS,
} from "./eval/suite.ts";
export {
  applyConfigOverrides,
  EvalVariantError,
  loadVariantsFile,
  resolveVariants,
  type VariantsFile,
} from "./eval/variants.ts";
export {
  runVerifier,
  runVerifiers,
  snapshotTree,
  type ToolEvent,
  type TreeSnapshot,
  type VerifierContext,
  type VerifierResult,
  type VerifierStatus,
} from "./eval/verifiers.ts";
export { type ExtensionConflict, ExtensionRegistry } from "./extensions/registry.ts";
export { ForgeError } from "./forge/errors.ts";
export {
  downloadSize as pyodideDownloadSize,
  inspectPyodide,
  installPyodide,
  PyodideIntegrityError,
  pyodideDir,
} from "./forge/python/pyodide-install.ts";
export {
  PYODIDE_MANIFEST,
  type PyodideManifest,
  type PyodideProfile,
} from "./forge/python/pyodide-manifest.ts";
export { describePythonBackends } from "./forge/python/status.ts";
export { createPythonBackends } from "./forge/python/wiring.ts";
export { describeForge, type ForgeStatus, forgeEngineFor } from "./forge/runtime.ts";
export {
  emptyScratch,
  listScratch,
  openScratchFile,
  SCRATCH_LIST_LIMIT,
  type ScratchFileInfo,
} from "./forge/scratch-files.ts";
export * from "./goal/index.ts";
export { HerdrBridge } from "./integrations/herdr.ts";
export { type McpIdentity, mcpIdentity } from "./mcp/alias.ts";
export { assessEntry } from "./mcp/catalog/availability.ts";
export { CATEGORY_IDS, CATEGORY_LABELS, type CategoryId } from "./mcp/catalog/categories.ts";
export { type CategoryClassifier, createRuleClassifier } from "./mcp/catalog/classifier.ts";
export { readGlobalCatalogConfig } from "./mcp/catalog/config.ts";
export {
  type CatalogServiceOptions,
  createCatalogService,
  type McpCatalogService,
} from "./mcp/catalog/service.ts";
export {
  type CatalogEntry,
  type CatalogSource,
  CatalogSourceError,
  type CatalogSourcePage,
  type ListPageRequest,
  type RejectedEntry,
} from "./mcp/catalog/source.ts";
export {
  type CatalogSourceConfig,
  createSourceFactory,
  type SourceBuilder,
  type SourceFactory,
} from "./mcp/catalog/source-factory.ts";
export { OfficialRegistrySource } from "./mcp/catalog/sources/official-registry.ts";
export type { CatalogQuery } from "./mcp/catalog/store.ts";
export {
  McpConfigError,
  type McpConfigErrorCode,
  type McpConfigTarget,
  type McpConfigWriteResult,
  readMcpConfigRevision,
  removeMcpServer,
  setMcpServerEnabled,
  writeMcpServer,
} from "./mcp/config-writer.ts";
export {
  McpConnector,
  type McpServerInfo,
  type McpStatus,
  type McpToolInfo,
} from "./mcp/connector.ts";
export {
  createProjectOverride,
  type McpRemovalPreview,
  previewMcpRemoval,
} from "./mcp/scopes.ts";
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
  DIAGRAM_MAX_BYTES,
  DIAGRAM_MAX_NODES,
  DIAGRAM_SYNTAXES,
  DIAGRAMS_MAX_ALLOWED,
  mermaidProblem,
  type PlanDiagram,
  validateDiagrams,
} from "./plan/diagrams.ts";
export {
  buildPlanManifest,
  parsePlanHeadings,
  slugifyHeading,
} from "./plan/manifest.ts";
export {
  claimApprovedPlan,
  currentPlan,
  discardApprovedPlan,
  IMPLEMENTATION_AGENT_ID,
  implementationPrompt,
  PLAN_CONTEXT_MAX_CHARS,
  PLAN_CRITERIA_KEY,
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
  APP_ACTION_TIMEOUT_MS,
  APP_APPROVAL_TIMEOUT_MS,
  type AppApprovalRequest,
  type AppApprover,
  PluginAppError,
  PluginAppRegistry,
} from "./plugins/apps.ts";
export {
  checkInstalledPlugin,
  type GateReport,
  type GateRequest,
  runPluginGateChild,
} from "./plugins/creator/gate.ts";
export {
  type GateCommand,
  gateCommand,
  gateEnvironment,
  runInstalledGate,
} from "./plugins/creator/gate-runner.ts";
export {
  isPluginCreatorPath,
  type PluginCreatorPaths,
  pluginCreatorPathMatcher,
  pluginCreatorPaths,
  pluginCreatorProjectOf,
} from "./plugins/creator/paths.ts";
export {
  MAX_BUILD_ATTEMPTS,
  type PluginBuildOutcome,
  PluginCreatorProjects,
  type PluginCreatorProjectsOptions,
  sdkRangeFor,
  titleFrom,
} from "./plugins/creator/projects.ts";
export { detectSchema } from "./plugins/creator/schema.ts";
export { sampleInput } from "./plugins/creator/schema-sample.ts";
export { ensurePluginCreatorSkill } from "./plugins/creator/skill.ts";
export {
  PLUGIN_CREATOR_SKILL_FILES,
  PLUGIN_CREATOR_SKILL_NAME,
} from "./plugins/creator/skill-files.ts";
export {
  PLUGIN_CREATOR_LIMITS,
  PLUGIN_CREATOR_STEPS,
  PluginCreatorError,
  type PluginCreatorErrorCode,
} from "./plugins/creator/types.ts";
export { type ProjectValidation, validateProject } from "./plugins/creator/validate.ts";
export { sanitizePluginDiagnostic } from "./plugins/diagnostic.ts";
export {
  discoverPlugins,
  type PluginEnvironment,
  PluginHost,
  type PluginHostOptions,
  pluginCodeImportedFrom,
  pluginPrefix,
  type ViewInfo,
  ViewRunError,
} from "./plugins/host.ts";
export {
  type CliInstallOptions,
  cliInstall,
  cliUpdateAll,
  INSTALL_TIMEOUT_MS,
  type InstalledTogether,
  type InstallPluginInput,
  type InstallPluginResult,
  type InstallResolvingPeersInput,
  type InstallResolvingPeersResult,
  type InstallRunner,
  type InstallTogetherInput,
  type InstallTogetherResult,
  installedGlobalPluginPackages,
  installedGlobalPlugins,
  installedNpmPlugins,
  installPlugin,
  installPluginResolvingPeers,
  installPluginsTogether,
  isPeerConflict,
  NpmInstallError,
  npmInstallTarget,
  type PluginSpec,
  parsePluginSpec,
  pluginDependencySpec,
  pluginTrustRemark,
  printInstallResult,
  registerPluginInstallTool,
  sanitizeNpmError,
  type UninstallPluginInput,
  type UninstallPluginResult,
  uninstallPlugin,
  updateAllPlugins,
} from "./plugins/install.ts";
export {
  type InstallLocalPluginInput,
  type InstallLocalPluginResult,
  installLocalPluginTarball,
  LocalInstallError,
  type LocalInstallPhase,
  storedTarballName,
} from "./plugins/local-install.ts";
export {
  NPM_NOT_FOUND_MESSAGE,
  type NpmInvocation,
  resolveNpmInvocation,
  runNpm,
} from "./plugins/npm-runner.ts";
export { installedSdkVersion } from "./plugins/sdk-version.ts";
export {
  inspectPluginTarball,
  MAX_TARBALL_BYTES,
  type PluginTarballInfo,
  readTarballPackageJson,
  type TarballLimits,
} from "./plugins/tarball.ts";
export {
  type PackDirectoryResult,
  packDirectory,
  type TarballWriteEntry,
  TarballWriteError,
  type TarballWriteLimits,
  tarGzBuffer,
  writeTarGz,
} from "./plugins/tarball-writer.ts";
export {
  type CatalogPluginState,
  type CatalogPluginStateInput,
  catalogPluginState,
  comparePluginVersions,
  satisfiesRange,
} from "./plugins/version-compat.ts";
export * from "./proof/index.ts";
export {
  AuthFlow,
  AuthFlowLimitError,
  AuthFlowRegistry,
  type AuthFlowRegistryOptions,
  type AuthFlowStatus,
  FLOW_MAX_ACTIVE,
  FLOW_RETAIN_MS,
  FLOW_TTL_MS,
  isSafeStepUrl,
  type RunAuthFlowOptions,
  runAuthFlow,
  type Schedule,
  type StartFlowInput,
} from "./providers/oauth/flow.ts";
export {
  type FileLockOptions,
  FileLockTimeoutError,
  isStaleLock,
  withFileLock,
} from "./providers/oauth/lock.ts";
export {
  LOOPBACK_MAX_MS,
  LoopbackError,
  type OpenLoopbackOptions,
  openLoopback,
} from "./providers/oauth/loopback.ts";
export {
  needsRefresh,
  OAuthError,
  type OAuthErrorCode,
  OAuthManager,
  type OAuthManagerOptions,
} from "./providers/oauth/manager.ts";
export {
  knownSecretValues,
  redactCredentials,
  redactDeep,
  redactEventData,
  registerSecret,
  SecretRegistry,
} from "./providers/redaction.ts";
export {
  ActiveProvider,
  ProviderAuthDeclarationError,
  ProviderRegistry,
  type RegisteredProvider,
  UnconfiguredProvider,
} from "./providers/registry.ts";
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
  type StoredOAuthCredential,
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
export {
  type IdSource,
  newId,
  newUuid,
  seededIdSource,
  setIdSource,
  ulid,
} from "./runtime/ids.ts";
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
  WORKSPACE_MARKER,
  workspaceKey,
} from "./runtime/paths.ts";
export {
  isMissingCommand,
  type ProcessResult,
  RIPGREP_INSTALL_HINT,
  runProcess,
} from "./runtime/process.ts";
export {
  killAllTrackedProcesses,
  PROCESS_SWEEP_GRACE_MS,
  type ProcessKillPlan,
  processKillPlan,
  type TrackedProcess,
  terminateAllTrackedProcesses,
  trackedProcesses,
  trackProcess,
} from "./runtime/process-registry.ts";
export { isSqliteExperimentalWarning, openDatabase } from "./runtime/sqlite.ts";
export { SQLiteStore } from "./runtime/store.ts";
export { crc32, writeZip, type ZipEntry, type ZipSink } from "./runtime/zip.ts";
export {
  DEFAULT_SEMANTIC_CONFIG,
  formatSemanticReport,
  type SemanticConfig,
  SemanticRegistry,
  SemanticService,
  type SemanticStatus,
} from "./semantic/index.ts";
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
  SKILL_AUTHORING_GUIDANCE,
  SKILL_AUTHORING_SKILL_NAMES,
  SKILL_DRAFT_INSTRUCTIONS,
} from "./skills/authoring-guidance.ts";
export {
  generateSkillDraft,
  parseSkillDraft,
  SKILL_FEEDBACK_MAX,
  SKILL_IDEA_MAX,
  type SkillAuthoringGuidance,
  skillAuthoringGuidance,
  skillDraftRequest,
  slugifySkillName,
} from "./skills/draft.ts";
export { SkillWriteError, type SkillWriteResult, writeSkill } from "./skills/writer.ts";
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
export { NOT_SANDBOXED } from "./tools/analysis.ts";
export { formatBytes } from "./tools/artifact-blocks.ts";
export { ARTIFACT_READ_MAX, exportedPaths } from "./tools/artifacts.ts";
export { GET_GOAL_TOOL, parseEvidence, UPDATE_GOAL_TOOL } from "./tools/goal.ts";
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
