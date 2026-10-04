import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_TEMPLATES,
  type AgentDefinitionInfo,
  type AgentDraft,
  type AgentModelOption,
  type AppOptions,
  type ApprovalDecision,
  type ApprovalRequest,
  agentAuthoringGuidance,
  agentCommandDescriptors,
  agentIdFromCommand,
  agentModelCapabilities,
  agentModelLabels,
  agentModelOptions,
  changelogNews,
  describePermissionStatus,
  type ExternalDirectoryRequest,
  formatChangelogMarkdown,
  formatDecisionStatsSection,
  formatReloadReport,
  type GoalHostView,
  generateAgentDraft,
  goalOptInTools,
  goalOutcome,
  goalWaiting,
  IMPLEMENTATION_AGENT_ID,
  isTaskLive,
  loadChangelog,
  modeFromFlags,
  NOT_SANDBOXED,
  nextAgent,
  PERMISSION_MODE_TABLE,
  PERMISSION_USAGE,
  type PermissionMode,
  type PermissionModeLabel,
  PLAN_QUESTION_ID,
  PLAN_TEXT_KEY,
  parseGoalCommand,
  parsePermissionCommand,
  ReloadFailedError,
  ReloadRefusedError,
  reloadApplication,
  type SettableSettingKey,
  selectEntries,
  settlePlanRun,
  stateHome,
  toGoalInfo,
  toGrantWire,
  toRef,
  validateReloadConfig,
} from "@alisio/core";
import type {
  AskQuestionsRequest,
  AskQuestionsResult,
  GoalInfo,
  ModelInfo,
  PanelNode,
  PlanReview,
  RunEvent,
} from "@alisio/sdk";
import { summarizeDecisionEvents } from "@alisio/sdk";
import {
  CombinedAutocompleteProvider,
  type Component,
  Container,
  Editor,
  getImageDimensions,
  getNativeClipboard,
  Key,
  MouseRegion,
  matchesKey,
  ProcessTerminal,
  ScrollView,
  type SelectItem,
  SelectList,
  TuiAltScreen,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  VStack,
} from "@earendil-works/pi-tui";
import { loadVersion } from "../version.ts";
import {
  AGENT_PICKER_ACTIONS,
  type AgentField,
  type AgentForm,
  agentEditorRows,
  agentFieldChoices,
  agentFieldSupported,
  agentPickerRows,
  applyDraft,
  decodeMultiline,
  emptyAgentForm,
  encodeMultiline,
  filterAgentRows,
  formErrors,
  formFromDefinition,
  formFromTemplate,
  formToInput,
  parseAgentsArgs,
} from "./agent-manager.ts";
import {
  type ActiveAgent,
  activeAgentCatalog,
  agentRunOptions,
  type MainCapableAgentRecord,
  mainAgentFromRecord,
  resolveActiveAgent,
} from "./agents.ts";
import { ArtifactPreview, loadPreview } from "./artifact-preview.ts";
import {
  ARTIFACTS_HINT,
  artifactActions,
  artifactRow,
  capabilityApprovalTitle,
  detailRows,
  installApprovalDetail,
  installApprovalTitle,
  matchArtifact,
  permissionRow,
} from "./artifacts.ts";
import {
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  type PendingAttachment,
  pasteImageFromClipboard,
  removeLastAttachment,
  toApiAttachment,
} from "./attachments.ts";
import { BTW_DESCRIPTION, BTW_USAGE, btwBrowser, btwPending } from "./btw.ts";
import { copyText, nodeSpawn } from "./clipboard.ts";
import {
  AttachmentsBar,
  BannerBlock,
  BtwPanel,
  ContentInset,
  clock,
  componentFor,
  contentInnerWidth,
  Footer,
  Header,
  type HeaderInfo,
  MarkdownPanel,
  PlanReviewPanel,
  QuestionPanel,
  Switch,
  setArtifactPathResolver,
  TranscriptSync,
  TreePanel,
} from "./components.ts";
import { ConnectInputPrompt } from "./connect-input.ts";
import { bounded, EXIT_PENDING_CAP_MS, EXIT_SESSION_END_CAP_MS } from "./exit.ts";
import { BRANCH_REFRESH_MS, createBranchCache } from "./git-branch.ts";
import {
  formatGoalStatus,
  GoalBar,
  goalPickerItems,
  goalPickerPrefill,
  goalStopNotice,
  planGoalCommand,
} from "./goal.ts";
import {
  agentCycleHint,
  isPermissionMode,
  modeDisplay,
  type PermissionMenuRow,
  permissionMenuRows,
  permissionTransition,
  reloadGuard,
  shiftTabDecision,
} from "./modes.ts";
import { cannotOpenMessage, openPath, revealPath } from "./open-path.ts";
import { initialPanelState, reducePanel, visibleRows } from "./panel.ts";
import { planDiagramsMarkdown, planTranscriptMarkdown } from "./plan-review.ts";
import { summarizeAnswers } from "./questions.ts";
import { InteractiveQueue } from "./queue.ts";
import { type SettingRow, type SettingsNavigationAction, settingsMenuRows } from "./settings.ts";
import { SettingsMenu } from "./settings-menu.ts";
import { SkillsManager } from "./skills-manager.ts";
import {
  addItem,
  COMMANDS,
  configuredProviderModelItems,
  editorCopyKey,
  effectiveEffort,
  effortPickerItems,
  type FoldCandidate,
  foldCandidates,
  foldToggleKey,
  formatContext,
  formatDuration,
  formatTokens,
  hostOf,
  initialViewState,
  isGroupHeader,
  itemsFromHistory,
  lastAssistantText,
  mcpServerItems,
  mcpToolItems,
  parseCommand,
  pluginCatalogItems,
  pluginToggleNeedsConfirmation,
  providerModelItems,
  reduceEvent,
  reservedCommandNames,
  resolveCommand,
  richPartsOf,
  shortenPath,
  shortId,
  skipGroupHeaders,
  slashCompletionCommands,
  summarizeToolArgs,
  type TranscriptItem,
  type ViewState,
  validateEffortLevel,
  visibleGroupedItems,
} from "./state.ts";
import { TasksView, wakeDecision } from "./tasks.ts";
import { editorTheme, selectListTheme, style } from "./theme.ts";
import { readViewerState, writeViewerState } from "./viewer-state.ts";

const VERSION = loadVersion(import.meta.url);

/**
 * Inline selection list with type-to-filter, rendered above the editor.
 *
 * Grouped item builders (pluginCatalogItems) interleave their output with non-selectable
 * `__group:` header items. Headers stay in the SelectList so they render, scroll and truncate
 * like rows, but selection is owned here: navigation jumps over headers via skipGroupHeaders
 * (wrapping both directions), Enter never fires onSelect for a header, and the whole display
 * sequence is re-derived on every filter keystroke so headers of fully-filtered groups vanish.
 */
export class Picker implements Component {
  private list: SelectList = new SelectList([], 1, selectListTheme);
  private filter = "";
  /** Full item sequence (group headers + rows) before any filtering. */
  private readonly allItems: SelectItem[];
  /** Display sequence: filtered rows plus the headers of groups that still match. */
  private items: SelectItem[] = [];
  /** Selection index within `items`; always a real row, never a group header. */
  private index = 0;
  /** Picker height target: counted on real rows only, so headers never stretch the list. */
  private readonly maxVisible: number;
  constructor(
    private title: string,
    items: SelectItem[],
    private readonly onSelectItem: (item: SelectItem) => void,
    private readonly onCancelPick: () => void,
    private filterable = false,
    private detail?: string,
    /** Custom filter (default: value prefix, keeping group headers). */
    private readonly match?: (items: SelectItem[], filter: string) => SelectItem[],
  ) {
    this.allItems = items;
    this.maxVisible = Math.min(
      10,
      Math.max(1, items.filter((item) => !isGroupHeader(item)).length),
    );
    this.resetList();
  }
  /** Copies items, dimming group-header labels (style helpers stay plain under NO_COLOR). */
  private static displayItems(items: SelectItem[]): SelectItem[] {
    return items.map((item) =>
      isGroupHeader(item) ? { ...item, label: style.gray(item.label) } : item,
    );
  }
  /** (Re)builds the SelectList over the filtered display sequence; selection starts on a row. */
  private resetList(): void {
    this.items = Picker.displayItems(
      this.filter
        ? this.match
          ? this.match(this.allItems, this.filter)
          : visibleGroupedItems(this.allItems, this.filter)
        : this.allItems,
    );
    this.list = new SelectList(this.items, this.maxVisible, selectListTheme);
    this.list.onSelect = (item) => {
      if (!isGroupHeader(item)) this.onSelectItem(item);
    };
    this.list.onCancel = this.onCancelPick;
    this.index = this.items.length ? skipGroupHeaders(this.items, -1, 1) : 0;
    if (this.index < 0) this.index = 0;
    this.list.setSelectedIndex(this.index);
  }
  invalidate(): void {
    this.list.invalidate();
  }
  /** The currently selected item — always a real row, never a group header. */
  getSelectedItem(): SelectItem | null {
    return this.items[this.index] ?? null;
  }
  handleInput(data: string): void {
    if (this.filterable && matchesKey(data, Key.backspace)) {
      this.filter = this.filter.slice(0, -1);
      this.resetList();
    } else if (this.filterable && data.length === 1 && data >= " " && data <= "~") {
      this.filter += data;
      this.resetList();
    } else if (matchesKey(data, Key.up) || matchesKey(data, Key.down)) {
      const dir = matchesKey(data, Key.down) ? 1 : -1;
      this.index = this.items.length ? skipGroupHeaders(this.items, this.index, dir) : 0;
      this.list.setSelectedIndex(this.index);
    } else if (matchesKey(data, Key.enter)) {
      const item = this.items[this.index];
      if (item && !isGroupHeader(item)) this.onSelectItem(item);
    } else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
      this.onCancelPick();
    } else {
      this.list.handleInput(data);
    }
  }
  render(width: number): string[] {
    const hint = this.filterable
      ? `  ${this.filter ? `filter: ${this.filter}` : "type to filter"} · ↑↓ · Enter · Esc`
      : "  ↑↓ · Enter · Esc";
    return [
      truncateToWidth(style.bold(style.yellow(this.title)), width),
      ...(this.detail
        ? this.detail
            .split("\n")
            .flatMap((line) => {
              const words = line.split(/\s+/);
              const rows: string[] = [];
              let row = "";
              for (const word of words) {
                if (row && [...`${row} ${word}`].length > width) {
                  rows.push(row);
                  row = word;
                } else row = row ? `${row} ${word}` : word;
              }
              if (row) rows.push(row);
              return rows;
            })
            .map((line) => truncateToWidth(style.dim(line), width))
        : []),
      ...this.list.render(width),
      truncateToWidth(style.dim(hint), width),
    ];
  }
}

export interface TuiOptions extends AppOptions {
  session?: string;
  quiet?: boolean;
  /** `false` with --no-banner. */
  banner?: boolean;
}

