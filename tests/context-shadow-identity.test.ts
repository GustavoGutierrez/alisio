import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ProviderEvent } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CONTEXT_POLICY_VERSION } from "../packages/core/src/context/elide.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { CASSETTE_SUFFIX, readCassette } from "../packages/core/src/eval/cassette.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { BUNDLED_DIR, RECORDED_TASKS, runScripted } from "../scripts/eval-record-bundled.ts";

/**
 * The Context Governor must be invisible until it is `on`: `off` and `shadow` send the provider the
 * same bytes as a build without it, and no mode ever changes what is persisted.
 */

type Mode = "off" | "shadow" | "on";
interface Governor {
  mode: Mode;
  minAgeTurns: number;
  epochMessages: number;
  policyVersion: number;
}
const governor = (mode: Mode, epochMessages = 0): Governor => ({
  mode,
  minAgeTurns: 2,
  epochMessages,
  policyVersion: CONTEXT_POLICY_VERSION,
});

const shaOf = (n: number) => n.toString(16).padStart(64, "0");

type Step = [id: string, name: string, args: object];
/** The model's script: a mix of reads, edits, polls and searches that makes results redundant. */
function script(): Step[] {
  const steps: Step[] = [
    ["c1", "read_file", { path: "a.ts" }],
    ["c2", "search_text", { pattern: "foo", path: "src" }],
    ["c3", "read_file", { path: "a.ts" }],
    ["c4", "edit_file", { path: "a.ts" }],
    ["c5", "bg_output", { id: "t1" }],
    ["c6", "bg_output", { id: "t1" }],
    ["c7", "search_text", { path: "src", pattern: "foo" }],
    ["c8", "read_file", { path: "a.ts" }],
  ];
  for (let i = 9; i <= 20; i++)
    steps.push([`c${i}`, i % 2 ? "read_file" : "edit_file", { path: "b.ts" }]);
  return steps;
}

interface Capture {
  requests: Array<{ instructions: string; messages: Message[]; tools: string[] }>;
  raw: string[];
  stored: string;
  status: string;
  governance: unknown;
}

async function scenario(root: string, gov: Governor | undefined, tag: string): Promise<Capture> {
  const store = new SQLiteStore(join(root, `store-${tag}.sqlite`));
  const files = new Map<string, number>([
    ["a.ts", 1],
    ["b.ts", 1],
  ]);
  let tick = 0;
  const registry = new ToolRegistry();
  const tool = (name: string, run: (input: Record<string, unknown>) => string) =>
    registry.register({
      name,
      effect: "read",
      description: name,
      inputSchema: { type: "object" },
      async execute(input) {
        return textResult(run(input as Record<string, unknown>));
      },
    });
  tool("read_file", (i) =>
    JSON.stringify({
      path: i.path,
      sha256: shaOf(files.get(String(i.path)) ?? 0),
      startLine: 1,
      content: `1: ${"line ".repeat(120)}`,
      truncated: false,
    }),
  );
  tool("edit_file", (i) => {
    files.set(String(i.path), (files.get(String(i.path)) ?? 0) + 1);
    return JSON.stringify({ path: i.path, sha256: shaOf(files.get(String(i.path)) ?? 0) });
  });
  tool("search_text", () =>
    JSON.stringify({
      exitCode: 0,
      stdout: [
        JSON.stringify({ type: "match", data: { lines: { text: "foo here" } } }),
        JSON.stringify({ type: "summary", data: { elapsed_total: { nanos: ++tick } } }),
      ].join("\n"),
      stderr: "",
      truncated: false,
    }),
  );
  tool("bg_output", (i) =>
    JSON.stringify({ id: i.id, status: "running", text: "chunk", next_offset: 5, eof: false }),
  );

  const steps = script();
  let call = 0;
  const raw: string[] = [];
  const requests: Capture["requests"] = [];
  const provider = {
    id: "test",
    model: "test",
    async *stream(request: {
      instructions: string;
      messages: Message[];
      tools?: Array<{ name: string }>;
    }): AsyncGenerator<ProviderEvent> {
      const record = {
        instructions: request.instructions,
        messages: request.messages,
        tools: (request.tools ?? []).map((t) => t.name),
      };
      raw.push(JSON.stringify(record));
      requests.push(record);
      const step = steps[call++];
      yield {
        type: "completed",
        message: step
          ? {
              role: "assistant",
              text: "",
              calls: [{ id: step[0], name: step[1], arguments: JSON.stringify(step[2]) }],
            }
          : { role: "assistant", text: "all done", calls: [] },
      };
    },
  };
  const session = store.create(root, "test", "test");
  const runner = new AgentRunner({
    provider: provider as never,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    maxTurns: 100,
    ...(gov ? { contextGovernor: gov } : {}),
  });
  try {
    const result = await runner.run(session.id, "go");
    return {
      requests,
      raw,
      stored: JSON.stringify(store.messages(session.id)),
      status: result.status,
      governance: runner.governance(session.id),
    };
  } finally {
    store.close();
  }
}

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "alisio-shadow-identity-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const STUB = /^\[elided: (read_file|bg_output|search_text) /;
const toolText = (m: Message) =>
  m.role === "tool" ? m.result.content.map((p) => (p.type === "text" ? p.text : "")).join("") : "";

