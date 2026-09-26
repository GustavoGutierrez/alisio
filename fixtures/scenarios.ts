import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  type ModelProvider,
  type ProviderEvent,
  type SearchProvider,
  textResult,
} from "@alisio/sdk";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import { BUILTIN_PROMPTS } from "../packages/cli/src/prompts/index.ts";
import { createApplication } from "../packages/core/src/application.ts";
import { configSchema, loadConfig } from "../packages/core/src/config.ts";
import { estimateTokens } from "../packages/core/src/core/compaction.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { HerdrBridge } from "../packages/core/src/integrations/herdr.ts";
import { McpConnector } from "../packages/core/src/mcp/connector.ts";
import { PluginHost, pluginPrefix } from "../packages/core/src/plugins/host.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { Skills } from "../packages/core/src/resources/skills.ts";
import { safePath } from "../packages/core/src/runtime/paths.ts";
import { runProcess } from "../packages/core/src/runtime/process.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { runExecute } from "../packages/core/src/tools/execute.ts";
import {
  duckDuckGoInstantProvider,
  searchWithFallback,
  validateSearxngUrl,
} from "../packages/core/src/tools/search.ts";
import { hash, objectSchema, registerStandard } from "../packages/core/src/tools/standard.ts";
import { webfetch } from "../packages/core/src/tools/webfetch.ts";
import {
  getTrust,
  hashProjectConfig,
  hasProjectResources,
  listTrust,
  resolveTrust,
  revokeTrust,
  setTrust,
} from "../packages/core/src/trust.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";
import {
  SQLiteMemoryStore as MemoryStoreOnPort,
  projectId,
} from "../packages/plugin-memory/src/store.ts";
import { OpenAICompatibleProvider } from "../packages/plugin-openai-compatible/src/index.ts";
import { isMain, serve } from "./http.ts";

