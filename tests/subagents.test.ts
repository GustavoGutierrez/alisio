import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ModelProvider } from "@alisio/sdk";
import { textResult } from "@alisio/sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import { type AppOptions, createApplication } from "../packages/core/src/application.ts";
import { hash } from "../packages/core/src/tools/standard.ts";
import { subagentsConfigSchema } from "../packages/plugin-subagents/src/config.ts";

const base = await mkdtemp(join(tmpdir(), "alisio-subagents-"));
afterAll(() => rm(base, { recursive: true, force: true }));
beforeAll(() => {
  process.env.ALISIO_CONFIG_HOME = join(base, "no-config-home");
});

type Reply = { text?: string; calls?: Array<{ name: string; args: unknown }> };
type Turn = {
  key: string;
  round: number;
  messages: Message[];
  tools: string[];
  instructions: string;
  /** Per-call output token budget the request was sent with. */
  maxOutputTokens?: number;
};
/** Scripted provider: each conversation is keyed by its first user message. */
function scripted(handler: (turn: Turn) => Reply | Promise<Reply>): ModelProvider {
  const rounds = new Map<string, number>();
  let seq = 0;
  return {
    id: "test",
    model: "test",
    async *stream(request) {
      const first = request.messages.find((m) => m.role === "user" && !m.summary);
      const key = first?.role === "user" ? first.text : "";
      const round = (rounds.get(key) ?? 0) + 1;
      rounds.set(key, round);
      const reply = await handler({
        key,
        round,
        messages: request.messages,
        tools: request.tools.map((t) => t.name),
        instructions: request.instructions,
        maxOutputTokens: request.maxOutputTokens,
      });
      const calls = (reply.calls ?? []).map((c) => ({
        id: `c${++seq}`,
        name: c.name,
        arguments: JSON.stringify(c.args),
      }));
      yield {
        type: "completed",
        message: { role: "assistant", text: reply.text ?? "", calls },
        usage: { input: 100, output: 10 },
      };
    },
  };
}
const toolTexts = (messages: Message[]) =>
  messages.flatMap((m) =>
    m.role === "tool"
      ? [
          m.result.content
            .filter((c) => c.type === "text")
            .map((c) => c.text)
            .join(""),
        ]
      : [],
  );
const taskId = (text: string) => /<task id="([^"]+)"/.exec(text)?.[1] ?? "";
let n = 0;
async function app(
  provider: ModelProvider,
  options: { plugin?: Record<string, unknown>; app?: Partial<AppOptions>; cwd?: string } = {},
) {
  const dir = join(base, `case-${n++}`);
  await mkdir(dir, { recursive: true });
  process.env.ALISIO_STATE_HOME = join(dir, "state");
  const config = join(dir, "config.json");
  await writeFile(
    config,
    JSON.stringify({
      provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
      builtinPlugins: { subagents: { ...(options.plugin ?? {}) } },
    }),
  );
  const instance = await createApplication({
    cwd: options.cwd ?? dir,
    config,
    noHerdr: true,
    db: join(dir, "sessions.sqlite"),
    builtins: BUILTIN_PLUGINS.filter((p) => p.id === "subagents"),
    provider,
    ...options.app,
  });
  const session = instance.store.create(instance.workspace, instance.provider.id, "test").id;
  return { app: instance, session, dir, db: join(dir, "sessions.sqlite") };
}
const gate = () => {
  let open: () => void = () => {};
  const promise = new Promise<void>((r) => {
    open = r;
  });
  return { promise, open };
};

