/**
 * `artifact_read` (bounded text, truncation marked) and `artifact_export` (a copy into the
 * workspace through the `write` gate, confined to it), plus `runToolCall`: a run without a
 * model that executes one tool call with the same gates and leaves a valid transcript.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, RunEvent } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalRequest, createApplication } from "../packages/core/src/index.ts";

let root: string;
let workspace: string;
let db: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-art-tools-"));
  workspace = join(root, "ws");
  await mkdir(workspace);
  db = join(root, "state", "sessions.sqlite");
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};

async function app(options: Parameters<typeof createApplication>[0] = {}) {
  const events: RunEvent[] = [];
  const created = await createApplication({
    cwd: workspace,
    db,
    noHerdr: true,
    python: join(root, "no-python"),
    provider: silent,
    onEvent: (event) => events.push(event),
    ...options,
  });
  apps.push(created);
  return Object.assign(created, { events });
}

type App = Awaited<ReturnType<typeof app>>;
const owner = (a: App, sessionId: string) => ({
  sessionId,
  rootSessionId: sessionId,
  workspace: a.workspace,
});
const text = (result: { content: Array<{ type: string; text?: string }> }) =>
  result.content.map((p) => (p.type === "text" ? p.text : "")).join("");

describe("artifact_read", () => {
  it("reads a text artifact, truncates at maxBytes with a marker and scopes to the session", async () => {
    const a = await app();
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const other = a.store.create(a.workspace, "fake", "fake-model").id;
    const { artifact } = await a.artifacts.publishText(
      { fileName: "notes.md", text: `# Notes\n${"x".repeat(5000)}` },
      owner(a, session),
    );
    const full = await a.runner.runToolCall(session, "artifact_read", { id: artifact.id });
    expect(full.result.isError).toBeFalsy();
    expect(text(full.result)).toContain("# Notes");
    expect(text(full.result)).not.toContain("truncated");

    const cut = await a.runner.runToolCall(session, "artifact_read", {
      id: artifact.id,
      maxBytes: 100,
    });
    expect(text(cut.result)).toMatch(/truncated: showing 100 of 5008 bytes/);

    const foreign = await a.runner.runToolCall(other, "artifact_read", { id: artifact.id });
    expect(foreign.result.isError).toBe(true);
    expect(text(foreign.result)).toMatch(/not found/i);
  });

  it("reads one file of a multi-file artifact and refuses binary files", async () => {
    const a = await app();
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const staging = join(root, "staging");
    await mkdir(join(staging, "site"), { recursive: true });
    await writeFile(join(staging, "site", "index.html"), "<h1>Hi</h1>");
    await writeFile(join(staging, "site", "data.js"), "window.data = [1, 2]");
    await writeFile(
      join(staging, "chart.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0]),
    );
    const published = await a.artifacts.publishOutputs(staging, owner(a, session));
    const site = published.find((p) => p.artifact.kind === "dashboard")?.artifact.id ?? "";
    const png = published.find((p) => p.artifact.fileName === "chart.png")?.artifact.id ?? "";

    const entry = await a.runner.runToolCall(session, "artifact_read", { id: site });
    expect(text(entry.result)).toContain("<h1>Hi</h1>");
    const asset = await a.runner.runToolCall(session, "artifact_read", {
      id: site,
      path: "data.js",
    });
    expect(text(asset.result)).toContain("window.data");
    const missing = await a.runner.runToolCall(session, "artifact_read", {
      id: site,
      path: "../manifest.json",
    });
    expect(missing.result.isError).toBe(true);
    const binary = await a.runner.runToolCall(session, "artifact_read", { id: png });
    expect(binary.result.isError).toBe(true);
    expect(text(binary.result)).toMatch(/not a text file/i);
  });
});

describe("artifact_export through runToolCall", () => {
  it("asks for write without --allow-write, copies into the workspace and journals a run", async () => {
    const approve = vi.fn(async (_request: ApprovalRequest) => "once" as const);
    const a = await app({ approve });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const { artifact } = await a.artifacts.publishText(
      { fileName: "summary.md", text: "# Summary\n" },
      owner(a, session),
    );
    const outcome = await a.runner.runToolCall(
      session,
      "artifact_export",
      { id: artifact.id, target: "reports\\q3" },
      { display: "Copy summary.md to the workspace" },
    );
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({ effect: "write" });
    expect(outcome.status).toBe("completed");
    expect(await readFile(join(workspace, "reports", "q3", "summary.md"), "utf8")).toBe(
      "# Summary\n",
    );
    expect(text(outcome.result)).toContain("reports/q3/summary.md");

    // A run without a model: run_started → tool_* → run_completed, in that order.
    const types = a.events.filter((e) => e.runId === outcome.runId).map((e) => e.type);
    expect(types).toEqual([
      "run_started",
      "tool_started",
      "approval_requested",
      "approval_resolved",
      "tool_completed",
      "run_completed",
    ]);
    // The transcript stays valid for any provider: user → assistant(call) → tool → assistant.
    const messages = a.store.messages(session);
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
    const call = messages[1]?.role === "assistant" ? messages[1].calls[0] : undefined;
    expect(call).toMatchObject({ name: "artifact_export" });
    expect(messages[2]).toMatchObject({ role: "tool", callId: call?.id });
    expect(messages[0]).toMatchObject({ display: "Copy summary.md to the workspace" });
  });

  it("does not ask with --allow-write, refuses to overwrite and stays inside the workspace", async () => {
    const approve = vi.fn(async () => "deny" as const);
    const a = await app({ allowWrite: true, approve });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const { artifact } = await a.artifacts.publishText(
      { fileName: "data.json", text: '{"a":1}' },
      owner(a, session),
    );
    const first = await a.runner.runToolCall(session, "artifact_export", {
      id: artifact.id,
      target: ".",
    });
    expect(first.result.isError).toBeFalsy();
    expect(approve).not.toHaveBeenCalled();
    const again = await a.runner.runToolCall(session, "artifact_export", {
      id: artifact.id,
      target: ".",
    });
    expect(again.result.isError).toBe(true);
    expect(text(again.result)).toMatch(/already exists/);
    const forced = await a.runner.runToolCall(session, "artifact_export", {
      id: artifact.id,
      target: "",
      overwrite: true,
    });
    expect(forced.result.isError).toBeFalsy();
    for (const target of ["../outside", join(root, "elsewhere")]) {
      const escaped = await a.runner.runToolCall(session, "artifact_export", {
        id: artifact.id,
        target,
      });
      expect(escaped.result.isError).toBe(true);
    }
    await expect(readFile(join(root, "outside", "data.json"))).rejects.toThrow();
    await expect(readFile(join(root, "elsewhere", "data.json"))).rejects.toThrow();
  });

  it("copies a multi-file dashboard into a folder named after it", async () => {
    const a = await app({ allowWrite: true });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const staging = join(root, "staging");
    await mkdir(join(staging, "sales", "assets"), { recursive: true });
    await writeFile(join(staging, "sales", "index.html"), "<p>x</p>");
    await writeFile(join(staging, "sales", "assets", "app.js"), "1");
    const [published] = await a.artifacts.publishOutputs(staging, owner(a, session));
    const outcome = await a.runner.runToolCall(session, "artifact_export", {
      id: published?.artifact.id,
      target: "out",
    });
    expect(outcome.result.isError).toBeFalsy();
    expect(await readFile(join(workspace, "out", "sales", "assets", "app.js"), "utf8")).toBe("1");
    expect(text(outcome.result)).toContain("out/sales/index.html");
  });

  it("a denied approval writes nothing and --read-only has no artifact tools", async () => {
    const a = await app({ approve: async () => "deny" as const });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    const { artifact } = await a.artifacts.publishText(
      { fileName: "r.md", text: "r" },
      owner(a, session),
    );
    const denied = await a.runner.runToolCall(session, "artifact_export", {
      id: artifact.id,
      target: ".",
    });
    expect(denied.result.isError).toBe(true);
    await expect(readFile(join(workspace, "r.md"))).rejects.toThrow();
    await a.close();
    apps.length = 0;
    const readOnly = await app({ readOnly: true });
    const names = readOnly.registry.list().map((t) => t.name);
    expect(names).not.toContain("artifact_export");
    expect(names).not.toContain("artifact_read");
  });
});
