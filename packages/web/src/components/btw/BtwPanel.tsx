import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { Markdown } from "../../markdown/view.tsx";
import { btw, closeSideQuestion } from "../../store/app.ts";
import {
  BTW_USAGE,
  currentSideQuestion,
  sideQuestionMoves,
  stepSideQuestion,
} from "../../store/btw.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import styles from "./btw.module.css";

const editable = (target: EventTarget | null) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

/**
 * The floating `/btw` side panel: a side question and its answer, outside the transcript.
 * Esc closes it (cancelling a pending question); ←/→ browse earlier answers.
 */
export function BtwPanel() {
  const state = btw.value;
  const panel = useRef<HTMLElement>(null);
  useEffect(() => {
    panel.current?.focus();
  }, [state?.sessionId, state?.pending?.question]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const current = btw.value;
      // Keys already handled elsewhere (e.g. Esc closing the composer palette) stay there.
      if (!current || event.defaultPrevented) return;
      if (event.key === "Escape") {
        event.preventDefault();
        closeSideQuestion();
      } else if (
        (event.key === "ArrowLeft" || event.key === "ArrowRight") &&
        !editable(event.target) &&
        !event.altKey &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        event.preventDefault();
        btw.value = stepSideQuestion(current, event.key === "ArrowLeft" ? -1 : 1);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);
  if (!state) return null;
  const entry = currentSideQuestion(state);
  const moves = sideQuestionMoves(state);
  const question = state.pending?.question ?? state.error?.question ?? entry?.question;
  const step = (direction: -1 | 1) => {
    if (btw.value) btw.value = stepSideQuestion(btw.value, direction);
  };
  return (
    <aside
      ref={panel}
      class={styles.panel}
      role="dialog"
      aria-modal="false"
      aria-labelledby="btw-title"
      tabIndex={-1}
    >
      <header class={styles.head}>
        <span class={styles.badge} aria-hidden="true">
          btw
        </span>
        <div class={styles.titles}>
          <h2 id="btw-title" class={styles.title}>
            {t("btw.title")}
          </h2>
          <p class={styles.eyebrow}>{t("btw.subtitle")}</p>
        </div>
        {state.entries.length && !state.usage ? (
          <nav class={styles.nav} aria-label={t("btw.history")}>
            <button
              type="button"
              class="icon-btn"
              aria-label={t("btw.earlier")}
              title={t("btw.earlier")}
              disabled={!moves.earlier}
              onClick={() => step(-1)}
            >
              <Icon name="chevronRight" size={16} class={styles.flip} />
            </button>
            <span class={styles.position} aria-live="polite">
              {entry ? t("btw.position", { n: state.index + 1, total: state.entries.length }) : ""}
            </span>
            <button
              type="button"
              class="icon-btn"
              aria-label={t("btw.later")}
              title={t("btw.later")}
              disabled={!moves.later}
              onClick={() => step(1)}
            >
              <Icon name="chevronRight" size={16} />
            </button>
          </nav>
        ) : null}
        {entry ? <CopyButton text={() => entry.answer} label={t("btw.copy")} /> : null}
        <button
          type="button"
          class="icon-btn"
          aria-label={t("common.close")}
          title={t("common.close")}
          onClick={() => closeSideQuestion()}
        >
          <Icon name="x" size={16} />
        </button>
      </header>
      <div class={styles.body}>
        {state.usage ? (
          <div class={styles.usage}>
            <code>{BTW_USAGE}</code>
            <p>{t("btw.usage")}</p>
          </div>
        ) : (
          <>
            {question ? <p class={styles.question}>{question}</p> : null}
            {state.pending ? (
              <div class={styles.pending} role="status">
                <span class={`${styles.spinner} spin`} aria-hidden="true" />
                <span>{t("btw.thinking")}</span>
                <button type="button" class={styles.cancel} onClick={() => closeSideQuestion()}>
                  {t("common.cancel")}
                </button>
              </div>
            ) : state.error ? (
              <p class={styles.error} role="alert">
                {state.error.message}
              </p>
            ) : entry ? (
              <div class={styles.answer}>
                <Markdown text={entry.answer} />
              </div>
            ) : null}
          </>
        )}
      </div>
      {entry ? (
        <footer class={styles.foot}>
          {t("btw.tokens", {
            model: entry.model,
            input: entry.usage.input.toLocaleString(),
            output: entry.usage.output.toLocaleString(),
          })}
          {entry.truncated ? ` · ${t("btw.truncated")}` : ""}
        </footer>
      ) : null}
    </aside>
  );
}