describe("delegation basics", () => {
  it("runs parallel children with fresh, isolated context and wraps their results", async () => {
    const seen: Record<string, Turn> = {};
    const active = { now: 0, max: 0 };
    const { app: a, session } = await app(
      scripted(async (t) => {
        if (t.key.startsWith("PARENT")) {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "find A", prompt: "CHILD-A look", subagent_type: "explore" },
                },
                {
                  name: "task",
                  args: { description: "find B", prompt: "CHILD-B look", subagent_type: "explore" },
                },
              ],
            };
          seen.parentResults = t;
          return { text: "summary" };
        }
        seen[t.key] = t;
        active.now++;
        active.max = Math.max(active.max, active.now);
        await new Promise((r) => setTimeout(r, 60));
        active.now--;
        return { text: `result of ${t.key}` };
      }),
    );
    try {
      await a.runner.run(session, "PARENT SECRET-PARENT delegate");
      const child = seen["CHILD-A look"];
      expect(child).toBeDefined();
      expect(JSON.stringify(child?.messages)).not.toContain("SECRET-PARENT");
      expect(child?.instructions).toContain("Subagent: explore");
      expect(child?.tools).not.toContain("write_file");
      expect(child?.tools).not.toContain("task");
      expect(active.max).toBe(2);
      const results = toolTexts(seen.parentResults?.messages ?? []);
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toMatch(/^Subagent output \(non-authoritative/);
        expect(r).toMatch(/<task id="[0-9a-f-]{36}" agent="explore" state="completed">/);
      }
      const children = a.store.children(session);
      expect(children.map((c) => [c.agent, c.status, c.depth])).toEqual([
        ["explore", "completed", 1],
        ["explore", "completed", 1],
      ]);
    } finally {
      await a.close();
    }
  });

  it("withholds task at the depth limit and caps results", async () => {
    let childTools: string[] = [];
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD", subagent_type: "general" },
                },
              ],
            };
          return { text: toolTexts(t.messages).join("") };
        }
        childTools = t.tools;
        return { text: "x".repeat(10_000) };
      }),
      { plugin: { maxDepth: 1, resultMaxBytes: 2_000 } },
    );
    try {
      const { text } = await a.runner.run(session, "PARENT");
      expect(childTools).toContain("read_file");
      expect(childTools).not.toContain("task");
      expect(text).toMatch(/\[truncated: 8000 bytes omitted\]/);
      expect(text.length).toBeLessThan(2_600);
    } finally {
      await a.close();
    }
  });

  it("enforces concurrency and fails fast when the queue is full", async () => {
    const release = gate();
    let started = 0;
    const { app: a, session } = await app(
      scripted(async (t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [1, 2, 3].map((i) => ({
                name: "task",
                args: { description: `t${i}`, prompt: `CHILD-${i}`, subagent_type: "explore" },
              })),
            };
          return { text: toolTexts(t.messages).join("\n---\n") };
        }
        started++;
        if (started === 1) setTimeout(() => release.open(), 100);
        await release.promise;
        return { text: `done ${t.key}` };
      }),
      { plugin: { maxConcurrentPerParent: 1, maxQueued: 1 } },
    );
    try {
      const { text } = await a.runner.run(session, "PARENT");
      expect(text.match(/state="completed"/g)).toHaveLength(2);
      expect(text).toMatch(/queue is full/);
    } finally {
      await a.close();
    }
  });

  it("turns child failures into structured errors with the task id", async () => {
    let parentSaw = "";
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD-FAIL", subagent_type: "explore" },
                },
              ],
            };
          const tool = t.messages.findLast((m) => m.role === "tool");
          parentSaw = JSON.stringify(tool);
          return { text: "ok" };
        }
        throw new Error("provider exploded");
      }),
    );
    try {
      await a.runner.run(session, "PARENT");
      expect(parentSaw).toContain('"isError":true');
      expect(parentSaw).toMatch(/state=\\"failed\\"/);
      expect(parentSaw).toContain("provider exploded");
      expect(parentSaw).toMatch(/Resume with task_id=\\"[0-9a-f-]{36}\\"/);
    } finally {
      await a.close();
    }
  });

  it("delivers a turn-capped child as usable partial output, not an error", async () => {
    let parentSaw = "";
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD-LOOP", subagent_type: "explore" },
                },
              ],
            };
          const tool = t.messages.findLast((m) => m.role === "tool");
          parentSaw = JSON.stringify(tool);
          return { text: "ok" };
        }
        // The child never finishes: it keeps reading files until its turn cap (2) kicks in,
        // while streaming partial observations.
        return {
          text: `scan round ${t.round}`,
          calls: [{ name: "read_file", args: { path: "config.json" } }],
        };
      }),
      { plugin: { maxTurns: 2 } },
    );
    try {
      const { text } = await a.runner.run(session, "PARENT");
      expect(text).toBe("ok");
      // Partial result, NOT a failure: no error flag, state="completed", progress delivered.
      expect(parentSaw).not.toContain('"isError":true');
      expect(parentSaw).not.toContain('state="failed"');
      expect(parentSaw).not.toContain("provider exploded");
      expect(parentSaw).toContain("scan round 2");
      // The caller is warned that the report may be incomplete.
      expect(parentSaw).toContain("reached its turn limit");
      expect(parentSaw).toContain("may be incomplete");
      const children = a.store.children(session);
      expect(children.map((c) => [c.agent, c.status])).toEqual([["explore", "completed"]]);
    } finally {
      await a.close();
    }
  });
});

