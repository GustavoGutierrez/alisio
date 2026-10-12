/**
 * The nested-call port of Forja (spec D-24, D-29, §6.4): how a script running inside a `js_run`
 * call reaches other tools. A nested call is NOT a second permission system: it passes the same
 * gate a direct call of the run passes (the run's `toolFilter`, opt-in tools, the LIVE run policy
 * and `decideEffect`), with two differences that follow from "never open a new approval":
 * approvals and stored grants do not exist for it, and the answer to "would need to ask" is a
 * structured error instead of a prompt.
 *
 * The runner builds one dispatcher per tool call (`core/call-internals.ts`); the broker of Phase 3b
 * is its only consumer. Nothing here knows QuickJS.
 */
import type {
  ArtifactPublisher,
  ToolContext,
  ToolDecisions,
  ToolDefinition,
  ToolResult,
} from "@alisio/sdk";
import type { Policy } from "../core/contracts.ts";
import { OPT_IN_TOOLS, optInAllows } from "../core/opt-in.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { decideEffect, effectOf } from "../permissions/decide.ts";
import type { PathAccess } from "../runtime/access.ts";
import { type ForgeErrorCode, isForgeError } from "./errors.ts";
import { forgeCallId } from "./journal.ts";
import { hasScratchEstimator, scratchIncomingBytes } from "./scratch-quota.ts";

/**
 * Tools no script can reach in v1: Forja's own tools and `execute` (no recursion), the guide
 * (a model-facing tool), and the subagent tools (`task`, `task_wait` and `send_message` can wait
 * on a child session that is waiting for this very call: D-29), and `ask_user_question` (the only
 * tool that opens an interactive prompt; approvals and installs are already refused). Opt-in tools (`OPT_IN_TOOLS`) are
 * excluded as well.
 */
export const FORGE_EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "js_run",
  "forge_guide",
  "task",
  "task_wait",
  "send_message",
  "execute",
  // Opens an interactive prompt; a script has nobody to ask (D7: never a new approval or UI).
  "ask_user_question",
]);

export interface NestedCallStart {
  /** `${parentCallId}:forge:${n}`: the journal id of this call; never a `tool_calls` row. */
  nestedCallId: string;
  name: string;
  effect: string;
  /** Resolved absolute paths the tool declared (journaled for `write` calls, D-31). */
  paths: string[];
}

export interface NestedCallRequest {
  name: unknown;
  input?: unknown;
  /** Cancels this call; combined with the signal of the parent call. */
  signal?: AbortSignal;
  /** Runs once the call passed the gate, right before the tool executes. */
  onStart?: (start: NestedCallStart) => void;
}

export type NestedCallOutcome =
  | {
      ok: true;
      nestedCallId: string;
      effect: string;
      /** Text parts of the result, joined. */
      text: string;
      /** The text parsed as JSON when it is JSON, else the text. */
      value: unknown;
      result: ToolResult;
    }
  | {
      ok: false;
      nestedCallId: string;
      code: ForgeErrorCode;
      message: string;
      /** Known once the tool was found; lets the caller journal the failed attempt. */
      effect?: string;
    };

export interface NestedCallDispatcher {
  /** The tools a nested call can reach right now (what `catalog.search` lists). */
  catalog(): ToolDefinition[];
  /**
   * Whether the registry has a tool of this name, reachable or not. The only names a record or a
   * broadcast may carry: a name a script invented is never stored.
   */
  knows(name: string): boolean;
  call(request: NestedCallRequest): Promise<NestedCallOutcome>;
}

