/**
 * The Forja execution journal over the real SQLite store (spec §9.1, §9.3): lifecycle rows that
 * obey the state machine, nested calls with hashes only, a terminal state reached once, and the
 * restart reconciliation of non-terminal rows (FJ-AC-25).
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  forgeCallId,
  type OpenExecutionInput,
  reconcileInterruptedExecutions,
  SqliteExecutionJournal,
} from "../packages/core/src/forge/journal.ts";
import { InvalidTransitionError } from "../packages/core/src/forge/state-machine.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function setup(clock = { now: 1_000 }) {
  const root = await mkdtemp(join(tmpdir(), "alisio-forge-journal-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const journal = new SqliteExecutionJournal(store.db, { now: () => clock.now });
  return { store, journal, clock };
}

const input = (overrides: Partial<OpenExecutionInput> = {}): OpenExecutionInput => ({
  id: "exec_1",
  rootSessionId: "root-1",
  sessionId: "child-1",
  toolCallId: "call-1",
  engine: "javascript-quickjs",
  isolation: "wasm-isolate",
  selectionReason: "language",
  codeSha256: "a".repeat(64),
  ...overrides,
});

function toRunning(journal: SqliteExecutionJournal, id = "exec_1") {
  journal.transition(id, "preparing");
  journal.transition(id, "running");
}

describe("forge execution journal: lifecycle", () => {
  it("opens a validating row with its identity and no end", async () => {
    const { journal } = await setup();
    journal.open(input({ analysisExecutionId: undefined }));
    expect(journal.get("exec_1")).toMatchObject({
      id: "exec_1",
      rootSessionId: "root-1",
      sessionId: "child-1",
      toolCallId: "call-1",
      engine: "javascript-quickjs",
      isolation: "wasm-isolate",
      selectionReason: "language",
      status: "validating",
      codeSha256: "a".repeat(64),
      startedAt: 1_000,
      terminationUnconfirmed: false,
    });
    expect(journal.get("exec_1")?.endedAt).toBeUndefined();
    expect(journal.get("missing")).toBeUndefined();
  });

  it("follows the diagrammed transitions and refuses the others without changing the row", async () => {
    const { journal } = await setup();
    journal.open(input());
    expect(() => journal.transition("exec_1", "running")).toThrow(InvalidTransitionError);
    expect(journal.get("exec_1")?.status).toBe("validating");
    toRunning(journal);
    journal.transition("exec_1", "collecting");
    expect(journal.get("exec_1")?.status).toBe("collecting");
  });

  it("refuses a transition to a terminal state: those go through close()", async () => {
    const { journal } = await setup();
    journal.open(input());
    expect(() => journal.transition("exec_1", "failed")).toThrow(/close/);
    expect(journal.get("exec_1")?.status).toBe("validating");
  });

  it("closes a terminal state once, with end time, error code and metrics", async () => {
    const { journal, clock } = await setup();
    journal.open(input());
    toRunning(journal);
    journal.transition("exec_1", "collecting");
    clock.now = 2_500;
    journal.close("exec_1", { status: "succeeded", metrics: { durationMs: 1500, toolCalls: 2 } });
    expect(journal.get("exec_1")).toMatchObject({
      status: "succeeded",
      endedAt: 2_500,
      metrics: { durationMs: 1500, toolCalls: 2 },
    });
    expect(() => journal.close("exec_1", { status: "failed", errorCode: "TIMEOUT" })).toThrow(
      InvalidTransitionError,
    );
    expect(journal.get("exec_1")).toMatchObject({ status: "succeeded", endedAt: 2_500 });
    expect(journal.get("exec_1")?.errorCode).toBeUndefined();
  });

  it("records a failure code and refuses a non-terminal status in close()", async () => {
    const { journal } = await setup();
    journal.open(input());
    expect(() => journal.close("exec_1", { status: "running" as never })).toThrow(/terminal/);
    journal.close("exec_1", { status: "failed", errorCode: "SCRIPT_SYNTAX" });
    expect(journal.get("exec_1")).toMatchObject({ status: "failed", errorCode: "SCRIPT_SYNTAX" });
  });

  it("walks a timeout through timed_out_pending and keeps terminationUnconfirmed", async () => {
    const { journal } = await setup();
    journal.open(input());
    toRunning(journal);
    journal.transition("exec_1", "timed_out_pending");
    journal.close("exec_1", {
      status: "timed_out",
      errorCode: "TIMEOUT",
      terminationUnconfirmed: true,
    });
    expect(journal.get("exec_1")).toMatchObject({
      status: "timed_out",
      errorCode: "TIMEOUT",
      terminationUnconfirmed: true,
    });
  });

  it("links an execution to an analysis execution when given one", async () => {
    const { store, journal } = await setup();
    store.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('an_1','s','r','/w','managed','running','x','analysis/jobs/a',1)`,
      )
      .run();
    journal.open(input({ analysisExecutionId: "an_1" }));
    expect(journal.get("exec_1")?.analysisExecutionId).toBe("an_1");
  });

  it("lists the executions of a root session by start time", async () => {
    const { journal, clock } = await setup();
    journal.open(input({ id: "late" }));
    clock.now = 500;
    journal.open(input({ id: "early" }));
    journal.open(input({ id: "other", rootSessionId: "root-2" }));
    expect(journal.listByRoot("root-1").map((e) => e.id)).toEqual(["early", "late"]);
  });
});

describe("forge execution journal: nested calls", () => {
  it("numbers nested call ids as `${toolCallId}:forge:${n}`", () => {
    expect(forgeCallId("call-1", 3)).toBe("call-1:forge:3");
  });

  it("records a call from start to end with its hash, never the input", async () => {
    const { journal } = await setup();
    journal.open(input());
    const callId = journal.startCall({
      executionId: "exec_1",
      n: 1,
      toolName: "read_file",
      effect: "read",
      inputSha256: "b".repeat(64),
    });
    expect(callId).toBe("call-1:forge:1");
    expect(journal.calls("exec_1")).toEqual([
      expect.objectContaining({ callId, status: "started", inputSha256: "b".repeat(64) }),
    ]);
    expect(journal.endCall("exec_1", callId, { status: "succeeded", durationMs: 12 })).toBe(true);
    expect(journal.calls("exec_1")[0]).toMatchObject({ status: "succeeded", durationMs: 12 });
    // A call ends once.
    expect(journal.endCall("exec_1", callId, { status: "failed", errorCode: "TOOL_FAILED" })).toBe(
      false,
    );
    expect(journal.calls("exec_1")[0]?.status).toBe("succeeded");
  });

  it("keeps paths only for the write effect (D-31)", async () => {
    const { journal } = await setup();
    journal.open(input());
    journal.startCall({
      executionId: "exec_1",
      n: 1,
      toolName: "write_file",
      effect: "write",
      inputSha256: "c".repeat(64),
      paths: ["src/a.ts", "src/b.ts"],
    });
    journal.startCall({
      executionId: "exec_1",
      n: 2,
      toolName: "read_file",
      effect: "read",
      inputSha256: "d".repeat(64),
      paths: ["src/a.ts"],
    });
    const [write, read] = journal.calls("exec_1");
    expect(write?.paths).toEqual(["src/a.ts", "src/b.ts"]);
    expect(read?.paths).toBeUndefined();
  });

  it("leaves in-flight calls `started` when the execution is cancelled (D-23b)", async () => {
    const { journal } = await setup();
    journal.open(input());
    toRunning(journal);
    journal.startCall({
      executionId: "exec_1",
      n: 1,
      toolName: "write_file",
      effect: "write",
      inputSha256: "e".repeat(64),
      paths: ["x.txt"],
    });
    journal.transition("exec_1", "cancelling");
    journal.close("exec_1", { status: "cancelled", errorCode: "CANCELLED" });
    expect(journal.get("exec_1")?.status).toBe("cancelled");
    expect(journal.calls("exec_1")[0]?.status).toBe("started");
  });

  it("returns calls in numeric order, not text order", async () => {
    const { journal } = await setup();
    journal.open(input());
    for (const n of [10, 2, 1])
      journal.startCall({
        executionId: "exec_1",
        n,
        toolName: "t",
        effect: "read",
        inputSha256: "f".repeat(64),
      });
    expect(journal.calls("exec_1").map((c) => c.callId)).toEqual([
      "call-1:forge:1",
      "call-1:forge:2",
      "call-1:forge:10",
    ]);
  });
});

describe("forge restart reconciliation (FJ-AC-25)", () => {
  it("fails every non-terminal execution of a dead owner as interrupted and never relaunches", async () => {
    const { store, journal, clock } = await setup();
    const states = [
      "validating",
      "preparing",
      "running",
      "cancelling",
      "timed_out_pending",
      "collecting",
    ] as const;
    for (const [index, state] of states.entries()) {
      const id = `exec_${state}`;
      journal.open(input({ id, toolCallId: `c${index}` }));
      const path: Record<string, string[]> = {
        validating: [],
        preparing: ["preparing"],
        running: ["preparing", "running"],
        cancelling: ["preparing", "running", "cancelling"],
        timed_out_pending: ["preparing", "running", "timed_out_pending"],
        collecting: ["preparing", "running", "collecting"],
      };
      for (const step of path[state] ?? []) journal.transition(id, step as never);
    }
    journal.open(input({ id: "done", toolCallId: "cd" }));
    clock.now = 1_100;
    journal.close("done", { status: "failed", errorCode: "SCRIPT_SYNTAX" });

    clock.now = 9_000;
    const count = reconcileInterruptedExecutions(store.db, {
      now: () => clock.now,
      isAlive: () => false,
    });
    expect(count).toBe(states.length);
    for (const state of states)
      expect(journal.get(`exec_${state}`)).toMatchObject({
        status: "failed",
        errorCode: "ISOLATE_FAILURE",
        endedAt: 9_000,
        metrics: { reason: "interrupted" },
      });
    expect(journal.get("done")).toMatchObject({
      status: "failed",
      errorCode: "SCRIPT_SYNTAX",
      endedAt: 1_100,
    });
    // Idempotent: nothing left to reconcile.
    expect(
      reconcileInterruptedExecutions(store.db, { now: () => 9_500, isAlive: () => false }),
    ).toBe(0);
  });

  it("leaves executions owned by a live process alone", async () => {
    const { store, journal } = await setup();
    journal.open(input({ id: "mine", toolCallId: "m" }));
    const count = reconcileInterruptedExecutions(store.db, { isAlive: () => true });
    expect(count).toBe(0);
    expect(journal.get("mine")?.status).toBe("validating");
  });

  it("reconciles rows with no recorded owner", async () => {
    const { store, journal } = await setup();
    journal.open(input({ id: "orphan" }));
    store.db.exec("UPDATE forge_executions SET owner_pid=NULL");
    expect(reconcileInterruptedExecutions(store.db, { isAlive: () => true })).toBe(1);
    expect(journal.get("orphan")?.status).toBe("failed");
  });
});
