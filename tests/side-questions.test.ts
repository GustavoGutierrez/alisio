/** `/btw` side questions (core service + CommandCatalog): answered outside the conversation. */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS, CommandCatalog } from "../packages/core/src/commands/catalog.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import * as core from "../packages/core/src/index.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  SIDE_QUESTION_HISTORY_LIMIT,
  SIDE_QUESTION_USAGE,
  SIDE_QUESTIONS_NAMESPACE,
  SideQuestions,
  sideTranscript,
} from "../packages/core/src/sessions/side-questions.ts";

type Request = Parameters<ModelProvider["stream"]>[0];
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const abortable = <T>(promise: Promise<T>, signal: AbortSignal) =>
  new Promise<T>((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });

/** A runner + store where `turn` answers every provider call (requests are recorded). */
async function fixture(
  turn: (request: Request, call: number) => AsyncGenerator<ProviderEvent>,
  options: { maxContextChars?: number } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-btw-"));
  roots.push(root);
  const store = new SQLiteStore(join(root, "sessions.sqlite"));
  const calls: Request[] = [];
  const provider: ModelProvider = {
    id: "test",
    model: "m",
    stream(request) {
      calls.push(request);
      return turn(request, calls.length - 1);
    },
  };
  const registry = new ToolRegistry();
  registry.register({
    name: "read_it",
    description: "r",
    inputSchema: { type: "object", properties: {} },
    effect: "read",
    async execute() {
      return { content: [{ type: "text", text: "file body" }] };
    },
  });
  const runner = new AgentRunner({
    provider,
    registry,
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    ...(options.maxContextChars ? { maxContextChars: options.maxContextChars } : {}),
  });
  let n = 0;
  const side = new SideQuestions({
    runner,
    state: store,
    now: () => 1000 + n,
    id: () => `q${++n}`,
  });
  const session = store.create(root, "test", "m").id;
  const count = (table: string) =>
    (
      store.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE session=?`).get(session) as {
        n: number;
      }
    ).n;
  const snapshot = () => ({
    messages: JSON.stringify(store.messages(session)),
    rows: ["messages", "events", "runs", "tool_calls"].map(count),
    usage: store.get(session).usage,
  });
  return { root, store, runner, side, session, calls, snapshot, close: () => store.close() };
}

async function* answer(
  text: string,
  usage = { input: 11, output: 3 },
): AsyncGenerator<ProviderEvent> {
  yield { type: "text_delta", delta: text };
  yield { type: "completed", message: { role: "assistant", text, calls: [] }, usage };
}

describe("SideQuestions", () => {
  it("answers from the active history with one tool-less call and persists nothing else", async () => {
    const fx = await fixture((request, call) =>
      call === 0 ? answer("Main answer") : answer("You asked about ducks."),
    );
    try {
      await fx.runner.run(fx.session, "Tell me about ducks");
      const before = fx.snapshot();
      const entry = await fx.side.ask(fx.session, "  what did I ask?  ");
      expect(entry).toEqual({
        id: "q1",
        question: "what did I ask?",
        answer: "You asked about ducks.",
        model: "m",
        usage: { input: 11, output: 3 },
        createdAt: 1001,
      });
      const request = fx.calls[1] as Request;
      expect(request.tools).toEqual([]);
      expect(request.model).toBe("m");
      expect(request.instructions).toContain("side question");
      expect(request.messages).toHaveLength(1);
      const prompt = request.messages[0];
      expect(prompt?.role).toBe("user");
      const text = prompt?.role === "user" ? prompt.text : "";
      expect(text).toContain("USER: Tell me about ducks");
      expect(text).toContain("ASSISTANT: Main answer");
      expect(text).toMatch(/Side question: what did I ask\?$/);
      // No messages, events, runs, tool calls or usage were written by the side question.
      expect(fx.snapshot()).toEqual(before);
      expect(fx.side.history(fx.session)).toEqual([entry]);
      expect(fx.store.getState(SIDE_QUESTIONS_NAMESPACE, fx.session)).toEqual([entry]);
    } finally {
      fx.close();
    }
  });

  it("runs while the session is busy and never takes the session lock", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fx = await fixture(async function* (request, call) {
      if (call === 0) {
        yield { type: "text_delta", delta: "wor" };
        await abortable(gate, request.signal);
        yield* answer("working done");
      } else yield* answer("side answer");
    });
    try {
      const run = fx.runner.run(fx.session, "long task");
      await new Promise((r) => setTimeout(r, 20));
      expect(fx.runner.isRunning(fx.session)).toBe(true);
      const entry = await fx.side.ask(fx.session, "status?");
      expect(entry.answer).toBe("side answer");
      expect(fx.runner.isRunning(fx.session)).toBe(true);
      release();
      await expect(run).resolves.toMatchObject({ status: "completed", text: "working done" });
      // The run's transcript holds only its own prompt and answer.
      expect(fx.store.messages(fx.session).map((m) => m.role)).toEqual(["user", "assistant"]);
    } finally {
      fx.close();
    }
  });

  it("is cancelled by its signal without recording anything", async () => {
    let started!: () => void;
    const began = new Promise<void>((r) => {
      started = r;
    });
    const fx = await fixture(async function* (request) {
      started();
      await abortable(new Promise(() => {}), request.signal);
      yield* answer("never");
    });
    try {
      const controller = new AbortController();
      const pending = fx.side.ask(fx.session, "slow?", { signal: controller.signal });
      await began;
      controller.abort(new Error("Cancelled"));
      await expect(pending).rejects.toThrow("Cancelled");
      expect(fx.side.history(fx.session)).toEqual([]);
    } finally {
      fx.close();
    }
  });

  it("surfaces provider failures as a clean error and records nothing", async () => {
    const fx = await fixture(async function* () {
      throw new Error("HTTP 500 upstream exploded");
    });
    try {
      await expect(fx.side.ask(fx.session, "hello?")).rejects.toThrow(
        "Side question failed: HTTP 500 upstream exploded",
      );
      expect(fx.side.history(fx.session)).toEqual([]);
    } finally {
      fx.close();
    }
  });

  it("validates the question", async () => {
    const fx = await fixture(() => answer("x"));
    try {
      await expect(fx.side.ask(fx.session, "   ")).rejects.toThrow(SIDE_QUESTION_USAGE);
      await expect(fx.side.ask(fx.session, "x".repeat(4_001))).rejects.toThrow(/4000/);
      expect(fx.calls).toHaveLength(0);
    } finally {
      fx.close();
    }
  });

  it("keeps only the newest 20 entries, oldest first", async () => {
    const fx = await fixture((_request, call) => answer(`answer ${call}`));
    try {
      for (let i = 0; i < SIDE_QUESTION_HISTORY_LIMIT + 3; i++)
        await fx.side.ask(fx.session, `question ${i}`);
      const history = fx.side.history(fx.session);
      expect(history).toHaveLength(SIDE_QUESTION_HISTORY_LIMIT);
      expect(history[0]?.question).toBe("question 3");
      expect(history.at(-1)?.question).toBe(`question ${SIDE_QUESTION_HISTORY_LIMIT + 2}`);
    } finally {
      fx.close();
    }
  });

  it("drops the oldest history to fit the context budget", () => {
    const messages = Array.from({ length: 10 }, (_, i) => ({
      role: "user" as const,
      text: `message ${i} ${"x".repeat(80)}`,
    }));
    const transcript = sideTranscript(messages, 400);
    expect(transcript.length).toBeLessThanOrEqual(400 + 80);
    expect(transcript).toMatch(/^\[\d+ earlier messages omitted/);
    expect(transcript).toContain("message 9");
    expect(transcript).not.toContain("message 0 ");
    expect(sideTranscript(messages, 100_000)).not.toContain("omitted");
  });

  it("fits a large session into a small budget before calling the provider", async () => {
    const fx = await fixture(() => answer("fits"), { maxContextChars: 6_000 });
    try {
      for (let i = 0; i < 40; i++)
        fx.store.append(fx.session, { role: "user", text: `old ${i} ${"y".repeat(500)}` });
      await fx.side.ask(fx.session, "summary?");
      const prompt = fx.calls[0]?.messages[0];
      const text = prompt?.role === "user" ? prompt.text : "";
      expect(text.length).toBeLessThan(6_000);
      expect(text).toContain("old 39");
      expect(text).toContain("earlier messages omitted");
    } finally {
      fx.close();
    }
  });

  it("keeps its history out of every plugin's state namespace", () => {
    // Plugin ids match /^[a-z0-9][a-z0-9.-]{0,63}$/: a colon can never occur in one.
    expect(/^[a-z0-9][a-z0-9.-]{0,63}$/.test(SIDE_QUESTIONS_NAMESPACE)).toBe(false);
  });
});

describe("/btw in the CommandCatalog", () => {
  it("is a built-in core command for every surface with an optional question", () => {
    const btw = BUILTIN_COMMANDS.find((c) => c.name === "btw");
    expect(btw).toMatchObject({ argumentHint: "[question]", execution: "core" });
    expect(btw?.surfaces).toEqual(["tui", "web", "api"]);
    expect(new CommandCatalog().resolve("BTW")).toMatchObject({ source: "builtin" });
    expect(core.SIDE_QUESTION_USAGE).toBe("Usage: /btw <question>");
  });

  it("wins over plugin commands and prompt templates named btw", async () => {
    const fx = await fixture(() => answer("x"));
    try {
      const catalog = new CommandCatalog({
        workspace: fx.root,
        store: fx.store,
        runner: fx.runner,
        registry: new ToolRegistry(),
        provider: { id: "test" },
        plugins: {
          commands: new Map([["btw", async () => "plugin btw"]]),
          commandInfo: new Map([["btw", { plugin: "rogue" }]]),
        },
      });
      expect(catalog.list().filter((c) => c.name === "btw")).toHaveLength(1);
      expect(catalog.resolve("btw")?.source).toBe("builtin");
    } finally {
      fx.close();
    }
  });

  it("prints the usage line without a question and history, else the latest entry", async () => {
    const fx = await fixture((_r, call) => answer(`answer ${call}`));
    try {
      const catalog = new CommandCatalog({
        workspace: fx.root,
        store: fx.store,
        runner: fx.runner,
        registry: new ToolRegistry(),
        provider: { id: "test" },
        sideQuestions: fx.side,
      });
      const ctx = { sessionId: fx.session };
      const empty = await catalog.execute("btw", "", ctx);
      expect(empty.text?.split("\n")[0]).toBe("Usage: /btw <question>");
      expect(empty.tone).toBe("notice");
      const asked = await catalog.execute("btw", "first?", ctx);
      expect(asked.text).toContain("answer 0");
      await catalog.execute("btw", "second?", ctx);
      const latest = await catalog.execute("btw", "", ctx);
      expect(latest.text).toContain("**btw 2/2** · second?");
      expect(latest.text).toContain("answer 1");
      expect((latest.data as { history: unknown[] }).history).toHaveLength(2);
      expect(fx.store.messages(fx.session)).toEqual([]);
    } finally {
      fx.close();
    }
  });
});
