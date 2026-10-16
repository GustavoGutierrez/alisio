import type { Message } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  elisionCandidates,
  type Projection,
  projectContext,
} from "../packages/core/src/context/elide.ts";
import { buildInventory } from "../packages/core/src/context/inventory.ts";
import { estimateTokens, reduceMessagesToBudget } from "../packages/core/src/core/compaction.ts";
import { mulberry32 } from "../scripts/bench/lib.ts";

/** Number of generated histories per property (each seed is one history). */
const HISTORIES = 300;

const H1 = "a".repeat(64);
const H2 = "b".repeat(64);
const H3 = "c".repeat(64);
const PLAIN = "plain match line, not ripgrep json: ".repeat(3);

const user = (text: string): Message => ({ role: "user", text });
const asst = (text: string, calls: Array<[string, string, object]> = []): Message => ({
  role: "assistant",
  text,
  calls: calls.map(([id, name, args]) => ({ id, name, arguments: JSON.stringify(args) })),
});
const result = (callId: string, text: string, isError = false): Message => ({
  role: "tool",
  callId,
  result: { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) },
});
const readOut = (path: string, sha256: string | null, content = "1: x") =>
  JSON.stringify({ path, sha256, startLine: 1, content, truncated: false });
const bgOut = (id: string, text: string, next = 0) =>
  JSON.stringify({ id, status: "running", text, next_offset: next, eof: false });
const searchOut = (matches: string[], elapsed: number, exitCode = 0) =>
  JSON.stringify({
    exitCode,
    stdout: [
      ...matches.map((m) =>
        JSON.stringify({ type: "match", data: { path: { text: "src/a.ts" }, lines: { text: m } } }),
      ),
      JSON.stringify({ type: "summary", data: { elapsed_total: { nanos: elapsed } } }),
    ].join("\n"),
    stderr: "",
    truncated: false,
  });

/** A call + its result as two messages. */
const exchange = (
  id: string,
  name: string,
  args: object,
  out: string,
  isError = false,
): Message[] => [asst("", [[id, name, args]]), result(id, out, isError)];

/** Two closing turns so earlier messages are old enough for the default minAge of 2. */
const closing: Message[] = [user("next"), asst("done"), user("more"), asst("done again")];

const opts = { minAgeTurns: 2, epochMessages: 0 };
const stubRead = (path: string, sha8: string, lines = "") =>
  `[elided: read_file ${JSON.stringify(path)}@${sha8}${lines}; re-read to view]`;

const toolText = (m: Message | undefined) =>
  m?.role === "tool" ? m.result.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";
const elidedIndexes = (p: Projection) => p.elisions.map((e) => e.index);

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

