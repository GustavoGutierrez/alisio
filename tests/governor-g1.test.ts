/**
 * `scripts/governor-g1.ts` (specs/012, Phase 6, claim G1): deterministic token measurement of the
 * Context Governor over scripted sessions. No model, no network. The token figures are ESTIMATES
 * (the scripted provider reports a constant fake `usage`); the tests pin that labeling.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { REFERENCE_SCRIPTS } from "../scripts/eval-record-bundled.ts";
import {
  auditSweep,
  G1_SCHEMA,
  measureSession,
  measureSuite,
  prefixReuse,
  reductionBetween,
  summarizeReductions,
} from "../scripts/governor-g1.ts";

const SUITE = "long-context-stress";
const CONFIG_EDITS = "sequential-config-edits";
let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "governor-g1-test-"));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("reductionBetween: tokens saved by `on` against `off`", () => {
  const req = (messageTokens: number, kind: "main" | "compaction" = "main") => ({
    kind,
    messageTokens,
    fixedTokens: 100,
    reusedTokens: 0,
  });

  it.each([
    ["no change", [100, 200], [100, 200], 0, 0],
    ["half of the second request", [100, 200], [100, 100], 100 / 300, 100 / 500],
    ["everything saved is impossible but defined", [100, 100], [0, 0], 1, 200 / 400],
  ])("%s", (_name, off, on, messagesOnly, fullRequest) => {
    const result = reductionBetween(
      off.map((n) => req(n)),
      on.map((n) => req(n)),
    );
    expect(result.messages).toBeCloseTo(messagesOnly, 12);
    expect(result.request).toBeCloseTo(fullRequest, 12);
    expect(result.requests).toBe(2);
  });

  it("returns the per-request reduction in order", () => {
    const result = reductionBetween(
      [req(100), req(400)].map((r) => r),
      [req(100), req(300)],
    );
    expect(result.perRequest).toEqual([0, 0.25]);
  });

  it("refuses to compare sessions with a different number of requests (not comparable)", () => {
    expect(() => reductionBetween([req(1)], [req(1), req(2)])).toThrow(/same number of requests/);
  });

  it("refuses to compare sessions whose request kinds differ", () => {
    expect(() => reductionBetween([req(1, "main")], [req(1, "compaction")])).toThrow(/kind/);
  });

  it("an empty session has zero reduction, not NaN", () => {
    expect(reductionBetween([], [])).toMatchObject({ messages: 0, request: 0, requests: 0 });
  });
});

describe("prefixReuse: the share of sent conversation a perfect prefix cache could serve", () => {
  const main = (messageTokens: number, reusedTokens: number) => ({
    kind: "main" as const,
    messageTokens,
    fixedTokens: 100,
    reusedTokens,
  });

  it("is reused tokens over sent tokens of the main-loop requests", () => {
    // The first request has nothing to reuse; the others reuse their common prefix.
    const result = prefixReuse([main(100, 0), main(150, 100), main(200, 50)]);
    expect(result).toMatchObject({ sentTokens: 450, reusedTokens: 150 });
    expect(result.share).toBeCloseTo(150 / 450, 12);
  });

  it("ignores compaction requests (a different lane) and is zero for an empty session", () => {
    const compaction = { ...main(500, 0), kind: "compaction" as const };
    expect(prefixReuse([main(100, 0), compaction, main(100, 100)]).sentTokens).toBe(200);
    expect(prefixReuse([])).toMatchObject({ share: 0, sentTokens: 0 });
  });
});

describe("summarizeReductions", () => {
  it("reports min, median, max and the pooled figure (sum over tasks, not a mean of means)", () => {
    const summary = summarizeReductions([
      { off: 1000, on: 1000 },
      { off: 1000, on: 500 },
      { off: 8000, on: 8000 },
    ]);
    expect(summary).toMatchObject({ tasks: 3, min: 0, median: 0, max: 0.5 });
    expect(summary.pooled).toBeCloseTo(500 / 10000, 12);
  });
  it("is empty-safe", () => {
    expect(summarizeReductions([])).toMatchObject({ tasks: 0, pooled: 0 });
  });
});

describe("auditSweep: the synthetic long session", () => {
  const turns = REFERENCE_SCRIPTS[`${SUITE}/${CONFIG_EDITS}`] ?? [];
  it("repeats every read_file turn once before the final answer and changes nothing else", () => {
    const longer = auditSweep(turns);
    const reads = (list: typeof turns) =>
      list.filter((t) => typeof t !== "function" && t.calls?.[0]?.name === "read_file").length;
    expect(longer.length).toBe(turns.length + reads(turns));
    expect(reads(longer)).toBe(reads(turns) * 2);
    expect(longer.slice(0, turns.length - 1)).toEqual(turns.slice(0, -1));
    expect(longer.at(-1)).toEqual(turns.at(-1));
  });
});

describe("measureSession (real engine, scripted provider)", () => {
  const measure = (governor: "off" | "shadow" | "on", limit: number, sweep = false) =>
    measureSession({
      suiteId: SUITE,
      taskId: CONFIG_EDITS,
      governor,
      maxContextChars: limit,
      ...(sweep ? { audit: true } : {}),
      tmpRoot: root,
    });

  it("labels its figures: estimated tokens of a synthetic scripted session", async () => {
    const m = await measure("off", 800_000);
    expect(m.basis).toBe("estimated");
    expect(m.synthetic).toBe(true);
    expect(m.status).toBe("pass");
    expect(m.requests.length).toBeGreaterThan(10);
    expect(m.requests.every((r) => r.messageTokens > 0 && r.fixedTokens > 0)).toBe(true);
  });

  it("`on` sends fewer tokens than `off` when old reads are superseded and nothing compacts", async () => {
    const off = await measure("off", 800_000);
    const on = await measure("on", 800_000);
    expect(on.status).toBe("pass");
    const r = reductionBetween(off.requests, on.requests);
    expect(r.messages).toBeGreaterThan(0.05);
    expect(r.request).toBeGreaterThan(0);
    expect(r.request).toBeLessThan(r.messages);
    // Monotone: a request never gets bigger because the governor is on.
    expect(r.perRequest.every((x) => x >= 0)).toBe(true);
  });

  it("`shadow` sends exactly what `off` sends (D6)", async () => {
    const off = await measure("off", 800_000);
    const shadow = await measure("shadow", 800_000);
    expect(shadow.requests).toEqual(off.requests);
  });

  it("the long synthetic session has more requests and a larger reduction", async () => {
    const off = await measure("off", 800_000);
    const longOff = await measure("off", 800_000, true);
    const longOn = await measure("on", 800_000, true);
    expect(longOff.requests.length).toBeGreaterThan(off.requests.length);
    expect(longOn.status).toBe("pass");
    const short = reductionBetween(off.requests, (await measure("on", 800_000)).requests);
    expect(reductionBetween(longOff.requests, longOn.requests).messages).toBeGreaterThan(
      short.messages,
    );
  });

  it("eager elision (epochMessages 0) saves more than the shipped epoch where files change", async () => {
    const base = {
      suiteId: SUITE,
      taskId: CONFIG_EDITS,
      maxContextChars: 800_000,
      audit: true,
      tmpRoot: root,
    };
    const off = await measureSession({ ...base, governor: "off" });
    const epoch = await measureSession({ ...base, governor: "on" });
    const eager = await measureSession({ ...base, governor: "on", epochMessages: 0 });
    const shipped = reductionBetween(off.requests, epoch.requests).messages;
    expect(reductionBetween(off.requests, eager.requests).messages).toBeGreaterThan(shipped);
  });

  it("re-reading an UNCHANGED file is not elided, even eagerly (superseded means the content changed)", async () => {
    const base = {
      suiteId: SUITE,
      taskId: "chain-walk-rules-01",
      maxContextChars: 800_000,
      audit: true,
      tmpRoot: root,
    };
    const off = await measureSession({ ...base, governor: "off" });
    const eager = await measureSession({ ...base, governor: "on", epochMessages: 0 });
    expect(reductionBetween(off.requests, eager.requests).messages).toBe(0);
  });

  it("records how much of each request repeats the previous one (cache-friendliness)", async () => {
    const off = await measure("off", 800_000);
    const on = await measure("on", 800_000);
    const shadow = await measure("shadow", 800_000);
    expect(off.requests[0]?.reusedTokens).toBe(0);
    // Without the governor a request is the previous one plus new messages: all of it is reused.
    const offReuse = prefixReuse(off.requests);
    expect(offReuse.share).toBeGreaterThan(0.9);
    expect(prefixReuse(shadow.requests)).toEqual(offReuse);
    // Rewriting old results breaks the prefix at the elided message: the share cannot rise.
    expect(prefixReuse(on.requests).share).toBeLessThanOrEqual(offReuse.share);
  });

  it("is deterministic: the same session measured twice is identical", async () => {
    expect(await measure("on", 800_000)).toEqual(await measure("on", 800_000));
  });

  it("counts the compaction summarizer calls as requests of their own kind", async () => {
    const m = await measure("off", 40_000);
    expect(m.requests.filter((r) => r.kind === "compaction").length).toBeGreaterThanOrEqual(1);
    expect(m.compactions).toBe(m.requests.filter((r) => r.kind === "compaction").length);
  });
});

describe("measureSuite", () => {
  it("measures every stress task under both limits and both lengths, and keeps estimated apart", async () => {
    const result = await measureSuite({
      tmpRoot: root,
      tasks: [CONFIG_EDITS],
    });
    expect(result.schema).toBe(G1_SCHEMA);
    expect(result.basis).toBe("estimated");
    expect(result.synthetic).toBe(true);
    // 1 task x 2 limits x 2 lengths
    expect(result.cells).toHaveLength(4);
    for (const cell of result.cells) {
      expect(cell.off.status).toBe("pass");
      expect(cell.on.status).toBe("pass");
      expect(cell.reduction.messages).toBeGreaterThanOrEqual(0);
    }
    expect(result.summary.map((s) => `${s.length}/${s.limit}`).sort()).toEqual([
      "audit/default-limit",
      "audit/small-context",
      "reference/default-limit",
      "reference/small-context",
    ]);
    // The eager-epoch sensitivity arm is reported next to the default configuration.
    for (const cell of result.cells) {
      expect(cell.onEager.status).toBe("pass");
      expect(cell.reductionEager.messages).toBeGreaterThanOrEqual(cell.reduction.messages);
    }
    // The cache-friendliness proxy is reported for every arm.
    for (const cell of result.cells) {
      expect(cell.prefixReuse.off.share).toBeGreaterThanOrEqual(cell.prefixReuse.on.share);
      expect(cell.prefixReuse.off.sentTokens).toBeGreaterThan(0);
    }
    // The raw per-request series is kept so the per-turn comparison can be re-derived.
    for (const cell of result.cells) {
      expect(cell.series.off).toHaveLength(cell.off.requests);
      expect(cell.series.on).toHaveLength(cell.on.requests);
      expect(cell.series.kinds).toHaveLength(cell.off.requests);
    }
  });
});
