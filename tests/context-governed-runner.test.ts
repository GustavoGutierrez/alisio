import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, RunEvent } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTEXT_POLICY_VERSION } from "../packages/core/src/context/elide.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { CASSETTE_SUFFIX, readCassette } from "../packages/core/src/eval/cassette.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { BUNDLED_DIR, RECORDED_TASKS, runScripted } from "../scripts/eval-record-bundled.ts";

/** `context_governed` and the usage ledger on the runner seam (spec 012 phase 4). */

type Mode = "off" | "shadow" | "on";
const governor = (mode: Mode) => ({
  mode,
  minAgeTurns: 2,
  epochMessages: 0,
  policyVersion: CONTEXT_POLICY_VERSION,
});

const SECRET_TEXT = "DISTINCTIVE-FILE-TEXT";
const SECRET_PATH = "secret-dir/distinct-name.ts";
const SECRET_PATTERN = "needle-pattern-xyz";
const shaOf = (n: number) => n.toString(16).padStart(64, "0");

type Step = [id: string, name: string, args: object | string, truncated?: boolean];
function script(): Step[] {
  const steps: Step[] = [
    ["c1", "read_file", { path: SECRET_PATH }],
    ["c2", "search_text", { pattern: SECRET_PATTERN, path: "." }],
    ["c3", "read_file", { path: SECRET_PATH }],
    ["c4", "edit_file", { path: SECRET_PATH }],
    ["c5", "read_file", { path: SECRET_PATH }],
  ];
  for (let i = 6; i <= 12; i++)
    steps.push([`c${i}`, i % 2 ? "read_file" : "edit_file", { path: "b.ts" }]);
  return steps;
}

function rowTypes(path: string, session: string): string[] {
  const db = openDatabase(path);
  try {
    const rows = db.prepare("SELECT type FROM events WHERE session=? ORDER BY seq").all(session);
    return (rows as Array<{ type: string }>).map((r) => r.type);
  } finally {
    db.close();
  }
}

