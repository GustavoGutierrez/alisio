/** Skill Builder core: tolerant draft parsing, generation request, atomic writer, trust marker. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  generateSkillDraft,
  hasProjectResources,
  parseSkillDraft,
  type SkillDraft,
  Skills,
  SkillWriteError,
  skillAuthoringGuidance,
  skillDraftRequest,
  writeSkill,
} from "../packages/core/src/index.ts";

const answer = {
  name: "pdf-merger",
  description: "Merges PDF files. Use when the user wants to combine PDFs.",
  body: "# PDF merger\n\nRun `scripts/merge.py`.\n",
  files: [{ path: "scripts/merge.py", content: "# Usage: merge.py\nprint(1)\n", purpose: "Merge" }],
};
const fenced = (value: unknown) =>
  `Here you go:\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\nEnjoy.`;

describe("parseSkillDraft", () => {
  it("accepts bare JSON, fenced JSON and JSON surrounded by prose", () => {
    for (const text of [
      JSON.stringify(answer),
      fenced(answer),
      `Sure. ${JSON.stringify(answer)} Done`,
    ])
      expect(parseSkillDraft(text, "m").name).toBe("pdf-merger");
  });
  it("records the model and guidance and keeps file purposes", () => {
    const draft = parseSkillDraft(JSON.stringify(answer), "gpt-x", "skill:alisio-skill-authoring");
    expect(draft).toMatchObject({ generatedBy: "gpt-x", guidance: "skill:alisio-skill-authoring" });
    expect(draft.files).toEqual([
      { path: "scripts/merge.py", content: "# Usage: merge.py\nprint(1)\n", purpose: "Merge" },
    ]);
  });
  it("slugifies the name and cleans the description", () => {
    const draft = parseSkillDraft(
      JSON.stringify({
        ...answer,
        name: "  PDF Merger!! ",
        description: `<b>Merges</b>\n  PDFs. ${"x".repeat(2000)}`,
      }),
      "m",
    );
    expect(draft.name).toBe("pdf-merger");
    expect(draft.description).not.toMatch(/[<>\n]/);
    expect(draft.description.length).toBeLessThanOrEqual(1024);
  });
  it("clips compatibility and drops unusable files and unknown keys", () => {
    const draft = parseSkillDraft(
      JSON.stringify({
        ...answer,
        compatibility: "c".repeat(900),
        evil: "x",
        files: [
          { path: "..\\x", content: "a" },
          { path: "./references/a.md", content: "ok" },
          { path: "assets/n.txt", content: 5 },
          "nope",
          ...Array.from({ length: 40 }, (_, i) => ({ path: `assets/f${i}.txt`, content: "x" })),
        ],
      }),
      "m",
    );
    expect(draft.compatibility?.length).toBe(500);
    expect(draft).not.toHaveProperty("evil");
    expect(draft.files.some((f) => f.path.includes(".."))).toBe(false);
    expect(draft.files[0]?.path).toBe("references/a.md");
    expect(draft.files.length).toBeLessThanOrEqual(20);
  });
  it("strips frontmatter the model put into the body", () => {
    const draft = parseSkillDraft(
      JSON.stringify({ ...answer, body: "---\nname: evil\n---\n# Real body\n" }),
      "m",
    );
    expect(draft.body).toBe("# Real body");
  });
  it("throws a readable error when there is no JSON or no body", () => {
    expect(() => parseSkillDraft("I cannot do that", "m")).toThrow("did not return");
    expect(() => parseSkillDraft('{"name":"x","description":"d"}', "m")).toThrow("no instructions");
  });
});

describe("skill draft request and generation", () => {
  it("builds a fresh request with hints and a refine request with the previous draft", () => {
    const fresh = skillDraftRequest({
      idea: "merge pdfs",
      when: "combine these PDFs",
      include: { scripts: "yes", references: "no" },
    });
    expect(fresh).toContain("merge pdfs");
    expect(fresh).toContain("combine these PDFs");
    expect(fresh).toMatch(/script/i);
    const refine = skillDraftRequest({
      idea: "merge pdfs",
      previous: { ...answer, files: [] } as SkillDraft,
      feedback: "make it shorter",
    });
    expect(refine).toContain("make it shorter");
    expect(refine).toContain("# PDF merger");
  });

  const provider = (
    calls: Array<Parameters<ModelProvider["stream"]>[0]>,
    text: string,
  ): ModelProvider => ({
    id: "fake",
    model: "fake-model",
    async *stream(request) {
      calls.push(request);
      yield { type: "completed", message: { role: "assistant", text, calls: [] } };
    },
  });

  it("calls the model once without tools, with the guidance and a skill-sized budget", async () => {
    const calls: Array<Parameters<ModelProvider["stream"]>[0]> = [];
    const draft = await generateSkillDraft(provider(calls, JSON.stringify(answer)), {
      idea: "merge pdfs",
    });
    expect(draft.generatedBy).toBe("fake-model");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.tools).toEqual([]);
    expect(calls[0]?.maxOutputTokens).toBeGreaterThanOrEqual(8000);
    expect(calls[0]?.instructions).toMatch(/Use when/);
    expect(calls[0]?.instructions).toMatch(/JSON/);
  });
  it("rejects an empty idea and an over-long one", async () => {
    const calls: Array<Parameters<ModelProvider["stream"]>[0]> = [];
    const p = provider(calls, "{}");
    await expect(generateSkillDraft(p, { idea: "  " })).rejects.toThrow("Describe");
    await expect(generateSkillDraft(p, { idea: "x".repeat(4001) })).rejects.toThrow("limited");
    expect(calls).toHaveLength(0);
  });
  it("propagates an abort", async () => {
    const calls: Array<Parameters<ModelProvider["stream"]>[0]> = [];
    const controller = new AbortController();
    controller.abort(new Error("Cancelled"));
    await expect(
      generateSkillDraft(
        provider(calls, JSON.stringify(answer)),
        { idea: "x" },
        { signal: controller.signal },
      ),
    ).rejects.toThrow();
  });
  it("uses a discovered skill named alisio-skill-authoring as guidance override", async () => {
    const bundled = await skillAuthoringGuidance();
    expect(bundled.source).toBe("bundled:skill-authoring");
    const custom = await skillAuthoringGuidance({
      items: { has: (name: string) => name === "alisio-skill-authoring" },
      load: async () => "---\nname: alisio-skill-authoring\ndescription: x\n---\nMY RULES",
    });
    expect(custom).toEqual({ text: "MY RULES", source: "skill:alisio-skill-authoring" });
  });
});

describe("writeSkill", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-skillwrite-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const draft = (): SkillDraft => ({ ...answer, files: [...answer.files] });

  it("writes SKILL.md and files the loader can discover, with 0644 modes", async () => {
    const skills = join(root, "skills");
    const result = await writeSkill({ root: skills, draft: draft() });
    expect(result.dir).toBe(join(skills, "pdf-merger"));
    expect(
      (await readFile(join(result.dir, "SKILL.md"), "utf8")).startsWith("---\nname: pdf-merger"),
    ).toBe(true);
    expect(await readFile(join(result.dir, "scripts/merge.py"), "utf8")).toContain("Usage");
    for (const file of ["SKILL.md", "scripts/merge.py"])
      expect((await stat(join(result.dir, file))).mode & 0o777).toBe(0o644);
    expect((await stat(result.dir)).mode & 0o777).toBe(0o755);
    const loaded = new Skills();
    await loaded.discover([skills]);
    expect(loaded.diagnostics).toEqual([]);
    expect(loaded.items.has("pdf-merger")).toBe(true);
  });
  it("leaves no temp folders behind", async () => {
    const skills = join(root, "skills");
    await writeSkill({ root: skills, draft: draft() });
    expect(await readdir(skills)).toEqual(["pdf-merger"]);
  });
  it("refuses to overwrite unless explicitly allowed, and keeps the old one on refusal", async () => {
    const skills = join(root, "skills");
    await writeSkill({ root: skills, draft: draft() });
    const changed = { ...draft(), body: "# Changed\n", files: [] };
    await expect(writeSkill({ root: skills, draft: changed })).rejects.toMatchObject({
      code: "exists",
    });
    expect(await readFile(join(skills, "pdf-merger/SKILL.md"), "utf8")).toContain("PDF merger");
    await writeSkill({ root: skills, draft: changed, overwrite: true });
    const text = await readFile(join(skills, "pdf-merger/SKILL.md"), "utf8");
    expect(text).toContain("# Changed");
    expect(existsSync(join(skills, "pdf-merger/scripts"))).toBe(false);
    expect(await readdir(skills)).toEqual(["pdf-merger"]);
  });
  it("rejects invalid drafts before touching the disk", async () => {
    const skills = join(root, "skills");
    for (const bad of [
      { ...draft(), name: "../evil" },
      { ...draft(), name: "Bad Name" },
      { ...draft(), files: [{ path: "../x.txt", content: "a" }] },
      { ...draft(), files: [{ path: "/etc/x", content: "a" }] },
      { ...draft(), files: [{ path: "scripts/.hidden", content: "a" }] },
      { ...draft(), files: [{ path: "assets/big.txt", content: "x".repeat(300 * 1024) }] },
    ])
      await expect(writeSkill({ root: skills, draft: bad })).rejects.toBeInstanceOf(
        SkillWriteError,
      );
    expect(existsSync(skills)).toBe(false);
  });
  it("does not write through a symlinked skill folder", async () => {
    const skills = join(root, "skills");
    const outside = join(root, "outside");
    await mkdir(skills, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(skills, "pdf-merger"));
    await expect(writeSkill({ root: skills, draft: draft(), overwrite: true })).rejects.toThrow();
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("trust markers", () => {
  it("counts .agents/skills and .claude/skills as project resources", async () => {
    for (const dir of [".agents/skills", ".claude/skills"]) {
      const workspace = await mkdtemp(join(tmpdir(), "alisio-trustmark-"));
      expect(await hasProjectResources(workspace)).toBe(false);
      await mkdir(join(workspace, dir), { recursive: true });
      await writeFile(join(workspace, dir, ".keep"), "");
      expect(await hasProjectResources(workspace)).toBe(true);
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
