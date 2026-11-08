/** Skill Builder web logic: describe form, progress stages, review editing, save errors, strings. */
import type { SkillDraft } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  buildRequest,
  describeProblem,
  draftIsDirty,
  fileTree,
  formatElapsed,
  progressStages,
  removeFile,
  reviewDraft,
  saveFailure,
  setDraftField,
  setFileContent,
} from "../packages/web/src/components/skill-builder/model.ts";
import { skillBuilderStrings } from "../packages/web/src/components/skill-builder/strings.ts";
import { ApiRequestError } from "../packages/web/src/net/api.ts";

const draft = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "budget-report",
  description: "Builds budget reports. Use when the user asks for a budget summary.",
  body: "# Budget\n\nRun `scripts/sum.py`.\n",
  files: [
    { path: "scripts/sum.py", content: "# Usage: sum.py\nprint(1)\n", purpose: "Totals" },
    { path: "references/notes.md", content: "a\nb\n" },
  ],
  ...over,
});

describe("describe form", () => {
  const form = { idea: "", when: "", scope: "project" as const, include: {} };
  it("needs an idea of reasonable length", () => {
    expect(describeProblem(form)).toBe("idea_required");
    expect(describeProblem({ ...form, idea: "   " })).toBe("idea_required");
    expect(describeProblem({ ...form, idea: "x".repeat(4001) })).toBe("idea_too_long");
    expect(describeProblem({ ...form, idea: "merge pdfs" })).toBeUndefined();
  });
  it("builds a minimal request without empty or auto fields", () => {
    expect(buildRequest({ ...form, idea: " merge pdfs " })).toEqual({
      idea: "merge pdfs",
      scope: "project",
    });
    expect(
      buildRequest({
        ...form,
        idea: "x",
        when: " when merging ",
        scope: "global",
        include: { scripts: "yes", templates: "auto", references: "no" },
      }),
    ).toEqual({
      idea: "x",
      when: "when merging",
      scope: "global",
      include: { scripts: "yes", references: "no" },
    });
  });
  it("adds the previous draft and feedback when regenerating", () => {
    const previous = draft();
    expect(buildRequest({ ...form, idea: "x" }, { previous, feedback: " shorter " })).toMatchObject(
      {
        previous,
        feedback: "shorter",
      },
    );
    expect(buildRequest({ ...form, idea: "x" }, { previous, feedback: "  " })).not.toHaveProperty(
      "feedback",
    );
  });
});

describe("progress stages", () => {
  const states = (elapsed: number, phase: "waiting" | "validating" | "done") =>
    progressStages(elapsed, phase).map((s) => s.state);
  it("walks through timed hints while waiting, never reaching validating or done", () => {
    expect(states(0, "waiting")).toEqual(["active", "pending", "pending", "pending"]);
    expect(states(6_000, "waiting")).toEqual(["done", "active", "pending", "pending"]);
    expect(states(60_000, "waiting")).toEqual(["done", "done", "active", "pending"]);
    expect(states(10 * 60_000, "waiting")[3]).toBe("pending");
  });
  it("marks validating only after the response and done at the end", () => {
    expect(states(5_000, "validating")).toEqual(["done", "done", "done", "active"]);
    expect(states(5_000, "done")).toEqual(["done", "done", "done", "done"]);
  });
  it("names the stages in order", () => {
    expect(progressStages(0, "waiting").map((s) => s.id)).toEqual([
      "analyze",
      "write",
      "files",
      "validate",
    ]);
  });
  it("formats elapsed time", () => {
    expect(formatElapsed(0)).toBe("0:00");
    expect(formatElapsed(65_400)).toBe("1:05");
    expect(formatElapsed(3_600_000)).toBe("60:00");
  });
});

