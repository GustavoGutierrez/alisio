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
