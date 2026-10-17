import { useEffect, useState } from "preact/hooks";
import { contextTick, currentId } from "../../store/app.ts";
import { failed, loadContextReport, loading, report } from "../../store/context-report.ts";
import { ContextView } from "./ContextView.tsx";
import styles from "./context.module.css";
import { ck } from "./strings.ts";

/** The Context tab of the dock: the report of the open session, read again on every request. */
export function ContextTab() {
  const id = currentId.value;
  // Reading the tick subscribes the tab to the stream's `context_governed` events.
  const tick = contextTick.value;
  const [all, setAll] = useState(false);
  useEffect(() => {
    if (id) void loadContextReport(id);
  }, [id, tick]);
  const current = report.value;
  if (!id) return null;
  if (!current || current.sessionId !== id)
    return <p class={styles.note}>{failed.value ? ck("failed") : ck("loading")}</p>;
  return (
    <div class={styles.panel}>
      <ContextView report={current} showAll={all} onShowAll={setAll} />
      <button
        type="button"
        class={styles.refresh}
        disabled={loading.value}
        onClick={() => void loadContextReport(id)}
      >
        {ck("refresh")}
      </button>
    </div>
  );
}
