/**
 * Phase 4 over HTTP: `POST /api/artifacts/:aid/rerun` (a `python_run { rerunOf }` call of the
 * session through the capability gate), `GET /api/analysis` (the read-only runtime state of the
 * Settings page) and the analysis settings (`analysis.retention.*`, three-level keys) through
 * `PATCH /api/settings`.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AnalysisStatus,
  ArtifactRef,
  PendingApproval,
  ProviderEvent,
  SettingsOverview,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { fake, fakeInterpreter } from "./analysis-run-helpers.ts";
import {
  fakeProvider,
  gatedProvider,
  newSession,
  reply,
  settled,
  startTestServer,
  type TestServer,
  until,
} from "./server-helpers.ts";

let t: TestServer | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** The default manager with the discovered interpreter replaced by the fake one. */
async function fakeRuntime() {
  const dir = await mkdtemp(join(tmpdir(), "alisio-fake-runtime-"));
  scratch.push(dir);
  return Object.assign(new AnalysisRuntimeManager({ stateDir: dir }), {
    interpreter: fakeInterpreter,
  });
}

/** Each run calls python_run once with a script that publishes report.md, then answers. */
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
            arguments: JSON.stringify({
              code: fake({ files: { "report.md": `# Report ${call}\n` } }),
            }),
          },
        ],
      },
    };
  });

async function start(options: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer({
    provider: pythonProvider(),
    ...options,
    app: { analysisRuntime: await fakeRuntime(), trustProject: true, ...options.app },
  });
  return t;
}

const artifactsOf = async (server: TestServer, sessionId: string) =>
  (await server.api.get(`/api/sessions/${sessionId}/artifacts`)).json<{ items: ArtifactRef[] }>()
    .items;

const pendingApproval = (server: TestServer, sessionId: string): Promise<PendingApproval> =>
  until(async () => {
    const list = (await server.api.get(`/api/approvals?session=${sessionId}`)).json<
      PendingApproval[]
    >();
    return list[0];
  }) as Promise<PendingApproval>;

/** A session whose first python_run ran (allowed for the session) and published one artifact. */
async function original(server: TestServer) {
  const session = await newSession(server);
  const run = (
    await server.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
  ).json<{ runId: string }>();
  const approval = await pendingApproval(server, session.id);
  await server.api.post(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
    decision: "session",
  });
  await settled(server, session.id, run.runId);
  const items = await artifactsOf(server, session.id);
  expect(items).toHaveLength(1);
  return { session, artifact: items[0] as ArtifactRef };
}