/** Memory store over the same SQLite adapter the host provides through the storage port. */
class SQLiteMemoryStore extends MemoryStoreOnPort {
  constructor(path: string, options?: ConstructorParameters<typeof MemoryStoreOnPort>[1]) {
    super(openDatabase(path), options);
  }
}
let root = "";
const signal = () => AbortSignal.timeout(10000);
const db = () => new SQLiteStore(join(root, `${crypto.randomUUID()}.sqlite`));
const fixtures: Record<string, () => Promise<void>> = {
  async "safe-path"() {
    await mkdir(join(root, "dir"));
    assert.equal(await safePath(root, "dir/file"), join(root, "dir/file"));
    await assert.rejects(() => safePath(root, "../escape"));
    await symlink(tmpdir(), join(root, "link"));
    await assert.rejects(() => safePath(root, "link/secret"), /Symlinks/);
  },
  async "context-scope"() {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "AGENTS.md"), "Root rules");
    await writeFile(join(root, "src", "AGENTS.md"), "Nested rules");
    const context = new ProjectContext(root);
    const initial = await context.instructions();
    assert.match(initial, /Root rules/);
    assert.doesNotMatch(initial, /Nested rules/);
    assert.match((await context.beforePaths(["src/code.ts"])) ?? "", /Nested rules/);
    assert.equal(await context.beforePaths(["src/code.ts"]), undefined);
    assert.match(await context.instructions(), /Nested rules/);
    await writeFile(join(root, "src", "AGENTS.md"), "Changed rules");
    assert.match((await context.beforePaths(["src/code.ts"])) ?? "", /Changed rules/);
    assert.equal((await context.explain(".")).length, 1);
    // Agente.md is not a recognized name; AGENT.md remains a legacy alias.
    await rm(join(root, "src", "AGENTS.md"));
    await writeFile(join(root, "src", "Agente.md"), "Spanish filename rules");
    assert.equal(await context.beforePaths(["src/code.ts"], "fresh"), undefined);
    await writeFile(join(root, "src", "AGENT.md"), "Alternate filename rules");
    assert.match((await context.beforePaths(["src/code.ts"])) ?? "", /Alternate filename rules/);
  },
  async skills() {
    const valid = join(root, "skills", "review"),
      bad = join(root, "skills", "bad");
    await mkdir(valid, { recursive: true });
    await mkdir(bad);
    await writeFile(
      join(valid, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nSECRET_BODY",
    );
    await writeFile(join(bad, "SKILL.md"), "invalid");
    const skills = new Skills();
    await skills.discover([join(root, "skills")]);
    assert.equal(skills.items.size, 1);
    assert.equal(skills.diagnostics.length, 1);
    assert.doesNotMatch(skills.catalog(), /SECRET_BODY/);
    assert.match(await skills.load("review"), /SECRET_BODY/);
    await assert.rejects(() => skills.resource("review", "../../outside"), /outside/);
  },
  async "safe-edit"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const invoke = (name: string, i: Record<string, unknown>) =>
      reg.get(name).execute(i, { signal: signal(), workspace: root, emit: () => {} });
    await writeFile(join(root, "a.txt"), "old\r\nunchanged\r\n");
    await invoke("edit_file", {
      path: "a.txt",
      oldText: "old",
      newText: "new",
      expectedHash: hash("old\r\nunchanged\r\n"),
    });
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "new\r\nunchanged\r\n");
    await assert.rejects(
      () => invoke("write_file", { path: "a.txt", content: "destroy", expectedHash: null }),
      /precondition/,
    );
    await assert.rejects(
      () =>
        invoke("edit_file", {
          path: "a.txt",
          oldText: "new",
          newText: "bad",
          expectedHash: hash("stale"),
        }),
      /precondition/,
    );
    await invoke("write_file", { path: "new.txt", content: "created", expectedHash: null });
    assert.equal(await readFile(join(root, "new.txt"), "utf8"), "created");
  },
  async "ambiguous-edit"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await writeFile(join(root, "a"), "same same");
    await assert.rejects(
      () =>
        reg
          .get("edit_file")
          .execute(
            { path: "a", oldText: "same", newText: "x", expectedHash: hash("same same") },
            { signal: signal(), workspace: root, emit: () => {} },
          ),
      /exactly one/,
    );
    assert.equal(await readFile(join(root, "a"), "utf8"), "same same");
  },
  async search() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await writeFile(join(root, "a.txt"), "needle");
    const ctx = { signal: signal(), workspace: root, emit: () => {} };
    const found = await reg.get("search_text").execute({ pattern: "needle" }, ctx);
    assert.match(JSON.stringify(found), /needle/);
    const absent = await reg.get("search_text").execute({ pattern: "absent" }, ctx);
    assert.match(JSON.stringify(absent), /exitCode\\":1/);
  },
  async "process-abort"() {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    await assert.rejects(
      () =>
        runProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
          cwd: root,
          signal: ctrl.signal,
        }),
      /abort/i,
    );
  },
  async "process-limit"() {
    const r = await runProcess(
      process.execPath,
      ["-e", "process.stdout.write('x'.repeat(100000))"],
      { cwd: root, signal: signal(), maxBytes: 1000 },
    );
    assert.equal(r.truncated, true);
    assert.equal(r.stdout.length, 1000);
  },
  async "store-recovery"() {
    const store = db();
    try {
      const s = store.create(root, "test", "test");
      store.append(s.id, {
        role: "assistant",
        text: "",
        calls: [{ id: "a", name: "write", arguments: "{}" }],
      });
      store.beginCall(s.id, { id: "a", name: "write", arguments: "{}" });
      assert.throws(() => store.reconcile(s.id), /Uncertain/);
      store.reconcile(s.id, true);
      assert.equal(store.messages(s.id).length, 2);
      store.reconcile(s.id);
      assert.equal(store.messages(s.id).length, 2);
      store.acquire(s.id);
      assert.throws(() => store.acquire(s.id), /already/);
      store.release(s.id);
    } finally {
      store.close();
    }
  },
  async "completed-recovery"() {
    const store = db();
    try {
      const s = store.create(root, "test", "test"),
        call = { id: "a", name: "read", arguments: "{}" };
      store.append(s.id, { role: "assistant", text: "", calls: [call] });
      store.beginCall(s.id, call);
      store.endCall(s.id, call, textResult("recorded"));
      store.reconcile(s.id);
      assert.match(JSON.stringify(store.messages(s.id)), /recorded/);
    } finally {
      store.close();
    }
  },
  async "plugin-rollback"() {
    const registry = new ToolRegistry(),
      store = db(),
      host = new PluginHost(registry, store);
    try {
      await assert.rejects(() =>
        host.activate(
          {
            id: "broken",
            version: "1.0.0",
            apiVersion: 1,
            setup(api) {
              api.tools.register({
                name: "hello",
                description: "test",
                inputSchema: objectSchema({}),
                async execute() {
                  return textResult("ok");
                },
              });
              throw new Error("broken");
            },
          },
          root,
        ),
      );
      assert.equal(registry.list().length, 0);
      await assert.rejects(() =>
        host.activate({ id: "wrong", version: "1.0.0", apiVersion: 2, setup() {} } as never, root),
      );
    } finally {
      await host.close();
      store.close();
    }
  },
  async "plugin-external"() {
    const registry = new ToolRegistry(),
      store = db(),
      host = new PluginHost(registry, store);
    try {
      await writeFile(join(root, "dep.ts"), 'export const message="external dependency";');
      await writeFile(
        join(root, "plugin.ts"),
        'import {message} from "./dep.ts";export default {id:"external",version:"1.0.0",apiVersion:1,setup(api){api.tools.register({name:"hello",description:"hello",inputSchema:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:message}]}}})}}',
      );
      await host.load(join(root, "plugin.ts"));
      const tool = registry.get(`${pluginPrefix("external")}_hello`);
      assert.match(
        JSON.stringify(
          await tool.execute({}, { signal: signal(), workspace: root, emit: () => {} }),
        ),
        /external dependency/,
      );
      await host.close();
      assert.equal(registry.list().length, 0);
    } finally {
      store.close();
    }
  },
  async config() {
    await mkdir(join(root, ".alisio"));
    await writeFile(
      join(root, ".alisio", "config.json"),
      JSON.stringify({
        provider: { model: "local-model", baseURL: "http://localhost:1234/v1", auth: "none" },
      }),
    );
    const ignored = await loadConfig(root);
    assert.notEqual(ignored.provider.model, "local-model");
    const trusted = await loadConfig(root, { trustProject: true });
    assert.equal(trusted.provider.model, "local-model");
    assert.equal(trusted.provider.auth, "none");
    assert.equal(
      (await loadConfig(root, { trustProject: true, model: "override" })).provider.model,
      "override",
    );
  },
  async "agent-loop"() {
    const store = db(),
      registry = new ToolRegistry();
    let calls = 0,
      round = 0;
    registry.register({
      name: "hello",
      effect: "read",
      description: "hello",
      inputSchema: objectSchema({}),
      async execute() {
        calls++;
        return textResult("world");
      },
    });
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        round++;
        if (round === 1)
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: "",
              calls: [{ id: "c1", name: "hello", arguments: "{}" }],
            },
          };
        else {
          assert.equal(request.messages.at(-1)?.role, "tool");
          yield { type: "text_delta", delta: "done" };
          yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        }
      },
    };
    try {
      const session = store.create(root, "test", "test");
      const runner = new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
      });
      assert.equal((await runner.run(session.id, "test")).text, "done");
      assert.equal(calls, 1);
      assert.equal(store.messages(session.id).length, 4);
    } finally {
      store.close();
    }
  },
  async policy() {
    const store = db(),
      registry = new ToolRegistry();
    let invoked = false,
      round = 0;
    registry.register({
      name: "danger",
      effect: "write",
      description: "write",
      inputSchema: objectSchema({}),
      async execute() {
        invoked = true;
        return textResult("bad");
      },
    });
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        assert.equal(request.tools.length, 0);
        if (++round === 1)
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: "",
              calls: [{ id: "x", name: "danger", arguments: "{}" }],
            },
          };
        else {
          assert.match(JSON.stringify(request.messages), /Capability denied/);
          yield { type: "completed", message: { role: "assistant", text: "denied", calls: [] } };
        }
      },
    };
    try {
      const session = store.create(root, "test", "test");
      await new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
      }).run(session.id, "test");
      assert.equal(invoked, false);
    } finally {
      store.close();
    }
  },
  async "scope-before-edit"() {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "AGENTS.md"), "Never edit without reconsidering");
    const store = db(),
      registry = new ToolRegistry();
    let invoked = 0,
      round = 0;
    registry.register({
      name: "edit",
      effect: "write",
      paths: () => ["src/a"],
      description: "edit",
      inputSchema: objectSchema({}),
      async execute() {
        invoked++;
        return textResult("ok");
      },
    });
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        if (++round < 3)
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: "",
              calls: [{ id: `c${round}`, name: "edit", arguments: "{}" }],
            },
          };
        else yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        if (round === 2) assert.match(request.instructions, /Never edit/);
      },
    };
    try {
      const s = store.create(root, "test", "test");
      await new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: true, process: false, external: false },
      }).run(s.id, "test");
      assert.equal(invoked, 1);
    } finally {
      store.close();
    }
  },
  async "herdr-contract"() {
    const commands: string[][] = [];
    const bridge = new HerdrBridge(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        HERDR_BIN_PATH: "herdr",
        HERDR_SOCKET_PATH: "socket",
      },
      async (args) => {
        commands.push(args);
        return '{"ok":true}';
      },
    );
    await bridge.report("idle", "session");
    bridge.event({
      schemaVersion: 1,
      runId: "r",
      sessionId: "session",
      seq: 1,
      type: "run_started",
      timestamp: "now",
      data: {},
    });
    await bridge.report("blocked", "session", "need input");
    await bridge.close();
    assert.equal(commands.length, 4);
    assert.equal(commands[0]?.[1], "report-agent");
    assert.equal(commands[3]?.[1], "release-agent");
    assert.equal(commands[1]?.[commands[1].indexOf("--state") + 1], "working");
    const seqs = commands.map((a) => Number(a[a.indexOf("--seq") + 1]));
    assert.ok(seqs.every((n, i) => !i || n > (seqs[i - 1] ?? 0)));
  },
  async "herdr-messaging"() {
    const commands: string[][] = [];
    const bridge = new HerdrBridge(
      {
        HERDR_ENV: "1",
        HERDR_PANE_ID: "w1:p1",
        HERDR_BIN_PATH: "herdr",
        HERDR_SOCKET_PATH: "socket",
      },
      async (args) => {
        commands.push(args);
        return "{}";
      },
    );
    const r = new ToolRegistry();
    bridge.registerTools(r);
    const prompt = "Review `code` and $(do not execute)";
    await r
      .get("herdr_prompt")
      .execute(
        { target: "w1:p2", text: prompt },
        { signal: signal(), workspace: root, emit: () => {} },
      );
    assert.deepEqual(commands[0], ["agent", "prompt", "w1:p2", prompt]);
    await assert.rejects(
      () =>
        r
          .get("herdr_prompt")
          .execute(
            { target: "w1:p1", text: "self" },
            { signal: signal(), workspace: root, emit: () => {} },
          ),
      /own pane/,
    );
  },
  async "herdr-noop"() {
    let called = false;
    const bridge = new HerdrBridge({}, async () => {
      called = true;
      return "";
    });
    await bridge.report("working", "s");
    await bridge.close();
    assert.equal(called, false);
    assert.throws(() => bridge.registerTools(new ToolRegistry()), /Herdr pane/);
  },
  async compaction() {
    const path = join(root, "compaction.sqlite");
    let store = new SQLiteStore(path);
    const requests: Array<{ instructions: string; text: string; tools: number }> = [];
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        requests.push({
          instructions: request.instructions,
          text: JSON.stringify(request.messages),
          tools: request.tools.length,
        });
        yield { type: "text_delta", delta: "SUMMARY" };
        yield {
          type: "completed",
          message: { role: "assistant", text: "SUMMARY of earlier work", calls: [] },
        };
      },
    };
    const call = (id: string) => ({ id, name: "hello", arguments: "{}" });
    const tool = (callId: string) =>
      ({ role: "tool", callId, result: textResult(`result ${callId}`) }) as const;
    try {
      const s = store.create(root, "test", "test");
      for (const m of [
        { role: "user", text: "first" },
        { role: "assistant", text: "", calls: [call("c1"), call("c2")] },
        tool("c1"),
        tool("c2"),
        { role: "assistant", text: "one", calls: [] },
        { role: "user", text: "second" },
        { role: "assistant", text: "", calls: [call("c3")] },
        tool("c3"),
        { role: "assistant", text: "two", calls: [] },
        { role: "user", text: "third" },
        { role: "assistant", text: "three", calls: [] },
      ] as const)
        store.append(s.id, m as never);
      const events: string[] = [];
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        compaction: { keepTurns: 1 },
        onEvent: (e) => events.push(e.type),
      });
      const result = await runner.compact(s.id, { focus: "keep API names" });
      assert.ok(result);
      assert.equal(result.replaced, 9);
      assert.ok(result.after < result.before);
      assert.equal(requests.length, 1);
      assert.equal(requests[0]?.tools, 0);
      assert.match(requests[0]?.text ?? "", /keep API names/);
      assert.match(requests[0]?.text ?? "", /c3/);
      assert.deepEqual(events, ["compaction_started", "compaction_completed"]);
      const expected = [
        { role: "user", text: result.summary.text, summary: true },
        { role: "user", text: "third" },
        { role: "assistant", text: "three", calls: [] },
      ];
      assert.match(result.summary.text, /SUMMARY of earlier work/);
      assert.deepEqual(store.messages(s.id), expected);
      store.close();
      store = new SQLiteStore(path);
      assert.deepEqual(store.messages(s.id), expected);
      const persisted = store.db
        .prepare("SELECT type FROM events WHERE session=? ORDER BY seq")
        .all(s.id) as { type: string }[];
      assert.deepEqual(
        persisted.map((e) => e.type),
        ["compaction_started", "compaction_completed"],
      );
      // A session with an unanswered call must never be compacted.
      const pending = store.create(root, "test", "test");
      store.append(pending.id, { role: "user", text: "a" });
      store.append(pending.id, { role: "assistant", text: "", calls: [call("p1")] });
      store.beginCall(pending.id, call("p1"));
      const again = new AgentRunner({
        provider,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
      });
      await assert.rejects(() => again.compact(pending.id), /Uncertain/);
      assert.equal(store.messages(pending.id).length, 2);
    } finally {
      store.close();
    }
  },
  async "auto-compaction"() {
    const store = db(),
      registry = new ToolRegistry();
    registry.register({
      name: "hello",
      effect: "read",
      description: "hello",
      inputSchema: objectSchema({}),
      async execute() {
        return textResult("x".repeat(200));
      },
    });
    let round = 0,
      summaries = 0;
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        if (!request.tools.length) {
          summaries++;
          yield {
            type: "completed",
            message: { role: "assistant", text: "compact summary", calls: [] },
          };
          return;
        }
        round++;
        if (round === 1)
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: "",
              calls: [{ id: `a${round}`, name: "hello", arguments: "{}" }],
            },
            usage: { input: 900, output: 20 },
          };
        else {
          assert.equal(request.messages[0]?.role, "user");
          assert.equal((request.messages[0] as { summary?: boolean }).summary, true);
          yield {
            type: "completed",
            message: { role: "assistant", text: "done", calls: [] },
            usage: { input: 100, output: 5 },
          };
        }
      },
    };
    try {
      const s = store.create(root, "test", "test");
      for (let i = 0; i < 3; i++) {
        store.append(s.id, { role: "user", text: `old ${i} ${"y".repeat(100)}` });
        store.append(s.id, { role: "assistant", text: `old answer ${i}`, calls: [] });
      }
      const events: Array<{ type: string; data: unknown }> = [];
      const runner = new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        contextWindow: () => 1000,
        compaction: { auto: true, threshold: 0.85, keepTurns: 1 },
        onEvent: (e) => events.push({ type: e.type, data: e.data }),
      });
      assert.equal((await runner.run(s.id, "new task")).text, "done");
      assert.equal(summaries, 1);
      const completed = events.find((e) => e.type === "compaction_completed");
      assert.ok(completed);
      assert.equal((completed.data as { reason: string }).reason, "auto");
      const messages = store.messages(s.id);
      assert.equal((messages[0] as { summary?: boolean }).summary, true);
      // The in-flight turn stays intact: its user prompt, call and result survive.
      assert.ok(messages.some((m) => m.role === "user" && m.text === "new task"));
      assert.ok(messages.some((m) => m.role === "tool" && m.callId === "a1"));
      // Unknown window disables automatic compaction.
      const other = store.create(root, "test", "test");
      round = 0;
      summaries = 0;
      const plain = new AgentRunner({
        provider: {
          id: "test",
          model: "test",
          async *stream() {
            yield {
              type: "completed",
              message: { role: "assistant", text: "ok", calls: [] },
              usage: { input: 999_999, output: 1 },
            };
          },
        },
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        compaction: { auto: true },
      });
      await plain.run(other.id, "a");
      await plain.run(other.id, "b");
      assert.equal(summaries, 0);
    } finally {
      store.close();
    }
  },
  async "model-switch"() {
    const path = join(root, "model.sqlite");
    let store = new SQLiteStore(path);
    const seen: Array<string | undefined> = [];
    const provider: ModelProvider = {
      id: "test",
      model: "m1",
      async *stream(request) {
        seen.push(request.model);
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    const make = () =>
      new AgentRunner({
        provider,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        onEvent: (e) => events.push(e),
      });
    const events: Array<{ type: string; data: unknown }> = [];
    try {
      const s = store.create(root, "test", "m1");
      const runner = make();
      await runner.run(s.id, "one");
      runner.setModel(s.id, "m2");
      assert.equal(store.get(s.id).model, "m2");
      await runner.run(s.id, "two");
      assert.deepEqual(seen, ["m1", "m2"]);
      const changed = events.find((e) => e.type === "model_changed");
      assert.deepEqual(changed?.data, { model: "m2", previous: "m1" });
      const turns = events.filter((e) => e.type === "turn_completed");
      assert.equal((turns.at(-1)?.data as { model: string }).model, "m2");
      store.close();
      store = new SQLiteStore(path);
      assert.equal(store.get(s.id).model, "m2");
      await make().run(s.id, "three");
      assert.equal(seen.at(-1), "m2");
      assert.equal(store.messages(s.id).length, 6);
      assert.throws(() => make().setModel(s.id, ""), /model/i);
    } finally {
      store.close();
    }
  },
  async "store-migration"() {
    const path = join(root, "legacy.sqlite");
    const legacy = openDatabase(path);
    legacy.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations VALUES(1);
      CREATE TABLE sessions(id TEXT PRIMARY KEY,workspace TEXT,provider TEXT,model TEXT,locked_pid INTEGER);
      CREATE TABLE messages(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT REFERENCES sessions(id),body TEXT NOT NULL);
      CREATE TABLE tool_calls(session TEXT,call_id TEXT,status TEXT,result TEXT,PRIMARY KEY(session,call_id));
      CREATE TABLE events(seq INTEGER PRIMARY KEY AUTOINCREMENT,session TEXT,run_id TEXT,type TEXT,body TEXT);
      CREATE TABLE plugin_state(plugin TEXT,key TEXT,value TEXT,PRIMARY KEY(plugin,key));
      INSERT INTO sessions VALUES('old','/w','p','m',NULL);
      INSERT INTO messages(session,body) VALUES('old','{"role":"user","text":"legacy"}');`);
    legacy.close();
    for (let i = 0; i < 2; i++) {
      const store = new SQLiteStore(path);
      try {
        assert.deepEqual(store.messages("old"), [{ role: "user", text: "legacy" }]);
        const versions = store.db.prepare("SELECT version FROM schema_migrations").all() as {
          version: number;
        }[];
        assert.deepEqual(
          versions.map((v) => v.version),
          [1, 2, 3],
        );
      } finally {
        store.close();
      }
    }
  },
  async approval() {
    const store = db(),
      registry = new ToolRegistry();
    let writes = 0,
      round = 0;
    registry.register({
      name: "danger",
      effect: "write",
      description: "write",
      inputSchema: objectSchema({}),
      async execute() {
        writes++;
        return textResult("written");
      },
    });
    const asked: string[] = [];
    const answers = ["deny", "session"] as const;
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        // With an approval handler, gated tools are offered to the model.
        assert.equal(request.tools.length, 1);
        round++;
        if (round <= 3)
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: "",
              calls: [{ id: `w${round}`, name: "danger", arguments: "{}" }],
            },
          };
        else yield { type: "completed", message: { role: "assistant", text: "end", calls: [] } };
      },
    };
    try {
      const session = store.create(root, "test", "test");
      await new AgentRunner({
        provider,
        registry,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        approve: async (request) => {
          asked.push(`${request.call.id}:${request.effect}`);
          return answers[asked.length - 1] ?? "deny";
        },
      }).run(session.id, "test");
      // w1 denied, w2 approved for the session, w3 runs without asking.
      assert.deepEqual(asked, ["w1:write", "w2:write"]);
      assert.equal(writes, 2);
      assert.match(JSON.stringify(store.messages(session.id)), /denied by the user/);
    } finally {
      store.close();
    }
  },
  async "memory-store"() {
    let clock = Date.UTC(2026, 0, 1);
    const path = join(root, "memory.sqlite");
    let mem = new SQLiteMemoryStore(path, { now: () => clock });
    const base = { project: "p1", scope: "project" as const };
    try {
      const a = mem.save({
        ...base,
        type: "decision",
        title: "Session storage uses SQLite WAL",
        content: "**What**: WAL mode for sessions",
        topicKey: "decision/sqlite-wal",
        session: "s1",
      });
      assert.equal(a.action, "created");
      clock += 1000;
      const b = mem.save({
        ...base,
        type: "decision",
        title: "Session storage uses SQLite WAL",
        content: "**What**: WAL mode plus busy_timeout",
        topicKey: "decision/sqlite-wal",
        session: "s2",
      });
      assert.deepEqual(b, { id: a.id, action: "updated" });
      const updated = mem.get(a.id, "p1");
      assert.equal(updated?.revisionCount, 2);
      assert.equal(updated?.session, "s2");
      // Same key in another project, or another scope, is an independent row.
      const other = mem.save({
        project: "p2",
        scope: "project",
        type: "decision",
        title: "Other project WAL",
        content: "**What**: unrelated WAL",
        topicKey: "decision/sqlite-wal",
      });
      assert.notEqual(other.id, a.id);
      const personalKey = mem.save({
        ...base,
        scope: "personal",
        type: "decision",
        title: "Personal WAL",
        content: "personal wal",
        topicKey: "decision/sqlite-wal",
      });
      assert.notEqual(personalKey.id, a.id);
      // Exact duplicates (normalized) within the window bump duplicateCount; later ones insert.
      const d1 = mem.save({
        ...base,
        type: "bugfix",
        title: "Fix lock",
        content: "Release  the LOCK in finally",
      });
      const d2 = mem.save({
        ...base,
        type: "bugfix",
        title: "Fix lock",
        content: "release the lock in finally",
      });
      assert.deepEqual(d2, { id: d1.id, action: "duplicate" });
      assert.equal(mem.get(d1.id, "p1")?.duplicateCount, 2);
      clock += 16 * 60_000;
      const d3 = mem.save({
        ...base,
        type: "bugfix",
        title: "Fix lock",
        content: "release the lock in finally",
      });
      assert.equal(d3.action, "created");
      mem.forget(d3.id, "p1", true);
      // Ranking: a strong title match beats a passing mention.
      mem.save({
        ...base,
        type: "discovery",
        title: "Notes",
        content: `Long text ${"filler ".repeat(200)} mentions compaction once`,
      });
      const strong = mem.save({
        ...base,
        type: "pattern",
        title: "Compaction keeps tool pairs",
        content: "compaction never splits calls",
      });
      const hits = mem.search("p1", "compaction", { limit: 5 });
      assert.equal(hits[0]?.id, strong.id);
      assert.ok(hits.every((h) => h.snippet.length <= 301));
      assert.ok(!("content" in (hits[0] as object)));
      // AND by default, any-match on request.
      assert.equal(mem.search("p1", "compaction gardening").length, 0);
      assert.ok(mem.search("p1", "compaction gardening", { mode: "any" }).length >= 2);
      // Scoping: personal memories are visible everywhere; other projects only with allProjects.
      const personal = mem.save({
        project: "p2",
        scope: "personal",
        type: "preference",
        title: "Prefers terse answers",
        content: "User prefers terse answers",
      });
      assert.ok(mem.search("p1", "terse").some((h) => h.id === personal.id));
      assert.ok(!mem.search("p1", "unrelated").some((h) => h.id === other.id));
      assert.ok(
        mem.search("p1", "unrelated", { allProjects: true }).some((h) => h.id === other.id),
      );
      assert.equal(mem.get(other.id, "p1"), undefined);
      assert.deepEqual(mem.count("p1"), { project: 4, personal: 2 });
      // Private blocks are redacted; content is capped with Engram's marker; results bounded.
      const secret = mem.save({
        ...base,
        type: "config",
        title: "Token <private>abc</private>",
        content: "key=<private>s3cr3t</private> set",
      });
      const stored = mem.get(secret.id, "p1");
      assert.equal(stored?.title, "Token [REDACTED]");
      assert.equal(stored?.content, "key=[REDACTED] set");
      assert.ok(
        !JSON.stringify(mem.db.prepare("SELECT * FROM observations").all()).includes("s3cr3t"),
      );
      const big = mem.save({
        ...base,
        type: "learning",
        title: "Big",
        content: "y".repeat(60_000),
      });
      const bigContent = mem.get(big.id, "p1")?.content ?? "";
      assert.ok(bigContent.length <= 50_000 && bigContent.endsWith("... [truncated]"));
      assert.ok(
        mem.search("p1", "compaction wal lock token", { limit: 500, mode: "any" }).length <= 20,
      );
      assert.equal(mem.recent("p1", 2).length, 2);
      // Pin, timeline, summaries, prompts.
      assert.equal(mem.pin(a.id, "p1", true), true);
      assert.deepEqual(
        mem.pinned("p1").map((h) => h.id),
        [a.id],
      );
      mem.save({ ...base, type: "learning", title: "Before", content: "t1", session: "tl" });
      const mid = mem.save({
        ...base,
        type: "learning",
        title: "Middle",
        content: "t2",
        session: "tl",
      });
      mem.save({ ...base, type: "learning", title: "After", content: "t3", session: "tl" });
      assert.deepEqual(
        mem.timeline(mid.id, "p1", 1, 1).map((h) => h.title),
        ["Before", "Middle", "After"],
      );
      mem.recordPrompt("p1", "s1", "first <private>pw</private> prompt");
      assert.equal(mem.recentPrompts("p1")[0]?.content, "first [REDACTED] prompt");
      mem.saveSummary("p1", "s1", "## Goal\nfirst");
      clock += 1000;
      mem.saveSummary("p1", "s2", "## Goal\nsecond");
      assert.match(mem.lastSummary("p1")?.content ?? "", /second/);
      // Soft delete hides the row everywhere; hard delete removes it.
      assert.equal(mem.forget(strong.id, "p1"), true);
      assert.equal(mem.forget(other.id, "p1"), false);
      assert.ok(!mem.search("p1", "compaction").some((h) => h.id === strong.id));
      assert.equal(mem.get(strong.id, "p1"), undefined);
      assert.ok(
        mem.db
          .prepare("SELECT 1 FROM observations WHERE id=? AND deleted_at IS NOT NULL")
          .get(strong.id),
      );
      mem.close();
      mem = new SQLiteMemoryStore(path, { now: () => clock });
      assert.equal(mem.get(a.id, "p1")?.revisionCount, 2);
      assert.ok((mem.get(a.id, "p1")?.accessCount ?? 0) >= 1);
      const id1 = await projectId(root),
        id2 = await projectId(join(root, "."));
      assert.equal(id1, id2);
      assert.match(id1, /^[\w.-]+-[0-9a-f]{8}$/);
    } finally {
      mem.close();
    }
  },
  async "memory-migration"() {
    const path = join(root, "v2.sqlite");
    const sessions = new SQLiteStore(path);
    const s = sessions.create(root, "p", "m");
    sessions.append(s.id, { role: "user", text: "kept" });
    sessions.close();
    for (let i = 0; i < 2; i++) {
      const mem = new SQLiteMemoryStore(path);
      mem.save({
        project: "p",
        scope: "project",
        type: "config",
        title: `t${i}`,
        content: `c${i}`,
      });
      const versions = mem.db
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all() as { version: number }[];
      assert.deepEqual(
        versions.map((v) => v.version),
        [1, 2, 3, 100],
      );
      mem.close();
    }
    const reopened = new SQLiteStore(path);
    try {
      assert.deepEqual(reopened.messages(s.id), [{ role: "user", text: "kept" }]);
    } finally {
      reopened.close();
    }
  },
  async "memory-tools"() {
    const store = db(),
      registry = new ToolRegistry(),
      host = new PluginHost(registry, store);
    const dbPath = join(root, "tools-memory.sqlite");
    await host.activate(
      createMemoryPlugin(
        { dbPath, injectBudgetTokens: 400 },
        { workspace: root, stateHome: root, configDir: root },
      ),
      root,
      { builtin: true },
    );
    const results: string[] = [];
    let round = 0;
    const call = (id: string, name: string, args: unknown) => ({
      id,
      name,
      arguments: JSON.stringify(args),
    });
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        const names = request.tools.map((t) => t.name);
        for (const n of [
          "memory_save",
          "memory_search",
          "memory_get",
          "memory_context",
          "memory_forget",
          "memory_timeline",
          "memory_pin",
        ])
          assert.ok(names.includes(n), `${n} offered unprefixed under a read-only policy`);
        assert.match(request.instructions, /Persistent memory/);
        const last = request.messages.at(-1);
        if (last?.role === "tool") results.push(last.result.content[0]?.text ?? "");
        round++;
        const save = (what: string) =>
          call(`s${round}`, "memory_save", {
            title: "Memory lives in a user-level DB",
            type: "architecture",
            what,
            why: "Persist across sessions",
            where: "src/plugins/builtin/memory/store.ts",
            learned: "FTS5 is enough",
            topic_key: "architecture/memory-location",
          });
        const calls =
          round === 1
            ? [save("user-level sqlite")]
            : round === 2
              ? [save("user-level sqlite, overridable by dbPath")]
              : round === 3
                ? [call("q", "memory_search", { query: "user-level DB" })]
                : round === 4
                  ? [call("g", "memory_get", { id: 1 })]
                  : round === 5
                    ? [call("c", "memory_context", {})]
                    : round === 6
                      ? [call("f", "memory_forget", { id: 1 })]
                      : [];
        yield {
          type: "completed",
          message: { role: "assistant", text: calls.length ? "" : "done", calls },
        };
      },
    };
    try {
      assert.ok(host.commands.has("memory"));
      assert.match(host.status.get("memory:count")?.text ?? "", /^mem 0/);
      const session = store.create(root, "test", "test");
      await new AgentRunner({
        provider,
        registry,
        store,
        context: {
          instructions: async () => (await Promise.all(host.contexts.map((c) => c()))).join("\n"),
          beforePaths: async () => undefined,
        },
        workspace: root,
        extensions: host,
        policy: { write: false, process: false, external: false },
      }).run(session.id, "remember");
      const [created, updated, search, get, context, forget] = results.map((r) => JSON.parse(r));
      assert.deepEqual(created, { id: 1, action: "created" });
      assert.deepEqual(updated, { id: 1, action: "updated" });
      assert.equal(search.results[0].id, 1);
      assert.equal(search.results[0].content, undefined);
      assert.match(get.content, /\*\*Why\*\*: Persist across sessions/);
      assert.equal(get.revisionCount, 2);
      assert.equal(get.session, session.id);
      assert.match(context.context, /#1 \[architecture\] \*\*Memory lives/);
      assert.deepEqual(forget, { forgotten: true });
      assert.equal(await host.commands.get("memory")?.("show 1"), "Memory #1 not found.");
      const mem = new SQLiteMemoryStore(dbPath);
      assert.deepEqual(mem.count(await projectId(root)), { project: 0, personal: 0 });
      mem.close();
    } finally {
      await host.close();
      store.close();
    }
  },
  async "smart-compaction"() {
    const store = db(),
      registry = new ToolRegistry(),
      host = new PluginHost(registry, store);
    const dbPath = join(root, "smart-memory.sqlite"),
      project = await projectId(root);
    const seedStore = new SQLiteMemoryStore(dbPath);
    const seeded = seedStore.save({
      project,
      scope: "project",
      type: "decision",
      title: "API naming",
      content: "**What**: snake_case tool names",
      topicKey: "decision/api-naming",
    });
    seedStore.save({
      project,
      scope: "project",
      type: "discovery",
      title: "Unrelated gardening note",
      content: "tomatoes",
    });
    seedStore.close();
    await host.activate(
      createMemoryPlugin(
        { dbPath, injectBudgetTokens: 350 },
        { workspace: root, stateHome: root, configDir: root },
      ),
      root,
      { builtin: true },
    );
    let reply = "";
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        assert.equal(request.tools.length, 0);
        assert.match(request.instructions, /"observations": array of durable observations/);
        yield { type: "completed", message: { role: "assistant", text: reply, calls: [] } };
      },
    };
    const call = (id: string) => ({ id, name: "hello", arguments: "{}" });
    const tool = (callId: string) =>
      ({ role: "tool", callId, result: textResult(`result ${callId}`) }) as const;
    const seed = () => {
      const s = store.create(root, "test", "test");
      for (const m of [
        { role: "user", text: "first" },
        { role: "assistant", text: "", calls: [call("c1"), call("c2")] },
        tool("c1"),
        tool("c2"),
        { role: "assistant", text: "one", calls: [] },
        { role: "user", text: "latest" },
        { role: "assistant", text: "", calls: [call("c3")] },
        tool("c3"),
        { role: "assistant", text: "three", calls: [] },
      ] as const)
        store.append(s.id, m as never);
      return s.id;
    };
    const events: Array<{ type: string; data: unknown }> = [];
    const runner = new AgentRunner({
      provider,
      registry,
      store,
      context: new ProjectContext(root),
      workspace: root,
      policy: { write: false, process: false, external: false },
      compaction: { keepTurns: 1 },
      extensions: host,
      onEvent: (e) => events.push({ type: e.type, data: e.data }),
    });
    const inspect = () => new SQLiteMemoryStore(dbPath);
    try {
      reply = `\`\`\`json\n${JSON.stringify({
        checkpoint: {
          goal: "Rename the API tools",
          instructions: ["Keep IDs exact"],
          discoveries: ["c1 and c2 read config"],
          accomplished: ["Renamed hello"],
          currentState: "Tests pending",
          nextSteps: ["Update API naming docs"],
          relevantFiles: ["src/tools/standard.ts"],
        },
        observations: [
          {
            title: "API naming",
            type: "decision",
            what: "snake_case tool names, verbs first",
            topic_key: "decision/api-naming",
          },
          {
            title: "Config lives in .alisio",
            type: "config",
            what: "Project config path",
            where: ".alisio/config.json",
          },
        ],
      })}\n\`\`\``;
      const first = seed();
      const result = await runner.compact(first);
      assert.ok(result);
      const text = result.summary.text;
      assert.match(text, /## Goal\nRename the API tools/);
      const recall = text.slice(text.indexOf("[Recovered memory"));
      assert.match(recall, new RegExp(`#${seeded.id} \\[decision\\] \\*\\*API naming`));
      assert.match(recall, /memory_get/);
      assert.ok(estimateTokens(recall) <= 350);
      assert.deepEqual(store.messages(first).slice(1), [
        { role: "user", text: "latest" },
        { role: "assistant", text: "", calls: [call("c3")] },
        tool("c3"),
        { role: "assistant", text: "three", calls: [] },
      ]);
      let mem = inspect();
      assert.equal(mem.get(seeded.id, project)?.revisionCount, 2);
      assert.equal(mem.count(project).project, 3);
      assert.match(
        mem.lastSummary(project)?.content ?? "",
        /## Next steps\n- Update API naming docs/,
      );
      assert.equal(mem.recentPrompts(project)[0]?.content, "first");
      mem.close();
      const done = events.find((e) => e.type === "compaction_completed")?.data as {
        structured: boolean;
        plugins: Record<string, Record<string, unknown>>;
        summarizedTokens: number;
        checkpointTokens: number;
      };
      assert.equal(done.structured, true);
      assert.deepEqual(done.plugins.memory?.memories, { created: 1, updated: 1, duplicate: 0 });
      assert.equal(done.plugins.memory?.archive, "confirmed");
      assert.match(String(done.plugins.memory?.summary), /archive confirmed/);
      assert.ok(done.summarizedTokens > 0 && done.checkpointTokens > 0);
      // Invalid JSON: text-only checkpoint, no memories extracted, pairing still intact.
      reply = "Plain checkpoint text {oops";
      const second = seed();
      const fallback = await runner.compact(second);
      assert.match(fallback?.summary.text ?? "", /Plain checkpoint text/);
      mem = inspect();
      assert.equal(mem.count(project).project, 3);
      assert.match(mem.lastSummary(project)?.content ?? "", /Plain checkpoint text/);
      mem.close();
      assert.equal(store.messages(second).filter((m) => m.role === "tool").length, 1);
      const last = events.filter((e) => e.type === "compaction_completed").at(-1)?.data as {
        structured: boolean;
        plugins: Record<string, Record<string, unknown>>;
      };
      assert.equal(last.structured, false);
      assert.equal(last.plugins.memory?.archive, "confirmed");
    } finally {
      await host.close();
      store.close();
    }
  },
  async "memory-session-start"() {
    const project = await projectId(root);
    const seedPath = join(root, "start-memory.sqlite");
    const seedStore = new SQLiteMemoryStore(seedPath);
    for (let i = 0; i < 30; i++)
      seedStore.save({
        project,
        scope: "project",
        type: "learning",
        title: `Lesson ${i} about builds`,
        content: `detail ${i} ${"z".repeat(300)}`,
      });
    seedStore.saveSummary(project, "old", `## Goal\nShip the TUI\n${"more ".repeat(500)}`);
    seedStore.close();
    const store = db();
    const seen: string[][] = [];
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        seen.push(request.messages.map((m) => (m.role === "user" ? m.text : m.role)));
        yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
      },
    };
    const hostFor = async (dbPath: string) => {
      const host = new PluginHost(new ToolRegistry(), store);
      await host.activate(
        createMemoryPlugin(
          { dbPath, injectBudgetTokens: 300 },
          { workspace: root, stateHome: root, configDir: root },
        ),
        root,
        { builtin: true },
      );
      return host;
    };
    const runnerFor = (host: PluginHost) =>
      new AgentRunner({
        provider,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        extensions: host,
      });
    const host = await hostFor(seedPath);
    const empty = await hostFor(join(root, "empty-memory.sqlite"));
    try {
      const s = store.create(root, "test", "test");
      const runner = runnerFor(host);
      await runner.run(s.id, "hello");
      await runner.run(s.id, "again");
      const messages = store.messages(s.id);
      assert.equal(messages.length, 5);
      const injected = messages[0];
      assert.ok(injected?.role === "user" && injected.summary === true);
      assert.match(injected.text, /### Last Session Summary\n## Goal\nShip the TUI/);
      assert.match(injected.text, /#\d+ \[learning\] \*\*Lesson/);
      assert.ok(estimateTokens(injected.text) <= 300);
      assert.equal(seen[0]?.[1], "hello");
      const t = store.create(root, "test", "test");
      await runnerFor(empty).run(t.id, "hi");
      assert.equal(store.messages(t.id).length, 2);
    } finally {
      await host.close();
      await empty.close();
      store.close();
    }
  },
  async "plugin-hooks"() {
    const registry = new ToolRegistry(),
      store = db(),
      host = new PluginHost(registry, store, { hookTimeoutMs: 200, sessionEndTimeoutMs: 200 });
    const seen: Record<string, unknown> = {};
    const wait = (signal: AbortSignal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          seen.aborted = true;
          resolve();
        });
      });
    const noop = {
      inputSchema: objectSchema({}),
      async execute() {
        return textResult("ok");
      },
    };
    await host.activate(
      {
        id: "good",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.compaction.register({
            async beforeCompact(input) {
              seen.before = input.messages.length;
              return {
                instructions: "Also list notes.",
                outputFields: { notes: "array of strings" },
              };
            },
            async afterCompact(result) {
              seen.extracted = result.extracted;
              seen.goal = result.checkpoint?.goal;
              return { injectContext: "GOOD-INJECT", report: { summary: "good ok" } };
            },
          });
          api.session.onStart(async () => "START-CONTEXT");
          api.session.onEnd(async (info) => {
            seen.end = info.reason;
            seen.completion = await api.model.complete({
              system: "s",
              messages: [{ role: "user", text: "hi" }],
              signal: info.signal,
            });
          });
          api.ui.status("k", "status text", "detail text");
          api.commands.register("hello", async (a) => `hi ${a}`, { description: "Say hi" });
          api.tools.register({
            name: "sneaky",
            description: "claims internal",
            effect: "internal",
            ...noop,
          });
        },
      },
      root,
    );
    await host.activate(
      {
        id: "broken",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.compaction.register({
            async beforeCompact() {
              return { outputFields: { checkpoint: "hijack" } };
            },
            async afterCompact() {
              throw new Error("boom");
            },
          });
        },
      },
      root,
    );
    await host.activate(
      {
        id: "slow",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.compaction.register({
            async afterCompact(input) {
              await wait(input.signal);
              return { injectContext: "LATE" };
            },
          });
          api.session.onEnd(async (info) => wait(info.signal));
        },
      },
      root,
    );
    await host.activate(
      {
        id: "first-party",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.tools.register({ name: "bt", description: "builtin", effect: "internal", ...noop });
          api.commands.register("bt-cmd", async () => "ok");
        },
      },
      root,
      { builtin: true },
    );
    host.setCompleter(async (request) => `completed:${request.messages[0]?.text}`);
    const checkpoint = {
      goal: "G",
      instructions: [],
      discoveries: [],
      accomplished: [],
      currentState: "",
      nextSteps: [],
      relevantFiles: [],
    };
    let instructions = "";
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        instructions = request.instructions;
        const text = request.tools.length ? "ok" : JSON.stringify({ checkpoint, notes: ["n1"] });
        yield { type: "completed", message: { role: "assistant", text, calls: [] } };
      },
    };
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    const runner = new AgentRunner({
      provider,
      registry,
      store,
      context: new ProjectContext(root),
      workspace: root,
      policy: { write: false, process: false, external: false },
      compaction: { keepTurns: 1 },
      extensions: host,
      onEvent: (e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }),
    });
    try {
      // Session start injection, once.
      const s = store.create(root, "test", "test");
      await runner.run(s.id, "one");
      await runner.run(s.id, "two");
      assert.deepEqual(store.messages(s.id)[0], {
        role: "user",
        text: "START-CONTEXT",
        summary: true,
      });
      assert.equal(store.messages(s.id).filter((m) => m.role === "user" && m.summary).length, 1);
      // Compaction: good hook applied; failing and slow hooks isolated; bounded time.
      const started = Date.now();
      const result = await runner.compact(s.id);
      assert.ok(Date.now() - started < 2_000);
      assert.ok(result);
      assert.equal(seen.before, 3);
      assert.deepEqual(seen.extracted, { notes: ["n1"] });
      assert.equal(seen.goal, "G");
      assert.equal(seen.aborted, true);
      assert.match(instructions, /"notes": array of strings/);
      assert.match(instructions, /Also list notes\./);
      assert.doesNotMatch(instructions, /hijack/);
      assert.match(result.summary.text, /## Goal\nG/);
      assert.match(result.summary.text, /GOOD-INJECT/);
      assert.doesNotMatch(result.summary.text, /LATE/);
      const failures = events
        .filter((e) => e.type === "plugin_hook_failed")
        .map((e) => `${e.data.source}:${e.data.hook}:${e.data.error}`);
      assert.equal(failures.length, 3);
      assert.ok(
        failures.some((f) =>
          f.startsWith("broken:beforeCompact:Output field rejected: checkpoint"),
        ),
      );
      assert.ok(failures.some((f) => f === "broken:afterCompact:boom"));
      assert.ok(failures.some((f) => f.startsWith("slow:afterCompact:Timed out after 200ms")));
      const completed = events.find((e) => e.type === "compaction_completed")?.data;
      assert.deepEqual((completed?.plugins as Record<string, unknown>).good, {
        summary: "good ok",
      });
      // Session end: model service available, timeout enforced.
      const endStarted = Date.now();
      const end = await host.sessionEnd({
        sessionId: s.id,
        model: "test",
        workspace: root,
        reason: "exit",
        messages: [],
      });
      assert.ok(Date.now() - endStarted < 1_500);
      assert.equal(seen.end, "exit");
      assert.equal(seen.completion, "completed:hi");
      assert.deepEqual(
        end.failures.map((f) => `${f.source}:${f.hook}`),
        ["slow:sessionEnd"],
      );
      // Naming and trust: external plugins are prefixed and cannot claim `internal`.
      assert.equal(registry.get(`${pluginPrefix("good")}_sneaky`).effect, "external");
      assert.equal(registry.get("bt").effect, "internal");
      assert.ok(host.commands.has("good:hello") && host.commands.has("bt-cmd"));
      assert.equal(host.commandInfo.get("good:hello")?.description, "Say hi");
      assert.deepEqual(host.status.get("good:k"), {
        plugin: "good",
        text: "status text",
        detail: "detail text",
      });
      assert.equal(host.externalCount, 3);
      await host.close();
      assert.equal(host.status.size, 0);
      assert.equal(host.commands.size, 0);
    } finally {
      store.close();
    }
  },
  async "memory-enabled-disabled"() {
    const config = (extra: Record<string, unknown> = {}) => {
      const path = join(root, `config-${crypto.randomUUID()}.json`);
      return writeFile(
        path,
        JSON.stringify({
          provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
          ...extra,
        }),
      ).then(() => path);
    };
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream() {
        yield {
          type: "completed",
          message: { role: "assistant", text: "generic summary", calls: [] },
        };
      },
    };
    const open = async (state: string, file: string, disablePlugins?: string[]) => {
      process.env.ALISIO_STATE_HOME = state;
      return createApplication({
        builtins: BUILTIN_PLUGINS,
        cwd: root,
        config: file,
        provider,
        noHerdr: true,
        readOnly: true,
        db: join(root, `${crypto.randomUUID()}.sqlite`),
        ...(disablePlugins ? { disablePlugins } : {}),
      });
    };
    const memoryTools = (app: Awaited<ReturnType<typeof createApplication>>) =>
      app.registry
        .list()
        .filter((t) => t.name.startsWith("memory_"))
        .map((t) => t.name);
    // Enabled by default, even under --read-only.
    const enabledState = join(root, "state-enabled");
    const enabled = await open(enabledState, await config());
    try {
      assert.equal(memoryTools(enabled).length, 7);
      assert.ok(existsSync(join(enabledState, "memory.sqlite")));
      assert.match(await enabled.context.instructions(), /Persistent memory/);
      assert.ok(enabled.plugins.commands.has("memory"));
      assert.equal(enabled.runner.policy.external, false);
    } finally {
      await enabled.close();
    }
    for (const [label, file, flags] of [
      ["flag", await config(), ["memory"]],
      ["config", await config({ builtinPlugins: { memory: { enabled: false } } }), undefined],
    ] as const) {
      const state = join(root, `state-${label}`);
      const app = await open(state, file, flags ? [...flags] : undefined);
      try {
        assert.deepEqual(memoryTools(app), [], label);
        assert.ok(!existsSync(join(state, "memory.sqlite")), label);
        assert.doesNotMatch(await app.context.instructions(), /Persistent memory/);
        assert.ok(!app.plugins.commands.has("memory"));
        assert.equal(app.plugins.status.size, 0);
        // Compaction still works in generic mode.
        const s = app.store.create(app.workspace, app.provider.id, "test");
        for (const text of ["a", "b", "c"]) {
          app.store.append(s.id, { role: "user", text });
          app.store.append(s.id, { role: "assistant", text: `re ${text}`, calls: [] });
        }
        const result = await app.runner.compact(s.id);
        assert.match(result?.summary.text ?? "", /generic summary/);
        assert.doesNotMatch(result?.summary.text ?? "", /Recovered memory/);
      } finally {
        await app.close();
      }
    }
    await assert.rejects(
      () => open(join(root, "state-bad"), "", ["nope"]),
      /Unknown built-in plugin: nope/,
    );
  },
  async "plugin-package"() {
    const dir = join(root, "node_modules", "alisio-plugin-greeter");
    await mkdir(join(dir, "dist"), { recursive: true });
    await writeFile(
      join(dir, "package.json"),
      JSON.stringify({
        name: "alisio-plugin-greeter",
        version: "1.0.0",
        type: "module",
        keywords: ["alisio-plugin"],
        exports: { ".": { import: "./dist/index.js" } },
      }),
    );
    await writeFile(
      join(dir, "dist", "index.js"),
      'export default {id:"greeter",version:"1.0.0",apiVersion:1,setup(api){api.tools.register({name:"greet",description:"greet",effect:"read",inputSchema:{type:"object",properties:{}},async execute(){return {content:[{type:"text",text:"hi from npm"}]}}});api.commands.register("greet",async()=>"hi",{description:"Greets"})}}',
    );
    const store = db(),
      registry = new ToolRegistry(),
      host = new PluginHost(registry, store);
    try {
      await host.load("alisio-plugin-greeter", { from: join(root, "sub"), globalRoots: [] });
      const tool = registry.get(`${pluginPrefix("greeter")}_greet`);
      assert.match(
        JSON.stringify(
          await tool.execute({}, { signal: signal(), workspace: root, emit: () => {} }),
        ),
        /hi from npm/,
      );
      await assert.rejects(
        () => host.load("alisio-plugin-absent", { from: root, globalRoots: [] }),
        /not found/,
      );
    } finally {
      await host.close();
      store.close();
    }
    // Through configuration: explicit config file lists the package by name.
    const config = join(root, "config.json");
    await writeFile(
      config,
      JSON.stringify({
        provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
        plugins: ["alisio-plugin-greeter"],
      }),
    );
    process.env.ALISIO_STATE_HOME = join(root, "state");
    const app = await createApplication({
      cwd: root,
      config,
      noHerdr: true,
      db: join(root, "app.sqlite"),
      disablePlugins: [],
      provider: { id: "test", model: "test", async *stream() {} },
    });
    try {
      assert.ok(app.plugins.commands.has("greeter:greet"));
      assert.equal(app.plugins.externalCount, 1);
      assert.equal(app.runner.policy.external, true);
    } finally {
      await app.close();
    }
  },
  async "prompt-init"() {
    const project = join(root, "proj");
    await mkdir(join(project, ".git"), { recursive: true });
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "demo", scripts: { test: "vitest run" } }),
    );
    const calls: string[] = [];
    let firstUser = "";
    let round = 0;
    const call = (id: string, name: string, args: unknown) => ({
      id,
      name,
      arguments: JSON.stringify(args),
    });
    const provider = (mode: "create" | "update"): ModelProvider => ({
      id: "test",
      model: "test",
      async *stream(request) {
        const users = request.messages.filter((m) => m.role === "user");
        firstUser = users.at(-1)?.role === "user" ? (users.at(-1) as { text: string }).text : "";
        round++;
        const last = request.messages.at(-1);
        let calls_: ReturnType<typeof call>[] = [];
        if (mode === "create")
          calls_ =
            round === 1
              ? [call("l1", "list_files", {}), call("r1", "read_file", { path: "package.json" })]
              : round === 2
                ? [
                    call("w1", "write_file", {
                      path: "AGENTS.md",
                      content: "# demo\n\n- Test: `vitest run` (from package.json)\n",
                      expectedHash: null,
                    }),
                  ]
                : [];
        else if (round === 1) calls_ = [call("r2", "read_file", { path: "AGENTS.md" })];
        else if (round === 2) {
          const sha = JSON.parse(
            last?.role === "tool" ? (last.result.content[0]?.text ?? "{}") : "{}",
          ).sha256;
          calls_ = [
            call("e1", "edit_file", {
              path: "AGENTS.md",
              oldText: "Human note: keep this.",
              newText: "Human note: keep this.\n\n## Commands\n- `vitest run`",
              expectedHash: sha,
            }),
          ];
        }
        for (const c of calls_) calls.push(c.name);
        yield {
          type: "completed",
          message: {
            role: "assistant",
            text: calls_.length ? "" : "Summary: AGENTS.md updated.",
            calls: calls_,
          },
        };
      },
    });
    const config = join(root, "cfg.json");
    await writeFile(
      config,
      JSON.stringify({
        provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
      }),
    );
    process.env.ALISIO_STATE_HOME = join(root, "state");
    const open = (mode: "create" | "update", extra: Record<string, unknown> = {}) =>
      createApplication({
        cwd: project,
        config,
        noHerdr: true,
        db: join(root, `${crypto.randomUUID()}.sqlite`),
        builtinPrompts: BUILTIN_PROMPTS,
        provider: provider(mode),
        allowWrite: true,
        ...extra,
      });
    // Create: explores, then writes a new AGENTS.md; the prompt is persisted with its display.
    let app = await open("create");
    try {
      const expanded = app.expandPrompt("/init");
      assert.ok(expanded);
      assert.match(expanded.text, /AGENTS\.md/);
      assert.match(expanded.text, /expectedHash/);
      const s = app.store.create(app.workspace, app.provider.id, "test");
      await app.runner.run(s.id, expanded.text, undefined, { display: expanded.display });
      assert.deepEqual(calls, ["list_files", "read_file", "write_file"]);
      assert.match(await readFile(join(project, "AGENTS.md"), "utf8"), /vitest run/);
      assert.equal(firstUser, expanded.text);
      assert.deepEqual(app.store.messages(s.id)[0], {
        role: "user",
        text: expanded.text,
        display: "/init",
      });
    } finally {
      await app.close();
    }
    // Update: reads the existing file and edits it with the current hash (never write_file).
    await writeFile(join(project, "AGENTS.md"), "# demo\n\nHuman note: keep this.\n");
    calls.length = 0;
    round = 0;
    app = await open("update");
    try {
      const expanded = app.expandPrompt("/init focus on tests");
      assert.ok(expanded);
      assert.match(expanded.text, /focus on tests/);
      const s = app.store.create(app.workspace, app.provider.id, "test");
      await app.runner.run(s.id, expanded.text, undefined, { display: expanded.display });
      assert.deepEqual(calls, ["read_file", "edit_file"]);
      const text = await readFile(join(project, "AGENTS.md"), "utf8");
      assert.match(text, /Human note: keep this\./);
      assert.match(text, /## Commands/);
      assert.equal(
        (app.store.messages(s.id)[0] as { display?: string }).display,
        "/init focus on tests",
      );
    } finally {
      await app.close();
    }
    // Requirements: --read-only refuses clearly; headless without write or approvals too.
    app = await open("create", { readOnly: true, allowWrite: false });
    try {
      assert.throws(() => app.expandPrompt("/init"), /--read-only/);
    } finally {
      await app.close();
    }
    app = await open("create", { allowWrite: false });
    try {
      assert.throws(() => app.expandPrompt("/init"), /--allow-write/);
      assert.equal(app.expandPrompt("/not-a-template"), undefined);
    } finally {
      await app.close();
    }
    app = await open("create", { allowWrite: false, approve: async () => "once" });
    try {
      assert.ok(app.expandPrompt("/init"), "approvals make write requirements satisfiable");
    } finally {
      await app.close();
    }
  },
  async "prompt-sources"() {
    const project = join(root, "work");
    await mkdir(join(project, ".alisio", "prompts"), { recursive: true });
    await writeFile(
      join(project, ".alisio", "prompts", "proj.md"),
      "---\ndescription: project prompt\n---\nProject $1",
    );
    const configHome = join(root, "home");
    await mkdir(join(configHome, "prompts"), { recursive: true });
    await writeFile(
      join(configHome, "prompts", "hello.md"),
      "---\ndescription: user prompt\nargument-hint: <name>\n---\nHello $1",
    );
    await writeFile(
      join(configHome, "prompts", "init.md"),
      "---\ndescription: my init\n---\nCustom init",
    );
    await mkdir(join(root, "plugin", "prompts"), { recursive: true });
    await writeFile(
      join(root, "plugin", "prompts", "review.md"),
      "---\ndescription: plugin review\n---\nReview $ARGUMENTS",
    );
    await writeFile(
      join(root, "plugin", "index.mjs"),
      'export default {id:"prompter",version:"1.0.0",apiVersion:1,setup(api){api.resources.prompts("./prompts")}}',
    );
    const config = join(root, "cfg.json");
    await writeFile(
      config,
      JSON.stringify({
        provider: { baseURL: "http://127.0.0.1:9/v1", model: "test", auth: "none" },
      }),
    );
    const previous = process.env.ALISIO_CONFIG_HOME;
    process.env.ALISIO_CONFIG_HOME = configHome;
    process.env.ALISIO_STATE_HOME = join(root, "state");
    const provider: ModelProvider = { id: "test", model: "test", async *stream() {} };
    const open = (trusted: boolean) =>
      createApplication({
        cwd: project,
        ...(trusted ? { config } : {}),
        noHerdr: true,
        db: join(root, `${crypto.randomUUID()}.sqlite`),
        builtinPrompts: BUILTIN_PROMPTS,
        reservedPromptNames: ["help"],
        plugin: [join(root, "plugin", "index.mjs")],
        provider,
      });
    try {
      const trusted = await open(true);
      try {
        const t = trusted.prompts.templates;
        assert.equal(t.get("review")?.source, "plugin");
        assert.equal(t.get("hello")?.argumentHint, "<name>");
        assert.equal(t.get("proj")?.source, "project");
        assert.equal(t.get("init")?.description, "my init");
        assert.ok(
          trusted.prompts.diagnostics.some(
            (d) => d.type === "prompt_override" && d.name === "init" && d.winner === "user",
          ),
        );
        assert.equal(trusted.expandPrompt("/review the parser")?.text, "Review the parser");
      } finally {
        await trusted.close();
      }
      const untrusted = await open(false);
      try {
        assert.equal(untrusted.prompts.templates.has("proj"), false);
        assert.equal(untrusted.prompts.templates.get("review")?.source, "plugin");
      } finally {
        await untrusted.close();
      }
    } finally {
      if (previous === undefined) delete process.env.ALISIO_CONFIG_HOME;
      else process.env.ALISIO_CONFIG_HOME = previous;
    }
  },
  async "token-budget"() {
    // An /init-sized run: 12 exploring turns of ~40k tokens each (480k cumulative).
    const registry = new ToolRegistry();
    registry.register({
      name: "look",
      effect: "read",
      description: "look",
      inputSchema: objectSchema({}),
      async execute() {
        return textResult("seen");
      },
    });
    const make = (maxTokens?: number) => {
      let round = 0;
      const store = db();
      const provider: ModelProvider = {
        id: "test",
        model: "test",
        async *stream() {
          round++;
          yield {
            type: "completed",
            message: {
              role: "assistant",
              text: round > 12 ? "done" : "",
              calls: round > 12 ? [] : [{ id: `l${round}`, name: "look", arguments: "{}" }],
            },
            usage: { input: 39_000, output: 1_000 },
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
        ...(maxTokens ? { maxTokens } : {}),
      });
      return { runner, store };
    };
    const auto = make();
    try {
      const s = auto.store.create(root, "test", "test");
      assert.equal((await auto.runner.run(s.id, "explore")).text, "done");
    } finally {
      auto.store.close();
    }
    const fixed = make(100_000);
    try {
      const s = fixed.store.create(root, "test", "test");
      await assert.rejects(() => fixed.runner.run(s.id, "explore"), /Token budget exhausted/);
    } finally {
      fixed.store.close();
    }
  },
  async attachments() {
    const path = join(root, "attachments.sqlite");
    let store = new SQLiteStore(path);
    const oldImage = {
      kind: "image" as const,
      mimeType: "image/png",
      data: "b2xkLXNlY3JldC1ieXRlcw==",
      bytes: 4000,
      width: 100,
      height: 50,
    };
    const keptImage = {
      kind: "image" as const,
      mimeType: "image/jpeg",
      data: "a2VwdC1zZWNyZXQtYnl0ZXM=",
      bytes: 8192,
      width: 640,
      height: 480,
    };
    let summaryRequestText = "";
    const provider: ModelProvider = {
      id: "test",
      model: "test",
      async *stream(request) {
        summaryRequestText = JSON.stringify(request.messages);
        yield {
          type: "completed",
          message: { role: "assistant", text: "SUMMARY of earlier work", calls: [] },
        };
      },
    };
    try {
      const s = store.create(root, "test", "test");
      store.append(s.id, { role: "user", text: "look at this old one", attachments: [oldImage] });
      store.append(s.id, { role: "assistant", text: "an old reply", calls: [] });
      store.append(s.id, { role: "user", text: "look at this kept one", attachments: [keptImage] });
      const runner = new AgentRunner({
        provider,
        registry: new ToolRegistry(),
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        compaction: { keepTurns: 1 },
      });
      const result = await runner.compact(s.id);
      assert.ok(result);
      // The summarized (discarded) image is described by mime/dimensions only, in the model's
      // own request; its raw base64 never reaches the summarizer or the checkpoint text.
      assert.match(summaryRequestText, /ATTACHMENT: image\/png 100x50, 4000 bytes/);
      assert.doesNotMatch(summaryRequestText, new RegExp(oldImage.data));
      // The checkpoint itself (whatever the model wrote) still never carries raw bytes forward.
      assert.doesNotMatch(result.summary.text, new RegExp(oldImage.data));
      // The kept (recent) message's attachment is untouched: full bytes, still a real turn.
      const kept = store.messages(s.id);
      assert.deepEqual(kept, [
        { role: "user", text: result.summary.text, summary: true },
        { role: "user", text: "look at this kept one", attachments: [keptImage] },
      ]);
      // Resume: closing and reopening the store round-trips the attachment exactly.
      store.close();
      store = new SQLiteStore(path);
      const resumed = store.messages(s.id);
      const resumedUser = resumed[1];
      assert.ok(resumedUser?.role === "user");
      assert.deepEqual(resumedUser?.attachments, [keptImage]);
    } finally {
      store.close();
    }
  },
  async "ask-user-question"() {
    const ctx = (extra?: Record<string, unknown>) => ({
      signal: signal(),
      workspace: root,
      emit: () => {},
      ...extra,
    });
    const questions = [
      {
        header: "Style",
        question: "Which formatting style?",
        options: [{ label: "Tabs" }, { label: "Spaces", recommended: true }, { label: "Mixed" }],
      },
      {
        header: "Tools",
        question: "Which tools should run?",
        multiSelect: true,
        options: [{ label: "Lint" }, { label: "Tests" }],
      },
    ];
    // Headless: no `ui` at all never hangs and fails fast with a guidance message.
    {
      const reg = new ToolRegistry();
      registerStandard(reg, root, new Skills(), new ProjectContext(root));
      const result = await reg.get("ask_user_question").execute({ questions }, ctx());
      assert.equal(result.isError, true);
      assert.match(result.content[0]?.text ?? "", /not interactive|headless/);
    }
    // Headless: `ui.interactive()` returning false also fails fast, never calls askQuestions.
    {
      const reg = new ToolRegistry();
      let called = false;
      registerStandard(reg, root, new Skills(), new ProjectContext(root), {
        interactive: () => false,
        askQuestions: async () => {
          called = true;
          return {};
        },
      });
      const result = await reg.get("ask_user_question").execute({ questions }, ctx());
      assert.equal(result.isError, true);
      assert.equal(called, false);
    }
    // Interactive: the request forwards session/label/signal, and answers map back in array order.
    {
      const reg = new ToolRegistry();
      let captured: unknown;
      registerStandard(reg, root, new Skills(), new ProjectContext(root), {
        interactive: () => true,
        askQuestions: async (request) => {
          captured = request;
          return { q0: "Spaces", q1: ["Lint", "Tests"] };
        },
      });
      const callSignal = signal();
      const result = await reg
        .get("ask_user_question")
        .execute(
          { questions },
          ctx({ session: "child-1", label: "general › explore", signal: callSignal }),
        );
      assert.equal(result.isError, undefined);
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      assert.deepEqual(parsed.answers, [
        { header: "Style", skipped: false, selected: ["Spaces"] },
        { header: "Tools", skipped: false, selected: ["Lint", "Tests"] },
      ]);
      const req = captured as {
        session?: string;
        label?: string;
        signal?: AbortSignal;
        questions: Array<{ id: string; header: string }>;
      };
      assert.equal(req.session, "child-1");
      assert.equal(req.label, "general › explore");
      assert.equal(req.signal, callSignal);
      assert.equal(req.questions[0]?.id, "q0");
    }
    // Skipped question maps to undefined selected, not an empty selection.
    {
      const reg = new ToolRegistry();
      registerStandard(reg, root, new Skills(), new ProjectContext(root), {
        interactive: () => true,
        askQuestions: async () => ({ q0: undefined, q1: [] }),
      });
      const result = await reg.get("ask_user_question").execute({ questions }, ctx());
      const parsed = JSON.parse(result.content[0]?.text ?? "{}");
      assert.deepEqual(parsed.answers, [
        { header: "Style", skipped: true, selected: [] },
        { header: "Tools", skipped: false, selected: [] },
      ]);
    }
    // Schema-level validation (through the registry's ajv-backed parse, like a real tool call).
    {
      const reg = new ToolRegistry();
      registerStandard(reg, root, new Skills(), new ProjectContext(root), {
        interactive: () => true,
        askQuestions: async () => ({}),
      });
      const valid = JSON.stringify({ questions });
      assert.deepEqual(reg.parse("ask_user_question", valid), { questions });
      const tooFew = JSON.stringify({ questions: [] });
      assert.throws(() => reg.parse("ask_user_question", tooFew));
      const fiveQuestions = JSON.stringify({
        questions: Array.from({ length: 5 }, (_, i) => ({
          header: `Q${i}`,
          question: "?",
          options: [{ label: "A" }, { label: "B" }],
        })),
      });
      assert.throws(() => reg.parse("ask_user_question", fiveQuestions));
      const oneOption = JSON.stringify({
        questions: [{ header: "Q", question: "?", options: [{ label: "A" }] }],
      });
      assert.throws(() => reg.parse("ask_user_question", oneOption));
      const fiveOptions = JSON.stringify({
        questions: [
          {
            header: "Q",
            question: "?",
            options: [
              { label: "A" },
              { label: "B" },
              { label: "C" },
              { label: "D" },
              { label: "E" },
            ],
          },
        ],
      });
      assert.throws(() => reg.parse("ask_user_question", fiveOptions));
    }
    // Runtime business-rule validation (beyond what the JSON Schema alone can express).
    {
      const reg = new ToolRegistry();
      registerStandard(reg, root, new Skills(), new ProjectContext(root), {
        interactive: () => true,
        askQuestions: async () => ({}),
      });
      await assert.rejects(
        () =>
          reg.get("ask_user_question").execute(
            {
              questions: [
                {
                  header: "Q",
                  question: "?",
                  options: [
                    { label: "A", recommended: true },
                    { label: "B", recommended: true },
                  ],
                },
              ],
            },
            ctx(),
          ),
        /one option may be recommended/,
      );
      await assert.rejects(
        () =>
          reg.get("ask_user_question").execute(
            {
              questions: [
                { header: "Q", question: "?", options: [{ label: "Same" }, { label: "Same" }] },
              ],
            },
            ctx(),
          ),
        /unique/,
      );
    }
  },
  async webfetch() {
    const server = await serve(async (req) => {
      const url = new URL(req.url);
      if (url.pathname === "/redirect")
        return new Response(null, { status: 302, headers: { Location: "/page" } });
      if (url.pathname === "/page")
        return new Response(
          "<html><head><style>.x{color:red}</style></head><body><h1>Hi</h1><p>World</p></body></html>",
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        );
      if (url.pathname === "/image")
        return new Response(new Uint8Array([137, 80, 78, 71]), {
          headers: { "Content-Type": "image/png" },
        });
      if (url.pathname === "/big")
        return new Response(`${"line of fetched content\n".repeat(1200)}`, {
          headers: { "Content-Type": "text/plain" },
        });
      return new Response("not found", { status: 404 });
    });
    try {
      // Redirect handling + HTML-to-markdown (script/style stripped, headings/paragraphs kept).
      const page = await webfetch(
        root,
        `http://127.0.0.1:${server.port}/redirect`,
        "markdown",
        10,
        signal(),
      );
      assert.match(page.content, /# Hi/);
      assert.match(page.content, /World/);
      assert.doesNotMatch(page.content, /color:red/);
      assert.equal(page.truncated, false);
      // Binary/image content is refused, not returned as garbage.
      await assert.rejects(
        () => webfetch(root, `http://127.0.0.1:${server.port}/image`, "markdown", 10, signal()),
        /textual content/,
      );
      // Non-http(s) schemes are refused outright.
      await assert.rejects(
        () => webfetch(root, "ftp://example.com/file", "text", 10, signal()),
        /http\(s\)/,
      );
      // Size/embedding cap: the result is truncated but the full text is written to a workspace
      // cache file, so it stays retrievable in full (not just the embedded slice).
      const big = await webfetch(root, `http://127.0.0.1:${server.port}/big`, "text", 10, signal());
      assert.equal(big.truncated, true);
      assert.ok(big.fullTextPath);
      const onDisk = await readFile(join(root, big.fullTextPath as string), "utf8");
      assert.equal(onDisk, "line of fetched content\n".repeat(1200));
      assert.ok(onDisk.length > big.content.length);
    } finally {
      await server.close();
    }
  },
  async "webfetch-permission-gate"() {
    // A `read`-only policy (no --allow-external, no approvals) never offers `webfetch` at all.
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const fakeProvider: ModelProvider = {
      id: "fake",
      model: "fake",
      async *stream() {
        throw new Error("must not be called");
        yield undefined as never;
      },
    };
    const store = db();
    try {
      const denied = new AgentRunner({
        provider: fakeProvider,
        registry: reg,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
      });
      assert.equal(
        denied.availableTools().some((t) => t.name === "webfetch"),
        false,
      );
      // With interactive approvals available, an unallowed `external` effect is still OFFERED
      // (approval-eligible), matching write/process instead of a hard, silent exclusion.
      const withApprovals = new AgentRunner({
        provider: fakeProvider,
        registry: reg,
        store,
        context: new ProjectContext(root),
        workspace: root,
        policy: { write: false, process: false, external: false },
        approve: async () => "deny",
      });
      assert.equal(
        withApprovals.availableTools().some((t) => t.name === "webfetch"),
        true,
      );
    } finally {
      store.close();
    }
  },
  async "websearch-searxng-default-chain"() {
    const server = await serve(async (req) => {
      const url = new URL(req.url);
      assert.equal(url.pathname, "/search");
      assert.equal(url.searchParams.get("format"), "json");
      assert.equal(url.searchParams.get("q"), "bun runtime");
      return new Response(
        JSON.stringify({
          results: [{ title: "Bun", url: "https://bun.sh", content: "A fast runtime" }],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    });
    try {
      const outcome = await searchWithFallback(
        "bun runtime",
        { searxngUrl: `http://127.0.0.1:${server.port}` },
        undefined,
        signal(),
      );
      assert.deepEqual(outcome.results, [
        { title: "Bun", url: "https://bun.sh", snippet: "A fast runtime" },
      ]);
      assert.equal(outcome.source, `searxng (http://127.0.0.1:${server.port})`);
      assert.equal(outcome.limitation, undefined);
    } finally {
      await server.close();
    }
  },
  async "websearch-duckduckgo-instant"() {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL) => {
      assert.match(String(input), /api\.duckduckgo\.com/);
      return new Response(
        JSON.stringify({
          Heading: "Bun",
          AbstractText: "Bun is a fast JavaScript runtime",
          AbstractURL: "https://bun.sh",
          RelatedTopics: [],
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const direct = await duckDuckGoInstantProvider().search("bun");
      assert.equal(direct[0]?.title, "Bun");
      const outcome = await searchWithFallback(
        "bun",
        { provider: "duckduckgo-instant" },
        undefined,
        signal(),
      );
      assert.equal(outcome.results[0]?.snippet, "Bun is a fast JavaScript runtime");
      assert.match(outcome.limitation ?? "", /Instant Answer/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
  async "websearch-searxng-ssrf-guard"() {
    assert.throws(() => validateSearxngUrl("ftp://evil.example.com"), /http or https/);
    assert.throws(() => validateSearxngUrl("http://evil.example.com"), /https/);
    assert.doesNotThrow(() => validateSearxngUrl("http://localhost:8080"));
    assert.doesNotThrow(() => validateSearxngUrl("http://127.0.0.1:8080"));
    assert.doesNotThrow(() => validateSearxngUrl("https://evil.example.com"));
  },
  async "websearch-extension-point"() {
    const reg = new ToolRegistry();
    const host = new PluginHost(reg, { getState: () => undefined, setState: () => {} });
    const custom: SearchProvider = {
      id: "custom",
      search: async (q) => [{ title: `custom:${q}`, url: "https://example.com", snippet: "s" }],
    };
    await host.activate(
      {
        id: "acme.search",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.extensions.register("websearch", custom, { priority: 10 });
        },
      },
      root,
    );
    const outcome = await searchWithFallback(
      "q",
      undefined,
      () => host.extensions.resolve("websearch"),
      signal(),
    );
    assert.equal(outcome.results[0]?.title, "custom:q");
    assert.equal(outcome.source, "plugin:acme.search");
    // Disposal restores the built-in chain (there is nothing left to resolve).
    await host.close();
    assert.equal(host.extensions.resolve("websearch"), undefined);
  },
  async "websearch-extension-point-broken-provider-falls-back"() {
    const reg = new ToolRegistry();
    const host = new PluginHost(reg, { getState: () => undefined, setState: () => {} });
    const broken: SearchProvider = {
      id: "broken",
      async search() {
        throw new Error("boom");
      },
    };
    await host.activate(
      {
        id: "acme.broken",
        version: "1.0.0",
        apiVersion: 1,
        setup(api) {
          api.extensions.register("websearch", broken);
        },
      },
      root,
    );
    const server = await serve(
      async () =>
        new Response(
          JSON.stringify({ results: [{ title: "fallback", url: "https://x", content: "s" }] }),
          {
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    try {
      const outcome = await searchWithFallback(
        "q",
        { searxngUrl: `http://127.0.0.1:${server.port}` },
        () => host.extensions.resolve("websearch"),
        signal(),
      );
      assert.equal(outcome.results[0]?.title, "fallback");
      assert.match(outcome.diagnostic ?? "", /acme\.broken/);
    } finally {
      await server.close();
    }
  },
  async "execute-basic"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await writeFile(join(root, "note.txt"), "hello world");
    const result = await runExecute(
      `const r = await callTool("read_file", { path: "note.txt" });
       return r.content;`,
      {
        registry: reg,
        policy: { write: false, process: false, external: false },
        workspace: root,
        signal: signal(),
        emit: () => {},
      },
    );
    assert.match(String(result), /hello world/);
  },
  async "execute-denied-effect"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await assert.rejects(
      () =>
        runExecute(
          `return await callTool("write_file", { path: "x.txt", content: "y", expectedHash: null });`,
          {
            registry: reg,
            policy: { write: false, process: false, external: false },
            workspace: root,
            signal: signal(),
            emit: () => {},
          },
        ),
      /capability denied/i,
    );
    assert.equal(existsSync(join(root, "x.txt")), false);
  },
  async "execute-allowed-when-policy-grants-it"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const result = await runExecute(
      `await callTool("write_file", { path: "granted.txt", content: "ok", expectedHash: null });
       return "done";`,
      {
        registry: reg,
        policy: { write: true, process: false, external: false },
        workspace: root,
        signal: signal(),
        emit: () => {},
      },
    );
    assert.equal(result, "done");
    assert.equal(await readFile(join(root, "granted.txt"), "utf8"), "ok");
  },
  async "execute-timeout"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await assert.rejects(
      () =>
        runExecute(`await new Promise(() => {}); return 1;`, {
          registry: reg,
          policy: { write: false, process: false, external: false },
          workspace: root,
          signal: signal(),
          emit: () => {},
          timeoutMs: 150,
        }),
      /timed out|exceeded/i,
    );
  },
  async "execute-call-count-bound"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await writeFile(join(root, "note.txt"), "x");
    await assert.rejects(
      () =>
        runExecute(
          `for (let i = 0; i < 25; i++) { await callTool("read_file", { path: "note.txt" }); }
           return "done";`,
          {
            registry: reg,
            policy: { write: false, process: false, external: false },
            workspace: root,
            signal: signal(),
            emit: () => {},
          },
        ),
      /exceeded the limit/,
    );
  },
  async "execute-cannot-call-itself"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    await assert.rejects(
      () =>
        runExecute(`return await callTool("execute", { code: "return 1" });`, {
          registry: reg,
          policy: { write: false, process: false, external: false },
          workspace: root,
          signal: signal(),
          emit: () => {},
        }),
      /cannot call itself/,
    );
  },
  async "execute-no-direct-fs-or-network"() {
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    // Returned as a JSON string (a primitive) rather than an object: an object literal built
    // inside the vm sandbox belongs to that separate realm's own Object.prototype, which a
    // cross-realm deepEqual would (rightly) refuse to treat as identical to a host-realm object —
    // itself a real, positive proof of the isolation this test is trying to demonstrate.
    const result = await runExecute(
      `return JSON.stringify({
         hasRequire: typeof require,
         hasProcess: typeof process,
         hasFetch: typeof fetch,
         hasSetTimeout: typeof setTimeout,
       });`,
      {
        registry: reg,
        policy: { write: false, process: false, external: false },
        workspace: root,
        signal: signal(),
        emit: () => {},
      },
    );
    assert.deepEqual(JSON.parse(String(result)), {
      hasRequire: "undefined",
      hasProcess: "undefined",
      hasFetch: "undefined",
      hasSetTimeout: "undefined",
    });
  },
  async "project-trust"() {
    const previousStateHome = process.env.ALISIO_STATE_HOME;
    process.env.ALISIO_STATE_HOME = join(root, "state");
    try {
      const bare = join(root, "bare");
      await mkdir(bare, { recursive: true });
      // Nothing to trust: no project resources at all.
      assert.equal(await hasProjectResources(bare), false);
      const bareResolution = await resolveTrust(bare);
      assert.deepEqual(bareResolution, {
        trusted: false,
        hasProjectResources: false,
        needsPrompt: false,
        configHash: null,
      });

      const withConfig = join(root, "with-config");
      await mkdir(join(withConfig, ".alisio"), { recursive: true });
      await writeFile(join(withConfig, ".alisio", "config.json"), JSON.stringify({ a: 1 }));
      assert.equal(await hasProjectResources(withConfig), true);
      const hash1 = await hashProjectConfig(withConfig);
      assert.equal(typeof hash1, "string");

      // Fresh: needs a prompt (nothing stored yet).
      const fresh = await resolveTrust(withConfig);
      assert.equal(fresh.needsPrompt, true);
      assert.equal(fresh.trusted, false);

      // Store a "trusted" decision; it should now resolve without prompting.
      await setTrust(withConfig, true, hash1);
      const afterTrust = await resolveTrust(withConfig);
      assert.deepEqual(afterTrust, {
        trusted: true,
        hasProjectResources: true,
        needsPrompt: false,
        configHash: hash1,
      });
      const stored = await getTrust(withConfig);
      assert.equal(stored?.trusted, true);
      assert.equal(stored?.configHash, hash1);

      // Changing the config content must force a re-prompt, never silently keep trusting it.
      await writeFile(join(withConfig, ".alisio", "config.json"), JSON.stringify({ a: 2 }));
      const afterChange = await resolveTrust(withConfig);
      assert.equal(afterChange.needsPrompt, true);
      assert.equal(afterChange.trusted, false);
      assert.notEqual(afterChange.configHash, hash1);

      // Re-confirm trust for the new content; resolves cleanly again.
      const hash2 = await hashProjectConfig(withConfig);
      await setTrust(withConfig, true, hash2);
      assert.equal((await resolveTrust(withConfig)).needsPrompt, false);

      // A declined project (e.g. via a resource other than config.json) never re-prompts either.
      const declinedWorkspace = join(root, "declined");
      await mkdir(join(declinedWorkspace, ".alisio", "agents"), { recursive: true });
      assert.equal(await hasProjectResources(declinedWorkspace), true);
      await setTrust(declinedWorkspace, false, await hashProjectConfig(declinedWorkspace));
      const declined = await resolveTrust(declinedWorkspace);
      assert.equal(declined.needsPrompt, false);
      assert.equal(declined.trusted, false);

      // list/revoke.
      const listed = await listTrust();
      assert.ok(listed.some((e) => e.workspace === withConfig && e.trusted === true));
      assert.ok(listed.some((e) => e.workspace === declinedWorkspace && e.trusted === false));
      assert.equal(await revokeTrust(withConfig), true);
      assert.equal(await getTrust(withConfig), undefined);
      assert.equal(await revokeTrust(withConfig), false); // already gone
      // Revoking makes it need a prompt again (exactly like a fresh, never-decided workspace).
      assert.equal((await resolveTrust(withConfig)).needsPrompt, true);
    } finally {
      if (previousStateHome === undefined) delete process.env.ALISIO_STATE_HOME;
      else process.env.ALISIO_STATE_HOME = previousStateHome;
    }
  },
  async "permission-truth-table"() {
    // Exercises the full write/process/external truth table end to end (not just
    // `availableTools()`): flag absent + not read-only -> offered and asked each call; flag
    // present -> allowed without asking; --read-only -> never offered, hard denied.
    const reg = new ToolRegistry();
    registerStandard(reg, root, new Skills(), new ProjectContext(root));
    const store = db();
    const cases: Array<{
      tool: string;
      effect: "write" | "process" | "external";
      input: Record<string, unknown>;
    }> = [
      {
        tool: "write_file",
        effect: "write",
        input: { path: "a.txt", content: "x", expectedHash: null },
      },
      {
        tool: "run_process",
        effect: "process",
        input: { command: process.execPath, args: ["-e", "1"] },
      },
      { tool: "webfetch", effect: "external", input: { url: "http://127.0.0.1:1/unreachable" } },
    ];
    const providerFor = (toolCase: (typeof cases)[number]): ModelProvider => {
      let answered = false;
      return {
        id: "fake",
        model: "fake",
        async *stream() {
          if (!answered) {
            answered = true;
            yield {
              type: "completed",
              message: {
                role: "assistant",
                text: "",
                calls: [
                  { id: "c1", name: toolCase.tool, arguments: JSON.stringify(toolCase.input) },
                ],
              },
            };
          } else {
            yield {
              type: "completed",
              message: { role: "assistant", text: "done", calls: [] },
            };
          }
        },
      };
    };
    try {
      for (const toolCase of cases) {
        // 1) Flag absent, not read-only, WITH an approve handler (matches the TUI's own
        //    unconditional approve wiring): offered, and the handler is actually asked.
        let asked = false;
        const session1 = store.create(root, "fake", "fake").id;
        const askRunner = new AgentRunner({
          provider: providerFor(toolCase),
          registry: reg,
          store,
          context: new ProjectContext(root),
          workspace: root,
          policy: { write: false, process: false, external: false },
          approve: async (request) => {
            asked = true;
            assert.equal(request.effect, toolCase.effect);
            return "deny";
          },
        });
        await askRunner.run(session1, "go", signal());
        assert.equal(asked, true, `${toolCase.tool}: approve handler must be asked`);
        const messages1 = store.messages(session1);
        const toolResult = messages1.find((m) => m.role === "tool");
        assert.ok(toolResult?.role === "tool");
        assert.match(JSON.stringify(toolResult?.result), /denied by the user/);

        // 2) Flag present: allowed outright, never asks.
        let askedWhenAllowed = false;
        const session2 = store.create(root, "fake", "fake").id;
        const allowRunner = new AgentRunner({
          provider: providerFor(toolCase),
          registry: reg,
          store,
          context: new ProjectContext(root),
          workspace: root,
          policy: {
            write: toolCase.effect === "write",
            process: toolCase.effect === "process",
            external: toolCase.effect === "external",
          },
          approve: async () => {
            askedWhenAllowed = true;
            return "deny";
          },
        });
        await allowRunner.run(session2, "go", signal());
        assert.equal(askedWhenAllowed, false, `${toolCase.tool}: an allowed effect must not ask`);

        // 3) --read-only equivalent: no approve handler at all, policy false -> hard denial,
        //    never offered to the model in the first place.
        const readOnlyRunner = new AgentRunner({
          provider: providerFor(toolCase),
          registry: reg,
          store,
          context: new ProjectContext(root),
          workspace: root,
          policy: { write: false, process: false, external: false },
        });
        assert.equal(
          readOnlyRunner.availableTools().some((t) => t.name === toolCase.tool),
          false,
          `${toolCase.tool}: must not be offered under --read-only`,
        );
      }
    } finally {
      store.close();
    }
  },
};
export const scenarioNames = Object.keys(fixtures);
/** Runs one scenario with a fresh temporary root (in-process under Node or Bun). */
export async function runScenario(name: string): Promise<{ scenario: string; ok: boolean }> {
  const fixture = fixtures[name];
  if (!fixture) throw new Error(`Unknown scenario ${name}`);
  root = await mkdtemp(join(tmpdir(), "alisio-test-"));
  try {
    await fixture();
    return { scenario: name, ok: true };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
if (isMain(import.meta.url)) console.log(JSON.stringify(await runScenario(process.argv[2] ?? "")));