describe("child output token budgets", () => {
  it("forwards maxOutputTokensPerChild to child runs (default 16384) and keeps maxTokens cumulative", async () => {
    let childTurn: Turn | undefined;
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD-BUDGET", subagent_type: "general" },
                },
              ],
            };
          return { text: "parent done" };
        }
        childTurn = t;
        return { text: "done" };
      }),
    );
    try {
      await a.runner.run(session, "PARENT");
      expect(childTurn?.maxOutputTokens).toBe(16_384);
      const options = a.store.children(session).map((c) => a.store.get(c.id).options ?? {});
      expect(options[0]).toMatchObject({ maxOutputTokens: 16_384 });
    } finally {
      await a.close();
    }
  });

  it("honors an explicit maxOutputTokensPerChild", async () => {
    let childTurn: Turn | undefined;
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD-EXPLICIT", subagent_type: "explore" },
                },
              ],
            };
          return { text: "parent done" };
        }
        childTurn = t;
        return { text: "done" };
      }),
      { plugin: { maxOutputTokensPerChild: 8192 } },
    );
    try {
      await a.runner.run(session, "PARENT");
      expect(childTurn?.maxOutputTokens).toBe(8192);
    } finally {
      await a.close();
    }
  });

  it("sends the child call together with the cumulative maxTokens when both are configured", async () => {
    let childTurn: Turn | undefined;
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: { description: "d", prompt: "CHILD-BOTH", subagent_type: "general" },
                },
              ],
            };
          return { text: "parent done" };
        }
        childTurn = t;
        return { text: "done" };
      }),
      { plugin: { maxTokensPerChild: 300_000 } },
    );
    try {
      await a.runner.run(session, "PARENT");
      expect(childTurn?.maxOutputTokens).toBe(16_384);
      const options = a.store.children(session).map((c) => a.store.get(c.id).options ?? {});
      expect(options[0]).toMatchObject({ maxTokens: 300_000, maxOutputTokens: 16_384 });
    } finally {
      await a.close();
    }
  });
});

describe("subagents config schema", () => {
  it("defaults maxOutputTokensPerChild to 16384 and keeps maxTokensPerChild optional", () => {
    const config = subagentsConfigSchema.parse({});
    expect(config.maxOutputTokensPerChild).toBe(16_384);
    expect(config.maxTokensPerChild).toBeUndefined();
    expect(config.maxTurns).toBe(50);
  });

  it("accepts explicit limits and rejects non-positive output budgets", () => {
    expect(
      subagentsConfigSchema.parse({ maxOutputTokensPerChild: 8192 }).maxOutputTokensPerChild,
    ).toBe(8192);
    expect(
      subagentsConfigSchema.parse({ maxTokensPerChild: 300_000, maxOutputTokensPerChild: 24_000 })
        .maxTokensPerChild,
    ).toBe(300_000);
    expect(() => subagentsConfigSchema.parse({ maxOutputTokensPerChild: 0 })).toThrow();
    expect(() => subagentsConfigSchema.parse({ maxOutputTokensPerChild: -1 })).toThrow();
  });
});

