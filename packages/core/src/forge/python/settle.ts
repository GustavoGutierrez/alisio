import type { TerminationReport } from "../ports.ts";
import type { RunningProcess } from "./backend.ts";

/** How long a stop waits for the process to be reported gone (the kill grace is 5 s). */
export const SETTLE_MS = 12_000;

/** Waits for an aborted process to settle and says whether that was confirmed in time. */
export async function settle(
  process: RunningProcess,
  method: TerminationReport["method"],
  started: number,
): Promise<TerminationReport> {
  const done = process.result.then(
    () => true,
    () => true,
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const confirmed = await Promise.race([
    done,
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), SETTLE_MS);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  return {
    confirmed,
    method,
    elapsedMs: Date.now() - started,
    ...(confirmed ? {} : { settled: done.then(() => undefined) }),
  };
}
