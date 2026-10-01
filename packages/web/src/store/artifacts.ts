/**
 * Artifacts of the open session (spec §15.1): the list loaded on session open, after every run and
 * on each `artifact_published` event (it reconciles the cards built from tool results by id, e.g.
 * to show `deleted`), the artifact panel (which artifact, its switcher, viewer links, failures),
 * plus the saved capability grants behind the header's permissions popover. The pure logic is in
 * `util/artifacts.ts` and `util/panel.ts`.
 */
import type { ArtifactRef, CapabilityGrantWire, DatasetRef } from "@alisio/sdk";
import { batch, effect, signal, untracked } from "@preact/signals";
import { t } from "../i18n/index.ts";
import { ApiRequestError } from "../net/api.ts";
import { downloadUrl, mergeArtifacts } from "../util/artifacts.ts";
import { freshViewUrl } from "../util/panel.ts";
import {
  api,
  artifactsRequest,
  capabilitiesTick,
  currentId,
  focusComposer,
  permissionsOpen,
  publishedArtifacts,
  runEnded,
  toast,
} from "./app.ts";
import { dockOpen, setDockOpen } from "./dock.ts";

/** Session id → its artifacts (newest first); absent until the first load finishes. */
export const artifactsBySession = signal<Record<string, ArtifactRef[]>>({});

export async function loadArtifacts(sessionId: string): Promise<void> {
  try {
    const { items } = await api.artifacts(sessionId);
    artifactsBySession.value = {
      ...artifactsBySession.value,
      [sessionId]: mergeArtifacts([], items),
    };
  } catch {
    /* Cards keep their own data; reconciliation retries after the next run. */
  }
}

// Reload when a session opens and after each run (new artifacts, deletions elsewhere).
effect(() => {
  const id = currentId.value;
  void runEnded.value;
  if (id) void loadArtifacts(id);
});

/** Adds artifacts announced live (`artifact_published`) to the session list. */
export function artifactsPublished(sessionId: string, incoming: ArtifactRef[]): void {
  const list = artifactsBySession.value[sessionId];
  if (!list) return;
  batch(() => {
    artifactsBySession.value = {
      ...artifactsBySession.value,
      [sessionId]: mergeArtifacts(list, incoming),
    };
    // Shown with a "new" dot in the switcher; the panel's view never changes by itself.
    if (artifactPanel.value)
      unseen.value = new Set([...unseen.value, ...incoming.map((artifact) => artifact.id)]);
  });
}

effect(() => {
  const batchOf = publishedArtifacts.value;
  if (batchOf) untracked(() => artifactsPublished(batchOf.sessionId, batchOf.artifacts));
});

effect(() => {
  const request = artifactsRequest.value;
  if (request) untracked(() => browseArtifacts(request.filter));
});

/**
 * The artifact panel: the artifact on view (absent = the empty state of `/artifacts`), whether
 * its switcher starts open and with which filter. `null` = closed.
 */
export interface ArtifactPanelState {
  id?: string;
  /** A dataset attached to a prompt, shown as a table instead of an artifact. */
  dataset?: DatasetRef;
  listOpen?: boolean;
  filter?: string;
}
export const artifactPanel = signal<ArtifactPanelState | null>(null);
/** Artifacts published while the panel was open and not yet looked at. */
export const unseen = signal<Set<string>>(new Set());
/** Why opening an artifact failed (cards show "Unavailable" and Retry). */
export const openErrors = signal<Record<string, string>>({});

/** The element that opened the panel: focus returns there on close. */
let opener: HTMLElement | undefined;

/** Opens the panel on an artifact (closing the Dock: one right slot, ADR-07). */
export function openArtifact(id: string, from?: HTMLElement): void {
  if (from) opener = from;
  batch(() => {
    if (dockOpen.peek()) setDockOpen(false);
    clearOpenError(id);
    const next = new Set(unseen.value);
    next.delete(id);
    unseen.value = next;
    artifactPanel.value = { id };
  });
}

/** Opens an attached dataset as a table in the right slot (closing the Dock, like an artifact). */
export function openDataset(dataset: DatasetRef, from?: HTMLElement): void {
  if (from) opener = from;
  batch(() => {
    if (dockOpen.peek()) setDockOpen(false);
    artifactPanel.value = { dataset };
  });
}

