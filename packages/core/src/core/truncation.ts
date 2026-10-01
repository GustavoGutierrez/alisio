import { OUTPUT_TRUNCATED_CODE, type RunTruncationInfo, type ToolCall } from "@alisio/sdk";
import { describeOutputLimitSource } from "./output-limit.ts";

/**
 * Recovery from a model response that the output-token limit (`limits.maxOutputTokens`) cut
 * off before it was usable. Provider-agnostic: the runner decides from the completed message
 * (`truncated: true`) or from the typed `OutputTruncatedError` signal, never from SDK types.
 */

/** The run failed because every response was cut off; carries the numbers for the UIs. */
export class RunTruncationError extends Error {
  readonly code = OUTPUT_TRUNCATED_CODE;
  readonly info: RunTruncationInfo;
  constructor(info: RunTruncationInfo) {
    super(describeTruncation(info));
    this.name = "RunTruncationError";
    this.info = info;
  }
}

/** Plain-text failure message (TUI, headless, logs). English only; the web localizes it. */
export function describeTruncation(info: RunTruncationInfo): string {
  const who = info.model ? `The model ${info.model}` : "The model";
  const times = info.attempts === 1 ? "once" : `${info.attempts} times`;
  return (
    `${who} was cut off ${times} by the output-token limit (${info.maxOutputTokens} tokens, ${describeOutputLimitSource(info.source)}) ` +
    "before it produced a usable response, so the run was stopped. " +
    "Raise limits.maxOutputTokens (/settings or the config file), lower the reasoning effort (/effort), " +
    "or ask for the result in smaller parts."
  );
}

/**
 * COMPATIBILITY: provider plugins published before the typed signal (for example
 * `@alisio/plugin-deepseek` 0.1.1) throw a plain `Error` with this text when a response is cut
 * off before any visible text. It is the only place the text is matched; new providers should
 * yield `completed` with `truncated: true` or throw `OutputTruncatedError` from `@alisio/sdk`.
 */
const LEGACY_TRUNCATION_TEXT = "cut off by max output tokens before any usable content";

/** Whether a provider failure means "the response was cut off by the output-token limit". */
export function isOutputTruncationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, message } = error as { code?: unknown; message?: unknown };
  return (
    code === OUTPUT_TRUNCATED_CODE ||
    (typeof message === "string" && message.includes(LEGACY_TRUNCATION_TEXT))
  );
}

/**
 * Whether a tool call of a truncated response cannot be trusted: missing id or name, or
 * arguments that are not a complete JSON object. Empty arguments only count as incomplete for
 * the LAST call (the one being streamed when the limit hit); an earlier call with no arguments
 * is how a provider reports a call without parameters.
 */
export function incompleteCalls(calls: ToolCall[]): boolean {
  return calls.some((call, index) => {
    if (!call.id || !call.name) return true;
    const raw = call.arguments.trim();
    if (!raw) return index === calls.length - 1;
    try {
      const parsed: unknown = JSON.parse(raw);
      return typeof parsed !== "object" || parsed === null || Array.isArray(parsed);
    } catch {
      return true;
    }
  });
}

/** What the model is told on the request that follows a truncated response. */
export const TRUNCATION_NOTICE =
  "Your previous reply was cut off by the output-token limit, so it was discarded. " +
  "Do not repeat what you already produced. Work in smaller steps: write long files in several parts " +
  "(for example save the script or data to files in several tool calls, or build the dashboard with " +
  "the compact alisio_runtime.html and svg helpers), keep your reasoning short, and continue from where you stopped.";

const EFFORT_RANK = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * One step below `current` among the model's supported levels, or `undefined` when that cannot
 * be decided cleanly (unknown level names, no current level, or already the lowest).
 */
export function lowerEffort(
  current: string | undefined,
  supported: readonly string[] | undefined,
): string | undefined {
  if (!current || !supported?.length) return undefined;
  const rank = (level: string) => EFFORT_RANK.indexOf(level);
  if (rank(current) < 0 || supported.some((level) => rank(level) < 0)) return undefined;
  const lower = [...supported].filter((level) => rank(level) < rank(current));
  lower.sort((a, b) => rank(b) - rank(a));
  return lower[0];
}
