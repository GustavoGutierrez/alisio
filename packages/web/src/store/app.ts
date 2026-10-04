/**
 * The app controller: signals over the pure reducers plus the actions components call. One
 * `EventStream` watches the open session (every stream also receives `session_status` for the
 * sidebar); frames arrive batched per animation frame and are applied in one signal update.
 */

import type {
  AgentInfo,
  BlobRef,
  ChangelogView,
  CommandDescriptor,
  DatasetRef,
  GoalInfo,
  HealthInfo,
  PermissionPresetId,
  PluginInfo,
  ServerFrame,
  SessionContextUsage,
  SessionDetail,
  SessionModels,
} from "@alisio/sdk";
import { batch, computed, signal } from "@preact/signals";
import { t } from "../i18n/index.ts";
import { ApiClient, ApiRequestError, newId } from "../net/api.ts";
import { type EventSourceLike, EventStream, type StreamStatus } from "../net/events.ts";
import { normalizeVersion } from "../util/version.ts";
import {
  answeredSideQuestion,
  type BtwState,
  browseSideQuestions,
  failedSideQuestion,
  pendingSideQuestion,
  sideQuestionOf,
} from "./btw.ts";
import { LAST_SEEN_KEY, newsAction } from "./changelog.ts";
import { parseSlash, pushHistory } from "./composer.ts";
import { pushDatasetNotice } from "./datasets.ts";
import { liveTasks, openTasks } from "./dock.ts";
import { errorText } from "./errors.ts";
import { goalFromFrame } from "./goal-frame.ts";
import { nextAgentId } from "./modes.ts";
import { applyPending, emptyPending, resolveLocal, visiblePending } from "./pending.ts";
import {
  effectiveTab,
  emptyPlugins,
  MEMORY_PLUGIN,
  type PluginsState,
  pluginAvailability,
  pluginsFailed,
  type SessionTab,
} from "./plugins.ts";
import { applyCompacting, applyProgress, type RunProgress } from "./progress.ts";
import {
  applySessionStatus,
  emptySidebar,
  loadSidebar,
  newSessionTarget,
  upsertSession,
  upsertWorkspace,
  workspaceOpenMode,
} from "./sessions.ts";
import { readJson, readPref, writePref } from "./storage.ts";
import {
  addLocalNote,
  applyFrames,
  dropEcho,
  emptyTranscript,
  failEcho,
  localEcho,
  prependOlder,
} from "./transcript.ts";

export const auth = signal<"ok" | "unauthorized">("ok");
export const reloadRequired = signal(false);
export const streamStatus = signal<StreamStatus>("connecting");
export const sidebar = signal(emptySidebar());
export const currentId = signal<string | undefined>(undefined);
export const detail = signal<SessionDetail | undefined>(undefined);
export const transcript = signal(emptyTranscript(""));
/**
 * What the live run of the open session is doing (phase, elapsed, last activity), derived from
 * the frames received. Undefined when no run is live.
 */
