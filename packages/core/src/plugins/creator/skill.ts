/**
 * Materializes the bundled creator skill under `<config home>/plugin-creator/skills/` so the
 * ordinary skill loader (`skill_load`, `skill_resource`) serves it to creator sessions. A
 * `.version` hash makes it idempotent; a changed or tampered copy is replaced as a whole.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configHome } from "../../config.ts";
import { pluginCreatorPaths } from "./paths.ts";
import { PLUGIN_CREATOR_SKILL_FILES, PLUGIN_CREATOR_SKILL_NAME } from "./skill-files.ts";

const VERSION = createHash("sha256")
  .update(JSON.stringify(Object.entries(PLUGIN_CREATOR_SKILL_FILES).sort()))
  .digest("hex")
  .slice(0, 16);

/** Writes the skill when missing or stale; returns the skill ROOT (the parent of the skill dir). */
export async function ensurePluginCreatorSkill(home: string = configHome()): Promise<string> {
  const root = pluginCreatorPaths(home).skills;
  const target = join(root, PLUGIN_CREATOR_SKILL_NAME);
  const current = await readFile(join(target, ".version"), "utf8").catch(() => "");
  if (current === VERSION) return root;
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = join(root, `.${PLUGIN_CREATOR_SKILL_NAME}.${randomBytes(4).toString("hex")}`);
  try {
    for (const [rel, text] of Object.entries(PLUGIN_CREATOR_SKILL_FILES)) {
      const file = join(temp, rel);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, text);
    }
    await writeFile(join(temp, ".version"), VERSION);
    await rm(target, { recursive: true, force: true });
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {});
    // Another process may have written the same version concurrently.
    if ((await readFile(join(target, ".version"), "utf8").catch(() => "")) === VERSION) return root;
    throw error;
  }
  return root;
}
