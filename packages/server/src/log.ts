/** Structured JSON-per-line logs to stderr (RNF-13). No OpenTelemetry. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

export interface LogFields {
  correlationId?: string;
  sessionId?: string;
  runId?: string;
  route?: string;
  status?: number;
  ms?: number;
  [key: string]: unknown;
}

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

/** Parses `ALISIO_LOG_LEVEL`; anything unknown falls back to `info`. */
export function logLevel(value = process.env.ALISIO_LOG_LEVEL): LogLevel {
  return value && value in ORDER ? (value as LogLevel) : "info";
}

/** A logger that writes one JSON object per line through `write` (stderr by default). */
export function createLogger(
  level: LogLevel = logLevel(),
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const emit =
    (at: Exclude<LogLevel, "silent">) =>
    (msg: string, fields: LogFields = {}) => {
      if (ORDER[at] < ORDER[level]) return;
      try {
        write(`${JSON.stringify({ ts: new Date().toISOString(), level: at, msg, ...fields })}\n`);
      } catch {
        /* Logging never breaks a request. */
      }
    };
  return { debug: emit("debug"), info: emit("info"), warn: emit("warn"), error: emit("error") };
}