export const runProgress = signal<RunProgress | undefined>(undefined);
/** The open session is compacting its context (with or without a run). */
export const compacting = signal(false);
export const pending = signal(emptyPending());
export const commands = signal<CommandDescriptor[]>([]);
export const models = signal<SessionModels | undefined>(undefined);
export const context = signal<SessionContextUsage | undefined>(undefined);
export const history = signal<string[]>(readJson<string[]>("alisio.history", []));
/** Polite screen-reader announcement (turn completed), assertive for approvals. */
export const announcePolite = signal("");
export const announceAssertive = signal("");
/** Ticks every 30 s so relative times refresh. */
export const now = signal(Date.now());
export const settingsOpen = signal(false);
/** The Agents window (list/editor), opened from the sidebar above Settings. */
export const agentsOpen = signal(false);
/** The `/agents` quick picker of the open chat. */
export const agentPickerOpen = signal(false);
/** The main agents of the open chat's workspace, in the server's stable cycle order. */
export const agentList = signal<AgentInfo[]>([]);
/** Polite screen-reader announcement of the agent a Shift+Tab or selector switch activated. */
export const announceAgent = signal("");
/** The `/changelog` dialog: the version asked for (empty: the latest entries). */
export const changelogRequest = signal<{ version: string; at: number } | undefined>(undefined);
export const mobileSidebar = signal(false);
/** Asks the composer to take focus (e.g. after an approval is answered). */
export const focusComposer = signal(0);
export const toast = signal<string | undefined>(undefined);
/** Text the composer should insert at its cursor (e.g. an `@path` mention from the dock). */
export const composerInsert = signal<{ text: string; n: number } | undefined>(undefined);
/** Bumped when a run of the open session ends (the dock refreshes its tree and changes). */
export const runEnded = signal(0);
/** Bumped when durable events of the open session arrive (stats and trajectory catch up). */
export const eventsTick = signal(0);
/** Bumped per `catalog_changed` scope (settings pages reload what changed). */
export const catalogTick = signal<Record<string, number>>({});
/** The `/btw` side panel (not part of the transcript); undefined when closed. */
export const btw = signal<BtwState | undefined>(undefined);
/** The session view tab (RF-10). */
export const sessionTab = signal<SessionTab>("conversation");
/** Plugins of the open session's workspace (feeds "is plugin X enabled" and the tabs). */
export const pluginsState = signal<PluginsState>(emptyPlugins);
/** Plugin display names by their tool prefix (`p_<hash>`), to label plugin tool calls. */
export const pluginNames = computed(() =>
  Object.fromEntries((pluginsState.value.list ?? []).map((p) => [p.toolPrefix, p.name])),
);
/** Whether plugin `id` is enabled and running in the open workspace (reading it subscribes). */
export const isPluginEnabled = (id: string): boolean =>
  pluginAvailability(pluginsState.value, detail.value?.workspaceId, id) === "enabled";
/** Availability of the memory plugin (decides whether the Memory tab exists). */
export const memoryAvailability = () =>
  pluginAvailability(pluginsState.value, detail.value?.workspaceId, MEMORY_PLUGIN);
/** The tab to render and highlight: Memory only while its plugin is available. */
export const activeTab = () => effectiveTab(sessionTab.value, memoryAvailability());
/** Stores a workspace's plugin list; a tab whose plugin is now disabled falls back to Conversation. */
export function receivePlugins(workspace: string, list: PluginInfo[]): void {
  pluginsState.value = { workspace, list };
  // Only a definitely disabled plugin removes its tab (a slow or failed load never bounces the user).
  if (memoryAvailability() === "disabled")
    sessionTab.value = effectiveTab(sessionTab.value, "disabled");
}
export function failPlugins(workspace: string): void {
  pluginsState.value = pluginsFailed(pluginsState.value, workspace);
}
/** The header's permissions popover: modes, status and saved permissions (`/permission`). */
export const permissionsOpen = signal(false);
/**
 * The goal of the open session (`/goal`): kept by the stream (the snapshot after a reload, then
 * `goal_changed` frames). Everything that shows or edits it is its own chunk (`store/goal.ts`).
 */
export const goalInfo = signal<GoalInfo | null>(null);
/** Bumped by `capabilities_changed` for the open session (permissions are refetched). */
export const capabilitiesTick = signal(0);
/** `/artifacts [filter]` from the composer: the panel opens with its switcher. */
export const artifactsRequest = signal<{ filter: string; at: number } | undefined>(undefined);
/** The last batch of artifacts announced live (`artifact_published`) for the open session. */
export const publishedArtifacts = signal<
  { sessionId: string; artifacts: import("@alisio/sdk").ArtifactRef[] } | undefined
>(undefined);

export const visible = computed(() => visiblePending(pending.value, transcript.value.session));
export const sessionStatus = computed(
  () => transcript.value.session?.status ?? detail.value?.status ?? "idle",
);
export const busy = computed(() => {
  const status = sessionStatus.value;
  return (
    !!transcript.value.live ||
    status === "running" ||
    status === "queued" ||
    status === "awaiting_input"
  );
});

export const api = new ApiClient({
  onUnauthorized: () => {
    auth.value = "unauthorized";
  },
});

let stream: EventStream | undefined;
let reloadingSidebar: Promise<void> | undefined;

