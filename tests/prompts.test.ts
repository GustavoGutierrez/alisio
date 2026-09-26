import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  expandSlashPrompt,
  loadPromptTemplates,
  parsePromptTemplate,
  promptSources,
  renderPromptTemplate,
  splitArguments,
} from "../packages/core/src/resources/prompts.ts";

const root = await mkdtemp(join(tmpdir(), "alisio-prompts-"));
afterAll(() => rm(root, { recursive: true, force: true }));
const meta = { name: "review", source: "user" as const, origin: "/x/review.md" };
const file = (front: string, body = "Body") => `---\n${front}\n---\n${body}`;

describe("parsing", () => {
  it("reads description, argument hint and requirements from frontmatter", () => {
    const t = parsePromptTemplate(
      file('description: Review code\nargument-hint: "[path]"\nrequires: [write]', "Review $1"),
      meta,
    );
    expect(t).toMatchObject({
      name: "review",
      description: "Review code",
      argumentHint: "[path]",
      requires: ["write"],
      body: "Review $1",
      source: "user",
      origin: "/x/review.md",
    });
    expect(parsePromptTemplate(file("description: d"), meta).requires).toEqual([]);
  });

  it("rejects missing frontmatter, missing description, unknown keys and bad requirements", () => {
    expect(() => parsePromptTemplate("no frontmatter", meta)).toThrow(/frontmatter/);
    expect(() => parsePromptTemplate(file("argument-hint: x"), meta)).toThrow(/description/);
    expect(() => parsePromptTemplate(file("description: d\ncolour: red"), meta)).toThrow(/colour/);
    expect(() => parsePromptTemplate(file("description: d\nrequires: [root]"), meta)).toThrow();
    expect(() => parsePromptTemplate(file("description: d", "  "), meta)).toThrow(/empty/);
    expect(() =>
      parsePromptTemplate(file("description: d"), { ...meta, name: "Bad Name" }),
    ).toThrow(/name/);
  });
});

describe("arguments", () => {
  it("splits like a shell, honoring quotes", () => {
    expect(splitArguments(`src/a.ts "two words" 'x y' last`)).toEqual([
      "src/a.ts",
      "two words",
      "x y",
      "last",
    ]);
    expect(splitArguments("   ")).toEqual([]);
  });

  it("substitutes $ARGUMENTS and $1..$9, leaving missing positions empty", () => {
    expect(
      renderPromptTemplate("All: $ARGUMENTS | first: $1 | second: $2 | tenth: $9.", `a "b c"`),
    ).toBe('All: a "b c" | first: a | second: b c | tenth: .');
    expect(renderPromptTemplate("Cost $10", "x")).toBe("Cost x0");
  });

  it("appends arguments when the body does not reference them", () => {
    expect(renderPromptTemplate("Do the thing.", "focus on tests")).toBe(
      "Do the thing.\n\nfocus on tests",
    );
    expect(renderPromptTemplate("Do the thing.", "")).toBe("Do the thing.");
  });
});

describe("loading and precedence", () => {
  const write = async (dir: string, name: string, text: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${name}.md`), text);
  };

  it("applies builtin < plugin < user < project, with deterministic plugin ties", async () => {
    const zeta = join(root, "p-zeta"),
      alpha = join(root, "p-alpha"),
      user = join(root, "user"),
      project = join(root, "project");
    await write(zeta, "shared", file("description: from zeta"));
    await write(alpha, "shared", file("description: from alpha"));
    await write(alpha, "plugin-only", file("description: plugin only"));
    await write(user, "init", file("description: user init"));
    await write(user, "broken", "not a template");
    await write(project, "init", file("description: project init"));
    const { templates, diagnostics } = await loadPromptTemplates([
      {
        kind: "builtin",
        id: "builtin",
        entries: [{ name: "init", text: file("description: builtin init") }],
      },
      { kind: "plugin", id: "zeta", dir: zeta },
      { kind: "plugin", id: "alpha", dir: alpha },
      { kind: "user", id: "user", dir: user },
      { kind: "project", id: "project", dir: project },
      { kind: "user", id: "user", dir: join(root, "missing") },
    ]);
    expect(templates.get("init")?.description).toBe("project init");
    expect(templates.get("shared")?.description).toBe("from alpha");
    expect(templates.get("plugin-only")?.source).toBe("plugin");
    expect(templates.has("broken")).toBe(false);
    expect(diagnostics).toContainEqual({
      type: "prompt_conflict",
      name: "shared",
      winner: "plugin:alpha",
      losers: ["plugin:zeta"],
    });
    expect(diagnostics).toContainEqual({
      type: "prompt_override",
      name: "init",
      winner: "project",
      overridden: ["builtin", "user"],
    });
    expect(
      diagnostics.some((d) => d.type === "prompt_invalid" && d.origin.endsWith("broken.md")),
    ).toBe(true);
  });

  it("never lets templates shadow reserved command names", async () => {
    const { templates, diagnostics } = await loadPromptTemplates(
      [
        {
          kind: "builtin",
          id: "builtin",
          entries: [{ name: "help", text: file("description: x") }],
        },
      ],
      { reserved: ["help"] },
    );
    expect(templates.has("help")).toBe(false);
    expect(diagnostics).toEqual([{ type: "prompt_shadowed", name: "help", origin: "builtin" }]);
  });

  it("includes project prompts only for trusted projects", () => {
    const base = {
      plugins: [{ plugin: "p", dir: "/p" }],
      userDir: "/u",
      projectDir: "/w/.alisio/prompts",
    };
    const kinds = (trusted: boolean) => promptSources({ ...base, trusted }).map((s) => s.kind);
    expect(kinds(false)).toEqual(["builtin", "plugin", "user"]);
    expect(kinds(true)).toEqual(["builtin", "plugin", "user", "project"]);
  });
});

describe("slash expansion", () => {
  it("expands known templates and ignores other input", async () => {
    const { templates } = await loadPromptTemplates([
      {
        kind: "builtin",
        id: "builtin",
        entries: [
          { name: "init", text: file("description: d", "Write AGENTS.md. Focus: $ARGUMENTS") },
        ],
      },
    ]);
    expect(expandSlashPrompt("/init  plugin SDK ", templates)).toMatchObject({
      name: "init",
      args: "plugin SDK",
      display: "/init plugin SDK",
      text: "Write AGENTS.md. Focus: plugin SDK",
    });
    expect(expandSlashPrompt("/unknown x", templates)).toBeUndefined();
    expect(expandSlashPrompt("init", templates)).toBeUndefined();
  });
});
