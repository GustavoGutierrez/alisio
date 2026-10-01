/**
 * The output-token budget of one model request.
 *
 * Priority: a value the user set explicitly (`limits.maxOutputTokens` in any config layer,
 * `/settings`, a per-run option) always wins, even above the model's declared maximum (they asked
 * for it, and a provider that rejects it says so); otherwise the maximum the model's catalog
 * declares (`ModelInfo.maxOutputTokens`), capped at `MAX_AUTO_OUTPUT_TOKENS`; otherwise
 * `DEFAULT_MAX_OUTPUT_TOKENS`. The value is resolved for the model of each request, so switching
 * model within a session changes it.
 */

/** Output budget used when neither the user nor the model catalog says anything. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;
/**
 * Upper bound of a budget taken from a model's declared maximum. Catalogs declare the model's
 * hard limit (hundreds of thousands of tokens for some reasoning models), which is far more than
 * a single agent turn should be allowed to stream; an explicit user value is never capped by it.
 */
export const MAX_AUTO_OUTPUT_TOKENS = 65_536;

/** Where the effective budget came from. */
export type OutputLimitSource = "user" | "model" | "default";

export interface OutputLimit {
  value: number;
  source: OutputLimitSource;
}

const positive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 1;

export function resolveMaxOutputTokens(input: {
  /** Set by the user (config, settings or a per-run option); `undefined` when only defaulted. */
  explicit?: number | undefined;
  /** `ModelInfo.maxOutputTokens` of the model of the request, when its catalog declares one. */
  declared?: number | undefined;
  /** Used when nothing else applies; `DEFAULT_MAX_OUTPUT_TOKENS` unless the host knows better. */
  fallback?: number | undefined;
}): OutputLimit {
  if (positive(input.explicit)) return { value: Math.floor(input.explicit), source: "user" };
  if (positive(input.declared))
    return { value: Math.min(Math.floor(input.declared), MAX_AUTO_OUTPUT_TOKENS), source: "model" };
  return {
    value: positive(input.fallback) ? Math.floor(input.fallback) : DEFAULT_MAX_OUTPUT_TOKENS,
    source: "default",
  };
}

/** A short English phrase for messages and logs. */
export function describeOutputLimitSource(source: OutputLimitSource | undefined): string {
  if (source === "user") return "set by you";
  if (source === "model") return "from the model catalog";
  if (source === "default") return "default";
  return "current limit";
}
