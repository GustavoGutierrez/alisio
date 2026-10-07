import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProviderEvent, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalBridge } from "../packages/server/src/bridges/approval-bridge.ts";
import {
  DEFAULT_INTERACTION_TIMEOUT_MS,
  InteractionBridge,
} from "../packages/server/src/bridges/interaction-bridge.ts";
import {
  fakeProvider,
  newSession,
  openStream,
  reply,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});
const stream = (sessions: string[]) => {
  if (!t) throw new Error("no server");
  const s = openStream(t.server.port, t.cookie, sessions);
  streams.push(s);
  return s;
};
type Frame<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;

/** Each run calls `tool` once (unique call ids), then answers "done" after the result. */
function toolProvider(tool: (call: number) => { name: string; args: Record<string, unknown> }) {
  return fakeProvider(async function* (request, call): AsyncGenerator<ProviderEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield* reply("done");
      return;
    }
    const { name, args } = tool(call);
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [{ id: `c${call}`, name, arguments: JSON.stringify(args) }],
      },
    };
  });
}
const writeFile = (file: (call: number) => string) =>
  toolProvider((call) => ({
    name: "write_file",
    args: { path: file(call), content: "x", expectedHash: null },
  }));
const eventsOf = async (s: TestServer, sid: string) =>
  (await s.api.get(`/api/sessions/${sid}/events?limit=500`)).json<{
    items: Array<{ type: string; data: Record<string, unknown> }>;
  }>().items;

describe("ApprovalBridge over HTTP (T-10)", () => {
  it("denies (fail-closed) when no client watches the session within the grace period", async () => {
    t = await startTestServer({
      provider: writeFile(() => "new.txt"),
      approvalGraceMs: 50,
    });
    const session = await newSession(t);
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "w" })
    ).json<{ runId: string }>();
    expect(await settled(t, session.id, run.runId)).toMatchObject({ status: "completed" });
    const resolved = (await eventsOf(t, session.id)).find((e) => e.type === "approval_resolved");
    expect(resolved?.data).toMatchObject({ decision: "deny", effect: "write" });
    expect(existsSync(join(t.workspace, "new.txt"))).toBe(false);
  });

  it("delivers the approval to watchers; the first answer wins and the second gets 409", async () => {
    t = await startTestServer({ provider: writeFile(() => "ok.txt") });
    const session = await newSession(t);
    const s = stream([session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "w" })
    ).json<{ runId: string }>();
    const { approval } = (await s.next((e) => e.frame.t === "approval")).frame as Frame<"approval">;
    expect(approval).toMatchObject({
      approvalId: `${session.id}:c0`,
      sessionId: session.id,
      rootSessionId: session.id,
      runId: run.runId,
      kind: "effect",
      name: "write_file",
      effect: "write",
    });
    expect(approval.input).toContain('"path": "ok.txt"');
    expect((await t.api.get(`/api/sessions/${session.id}`)).json()).toMatchObject({
      status: "awaiting_input",
    });
    expect((await t.api.get(`/api/approvals?session=${session.id}`)).json()).toEqual([approval]);
    const id = encodeURIComponent(approval.approvalId);
    expect((await t.api.post(`/api/approvals/${id}`, { decision: "once" })).json()).toEqual({
      resolved: true,
    });
    const second = await t.api.post(`/api/approvals/${id}`, { decision: "deny" });
    expect(second.status).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "approval_resolved" } });
    expect((await t.api.post("/api/approvals/nope", { decision: "deny" })).status).toBe(404);
    await s.next(
      (e) => e.frame.t === "approval_withdrawn" && e.frame.reason === "resolved_elsewhere",
    );
    await settled(t, session.id, run.runId);
    expect(existsSync(join(t.workspace, "ok.txt"))).toBe(true);
  });

  it("withdraws a pending approval when the run is cancelled", async () => {
    t = await startTestServer({ provider: writeFile(() => "never.txt") });
    const session = await newSession(t);
    const s = stream([session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "w" })
    ).json<{ runId: string }>();
    await s.next((e) => e.frame.t === "approval");
    await t.api.post(`/api/sessions/${session.id}/cancel`, {});
    await s.next((e) => e.frame.t === "approval_withdrawn" && e.frame.reason === "cancelled");
    expect(await settled(t, session.id, run.runId)).toMatchObject({ status: "cancelled" });
    expect((await t.api.get("/api/approvals")).json()).toEqual([]);
  });

  it("keeps the launch flags as the ceiling: full-access still asks for process without --allow-process", async () => {
    t = await startTestServer({
      provider: toolProvider(() => ({ name: "shell", args: { command: "echo hi" } })),
      app: { allowWrite: true },
    });
    const session = await newSession(t, { preset: "full-access" });
    const s = stream([session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "run" });
    const { approval } = (await s.next((e) => e.frame.t === "approval")).frame as Frame<"approval">;
    expect(approval).toMatchObject({ name: "shell", effect: "process" });
    await t.api.post(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      decision: "deny",
    });
    await settled(t, session.id);
  });

  it("scopes 'allow for session' to that session only", async () => {
    t = await startTestServer({ provider: writeFile((call) => `f${call}.txt`) });
    const a = await newSession(t);
    const b = await newSession(t);
    const sa = stream([a.id]);
    const sb = stream([b.id]);
    await sa.next((e) => e.frame.t === "snapshot");
    await sb.next((e) => e.frame.t === "snapshot");
    await t.api.post(`/api/sessions/${a.id}/prompts`, { requestId: "a1", text: "w" });
    const first = (await sa.next((e) => e.frame.t === "approval")).frame as Frame<"approval">;
    await t.api.post(`/api/approvals/${encodeURIComponent(first.approval.approvalId)}`, {
      decision: "session",
    });
    await settled(t, a.id);
    const again = (
      await t.api.post(`/api/sessions/${a.id}/prompts`, { requestId: "a2", text: "w" })
    ).json<{ runId: string }>();
    await settled(t, a.id, again.runId);
    expect(sa.frames().filter((f) => f.t === "approval")).toHaveLength(1);
    await t.api.post(`/api/sessions/${b.id}/prompts`, { requestId: "b1", text: "w" });
    const other = (await sb.next((e) => e.frame.t === "approval")).frame as Frame<"approval">;
    expect(other.approval.sessionId).toBe(b.id);
    await t.api.post(`/api/approvals/${encodeURIComponent(other.approval.approvalId)}`, {
      decision: "deny",
    });
    await settled(t, b.id);
  });
  it("applies a preset chosen mid-run to the run in flight (from its next tool call)", async () => {
    // Two process calls in one run: the policy change must land between them.
    const twoCalls = fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
      const tools = request.messages.filter((m) => m.role === "tool").length;
      if (tools >= 2) {
        yield* reply("done");
        return;
      }
      yield {
        type: "completed",
        message: {
          role: "assistant",
          text: "",
          calls: [
            { id: `c${tools}`, name: "shell", arguments: JSON.stringify({ command: "echo hi" }) },
          ],
        },
      };
    });
    t = await startTestServer({
      provider: twoCalls,
      app: { allowWrite: true, allowProcess: true, allowExternal: true },
    });
    const session = await newSession(t); // workspace-write: processes ask
    const s = stream([session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "run" })
    ).json<{ runId: string }>();
    const first = (await s.next((e) => e.frame.t === "approval")).frame as Frame<"approval">;
    expect(first.approval.name).toBe("shell");
    // Full access is chosen while the run waits: the in-flight run holds the session's live
    // policy object, so it must stop asking from its next tool call.
    await t.api.patch(`/api/sessions/${session.id}`, { preset: "full-access" });
    await t.api.post(`/api/approvals/${encodeURIComponent(first.approval.approvalId)}`, {
      decision: "once",
    });
    const outcome = await until(async () => {
      const askedAgain = s
        .frames()
        .some(
          (f) =>
            f.t === "approval" &&
            (f as Frame<"approval">).approval.approvalId !== first.approval.approvalId,
        );
      if (askedAgain) return "asked_again";
      if (!t) return undefined;
      const runs = (await t.api.get(`/api/sessions/${session.id}/runs`)).json<
        Array<{ id: string; status: string }>
      >();
      const current = runs.find((r) => r.id === run.runId);
      return current && current.status !== "running" && current.status !== "queued"
        ? "settled"
        : undefined;
    });
    expect(outcome).toBe("settled");
    expect((await t.api.get(`/api/sessions/${session.id}`)).json<{ preset: string }>().preset).toBe(
      "full-access",
    );
  });
});