/** Asks the sidebar to show its "open a workspace" form (no existing workspace to use). */
export const openWorkspaceRequest = signal(0);
/** Server capabilities from `/api/health` (native folder dialog, folder browser). */
export const health = signal<HealthInfo | undefined>(undefined);
/** How "Open a workspace" asks for a folder on this server. */
/** The server's Alisio version (undefined until `/api/health` answers or when it omits it). */
export const appVersion = computed(() => normalizeVersion(health.value?.version));
export const openMode = computed(() => workspaceOpenMode(health.value?.capabilities));
/** The native folder dialog is open on the server's desktop. */
export const picking = signal(false);

export function insertIntoComposer(text: string): void {
  composerInsert.value = { text, n: (composerInsert.value?.n ?? 0) + 1 };
  focusComposer.value++;
}

export function showToast(message: string): void {
  toast.value = message;
  setTimeout(() => {
    if (toast.value === message) toast.value = undefined;
  }, 5000);
}

export async function reloadSidebar(): Promise<void> {
  reloadingSidebar ??= (async () => {
    try {
      const [workspaces, sessions] = await Promise.all([
        // Archived workspaces too: the sidebar hides them (and their sessions) unless asked.
        api.workspaces("all"),
        api.sessions({ archived: "all" }),
      ]);
      sidebar.value = loadSidebar(sidebar.value, workspaces, sessions.items);
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 401)) showToast(errorText(error));
    } finally {
      reloadingSidebar = undefined;
    }
  })();
  return reloadingSidebar;
}

async function refreshContext(): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  try {
    const usage = await api.context(id);
    if (currentId.value === id) context.value = usage;
  } catch {
    /* the ring just stays as it was */
  }
}

async function refreshModels(): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  try {
    const list = await api.models(id);
    if (currentId.value === id) models.value = list;
  } catch {
    models.value = undefined;
  }
}

async function refreshCommands(): Promise<void> {
  const id = currentId.value;
  try {
    const list = await api.commands(id);
    if (currentId.value === id) commands.value = list;
  } catch {
    /* the palette keeps the previous catalog */
  }
}

/** Loads the workspace's main agents (stable cycle order) for the selector and Shift+Tab. */
async function refreshAgents(): Promise<void> {
  const wid = detail.value?.workspaceId;
  if (!wid) {
    agentList.value = [];
    return;
  }
  try {
    const list = await api.agents(wid);
    if (detail.value?.workspaceId === wid) agentList.value = list;
  } catch {
    /* the selector keeps the previous list */
  }
}

/** Loads plugin names for the open session's workspace (labels of plugin tool calls). */
async function refreshPluginNames(): Promise<void> {
  const wid = detail.value?.workspaceId;
  if (!wid) return;
  try {
    const list = await api.plugins(wid);
    if (detail.value?.workspaceId !== wid) return;
    receivePlugins(wid, list);
  } catch {
    /* labels fall back to "plugin"; the plugin list keeps its last known state */
    failPlugins(wid);
  }
}

async function refreshDetail(): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  try {
    const next = await api.session(id);
    if (currentId.value === id) {
      detail.value = next;
      sidebar.value = upsertSession(sidebar.value, next);
    }
  } catch {
    /* keep the last detail */
  }
}

/** An approved plan switches the session to build when its next run starts: refresh the badge. */
let planApproved = false;

