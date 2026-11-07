/**
 * Staging area of uploaded plugin tarballs: `<stateHome>/tmp/plugin-uploads/<id>/plugin.tgz`.
 * Everything here is temporary: it is deleted after install, failure or cancel, and directories
 * older than an hour are swept at server start and before each upload.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "@alisio/core";

export const STAGING_MAX_AGE_MS = 60 * 60 * 1000;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const stagingRoot = (): string => join(stateHome(), "tmp", "plugin-uploads");
export const isStagingId = (value: string): boolean => ID.test(value);
export const stagingDir = (id: string): string => join(stagingRoot(), id);
export const stagingFile = (id: string): string => join(stagingDir(id), "plugin.tgz");

export async function createStaging(): Promise<{ id: string; dir: string; file: string }> {
  const id = randomUUID();
  await mkdir(stagingDir(id), { recursive: true, mode: 0o700 });
  return { id, dir: stagingDir(id), file: stagingFile(id) };
}

export async function removeStaging(id: string): Promise<void> {
  if (isStagingId(id)) await rm(stagingDir(id), { recursive: true, force: true });
}

/** Removes staging directories not touched for `maxAgeMs`; returns how many it removed. */
export async function sweepStaging(
  now = Date.now(),
  maxAgeMs = STAGING_MAX_AGE_MS,
): Promise<number> {
  let removed = 0;
  let names: string[];
  try {
    names = await readdir(stagingRoot());
  } catch {
    return 0;
  }
  for (const name of names) {
    const dir = join(stagingRoot(), name);
    try {
      if (now - (await stat(dir)).mtimeMs >= maxAgeMs) {
        await rm(dir, { recursive: true, force: true });
        removed++;
      }
    } catch {
      /* gone already */
    }
  }
  return removed;
}
