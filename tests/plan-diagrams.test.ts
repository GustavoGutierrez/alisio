/**
 * Plan diagram validation (`exit_plan`): pure functions over Mermaid text. Mermaid cannot render
 * in Node, so these rules are what the server enforces without drawing anything.
 */
import { describe, expect, it } from "vitest";
import {
  DIAGRAM_MAX_BYTES,
  DIAGRAM_MAX_NODES,
  DIAGRAM_SYNTAXES,
  defaultDiagramType,
  diagramHash,
  diagramSyntax,
  estimateNodes,
  mermaidProblem,
  validateDiagrams,
} from "../packages/core/src/plan/diagrams.ts";

const FLOW = "flowchart LR\n  a([Request]):::input --> b[API]:::system --> c[(Store)]:::data";
const wrap = (mermaid: string, extra: Record<string, unknown> = {}) => ({
  id: "one",
  title: "One",
  explanation: "Shows one thing.",
  mermaid,
  ...extra,
});

describe("diagram types", () => {
  it.each([
    ["flowchart TD\n a-->b", "flowchart"],
    ["graph LR\n a-->b", "graph"],
    ["sequenceDiagram\n A->>B: hi", "sequenceDiagram"],
    ["stateDiagram-v2\n [*] --> A", "stateDiagram-v2"],
    ["erDiagram\n A ||--o{ B : has", "erDiagram"],
    ["gantt\n title x\n section s\n t :a1, 2026-01-01, 3d", "gantt"],
    ["mindmap\n  root((x))\n    a", "mindmap"],
    ["timeline\n  title x\n  2026 : launch", "timeline"],
  ])("accepts %s", (source, syntax) => {
    expect(diagramSyntax(source)).toBe(syntax);
    expect(DIAGRAM_SYNTAXES).toContain(syntax);
    expect(mermaidProblem(source)).toBeUndefined();
  });

  it.each([
    "pie\n a: 1",
    "gitGraph\n commit",
    "sankey-beta\n a,b,1",
    "architecture-beta\n service a()",
    "C4Context\n Person(a, A)",
  ])("rejects %s as not allowed", (source) => {
    expect(mermaidProblem(source)).toMatch(/not allowed/);
  });

  it("needs a diagram keyword as the first statement, after comments, directives and front matter", () => {
    expect(mermaidProblem("just some words")).toMatch(/not allowed|keyword/);
    expect(mermaidProblem("")).toMatch(/empty/);
    expect(mermaidProblem("%% a comment\nflowchart TD\n a-->b")).toBeUndefined();
    expect(mermaidProblem("---\ntitle: Nice\n---\nflowchart TD\n a-->b")).toBeUndefined();
    expect(mermaidProblem('%%{init: {"theme": "forest"}}%%\nflowchart TD\n a-->b')).toBeUndefined();
  });

  it("infers a purpose from the syntax", () => {
    expect(defaultDiagramType("sequenceDiagram")).toBe("sequence");
    expect(defaultDiagramType("stateDiagram-v2")).toBe("state");
    expect(defaultDiagramType("erDiagram")).toBe("data");
    expect(defaultDiagramType("flowchart")).toBe("flow");
  });
});

