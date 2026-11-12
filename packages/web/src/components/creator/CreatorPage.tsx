/**
 * The plugin creator page (lazy chunk), shown in place of the chat like a plugin app: "My plugins"
 * on one side, and either the new-request panel or the project on screen on the other. The chat
 * stays mounted (hidden and inert) behind it.
 */
import { useEffect, useRef } from "preact/hooks";
import { api } from "../../store/app.ts";
import { creatorOpen } from "../../store/plugin-apps-state.ts";
import { useOverlayScrollbars } from "../../util/scrollbars.ts";
import { Icon } from "../icons.tsx";
import { settingsWorkspace } from "../settings/shared.tsx";
import styles from "./creator.module.css";
import { NewRequest } from "./NewRequest.tsx";
import { ProjectList } from "./ProjectList.tsx";
import { ProjectView } from "./ProjectView.tsx";
import {
  attach,
  loadProjects,
  POLL_MS,
  readOnly,
  refreshProject,
  running,
  selected,
  selectedId,
  startedAt,
} from "./store.ts";
import { cr } from "./strings.ts";

/** How long after a start the page keeps polling before the session reports it is running. */
const START_GRACE_MS = 20_000;

export function CreatorPage() {
  const workspace = settingsWorkspace();
  const scroll = useRef<HTMLDivElement>(null);
  useOverlayScrollbars(scroll);
  useEffect(() => {
    const detach = attach();
    void loadProjects();
    return detach;
  }, []);

  // Read-only servers refuse every mutation: say so up front and disable the actions.
  useEffect(() => {
    if (!workspace) return;
    void api
      .settings(workspace.id)
      .then((overview) => {
        readOnly.value = overview.readOnly;
      })
      .catch(() => {});
  }, [workspace?.id]);

  // While a run is going on, refresh the project: the agent reports its steps there.
  const id = selectedId.value;
  const active = running.value;
  const started = startedAt.value;
  useEffect(() => {
    if (!id) return;
    const live = () => running.peek() || Date.now() - (startedAt.peek() ?? 0) < START_GRACE_MS;
    if (!live()) return;
    const timer = setInterval(() => {
      if (live()) void refreshProject(id);
    }, POLL_MS);
    return () => {
      clearInterval(timer);
      // One last refresh when the run ends: final steps, build stats and version.
      void refreshProject(id);
    };
  }, [id, active, started]);

  const entry = selected.value;
  return (
    <section class={styles.page} aria-labelledby="creator-title">
      <div class={styles.bar}>
        <button
          type="button"
          class={styles.ghost}
          onClick={() => {
            creatorOpen.value = false;
          }}
        >
          <Icon name="arrowLeft" size={16} />
          {cr("back")}
        </button>
      </div>
      <div ref={scroll} class={styles.scroll}>
        <div class={styles.inner}>
          <header class={styles.hero}>
            <span class={styles.heroIcon} aria-hidden="true">
              <Icon name="wand" size={24} />
            </span>
            <div>
              <h1 id="creator-title">{cr("title")}</h1>
              <p class={styles.lead}>{cr("lead")}</p>
            </div>
          </header>
          {readOnly.value ? (
            <p class={styles.callout} data-tone="warn" role="note">
              <Icon name="lock" size={16} />
              <span>{cr("readOnly")}</span>
            </p>
          ) : null}
          <div class={styles.layout}>
            <ProjectList />
            <div>
              {entry ? (
                <ProjectView key={entry.project.id} entry={entry} workspace={workspace?.id} />
              ) : (
                <NewRequest workspace={workspace?.id} />
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
