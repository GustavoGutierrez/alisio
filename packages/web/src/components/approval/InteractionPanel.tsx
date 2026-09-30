import type { PendingInteraction } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { answer } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import styles from "./approval.module.css";

/** Plugin questions (`ui.select`, `ui.askQuestions`, RF-18) in the composer's place. */
export function InteractionPanel({ interaction }: { interaction: PendingInteraction }) {
  const panel = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState(0);
  const [answers, setAnswers] = useState<Record<string, string | string[]>>({});
  useEffect(() => {
    setStep(0);
    setAnswers({});
    panel.current?.focus();
  }, [interaction.interactionId]);

  const request = interaction.request;
  const skip = () => void answer(interaction.interactionId, null);
  const titleId = `interaction-${interaction.interactionId}`;

  let body: preact.ComponentChildren;
  let footer: preact.ComponentChildren;
  if (request.kind === "select") {
    body = (
      <>
        <h2 id={titleId} class={styles.title}>
          {request.select.title}
        </h2>
        <div class={styles.options} role="group" aria-labelledby={titleId}>
          {request.select.options.map((option) => (
            <button
              key={option.value}
              type="button"
              class={styles.option}
              onClick={() => void answer(interaction.interactionId, option.value)}
            >
              <span class={styles.optionLabel}>{option.label}</span>
              {option.description ? (
                <span class={styles.optionDescription}>{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      </>
    );
    footer = (
      <button type="button" class={styles.secondary} onClick={skip}>
        {t("interaction.skip")}
      </button>
    );
  } else {
    const questions = request.questions;
    const question = questions[step] ?? questions[0];
    if (!question) return null;
    const value = answers[question.id];
    const chosen = (v: string) => (Array.isArray(value) ? value.includes(v) : value === v);
    const toggle = (v: string) =>
      setAnswers({
        ...answers,
        [question.id]: question.multiSelect
          ? chosen(v)
            ? (value as string[]).filter((x) => x !== v)
            : [...((value as string[] | undefined) ?? []), v]
          : v,
      });
    const last = step >= questions.length - 1;
    body = (
      <>
        <p class={styles.meta}>
          {request.label ? `${t("interaction.from", { label: request.label })} · ` : ""}
          {t("interaction.questionOf", { n: step + 1, total: questions.length })}
        </p>
        <p class={styles.chip}>{question.header}</p>
        <h2 id={titleId} class={styles.title}>
          {question.question}
        </h2>
        <div
          class={styles.options}
          role={question.multiSelect ? "group" : "radiogroup"}
          aria-labelledby={titleId}
        >
          {question.options.map((option) => (
            <button
              key={option.value}
              type="button"
              role={question.multiSelect ? "checkbox" : "radio"}
              aria-checked={chosen(option.value)}
              class={styles.option}
              onClick={() => toggle(option.value)}
            >
              <span class={styles.optionLabel}>
                {option.label}
                {option.recommended ? (
                  <span class={styles.recommended}>{t("interaction.recommended")}</span>
                ) : null}
              </span>
              {option.description ? (
                <span class={styles.optionDescription}>{option.description}</span>
              ) : null}
            </button>
          ))}
        </div>
      </>
    );
    footer = (
      <>
        <button type="button" class={styles.secondary} onClick={skip}>
          {t("interaction.skip")}
        </button>
        <span class={styles.gap} />
        <button
          type="button"
          class={styles.primary}
          onClick={() =>
            last ? void answer(interaction.interactionId, answers) : setStep(step + 1)
          }
        >
          {last ? t("interaction.submit") : t("interaction.next")}
        </button>
      </>
    );
  }
  return (
    <div class={styles.dock}>
      <div
        ref={panel}
        class={styles.panel}
        role="dialog"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === "Escape") skip();
        }}
      >
        <div class={styles.head}>
          <span class={styles.badge}>
            <Icon name="question" size={16} />
          </span>
          <p class={styles.eyebrow}>{t("interaction.title")}</p>
        </div>
        <div class={styles.body}>{body}</div>
        <div class={styles.actions}>{footer}</div>
      </div>
    </div>
  );
}