describe("projectContext table of cases", () => {
  it("T1 a read superseded by a read with another sha256 becomes the exact stub", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    const p = projectContext(h, opts);
    expect(toolText(p.messages[2])).toBe(stubRead("a.ts", "aaaaaaaa"));
    expect(p.messages[4]).toBe(h[4]);
    expect(p.elisions).toHaveLength(1);
    expect(p.elisions[0]).toMatchObject({
      index: 2,
      callId: "c1",
      reason: "superseded_read",
      witnessCallId: "c2",
    });
    expect(p.elisions[0]?.segmentId).toMatch(/^[0-9a-f]{12}$/);
  });

  it("T1 the stub carries the requested line window only when it was given", () => {
    const h = [
      user("go"),
      ...exchange(
        "c1",
        "read_file",
        { path: "a.ts", startLine: 10, limit: 50 },
        readOut("a.ts", H1),
      ),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    expect(toolText(projectContext(h, opts).messages[2])).toBe(
      stubRead("a.ts", "aaaaaaaa", " lines 10+50"),
    );
  });

  it("T2 a re-read with the same sha256 is not elided", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...closing,
    ];
    const p = projectContext(h, opts);
    expect(p.elisions).toEqual([]);
    expect(p.messages).toBe(h);
  });

  it("T3 a -> b -> a: the first read is elided at every prefix once it is old enough", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...exchange("c3", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...closing,
    ];
    const stub = stubRead("a.ts", "aaaaaaaa");
    let seen = false;
    for (let k = 1; k <= h.length; k++) {
      const p = projectContext(h.slice(0, k), opts);
      const isStub = toolText(p.messages[2]) === stub;
      if (isStub) seen = true;
      else expect(seen, `un-elided again at prefix ${k}`).toBe(false);
    }
    expect(seen).toBe(true);
    // The middle read (b) is superseded by the final a: elided too, the last one never.
    const full = projectContext(h, opts);
    expect(elidedIndexes(full)).toEqual([2, 4]);
  });

  it("T4 a read followed by a successful edit/write is elided; by a failed edit it is not", () => {
    const base = exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1));
    const edit = [
      user("go"),
      ...base,
      ...exchange(
        "c2",
        "edit_file",
        { path: "a.ts" },
        JSON.stringify({ path: "a.ts", sha256: H2 }),
      ),
      ...closing,
    ];
    const failed = [
      user("go"),
      ...base,
      ...exchange("c2", "edit_file", { path: "a.ts" }, "precondition failed", true),
      ...closing,
    ];
    const write = [
      user("go"),
      ...base,
      ...exchange(
        "c2",
        "write_file",
        { path: "a.ts" },
        JSON.stringify({ path: "a.ts", sha256: H2 }),
      ),
      ...closing,
    ];
    expect(elidedIndexes(projectContext(edit, opts))).toEqual([2]);
    expect(elidedIndexes(projectContext(failed, opts))).toEqual([]);
    expect(elidedIndexes(projectContext(write, opts))).toEqual([2]);
  });

  it("T5 a single old read of a path and an old error read are never elided", () => {
    const single = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...closing,
    ];
    expect(projectContext(single, opts).elisions).toEqual([]);
    const errored = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, "File not found: a.ts", true),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    expect(projectContext(errored, opts).elisions).toEqual([]);
  });

  it("T6 results younger than minAgeTurns assistant messages are kept, then elided by ageing", () => {
    const head = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
    ];
    // Assistant messages after the first read: only the one that issued c2.
    expect(projectContext(head, opts).elisions).toEqual([]);
    expect(projectContext([...head, asst("one more")], opts).elisions).toHaveLength(1);
    // minAgeTurns is clamped to at least 1: 0 never elides the current turn's own result.
    const clamped = projectContext(head, { minAgeTurns: 0, epochMessages: 0 });
    expect(clamped.elisions).toHaveLength(1);
    expect(clamped.elisions[0]?.index).toBe(2);
    const lastOnly = [...head.slice(0, 3)];
    expect(projectContext(lastOnly, { minAgeTurns: 0, epochMessages: 0 }).elisions).toEqual([]);
    // A larger minAge waits longer.
    expect(
      projectContext([...head, asst("one more")], { minAgeTurns: 3, epochMessages: 0 }).elisions,
    ).toEqual([]);
  });

  it("T7 bg_output: identical normalized arguments and empty polls are elided; incremental reads are not", () => {
    const same = [
      user("go"),
      ...exchange("c1", "bg_output", { id: "t1" }, bgOut("t1", "abc", 3)),
      ...exchange("c2", "bg_output", { id: "t1", offset: 0, limit: 16384 }, bgOut("t1", "abc", 3)),
      ...closing,
    ];
    const p = projectContext(same, opts);
    expect(toolText(p.messages[2])).toBe(
      '[elided: bg_output "t1" offset 0; a later bg_output covers it]',
    );
    expect(p.elisions[0]).toMatchObject({ reason: "stale_bg_output", witnessCallId: "c2" });

    const incremental = [
      user("go"),
      ...exchange("c1", "bg_output", { id: "t1" }, bgOut("t1", "abc", 16384)),
      ...exchange("c2", "bg_output", { id: "t1", offset: 16384 }, bgOut("t1", "def", 16390)),
      ...closing,
    ];
    expect(projectContext(incremental, opts).elisions).toEqual([]);

    const empty = [
      user("go"),
      ...exchange("c1", "bg_output", { id: "t1" }, bgOut("t1", "", 0)),
      ...exchange("c2", "bg_output", { id: "t1", offset: 0, limit: 100 }, bgOut("t1", "xyz", 3)),
      ...closing,
    ];
    expect(elidedIndexes(projectContext(empty, opts))).toEqual([2]);

    const emptyAlone = [
      user("go"),
      ...exchange("c1", "bg_output", { id: "t1" }, bgOut("t1", "", 0)),
      ...exchange("c2", "bg_output", { id: "other" }, bgOut("other", "xyz", 3)),
      ...closing,
    ];
    expect(projectContext(emptyAlone, opts).elisions).toEqual([]);
  });

  it("T8 search_text: same arguments (any key order) and same matches are elided, whatever the elapsed time", () => {
    const h = [
      user("go"),
      ...exchange("c1", "search_text", { pattern: "foo", path: "src" }, searchOut(["foo 1"], 111)),
      ...exchange("c2", "search_text", { path: "src", pattern: "foo" }, searchOut(["foo 1"], 999)),
      ...closing,
    ];
    const p = projectContext(h, opts);
    expect(toolText(p.messages[2])).toBe(
      '[elided: search_text "foo"; identical to a later result]',
    );
    expect(p.elisions[0]).toMatchObject({ reason: "duplicate_search", witnessCallId: "c2" });
    const different = [
      user("go"),
      ...exchange("c1", "search_text", { pattern: "foo" }, searchOut(["foo 1"], 1)),
      ...exchange("c2", "search_text", { pattern: "foo" }, searchOut(["foo 2"], 1)),
      ...closing,
    ];
    expect(projectContext(different, opts).elisions).toEqual([]);
    const otherExit = [
      user("go"),
      ...exchange("c1", "search_text", { pattern: "foo" }, searchOut([], 1, 1)),
      ...exchange("c2", "search_text", { pattern: "foo" }, searchOut([], 1, 0)),
      ...closing,
    ];
    expect(projectContext(otherExit, opts).elisions).toEqual([]);
    const unparsable = [
      user("go"),
      ...exchange("c1", "search_text", { pattern: "foo" }, PLAIN),
      ...exchange("c2", "search_text", { pattern: "foo" }, PLAIN),
      ...closing,
    ];
    expect(elidedIndexes(projectContext(unparsable, opts))).toEqual([2]);
  });

  it("T9 a read without sha256 (large file) is elided by an edit and the stub says unknown", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "big.ts" }, readOut("big.ts", null)),
      ...exchange(
        "c2",
        "edit_file",
        { path: "big.ts" },
        JSON.stringify({ path: "big.ts", sha256: H2 }),
      ),
      ...closing,
    ];
    expect(toolText(projectContext(h, opts).messages[2])).toBe(stubRead("big.ts", "unknown"));
    const reads = [
      user("go"),
      ...exchange("c1", "read_file", { path: "big.ts" }, readOut("big.ts", null)),
      ...exchange("c2", "read_file", { path: "big.ts" }, readOut("big.ts", H2)),
      ...closing,
    ];
    expect(projectContext(reads, opts).elisions).toEqual([]);
  });

  it("T10 a read result clipped by reduceMessagesToBudget produces the same stub bytes", () => {
    const big = "y".repeat(24_000);
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1, big)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    const reduced = reduceMessagesToBudget(h, 9_000);
    expect(reduced.truncated).toBeGreaterThan(0);
    expect(toolText(reduced.messages[2])).not.toBe(toolText(h[2]));
    expect(() => JSON.parse(toolText(reduced.messages[2]))).toThrow();
    const clipped = projectContext(reduced.messages, opts);
    const plain = projectContext(h, opts);
    expect(toolText(clipped.messages[2])).toBe(stubRead("a.ts", "aaaaaaaa"));
    expect(toolText(clipped.messages[2])).toBe(toolText(plain.messages[2]));
  });

  it("T11 hostile paths are JSON-quoted into one ASCII line", () => {
    for (const path of ['a"b\nc.ts', "dir\\ño\u2028.ts"]) {
      const h = [
        user("go"),
        ...exchange("c1", "read_file", { path }, readOut(path, H1)),
        ...exchange("c2", "read_file", { path }, readOut(path, H2)),
        ...closing,
      ];
      const stub = toolText(projectContext(h, opts).messages[2]);
      expect(stub).toMatch(/^\[elided: read_file "/);
      expect(stub).not.toMatch(/[\n\r\u2028\u2029]/);
      expect(/^[\x20-\x7e]*$/.test(stub)).toBe(true);
      expect(JSON.parse(stub.slice("[elided: read_file ".length, stub.indexOf("@aaaaaaaa")))).toBe(
        path,
      );
    }
  });

  it("T12 returns the very same array when nothing is elided", () => {
    expect(projectContext([], opts).messages).toEqual([]);
    const empty: Message[] = [];
    expect(projectContext(empty, opts).messages).toBe(empty);
    const young = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
    ];
    const p = projectContext(young, opts);
    expect(p.messages).toBe(young);
    expect(p.tokensAfter).toBe(p.tokensBefore);
  });

  it("T13 never mutates its input (deep-frozen history)", () => {
    const h = deepFreeze([
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ]);
    const p = projectContext(h, opts);
    expect(p.elisions).toHaveLength(1);
    expect(p.messages).not.toBe(h);
  });

  it("T14 users, checkpoints and assistants (with provider data) are the same references", () => {
    const withData: Message = {
      role: "assistant",
      text: "",
      calls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.ts" }) }],
      providerData: [{ opaque: true }],
    };
    const h: Message[] = [
      { role: "user", summary: true, text: "checkpoint" },
      user("go"),
      withData,
      result("c1", readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    const p = projectContext(h, opts);
    expect(p.elisions).toHaveLength(1);
    expect(p.messages).toHaveLength(h.length);
    h.forEach((m, i) => {
      if (i !== 3) expect(p.messages[i]).toBe(m);
    });
    const elided = p.messages[3];
    expect(elided).toMatchObject({ role: "tool", callId: "c1" });
    expect(elided).not.toBe(h[3]);
  });

  it("T15 with an epoch the projection only changes when the length crosses a multiple", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
      ...exchange("c3", "read_file", { path: "b.ts" }, readOut("b.ts", H1)),
      ...exchange("c4", "read_file", { path: "b.ts" }, readOut("b.ts", H2)),
      ...closing,
    ];
    const E = 4;
    for (let k = 0; k <= h.length; k++) {
      const boundary = Math.floor(k / E) * E;
      const p = projectContext(h.slice(0, k), { minAgeTurns: 2, epochMessages: E });
      const model = projectContext(h.slice(0, boundary), opts);
      expect(p.boundary, `k=${k}`).toBe(boundary);
      expect(JSON.stringify(p.messages), `k=${k}`).toBe(
        JSON.stringify([...model.messages, ...h.slice(boundary, k)]),
      );
    }
    // eager (0) projects everything it can on the full history
    expect(projectContext(h, opts).boundary).toBe(h.length);
  });

  it("T16 tokensSaved is the estimate difference and totals add up", () => {
    const big = "z".repeat(4_000);
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1, big)),
      ...exchange("c2", "read_file", { path: "a.ts" }, readOut("a.ts", H2)),
      ...closing,
    ];
    const p = projectContext(h, opts);
    const e = p.elisions[0];
    expect(e).toBeDefined();
    expect(e?.tokensSaved).toBe(
      estimateTokens(toolText(h[2])) - estimateTokens(toolText(p.messages[2])),
    );
    expect(e?.tokensSaved).toBeGreaterThan(900);
    expect(p.tokensBefore - p.tokensAfter).toBe(e?.tokensSaved);
  });

  it("T17 never replaces a result with a stub that is not shorter", () => {
    const miss = JSON.stringify({ exitCode: 1, stdout: "", stderr: "", truncated: false });
    const search = (pattern: string, out: string) => [
      ...exchange(`s-${pattern}-1`, "search_text", { pattern }, out),
      ...exchange(`s-${pattern}-2`, "search_text", { pattern }, out),
    ];
    const long = "needle_".repeat(8);
    const tiny = [user("go"), ...search(long, miss), ...closing];
    const stub = `[elided: search_text "${long}"; identical to a later result]`;
    expect(toolText(tiny[2]).length).toBeLessThan(stub.length);
    const p = projectContext(tiny, opts);
    expect(p.elisions).toEqual([]);
    expect(p.messages).toBe(tiny);

    const big = searchOut(["x".repeat(400)], 1);
    const grown = [user("go"), ...search("q", big), ...closing];
    const q = projectContext(grown, opts);
    expect(q.elisions).toHaveLength(1);
    expect(q.elisions[0]?.tokensSaved).toBeGreaterThan(0);
  });
});

