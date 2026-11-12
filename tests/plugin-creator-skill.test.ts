import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ensurePluginCreatorSkill,
  PLUGIN_CREATOR_SKILL_FILES,
  PLUGIN_CREATOR_SKILL_NAME,
  Skills,
} from "../packages/core/src/index.ts";

const skillMd = PLUGIN_CREATOR_SKILL_FILES["SKILL.md"] ?? "";

describe("bundled plugin creator skill", () => {
  it("keeps SKILL.md a short index with valid frontmatter", () => {
    expect(skillMd.startsWith(`---\nname: ${PLUGIN_CREATOR_SKILL_NAME}\ndescription: `)).toBe(true);
    expect(skillMd.split("\n").length).toBeLessThan(120);
  });

  it("references only files it ships, and ships only referenced files", () => {
    const referenced = [...skillMd.matchAll(/\b((?:references|templates)\/[\w./-]+\.\w+)/g)].map(
      (m) => m[1] as string,
    );
    expect(referenced.length).toBeGreaterThan(3);
    for (const path of referenced) expect(PLUGIN_CREATOR_SKILL_FILES).toHaveProperty([path]);
    for (const path of Object.keys(PLUGIN_CREATOR_SKILL_FILES))
      if (path !== "SKILL.md") expect(referenced).toContain(path);
  });

  it("materializes into a discoverable skill and refreshes stale copies", async () => {
    const home = await mkdtemp(join(tmpdir(), "alisio-creator-skill-"));
    const root = await ensurePluginCreatorSkill(home);
    const skills = new Skills();
    await skills.discover([root]);
    expect(skills.items.get(PLUGIN_CREATOR_SKILL_NAME)).toBeDefined();
    expect(skills.diagnostics).toEqual([]);
    const file = join(root, PLUGIN_CREATOR_SKILL_NAME, "SKILL.md");
    await writeFile(file, "tampered");
    await writeFile(join(root, PLUGIN_CREATOR_SKILL_NAME, ".version"), "old");
    await ensurePluginCreatorSkill(home);
    expect(await readFile(file, "utf8")).toBe(skillMd);
  });
});