describe("POST /api/artifacts/:aid/rerun", () => {
  it("repeats the analysis as a new execution with new artifacts and leaves the original intact", async () => {
    const server = await start();
    const { session, artifact } = await original(server);
    const before = (await server.api.get(`/api/artifacts/${artifact.id}`)).json<{
      provenance: Record<string, unknown>;
    }>();
    const res = await server.api.post(`/api/artifacts/${artifact.id}/rerun`, {});
    expect(res.status).toBe(202);
    const { runId } = res.json<{ runId: string }>();
    // The session grant covers it: no second approval.
    expect(await settled(server, session.id, runId)).toMatchObject({ status: "completed" });
    const items = await artifactsOf(server, session.id);
    expect(items).toHaveLength(2);
    const fresh = items.find((a) => a.id !== artifact.id) as ArtifactRef;
    const detail = (await server.api.get(`/api/artifacts/${fresh.id}`)).json<{
      provenance: Record<string, unknown>;
    }>();
    expect(detail.provenance).toMatchObject({
      rerunOf: before.provenance.executionId,
      rerunOfArtifact: artifact.id,
      scriptSha256: before.provenance.scriptSha256,
    });
    expect(detail.provenance.executionId).not.toBe(before.provenance.executionId);
    // The first artifact is untouched and still downloadable.
    expect(items.find((a) => a.id === artifact.id)).toMatchObject({ status: "ready" });
    const download = await server.api.get(`/api/artifacts/${artifact.id}/download`);
    expect(download.text).toBe("# Report 0\n");
    // The transcript shows the action like any tool call of the session.
    const page = (await server.api.get(`/api/sessions/${session.id}/messages`)).json<{
      items: Array<{ message: { role: string } }>;
    }>();
    expect(page.items.at(-1)?.message.role).toBe("assistant");
  });

  it("asks through the capability gate when nothing allows it, showing the saved script", async () => {
    const server = await start();
    const { session, artifact } = await original(server);
    // Revoke the session grant: the rerun has to ask again.
    const grants = (await server.api.get(`/api/sessions/${session.id}/capabilities`)).json<{
      items: Array<{ id: string; revokedAt?: number }>;
    }>();
    for (const grant of grants.items.filter((g) => g.revokedAt === undefined))
      await server.api.delete(`/api/sessions/${session.id}/capabilities/${grant.id}`);
    const res = await server.api.post(`/api/artifacts/${artifact.id}/rerun`, {});
    const { runId } = res.json<{ runId: string }>();
    const approval = await pendingApproval(server, session.id);
    expect(approval).toMatchObject({ name: "python_run", capability: "analysis.run" });
    expect(approval.preview).toContain("# fake:");
    await server.api.post(`/api/approvals/${encodeURIComponent(approval.approvalId)}`, {
      decision: "deny",
    });
    await settled(server, session.id, runId);
    expect(await artifactsOf(server, session.id)).toHaveLength(1);
  });

  it("answers 409 while the session is waiting or running, 404 for unknown artifacts, 400 for one without a script", async () => {
    const server = await start();
    const { session, artifact } = await original(server);
    // An artifact that python_run did not produce: no script to run again.
    const { ArtifactStore } = await import("../packages/core/src/artifacts/store.ts");
    const { SQLiteStore } = await import("../packages/core/src/runtime/store.ts");
    const side = new SQLiteStore(server.db);
    const text = (
      await new ArtifactStore({ root: join(server.root, "state"), db: side.db }).publishText(
        { fileName: "notes.md", text: "x" },
        { sessionId: session.id, rootSessionId: session.id, workspace: server.workspace },
      )
    ).artifact.id;
    side.close();
    const plain = await server.api.post(`/api/artifacts/${text}/rerun`, {});
    expect(plain.status).toBe(400);
    expect(plain.text).toMatch(/no script/);
    expect((await server.api.post("/api/artifacts/art_nope/rerun", {})).status).toBe(404);
    // A run waiting for an approval keeps the session busy.
    const grants = (await server.api.get(`/api/sessions/${session.id}/capabilities`)).json<{
      items: Array<{ id: string; revokedAt?: number }>;
    }>();
    for (const grant of grants.items.filter((g) => g.revokedAt === undefined))
      await server.api.delete(`/api/sessions/${session.id}/capabilities/${grant.id}`);
    const run = (
      await server.api.post(`/api/sessions/${session.id}/prompts`, {
        requestId: "r2",
        text: "again",
      })
    ).json<{ runId: string }>();
    const waiting = await pendingApproval(server, session.id);
    const busy = await server.api.post(`/api/artifacts/${artifact.id}/rerun`, {});
    expect(busy.status).toBe(409);
    expect(busy.json()).toMatchObject({ error: { code: "runs_active" } });
    await server.api.post(`/api/approvals/${encodeURIComponent(waiting.approvalId)}`, {
      decision: "deny",
    });
    await settled(server, session.id, run.runId);
    // A deleted artifact is gone for good.
    await server.api.delete(`/api/artifacts/${artifact.id}`);
    expect((await server.api.post(`/api/artifacts/${artifact.id}/rerun`, {})).status).toBe(404);
  });

  it("is unavailable under --read-only (there is no python_run to call)", async () => {
    const server = await start({ app: { readOnly: true } });
    const session = await newSession(server);
    const { ArtifactStore } = await import("../packages/core/src/artifacts/store.ts");
    const { SQLiteStore } = await import("../packages/core/src/runtime/store.ts");
    const side = new SQLiteStore(server.db);
    const store = new ArtifactStore({ root: join(server.root, "state"), db: side.db });
    const made = await store.publishText(
      { fileName: "n.md", text: "x" },
      { sessionId: session.id, rootSessionId: session.id, workspace: server.workspace },
    );
    // An execution that pre-dates the read-only start.
    side.db
      .prepare(
        `INSERT INTO analysis_executions(id,session,root_session,workspace,runtime,status,script_sha256,rel_dir,created_at)
         VALUES('exec_old',?,?,?,'managed','completed','x','analysis/jobs/old',1)`,
      )
      .run(session.id, session.id, server.workspace);
    side.db
      .prepare("UPDATE artifacts SET execution_id='exec_old' WHERE id=?")
      .run(made.artifact.id);
    side.close();
    const res = await server.api.post(`/api/artifacts/${made.artifact.id}/rerun`, {});
    expect(res.status).toBe(403);
    expect(res.text).toMatch(/unavailable/);
  });
});

