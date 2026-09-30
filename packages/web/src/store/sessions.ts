/**
 * Sidebar index: workspaces and root sessions (spec §10.3). Pure reducers; `session_status`
 * frames update rows in place, and a frame for an unknown session marks the index stale so the
 * app reloads the list.
 */
import type { ServerFrame, SessionSummary, WorkspaceInfo } from "@alisio/sdk";

export interface SidebarState {
  workspaces: WorkspaceInfo[];
  sessions: Record<string, SessionSummary>;
  /** A session the index does not know changed: reload the list. */
  stale: boolean;
  loaded: boolean;
}

export interface WorkspaceGroup {
  workspace: WorkspaceInfo;
  name: string;
  /** Short parent path that tells apart workspaces sharing `name` (e.g. two `alisio` clones). */
  hint?: string;
  sessions: SessionSummary[];
}

export const emptySidebar = (): SidebarState => ({
  workspaces: [],
  sessions: {},
  stale: false,
  loaded: false,
});

export function loadSidebar(
  _state: SidebarState,
  workspaces: WorkspaceInfo[],
  sessions: SessionSummary[],
): SidebarState {
  return {
    workspaces,
    sessions: Object.fromEntries(sessions.filter((s) => !s.parentId).map((s) => [s.id, s])),
    stale: false,
    loaded: true,
  };
}

export const upsertSession = (state: SidebarState, session: SessionSummary): SidebarState => ({
  ...state,
  sessions: { ...state.sessions, [session.id]: { ...state.sessions[session.id], ...session } },
});

export const upsertWorkspace = (state: SidebarState, workspace: WorkspaceInfo): SidebarState => ({
  ...state,
  workspaces: [...state.workspaces.filter((w) => w.id !== workspace.id), workspace].sort((a, b) =>
    a.path.localeCompare(b.path),
  ),
});

export function applySessionStatus(
  state: SidebarState,
  frame: Extract<ServerFrame, { t: "session_status" }>,
): SidebarState {
  const current = state.sessions[frame.sessionId];
  if (!current) return { ...state, stale: true };
  return upsertSession(state, {
    ...current,
    status: frame.status,
    ...(frame.title !== undefined ? { title: frame.title } : {}),
    ...(frame.updatedAt !== undefined ? { updatedAt: frame.updatedAt } : {}),
  });
}

export const workspaceName = (workspace: WorkspaceInfo): string =>
  workspace.label ?? workspace.path.split(/[\\/]/).filter(Boolean).at(-1) ?? workspace.path;

const parentSegments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean).slice(0, -1);

/**
 * Hints for workspaces whose display names collide: the shortest parent-path suffix (at least two
 * folders when available) that is unique among the same-named ones. Labelled workspaces are named
 * by their user and get no hint.
 */
export function workspaceHints(workspaces: WorkspaceInfo[]): Map<string, string> {
  const byName = new Map<string, WorkspaceInfo[]>();
  for (const workspace of workspaces) {
    if (workspace.label) continue;
    const key = workspaceName(workspace).toLowerCase();
    byName.set(key, [...(byName.get(key) ?? []), workspace]);
  }
  const hints = new Map<string, string>();
  for (const group of byName.values()) {
    if (group.length < 2) continue;
    const parents = group.map((w) => parentSegments(w.path));
    const longest = Math.max(...parents.map((p) => p.length));
    const suffixes = (k: number) => parents.map((p) => (p.length ? p.slice(-k).join("/") : "/"));
    let k = Math.min(2, Math.max(1, longest));
    while (k < longest && new Set(suffixes(k)).size < group.length) k++;
    suffixes(k).forEach((suffix, i) => {
      const id = group[i]?.id;
      if (id) hints.set(id, suffix);
    });
  }
  return hints;
}

/**
 * Where a "New session" without an explicit workspace goes: the current session's workspace if its
 * folder still exists, else the most recently used existing one (opened or with the latest
 * session). `undefined` when no existing workspace is known (the user must open one).
 */
export function newSessionTarget(
  state: SidebarState,
  currentWorkspaceId?: string,
): string | undefined {
  const exists = (id: string) => state.workspaces.find((w) => w.id === id)?.exists !== false;
  if (currentWorkspaceId && exists(currentWorkspaceId)) return currentWorkspaceId;
  const latest = new Map<string, number>();
  for (const s of Object.values(state.sessions))
    latest.set(s.workspaceId, Math.max(latest.get(s.workspaceId) ?? 0, s.updatedAt ?? 0));
  const recency = (w: WorkspaceInfo) => Math.max(w.lastOpenedAt ?? 0, latest.get(w.id) ?? 0);
  return state.workspaces
    .filter((w) => w.exists !== false)
    .sort((a, b) => recency(b) - recency(a))[0]?.id;
}

/** Pinned first, then most recently updated; sessions without `updatedAt` last. */
const bySidebarOrder = (a: SessionSummary, b: SessionSummary): number =>
  a.pinned !== b.pinned ? (a.pinned ? -1 : 1) : (b.updatedAt ?? -1) - (a.updatedAt ?? -1);

/** Workspace folders with their visible sessions, filtered by a search query. */
export function groupSessions(
  state: SidebarState,
  query: string,
  showArchived = false,
): WorkspaceGroup[] {
  const q = query.trim().toLowerCase();
  const all = Object.values(state.sessions).filter((s) => showArchived || !s.archived);
  const known = new Map(state.workspaces.map((w) => [w.id, w]));
  for (const s of all)
    if (!known.has(s.workspaceId))
      known.set(s.workspaceId, {
        id: s.workspaceId,
        path: s.workspace,
        pinned: false,
        open: false,
        // Unknown to the server list: assume present; opening it reports `workspace_missing`.
        exists: true,
        trusted: false,
        untrustedResources: false,
      });
  const groups: WorkspaceGroup[] = [];
  const hints = workspaceHints([...known.values()]);
  for (const workspace of known.values()) {
    const name = workspaceName(workspace);
    const hint = hints.get(workspace.id);
    const sessions = all
      .filter((s) => s.workspaceId === workspace.id)
      .filter(
        (s) =>
          !q ||
          (s.title ?? "").toLowerCase().includes(q) ||
          s.id.toLowerCase().startsWith(q) ||
          name.toLowerCase().includes(q),
      )
      .sort(bySidebarOrder);
    if (q && !sessions.length && !name.toLowerCase().includes(q)) continue;
    groups.push({ workspace, name, ...(hint ? { hint } : {}), sessions });
  }
  return groups.sort(
    (a, b) =>
      Number(b.workspace.pinned) - Number(a.workspace.pinned) ||
      a.workspace.path.localeCompare(b.workspace.path),
  );
}
