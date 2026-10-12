/**
 * How many bytes a write into the scratchpad leaves in it (spec §9.4, FJ-AC-34), per tool. The
 * quota check needs the size the file WILL have, and only the tool knows its own semantics:
 * `write_file` stores `content`; `edit_file` replaces one occurrence, so the new size is the
 * current size minus `oldText` plus `newText`. A write-effect tool without an estimate here is not
 * let into the scratchpad without an approval (its size cannot be bounded beforehand).
 */
import { lstat } from "node:fs/promises";

const ESTIMATED: ReadonlySet<string> = new Set(["write_file", "edit_file"]);

/** Whether the quota can be enforced beforehand for this tool. */
export const hasScratchEstimator = (tool: string): boolean => ESTIMATED.has(tool);

const bytesOf = (value: unknown): number =>
  typeof value === "string" ? Buffer.byteLength(value) : 0;

/**
 * The bytes the file(s) will hold after the call: what `PathAccess.scratchQuotaProblem` takes as
 * `incomingBytes` (the current size of the replaced `targets` is subtracted there). A tool with no
 * estimator that a policy allowed anyway counts its `content` string, as before.
 */
export async function scratchIncomingBytes(
  tool: string,
  input: Record<string, unknown>,
  targets: readonly string[],
): Promise<number> {
  if (tool === "edit_file") {
    const target = targets[0];
    const current = target ? ((await lstat(target).catch(() => undefined))?.size ?? 0) : 0;
    return Math.max(0, current - bytesOf(input.oldText) + bytesOf(input.newText));
  }
  return bytesOf(input.content);
}
