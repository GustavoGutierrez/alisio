import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication, setProjectSkillEnabled } from "../packages/core/src/index.ts";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(existing = true) {
  const root = await mkdtemp(join(tmpdir(), "alisio-skill-manager-"));
  roots.push(root);
  await mkdir(join(root, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    join(root, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review safely\n---\nPRIVATE-BODY",
  );
  if (existing) {
    await mkdir(join(root, ".alisio"), { recursive: true });
    await writeFile(
      join(root, ".alisio", "config.json"),
      `${JSON.stringify({ schemaVersion: 1, limits: { maxTurns: 7 } })}\n`,
    );
  }
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config-home"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state-home"));
  return root;
}

describe("application skill manager", () => {
  it("persists atomically, preserves unrelated fields and applies immediately", async () => {
    const root = await fixture();
    const app = await createApplication({ cwd: root, trustProject: true, noHerdr: true });
    try {
      expect(app.skills.catalog()).toContain("review");
      await app.setSkillEnabled("review", false);
      expect(app.skills.items.has("review")).toBe(false);
      await expect(app.skills.load("review")).rejects.toThrow("Re-enable it with /skills");
      const raw = JSON.parse(await readFile(join(root, ".alisio", "config.json"), "utf8"));
      expect(raw).toMatchObject({
        limits: { maxTurns: 7 },
        skillOverrides: { review: { enabled: false } },
      });
    } finally {
      await app.close();
    }
    const restarted = await createApplication({ cwd: root, trustProject: true, noHerdr: true });
    try {
      expect(restarted.skills.items.has("review")).toBe(false);
      await restarted.setSkillEnabled("review", true);
      expect(restarted.skills.items.has("review")).toBe(true);
    } finally {
      await restarted.close();
    }
  });

  it("requires trust before modifying existing project config but may create a new override file", async () => {
    const root = await fixture();
    await expect(
      setProjectSkillEnabled({ workspace: root, id: "review", enabled: false, trusted: false }),
    ).rejects.toThrow("Trust this project");
    const fresh = await fixture(false);
    await setProjectSkillEnabled({
      workspace: fresh,
      id: "review",
      enabled: false,
      trusted: false,
    });
    expect(JSON.parse(await readFile(join(fresh, ".alisio", "config.json"), "utf8"))).toMatchObject(
      {
        schemaVersion: 1,
        skillOverrides: { review: { enabled: false } },
      },
    );
  });

  it("does not apply similarly named global overrides across projects", async () => {
    const root = await fixture();
    await mkdir(join(root, "config-home"), { recursive: true });
    await writeFile(
      join(root, "config-home", "config.json"),
      `${JSON.stringify({ schemaVersion: 1, skillOverrides: { review: { enabled: false } } })}\n`,
    );
    const app = await createApplication({ cwd: root, trustProject: true, noHerdr: true });
    try {
      expect(app.skills.items.has("review")).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("never exposes absolute paths or skill bodies in the safe application catalog", async () => {
    const root = await fixture();
    const app = await createApplication({ cwd: root, trustProject: true, noHerdr: true });
    try {
      const text = JSON.stringify(app.skillCatalog());
      expect(text).not.toContain(root);
      expect(text).not.toContain("PRIVATE-BODY");
    } finally {
      await app.close();
    }
  });

  it("retains the registering plugin owner and locks its namespaced skill", async () => {
    const root = await fixture();
    await mkdir(join(root, "plugin-skills", "plugin-tip"), { recursive: true });
    await writeFile(
      join(root, "plugin-skills", "plugin-tip", "SKILL.md"),
      "---\nname: plugin-tip\ndescription: Plugin guidance\n---\nPLUGIN-BODY",
    );
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      noHerdr: true,
      builtins: [
        {
          id: "acme",
          name: "Acme Tools",
          description: "Fixture plugin",
          create: () =>
            definePlugin({
              id: "acme",
              name: "Acme Tools",
              description: "Fixture plugin",
              version: "1.0.0",
              apiVersion: 1,
              setup(api) {
                api.resources.skills("plugin-skills");
              },
            }),
        },
      ],
    });
    try {
      const entry = app.skillCatalog().find((skill) => skill.name === "plugin-tip");
      expect(entry).toMatchObject({
        displayId: "acme:plugin-tip",
        owner: { id: "acme", name: "Acme Tools" },
        locked: true,
        manageable: false,
      });
      await expect(app.setSkillEnabled("acme:plugin-tip", false)).rejects.toThrow("/plugins");
    } finally {
      await app.close();
    }
  });
});
