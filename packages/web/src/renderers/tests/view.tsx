import type { UiBlock } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { failedOnly, summarize } from "./model.ts";
import styles from "./tests.module.css";

type TestsBlock = Extract<UiBlock, { kind: "test-results" }>;
const MARK = { passed: "✓", failed: "✗", skipped: "○", todo: "○" } as const;

/** Test results: passed/failed/skipped summary, "failures only" filter, errors and file:line. */
export default function TestsView({ block }: { block: TestsBlock }) {
  const counts = summarize(block);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const suites = onlyFailed ? failedOnly(block.suites) : block.suites;
  return (
    <figure class={styles.block}>
      <figcaption class={styles.header}>
        {block.framework ? <span class={styles.framework}>{block.framework}</span> : null}
        <span class={styles.passed}>{t("tests.passed", { count: counts.passed })}</span>
        <span class={styles.failed}>{t("tests.failed", { count: counts.failed })}</span>
        <span>{t("tests.skipped", { count: counts.skipped + counts.todo })}</span>
        {block.durationMs !== undefined ? (
          <span>{t("tool.duration", { ms: block.durationMs })}</span>
        ) : null}
        {counts.failed ? (
          <button
            type="button"
            class={styles.filter}
            aria-pressed={onlyFailed}
            onClick={() => setOnlyFailed(!onlyFailed)}
          >
            {t("tests.onlyFailed")}
          </button>
        ) : null}
      </figcaption>
      <div class={styles.body}>
        {suites.map((suite, i) => (
          <section key={i} class={styles.suite}>
            <p class={styles.suiteName}>
              {suite.name}
              {suite.file ? <span class={styles.file}>{suite.file}</span> : null}
            </p>
            <ul class={styles.cases}>
              {suite.cases.map((c, j) => (
                <li key={j} data-status={c.status}>
                  <span class={styles.mark} aria-label={t(`tests.status.${c.status}`)}>
                    {MARK[c.status]}
                  </span>
                  <span class={styles.name}>{c.name}</span>
                  {suite.file && c.line !== undefined ? (
                    <span class={styles.file}>
                      {suite.file}:{c.line}
                    </span>
                  ) : null}
                  {c.durationMs !== undefined ? (
                    <span class={styles.time}>{c.durationMs} ms</span>
                  ) : null}
                  {c.error ? (
                    <details
                      class={styles.error}
                      open={c.status === "failed" && suite.cases.length <= 20}
                    >
                      <summary>{t("tests.error")}</summary>
                      <pre>{c.error}</pre>
                    </details>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    </figure>
  );
}
