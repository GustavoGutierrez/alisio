/**
 * The kernel as Python uses it (Python spec §4, P2): a caller-made selection, no tool-call port, no
 * Forja slot, trusted limit overrides, the link to the analysis execution and the engine's own
 * `collect` step before the shared state is committed. A fake engine stands in for Python; the
 * kernel, journal, state store and registry are the real ones.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EngineDescriptor, ForgeProgress } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteExecutionJournal } from "../packages/core/src/forge/journal.ts";
import { ExecutionKernel, type KernelInvocation } from "../packages/core/src/forge/kernel.ts";
import type {
  EngineOutcome,
  ExecutionEngine,
  KernelChannel,
  PreparedExecution,
} from "../packages/core/src/forge/ports.ts";
import { EngineRegistry } from "../packages/core/src/forge/registry.ts";
import { createJavaScriptSelector } from "../packages/core/src/forge/selector.ts";
import { SlotTable } from "../packages/core/src/forge/slots.ts";
import { SqliteStateStore } from "../packages/core/src/forge/state-store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

interface Behavior {
  run?: (channel: KernelChannel, prepared: PreparedExecution) => Promise<EngineOutcome>;
  collect?: (outcome: EngineOutcome) => Promise<EngineOutcome>;
  analysisExecutionId?: string;
}

const descriptor: EngineDescriptor = {
  id: "python-oci",
  language: "python",
  version: "fake",
  isolation: "os-container",
  ready: true,
  capabilities: {
    cooperativeInterrupt: false,
    hardTermination: true,
    hardMemoryLimit: true,
    networkDeniedByOS: true,
    toolCalls: false,
  },
};

function fakeEngine(behavior: Behavior) {
  const seen: { limits?: PreparedExecution["limits"]; payload?: unknown; collected: number } = {
    collected: 0,
  };
  const engine: ExecutionEngine = {
    id: "python-oci",
    describe: async () => descriptor,
    async prepare(request, ctx) {
      seen.limits = ctx.limits;
      seen.payload = request.payload;
      return {
        executionId: ctx.executionId,
        engine: "python-oci",
        limits: ctx.limits,
        ...(behavior.analysisExecutionId
          ? { analysisExecutionId: behavior.analysisExecutionId }
          : {}),
      };
    },
    run: async (prepared, channel) =>
      behavior.run ? behavior.run(channel, prepared) : { kind: "completed" },
    terminate: async () => ({ confirmed: true, method: "container-kill", elapsedMs: 0 }),
    async collect(_prepared, outcome) {
      seen.collected++;
      return behavior.collect ? behavior.collect(outcome) : outcome;
    },
    dispose: async () => {},
  };
  return { engine, seen };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function fixture(behavior: Behavior = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-kernel-py-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const journal = new SqliteExecutionJournal(store.db);
  const state = new SqliteStateStore(store.db);
  const engines = new EngineRegistry();
  const { engine, seen } = fakeEngine(behavior);
  await engines.register(engine);
  const slots = new SlotTable({ perSession: 1, perProcess: 1 });
  const kernel = new ExecutionKernel({
    engines,
    selector: createJavaScriptSelector(),
    journal,
    state,
    slots,
    config: () => ({ enabled: false, limits: {}, stateEnabled: true }),
  });
  cleanups.push(async () => {
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const session = store.create(root, "test", "m").id;
  const progress: ForgeProgress[] = [];
  const invoke = (extra: Partial<KernelInvocation> = {}, signal?: AbortSignal) =>
    kernel.execute({
      source: "print('hi')",
      language: "python",
      selection: { engine: "python-oci", reason: "analysis.runtime=oci" },
      call: {
        toolCallId: "call-1",
        session,
        rootSessionId: session,
        workspace: root,
        signal: signal ?? new AbortController().signal,
        permissionMode: "ask",
        allowAnalysis: true,
        allowProcess: true,
        emit: (event) => progress.push(event),
      },
      ...extra,
    });
  return { invoke, journal, state, slots, seen, progress, session, store };
}

describe("kernel with a caller-made selection (Python)", () => {
  it("runs the selected engine and records its descriptor and the reason in the journal and the result", async () => {
    const f = await fixture();
    const { result } = await f.invoke();
    expect(result).toMatchObject({
      status: "succeeded",
      engine: "python-oci",
      isolation: "os-container",
      selectionReason: "analysis.runtime=oci",
    });
    expect(f.journal.get(result.executionId)).toMatchObject({
      engine: "python-oci",
      isolation: "os-container",
      selectionReason: "analysis.runtime=oci",
      status: "succeeded",
    });
  });

  it("offers no tools: the guest's nested port is empty", async () => {
    const f = await fixture();
    await f.invoke();
    expect(f.seen.payload).toMatchObject({ catalogSize: 0 });
  });

  it("passes the engine's own payload next to the state snapshot", async () => {
    const f = await fixture();
    await f.invoke({ payload: { code: "x", backend: "oci" } });
    expect(f.seen.payload).toMatchObject({ code: "x", backend: "oci", state: {} });
  });

  it("applies trusted limit overrides after the merge, above the JavaScript maxima", async () => {
    const f = await fixture();
    await f.invoke({ limitOverrides: { timeoutMs: 900_000, maxSourceBytes: 1_000_000 } });
    expect(f.seen.limits).toMatchObject({ timeoutMs: 900_000, maxSourceBytes: 1_000_000 });
  });

  it("accepts a script over the JavaScript source limit when the core raised it", async () => {
    const f = await fixture();
    const big = "x".repeat(100_000);
    const refused = await f.invoke({ source: big });
    expect(refused.result.error?.code).toBe("INVALID_INPUT");
    const accepted = await f.invoke({ source: big, limitOverrides: { maxSourceBytes: 1_000_000 } });
    expect(accepted.result.status).toBe("succeeded");
  });

  it("takes no Forja slot, so a run inside a js_run of the same session is not refused", async () => {
    const f = await fixture();
    const release = f.slots.acquire(f.session);
    const { result } = await f.invoke();
    expect(result.status).toBe("succeeded");
    release();
  });

  it("links the journal row to the analysis execution the engine created", async () => {
    const f = await fixture({ analysisExecutionId: "exec_abc" });
    f.store.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,
           script_sha256,rel_dir,created_at) VALUES('exec_abc','s','s','w','managed','running','h','r',1)`,
      )
      .run();
    const { result } = await f.invoke();
    expect(f.journal.get(result.executionId)?.analysisExecutionId).toBe("exec_abc");
  });

  it("does not compute a JavaScript guide hint for a Python failure", async () => {
    const f = await fixture({
      run: async () => ({ kind: "failed", code: "TOOL_UNAVAILABLE", message: "x" }),
    });
    const { result } = await f.invoke();
    expect(result.status).toBe("failed");
    expect(result.error?.hint).toBeUndefined();
  });

  it("emits ForgeProgress for the phases and for guest progress, tagged with the Python engine", async () => {
    const f = await fixture({
      run: async (channel) => {
        await channel.receive({
          protocol: 1,
          type: "progress",
          seq: 0,
          payload: { message: "Training", completed: 1, total: 3 },
        });
        return { kind: "completed" };
      },
    });
    await f.invoke();
    expect(f.progress.every((p) => p.engine === "python-oci")).toBe(true);
    expect(f.progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["preparing", "running", "collecting"]),
    );
    expect(f.progress.find((p) => p.message === "Training")).toMatchObject({
      completed: 1,
      total: 3,
    });
  });
});

describe("the engine's collect step and the shared state", () => {
  const setState = (key: string, value: unknown) => async (channel: KernelChannel) => {
    await channel.receive({ protocol: 1, type: "state.set", seq: 0, payload: { key, value } });
    return { kind: "completed" } as const;
  };

  it("commits the state delta after a successful collection (FP-AC-19)", async () => {
    const f = await fixture({ run: setState("last", "ds_1") });
    await f.invoke();
    expect(f.state.snapshot(f.session).values).toEqual({ last: "ds_1" });
  });

  it("discards the delta when the script fails (FP-AC-20)", async () => {
    const f = await fixture({
      run: async (channel) => {
        await setState("last", "ds_1")(channel);
        return { kind: "failed", code: "SCRIPT_RUNTIME", message: "exit 1" };
      },
    });
    const { result } = await f.invoke();
    expect(result.status).toBe("failed");
    expect(f.state.snapshot(f.session).values).toEqual({});
  });

  it("discards the delta when the collection fails after a successful script", async () => {
    const f = await fixture({
      run: setState("last", "ds_1"),
      collect: async () => ({
        kind: "failed",
        code: "SCRIPT_RUNTIME",
        message: "publication rejected",
      }),
    });
    const { result } = await f.invoke();
    expect(result).toMatchObject({ status: "failed", error: { message: "publication rejected" } });
    expect(f.state.snapshot(f.session).values).toEqual({});
    expect(f.journal.get(result.executionId)?.status).toBe("failed");
  });

  it("collects a failed script too (publishOnError) but never commits its delta", async () => {
    const f = await fixture({
      run: async () => ({ kind: "failed", code: "SCRIPT_RUNTIME", message: "exit 3" }),
    });
    await f.invoke();
    expect(f.seen.collected).toBe(1);
  });

  it("does not collect when the host stopped the execution", async () => {
    const controller = new AbortController();
    const f = await fixture({
      run: async (channel) => {
        controller.abort(new Error("Cancelled"));
        // The kernel heard it synchronously: its own signal is already aborted.
        expect(channel.signal.aborted).toBe(true);
        return { kind: "failed", code: "ISOLATE_FAILURE", message: "stopped" };
      },
    });
    const { result } = await f.invoke({}, controller.signal);
    expect(result.status).toBe("cancelled");
    expect(f.seen.collected).toBe(0);
    expect(f.state.snapshot(f.session).values).toEqual({});
  });
});