describe("Context Governor wiring in the runner", () => {
  it("S1 off and shadow send byte-identical requests to a runner without the governor", async () => {
    const bare = await scenario(root, undefined, "bare");
    const off = await scenario(root, governor("off"), "off");
    const shadow = await scenario(root, governor("shadow"), "shadow");
    expect(bare.status).toBe("completed");
    expect(bare.raw.length).toBe(script().length + 1);
    expect(off.raw).toEqual(bare.raw);
    expect(shadow.raw).toEqual(bare.raw);
  });

  it("S2 the persisted transcript is identical in every mode", async () => {
    const bare = await scenario(root, undefined, "bare2");
    const off = await scenario(root, governor("off"), "off2");
    const shadow = await scenario(root, governor("shadow"), "shadow2");
    const on = await scenario(root, governor("on"), "on2");
    expect(off.stored).toBe(bare.stored);
    expect(shadow.stored).toBe(bare.stored);
    expect(on.stored).toBe(bare.stored);
    expect(on.status).toBe("completed");
  });

  it("S3 on keeps every request's shape and only swaps redundant tool results for stubs", async () => {
    const off = await scenario(root, governor("off"), "off3");
    const on = await scenario(root, governor("on"), "on3");
    expect(on.requests.length).toBe(off.requests.length);
    let differing = 0;
    on.requests.forEach((req, r) => {
      const base = off.requests[r];
      expect(req.instructions).toBe(base?.instructions);
      expect(req.tools).toEqual(base?.tools);
      expect(req.messages.length).toBe(base?.messages.length);
      req.messages.forEach((m, i) => {
        const b = base?.messages[i] as Message;
        expect(m.role).toBe(b.role);
        if (m.role === "tool" && b.role === "tool") expect(m.callId).toBe(b.callId);
        if (JSON.stringify(m) === JSON.stringify(b)) return;
        differing++;
        expect(m.role).toBe("tool");
        expect(toolText(m)).toMatch(STUB);
        // The call id and everything but the text survive.
        if (m.role === "tool" && b.role === "tool")
          expect({ ...m, result: undefined }).toEqual({ ...b, result: undefined });
      });
    });
    expect(differing).toBeGreaterThan(0);
  });

  it("S4 shadow records what it would elide, off records nothing, and no content is kept", async () => {
    const off = await scenario(root, governor("off"), "off4");
    const bare = await scenario(root, undefined, "bare4");
    const shadow = await scenario(root, governor("shadow"), "shadow4");
    expect(off.governance).toBeUndefined();
    expect(bare.governance).toBeUndefined();
    expect(shadow.governance).toMatchObject({
      mode: "shadow",
      policyVersion: CONTEXT_POLICY_VERSION,
    });
    const g = shadow.governance as {
      elided: number;
      tokensSaved: number;
      tokensBefore: number;
      tokensAfter: number;
      elisions: Array<{ reason: string }>;
    };
    expect(g.elided).toBeGreaterThan(0);
    expect(g.tokensSaved).toBeGreaterThan(0);
    expect(g.tokensBefore - g.tokensAfter).toBe(g.tokensSaved);
    expect(g.elisions).toHaveLength(g.elided);
    const text = JSON.stringify(shadow.governance);
    expect(text).not.toContain("line line");
    expect(text).not.toContain("foo here");
  });

  it.each([32, 8])(
    "S5 with an epoch of %i messages a request is a byte prefix of the next one in the same epoch",
    async (epoch) => {
      const off = await scenario(root, governor("off"), `off5-${epoch}`);
      const on = await scenario(root, governor("on", epoch), `on5-${epoch}`);
      const json = on.requests.map((r) => r.messages.map((m) => JSON.stringify(m)));
      let sameEpochPairs = 0;
      let stubbed = 0;
      json.forEach((a, i) => {
        // Inside the first epoch nothing is eligible yet: identical to off.
        if (a.length < epoch)
          expect(a, `request ${i}`).toEqual(
            off.requests[i]?.messages.map((m) => JSON.stringify(m)),
          );
        if (a.some((m) => STUB.test(toolText(JSON.parse(m))))) stubbed++;
        for (const b of json.slice(i + 1)) {
          if (Math.floor(a.length / epoch) !== Math.floor(b.length / epoch)) continue;
          sameEpochPairs++;
          expect(b.slice(0, a.length), `request ${i}`).toEqual(a);
        }
      });
      expect(sameEpochPairs).toBeGreaterThan(5);
      expect(stubbed).toBeGreaterThan(0);
    },
  );
});

describe("S6 shadow replay of the bundled cassettes", () => {
  it("replays every recorded task with the governor in shadow mode without divergence", async () => {
    for (const key of RECORDED_TASKS) {
      const [suiteId, taskId] = key.split("/") as [string, string];
      const record = await runScripted({
        suiteId,
        taskId,
        mode: "replay",
        cassette: readCassette(
          join(BUNDLED_DIR, suiteId, "cassettes", `${taskId}${CASSETTE_SUFFIX}`),
        ),
        tmpRoot: root,
        configOverrides: { "context.governor": "shadow" },
      });
      expect(record.divergence, key).toBeUndefined();
      expect(record.error, key).toBeUndefined();
      expect(record.status, key).toBe("pass");
    }
  }, 60_000);
});
