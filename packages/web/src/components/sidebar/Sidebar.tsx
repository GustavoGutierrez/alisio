import type { SessionSummary } from "@alisio/sdk";
import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale, t } from "../../i18n/index.ts";
import {
  addWorkspace,
  agentsOpen,
  appVersion,
  currentId,
  mobileSidebar,
  newSession,
  now,
  openMode,
  openSession,
  openWorkspaceRequest,
  patchCurrent,
  patchWorkspace,
  picking,
  pickWorkspace,
  settingsOpen,
  setWorkspaceTrust,
  sidebar,
  skillBuilderOpen,
} from "../../store/app.ts";
import { allCollapsed, closedFolders, folderOpen, setFoldersOpen } from "../../store/folders.ts";
import { activeAppKey, appCatalog, appsWorkspace, openApp } from "../../store/plugin-apps.ts";
import { appMenuItems } from "../../store/plugin-apps-model.ts";
import { setSidebarCollapsed, sidebarCollapsed } from "../../store/prefs.ts";
import { groupSessions, projectSections } from "../../store/sessions.ts";
import { relativeTime } from "../../util/time.ts";
import { Icon } from "../icons.tsx";
import { Menu } from "../Menu.tsx";
import type { ColorPalette } from "./ColorPalette.tsx";
import type { FolderBrowser } from "./FolderBrowser.tsx";
import type { ProjectSettings } from "./ProjectSettings.tsx";
import { projectMenuItems } from "./project-settings.ts";
import styles from "./sidebar.module.css";

export const searchRequest = { focus: () => {} };

