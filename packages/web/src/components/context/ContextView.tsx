import type { ContextReport } from "@alisio/sdk";
import { type ContextRow, contextRows, contextSummary } from "../../store/context-report.ts";
import styles from "./context.module.css";
import { ck, criticalityLabel, invariantKindLabel, kindLabel, reasonLabel } from "./strings.ts";

/**
 * The presentational part of the Context panel: no hooks and no store, so it is a pure function
 * of its props (the tests walk its output). It renders the segments of the `ContextReport` as they
 * come, with the reason the report gives for each one.
 */
export interface ContextViewProps {
  report: ContextReport;
  /** List every segment instead of only the pinned, low and elided ones. */
  showAll: boolean;
  onShowAll: (all: boolean) => void;
}

function Row({ row, mode }: { row: ContextRow; mode: ContextReport["mode"] }) {
  const decision = row.elided
    ? `${reasonLabel(row.elided.reason)}${
        row.elided.replacedBy ? ` · ${ck("replacedBy", { callId: row.elided.replacedBy })}` : ""
      }`
    : (row.reason ?? "");
  return (
    <li
      class={styles.row}
      data-segment={row.id}
      data-kind={row.kind}
      data-criticality={row.criticality}
      data-elided={row.elided ? row.elided.reason : undefined}
    >
      <div class={styles.rowHead}>
        <span class={styles.kind}>{kindLabel(row.kind)}</span>
        <span class={styles.origin}>{row.origin}</span>
        <span class={styles.tokens}>{ck("tokens", { n: row.tokens })}</span>
        <span class={styles.criticality} data-criticality={row.criticality}>
          {criticalityLabel(row.criticality)}
        </span>
      </div>
      {decision ? (
        <p class={styles.note} data-mode={mode}>
          {decision}
          {row.elided ? ` · ${ck("tokens", { n: row.elided.tokensSaved })}` : ""}
        </p>
      ) : null}
      {row.used !== undefined ? (
        <p class={styles.note}>{row.used ? ck("usedLater") : ck("notUsed")}</p>
      ) : null}
    </li>
  );
}

export function ContextView(props: ContextViewProps) {
  const { report, showAll } = props;
  const summary = contextSummary(report);
  const rows = contextRows(report, showAll);
  const kinds = Object.entries(report.invariants.byKind).filter(([, n]) => !!n) as Array<
    [string, number]
  >;
  return (
    <section class={styles.card} data-mode={report.mode} aria-label={ck("label")}>
      <header class={styles.head}>
        <h3 class={styles.title}>{ck("label")}</h3>
        <span class={styles.summary}>
          {ck("mode", { mode: ck(`mode.${report.mode}`), policy: report.policyVersion })}
        </span>
      </header>
      {!summary.active ? (
        <p class={styles.note}>{ck("off")}</p>
      ) : (
        <>
          <p class={styles.line}>
            {ck("history", {
              messages: report.messages,
              before: report.tokensBefore,
              after: report.tokensAfter,
            })}
          </p>
          <p class={styles.line} data-elided={summary.elided}>
            {summary.elided
              ? ck(report.mode === "on" ? "elided" : "elidedShadow", {
                  n: summary.elided,
                  saved: report.tokensSaved,
                })
              : ck("none")}
            {summary.reasons.length
              ? ` (${summary.reasons.map(([r, n]) => `${reasonLabel(r)} ${n}`).join(", ")})`
              : ""}
          </p>
          {summary.usedPercent !== undefined ? (
            <p class={styles.line}>{ck("used", { percent: summary.usedPercent })}</p>
          ) : null}
          <div class={styles.line} data-invariants={report.invariants.count}>
            <span>{ck("invariants", { n: report.invariants.count })}</span>
            {kinds.length ? (
              <span class={styles.note}>
                {` · ${kinds.map(([kind, n]) => `${invariantKindLabel(kind)} ${n}`).join(" · ")}`}
              </span>
            ) : (
              <span class={styles.note}>{` · ${ck("noInvariants")}`}</span>
            )}
            {report.invariants.omitted ? (
              <span class={styles.note}>
                {` · ${ck("invariantsOmitted", { n: report.invariants.omitted })}`}
              </span>
            ) : null}
          </div>
          <div class={styles.listHead}>
            <h4 class={styles.subtitle}>{ck("segments")}</h4>
            <label class={styles.check}>
              <input
                type="checkbox"
                checked={showAll}
                onChange={(event) =>
                  props.onShowAll((event.currentTarget as HTMLInputElement).checked)
                }
              />
              <span>{ck("showAll")}</span>
            </label>
          </div>
          {rows.length ? (
            <ul class={styles.list}>
              {rows.map((row) => (
                <Row key={row.id} row={row} mode={report.mode} />
              ))}
            </ul>
          ) : null}
          {!showAll && summary.hidden > 0 ? (
            <p class={styles.note}>{ck("hidden", { n: summary.hidden })}</p>
          ) : null}
          {report.segmentsOmitted ? (
            <p class={styles.note}>{ck("omitted", { n: report.segmentsOmitted })}</p>
          ) : null}
          <p class={styles.note}>{ck("disclaimer")}</p>
        </>
      )}
    </section>
  );
}
