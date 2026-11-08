/** Extraction of embedded document assets and the generator of the embedding module (D-28). */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import type { EmbeddedAssets } from "./embedded-assets.ts";

const safe = (rel: string) => {
  const n = normalize(rel);
  return !isAbsolute(n) && !n.startsWith("..") && !n.includes("\0");
};

/**
 * Writes the embedded files under `target` (once: a `.complete` marker ends the work) and returns
 * the directory, with a trailing separator like `ASSETS_ROOT`.
 */
export async function materializeAssets(assets: EmbeddedAssets, target: string): Promise<string> {
  const done = join(target, ".complete");
  const exists = await stat(done).then(
    () => true,
    () => false,
  );
  if (!exists) {
    for (const [rel, data] of Object.entries(assets.files)) {
      if (!safe(rel)) continue;
      const file = join(target, rel);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, Buffer.from(data, "base64"));
      await rename(temp, file);
    }
    await writeFile(done, assets.version);
  }
  return `${target}/`;
}

async function listFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...(await listFiles(dir, rel)));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** JavaScript source of the module `embedded-assets.js` carrying every file of `assetsDir`. */
export async function embeddedModuleSource(assetsDir: string): Promise<string> {
  const files: Record<string, string> = {};
  const hash = createHash("sha256");
  for (const rel of await listFiles(assetsDir)) {
    const bytes = await readFile(join(assetsDir, rel));
    hash.update(rel).update(bytes);
    files[rel] = bytes.toString("base64");
  }
  const version = hash.digest("hex").slice(0, 16);
  return `export const EMBEDDED_ASSETS = ${JSON.stringify({ version, files })};\n`;
}