/** The Apps group: listed just above Projects, and not rendered at all without apps. */
function AppsGroup() {
  const items = appMenuItems(
    appCatalog.value,
    appsWorkspace.value,
    activeAppKey.value,
    locale.value,
  );
  if (!items.length) return null;
  return (
    <section class={styles.appsGroup} aria-labelledby="sidebar-apps-title">
      <div class={styles.sectionHead}>
        <h2 id="sidebar-apps-title" class={styles.sectionTitle}>
          {t("sidebar.apps")}
        </h2>
      </div>
      <ul class={styles.sessions}>
        {items.map((item) => (
          <li key={item.key} class={styles.row} data-active={item.active}>
            <button
              type="button"
              class={`${styles.rowLink} ${styles.appLink}`}
              aria-current={item.active ? "page" : undefined}
              onClick={() => {
                void openApp(item.plugin, item.id);
                mobileSidebar.value = false;
              }}
            >
              <Icon name="layers" size={15} />
              <span class={styles.rowTitle}>{item.label}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function SessionRow({ session }: { session: SessionSummary }) {
  const active = !activeAppKey.value && session.id === currentId.value;
  const title = session.title || t("session.untitled");
  const status = session.status;
  return (
    <li class={styles.row} data-active={active ? "true" : undefined}>
      <a
        href={`#/s/${encodeURIComponent(session.id)}`}
        class={styles.rowLink}
        aria-current={active ? "page" : undefined}
        onClick={(event) => {
          event.preventDefault();
          void openSession(session.id);
        }}
      >
        {status !== "idle" ? (
          <span class={styles.status} data-status={status} title={t(`status.${status}`)}>
            <span class="sr-only">{t(`status.${status}`)}</span>
          </span>
        ) : null}
        {session.pinned && status === "idle" ? (
          <Icon name="pin" size={12} class={styles.pinned} />
        ) : null}
        <span class={styles.rowTitle}>{title}</span>
        <span class={styles.time}>{relativeTime(session.updatedAt, now.value, locale.value)}</span>
      </a>
      <Menu
        label={t("session.actions", { title })}
        align="end"
        fixed
        class={`icon-btn ${styles.rowMenu}`}
        groups={[
          {
            items: [
              { id: "pin", label: session.pinned ? t("session.unpin") : t("session.pin") },
              {
                id: "archive",
                label: session.archived ? t("session.unarchive") : t("session.archive"),
              },
            ],
            onSelect: (action) =>
              void patchCurrent(
                action === "pin" ? { pinned: !session.pinned } : { archived: !session.archived },
                session.id,
              ),
          },
        ]}
      >
        <Icon name="more" size={16} />
      </Menu>
    </li>
  );
}

/** Workspaces and their sessions (RF-11): search, archived filter, open folder, settings. */
/** The windows opened from the foot of the sidebar, in order (above the version line). */
const FOOTER = [
  ["users", "sidebar.agents", agentsOpen],
  ["sparkle", "sidebar.skillBuilder", skillBuilderOpen],
  ["settings", "sidebar.settings", settingsOpen],
] as const;

export function Sidebar() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [archived, setArchived] = useState(false);
  /** How the open-a-workspace UI is shown: nothing, the typed-path form or the folder browser. */
  const [adding, setAdding] = useState<"none" | "manual" | "browser">("none");
  const [path, setPath] = useState("");
  /** The in-app folder browser is a lazy chunk, loaded the first time it is shown. */
  const [Browser, setBrowser] = useState<{ View: typeof FolderBrowser }>();
  /** The project whose color palette is open (the palette is a lazy chunk). */
  const [palette, setPalette] = useState<{ id: string; View: typeof ColorPalette }>();
  /** The project whose settings dialog is open (a lazy chunk, like the palette). */
  const [project, setProject] = useState<{ id: string; View: typeof ProjectSettings }>();
  const search = useRef<HTMLInputElement>(null);
  // Plain render-time derivation: it depends on local state (query, archived) as well as the
  // sidebar signal, which a `useComputed` would only track for the signal.
  const groups = { value: groupSessions(sidebar.value, query, archived) };
  const sections = projectSections(groups.value);
  const shownIds = groups.value.map((g) => g.workspace.id);
  const allClosed = allCollapsed(shownIds, closedFolders.value);
  const collapsed = sidebarCollapsed.value && !mobileSidebar.value;
  const workspaceRequest = openWorkspaceRequest.value;

  /** Native dialog on the server's desktop, else the in-app browser, else a typed path. */
  const openWorkspace = async () => {
    if (openMode.value === "native") {
      setAdding("none");
      if ((await pickWorkspace()) !== "unavailable") return;
    }
    setAdding(openMode.value === "browser" ? "browser" : "manual");
  };

  // "New session" found no existing workspace: open a workspace first.
  useEffect(() => {
    if (!workspaceRequest) return;
    if (sidebarCollapsed.value) setSidebarCollapsed(false);
    void openWorkspace();
  }, [workspaceRequest]);

  useEffect(() => {
    if (adding === "browser" && !Browser)
      void import("./FolderBrowser.tsx").then((m) => setBrowser({ View: m.FolderBrowser }));
  }, [adding]);

  useEffect(() => {
    searchRequest.focus = () => {
      if (sidebarCollapsed.value) setSidebarCollapsed(false);
      setSearching(true);
      requestAnimationFrame(() => search.current?.focus());
    };
  }, []);

  const renderGroup = (group: (typeof groups.value)[number]) => {
    const open = folderOpen(group.workspace.id, closedFolders.value, query);
    const listId = `ws-${group.workspace.id}`;
    const missing = group.workspace.exists === false;
    const archivedWs = group.workspace.archived;
    const blocked = missing || archivedWs;
    const label = group.hint ? `${group.name} · ${group.hint}` : group.name;
    return (
      <section
        key={group.workspace.id}
        class={styles.folder}
        data-missing={missing ? "true" : undefined}
        data-archived={archivedWs ? "true" : undefined}
        data-color={group.workspace.color}
      >
        <div class={styles.folderHead}>
          <button
            type="button"
            class={styles.folderToggle}
            aria-expanded={open}
            aria-controls={listId}
            title={group.workspace.path}
            onClick={() => setFoldersOpen([group.workspace.id], !open)}
          >
            <Icon name="folder" size={16} class={open ? styles.folderOpen : styles.folderIcon} />
            <span class={styles.folderLabel}>
              <span class={styles.folderName}>{group.name}</span>
              {group.hint || missing || archivedWs ? (
                <span class={styles.folderMeta}>
                  {group.hint ? <span class={styles.folderHint}>{group.hint}</span> : null}
                  {missing ? (
                    <span class={styles.missing} title={t("sidebar.missingHint")}>
                      {t("sidebar.missing")}
                    </span>
                  ) : null}
                  {archivedWs ? (
                    <span class={styles.archivedTag} title={t("workspace.archivedHint")}>
                      {t("sidebar.archived")}
                    </span>
                  ) : null}
                </span>
              ) : null}
            </span>
            <span class="sr-only">{t("sidebar.toggleFolder", { name: label })}</span>
          </button>
          {!missing && group.workspace.untrustedResources ? (
            <span class={styles.untrusted} title={t("sidebar.untrustedHint")}>
              {t("sidebar.untrusted")}
            </span>
          ) : null}
          <Menu
            label={t("workspace.actions", { name: label })}
            align="end"
            fixed
            class={`icon-btn ${styles.folderMenu}`}
            groups={[
              {
                items: projectMenuItems(group.workspace, t),
                onSelect: (action) =>
                  action === "color"
                    ? void import("./ColorPalette.tsx").then((m) =>
                        setPalette({ id: group.workspace.id, View: m.ColorPalette }),
                      )
                    : action === "settings"
                      ? void import("./ProjectSettings.tsx").then((m) =>
                          setProject({ id: group.workspace.id, View: m.ProjectSettings }),
                        )
                      : action === "trust"
                        ? void setWorkspaceTrust(group.workspace, !group.workspace.trusted)
                        : void patchWorkspace(
                            group.workspace.id,
                            action === "pin"
                              ? { pinned: !group.workspace.pinned }
                              : { archived: !archivedWs },
                          ),
              },
            ]}
          >
            <Icon name="more" size={16} />
          </Menu>
          <button
            type="button"
            class={`icon-btn ${styles.folderAdd}`}
            aria-label={t("sidebar.newIn", { name: label })}
            title={
              missing
                ? t("sidebar.missingHint")
                : archivedWs
                  ? t("workspace.archivedHint")
                  : t("sidebar.newIn", { name: label })
            }
            disabled={blocked}
            onClick={() => void newSession(group.workspace.id)}
          >
            <Icon name="plus" size={15} />
          </button>
        </div>
        {project?.id === group.workspace.id ? (
          <project.View
            workspaceId={group.workspace.id}
            onClose={() => {
              setProject(undefined);
              // The menu button is still in the page: put focus back where the dialog came from.
              requestAnimationFrame(() =>
                document
                  .getElementById(listId)
                  ?.closest("section")
                  ?.querySelector<HTMLElement>('[aria-haspopup="menu"]')
                  ?.focus(),
              );
            }}
          />
        ) : null}
        {palette?.id === group.workspace.id ? (
          <palette.View
            name={group.name}
            current={group.workspace.color}
            onPick={(color) => void patchWorkspace(group.workspace.id, { color })}
            onClose={() => setPalette(undefined)}
          />
        ) : null}
        {open ? (
          <ul id={listId} class={styles.sessions}>
            {group.sessions.length ? (
              group.sessions.map((session) => <SessionRow key={session.id} session={session} />)
            ) : (
              <li class={styles.emptyRow}>
                {query ? t("sidebar.noMatches", { query }) : t("sidebar.noSessions")}
              </li>
            )}
          </ul>
        ) : null}
      </section>
    );
  };

  if (collapsed)
    return (
      <nav class={`${styles.sidebar} ${styles.rail}`} aria-label={t("sidebar.label")}>
        <button
          type="button"
          class="icon-btn"
          aria-label={t("sidebar.expand")}
          title={t("sidebar.expand")}
          onClick={() => setSidebarCollapsed(false)}
        >
          <Icon name="panel" size={18} />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label={t("sidebar.newSession")}
          title={t("sidebar.newSession")}
          onClick={() => void newSession()}
        >
          <Icon name="plusCircle" size={18} />
        </button>
        <span class={styles.spacer} />
        {FOOTER.map(([icon, label, open]) => (
          <button
            key={label}
            type="button"
            class="icon-btn"
            aria-label={t(label)}
            title={t(label)}
            onClick={() => {
              open.value = true;
            }}
          >
            <Icon name={icon} size={18} />
          </button>
        ))}
      </nav>
    );

  return (
    <nav
      class={styles.sidebar}
      aria-label={t("sidebar.label")}
      data-mobile-open={mobileSidebar.value ? "true" : undefined}
    >
      <div class={styles.brand}>
        <img class={styles.logo} src="/alisio-wordmark.png" alt="Alisio" width={96} height={45} />
        <button
          type="button"
          class={`icon-btn ${styles.collapse}`}
          aria-label={t("sidebar.collapse")}
          title={t("sidebar.collapse")}
          onClick={() => {
            if (mobileSidebar.value) mobileSidebar.value = false;
            else setSidebarCollapsed(true);
          }}
        >
          <Icon name="panel" size={18} />
        </button>
      </div>
      <button type="button" class={styles.newSession} onClick={() => void newSession()}>
        <Icon name="plusCircle" size={17} />
        {t("sidebar.newSession")}
      </button>
      <AppsGroup />
      <div class={styles.sectionHead}>
        <h2 class={styles.sectionTitle}>{t("sidebar.workspaces")}</h2>
        <button
          type="button"
          class="icon-btn"
          aria-label={allClosed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
          title={allClosed ? t("sidebar.expandAll") : t("sidebar.collapseAll")}
          disabled={!!query || !shownIds.length}
          onClick={() => setFoldersOpen(shownIds, allClosed)}
        >
          <Icon name={allClosed ? "expand" : "shrink"} />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-pressed={searching}
          aria-label={t("sidebar.search")}
          title={`${t("sidebar.search")} (Ctrl+K)`}
          onClick={() => {
            if (searching) {
              setSearching(false);
              setQuery("");
            } else searchRequest.focus();
          }}
        >
          <Icon name="search" />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-pressed={archived}
          aria-label={archived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
          title={archived ? t("sidebar.hideArchived") : t("sidebar.showArchived")}
          onClick={() => setArchived(!archived)}
        >
          <Icon name="archive" />
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-pressed={adding !== "none" || picking.value}
          aria-label={t("sidebar.addWorkspace")}
          title={t("sidebar.addWorkspace")}
          disabled={picking.value}
          onClick={() => (adding !== "none" ? setAdding("none") : void openWorkspace())}
        >
          <Icon name="folderPlus" />
        </button>
      </div>
      {searching ? (
        <input
          ref={search}
          type="search"
          class={styles.field}
          placeholder={t("sidebar.search")}
          aria-label={t("sidebar.search")}
          value={query}
          onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setQuery("");
              setSearching(false);
            }
          }}
        />
      ) : null}
      {picking.value ? (
        <div class={styles.picking} role="status">
          <span class={styles.pickingDot} aria-hidden="true" />
          <span class={styles.pickingText}>
            {t("sidebar.pickWaiting")}
            {adding === "manual" ? null : (
              <button type="button" class={styles.addLink} onClick={() => setAdding("manual")}>
                {t("sidebar.typePath")}
              </button>
            )}
          </span>
        </div>
      ) : null}
      {adding === "manual" ? (
        <div class={styles.addBox}>
          <form
            class={styles.addForm}
            onSubmit={async (event) => {
              event.preventDefault();
              if (path.trim() && (await addWorkspace(path))) {
                setPath("");
                setAdding("none");
              }
            }}
          >
            <input
              class={styles.field}
              placeholder="/home/me/project"
              aria-label={t("sidebar.addWorkspacePrompt")}
              value={path}
              onInput={(event) => setPath((event.target as HTMLInputElement).value)}
            />
            <button type="submit" class={styles.addButton}>
              {t("sidebar.addWorkspaceAction")}
            </button>
          </form>
          {openMode.value === "manual" ? null : (
            <button
              type="button"
              class={styles.addLink}
              onClick={() =>
                openMode.value === "native" ? void openWorkspace() : setAdding("browser")
              }
            >
              {t("sidebar.browseFolders")}
            </button>
          )}
        </div>
      ) : null}
      {adding === "browser" && Browser ? (
        <Browser.View onClose={() => setAdding("none")} onTypePath={() => setAdding("manual")} />
      ) : null}
      <div class={styles.tree}>
        {sections.map((section) => {
          // Subgroup state shares the folder store under a `group:` key (never a workspace id).
          const key = `group:${section.id}`;
          const groupOpen = section.id === "all" || folderOpen(key, closedFolders.value, query);
          return (
            <div key={section.id} class={styles.group}>
              {section.id === "all" ? null : (
                <h3 class={styles.groupTitle}>
                  <button
                    type="button"
                    class={styles.groupToggle}
                    aria-expanded={groupOpen}
                    aria-controls={`grp-${section.id}`}
                    onClick={() => setFoldersOpen([key], !groupOpen)}
                  >
                    <Icon name={groupOpen ? "chevronDown" : "chevronRight"} size={12} />
                    {t(section.id === "pinned" ? "sidebar.pinnedGroup" : "sidebar.recentGroup")}
                  </button>
                </h3>
              )}
              {groupOpen ? (
                <div id={`grp-${section.id}`}>{section.groups.map(renderGroup)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
      {FOOTER.map(([icon, label, open], index) => (
        <button
          key={label}
          type="button"
          class={index ? `${styles.settings} ${styles.settingsBelow}` : styles.settings}
          onClick={() => {
            open.value = true;
          }}
        >
          <Icon name={icon} size={17} />
          {t(label)}
        </button>
      ))}
      {appVersion.value ? (
        <p class={styles.version} title={t("about.versionTitle", { version: appVersion.value })}>
          {t("about.version", { version: appVersion.value })}
        </p>
      ) : null}
    </nav>
  );
}
