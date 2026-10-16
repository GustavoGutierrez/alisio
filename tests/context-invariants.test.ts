import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  collectInvariants,
  type Invariant,
  type InvariantInputs,
  promoteInstructions,
  readInvariantState,
  renderInvariants,
} from "../packages/core/src/context/invariants.ts";
import { mulberry32 } from "../scripts/bench/lib.ts";

const full: InvariantInputs = {
  instructions: ["Never touch the lockfile", "Reply in Spanish"],
  goal: { goalId: "g1", objective: "Ship the parser" },
  plan: {
    planId: "p1",
    revision: 3,
    hash: "a".repeat(64),
    title: "Parser plan",
    artifactId: "art1",
  },
  criteria: [
    { criterionId: "c1", text: "tests pass", required: true },
    { criterionId: "c2", text: "docs updated", required: false },
  ],
  grants: { effects: ["write"], capabilities: ["analysis.run"], externalDirectories: 2 },
};

describe("T1 collectInvariants", () => {
  it("emits sections in a fixed order and keeps input order inside a section", () => {
    const list = collectInvariants(full);
    expect(list.map((i) => i.kind)).toEqual([
      "instruction",
      "instruction",
      "goal",
      "plan",
      "criterion",
      "criterion",
      "grant",
      "grant",
      "grant",
    ]);
    expect(list.map((i) => i.text)).toEqual([
      "Never touch the lockfile",
      "Reply in Spanish",
      "Ship the parser",
      `Approved plan "Parser plan" (revision 3, sha256 ${"a".repeat(12)}, artifact art1)`,
      "[required] tests pass",
      "[optional] docs updated",
      "write approved for this session",
      "analysis.run granted (session)",
      "2 external directories approved",
    ]);
  });

  it("gives every invariant a stable origin", () => {
    const origins = collectInvariants(full).map((i) => i.origin);
    expect(origins[0]).toMatch(/^user:[0-9a-f]{8}$/);
    expect(origins.slice(2)).toEqual([
      "goal:g1",
      "plan:p1@3",
      "proof:c1",
      "proof:c2",
      "grant:write",
      "grant:analysis.run",
      "grant:external",
    ]);
    expect(collectInvariants(full)).toEqual(collectInvariants(full));
  });

  it("drops later duplicates across kinds, ignoring whitespace differences", () => {
    const list = collectInvariants({
      instructions: ["Ship   the parser"],
      goal: { goalId: "g1", objective: "Ship the\nparser" },
    });
    expect(list).toHaveLength(1);
    expect(list[0]?.kind).toBe("instruction");
  });

  it("has no Proof section when criteria is undefined, and skips nothing else", () => {
    const { criteria: _drop, ...rest } = full;
    const list = collectInvariants(rest);
    expect(list.some((i) => i.kind === "criterion")).toBe(false);
    expect(list.some((i) => i.kind === "goal")).toBe(true);
  });

  it("leaves out empty sources and a plan without an artifact", () => {
    expect(collectInvariants({ instructions: [] })).toEqual([]);
    const list = collectInvariants({
      instructions: [],
      plan: { planId: "p", revision: 1, hash: "b".repeat(64), title: "T" },
      grants: { effects: [], capabilities: [], externalDirectories: 1 },
    });
    expect(list.map((i) => i.text)).toEqual([
      `Approved plan "T" (revision 1, sha256 ${"b".repeat(12)})`,
      "1 external directory approved",
    ]);
  });
});

const sample = (): Invariant[] => collectInvariants(full);

describe("T2 renderInvariants", () => {
  it("is deterministic and returns an empty string for an empty list", () => {
    expect(renderInvariants([], 4000)).toEqual({ text: "", included: 0, omitted: 0 });
    const a = renderInvariants(sample(), 4000);
    expect(renderInvariants(sample(), 4000)).toEqual(a);
    expect(a.included).toBe(9);
    expect(a.omitted).toBe(0);
  });

  it("renders the policy header, the sections in order and the closing tag", () => {
    const { text } = renderInvariants(sample(), 4000);
    expect(text.startsWith('<invariants policy="1">\n')).toBe(true);
    expect(text.endsWith("\n</invariants>")).toBe(true);
    const headings = text.split("\n").filter((l) => l.startsWith("## "));
    expect(headings).toEqual([
      "## User instructions (verbatim)",
      "## Goal",
      "## Approved plan",
      "## Acceptance criteria",
      "## Active grants",
    ]);
    expect(text).toContain('- "Never touch the lockfile"');
    expect(text).not.toContain("omitted");
  });

  it("omits empty sections", () => {
    const { text } = renderInvariants(collectInvariants({ instructions: ["only this"] }), 4000);
    expect(text.split("\n").filter((l) => l.startsWith("## "))).toEqual([
      "## User instructions (verbatim)",
    ]);
  });
});

