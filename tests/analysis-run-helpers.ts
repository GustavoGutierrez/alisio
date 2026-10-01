/**
 * A runner with the real analysis tools over a temp state folder, for the phase 4 tests (OCI,
 * extras, rerun, retention): `python_run` calls go through `AgentRunner.runToolCall`, so they pass
 * the same capability gates as a model call. The interpreter is a fake (`fixtures/fake-python.mjs`
 * run by Node), so no Python, network or container engine is needed.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ModelProvider, RunEvent, ToolResult } from "@alisio/sdk";
import { CapabilityGrants } from "../packages/core/src/analysis/capabilities.ts";
import { DatasetService } from "../packages/core/src/analysis/data/datasets.ts";
import { AnalysisJobs } from "../packages/core/src/analysis/jobs.ts";
import { AnalysisRerun } from "../packages/core/src/analysis/rerun.ts";
import type { PythonResolution } from "../packages/core/src/analysis/runtime-manager.ts";
import { createArtifactPublisher } from "../packages/core/src/artifacts/publisher.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import type { ApprovalHandler, Policy } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  type AnalysisToolDeps,
  registerAnalysisTools,
} from "../packages/core/src/tools/analysis.ts";

export const FAKE_PYTHON = resolve("fixtures/fake-python.mjs");
export const FAKE_CONTAINER = resolve("fixtures/fake-container.mjs");

/** The script of a fake interpreter: `# fake: {...}` tells it what to write, print and return. */
export const fake = (plan: Record<string, unknown>) =>
  `# fake: ${JSON.stringify(plan)}\nprint("unused")\n`;

export const fakeInterpreter = async (): Promise<PythonResolution> => ({
  ok: true,
  executable: process.execPath,
  prefixArgs: [FAKE_PYTHON],
  version: "3.12.0",
  source: "python3",
});

const silent: ModelProvider = {
  id: "fake",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};

export interface AnalysisHarnessOptions {
  /** Overrides of the tool dependencies (container runtime, extras installer…). */
  deps?: Partial<AnalysisToolDeps>;
  approve?: ApprovalHandler;
  policy?: Partial<Policy>;
  /** The clock of the job and artifact stores. */
  now?: () => number;
}

export async function analysisHarness(options: AnalysisHarnessOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-analysis-"));
  const workspace = join(root, "ws");
  const state = join(root, "state");
  await mkdir(workspace, { recursive: true });
  const store = new SQLiteStore(join(state, "sessions.sqlite"));
  const artifacts = new ArtifactStore({
    root: state,
    db: store.db,
    ...(options.now ? { now: options.now } : {}),
  });
  const jobs = new AnalysisJobs({
    root: state,
    db: store.db,
    ...(options.now ? { now: options.now } : {}),
  });
  const datasets = new DatasetService({
    root: state,
    db: store.db,
    ...(options.now ? { now: options.now } : {}),
  });
  const rerun = new AnalysisRerun({ jobs, store: artifacts, datasets });
  const grants = new CapabilityGrants({ db: store.db, rootOf: (id) => store.rootOf(id) });
  const registry = new ToolRegistry();
  registerAnalysisTools(registry, {
    store: artifacts,
    jobs,
    runtime: { interpreter: fakeInterpreter },
    datasets,
    rerun,
    rootOf: (id) => store.rootOf(id),
    limits: { timeoutMs: 120_000, maxLogBytes: 1_000_000 },
    startup: { candidates: true, extras: [] },
    ...options.deps,
  });
  const events: RunEvent[] = [];
  const policy: Policy = {
    write: false,
    process: false,
    external: false,
    analysis: true,
    ...options.policy,
  };
  const runner = new AgentRunner({
    provider: silent,
    registry,
    store,
    context: { instructions: async () => "", beforePaths: async () => undefined },
    policy,
    workspace,
    ...(options.approve ? { approve: options.approve } : {}),
    capabilities: {
      granted: (capability, sessionId) => grants.granted(capability, sessionId),
      record: (input) => {
        grants.record({ ...input, workspace });
      },
      source: "tui",
      runtime: "managed",
      preview: async (input, sessionId) =>
        typeof input.rerunOf === "string"
          ? rerun.script(input.rerunOf, store.rootOf(sessionId))
          : undefined,
    },
    onEvent: (event) => events.push(event),
    artifacts: (call, announce) =>
      createArtifactPublisher(
        artifacts,
        {
          sessionId: call.sessionId,
          rootSessionId: store.rootOf(call.sessionId),
          workspace,
          runId: call.runId,
          callId: call.callId,
        },
        announce,
      ),
  });
  const session = store.create(workspace, "fake", "fake-model").id;
  const text = (result: ToolResult) =>
    result.content
      .filter((p) => p.type === "text")
      .map((p) => (p as { text: string }).text)
      .join("\n");
  return {
    root,
    state,
    workspace,
    store,
    artifacts,
    jobs,
    datasets,
    rerun,
    grants,
    runner,
    session,
    events,
    text,
    /** One `python_run` call of the session, through the gates of a model call. */
    async run(input: Record<string, unknown>, signal?: AbortSignal) {
      const { result } = await runner.runToolCall(session, "python_run", input, {
        ...(signal ? { signal } : {}),
      });
      return { result, text: text(result) };
    },
    executions: () =>
      store.db.prepare("SELECT * FROM analysis_executions ORDER BY created_at, id").all() as Array<
        Record<string, unknown>
      >,
    async dispose() {
      datasets.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export type AnalysisHarness = Awaited<ReturnType<typeof analysisHarness>>;