async function run(root: string, mode: Mode | undefined, tag: string, steps = script()) {
  const store = new SQLiteStore(join(root, `store-${tag}.sqlite`));
  const versions = new Map<string, number>();
  const registry = new ToolRegistry();
  const tool = (name: string, out: (i: Record<string, unknown>) => string) =>
    registry.register({
      name,
      effect: "read",
      description: name,
      inputSchema: { type: "object" },
      async execute(input) {
        return textResult(out(input as Record<string, unknown>));
      },
    });
  tool("read_file", (i) =>
    JSON.stringify({
      path: i.path,
      sha256: shaOf(versions.get(String(i.path)) ?? 0),
      content: `1: ${SECRET_TEXT} `.repeat(40),
    }),
  );
  tool("edit_file", (i) => {
    versions.set(String(i.path), (versions.get(String(i.path)) ?? 0) + 1);
    return JSON.stringify({ path: i.path, sha256: shaOf(versions.get(String(i.path)) ?? 0) });
  });
  tool("search_text", () =>
    JSON.stringify({
      exitCode: 0,
      stdout: JSON.stringify({
        type: "match",
        data: { path: { text: join(root, SECRET_PATH) }, lines: { text: SECRET_TEXT } },
      }),
      stderr: "",
      truncated: false,
    }),
  );
  let call = 0;
  const provider = {
    id: "test",
    model: "test",
    async *stream(): AsyncGenerator<ProviderEvent> {
      const step = steps[call++];
      yield {
        type: "completed",
        message: step
          ? {
              role: "assistant",
              text: "",
              calls: [
                {
                  id: step[0],
                  name: step[1],
                  arguments: typeof step[2] === "string" ? step[2] : JSON.stringify(step[2]),
                },
              ],
              ...(step[3] ? { truncated: true } : {}),
            }
          : { role: "assistant", text: "all done", calls: [] },
      };
    },
  };
  const events: RunEvent[] = [];
  const session = store.create(root, "test", "test");
  const runner = new AgentRunner({
    provider: provider as never,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    maxTurns: 100,
    truncationRecoveries: 2,
    onEvent: (e) => events.push(e),
    ...(mode ? { contextGovernor: governor(mode) } : {}),
  });
  try {
    const result = await runner.run(session.id, "go");
    return {
      status: result.status,
      events,
      requests: call,
      usage: runner.contextUsage(session.id),
      rows: rowTypes(join(root, `store-${tag}.sqlite`), session.id),
    };
  } finally {
    store.close();
  }
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "alisio-governed-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const governed = (events: RunEvent[]) => events.filter((e) => e.type === "context_governed");
const ALLOWED_KEYS = new Set([
  "policyVersion",
  "mode",
  "request",
  "messages",
  "segments",
  "elided",
  "byReason",
  "tokensBefore",
  "tokensAfter",
  "tokensSaved",
  "elidedCallIds",
  "elidedCallIdsOmitted",
  "invariants",
  "usage",
]);

describe("context_governed on the runner seam", () => {
  it("P3 off and a runner without the governor emit nothing and keep no ledger", async () => {
    const bare = await run(root, undefined, "bare");
    const off = await run(root, "off", "off");
    expect(governed(bare.events)).toHaveLength(0);
    expect(governed(off.events)).toHaveLength(0);
    expect(bare.usage).toBeUndefined();
    expect(off.usage).toBeUndefined();
    expect(off.events.map((e) => e.type)).toEqual(bare.events.map((e) => e.type));
    expect(off.rows).toEqual(bare.rows);
  });

  it.each(["shadow", "on"] as const)(
    "P4 %s emits exactly one durable event per model request",
    async (mode) => {
      const r = await run(root, mode, `p4-${mode}`);
      const events = governed(r.events);
      expect(events).toHaveLength(r.requests);
      expect(events.map((e) => (e.data as { request: number }).request)).toEqual(
        Array.from({ length: r.requests }, (_, i) => i + 1),
      );
      for (const e of events) expect(e.eventId).toBeDefined();
      expect(r.rows.filter((t) => t === "context_governed")).toHaveLength(r.requests);
      const last = events.at(-1)?.data as { mode: string; elided: number; policyVersion: number };
      expect(last).toMatchObject({ mode, policyVersion: CONTEXT_POLICY_VERSION });
      expect(last.elided).toBeGreaterThan(0);
    },
  );

  it("P4 a truncation recovery is a new request with its own event", async () => {
    const steps: Step[] = [
      ["t1", "read_file", '{"path":"a.t', true],
      ["t2", "read_file", { path: "a.ts" }],
    ];
    const r = await run(root, "shadow", "trunc", steps);
    expect(r.status).toBe("completed");
    expect(r.events.some((e) => e.type === "truncation_recovery")).toBe(true);
    expect(governed(r.events)).toHaveLength(r.requests);
    expect(r.requests).toBe(3);
  });

  it("P2 carries no file text, paths or patterns, and only allow-listed keys", async () => {
    for (const mode of ["shadow", "on"] as const) {
      const r = await run(root, mode, `p2-${mode}`);
      for (const e of governed(r.events)) {
        const json = JSON.stringify(e.data);
        for (const secret of [SECRET_TEXT, SECRET_PATH, SECRET_PATTERN, "distinct-name", "elided:"])
          expect(json).not.toContain(secret);
        for (const key of Object.keys(e.data as object)) expect(ALLOWED_KEYS.has(key)).toBe(true);
        expect(json.length).toBeLessThan(2048);
      }
    }
  });

  it("P6 elision in `on` is never reported as context_reduced", async () => {
    const r = await run(root, "on", "p6");
    expect(governed(r.events).some((e) => (e.data as { elided: number }).elided > 0)).toBe(true);
    expect(r.events.some((e) => e.type === "context_reduced")).toBe(false);
  });

  it("the ledger counts reads that the agent acted on later, in shadow and on alike", async () => {
    const shadow = await run(root, "shadow", "u-shadow");
    const on = await run(root, "on", "u-on");
    expect(shadow.usage?.used).toBeGreaterThan(0);
    expect(shadow.usage?.observed).toBeGreaterThan(shadow.usage?.used ?? 0);
    expect(shadow.usage?.byTool.search_text).toEqual({ observed: 1, used: 1 });
    expect(shadow.usage?.stubOnly).toBe(0);
    expect(on.usage?.observed).toBeGreaterThan(0);
    // The last event carries the same cumulative numbers (minus the final pending results).
    const data = governed(shadow.events).at(-1)?.data as { usage?: { observed: number } };
    expect(data.usage?.observed).toBeGreaterThan(0);
  });
});

describe("P7 Lab incidents", () => {
  it("a shadow replay of the bundled cassettes reports the same incidents as off", async () => {
    for (const key of RECORDED_TASKS) {
      const [suiteId, taskId] = key.split("/") as [string, string];
      const replay = (mode: Mode) =>
        runScripted({
          suiteId,
          taskId,
          mode: "replay",
          cassette: readCassette(
            join(BUNDLED_DIR, suiteId, "cassettes", `${taskId}${CASSETTE_SUFFIX}`),
          ),
          tmpRoot: root,
          configOverrides: { "context.governor": mode },
        });
      const off = await replay("off");
      const shadow = await replay("shadow");
      expect(shadow.incidents, key).toEqual(off.incidents);
      expect(JSON.stringify(shadow.incidents), key).not.toContain("context_governed");
    }
  }, 60_000);
});