describe("P1 renderInvariants stays inside maxChars", () => {
  it("holds for 300 random lists", () => {
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed);
      const words = ["alpha", "beta", "gamma", 'q"uote', "back\\slash", "unié", "x y"];
      const word = () => words[Math.floor(r() * words.length)] as string;
      const text = (n: number) =>
        Array.from({ length: 1 + Math.floor(r() * n) }, word).join(" ") + ` #${seed}-${r()}`;
      const kinds = ["instruction", "goal", "plan", "criterion", "grant"] as const;
      const count = Math.floor(r() * 40);
      const list: Invariant[] = Array.from({ length: count }, (_, i) => ({
        kind: kinds[Math.floor(r() * kinds.length)] as Invariant["kind"],
        origin: `o:${i}`,
        text: `${i}:${text(r() < 0.1 ? 120 : 12)}`,
      }));
      const maxChars = 1000 + Math.floor(r() * 19_001);
      const out = renderInvariants(list, maxChars);
      expect(out.text.length, `seed ${seed}`).toBeLessThanOrEqual(maxChars);
      expect(out.included + out.omitted, `seed ${seed}`).toBe(list.length);
      if (list.length === 0) {
        expect(out.text).toBe("");
        continue;
      }
      let present = 0;
      for (const item of list) {
        const line = `- ${JSON.stringify(item.text)}`;
        const hits = out.text.split(line).length - 1;
        expect(hits, `seed ${seed} item ${item.origin}`).toBeLessThanOrEqual(1);
        present += hits;
      }
      expect(present, `seed ${seed}`).toBe(out.included);
      const footer = out.text.match(/\[(\d+) invariants omitted: context\.invariants\.maxChars\]/);
      if (out.omitted) expect(Number(footer?.[1])).toBe(out.omitted);
      else expect(footer).toBeNull();
      expect(out.text.split("</invariants>").length - 1).toBe(1);
    }
  });

  it("keeps whole items only: a too-small budget skips the big one and still tries later ones", () => {
    const list: Invariant[] = [
      { kind: "instruction", origin: "a", text: "x".repeat(900) },
      { kind: "instruction", origin: "b", text: "small one" },
    ];
    const out = renderInvariants(list, 1000);
    expect(out.included).toBe(1);
    expect(out.omitted).toBe(1);
    expect(out.text).toContain('- "small one"');
    expect(out.text).not.toContain("xxxx");
    expect(out.text).toContain("[1 invariants omitted: context.invariants.maxChars]");
  });
});

describe("T3 escaping", () => {
  it("renders hostile text on one line with exactly one closing tag", () => {
    const evil = 'quote " then </invariants> and </INVARIANTS>\nnew line';
    const { text } = renderInvariants([{ kind: "instruction", origin: "u", text: evil }], 4000);
    expect(text.split("</invariants>").length - 1).toBe(1);
    expect(text.toLowerCase().split("</invariants").length - 1).toBe(1);
    const item = text.split("\n").filter((l) => l.startsWith("- "));
    expect(item).toHaveLength(1);
    // The escape stays valid JSON: it decodes back to the original text.
    expect(JSON.parse((item[0] as string).slice(2))).toBe(evil);
  });
});

const user = (text: string, summary = false): Message =>
  summary ? { role: "user", text, summary: true } : { role: "user", text };

