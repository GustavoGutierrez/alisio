/**
 * Forja over HTTP and SSE (Forja spec §11.1, D-31, FJ-AC-35): nested writes of `js_run` reach the
 * changes panel, `ForgeProgress` rides `tool_progress` through the SseHub for both engines, and
 * `GET /api/forge` stays free of session data.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeOverview, ForgeProgress, ProviderEvent, SessionChange } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { fake, fakeInterpreter } from "./analysis-run-helpers.ts";
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
const scratch: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** One tool call per run (`call` is the call number), then "done". */
const oneCall = (name: string, args: Record<string, unknown>) =>
  fakeProvider(async function* (request): AsyncGenerator<ProviderEvent> {
    if (request.messages.at(-1)?.role === "tool") {
      yield* reply("done");
      return;
    }
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [{ id: "c1", name, arguments: JSON.stringify(args) }],
      },
    };
  });

describe("GET /api/sessions/:sid/changes: nested writes (D-31)", () => {
  it("lists a file a js_run script wrote through tools.call, additively", async () => {
    t = await startTestServer({
      provider: oneCall("js_run", {
        code: "await tools.call('write_file', { path: 'nested/out.txt', content: 'x', expectedHash: null }); return 1;",
      }),
      app: { allowWrite: true },
    });
    const session = await newSession(t, { preset: "workspace-write" });
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    expect(await settled(t, session.id, run.runId)).toMatchObject({ status: "completed" });
    const { files } = (await t.api.get(`/api/sessions/${session.id}/changes`)).json<{
      files: SessionChange[];
    }>();
    expect(files.map((f) => f.path)).toEqual(["nested/out.txt"]);
    expect(files[0]).toMatchObject({ effect: "write", lastRunId: run.runId });
  });

  it("does not list a nested write the gate refused", async () => {
    t = await startTestServer({
      provider: oneCall("js_run", {
        code: "try { await tools.call('write_file', { path: 'nope.txt', content: 'x', expectedHash: null }); } catch (e) { return e.code; }",
      }),
      app: { allowWrite: false },
    });
    const session = await newSession(t);
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    await settled(t, session.id, run.runId);
    const { files } = (await t.api.get(`/api/sessions/${session.id}/changes`)).json<{
      files: SessionChange[];
    }>();
    expect(files).toEqual([]);
  });
});

describe("tool_progress over SSE carries ForgeProgress", () => {
  /** ForgeProgress objects the `delta` frames carry as JSON chunks of `progress` (hub contract). */
  const forgeProgress = (frames: ReturnType<ReturnType<typeof openStream>["frames"]>) =>
    frames.flatMap((f) =>
      f.t === "delta"
        ? (f.progress ?? []).flatMap(({ chunk }) => {
            try {
              const value = JSON.parse(chunk) as ForgeProgress;
              return value.kind === "forge" ? [value] : [];
            } catch {
              return [];
            }
          })
        : [],
    );

  it("js_run: preparing, a nested call and collecting reach a subscriber", async () => {
    t = await startTestServer({
      provider: oneCall("js_run", {
        code: "await tools.call('list_files', { path: '.' }); return 1;",
      }),
    });
    const session = await newSession(t);
    const s = openStream(t.server.port, t.cookie, [session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    await s.next((e) => e.frame.t === "event" && e.frame.event.type === "run_completed");
    const progress = forgeProgress(s.frames());
    s.close();
    expect(progress.map((p) => p.phase)).toEqual(
      expect.arrayContaining(["preparing", "call", "collecting"]),
    );
    expect(progress.every((p) => p.engine === "javascript-quickjs")).toBe(true);
    expect(progress.find((p) => p.call?.status === "succeeded")?.call?.tool).toBe("list_files");
  });

  it("python_run: its ForgeProgress carries the engine that runs it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-fake-runtime-"));
    scratch.push(dir);
    t = await startTestServer({
      provider: oneCall("python_run", { code: fake({ files: { "r.md": "# r\n" } }) }),
      app: {
        analysisRuntime: Object.assign(new AnalysisRuntimeManager({ stateDir: dir }), {
          interpreter: fakeInterpreter,
        }),
        trustProject: true,
      },
    });
    const session = await newSession(t, { preset: "workspace-write" });
    const s = openStream(t.server.port, t.cookie, [session.id]);
    await s.next((e) => e.frame.t === "snapshot");
    await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" });
    const approval = await s.next((e) => e.frame.t === "approval");
    const id = (approval.frame as { approval: { approvalId: string } }).approval.approvalId;
    await t.api.post(`/api/approvals/${encodeURIComponent(id)}`, { decision: "session" });
    await s.next((e) => e.frame.t === "event" && e.frame.event.type === "run_completed");
    const progress = forgeProgress(s.frames());
    s.close();
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.every((p) => p.engine === "python-managed")).toBe(true);
  });
});

describe("GET /api/forge", () => {
  it("describes engines, limits, scratch and state, and no session data", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
    const res = await t.api.get(`/api/forge?workspace=${wid}`);
    const forge = res.json<ForgeOverview>();
    expect(forge.engines.map((e) => e.id)).toEqual([
      "javascript-quickjs",
      "python-oci",
      "python-wasm",
      "python-managed",
    ]);
    expect(forge.javascript.limits.maxToolCalls).toBeGreaterThan(0);
    // The scratch settings the Forja page shows, without the folder (a host path).
    expect(forge.scratch).toEqual({ enabled: true, retentionDays: 7, maxBytes: 256 * 1024 * 1024 });
    expect(forge.guides).toEqual({ enabled: true });
    // The Python isolation policy and the configured runtime, read only.
    expect(forge.python).toEqual({ runtime: "auto", isolation: "preferred" });
    expect(res.text).not.toContain(session.id);
    expect(res.text).not.toContain(t.workspace);
  });
});
