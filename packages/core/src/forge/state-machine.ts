/**
 * The Forja execution lifecycle (spec §5.2). Pure: no I/O.
 *
 * `cancelling` and `timed_out_pending` exist because a terminal state is only reached once the
 * host has confirmed the guest stopped; a terminal state is reached exactly once.
 */
export type ExecutionState =
  | "validating"
  | "preparing"
  | "running"
  | "cancelling"
  | "timed_out_pending"
  | "collecting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed_out";

const TRANSITIONS: Readonly<Record<ExecutionState, readonly ExecutionState[]>> = {
  validating: ["preparing", "failed"],
  preparing: ["running", "failed", "cancelled"],
  running: ["collecting", "failed", "cancelling", "timed_out_pending"],
  cancelling: ["cancelled"],
  timed_out_pending: ["timed_out"],
  collecting: ["succeeded", "failed"],
  succeeded: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: ExecutionState,
    readonly to: ExecutionState,
  ) {
    super(`Invalid execution transition: ${from} -> ${to}`);
    this.name = "InvalidTransitionError";
  }
}

export function canTransition(from: ExecutionState, to: ExecutionState): boolean {
  return TRANSITIONS[from].includes(to);
}

export class ExecutionStateMachine {
  #state: ExecutionState = "validating";

  get state(): ExecutionState {
    return this.#state;
  }

  get isTerminal(): boolean {
    return TRANSITIONS[this.#state].length === 0;
  }

  /** Moves to `to`, or throws without changing state when the diagram does not allow it. */
  transition(to: ExecutionState): void {
    if (!canTransition(this.#state, to)) throw new InvalidTransitionError(this.#state, to);
    this.#state = to;
  }
}
