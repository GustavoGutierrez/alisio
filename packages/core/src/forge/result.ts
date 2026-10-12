/**
 * The common result of a Forja execution (spec §5.3) and its compact text projection for the model.
 * Pure: no I/O. `status: "succeeded"` means the program finished, not that every nested call did;
 * `calls.failed` and `calls.denied` say the rest.
 */
import type { EngineId, IsolationLevel } from "@alisio/sdk";
import { type ForgeErrorCode, type GuideHint, renderHint } from "./errors.ts";
import type { ForgeOutputItem } from "./protocol.ts";

export type ForgeStatus = "succeeded" | "failed" | "cancelled" | "timed_out";

export interface ForgeResult {
  schemaVersion: 1;
  executionId: string;
  engine: EngineId;
  isolation: IsolationLevel;
  selectionReason: string;
  status: ForgeStatus;
  /** Text and JSON the script emitted explicitly, up to the retained-output limit. */
  output: ForgeOutputItem[];
  /** The script's `return` value. */
  value?: unknown;
  error?: { code: ForgeErrorCode; message: string; hint?: GuideHint };
  /** `failed` counts calls that errored; `denied` counts calls the permission gate refused. */
  calls: { total: number; failed: number; denied: number };
  /** What the model sees was cut to the output limit. */
  truncated: boolean;
  metrics: { wallMs: number; queueMs: number; outputBytes: number };
}

/** Cuts `text` to `max` characters on a character boundary; reports whether it did. */
export function clipText(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  let end = max;
  // Do not leave half of a surrogate pair at the cut.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), clipped: true };
}

/** The text of the emitted items, in order; JSON items are rendered as one line each. */
export function outputText(items: readonly ForgeOutputItem[]): string {
  return items
    .map((item) => (item.type === "text" ? item.text : JSON.stringify(item.value)))
    .join("");
}

/** Which guide topic explains how to recover from an error, when the cause is known. */
export function hintFor(code: ForgeErrorCode, message: string, source = ""): GuideHint | undefined {
  if (
    code === "SCRIPT_SYNTAX" &&
    (/\bimport\b|\brequire\b|\bexport\b/.test(message) ||
      /^\s*(import|export)\b|\brequire\s*\(/m.test(source))
  )
    return {
      topic: "js.api",
      reason: "imports and require are not available; call tools with tools.call",
    };
  if (code === "TOOL_UNAVAILABLE")
    return { topic: "js.tools", reason: "list the tools you can call with catalog.search" };
  if (code === "OUTPUT_LIMIT")
    return {
      topic: "js.patterns#filtering",
      reason: "filter, aggregate or paginate before returning data",
    };
  return undefined;
}

/** Where a Python failure with a known cause points the model (spec §8.4). */
export function pythonHintFor(code: "PACKAGE_UNAVAILABLE" | "RUNTIME_UNAVAILABLE"): GuideHint {
  return code === "PACKAGE_UNAVAILABLE"
    ? {
        topic: "python.environment",
        reason: "a package is missing in the backend that runs Python",
      }
    : {
        topic: "python.environment",
        reason: "no Python backend can run now; the guide lists the shortest fix",
      };
}

/**
 * The text the model receives. The value and the emitted output share the `maxChars` budget; the
 * rest of the report (status, calls, error) is small and always kept.
 */
export function renderForgeResult(
  result: ForgeResult,
  maxChars: number,
): { text: string; truncated: boolean } {
  const head = [`status: ${result.status}`];
  const tail = [
    `calls: ${result.calls.total} total, ${result.calls.failed} failed, ${result.calls.denied} denied`,
  ];
  let errorClipped = false;
  if (result.error) {
    // The message can come from the script (an error it threw): bound it like any other text.
    const message = clipText(result.error.message, maxChars);
    errorClipped = message.clipped;
    tail.push(`error: ${result.error.code}: ${message.text}`);
    if (message.clipped) tail.push(`[error message truncated at ${maxChars} characters]`);
    if (result.error.hint) tail.push(`hint: ${renderHint(result.error.hint)}`);
  }
  const body: string[] = [];
  if (result.value !== undefined) body.push(`value: ${JSON.stringify(result.value)}`);
  const emitted = outputText(result.output);
  if (emitted !== "") body.push(`output:\n${emitted}`);
  const clipped = clipText(body.join("\n"), maxChars);
  const lines = [...head];
  if (clipped.text !== "") lines.push(clipped.text);
  if (clipped.clipped)
    lines.push(
      `[output truncated at ${maxChars} characters; return less: filter, aggregate or paginate]`,
    );
  lines.push(...tail);
  return {
    text: lines.join("\n"),
    truncated: clipped.clipped || errorClipped || result.truncated,
  };
}