describe("elisionCandidates", () => {
  it("reports the EARLIEST witness, which stays stable when more witnesses are appended", () => {
    const h = [
      user("go"),
      ...exchange("c1", "read_file", { path: "a.ts" }, readOut("a.ts", H1)),
      ...exchange(
        "c2",
        "edit_file",
        { path: "a.ts" },
        JSON.stringify({ path: "a.ts", sha256: H2 }),
      ),
    ];
    const before = elisionCandidates(h).get(2);
    const after = elisionCandidates([
      ...h,
      ...exchange("c3", "read_file", { path: "a.ts" }, readOut("a.ts", H3)),
    ]).get(2);
    expect(before).toEqual({ reason: "superseded_read", witness: 4 });
    expect(after).toEqual(before);
  });
});

// ---------------------------------------------------------------------------------------------
// Property tests over generated histories.
// ---------------------------------------------------------------------------------------------

type Rng = () => number;
const int = (r: Rng, min: number, max: number) => min + Math.floor(r() * (max - min + 1));
const pick = <T>(r: Rng, items: T[]): T => items[int(r, 0, items.length - 1)] as T;

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

/** A random but VALID history over a small tool/path/sha universe so supersession is frequent. */
function generate(seed: number): Message[] {
  const r = mulberry32(seed);
  const messages: Message[] = [];
  let n = 0;
  if (r() < 0.15) messages.push({ role: "user", summary: true, text: "checkpoint" });
  const turns = int(r, 2, 5);
  for (let t = 0; t < turns; t++) {
    messages.push(user(`turn ${t}`));
    const rounds = int(r, 1, 4);
    for (let k = 0; k < rounds; k++) {
      const batch = Array.from({ length: int(r, 1, 3) }, () => {
        const id = `c${n++}`;
        const path = pick(r, ["a.ts", "b.ts", "c.ts"]);
        const sha = r() < 0.08 ? null : pick(r, [H1, H2, H3]);
        const kind = r();
        let name: string;
        let args: object;
        let out: string;
        if (kind < 0.4) {
          name = "read_file";
          args = r() < 0.3 ? { path, startLine: int(r, 1, 50), limit: int(r, 1, 100) } : { path };
          out = readOut(path, sha, "x".repeat(int(r, 0, 300)));
        } else if (kind < 0.52) {
          name = "edit_file";
          args = { path };
          out = JSON.stringify({ path, sha256: pick(r, [H1, H2, H3]) });
        } else if (kind < 0.6) {
          name = "write_file";
          args = { path };
          out = JSON.stringify({ path, sha256: pick(r, [H1, H2, H3]) });
        } else if (kind < 0.8) {
          name = "bg_output";
          const id2 = pick(r, ["t1", "t2"]);
          const offset = pick(r, [undefined, 0, 16384]);
          args = { id: id2, ...(offset === undefined ? {} : { offset }) };
          out = bgOut(id2, r() < 0.3 ? "" : "abc", pick(r, [0, 3, 16384]));
        } else {
          name = "search_text";
          const pattern = pick(r, ["p1", "p2"]);
          args = r() < 0.5 ? { pattern, path: "src" } : { path: "src", pattern };
          out = searchOut(pick(r, [["m1"], ["m2"], []]), int(r, 1, 1_000_000));
        }
        const isError = r() < 0.15;
        return { id, name, args, out: isError ? "boom" : out, isError };
      });
      messages.push({
        role: "assistant",
        text: r() < 0.3 ? "thinking" : "",
        calls: batch.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
        ...(r() < 0.2 ? { providerData: [{ seed }] } : {}),
      });
      for (const c of shuffle(r, batch)) messages.push(result(c.id, c.out, c.isError));
    }
    if (r() < 0.8) messages.push(asst(`answer ${t}`));
  }
  return messages;
}

