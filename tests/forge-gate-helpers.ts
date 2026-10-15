/**
 * Shared fixture for the Forja gate tests (characterization of the runner's call gate and of
 * `execute`, then the extracted `decideEffect` and the nested-call dispatcher): an `AgentRunner`
 * over a real SQLite store whose scripted provider issues the tool calls a test asks for.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ToolCall, ToolDefinition } from "@alisio/sdk";
import type {
  ApprovalDecision,
  ApprovalRequest,
  CapabilityGate,
  Policy,
} from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import {
  AgentRunner,
  type RunnerOptions,
  type RunOptions,
} from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

export interface ScriptedCall {
  name: string;
  arguments?: Record<string, unknown>;
}

export interface ToolOutcome {
  name: string;
  isError: boolean;
  text: string;
}

export const effectTool = (
  name: string,
  effect: ToolDefinition["effect"],
  extra: Partial<ToolDefinition> = {},
  onRun?: () => void,
): ToolDefinition => ({
  name,
  description: name,
  inputSchema: { type: "object", properties: {} },
  ...(effect ? { effect } : {}),
  async execute() {
    onRun?.();
    return { content: [{ type: "text", text: `ran ${name}` }] };
  },
  ...extra,
});

export interface GateFixtureOptions {
  policy: Policy;
  /** `false`: the runner has no approval handler at all (headless, `--read-only`). */
  approve?: false | ((request: ApprovalRequest) => ApprovalDecision);
  tools?: ToolDefinition[];
  capabilities?: CapabilityGate;
  /** Built with the fixture's workspace root, which exists only once the fixture does. */
  pathAccess?: (root: string) => NonNullable<RunnerOptions["pathAccess"]>;
  readConcurrency?: number;
  onEvent?: RunnerOptions["onEvent"];
  /** Builds the Proof recorder over the fixture's store (spec 011, phase 2). */
  proof?: (store: SQLiteStore) => NonNullable<RunnerOptions["proof"]>;
  /** The text of the final assistant message (default "done"). */
  finalText?: string;
}

/** A runner whose provider plays one scripted turn of tool calls and then finishes. */
export async function gateFixture(options: GateFixtureOptions) {
  const root = await mkdtemp(join(tmpdir(), "alisio-gate-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  const asked: ApprovalRequest[] = [];
  const ran: string[] = [];
  for (const tool of options.tools ?? []) {
    const original = tool.execute.bind(tool);
    registry.register({
      ...tool,
      async execute(input, context) {
        ran.push(tool.name);
        return original(input, context);
      },
    });
  }
  let pending: ScriptedCall[] = [];
  let turn = 0;
  let callId = 0;
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    async *stream() {
      const calls: ToolCall[] =
        turn++ === 0
          ? pending.map((c) => ({
              id: `c${++callId}`,
              name: c.name,
              arguments: JSON.stringify(c.arguments ?? {}),
            }))
          : [];
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: calls.length ? "" : (options.finalText ?? "done"),
          calls,
        },
      };
    },
  };
  const approve = options.approve;
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: options.policy,
    ...(approve === false
      ? {}
      : {
          approve: async (request: ApprovalRequest) => {
            asked.push(request);
            return approve ? approve(request) : "once";
          },
        }),
    ...(options.capabilities ? { capabilities: options.capabilities } : {}),
    ...(options.pathAccess ? { pathAccess: options.pathAccess(root) } : {}),
    ...(options.readConcurrency ? { readConcurrency: options.readConcurrency } : {}),
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
    ...(options.proof ? { proof: options.proof(store) } : {}),
  });
  const session = store.create(root, "test", "m").id;
  return {
    runner,
    store,
    registry,
    root,
    session,
    asked,
    ran,
    /** Plays `calls` as one assistant turn and returns what each call answered, in order. */
    async play(
      calls: ScriptedCall[],
      run: RunOptions = {},
      signal: AbortSignal = new AbortController().signal,
    ) {
      const sessionId = session;
      pending = calls;
      turn = 0;
      const before = store.messages(sessionId).length;
      try {
        await runner.run(sessionId, "go", signal, run);
      } catch (error) {
        // A cancelled run rejects with its abort reason; that is the outcome under test.
        if (!signal.aborted) throw error;
      }
      const outcomes: ToolOutcome[] = [];
      for (const m of store.messages(sessionId).slice(before))
        if (m.role === "tool")
          outcomes.push({
            name: calls[outcomes.length]?.name ?? "",
            isError: m.result.isError ?? false,
            text: m.result.content.map((p) => (p.type === "text" ? p.text : "")).join(""),
          });
      return outcomes;
    },
    /** Journal status of a call of the session (`pending` means "uncertain outcome"). */
    callStatus(callId: string): string | undefined {
      const row = store.db
        .prepare("SELECT status FROM tool_calls WHERE session=? AND call_id=?")
        .get(session, callId) as { status: string } | null;
      return row?.status;
    },
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