/** A hub double recording frames per session. */
function fakeHub(watched: Set<string> = new Set(), workspaces: Set<string> = new Set()) {
  const sent: Array<{ to: string; frame: ServerFrame }> = [];
  return {
    sent,
    watched,
    workspaces,
    toSession: (to: string, frame: ServerFrame) => void sent.push({ to, frame }),
    toWorkspace: (to: string, frame: ServerFrame) => void sent.push({ to: `ws:${to}`, frame }),
    subscribers: (id: string) => (watched.has(id) ? 1 : 0),
    workspaceSubscribers: (id: string) => (workspaces.has(id) ? 1 : 0),
  };
}
const call = (id: string) => ({ id, name: "write_file", arguments: "{}" });

describe("ApprovalBridge", () => {
  it("shows child-session approvals in the root session view", async () => {
    const hub = fakeHub(new Set(["root"]));
    const bridge = new ApprovalBridge({ hub, rootOf: (id) => (id === "child" ? "root" : id) });
    const decision = bridge.handler({
      call: call("x"),
      session: "child",
      label: "general › explore",
      effect: "write",
      input: { path: "a" },
      signal: new AbortController().signal,
    });
    expect(bridge.pending("root")).toEqual([
      expect.objectContaining({
        approvalId: "child:x",
        sessionId: "child",
        rootSessionId: "root",
        label: "general › explore",
      }),
    ]);
    expect(hub.sent.map((s) => s.to)).toEqual(["root", "child"]);
    expect(bridge.awaiting("root")).toBe(true);
    expect(bridge.resolve("child:x", "session")).toBe("resolved");
    expect(await decision).toBe("session");
    expect(bridge.resolve("child:x", "once")).toBe("already_resolved");
  });

  it("carries the capability, script preview and runtime of a capability approval", async () => {
    const bridge = new ApprovalBridge({ hub: fakeHub(new Set(["s"])), rootOf: (id) => id });
    const decision = bridge.handler({
      call: call("py"),
      session: "s",
      effect: "process",
      capability: "analysis.run",
      preview: "print(1)",
      runtime: "managed",
      input: { code: "print(1)" },
      signal: new AbortController().signal,
    });
    expect(bridge.pending("s")).toEqual([
      expect.objectContaining({
        capability: "analysis.run",
        preview: "print(1)",
        runtime: "managed",
        effect: "process",
      }),
    ]);
    bridge.resolve("s:py", "deny");
    expect(await decision).toBe("deny");
  });

  it("denies after the timeout even when watched, and on abort", async () => {
    const bridge = new ApprovalBridge({
      hub: fakeHub(new Set(["s"])),
      rootOf: (id) => id,
      timeoutMs: 20,
    });
    const request = {
      call: call("t"),
      session: "s",
      effect: "write" as const,
      input: {},
      signal: new AbortController().signal,
    };
    expect(await bridge.handler(request)).toBe("deny");
    const controller = new AbortController();
    const pending = bridge.handler({ ...request, call: call("u"), signal: controller.signal });
    controller.abort();
    expect(await pending).toBe("deny");
    expect(bridge.size).toBe(0);
  });

  it("starts the grace period when the last watcher leaves", async () => {
    const hub = fakeHub(new Set(["s"]));
    const bridge = new ApprovalBridge({ hub, rootOf: (id) => id, graceMs: 20 });
    const decision = bridge.handler({
      call: call("g"),
      session: "s",
      effect: "process",
      input: {},
      signal: new AbortController().signal,
    });
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.size).toBe(1);
    hub.watched.clear();
    bridge.subscribersChanged();
    expect(await decision).toBe("deny");
    const withdrawn = hub.sent.at(-1)?.frame as Frame<"approval_withdrawn">;
    expect(withdrawn).toMatchObject({ t: "approval_withdrawn", reason: "timeout" });
  });
});

