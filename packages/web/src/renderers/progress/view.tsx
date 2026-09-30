import type { UiBlock } from "@alisio/sdk";
import { t } from "../../i18n/index.ts";
import styles from "./progress.module.css";

type ProgressBlock = Extract<UiBlock, { kind: "progress" }>;
const MARK = { pending: "○", running: "●", completed: "✓", failed: "✗", cancelled: "–" } as const;

/** Steps with their status (a vertical timeline). */
export default function ProgressView({ block }: { block: ProgressBlock }) {
  const done = block.steps.filter((s) => s.status === "completed").length;
  return (
    <figure class={styles.block}>
      <figcaption class={styles.header}>
        <span>{block.title ?? t("progress.title")}</span>
        <span class={styles.count}>
          {done}/{block.steps.length}
        </span>
      </figcaption>
      <ol class={styles.steps}>
        {block.steps.map((step, i) => (
          <li key={i} data-status={step.status}>
            <span class={styles.mark} aria-label={t(`progress.status.${step.status}`)}>
              {MARK[step.status]}
            </span>
            <span class={styles.label}>{step.label}</span>
            {step.detail ? <span class={styles.detail}>{step.detail}</span> : null}
          </li>
        ))}
      </ol>
    </figure>
  );
}
