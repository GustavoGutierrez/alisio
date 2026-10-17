import { readFileSync } from "node:fs";
import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  planCompaction,
  reduceMessageSizes,
  reduceMessagesToBudget,
} from "../packages/core/src/core/compaction.ts";
import { mulberry32 } from "../scripts/bench/lib.ts";

/** Number of generated histories per property (each seed is one history). */
const HISTORIES = 300;

type Rng = () => number;
const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const text = (r: Rng) => "x".repeat(r() < 0.25 ? int(r, 3_000, 30_000) : int(r, 0, 120));

/** Fisher-Yates with the seeded generator, so out-of-order results stay reproducible. */
function shuffle<T>(r: Rng, items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = int(r, 0, i);
    const a = out[i] as T;
    out[i] = out[j] as T;
    out[j] = a;
  }
  return out;
}

/**
 * A random but VALID history: user turns made of rounds of assistant tool-call batches (1 to 4
 * parallel calls) whose results arrive in shuffled order and sometimes as errors, then an
 * optional final answer. With `dangling`, the last batch is left unanswered (an interrupted run).
 */
function generate(seed: number): { messages: Message[]; dangling: boolean } {
  const r = mulberry32(seed);
  const messages: Message[] = [];
  let n = 0;
  if (r() < 0.2) messages.push({ role: "user", summary: true, text: "checkpoint" });
  const turns = int(r, 1, 6);
  let dangling = false;
  for (let t = 0; t < turns; t++) {
    messages.push({ role: "user", text: text(r) });
    const rounds = int(r, 0, 4);
    for (let k = 0; k < rounds; k++) {
      const ids = Array.from({ length: int(r, 1, 4) }, () => `c${n++}`);
      messages.push({
        role: "assistant",
        text: r() < 0.3 ? text(r) : "",
        calls: ids.map((id) => ({ id, name: "read_file", arguments: `{"path":"${id}.ts"}` })),
      });
      const last = t === turns - 1 && k === rounds - 1;
      if (last && r() < 0.15) {
        dangling = true;
        break;
      }
      // Defensive case: a user message (e.g. queued steering) lands between results of one batch.
      const interrupt = ids.length > 1 && r() < 0.2 ? int(r, 1, ids.length - 1) : -1;
      shuffle(r, ids).forEach((id, i) => {
        if (i === interrupt) messages.push({ role: "user", text: "interjection" });
        messages.push({
          role: "tool",
          callId: id,
          result: {
            content: [{ type: "text", text: text(r) }],
            ...(r() < 0.2 ? { isError: true } : {}),
          },
        });
      });
    }
    if (r() < 0.8 && !dangling) messages.push({ role: "assistant", text: text(r), calls: [] });
    if (dangling) break;
  }
  return { messages, dangling };
}

/** Every result's call is in the list and every call in the list has its result. */
function unpaired(messages: Message[]): string[] {
  const calls = new Set(
    messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : [])),
  );
  const results = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])));
  return [
    ...[...results].filter((id) => !calls.has(id)).map((id) => `result without call: ${id}`),
    ...[...calls].filter((id) => !results.has(id)).map((id) => `call without result: ${id}`),
  ];
}

const signature = (messages: Message[]) =>
  messages.map((m) =>
    m.role === "tool"
      ? `tool:${m.callId}`
      : m.role === "assistant"
        ? `assistant:${m.calls.map((c) => c.id)}`
        : "user",
  );

describe("call/result boundaries survive compaction projections", () => {
  it("generates varied histories (sanity of the generator)", () => {
    const sizes = new Set<number>();
    let parallel = 0;
    let errors = 0;
    let dangling = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const h = generate(seed);
      sizes.add(h.messages.length);
      if (h.dangling) dangling++;
      parallel += h.messages.filter((m) => m.role === "assistant" && m.calls.length > 1).length;
      errors += h.messages.filter((m) => m.role === "tool" && m.result.isError).length;
      // Complete histories are valid inputs: the property is about what compaction does to them.
      if (!h.dangling) expect(unpaired(h.messages), `seed ${seed}`).toEqual([]);
    }
    expect(sizes.size).toBeGreaterThan(10);
    expect(parallel).toBeGreaterThan(50);
    expect(errors).toBeGreaterThan(50);
    expect(dangling).toBeGreaterThan(0);
  });

  it(`planCompaction never separates a call from its result (${HISTORIES} histories)`, () => {
    let planned = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const { messages, dangling } = generate(seed);
      const r = mulberry32(seed ^ 0x9e3779b9);
      const options = { keepTurns: int(r, 0, 3), minKeepMessages: int(r, 1, 6) };
      const plan = planCompaction(messages, options);
      const where = `seed ${seed} options ${JSON.stringify(options)}`;
      // Documented exception: an unanswered trailing call means there is no safe cut at all.
      if (dangling) {
        expect(plan, where).toBeUndefined();
        continue;
      }
      if (!plan) continue;
      planned++;
      expect(unpaired(plan.summarized), `${where} (summarized)`).toEqual([]);
      expect(unpaired(plan.kept), `${where} (kept)`).toEqual([]);
      expect(plan.kept[0]?.role, where).not.toBe("tool");
      expect([...plan.summarized, ...plan.kept], where).toEqual(messages);
    }
    expect(planned).toBeGreaterThan(50);
  });

  it(`reduceMessagesToBudget keeps every message and pairing (${HISTORIES} histories)`, () => {
    let truncated = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const { messages, dangling } = generate(seed);
      if (dangling) continue;
      const r = mulberry32(seed ^ 0x85ebca6b);
      const target = int(r, 200, 20_000);
      const reduced = reduceMessagesToBudget(messages, target);
      const where = `seed ${seed} target ${target}`;
      expect(signature(reduced.messages), where).toEqual(signature(messages));
      expect(unpaired(reduced.messages), where).toEqual([]);
      truncated += reduced.truncated;
    }
    expect(truncated).toBeGreaterThan(0);
  });

  it(`reduceMessageSizes keeps every message and pairing (${HISTORIES} histories)`, () => {
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const { messages, dangling } = generate(seed);
      if (dangling) continue;
      const reduced = reduceMessageSizes(messages, { maxToolResultChars: 500, maxTextChars: 800 });
      expect(signature(reduced.messages), `seed ${seed}`).toEqual(signature(messages));
      expect(unpaired(reduced.messages), `seed ${seed}`).toEqual([]);
    }
  });
});

describe("Context Governor wiring stays minimal", () => {
  it("runner.ts imports only the elision, governance, invariants and usage modules of context/*", () => {
    const source = readFileSync(
      new URL("../packages/core/src/core/runner.ts", import.meta.url),
      "utf8",
    );
    const imports = [...source.matchAll(/from\s+["']([^"']*\/context\/[^"']*)["']/g)].map(
      (m) => m[1],
    );
    expect(imports.sort()).toEqual([
      "../context/elide.ts",
      "../context/governance.ts",
      "../context/invariants.ts",
      "../context/usage.ts",
    ]);
    // The inventory is still not wired: only `elide.ts`/`governance.ts` (phase 2), `invariants.ts`
    // (phase 3) and `usage.ts` (phase 4) are wired.
    expect(source).not.toMatch(/context\/inventory/);
  });
});
