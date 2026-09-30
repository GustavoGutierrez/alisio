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
        trusted: false,
        untrustedResources: false,
      });
  const groups: WorkspaceGroup[] = [];
  for (const workspace of known.values()) {
    const name = workspaceName(workspace);
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
    groups.push({ workspace, name, sessions });
  }
  return groups.sort(
    (a, b) =>
      Number(b.workspace.pinned) - Number(a.workspace.pinned) ||
      a.workspace.path.localeCompare(b.workspace.path),
  );
}
