/** Shared helpers of the reliability-lab engine tests: scripted providers and in-memory suites. */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  EvalRunRecord,
  EvalTask,
  ModelProvider,
  ProviderEvent,
  ToolCall,
  Usage,
} from "@alisio/sdk";
import type { LoadedSuite } from "../packages/core/src/eval/suite.ts";

export interface ScriptedTurn {
  text?: string;
  calls?: Array<{ name: string; args: Record<string, unknown> | string }>;
  usage?: Usage;
  /** Opaque provider continuation data carried on the assistant message. */
  providerData?: unknown[];
  /** Explicit tool-call ids (default `call-<turn>-<n>`). */
  callIds?: string[];
}

type Request = Parameters<ModelProvider["stream"]>[0];

/**
 * A provider that answers call N with `turns[N]` (the last turn repeats forever), without network.
 * `onCall` runs first and may throw or wait (use `request.signal`).
 */
export function scriptedProvider(
  turns: ScriptedTurn[],
  options: { onCall?: (request: Request, call: number) => Promise<void> | void } = {},
): ModelProvider & { requests: Request[] } {
  const requests: Request[] = [];
  return {
    id: "fake",
    model: "fake-model",
    requests,
    async *stream(request): AsyncGenerator<ProviderEvent> {
      const index = requests.length;
      requests.push(request);
      await options.onCall?.(request, index);
      const turn = turns[Math.min(index, turns.length - 1)] ?? {};
      const calls: ToolCall[] = (turn.calls ?? []).map((c, n) => ({
        id: turn.callIds?.[n] ?? `call-${index}-${n}`,
        name: c.name,
        arguments: typeof c.args === "string" ? c.args : JSON.stringify(c.args),
      }));
      if (turn.text) yield { type: "text_delta", delta: turn.text };
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: turn.text ?? "",
          calls,
          ...(turn.providerData ? { providerData: turn.providerData } : {}),
        },
        ...(turn.usage ? { usage: turn.usage } : {}),
      };
    },
  };
}

export const task = (overrides: Partial<EvalTask> = {}): EvalTask => ({
  id: "t1",
  prompt: "Do the thing",
  fixture: "fixtures/t1",
  budget: { maxTurns: 10, maxWallMs: 20_000 },
  policy: { mode: "auto" },
  verifiers: [],
  ...overrides,
});

/** Writes `files` under `<root>/suite/fixtures/<task.id>` and returns the loaded-suite shape. */
export function makeSuite(
  root: string,
  tasks: EvalTask[],
  files: Record<string, string> = {},
): LoadedSuite {
  const dir = join(root, "suite");
  const fixtureDirs: Record<string, string> = {};
  for (const t of tasks) {
    const fixture = join(dir, "fixtures", t.id);
    mkdirSync(fixture, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
      mkdirSync(dirname(join(fixture, path)), { recursive: true });
      writeFileSync(join(fixture, path), content);
    }
    fixtureDirs[t.id] = fixture;
  }
  return {
    suite: {
      schemaVersion: 1,
      suiteId: "demo",
      suiteVersion: "1.0.0",
      description: "demo",
      tasks,
    },
    dir,
    fixtureDirs,
  };
}

let counter = 0;
export function record(overrides: Partial<EvalRunRecord> = {}): EvalRunRecord {
  counter += 1;
  return {
    schemaVersion: 1,
    runId: `run-${counter}`,
    suiteId: "demo",
    suiteVersion: "1.0.0",
    taskId: "t1",
    repetition: 0,
    seed: 100,
    harnessVersion: "0.6.0",
    configHash: "sha256:aaa",
    provider: "fake",
    model: "fake-model",
    mode: "live",
    startedAt: 1,
    endedAt: 2,
    status: "pass",
    verifiers: [],
    measured: { inputTokens: 1000, outputTokens: 500, wallMs: 2000, turns: 3, toolCalls: 2 },
    incidents: [],
    ...overrides,
  };
}

/** `statuses` runs of one task, with wall times 1000, 2000, ... unless given. */
export function runsOf(
  taskId: string,
  statuses: EvalRunRecord["status"][],
  extra: (index: number) => Partial<EvalRunRecord> = () => ({}),
): EvalRunRecord[] {
  return statuses.map((status, index) =>
    record({
      taskId,
      status,
      repetition: index,
      measured: {
        inputTokens: 1000 * (index + 1),
        outputTokens: 100,
        wallMs: 1000 * (index + 1),
        turns: 2,
        toolCalls: 1,
      },
      ...extra(index),
    }),
  );
}
