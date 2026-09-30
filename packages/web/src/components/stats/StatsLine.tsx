import { useComputed } from "@preact/signals";
import { useEffect } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { currentId, eventsTick } from "../../store/app.ts";
import { statsFeed } from "../../store/events.ts";
import { compactNumber, formatSeconds, type Stats, sessionStats } from "../../store/stats.ts";
import styles from "./stats.module.css";

function parts(stats: Stats): string[] {
  return [
    t(stats.turns === 1 ? "stats.turn" : "stats.turns", { count: stats.turns }),
    t(stats.steps === 1 ? "stats.step" : "stats.steps", { count: stats.steps }),
    t("stats.llm", { time: formatSeconds(stats.llmMs) }),
    t("stats.tools", { time: formatSeconds(stats.toolMs) }),
    t("stats.ttft", { time: stats.ttftMs !== undefined ? formatSeconds(stats.ttftMs) : "—" }),
    t("stats.throughput", {
      value: stats.tokensPerSecond !== undefined ? compactNumber(stats.tokensPerSecond) : "—",
    }),
    t("stats.cache", {
      value: stats.cacheHit !== undefined ? `${Math.round(stats.cacheHit * 100)}%` : "—",
    }),
    t("stats.input", { value: compactNumber(stats.inputTokens) }),
  ];
}

/**
 * Under the composer (RF-16): turns · steps · LLM time · tool time · TTFT · tok/s · cache ·
 * input tokens of the latest run; the tooltip has the session totals.
 */
export function StatsLine() {
  const id = currentId.value;
  useEffect(() => {
    void statsFeed.sync();
  }, [id, eventsTick.value]);
  const stats = useComputed(() => sessionStats(statsFeed.state.value.items));
  const { last, session } = stats.value;
  if (!id || !last) return null;
  const total = parts(session).join(" · ");
  return (
    <p
      class={styles.line}
      title={t("stats.session", { runs: session.runs, stats: total })}
      aria-label={t("stats.label", { stats: parts(last).join(", ") })}
    >
      {parts(last).map((part, i) => (
        <span key={i}>{part}</span>
      ))}
    </p>
  );
}