export async function runTui(options: TuiOptions): Promise<void> {
  const { createApplication, CommandCatalog } = await import("@alisio/core");
  const { BUILTIN_PLUGINS } = await import("../builtin.ts");
  const { BUILTIN_PROMPTS } = await import("../prompts/index.ts");
  let dispatch: (event: RunEvent) => void = () => {};
  let approve: (request: ApprovalRequest) => Promise<ApprovalDecision> = async () => "deny";
  let approveExternalDirectory: (request: ExternalDirectoryRequest) => Promise<ApprovalDecision> =
    async () => "deny";
  // The options of every application this process builds: the first one and each `/reload`.
  const appOptions: AppOptions = {
    builtins: BUILTIN_PLUGINS,
    builtinPrompts: BUILTIN_PROMPTS,
    reservedPromptNames: reservedCommandNames(),
    ...options,
    onEvent: (event) => dispatch(event),
    approve: (request) => approve(request),
    approveExternalDirectory: (request) => approveExternalDirectory(request),
    tasks: {
      // Finished background tasks wake the owner agent through the normal prompt path (bound below).
      wake: (request) => wakeForTasks(request),
      onChange: (task, root) => {
        tasksView?.refresh().catch(() => {});
        onTaskChange(task, root);
      },
    },
    // A goal changed (a user command, a finished run, the model's `update_goal`): redraw its bar.
    goals: { onChange: (sessionId) => onGoalChange(sessionId) },
  };
  let wakeForTasks: import("@alisio/core").TaskWake = () => "busy";
  let onTaskChange: (task: import("@alisio/sdk").BackgroundTaskInfo, root: string) => void =
    () => {};
  let onGoalChange: (sessionId: string) => void = () => {};
  let tasksView: TasksView | undefined;
  // `let`: `/reload` swaps in a freshly built application (the session id and database persist).
  let app = await createApplication(appOptions);
  let activeProvider = app.providerInfo;
  let session =
    options.session ?? app.store.create(app.workspace, app.provider.id, app.provider.model).id;
  if (options.session && options.model && app.store.get(session).model !== options.model)
    app.runner.setModel(session, options.model);
  let view: ViewState = initialViewState(app.store.get(session).model);
  if (options.session) view = { ...view, items: itemsFromHistory(app.store.messages(session)) };
  let pendingAttachments: PendingAttachment[] = [];
  /**
   * The permission mode label (`/permission`). Derived from the launch flags and only a LABEL until
   * the user picks a mode: nothing is applied at startup, so the startup behavior is unchanged.
   */
  let permissionMode: PermissionModeLabel = modeFromFlags(options);
  /** The user picked a mode (so a reload re-applies it); a flag-derived label never changes policy. */
  let modePicked = false;
  /** Agent chosen with Shift+Tab before (or without) the config write that persists it. */
  let agentOverride: string | undefined;
  let reloading = false;

  let modelList: Promise<ModelInfo[]> | undefined;
  /** Cached active-provider catalog for completion and context-window discovery. */
  const models = (): Promise<ModelInfo[]> =>
    (modelList ??= app.loadModels(AbortSignal.timeout(10_000)).catch((e) => {
      modelList = undefined;
      throw e;
    }));
  /** Active-provider catalog by model id; feeds effort support and display names. */
  let modelCatalog = new Map<string, ModelInfo>();
  /**
   * Reloads the active-provider catalog and repaints when it lands, so the context bar learns
   * the ACTIVE model's real window (previously only the first /model picker or autocomplete
   * call loaded it, leaving a fabricated 40k total on screen). Called at startup and after
   * every provider/model switch; the bar honestly shows `?` until the catalog arrives.
   * The same refresh feeds the effort status (supported levels + default) and the model
   * display name used by the header and the status line below the editor.
   */
  const primeModels = () => {
    void models()
      .then((list) => {
        modelCatalog = new Map(list.map((m) => [m.id, m]));
        refreshEffort();
        tui.requestRender();
      })
      .catch(() => {});
  };
  const effortSupportFor = (model: string) => modelCatalog.get(model)?.effort;
  const modelDisplayName = (model: string): string => modelCatalog.get(model)?.name ?? model;
  /** Persisted `agents.effort` is silently replaced by the model default when unsupported; one notice. */
  let notifiedEffortFallback = "";
  function refreshEffort(): void {
    const persisted = app.config.agents.effort;
    const capability = effortSupportFor(view.model);
    if (!persisted || !capability?.supportedLevels?.length) return;
    if (capability.supportedLevels.includes(persisted)) return;
    const key = `${view.model}:${persisted}`;
    if (notifiedEffortFallback !== key) {
      notifiedEffortFallback = key;
      flashHint(
        `Reasoning effort "${persisted}" is not supported by ${modelDisplayName(view.model)}; using ${capability.defaultLevel ? `"${capability.defaultLevel}"` : "the provider default"}.`,
        7000,
      );
    }
  }
  /** Effective effort sent on runs: the persisted level when supported, else the model default. */
  const currentEffort = (): string | undefined =>
    effectiveEffort(app.config.agents.effort, effortSupportFor(view.model));
  const terminal = new ProcessTerminal();
  const copy = async (text: string) =>
    copyText(text, {
      platform: process.platform,
      env: process.env,
      spawn: nodeSpawn,
      writeOsc52: (sequence) => terminal.write(sequence),
    });
  const copyMessage = (result: { ok: boolean; method: string }) =>
    result.ok
      ? `Copied (${result.method})`
      : result.method === "osc52"
        ? "Sent via OSC 52 (unverified: no clipboard tool found; needs terminal support)"
        : "Copy failed: no clipboard tool available";
  const tui = new TuiAltScreen(terminal, false, undefined, {
    mouse: true,
    copyOnSelect: true,
    copySelection: async (text) => {
      const result = await copy(text);
      return result.ok ? true : copyMessage(result);
    },
  });
  const main = new TranscriptSync();
  const transcript = main.container;
  // Read-only views of child sessions (subagents), fed by their events.
  const childViews = new Map<string, ViewState>();
  const childView = new TranscriptSync();
  // Fold state of every collapsible transcript row (reasoning sections, tool batches, long
  // outputs). Keyed by stable fold keys from state.ts; absent entries use the pure defaults.
  const folded = new Map<string, boolean>();
  const foldOf = (candidate: FoldCandidate) =>
    folded.get(candidate.key) ?? candidate.defaultExpanded;
  main.setFoldResolver(foldOf);
  childView.setFoldResolver(foldOf);
  /** Which transcript is on screen right now (child view while viewing a subagent, else main). */
  const visibleTranscript = (): { items: TranscriptItem[]; sync: TranscriptSync } =>
    viewedState()
      ? { items: viewedState()?.items ?? [], sync: childView }
      : { items: view.items, sync: main };
  /** Applies one fold toggle and re-syncs only the affected transcript (cheap: events, not frames). */
  const toggleFold = (candidate: FoldCandidate) => {
    folded.set(candidate.key, !(folded.get(candidate.key) ?? candidate.defaultExpanded));
    const visible = visibleTranscript();
    visible.sync.sync(visible.items);
    tui.requestRender();
  };
  let panelState = initialPanelState();
  const startupDiagnostics: import("@alisio/core").StartupDiagnostic[] = [];
  let hint: string | undefined;
  let hintTimer: ReturnType<typeof setTimeout> | undefined;
  const flashHint = (text: string, ms = 2500) => {
    hint = text;
    clearTimeout(hintTimer);
    hintTimer = setTimeout(() => {
      hint = undefined;
      tui.requestRender();
    }, ms);
    tui.requestRender();
  };
  // Git branch of the workspace for the header. Reading refs is a read operation, so it stays on
  // under --read-only; the TTL cache means git is spawned at most once per ~10s, never per frame,
  // and a missing repo/git or a slow spawn simply yields no branch segment.
  const branchCache = createBranchCache();
  let branchName: string | undefined;
  const refreshBranch = () => {
    void branchCache.read(app.workspace).then((branch) => {
      if (branch !== branchName) {
        branchName = branch;
        tui.requestRender();
      }
    });
  };
  refreshBranch();
  const branchTimer = setInterval(refreshBranch, BRANCH_REFRESH_MS);
  /**
   * Selectable ACTIVE (main-session) agents: the built-in `build`/`plan` pair plus the
   * main-capable definitions the subagents plugin publishes (`mode: primary|all`) through its
   * plugin state. Never imports the plugin package; a missing/unavailable contribution is just
   * an empty extra list. The persisted `agents.active` id resolves against this catalog.
   */
  const mainAgents = (): ActiveAgent[] => {
    let contributions: ActiveAgent[] = [];
    try {
      const records = app.plugins.pluginState("subagents", "mainAgents") as
        | MainCapableAgentRecord[]
        | undefined;
      contributions = (records ?? []).map(mainAgentFromRecord);
    } catch {
      /* plugin state is best-effort */
    }
    return activeAgentCatalog(contributions);
  };
  const currentAgent = (): ActiveAgent =>
    resolveActiveAgent(mainAgents(), agentOverride ?? app.config.agents.active);
  const headerInfo = (): HeaderInfo => {
    const policy = app.runner.policy,
      ask = app.runner.approvals;
    return {
      version: VERSION,
      host: hostOf(String(activeProvider?.profile.baseURL ?? app.config.provider.baseURL)),
      apiMode: String(activeProvider?.profile.apiMode ?? app.config.provider.apiMode),
      provider: app.providers.get(activeProvider?.id ?? "")?.name,
      modelName: modelDisplayName(view.model),
      effort: currentEffort(),
      cwd: shortenPath(app.workspace, homedir()),
      session: shortId(session),
      branch: branchName,
      write: policy.write ? "on" : ask ? "ask" : "off",
      process: policy.process ? "on" : ask ? "ask" : "off",
      mode: modeDisplay(permissionMode),
      mcp: app.mcpRuntimePermission() === "granted",
      readOnly: !!options.readOnly,
    };
  };
  const header = new Header(headerInfo, () => view);
  const panelEntry = () => [...app.plugins.panels.values()][0];
  const panelNodes = (): PanelNode[] => {
    try {
      const nodes = panelEntry()?.provider.nodes({ sessionId: session }) ?? [];
      // Display-only override: a session blocked on ask_user_question or an approval prompt shows
      // as "waiting" rather than "running", so the tree panel explains why it looks stalled.
      return nodes.map((n) =>
        n.status === "running" && n.sessionId && interactiveQueue.isWaiting(n.sessionId)
          ? { ...n, status: "waiting" }
          : n,
      );
    } catch {
      return [];
    }
  };
  const viewedState = () =>
    panelState.focus === "view" && panelState.viewing
      ? childViews.get(panelState.viewing)
      : undefined;
  const viewHint = () => {
    const nodes = panelNodes();
    const node = nodes.find((n) => n.id === panelState.viewing);
    if (!node) return "Esc back";
    const path: string[] = [];
    for (
      let cur: PanelNode | undefined = node;
      cur;
      cur = nodes.find((n) => n.id === cur?.parentId)
    )
      path.unshift(cur.label);
    const siblings = nodes.filter((n) => n.parentId === node.parentId);
    const child = viewedState();
    const budget = app.contextBudget(child?.model ?? view.model);
    const pct =
      child?.context && budget?.total
        ? ` · ctx ${Math.round((child.context.used / budget.total) * 100)}%`
        : "";
    const tokens = child
      ? ` · ↑${formatTokens(child.stats.input)} ↓${formatTokens(child.stats.output)}`
      : "";
    return `viewing ${path.join(" › ")} · ${siblings.indexOf(node) + 1}/${siblings.length}${pct}${tokens} · ↑ parent ↓ child ←→ siblings · Esc back · Ctrl+K cancel`;
  };
  const panelHint = () =>
    panelState.focus === "panel"
      ? "agents: ↑↓ move · → expand/enter · ← collapse/parent · Enter open · Ctrl+K cancel · Esc/Tab editor"
      : panelState.focus === "view"
        ? viewHint()
        : undefined;
  const footer = new Footer(
    () => viewedState() ?? view,
    () => app.contextBudget((viewedState() ?? view).model),
    () => panelHint() ?? hint,
    () => [...app.plugins.status.values()].map((s) => s.text),
    // Status row below the editor: `agent: <name> · <model> · <provider> · <effort>` (the
    // effort segment appears only when the active model advertises supported levels).
    () => ({
      agent: currentAgent().name,
      mode: modeDisplay(permissionMode),
      model: modelDisplayName(view.model),
      provider: app.providers.get(activeProvider?.id ?? "")?.name,
      effort: currentEffort(),
    }),
  );
  const treePanel = new TreePanel(() => {
    const entry = panelEntry();
    if (!entry) return undefined;
    const nodes = panelNodes();
    return {
      title: entry.provider.title,
      rows: visibleRows(nodes, panelState.collapsed).map((r) => ({
        ...r,
        collapsed: panelState.collapsed.has(r.node.id),
      })),
      total: nodes,
      focused: panelState.focus !== "editor",
      ...(panelState.selected ? { selected: panelState.selected } : {}),
      ...(panelState.confirm ? { confirm: panelState.confirm } : {}),
    };
  });
  app.plugins.onStatusChange = () => tui.requestRender();
  const pickerSlot = new Container();
  const attachmentsBar = new AttachmentsBar(() => pendingAttachments);
  const editor = new Editor(tui, editorTheme, { paddingX: app.config.tui.paddingX });
  const bottom = new Container();
  bottom.addChild(pickerSlot);
  bottom.addChild(attachmentsBar);
  bottom.addChild(new GoalBar(() => goalInfoNow()));
  bottom.addChild(editor);
  bottom.addChild(treePanel);
  bottom.addChild(footer);
  // Click-to-toggle on collapsible transcript rows: pi-tui synthesizes `click` events after a
  // press+release without movement, so plain clicks fold/unfold while drag-selection keeps
  // working (copyOnSelect must never be disturbed). The region sits between the ScrollView and
  // the content switch; content rows = visible rows + the scroll offset.
  let transcriptScroll: ScrollView | undefined;
  // Transcript content is inset from both borders in ONE place: the wrapper hands children a
  // reduced width and prefixes every row, so agent text, copy hints, tool sub-lines, reasoning
  // lines and group headers all share the same visual column. The config is read live, so a
  // `/settings` change applies on the next render without rebuilding the view.
  const contentInsetX = () => app.config.tui.contentPaddingX;
  const transcriptRegion = new MouseRegion(
    new ContentInset(
      new Switch(() => (viewedState() ? childView.container : transcript)),
      contentInsetX,
    ),
    (event: TuiMouseEvent): TuiMouseEventResult | undefined => {
      if (picker || event.type !== "click" || event.button !== "left") return undefined;
      const scroll = transcriptScroll;
      if (!scroll) return undefined;
      const visible = visibleTranscript();
      // entryAt re-renders each row to measure its height, so it must use the same reduced width
      // the wrapper hands the rows during render.
      const candidate = visible.sync.entryAt(
        event.y + scroll.scrollTop,
        contentInnerWidth(event.width, contentInsetX()),
      );
      if (!candidate) return undefined;
      toggleFold(candidate);
      return { handled: true };
    },
  );
  transcriptScroll = new ScrollView(transcriptRegion, {
    follow: "end",
    primary: true,
    overscroll: "chain",
  });
  tui.setLayoutRoot(
    new VStack([
      { component: header, basis: "auto" },
      { component: transcriptScroll, basis: 0, grow: 1, minSize: 1 },
      { component: bottom, basis: "auto", shrink: 1, minSize: 3 },
    ]),
  );
  // Prime the active provider's catalog so the context bar shows the model's real window
  // (or an honest `?`) instead of a fabricated total; repaint when the catalog lands.
  primeModels();

  const sync = () => {
    main.sync(view.items);
    tui.requestRender();
  };
  const reset = (next: ViewState) => {
    view = next;
    main.reset();
    sync();
  };
  const openChild = (sessionId: string) => {
    if (!childViews.has(sessionId)) {
      let base = initialViewState(view.model);
      try {
        base = { ...base, items: itemsFromHistory(app.store.messages(sessionId)) };
      } catch {
        /* unknown session */
      }
      childViews.set(sessionId, base);
    }
    childView.reset();
    childView.sync(childViews.get(sessionId)?.items ?? []);
    tui.requestRender();
  };
  const applyPanel = (result: ReturnType<typeof reducePanel>) => {
    panelState = result.state;
    const effect = result.effect;
    if (effect?.type === "open") openChild(effect.sessionId);
    if (effect?.type === "cancel")
      void panelEntry()?.provider.action?.("cancel", effect.id, { sessionId: session });
    if (effect?.type === "cancel") flashHint("Cancelling agent and its descendants…");
    tui.requestRender();
  };
  const push = (item: TranscriptItem) => {
    view = addItem(view, item);
    sync();
  };
  const notice = (text: string) => push({ kind: "notice", text });
  const error = (e: unknown) =>
    push({ kind: "error", text: e instanceof Error ? e.message : String(e) });
  const info = (text: string) => push({ kind: "info", text });
  let terminalEvent = false;
  let artifactsThisRun = 0;
  // Artifact announcements show the real local file (resolved from the store, never the model).
  setArtifactPathResolver((id) => {
    const record = app.artifacts.get(id);
    return record?.status === "ready" ? app.artifacts.localPath(record) : undefined;
  });
  dispatch = (event) => {
    // The event stream stays text-only (headless/JSONL consumers see the projection); the TUI
    // pulls the persisted rich parts (ui/image) itself so native rendering survives resume.
    if (event.type === "tool_completed") {
      const data = (event.data ?? {}) as Record<string, unknown>;
      const rich = richPartsOf(
        app.store.callResult(event.sessionId, String(data.id ?? "")),
        String(data.name ?? ""),
      );
      if (rich.ui !== undefined || rich.image !== undefined)
        event = { ...event, data: { ...data, ...rich } };
    }
    if (event.sessionId !== session) {
      // Child session (e.g. a subagent): keep a view model for its read-only view.
      const child = childViews.get(event.sessionId) ?? initialViewState(view.model);
      childViews.set(event.sessionId, reduceEvent(child, event));
      if (panelState.viewing === event.sessionId)
        childView.sync(childViews.get(event.sessionId)?.items ?? []);
      tui.requestRender();
      return;
    }
    if (event.type === "artifact_published") artifactsThisRun++;
    const ended = [
      "run_completed",
      "run_failed",
      "run_cancelled",
      "run_turns_exceeded",
      "compaction_failed",
    ].includes(event.type);
    if (ended) terminalEvent = true;
    view = reduceEvent(view, event);
    if (ended && event.type !== "compaction_failed" && artifactsThisRun > 0) {
      artifactsThisRun = 0;
      view = addItem(view, { kind: "notice", text: ARTIFACTS_HINT });
    }
    sync();
  };
  const refreshEstimate = () => {
    const current = session;
    app.runner
      .estimateContext(current)
      .then((used) => {
        if (current !== session) return;
        view = { ...view, context: { used, estimated: true } };
        tui.requestRender();
      })
      .catch(() => {});
  };

  let busy = false,
    controller: AbortController | undefined,
    pending: Promise<unknown> | undefined,
    picker: Component | undefined,
    settingsMenu: SettingsMenu | undefined;
  const showPicker = (next: Component) => {
    picker = next;
    pickerSlot.clear();
    pickerSlot.addChild(next);
    tui.setFocus(next);
    tui.requestRender();
  };
  const closePicker = () => {
    picker = undefined;
    settingsMenu = undefined;
    pickerSlot.clear();
    tui.setFocus(editor);
    tui.requestRender();
  };
  /**
   * Single serialized queue for every cross-session interactive prompt: write/process approvals,
   * `/model`'s `select`, and `ask_user_question`/`/ask`'s question panel — at most one of these is
   * ever on screen, regardless of how many sessions (root or nested subagents) ask at once. FIFO by
   * arrival (no root-over-subagent priority): simple, fair, and deterministic. `/model` and
   * `/resume`'s own command-triggered pickers are intentionally NOT routed through this queue: they
   * are user-command-driven (never concurrent with a subagent) and `chooseModel()` does not await
   * picker resolution today, so folding them in would need an unrelated restructuring.
   */
  const interactiveQueue = new InteractiveQueue();
  approve = (request) =>
    interactiveQueue.submit<ApprovalDecision>({
      kind: "approval",
      sessionId: request.session,
      label: request.label,
      signal: request.signal,
      onWithdrawn: () => "deny",
      run: () =>
        new Promise<ApprovalDecision>((resolve) => {
          let settled = false;
          const finish = (decision: ApprovalDecision) => {
            if (settled) return;
            settled = true;
            request.signal.removeEventListener("abort", onAbort);
            closePicker();
            resolve(decision);
          };
          const onAbort = () => finish("deny");
          request.signal.addEventListener("abort", onAbort, { once: true });
          if (request.capability === "analysis.install" && request.install) {
            // Installing the optional packages: only once or deny (never stored), with what is
            // installed, the download estimate and that it needs the network.
            showPicker(
              new Picker(
                `${request.label ? `[${request.label}] ` : ""}${installApprovalTitle(request.install)}`,
                [
                  { value: "once", label: "Allow once" },
                  { value: "deny", label: "Deny" },
                ],
                (item) => finish(item.value as ApprovalDecision),
                () => finish("deny"),
                false,
                installApprovalDetail(request.install),
              ),
            );
            return;
          }
          if (request.capability) {
            // A capability (Python analysis): its own title, the script preview and the
            // not-a-sandbox warning; "for this session" is persisted for the root session.
            showPicker(
              new Picker(
                `${request.label ? `[${request.label}] ` : ""}${capabilityApprovalTitle(request.runtime)}`,
                [
                  { value: "once", label: "Allow once" },
                  { value: "session", label: "Allow for this session" },
                  { value: "deny", label: "Deny" },
                ],
                (item) => finish(item.value as ApprovalDecision),
                () => finish("deny"),
                false,
                [
                  request.preview ?? "",
                  "",
                  request.runtime === "oci"
                    ? "Runs in a container without network access. Repository files are not modified by this step."
                    : `${NOT_SANDBOXED} It could change repository files; Alisio itself does not modify them in this step.`,
                ].join("\n"),
              ),
            );
            return;
          }
          showPicker(
            new Picker(
              `${request.label ? `[${request.label}] ` : ""}Allow ${request.call.name} (${request.effect}): ${summarizeToolArgs(request.call.name, request.call.arguments)}?`,
              [
                { value: "once", label: "Allow once" },
                { value: "session", label: `Always allow ${request.effect} in this session` },
                { value: "deny", label: "Deny" },
              ],
              (item) => finish(item.value as ApprovalDecision),
              () => finish("deny"),
            ),
          );
        }),
    });

  /**
   * External-directory approval: a tool path outside the workspace and every declared extra root
   * asks here before the call runs, scoped to the containing directory (not the individual file),
   * so one approval covers that directory's subtree for the session. Same queue and the same
   * allow-once / allow-session / deny choices as the capability approval above.
   */
  approveExternalDirectory = (request) =>
    interactiveQueue.submit<ApprovalDecision>({
      kind: "approval",
      sessionId: request.session,
      label: request.label,
      signal: request.signal,
      onWithdrawn: () => "deny",
      run: () =>
        new Promise<ApprovalDecision>((resolve) => {
          let settled = false;
          const finish = (decision: ApprovalDecision) => {
            if (settled) return;
            settled = true;
            request.signal.removeEventListener("abort", onAbort);
            closePicker();
            resolve(decision);
          };
          const onAbort = () => finish("deny");
          request.signal.addEventListener("abort", onAbort, { once: true });
          showPicker(
            new Picker(
              `${request.label ? `[${request.label}] ` : ""}Allow access outside the workspace to ${shortenPath(request.directory, homedir(), 72)}?`,
              [
                { value: "once", label: "Allow once" },
                { value: "session", label: "Always allow this directory in this session" },
                { value: "deny", label: "Deny" },
              ],
              (item) => finish(item.value as ApprovalDecision),
              () => finish("deny"),
            ),
          );
        }),
    });

  /**
   * `ask_user_question` / `/ask`: routed through the same `interactiveQueue` as `approve`/`select`,
   * so a root or subagent question never races another prompt for the screen. A question withdrawn
   * while queued or displayed (its session cancelled) resolves every question undefined and prints
   * a notice; it never leaves a stale prompt on screen or blocks the next queued item.
   */
  /**
   * `exit_plan`: the plan is printed in the transcript (above the panel), then the three decisions
   * (and the free-text line for "Add context") are asked through the same queue. Dismissing the
   * panel (Esc) or cancelling the run answers "skip": the tool always returns a result.
   */
  const askPlanReview = (
    request: AskQuestionsRequest,
    plan: PlanReview,
  ): Promise<AskQuestionsResult> => {
    const question = request.questions[0];
    const options = (question?.options ?? []).map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.description ? { description: option.description } : {}),
      ...(option.recommended ? { recommended: true } : {}),
      ...(option.textInput ? { textInput: true } : {}),
    }));
    const withdrawn = (): AskQuestionsResult => ({ [PLAN_QUESTION_ID]: undefined });
    return interactiveQueue.submit<AskQuestionsResult>({
      kind: "question",
      sessionId: request.session,
      label: request.label,
      signal: request.signal,
      onWithdrawn: () => {
        notice("Plan review withdrawn: the run was cancelled.");
        return withdrawn();
      },
      run: () =>
        new Promise<AskQuestionsResult>((resolve) => {
          let settled = false;
          const finish = (result: AskQuestionsResult) => {
            if (settled) return;
            settled = true;
            request.signal?.removeEventListener("abort", onAbort);
            closePicker();
            resolve(result);
          };
          const onAbort = () => {
            notice("Plan review withdrawn: the run was cancelled.");
            finish(withdrawn());
          };
          request.signal?.addEventListener("abort", onAbort, { once: true });
          push({
            kind: "assistant",
            text: planTranscriptMarkdown(plan),
            reasoning: "",
            done: true,
          });
          if (plan.diagrams?.length) {
            // The folder is resolved from the store, never from the model.
            const record = plan.artifact ? app.artifacts.get(plan.artifact.id) : undefined;
            const folder =
              record?.status === "ready"
                ? shortenPath(join(app.artifacts.folder(record), "files"), homedir(), 96)
                : undefined;
            push({
              kind: "assistant",
              text: planDiagramsMarkdown({
                revision: plan.revision,
                diagrams: plan.diagrams,
                ...(folder ? { folder } : {}),
              }),
              reasoning: "",
              done: true,
            });
          }
          showPicker(
            new PlanReviewPanel(
              options,
              {
                title: plan.title,
                revision: plan.revision,
                ...(plan.artifact ? { artifactId: plan.artifact.id } : {}),
                question: question?.question ?? "",
              },
              (effect) => {
                info(
                  `Plan review: ${options.find((o) => o.value === effect.value)?.label ?? effect.value}`,
                );
                finish({
                  [PLAN_QUESTION_ID]: effect.value,
                  ...(effect.text ? { [PLAN_TEXT_KEY]: effect.text } : {}),
                });
              },
              question?.options.find((o) => o.textInput)?.textInput?.placeholder,
            ),
          );
        }),
    });
  };
  const askQuestions = (request: AskQuestionsRequest): Promise<AskQuestionsResult> => {
    if (request.plan && request.questions.length === 1) return askPlanReview(request, request.plan);
    const specs = request.questions.map((q) => ({
      header: q.header,
      question: q.question,
      ...(q.multiSelect ? { multiSelect: true } : {}),
      options: q.options.map((o) => ({
        label: o.label,
        ...(o.description ? { description: o.description } : {}),
        ...(o.recommended ? { recommended: true } : {}),
      })),
    }));
    const withdrawnResult = (): AskQuestionsResult =>
      Object.fromEntries(request.questions.map((q) => [q.id, undefined]));
    const toResult = (
      answers: Array<{ skipped: boolean; indices: number[] } | undefined>,
    ): AskQuestionsResult => {
      const result: AskQuestionsResult = {};
      request.questions.forEach((q, i) => {
        const a = answers[i];
        if (!a || a.skipped) {
          result[q.id] = undefined;
          return;
        }
        const values = a.indices.map((idx) => q.options[idx]?.value ?? "");
        result[q.id] = q.multiSelect ? values : values[0];
      });
      return result;
    };
    return interactiveQueue.submit<AskQuestionsResult>({
      kind: "question",
      sessionId: request.session,
      label: request.label,
      signal: request.signal,
      onWithdrawn: () => {
        notice(
          `${request.label ? `[${request.label}] ` : ""}Question withdrawn: the asking agent was cancelled.`,
        );
        return withdrawnResult();
      },
      run: () =>
        new Promise<AskQuestionsResult>((resolve) => {
          let settled = false;
          const finish = (result: AskQuestionsResult) => {
            if (settled) return;
            settled = true;
            request.signal?.removeEventListener("abort", onAbort);
            closePicker();
            resolve(result);
          };
          const onAbort = () => {
            notice(
              `${request.label ? `[${request.label}] ` : ""}Question withdrawn: the asking agent was cancelled.`,
            );
            finish(withdrawnResult());
          };
          request.signal?.addEventListener("abort", onAbort, { once: true });
          showPicker(
            new QuestionPanel(
              specs,
              (answers) => {
                info(summarizeAnswers(specs, answers));
                finish(toResult(answers));
              },
              request.label,
            ),
          );
        }),
    });
  };

  // ---- Session goal (`/goal`) --------------------------------------------------------------
  // The goal lives in the shared database and `app.goals` (core) owns its rules; this block only
  // shows it, asks the core whether it may continue (`kickGoal`) and starts the continuation as a
  // normal prompt. A claimed continuation can only start once (the core records the claim).
  let goalCache: GoalInfo | undefined;
  const goalRoot = () => app.store.rootOf(session);
  const goalHostView = (): GoalHostView => {
    const asking = interactiveQueue.current();
    return {
      running: busy,
      // What the user typed but did not send goes first (a goal never talks over a draft).
      queuedInput: editor.getText().trim().length > 0,
      ...(asking ? { awaiting: asking.kind ?? "question" } : {}),
      planMode: currentAgent().id === "plan",
      liveTasks: app.tasks.liveCount(goalRoot()),
    };
  };
  /** The cached goal with what it waits for NOW (computed live: no database read per render). */
  const goalInfoNow = (): GoalInfo | undefined => {
    if (!goalCache) return undefined;
    const waiting = goalWaiting({
      ...goalHostView(),
      status: goalCache.status,
      enabled: app.goals.enabled,
      inflight: false,
    });
    return { ...goalCache, ...(waiting ? { waiting } : {}) };
  };
  /** Re-reads the goal; one transcript line when it stopped by itself. */
  const refreshGoal = () => {
    const before = goalCache;
    goalCache = app.goals.info(goalRoot());
    if (
      before &&
      goalCache &&
      before.goalId === goalCache.goalId &&
      before.status === "active" &&
      goalCache.status !== "active" &&
      goalCache.reason !== "user_paused"
    ) {
      const line = goalStopNotice(goalCache);
      if (line) notice(line);
    }
    tui.requestRender();
  };
  onGoalChange = (sessionId) => {
    if (sessionId === goalRoot()) refreshGoal();
  };
  refreshGoal();
  /** The goal continues if the core says so; otherwise it waits (the bar says for what). */
  const kickGoal = (): void => {
    if (stopping || reloading) return;
    try {
      const root = goalRoot();
      if (!app.goals.get(root)) return;
      const decision = app.goals.next(root, goalHostView());
      refreshGoal();
      if (decision.kind !== "continue") return;
      const timeout = app.config.limits.timeoutMs;
      void runPrompt(decision.prompt.display, decision.prompt.text, decision.prompt.display, {
        maxTokens: decision.run.maxTokens,
        timeoutMs: Math.max(1000, Math.min(decision.run.remainingMs, timeout)),
      });
    } catch (cause) {
      error(cause);
    }
  };
  onTaskChange = (task, root) => {
    if (root !== goalRoot()) return;
    // The last background task of a waiting goal ended: it continues.
    if (!isTaskLive(task.status)) setImmediate(kickGoal);
    else refreshGoal();
  };
  /** After a run: folds it into the goal (tokens, turns, breakers). */
  const settleGoalRun = (
    owner: string,
    run: { runId: string; startedAt: number },
    outcome: { cancelled: boolean; result?: unknown; error?: unknown },
  ) => {
    const root = app.store.rootOf(owner);
    if (!app.goals.get(root)) return;
    app.goals.settle(
      root,
      goalOutcome({
        runId: run.runId,
        startedAt: run.startedAt,
        endedAt: Date.now(),
        cancelled: outcome.cancelled,
        ...(outcome.result
          ? { result: outcome.result as Parameters<typeof goalOutcome>[0]["result"] }
          : {}),
        ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      }),
    );
  };
  const goalConfirmReplace = (objective: string, tokenBudget?: number) =>
    showPicker(
      new Picker(
        "This session already has a goal. Replace it?",
        [
          {
            value: "replace",
            label: "Replace it",
            description: "The current goal is removed and the new one starts",
          },
          { value: "keep", label: "Keep the current goal" },
        ],
        (item) => {
          closePicker();
          if (item.value === "replace") startGoal(objective, tokenBudget, true);
        },
        closePicker,
      ),
    );
  const startGoal = (objective: string, tokenBudget: number | undefined, replace: boolean) => {
    const outcome = app.goals.create(goalRoot(), {
      objective,
      ...(tokenBudget ? { tokenBudget } : {}),
      ...(replace ? { replace: true } : {}),
    });
    if (!outcome.ok) return notice(outcome.message);
    refreshGoal();
    notice(
      tokenBudget
        ? "Goal started with a token budget. The agent works on it until it is done, blocked, paused or out of budget."
        : "Goal started. Without a token budget only the turn and time limits stop it: /goal budget=50k sets one.",
    );
    kickGoal();
  };
  /** `/goal …`: everything but the continuation itself. */
  const goalCommand = (args: string) => {
    const root = goalRoot();
    const plan = planGoalCommand(parseGoalCommand(args), {
      goal: app.goals.info(root),
      enabled: app.goals.enabled,
    });
    const applied = (outcome: ReturnType<typeof app.goals.pause>, done: string) => {
      if (!outcome.ok) return notice(outcome.message);
      refreshGoal();
      notice(done);
    };
    switch (plan.kind) {
      case "say":
        return plan.tone === "info" ? info(plan.text) : notice(plan.text);
      case "picker": {
        const goal = app.goals.info(root);
        if (!goal) return;
        return showPicker(
          new Picker(
            "Start or manage the current Session Goal",
            goalPickerItems(goal),
            (item) => {
              closePicker();
              const prefill = goalPickerPrefill(item.value as never, goal);
              if (prefill !== undefined) {
                editor.setText(prefill);
                return tui.requestRender();
              }
              if (item.value === "status") {
                refreshGoal();
                const current = goalInfoNow();
                return current ? info(formatGoalStatus(current)) : undefined;
              }
              goalCommand(item.value);
            },
            closePicker,
          ),
        );
      }
      case "confirm-replace":
        return goalConfirmReplace(plan.objective, plan.tokenBudget);
      case "create":
        return startGoal(plan.objective, plan.tokenBudget, false);
      case "act": {
        const done = {
          pause: "Goal paused: it will not continue until you resume it.",
          resume: "Goal resumed.",
          clear: "Goal cleared.",
        }[plan.action];
        const outcome =
          plan.action === "pause"
            ? app.goals.pause(root)
            : plan.action === "resume"
              ? app.goals.resume(root)
              : app.goals.clear(root);
        applied(outcome, done);
        return plan.action === "resume" ? kickGoal() : undefined;
      }
      case "edit": {
        applied(app.goals.edit(root, plan.objective), "Goal objective updated.");
        return;
      }
      case "edit-prefill":
        editor.setText(plan.text);
        return tui.requestRender();
      case "budget": {
        applied(
          app.goals.setBudget(root, plan.tokens),
          plan.tokens === null ? "Goal token budget removed." : "Goal token budget set.",
        );
        return kickGoal();
      }
    }
  };

  /**
   * After a run: an approved plan (`exit_plan`) starts its implementation exactly once. The claim is
   * a compare-and-set in the session database, so a double Enter or a second surface cannot start
   * a second turn. The agent switches to build BEFORE the turn (the run that took the decision has
   * already ended, so no tool call is cut in half); the permission mode is left as it is. A run the
   * user cancelled drops an approval it had not started yet.
   */
  const followUpPlan = async (owner: string, aborted: boolean) => {
    if (stopping) return;
    try {
      const next = settlePlanRun(app.store, owner, { aborted });
      if (next.kind === "dropped")
        return notice(
          "Plan approval dropped: the run was cancelled before the implementation started.",
        );
      if (next.kind !== "implement") return;
      agentOverride = IMPLEMENTATION_AGENT_ID;
      if (!options.readOnly)
        try {
          await app.updateSetting("agents.active", IMPLEMENTATION_AGENT_ID);
          if (agentOverride === IMPLEMENTATION_AGENT_ID) agentOverride = undefined;
        } catch (cause) {
          agentOverride = undefined;
          return error(
            new Error(
              `The plan was approved but Alisio could not switch to the build agent: ${cause instanceof Error ? cause.message : String(cause)}. Switch with /agent:build and ask it to implement the plan.`,
            ),
          );
        }
      refreshEffort();
      notice(
        `Plan approved: switching to the build agent to implement revision ${next.plan.revision}.`,
      );
      await runPrompt(next.display, next.text, next.display);
    } catch (cause) {
      error(cause);
    }
  };
  const task = async (
    work: (signal: AbortSignal) => Promise<unknown>,
    goalRun?: { runId: string },
  ) => {
    busy = true;
    terminalEvent = false;
    controller = new AbortController();
    const signal = controller.signal;
    const owner = session;
    const startedAt = Date.now();
    const promise = work(signal);
    pending = promise;
    let result: unknown;
    let failure: unknown;
    try {
      result = await promise;
    } catch (e) {
      failure = e;
      if (!terminalEvent) error(e);
    } finally {
      busy = false;
      controller = undefined;
      pending = undefined;
      view = { ...view, streaming: false, compacting: false };
      if (!view.context || view.context.estimated) refreshEstimate();
      tui.requestRender();
      // A finished-task notification held back while this run was busy may go now.
      app.tasks.sessionIdle(app.store.rootOf(owner));
    }
    // The run counts for the session's goal (its tokens, turns and breakers) before anything else
    // starts; an interrupt (Esc) pauses the goal.
    if (goalRun)
      try {
        settleGoalRun(
          owner,
          { runId: goalRun.runId, startedAt },
          {
            cancelled: signal.aborted,
            ...(result !== undefined ? { result } : {}),
            ...(failure !== undefined ? { error: failure } : {}),
          },
        );
      } catch (cause) {
        error(cause);
      }
    await followUpPlan(owner, signal.aborted);
    // The goal continues unless something (a question, a task, plan mode, you) says to wait.
    if (goalRun) kickGoal();
  };
  /** `/tasks`: the background tasks of this session, their live output and the user's stop. */
  const showTasks = () => {
    const owner = () => app.store.rootOf(session);
    const view: TasksView = new TasksView({
      list: () => app.tasks.list(owner(), { limit: 100, mirror: true }),
      read: (id, offset) => app.tasks.read(owner(), id, { offset, reader: "user" }),
      stop: (id) => app.tasks.stop(owner(), id, "user"),
      rows: () => process.stdout.rows ?? 24,
      requestRender: () => tui.requestRender(),
      close: () => {
        tasksView = undefined;
        closePicker();
      },
      active: () => picker === view,
      notice,
    });
    tasksView = view;
    view.start();
    showPicker(view);
  };
  /**
   * The wake-up of a finished background task: ONE run of this session carrying the notification,
   * started through the normal prompt path (`runner.enqueue` would leave the text waiting for the
   * next prompt). It waits (answers `busy`, the core retries) while a turn runs, a question or
   * approval is on screen, or another session is open; it is never started while exiting.
   */
  wakeForTasks = (request) => {
    const decision = wakeDecision({
      exiting: stopping,
      reloading,
      busy,
      promptPending: !!interactiveQueue.current(),
      openRoot: app.store.rootOf(session),
      ownerRoot: request.sessionId,
    });
    if (decision !== "start") return decision === "skip" ? "skip" : "busy";
    void runPrompt(request.display, request.text, request.display);
    return "started";
  };
  /** `/artifacts [filter]`: the root session's artifacts, newest first, then their actions. */
  const browseArtifacts = (filter: string) => {
    const all = app.artifacts
      .list(app.store.rootOf(session), { limit: 500, includeExpired: true })
      .map(toRef);
    const shown = filter ? all.filter((artifact) => matchArtifact(artifact, filter)) : all;
    if (!shown.length)
      return notice(
        all.length ? `No artifacts match "${filter}"` : "No artifacts in this session yet.",
      );
    const byId = new Map(all.map((artifact) => [artifact.id, artifact]));
    const now = Date.now();
    showPicker(
      new Picker(
        `Artifacts · ${shown.length}`,
        shown.map((artifact) => ({ value: artifact.id, label: artifactRow(artifact, now) })),
        (item) => artifactMenu(item.value, filter),
        () => closePicker(),
        true,
        undefined,
        (items, text) =>
          items.filter((item) => {
            const artifact = byId.get(item.value);
            return !!artifact && matchArtifact(artifact, text);
          }),
      ),
    );
  };
  const artifactMenu = (id: string, filter: string) => {
    const record = app.artifacts.get(id);
    if (!record || (record.status !== "ready" && record.status !== "expired")) {
      closePicker();
      return notice("This artifact is no longer available.");
    }
    const artifact = toRef(record);
    const path = app.artifacts.localPath(record);
    const back = () => artifactMenu(id, filter);
    const copyPath = async () => {
      const result = await copy(path);
      closePicker();
      if (result.ok) tui.flash("Path copied");
      else notice(`${copyMessage(result)}. Path: ${path}`);
    };
    /** Opens (or reveals) a store path; without a desktop, offers to copy it instead. */
    const launch = async (target: string, reveal: boolean) => {
      const outcome = await (reveal ? revealPath(target) : openPath(target));
      if (outcome.ok) return closePicker();
      // No desktop (SSH, no display) or no opener: nothing was launched; offer the path.
      return showPicker(
        new Picker(
          cannotOpenMessage(target, outcome),
          [
            { value: "copy", label: "Copy path" },
            { value: "close", label: "Close" },
          ],
          (choice) =>
            choice.value === "copy"
              ? void copy(target).then((result) => {
                  closePicker();
                  if (result.ok) tui.flash("Path copied");
                  else notice(`${copyMessage(result)}. Path: ${target}`);
                })
              : closePicker(),
          () => closePicker(),
        ),
      );
    };
    // `Copy to workspace…` needs artifact_export (absent under --read-only or with analysis off).
    const canExport =
      !options.readOnly && app.registry.list().some((tool) => tool.name === "artifact_export");
    const job = record.executionId ? app.analysis.jobs.get(record.executionId) : undefined;
    // `Rerun` runs python_run { rerunOf } (absent under --read-only or with analysis disabled).
    const canRerun =
      !options.readOnly && app.registry.list().some((tool) => tool.name === "python_run");
    showPicker(
      new Picker(
        artifact.fileName,
        artifactActions(artifact, {
          readOnly: !canExport,
          sources: !!job,
          rerun: !!job && canRerun,
        }),
        (item) =>
          void (async () => {
            if (item.value === "copy") return copyPath();
            if (item.value === "open" || item.value === "reveal")
              return launch(path, item.value === "reveal");
            if (item.value === "preview") {
              const preview = await loadPreview(artifact, path);
              return showPicker(
                new ArtifactPreview(artifact, preview, {
                  height: () => Math.max(5, (process.stdout.rows ?? 24) - 12),
                  open: () => void launch(path, false).catch(error),
                  copy: () => void copyPath().catch(error),
                  close: back,
                }),
              );
            }
            if (item.value === "sources" && job)
              // An explicit user action: the job folder (script, logs, work) of this execution.
              return launch(join(app.artifacts.root, ...job.relDir.split(/[\\/]/)), false);
            if (item.value === "details") {
              const provenance = record.provenance;
              return showPicker(
                new Picker(
                  `Details · ${artifact.fileName}`,
                  [{ value: "back", label: "Back" }],
                  back,
                  back,
                  false,
                  detailRows(artifact, provenance)
                    .map(([label, value]) => `${label}: ${value}`)
                    .join("\n"),
                ),
              );
            }
            if (item.value === "rerun") {
              if (busy) {
                closePicker();
                return notice("Wait until the current run finishes, then run the analysis again.");
              }
              closePicker();
              info(`Run the analysis of ${artifact.fileName} again`);
              // A tool call without the model: the same capability gate as the first run.
              void task((signal) =>
                app.runner.runToolCall(
                  session,
                  "python_run",
                  { rerunOf: id },
                  { signal, display: `Run the analysis of ${artifact.fileName} again` },
                ),
              );
              return;
            }
            if (item.value === "export") {
              if (busy) {
                closePicker();
                return notice("Wait until the current run finishes, then copy the artifact.");
              }
              return showPicker(
                new ConnectInputPrompt({
                  provider: "",
                  title: `Copy ${artifact.fileName} to the workspace`,
                  label: "Folder in the workspace",
                  initial: ".",
                  secret: false,
                  placeholder: ".",
                  hint: "Relative to the workspace. Writing asks first unless --allow-write.",
                  step: 1,
                  steps: 1,
                  onSubmit: (target) => {
                    closePicker();
                    info(`Copy ${artifact.fileName} to the workspace (${target.trim() || "."})`);
                    // A tool call without the model: the write gate (approval) applies as usual.
                    void task((signal) =>
                      app.runner.runToolCall(
                        session,
                        "artifact_export",
                        { id, target: target.trim() || "." },
                        {
                          signal,
                          display: `Copy ${artifact.fileName} to the workspace (${target.trim() || "."})`,
                        },
                      ),
                    );
                  },
                  onCancel: back,
                }),
              );
            }
            if (item.value === "delete")
              return showPicker(
                new Picker(
                  `Delete ${artifact.fileName}? This can't be undone.`,
                  [
                    { value: "delete", label: "Delete" },
                    { value: "cancel", label: "Cancel" },
                  ],
                  (choice) =>
                    void (async () => {
                      if (choice.value !== "delete") return back();
                      await app.artifacts.delete(id);
                      closePicker();
                      notice(`Deleted ${artifact.fileName}`);
                    })(),
                  back,
                ),
              );
          })().catch(error),
        () => browseArtifacts(filter),
      ),
    );
  };
  /** `/permissions`: persisted grants of the root session; choosing one offers to revoke it. */
  const managePermissions = () => {
    const grants = app.capabilityGrants.live(session).map(toGrantWire);
    if (!grants.length) return notice("No saved permissions in this session.");
    showPicker(
      new Picker(
        "Session permissions",
        grants.map((grant) => ({ value: grant.id, label: permissionRow(grant) })),
        (item) =>
          showPicker(
            new Picker(
              `Revoke "${item.label}"?`,
              [
                { value: "revoke", label: "Revoke" },
                { value: "cancel", label: "Cancel" },
              ],
              (choice) => {
                if (choice.value !== "revoke") return managePermissions();
                app.capabilityGrants.revoke(session, item.value, "tui");
                closePicker();
                notice("Permission revoked: the next Python analysis asks again.");
              },
              () => managePermissions(),
            ),
          ),
        () => closePicker(),
      ),
    );
  };
  // ---- Permission modes, agent cycle, /reload and /changelog (modes spec, Phase 1) ----------
  /** Markdown status of the current permission mode and what actually runs without asking. */
  const permissionStatusText = () => {
    const policy = app.runner.policy;
    return [
      describePermissionStatus({
        mode: permissionMode,
        policy,
        approvals: app.runner.approvals,
      }),
      ...(permissionMode === "ask" && policy.external
        ? [
            "",
            "Note: external (network, MCP, plugin tools) was already allowed at startup because plugins or MCP are enabled; pick a mode to set it explicitly.",
          ]
        : []),
    ].join("\n");
  };
  /** Applies a permission mode between turns: it resets "allow for this session" widenings. */
  const setPermissionMode = (target: PermissionMode) => {
    if (busy) return flashHint("A turn is running: wait for it to finish before changing the mode");
    const result = permissionTransition(permissionMode, target);
    if (!result.ok) return notice(result.message);
    app.runner.setPolicy(PERMISSION_MODE_TABLE[target].policy);
    permissionMode = target;
    modePicked = true;
    notice(result.message);
    if (result.warning) notice(result.warning);
    flashHint(`Permission mode: ${target}`);
    tui.requestRender();
  };
  /** `/permission`: ONE menu with the three modes, the status and the saved permissions. */
  const openPermissionMenu = () => {
    const rows = permissionMenuRows(permissionMode);
    showPicker(
      new Picker(
        "Permission mode",
        rows.map((row) => ({ value: row.value, label: row.label, description: row.description })),
        (item) => {
          const choice = item.value as PermissionMenuRow["value"];
          if (choice === "status") {
            closePicker();
            return info(permissionStatusText());
          }
          if (choice === "manage") {
            closePicker();
            return managePermissions();
          }
          if (choice === "full" && permissionMode !== "locked")
            return showPicker(
              new Picker(
                "Enable full access?",
                [
                  { value: "yes", label: "Yes, enable full access" },
                  { value: "no", label: "Cancel" },
                ],
                (confirm) => {
                  closePicker();
                  if (confirm.value === "yes") setPermissionMode("full");
                },
                () => closePicker(),
                false,
                "Writes, commands and network calls will run without asking. This is not a sandbox: anything the agent runs has your user's permissions.",
              ),
            );
          closePicker();
          if (isPermissionMode(choice)) setPermissionMode(choice);
        },
        () => closePicker(),
        false,
        "ask: every effect asks · auto: workspace edits run, commands and network ask · full access: nothing asks (not a sandbox). Modes apply from the next tool call and reset session approvals.",
      ),
    );
  };
  /** Shift+Tab: the next main agent (build, plan, then custom ones); applies from the next prompt. */
  const cycleAgent = async () => {
    const next = nextAgent(mainAgents(), currentAgent().id, 1);
    if (!next) return;
    const previous = currentAgent().name;
    // Set synchronously so a quick second press continues from this agent, not the stale config.
    agentOverride = next.id;
    flashHint(agentCycleHint(next, view.model), 4000);
    if (!options.readOnly) {
      try {
        await app.updateSetting("agents.active", next.id);
        if (agentOverride === next.id) agentOverride = undefined;
      } catch (cause) {
        agentOverride = undefined;
        flashHint(`Could not switch to ${next.name} (still ${previous})`);
        return error(cause);
      }
    }
    refreshEffort();
    tui.requestRender();
    // A goal that waited for the plan agent to leave plan mode may continue now.
    refreshGoal();
    if (!busy) kickGoal();
  };
  /** `/changelog [version]`: a scrollable panel with the shipped, offline changelog. */
  const showChangelog = (args: string) => {
    const selected = selectEntries(loadChangelog(), args ? { version: args } : {});
    if (!selected.found)
      return notice(
        `No changelog entry for version ${args}. Run /changelog to see the latest releases.`,
      );
    showPicker(
      new MarkdownPanel(
        `What's new · Alisio ${VERSION}${args ? ` · ${args}` : ""}`,
        formatChangelogMarkdown(selected.entries),
        closePicker,
        () => Math.max(6, (process.stdout.rows ?? 30) - 14),
      ),
    );
  };
  /** After an upgrade: ONE discreet line (never on a first run), then remember the version. */
  const announceNews = async () => {
    const dir = stateHome();
    const news = changelogNews({
      entries: loadChangelog(),
      current: VERSION,
      lastSeen: (await readViewerState(dir)).lastSeenVersion,
    });
    if (news.show)
      notice(
        `Alisio updated to ${VERSION} · ${news.versions.length} new ${news.versions.length === 1 ? "entry" : "entries"} · /changelog`,
      );
    if (news.record && !options.readOnly) await writeViewerState(dir, { lastSeenVersion: VERSION });
  };
  /**
   * `/reload`: refused mid-turn; validates the configuration, builds a NEW application next to the
   * current one and only then swaps, so a broken config leaves this session untouched.
   */
  const reloadAll = async () => {
    const guard = () =>
      reloadGuard({
        busy,
        runningChildren: panelNodes().filter((node) => node.status === "running").length,
        queuedPrompts: !!interactiveQueue.current(),
        backgroundTasks: app.tasks.liveCount(),
      });
    const reason = guard();
    if (reason) return notice(reason);
    reloading = true;
    flashHint("Reloading configuration…", 60_000);
    try {
      const report = await reloadApplication({
        current: app,
        busy: guard,
        validate: () => validateReloadConfig(appOptions),
        create: () => createApplication(appOptions),
        swap: (next) => rebindApplication(next),
      });
      editor.setAutocompleteProvider(buildSlashCompletionProvider());
      info(formatReloadReport(report));
      for (const failure of app.mcpStartupFailures()) notice(failure);
    } catch (cause) {
      if (cause instanceof ReloadRefusedError) notice(cause.message);
      else if (cause instanceof ReloadFailedError)
        error(new Error(`Reload failed; the current session is unchanged: ${cause.message}`));
      else error(cause);
    } finally {
      reloading = false;
      flashHint("Reload finished", 1500);
    }
  };
  const runPrompt = (
    display: string,
    prompt: string,
    persistDisplay?: string,
    /** The goal's own caps for this run (what is left of its token budget and time). */
    caps?: { maxTokens?: number; timeoutMs?: number },
  ) => {
    // Any pending clipboard-pasted images ride along with the very next turn, then are cleared.
    const attachments = pendingAttachments.map(toApiAttachment);
    pendingAttachments = [];
    attachmentsBar.invalidate();
    push({ kind: "user", text: display });
    // The ACTIVE agent drives the main session: its system prompt is appended per run and a
    // read-only agent narrows the run to reads (no approvals). The persisted reasoning effort is
    // resolved against the ACTIVE model and sent when the model advertises supported levels.
    const agent = currentAgent();
    // An explicit /effort wins; otherwise the agent's own default effort (agentRunOptions) is kept.
    const effort = app.config.agents.effort || !agent.effort ? currentEffort() : undefined;
    // The goal tools are offered while the session has an ACTIVE goal (never to the plan agent).
    const agentOptions = agentRunOptions(agent, { plan: app.config.plan });
    const goalTools = goalOptInTools(app.goals.get(app.store.rootOf(session)), agent.id === "plan");
    const optInTools = [...(agentOptions.optInTools ?? []), ...goalTools];
    const runId = crypto.randomUUID();
    return task(
      (signal) =>
        app.runner.run(session, prompt, signal, {
          ...agentOptions,
          runId,
          ...(optInTools.length ? { optInTools } : {}),
          ...(effort ? { reasoningEffort: effort } : {}),
          ...(persistDisplay ? { display: persistDisplay } : {}),
          ...(attachments.length ? { attachments } : {}),
          ...(caps?.maxTokens !== undefined ? { maxTokens: caps.maxTokens } : {}),
          ...(caps?.timeoutMs !== undefined ? { timeoutMs: caps.timeoutMs } : {}),
        }),
      { runId },
    );
  };

  let resolveExit: () => void = () => {};
  const exited = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  let stopping = false;
  /** Session-end plugin hooks (e.g. memory summary), bounded by the host timeout. */
  const endSession = async (reason: "clear" | "exit") => {
    if (!view.stats.runs || !app.plugins.hasSessionEndHooks) return;
    flashHint("Running session-end plugin hooks…", 60_000);
    tui.renderNow?.();
    try {
      const { failures } = await app.endSession(session, reason);
      for (const f of failures) notice(`Plugin ${f.source} ${f.hook} failed: ${f.error}`);
    } catch (e) {
      error(e);
    } finally {
      hint = undefined;
      tui.requestRender();
    }
  };
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    controller?.abort(new Error("Exiting"));
    // Exit must feel instant: an in-flight turn gets up to 3s (the abort above settles it
    // immediately in practice), then session-end hooks get a short cap — /clear still honors
    // the full pluginHooks.sessionEndTimeoutMs. app.close() later in the main path is itself
    // parallel and capped, so the whole exit path is bounded end to end.
    await bounded(
      pending?.catch(() => {}),
      EXIT_PENDING_CAP_MS,
    );
    await bounded(endSession("exit"), EXIT_SESSION_END_CAP_MS);
    resolveExit();
  };

  const askInput = (input: {
    provider: string;
    label: string;
    initial?: string;
    secret?: boolean;
    placeholder: string;
    hint?: string;
    step: number;
    steps: number;
    title?: string;
  }): Promise<string | undefined> =>
    new Promise((resolve) => {
      showPicker(
        new ConnectInputPrompt({
          ...input,
          initial: input.initial ?? "",
          secret: input.secret ?? false,
          onSubmit: (value) => {
            closePicker();
            resolve(value);
          },
          onCancel: () => {
            closePicker();
            resolve(undefined);
          },
        }),
      );
    });
  const askChoice = (
    title: string,
    choices: Array<{ value: string; label: string; description?: string }>,
  ): Promise<string | undefined> =>
    new Promise((resolve) => {
      showPicker(
        new Picker(
          title,
          choices,
          (item) => {
            closePicker();
            resolve(item.value);
          },
          () => {
            closePicker();
            resolve(undefined);
          },
        ),
      );
    });
  const connect = async () => {
    const registrations = app.providers.list();
    if (!registrations.length) return notice("No provider plugins are registered");
    const providerId = await askChoice(
      "Select provider",
      registrations.map((p) => ({
        value: p.id,
        label: p.name,
        ...(p.description ? { description: p.description } : {}),
      })),
    );
    if (!providerId) return;
    const registration = app.providers.get(providerId);
    if (!registration) return error(`Provider disappeared: ${providerId}`);
    const prior = await app.providerSettings.resolve(providerId);
    const profile: Record<string, string | boolean | number> = { ...(prior?.profile.values ?? {}) };
    const credentials: Record<string, string> = { ...(prior?.credentials ?? {}) };
    const inputFields = registration.fields.filter(
      (field) => field.kind !== "select" && field.kind !== "boolean",
    );
    let inputStep = 0;
    for (const field of registration.fields) {
      if (field.kind === "secret") {
        inputStep++;
        const entered = await askInput({
          provider: registration.name,
          label: field.label,
          secret: true,
          placeholder: credentials[field.key] ? "Leave empty to keep saved value" : "Paste API key",
          hint: field.description ?? "Input is masked and never added to command history",
          step: inputStep,
          steps: inputFields.length,
        });
        if (entered === undefined) return;
        if (entered) credentials[field.key] = entered;
        if (field.required && !credentials[field.key]) return error(`${field.label} is required`);
        continue;
      }
      if (field.kind === "select" || field.kind === "boolean") {
        const options =
          field.kind === "boolean"
            ? [
                { value: "true", label: "Yes" },
                { value: "false", label: "No" },
              ]
            : (field.options ?? []);
        const current = String(profile[field.key] ?? field.defaultValue ?? "");
        const selected = await askChoice(
          field.label,
          [...options].sort((a, b) => Number(b.value === current) - Number(a.value === current)),
        );
        if (selected === undefined) return;
        profile[field.key] = field.kind === "boolean" ? selected === "true" : selected;
        continue;
      }
      const current = String(profile[field.key] ?? field.defaultValue ?? "");
      inputStep++;
      const entered = await askInput({
        provider: registration.name,
        label: field.label,
        initial: current,
        placeholder: field.kind === "url" ? "https://api.example.com/v1" : `Enter ${field.label}`,
        hint:
          field.description ??
          (field.kind === "url" ? "Paste the complete HTTP(S) URL" : undefined),
        step: inputStep,
        steps: inputFields.length,
      });
      if (entered === undefined) return;
      if (field.required && !entered.trim()) return error(`${field.label} is required`);
      profile[field.key] = entered.trim();
    }
    flashHint("Validating connection and loading models…", 60_000);
    let discovered: ModelInfo[];
    try {
      discovered = await app.probeProvider(
        providerId,
        profile,
        credentials,
        AbortSignal.timeout(20_000),
      );
    } catch (cause) {
      return error(cause);
    }
    let model: string | undefined;
    if (discovered.length)
      model = await askChoice(
        `${registration.name} · Select model`,
        providerModelItems(registration.name, discovered, prior?.profile.model),
      );
    else
      model = await askInput({
        provider: registration.name,
        label: "Model ID",
        initial: prior?.profile.model ?? "",
        placeholder: "provider-model-id",
        hint: "The provider returned no model catalog",
        step: inputFields.length + 1,
        steps: inputFields.length + 2,
      });
    if (!model) return;
    // Local servers like llama.cpp omit `context_window` from GET /models, so the bar would show
    // an honest `?`. When the discovered catalog cannot name the window (or is empty), ask ONE
    // optional numeric override and persist it in the profile values when provided.
    const catalogEntry = discovered.find((candidate) => candidate.id === model);
    if (!catalogEntry?.contextWindow) {
      const windowStep = discovered.length ? inputFields.length + 1 : inputFields.length + 2;
      const entered = await askInput({
        provider: registration.name,
        label: "Context window in tokens (optional)",
        initial: profile.contextWindow === undefined ? "" : String(profile.contextWindow),
        placeholder: "131072",
        hint: "For local servers that omit context_window; leave empty to keep the saved value or stay unknown",
        step: windowStep,
        steps: windowStep,
      });
      if (entered === undefined) return;
      if (entered.trim()) {
        const parsed = Number(entered.trim());
        if (!Number.isInteger(parsed) || parsed <= 0)
          return error("Context window must be a positive number of tokens");
        profile.contextWindow = parsed;
      }
    }
    await app.activateProvider(providerId, profile, credentials, model);
    activeProvider = app.providerInfo;
    modelList = undefined;
    session = app.store.create(app.workspace, app.provider.id, model).id;
    reset(initialViewState(model));
    notice(`Connected to ${registration.name} with model ${model}. Started a fresh session.`);
    refreshEstimate();
    primeModels();
  };
  const chooseModel = async () => {
    const catalogs = await app.configuredProviderCatalogs(AbortSignal.timeout(20_000));
    const choices = configuredProviderModelItems(
      catalogs,
      activeProvider?.persisted ? { provider: activeProvider.id, model: view.model } : undefined,
    );
    if (!choices.length) return notice("No plugin provider profiles are configured. Use /connect.");
    const items: SelectItem[] = choices;
    showPicker(
      new Picker(
        "Select provider and model",
        items,
        (item) => {
          closePicker();
          const choice = choices.find((candidate) => candidate.value === item.value);
          if (!choice || choice.unavailable) return flashHint("That provider is unavailable");
          const selected = JSON.parse(choice.value) as {
            profile: string;
            provider: string;
            model: string;
          };
          void app
            .switchModel(`${selected.provider}/${selected.model}`)
            .then((created) => {
              if (!created) return;
              activeProvider = app.providerInfo;
              modelList = undefined;
              session = created.id;
              reset(initialViewState(selected.model));
              notice(
                `Provider changed to ${app.providers.get(selected.provider)?.name ?? selected.provider} with model ${selected.model}. Started a fresh session.`,
              );
              refreshEstimate();
              primeModels();
            })
            .catch(error);
        },
        closePicker,
        true,
      ),
    );
  };
  const managePlugins = () => {
    const catalog = app.pluginCatalog();
    const openCatalog = () => {
      const entries = app.pluginCatalog();
      showPicker(
        new Picker(
          "Plugins",
          pluginCatalogItems(entries),
          (item) => {
            const selected = entries.find((entry) => entry.id === item.value);
            if (!selected) return openCatalog();
            const action = selected.enabled ? "Disable" : "Enable";
            const detail = [
              selected.description,
              `Status: ${selected.status} · Source: ${selected.builtin ? "built-in" : selected.source}`,
              `Category: ${selected.categories.join(", ") || "general"}`,
              selected.diagnostic ?? "Changes are saved for the next Alisio start.",
            ].join("\n");
            showPicker(
              new Picker(
                selected.name,
                [
                  ...(selected.manageable
                    ? [
                        {
                          value: "toggle",
                          label: `${action} ${selected.name}`,
                          description: "Persist project override (restart required)",
                        },
                      ]
                    : []),
                  { value: "back", label: "Back to plugin list" },
                ],
                (choice) => {
                  if (choice.value === "back") return openCatalog();
                  const apply = async () => {
                    try {
                      const updated = await app.setPluginEnabled(selected.id, !selected.enabled, {
                        liveSession: view.stats.runs > 0 || view.streaming,
                      });
                      notice(`${updated.name}: ${updated.diagnostic ?? "restart required"}.`);
                    } catch (cause) {
                      error(cause);
                    }
                    openCatalog();
                  };
                  if (!pluginToggleNeedsConfirmation(selected)) return void apply();
                  showPicker(
                    new Picker(
                      `${action} external plugin?`,
                      [
                        {
                          value: "confirm",
                          label: `Yes, ${action.toLowerCase()} ${selected.name}`,
                          description:
                            "External plugins execute with full process privileges in trusted projects",
                        },
                        { value: "cancel", label: "Cancel" },
                      ],
                      (confirmation) => {
                        if (confirmation.value === "confirm") void apply();
                        else openCatalog();
                      },
                      openCatalog,
                      false,
                      detail,
                    ),
                  );
                },
                openCatalog,
                false,
                detail,
              ),
            );
          },
          closePicker,
          true,
        ),
      );
    };
    if (!catalog.length) return notice("No plugins are available");
    openCatalog();
  };
  const manageSkills = () => {
    const entries = app.skillCatalog();
    if (!entries.length) return notice("No skills are available");
    showPicker(
      new SkillsManager({
        entries,
        height: () => Math.max(6, (process.stdout.rows ?? 24) - 7),
        onClose: closePicker,
        onToggle: (id, enabled) => app.setSkillEnabled(id, enabled),
        onError: error,
        onChanged: notice,
        requestRender: () => tui.requestRender(),
      }),
    );
  };
  const manageMcp = () => {
    const openCatalog = () => {
      const entries = app.mcp.list();
      const serverItems = mcpServerItems(entries);
      const items: { value: string; label: string; description: string }[] = [
        ...serverItems,
        ...(app.mcpAllowPersisted()
          ? [
              {
                value: "!revoke-global",
                label: "Revoke global MCP consent",
                description: "Clear mcp.allow from your user configuration and disconnect servers",
              },
            ]
          : []),
      ];
      if (!items.length) return notice("No MCP servers are configured");
      showPicker(
        new Picker(
          `MCP servers (${entries.length})`,
          items,
          (item) => {
            if (item.value === "!revoke-global") {
              showPicker(
                new Picker(
                  "Revoke global MCP consent?",
                  [
                    {
                      value: "revoke",
                      label: "Revoke and disconnect",
                      description:
                        "Clears mcp.allow; future Alisio starts will not auto-grant or auto-connect MCP servers",
                    },
                    {
                      value: "cancel",
                      label: "Cancel",
                      description: "Keep global MCP consent enabled",
                    },
                  ],
                  (choice) => {
                    if (choice.value !== "revoke") return openCatalog();
                    void app
                      .revokeGlobalMcpConsent()
                      .then(() =>
                        notice(
                          "Global MCP consent revoked. Runtime permission dropped and configured servers disconnected.",
                        ),
                      )
                      .catch(error)
                      .finally(openCatalog);
                  },
                  openCatalog,
                  false,
                  "Removes mcp.allow from your user configuration (~/.config/alisio/config.json) atomically. This run's --allow-mcp flag, if given, keeps permission for this session.",
                ),
              );
              return;
            }
            const selected = app.mcp.info(item.value);
            const source =
              selected.source.kind === "global"
                ? "User"
                : selected.source.kind[0]?.toUpperCase() + selected.source.kind.slice(1);
            const endpoint =
              selected.transport === "stdio"
                ? `Command: ${selected.command}`
                : `URL: ${selected.url}`;
            const detail = [
              `Configured: ${selected.enabled ? "enabled" : "disabled"} · Source: ${source}`,
              `Runtime permission: ${selected.runtimePermission.replace("-", " ")}`,
              `Connection: ${selected.status === "disabled" ? "disconnected" : selected.status}`,
              endpoint,
              selected.source.file
                ? `Config: ${shortenPath(selected.source.file, homedir(), 72)}`
                : "Config: managed by registration source",
              `Capabilities: ${selected.capabilities.join(", ") || "unknown until connected"}`,
              `Tools: ${selected.counts.tools} · Resources: ${selected.counts.resources} · Prompts: ${selected.counts.prompts}`,
              selected.diagnostic,
            ]
              .filter(Boolean)
              .join("\n");
            const connected = selected.status === "connected";
            showPicker(
              new Picker(
                selected.displayName,
                [
                  ...(selected.counts.tools
                    ? [
                        {
                          value: "tools",
                          label: "View tools",
                          description: `${selected.counts.tools} available`,
                        },
                      ]
                    : []),
                  ...(selected.status !== "disabled"
                    ? [
                        {
                          value: "connect",
                          label: connected ? "Reconnect" : "Connect",
                          description: "Start a process or network connection",
                        },
                      ]
                    : []),
                  {
                    value: "toggle",
                    label: selected.status === "disabled" ? "Enable" : "Disable",
                    description: `Persist in ${source.toLowerCase()} configuration`,
                  },
                  { value: "back", label: "Back" },
                ],
                (action) => {
                  if (action.value === "back") return openCatalog();
                  if (action.value === "tools") {
                    const tools = app.mcp.tools(selected.name);
                    return showPicker(
                      new Picker(
                        `${selected.displayName} tools (${tools.length})`,
                        mcpToolItems(tools),
                        () => {},
                        () => manageMcp(),
                        true,
                        "Annotations are server-declared. Unannotated tools are not assumed destructive.",
                      ),
                    );
                  }
                  if (action.value === "connect") {
                    withMcpConsent(() =>
                      app.mcp
                        .reconnect(selected.name, AbortSignal.timeout(15_000))
                        .then(() => notice(`${selected.displayName} connected.`)),
                    );
                    return;
                  }
                  const enabling = !selected.enabled;
                  const applyToggle = () =>
                    app
                      .setMcpEnabled(selected.name, enabling, enabling)
                      .then((updated) =>
                        notice(
                          `${updated.displayName}: configured ${updated.enabled ? "enabled" : "disabled"}; ${updated.status.replace("-", " ")}.`,
                        ),
                      );
                  if (enabling) withMcpConsent(applyToggle);
                  else void applyToggle().catch(error).finally(openCatalog);
                },
                openCatalog,
                false,
                detail,
              ),
            );
          },
          closePicker,
          true,
          "[x] connected · [-] disconnected · [ ] disabled · [!] failed · [?] needs authentication · [*] restart required",
        ),
      );
    };
    const withMcpConsent = (action: () => Promise<unknown>) => {
      if (options.readOnly) {
        error("MCP is unavailable under --read-only");
        return openCatalog();
      }
      const run = () => void action().catch(error).finally(openCatalog);
      if (app.mcpRuntimePermission() === "granted") return run();
      showPicker(
        new Picker(
          "Grant MCP access?",
          [
            {
              value: "grant-session",
              label: "Grant for this session only",
              description: "May start the configured process or network connection; not saved",
            },
            {
              value: "grant-remember",
              label: "Grant and remember for this user (global)",
              description: "Persists mcp.allow in your user configuration for every session",
            },
            {
              value: "cancel",
              label: "Cancel",
              description: "Make no permission or server changes",
            },
          ],
          (choice) => {
            if (choice.value === "cancel") return openCatalog();
            if (choice.value === "grant-session") {
              try {
                app.grantMcpRuntimePermission({ source: "interactive-tui", confirmed: true });
                notice("MCP process/network access granted for this Alisio session only.");
                run();
              } catch (cause) {
                error(cause);
                openCatalog();
              }
              return;
            }
            void app
              .rememberGlobalMcpConsent()
              .then(() => {
                notice(
                  "MCP process/network access granted globally (mcp.allow) for this user. Enabled servers will auto-connect on every start.",
                );
                run();
              })
              .catch((cause) => {
                error(cause);
                openCatalog();
              });
          },
          openCatalog,
          false,
          "Session-only lasts until Alisio exits. Remembering writes mcp.allow=true to your user configuration so every start grants MCP access and auto-connects enabled servers, including headless runs. MCP servers and their tools run with your user privileges.",
        ),
      );
    };
    openCatalog();
  };
  /**
   * `/agents` (active agent): a navigable picker listing every selectable main-session agent with
   * its description. Selecting one persists `agents.active` globally (applies from the next
   * prompt), optionally switches the session model to the agent's declared model, and starts a
   * fresh session just like `/model` when it does. Esc returns to the editor.
   */
  const openAgentsPicker = () => {
    const agents = mainAgents();
    const current = currentAgent();
    const rows = [...AGENT_PICKER_ACTIONS, ...agentPickerRows(agents, current.id, agentRoots())];
    showPicker(
      new Picker(
        "Agents",
        rows,
        (item) => {
          if (item.value === "__agents:new") {
            closePicker();
            return void newAgentFlow().catch(error);
          }
          if (item.value === "__agents:manage") {
            closePicker();
            return void manageAgents().catch(error);
          }
          const agent = agents.find((candidate) => candidate.id === item.value);
          if (agent) void applyActiveAgent(agent);
        },
        closePicker,
        true,
        "Type to search by name or description. Selecting an agent activates it from the next prompt; build (default) returns to the default Alisio agent.",
        (items, filter) => filterAgentRows(items, filter),
      ),
    );
  };
  const applyActiveAgent = (agent: ActiveAgent) => {
    void (async () => {
      closePicker();
      const previous = currentAgent().name;
      try {
        await app.updateSetting("agents.active", agent.id);
        let switched = false;
        if (agent.model && app.store.get(session).model !== agent.model) {
          flashHint(`Switching to ${agent.name}'s model ${agent.model}…`, 60_000);
          const created = await app.switchModel(agent.model);
          if (created) {
            activeProvider = app.providerInfo;
            modelList = undefined;
            session = created.id;
            reset(initialViewState(created.model));
            switched = true;
          }
        }
        notice(
          `Active agent: ${agent.name}${agent.readOnly ? " (read-only)" : ""}. Applies from the next prompt.`,
        );
        if (agent.model && switched)
          notice(
            `Agent ${agent.name} switches the session model to ${app.store.get(session).model}.`,
          );
        else if (agent.model)
          flashHint(
            `Agent ${agent.name} keeps the current model (already ${view.model}). Override any time with /model.`,
          );
        else flashHint(`Active agent: ${agent.name} (was ${previous}).`);
        refreshEffort();
        primeModels();
        tui.requestRender();
        refreshGoal();
        if (!busy) kickGoal();
      } catch (cause) {
        error(cause);
      }
    })();
  };
  // ---- Agent manager: project/global `.agents/agents` files (shared core service) ----------
  const agentRoots = () => ({ workspace: app.workspace, home: homedir() });
  let agentModels: AgentModelOption[] | undefined;
  /** Configured models with capabilities (cached per process; the running model always listed). */
  const loadAgentModels = async (): Promise<AgentModelOption[]> => {
    if (agentModels) return agentModels;
    let options: AgentModelOption[] = [];
    try {
      options = agentModelOptions(await app.listAvailableModels(), {
        ...(app.providerInfo?.profileName ? { profile: app.providerInfo.profileName } : {}),
        ...(app.providerInfo?.id ? { provider: app.providerInfo.id } : {}),
        model: view.model,
      });
    } catch {
      /* configured catalogs unavailable: offer the running model only */
    }
    if (!options.some((option) => option.active)) {
      const capabilities = agentModelCapabilities(
        modelCatalog.get(view.model) ?? { id: view.model },
      );
      options.unshift({
        reference: view.model,
        provider: app.provider.id,
        profile: app.providerInfo?.profileName ?? "",
        providerName: app.providers.get(activeProvider?.id ?? "")?.name ?? app.provider.id,
        id: view.model,
        active: true,
        capabilities,
        labels: agentModelLabels(capabilities),
      });
    }
    agentModels = options;
    return options;
  };
  const capabilitiesOf = (models: AgentModelOption[], reference: string) =>
    models.find((m) => m.reference === reference || m.id === reference)?.capabilities ??
    agentModelCapabilities(undefined);
  const defaultAgentModel = (models: AgentModelOption[]) =>
    models.find((m) => m.active)?.reference ?? view.model;
  /**
   * "Building with Alisio": one tool-less call of the ACTIVE model writes (or refines) the agent
   * with the authoring guidance (a discovered `create-agent` skill, else the bundled one). Runs as
   * a task, so Esc cancels it; failures are reported and leave the form untouched.
   */
  const buildWithAlisio = async (
    description: string,
    base?: AgentForm,
  ): Promise<AgentDraft | undefined> => {
    let draft: AgentDraft | undefined;
    flashHint("◐ Building with Alisio… writing the agent instructions · Esc to cancel", 180_000);
    await task(async (signal) => {
      draft = await generateAgentDraft(app.provider, description, {
        signal,
        guidance: await agentAuthoringGuidance(app.skills),
        ...(base
          ? {
              base: {
                name: base.name,
                description: base.description,
                instructions: base.instructions,
              },
            }
          : {}),
      });
    });
    flashHint(
      draft
        ? `Draft by ${draft.generatedBy} (${draft.guidance}). Review it, then save.`
        : "Building with Alisio stopped; nothing was changed.",
      5000,
    );
    return draft;
  };
  /** Saves a form; reports honestly whether the running registry already uses the change. */
  const saveAgentForm = async (form: AgentForm, models: AgentModelOption[]) => {
    const input = formToInput(form, capabilitiesOf(models, form.model));
    const change = form.id
      ? await app.agentDefinitions.update(form.scope, form.id, input)
      : await app.agentDefinitions.create(form.scope, input);
    editor.setAutocompleteProvider(buildSlashCompletionProvider());
    notice(
      change.live
        ? `Agent ${change.result.name} saved to ${change.result.path} and available now: /agent:${change.result.id}.`
        : `Agent ${change.result.name} saved to ${change.result.path}. Restart Alisio to use it${form.scope === "project" ? " (project agents also need a trusted workspace)" : ""}.`,
    );
    return change;
  };
  /** Starts a fresh session with `id` as the active agent (the "Try it" action). */
  const tryAgentInNewSession = async (id: string) => {
    const agent = mainAgents().find((candidate) => candidate.id === id);
    if (!agent)
      return notice(`Agent ${id} is not loaded in this process; restart Alisio to try it.`);
    await endSession("clear");
    await app.updateSetting("agents.active", agent.id);
    let created: Awaited<ReturnType<typeof app.switchModel>>;
    if (agent.model && agent.model !== view.model)
      created = await app.switchModel(agent.model).catch(() => undefined);
    if (created) {
      activeProvider = app.providerInfo;
      modelList = undefined;
      session = created.id;
      reset(initialViewState(created.model));
    } else {
      session = app.store.create(app.workspace, app.provider.id, view.model).id;
      reset(initialViewState(view.model));
    }
    notice(`New session ${session} with agent ${agent.name}. Type a prompt to try it.`);
    void app.herdr.report("idle", session);
    refreshEffort();
    refreshEstimate();
  };
  /** After the first save: try the agent in a new session (default) or keep editing. */
  const offerTryAgent = async (form: AgentForm, models: AgentModelOption[], live: boolean) => {
    const choice = await askChoice(
      `Agent ${form.name} created`,
      live
        ? [
            { value: "try", label: "▶ Try it in a new session", description: "Default" },
            { value: "stay", label: "Stay in editor" },
          ]
        : [{ value: "stay", label: "Stay in editor", description: "Restart Alisio to try it" }],
    );
    if (choice === "try" && form.id) return tryAgentInNewSession(form.id);
    if (choice === "stay") return openAgentEditor(form, models, form);
  };
  /** The editor: one picker row per field; each edit returns to it. Esc closes. */
  const openAgentEditor = async (
    initial: AgentForm,
    models: AgentModelOption[],
    saved?: AgentForm,
  ): Promise<void> => {
    let form = initial;
    let baseline = saved ? JSON.stringify(saved) : undefined;
    const show = () => {
      const capabilities = capabilitiesOf(models, form.model);
      const dirty = baseline === undefined || JSON.stringify(form) !== baseline;
      showPicker(
        new Picker(
          form.id ? `Agents › ${form.name}` : "Agents › New agent",
          agentEditorRows(form, capabilities, {
            creating: !form.id,
            scopes: app.agentDefinitions.scopes,
            dirty,
          }),
          (item) => {
            closePicker();
            void edit(item.value as AgentField, dirty).catch((cause) => {
              error(cause);
              show();
            });
          },
          closePicker,
          false,
          `${form.scope === "project" ? "Project" : "Global"} scope · ${shortenPath(app.agentDefinitions.dir(form.scope), homedir())}`,
        ),
      );
    };
    const input = (label: string, initialValue: string, placeholder: string, hint?: string) =>
      askInput({
        provider: "agent",
        title: form.id ? `Agents › ${form.name}` : "Agents › New agent",
        label,
        initial: initialValue,
        placeholder,
        ...(hint ? { hint } : {}),
        step: 1,
        steps: 1,
      });
    const edit = async (field: AgentField, dirty: boolean): Promise<void> => {
      const capabilities = capabilitiesOf(models, form.model);
      switch (field) {
        case "scope": {
          const scope = await askChoice(
            "Scope",
            app.agentDefinitions.scopes.map((value) => ({
              value,
              label: value === "project" ? "Project" : "Global",
              description: app.agentDefinitions.dir(value),
            })),
          );
          if (scope === "project" || scope === "global") form = { ...form, scope };
          break;
        }
        case "name": {
          const value = await input("Name", form.name, "New agent");
          if (value !== undefined) form = { ...form, name: value.trim() };
          break;
        }
        case "description": {
          const value = await input(
            "Description",
            form.description,
            "One sentence: what this agent does",
          );
          if (value !== undefined) form = { ...form, description: value.trim() };
          break;
        }
        case "instructions": {
          const value = await input(
            "Instructions",
            encodeMultiline(form.instructions),
            "Describe desired model behavior (tone, tool usage, response style)",
            "Type \\n for a new line. ✦ Refine with Alisio writes them for you.",
          );
          if (value !== undefined) form = { ...form, instructions: decodeMultiline(value) };
          break;
        }
        case "model": {
          const value = await askChoice(
            "Model",
            models.map((m) => ({
              value: m.reference,
              label: `${m.name ?? m.id} · ${m.providerName}${m.active ? " (active)" : ""}${m.reference === form.model ? " ✓" : ""}`,
              description: m.labels.join(" · ") || "capabilities not declared by the provider",
            })),
          );
          if (value) {
            const fitted = formToInput({ ...form, model: value }, capabilitiesOf(models, value));
            form = {
              ...form,
              model: value,
              reasoning: { ...(fitted.reasoning ?? {}) },
              text: {
                ...(fitted.text?.format ? { format: fitted.text.format.type } : {}),
                ...(fitted.text?.verbosity ? { verbosity: fitted.text.verbosity } : {}),
              },
            };
          }
          break;
        }
        case "effort":
        case "summary":
        case "verbosity":
        case "format": {
          if (field !== "format" && !agentFieldSupported(field, capabilities)) {
            flashHint(`${form.model} does not support this setting.`);
            break;
          }
          const value = await askChoice(field, agentFieldChoices(field, capabilities));
          if (value === undefined) break;
          const clear = value === "!clear" ? undefined : value;
          if (field === "effort")
            form = { ...form, reasoning: { ...form.reasoning, effort: clear } };
          if (field === "summary")
            form = {
              ...form,
              reasoning: { ...form.reasoning, summary: clear as AgentForm["reasoning"]["summary"] },
            };
          if (field === "verbosity")
            form = {
              ...form,
              text: { ...form.text, verbosity: clear as AgentForm["text"]["verbosity"] },
            };
          if (field === "format")
            form = {
              ...form,
              text: { ...form.text, format: clear as AgentForm["text"]["format"] },
            };
          break;
        }
        case "refine": {
          const changes = await input(
            "What should change? (optional)",
            "",
            "e.g. focus on security, answer in Spanish",
          );
          if (changes === undefined) break;
          const draft = await buildWithAlisio(changes, form);
          if (draft) form = applyDraft(form, draft);
          break;
        }
        case "save": {
          const errors = formErrors(form);
          if (errors.length) {
            flashHint(errors.join("; "), 5000);
            break;
          }
          if (!dirty) {
            flashHint("No unsaved changes");
            break;
          }
          const creating = !form.id;
          const change = await saveAgentForm(form, models);
          form = { ...form, id: change.result.id, name: change.result.name };
          baseline = JSON.stringify(form);
          if (creating) return offerTryAgent(form, models, change.live);
          break;
        }
        case "cancel": {
          if (dirty) {
            const discard = await askChoice("Discard unsaved changes?", [
              { value: "keep", label: "Keep editing" },
              { value: "discard", label: "Discard and close" },
            ]);
            if (discard === "discard") return;
            break;
          }
          return;
        }
      }
      show();
    };
    show();
  };
  /** `/agents new [description]`: assisted (with a description), template or blank. */
  const newAgentFlow = async (description?: string) => {
    const models = await loadAgentModels();
    const blank = emptyAgentForm(app.agentDefinitions.defaultScope, defaultAgentModel(models));
    let mode = description ? "assisted" : undefined;
    if (!mode)
      mode = await askChoice("Agents › New agent", [
        {
          value: "assisted",
          label: "✦ Describe it — Alisio writes the agent",
          description: "The active model drafts the name, instructions and settings",
        },
        { value: "template", label: "From a template…" },
        { value: "blank", label: "Blank agent" },
      ]);
    if (mode === "template") return chooseAgentTemplate();
    if (mode === "blank") return openAgentEditor(blank, models);
    if (mode !== "assisted") return;
    const text =
      description ??
      (await askInput({
        provider: "agent",
        title: "Agents › New agent",
        label: "Describe the agent you want",
        initial: "",
        placeholder: "e.g. reviews pull requests for security issues",
        step: 1,
        steps: 1,
      }));
    if (!text?.trim()) return;
    const draft = await buildWithAlisio(text);
    if (!draft) return;
    const form = applyDraft(blank, draft);
    if (formErrors(form).length) return openAgentEditor(form, models);
    const change = await saveAgentForm(form, models);
    return offerTryAgent({ ...form, id: change.result.id }, models, change.live);
  };
  /** `/agents templates`: pick a template, then customize it (and optionally refine it). */
  const chooseAgentTemplate = async () => {
    const models = await loadAgentModels();
    showPicker(
      new Picker(
        "Agents › Templates",
        AGENT_TEMPLATES.map((template) => ({
          value: template.id,
          label: template.name,
          description: template.description,
        })),
        (item) => {
          closePicker();
          const template = AGENT_TEMPLATES.find((candidate) => candidate.id === item.value);
          if (template)
            void openAgentEditor(
              formFromTemplate(
                template,
                app.agentDefinitions.defaultScope,
                defaultAgentModel(models),
              ),
              models,
            ).catch(error);
        },
        closePicker,
        true,
        "Type to search. The template opens in the editor; ✦ Refine with Alisio adapts it to your changes.",
        (items, filter) => filterAgentRows(items, filter),
      ),
    );
  };
  /** `/agents manage`: saved project/global agents → edit, activate, try or delete. */
  const manageAgents = async () => {
    const list = await app.agentDefinitions.list();
    if (!list.length) return notice("No saved agents yet. Create one with /agents new.");
    showPicker(
      new Picker(
        "Agents › Saved agents",
        list.map((a) => ({
          value: `${a.scope}:${a.id}`,
          label: `${a.name} [${a.scope === "project" ? "Project" : "Global"}]${a.overridesGlobal ? " overrides global" : ""}${a.overriddenByProject ? " (overridden by project)" : ""}`,
          description: [a.description, a.model].filter(Boolean).join(" · "),
        })),
        (item) => {
          closePicker();
          const found = list.find((a) => `${a.scope}:${a.id}` === item.value);
          if (found) void agentActions(found).catch(error);
        },
        closePicker,
        true,
        `Project: ${app.agentDefinitions.scopes.includes("project") ? app.agentDefinitions.dir("project") : "—"} · Global: ${app.agentDefinitions.dir("global")}`,
        (items, filter) => filterAgentRows(items, filter),
      ),
    );
  };
  const agentActions = async (definition: AgentDefinitionInfo) => {
    const action = await askChoice(`${definition.name} [${definition.scope}]`, [
      { value: "edit", label: "Edit" },
      { value: "activate", label: "Activate in this session", description: "From the next prompt" },
      { value: "try", label: "Try it in a new session" },
      { value: "delete", label: "Delete", description: definition.path },
    ]);
    if (action === "edit") {
      const form = formFromDefinition(definition);
      return openAgentEditor(form, await loadAgentModels(), form);
    }
    if (action === "try") return tryAgentInNewSession(definition.id);
    if (action === "activate") {
      const agent = mainAgents().find((candidate) => candidate.id === definition.id);
      if (!agent) return notice(`Agent ${definition.id} is not loaded; restart Alisio to use it.`);
      return applyActiveAgent(agent);
    }
    if (action === "delete") {
      const confirm = await askChoice(`Delete ${definition.path}?`, [
        { value: "no", label: "Keep it" },
        { value: "yes", label: "Delete the file" },
      ]);
      if (confirm !== "yes") return;
      const change = await app.agentDefinitions.delete(definition.scope, definition.id);
      editor.setAutocompleteProvider(buildSlashCompletionProvider());
      notice(
        change.live
          ? `Deleted agent ${definition.name}; it is no longer offered.`
          : `Deleted ${definition.path}. Restart Alisio to drop it from the running agents.`,
      );
    }
  };
  /** Routes `/agents [verb]`: TUI manager verbs, else the subagents plugin's verbs. */
  const agentsCommand = async (args: string, raw: string): Promise<unknown> => {
    const command = parseAgentsArgs(args);
    if (command.kind === "plugin") {
      const handler = app.plugins.commands.get("agents");
      if (!handler) return error("Subagent task management needs the Subagents plugin.");
      const output = await handler(command.args, { sessionId: session });
      if (/^reload\b/.test(command.args))
        editor.setAutocompleteProvider(buildSlashCompletionProvider());
      return info(output);
    }
    if (busy) {
      editor.setText(raw);
      flashHint("A turn is running: wait for it to finish before managing agents");
      return;
    }
    switch (command.kind) {
      case "picker":
        // Pick up files edited outside Alisio before listing.
        await app.agentDefinitions.reload();
        return openAgentsPicker();
      case "new":
        return newAgentFlow(command.description);
      case "templates":
        return chooseAgentTemplate();
      case "manage":
        return manageAgents();
      case "edit":
      case "delete": {
        const list = await app.agentDefinitions.list();
        const found =
          list.find((a) => a.id === command.id && (!command.scope || a.scope === command.scope)) ??
          undefined;
        if (!found) return error(`No saved agent ${command.id}. See /agents manage.`);
        if (command.kind === "edit") {
          const form = formFromDefinition(found);
          return openAgentEditor(form, await loadAgentModels(), form);
        }
        return agentActions(found);
      }
    }
  };
  /**
   * `/effort [level]`: without an argument, a picker over the ACTIVE model's advertised effort
   * levels (marking the model default); with an argument, the level is validated against
   * `effort.supportedLevels` and persisted globally. The chosen level is sent from the next
   * prompt; if the model later changes to one that does not support it, the model's default is
   * used silently with a one-time notice.
   */
  const setEffort = async (args: string) => {
    const capability = effortSupportFor(view.model);
    if (!args) {
      if (!capability?.supportedLevels?.length)
        return notice(
          `${view.model} does not advertise reasoning effort levels (ModelInfo.effort), so /effort is not available for it.`,
        );
      const items = effortPickerItems(capability, currentEffort());
      showPicker(
        new Picker(
          `Reasoning effort · ${modelDisplayName(view.model)}`,
          items,
          (item) => void applyEffort(item.value),
          closePicker,
          true,
        ),
      );
      return;
    }
    const invalid = validateEffortLevel(args, capability);
    if (invalid) return notice(invalid);
    await applyEffort(args);
  };
  const applyEffort = async (value: string) => {
    const clear = value === "!clear";
    closePicker();
    try {
      await app.updateSetting("agents.effort", clear ? undefined : value);
      const capability = effortSupportFor(view.model);
      const effective = effectiveEffort(clear ? undefined : value, capability);
      notice(
        clear
          ? `Reasoning effort cleared; ${capability?.defaultLevel ? `the model default "${capability.defaultLevel}" is used` : "the provider default is used"}.`
          : `Reasoning effort: ${value}${value === capability?.defaultLevel ? ` (default for ${modelDisplayName(view.model)})` : ""}${effective && effective !== value ? ` — effective: ${effective}` : ""}. Applies from the next prompt.`,
      );
      refreshEffort();
      tui.requestRender();
    } catch (cause) {
      error(cause);
    }
  };
  /**
   * Navigation rows at the bottom of `/settings`: they route to the existing managers and one-shot
   * actions exactly like the old picker, so every prior entry stays reachable. `compact` and
   * `stats` finish here and re-open the settings list (mirroring managePlugins' openCatalog loop);
   * rows that delegate to another manager (provider/model, connect, plugins, skills, MCP) leave
   * the list and that manager owns its Esc/back behavior.
   */
  const SETTINGS_NAVIGATION: SettingsNavigationAction[] = [
    {
      id: "model",
      label: "Provider & model",
      description: "Switch the active provider and model",
    },
    {
      id: "connect",
      label: "Connect provider",
      description: "Configure a provider and choose its active model",
    },
    {
      id: "compact",
      label: "Compact context now",
      description: "Summarize older history with the current model, then return here",
    },
    { id: "plugins", label: "Plugins", description: "Browse and manage project plugins" },
    { id: "skills", label: "Skills", description: "Browse and manage effective skills" },
    { id: "mcp", label: "MCP servers", description: "Browse and manage MCP servers" },
    {
      id: "stats",
      label: "Session statistics",
      description: "View session statistics, then return here",
    },
  ];
  /**
   * Central `/settings` (`/prefs`) menu: an OpenCode-style list of REAL, wired preferences
   * (compaction, context fallback, MCP consent, limits, editor padding) with a live type-to-search
   * filter, Enter/Space to cycle a value, a `(n/total)` counter, and a footer describing the
   * highlighted row. Esc returns to the editor. Every setting persists to the GLOBAL user config
   * through `app.updateSetting` (or the MCP consent path) and is applied to the running process
   * where supported; rows rebuild from the live config after each change.
   */
  const openSettings = () => {
    const providerName = app.providers.get(activeProvider?.id ?? "")?.name;
    const current = view.model
      ? providerName
        ? `${providerName} · ${view.model}`
        : view.model
      : "";
    const build = () =>
      settingsMenuRows(
        {
          config: app.config,
          mcpAllowPersisted: app.mcpAllowPersisted(),
          readOnly: !!options.readOnly,
        },
        SETTINGS_NAVIGATION,
      );
    const applySetting = (row: SettingRow, value: unknown) => {
      const settle = () => settingsMenu?.refresh(build());
      if (row.id === "mcp.allow") {
        const consent =
          value === true ? app.rememberGlobalMcpConsent() : app.revokeGlobalMcpConsent();
        void consent
          .then(() =>
            notice(
              value === true
                ? "MCP consent remembered globally (mcp.allow); enabled servers will auto-connect on every start. Use /mcps to connect them now."
                : "Global MCP consent revoked: runtime permission dropped and configured servers disconnected.",
            ),
          )
          .catch(error)
          .finally(settle);
        return;
      }
      const stored =
        row.id === "limits.timeoutMs" || row.id === "analysis.limits.timeoutMs"
          ? Number(value) * 1000
          : value;
      void app
        // Setting ids are the exact SettableSettingKey paths SETTINGS_DEFINITIONS is built from.
        .updateSetting(row.id as SettableSettingKey, stored)
        .then(() => {
          if (row.id === "tui.paddingX") editor.setPaddingX(Number(value));
          // The inset wrapper reads the live config; repaint so the new value shows immediately.
          if (row.id === "tui.contentPaddingX") tui.requestRender();
          // Rebuild the slash provider: the toggle gates the skill:<id> entries immediately.
          if (row.id === "tui.skillSlashCommands")
            editor.setAutocompleteProvider(buildSlashCompletionProvider());
        })
        .catch(error)
        .finally(settle);
    };
    const navigate = (row: SettingRow) => {
      switch (row.action) {
        case "model":
          closePicker();
          return void chooseModel();
        case "connect":
          closePicker();
          return void connect();
        case "compact":
          closePicker();
          void task((signal) => app.runner.compact(session, { signal }))
            .catch(error)
            .then(openSettings);
          return;
        case "plugins":
          closePicker();
          return managePlugins();
        case "skills":
          closePicker();
          return manageSkills();
        case "mcp":
          closePicker();
          return manageMcp();
        case "stats":
          closePicker();
          info(statsReport());
          openSettings();
          return;
        default:
          return openSettings();
      }
    };
    const menu = new SettingsMenu(
      "Settings",
      build(),
      applySetting,
      navigate,
      closePicker,
      [
        current ? `Current: ${current}` : "",
        ...(options.readOnly ? ["Read-only run: changes are not persisted"] : []),
      ]
        .filter(Boolean)
        .join("\n") || undefined,
    );
    settingsMenu = menu;
    showPicker(menu);
  };
  const workspaceSessions = () =>
    app.store.list().filter((s) => s.workspace === app.workspace && s.provider === app.provider.id);
  const firstPrompt = (id: string) => {
    const first = app.store.messages(id).find((m) => m.role === "user" && !m.summary);
    return first?.role === "user" ? first.text.replace(/\s+/g, " ").slice(0, 60) : "";
  };
  const resume = (target: string) => {
    const matches = workspaceSessions().filter((s) => s.id.startsWith(target));
    if (matches.length !== 1)
      return error(
        matches.length
          ? `Ambiguous session prefix: ${target}`
          : `No session in this workspace matches ${target}`,
      );
    const found = matches[0];
    if (!found) return;
    session = found.id;
    reset({
      ...initialViewState(found.model),
      items: itemsFromHistory(app.store.messages(found.id)),
    });
    notice(`Resumed session ${found.id}`);
    refreshGoal();
    refreshEstimate();
  };
  const statsReport = () => {
    const s = view.stats;
    const budget = app.contextBudget(view.model);
    const tools = Object.entries(s.tools)
      .map(([name, t]) => `| \`${name}\` | ${t.calls} | ${t.errors} |`)
      .join("\n");
    const decisionSection = formatDecisionStatsSection(summarizeDecisionEvents(s.decisions ?? []));
    return [
      "**Session statistics**",
      "",
      `- Session: \`${session}\``,
      `- Model: \`${view.model}\`${s.models.length > 1 ? ` (used: ${s.models.join(", ")})` : ""}`,
      `- Tokens: in ${formatTokens(s.input)} · out ${formatTokens(s.output)} · cached ${formatTokens(s.cached)}`,
      `- Runs: ${s.runs} · turns: ${s.turns}${s.lastRunMs !== undefined ? ` · last run ${formatDuration(s.lastRunMs)}` : ""}`,
      `- Duration: ${formatDuration(Date.now() - s.startedAt)}`,
      `- Context: ${formatContext(view.context?.used ?? 0, budget?.total, view.context?.estimated ?? true, budget?.basis)}`,
      "",
      tools ? `| Tool | Calls | Errors |\n| --- | --- | --- |\n${tools}` : "No tool calls yet.",
      "",
      ...(decisionSection ? [decisionSection, ""] : []),
      "**Extensions**",
      "",
      `- mascot: ${app.plugins.extensions.resolve("mascot")?.provider.id ?? "alisio.default"} · startup screen: ${app.plugins.extensions.resolve("startup-screen")?.provider.id ?? "alisio.default"}`,
      ...[...app.plugins.extensions.conflicts(), ...startupDiagnostics].map(
        (d) =>
          `- ${"winner" in d ? `extension_conflict ${d.point}: ${d.winner} over ${d.losers.join(", ")}` : `${d.type} ${d.source} ${d.hook}: ${d.error}`}`,
      ),
      `- prompt templates: ${app.prompts.templates.size}`,
      ...app.prompts.diagnostics.map((d) => `- ${d.type} ${JSON.stringify(d).slice(0, 160)}`),
      "",
      ...(app.plugins.status.size
        ? [
            "**Plugins**",
            "",
            ...[...app.plugins.status.values()].map((x) => `- ${x.plugin}: ${x.detail ?? x.text}`),
            "",
          ]
        : []),
      "Token counts cover this TUI process only and depend on provider usage reports.",
    ].join("\n");
  };
  const helpReport = () =>
    [
      "**Commands**",
      "",
      ...COMMANDS.map(
        (c) =>
          `- \`/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description}${c.aliases ? ` (alias: ${c.aliases.map((a) => `/${a}`).join(", ")})` : ""}`,
      ),
      ...[...app.plugins.commandInfo.entries()]
        .filter(([name]) => !resolveCommand(name))
        .map(
          ([name, c]) =>
            `- \`/${name}${c.argumentHint ? ` ${c.argumentHint}` : ""}\` — ${c.description ?? "plugin command"} (plugin ${c.plugin})`,
        ),
      ...(app.prompts.templates.size
        ? [
            "",
            "**Prompt templates** (rendered and sent as your message)",
            "",
            ...[...app.prompts.templates.values()].map(
              (t) =>
                `- \`/${t.name}${t.argumentHint ? ` ${t.argumentHint}` : ""}\` — ${t.description} (${t.source}${t.requires.length ? `, needs ${t.requires.join("+")}` : ""})`,
            ),
            "",
          ]
        : []),
      "- `/skill:name request` — load a skill and send the request",
      "- `/init` (above) writes AGENTS.md; the shell command `alisio setup` only scaffolds `.alisio/config.json`",
      "- `/plugin.id:name args` or `/command plugin.id:name args` — run a plugin command",
      "",
      "**Keys**: Enter send · Shift+Enter / Alt+Enter / Ctrl+J newline · Tab complete · ↑↓ history · Esc interrupt · Ctrl+C clear input (twice to exit) · Ctrl+D exit on empty input · c / y copy last response (empty input) · x expand/collapse latest thought/tool batch/output (empty input) · click a collapsible header row to toggle it · PgUp/PgDn or mouse wheel scroll · Ctrl+X agent panel · Ctrl+B background running agents · Shift+Tab cycle the main agents (build, plan, your own)",
      `**Paste**: multi-line text pastes as one block automatically · Ctrl+V attach a clipboard image (PNG/JPEG/GIF/WebP, up to ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(0)} MB, up to ${MAX_ATTACHMENTS_PER_MESSAGE} per message) · Ctrl+R remove the last attached image`,
    ].join("\n");

  // `/btw` side questions: answered in the picker slot, never appended to the transcript. One
  // question is in flight at a time; Esc cancels it (independent of the run's controller, so a
  // side question also works, and is cancelled on its own, while a turn is running).
  let btwController: AbortController | undefined;
  let btwPanel: BtwPanel | undefined;
  const btwHeight = () => Math.max(4, Math.floor((process.stdout.rows ?? 30) / 2) - 6);
  const closeBtw = () => {
    btwController?.abort(new Error("Cancelled"));
    btwController = undefined;
    if (btwPanel && picker === btwPanel) closePicker();
    btwPanel = undefined;
  };
  const sideQuestion = async (question: string) => {
    const asked = session;
    const entries = app.sideQuestions.history(asked);
    if (!question) {
      const state = btwBrowser(entries);
      if (!state) return notice(`${BTW_USAGE}\n${BTW_DESCRIPTION}`);
      btwPanel = new BtwPanel(state, closeBtw, btwHeight);
      return showPicker(btwPanel);
    }
    btwController?.abort(new Error("Cancelled"));
    const controller = new AbortController();
    btwController = controller;
    const panel = new BtwPanel(btwPending(entries, question), closeBtw, btwHeight);
    btwPanel = panel;
    showPicker(panel);
    try {
      await app.sideQuestions.ask(asked, question, { signal: controller.signal });
      if (controller.signal.aborted) return;
      panel.dispatch({ type: "answered", entries: app.sideQuestions.history(asked) });
      // An approval may have taken the slot meanwhile: the answer is in the history anyway.
      if (picker !== panel) flashHint("Side answer ready: /btw to view it", 4000);
    } catch (e) {
      if (controller.signal.aborted) return;
      panel.dispatch({ type: "failed", message: e instanceof Error ? e.message : String(e) });
      if (picker !== panel) error(e);
    } finally {
      if (btwController === controller) btwController = undefined;
      tui.requestRender();
    }
  };
  let commandCatalog = new CommandCatalog(app);
  const mutating = new Set([
    "connect",
    "model",
    "plugins",
    "skills",
    "mcps",
    "settings",
    "compact",
    "clear",
    "resume",
    "reload",
  ]);
  const handleSubmit = async (raw: string) => {
    const text = raw.trim();
    if (!text) return;
    if (reloading) {
      editor.setText(raw);
      flashHint("Reloading configuration: wait a moment");
      return;
    }
    editor.addToHistory(raw);
    const parsed = parseCommand(text);
    const name = parsed ? resolveCommand(parsed.name) : undefined;
    const isTemplate = !!parsed && !name && app.prompts.templates.has(parsed.name);
    if (
      busy &&
      (!parsed || (name && mutating.has(name)) || parsed.name.startsWith("skill:") || isTemplate)
    ) {
      editor.setText(raw);
      flashHint("A turn is running: press Esc to interrupt, or wait for it to finish");
      return;
    }
    try {
      if (!parsed) return await runPrompt(raw, raw);
      if (isTemplate) {
        const expanded = app.expandPrompt(text);
        if (expanded) return await runPrompt(expanded.display, expanded.text, expanded.display);
      }
      if (parsed.name.startsWith("skill:")) {
        const skill = await app.skills.load(parsed.name.slice(6));
        return await runPrompt(text, `${skill}\n\nUser request: ${parsed.args}`);
      }
      if (parsed.name === "command") {
        const [command, ...rest] = parsed.args.split(" ");
        const handler = app.plugins.commands.get(command ?? "");
        if (!handler) return error(`Unknown plugin command: ${command ?? ""}`);
        return info(await handler(rest.join(" "), { sessionId: session }));
      }
      const agentId = agentIdFromCommand(parsed.name);
      if (agentId) {
        // `/agent:<id>`: activates a loaded agent from the next prompt (as the /agents picker).
        if (busy) {
          editor.setText(raw);
          flashHint("A turn is running: wait for it to finish before switching the active agent");
          return;
        }
        const agent = mainAgents().find((candidate) => candidate.id === agentId);
        if (!agent)
          return error(`Unknown agent ${agentId}. Open /agents to see the loaded agents.`);
        return applyActiveAgent(agent);
      }
      switch (name) {
        case "help":
          return info(helpReport());
        case "exit":
          return void (await shutdown());
        case "stats":
          return info(statsReport());
        case "tools":
        case "decisions":
        case "sessions": {
          // Text-identical core handlers (parity-tested): output comes from the CommandCatalog.
          const result = await commandCatalog.execute(name, parsed.args, { sessionId: session });
          return result.tone === "notice" ? notice(result.text ?? "") : info(result.text ?? "");
        }
        case "connect":
          return await connect();
        case "model":
          return await chooseModel();
        case "plugins":
          return managePlugins();
        case "skills":
          return manageSkills();
        case "mcps":
          return manageMcp();
        case "settings":
          return openSettings();
        case "compact":
          return await task((signal) =>
            app.runner.compact(session, { focus: parsed.args || undefined, signal }),
          );
        case "copy": {
          const last = lastAssistantText(view.items);
          if (!last) return notice("No assistant response to copy yet");
          const result = await copy(last);
          const message = copyMessage(result);
          tui.flash(message);
          return result.ok ? undefined : notice(message);
        }
        case "btw":
          return await sideQuestion(parsed.args);
        case "artifacts":
          return browseArtifacts(parsed.args);
        case "tasks":
          return showTasks();
        case "goal":
          return goalCommand(parsed.args);
        case "permission": {
          const action = parsePermissionCommand(parsed.args);
          if (action.type === "menu") return openPermissionMenu();
          if (action.type === "status") return info(permissionStatusText());
          if (action.type === "set") return setPermissionMode(action.mode);
          return notice(PERMISSION_USAGE);
        }
        case "reload":
          return await reloadAll();
        case "changelog":
          return showChangelog(parsed.args);
        case "ask": {
          if (!parsed.args) return notice("Usage: /ask <question>");
          return await runPrompt(
            `/ask ${parsed.args}`,
            `The user has a question of their own and wants help turning it into a multiple-choice ` +
              `question: "${parsed.args}"\n\nPropose 2-4 concrete, mutually distinct options that ` +
              `would resolve it. Mark at most one option "recommended" only if you have a clear, ` +
              `well-justified opinion; it is a suggestion, never forced on the user. Then ` +
              `immediately call ask_user_question with exactly one question built from this ` +
              `(reuse the user's own wording for the question text). Do not answer in plain text ` +
              `first; call the tool right away.`,
          );
        }
        case "agents":
          // TUI manager verbs (picker, new, templates, manage, edit, delete); other verbs go to the
          // subagents plugin's own `/agents` command (list/open/cancel/kill/resume/merge/discard/
          // defs/reload), still available while a turn runs.
          return await agentsCommand(parsed.args, raw);
        case "effort":
          if (busy) {
            editor.setText(raw);
            flashHint("A turn is running: wait for it to finish before changing the effort");
            return;
          }
          return await setEffort(parsed.args);
        case "clear": {
          await endSession("clear");
          session = app.store.create(app.workspace, app.provider.id, view.model).id;
          reset(initialViewState(view.model));
          notice(`New session ${session}`);
          void app.herdr.report("idle", session);
          refreshGoal();
          return refreshEstimate();
        }
        case "resume":
          if (parsed.args) return resume(parsed.args);
          return showPicker(
            new Picker(
              "Resume session",
              workspaceSessions()
                .slice(0, 50)
                .map((s) => ({
                  value: s.id,
                  label: `${shortId(s.id)}${s.id === session ? " (current)" : ""}`,
                  description: `${s.model} · ${firstPrompt(s.id) || "empty"}`,
                })),
              (item) => {
                closePicker();
                resume(item.value);
              },
              closePicker,
              true,
            ),
          );
        default:
          // Plugin commands are routed generically (built-ins unprefixed, others `id:name`).
          if (app.plugins.commands.has(parsed.name))
            return info(
              await (app.plugins.commands.get(parsed.name)?.(parsed.args, { sessionId: session }) ??
                ""),
            );
          return error(`Unknown command /${parsed.name}. Type /help.`);
      }
    } catch (e) {
      error(e);
    }
  };
  editor.onSubmit = (text) => {
    void handleSubmit(text);
  };
  /**
   * Builds the editor slash-autocomplete provider from the live config: `tui.skillSlashCommands`
   * gates the standalone `skill:<id>` entries (the `/skills` manager always keeps its argument
   * completion), so rebuilding after a settings save takes effect without a restart.
   */
  const buildSlashCompletionProvider = () => {
    const sources = [
      ...COMMANDS,
      ...[...app.prompts.templates.values()].map((t) => ({
        name: t.name,
        description: `${t.description} (template)`,
        ...(t.argumentHint ? { argumentHint: t.argumentHint } : {}),
      })),
      ...[...app.plugins.commandInfo.entries()]
        .filter(([name]) => !resolveCommand(name))
        .map(([name, c]) => ({
          name,
          description: c.description ?? `plugin ${c.plugin}`,
          ...(c.argumentHint ? { argumentHint: c.argumentHint } : {}),
        })),
      // `/agent:<id>` for every loaded agent (namespaced: never collides with other commands).
      ...agentCommandDescriptors(mainAgents()).map((d) => ({
        name: d.name,
        description: d.description,
      })),
    ];
    return new CombinedAutocompleteProvider(
      slashCompletionCommands(
        sources,
        {
          sessions: (prefix) =>
            workspaceSessions()
              .filter((s) => s.id.startsWith(prefix))
              .map((s) => ({ value: s.id, label: shortId(s.id), description: s.model })),
          skills: app
            .skillCatalog()
            .map(({ id, name, displayId, description, scope, enabled, locked, effective }) => ({
              id,
              name,
              displayId,
              description,
              scope,
              enabled,
              locked,
              effective,
            })),
        },
        { skillEntries: app.config.tui.skillSlashCommands !== false },
      ),
      app.workspace,
    );
  };
  editor.setAutocompleteProvider(buildSlashCompletionProvider());

  // Interactive services for plugins: choices (e.g. worktree isolation) and session views.
  const interactiveUI: Parameters<typeof app.plugins.setInteractiveUI>[0] = {
    // No session/label/signal on SelectRequest: queued FIFO like everything else, never withdrawn
    // early. Routed through the same queue as approve/askQuestions since plugin-subagents can call
    // `select` concurrently with an approval, which previously raced on the shared picker slot.
    select: (request) =>
      interactiveQueue.submit<string | undefined>({
        kind: "question",
        onWithdrawn: () => undefined,
        run: () =>
          new Promise<string | undefined>((resolve) => {
            showPicker(
              new Picker(
                request.title,
                request.options.map((o) => ({
                  value: o.value,
                  label: o.label,
                  ...(o.description ? { description: o.description } : {}),
                })),
                (item) => {
                  closePicker();
                  resolve(item.value);
                },
                () => {
                  closePicker();
                  resolve(undefined);
                },
              ),
            );
          }),
      }),
    askQuestions: (request) => askQuestions(request),
    open: (sessionId) => {
      const node = panelNodes().find((n) => n.sessionId === sessionId);
      panelState = {
        ...panelState,
        focus: "view",
        viewing: node?.id ?? sessionId,
        selected: node?.id ?? sessionId,
      };
      openChild(sessionId);
      return true;
    },
  };
  app.plugins.setInteractiveUI(interactiveUI);
  /** `/reload`: moves every surface binding to the new application (the old one is closed after). */
  const rebindApplication = (next: typeof app) => {
    app = next;
    commandCatalog = new CommandCatalog(app);
    activeProvider = app.providerInfo;
    modelList = undefined;
    modelCatalog = new Map();
    agentModels = undefined;
    app.plugins.onStatusChange = () => tui.requestRender();
    app.plugins.setInteractiveUI(interactiveUI);
    // A mode the user picked survives the reload; a label that only came from flags is re-derived.
    if (modePicked && permissionMode !== "custom" && permissionMode !== "locked")
      app.runner.setPolicy(PERMISSION_MODE_TABLE[permissionMode].policy);
    primeModels();
    refreshEstimate();
  };
  const panelKey = (data: string): string | undefined => {
    if (matchesKey(data, Key.up)) return "up";
    if (matchesKey(data, Key.down)) return "down";
    if (matchesKey(data, Key.left)) return "left";
    if (matchesKey(data, Key.right)) return "right";
    if (matchesKey(data, Key.enter)) return "enter";
    if (matchesKey(data, Key.escape)) return "escape";
    if (matchesKey(data, Key.tab)) return "tab";
    if (matchesKey(data, Key.ctrl("k"))) return "cancel";
    if (data === "y" || data === "Y") return "yes";
    if (data === "n" || data === "N") return "no";
    return undefined;
  };
  // Ctrl+V: attach a clipboard image (Ctrl+R removes the most recently attached one). Text
  // paste needs no wiring here: pi-tui's Editor already handles bracketed paste atomically.
  const attachmentLimits = {
    maxBytes: MAX_IMAGE_BYTES,
    maxCount: MAX_ATTACHMENTS_PER_MESSAGE,
    dimensions: getImageDimensions,
  };
  const pasteImage = async () => {
    const result = await pasteImageFromClipboard(
      getNativeClipboard(),
      pendingAttachments,
      attachmentLimits,
    );
    pendingAttachments = result.list;
    if (result.message) flashHint(result.message);
    attachmentsBar.invalidate();
    tui.requestRender();
  };
  const removeAttachment = () => {
    const { list, removed } = removeLastAttachment(pendingAttachments);
    pendingAttachments = list;
    if (removed) flashHint(`Removed attachment: ${removed.mimeType}`);
    attachmentsBar.invalidate();
    tui.requestRender();
  };
  let lastCtrlC = 0;
  tui.addInputListener((data) => {
    // Shift+Tab cycles the main agents. Input listeners run before the focused editor, so this is
    // the one place that sees the key; a picker, the autocomplete list or the agents panel keep it.
    const cycle = shiftTabDecision(data, {
      busy,
      picker: !!picker,
      autocomplete: editor.isShowingAutocomplete(),
      panelFocused: panelState.focus !== "editor",
    });
    if (cycle.type === "blocked") {
      flashHint(cycle.hint);
      return { consume: true };
    }
    if (cycle.type === "cycle") {
      void cycleAgent();
      return { consume: true };
    }
    if (!picker && panelState.focus === "editor") {
      if (matchesKey(data, Key.ctrl("v"))) {
        void pasteImage();
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("r")) && pendingAttachments.length) {
        removeAttachment();
        return { consume: true };
      }
      // `x` on an EMPTY editor line toggles the nearest collapsible transcript row — a finished
      // `Thought` section, a grouped batch of tool calls, or a long command output. Same
      // empty-input convention as Enter, Ctrl+D and `c`/`y`; typing `x` mid-message is never
      // intercepted, and with nothing collapsible it types normally.
      if (
        foldToggleKey(data, {
          text: editor.getText(),
          autocomplete: editor.isShowingAutocomplete(),
        })
      ) {
        const target = foldCandidates(visibleTranscript().items).at(-1);
        if (target) {
          toggleFold(target);
          return { consume: true };
        }
      }
    }
    if (!picker) {
      if (matchesKey(data, Key.ctrl("x"))) {
        const r = reducePanel(panelState, { type: "ctrlX", now: Date.now() }, panelNodes());
        if (!r.handled) flashHint("No agents to navigate yet");
        else applyPanel(r);
        return { consume: true };
      }
      if (matchesKey(data, Key.ctrl("b")) && busy) {
        void panelEntry()?.provider.action?.("background", undefined, { sessionId: session });
        flashHint("Moved running foreground agents to the background");
        return { consume: true };
      }
      if (panelState.focus !== "editor" || panelState.confirm) {
        const key = panelKey(data);
        if (key || panelState.focus === "view") {
          const r = reducePanel(
            panelState,
            { type: "key", key: key ?? "other", now: Date.now() },
            panelNodes(),
          );
          applyPanel(r);
          if (r.handled || panelState.focus === "view") return { consume: true };
          return undefined;
        }
        // Typing returns focus to the editor.
        panelState = { ...panelState, focus: "editor" };
        tui.requestRender();
        return undefined;
      }
      if (matchesKey(data, Key.down) && !editor.getText() && !editor.isShowingAutocomplete()) {
        const r = reducePanel(
          panelState,
          { type: "key", key: "down", now: Date.now(), editorEmpty: true },
          panelNodes(),
        );
        if (r.handled) {
          applyPanel(r);
          return { consume: true };
        }
      }
      // `c`/`y` on an EMPTY editor line copies the last assistant response as raw text, the same
      // as /copy; typing `c` or `y` mid-message is never intercepted.
      if (
        editorCopyKey(data, {
          text: editor.getText(),
          autocomplete: editor.isShowingAutocomplete(),
          busy,
        })
      ) {
        const last = lastAssistantText(view.items);
        if (last) {
          void copy(last).then((result) => {
            const message = copyMessage(result);
            tui.flash(message);
            if (!result.ok) notice(message);
          });
        }
        return { consume: true };
      }
    }
    if (matchesKey(data, Key.escape)) {
      if (busy && !picker && !editor.isShowingAutocomplete()) {
        controller?.abort(new Error("Interrupted by user"));
        flashHint("Interrupting…");
        return { consume: true };
      }
      return undefined;
    }
    if (matchesKey(data, Key.ctrl("c"))) {
      if (tui.hasActiveSelection()) return undefined;
      if (picker) {
        picker.handleInput?.("\x1b");
        return { consume: true };
      }
      if (editor.getText()) {
        editor.setText("");
        tui.requestRender();
        return { consume: true };
      }
      if (busy) {
        controller?.abort(new Error("Interrupted by user"));
        return { consume: true };
      }
      const now = Date.now();
      if (now - lastCtrlC < 1500) void shutdown();
      else {
        lastCtrlC = now;
        flashHint("Press Ctrl+C again to exit", 1500);
      }
      return { consume: true };
    }
    if (matchesKey(data, Key.ctrl("d")) && !editor.getText() && !picker) {
      void shutdown();
      return { consume: true };
    }
    return undefined;
  });

  const ticker = setInterval(() => {
    clock.now = Date.now();
    if (
      busy ||
      btwPanel?.pending ||
      view.items.some((i) => i.kind === "tool" && i.status === "running") ||
      panelNodes().some((n) => n.status === "running")
    ) {
      clock.frame++;
      tui.requestRender();
    }
  }, 100);
  const onSignal = () => void shutdown();
  process.on("SIGTERM", onSignal);
  process.on("SIGHUP", onSignal);

  try {
    await app.herdr.report("idle", session);
    tui.setFocus(editor);
    const { bannerPolicy, startupInput, terminalCapabilities } = await import("../banner.ts");
    if (
      bannerPolicy({
        mode: "tui",
        ...options,
        stdoutTTY: !!process.stdout.isTTY,
        stderrTTY: !!process.stderr.isTTY,
        env: process.env,
      })
    ) {
      const { renderStartup } = await import("@alisio/core");
      const banner = new BannerBlock((width) => {
        const result = renderStartup(
          app.plugins,
          startupInput(app, {
            version: VERSION,
            model: view.model,
            readOnly: !!options.readOnly,
            terminal: terminalCapabilities({ env: process.env, columns: width, tty: true }),
          }),
        );
        // Report provider problems once; later renders (resize) reuse the same resolution.
        if (!startupDiagnostics.length && result.diagnostics.length) {
          startupDiagnostics.push(...result.diagnostics);
          queueMicrotask(() => {
            for (const d of result.diagnostics)
              notice(
                d.type === "extension_conflict"
                  ? `Extension conflict on ${d.point}: ${d.winner} chosen over ${d.losers.join(", ")}`
                  : `Plugin ${d.source} ${d.hook} failed: ${d.error} (default used)`,
              );
          });
        }
        return result.lines;
      });
      // First block of the conversation; it scrolls away naturally.
      transcript.addChild(banner);
    }
    tui.start();
    for (const failure of app.mcpStartupFailures()) notice(failure);
    void announceNews().catch(() => {});
    sync();
    refreshEstimate();
    // Discover context windows in the background; failures only mean "unknown".
    models()
      .then(() => tui.requestRender())
      .catch(() => {});
    await exited;
  } finally {
    clearInterval(ticker);
    clearInterval(branchTimer);
    clearTimeout(hintTimer);
    process.off("SIGTERM", onSignal);
    process.off("SIGHUP", onSignal);
    tui.stop();
    await app.close();
    process.stdout.write(`\nSession: ${session}\n`);
  }
}
