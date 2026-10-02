/**
 * The web plan viewer at its module boundaries: recognizing a plan folder, reading its manifest
 * defensively, loading the folder through the artifact files route (missing or invalid manifest,
 * partial failures, stale responses), the section split and cross-navigation helpers, the
 * revision badges, Alisio's diagram palette and theme, EN/ES strings and the lazy loading that
 * keeps the initial bundle inside its budget.
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { slugifyHeading as coreSlug, parsePlanHeadings } from "@alisio/core";
import { describe, expect, it } from "vitest";
import { planStrings } from "../packages/web/src/components/plan/strings.ts";
import { locale } from "../packages/web/src/i18n/index.ts";
import {
  applyPalette,
  PALETTE,
  PALETTE_CLASSES,
  themeVariables,
  undefinedPaletteClasses,
} from "../packages/web/src/renderers/mermaid/palette.ts";
import { mermaidConfig } from "../packages/web/src/renderers/mermaid/render.ts";
import {
  createPlanLoader,
  diagramBadge,
  diagramDomId,
  diagramsBySection,
  groupDiagrams,
  isPlanArtifact,
  loadPlanBundle,
  parsePlanManifest,
  partDomId,
  sectionDomId,
  slugifyHeading,
  splitPlanSections,
} from "../packages/web/src/util/plan-view.ts";

const manifest = (patch: Record<string, unknown> = {}) => ({
  version: 1,
  planId: "p1",
  revision: 1,
  title: "Add a flag",
  hash: "h",
  summary: "Ship it.",
  goals: ["One", "Two"],
  stages: [{ title: "Do A", detail: "Details" }, { title: "Do B" }],
  considerations: [
    { kind: "decision", text: "Use X" },
    { kind: "risk", text: "Might break" },
    { kind: "verification", text: "pnpm test" },
  ],
  sections: [{ id: "steps", title: "Steps", level: 2 }],
  diagrams: [
    {
      id: "request-flow",
      title: "Request flow",
      explanation: "How it flows.",
      section: "steps",
      type: "flow",
      syntax: "flowchart",
      file: "diagrams/request-flow.mmd",
      hash: "a",
      status: "new",
    },
    {
      id: "parts",
      title: "Parts",
      explanation: "The parts.",
      type: "components",
      syntax: "flowchart",
      file: "diagrams/parts.mmd",
      hash: "b",
      status: "updated",
    },
  ],
  removed: [{ id: "old", title: "Old one" }],
  ...patch,
});
const json = (value: unknown) => JSON.stringify(value);

describe("isPlanArtifact", () => {
  it("is a folder whose entry is plan.md and that carries plan.json", () => {
    const files = [{ path: "plan.md" }, { path: "plan.json" }];
    expect(isPlanArtifact({ entry: "plan.md", files })).toBe(true);
    expect(isPlanArtifact({ entry: "plan.md", files: [{ path: "plan.md" }] })).toBe(false);
    expect(isPlanArtifact({ files })).toBe(false);
    expect(isPlanArtifact({ entry: "index.html", files })).toBe(false);
    expect(isPlanArtifact({ entry: "plan.md" })).toBe(false);
  });
});

describe("parsePlanManifest", () => {
  it("reads a valid manifest", () => {
    const parsed = parsePlanManifest(json(manifest()));
    expect(parsed).toMatchObject({
      version: 1,
      revision: 1,
      title: "Add a flag",
      summary: "Ship it.",
      goals: ["One", "Two"],
      stages: [{ title: "Do A", detail: "Details" }, { title: "Do B" }],
      removed: [{ id: "old", title: "Old one" }],
    });
    expect(parsed?.diagrams.map((d) => [d.id, d.type, d.status])).toEqual([
      ["request-flow", "flow", "new"],
      ["parts", "components", "updated"],
    ]);
  });

  it("ignores unknown fields and a newer version number", () => {
    const parsed = parsePlanManifest(json(manifest({ version: 7, future: { a: 1 }, extra: "x" })));
    expect(parsed).toBeDefined();
    expect(parsed).not.toHaveProperty("future");
    expect(parsed).not.toHaveProperty("extra");
  });

  it.each([
    ["not json", "{nope"],
    ["an array", "[]"],
    ["no version", json({ title: "x" })],
    ["a zero version", json({ version: 0, title: "x" })],
    ["no title", json({ version: 1 })],
  ])("returns undefined for %s", (_name, text) => {
    expect(parsePlanManifest(text)).toBeUndefined();
  });

  it("drops malformed items instead of failing", () => {
    const parsed = parsePlanManifest(
      json(
        manifest({
          goals: ["ok", 3, "", null],
          stages: [{ title: "ok" }, { detail: "no title" }, "text"],
          considerations: [{ kind: "risk", text: "ok" }, { kind: "risk" }, 5],
          diagrams: [
            { id: "a", title: "A", file: "diagrams/a.mmd" },
            { id: "dup", title: "First", file: "diagrams/dup.mmd" },
            { id: "dup", title: "Second", file: "diagrams/dup.mmd" },
            { id: "b", title: "B" },
            { title: "no id", file: "diagrams/x.mmd" },
            null,
          ],
        }),
      ),
    );
    expect(parsed?.goals).toEqual(["ok"]);
    expect(parsed?.stages).toEqual([{ title: "ok" }]);
    expect(parsed?.considerations).toEqual([{ kind: "risk", text: "ok" }]);
    expect(parsed?.diagrams.map((d) => d.id)).toEqual(["a", "dup"]);
    expect(parsed?.diagrams[0]).toMatchObject({ type: "other", status: "unchanged" });
  });

  it("never lets a diagram point outside diagrams/<id>.mmd", () => {
    const files = [
      "../../manifest.json",
      "diagrams/../plan.md",
      "/etc/passwd",
      "diagrams/a/b.mmd",
      "diagrams/A.mmd",
      "https://evil.test/x.mmd",
      "diagrams/ok.mmd",
    ];
    const parsed = parsePlanManifest(
      json(manifest({ diagrams: files.map((file, i) => ({ id: `d${i}`, title: "T", file })) })),
    );
    expect(parsed?.diagrams.map((d) => d.file)).toEqual(["diagrams/ok.mmd"]);
  });
});

describe("splitPlanSections", () => {
  const PLAN =
    "Intro text.\n\n# Title\nTop.\n\n## Goal\nShip.\n```md\n## not a heading\n```\n## Steps\n1. a\n## Steps\nAgain.\n";

  it("splits at headings outside code fences, with unique ids and the heading line included", () => {
    const sections = splitPlanSections(PLAN);
    expect(sections.map((s) => [s.id, s.level])).toEqual([
      ["", 0],
      ["title", 1],
      ["goal", 2],
      ["steps", 2],
      ["steps-2", 2],
    ]);
    expect(sections[0]?.text).toBe("Intro text.");
    expect(sections[2]?.text).toContain("## Goal\nShip.");
    expect(sections[2]?.text).toContain("## not a heading");
    expect(
      sections
        .map((s) => s.text)
        .join("\n")
        .replace(/\n+/g, "\n"),
    ).toContain("Again.");
  });

  it("gives the same ids as the manifest the server writes", () => {
    const markdown =
      "# Añadir **bandera**\n## Verificación & pruebas\n### Sub `x`\n## Steps\n## Steps\n";
    expect(splitPlanSections(markdown).map((s) => s.id)).toEqual(
      parsePlanHeadings(markdown).map((h) => h.id),
    );
    for (const title of ["Verificación & Pruebas!", "!!!", "A  B", "x".repeat(100)])
      expect(slugifyHeading(title)).toBe(coreSlug(title));
  });

  it("handles an empty plan and a plan without headings", () => {
    expect(splitPlanSections("")).toEqual([]);
    expect(splitPlanSections("just text")).toEqual([
      { id: "", title: "", level: 0, text: "just text" },
    ]);
  });
});

describe("diagram helpers", () => {
  const parsed = parsePlanManifest(json(manifest())) as NonNullable<
    ReturnType<typeof parsePlanManifest>
  >;

  it("separates the component diagrams from the rest", () => {
    const { components, others } = groupDiagrams(parsed.diagrams);
    expect(components.map((d) => d.id)).toEqual(["parts"]);
    expect(others.map((d) => d.id)).toEqual(["request-flow"]);
    const architecture = groupDiagrams([{ ...parsed.diagrams[0], type: "architecture" } as never]);
    expect(architecture.components).toHaveLength(1);
  });

  it("maps a section to the diagrams that illustrate it (the back-links)", () => {
    const map = diagramsBySection(parsed.diagrams);
    expect([...map.keys()]).toEqual(["steps"]);
    expect(map.get("steps")?.map((d) => d.id)).toEqual(["request-flow"]);
  });

  it("shows a badge only for new or updated diagrams from the second revision on", () => {
    const [flow, parts] = parsed.diagrams as [
      (typeof parsed.diagrams)[number],
      (typeof parsed.diagrams)[number],
    ];
    expect(diagramBadge({ revision: 1 }, flow)).toBeUndefined();
    expect(diagramBadge({ revision: 2 }, flow)).toBe("new");
    expect(diagramBadge({ revision: 2 }, parts)).toBe("updated");
    expect(diagramBadge({ revision: 3 }, { status: "unchanged" })).toBeUndefined();
  });

  it("builds distinct DOM ids for sections, diagrams and parts", () => {
    expect(sectionDomId("steps")).toBe("plan-section-steps");
    expect(sectionDomId("")).toBe("plan-section-top");
    expect(diagramDomId("steps")).toBe("plan-diagram-steps");
    expect(partDomId("plan")).toBe("plan-part-plan");
    expect(new Set([sectionDomId("a"), diagramDomId("a"), partDomId("a")]).size).toBe(3);
  });
});

describe("loadPlanBundle", () => {
  const files = ["plan.md", "plan.json", "diagrams/request-flow.mmd", "diagrams/parts.mmd"].map(
    (path) => ({ path }),
  );
  const store: Record<string, string> = {
    "plan.md": "# Plan\n## Steps\n1. a\n",
    "plan.json": json(manifest()),
    "diagrams/request-flow.mmd": "flowchart LR\n a --> b\n",
    "diagrams/parts.mmd": "flowchart TD\n x --> y\n",
  };
  const fetcher =
    (overrides: Record<string, string | Error> = {}, seen: string[] = []) =>
    async (path: string) => {
      seen.push(path);
      const value = path in overrides ? overrides[path] : store[path];
      if (value instanceof Error) throw value;
      if (value === undefined) throw new Error(`404 ${path}`);
      return value;
    };

  it("loads the plan, the manifest and every diagram through the files route", async () => {
    const seen: string[] = [];
    const bundle = await loadPlanBundle({ files, fetchText: fetcher({}, seen) });
    expect(bundle.manifest?.title).toBe("Add a flag");
    expect(bundle.markdown).toContain("## Steps");
    expect(bundle.diagrams["request-flow"]).toEqual({ source: "flowchart LR\n a --> b\n" });
    expect(bundle.diagrams.parts?.source).toContain("flowchart TD");
    expect(bundle.issues).toEqual([]);
    expect(bundle.fallbackDiagrams).toEqual([]);
    expect(seen.sort()).toEqual([
      "diagrams/parts.mmd",
      "diagrams/request-flow.mmd",
      "plan.json",
      "plan.md",
    ]);
  });

  it("falls back to the Markdown and the diagram files when the manifest is missing", async () => {
    const bundle = await loadPlanBundle({
      files: files.filter((f) => f.path !== "plan.json"),
      fetchText: fetcher(),
    });
    expect(bundle.manifest).toBeUndefined();
    expect(bundle.issues).toEqual(["manifest-missing"]);
    expect(bundle.fallbackDiagrams.map((d) => [d.id, d.title])).toEqual([
      ["parts", "parts"],
      ["request-flow", "request flow"],
    ]);
    expect(bundle.diagrams.parts?.source).toBeDefined();
    expect(bundle.markdown).toContain("# Plan");
  });

  it("treats an invalid manifest like a missing one, without throwing", async () => {
    for (const bad of ["{nope", json({ version: 1 }), "[]"]) {
      const bundle = await loadPlanBundle({ files, fetchText: fetcher({ "plan.json": bad }) });
      expect(bundle.manifest).toBeUndefined();
      expect(bundle.issues).toEqual(["manifest-invalid"]);
      expect(bundle.fallbackDiagrams).toHaveLength(2);
    }
    const unreadable = await loadPlanBundle({
      files,
      fetchText: fetcher({ "plan.json": new Error("boom") }),
    });
    expect(unreadable.issues).toEqual(["manifest-invalid"]);
  });

  it("keeps the other diagrams when one cannot be read, and when the manifest names a missing file", async () => {
    const bundle = await loadPlanBundle({
      files: files.filter((f) => f.path !== "diagrams/parts.mmd"),
      fetchText: fetcher({ "diagrams/request-flow.mmd": new Error("500 failed") }),
    });
    expect(bundle.diagrams["request-flow"]).toEqual({ error: "500 failed" });
    expect(bundle.diagrams.parts?.error).toContain("not in this plan folder");
    expect(bundle.manifest?.title).toBe("Add a flag");
  });

  it("rejects when plan.md itself cannot be read (nothing to show)", async () => {
    await expect(
      loadPlanBundle({ files, fetchText: fetcher({ "plan.md": new Error("gone") }) }),
    ).rejects.toThrow("gone");
  });
});

describe("createPlanLoader", () => {
  const bundle = (markdown: string) => ({
    markdown,
    diagrams: {},
    fallbackDiagrams: [],
    issues: [],
  });

  it("drops the answer of a plan the user already left", async () => {
    const releases = new Map<string, (value: ReturnType<typeof bundle>) => void>();
    const load = createPlanLoader((id) => new Promise((resolve) => releases.set(id, resolve)));
    const first = load("art_1");
    const second = load("art_2");
    releases.get("art_2")?.(bundle("two"));
    expect((await second)?.markdown).toBe("two");
    // The slow, superseded response arrives later and is ignored.
    releases.get("art_1")?.(bundle("one"));
    expect(await first).toBeUndefined();
  });

  it("drops the failure of a superseded request too, but reports the latest failure", async () => {
    const fails = new Map<string, (error: Error) => void>();
    const load = createPlanLoader((id) => new Promise((_resolve, reject) => fails.set(id, reject)));
    const first = load("a");
    const second = load("b");
    fails.get("a")?.(new Error("old"));
    expect(await first).toBeUndefined();
    fails.get("b")?.(new Error("new"));
    await expect(second).rejects.toThrow("new");
  });

  it("loads the same plan again after a failure (retry)", async () => {
    let calls = 0;
    const load = createPlanLoader(async () => {
      if (++calls === 1) throw new Error("flaky");
      return bundle("ok");
    });
    await expect(load("a")).rejects.toThrow("flaky");
    expect((await load("a"))?.markdown).toBe("ok");
  });
});

describe("Alisio diagram palette", () => {
  const FLOW = "flowchart LR\n  a([In]):::input --> b[API]:::system\n  b --> c[(Db)]:::data";

  it("appends a classDef for every palette class a flowchart uses and does not define", () => {
    const out = applyPalette(FLOW, "dark");
    expect(out.startsWith(FLOW)).toBe(true);
    for (const name of ["input", "system", "data"])
      expect(out).toMatch(new RegExp(`classDef ${name} fill:#`));
    expect(out).not.toMatch(/classDef (process|external|decision|risk)\b/);
  });

  it("uses the light or the dark variant", () => {
    expect(applyPalette(FLOW, "dark")).toContain(`fill:${PALETTE.dark.input.fill}`);
    expect(applyPalette(FLOW, "light")).toContain(`fill:${PALETTE.light.input.fill}`);
    expect(PALETTE.dark.input.fill).not.toBe(PALETTE.light.input.fill);
  });

  it("keeps the colors a diagram defines itself", () => {
    const own = `${FLOW}\n  classDef input fill:#fff,stroke:#000`;
    expect(applyPalette(own, "dark")).not.toMatch(/classDef input fill:#14283a/);
    expect(undefinedPaletteClasses(own)).toEqual(["data", "system"]);
    expect(undefinedPaletteClasses(`${FLOW}\n  classDef input,data fill:#fff`)).toEqual(["system"]);
  });

  it("understands `class A,B name` statements", () => {
    expect(undefinedPaletteClasses("flowchart TD\n  a --> b\n  class a,b risk")).toEqual(["risk"]);
  });

  it("returns anything that is not a flowchart, and flowcharts without classes, unchanged", () => {
    const sequence = "sequenceDiagram\n  A->>B: hi";
    expect(applyPalette(sequence, "dark")).toBe(sequence);
    const plain = "graph TD\n  a --> b";
    expect(applyPalette(plain, "light")).toBe(plain);
    expect(applyPalette("%% note\nflowchart TD\n a:::risk --> b", "light")).toContain(
      "classDef risk",
    );
  });

  it("covers every class of the style guide, with readable contrast between fill and text", () => {
    for (const theme of ["light", "dark"] as const)
      for (const name of PALETTE_CLASSES) {
        const { fill, color } = PALETTE[theme][name];
        expect(luminanceGap(fill, color), `${theme} ${name}`).toBeGreaterThan(4.5);
      }
  });

  it("themes Mermaid in Alisio's colors only when asked, never touching security", () => {
    const plain = mermaidConfig("dark");
    expect(plain).toMatchObject({ theme: "dark", securityLevel: "strict", htmlLabels: false });
    expect(plain).not.toHaveProperty("themeVariables");
    expect(mermaidConfig("light").theme).toBe("default");
    for (const theme of ["dark", "light"] as const) {
      const themed = mermaidConfig(theme, true);
      expect(themed).toMatchObject({ theme: "base", securityLevel: "strict", htmlLabels: false });
      expect(themed.themeVariables).toEqual(themeVariables(theme));
    }
    expect(themeVariables("dark")).toMatchObject({ darkMode: true });
    expect(themeVariables("light")).toMatchObject({ darkMode: false });
    expect(themeVariables("dark").background).not.toBe(themeVariables("light").background);
  });
});

/** WCAG contrast ratio of two #rrggbb colors. */
function luminanceGap(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const c = Number.parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("plan viewer strings", () => {
  it("English and Spanish keep the same keys and placeholders, with no empty text", () => {
    expect(Object.keys(planStrings.es).sort()).toEqual(Object.keys(planStrings.en).sort());
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    for (const [key, text] of Object.entries(planStrings.en)) {
      const spanish = (planStrings.es as Record<string, string>)[key] as string;
      expect(spanish, key).not.toBe("");
      expect(placeholders(spanish), key).toEqual(placeholders(text));
    }
  });

  it("follows the locale signal", async () => {
    const { pk, diagramCountText } = await import("../packages/web/src/components/plan/strings.ts");
    const before = locale.value;
    try {
      locale.value = "en";
      expect(diagramCountText(1)).toBe("1 diagram");
      expect(diagramCountText(3)).toBe("3 diagrams");
      expect(pk("revision", { n: 2 })).toBe("Revision 2");
      locale.value = "es";
      expect(diagramCountText(3)).toBe("3 diagramas");
      expect(pk("revision", { n: 2 })).toBe("Revisión 2");
    } finally {
      locale.value = before;
    }
  });
});

describe("lazy loading", () => {
  /** Modules reachable from `entry` through static imports only (dynamic `import()` is a chunk boundary). */
  function staticGraph(entry: string): Set<string> {
    const seen = new Set<string>();
    const visit = (file: string) => {
      if (seen.has(file) || !/\.(tsx?|css)$/.test(file)) return;
      seen.add(file);
      if (file.endsWith(".css")) return;
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(
        /(?:^|\n)\s*(?:import|export)\s[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']/g,
      )) {
        const spec = match[1] ?? match[2];
        if (!spec?.startsWith(".")) continue;
        visit(resolve(dirname(file), spec));
      }
    };
    visit(resolve(entry));
    return seen;
  }

  it("keeps the viewer, its styles and the Mermaid engine out of the initial chunk", () => {
    const initial = [...staticGraph("packages/web/src/main.tsx")].map((file) =>
      file.replace(`${resolve(".")}/`, ""),
    );
    // The walk really follows the app's imports.
    expect(initial).toContain("packages/web/src/app.tsx");
    expect(initial).toContain("packages/web/src/store/app.ts");
    for (const heavy of [
      "packages/web/src/components/plan/PlanViewer.tsx",
      "packages/web/src/components/plan/plan.module.css",
      "packages/web/src/components/plan/strings.ts",
      "packages/web/src/renderers/mermaid/engine.ts",
      "packages/web/src/renderers/mermaid/palette.ts",
    ])
      expect(initial, heavy).not.toContain(heavy);
  });

  it("loads the viewer through a dynamic import from the panel's small wrapper", () => {
    const wrapper = readFileSync(
      join("packages/web/src/components/artifacts/LazyPlanViewer.tsx"),
      "utf8",
    );
    expect(wrapper).toMatch(/import\("\.\.\/plan\/PlanViewer\.tsx"\)/);
    expect(wrapper).not.toMatch(/^import .* from "\.\.\/plan\/PlanViewer/m);
  });
});
