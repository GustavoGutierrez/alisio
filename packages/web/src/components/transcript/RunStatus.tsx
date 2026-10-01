import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { cancelRun, runProgress } from "../../store/app.ts";
import {
  describePhase,
  formatClock,
  type Phase,
  type RunProgress,
  STALL_QUIET_MS,
  STALL_STALLED_MS,
  stallOf,
} from "../../store/progress.ts";
import { toolLabel } from "../../util/tools.ts";
import styles from "./transcript.module.css";

/** A clock that ticks once a second while `active`; the only timer of the indicator. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/** The phase as one sentence, with the tool's own name and a short argument when it has one. */
export function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case "waiting":
      return t("run.phase.waiting");
    case "thinking":
      return t("run.phase.thinking");
    case "writing":
      return t("run.phase.writing");
    case "compacting":
      return t("run.phase.compacting");
    case "approval":
      return t("run.phase.approval", { name: toolLabel(phase.name) });
    case "tool": {
      const detail = phase.summary;
      switch (phase.category) {
        case "python":
          return detail ? t("run.phase.pythonWith", { detail }) : t("run.phase.python");
        case "data":
          return detail ? t("run.phase.dataWith", { detail }) : t("run.phase.data");
        case "artifact":
          return detail ? t("run.phase.artifactWith", { detail }) : t("run.phase.artifact");
        case "question":
          return t("run.phase.question");
        case "agent":
          return t("run.phase.agent");
        default: {
          const name = toolLabel(phase.name);
          return detail ? t("run.phase.toolWith", { name, detail }) : t("run.phase.tool", { name });
        }
      }
    }
  }
}

function stallMessage(phase: Phase, level: "quiet" | "stalled", seconds: number): string {
  if (phase.kind === "tool")
    return t(level === "stalled" ? "run.stalled.tool" : "run.quiet.tool", {
      name: toolLabel(phase.name),
      seconds,
    });
  return t(level === "stalled" ? "run.stalled.model" : "run.quiet.model", { seconds });
}

/**
 * The live run's status line: what the run is really doing, how long it has been going, when
 * anything last arrived and, once it goes quiet, an honest "no response for N s" with Stop. It
 * only reads frames the client received (see `store/progress.ts`); it never fakes activity.
 */
export function RunStatus() {
  const progress = runProgress.value;
  const now = useNow(progress !== undefined);
  if (!progress) return null;
  return <RunStatusLine progress={progress} now={now} />;
}

function RunStatusLine({ progress, now }: { progress: RunProgress; now: number }) {
  const [stopped, setStopped] = useState<string | undefined>(undefined);
  const phase = describePhase(progress);
  const label = phaseLabel(phase);
  const stall = stallOf(progress, now);
  const idleSeconds = Math.floor(stall.idleMs / 1000);
  // The live region changes only when the phase or the stall level does, never every second.
  const announce =
    stall.level === "none"
      ? label
      : `${label} ${t(stall.level === "stalled" ? "run.announce.stalled" : "run.announce.quiet", {
          seconds: (stall.level === "stalled" ? STALL_STALLED_MS : STALL_QUIET_MS) / 1000,
        })}`;
  const stopping = stopped === progress.runId;
  return (
    <div class={styles.runStatus} data-level={stall.level} data-phase={phase.kind}>
      <div class={styles.runLine}>
        <span class={`${styles.spinner} spin`} aria-hidden="true" />
        <span class={styles.runLabel}>{label}</span>
        <span class={styles.runMeta}>
          {t("run.elapsed", { time: formatClock(now - progress.startedAt) })}
          {" · "}
          {t("run.stepElapsed", { time: formatClock(now - progress.phaseSince) })}
          {" · "}
          {idleSeconds < 2 ? t("run.lastUpdateNow") : t("run.lastUpdate", { seconds: idleSeconds })}
        </span>
        {stall.level !== "none" ? (
          <button
            type="button"
            class={styles.runStop}
            disabled={stopping}
            onClick={() => {
              setStopped(progress.runId);
              void cancelRun();
            }}
          >
            {t("run.stop")}
          </button>
        ) : null}
      </div>
      {stall.level !== "none" ? (
        <p class={styles.runWarn}>{stallMessage(phase, stall.level, idleSeconds)}</p>
      ) : null}
      <span class="sr-only" role="status" aria-live="polite">
        {announce}
      </span>
    </div>
  );
}
