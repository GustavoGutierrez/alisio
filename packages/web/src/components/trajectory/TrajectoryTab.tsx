import { useComputed } from "@preact/signals";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { currentId, eventsTick } from "../../store/app.ts";
import { trajectoryFeed } from "../../store/events.ts";
import { formatSeconds } from "../../store/stats.ts";
import { executionTimeline, type TrajectoryRun, trajectory } from "../../store/trajectory.ts";
import { TimelineView } from "./TimelineView.tsx";
import styles from "./trajectory.module.css";

/** Runs shown before "Show earlier runs" (the feed itself loads in pages from `/events`). */
const RUN_WINDOW = 20;

const time = (at: number) =>
  at ? new Date(at).toLocaleTimeString(undefined, { hour12: false }) : "—";

function Run({ run, open }: { run: TrajectoryRun; open: boolean }) {
  return (
    <details class={styles.run} open={open}>
      <summary class={styles.runHead}>
        <span class={styles.status} data-status={run.status}>
          {t(`trajectory.status.${run.status}`)}
        </span>
        <span class={styles.runId} title={run.runId}>
          {run.runId.slice(0, 8)}
        </span>
        <span>{time(run.startedAt)}</span>
        <span>{t(run.turns === 1 ? "stats.turn" : "stats.turns", { count: run.turns })}</span>
        <span class={styles.duration}>{formatSeconds(run.durationMs)}</span>
      </summary>
      <table class={styles.table}>
        <thead>
          <tr>
            <th scope="col" class={styles.colTime}>
              {t("trajectory.time")}
            </th>
            <th scope="col" class={styles.colTurn}>
              {t("trajectory.turn")}
            </th>
            <th scope="col" class={styles.colType}>
              {t("trajectory.type")}
            </th>
            <th scope="col">{t("trajectory.summary")}</th>
            <th scope="col" class={`${styles.num} ${styles.colDuration}`}>
              {t("trajectory.duration")}
            </th>
          </tr>
        </thead>
        <tbody>
          {run.rows.map((row) => (
            <tr key={row.eventId} data-error={row.error ? "true" : undefined}>
              <td class={styles.mono}>{time(row.at)}</td>
              <td class={styles.num}>{row.turn ?? ""}</td>
              <td class={`${styles.mono} ${styles.summary}`} title={row.type}>
                {row.type}
              </td>
              <td class={styles.summary} title={row.summary}>
                {row.summary}
              </td>
              <td class={`${styles.num} ${styles.mono}`}>
                {row.durationMs !== undefined ? formatSeconds(row.durationMs) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Flat timeline of the session's durable events grouped by run (RF-10). */
export function TrajectoryTab() {
  const id = currentId.value;
  const [all, setAll] = useState(false);
  const [view, setView] = useState<"table" | "timeline">("table");
  useEffect(() => {
    void trajectoryFeed.sync();
  }, [id, eventsTick.value]);
  const feed = trajectoryFeed.state.value;
  const runs = useComputed(() => trajectory(trajectoryFeed.state.value.items));
  const timeline = useComputed(() => executionTimeline(trajectoryFeed.state.value.items));
  const list = runs.value;
  const shown = all ? list : list.slice(-RUN_WINDOW);
  return (
    <section class={styles.tab} aria-label={t("header.trajectory")}>
      {list.length ? (
        <div class={styles.viewToggle} role="group" aria-label={t("trajectory.view")}>
          <button
            type="button"
            class={styles.viewButton}
            aria-pressed={view === "table"}
            data-active={view === "table" ? "true" : undefined}
            onClick={() => setView("table")}
          >
            {t("trajectory.view.table")}
          </button>
          <button
            type="button"
            class={styles.viewButton}
            aria-pressed={view === "timeline"}
            data-active={view === "timeline" ? "true" : undefined}
            onClick={() => setView("timeline")}
          >
            {t("trajectory.view.timeline")}
          </button>
        </div>
      ) : null}
      {feed.error ? <p class={styles.error}>{feed.error}</p> : null}
      {!list.length ? (
        <p class={styles.empty}>
          {feed.loading || !feed.loaded ? t("common.loading") : t("trajectory.empty")}
        </p>
      ) : null}
      {view === "timeline" && timeline.value ? (
        <TimelineView timeline={timeline.value} />
      ) : (
        <>
          {shown.length < list.length ? (
            <button type="button" class={styles.more} onClick={() => setAll(true)}>
              {t("trajectory.earlier", { count: list.length - shown.length })}
            </button>
          ) : null}
          {shown.map((run, i) => (
            <Run key={run.runId} run={run} open={i === shown.length - 1} />
          ))}
        </>
      )}
    </section>
  );
}
