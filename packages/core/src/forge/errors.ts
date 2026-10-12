/**
 * Forja error codes and the error type that carries them. Pure: no I/O. The Python specification
 * adds its own codes with the same shape.
 */
export const FORGE_ERROR_CODES = [
  "INVALID_INPUT",
  "ENGINE_UNAVAILABLE",
  "SCRIPT_SYNTAX",
  "SCRIPT_RUNTIME",
  "PERMISSION_DENIED",
  "APPROVAL_REQUIRED",
  "TOOL_UNAVAILABLE",
  "TOOL_INPUT_INVALID",
  "TOOL_FAILED",
  "BUDGET_EXCEEDED",
  "OUTPUT_LIMIT",
  "MEMORY_LIMIT",
  "STACK_LIMIT",
  "TIMEOUT",
  "CANCELLED",
  "STATE_CONFLICT",
  "PROTOCOL_VIOLATION",
  "UNRESOLVABLE_PROMISE",
  "ISOLATE_FAILURE",
  /** Python: the artifact publisher refused the files the script left (symlink, size, count). */
  "PUBLICATION_REJECTED",
] as const;

export type ForgeErrorCode = (typeof FORGE_ERROR_CODES)[number];

/** Points the model at the guide topic that explains how to recover from an error. */
export interface GuideHint {
  topic: string;
  reason: string;
}

/**
 * The one-line pointer the model reads (spec §8.4): the reason and the guide topic to call, never the
 * guide itself. An anchor (`js.patterns#filtering`) names a section of the topic.
 */
export function renderHint(hint: GuideHint): string {
  const [topic = hint.topic, anchor] = hint.topic.split("#");
  return `${hint.reason} (forge_guide topic "${topic}"${anchor ? `, section #${anchor}` : ""})`;
}

export class ForgeError extends Error {
  readonly code: ForgeErrorCode;
  readonly hint?: GuideHint;
  constructor(code: ForgeErrorCode, message: string, options: { hint?: GuideHint } = {}) {
    super(message);
    this.name = "ForgeError";
    this.code = code;
    if (options.hint) this.hint = options.hint;
  }
}

export function isForgeError(value: unknown): value is ForgeError {
  return value instanceof ForgeError;
}