/** `/artifacts [filter]`: the panel with its switcher open (or its empty state). */
export function browseArtifacts(filter = ""): void {
  const id = currentId.peek();
  const list = id ? artifactsBySession.peek()[id] : undefined;
  const current = artifactPanel.peek()?.id ?? list?.find((a) => a.status === "ready")?.id;
  batch(() => {
    if (dockOpen.peek()) setDockOpen(false);
    artifactPanel.value = {
      ...(current ? { id: current } : {}),
      listOpen: true,
      ...(filter ? { filter } : {}),
    };
  });
}

/** Closes the panel and returns focus to the card that opened it (or the composer). */
export function closeArtifactPanel(restoreFocus = true): void {
  artifactPanel.value = null;
  unseen.value = new Set();
  const target = opener;
  opener = undefined;
  if (!restoreFocus) return;
  if (target?.isConnected) target.focus();
  else focusComposer.value++;
}

// Artifacts belong to a session: switching sessions closes the panel.
let shownSession = currentId.peek();
effect(() => {
  const id = currentId.value;
  if (id !== shownSession && artifactPanel.peek()) untracked(() => closeArtifactPanel(false));
  shownSession = id;
});

export function setOpenError(id: string, message: string): void {
  openErrors.value = { ...openErrors.value, [id]: message };
}
export function clearOpenError(id: string): void {
  if (!(id in openErrors.value)) return;
  const next = { ...openErrors.value };
  delete next[id];
  openErrors.value = next;
}

const viewLinks = new Map<string, { url: string; expiresAt: number }>();

/** A viewer link for a dashboard or PDF, reused until 30 s before it expires. */
export async function requestViewUrl(id: string): Promise<string> {
  const cached = freshViewUrl(viewLinks.get(id), Date.now());
  if (cached) return cached;
  const link = await api.artifactView(id);
  viewLinks.set(id, link);
  return link.url;
}

/** Whether a failure means the artifact is gone (404/410) rather than a transient error. */
export const goneError = (error: unknown): boolean =>
  error instanceof ApiRequestError && (error.status === 404 || error.status === 410);

/** Deletes an artifact (after the panel's confirmation) and refreshes the list. */
export async function deleteArtifact(id: string): Promise<void> {
  await api.deleteArtifact(id);
  viewLinks.delete(id);
  const session = currentId.peek();
  if (session) await loadArtifacts(session);
}

/** "Copy to workspace…": runs `artifact_export` in the session (approval when required). */
export async function exportArtifact(
  id: string,
  target: string,
  overwrite: boolean,
): Promise<boolean> {
  try {
    await api.exportArtifact(id, target, overwrite);
    return true;
  } catch (error) {
    toast.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** Runs the analysis behind an artifact again; the capability gate may ask in the chat. */
export async function rerunArtifact(id: string, name: string): Promise<boolean> {
  try {
    await api.rerunArtifact(id);
    toast.value = t("artifactPanel.rerunStarted", { name });
    return true;
  } catch (error) {
    toast.value = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** Starts a download without opening anything (the server sends `attachment`). */
export function downloadArtifact(id: string): void {
  const link = document.createElement("a");
  link.href = downloadUrl(id);
  link.download = "";
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
}

export const grants = signal<{
  sessionId: string;
  items: CapabilityGrantWire[];
  error?: boolean;
}>();

export async function loadGrants(sessionId: string): Promise<void> {
  try {
    const { items } = await api.capabilities(sessionId);
    grants.value = { sessionId, items };
  } catch {
    grants.value = { sessionId, items: [], error: true };
  }
}

export async function revokeGrant(sessionId: string, grantId: string): Promise<void> {
  try {
    await api.revokeCapability(sessionId, grantId);
  } finally {
    await loadGrants(sessionId);
  }
}

// Refetch while the popover is open, when the session changes and on `capabilities_changed`.
effect(() => {
  const id = currentId.value;
  void capabilitiesTick.value;
  if (id && permissionsOpen.value) void loadGrants(id);
});

/** Live (not revoked) session grants. */
export const liveGrants = (items: CapabilityGrantWire[]): CapabilityGrantWire[] =>
  items.filter((g) => g.scope === "session" && g.decision === "allow" && g.revokedAt === undefined);
