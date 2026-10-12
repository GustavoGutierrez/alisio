/**
 * Shared fixture for the Forja kernel and engine tests: the real kernel, the real JavaScript
 * engine (QuickJS, a real worker or process host), a real SQLite journal and a real nested-call
 * dispatcher over a small tool registry. Only the tools and the model are test doubles.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeProgress, ToolDefinition } from "@alisio/sdk";
import type { Policy } from "../packages/core/src/core/contracts.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { JavaScriptEngine } from "../packages/core/src/forge/javascript/engine.ts";
import {
  type HostChoice,
  IsolateHostFactory,
} from "../packages/core/src/forge/javascript/hosts/factory.ts";
import { loadQuickJsModule } from "../packages/core/src/forge/javascript/wasm.ts";
import { SqliteExecutionJournal } from "../packages/core/src/forge/journal.ts";
import {
  ExecutionKernel,
  type KernelConfig,
  type KernelInvocation,
} from "../packages/core/src/forge/kernel.ts";
import type { ForgeLimits } from "../packages/core/src/forge/limits.ts";
import { createNestedDispatcher } from "../packages/core/src/forge/nested.ts";
import type { IsolateHost } from "../packages/core/src/forge/ports.ts";
import { EngineRegistry } from "../packages/core/src/forge/registry.ts";
import { createJavaScriptSelector } from "../packages/core/src/forge/selector.ts";
import { SlotTable } from "../packages/core/src/forge/slots.ts";
import { SqliteStateStore } from "../packages/core/src/forge/state-store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

export const fullPolicy: Policy = { write: true, process: true, external: true };
export const noPolicy: Policy = { write: false, process: false, external: false };

export interface KernelFixtureOptions {
  host?: HostChoice;
  /** A custom host (a scripted malicious guest). Overrides `host`. */
  isolateHost?: () => IsolateHost;
  tools?: ToolDefinition[];
  policy?: Policy;
  config?: Partial<KernelConfig>;
  limits?: Partial<ForgeLimits>;
  slots?: SlotTable;
}

/** A read tool that answers with `{ n }` after `delayMs` and tracks how many ran at once. */
export function probeTools() {
  let active = 0;
  let max = 0;
  const echo: ToolDefinition = {
    name: "echo",
    description: "Echo a number. Test tool.",
    effect: "read",
    inputSchema: {
      type: "object",
      properties: { n: { type: "number" }, delayMs: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    async execute(input) {
      active++;
      max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, Number(input.delayMs ?? 0)));
      active--;
      return { content: [{ type: "text", text: JSON.stringify({ n: input.n }) }] };
    },
  };
  return { echo, maxActive: () => max };
}

export async function kernelFixture(options: KernelFixtureOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "alisio-forge-kernel-"));
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const journal = new SqliteExecutionJournal(store.db);
  const stateStore = new SqliteStateStore(store.db);
  const registry = new ToolRegistry();
  for (const tool of options.tools ?? []) registry.register(tool);
  const engines = new EngineRegistry();
  const hosts = new IsolateHostFactory({
    choice: options.host ?? "worker",
    module: loadQuickJsModule,
  });
  const realEngine = new JavaScriptEngine({ hosts });
  const engine = options.isolateHost
    ? new JavaScriptEngine({
        hosts: {
          kind: "worker",
          create: async () => (options.isolateHost as () => IsolateHost)(),
        } as unknown as IsolateHostFactory,
      })
    : realEngine;
  await engines.register(engine);
  const slots = options.slots ?? new SlotTable();
  const kernel = new ExecutionKernel({
    engines,
    selector: createJavaScriptSelector(),
    journal,
    state: stateStore,
    slots,
    config: () => ({
      enabled: true,
      limits: options.limits ?? {},
      stateEnabled: true,
      ...options.config,
    }),
  });
  const session = store.create(root, "test", "m").id;
  let counter = 0;
  const progress: ForgeProgress[] = [];

  /** Runs a script as `js_run` would: its own parent call, nested calls through the real dispatcher. */
  const run = async (
    source: string,
    extra: {
      signal?: AbortSignal;
      requestedLimits?: Partial<ForgeLimits>;
      policy?: Policy;
      session?: string;
      approvals?: boolean;
      markEffectful?: () => void;
    } = {},
  ) => {
    const toolCallId = `call-${++counter}`;
    const signal = extra.signal ?? new AbortController().signal;
    const dispatcher = createNestedDispatcher({
      registry,
      policy: extra.policy ?? options.policy ?? fullPolicy,
      approvals: extra.approvals ?? false,
      workspace: root,
      session: extra.session ?? session,
      parentCallId: toolCallId,
      signal,
      markEffectful: extra.markEffectful ?? (() => {}),
    });
    const invocation: KernelInvocation = {
      source,
      ...(extra.requestedLimits ? { requestedLimits: extra.requestedLimits } : {}),
      call: {
        toolCallId,
        session: extra.session ?? session,
        rootSessionId: session,
        workspace: root,
        signal,
        permissionMode: "ask",
        allowAnalysis: false,
        allowProcess: false,
        dispatcher,
        emit: (event) => progress.push(event),
        tasksDir: join(root, "tasks"),
      },
    };
    return (await kernel.execute(invocation)).result;
  };

  return {
    run,
    kernel,
    journal,
    stateStore,
    store,
    registry,
    root,
    session,
    slots,
    progress,
    engine,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