describe("forbidden constructs", () => {
  it.each([
    ['click a "https://example.com"', /click/],
    ['click a href "https://example.com"', /click|href/],
    ["click a call doIt()", /click/],
    ["link a: Docs @ https://example.com", /link/],
    ["a --> b[<b>bold</b>]", /HTML/],
    ["a --> b[Line<br/>break]", /HTML/],
    ["a --> b[<script>alert(1)</script>]", /HTML/],
    ["a --> b[<img src=x onerror=alert(1)>]", /HTML/],
    ['a --> b["go javascript:alert(1)"]', /javascript/],
    ['a --> b["data:text/html;base64,AAA"]', /data:/],
    ["style a fill:url(http://x.test/i.png)", /external|url/],
    ['a --> b["<a href=\\"x\\">y</a>"]', /HTML|href/],
  ])("rejects %s", (line, reason) => {
    expect(mermaidProblem(`flowchart TD\n  a --> b\n  ${line}`)).toMatch(reason);
  });

  it("does not mistake arrows, generics or ordinary words for HTML or links", () => {
    expect(
      mermaidProblem(
        "flowchart TD\n  a <--> b\n  b -.-> c\n  c ==> d\n  d -->|yes| e\n  e[Metadata: raw data and click handling]",
      ),
    ).toBeUndefined();
    expect(mermaidProblem("stateDiagram-v2\n  state c <<choice>>\n  [*] --> c")).toBeUndefined();
    // Free text lines of a mind map may start with a word that is a keyword elsewhere.
    expect(
      mermaidProblem("mindmap\n  root((Plan))\n    Click tracking\n    Link checks"),
    ).toBeUndefined();
  });

  it.each([
    '%%{init: {"securityLevel": "loose"}}%%',
    "%%{init: {'flowchart': {'htmlLabels': true}}}%%",
    '%%{initialize: {"secure": []}}%%',
    '%%{init: {"themeCSS": "a{}"}}%%',
    '%%{init: {"dompurifyConfig": {}}}%%',
  ])("rejects the init directive %s", (directive) => {
    expect(mermaidProblem(`${directive}\nflowchart TD\n a --> b`)).toMatch(/security settings/);
  });

  it("rejects security settings in the front matter", () => {
    expect(
      mermaidProblem("---\nconfig:\n  securityLevel: loose\n---\nflowchart TD\n a-->b"),
    ).toMatch(/security/);
  });

  it("rejects control characters", () => {
    expect(mermaidProblem("flowchart TD\n a --> b\u0007")).toMatch(/control/);
  });
});

describe("size and node limits", () => {
  it("rejects a diagram above the byte limit (default 8 KB) and honors a custom one", () => {
    const labels = Array.from(
      { length: 60 },
      (_, i) => `  n${i % 5} --> n${(i + 1) % 5}[${"x".repeat(150)}]`,
    ).join("\n");
    const big = `flowchart TD\n${labels}`;
    expect(new TextEncoder().encode(big).length).toBeGreaterThan(DIAGRAM_MAX_BYTES);
    expect(mermaidProblem(big)).toMatch(/larger than 8192/);
    expect(mermaidProblem(FLOW, { maxBytes: 20 })).toMatch(/larger than 20/);
    // Bytes, not characters.
    expect(mermaidProblem(`flowchart TD\n a[${"é".repeat(5000)}]`)).toMatch(/larger/);
  });

  it("estimates flowchart nodes and rejects more than the limit (default 40)", () => {
    expect(estimateNodes(FLOW, "flowchart")).toBe(3);
    const many = `flowchart TD\n${Array.from({ length: DIAGRAM_MAX_NODES + 1 }, (_, i) => `  n${i}[Node ${i}]`).join("\n")}`;
    expect(estimateNodes(many, "flowchart")).toBe(DIAGRAM_MAX_NODES + 1);
    expect(mermaidProblem(many)).toMatch(/more than 40 nodes/);
    const exactly = `flowchart TD\n${Array.from({ length: DIAGRAM_MAX_NODES }, (_, i) => `  n${i}[Node ${i}]`).join("\n")}`;
    expect(mermaidProblem(exactly)).toBeUndefined();
    expect(mermaidProblem(many, { maxNodes: 60 })).toBeUndefined();
  });

  it("ignores labels, edge text, classes and subgraph lines when counting flowchart nodes", () => {
    const source = [
      "flowchart LR",
      "  subgraph Backend",
      "    api[API server]:::system -->|calls| db[(Orders DB)]:::data",
      "  end",
      '  user(["A user"]) --> api',
      "  classDef risk fill:#fee",
      "  class user risk",
      "  style api stroke:#333",
    ].join("\n");
    expect(estimateNodes(source, "flowchart")).toBe(3);
  });

  it("estimates the other diagram types", () => {
    expect(
      estimateNodes(
        "sequenceDiagram\n participant U as User\n participant A\n U->>A: hi\n A-->>S: x",
        "sequenceDiagram",
      ),
    ).toBe(3);
    expect(
      estimateNodes(
        "stateDiagram-v2\n [*] --> Idle\n Idle --> Busy\n Busy --> [*]",
        "stateDiagram-v2",
      ),
    ).toBe(2);
    expect(
      estimateNodes(
        "erDiagram\n USER ||--o{ ORDER : places\n ORDER ||--|{ ITEM : has\n USER {\n  string id\n }",
        "erDiagram",
      ),
    ).toBe(3);
    expect(estimateNodes("mindmap\n  root((x))\n    a\n    b", "mindmap")).toBe(3);
    expect(
      estimateNodes(
        "gantt\n title t\n section s\n a :a1, 2026-01-01, 3d\n b :after a1, 2d",
        "gantt",
      ),
    ).toBe(2);
  });
});

