/**
 * A private copy of the scratchpad for the `wasm` backend. The Node Permission Model follows
 * links that already exist, and Python reaches `node:fs` through the FFI, so granting the real
 * scratchpad would also grant whatever a symbolic link inside it points at. The copy is made by
 * the parent without ever following a link: links and special files are skipped, regular files
 * are opened with `O_NOFOLLOW` where the platform has it, relative paths are kept.
 */
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir } from "node:fs/promises";
import { join } from "node:path";

/** Most bytes copied; larger files that do not fit are left out (the runner used the same cap). */
export const SCRATCH_COPY_CAP_BYTES = 64 * 1024 * 1024;

/** Deepest directory level copied. */
const MAX_DEPTH = 32;

export async function copyScratchNoFollow(
  source: string,
  target: string,
  cap = SCRATCH_COPY_CAP_BYTES,
): Promise<{ files: number; bytes: number }> {
  await mkdir(target, { recursive: true, mode: 0o700 });
  let files = 0;
  let bytes = 0;
  const walk = async (from: string, to: string, depth: number): Promise<void> => {
    const entries = await readdir(from, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      const info = await lstat(src).catch(() => undefined);
      if (!info) continue;
      if (info.isDirectory()) {
        if (depth >= MAX_DEPTH) continue;
        await mkdir(dst, { mode: 0o700 });
        await walk(src, dst, depth + 1);
      } else if (info.isFile() && bytes + info.size <= cap) {
        const handle = await open(src, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch(
          () => undefined,
        );
        if (!handle) continue;
        try {
          // The entry could have been swapped for something else since the lstat.
          const opened = await handle.stat();
          if (!opened.isFile() || bytes + opened.size > cap) continue;
          const contents = await handle.readFile();
          const out = await open(dst, "wx", 0o600);
          try {
            await out.writeFile(contents);
          } finally {
            await out.close();
          }
          files++;
          bytes += contents.length;
        } finally {
          await handle.close();
        }
      }
    }
  };
  await walk(source, target, 0);
  return { files, bytes };
}
