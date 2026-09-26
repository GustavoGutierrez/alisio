import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Skills, skillRoots } from "../packages/core/src/resources/skills.ts";

const root = await mkdtemp(join(tmpdir(), "alisio-skills-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const skill = async (dir: string, name: string, description = `${name} skill`, folder = name) => {
  await mkdir(join(dir, folder), { recursive: true });
  await writeFile(
    join(dir, folder, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\nBODY-${name}`,
  );
};

describe("skill roots", () => {
  const options = {
    workspace: "/repo",
    cwd: "/repo/pkg/app",
    home: "/home/u",
    configHome: "/home/u/.config/alisio",
    configSkills: ["/opt/skills"],
    pluginRoots: ["/plugins/x/skills"],
  };
  it("orders project (closest first, three conventions), config, user, then plugins", () => {
    expect(skillRoots({ ...options, trusted: true }).map((r) => `${r.scope}:${r.dir}`)).toEqual([
      "project:/repo/pkg/app/.agents/skills",
      "project:/repo/pkg/app/.alisio/skills",
      "project:/repo/pkg/app/.claude/skills",
      "project:/repo/pkg/.agents/skills",
      "project:/repo/pkg/.alisio/skills",
      "project:/repo/pkg/.claude/skills",
      "project:/repo/.agents/skills",
      "project:/repo/.alisio/skills",
      "project:/repo/.claude/skills",
      "config:/opt/skills",
      "user:/home/u/.agents/skills",
      "user:/home/u/.config/alisio/skills",
      "plugin:/plugins/x/skills",
    ]);
  });
  it("skips project skills for untrusted projects", () => {
    expect(skillRoots({ ...options, trusted: false }).some((r) => r.scope === "project")).toBe(
      false,
    );
  });
});

describe("discovery", () => {
  it("lets project override user with a warning and a deterministic winner", async () => {
    const project = join(root, "p1", ".agents", "skills"),
      user = join(root, "u1", ".agents", "skills");
    await skill(project, "review", "project review");
    await skill(user, "review", "user review");
    await skill(user, "deploy");
    const skills = new Skills();
    await skills.discover([
      { dir: project, scope: "project" },
      { dir: user, scope: "user" },
    ]);
    expect(skills.items.get("review")?.description).toBe("project review");
    expect(skills.items.get("deploy")).toBeDefined();
    expect(skills.diagnostics.some((d) => /review/.test(d) && /overrides|shadow/i.test(d))).toBe(
      true,
    );
  });

  it("validates names per spec, warning on directory mismatch but loading", async () => {
    const dir = join(root, "names");
    await skill(dir, "good-name", "ok", "other-folder");
    await skill(dir, "Bad--Name", "bad", "bad");
    await skill(dir, "-lead", "bad", "lead");
    const skills = new Skills();
    await skills.discover([{ dir, scope: "user" }]);
    expect([...skills.items.keys()]).toEqual(["good-name"]);
    expect(skills.diagnostics.some((d) => /good-name/.test(d) && /directory/i.test(d))).toBe(true);
    expect(skills.diagnostics.filter((d) => /bad|lead/i.test(d)).length).toBeGreaterThanOrEqual(2);
  });

  it("bounds scan depth (5) and directory count", async () => {
    const dir = join(root, "deep");
    await skill(join(dir, "a", "b", "c", "d"), "four-deep");
    await skill(join(dir, "a", "b", "c", "d", "e", "f"), "too-deep");
    const skills = new Skills();
    await skills.discover([{ dir, scope: "user" }]);
    expect(skills.items.has("four-deep")).toBe(true);
    expect(skills.items.has("too-deep")).toBe(false);
    const many = join(root, "many");
    for (let i = 0; i < 30; i++) await mkdir(join(many, `d${i}`), { recursive: true });
    await skill(join(many, "zz"), "late");
    const limited = new Skills({ maxDirs: 10 });
    await limited.discover([{ dir: many, scope: "user" }]);
    expect(limited.items.has("late")).toBe(false);
    expect(limited.diagnostics.some((d) => /limit/i.test(d))).toBe(true);
  });

  it("keeps progressive disclosure: catalog lists names, load returns the body", async () => {
    const dir = join(root, "pd");
    await skill(dir, "notes");
    const skills = new Skills();
    await skills.discover([{ dir, scope: "user" }]);
    expect(skills.catalog()).toContain("notes");
    expect(skills.catalog()).not.toContain("BODY-notes");
    expect(await skills.load("notes")).toContain("BODY-notes");
  });

  it("exposes safe source, ownership and approximate-token metadata", async () => {
    const dir = join(root, "metadata");
    await skill(dir, "nextjs", "Next.js guidance");
    const skills = new Skills();
    await skills.discover([
      {
        dir,
        scope: "plugin",
        source: "plugin",
        owner: { id: "vercel", name: "Vercel" },
      },
    ]);
    const entry = skills.catalogEntries()[0];
    expect(entry).toMatchObject({
      id: "vercel:nextjs",
      displayId: "vercel:nextjs",
      source: "plugin",
      scope: "plugin",
      owner: { id: "vercel", name: "Vercel" },
      locked: true,
      manageable: false,
      enabled: true,
      effective: true,
    });
    expect(entry?.approximateTokens).toBeGreaterThan(0);
    expect(JSON.stringify(entry)).not.toContain(root);
    await expect(skills.load("vercel:nextjs")).resolves.toContain("BODY-nextjs");
    expect(() => skills.setEnabled("vercel:nextjs", false)).toThrow("locked by its plugin");
  });

  it("keeps precedence fixed while a manageable effective skill is disabled", async () => {
    const project = join(root, "overrides-project");
    const user = join(root, "overrides-user");
    await skill(project, "review", "project winner");
    await skill(user, "review", "shadowed user copy");
    const skills = new Skills({ overrides: { review: { enabled: false } } });
    await skills.discover([
      { dir: project, scope: "project" },
      { dir: user, scope: "user" },
    ]);
    expect(skills.items.has("review")).toBe(false);
    expect(skills.catalog()).not.toContain("project winner");
    expect(skills.catalogEntries()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ description: "project winner", effective: true, enabled: false }),
        expect.objectContaining({ description: "shadowed user copy", effective: false }),
      ]),
    );
    await expect(skills.load("review")).rejects.toThrow("disabled");
    skills.setEnabled("review", true);
    expect(skills.catalog()).toContain("project winner");
    await expect(skills.load("review")).resolves.toContain("BODY-review");
  });
});