describe("validateDiagrams", () => {
  const limits = { max: 5 };

  it("accepts a good diagram and fills the defaults", () => {
    const { accepted, dropped } = validateDiagrams([wrap(FLOW, { section: "Steps" })], limits);
    expect(dropped).toEqual([]);
    expect(accepted).toEqual([
      {
        id: "one",
        title: "One",
        explanation: "Shows one thing.",
        section: "Steps",
        type: "flow",
        syntax: "flowchart",
        mermaid: FLOW,
        nodes: 3,
      },
    ]);
  });

  it("keeps a valid type and falls back from an unknown one", () => {
    const [good, odd] = validateDiagrams(
      [wrap(FLOW, { type: "components" }), wrap(FLOW, { id: "two", type: "mystery" })],
      limits,
    ).accepted;
    expect(good?.type).toBe("components");
    expect(odd?.type).toBe("flow");
  });

  it.each([
    [{ id: "Not Kebab" }, /kebab-case/],
    [{ id: "has_underscore" }, /kebab-case/],
    [{ id: "x".repeat(41) }, /kebab-case/],
    [{ id: "" }, /kebab-case/],
    [{ title: " " }, /title/],
    [{ explanation: "" }, /explanation/],
    [{ mermaid: undefined }, /mermaid/],
    [{ mermaid: "   " }, /empty/],
  ])("drops %j", (patch, reason) => {
    const { accepted, dropped } = validateDiagrams([{ ...wrap(FLOW), ...patch }], limits);
    expect(accepted).toEqual([]);
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.reason).toMatch(reason);
  });

  it("drops a non-object item and a non-array argument without throwing", () => {
    expect(validateDiagrams(["x", null, 3], limits).dropped.map((d) => d.id)).toEqual([
      "#1",
      "#2",
      "#3",
    ]);
    expect(validateDiagrams("nope", limits).dropped[0]?.reason).toMatch(/array/);
    expect(validateDiagrams(undefined, limits)).toEqual({ accepted: [], dropped: [] });
  });

  it("keeps the first of a duplicated id", () => {
    const { accepted, dropped } = validateDiagrams(
      [wrap(FLOW), wrap(FLOW, { title: "Again" })],
      limits,
    );
    expect(accepted.map((d) => d.title)).toEqual(["One"]);
    expect(dropped[0]?.reason).toMatch(/already used/);
  });

  it("accepts only the first `max` diagrams, in order, and explains the rest", () => {
    const list = ["a", "b", "c", "d"].map((id) => wrap(FLOW, { id }));
    const { accepted, dropped } = validateDiagrams(list, { max: 2 });
    expect(accepted.map((d) => d.id)).toEqual(["a", "b"]);
    expect(dropped.map((d) => d.id)).toEqual(["c", "d"]);
    expect(dropped[0]?.reason).toMatch(/only 2 diagrams/);
    expect(validateDiagrams(list, { max: 0 }).dropped[0]?.reason).toMatch(/turned off/);
  });

  it("does not spend a slot on an invalid diagram", () => {
    const { accepted } = validateDiagrams(
      [wrap("pie\n a: 1", { id: "bad" }), wrap(FLOW, { id: "good" })],
      { max: 1 },
    );
    expect(accepted.map((d) => d.id)).toEqual(["good"]);
  });

  it("normalizes line endings and truncates long text fields", () => {
    const [d] = validateDiagrams(
      [wrap("flowchart TD\r\n a --> b\r\n", { title: "T".repeat(200) })],
      limits,
    ).accepted;
    expect(d?.mermaid).toBe("flowchart TD\n a --> b");
    expect(d?.title).toHaveLength(80);
  });
});

describe("diagramHash", () => {
  const base = { title: "T", explanation: "E", section: "steps", type: "flow", mermaid: FLOW };
  it("is stable, ignores line-ending noise and changes with every part", () => {
    expect(diagramHash(base)).toBe(
      diagramHash({ ...base, mermaid: `${FLOW.replace(/\n/g, "\r\n")}\n` }),
    );
    for (const patch of [
      { title: "T2" },
      { explanation: "E2" },
      { section: "goal" },
      { type: "components" },
      { mermaid: `${FLOW}\n d` },
    ])
      expect(diagramHash({ ...base, ...patch })).not.toBe(diagramHash(base));
  });
});
