import type { RunTimeoutInfo } from "@alisio/sdk";

/** A run stopped by a time limit; the message says which limit, which model and what to do. */
export class RunTimeoutError extends Error {
  readonly info: RunTimeoutInfo;
  constructor(info: RunTimeoutInfo) {
    super(describeTimeout(info));
    this.name = "RunTimeoutError";
    this.info = info;
  }
}

/** `AbortSignal.timeout` aborts with a `TimeoutError`; an explicit `abort()` does not. */
export function isTimeoutReason(reason: unknown): boolean {
  return (
    typeof reason === "object" &&
    reason !== null &&
    (reason as { name?: unknown }).name === "TimeoutError"
  );
}

/**
 * A short, human label for a provider id: the host of an OpenAI-compatible endpoint
 * (`openai-compatible:chat:https://api.example.com/v1` → `api.example.com`), else the id itself.
 */
export function providerLabel(id: string | undefined): string | undefined {
  if (!id) return undefined;
  const url = /(https?:\/\/[^\s]+)/.exec(id)?.[1];
  if (url)
    try {
      return new URL(url).host;
    } catch {
      /* fall through to the raw id */
    }
  return id;
}

const seconds = (ms: number) => Math.round(ms / 1000);

/** Plain-text message of a timeout (TUI, headless, logs, the `runs.error` column). English only. */
export function describeTimeout(info: RunTimeoutInfo): string {
  const who = info.model
    ? `The model ${info.model}${info.provider ? ` (${info.provider})` : ""}`
    : "The model";
  const limit = `${seconds(info.ms)} s`;
  if (info.kind === "first_token")
    return (
      `${who} sent nothing within ${limit} of the request, so the run was stopped. ` +
      "Retry, switch to another model, or raise or disable limits.firstTokenTimeoutMs (0 disables it)."
    );
  if (info.stage === "waiting_model")
    return info.firstRequest
      ? `${who} did not respond within ${limit}: no tokens were received. ` +
          "Retry, switch to another model, or raise limits.timeoutMs."
      : `The run reached its ${limit} limit while waiting for ${info.model ? `the model ${info.model}` : "the model"}` +
          `${info.provider ? ` (${info.provider})` : ""}. ` +
          "Everything produced so far is kept: prompt again to continue, switch model, or raise limits.timeoutMs.";
  const doing =
    info.stage === "tool" && info.tool
      ? `while running ${info.tool}`
      : info.stage === "streaming"
        ? "while the model was answering"
        : "";
  return (
    `The run reached its ${limit} limit${doing ? ` ${doing}` : ""}. ` +
    "Everything produced so far is kept: prompt again to continue, or raise limits.timeoutMs."
  );
}
