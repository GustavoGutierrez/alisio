/**
 * The capability matrix of `analysis.run` (python_run) through a real Application: tool
 * availability per mode, persisted "allow for this session" grants across restarts, revocation,
 * deny without side effects, and no widening of the `process` effect.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ApprovalRequest, createApplication } from "../packages/core/src/index.ts";

let root: string;
let workspace: string;
let db: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-caps-"));
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

/** Each run calls the queued tools (one per turn), then answers "done". */
function provider(
  calls: Array<{ name: string; args: Record<string, unknown> }>,
  prefix = "c",
): ModelProvider {
  let n = 0;
  return {
    id: "fake",
    model: "fake-model",
    async *stream(): AsyncGenerator<ProviderEvent> {
      const next = calls.shift();
      if (!next) {
        yield { type: "completed", message: { role: "assistant", text: "done", calls: [] } };
        return;
      }
      n++;
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: "",
          calls: [{ id: `${prefix}${n}`, name: next.name, arguments: JSON.stringify(next.args) }],
        },
      };
    },
  };
}
const python = { name: "python_run", args: { code: "print(1)" } };

async function app(
  options: Parameters<typeof createApplication>[0] & {
    queue?: Array<{ name: string; args: Record<string, unknown> }>;
    prefix?: string;
  } = {},
) {
  const { queue, prefix, ...rest } = options;
  const created = await createApplication({
    cwd: workspace,
    db,
    noHerdr: true,
    // A missing --python answers runtime_unavailable without launching anything.
    python: join(root, "no-python"),
    provider: provider(queue ?? [], prefix),
    ...rest,
  });
  apps.push(created);
  return created;
}
const toolNames = (a: Awaited<ReturnType<typeof app>>, sessionId?: string) =>
  a.runner.availableTools({}, sessionId).map((t) => t.name);
const executions = (a: Awaited<ReturnType<typeof app>>) =>
  a.store.db.prepare("SELECT count(*) AS n FROM analysis_executions").get() as { n: number };
const toolResult = (a: Awaited<ReturnType<typeof app>>, session: string, call: string) =>
  a.store
    .callResult(session, call)
    ?.content.map((p) => (p.type === "text" ? p.text : ""))
    .join("");

