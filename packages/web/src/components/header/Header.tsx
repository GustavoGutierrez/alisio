import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import {
  agentPickerOpen,
  api,
  detail,
  mobileSidebar,
  patchCurrent,
  sessionTab,
  transcript,
} from "../../store/app.ts";
import { dockOpen, setDockOpen } from "../../store/dock.ts";
import { Icon } from "../icons.tsx";
import styles from "./header.module.css";

/** Session header (RF-10): editable title, agent/preset badge, tabs and the session log. */
export function Header() {
  const session = detail.value;
  const live = transcript.value.session;
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) input.current?.select();
  }, [editing]);
  const title = live?.title ?? session?.title ?? t("session.untitled");
  const save = () => {
    setEditing(false);
    const next = value.trim();
    if (next !== (session?.title ?? "")) void patchCurrent({ title: next || null });
  };
  return (
    <header class={styles.header}>
      <div class={styles.top}>
        <button
          type="button"
          class={`icon-btn ${styles.menu}`}
          aria-label={t("header.openSidebar")}
          onClick={() => {
            mobileSidebar.value = true;
          }}
        >
          <Icon name="menu" size={18} />
        </button>
        {session && editing ? (
          <input
            ref={input}
            class={styles.titleInput}
            aria-label={t("header.titleLabel")}
            value={value}
            maxLength={200}
            onInput={(event) => setValue((event.target as HTMLInputElement).value)}
            onBlur={save}
            onKeyDown={(event) => {
              if (event.key === "Enter") save();
              if (event.key === "Escape") setEditing(false);
            }}
          />
        ) : (
          <h1 class={styles.title}>
            {session ? (
              <button
                type="button"
                class={styles.titleButton}
                title={t("header.rename")}
                onClick={() => {
                  setValue(session.title ?? "");
                  setEditing(true);
                }}
              >
                {title}
              </button>
            ) : (
              t("app.name")
            )}
          </h1>
        )}
        {session ? (
          <button
            type="button"
            class={`${styles.badge} ${styles.badgeButton}`}
            title={t("agentsWin.activeBadge", { name: session.agent ?? "build" })}
            onClick={() => {
              agentPickerOpen.value = true;
            }}
          >
            <Icon name="shield" size={13} />
            {session.agent ?? "build"} · {t(`preset.${session.preset}`)}
          </button>
        ) : null}
        <span class={styles.spacer} />
        {session ? (
          <a
            class={styles.log}
            href={api.exportUrl(session.id)}
            download={`alisio-${session.id}.jsonl`}
            title={t("header.sessionLogHint")}
          >
            {t("header.sessionLog")}
            <Icon name="download" size={15} />
          </a>
        ) : null}
        {session ? (
          <button
            type="button"
            class="icon-btn"
            aria-pressed={dockOpen.value}
            aria-label={t("header.toggleDock")}
            title={t("header.toggleDock")}
            onClick={() => setDockOpen(!dockOpen.value)}
          >
            <Icon name="panel" size={17} />
          </button>
        ) : null}
      </div>
      {session ? (
        <div class={styles.tabs} role="tablist" aria-label={t("header.titleLabel")}>
          {(["conversation", "trajectory"] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={sessionTab.value === tab}
              class={styles.tab}
              onClick={() => {
                sessionTab.value = tab;
              }}
            >
              {t(`header.${tab}`)}
            </button>
          ))}
        </div>
      ) : null}
    </header>
  );
}
