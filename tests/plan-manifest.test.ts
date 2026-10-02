/**
 * The plan manifest (`plan.json`) is generated from the Markdown the plan agent writes (Goal,
 * Context, Steps, Decisions, Risks, Verification) and from its accepted diagrams. A plan without
 * those sections still yields a valid, mostly empty manifest: the viewer then shows `plan.md`.
 */
import { describe, expect, it } from "vitest";
import { diagramHash, type PlanDiagram } from "../packages/core/src/plan/diagrams.ts";
import {
  buildPlanManifest,
  diffDiagrams,
  parsePlanHeadings,
  planContentHash,
  resolveSection,
  slugifyHeading,
} from "../packages/core/src/plan/manifest.ts";

const PLAN = `# Add a feature flag

## Goal
Ship a **kill switch** for the \`export\` feature so support can turn it off.

- Support can disable exports without a deploy
- The default stays on

## Context
The flag helper lives in \`src/flags.ts\`.

## Steps
1. Add the flag in \`src/flags.ts\`.
   It defaults to on.
2. Read it in [the export route](src/routes/export.ts).
3. **Test** the route.

## Decisions
- Use the existing flag store: no new dependency.

## Risks
- A cached value may stay stale for a minute.
- We did not check the mobile client.

## Verification
- \`pnpm test\`
`;

const diagram = (id: string, extra: Partial<PlanDiagram> = {}): PlanDiagram => ({
  id,
  title: `Diagram ${id}`,
  explanation: "Shows it.",
  type: "flow",
  syntax: "flowchart",
  mermaid: `flowchart TD\n ${id} --> b`,
  nodes: 2,
  ...extra,
});

const base = {
  planId: "p1",
  revision: 1,
  title: "Add a feature flag",
  hash: "h",
  markdown: PLAN,
  diagrams: [] as PlanDiagram[],
};

describe("headings and sections", () => {
  it("parses ATX headings outside code fences with unique ids", () => {
    const md = "# T\n## Steps\n```\n## not a heading\n```\n## Steps\n### Sub **bold**\n";
    expect(parsePlanHeadings(md)).toMatchObject([
      { id: "t", level: 1 },
      { id: "steps", level: 2, title: "Steps" },
      { id: "steps-2", level: 2 },
      { id: "sub-bold", level: 3, title: "Sub bold" },
    ]);
  });

  it("slugifies accents and punctuation", () => {
    expect(slugifyHeading("Verificación & Pruebas!")).toBe("verificacion-pruebas");
    expect(slugifyHeading("!!!")).toBe("section");
  });

  it("resolves a diagram section by id, title, or title prefix, and otherwise gives up", () => {
    const headings = parsePlanHeadings(PLAN);
    expect(resolveSection(headings, "Steps")).toBe("steps");
    expect(resolveSection(headings, "## steps")).toBe("steps");
    expect(resolveSection(headings, "verification")).toBe("verification");
    expect(resolveSection(headings, "Imple")).toBeUndefined();
    expect(resolveSection(headings, "Nothing like it")).toBeUndefined();
    expect(resolveSection(headings, undefined)).toBeUndefined();
  });
});

