/**
 * Settings (RF-14, image2.png): left navigation (General, Models, Plugins, Skills, MCP, Agent
 * presets, Appearance) and, top right, "Open configuration file" (shows the effective paths with
 * copy buttons; the server never opens editors) and close. Loaded lazily on first open.
 */
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, settingsOpen } from "../../store/app.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon, type IconName } from "../icons.tsx";
import { AgentsPage } from "./AgentsPage.tsx";
import { AppearancePage } from "./AppearancePage.tsx";
import { GeneralPage } from "./GeneralPage.tsx";
import { McpPage } from "./McpPage.tsx";
import { PluginsPage } from "./PluginsPage.tsx";
import { SkillsPage } from "./SkillsPage.tsx";
import styles from "./settings.module.css";
import { settingsWorkspace, useLoad } from "./shared.tsx";

type Page = "general" | "plugins" | "skills" | "mcp" | "agents" | "appearance";

const PAGES: Array<{ id: Page; icon: IconName }> = [
  { id: "general", icon: "settings" },
  { id: "plugins", icon: "sliders" },
  { id: "skills", icon: "book" },
  { id: "mcp", icon: "plug" },
  { id: "agents", icon: "users" },
  { id: "appearance", icon: "palette" },
];

const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex='0']";

function ConfigFiles(props: { onClose: () => void }) {
  const workspace = settingsWorkspace();
  const overview = useLoad(workspace ? () => api.settings(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const rows = overview.data
    ? [
        { label: t("config.effective"), path: overview.data.configPath },
        { label: t("config.settings"), path: overview.data.settingsPath },
        { label: t("config.providers"), path: overview.data.providersPath },
      ]
    : [];
  return (
    <div class={styles.popover} role="dialog" aria-label={t("config.open")}>
      <div class={styles.popoverHead}>
        <strong>{t("config.open")}</strong>
        <button
          type="button"
          class="icon-btn"
          aria-label={t("common.close")}
          onClick={props.onClose}
        >
          <Icon name="x" size={16} />
        </button>
      </div>
      <p class={styles.note}>{t("config.lead")}</p>
      {!workspace ? <p class={styles.note}>{t("settings.noWorkspace")}</p> : null}
      {overview.error ? <p class={styles.errorText}>{overview.error}</p> : null}
      <ul class={styles.paths}>
        {rows.map((row) => (
          <li key={row.label}>
            <span class={styles.meta}>{row.label}</span>
            <span class={styles.pathRow}>
              <code class={styles.path}>{row.path}</code>
              <CopyButton text={() => row.path} label={t("config.copy")} />
            </span>
          </li>
        ))}
      </ul>
      {overview.data && !overview.data.trusted ? (
        <p class={styles.note}>{t("config.untrusted")}</p>
      ) : null}
    </div>
  );
}

export function SettingsModal() {
  const [page, setPage] = useState<Page>("general");
  const [files, setFiles] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("nav button")?.focus();
    return () => previous?.focus();
  }, []);
  const close = () => {
    settingsOpen.value = false;
  };
  return (
    <div
      class={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            if (files) setFiles(false);
            else close();
          }
          if (event.key === "Tab") {
            const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <nav class={styles.nav} aria-label={t("settings.title")}>
          <h2 id="settings-title" class={styles.heading}>
            {t("settings.title")}
          </h2>
          {PAGES.map(({ id, icon }) => (
            <button
              key={id}
              type="button"
              class={styles.navItem}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon name={icon} size={17} />
              {t(`settings.${id}`)}
            </button>
          ))}
        </nav>
        <div class={styles.content}>
          <div class={styles.topBar}>
            <button
              type="button"
              class={styles.outline}
              aria-expanded={files}
              onClick={() => setFiles(!files)}
            >
              {t("config.open")}
            </button>
            <button type="button" class="icon-btn" aria-label={t("common.close")} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </div>
          {files ? <ConfigFiles onClose={() => setFiles(false)} /> : null}
          {page === "general" ? (
            <GeneralPage />
          ) : page === "plugins" ? (
            <PluginsPage />
          ) : page === "skills" ? (
            <SkillsPage />
          ) : page === "mcp" ? (
            <McpPage />
          ) : page === "agents" ? (
            <AgentsPage />
          ) : (
            <AppearancePage />
          )}
        </div>
      </div>
    </div>
  );
}
