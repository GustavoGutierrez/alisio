/**
 * State and calls of the plugin creator page (a lazy chunk). The projects list, the project on
 * screen and the creator session's own transcript, fed by the app's stream through `frameTaps`
 * (the stream watches `creatorSession` while the page is open). Approvals of that session stay in
 * the shared pending store, so the normal approval flow answers them.
 */
import type {
  AgentModelOption,
  PluginCreatorBuildResponse,
  PluginCreatorFile,
  PluginCreatorFileList,
  PluginCreatorProjectEntry,
  PluginCreatorSessionResponse,
  ServerFrame,
} from "@alisio/sdk";
import { batch, computed, signal } from "@preact/signals";
import { newId } from "../../net/api.ts";
import { api, pending, showToast } from "../../store/app.ts";
import { creatorSession, frameTaps } from "../../store/plugin-apps-state.ts";
import {
  applyFrames,
  emptyTranscript,
  localEcho,
  type TranscriptState,
} from "../../store/transcript.ts";
import { isRunActive } from "./model.ts";

const BASE = "/api/plugin-creator/projects";
const enc = encodeURIComponent;
/** Project refresh while a run is going on (the agent reports its steps there). */
export const POLL_MS = 2_000;
const JOB_POLL_MS = 600;

export interface ProjectsState {
  loading: boolean;
  error?: string;
  items: PluginCreatorProjectEntry[];
}

export const projects = signal<ProjectsState>({ loading: true, items: [] });
/** The project on screen, or undefined for the "new plugin" view. */
export const selectedId = signal<string | undefined>(undefined);
export const feed = signal<TranscriptState>(emptyTranscript(""));
export const readOnly = signal(false);
/** A build started from this page is running. */
export const buildingId = signal<string | undefined>(undefined);
/** Result of the last build of the selected project (kept until another project is opened). */
export const lastBuild = signal<
  { id: string; ok: boolean; response?: PluginCreatorBuildResponse; error?: unknown } | undefined
>(undefined);
/** An install or update job of this page: the project and its state. */
export const installing = signal<string | undefined>(undefined);
/** When this page last started a creator run (polling and the timer start before the stream). */
export const startedAt = signal<number | undefined>(undefined);
/** Text of the new-request box (examples prefill it) and a counter that focuses it. */
export const requestDraft = signal("");
export const requestFocus = signal(0);

export const selected = computed(() =>
  projects.value.items.find((item) => item.project.id === selectedId.value),
);
/** Status of the creator session on screen (snapshot plus `session_status` frames). */
export const runStatus = computed(() => feed.value.session?.status);
export const running = computed(() => isRunActive(runStatus.value));
export const approvals = computed(() => {
  const sid = creatorSession.value;
  return sid ? pending.value.approvals.filter((a) => a.rootSessionId === sid) : [];
});
export const interactions = computed(() => {
  const sid = creatorSession.value;
  return sid ? pending.value.interactions.filter((i) => i.sessionId === sid) : [];
});

const tap = (frames: ServerFrame[]) => {
  const sid = creatorSession.value;
  if (!sid) return;
  const next = applyFrames(feed.value, frames);
  if (next !== feed.value) feed.value = next;
};

/** Starts listening to the stream; returns the cleanup (unwatch the session too). */
export function attach(): () => void {
  frameTaps.add(tap);
  return () => {
    frameTaps.delete(tap);
    creatorSession.value = undefined;
  };
}

/** Watches `sessionId` (or nothing): the stream reconnects and sends its snapshot. */
export function watch(sessionId: string | undefined): void {
  if (creatorSession.value === sessionId) return;
  batch(() => {
    feed.value = emptyTranscript(sessionId ?? "");
    creatorSession.value = sessionId;
  });
}

const upsert = (entry: PluginCreatorProjectEntry) => {
  const items = projects.value.items;
  const index = items.findIndex((item) => item.project.id === entry.project.id);
  projects.value = {
    ...projects.value,
    items: index < 0 ? [entry, ...items] : items.map((item, i) => (i === index ? entry : item)),
  };
};

