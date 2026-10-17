import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { textResult } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { CommandCatalog, type CommandHost } from "../packages/core/src/commands/catalog.ts";
import { CONTEXT_POLICY_VERSION } from "../packages/core/src/context/elide.ts";
import { formatContextGovernorStatsSection } from "../packages/core/src/context/format.ts";
import type { GovernanceSnapshot } from "../packages/core/src/context/governance.ts";
import type { UsageSummary } from "../packages/core/src/context/usage.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import * as core from "../packages/core/src/index.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

const snapshot: GovernanceSnapshot = {
  mode: "shadow",
  policyVersion: 1,
  request: 4,
  messages: 412,
  segments: 500,
  boundary: 412,
  elided: 3,
  byReason: { superseded_read: 2, stale_bg_output: 0, duplicate_search: 1 },
  tokensBefore: 9000,
  tokensAfter: 7760,
  tokensSaved: 1240,
  elisions: [],
  invariants: { count: 4, chars: 1032, omitted: 0, promoted: 0, rejected: 0 },
  newlyElided: [],
};
const usage: UsageSummary = {
  observed: 112,
  used: 38,
  byKind: { tool_result: { observed: 112, used: 38 } },
  byTool: {
    list_files: { observed: 7, used: 2 },
    read_file: { observed: 45, used: 20 },
    search_text: { observed: 30, used: 6 },
  },
  unattributed: 30,
  pending: 2,
  stubOnly: 0,
  rereads: 5,
  evicted: 0,
};

describe("formatContextGovernorStatsSection", () => {
  it("renders the governor decision and the usage ratios", () => {
    const text = formatContextGovernorStatsSection({ governance: snapshot, usage }) ?? "";
    expect(text).toBe(
      [
        "**Context Governor**",
        "",
        "- Mode: shadow · policy v1",
        "- Last request: 412 messages · 3 elided (superseded_read 2, duplicate_search 1) · ~1240 tokens saved (estimate)",
        "- Invariants: 4 (1032 chars, 0 omitted)",
        "- Tool results used later: 38 of 112 (34%) · read_file 20/45 · search_text 6/30 · list_files 2/7",
        "- Not attributable: 30 · pending: 2 · re-reads: 5",
        '- Counts cover this process only; "used" is a path heuristic, not a measure of what the model needed.',
      ].join("\n"),
    );
  });

  it("is omitted without data and keeps the usage lines when the decision is gone", () => {
    expect(formatContextGovernorStatsSection({})).toBeUndefined();
    const empty = {
      ...usage,
      observed: 0,
      used: 0,
      byKind: {},
      byTool: {},
      unattributed: 0,
      pending: 0,
      rereads: 0,
    };
    expect(formatContextGovernorStatsSection({ usage: empty })).toBeUndefined();
    const text = formatContextGovernorStatsSection({ usage }) ?? "";
    expect(text).not.toContain("Last request");
    expect(text).not.toContain("Mode:");
    expect(text).toContain("38 of 112 (34%)");
  });
});

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function statsFor(mode: "off" | "shadow" | "on" | undefined) {
  const root = await mkdtemp(join(tmpdir(), "alisio-gov-stats-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const registry = new ToolRegistry();
  registry.register({
    name: "read_file",
    description: "r",
    inputSchema: { type: "object" },
    effect: "read",
    async execute() {
      return textResult(JSON.stringify({ path: "a.ts", sha256: "a".repeat(64) }));
    },
  });
  let turn = 0;
  const provider = {
    id: "test",
    model: "m",
    async *stream() {
      turn++;
      yield {
        type: "completed" as const,
        message:
          turn < 3
            ? {
                role: "assistant" as const,
                text: "",
                calls: [{ id: `c${turn}`, name: "read_file", arguments: '{"path":"a.ts"}' }],
              }
            : { role: "assistant" as const, text: "done", calls: [] },
      };
    },
  };
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    ...(mode
      ? {
          contextGovernor: {
            mode,
            minAgeTurns: 2,
            epochMessages: 0,
            policyVersion: CONTEXT_POLICY_VERSION,
          },
        }
      : {}),
  });
  const host: CommandHost = {
    workspace: root,
    store,
    runner,
    registry,
    provider: { id: "test" },
  };
  const session = store.create(root, "test", "m").id;
  await runner.run(session, "go");
  const result = await new CommandCatalog(host).execute("stats", "", { sessionId: session });
  store.close();
  return result;
}

describe("/stats in the core handler", () => {
  it("shows the section in shadow and on, never in off", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const r = await statsFor(mode);
      expect(r.text).toContain("**Context Governor**");
      expect(r.text).toContain(`- Mode: ${mode} · policy v${CONTEXT_POLICY_VERSION}`);
      expect(r.data).toMatchObject({
        contextGovernor: { mode, policyVersion: CONTEXT_POLICY_VERSION },
      });
    }
    for (const mode of ["off", undefined] as const) {
      const r = await statsFor(mode);
      expect(r.text).not.toContain("Context Governor");
      expect(r.data).not.toHaveProperty("contextGovernor");
    }
  });

  it("is the same formatter the TUI uses", () => {
    expect(core.formatContextGovernorStatsSection).toBe(formatContextGovernorStatsSection);
  });
});