function onFrames(frames: ServerFrame[]): void {
  let ended = false;
  let agentChanged = false;
  let rewritten = false;
  let catalog = false;
  let durable = false;
  const published: import("@alisio/sdk").ArtifactRef[] = [];
  const scopes = new Set<string>();
  batch(() => {
    transcript.value = applyFrames(transcript.value, frames);
    const at = Date.now();
    let progress = runProgress.value;
    for (const frame of frames)
      if (!("sessionId" in frame) || frame.sessionId === transcript.value.sessionId)
        progress = applyProgress(progress, frame, at);
    runProgress.value = progress;
    let isCompacting = compacting.value;
    for (const frame of frames)
      if (!("sessionId" in frame) || frame.sessionId === transcript.value.sessionId)
        isCompacting = applyCompacting(isCompacting, frame);
    if (isCompacting !== compacting.value) compacting.value = isCompacting;
    let nextPending = pending.value;
    let nextSidebar = sidebar.value;
    for (const frame of frames) {
      nextPending = applyPending(nextPending, frame);
      if (frame.t === "session_status") nextSidebar = applySessionStatus(nextSidebar, frame);
      if (frame.t === "approval" && frame.approval.rootSessionId === currentId.value)
        announceAssertive.value = frame.approval.name ?? frame.approval.approvalId;
      if (frame.t === "capabilities_changed" && frame.sessionId === currentId.value)
        capabilitiesTick.value++;
      if (frame.t === "dataset_ready" || frame.t === "dataset_failed") pushDatasetNotice(frame);
      // The tasks store is its own chunk: it loads when the first task frame arrives.
      if (frame.t === "tasks_changed")
        void import("./tasks.ts").then((m) => m.receiveTask(frame.sessionId, frame.task));
      // The goal of the open session: the snapshot after a (re)connect, then every change.
      const goal = goalFromFrame(frame, currentId.value);
      if (goal !== undefined) goalInfo.value = goal;
      if (frame.t === "catalog_changed") {
        scopes.add(frame.scope);
        if (frame.scope === "commands") catalog = true;
      }
      if (frame.t === "event" && frame.sessionId === currentId.value) {
        durable = true;
        const type = frame.event.type;
        if (type === "run_completed") announcePolite.value = `${Date.now()}`;
        if (type === "run_completed" || type === "run_failed" || type === "run_cancelled")
          ended = true;
        if (type === "compaction_completed") rewritten = true;
        if (type === "artifact_published") {
          const data = frame.event.data as { artifact?: import("@alisio/sdk").ArtifactRef };
          if (data.artifact) published.push(data.artifact);
        }
        if (type === "model_changed") ended = true;
        if (type === "plan_decided")
          planApproved = (frame.event.data as { decision?: string }).decision === "approve";
        if (type === "run_started" && planApproved) {
          planApproved = false;
          agentChanged = true;
        }
      }
    }
    pending.value = nextPending;
    sidebar.value = nextSidebar;
  });
  if (durable) eventsTick.value++;
  if (agentChanged) void refreshDetail();
  const session = currentId.value;
  if (published.length && session)
    publishedArtifacts.value = { sessionId: session, artifacts: published };
  if (sidebar.value.stale) void reloadSidebar();
  if (ended) {
    runEnded.value++;
    void refreshContext();
  }
  if (catalog) void refreshCommands();
  if (scopes.size) {
    const next = { ...catalogTick.value };
    for (const scope of scopes) next[scope] = (next[scope] ?? 0) + 1;
    catalogTick.value = next;
    if (scopes.has("models")) void refreshModels();
    if (scopes.has("plugins")) void refreshPluginNames();
    if (scopes.has("agents")) void refreshAgents();
  }
  // A compaction replaced older messages: take a fresh snapshot of the history.
  if (rewritten) {
    stream?.refresh();
    void refreshContext();
  }
}

/** Opens a session: resets its transcript, subscribes the stream and loads its side data. */
export async function openSession(id: string | undefined): Promise<void> {
  if (id === currentId.value && id) return;
  batch(() => {
    currentId.value = id;
    detail.value = undefined;
    transcript.value = emptyTranscript(id ?? "");
    runProgress.value = undefined;
    compacting.value = false;
    models.value = undefined;
    context.value = undefined;
    mobileSidebar.value = false;
    btw.value = undefined;
    goalInfo.value = null;
  });
  const hash = id ? `#/s/${encodeURIComponent(id)}` : "#/";
  if (location.hash !== hash) history_replace(hash);
  stream?.subscribe(id ? [id] : []);
  if (id) writePref("alisio.lastSession", id);
  void refreshCommands();
  liveTasks.value = 0;
  if (!id) return;
  void import("./tasks.ts").then((m) => m.loadTasks(id));
  try {
    const next = await api.session(id);
    if (currentId.value === id) detail.value = next;
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "not_found") {
      showToast(errorText(error));
      void openSession(undefined);
      return;
    }
  }
  void refreshModels();
  void refreshContext();
  void refreshPluginNames();
  void refreshAgents();
}

function history_replace(hash: string): void {
  try {
    window.history.replaceState(null, "", hash);
  } catch {
    location.hash = hash;
  }
}

