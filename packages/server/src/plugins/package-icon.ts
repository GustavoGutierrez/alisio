/**
 * The icon an installed plugin package ships: `package.json` → `"alisio": { "icon": "<path>" }`,
 * a path relative to the package directory. The file is only read when its real path (symlinks
 * resolved) stays inside the real package directory, it is a regular file with an image extension
 * and at most `MAX_ICON_BYTES`, and its bytes are really an SVG, WebP, PNG or JPEG: the content
 * type always comes from the bytes. Anything else is "no icon", never an error.
 */
import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { sniffCover } from "./catalog-service.ts";

export const MAX_ICON_BYTES = 256 * 1024;
const EXTENSIONS = new Set([".svg", ".png", ".webp", ".jpg", ".jpeg"]);

export interface PackageIcon {
  body: Buffer;
  contentType: string;
  etag: string;
}

/** The icon path a package.json declares, if it is a plain relative string. */
async function declaredPath(packageDir: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")) as {
      alisio?: { icon?: unknown };
    };
    const icon = manifest.alisio?.icon;
    return typeof icon === "string" && icon.length > 0 && icon.length <= 200 && !icon.includes("\0")
      ? icon
      : undefined;
  } catch {
    return undefined;
  }
}

export async function readPackageIcon(packageDir: string): Promise<PackageIcon | undefined> {
  const declared = await declaredPath(packageDir);
  if (!declared || isAbsolute(declared) || !EXTENSIONS.has(extname(declared).toLowerCase()))
    return undefined;
  try {
    const root = await realpath(packageDir);
    const file = await realpath(resolve(root, declared));
    if (!file.startsWith(root + sep)) return undefined;
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_ICON_BYTES) return undefined;
    const body = await readFile(file);
    const kind = sniffCover(body);
    if (!kind) return undefined;
    return {
      body,
      contentType: kind.type,
      etag: `"sha1-${createHash("sha1").update(body).digest("hex")}"`,
    };
  } catch {
    return undefined;
  }
}