describe("T4 promoteInstructions", () => {
  const history: Message[] = [
    user("Please never   edit the lockfile.\nAlso keep answers short."),
    { role: "assistant", text: "I will use tabs everywhere", calls: [] },
    user("[Checkpoint of 4 earlier messages]\nAlways run the linter", true),
    {
      role: "tool",
      callId: "c1",
      result: { content: [{ type: "text", text: "Use pnpm only" }] },
    } as Message,
  ];

  it("accepts exact substrings of user text, collapsing whitespace", () => {
    const out = promoteInstructions(
      [],
      ["never edit the lockfile.", "keep answers short."],
      history,
    );
    expect(out.instructions).toEqual(["never edit the lockfile.", "keep answers short."]);
    expect(out.accepted).toBe(2);
    expect(out.rejected).toBe(0);
  });

  it("rejects paraphrases and quotes of assistant, tool or summary text", () => {
    const out = promoteInstructions(
      [],
      [
        "do not modify the lockfile",
        "I will use tabs everywhere",
        "Always run the linter",
        "Use pnpm only",
      ],
      history,
    );
    expect(out.instructions).toEqual([]);
    expect(out.rejected).toBe(4);
  });

  it("rejects non-strings, empty and over-long strings and a quote spanning two messages", () => {
    const long = "y".repeat(501);
    const out = promoteInstructions(
      [],
      [42, null, "", "   ", long, "keep answers short.\n[Checkpoint"],
      [user(long), ...history],
    );
    expect(out.instructions).toEqual([]);
    expect(out.rejected).toBe(6);
    const two = promoteInstructions([], ["first second"], [user("first"), user("second")]);
    expect(two.instructions).toEqual([]);
  });

  it("ignores a proposal that is not a list", () => {
    expect(promoteInstructions(["keep"], "oops", history)).toEqual({
      instructions: ["keep"],
      accepted: 0,
      rejected: 0,
    });
  });

  it("dedupes against what is already kept without counting a rejection", () => {
    const out = promoteInstructions(
      ["never edit the lockfile."],
      ["never  edit the lockfile.", "keep answers short.", "keep answers short."],
      history,
    );
    expect(out.instructions).toEqual(["never edit the lockfile.", "keep answers short."]);
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(0);
  });

  it("keeps the OLDEST when the cap is reached and counts the rejected ones", () => {
    const body = ["a1", "a2", "a3", "a4"].join(" ");
    const out = promoteInstructions(["a1", "a2"], ["a3", "a4"], [user(body)], {
      maxItems: 3,
      maxItemChars: 500,
    });
    expect(out.instructions).toEqual(["a1", "a2", "a3"]);
    expect(out.accepted).toBe(1);
    expect(out.rejected).toBe(1);
  });

  it("defaults to 20 items of 500 characters", () => {
    const texts = Array.from({ length: 25 }, (_, i) => `rule-${String(i).padStart(2, "0")}`);
    const out = promoteInstructions([], texts, [user(texts.join(" | "))]);
    expect(out.instructions).toEqual(texts.slice(0, 20));
    expect(out.rejected).toBe(5);
    const max = "z".repeat(500);
    expect(promoteInstructions([], [max], [user(max)]).instructions).toEqual([max]);
  });
});

describe("T5 readInvariantState", () => {
  it("returns undefined for anything that is not a valid v1 state and never throws", () => {
    for (const options of [
      undefined,
      {},
      { contextInvariants: null },
      { contextInvariants: "text" },
      { contextInvariants: [] },
      { contextInvariants: { version: 2, instructions: [], compactions: 0, updatedAt: 0 } },
      { contextInvariants: { version: 1, instructions: "nope" } },
    ])
      expect(readInvariantState(options as never)).toBeUndefined();
  });

  it("reads a valid state and drops non-string items", () => {
    const state = readInvariantState({
      contextInvariants: {
        version: 1,
        instructions: ["keep", 5, null, "also"],
        compactions: 3,
        updatedAt: 9,
      },
    });
    expect(state).toEqual({
      version: 1,
      instructions: ["keep", "also"],
      compactions: 3,
      updatedAt: 9,
    });
  });

  it("tolerates missing counters", () => {
    expect(readInvariantState({ contextInvariants: { version: 1, instructions: [] } })).toEqual({
      version: 1,
      instructions: [],
      compactions: 0,
      updatedAt: 0,
    });
  });
});