describe("analysis.run capability matrix", () => {
  it("--read-only registers no analysis tool at all", async () => {
    const a = await app({ readOnly: true, allowAnalysis: true });
    const names = a.registry.list().map((t) => t.name);
    expect(names).not.toContain("python_run");
    expect(names).not.toContain("artifact_create");
  });

  it("analysis.enabled=false registers nothing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({ analysis: { enabled: false } }),
    );
    const a = await app({ allowAnalysis: true });
    expect(a.registry.list().map((t) => t.name)).not.toContain("python_run");
  });

  it("headless without a flag or grant does not offer python_run; --allow-analysis does (and not shell)", async () => {
    const headless = await app();
    const session = headless.store.create(headless.workspace, "fake", "fake-model");
    expect(toolNames(headless, session.id)).not.toContain("python_run");
    expect(toolNames(headless, session.id)).toEqual(
      expect.arrayContaining(["artifact_create", "artifact_list"]),
    );
    await headless.close();
    apps.length = 0;
    const flagged = await app({ allowAnalysis: true });
    expect(toolNames(flagged)).toContain("python_run");
    expect(toolNames(flagged)).not.toContain("shell");
  });

  it("--allow-analysis runs without asking and audits a flag decision", async () => {
    const approve = vi.fn(async () => "deny" as const);
    const a = await app({ allowAnalysis: true, approve, queue: [python] });
    const session = a.store.create(a.workspace, "fake", "fake-model");
    await a.runner.run(session.id, "go");
    expect(approve).not.toHaveBeenCalled();
    expect(toolResult(a, session.id, "c1")).toMatch(/^runtime_unavailable/);
    expect(a.capabilityGrants.list(session.id)).toEqual([
      expect.objectContaining({ source: "flag", scope: "once", decision: "allow" }),
    ]);
  });

  it("a session grant persists across a restart (headless resume), and revoking asks again", async () => {
    const approve = vi.fn(async (_request: ApprovalRequest) => "session" as const);
    const first = await app({ approve, queue: [python] });
    const session = first.store.create(first.workspace, "fake", "fake-model").id;
    await first.runner.run(session, "go");
    expect(approve).toHaveBeenCalledTimes(1);
    expect(approve.mock.calls[0]?.[0]).toMatchObject({
      capability: "analysis.run",
      effect: "process",
      preview: "print(1)",
      runtime: "managed",
    });
    const resolved = first.store
      .eventsPage?.(session, { after: 0, limit: 100 })
      .items.find((e) => e.type === "approval_resolved");
    expect(resolved?.data).toMatchObject({
      capability: "analysis.run",
      decision: "session",
      persisted: true,
    });
    await first.close();
    apps.length = 0;

    // A new process, headless (no approval handler, no flag): the grant still applies.
    const second = await app({ queue: [python], prefix: "d" });
    expect(toolNames(second, session)).toContain("python_run");
    await second.runner.run(session, "again");
    expect(toolResult(second, session, "d1")).toMatch(/^runtime_unavailable/);
    const [grant] = second.capabilityGrants.live(session);
    expect(grant).toMatchObject({ capability: "analysis.run", scope: "session", source: "tui" });
    expect(second.capabilityGrants.revoke(session, grant?.id ?? "", "tui")).toBe(true);
    expect(toolNames(second, session)).not.toContain("python_run");
    await second.close();
    apps.length = 0;

    const asked = vi.fn(async () => "once" as const);
    const third = await app({ approve: asked, queue: [python], prefix: "e" });
    await third.runner.run(session, "third");
    expect(asked).toHaveBeenCalledTimes(1);
  });

  it("deny returns a tool error and creates no job; the next call asks again", async () => {
    const approve = vi.fn(async () => "deny" as const);
    const a = await app({ approve, queue: [python, python] });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    await a.runner.run(session, "go");
    expect(toolResult(a, session, "c1")).toMatch(/denied by the user/);
    expect(toolResult(a, session, "c2")).toMatch(/denied by the user/);
    expect(approve).toHaveBeenCalledTimes(2);
    expect(executions(a).n).toBe(0);
    expect(a.capabilityGrants.list(session).map((g) => g.decision)).toEqual(["deny", "deny"]);
  });

  it("allowing analysis.run for the session does not allow shell", async () => {
    const approve = vi.fn(async (request: ApprovalRequest) =>
      request.capability ? ("session" as const) : ("deny" as const),
    );
    const a = await app({
      approve,
      queue: [python, { name: "shell", args: { command: "echo hi" } }],
    });
    const session = a.store.create(a.workspace, "fake", "fake-model").id;
    await a.runner.run(session, "go");
    expect(approve).toHaveBeenCalledTimes(2);
    expect(approve.mock.calls[1]?.[0]).toMatchObject({ effect: "process" });
    expect(approve.mock.calls[1]?.[0]).not.toHaveProperty("capability");
    expect(toolResult(a, session, "c2")).toMatch(/Capability process denied/);
    expect(a.runner.policy.process).toBe(false);
  });

  it("grants belong to the root session", async () => {
    const a = await app();
    const rootSession = a.store.create(a.workspace, "fake", "fake-model");
    const child = a.store.createChild({
      parentId: rootSession.id,
      workspace: a.workspace,
      provider: "fake",
      model: "fake-model",
      agent: "explore",
      title: "c",
      depth: 1,
      options: {},
    });
    a.capabilityGrants.record({
      capability: "analysis.run",
      sessionId: child.id,
      workspace: a.workspace,
      scope: "session",
      decision: "allow",
      source: "web",
    });
    expect(a.capabilityGrants.granted("analysis.run", rootSession.id)).toBe(true);
    expect(a.capabilityGrants.live(rootSession.id)[0]?.sessionId).toBe(rootSession.id);
  });
});
