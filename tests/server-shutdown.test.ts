import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderEvent, ServerFrame } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { startServer } from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";
import {
  client,
  fakeProvider,
  login,
  newSession,
  openStream,
  raw,
  reply,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  vi.unstubAllEnvs();
});

type Frame<T extends ServerFrame["t"]> = Extract<ServerFrame, { t: T }>;

describe("graceful shutdown (T-13)", () => {
  it("cancels runs, denies approvals, releases locks and ends streams within the bound", async () => {
    const provider = fakeProvider(async function* (request, call): AsyncGenerator<ProviderEvent> {
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
              id: `c${call}`,
              name: "write_file",
              arguments: JSON.stringify({ path: "x.txt", content: "x", expectedHash: null }),
            },
          ],
        },
      };
    });
    t = await startTestServer({ provider });
    const session = await newSession(t);
    const stream = openStream(t.server.port, t.cookie, [session.id]);
    await stream.next((e) => e.frame.t === "snapshot");
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "w" })
    ).json<{ runId: string }>();
    await stream.next((e) => e.frame.t === "approval");
    const begin = Date.now();
    await t.server.close();
    expect(Date.now() - begin).toBeLessThan(6_000);
    const withdrawn = (await stream.next((e) => e.frame.t === "approval_withdrawn"))
      .frame as Frame<"approval_withdrawn">;
    expect(withdrawn?.reason).toBe("cancelled");
    await expect(stream.next(() => false, 0, 2_000)).rejects.toThrow(/ended/);
    const store = new SQLiteStore(t.db);
    try {
      expect(store.runs(session.id)[0]).toMatchObject({ id: run.runId, status: "cancelled" });
      const lock = store.db.prepare("SELECT locked_pid FROM sessions WHERE id=?").get(session.id);
      expect(lock).toEqual({ locked_pid: null });
      // The runner reports the aborted approval as a cancelled run (no approval_resolved).
      const types = store.eventsPage(session.id).items.map((e) => e.type);
      expect(types).toContain("approval_requested");
      expect(types.at(-1)).toBe("run_cancelled");
    } finally {
      store.close();
    }
  });

  it("answers 503 shutting_down while runs are being stopped", async () => {
    // A provider that ignores cancellation keeps shutdown in its bounded wait.
    const stuck = fakeProvider(async function* (): AsyncGenerator<ProviderEvent> {
      yield { type: "text_delta", delta: "..." };
      await new Promise((resolve) => setTimeout(resolve, 60_000).unref());
    });
    t = await startTestServer({ provider: stuck });
    const session = await newSession(t);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "x" });
    const closing = t.server.close();
    const ready = await t.api.get("/api/ready");
    expect(ready.status).toBe(503);
    expect(ready.json()).toMatchObject({ error: { code: "shutting_down" } });
    expect((await t.api.get("/api/sessions")).status).toBe(503);
    const begin = Date.now();
    await closing;
    expect(Date.now() - begin).toBeLessThan(6_000);
  });

  it("reconciles runs left running by a dead process at startup", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-reconcile-"));
    await mkdir(join(root, "ws"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const db = join(root, "state", "sessions.sqlite");
    const dead = spawnSync(process.execPath, ["-e", "process.pid"]).pid as number;
    const store = new SQLiteStore(db);
    const session = store.create(join(root, "ws"), "fake", "fake-model");
    store.beginRun({ id: "stale", session: session.id, status: "running" });
    store.db.prepare("UPDATE runs SET owner_pid=? WHERE id='stale'").run(dead);
    store.close();
    const server = await startServer({
      port: 0,
      logger: createLogger("silent"),
      app: { db, noHerdr: true, provider: fakeProvider(() => reply("ok")) },
    });
    try {
      const api = client(server.port, await login(server.port, server.token));
      expect((await api.get(`/api/sessions/${session.id}/runs`)).json()).toEqual([
        expect.objectContaining({ id: "stale", status: "interrupted" }),
      ]);
      expect((await api.get(`/api/sessions/${session.id}`)).json()).toMatchObject({
        status: "error",
      });
      expect((await raw(server.port, "/api/health")).status).toBe(200);
    } finally {
      await server.close();
    }
  });
});
