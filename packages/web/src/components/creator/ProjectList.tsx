/** "My plugins": one card per creator project, or a friendly empty state with example requests. */
import type { PluginCreatorProjectEntry } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { Icon } from "../icons.tsx";
import styles from "./creator.module.css";
import { type Badge, displayVersion, statusBadge } from "./model.ts";
import { iconUrl, prefill, projects, running, select, selectedId } from "./store.ts";
import { type CrKey, cr } from "./strings.ts";

const BADGE_KEYS: Record<Badge, CrKey> = {
  building: "badgeBuilding",
  installed: "badgeInstalled",
  update: "badgeUpdate",
  notInstalled: "badgeNotInstalled",
  failed: "badgeFailed",
};

export function StatusBadge({ badge }: { badge: Badge }) {
  return (
    <span class={styles.badge} data-badge={badge}>
      {cr(BADGE_KEYS[badge])}
    </span>
  );
}

/** The plugin's own icon when it has a usable one, else a generic puzzle piece. */
export function ProjectIcon({ entry }: { entry: PluginCreatorProjectEntry }) {
  const [failed, setFailed] = useState(false);
  const { project } = entry;
  return (
    <span class={styles.projectIcon} aria-hidden="true">
      {project.icon && !failed ? (
        <img
          src={iconUrl(project.id, `${project.version}-${project.updatedAt}`)}
          alt=""
          width={40}
          height={40}
          onError={() => setFailed(true)}
        />
      ) : (
        <Icon name="puzzle" size={20} />
      )}
    </span>
  );
}

const EXAMPLES: CrKey[] = ["example1", "example2", "example3"];

export function ProjectList() {
  const state = projects.value;
  return (
    <aside aria-labelledby="creator-list-title">
      <div class={styles.listHead}>
        <h2 id="creator-list-title">{cr("listTitle")}</h2>
        {state.items.length ? (
          <button
            type="button"
            class={styles.ghost}
            aria-pressed={!selectedId.value}
            onClick={() => select(undefined)}
          >
            <Icon name="plus" size={15} />
            {cr("newPlugin")}
          </button>
        ) : null}
      </div>
      {state.loading ? (
        <div role="status" aria-label={cr("listLoading")}>
          <div class={styles.skeleton} />
          <div class={styles.skeleton} />
        </div>
      ) : state.error && !state.items.length ? (
        <p class={styles.callout} data-tone="danger" role="alert">
          <Icon name="alert" size={16} />
          <span>{cr("listFailed", { message: state.error })}</span>
        </p>
      ) : !state.items.length ? (
        <div class={styles.empty}>
          <span class={styles.emptyArt} aria-hidden="true">
            <Icon name="puzzle" size={30} />
          </span>
          <h3>{cr("emptyTitle")}</h3>
          <p>{cr("emptyBody")}</p>
          <p class={styles.emptyExamples}>{cr("examplesTitle")}</p>
          <ul class={`${styles.examples} ${styles.centered}`}>
            {EXAMPLES.map((key) => (
              <li key={key}>
                <button type="button" class={styles.example} onClick={() => prefill(cr(key))}>
                  <Icon name="sparkle" size={14} />
                  {cr(key)}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ul class={styles.projects}>
          {state.items.map((entry) => {
            const current = entry.project.id === selectedId.value;
            const badge = statusBadge(entry, current && !!entry.project.sessionId && running.value);
            return (
              <li key={entry.project.id}>
                <button
                  type="button"
                  class={styles.projectCard}
                  aria-current={current ? "true" : undefined}
                  onClick={() => select(entry.project.id)}
                >
                  <ProjectIcon entry={entry} />
                  <span class={styles.projectMeta}>
                    <span class={styles.projectName}>{entry.project.displayName}</span>
                    <span class={styles.projectLine}>
                      <span>{cr("version", { version: displayVersion(entry) })}</span>
                      <StatusBadge badge={badge} />
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </aside>
  );
}