const sessionFromHash = (): string | undefined => {
  const match = /^#\/s\/(.+)$/.exec(location.hash);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
};

/**
 * After an upgrade: ONE discreet toast, then remember the version. A first visit is silent. The
 * viewer state lives in localStorage and every access is guarded (private windows, blocked data).
 */
export async function checkChangelogNews(): Promise<ChangelogView | undefined> {
  const lastSeen = readPref(LAST_SEEN_KEY);
  try {
    const view = await api.changelog(lastSeen ? { lastSeen } : {});
    const action = newsAction(lastSeen, view);
    if (action.toast) showToast(t("changelog.news", { version: action.toast }));
    if (action.record) writePref(LAST_SEEN_KEY, action.record);
    return view;
  } catch {
    return undefined;
  }
}

export async function init(): Promise<void> {
  stream = new EventStream({
    // Same origin: the session cookie rides along. The DOM handler types are wider than ours.
    create: (url) => new EventSource(url) as unknown as EventSourceLike,
    onFrames,
    onStatus: (status) => {
      streamStatus.value = status;
    },
    onProtocolMismatch: () => {
      reloadRequired.value = true;
    },
    onClosed: () => {
      // The browser gave up: an expired cookie shows as a closed stream, so check.
      void api.workspaces().catch(() => {});
    },
  });
  window.addEventListener("online", () => stream?.nudge());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") stream?.nudge();
  });
  window.addEventListener("hashchange", () => {
    const id = sessionFromHash();
    if (id !== currentId.value) void openSession(id);
  });
  setInterval(() => {
    now.value = Date.now();
  }, 30_000);
  void api
    .health()
    .then((info) => {
      health.value = info;
    })
    .catch(() => {});
  await reloadSidebar();
  if (auth.value !== "ok") return;
  void checkChangelogNews();
  const fromHash = sessionFromHash();
  const last = readPref("alisio.lastSession");
  const sessions = sidebar.value.sessions;
  const initial =
    fromHash ??
    (last && sessions[last] && !sessions[last]?.archived
      ? last
      : Object.values(sessions)
          .filter((s) => !s.archived)
          .sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1))[0]?.id);
  if (initial) await openSession(initial);
  else {
    stream.subscribe([]);
    void refreshCommands();
  }
}

/**
 * Creates a session in a workspace: the given one, else the open session's if its folder exists,
 * else the most recently used existing one; with none, asks the user to open a workspace.
 */
export async function newSession(workspaceId?: string): Promise<void> {
  const workspace = workspaceId ?? newSessionTarget(sidebar.value, detail.value?.workspaceId);
  if (!workspace) {
    showToast(t("sidebar.openWorkspaceFirst"));
    openWorkspaceRequest.value++;
    return;
  }
  try {
    const created = await api.createSession({ workspace });
    sidebar.value = upsertSession(sidebar.value, created);
    await openSession(created.id);
    focusComposer.value++;
  } catch (error) {
    showToast(errorText(error));
    // The folder was deleted since the list loaded: refresh so the sidebar marks it missing.
    if (error instanceof ApiRequestError && error.code === "workspace_missing")
      void reloadSidebar();
  }
}

export async function addWorkspace(path: string): Promise<boolean> {
  try {
    const info = await api.addWorkspace(path.trim());
    sidebar.value = upsertWorkspace(sidebar.value, info);
    // The web never grants trust: say why project resources are off (the badge stays too).
    if (info.untrustedResources) showToast(t("sidebar.untrustedHint"));
    return true;
  } catch (error) {
    showToast(errorText(error));
    return false;
  }
}

/**
 * Asks the server to open its native folder dialog and adds the chosen folder. Resolves to
 * `"added"`, `"cancelled"` or `"unavailable"` (the caller falls back to the in-app browser).
 */
export async function pickWorkspace(): Promise<"added" | "cancelled" | "unavailable"> {
  if (picking.value) return "cancelled";
  picking.value = true;
  try {
    const outcome = await api.pickFolder();
    if ("cancelled" in outcome) return "cancelled";
    return (await addWorkspace(outcome.path)) ? "added" : "cancelled";
  } catch (error) {
    if (error instanceof ApiRequestError && error.code === "picker_unavailable") {
      if (health.value)
        health.value = {
          ...health.value,
          capabilities: { ...health.value.capabilities, nativePicker: false },
        };
      return "unavailable";
    }
    showToast(errorText(error));
    return "cancelled";
  } finally {
    picking.value = false;
  }
}

