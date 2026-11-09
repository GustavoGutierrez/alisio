/** Signals and actions of the plugin Apps feature (catalog polling, open app, kept instances). */
import { computed, effect, signal } from "@preact/signals";
import { t } from "../i18n/index.ts";
import { api, detail, showToast, sidebar } from "./app.ts";
import { errorText } from "./errors.ts";
import {
  type AppCatalogState,
  type AppInstance,
  appsOf,
  instanceKey,
  pickAppSession,
  receiveAppCatalog,
  withInstance,
} from "./plugin-apps-model.ts";
import { activeAppKey, activeAppSession } from "./plugin-apps-state.ts";
import { newSessionTarget, upsertSession } from "./sessions.ts";

export const APP_CATALOG_REFRESH_MS = 15_000;

/** The workspace whose apps the sidebar lists: the open session's, else the usual target. */
export const appsWorkspace = computed(
  () => detail.value?.workspaceId ?? newSessionTarget(sidebar.value),
);
export const appCatalog = signal<AppCatalogState | undefined>(undefined);
/** Apps of the current workspace's enabled plugins. Empty hides the whole Apps group. */
export const currentApps = computed(() => appsOf(appCatalog.value, appsWorkspace.value));
/** Every app opened so far; their frames stay mounted (hidden) until the page reloads. */
export const appInstances = signal<AppInstance[]>([]);
/** The instance shown in place of the chat, if any. */
export { activeAppKey };
export const activeApp = computed(() =>
  appInstances.value.find((instance) => instance.key === activeAppKey.value),
);

/** While an app is open, the stream also watches the session its actions run in (approvals). */
effect(() => {
  activeAppSession.value = activeApp.value?.sessionId;
});

let refreshing: AbortController | undefined;
export async function refreshAppCatalog(): Promise<void> {
  const workspace = appsWorkspace.value;
  refreshing?.abort();
  if (!workspace) {
    appCatalog.value = undefined;
    return;
  }
  const controller = new AbortController();
  refreshing = controller;
  try {
    const apps = await api.pluginApps(workspace, controller.signal);
    if (!controller.signal.aborted && workspace === appsWorkspace.value)
      appCatalog.value = receiveAppCatalog(appCatalog.value, workspace, apps);
  } catch {
    // A failed refresh keeps the last catalog; the next tick tries again.
  }
}

/** Starts the catalog refresh (on workspace change and every 15 s). Returns a stop function. */
export function startAppCatalog(interval = APP_CATALOG_REFRESH_MS): () => void {
  const stopEffect = effect(() => {
    void appsWorkspace.value;
    void refreshAppCatalog();
  });
  const timer = setInterval(() => void refreshAppCatalog(), interval);
  return () => {
    stopEffect();
    clearInterval(timer);
    refreshing?.abort();
  };
}

/** Back to the chat; the app instance and its unsaved edits stay mounted. */
export function closeApp(): void {
  activeAppKey.value = undefined;
}

/** Opens (or returns to) an app of the current workspace, resolving the session it runs in. */
export async function openApp(plugin: string, app: string): Promise<void> {
  const workspace = appsWorkspace.value;
  if (!workspace) return;
  const key = instanceKey(workspace, plugin, app);
  if (appInstances.value.some((instance) => instance.key === key)) {
    activeAppKey.value = key;
    return;
  }
  try {
    let sessionId = pickAppSession(
      sidebar.value,
      workspace,
      detail.value ? { id: detail.value.id, workspaceId: detail.value.workspaceId } : undefined,
    );
    if (!sessionId) {
      const created = await api.createSession({ workspace });
      sidebar.value = upsertSession(sidebar.value, created);
      sessionId = created.id;
    }
    appInstances.value = withInstance(appInstances.value, {
      key,
      workspace,
      plugin,
      app,
      sessionId,
    });
    activeAppKey.value = key;
  } catch (error) {
    showToast(`${t("apps.openFailed")} ${errorText(error)}`);
  }
}