const unpaired = (messages: Message[]): number => {
  const calls = new Set(
    messages.flatMap((m) => (m.role === "assistant" ? m.calls.map((c) => c.id) : [])),
  );
  const results = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.callId] : [])));
  return [...calls].filter((c) => !results.has(c)).length;
};

/** Prefix lengths a request can really be made from: every call answered. */
const requestPoints = (h: Message[]) =>
  Array.from({ length: h.length }, (_, i) => i + 1).filter((k) => unpaired(h.slice(0, k)) === 0);

const assistantsAfter = (h: Message[], i: number) =>
  h.slice(i + 1).filter((m) => m.role === "assistant").length;

describe("projectContext properties", () => {
  it("the generator exercises every rule (sanity)", () => {
    const reasons = new Set<string>();
    let elided = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const h = generate(seed);
      expect(unpaired(h), `seed ${seed}`).toBe(0);
      for (const e of projectContext(h, opts).elisions) {
        reasons.add(e.reason);
        elided++;
      }
    }
    expect([...reasons].sort()).toEqual(["duplicate_search", "stale_bg_output", "superseded_read"]);
    expect(elided).toBeGreaterThan(300);
  });

  it(`P1-P3, P6 hold at every request point (${HISTORIES} histories, seeds 1..${HISTORIES})`, () => {
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const h = generate(seed);
      const r = mulberry32(seed ^ 0xc0ffee);
      const o = { minAgeTurns: int(r, 1, 3), epochMessages: pick(r, [0, 0, 3, 4, 7]) };
      for (const k of requestPoints(h)) {
        const prefix = h.slice(0, k);
        const where = `seed ${seed} k ${k} ${JSON.stringify(o)}`;
        const p = projectContext(prefix, o);
        // P1: same shape, assistants are the same objects, tool messages change content only.
        expect(p.messages.length, where).toBe(prefix.length);
        const elided = new Set(elidedIndexes(p));
        prefix.forEach((m, i) => {
          const q = p.messages[i] as Message;
          expect(q.role, where).toBe(m.role);
          if (m.role === "assistant" || m.role === "user" || !elided.has(i))
            expect(q, `${where} i ${i}`).toBe(m);
          else {
            const { result: _r, ...restM } = m;
            const { result: _s, ...restQ } = q as typeof m;
            expect(restQ, where).toEqual(restM);
            expect((q as typeof m).result.isError, where).toBeUndefined();
            expect(toolText(q), where).toMatch(
              /^\[elided: (read_file|bg_output|search_text) [^\n]*\]$/,
            );
          }
        });
        if (elided.size === 0) expect(p.messages, where).toBe(prefix);
        // P2: protected material is never elided.
        const lastForPath = new Map<string, number>();
        const calls = new Map<string, { name: string; path?: string }>();
        prefix.forEach((m, i) => {
          if (m.role === "assistant")
            for (const c of m.calls) {
              const a = JSON.parse(c.arguments) as { path?: string };
              calls.set(c.id, { name: c.name, ...(a.path ? { path: a.path } : {}) });
            }
          if (m.role === "tool") {
            const path = calls.get(m.callId)?.path;
            if (path) lastForPath.set(path, i);
          }
        });
        for (const i of elided) {
          const m = prefix[i] as Message;
          expect(m.role, where).toBe("tool");
          if (m.role !== "tool") continue;
          expect(m.result.isError, `${where} error elided`).not.toBe(true);
          expect(assistantsAfter(prefix, i), `${where} young elided`).toBeGreaterThanOrEqual(
            o.minAgeTurns,
          );
          expect(i, where).toBeLessThan(p.boundary);
          const path = calls.get(m.callId)?.path;
          if (path) expect(lastForPath.get(path), `${where} last result of ${path}`).not.toBe(i);
        }
        // P3: deterministic, also on a structured clone.
        const again = projectContext(structuredClone(prefix), o);
        expect(JSON.stringify(again.messages), where).toBe(JSON.stringify(p.messages));
        expect(again.elisions, where).toEqual(p.elisions);
        // P6: the inventory explains every elision as low criticality.
        const segments = buildInventory(prefix).segments;
        for (const e of p.elisions) {
          const seg = segments.find((s) => s.kind === "tool_result" && s.id === e.segmentId);
          expect(seg?.criticality, `${where} inventory of ${e.callId}`).toBe("low");
        }
        // Model: elision only ever rewrites the prefix [0, boundary).
        expect(Math.max(-1, ...elided), where).toBeLessThan(p.boundary);
      }
    }
  });

  it(`P4 eager projection is monotone under append (${HISTORIES} histories)`, () => {
    let newlyElided = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const h = generate(seed);
      const minAgeTurns = 1 + (seed % 3);
      const o = { minAgeTurns, epochMessages: 0 };
      const points = requestPoints(h).map((k) => {
        const prefix = h.slice(0, k);
        const p = projectContext(prefix, o);
        return {
          k,
          prefix,
          p,
          elided: new Set(elidedIndexes(p)),
          json: p.messages.map((m) => JSON.stringify(m)),
        };
      });
      points.forEach((a, ai) => {
        for (const b of points.slice(ai + 1)) {
          const where = `seed ${seed} k ${a.k} -> ${b.k}`;
          // never above the proof of "stable under append": elided(k) is a subset of elided(k')
          for (const i of a.elided) {
            expect(b.elided.has(i), `${where} un-elided ${i}`).toBe(true);
            expect(b.json[i], `${where} stub changed at ${i}`).toBe(a.json[i]);
          }
          // everything else below k keeps its bytes unless it became elided
          for (let i = 0; i < a.k; i++)
            if (!b.elided.has(i)) expect(b.json[i], `${where} i ${i}`).toBe(a.json[i]);
          for (const i of b.elided) {
            if (a.elided.has(i)) continue;
            newlyElided++;
            const witnessSeen = elisionCandidates(a.prefix).has(i);
            if (witnessSeen)
              expect(assistantsAfter(a.prefix, i), `${where} newly elided ${i}`).toBeLessThan(
                minAgeTurns,
              );
            else {
              const w = elisionCandidates(b.prefix).get(i);
              expect(w?.witness ?? -1, `${where} witness of ${i}`).toBeGreaterThanOrEqual(a.k);
            }
          }
          // boundary is non-decreasing
          expect(b.p.boundary).toBeGreaterThanOrEqual(a.p.boundary);
        }
      });
    }
    expect(newlyElided).toBeGreaterThan(100);
  });

  it(`P5 an epoch projection only appends within one epoch (${HISTORIES} histories)`, () => {
    let compared = 0;
    for (let seed = 1; seed <= HISTORIES; seed++) {
      const h = generate(seed);
      const E = [3, 4, 7][seed % 3] as number;
      const o = { minAgeTurns: 1 + (seed % 3), epochMessages: E };
      const points = requestPoints(h).map((k) => ({
        k,
        json: projectContext(h.slice(0, k), o).messages.map((m) => JSON.stringify(m)),
      }));
      points.forEach((a, ai) => {
        for (const b of points.slice(ai + 1)) {
          if (Math.floor(a.k / E) !== Math.floor(b.k / E)) continue;
          compared++;
          expect(b.json.slice(0, a.k), `seed ${seed} E ${E} k ${a.k} -> ${b.k}`).toEqual(a.json);
        }
      });
    }
    expect(compared).toBeGreaterThan(500);
  });
});