describe("permissions", () => {
  it("narrows capabilities: read-only roots and read-only agents never get write tools", async () => {
    const tools: Record<string, string[]> = {};
    const provider = scripted((t) => {
      if (t.key === "PARENT") {
        if (t.round === 1)
          return {
            calls: [
              {
                name: "task",
                args: { description: "g", prompt: "CHILD-G", subagent_type: "general" },
              },
              {
                name: "task",
                args: { description: "e", prompt: "CHILD-E", subagent_type: "explore" },
              },
            ],
          };
        return { text: "ok" };
      }
      tools[t.key] = t.tools;
      return { text: "done" };
    });
    const ro = await app(provider, { app: { readOnly: true } });
    try {
      await ro.app.runner.run(ro.session, "PARENT");
      expect(tools["CHILD-G"]).not.toContain("write_file");
      expect(tools["CHILD-G"]).not.toContain("shell");
      const [child] = ro.app.store.children(ro.session);
      expect(ro.app.plugins.sessions.capabilities(child?.id ?? "")).toMatchObject({
        write: false,
        readOnly: true,
      });
    } finally {
      await ro.app.close();
    }
    const rw = await app(
      scripted((t) => {
        if (t.key === "PARENT")
          return t.round === 1
            ? {
                calls: [
                  {
                    name: "task",
                    args: { description: "g", prompt: "CHILD-G2", subagent_type: "general" },
                  },
                  {
                    name: "task",
                    args: { description: "e", prompt: "CHILD-E2", subagent_type: "explore" },
                  },
                ],
              }
            : { text: "ok" };
        tools[t.key] = t.tools;
        return { text: "done" };
      }),
      { app: { allowWrite: true }, plugin: { parallelWrites: "shared" } },
    );
    try {
      await rw.app.runner.run(rw.session, "PARENT");
      expect(tools["CHILD-G2"]).toContain("write_file");
      expect(tools["CHILD-E2"]).not.toContain("write_file");
    } finally {
      await rw.app.close();
    }
  });

  it("offers no task tool when the plugin is disabled", async () => {
    const { app: a } = await app(
      scripted(() => ({ text: "x" })),
      { app: { disablePlugins: ["subagents"] } },
    );
    try {
      expect(a.registry.list().some((t) => t.name === "task")).toBe(false);
    } finally {
      await a.close();
    }
  });
});

describe("communication", () => {
  it("delivers messages to running children, bounds waits and forbids waiting on ancestors", async () => {
    const hold = gate();
    let childSaw = "";
    let parentId = "";
    let illegal = "";
    const { app: a, session } = await app(
      scripted(async (t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: {
                    description: "m",
                    prompt: "CHILD-M",
                    subagent_type: "general",
                    background: true,
                  },
                },
              ],
            };
          const id = taskId(toolTexts(t.messages)[0] ?? "");
          if (t.round === 2)
            return {
              calls: [
                { name: "task_wait", args: { task_id: id, timeout_ms: 150 } },
                { name: "send_message", args: { task_id: id, text: "EXTRA-INFO" } },
              ],
            };
          if (t.round === 3) {
            hold.open();
            return { calls: [{ name: "task_wait", args: { task_id: id, timeout_ms: 5_000 } }] };
          }
          return { text: toolTexts(t.messages).join("\n---\n") };
        }
        if (t.round === 1) {
          parentId = session;
          return {
            calls: [
              { name: "hold", args: {} },
              { name: "task_wait", args: { task_id: parentId, timeout_ms: 10 } },
            ],
          };
        }
        childSaw = JSON.stringify(t.messages);
        illegal = toolTexts(t.messages).join("");
        return { text: "got it" };
      }),
    );
    a.registry.register({
      name: "hold",
      effect: "read",
      description: "waits",
      inputSchema: { type: "object", properties: {} },
      async execute() {
        await hold.promise;
        return textResult("held");
      },
    });
    try {
      const { text } = await a.runner.run(session, "PARENT");
      expect(text).toMatch(/Still running after 150ms/);
      expect(text).toMatch(/Queued for task/);
      expect(text).toMatch(/state="completed"[^]*got it/);
      expect(childSaw).toContain("EXTRA-INFO");
      expect(illegal).toMatch(/not one of your subagents: waiting on it would deadlock/);
    } finally {
      await a.close();
    }
  });

  it("injects a bounded completion notification into the parent after background work", async () => {
    const release = gate();
    let second = "";
    const { app: a, session } = await app(
      scripted(async (t) => {
        if (t.key === "PARENT") {
          if (t.round === 1)
            return {
              calls: [
                {
                  name: "task",
                  args: {
                    description: "bg",
                    prompt: "CHILD-BG",
                    subagent_type: "explore",
                    background: true,
                  },
                },
              ],
            };
          if (t.round === 2) return { text: "started" };
          second = JSON.stringify(t.messages);
          return { text: "noted" };
        }
        await release.promise;
        return { text: "background result" };
      }),
    );
    try {
      await a.runner.run(session, "PARENT");
      release.open();
      const [child] = a.store.children(session);
      for (let i = 0; i < 50 && a.store.get(child?.id ?? "").status !== "completed"; i++)
        await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 20));
      await a.runner.run(session, "next");
      expect(second).toContain("<task-notification");
      expect(second).toContain("background result");
    } finally {
      await a.close();
    }
  });
});

