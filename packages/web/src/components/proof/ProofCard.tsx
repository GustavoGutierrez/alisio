import { useEffect } from "preact/hooks";
import { currentId, goalInfo, proofTick } from "../../store/app.ts";
import { openProof } from "../../store/dock.ts";
import { overrideGoal } from "../../store/goal.ts";
import {
  addCriterion,
  ledger,
  loadProof,
  markNotApplicable,
  saveCriterion,
} from "../../store/proof.ts";
import { ProofView } from "./ProofView.tsx";
import styles from "./proof.module.css";
import { pk } from "./strings.ts";

/** Keeps the ledger of the open session fresh: on mount and whenever `proof_updated` arrives. */
function useLedger(): string | undefined {
  const id = currentId.value;
  // Reading the tick subscribes the component to the stream's `proof_updated` events.
  const tick = proofTick.value;
  useEffect(() => {
    if (id) void loadProof(id);
  }, [id, tick]);
  return id;
}

/** The compact summary in the thread (read-only); the button opens the panel. */
export function ProofCard() {
  const id = useLedger();
  const current = ledger.value;
  if (!id || !current || current.sessionId !== id || !current.criteria.length) return null;
  return (
    <div class={styles.wrap}>
      <ProofView
        ledger={current}
        mode="card"
        goal={null}
        sessionId={id}
        onAdd={() => undefined}
        onSave={() => undefined}
        onNotApplicable={() => undefined}
        onOverride={() => undefined}
      />
      <button type="button" class={styles.open} onClick={openProof}>
        {pk("open")}
      </button>
    </div>
  );
}

/** The Proof tab of the dock: the full card with the user's actions. */
export function ProofTab() {
  const id = useLedger();
  const current = ledger.value;
  if (!id || !current || current.sessionId !== id) return null;
  return (
    <div class={styles.panel}>
      <ProofView
        ledger={current}
        mode="panel"
        goal={goalInfo.value}
        sessionId={id}
        onAdd={(form) => void addCriterion(id, form)}
        onSave={(criterionId, change) => void saveCriterion(id, criterionId, change)}
        onNotApplicable={(criterionId, reason) => void markNotApplicable(id, criterionId, reason)}
        onOverride={(reason) => {
          const goal = goalInfo.value;
          if (goal) void overrideGoal(goal, reason);
        }}
      />
    </div>
  );
}
