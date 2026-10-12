/**
 * Who decides how an execution ends (spec §5.2, D5). Pure: no I/O.
 *
 * The host's own stop (a user cancellation, or its deadline) decides the terminal state whatever
 * the guest said afterwards; a guest that merely noticed the same thing first reports the same
 * code; anything else keeps the guest's own outcome. A guest that says TIMEOUT or CANCELLED when
 * the host stopped nothing is only reporting a failure: the terminal states are the host's alone.
 */
import type { ForgeErrorCode } from "./errors.ts";
import type { EngineOutcome } from "./ports.ts";
import type { ForgeStatus } from "./result.ts";

export interface Verdict {
  status: ForgeStatus;
  error?: { code: ForgeErrorCode; message: string };
  value?: unknown;
}

const timedOut = (timeoutMs: number): Verdict => ({
  status: "timed_out",
  error: { code: "TIMEOUT", message: `Execution exceeded ${timeoutMs} ms` },
});
const cancelled = (): Verdict => ({
  status: "cancelled",
  error: { code: "CANCELLED", message: "Execution was cancelled" },
});

export function verdictOf(
  outcome: EngineOutcome,
  stop: "cancelled" | "timeout" | undefined,
  timeoutMs: number,
): Verdict {
  if (stop === "timeout") return timedOut(timeoutMs);
  if (stop === "cancelled") return cancelled();
  if (outcome.kind === "completed")
    return {
      status: "succeeded",
      ...(outcome.value !== undefined ? { value: outcome.value } : {}),
    };
  if (outcome.code === "TIMEOUT" || outcome.code === "CANCELLED")
    return {
      status: "failed",
      error: {
        code: "SCRIPT_RUNTIME",
        message: `the script reported ${outcome.code} on its own: ${outcome.message}`,
      },
    };
  return { status: "failed", error: { code: outcome.code, message: outcome.message } };
}
