import type { FileEntry } from "@alisio/sdk";
import type { ComponentType } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { Markdown } from "../../markdown/view.tsx";
import CodeView from "../../renderers/code/view.tsx";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import { currentId, detail, insertIntoComposer, runEnded, showToast } from "../../store/app.ts";
import {
  changes,
  closeFileMenu,
  type DockTab,
  dirs,
  dockTab,
  downloadUrl,
  expanded,
  fileMenu,
  liveTasks,
  loadChanges,
  loadDir,
  openFileMenu,
  openInDock,
  preview,
  refreshTree,
  setDockOpen,
  toggleDir,
} from "../../store/dock.ts";
import { copyText } from "../../util/clipboard.ts";
import { absolutePath, extensionOf, fileName } from "../../util/files.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import styles from "./dock.module.css";

const TABS: DockTab[] = ["files", "changes", "preview", "tasks"];

/** The Tasks tab is its own chunk (the initial bundle has a size budget). */
function LazyTasks() {
  const [View, setView] = useState<ComponentType | undefined>();
  useEffect(() => {
    let alive = true;
    void import("../tasks/TasksTab.tsx").then((m) => {
      if (alive) setView(() => m.TasksTab);
    });
    return () => {
      alive = false;
    };
  }, []);
  return View ? <View /> : <p class={styles.empty}>{t("common.loading")}</p>;
}

function Dir({ path, depth }: { path: string; depth: number }) {
  const state = dirs.value[path];
  if (!state) return null;
  if (state.error) return <p class={styles.error}>{state.error}</p>;
  return (
    <ul
      class={styles.tree}
      role={depth ? "group" : "tree"}
      aria-label={depth ? undefined : t("dock.files")}
    >
      {state.entries.map((entry) => (
        <Entry key={entry.path} entry={entry} depth={depth} />
      ))}
      {state.loading ? <li class={styles.muted}>{t("common.loading")}</li> : null}
      {state.next && !state.loading ? (
        <li>
          <button type="button" class={styles.more} onClick={() => void loadDir(path, true)}>
            {t("dock.more")}
          </button>
        </li>
      ) : null}
    </ul>
  );
}

function Entry({ entry, depth }: { entry: FileEntry; depth: number }) {
  const open = expanded.value.has(entry.path);
  const selected = preview.value?.path === entry.path;
  const indent = { paddingLeft: `${8 + depth * 14}px` };
  if (entry.type === "dir")
    return (
      <li role="treeitem" aria-expanded={open}>
        <button
          type="button"
          class={styles.row}
          style={indent}
          onClick={() => toggleDir(entry.path)}
        >
          <Icon name={open ? "chevronDown" : "chevronRight"} size={13} />
          <Icon name="folder" size={14} />
          <span class={styles.name}>{entry.name}</span>
        </button>
        {open ? <Dir path={entry.path} depth={depth + 1} /> : null}
      </li>
    );
  return (
    <li
      role="treeitem"
      aria-selected={selected}
      onContextMenu={(event) => openFileMenu(event, entry.path)}
    >
      <button
        type="button"
        class={styles.row}
        style={indent}
        data-selected={selected ? "true" : undefined}
        disabled={entry.type !== "file"}
        title={entry.type === "symlink" ? t("dock.symlink") : entry.path}
        onClick={() => void openInDock(entry.path)}
      >
        <span class={styles.spacer13} />
        <Icon name={entry.type === "symlink" ? "layers" : "file"} size={14} />
        <span class={styles.name}>{entry.name}</span>
      </button>
    </li>
  );
}