/** Pins, renames, archives or unarchives a workspace (sessions are never touched). */
export async function patchWorkspace(
  id: string,
  patch: Parameters<ApiClient["patchWorkspace"]>[1],
): Promise<void> {
  try {
    const info = await api.patchWorkspace(id, patch);
    sidebar.value = upsertWorkspace(sidebar.value, info);
  } catch (error) {
    showToast(errorText(error));
  }
}

export async function patchCurrent(
  patch: Parameters<ApiClient["patchSession"]>[1],
  id = currentId.value,
): Promise<void> {
  if (!id) return;
  try {
    const next = await api.patchSession(id, patch);
    sidebar.value = upsertSession(sidebar.value, next);
    if (id === currentId.value) {
      detail.value = next;
      if (patch.model !== undefined || patch.effort !== undefined) {
        void refreshModels();
        void refreshContext();
      }
    }
  } catch (error) {
    showToast(errorText(error));
  }
}

/**
 * Activates `agentId` in the open chat through `/agent:<id>` (stored on the session, applied from
 * its next prompt; the agent's model only when it belongs to the session's provider).
 */
export async function activateAgent(agentId: string): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  try {
    const outcome = await api.command(id, { requestId: newId(), name: `agent:${agentId}` });
    if (outcome.output) transcript.value = addLocalNote(transcript.value, outcome.output);
    void refreshDetail();
    if (outcome.effects?.includes("model")) {
      void refreshModels();
      void refreshContext();
    }
  } catch (error) {
    showToast(errorText(error));
  }
}

/**
 * Shift+Tab and the selector: activates the next main agent of the open chat (build, plan, then
 * custom ones, wrapping around). It applies from the next prompt, so it is allowed mid-turn.
 */
export async function cycleAgent(step: 1 | -1 = 1): Promise<void> {
  const session = detail.value;
  if (!session) return;
  // A pending question or plan review owns the session: the agent does not change under it.
  if (visiblePending(pending.value, session).interactions.length) return;
  const agents = agentList.value;
  const current = session.agent ?? agents.find((agent) => agent.default)?.id;
  const next = nextAgentId(agents, current, step);
  if (!next || next === current) return;
  await activateAgent(next);
  const name = agents.find((agent) => agent.id === next)?.name ?? next;
  announceAgent.value = t("composer.agentApplied", { agent: name });
}

/**
 * Starts a NEW chat in `workspace` with `agentId` active ("Try it"). The agent's model is used
 * when the configured profiles can resolve it; otherwise the chat starts on the current model.
 */
export async function startSessionWithAgent(
  workspace: string,
  agentId: string,
  model?: string,
): Promise<boolean> {
  try {
    let created: SessionDetail;
    try {
      created = await api.createSession({ workspace, agent: agentId, ...(model ? { model } : {}) });
    } catch (error) {
      if (!model || !(error instanceof ApiRequestError) || error.code !== "validation_failed")
        throw error;
      created = await api.createSession({ workspace, agent: agentId });
      showToast(t("agentsWin.modelFallback", { model }));
    }
    sidebar.value = upsertSession(sidebar.value, created);
    await openSession(created.id);
    focusComposer.value++;
    return true;
  } catch (error) {
    showToast(errorText(error));
    return false;
  }
}

/**
 * Trusts (or stops trusting) a workspace after an explicit confirmation that says what trust
 * unlocks. The server persists the same decision as the terminal prompt and reopens the
 * workspace so its project config, plugins, agents, skills and prompts load (or unload).
 */
export async function setWorkspaceTrust(
  workspace: { id: string; path: string },
  trusted: boolean,
): Promise<boolean> {
  const question = trusted
    ? t("trust.confirm", { path: workspace.path })
    : t("trust.confirmRevoke", { path: workspace.path });
  if (!window.confirm(question)) return false;
  try {
    const info = await api.trustWorkspace(workspace.id, trusted);
    sidebar.value = upsertWorkspace(sidebar.value, info);
    showToast(t(info.trusted ? "trust.granted" : "trust.revoked"));
    if (detail.value?.workspaceId === workspace.id) void refreshCommands();
    return true;
  } catch (error) {
    showToast(errorText(error));
    return false;
  }
}

