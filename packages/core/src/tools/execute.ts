/**
 * `execute` ("Code Mode"): runs a short JS snippet that can call other already-registered tools,
 * so the model combines/post-processes several tool calls without every intermediate result
 * re-entering its own context — only the snippet's final return value does.
 *
 * Honest scope, matching AGENTS.md's rule to never treat a subprocess or manifest as a sandbox:
 * this uses Node's `vm` module, which gives the snippet its own global object and V8 intrinsics
 * (no `require`, `process`, `fetch`, filesystem or timers unless explicitly added — and none are
 * added here), but it is **not a security boundary**. Node's own documentation is explicit about
 * this: "the vm module is not a security mechanism; do not use it to run untrusted code." A
 * sufficiently motivated attacker with V8 exploits, or a lucky garbage-collection timing bug,
 * could still escape it. It is a correctness/ergonomics sandbox (isolate a snippet's scope,
 * bound its running time, keep it from importing or shelling out directly), not an OS-level
 * one — the same trust model as the rest of Alisio's in-process tools.
 *
 * Nested tool calls run through the exact same effect/permission gate every other call uses (see
 * `allowedEffect`): a snippet can only reach a tool whose effect the current policy already
 * allows. It never gets to trigger a NEW interactive approval prompt from inside the sandbox —
 * that would risk a confusing, potentially deadlocking nested prompt — so an effect that would
 * otherwise need approval is denied outright here, never silently granted.
 */
import { createContext, Script } from "node:vm";
import type { Policy } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";

export const EXECUTE_TIMEOUT_MS = 10_000;
export const MAX_NESTED_CALLS = 20;

export interface ExecuteDeps {
  registry: ToolRegistry;
  policy: Policy;
  workspace: string;
  signal: AbortSignal;
  emit: (data: unknown) => void;
  session?: string;
  label?: string;
  /**
   * Non-interactive path resolver for nested calls: the snippet can only use directories this
   * session already has; it never triggers a new external-directory approval prompt.
   */
  resolvePath?: (path: string) => Promise<string>;
  /** Overrides `EXECUTE_TIMEOUT_MS`, mainly for tests. */
  timeoutMs?: number;
}
const allowedEffect = (policy: Policy, effect: string) =>
  effect === "read" || effect === "internal" || !!policy[effect as keyof Policy];

export async function runExecute(code: string, deps: ExecuteDeps): Promise<unknown> {
  let calls = 0;
  const controller = new AbortController();
  const onAbort = () => controller.abort(deps.signal.reason);
  if (deps.signal.aborted) controller.abort(deps.signal.reason);
  else deps.signal.addEventListener("abort", onAbort, { once: true });
  const nestedSignal = AbortSignal.any([deps.signal, controller.signal]);

  const callTool = async (name: unknown, input?: unknown): Promise<unknown> => {
    if (typeof name !== "string" || !name)
      throw new Error("callTool: name must be a non-empty string");
    if (name === "execute") throw new Error("callTool: execute cannot call itself");
    calls++;
    if (calls > MAX_NESTED_CALLS)
      throw new Error(`callTool: exceeded the limit of ${MAX_NESTED_CALLS} nested tool calls`);
    const tool = deps.registry.get(name); // throws "Unknown tool: <name>" when absent
    const effect = tool.effect ?? "external";
    if (!allowedEffect(deps.policy, effect))
      throw new Error(
        `callTool: capability denied for "${name}" (effect: ${effect}); execute cannot request ` +
          "new approvals, only use capabilities already allowed for this session",
      );
    const rawInput = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
    const validated = deps.registry.parse(name, JSON.stringify(rawInput));
    const result = await tool.execute(validated, {
      signal: nestedSignal,
      workspace: deps.workspace,
      emit: deps.emit,
      ...(deps.session ? { session: deps.session } : {}),
      ...(deps.label ? { label: deps.label } : {}),
      ...(deps.resolvePath ? { resolvePath: deps.resolvePath } : {}),
    });
    const text = result.content
      .filter((p) => p.type === "text")
      .map((c) => c.text)
      .join("\n");
    if (result.isError) throw new Error(text);
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  };

  // A fresh V8 context: its own global object and intrinsics, no Node globals injected (no
  // `require`, `process`, `Buffer`, `fetch`, `setTimeout`) — only `callTool` is exposed.
  const context = createContext(
    { callTool },
    { codeGeneration: { strings: false, wasm: false } }, // no eval()/new Function() from strings
  );
  let script: Script;
  try {
    script = new Script(`"use strict";\n(async () => {\n${code}\n})()`, {
      filename: "execute-snippet.js",
    });
  } catch (error) {
    throw new Error(
      `execute: snippet has a syntax error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const timeoutMs = deps.timeoutMs ?? EXECUTE_TIMEOUT_MS;
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => {
      controller.abort(new Error("execute: timed out"));
      reject(new Error(`execute: snippet exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    // `timeout` here only bounds the SYNCHRONOUS portion of starting the async function; the
    // outer `timeout` promise above is what actually bounds the awaited nested tool calls.
    const resultPromise = script.runInContext(context, { timeout: timeoutMs }) as Promise<unknown>;
    return await Promise.race([resultPromise, timeout]);
  } finally {
    deps.signal.removeEventListener("abort", onAbort);
  }
}
