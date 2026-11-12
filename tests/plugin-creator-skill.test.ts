import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeAgentCatalog,
  agentRunOptions,
  ensurePluginCreatorSkill,
  PLUGIN_CREATOR_AGENT_ID,
  PLUGIN_CREATOR_SKILL_FILES,
  PLUGIN_CREATOR_SKILL_NAME,
  PluginCreatorProjects,
  resolveActiveAgent,
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

describe("plugin creator guidance on what the host enforces", () => {
  const cheatsheet = PLUGIN_CREATOR_SKILL_FILES["references/sdk-cheatsheet.md"] ?? "";
  const checklist = PLUGIN_CREATOR_SKILL_FILES["references/quality-checklist.md"] ?? "";

  it("states the strict inputSchema rules with an allowed pattern", () => {
    expect(cheatsheet).toMatch(/strict mode/i);
    expect(cheatsheet).toContain('type: ["number", "string"]');
    expect(cheatsheet).toMatch(/anyOf/);
    expect(cheatsheet).toMatch(/format/);
    expect(cheatsheet).toMatch(/required.*properties/i);
    expect(cheatsheet).toMatch(/parse/i);
  });

  it("lists every delivery gate code in the quality checklist", () => {
    for (const code of [
      "activation_failed",
      "syntax_error",
      "typescript_source",
      "import_not_packed",
      "tool_smoke_failed",
      "dispose_failed",
      "reactivate_failed",
      "tool_untested",
      "tests_too_few",
      "gate_unavailable",
    ])
      expect(checklist).toContain(code);
  });

  it("forbids the agent to call a failing plugin ready", () => {
    const agent = resolveActiveAgent(activeAgentCatalog([]), PLUGIN_CREATOR_AGENT_ID);
    const text = agentRunOptions(agent).instructions ?? "";
    expect(text).toMatch(/never (say|report).*ready/i);
    expect(text).toMatch(/inputSchema/);
    expect(text).toMatch(/attempt/i);
  });

  it("makes the template harness reject schemas the host rejects", async () => {
    const home = await mkdtemp(join(tmpdir(), "alisio-creator-harness-"));
    const projects = new PluginCreatorProjects({ home, sdkRange: "^0.11.0" });
    const project = await projects.create({ request: "Greet people" });
    const dir = projects.dir(project.id);
    const index = await readFile(join(dir, "src", "index.js"), "utf8");
    await writeFile(
      join(dir, "src", "index.js"),
      index.replace('name: { type: "string"', 'name: { type: ["string", "number"]'),
    );
    const run = await projects.runTests(project.id);
    expect(run.ok).toBe(false);
    expect(run.output).toMatch(/type arrays/);
  });
});