describe("InteractionBridge", () => {
  it("lets a question or plan review wait 60 minutes, longer than a tool approval's 10", async () => {
    expect(DEFAULT_INTERACTION_TIMEOUT_MS).toBe(60 * 60_000);
    vi.useFakeTimers();
    try {
      const hub = fakeHub(new Set(["root"]));
      const bridge = new InteractionBridge({ hub, rootOf: (id) => id, workspaceOf: () => "w" });
      const ui = bridge.uiFor("w");
      const questions = [{ id: "q", question: "Plan?", options: [{ value: "x", label: "X" }] }];
      let settled: unknown = "pending";
      void ui.askQuestions({ questions, session: "root" } as never).then((v) => {
        settled = v;
      });
      await vi.advanceTimersByTimeAsync(11 * 60_000);
      expect(settled).toBe("pending");
      expect(bridge.awaiting("root")).toBe(true);
      await vi.advanceTimersByTimeAsync(50 * 60_000);
      expect(settled).toEqual({ q: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes select to the workspace and returns the first valid answer", async () => {
    const hub = fakeHub(new Set(), new Set(["w"]));
    const bridge = new InteractionBridge({ hub, rootOf: (id) => id, workspaceOf: () => "w" });
    const ui = bridge.uiFor("w");
    const answer = ui.select({
      title: "Pick",
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    });
    const [pending] = bridge.pending("any-session");
    expect(pending).toMatchObject({ workspaceId: "w", request: { kind: "select" } });
    expect(hub.sent[0]?.to).toBe("ws:w");
    const id = pending?.interactionId ?? "";
    expect(bridge.resolve(id, "zzz")).toBe("invalid");
    expect(bridge.resolve(id, "b")).toBe("resolved");
    expect(bridge.resolve(id, "a")).toBe("already_resolved");
    expect(await answer).toBe("b");
    expect(ui.open("s")).toBe(true);
  });

  it("routes questions to the root session and cancels without watchers (fail-closed)", async () => {
    const hub = fakeHub(new Set(["root"]));
    const bridge = new InteractionBridge({
      hub,
      rootOf: (id) => (id === "child" ? "root" : id),
      workspaceOf: () => "w",
      graceMs: 20,
    });
    const ui = bridge.uiFor("w");
    const questions = [{ id: "q", question: "Why?", options: [{ value: "x", label: "X" }] }];
    const asked = ui.askQuestions({ questions, session: "child" } as never);
    const [pending] = bridge.pending("root");
    expect(pending?.sessionId).toBe("child");
    expect(bridge.awaiting("root")).toBe(true);
    bridge.resolve(pending?.interactionId ?? "", { q: "x" });
    expect(await asked).toEqual({ q: "x" });
    hub.watched.clear();
    expect(await ui.askQuestions({ questions, session: "child" } as never)).toEqual({
      q: undefined,
    });
    expect(await ui.select({ title: "t", options: [] })).toBeUndefined();
  });
});