describe("buildPlanManifest from Markdown", () => {
  const manifest = buildPlanManifest(base);

  it("extracts the summary, goals, stages, decisions, risks and verification", () => {
    expect(manifest).toMatchObject({
      version: 1,
      planId: "p1",
      revision: 1,
      title: "Add a feature flag",
      summary: "Ship a kill switch for the export feature so support can turn it off.",
      goals: ["Support can disable exports without a deploy", "The default stays on"],
      stages: [
        { title: "Add the flag in src/flags.ts.", detail: "It defaults to on." },
        { title: "Read it in the export route." },
        { title: "Test the route." },
      ],
      considerations: [
        { kind: "decision", text: "Use the existing flag store: no new dependency." },
        { kind: "risk", text: "A cached value may stay stale for a minute." },
        { kind: "risk", text: "We did not check the mobile client." },
        { kind: "verification", text: "pnpm test" },
      ],
      diagrams: [],
      removed: [],
    });
    expect(manifest.sections.map((s) => s.id)).toEqual([
      "add-a-feature-flag",
      "goal",
      "context",
      "steps",
      "decisions",
      "risks",
      "verification",
    ]);
  });

  it("is deterministic and plain data (no Markdown or HTML in the text fields)", () => {
    expect(buildPlanManifest(base)).toEqual(manifest);
    const text = JSON.stringify([
      manifest.summary,
      manifest.goals,
      manifest.stages,
      manifest.considerations,
    ]);
    expect(text).not.toMatch(/\*\*|`|\]\(/);
  });

  it("understands Spanish headings and h3 steps", () => {
    const md =
      "# Plan\n## Objetivo\nHacer algo útil.\n## Pasos\n### Primero\nHaz esto.\n### Segundo\nHaz aquello.\n## Riesgos\n- Puede fallar.\n";
    expect(buildPlanManifest({ ...base, markdown: md })).toMatchObject({
      summary: "Hacer algo útil.",
      stages: [
        { title: "Primero", detail: "Haz esto." },
        { title: "Segundo", detail: "Haz aquello." },
      ],
      considerations: [{ kind: "risk", text: "Puede fallar." }],
    });
  });

  it("falls back for a plan without the expected sections", () => {
    const md =
      "# Just a title\n\nSome intro about the change.\n\n## Whatever\nText here.\n\n## Other thing\n- a\n- b\n";
    const fallback = buildPlanManifest({ ...base, markdown: md });
    expect(fallback.summary).toBe("Some intro about the change.");
    expect(fallback.goals).toEqual([]);
    expect(fallback.stages).toEqual([]);
    expect(fallback.considerations).toEqual([]);
    expect(fallback.sections.map((s) => s.title)).toEqual([
      "Just a title",
      "Whatever",
      "Other thing",
    ]);
  });

  it("copes with no headings and with an empty-ish plan", () => {
    expect(
      buildPlanManifest({ ...base, markdown: "Do the thing.\n\nThen the other." }),
    ).toMatchObject({
      summary: "Do the thing.",
      sections: [],
    });
    expect(buildPlanManifest({ ...base, markdown: "x" }).summary).toBe("x");
  });

  it("ignores unknown headings but keeps them as sections", () => {
    const md = "# T\n## Goal\nA goal.\n## Rollout notes\nSome notes.\n";
    const m = buildPlanManifest({ ...base, markdown: md });
    expect(m.sections.map((s) => s.id)).toEqual(["t", "goal", "rollout-notes"]);
    expect(m.considerations).toEqual([]);
  });

  it("caps long text and big lists", () => {
    const steps = Array.from({ length: 50 }, (_, i) => `${i + 1}. ${"word ".repeat(80)}`).join(
      "\n",
    );
    const m = buildPlanManifest({ ...base, markdown: `# T\n## Steps\n${steps}\n` });
    expect(m.stages).toHaveLength(30);
    expect(m.stages[0]?.title.length).toBeLessThanOrEqual(160);
  });
});

describe("diagrams in the manifest", () => {
  it("lists them with files, hashes, resolved sections and status new at first", () => {
    const d = diagram("flow", { section: "Steps" });
    const m = buildPlanManifest({
      ...base,
      diagrams: [d, diagram("lost", { section: "Not a heading" })],
    });
    expect(m.diagrams).toEqual([
      {
        id: "flow",
        title: "Diagram flow",
        explanation: "Shows it.",
        section: "steps",
        type: "flow",
        syntax: "flowchart",
        file: "diagrams/flow.mmd",
        hash: diagramHash(d),
        status: "new",
      },
      expect.objectContaining({ id: "lost", status: "new" }),
    ]);
    expect(m.diagrams[1]).not.toHaveProperty("section");
  });

  it("marks new, updated, unchanged and removed against the previous revision", () => {
    const keep = diagram("keep");
    const change = diagram("change");
    const gone = diagram("gone");
    const previous = [keep, change, gone].map((d) => ({
      id: d.id,
      title: d.title,
      hash: diagramHash(d),
    }));
    const m = buildPlanManifest({
      ...base,
      revision: 2,
      previous,
      diagrams: [
        keep,
        diagram("change", { mermaid: "flowchart TD\n change --> other" }),
        diagram("fresh"),
      ],
    });
    expect(Object.fromEntries(m.diagrams.map((d) => [d.id, d.status]))).toEqual({
      keep: "unchanged",
      change: "updated",
      fresh: "new",
    });
    expect(m.removed).toEqual([{ id: "gone", title: "Diagram gone" }]);
  });

  it("counts a changed title, explanation or section as an update", () => {
    const d = diagram("a");
    const previous = [{ id: "a", title: d.title, hash: diagramHash(d) }];
    for (const patch of [
      { title: "New title" },
      { explanation: "Else." },
      { section: "Goal" },
      { type: "components" as const },
    ]) {
      const { status } = diffDiagrams(
        [{ id: "a", title: d.title, hash: diagramHash({ ...d, ...patch }) }],
        previous,
      );
      expect(status.get("a")).toBe("updated");
    }
  });

  it("has no removed list without a previous revision", () => {
    expect(buildPlanManifest({ ...base, diagrams: [diagram("a")] }).removed).toEqual([]);
  });
});

describe("planContentHash", () => {
  it("is the plain SHA-256 of the Markdown without diagrams (the old hash) and covers diagrams otherwise", () => {
    const plain = planContentHash("hello", []);
    expect(plain).toBe("2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
    const one = planContentHash("hello", [{ id: "a", hash: "1" }]);
    expect(one).not.toBe(plain);
    expect(planContentHash("hello", [{ id: "a", hash: "2" }])).not.toBe(one);
    expect(planContentHash("hello", [{ id: "b", hash: "1" }])).not.toBe(one);
    expect(planContentHash("hello", [{ id: "a", hash: "1" }])).toBe(one);
  });
});