describe("review editing", () => {
  it("edits fields and files immutably", () => {
    const original = draft();
    const renamed = setDraftField(original, "name", "budget-2");
    expect(renamed.name).toBe("budget-2");
    expect(original.name).toBe("budget-report");
    const edited = setFileContent(original, "scripts/sum.py", "print(2)\n");
    expect(edited.files[0]?.content).toBe("print(2)\n");
    expect(edited.files[0]?.purpose).toBe("Totals");
    expect(original.files[0]?.content).toContain("Usage");
    expect(removeFile(original, "scripts/sum.py").files.map((f) => f.path)).toEqual([
      "references/notes.md",
    ]);
  });
  it("detects edits", () => {
    const original = draft();
    expect(draftIsDirty(original, draft())).toBe(false);
    expect(draftIsDirty(original, setDraftField(original, "description", "x"))).toBe(true);
    expect(draftIsDirty(original, removeFile(original, "scripts/sum.py"))).toBe(true);
  });
  it("groups files by folder in a stable order with sizes", () => {
    const tree = fileTree(draft());
    expect(tree.map((g) => g.folder)).toEqual(["scripts", "references"]);
    expect(tree[0]?.files[0]).toMatchObject({ path: "scripts/sum.py", name: "sum.py", lines: 3 });
    expect(fileTree(draft({ files: [] }))).toEqual([]);
  });
  it("splits errors from suggestions and blocks saving on errors only", () => {
    const ok = reviewDraft(draft(), []);
    expect(ok.errors).toEqual([]);
    expect(ok.canSave).toBe(true);
    const soft = reviewDraft(draft({ description: "Builds reports." }), []);
    expect(soft.warnings.map((w) => w.code)).toContain("description-when");
    expect(soft.canSave).toBe(true);
    const hard = reviewDraft(draft({ name: "Bad Name" }), []);
    expect(hard.canSave).toBe(false);
    expect(hard.byField.name?.[0]?.code).toBe("name-format");
    expect(reviewDraft(draft(), ["budget-report"]).warnings.map((w) => w.code)).toContain(
      "name-collision",
    );
  });
  it("revalidates live after each edit", () => {
    const broken = removeFile(draft(), "scripts/sum.py");
    expect(reviewDraft(broken, []).errors.map((e) => e.code)).toContain("reference-missing");
    expect(reviewDraft(setDraftField(broken, "body", "# Budget\n"), []).canSave).toBe(true);
  });
});

describe("save failures", () => {
  const fail = (status: number, code: ApiRequestError["code"]) =>
    new ApiRequestError(status, code, "m");
  it("classifies the API errors the UI handles specially", () => {
    expect(saveFailure(fail(409, "skill_exists"))).toBe("exists");
    expect(saveFailure(fail(403, "not_manageable"))).toBe("untrusted");
    expect(saveFailure(fail(403, "capability_ceiling"))).toBe("readonly");
    expect(saveFailure(fail(400, "validation_failed"))).toBe("invalid");
    expect(saveFailure(fail(0, "network"))).toBe("other");
    expect(saveFailure(new Error("boom"))).toBe("other");
  });
});

describe("strings", () => {
  it("English and Spanish have the same keys and placeholders", () => {
    const { en, es } = skillBuilderStrings;
    expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(en) as Array<keyof typeof en>)
      expect(holes(es[key]), key).toEqual(holes(en[key]));
  });
  it("localizes every validation finding in both languages with the same placeholders", () => {
    const { issuesEn, issuesEs } = skillBuilderStrings;
    expect(Object.keys(issuesEs).sort()).toEqual(Object.keys(issuesEn).sort());
    const holes = (text: string) => (text.match(/\{\w+\}/g) ?? []).sort();
    for (const key of Object.keys(issuesEn) as Array<keyof typeof issuesEn>)
      expect(holes(issuesEs[key]), key).toEqual(holes(issuesEn[key]));
  });
  it("covers every code the shared validator can emit", () => {
    const hostile = {
      name: "Bad claude name",
      description: "I <b>x</b> ".repeat(300),
      compatibility: "c".repeat(900),
      license: "l".repeat(300),
      metadata: { a: 1 } as never,
      body: `${"x\n".repeat(600)} before May 2024 scripts\\x See \`references/none.md\``,
      files: [
        { path: "../x", content: "a" },
        { path: "assets/a.txt", content: "a\u0000" },
        { path: "assets/a.txt", content: "a" },
        { path: "assets/big.txt", content: "x".repeat(300 * 1024) },
        { path: "references/long.md", content: "l\n".repeat(150) },
        { path: "scripts/run.py", content: "print(1)" },
        ...Array.from({ length: 22 }, (_, i) => ({ path: `assets/f${i}.txt`, content: "x" })),
      ],
    };
    const result = reviewDraft(hostile as never, ["bad-claude-name", "helper"]);
    const codes = new Set([...result.errors, ...result.warnings].map((i) => i.code));
    for (const code of codes)
      expect(Object.keys(skillBuilderStrings.issuesEn), code).toContain(code);
    expect(codes.size).toBeGreaterThan(15);
  });
  it("has no empty text and keeps the Spanish vocabulary", () => {
    const { en, es } = skillBuilderStrings;
    for (const key of Object.keys(en) as Array<keyof typeof en>) {
      expect(en[key].length, key).toBeGreaterThan(0);
      expect(es[key].length, key).toBeGreaterThan(0);
    }
    expect(Object.values(es).join(" ")).not.toMatch(/plugins?\b/i);
  });
});