export const setPreset = (preset: PermissionPresetId) => patchCurrent({ preset });
export const setModel = (model: string) => patchCurrent({ model });
export const setEffort = (effort: string | null) => patchCurrent({ effort });

function remember(text: string): void {
  history.value = pushHistory(history.value, text);
  writePref("alisio.history", JSON.stringify(history.value));
}

/** Sends a prompt with an instant local echo; failures stay visible with a retry. */
async function sendPrompt(
  text: string,
  display?: string,
  requestId = newId(),
  images?: { refs: BlobRef[]; thumbs: string[] },
  datasets?: DatasetRef[],
): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  const localId = newId();
  const attachments = images?.refs.length ? images.refs : undefined;
  transcript.value = localEcho(transcript.value, {
    localId,
    requestId,
    text,
    ...(display ? { display } : {}),
    ...(attachments ? { attachments, thumbs: images?.thumbs ?? [] } : {}),
    ...(datasets?.length ? { datasets } : {}),
  });
  try {
    await api.prompt(id, {
      requestId,
      text,
      ...(display ? { display } : {}),
      ...(attachments ? { attachments } : {}),
      ...(datasets?.length ? { datasets: datasets.map((d) => d.id) } : {}),
    });
  } catch (error) {
    if (currentId.value === id)
      transcript.value = failEcho(transcript.value, localId, errorText(error));
  }
}

/** Resends a failed prompt with its original request id (idempotent on the server). */
export function retryEcho(localId: string): void {
  const echo = transcript.value.echoes.find((e) => e.localId === localId);
  if (!echo) return;
  transcript.value = dropEcho(transcript.value, localId);
  void sendPrompt(
    echo.text,
    echo.display,
    echo.requestId,
    echo.attachments ? { refs: echo.attachments, thumbs: echo.thumbs ?? [] } : undefined,
    echo.datasets,
  );
}

/**
 * Composer submit: a known slash command runs through the catalog, anything else is a prompt.
 * Prompts with images always go to the model (commands take no attachments).
 */
export async function submit(
  text: string,
  images?: { refs: BlobRef[]; thumbs: string[] },
  datasets?: DatasetRef[],
): Promise<void> {
  const id = currentId.value;
  if (!id || (!text.trim() && !images?.refs.length && !datasets?.length)) return;
  if (text.trim()) remember(text);
  if (images?.refs.length || datasets?.length)
    // Data alone is a request: ask the model to look at it.
    return sendPrompt(
      text.trim() || !datasets?.length ? text : t("dataset.defaultPrompt"),
      undefined,
      newId(),
      images,
      datasets,
    );
  const slash = parseSlash(text);
  // `/permission` (alias `/permissions`) alone opens the popover; with arguments it is a command.
  if ((slash?.name === "permission" || slash?.name === "permissions") && !slash.args) {
    permissionsOpen.value = true;
    return;
  }
  if (slash?.name === "changelog") {
    changelogRequest.value = { version: slash.args ?? "", at: Date.now() };
    return;
  }
  if (slash?.name === "tasks") {
    openTasks();
    return;
  }
  if (slash?.name === "goal" && commands.value.some((c) => c.name === "goal")) {
    // Its own chunk: asks before replacing a goal and opens the edit field.
    void import("./goal.ts").then((m) => m.runGoalCommand(id, slash.args ?? ""));
    return;
  }
  if (slash?.name === "artifacts") {
    artifactsRequest.value = { filter: slash.args ?? "", at: Date.now() };
    return;
  }
  if (slash?.name === "agents" && !slash.args) {
    // `/agents` alone opens the agent picker; `/agents <verb>` still runs the command.
    agentPickerOpen.value = true;
    return;
  }
  const known = slash
    ? commands.value.find(
        (c) => c.name === slash.name || c.aliases?.includes(slash.name.toLowerCase()),
      )
    : undefined;
  if (!slash || !known) return sendPrompt(text);
  const side = sideQuestionOf(text, commands.value);
  if (side) return openSideQuestion(id, side.question);
  try {
    const outcome = await api.command(id, {
      requestId: newId(),
      name: known.name,
      ...(slash.args ? { args: slash.args } : {}),
    });
    if (outcome.output) transcript.value = addLocalNote(transcript.value, outcome.output);
    if (known.name === "reload") showToast(t("reloadCmd.done"));
    if (outcome.prompt) await sendPrompt(outcome.prompt.text, outcome.prompt.display);
    if (outcome.effects?.length) {
      void refreshDetail();
      void refreshModels();
      void refreshContext();
    }
    if (outcome.sessionId) {
      await reloadSidebar();
      await openSession(outcome.sessionId);
    }
  } catch (error) {
    transcript.value = addLocalNote(transcript.value, `**/${known.name}**: ${errorText(error)}`);
  }
}