describe("robustness", () => {
  it("cascades cancellation and force-kills a process tool after the grace period", async () => {
    const started = gate();
    const pidFile = join(base, "child.pid");
    const controller = new AbortController();
    const script = `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)`;
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT")
          return t.round === 1
            ? {
                calls: [
                  {
                    name: "task",
                    args: { description: "p", prompt: "CHILD-P", subagent_type: "general" },
                  },
                ],
              }
            : { text: "ok" };
        setTimeout(() => started.open(), 300);
        return {
          calls: [
            {
              name: "run_process",
              args: { command: process.execPath, args: ["-e", script], timeoutMs: 120_000 },
            },
          ],
        };
      }),
      { app: { allowProcess: true } },
    );
    try {
      const run = a.runner.run(session, "PARENT", controller.signal);
      await started.promise;
      controller.abort(new Error("user pressed Esc"));
      await expect(run).rejects.toThrow();
      const [child] = a.store.children(session);
      for (let i = 0; i < 400 && a.store.get(child?.id ?? "").status === "running"; i++)
        await new Promise((r) => setTimeout(r, 25));
      expect(a.store.get(child?.id ?? "").status).toBe("cancelled");
      const pid = Number(await readFile(pidFile, "utf8"));
      let alive = true;
      for (let i = 0; i < 300 && alive; i++) {
        try {
          process.kill(pid, 0);
          await new Promise((r) => setTimeout(r, 50));
        } catch {
          alive = false;
        }
      }
      expect(alive).toBe(false);
    } finally {
      await a.close();
    }
  }, 30_000);

  it("marks stale work interrupted on restart and resumes it by task_id with history", async () => {
    let resumedMessages = "";
    let childId = "";
    const provider = scripted((t) => {
      if (t.key === "PARENT") {
        if (t.round === 1)
          return {
            calls: [
              {
                name: "task",
                args: { description: "r", prompt: "CHILD-R first", subagent_type: "explore" },
              },
            ],
          };
        if (t.round === 2) {
          childId = taskId(toolTexts(t.messages)[0] ?? "");
          return { text: "done" };
        }
        if (t.round === 3)
          return {
            calls: [
              {
                name: "task",
                args: {
                  description: "r",
                  prompt: "CHILD-R second",
                  subagent_type: "explore",
                  task_id: childId,
                },
              },
            ],
          };
        return { text: toolTexts(t.messages).at(-1) ?? "" };
      }
      if (t.round === 2) resumedMessages = JSON.stringify(t.messages);
      return { text: `child round ${t.round}` };
    });
    const first = await app(provider);
    await first.app.runner.run(first.session, "PARENT");
    first.app.store.updateSession(childId, { status: "running" });
    await first.app.close();
    // Restart on the same database: stale work is marked interrupted, never restarted.
    const again = await createApplication({
      cwd: first.dir,
      config: join(first.dir, "config.json"),
      noHerdr: true,
      db: first.db,
      builtins: BUILTIN_PLUGINS.filter((p) => p.id === "subagents"),
      provider,
    });
    try {
      expect(again.store.get(childId).status).toBe("interrupted");
      const { text } = await again.runner.run(first.session, "resume please");
      expect(resumedMessages).toContain("CHILD-R first");
      expect(resumedMessages).toContain("CHILD-R second");
      expect(text).toMatch(/state="completed"[^]*child round 2/);
      expect(again.store.get(childId).status).toBe("completed");
    } finally {
      await again.close();
    }
  });
});

