/**
 * Phase 3a wiring of Forja in the Application: executions of a dead process are closed when the
 * store opens, the services are ready for the engines, the scratchpad is an authorized write root
 * only while the JavaScript engine is enabled, and with it off nothing user-visible changes.
 */
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { SqliteExecutionJournal } from "../packages/core/src/forge/journal.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-forge-app-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};
const db = () => join(root, "state", "sessions.sqlite");

async function app(options: Parameters<typeof createApplication>[0] = {}) {
  const created = await createApplication({
    cwd: workspace,
    db: db(),
    noHerdr: true,
    provider: silent,
    ...options,
  });
  apps.push(created);
  return created;
}
const enableForge = () =>
  writeFile(
    join(root, "config", "config.json"),
    JSON.stringify({
      forge: { javascript: { enabled: true }, scratch: { root: join(root, "tmp") } },
    }),
  );

describe("restart reconciliation", () => {
  it("closes the executions of a process that is gone when the application opens", async () => {
    await mkdir(join(root, "state"), { recursive: true });
    const store = new SQLiteStore(db());
    const journal = new SqliteExecutionJournal(store.db, { ownerPid: 2 ** 22 + 12_345 });
    journal.open({
      id: "exec_stale",
      rootSessionId: "root-1",
      sessionId: "root-1",
      toolCallId: "call-1",
      engine: "javascript-quickjs",
      isolation: "wasm-isolate",
      selectionReason: "language",
      codeSha256: "a".repeat(64),
    });
    store.close();
    const a = await app();
    expect(a.forge.journal.get("exec_stale")).toMatchObject({
      status: "failed",
      errorCode: "ISOLATE_FAILURE",
      metrics: { reason: "interrupted" },
    });
  });
});

describe("Forja services", () => {
  it("offers the journal and the state store to the engines", async () => {
    const a = await app();
    expect(a.forge.journal).toBeInstanceOf(SqliteExecutionJournal);
    expect(a.forge.state.snapshot("root-1")).toEqual({ values: {}, revisions: {} });
  });

  it("runs the scratch retention sweep next to the analysis one", async () => {
    const a = await app({ analysisSweepDelayMs: 10_000_000 });
    expect(a.forge.scratchJanitor.sweep).toBeTypeOf("function");
    const report = await a.forge.scratchJanitor.sweep({ force: true });
    expect(report).toEqual({ sessionsDeleted: 0, bytesFreed: 0, errors: 0 });
  });
});

describe("scratchpad as a write root", () => {
  /** Runs write_file for `path` in ask mode and reports which approvals were requested. */
  async function writeInAskMode(a: Awaited<ReturnType<typeof app>>, path: string) {
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    await a.runner.runToolCall(session, "write_file", {
      path,
      content: "console.log(1)",
      expectedHash: null,
    });
    return session;
  }

  it("with the JavaScript engine off, offers no scratchpad and asks like before", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({ forge: { javascript: { enabled: false } } }),
    );
    const effects: string[] = [];
    const dirs: string[] = [];
    const a = await app({
      approve: async (request: ApprovalRequest) => {
        effects.push(request.effect);
        return "once";
      },
      approveExternalDirectory: async (request) => {
        dirs.push(request.path);
        return "once";
      },
    });
    expect(a.forge.scratchpad).toBeUndefined();
    const target = join(root, "tmp", "off", "plan.js");
    await mkdir(join(root, "tmp", "off"), { recursive: true });
    await writeInAskMode(a, target);
    expect(dirs).toEqual([target]);
    expect(effects).toEqual(["write"]);
  });

  it("with it on, a write in the root session's scratchpad asks for nothing", async () => {
    await enableForge();
    const effects: string[] = [];
    const dirs: string[] = [];
    const a = await app({
      approve: async (request: ApprovalRequest) => {
        effects.push(request.effect);
        return "once";
      },
      approveExternalDirectory: async (request) => {
        dirs.push(request.path);
        return "once";
      },
    });
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const pad = await a.forge.scratchpad?.(session);
    expect(pad?.startsWith(join(root, "tmp"))).toBe(true);
    expect((await stat(pad ?? "")).mode & 0o077).toBe(0);
    const file = join(pad ?? "", "plan.js");
    await a.runner.runToolCall(session, "write_file", {
      path: file,
      content: "console.log(1)",
      expectedHash: null,
    });
    expect(await readFile(file, "utf8")).toBe("console.log(1)");
    expect(effects).toEqual([]);
    expect(dirs).toEqual([]);
    // Another folder outside the roots is as before.
    const other = join(root, "elsewhere");
    await mkdir(other);
    await writeInAskMode(a, join(other, "x.js"));
    expect(dirs).toEqual([join(other, "x.js")]);
    expect(effects).toEqual(["write"]);
  });

  it("gives a child session the scratchpad of its root session", async () => {
    await enableForge();
    const a = await app();
    const rootId = a.store.create(workspace, "fake-provider", "fake-model").id;
    const child = a.store.createChild({
      parentId: rootId,
      workspace,
      provider: "fake-provider",
      model: "fake-model",
      agent: "general",
      title: "child",
      depth: 1,
      options: {},
    });
    expect(await a.forge.scratchpad?.(child.id)).toBe(await a.forge.scratchpad?.(rootId));
  });
});