let sideController: AbortController | undefined;

/**
 * `/btw [question]`: opens the side panel. With a question it asks it (one at a time; the
 * conversation is untouched), without one it shows the newest earlier answer or the usage line.
 */
export async function openSideQuestion(sessionId: string, question: string): Promise<void> {
  let entries = btw.value?.sessionId === sessionId ? btw.value.entries : [];
  if (!question) {
    btw.value = browseSideQuestions(sessionId, entries);
    try {
      entries = await api.sideQuestions(sessionId);
    } catch (error) {
      showToast(errorText(error));
      return;
    }
    if (btw.value?.sessionId === sessionId && !btw.value.pending)
      btw.value = browseSideQuestions(sessionId, entries);
    return;
  }
  sideController?.abort();
  const controller = new AbortController();
  sideController = controller;
  btw.value = pendingSideQuestion(sessionId, entries, question);
  try {
    await api.askSideQuestion(sessionId, question, controller.signal);
    const updated = await api.sideQuestions(sessionId);
    if (btw.value?.sessionId === sessionId && btw.value.pending?.question === question)
      btw.value = answeredSideQuestion(btw.value, updated);
  } catch (error) {
    if (controller.signal.aborted) return;
    if (btw.value?.sessionId === sessionId && btw.value.pending)
      btw.value = failedSideQuestion(btw.value, errorText(error));
  } finally {
    if (sideController === controller) sideController = undefined;
  }
}

/** Closes the side panel; a pending side question is cancelled on the server too. */
export function closeSideQuestion(): void {
  const state = btw.value;
  if (state?.pending) {
    sideController?.abort();
    sideController = undefined;
    void api.cancelSideQuestions(state.sessionId).catch(() => {});
  }
  btw.value = undefined;
  focusComposer.value++;
}

export async function cancelRun(): Promise<void> {
  const id = currentId.value;
  if (!id) return;
  try {
    await api.cancel(id);
  } catch (error) {
    showToast(errorText(error));
  }
}

export async function loadOlder(): Promise<void> {
  const state = transcript.value;
  if (!state.hasMore || state.oldestSeq === undefined) return;
  try {
    const page = await api.messages(state.sessionId, state.oldestSeq);
    if (transcript.value.sessionId === state.sessionId)
      transcript.value = prependOlder(transcript.value, page);
  } catch (error) {
    showToast(errorText(error));
  }
}

export async function decide(approvalId: string, decision: "once" | "session" | "deny") {
  try {
    await api.decide(approvalId, decision);
  } catch (error) {
    // 409: another tab answered first; 404: withdrawn. Either way it is no longer ours.
    if (!(error instanceof ApiRequestError && (error.status === 409 || error.status === 404)))
      showToast(errorText(error));
  }
  pending.value = resolveLocal(pending.value, approvalId);
  focusComposer.value++;
}

export async function answer(interactionId: string, value: unknown) {
  try {
    await api.answer(interactionId, value);
  } catch (error) {
    if (!(error instanceof ApiRequestError && (error.status === 409 || error.status === 404)))
      showToast(errorText(error));
  }
  pending.value = resolveLocal(pending.value, interactionId);
  focusComposer.value++;
}

export function saveDraft(sessionId: string, text: string): void {
  writePref(`alisio.draft.${sessionId}`, text || undefined);
}

export const loadDraft = (sessionId: string): string => readPref(`alisio.draft.${sessionId}`) ?? "";
