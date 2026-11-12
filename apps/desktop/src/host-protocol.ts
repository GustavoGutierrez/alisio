/**
 * Shutdown budget of Alisio Desktop, the one place these numbers are chosen. On quit the app sends
 * `{type: "shutdown"}` over IPC (works the same on Linux, macOS and Windows) and the host runs the
 * server's orderly close: in-flight runs settle, every workspace app closes, and the live process
 * registry SIGTERMs, then SIGKILLs, every command still running. That close is bounded by
 * `SERVER_CLOSE_BUDGET_MS` (8 s, `@alisio/server`). The host caps its whole shutdown at
 * `HOST_SHUTDOWN_CAP_MS` and then exits anyway; its `exit` hook kills what is still tracked. The
 * app waits `DESKTOP_SHUTDOWN_WAIT_MS` for the host to exit and only then falls back to killing it:
 * the host's process tree on Windows (`taskkill /T /F`), SIGTERM (the host then exits at once and
 * its exit hook kills the command groups) and SIGKILL after `DESKTOP_FORCE_GRACE_MS` on POSIX.
 * After the fallback it waits at most `DESKTOP_KILL_WAIT_MS` more, so quitting stays bounded.
 * `tests/desktop-host-lifecycle.test.ts` keeps server budget < host cap < app wait.
 */
export const HOST_SHUTDOWN_CAP_MS = 9_000;
export const DESKTOP_SHUTDOWN_WAIT_MS = 10_000;
export const DESKTOP_FORCE_GRACE_MS = 1_000;
export const DESKTOP_KILL_WAIT_MS = 2_000;

/** Messages the Electron main process sends to the host over IPC. */
export type AppMessage = { type: "shutdown" };

/** Whether an untrusted IPC value is the app's shutdown request. */
export function isShutdownRequest(value: unknown): boolean {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as Record<string, unknown>).type === "shutdown"
  );
}

/** Messages the host process sends to the Electron main process (IPC, or one JSON stdout line). */
export type HostMessage = { type: "ready"; launchUrl: string } | { type: "error"; message: string };

const MAX_MESSAGE_CHARS = 1_000;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Whether `value` is an http URL on the local loopback: the only thing the window may load. */
export function isLoopbackHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" && LOOPBACK.has(url.hostname);
  } catch {
    return false;
  }
}

/** Validates an untrusted value received from the host; `undefined` when it is not a message. */
export function parseHostMessage(value: unknown): HostMessage | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.type === "ready")
    return isLoopbackHttpUrl(record.launchUrl)
      ? { type: "ready", launchUrl: record.launchUrl }
      : undefined;
  if (record.type === "error" && typeof record.message === "string")
    return { type: "error", message: record.message.slice(0, MAX_MESSAGE_CHARS) };
  return undefined;
}

/** Parses one stdout line (the fallback channel); non-JSON noise yields `undefined`. */
export function parseHostLine(line: string): HostMessage | undefined {
  try {
    return parseHostMessage(JSON.parse(line));
  } catch {
    return undefined;
  }
}