function ChangesTab() {
  const state = changes.value;
  if (state.error) return <p class={styles.error}>{state.error}</p>;
  if (!state.files.length)
    return <p class={styles.empty}>{state.loading ? t("common.loading") : t("dock.noChanges")}</p>;
  return (
    <ul class={styles.list}>
      {state.files.map((file) => (
        <li key={file.path}>
          <button
            type="button"
            class={styles.row}
            onContextMenu={(event) => openFileMenu(event, file.path)}
            onClick={() => void openInDock(file.path, { diff: true })}
          >
            <span
              class={styles.badge}
              data-status={file.gitStatus ?? "session"}
              title={t("dock.gitStatus")}
            >
              {file.gitStatus ?? "•"}
            </span>
            <span class={styles.name}>{file.path}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function PreviewBody() {
  const [htmlMode, setHtmlMode] = useState<"rendered" | "source">("rendered");
  const state = preview.value;
  if (!state) return <p class={styles.empty}>{t("dock.noPreview")}</p>;
  if (state.status === "loading") return <p class={styles.empty}>{t("common.loading")}</p>;
  if (state.status === "error") return <p class={styles.error}>{state.error}</p>;
  const download = downloadUrl(state.path);
  return (
    <div class={styles.previewBody}>
      {state.diff ? <RendererHost block={state.diff} /> : null}
      {state.truncated ? (
        <p class={styles.notice}>
          {t("dock.truncated", { size: Math.round(state.size / 1024).toLocaleString() })}{" "}
          {download ? <a href={download}>{t("dock.download")}</a> : null}
        </p>
      ) : null}
      {state.kind === "pdf" && state.url ? (
        <iframe class={styles.frame} src={state.url} title={state.path} />
      ) : state.kind === "html" && state.text !== undefined ? (
        <>
          <div class={styles.viewToggle} role="group" aria-label={t("dock.htmlView")}>
            <button
              type="button"
              class={styles.viewButton}
              aria-pressed={htmlMode === "rendered"}
              data-active={htmlMode === "rendered" ? "true" : undefined}
              onClick={() => setHtmlMode("rendered")}
            >
              {t("dock.viewRendered")}
            </button>
            <button
              type="button"
              class={styles.viewButton}
              aria-pressed={htmlMode === "source"}
              data-active={htmlMode === "source" ? "true" : undefined}
              onClick={() => setHtmlMode("source")}
            >
              {t("dock.viewSource")}
            </button>
          </div>
          {htmlMode === "rendered" ? (
            // No scripts and an opaque origin: workspace HTML renders without touching the app.
            <iframe class={styles.frame} sandbox="" srcdoc={state.text} title={state.path} />
          ) : (
            <CodeView block={{ kind: "code", lang: "html", code: state.text }} />
          )}
        </>
      ) : state.kind === "image" && state.url ? (
        <img class={styles.image} src={state.url} alt={state.path} />
      ) : state.kind === "markdown" && state.text !== undefined ? (
        <div class={styles.markdown}>
          <Markdown text={state.text} />
        </div>
      ) : state.kind === "json" &&
        state.text !== undefined &&
        !state.truncated &&
        jsonOf(state.text) !== undefined ? (
        <RendererHost block={{ kind: "json", value: jsonOf(state.text), collapsedDepth: 2 }} />
      ) : state.text !== undefined ? (
        <CodeView
          block={{ kind: "code", lang: extensionOf(state.path) || "text", code: state.text }}
        />
      ) : !state.diff ? (
        <p class={styles.empty}>
          {t("dock.binary")} {download ? <a href={download}>{t("dock.download")}</a> : null}
        </p>
      ) : null}
    </div>
  );
}

const jsonCache = new Map<string, unknown>();
function jsonOf(text: string): unknown {
  if (jsonCache.has(text)) return jsonCache.get(text);
  let value: unknown;
  try {
    value = text.length <= 256 * 1024 ? JSON.parse(text) : undefined;
  } catch {
    value = undefined;
  }
  jsonCache.clear();
  jsonCache.set(text, value);
  return value;
}

/** Right-click menu of a file: copy its absolute path, its relative path or its name. */
function FileMenu() {
  const menu = fileMenu.value;
  const root = useRef<HTMLUListElement>(null);
  useEffect(() => {
    if (!menu) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && root.current?.contains(event.target as Node)) return;
      closeFileMenu();
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, [menu]);
  if (!menu) return null;
  const workspace = detail.value?.workspace;
  const items: Array<{ label: string; text: string }> = [
    { label: t("dock.copyAbsolute"), text: absolutePath(workspace, menu.path) ?? menu.path },
    { label: t("dock.copyRelative"), text: menu.path },
    { label: t("dock.copyName"), text: fileName(menu.path) },
  ];
  // Keep the menu inside the viewport when it opens near an edge.
  const left = typeof window === "undefined" ? menu.x : Math.min(menu.x, window.innerWidth - 220);
  const top = typeof window === "undefined" ? menu.y : Math.min(menu.y, window.innerHeight - 120);
  return (
    <ul ref={root} class={styles.menu} role="menu" style={{ left: `${left}px`, top: `${top}px` }}>
      {items.map((item) => (
        <li key={item.label}>
          <button
            type="button"
            role="menuitem"
            class={styles.menuItem}
            onClick={async () => {
              closeFileMenu();
              if (await copyText(item.text)) showToast(t("common.copied"));
            }}
          >
            {item.label}
          </button>
        </li>
      ))}
    </ul>
  );
}

/** The right dock (RF-12): Files, Changes and Preview of the open session's workspace. */
/** `width`: the shared right-slot width (px) when the Dock sits beside the chat. */
export function Dock(props: { width?: number } = {}) {
  const session = detail.value;
  const tab = dockTab.value;
  const state = preview.value;
  useEffect(() => {
    if (session?.workspaceId) void loadDir("");
  }, [session?.workspaceId]);
  useEffect(() => {
    if (tab === "changes") void loadChanges();
  }, [tab, currentId.value]);
  useEffect(() => {
    if (!runEnded.value) return;
    refreshTree();
    if (dockTab.value === "changes") void loadChanges();
  }, [runEnded.value]);
  return (
    <aside
      id="dock-panel"
      class={styles.dock}
      aria-label={t("dock.label")}
      style={props.width ? { width: `${props.width}px` } : undefined}
    >
      <div class={styles.head}>
        <div class={styles.tabs} role="tablist">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              class={styles.tab}
              onClick={() => {
                dockTab.value = id;
              }}
            >
              {t(`dock.${id}`)}
              {id === "tasks" && liveTasks.value ? (
                <span class={styles.count} title={t("dock.tasksLive", { count: liveTasks.value })}>
                  {liveTasks.value}
                </span>
              ) : null}
            </button>
          ))}
        </div>
        <button
          type="button"
          class="icon-btn"
          aria-label={t("dock.close")}
          title={t("dock.close")}
          onClick={() => setDockOpen(false)}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      {tab === "preview" && state ? (
        <div class={styles.pathBar}>
          <span class={styles.path} title={state.path}>
            {state.path || "/"}
          </span>
          <CopyButton text={() => state.path} label={t("dock.copyPath")} />
          <button
            type="button"
            class="icon-btn"
            aria-label={t("dock.mention")}
            title={t("dock.mention")}
            onClick={() => insertIntoComposer(`@${state.path} `)}
          >
            <Icon name="plus" size={15} />
          </button>
          {downloadUrl(state.path) ? (
            <a
              class="icon-btn"
              href={downloadUrl(state.path)}
              aria-label={t("dock.download")}
              title={t("dock.download")}
            >
              <Icon name="download" size={15} />
            </a>
          ) : null}
        </div>
      ) : null}
      <div class={styles.body} role="tabpanel">
        {!session ? (
          <p class={styles.empty}>{t("dock.noSession")}</p>
        ) : tab === "files" ? (
          <Dir path="" depth={0} />
        ) : tab === "changes" ? (
          <ChangesTab />
        ) : tab === "tasks" ? (
          <LazyTasks />
        ) : (
          <PreviewBody />
        )}
      </div>
      <FileMenu />
    </aside>
  );
}