export async function loadProjects(): Promise<void> {
  try {
    const list = await api.request<{ projects: PluginCreatorProjectEntry[] }>("GET", BASE);
    projects.value = { loading: false, items: list.projects };
  } catch (error) {
    projects.value = {
      ...projects.value,
      loading: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function refreshProject(id: string): Promise<PluginCreatorProjectEntry | undefined> {
  try {
    const entry = await api.request<PluginCreatorProjectEntry>("GET", `${BASE}/${enc(id)}`);
    upsert(entry);
    return entry;
  } catch {
    return undefined;
  }
}

export function select(id: string | undefined): void {
  if (selectedId.value === id) return;
  batch(() => {
    selectedId.value = id;
    lastBuild.value = undefined;
    startedAt.value = undefined;
  });
  const entry = projects.value.items.find((item) => item.project.id === id);
  watch(entry?.project.sessionId);
}

/** Sends `text` to the creator session (shown at once as a pending bubble). */
export async function prompt(sessionId: string, text: string): Promise<void> {
  const requestId = newId();
  if (feed.value.sessionId === sessionId)
    feed.value = localEcho(feed.value, { localId: requestId, requestId, text });
  await api.prompt(sessionId, { requestId, text });
}

/**
 * Opens (or resumes) the creator session of a project, records `request` as a change when given,
 * watches the session and sends the prompt. An explicit model always starts a fresh session.
 */
export async function startRun(
  id: string,
  text: string,
  options: { request?: boolean; model?: string } = {},
): Promise<void> {
  const session = await api.request<PluginCreatorSessionResponse>(
    "POST",
    `${BASE}/${enc(id)}/session`,
    {
      ...(options.request ? { request: text } : {}),
      ...(options.model ? { model: options.model } : {}),
    },
  );
  watch(session.sessionId);
  startedAt.value = Date.now();
  await refreshProject(id);
  await prompt(session.sessionId, text);
}

/** Creates a project from a request and starts its creator run. Returns the new id. */
export async function createProject(request: string, model?: string): Promise<string> {
  const entry = await api.request<PluginCreatorProjectEntry>("POST", BASE, {
    request,
    ...(model ? { model } : {}),
  });
  upsert(entry);
  select(entry.project.id);
  await startRun(entry.project.id, request, model ? { model } : {});
  return entry.project.id;
}

export async function cancelRun(): Promise<void> {
  const sid = creatorSession.value;
  if (sid) await api.cancel(sid).catch(() => {});
}

/** Validate, test and pack. Failures (422) carry the same response in their details. */
export async function buildProject(id: string): Promise<boolean> {
  buildingId.value = id;
  try {
    const response = await api.request<PluginCreatorBuildResponse>(
      "POST",
      `${BASE}/${enc(id)}/build`,
      {},
    );
    upsert({ project: response.project, status: response.status });
    lastBuild.value = { id, ok: true, response };
    return true;
  } catch (error) {
    const details = (error as { details?: unknown }).details as
      | PluginCreatorBuildResponse
      | undefined;
    if (details && typeof details === "object" && "project" in details && "status" in details)
      upsert({ project: details.project, status: details.status });
    lastBuild.value = { id, ok: false, error };
    return false;
  } finally {
    buildingId.value = undefined;
  }
}

/** Project id -> why its last install was rolled back (the plugin could not start). */
export const activationFailures = signal<Record<string, string>>({});

export interface InstallJobView {
  done: boolean;
  error?: string;
  result?: {
    /** The installed plugin did not start (sanitized reason). */
    activationError?: string;
    /** The install was undone because of `activationError`. */
    rolledBack?: boolean;
    installedVersion?: string;
    restartPending?: boolean;
    restartRequired?: boolean;
    enabled?: boolean;
    enableError?: string;
  };
}

/** Installs (or updates) the project's package; resolves with the finished job. */
export async function installProject(id: string, workspace?: string): Promise<InstallJobView> {
  installing.value = id;
  try {
    const { jobId } = await api.request<{ jobId: string }>("POST", `${BASE}/${enc(id)}/install`, {
      confirmed: true,
      ...(workspace ? { workspace } : {}),
    });
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, JOB_POLL_MS));
      const job = await api.request<InstallJobView>("GET", `/api/plugins/jobs/${enc(jobId)}`);
      if (job.done) {
        await refreshProject(id);
        return job;
      }
    }
  } finally {
    installing.value = undefined;
  }
}

export async function deleteProject(
  id: string,
  uninstall: boolean,
): Promise<{ deleted: boolean; uninstalled: boolean; restartPending: boolean }> {
  const result = await api.request<{
    deleted: boolean;
    uninstalled: boolean;
    restartPending: boolean;
  }>("DELETE", `${BASE}/${enc(id)}`, { uninstall });
  batch(() => {
    projects.value = {
      ...projects.value,
      items: projects.value.items.filter((item) => item.project.id !== id),
    };
    if (selectedId.value === id) {
      selectedId.value = undefined;
      lastBuild.value = undefined;
    }
  });
  watch(undefined);
  return result;
}

/** Shows the new-request panel with `text` in the box, focused. */
export function prefill(text: string): void {
  select(undefined);
  requestDraft.value = text;
  requestFocus.value++;
}

export const listFiles = (id: string) =>
  api.request<PluginCreatorFileList>("GET", `${BASE}/${enc(id)}/files`);

export const readFile = (id: string, path: string) =>
  api.request<PluginCreatorFile>(
    "GET",
    `${BASE}/${enc(id)}/files/${path.split("/").map(enc).join("/")}`,
  );

export const packageUrl = (id: string) => `${BASE}/${enc(id)}/package`;
export const iconUrl = (id: string, version: string) => `${BASE}/${enc(id)}/icon?v=${enc(version)}`;

export const loadModels = (workspace: string) => api.agentModels(workspace);
export type { AgentModelOption };

export function toastText(text: string): void {
  showToast(text);
}
