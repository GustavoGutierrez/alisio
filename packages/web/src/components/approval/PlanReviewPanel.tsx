import type { PendingInteraction } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { answer } from "../../store/app.ts";
import { openArtifact } from "../../store/artifacts.ts";
import {
  criteriaSelection,
  type DraftDecision,
  initialDecisions,
} from "../../store/plan-criteria.ts";
import {
  isPlanChoice,
  OPTION_HINTS,
  OPTION_LABELS,
  type PlanChoice,
  planAnswer,
  planReviewOf,
} from "../../store/plan-review.ts";
import { ArtifactCard } from "../artifacts/ArtifactCard.tsx";
import { Icon } from "../icons.tsx";
import { diagramCountText, pk } from "../plan/strings.ts";
import styles from "./approval.module.css";
import plan from "./plan.module.css";

/**
 * The decision screen of `exit_plan`, in the composer's place (lazy chunk). The plan itself is in
 * the chat (the `exit_plan` call, open) and in the side panel (the `plan.md` artifact card below).
 * Esc or "Skip for now" skips; "Add context" opens a text field whose text goes back to the
 * model. Every button locks after the first decision, so a double click sends one answer; the
 * server also answers a second one with a harmless conflict.
 */
export function PlanReviewPanel({ interaction }: { interaction: PendingInteraction }) {
  const view = planReviewOf(interaction);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [mode, setMode] = useState<"choose" | "text">("choose");
  const [text, setText] = useState("");
  const [sent, setSent] = useState(false);
  // The user's choice per proposed acceptance criterion (all kept as proposed by default).
  const [decisions, setDecisions] = useState<DraftDecision[]>([]);
  const drafts = view?.plan.acceptanceCriteria ?? [];
  useEffect(() => {
    setMode("choose");
    setText("");
    setSent(false);
    setDecisions(initialDecisions(view?.plan.acceptanceCriteria ?? []));
    panel.current?.focus();
  }, [interaction.interactionId]);
  useEffect(() => {
    if (mode === "text") field.current?.focus();
    else panel.current?.focus();
  }, [mode]);
  if (!view) return null;

  const decide = (choice: PlanChoice) => {
    if (sent) return;
    setSent(true);
    void answer(
      interaction.interactionId,
      planAnswer(view.question, choice, text, criteriaSelection(drafts, decisions)),
    );
  };
  const titleId = `plan-review-${interaction.interactionId}`;
  return (
    <div class={styles.dock}>
      <div
        ref={panel}
        class={styles.panel}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          if (mode === "text") setMode("choose");
          else decide("skip");
        }}
      >
        <div class={styles.head}>
          <span class={styles.badge}>
            <Icon name="file" size={16} />
          </span>
          <p class={styles.eyebrow}>
            {t("plan.review.eyebrow")}
            {view.plan.revision > 1
              ? ` · ${t("plan.review.revision", { n: view.plan.revision })}`
              : ""}
          </p>
        </div>
        <div class={styles.body}>
          <h2 id={titleId} class={styles.title}>
            {t("plan.review.title")}
          </h2>
          <p class={plan.planTitle}>{view.plan.title}</p>
          {view.plan.artifact ? <ArtifactCard artifact={view.plan.artifact} compact /> : null}
          {view.plan.diagrams?.length ? (
            <p class={plan.diagramsLine}>
              <span>{diagramCountText(view.plan.diagrams.length)}</span>
              {view.plan.artifact ? (
                <button
                  type="button"
                  class={plan.viewerButton}
                  aria-controls="artifact-panel"
                  onClick={(event) =>
                    openArtifact((view.plan.artifact as { id: string }).id, event.currentTarget)
                  }
                >
                  {pk("openViewer")}
                </button>
              ) : null}
            </p>
          ) : null}
          {drafts.length && mode === "choose" ? (
            <fieldset class={plan.criteria} disabled={sent}>
              <legend>{pk("criteriaTitle")}</legend>
              <p class={plan.criteriaHint}>{pk("criteriaHint")}</p>
              {drafts.map((draft, i) => {
                const d = decisions[i] ?? {
                  keep: true,
                  text: draft.text,
                  required: draft.required,
                };
                const change = (patch: Partial<DraftDecision>) =>
                  setDecisions((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                return (
                  <div key={`${i}-${draft.text}`} class={plan.criterion} data-kept={String(d.keep)}>
                    <input
                      type="checkbox"
                      checked={d.keep}
                      aria-label={pk("criterionKeep")}
                      onChange={(event) =>
                        change({ keep: (event.target as HTMLInputElement).checked })
                      }
                    />
                    <input
                      type="text"
                      class={plan.criterionText}
                      value={d.text}
                      maxLength={500}
                      disabled={!d.keep}
                      aria-label={pk("criterionText")}
                      onInput={(event) =>
                        change({ text: (event.target as HTMLInputElement).value })
                      }
                    />
                    <label class={plan.criterionRequired}>
                      <input
                        type="checkbox"
                        checked={d.required}
                        disabled={!d.keep}
                        onChange={(event) =>
                          change({ required: (event.target as HTMLInputElement).checked })
                        }
                      />
                      <span>{pk("criterionRequired")}</span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
          ) : null}
          {mode === "choose" ? (
            <div class={styles.options} role="group" aria-labelledby={titleId}>
              {view.question.options.map((option) => {
                const choice = isPlanChoice(option.value) ? option.value : undefined;
                const known = choice !== undefined;
                return (
                  <button
                    key={option.value}
                    type="button"
                    class={styles.option}
                    data-primary={choice === "approve" ? "true" : undefined}
                    disabled={sent}
                    onClick={() => {
                      if (choice === "context") setMode("text");
                      else if (choice) decide(choice);
                      else if (!sent) {
                        setSent(true);
                        void answer(interaction.interactionId, {
                          [view.question.id]: option.value,
                        });
                      }
                    }}
                  >
                    <span class={styles.optionLabel}>
                      {known ? t(OPTION_LABELS[choice]) : option.label}
                    </span>
                    {known ? (
                      <span class={styles.optionDescription}>{t(OPTION_HINTS[choice])}</span>
                    ) : option.description ? (
                      <span class={styles.optionDescription}>{option.description}</span>
                    ) : null}
                  </button>
                );
              })}
            </div>
          ) : (
            <label class={plan.contextField}>
              <span class="sr-only">{t("plan.review.contextLabel")}</span>
              <textarea
                ref={field}
                class={plan.contextInput}
                rows={4}
                value={text}
                disabled={sent}
                maxLength={20000}
                placeholder={t("plan.review.contextPlaceholder")}
                onInput={(event) => setText((event.target as HTMLTextAreaElement).value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
                    event.preventDefault();
                    if (text.trim()) decide("context");
                  }
                }}
              />
            </label>
          )}
        </div>
        <div class={styles.actions}>
          {mode === "text" ? (
            <>
              <button
                type="button"
                class={styles.secondary}
                disabled={sent}
                onClick={() => setMode("choose")}
              >
                {t("plan.review.back")}
              </button>
              <span class={styles.gap} />
              <button
                type="button"
                class={styles.primary}
                disabled={sent || !text.trim()}
                onClick={() => decide("context")}
              >
                {t("plan.review.send")}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
