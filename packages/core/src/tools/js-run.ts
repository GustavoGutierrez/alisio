/**
 * `js_run` (spec §6.1, D6, D-23, D-30): runs a JavaScript script in the isolated QuickJS-WASM
 * engine. It is a thin adapter: it validates the input, reads `codePath` from the scratchpad and
 * hands everything to the `ExecutionKernel`, then renders the `ForgeResult` for the model.
 *
 * Declared `read` and `concurrent: false` on purpose. The script has no effects of its own; every
 * effect happens in a nested call that passes the run's gate with ITS effect (D7). A run's
 * parallel read batch skips this tool (D-23a), and the kernel allows one active execution per
 * session. The nested-call port and the "left effects behind" flag come from the runner through
 * `callInternals`, which plugin tools cannot reach.
 */
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join } from "node:path";
import {
  type PermissionMode,
  type ToolContext,
  type ToolDefinition,
  type ToolResult,
} from "@alisio/sdk";
import { callInternals } from "../core/call-internals.ts";
import type { Policy } from "../core/contracts.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { ForgeError, isForgeError } from "../forge/errors.ts";
import type { ExecutionKernel } from "../forge/kernel.ts";
import { MAX_FORGE_LIMITS } from "../forge/limits.ts";
import { type ForgeResult, renderForgeResult } from "../forge/result.ts";
import { resolveScratchPath } from "../forge/session-dir.ts";

export const JS_RUN_DESCRIPTION =
  "Run JavaScript in an isolated QuickJS-WASM VM to combine tools and shape results (tools.call, " +
  "catalog, parallel, state; `return` a small JSON value). No imports, network or files; nested " +
  "calls use this session's permissions and never ask. Pass `code` or `codePath` (.js in the " +
  "scratchpad). See forge_guide.";

export const CODE_PATH_MAX_BYTES = 64 * 1024;

export interface JsRunDeps {
  kernel: ExecutionKernel;
  /** The root session of a session (its scratchpad, state and slots are keyed by it). */
  rootOf: (session: string) => string;
  /** The verified scratchpad of a session; undefined while there is none (or under --read-only). */
  scratchpad: (session: string) => Promise<string | undefined>;
  /** The run's live policy, to label the permission mode and the `--allow-*` flags. */
  policy: () => Policy;
}

const modeOf = (policy: Policy): PermissionMode =>
  policy.write && policy.process && policy.external ? "full" : policy.write ? "auto" : "ask";

const invalid = (message: string): ToolResult => ({
  content: [{ type: "text", text: `INVALID_INPUT: ${message}` }],
  isError: true,
});

/** The script's source from `code` or `codePath` (exactly one), or a reason it cannot be had. */
async function sourceOf(
  input: Record<string, unknown>,
  deps: JsRunDeps,
  session: string,
): Promise<string> {
  const hasCode = input.code !== undefined;
  const hasPath = input.codePath !== undefined;
  if (hasCode === hasPath)
    throw new ForgeError("INVALID_INPUT", "pass exactly one of `code` or `codePath`");
  if (hasCode) {
    if (typeof input.code !== "string")
      throw new ForgeError("INVALID_INPUT", "`code` must be a string");
    return input.code;
  }
  if (typeof input.codePath !== "string" || input.codePath === "")
    throw new ForgeError("INVALID_INPUT", "`codePath` must be a non-empty string");
  const pad = await deps.scratchpad(session);
  if (!pad)
    throw new ForgeError(
      "INVALID_INPUT",
      "`codePath` needs the session scratchpad, which is not available",
    );
  const path = await resolveScratchPath(pad, input.codePath);
  if (![".js", ".mjs"].includes(extname(path)))
    throw new ForgeError("INVALID_INPUT", "`codePath` must be a .js file inside the scratchpad");
  const info = await stat(path).catch(() => undefined);
  if (!info?.isFile())
    throw new ForgeError("INVALID_INPUT", `\`codePath\` does not name a file: ${input.codePath}`);
  if (info.size > CODE_PATH_MAX_BYTES)
    throw new ForgeError(
      "INVALID_INPUT",
      `\`codePath\` file is larger than ${CODE_PATH_MAX_BYTES} bytes`,
    );
  return readFile(path, "utf8");
}

export function registerJsRun(registry: ToolRegistry, deps: JsRunDeps): void {
  const tool: ToolDefinition = {
    name: "js_run",
    effect: "read",
    concurrent: false,
    description: JS_RUN_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        code: { type: "string", minLength: 1, maxLength: 65536 },
        title: { type: "string", maxLength: 120 },
        timeoutMs: { type: "integer", minimum: 100 },
        codePath: { type: "string", maxLength: 1024 },
      },
    },
    async execute(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
      const internals = callInternals(context);
      const session = context.session;
      if (!internals || !session || !context.callId)
        return invalid("js_run can only run inside an agent run");
      let source: string;
      try {
        source = await sourceOf(input, deps, session);
      } catch (error) {
        if (isForgeError(error)) return invalid(error.message);
        throw error;
      }
      const policy = deps.policy();
      const rootSessionId = deps.rootOf(session);
      const pad = await deps.scratchpad(session).catch(() => undefined);
      const outcome = await deps.kernel.execute({
        source,
        ...(typeof input.title === "string" ? { title: input.title } : {}),
        ...(typeof input.timeoutMs === "number"
          ? {
              requestedLimits: { timeoutMs: Math.min(input.timeoutMs, MAX_FORGE_LIMITS.timeoutMs) },
            }
          : {}),
        call: {
          toolCallId: context.callId,
          session,
          rootSessionId,
          workspace: context.workspace,
          signal: context.signal,
          permissionMode: modeOf(policy),
          allowAnalysis: !!policy.analysis,
          allowProcess: policy.process,
          dispatcher: internals.nested(),
          emit: (progress) => context.emit(progress),
          ...(pad ? { tasksDir: join(dirname(pad), "tasks") } : {}),
        },
      });
      // A cancelled run ends by throwing, like any tool interrupted by the user: the runner then keeps
      // a call that left effects pending for recovery (D-23b) and closes one that only read.
      if (outcome.result.status === "cancelled") throw new Error("js_run was cancelled");
      return toToolResult(outcome.result, outcome.maxOutputChars);
    },
  };
  registry.register(tool);
}

/** The ForgeResult as the model sees it. */
export function toToolResult(result: ForgeResult, maxChars: number): ToolResult {
  const rendered = renderForgeResult(result, maxChars);
  return {
    content: [{ type: "text", text: rendered.text }],
    ...(result.status === "succeeded" ? {} : { isError: true }),
  };
}
