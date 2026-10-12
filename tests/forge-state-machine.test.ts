/**
 * The Forja execution lifecycle (spec §5.2): only the diagrammed transitions are valid and a
 * terminal state is reached exactly once.
 */
import { describe, expect, it } from "vitest";
import {
  canTransition,
  type ExecutionState,
  ExecutionStateMachine,
  InvalidTransitionError,
} from "../packages/core/src/forge/state-machine.ts";

const VALID: Record<ExecutionState, ExecutionState[]> = {
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
const ALL = Object.keys(VALID) as ExecutionState[];

function at(state: ExecutionState): ExecutionStateMachine {
  // Walk the shortest valid path to the requested state.
  const paths: Record<ExecutionState, ExecutionState[]> = {
    validating: [],
    preparing: ["preparing"],
    running: ["preparing", "running"],
    cancelling: ["preparing", "running", "cancelling"],
    timed_out_pending: ["preparing", "running", "timed_out_pending"],
    collecting: ["preparing", "running", "collecting"],
    succeeded: ["preparing", "running", "collecting", "succeeded"],
    failed: ["failed"],
    cancelled: ["preparing", "cancelled"],
    timed_out: ["preparing", "running", "timed_out_pending", "timed_out"],
  };
  const machine = new ExecutionStateMachine();
  for (const step of paths[state]) machine.transition(step);
  return machine;
}

describe("forge execution state machine", () => {
  it("starts in validating and follows the happy path to succeeded", () => {
    const machine = new ExecutionStateMachine();
    expect(machine.state).toBe("validating");
    for (const step of ["preparing", "running", "collecting", "succeeded"] as const) {
      expect(machine.isTerminal).toBe(false);
      machine.transition(step);
      expect(machine.state).toBe(step);
    }
    expect(machine.isTerminal).toBe(true);
  });

  it("accepts exactly the transitions of the lifecycle diagram, from every state", () => {
    for (const from of ALL) {
      for (const to of ALL) {
        const expected = VALID[from].includes(to);
        expect(canTransition(from, to), `${from} -> ${to}`).toBe(expected);
        if (expected) {
          const machine = at(from);
          machine.transition(to);
          expect(machine.state).toBe(to);
        } else {
          const machine = at(from);
          expect(() => machine.transition(to), `${from} -> ${to}`).toThrow(InvalidTransitionError);
          expect(machine.state).toBe(from);
        }
      }
    }
  });

  it("models a cooperative cancel and a deadline as a pending state confirmed later", () => {
    const cancel = at("running");
    cancel.transition("cancelling");
    expect(cancel.isTerminal).toBe(false);
    cancel.transition("cancelled");
    expect(cancel.isTerminal).toBe(true);

    const deadline = at("running");
    deadline.transition("timed_out_pending");
    expect(deadline.isTerminal).toBe(false);
    deadline.transition("timed_out");
    expect(deadline.isTerminal).toBe(true);
  });

  it("reaches a terminal state only once", () => {
    const machine = at("failed");
    expect(() => machine.transition("failed")).toThrow(InvalidTransitionError);
    expect(() => machine.transition("cancelled")).toThrow(InvalidTransitionError);
    expect(machine.state).toBe("failed");
  });
});
