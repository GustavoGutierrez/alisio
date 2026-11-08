/**
 * Skill draft validation (hard errors and soft warnings) and SKILL.md rendering. The same pure
 * module serves the server (before writing) and the web (live validation in the Skill Builder).
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  renderSkillMd,
  SKILL_LIMITS,
  type SkillDraft,
  Skills,
  skillFilePathProblem,
  validateSkillDraft,
} from "../packages/core/src/index.ts";

const good = (over: Partial<SkillDraft> = {}): SkillDraft => ({
  name: "pdf-merger",
  description: "Merges PDF files into one document. Use when the user asks to combine PDFs.",
  body: "# PDF merger\n\n1. Collect the files.\n2. Run `scripts/merge.py`.\n",
  files: [{ path: "scripts/merge.py", content: "# Usage: merge.py a.pdf b.pdf\nprint('ok')\n" }],
  ...over,
});
const codes = (draft: SkillDraft, key: "errors" | "warnings", names?: string[]) =>
  validateSkillDraft(draft, names ? { existingNames: names } : {})[key].map((i) => i.code);

describe("validateSkillDraft hard errors", () => {
  it("accepts a well-formed draft", () => {
    const result = validateSkillDraft(good());
    expect(result.errors).toEqual([]);
  });

  const cases: Array<[string, Partial<SkillDraft>, string]> = [
    ["empty name", { name: "" }, "name-required"],
    ["uppercase name", { name: "PDF-merger" }, "name-format"],
    ["double hyphen", { name: "pdf--merger" }, "name-format"],
    ["edge hyphen", { name: "-pdf" }, "name-format"],
    ["too long name", { name: "a".repeat(65) }, "name-length"],
    ["reserved anthropic", { name: "anthropic-helper" }, "name-reserved"],
    ["reserved claude", { name: "my-claude-skill" }, "name-reserved"],
    ["xml tag in name", { name: "<b>x" }, "name-format"],
    ["empty description", { description: "  " }, "description-required"],
    ["long description", { description: `Use when ${"x".repeat(1100)}` }, "description-length"],
    ["angle brackets", { description: "Use when <b>x</b>" }, "description-xml"],
    ["long compatibility", { compatibility: "x".repeat(501) }, "compatibility-length"],
    ["metadata value not a string", { metadata: { v: 1 } as never }, "metadata-type"],
    ["metadata not an object", { metadata: ["a"] as never }, "metadata-type"],
    ["empty body", { body: "  " }, "body-required"],
    ["huge body", { body: "x".repeat(SKILL_LIMITS.skillBytes) }, "skill-size"],
    ["missing referenced file", { body: "See `references/guide.md`." }, "reference-missing"],
    [
      "missing linked file",
      { body: "See [guide](references/guide.md) for more." },
      "reference-missing",
    ],
  ];
  it.each(cases)("rejects %s", (_label, over, code) => {
    expect(codes(good(over), "errors")).toContain(code);
  });

  it("rejects bad file paths", () => {
    for (const path of [
      "../x.md",
      "/etc/passwd",
      "scripts/../../x",
      "C:\\x.py",
      "scripts\\x.py",
      "scripts/.hidden",
      ".git/config",
      "other/file.md",
      "SKILL.md",
      "scripts/a b.py",
      "scripts/a/b/c.py",
      "scripts/",
      "scripts//x.py",
      "references/é.md",
    ])
      expect(skillFilePathProblem(path), path).toBeTruthy();
    for (const path of ["scripts/merge.py", "references/guide.md", "assets/tpl/base.html"])
      expect(skillFilePathProblem(path), path).toBeUndefined();
  });

  it("enforces file count, per-file, total size, duplicates and text-only", () => {
    const many = Array.from({ length: SKILL_LIMITS.files + 1 }, (_, i) => ({
      path: `assets/f${i}.txt`,
      content: "x",
    }));
    expect(codes(good({ files: many }), "errors")).toContain("files-count");
    expect(
      codes(
        good({
          files: [{ path: "assets/big.txt", content: "x".repeat(SKILL_LIMITS.fileBytes + 1) }],
        }),
        "errors",
      ),
    ).toContain("file-size");
    const chunks = Array.from({ length: 5 }, (_, i) => ({
      path: `assets/c${i}.txt`,
      content: "x".repeat(SKILL_LIMITS.fileBytes),
    }));
    expect(codes(good({ files: chunks }), "errors")).toContain("total-size");
    expect(
      codes(
        good({
          files: [
            { path: "assets/a.txt", content: "a" },
            { path: "assets/A.txt", content: "b" },
          ],
        }),
        "errors",
      ),
    ).toContain("file-duplicate");
    expect(
      codes(good({ files: [{ path: "assets/a.bin", content: "a\u0000b" }] }), "errors"),
    ).toContain("file-binary");
    expect(codes(good({ files: [{ path: "../x", content: "a" }] }), "errors")).toContain(
      "file-path",
    );
  });
});

describe("validateSkillDraft soft warnings", () => {
  it("warns about long bodies", () => {
    const body = `${"line\n".repeat(501)}`;
    expect(codes(good({ body, files: [] }), "warnings")).toContain("body-long");
  });
  it("warns when the description has no when-clause", () => {
    expect(codes(good({ description: "Merges PDF files." }), "warnings")).toContain(
      "description-when",
    );
    expect(codes(good(), "warnings")).not.toContain("description-when");
  });
  it("warns about first and second person descriptions", () => {
    expect(codes(good({ description: "I can merge PDFs. Use when asked." }), "warnings")).toContain(
      "description-person",
    );
    expect(
      codes(good({ description: "You can merge PDFs. Use when asked." }), "warnings"),
    ).toContain("description-person");
  });
  it("warns about vague names", () => {
    expect(codes(good({ name: "helper" }), "warnings")).toContain("name-vague");
    expect(codes(good({ name: "data-utils" }), "warnings")).toContain("name-vague");
    expect(codes(good(), "warnings")).not.toContain("name-vague");
  });
  it("warns about long reference files without a table of contents", () => {
    const content = `${"text\n".repeat(120)}`;
    const files = [{ path: "references/api.md", content }];
    const body = "Read `references/api.md` first.";
    expect(codes(good({ body, files }), "warnings")).toContain("reference-toc");
    const withToc = [
      { path: "references/api.md", content: `# API\n\n## Contents\n- a\n\n${content}` },
    ];
    expect(codes(good({ body, files: withToc }), "warnings")).not.toContain("reference-toc");
  });
  it("warns about time-sensitive phrases and backslash paths", () => {
    expect(
      codes(
        good({ body: "Use the old API before August 2025.\nRun `scripts/merge.py`." }),
        "warnings",
      ),
    ).toContain("time-sensitive");
    expect(
      codes(good({ body: "Run `scripts\\merge.py`.\nAlso `scripts/merge.py`." }), "warnings"),
    ).toContain("backslash-path");
  });
  it("warns about scripts without usage or dependency notes", () => {
    const draft = good({
      body: "Run `scripts/merge.py`.",
      files: [{ path: "scripts/merge.py", content: "print('x')\n" }],
    });
    expect(codes(draft, "warnings")).toContain("script-undocumented");
    expect(codes(good(), "warnings")).not.toContain("script-undocumented");
  });
  it("warns on name collisions with existing skills", () => {
    expect(codes(good(), "warnings", ["pdf-merger"])).toContain("name-collision");
    expect(codes(good(), "warnings", ["other"])).not.toContain("name-collision");
  });
});

async function discovered(draft: SkillDraft) {
  const root = await mkdtemp(join(tmpdir(), "alisio-skillmd-"));
  try {
    await mkdir(join(root, draft.name), { recursive: true });
    await writeFile(join(root, draft.name, "SKILL.md"), renderSkillMd(draft));
    const skills = new Skills();
    await skills.discover([root]);
    return { skills, text: renderSkillMd(draft) };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("renderSkillMd", () => {
  it("builds frontmatter the real loader parses, quoting hostile text", async () => {
    const draft = good({
      description: 'Has: a colon, "quotes", # hash and\nnewline. Use when testing.',
      license: "MIT",
      compatibility: "Needs python3",
      metadata: { author: "Ana", version: "1.0" },
    });
    const { skills, text } = await discovered(draft);
    expect(skills.diagnostics).toEqual([]);
    expect(skills.items.get("pdf-merger")?.description).toBe(
      'Has: a colon, "quotes", # hash and newline. Use when testing.',
    );
    expect(text.startsWith("---\nname: pdf-merger\n")).toBe(true);
    expect(text).toContain('license: "MIT"');
    expect(text).toContain('compatibility: "Needs python3"');
    expect(text).toContain('  "author": "Ana"');
    expect(text.endsWith(`${draft.body.trim()}\n`)).toBe(true);
  });
  it("never lets a hostile description inject frontmatter keys", async () => {
    const { skills } = await discovered(good({ description: "x\n---\nname: evil\n" }));
    expect([...skills.items.keys()]).toEqual(["pdf-merger"]);
  });
});
