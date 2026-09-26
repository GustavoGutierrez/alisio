import { describe, expect, it } from "vitest";
import { renderCheckpoint } from "../packages/core/src/core/compaction.ts";
import {
  estimateTokens,
  formatObservation,
  ftsQuery,
  normalizeTopicKey,
  parseObservations,
  parseSessionSummary,
  rankScore,
  redactPrivate,
  renderInjection,
  renderMemoryContext,
  suggestTopicKey,
} from "../packages/plugin-memory/src/format.ts";
import type { MemoryHit } from "../packages/plugin-memory/src/types.ts";

const checkpoint = {
  goal: "Add memory to Alisio",
  instructions: ["Use pnpm", "Code in English"],
  discoveries: ["bun:sqlite ships FTS5"],
  accomplished: ["Store implemented"],
  currentState: "Writing tests",
  nextSteps: ["Wire the TUI /memory command"],
  relevantFiles: ["src/runtime/memory.ts"],
};

describe("observations and queries", () => {
  it("formats the What/Why/Where/Learned body", () => {
    const body = formatObservation({
      title: "t",
      type: "decision",
      what: "Chose SQLite",
      why: "Local and fast",
      where: "src/runtime/memory.ts",
      learned: "FTS5 is built in",
    });
    expect(body).toBe(
      "**What**: Chose SQLite\n**Why**: Local and fast\n**Where**: src/runtime/memory.ts\n**Learned**: FTS5 is built in",
    );
    expect(formatObservation({ title: "t", type: "learning", what: "Only what" })).toBe(
      "**What**: Only what",
    );
  });

  it("builds safe FTS5 queries from free text", () => {
    expect(ftsQuery('How does "WAL-mode" work?')).toBe(
      '"how" OR "does" OR "wal" OR "mode" OR "work"',
    );
    expect(ftsQuery("  ")).toBeUndefined();
    expect(ftsQuery("a ! ?")).toBeUndefined();
    expect(ftsQuery("db io")).toBeUndefined();
    expect(ftsQuery("wal mode", "all")).toBe('"wal" AND "mode"');
    expect(
      ftsQuery(Array.from({ length: 40 }, (_, i) => `word${i}`).join(" "))?.split(" OR "),
    ).toHaveLength(16);
  });

  it("normalizes and suggests kebab family/description topic keys", () => {
    expect(normalizeTopicKey("Architecture/Memory DB Location/Extra")).toBe(
      "architecture/memory-db-location-extra",
    );
    expect(normalizeTopicKey("  ")).toBeUndefined();
    expect(suggestTopicKey("bugfix", "Fix lock release in finally")).toBe(
      "bug/fix-lock-release-in-finally",
    );
    expect(suggestTopicKey("decision", "Use SQLite!")).toBe("decision/use-sqlite");
  });

  it("redacts private blocks", () => {
    expect(redactPrivate("a <private>secret\nkey</private> b <PRIVATE>x</PRIVATE>")).toBe(
      "a [REDACTED] b [REDACTED]",
    );
  });

  it("ranks by relevance with recency decay and access boost", () => {
    const now = Date.UTC(2026, 0, 31);
    const day = 86_400_000;
    expect(rankScore(-2, now, 0, now)).toBeGreaterThan(rankScore(-2, now - 90 * day, 0, now));
    expect(rankScore(-5, now - 90 * day, 0, now)).toBeGreaterThan(rankScore(-1, now, 0, now));
    expect(rankScore(-2, now, 10, now)).toBeGreaterThan(rankScore(-2, now, 0, now));
  });
});

