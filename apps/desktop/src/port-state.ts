/**
 * A stable loopback port for the desktop host. Every per-viewer preference of the web UI lives in
 * the browser storage of its origin (`http://127.0.0.1:<port>`), so a new random port per launch
 * would start every launch with empty preferences. The host keeps the port of its first launch in
 * a small file under the app's user data and tries it first; when it is busy it binds a free port
 * for this launch only and keeps the saved one, so the next launch gets the old origin back.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const MIN_PORT = 1024;
const MAX_PORT = 65_535;

/** The saved port, or undefined when the file is missing, unreadable, corrupt or out of range. */
export function readSavedPort(file: string): number | undefined {
  try {
    const port = (JSON.parse(readFileSync(file, "utf8")) as { port?: unknown } | null)?.port;
    return Number.isInteger(port) && (port as number) >= MIN_PORT && (port as number) <= MAX_PORT
      ? (port as number)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Saves `port` atomically (0600); a failure only costs the stable origin, never the launch. */
function savePort(file: string, port: number): void {
  const temp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(temp, `${JSON.stringify({ port })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  } catch {
    // Not fatal: the next launch picks a port again.
    rmSync(temp, { force: true });
  }
}

const portBusy = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === "EADDRINUSE" ||
  (error as { code?: unknown } | null)?.code === "EACCES";

/**
 * Starts with the saved port; on EADDRINUSE/EACCES falls back to port 0 WITHOUT replacing the
 * saved port. Saves the bound port only when none was saved (first launch, missing or corrupt
 * file). Any other start failure is rethrown.
 */
export async function listenOnPreferredPort<T>(
  file: string,
  start: (port: number) => Promise<T>,
  boundPort: (started: T) => number,
): Promise<T> {
  const saved = readSavedPort(file);
  if (saved !== undefined) {
    try {
      return await start(saved);
    } catch (error) {
      if (!portBusy(error)) throw error;
      return start(0);
    }
  }
  const started = await start(0);
  const port = boundPort(started);
  if (Number.isInteger(port) && port >= MIN_PORT && port <= MAX_PORT) savePort(file, port);
  return started;
}
