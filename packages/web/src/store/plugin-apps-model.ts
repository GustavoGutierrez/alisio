/** Pure model of the plugin Apps feature: catalog state, labels, instances and the session pick. */
import type { PluginAppInfo } from "@alisio/sdk";
import type { SidebarState } from "./sessions.ts";

export interface AppCatalogState {
  workspace: string;
  apps: PluginAppInfo[];
}

/** One mounted app: per project, plugin and app id (a different project is another instance). */
export interface AppInstance {
  key: string;
  workspace: string;
  plugin: string;
  app: string;
  sessionId: string;
}

export const instanceKey = (workspace: string, plugin: string, app: string): string =>
  JSON.stringify([workspace, plugin, app]);

/** The label for a locale: exact, then its base language, then English, then the id. */
export function appLabel(info: PluginAppInfo, locale: string): string {
  const base = locale.split("-")[0] ?? locale;
  return info.label[locale] ?? info.label[base] ?? info.label.en ?? info.id;
}

/** A catalog answer applies only if it is still for the workspace the user is looking at. */
export function receiveAppCatalog(
  state: AppCatalogState | undefined,
  workspace: string,
  apps: PluginAppInfo[],
): AppCatalogState {
  return { workspace, apps: apps.map((app) => ({ ...app, label: { ...app.label } })) };
}

/** Apps of `workspace`, or none while the catalog belongs to another workspace. */
export const appsOf = (state: AppCatalogState | undefined, workspace: string | undefined) =>
  state && workspace && state.workspace === workspace ? state.apps : [];

/**
 * The session an app of `workspace` runs in: the open session if it belongs to the project, else
 * the project's most recently updated root session; `undefined` means "create one".
 */
export function pickAppSession(
  sidebar: SidebarState,
  workspace: string,
  current?: { id: string; workspaceId: string },
): string | undefined {
  if (current && current.workspaceId === workspace) return current.id;
  return Object.values(sidebar.sessions)
    .filter((s) => s.workspaceId === workspace && !s.archived && !s.parentId)
    .sort((a, b) => (b.updatedAt ?? -1) - (a.updatedAt ?? -1))[0]?.id;
}

/** Adds an instance once; reopening an existing one keeps its session and frame. */
export function withInstance(list: AppInstance[], instance: AppInstance): AppInstance[] {
  return list.some((entry) => entry.key === instance.key) ? list : [...list, instance];
}

export interface AppMenuItem {
  key: string;
  plugin: string;
  id: string;
  label: string;
  active: boolean;
}

/** Entries of the sidebar Apps group; an empty list means the whole group is not rendered. */
export function appMenuItems(
  state: AppCatalogState | undefined,
  workspace: string | undefined,
  activeKey: string | undefined,
  locale: string,
): AppMenuItem[] {
  return appsOf(state, workspace).map((app) => {
    const key = instanceKey(workspace ?? "", app.plugin, app.id);
    return {
      key,
      plugin: app.plugin,
      id: app.id,
      label: appLabel(app, locale),
      active: key === activeKey,
    };
  });
}