describe("model output parsing", () => {
  it("keeps valid observations, normalizes topic keys and drops invalid items", () => {
    expect(
      parseObservations([
        {
          title: "Memory DB location",
          type: "decision",
          what: "User-level DB",
          topic_key: "Decision/Memory DB",
        },
        { title: "bad", type: "not-a-type", what: "dropped" },
        "nonsense",
      ]),
    ).toEqual([
      {
        title: "Memory DB location",
        type: "decision",
        what: "User-level DB",
        topicKey: "decision/memory-db",
      },
    ]);
    expect(parseObservations("not an array")).toEqual([]);
  });

  it("renders Engram session summary sections and falls back to text", () => {
    const parsed = parseSessionSummary(
      JSON.stringify({
        summary: {
          goal: "Ship memory",
          instructions: ["pnpm"],
          discoveries: [],
          accomplished: ["store"],
          nextSteps: ["TUI"],
          relevantFiles: ["a.ts"],
        },
        observations: [{ title: "Chose FTS5", type: "decision", what: "No embeddings" }],
      }),
    );
    expect(parsed.structured).toBe(true);
    for (const h of [
      "## Goal",
      "## Instructions",
      "## Discoveries",
      "## Accomplished",
      "## Next Steps",
      "## Relevant Files",
    ])
      expect(parsed.text).toContain(h);
    expect(parsed.observations).toHaveLength(1);
    expect(parseSessionSummary("free text {")).toEqual({
      structured: false,
      text: "free text {",
      observations: [],
    });
  });
});

describe("memory context", () => {
  const hit = (id: number, pinned = false): MemoryHit => ({
    id,
    type: "decision",
    title: `Title ${id}`,
    snippet: `body ${id} ${"w".repeat(250)}`,
    scope: "project",
    updatedAt: 0,
    pinned,
  });
  const data = {
    project: "alisio-12345678",
    session: "abcdef12-0000",
    summary: "## Goal\nShip memory",
    prompts: ["p".repeat(500), "second prompt"],
    pinned: [hit(99, true)],
    recent: Array.from({ length: 30 }, (_, i) => hit(i + 1)),
  };

  it("uses Engram's sections and full lines when the budget allows", () => {
    const text = renderMemoryContext({ ...data, recent: data.recent.slice(0, 2) }, 5_000);
    for (const h of [
      "### Session",
      "### Last Session Summary",
      "### Recent User Prompts",
      "### Pinned",
      "### Recent Observations",
    ])
      expect(text).toContain(h);
    expect(text).toContain(`- #1 [decision] **Title 1**: body 1`);
    expect(text).toContain(`- ${"p".repeat(200)}…`);
    expect(text).not.toContain("p".repeat(201));
  });

  it("keeps pinned memories and falls back to compact lines within budget", () => {
    for (const budget of [250, 500, 1500]) {
      const text = renderMemoryContext(data, budget);
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      expect(text).toContain("#99 [decision] **Title 99**");
    }
    expect(renderMemoryContext(data, 500)).toMatch(/- #\d+ \[decision\] \*\*Title \d+\*\*\n/);
  });
});

describe("injection budget", () => {
  const hits: MemoryHit[] = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    type: "discovery",
    title: `Memory number ${i + 1} about the storage layer`,
    snippet: "x".repeat(150),
    scope: "project",
    updatedAt: 0,
  }));

  it("stays within the token budget and keeps memory ids", () => {
    for (const budget of [200, 600, 1500]) {
      const text = renderInjection({
        heading: "Compaction checkpoint",
        body: renderCheckpoint(checkpoint),
        memories: hits,
        budgetTokens: budget,
      });
      expect(estimateTokens(text)).toBeLessThanOrEqual(budget);
      expect(text).toContain("## Goal");
    }
    const text = renderInjection({ heading: "h", body: "b", memories: hits, budgetTokens: 600 });
    expect(text).toContain("#1 [discovery]");
    expect(text).toContain("memory_get");
  });

  it("truncates an oversized body instead of exceeding the budget", () => {
    const text = renderInjection({
      heading: "h",
      body: "line\n".repeat(5_000),
      memories: [],
      budgetTokens: 300,
    });
    expect(estimateTokens(text)).toBeLessThanOrEqual(300);
    expect(text).toContain("[truncated]");
  });
});
