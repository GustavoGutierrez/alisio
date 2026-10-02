/**
 * Per-viewer state of the terminal UI that is not configuration: the last version whose changelog
 * the user has been told about (`lastSeenVersion`). Stored next to the session database as
 * `tui-state.json`; every failure (read-only disk, corrupt file) is swallowed, because a missing
 * notice must never break the terminal.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ViewerState {
  lastSeenVersion?: string;
}

export const viewerStateFile = (stateDir: string): string => join(stateDir, "tui-state.json");

export async function readViewerState(stateDir: string): Promise<ViewerState> {
  try {
    const parsed = JSON.parse(await readFile(viewerStateFile(stateDir), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const version = (parsed as { lastSeenVersion?: unknown }).lastSeenVersion;
    return typeof version === "string" && version.length <= 100 ? { lastSeenVersion: version } : {};
  } catch {
    return {};
  }
}

/** Merges `patch` into the stored state with an atomic replace; returns whether it was saved. */
export async function writeViewerState(
  stateDir: string,
  patch: Partial<ViewerState>,
): Promise<boolean> {
  try {
    const file = viewerStateFile(stateDir);
    const next = { ...(await readViewerState(stateDir)), ...patch };
    await mkdir(dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(next)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    return true;
  } catch {
    return false;
  }
}