describe("parallel writes", () => {
  const writer = (
    key: string,
    files: Record<string, { content: string; expectedHash: string | null }>,
  ) =>
    ({
      calls: Object.entries(files).map(([path, f]) => ({
        name: "write_file",
        args: { path, ...f },
      })),
    }) satisfies Reply;

  async function repo() {
    const dir = join(base, `repo-${n++}`);
    await mkdir(dir, { recursive: true });
    const g = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe" }).toString();
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@example.com");
    g("config", "user.name", "T");
    await writeFile(join(dir, "shared.txt"), "base\n");
    g("add", "-A");
    g("commit", "-q", "-m", "init");
    return { dir, g };
  }

  it("isolates concurrent writers in worktrees, then merges, reports conflicts and discards", async () => {
    const { dir, g } = await repo();
    const original = hash("base\n");
    const results: string[] = [];
    const { app: a, session } = await app(
      scripted((t) => {
        if (t.key === "PARENT")
          return t.round === 1
            ? {
                calls: ["A", "B"].map((x) => ({
                  name: "task",
                  args: {
                    description: `writer ${x}`,
                    prompt: `CHILD-W${x}`,
                    subagent_type: "general",
                  },
                })),
              }
            : (results.push(...toolTexts(t.messages)), { text: "ok" });
        if (t.round > 1) return { text: `wrote ${t.key}` };
        const x = t.key.slice(-1);
        return writer(t.key, {
          [`${x.toLowerCase()}.txt`]: { content: `${x}\n`, expectedHash: null },
          "shared.txt": { content: `changed by ${x}\n`, expectedHash: original },
        });
      }),
      { app: { allowWrite: true }, plugin: { parallelWrites: "worktree" }, cwd: dir },
    );
    try {
      await a.runner.run(session, "PARENT");
      expect(results).toHaveLength(2);
      for (const r of results) {
        expect(r).toMatch(/Branch: alisio\/[0-9a-f-]{36}/);
        expect(r).toMatch(/Changed files: .*shared\.txt/);
        expect(r).toMatch(/Diffstat:/);
      }
      expect(existsSync(join(dir, "a.txt"))).toBe(false);
      const [idA, idB] = results.map(taskId);
      const agents = a.plugins.commands.get("agents");
      expect(await agents?.(`merge ${idA}`, { sessionId: session })).toMatch(/Merged alisio\//);
      expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("A\n");
      const conflict = await agents?.(`merge ${idB}`, { sessionId: session });
      expect(conflict).toMatch(/Conflicting files: shared\.txt/);
      expect(g("status", "--porcelain").trim()).toBe("");
      expect(await agents?.(`discard ${idB}`, { sessionId: session })).toMatch(/Discarded/);
      expect(g("branch", "--list", `alisio/${idB}`).trim()).toBe("");
    } finally {
      await a.close();
    }
  }, 30_000);

  for (const mode of ["serial", "ask"] as const)
    it(`runs writers one at a time in ${mode === "ask" ? "headless ask (falls back to serial)" : "serial"} mode`, async () => {
      const spans: Record<string, [number, number]> = {};
      const results: string[] = [];
      const { app: a, session } = await app(
        scripted(async (t) => {
          if (t.key === "PARENT")
            return t.round === 1
              ? {
                  calls: ["1", "2"].map((x) => ({
                    name: "task",
                    args: { description: `w${x}`, prompt: `CHILD-S${x}`, subagent_type: "general" },
                  })),
                }
              : (results.push(...toolTexts(t.messages)), { text: "ok" });
          if (t.round === 1) {
            spans[t.key] = [Date.now(), 0];
            await new Promise((r) => setTimeout(r, 120));
            return { text: "", calls: [] };
          }
          return { text: "x" };
        }),
        { app: { allowWrite: true }, plugin: { parallelWrites: mode } },
      );
      // Record end times through the child finishing (round 1 returns the final text).
      a.plugins.observers.add((e) => {
        if (e.type === "run_completed") {
          const s = a.store.get(e.sessionId);
          const key = s.parentId
            ? (
                a.store.messages(e.sessionId).find((m) => m.role === "user") as
                  | { text: string }
                  | undefined
              )?.text
            : undefined;
          if (key && spans[key]) spans[key][1] = Date.now();
        }
      });
      try {
        await a.runner.run(session, "PARENT");
        const [first, second] = Object.values(spans).sort((x, y) => x[0] - y[0]);
        expect(first && second).toBeTruthy();
        expect((second?.[0] ?? 0) >= (first?.[1] ?? Number.MAX_SAFE_INTEGER)).toBe(true);
        if (mode === "ask")
          expect(results.join("")).toMatch(/without an interactive terminal: using serial/);
      } finally {
        await a.close();
      }
    });
});
