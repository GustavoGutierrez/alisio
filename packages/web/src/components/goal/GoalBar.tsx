import type { GoalInfo } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { focusComposer, goalInfo } from "../../store/app.ts";
import {
  barActions,
  budgetLevel,
  budgetPercent,
  clearGoal,
  compactTokens,
  editing,
  formatElapsed,
  hasReport,
  pauseGoal,
  resumeGoal,
  saveGoal,
  working,
} from "../../store/goal.ts";
import styles from "./goal.module.css";
import { gk, reasonText, statusText, waitingText } from "./strings.ts";

const OBJECTIVE_MAX = 4000;

/** The objective and the token budget, edited together (Ctrl/Cmd+Enter saves, Esc cancels). */
function EditForm(props: { goal: GoalInfo }) {
  const { goal } = props;
  const [objective, setObjective] = useState(goal.objective);
  const [budget, setBudget] = useState(
    goal.tokenBudget !== undefined ? String(goal.tokenBudget) : "",
  );
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    area.current?.focus();
  }, []);
  const close = () => {
    editing.value = false;
    focusComposer.value++;
  };
  const submit = async () => {
    if (working.value || !objective.trim()) return;
    if (await saveGoal(goal, { objective, budget })) focusComposer.value++;
  };
  return (
    <form
      class={styles.form}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          close();
        } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          void submit();
        }
      }}
    >
      <label class={styles.field}>
        <span>{gk("objective")}</span>
        <textarea
          ref={area}
          rows={3}
          maxLength={OBJECTIVE_MAX}
          value={objective}
          onInput={(event) => setObjective((event.currentTarget as HTMLTextAreaElement).value)}
        />
      </label>
      <label class={styles.field}>
        <span>{gk("budget")}</span>
        <input
          type="text"
          inputMode="text"
          autocomplete="off"
          value={budget}
          placeholder="50k"
          aria-describedby="goal-budget-hint"
          onInput={(event) => setBudget((event.currentTarget as HTMLInputElement).value)}
        />
        <small id="goal-budget-hint">{gk("budgetHint")}</small>
      </label>
      <div class={styles.formActions}>
        <button type="submit" class={styles.primary} disabled={working.value || !objective.trim()}>
          {gk("save")}
        </button>
        <button type="button" onClick={close}>
          {gk("cancel")}
        </button>
      </div>
    </form>
  );
}

function Budget(props: { goal: GoalInfo }) {
  const { goal } = props;
  const percent = budgetPercent(goal);
  if (percent === undefined)
    return (
      <span class={styles.stat} title={gk("noLimit")}>
        {gk("noBudget", { used: compactTokens(goal.tokensUsed) })}
      </span>
    );
  return (
    <span class={styles.budget}>
      <span
        class={styles.track}
        role="progressbar"
        aria-label={gk("budgetBar")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        data-level={budgetLevel(percent)}
      >
        <span class={styles.fill} style={{ width: `${percent}%` }} />
      </span>
      <span class={styles.stat}>
        {gk("budgetLabel", {
          used: compactTokens(goal.tokensUsed),
          budget: compactTokens(goal.tokenBudget ?? 0),
        })}
      </span>
    </span>
  );
}

/** The session goal above the composer: state, budget, turns, time, why it waits, and its buttons. */
export function GoalBar() {
  const goal = goalInfo.value;
  if (!goal) return null;
  const waiting = goal.waiting ? waitingText(goal.waiting) : undefined;
  const why = waiting ?? (goal.status === "active" ? "" : reasonText(goal.reason, goal.detail));
  const actions = barActions(goal);
  const busy = working.value;
  return (
    <section class={styles.wrap} aria-label={gk("label")}>
      <div class={styles.bar} data-status={goal.status}>
        <div class={styles.head}>
          <span class={styles.chip} data-status={goal.status}>
            {statusText(goal.status)}
          </span>
          {editing.value ? null : (
            <p class={styles.objective} title={goal.objective}>
              {goal.objective}
            </p>
          )}
          {editing.value ? null : (
            <div class={styles.actions}>
              {actions.includes("pause") ? (
                <button type="button" disabled={busy} onClick={() => void pauseGoal(goal)}>
                  {gk("pause")}
                </button>
              ) : null}
              {actions.includes("resume") ? (
                <button
                  type="button"
                  class={styles.primary}
                  disabled={busy}
                  onClick={() => void resumeGoal(goal)}
                >
                  {gk("resume")}
                </button>
              ) : null}
              {actions.includes("edit") ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    editing.value = true;
                  }}
                >
                  {gk("edit")}
                </button>
              ) : null}
              {actions.includes("clear") ? (
                <button type="button" disabled={busy} onClick={() => void clearGoal(goal)}>
                  {gk("clear")}
                </button>
              ) : null}
            </div>
          )}
        </div>
        {editing.value ? <EditForm goal={goal} /> : null}
        <div class={styles.meta}>
          <Budget goal={goal} />
          <span class={styles.stat}>
            {gk("turns", { used: goal.turnsUsed, max: goal.maxTurns })}
          </span>
          <span class={styles.stat}>{gk("time", { time: formatElapsed(goal.activeMs) })}</span>
        </div>
        <p
          class={styles.why}
          role="status"
          aria-live="polite"
          data-tone={goal.waiting ? "wait" : goal.status}
        >
          {why}
        </p>
        {hasReport(goal) ? (
          <details class={styles.report}>
            <summary>{gk("report")}</summary>
            <p>{goal.summary}</p>
            {goal.evidence?.length ? (
              <ul>
                {goal.evidence.map((item, index) => (
                  <li key={`${item.kind}-${index}`}>
                    <code>{item.kind}</code> {item.detail}
                  </li>
                ))}
              </ul>
            ) : null}
          </details>
        ) : null}
      </div>
    </section>
  );
}