export interface NestedDispatcherDeps {
  registry: ToolRegistry;
  /** The run's live policy object; read at every call (a session approval widens it). */
  policy: Policy;
  /** Whether the run could open an approval for a direct call (only to tell the error apart). */
  approvals: boolean;
  /**
   * Whether a write confined to the scratchpad may run without an approval (default true). It is
   * false only for a run locked down on purpose (a child run with approvals turned off).
   */
  scratchWrites?: boolean;
  toolFilter?: (tool: ToolDefinition) => boolean;
  optInTools?: readonly string[];
  workspace: string;
  session: string;
  label?: string;
  runId?: string;
  /** The id of the parent tool call; artifacts and decisions are bound to it. */
  parentCallId: string;
  signal: AbortSignal;
  pathAccess?: PathAccess;
  artifacts?: ArtifactPublisher;
  decisions?: ToolDecisions;
  /** The run's guard (context changed, token budget spent): throws to refuse the call. */
  guard?: (effect: string) => void;
  /** Flags the parent call effectful; called when a non-read, non-internal call starts. */
  markEffectful: () => void;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function createNestedDispatcher(deps: NestedDispatcherDeps): NestedCallDispatcher {
  let counter = 0;

  /** The tool when this run lets a script reach it, else undefined (excluded, filtered, absent). */
  const reachable = (name: string): ToolDefinition | undefined => {
    if (FORGE_EXCLUDED_TOOLS.has(name) || OPT_IN_TOOLS.has(name)) return undefined;
    let tool: ToolDefinition;
    try {
      tool = deps.registry.get(name);
    } catch {
      return undefined;
    }
    if (deps.toolFilter && !deps.toolFilter(tool)) return undefined;
    if (!optInAllows(name, deps.optInTools)) return undefined;
    return tool;
  };

  const decide = (tool: ToolDefinition, approvals: boolean) =>
    decideEffect(deps.policy, tool, { approvals, capabilityGranted: false });

  const allInScratch = async (targets: string[]): Promise<boolean> => {
    const access = deps.pathAccess;
    if (!access || targets.length === 0) return false;
    const inside = await Promise.all(targets.map((t) => access.isScratchPath(t, deps.session)));
    return inside.every(Boolean);
  };

  return {
    knows(name) {
      try {
        deps.registry.get(name);
        return true;
      } catch {
        return false;
      }
    },

    catalog() {
      return deps.registry
        .list()
        .filter((tool) => reachable(tool.name) && decide(tool, false).kind === "allow");
    },

    async call(request) {
      const nestedCallId = forgeCallId(deps.parentCallId, ++counter);
      const fail = (code: ForgeErrorCode, message: string, effect?: string): NestedCallOutcome => ({
        ok: false,
        nestedCallId,
        code,
        message,
        ...(effect ? { effect } : {}),
      });
      const name = request.name;
      if (typeof name !== "string" || name === "")
        return fail("TOOL_UNAVAILABLE", "tool name must be a non-empty string");
      const tool = reachable(name);
      if (!tool) return fail("TOOL_UNAVAILABLE", `Tool "${name}" is not available from js_run`);
      const effect = effectOf(tool);

      const rawInput = request.input === undefined ? {} : request.input;
      if (!isPlainObject(rawInput))
        return fail("TOOL_INPUT_INVALID", "tool input must be a JSON object", effect);
      let input: Record<string, unknown>;
      try {
        input = deps.registry.parse(name, JSON.stringify(rawInput));
      } catch (error) {
        return fail("TOOL_INPUT_INVALID", messageOf(error), effect);
      }

      const signal = request.signal ? AbortSignal.any([deps.signal, request.signal]) : deps.signal;
      // Declared paths are resolved first, like a direct call, but can never ask for a directory.
      const resolved = new Map<string, string>();
      const targets: string[] = [];
      try {
        signal.throwIfAborted();
        if (deps.pathAccess)
          for (const declared of tool.paths?.(input) ?? [])
            if (!resolved.has(declared)) {
              const target = await deps.pathAccess.resolve(declared, {
                workspace: deps.workspace,
                session: deps.session,
                ...(deps.label ? { label: deps.label } : {}),
                signal,
                interactive: false,
              });
              resolved.set(declared, target);
              resolved.set(target, target);
              targets.push(target);
            }
      } catch (error) {
        if (signal.aborted) return fail("CANCELLED", "cancelled", effect);
        return fail("PERMISSION_DENIED", messageOf(error), effect);
      }

      try {
        deps.guard?.(effect);
      } catch (error) {
        return fail("PERMISSION_DENIED", messageOf(error), effect);
      }

      if (decide(tool, false).kind !== "allow") {
        // Same answer as a direct call: "would ask" is APPROVAL_REQUIRED, "never allowed" is denied.
        const direct = decide(tool, deps.approvals);
        // The scratchpad is an authorized write root: a write confined to it needs no approval,
        // also when nobody could be asked (headless).
        const scratchWrite =
          deps.scratchWrites !== false &&
          effect === "write" &&
          !tool.capability &&
          hasScratchEstimator(name) &&
          decide(tool, true).kind === "ask" &&
          (await allInScratch(targets));
        if (!scratchWrite)
          return direct.kind === "ask"
            ? fail(
                "APPROVAL_REQUIRED",
                `"${name}" needs approval (effect: ${effect}); a script cannot request one. ` +
                  "Call it directly or ask the user to allow it for this session.",
                effect,
              )
            : fail("PERMISSION_DENIED", `Capability denied: ${tool.capability ?? effect}`, effect);
      }

      // A write confined to the scratchpad is bound by its quota, however it was allowed. The check
      // and the write run under one lock, so parallel writes cannot all pass it (L1).
      let releaseScratch: (() => void) | undefined;
      try {
        if (effect === "write" && !tool.capability && (await allInScratch(targets))) {
          releaseScratch = await deps.pathAccess?.lockScratch(deps.session);
          const problem = await deps.pathAccess?.scratchQuotaProblem(
            deps.session,
            await scratchIncomingBytes(name, input, targets),
            targets,
          );
          if (problem) return fail("BUDGET_EXCEEDED", problem, effect);
        }

        // From here the tool may leave effects, even if the script is then cancelled.
        if (effect !== "read" && effect !== "internal") deps.markEffectful();
        request.onStart?.({ nestedCallId, name, effect, paths: targets });

        const context: ToolContext = {
          signal,
          workspace: deps.workspace,
          emit: () => {},
          session: deps.session,
          callId: deps.parentCallId,
          ...(deps.runId ? { runId: deps.runId } : {}),
          ...(deps.label ? { label: deps.label } : {}),
          ...(deps.artifacts ? { artifacts: deps.artifacts } : {}),
          ...(deps.decisions ? { decisions: deps.decisions } : {}),
          // A script can never open the installation prompt.
          approveInstall: async () => "deny",
          ...(deps.pathAccess
            ? {
                resolvePath: (path: string) => {
                  const known = resolved.get(path);
                  return known !== undefined
                    ? Promise.resolve(known)
                    : (deps.pathAccess as PathAccess).resolve(path, {
                        workspace: deps.workspace,
                        session: deps.session,
                        ...(deps.label ? { label: deps.label } : {}),
                        signal,
                        interactive: false,
                      });
                },
              }
            : {}),
        };
        let result: ToolResult;
        try {
          result = await tool.execute(input, context);
        } catch (error) {
          if (signal.aborted) return fail("CANCELLED", "cancelled", effect);
          return fail(isForgeError(error) ? error.code : "TOOL_FAILED", messageOf(error), effect);
        }
        const text = result.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        if (result.isError) return fail("TOOL_FAILED", text, effect);
        let value: unknown = text;
        try {
          value = JSON.parse(text);
        } catch {
          /* Not JSON: the text itself is the value. */
        }
        return { ok: true, nestedCallId, effect, text, value, result };
      } finally {
        releaseScratch?.();
      }
    },
  };
}
