import type { SessionSummary } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale, t } from "../../i18n/index.ts";
import {
  addWorkspace,
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
  sidebar,
} from "../../store/app.ts";
import { setSidebarCollapsed, sidebarCollapsed } from "../../store/prefs.ts";
import { groupSessions } from "../../store/sessions.ts";
import { relativeTime } from "../../util/time.ts";
import { Icon } from "../icons.tsx";
import { Menu } from "../Menu.tsx";
import { FolderBrowser } from "./FolderBrowser.tsx";
import styles from "./sidebar.module.css";

export const searchRequest = { focus: () => {} };

function SessionRow({ session }: { session: SessionSummary }) {
  const active = session.id === currentId.value;
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
export function Sidebar() {
  const [query, setQuery] = useState("");
  const [searching, setSearching] = useState(false);
  const [archived, setArchived] = useState(false);
  /** How the open-a-workspace UI is shown: nothing, the typed-path form or the folder browser. */
  const [adding, setAdding] = useState<"none" | "manual" | "browser">("none");
  const [path, setPath] = useState("");
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const search = useRef<HTMLInputElement>(null);
  // Plain render-time derivation: it depends on local state (query, archived) as well as the
  // sidebar signal, which a `useComputed` would only track for the signal.
  const groups = { value: groupSessions(sidebar.value, query, archived) };
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
    searchRequest.focus = () => {
      if (sidebarCollapsed.value) setSidebarCollapsed(false);
      setSearching(true);
      requestAnimationFrame(() => search.current?.focus());
    };
  }, []);

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
        <button
          type="button"
          class="icon-btn"
          aria-label={t("sidebar.settings")}
          title={t("sidebar.settings")}
          onClick={() => {
            settingsOpen.value = true;
          }}
        >
          <Icon name="settings" size={18} />
        </button>
      </nav>
    );

  return (
    <nav
      class={styles.sidebar}
      aria-label={t("sidebar.label")}
      data-mobile-open={mobileSidebar.value ? "true" : undefined}
    >
      <div class={styles.brand}>
        <img class={styles.logo} src="/logo-64.png" alt="Alisio" width={26} height={26} />
        <span class={styles.wordmark} aria-hidden="true">
          alisio
        </span>
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
      <div class={styles.sectionHead}>
        <h2 class={styles.sectionTitle}>{t("sidebar.workspaces")}</h2>
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
      {adding === "browser" ? (
        <FolderBrowser onClose={() => setAdding("none")} onTypePath={() => setAdding("manual")} />
      ) : null}
      <div class={styles.tree}>
        {groups.value.map((group) => {
          const open = !closed[group.workspace.id] || !!query;
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
            >
              <div class={styles.folderHead}>
                <button
                  type="button"
                  class={styles.folderToggle}
                  aria-expanded={open}
                  aria-controls={listId}
                  title={group.workspace.path}
                  onClick={() => setClosed({ ...closed, [group.workspace.id]: open })}
                >
                  <Icon name="folder" size={16} class={open ? styles.folderOpen : undefined} />
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
                      items: [
                        {
                          id: "pin",
                          label: group.workspace.pinned ? t("workspace.unpin") : t("workspace.pin"),
                        },
                        {
                          id: "archive",
                          label: archivedWs ? t("workspace.unarchive") : t("workspace.archive"),
                        },
                      ],
                      onSelect: (action) =>
                        void patchWorkspace(
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
              {open ? (
                <ul id={listId} class={styles.sessions}>
                  {group.sessions.length ? (
                    group.sessions.map((session) => (
                      <SessionRow key={session.id} session={session} />
                    ))
                  ) : (
                    <li class={styles.emptyRow}>
                      {query ? t("sidebar.noMatches", { query }) : t("sidebar.noSessions")}
                    </li>
                  )}
                </ul>
              ) : null}
            </section>
          );
        })}
      </div>
      <button
        type="button"
        class={styles.settings}
        onClick={() => {
          settingsOpen.value = true;
        }}
      >
        <Icon name="settings" size={17} />
        {t("sidebar.settings")}
      </button>
    </nav>
  );
}
