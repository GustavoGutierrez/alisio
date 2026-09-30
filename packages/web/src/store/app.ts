/**
 * The app controller: signals over the pure reducers plus the actions components call. One
 * `EventStream` watches the open session (every stream also receives `session_status` for the
 * sidebar); frames arrive batched per animation frame and are applied in one signal update.
 */

import type {
  BlobRef,
  CommandDescriptor,
  PermissionPresetId,
  ServerFrame,
  SessionContextUsage,
  SessionDetail,
  SessionModels,
} from "@alisio/sdk";
import { batch, computed, signal } from "@preact/signals";
import { ApiClient, ApiRequestError, newId } from "../net/api.ts";
import { type EventSourceLike, EventStream, type StreamStatus } from "../net/events.ts";
import { parseSlash, pushHistory } from "./composer.ts";
import { applyPending, emptyPending, resolveLocal, visiblePending } from "./pending.ts";
import {
  applySessionStatus,
  emptySidebar,
  loadSidebar,
  upsertSession,
  upsertWorkspace,
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
export const mobileSidebar = signal(false);
/** Asks the composer to take focus (e.g. after an approval is answered). */
export const focusComposer = signal(0);
export const toast = signal<string | undefined>(undefined);
/** Text the composer should insert at its cursor (e.g. an `@path` mention from the dock). */
export const composerInsert = signal<{ text: string; n: number } | undefined>(undefined);
/** Bumped when a run of the open session ends (the dock refreshes its tree and changes). */
export const runEnded = signal(0);

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

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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
        api.workspaces(),
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

function onFrames(frames: ServerFrame[]): void {
  let ended = false;
  let rewritten = false;
  let catalog = false;
  batch(() => {
    transcript.value = applyFrames(transcript.value, frames);
    let nextPending = pending.value;
    let nextSidebar = sidebar.value;
    for (const frame of frames) {
      nextPending = applyPending(nextPending, frame);
      if (frame.t === "session_status") nextSidebar = applySessionStatus(nextSidebar, frame);
      if (frame.t === "approval" && frame.approval.rootSessionId === currentId.value)
        announceAssertive.value = frame.approval.name ?? frame.approval.approvalId;
      if (frame.t === "catalog_changed" && frame.scope === "commands") catalog = true;
      if (frame.t === "event" && frame.sessionId === currentId.value) {
        const type = frame.event.type;
        if (type === "run_completed") announcePolite.value = `${Date.now()}`;
        if (type === "run_completed" || type === "run_failed" || type === "run_cancelled")
          ended = true;
        if (type === "compaction_completed") rewritten = true;
        if (type === "model_changed") ended = true;
      }
    }
    pending.value = nextPending;
    sidebar.value = nextSidebar;
  });
  if (sidebar.value.stale) void reloadSidebar();
  if (ended) {
    runEnded.value++;
    void refreshContext();
  }
  if (catalog) void refreshCommands();
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
    models.value = undefined;
    context.value = undefined;
    mobileSidebar.value = false;
  });
  const hash = id ? `#/s/${encodeURIComponent(id)}` : "#/";
  if (location.hash !== hash) history_replace(hash);
  stream?.subscribe(id ? [id] : []);
  if (id) writePref("alisio.lastSession", id);
  void refreshCommands();
  if (!id) return;
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
  await reloadSidebar();
  if (auth.value !== "ok") return;
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

/** Creates a session in a workspace (the open session's, else the first known one). */
export async function newSession(workspaceId?: string): Promise<void> {
  const workspace =
    workspaceId ?? detail.value?.workspaceId ?? sidebar.value.workspaces[0]?.id ?? undefined;
  if (!workspace) return;
  try {
    const created = await api.createSession({ workspace });
    sidebar.value = upsertSession(sidebar.value, created);
    await openSession(created.id);
    focusComposer.value++;
  } catch (error) {
    showToast(errorText(error));
  }
}

export async function addWorkspace(path: string): Promise<boolean> {
  try {
    const info = await api.addWorkspace(path.trim());
    sidebar.value = upsertWorkspace(sidebar.value, info);
    return true;
  } catch (error) {
    showToast(errorText(error));
    return false;
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
  });
  try {
    await api.prompt(id, {
      requestId,
      text,
      ...(display ? { display } : {}),
      ...(attachments ? { attachments } : {}),
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
  );
}

/**
 * Composer submit: a known slash command runs through the catalog, anything else is a prompt.
 * Prompts with images always go to the model (commands take no attachments).
 */
export async function submit(
  text: string,
  images?: { refs: BlobRef[]; thumbs: string[] },
): Promise<void> {
  const id = currentId.value;
  if (!id || (!text.trim() && !images?.refs.length)) return;
  if (text.trim()) remember(text);
  if (images?.refs.length) return sendPrompt(text, undefined, newId(), images);
  const slash = parseSlash(text);
  const known = slash
    ? commands.value.find(
        (c) => c.name === slash.name || c.aliases?.includes(slash.name.toLowerCase()),
      )
    : undefined;
  if (!slash || !known) return sendPrompt(text);
  try {
    const outcome = await api.command(id, {
      requestId: newId(),
      name: known.name,
      ...(slash.args ? { args: slash.args } : {}),
    });
    if (outcome.output) transcript.value = addLocalNote(transcript.value, outcome.output);
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