describe("GET /api/analysis and the analysis settings", () => {
  const workspaceId = async (server: TestServer) =>
    (await server.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";

  it("reports the runtime state read only: mode, interpreter, container settings, limits and retention", async () => {
    const server = await start();
    const wid = await workspaceId(server);
    const status = (await server.api.get(`/api/analysis?workspace=${wid}`)).json<AnalysisStatus>();
    expect(status).toMatchObject({
      enabled: true,
      readOnly: false,
      mode: "managed",
      python: { found: true, version: "3.12.0", extras: [] },
      oci: { engine: "docker", memoryMb: 2048, cpus: 2 },
      limits: { timeoutMs: 120_000 },
      retention: { jobsDays: 30, intermediateDays: 7, artifactsDays: 0 },
    });
    // The container engine is not probed while the mode is managed and no image is set.
    expect(status.oci.available).toBeUndefined();
  });

  it("explains how to install Python when none is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-none-"));
    scratch.push(dir);
    const manager = Object.assign(new AnalysisRuntimeManager({ stateDir: dir }), {
      interpreter: async () => ({
        ok: false as const,
        reason: "No Python interpreter was found on PATH",
      }),
    });
    const server = await start({ app: { analysisRuntime: manager } });
    const wid = await workspaceId(server);
    const status = (await server.api.get(`/api/analysis?workspace=${wid}`)).json<AnalysisStatus>();
    expect(status.python).toMatchObject({
      found: false,
      reason: expect.stringMatching(/No Python/),
    });
    const hints = (status.python as { hints: { primary: string; system: string } }).hints;
    expect(hints.primary.length).toBeGreaterThan(3);
    expect(hints.system.length).toBeGreaterThan(2);
  });

  it("edits retention and the timeout through three-level keys, validated and persisted", async () => {
    const server = await start();
    const wid = await workspaceId(server);
    const overview = (
      await server.api.get(`/api/settings?workspace=${wid}`)
    ).json<SettingsOverview>();
    const keys = overview.settings.map((s) => s.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        "analysis.enabled",
        "analysis.limits.timeoutMs",
        "analysis.retention.jobsDays",
        "analysis.retention.intermediateDays",
        "analysis.retention.artifactsDays",
      ]),
    );
    expect(overview.settings.find((s) => s.key === "analysis.retention.jobsDays")).toMatchObject({
      kind: "number",
      value: 30,
    });
    const ok = await server.api.patch("/api/settings", {
      workspace: wid,
      key: "analysis.retention.jobsDays",
      value: 14,
    });
    expect(ok.status).toBe(200);
    const after = (await server.api.get(`/api/settings?workspace=${wid}`)).json<SettingsOverview>();
    expect(after.settings.find((s) => s.key === "analysis.retention.jobsDays")?.value).toBe(14);
    expect(
      (await server.api.get(`/api/analysis?workspace=${wid}`)).json<AnalysisStatus>().retention
        .jobsDays,
    ).toBe(14);
    const invalid = await server.api.patch("/api/settings", {
      workspace: wid,
      key: "analysis.limits.timeoutMs",
      value: 10,
    });
    expect(invalid.status).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { details: { fields: ["value"] } } });
    // Runtime and the container are not settings: only the user's config file decides them.
    for (const key of ["analysis.runtime", "analysis.oci.image"])
      expect(
        (await server.api.patch("/api/settings", { workspace: wid, key, value: "oci" })).status,
      ).toBe(400);
  });
});
