/** Render temp-dir janitor (spec 026 D20): removes leftovers older than one hour. */
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { DOCUMENT_LIMITS } from "./limits.ts";

export async function sweepDocumentTmp(
  root: string,
  now: number = Date.now(),
  maxAgeMs: number = DOCUMENT_LIMITS.tmpMaxAgeMs,
): Promise<number> {
  let removed = 0;
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const path = join(root, name);
    try {
      const info = await stat(path);
      if (now - info.mtimeMs > maxAgeMs) {
        await rm(path, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // best effort: another process may have removed it
    }
  }
  return removed;
}
