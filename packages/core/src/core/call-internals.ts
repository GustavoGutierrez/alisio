/**
 * What only the core's own tools may do from inside a call (spec D-23, D-24): flag the running
 * call as `effectful` and reach the run's nested-call dispatcher. It is NOT part of the SDK
 * `ToolContext`: the runner binds it to the context object of a call in a module-private
 * `WeakMap`, so a plugin tool, which sees only the SDK type, has no property to find and no module
 * to import.
 */
import type { ToolContext } from "@alisio/sdk";
import type { NestedCallDispatcher } from "../forge/nested.ts";

export interface CallInternals {
  /**
   * Flags the running call: it may have left effects, so a cancellation must leave it pending for
   * recovery even though its own effect is `read`. Idempotent.
   */
  markEffectful(): void;
  /** The dispatcher for tool calls made from inside this call (built on first use). */
  nested(): NestedCallDispatcher;
}

const bound = new WeakMap<object, CallInternals>();

/** The runner binds the internals of a call to the context it hands the tool. */
export function bindCallInternals(context: ToolContext, internals: CallInternals): void {
  bound.set(context, internals);
}

/** The internals of the call this context belongs to; undefined for any other context. */
export function callInternals(context: ToolContext): CallInternals | undefined {
  return bound.get(context);
}
