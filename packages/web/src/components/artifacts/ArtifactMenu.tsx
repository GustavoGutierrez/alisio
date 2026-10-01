import type { ArtifactRef } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { ARTIFACT_ICONS } from "../../util/artifacts.ts";
import { filterArtifacts } from "../../util/panel.ts";
import { Icon, type IconName } from "../icons.tsx";
import styles from "./panel.module.css";

export interface MenuAction {
  key: string;
  label: string;
  icon?: IconName;
  /** A link (downloads) instead of a button. */
  href?: string;
  download?: boolean;
  danger?: boolean;
  onSelect?: () => void;
}

const kindLabel = (artifact: ArtifactRef) =>
  `${t(`artifact.kind.${artifact.kind}` as Parameters<typeof t>[0])}${
    artifact.status === "expired" ? ` · ${t("artifact.expired")}` : ""
  }`;

/**
 * The title's popup (spec §15.3): the session's artifacts as a listbox (newest first, the current
 * one selected, a filter above 8 entries, arrows/Enter/Esc and type-to-jump, a "new" dot for
 * artifacts published while the panel was open), then the secondary actions.
 */
export function ArtifactMenu(props: {
  id: string;
  list: ArtifactRef[];
  current?: string;
  unseen: Set<string>;
  initialFilter?: string;
  actions: MenuAction[];
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState(props.initialFilter ?? "");
  const shown = filterArtifacts(
    // Expired artifacts stay listed (dimmed): choosing one offers Details and Run again.
    props.list.filter((artifact) => artifact.status === "ready" || artifact.status === "expired"),
    filter,
  );
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      shown.findIndex((artifact) => artifact.id === props.current),
    ),
  );
  const listRef = useRef<HTMLUListElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: "", at: 0 });
  const withFilter = props.list.length > 8 || !!props.initialFilter;
  useEffect(() => {
    (withFilter ? filterRef.current : listRef.current)?.focus();
  }, [withFilter]);
  useEffect(() => {
    if (active >= shown.length) setActive(Math.max(0, shown.length - 1));
  }, [shown.length, active]);
  const optionId = (index: number) => `${props.id}-opt-${index}`;
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      props.onClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setActive((index) => Math.min(shown.length - 1, Math.max(0, index + delta)));
      return;
    }
    if (event.key === "Enter") {
      const chosen = shown[active];
      if (chosen) {
        event.preventDefault();
        props.onPick(chosen.id);
      }
      return;
    }
    // Type to jump (only when typing is not filtering).
    if (event.target !== filterRef.current && event.key.length === 1 && !event.ctrlKey) {
      const now = Date.now();
      typed.current = {
        text: (now - typed.current.at < 700 ? typed.current.text : "") + event.key.toLowerCase(),
        at: now,
      };
      const found = shown.findIndex((artifact) =>
        artifact.fileName.toLowerCase().startsWith(typed.current.text),
      );
      if (found >= 0) setActive(found);
    }
  };
  return (
    <div class={styles.popup} onKeyDown={onKeyDown}>
      {withFilter ? (
        <input
          ref={filterRef}
          class={styles.filter}
          type="search"
          value={filter}
          placeholder={t("artifactPanel.filter")}
          aria-label={t("artifactPanel.filter")}
          aria-controls={`${props.id}-list`}
          aria-activedescendant={shown.length ? optionId(active) : undefined}
          onInput={(event) => {
            setFilter((event.currentTarget as HTMLInputElement).value);
            setActive(0);
          }}
        />
      ) : null}
      <ul
        ref={listRef}
        id={`${props.id}-list`}
        class={styles.listbox}
        role="listbox"
        aria-label={t("artifactPanel.switch")}
        tabIndex={0}
        aria-activedescendant={shown.length ? optionId(active) : undefined}
      >
        {shown.length ? (
          shown.map((artifact, index) => (
            <li
              key={artifact.id}
              id={optionId(index)}
              role="option"
              class={styles.option}
              aria-selected={artifact.id === props.current}
              data-active={index === active ? "true" : undefined}
              onClick={() => props.onPick(artifact.id)}
              onMouseMove={() => setActive(index)}
            >
              <Icon name={ARTIFACT_ICONS[artifact.kind] as IconName} size={16} />
              <span class={styles.optionName} title={artifact.fileName}>
                {artifact.title !== artifact.fileName ? artifact.title : artifact.fileName}
                {props.unseen.has(artifact.id) ? (
                  <span class={styles.dot} role="img" aria-label={t("artifactPanel.new")} />
                ) : null}
              </span>
              <span class={styles.optionKind}>{kindLabel(artifact)}</span>
            </li>
          ))
        ) : (
          <li class={styles.muted}>
            {props.list.length ? t("artifactPanel.noMatch") : t("artifactPanel.empty")}
          </li>
        )}
      </ul>
      {props.actions.length ? (
        <div class={styles.menu}>
          {props.actions.map((action) =>
            action.href ? (
              <a
                key={action.key}
                class={styles.action}
                href={action.href}
                {...(action.download ? { download: "" } : {})}
                onClick={() => props.onClose()}
              >
                {action.icon ? <Icon name={action.icon} size={15} /> : null}
                {action.label}
              </a>
            ) : (
              <button
                key={action.key}
                type="button"
                class={`${styles.action}${action.danger ? ` ${styles.danger}` : ""}`}
                onClick={() => action.onSelect?.()}
              >
                {action.icon ? <Icon name={action.icon} size={15} /> : null}
                {action.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </div>
  );
}
