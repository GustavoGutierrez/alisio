import type { GoalInfo, ProofLedger } from "@alisio/sdk";
import {
  exportHref,
  type NewCriterionForm,
  overrideAvailable,
  type ProofRow,
  proofCounts,
  proofRows,
} from "../../store/proof.ts";
import styles from "./proof.module.css";
import { pk, statusLabel } from "./strings.ts";

/**
 * The presentational part of the Proof card: no hooks and no store, so it is a pure function of
 * its props (the tests walk its output). `card` is the compact, read-only summary in the thread;
 * `panel` adds the user's actions (add, edit, not applicable, the goal override) and the exports.
 */
export interface ProofViewProps {
  ledger: ProofLedger;
  mode: "card" | "panel";
  goal: Pick<GoalInfo, "status"> | null;
  sessionId: string;
  onAdd: (form: NewCriterionForm) => void;
  onSave: (criterionId: string, change: { text?: string; required?: boolean }) => void;
  onNotApplicable: (criterionId: string, reason: string) => void;
  onOverride: (reason: string) => void;
}

const field = (form: HTMLFormElement, name: string): string =>
  String(new FormData(form).get(name) ?? "").trim();

function submitted(handler: (form: HTMLFormElement) => void) {
  return (event: Event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement;
    handler(form);
    form.reset();
  };
}

function Row(
  props: { row: ProofRow; panel: boolean } & Pick<ProofViewProps, "onSave" | "onNotApplicable">,
) {
  const { row, panel } = props;
  const editable = panel && row.status !== "not_applicable";
  return (
    <li
      class={styles.row}
      data-criterion={row.criterionId}
      data-status={row.status}
      data-stale={row.stale ? "true" : undefined}
    >
      <div class={styles.rowHead}>
        <span class={styles.status} data-status={row.status}>
          {statusLabel(row.status)}
        </span>
        <span class={styles.text}>{row.text}</span>
        <span class={styles.required} data-required={row.required ? "true" : undefined}>
          {row.required ? pk("required") : pk("optional")}
        </span>
      </div>
      {row.stale ? <p class={styles.note}>{pk("stale")}</p> : null}
      {row.command ? <code class={styles.command}>{row.command}</code> : null}
      <p class={styles.note}>
        {row.notApplicableReason
          ? pk("naReason", { reason: row.notApplicableReason })
          : row.evidence
            ? pk("evidence", { callId: row.evidence.callId, code: row.evidence.exitCode ?? "-" })
            : row.status === "manual_review"
              ? ""
              : pk("noEvidence")}
      </p>
      {editable ? (
        <div class={styles.actions}>
          <details class={styles.inline}>
            <summary>{pk("edit")}</summary>
            <form
              class={styles.form}
              onSubmit={submitted((form) =>
                props.onSave(row.criterionId, {
                  text: field(form, "text"),
                  required: new FormData(form).get("required") === "on",
                }),
              )}
            >
              <label class={styles.field}>
                <span>{pk("text")}</span>
                <input name="text" type="text" required maxLength={600} value={row.text} />
              </label>
              <label class={styles.check}>
                <input name="required" type="checkbox" checked={row.required} />
                <span>{pk("requiredLabel")}</span>
              </label>
              <button type="submit" class={styles.primary}>
                {pk("save")}
              </button>
            </form>
          </details>
          <details class={styles.inline}>
            <summary>{pk("notApplicable")}</summary>
            <form
              class={styles.form}
              onSubmit={submitted((form) =>
                props.onNotApplicable(row.criterionId, field(form, "reason")),
              )}
            >
              <label class={styles.field}>
                <span>{pk("reason")}</span>
                <input name="reason" type="text" required maxLength={500} />
              </label>
              <button type="submit" class={styles.primary}>
                {pk("save")}
              </button>
            </form>
          </details>
        </div>
      ) : null}
    </li>
  );
}

export function ProofView(props: ProofViewProps) {
  const { ledger, mode, goal, sessionId } = props;
  const panel = mode === "panel";
  const counts = proofCounts(ledger);
  const rows = proofRows(ledger);
  return (
    <section class={styles.card} data-mode={mode} aria-label={pk("label")}>
      <header class={styles.head}>
        <h3 class={styles.title}>{pk("label")}</h3>
        <span class={styles.summary}>
          {pk("summary", { verified: counts.verified, total: counts.total })}
        </span>
        {counts.requiredUnmet ? (
          <span class={styles.unmet}>{pk("unmet", { n: counts.requiredUnmet })}</span>
        ) : null}
      </header>
      {rows.length ? (
        <ul class={styles.list}>
          {rows.map((row) => (
            <Row
              key={row.criterionId}
              row={row}
              panel={panel}
              onSave={props.onSave}
              onNotApplicable={props.onNotApplicable}
            />
          ))}
        </ul>
      ) : panel ? (
        <p class={styles.note}>{pk("empty")}</p>
      ) : null}
      {ledger.divergences.length ? (
        <ul class={styles.divergences} role="note">
          {ledger.divergences.map((d) => (
            <li key={`${d.claim}-${d.actual}`}>
              {pk("divergence", { claim: d.claim, status: statusLabel(d.actual) })}
            </li>
          ))}
        </ul>
      ) : null}
      {panel ? (
        <>
          <details class={styles.inline} open={!rows.length}>
            <summary>{pk("add")}</summary>
            <form
              class={styles.form}
              onSubmit={submitted((form) =>
                props.onAdd({
                  text: field(form, "text"),
                  ...(field(form, "verify") ? { verify: field(form, "verify") } : {}),
                  required: new FormData(form).get("required") === "on",
                }),
              )}
            >
              <label class={styles.field}>
                <span>{pk("text")}</span>
                <input name="text" type="text" required maxLength={600} />
              </label>
              <label class={styles.field}>
                <span>{pk("command")}</span>
                <input name="verify" type="text" maxLength={1000} placeholder="pnpm test" />
                <small>{pk("commandHint")}</small>
              </label>
              <label class={styles.check}>
                <input name="required" type="checkbox" />
                <span>{pk("requiredLabel")}</span>
              </label>
              <button type="submit" class={styles.primary}>
                {pk("add")}
              </button>
            </form>
          </details>
          {overrideAvailable(goal, ledger) ? (
            <details class={styles.inline} data-override="true">
              <summary>{pk("override")}</summary>
              <form
                class={styles.form}
                onSubmit={submitted((form) => props.onOverride(field(form, "reason")))}
              >
                <p class={styles.note}>{pk("overrideHint")}</p>
                <label class={styles.field}>
                  <span>{pk("reason")}</span>
                  <input name="reason" type="text" required maxLength={500} />
                </label>
                <button type="submit" class={styles.danger}>
                  {pk("overrideConfirm")}
                </button>
              </form>
            </details>
          ) : null}
          <p class={styles.exports}>
            <a href={exportHref(sessionId, "md")} download="proof.md">
              {pk("export.md")}
            </a>
            <a href={exportHref(sessionId, "json")} download="proof.json">
              {pk("export.json")}
            </a>
          </p>
          <p class={styles.note}>{pk("disclaimer")}</p>
        </>
      ) : null}
    </section>
  );
}
