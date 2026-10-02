import type { BackgroundTaskInfo } from "@alisio/sdk";
import { useEffect, useState } from "preact/hooks";
import { RendererHost } from "../../renderers/RendererHost.tsx";
import { currentId } from "../../store/app.ts";
import { formatSeconds } from "../../store/stats.ts";
import {
  isLiveTask,
  leaveTasks,
  loadTasks,
  outputState,
  selectedTask,
  selectTask,
  stopping,
  stopTask,
  tasksState,
} from "../../store/tasks.ts";
import { tk } from "./strings.ts";
import styles from "./tasks.module.css";

/** How long a task ran (live tasks count up to now). */
const duration = (task: BackgroundTaskInfo, now: number): number | undefined =>
  task.startedAt ? Math.max(0, (task.endedAt ?? now) - task.startedAt) : undefined;

function Status({ task }: { task: BackgroundTaskInfo }) {
  return (
    <span class={styles.status} data-status={task.status}>
      {tk(`status.${task.status}`)}
    </span>
  );
}

function stopNote(task: BackgroundTaskInfo): string | undefined {
  if (task.errorCode === "timeout") return tk("timeout");
  if (task.status === "cancelled" && task.abortOrigin)
    return tk("stoppedBy", { who: tk(`who.${task.abortOrigin}`) });
  if (task.status === "lost") return tk("lostHint");
  return undefined;
}

function Row({ task, now }: { task: BackgroundTaskInfo; now: number }) {
  const ran = duration(task, now);
  return (
    <li>
      <button type="button" class={styles.row} onClick={() => selectTask(task.id)}>
        <span class={styles.rowTop}>
          <span class={styles.label} title={task.label}>
            {task.label}
          </span>
          <Status task={task} />
        </span>
        <span class={styles.meta}>
          <span>{tk(`kind.${task.kind}`)}</span>
          {ran !== undefined ? <span>{formatSeconds(ran)}</span> : null}
          {task.kind === "shell" ? (
            <span>{tk("bytes", { size: Math.max(1, Math.round(task.bytes / 1024)) })}</span>
          ) : null}
        </span>
      </button>
    </li>
  );
}

function Detail({ task, now }: { task: BackgroundTaskInfo; now: number }) {
  const out = outputState.value;
  const busy = stopping.value.has(task.id) || task.status === "stopping";
  const live = isLiveTask(task);
  const note = stopNote(task);
  const ran = duration(task, now);
  return (
    <div class={styles.detail}>
      <div class={styles.detailHead}>
        <button type="button" class={styles.back} onClick={() => selectTask(undefined)}>
          <span aria-hidden="true">←</span>
          {tk("back")}
        </button>
        {task.kind === "shell" && live ? (
          <button
            type="button"
            class={styles.stop}
            disabled={busy}
            onClick={() => void stopTask(task.id)}
          >
            {busy ? tk("stopping") : tk("stop")}
          </button>
        ) : null}
      </div>
      <div class={styles.titleRow}>
        <h3 class={styles.detailTitle}>{task.label}</h3>
        <Status task={task} />
      </div>
      <dl class={styles.facts}>
        {task.command ? (
          <>
            <dt>{tk("command")}</dt>
            <dd>
              <code>{task.command}</code>
            </dd>
          </>
        ) : null}
        {task.kind === "shell" && task.cwd ? (
          <>
            <dt>{tk("directory")}</dt>
            <dd>
              <code>{task.cwd}</code>
            </dd>
          </>
        ) : null}
        {ran !== undefined ? (
          <>
            <dt>{tk("time")}</dt>
            <dd>{formatSeconds(ran)}</dd>
          </>
        ) : null}
      </dl>
      {note ? <p class={styles.note}>{note}</p> : null}
      {task.kind === "subagent" ? <p class={styles.note}>{tk("subagentHint")}</p> : null}
      {task.kind === "shell" ? (
        <>
          {out?.error ? <p class={styles.error}>{out.error}</p> : null}
          {out?.loading ? <p class={styles.muted}>{tk("loading")}</p> : null}
          {out && !out.loading && !out.text && !live ? (
            <p class={styles.muted}>{tk("noOutput")}</p>
          ) : (
            <RendererHost
              block={{
                kind: "terminal",
                output: out?.text ?? "",
                ...(task.command ? { command: task.command } : {}),
                ...(task.exitCode !== undefined && !live ? { exitCode: task.exitCode } : {}),
                ...(task.truncated || out?.trimmed ? { truncated: true } : {}),
              }}
              live={live}
            />
          )}
          {out?.trimmed ? <p class={styles.muted}>{tk("outputTrimmed")}</p> : null}
          {task.truncated ? <p class={styles.muted}>{tk("outputCut")}</p> : null}
        </>
      ) : null}
    </div>
  );
}

/** The Dock's Tasks tab: the session's background tasks, live output and the Stop button. */
export function TasksTab() {
  const id = currentId.value;
  const state = tasksState.value;
  const [now, setNow] = useState(Date.now());
  const selected = selectedTask.value
    ? state.items.find((item) => item.id === selectedTask.value)
    : undefined;
  useEffect(() => {
    if (id && state.sessionId !== id) void loadTasks(id);
  }, [id, state.sessionId]);
  // The tab closed: stop following the output.
  useEffect(() => leaveTasks, []);
  const anyLive = state.items.some(isLiveTask);
  useEffect(() => {
    if (!anyLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [anyLive]);
  if (selected) return <Detail task={selected} now={now} />;
  return (
    <div class={styles.tab}>
      <p class={styles.lead}>{tk("lead")}</p>
      {state.error ? (
        <p class={styles.error}>
          {tk("loadFailed")}{" "}
          <button type="button" class={styles.link} onClick={() => id && void loadTasks(id)}>
            {tk("retry")}
          </button>
        </p>
      ) : null}
      {state.loading && !state.items.length ? <p class={styles.muted}>{tk("loading")}</p> : null}
      {!state.loading && !state.error && !state.items.length ? (
        <p class={styles.muted}>{tk("empty")}</p>
      ) : null}
      <ul class={styles.list} aria-label={tk("title")}>
        {state.items.map((task) => (
          <Row key={task.id} task={task} now={now} />
        ))}
      </ul>
    </div>
  );
}
