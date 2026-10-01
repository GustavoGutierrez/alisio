import { join } from "node:path";
import type { CapabilityGrantWire, ProviderEvent, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeProvider,
  newSession,
  openStream,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});
type Frame<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;

/** Each run calls python_run once (unique ids), then answers "done". */
const pythonProvider = () =>
  fakeProvider(async function* (request, call): AsyncGenerator<ProviderEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield* reply("done");
      return;
    }
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [
          {
            id: `p${call}`,
            name: "python_run",
            arguments: JSON.stringify({ code: "import csv\nprint('hi')" }),
          },
        ],
      },
    };
  });

describe("capability approvals and grants over HTTP", () => {
  it("asks with the capability and script preview; S persists, lists, broadcasts and revokes", async () => {
    // No Python on purpose: --python points nowhere, so nothing is ever launched.
    t = await startTestServer({
      provider: pythonProvider(),
      app: { python: join("/nonexistent", "python") },
    });
    const session = await newSession(t);
    const watcher = openStream(t.server.port, t.cookie, [session.id]);
    const other = openStream(t.server.port, t.cookie, [session.id]);
    streams.push(watcher, other);
    await watcher.next((e) => e.frame.t === "snapshot");
    await other.next((e) => e.frame.t === "snapshot");
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    const { approval } = (await watcher.next((e) => e.frame.t === "approval"))
      .frame as Frame<"approval">;
    expect(approval).toMatchObject({
      name: "python_run",
      effect: "process",
      capability: "analysis.run",
      runtime: "managed",
      preview: "import csv\nprint('hi')",
    });
    await t.api.post(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      decision: "session",
    });
    await other.next((e) => e.frame.t === "capabilities_changed");
    await settled(t, session.id, run.runId);
    const list = (await t.api.get(`/api/sessions/${session.id}/capabilities`)).json<{
      items: CapabilityGrantWire[];
    }>();
    expect(list.items).toEqual([
      expect.objectContaining({
        capability: "analysis.run",
        sessionId: session.id,
        scope: "session",
        decision: "allow",
        source: "web",
      }),
    ]);
    expect(JSON.stringify(list)).not.toContain(t.workspace);

    // The next run does not ask: the grant is persisted for the session.
    const second = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r2", text: "again" })
    ).json<{ runId: string }>();
    await settled(t, session.id, second.runId);
    expect(watcher.frames().filter((f) => f.t === "approval")).toHaveLength(1);

    const grant = list.items[0] as CapabilityGrantWire;
    const from = other.events.length;
    const revoked = await t.api.delete(`/api/sessions/${session.id}/capabilities/${grant.id}`);
    expect(revoked.json()).toEqual({ revoked: true });
    await other.next((e) => e.frame.t === "capabilities_changed", from);
    expect(
      (await t.api.delete(`/api/sessions/${session.id}/capabilities/${grant.id}`)).status,
    ).toBe(404);
    const after = (await t.api.get(`/api/sessions/${session.id}/capabilities`)).json<{
      items: CapabilityGrantWire[];
    }>();
    expect(after.items[0]).toMatchObject({ id: grant.id, revokedAt: expect.any(Number) });
  });

  it("requires the cookie and 404s unknown sessions", async () => {
    t = await startTestServer();
    expect((await t.api.get("/api/sessions/nope/capabilities")).status).toBe(404);
    const session = await newSession(t);
    const { raw } = await import("./server-helpers.ts");
    expect((await raw(t.server.port, `/api/sessions/${session.id}/capabilities`)).status).toBe(401);
  });
});
