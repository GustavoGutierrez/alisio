/**
 * `POST /api/artifacts/:aid/export` (spec §14.1): the server runs `artifact_export` as a tool
 * call of the session (`runToolCall`), so it passes the `write` gate (a web approval when the
 * preset asks) and the copied files appear in the session's Changes. A running session answers
 * `409 runs_active`.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PendingApproval, SessionChange } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import {
  gatedProvider,
  newSession,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
let side: SQLiteStore | undefined;
afterEach(async () => {
  side?.close();
  side = undefined;
  await t?.close();
  t = undefined;
});

async function publish(sessionId: string, fileName = "summary.md", text = "# Summary\n") {
  side ??= new SQLiteStore((t as TestServer).db);
  const store = new ArtifactStore({ root: join((t as TestServer).root, "state"), db: side.db });
  return (
    await store.publishText(
      { fileName, text },
      { sessionId, rootSessionId: sessionId, workspace: (t as TestServer).workspace },
    )
  ).artifact.id;
}

describe("POST /api/artifacts/:aid/export", () => {
  it("asks for write approval without --allow-write, copies the file and lists it in Changes", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const id = await publish(session.id);
    const res = await t.api.post(`/api/artifacts/${id}/export`, { target: "reports" });
    expect(res.status).toBe(202);
    const { runId } = res.json<{ runId: string }>();
    // Writing is not pre-allowed: the approval reaches the web like any other.
    const approval = await until(async () => {
      const list = (await t?.api.get(`/api/approvals?session=${session.id}`))?.json<
        PendingApproval[]
      >();
      return list?.[0];
    });
    expect(approval).toMatchObject({ name: "artifact_export", effect: "write" });
    await t.api.post(`/api/approvals/${approval?.approvalId}`, { decision: "once" });
    expect(await settled(t, session.id, runId)).toMatchObject({ status: "completed" });
    expect(await readFile(join(t.workspace, "reports", "summary.md"), "utf8")).toBe("# Summary\n");
    const { files } = (await t.api.get(`/api/sessions/${session.id}/changes`)).json<{
      files: SessionChange[];
    }>();
    expect(files.map((f) => f.path)).toEqual(["reports/summary.md"]);
    // The transcript shows the action and its result like a tool call of the session.
    const page = (await t.api.get(`/api/sessions/${session.id}/messages`)).json<{
      items: Array<{ message: { role: string; display?: string } }>;
    }>();
    expect(page.items.map((i) => i.message.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
  });

  it("answers 409 runs_active while the session runs, 404 for unknown artifacts, 400 without a target", async () => {
    const gated = gatedProvider();
    t = await startTestServer({ provider: gated.provider, app: { allowWrite: true } });
    const session = await newSession(t);
    const id = await publish(session.id);
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    await gated.started;
    const busy = await t.api.post(`/api/artifacts/${id}/export`, { target: "." });
    expect(busy.status).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "runs_active" } });
    gated.release();
    await settled(t, session.id);
    expect((await t.api.post("/api/artifacts/art_nope/export", { target: "." })).status).toBe(404);
    expect((await t.api.post(`/api/artifacts/${id}/export`, {})).status).toBe(400);
  });
});
