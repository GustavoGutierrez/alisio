/**
 * `/context` (spec 012 phase 5): a read-only core command on every surface. Its text is the
 * `formatContextReport` rendering of the application's `ContextReport`, the same report the web
 * panel and the route show.
 */
import type { ContextReport } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  CommandCatalog,
  type CommandHost,
} from "../packages/core/src/commands/catalog.ts";
import { formatContextReport } from "../packages/core/src/context/format.ts";

const report: ContextReport = {
  sessionId: "s1",
  policyVersion: 1,
  mode: "on",
  request: 7,
  messages: 12,
  segments: [
    {
      id: "aaaaaaaaaaaa",
      kind: "tool_result",
      origin: "src/a.ts",
      callId: "c1",
      tokens: 900,
      criticality: "low",
      reason: "superseded read: superseded by a later read of src/a.ts with a different sha256",
      elided: { reason: "superseded_read", replacedBy: "c2", tokensSaved: 880 },
    },
  ],
  tokensBefore: 2000,
  tokensAfter: 1120,
  tokensSaved: 880,
  elided: 1,
  byReason: { superseded_read: 1, stale_bg_output: 0, duplicate_search: 0 },
  invariants: { count: 0, omitted: 0, byKind: {} },
  usedRatioByKind: {},
};

const catalog = (contextReport?: (id: string) => ContextReport) =>
  new CommandCatalog({
    workspace: "/w",
    provider: { id: "p" },
    ...(contextReport ? { contextReport } : {}),
  } as unknown as CommandHost);

describe("/context", () => {
  it("is a core built-in on every surface", () => {
    const d = BUILTIN_COMMANDS.find((c) => c.name === "context");
    expect(d).toMatchObject({ execution: "core", surfaces: ["tui", "web", "api"] });
    expect(new CommandCatalog().list("web").some((c) => c.name === "context")).toBe(true);
  });

  it("prints the report of the session and returns it as data", async () => {
    const seen: string[] = [];
    const result = await catalog((id) => {
      seen.push(id);
      return report;
    }).execute("context", "", { sessionId: "s1" });
    expect(seen).toEqual(["s1"]);
    expect(result.text).toBe(formatContextReport(report));
    expect(result.data).toEqual(report);
  });

  it("explains itself when the host cannot build a report", async () => {
    const result = await catalog().execute("context", "", { sessionId: "s1" });
    expect(result.text).toMatch(/not available/i);
  });
});
