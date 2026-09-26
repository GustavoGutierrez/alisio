/** Portable file helpers (node:fs) replacing Bun.file/Bun.write. */
import { constants } from "node:fs";
import { access, open, readFile, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";

const missing = (e: unknown) =>
  ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException).code ?? "");
export async function fileSize(path: string): Promise<number | undefined> {
  try {
    const s = await stat(path);
    return s.isFile() ? s.size : undefined;
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
export const exists = async (path: string) => (await fileSize(path)) !== undefined;
/** Reads UTF-8 text, refusing files larger than `maxBytes`. */
export async function readText(path: string, maxBytes = Number.POSITIVE_INFINITY): Promise<string> {
  const size = await fileSize(path);
  if (size === undefined)
    throw Object.assign(new Error(`File not found: ${path}`), { code: "ENOENT" });
  if (size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${path}`);
  return readFile(path, "utf8");
}
export async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (e) {
    if (missing(e)) return undefined;
    throw e;
  }
}
/** First `bytes` bytes decoded as UTF-8. */
export async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}
/** Executable lookup on PATH (PATHEXT on Windows), replacing Bun.which. */
export async function which(command: string): Promise<string | undefined> {
  const extensions =
    process.platform === "win32"
      ? ["", ...(process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)]
      : [""];
  const candidates = isAbsolute(command)
    ? [command]
    : (process.env.PATH ?? "")
        .split(delimiter)
        .filter(Boolean)
        .map((dir) => join(dir, command));
  for (const base of candidates)
    for (const ext of extensions) {
      const path = `${base}${ext}`;
      try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await fileSize(path)) !== undefined) return path;
      } catch {
        /* keep looking */
      }
    }
  return undefined;
}
