/** Step 2: staged progress (honest hints while waiting), elapsed time and Cancel. */
import { Icon } from "../icons.tsx";
import { formatElapsed, type GenerationPhase, progressStages, type StageId } from "./model.ts";
import { Spinner } from "./parts.tsx";
import styles from "./skill-builder.module.css";
import { type SbKey, sb } from "./strings.ts";

const STAGE_TEXT: Record<StageId, SbKey> = {
  analyze: "stageAnalyze",
  write: "stageWrite",
  files: "stageFiles",
  validate: "stageValidate",
};
const STATE_TEXT = { active: "stageActive", done: "stageDone", pending: "stagePending" } as const;

export function GeneratingStep(props: {
  elapsedMs: number;
  phase: GenerationPhase;
  onCancel: () => void;
}) {
  const stages = progressStages(props.elapsedMs, props.phase);
  const current = stages.find((stage) => stage.state === "active") ?? stages[stages.length - 1];
  return (
    <div class={styles.page} aria-busy="true">
      <header>
        <h2 class={styles.title} id="sb-step-title" tabIndex={-1}>
          {sb("generatingTitle")}
        </h2>
        <p class={styles.lead}>{sb("generatingLead")}</p>
      </header>
      {/* Announces stage changes only (not every second). */}
      <p class="sr-only" role="status" aria-live="polite">
        {current ? sb(STAGE_TEXT[current.id]) : ""}
      </p>
      <ol class={styles.progress}>
        {stages.map((stage) => (
          <li key={stage.id} class={styles.stage} data-state={stage.state}>
            <span class={styles.stageIcon}>
              {stage.state === "active" ? (
                <Spinner />
              ) : stage.state === "done" ? (
                <Icon name="check" size={16} />
              ) : (
                <span class={styles.stageDot} />
              )}
            </span>
            {sb(STAGE_TEXT[stage.id])}
            <span class={styles.stageState}>{sb(STATE_TEXT[stage.state])}</span>
          </li>
        ))}
      </ol>
      <p class={styles.hint}>{sb("stagesNote")}</p>
      <div class={styles.actionBar}>
        <span class={styles.elapsed}>
          {sb("elapsed", { time: formatElapsed(props.elapsedMs) })}
        </span>
        <span class={styles.actionSpacer} />
        <button type="button" class={styles.secondaryBtn} onClick={props.onCancel}>
          {sb("cancel")}
        </button>
      </div>
    </div>
  );
}
