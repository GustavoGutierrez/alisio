/**
 * The ContextReport over HTTP (spec 012 phase 5): `GET /api/sessions/:sid/context/report`. A real
 * server and a scripted provider run a session that supersedes a read; the report must agree with
 * the durable `context_governed` events of the same run (the JSONL the headless `--json` output and
 * the session export carry). The older `GET /api/sessions/:sid/context` (context ring) is unchanged.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  ContextGovernedData,
  ContextReport,
  ProviderEvent,
  SessionContextUsage,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import {
  fakeProvider,
  newSession,
  raw,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});
const server = () => t as TestServer;
const reportPath = (id: string) => `/api/sessions/${id}/context/report`;
const FILE_TEXT = "DISTINCTIVE-WORKSPACE-FILE-TEXT";
const A_TS = `export const v = 1; // ${FILE_TEXT}\n`;

/** read a.ts, rewrite it, read it again (the first read is superseded), read b.ts, then answer. */
const SCRIPT: Array<[id: string, name: string, args: object]> = [
  ["r1", "read_file", { path: "a.ts" }],
  [
    "w1",
    "write_file",
    {
      path: "a.ts",
      content: "export const v = 2;\n",
      expectedHash: createHash("sha256").update(A_TS).digest("hex"),
    },
  ],
  ["r2", "read_file", { path: "a.ts" }],
  ["r3", "read_file", { path: "b.ts" }],
  ["r4", "read_file", { path: "b.ts" }],
];
function scripted() {
  return fakeProvider(async function* (_request, call): AsyncGenerator<ProviderEvent> {
    const step = SCRIPT[call];
    if (!step) return yield* reply("done");
    yield {
      type: "completed",
      message: {
        role: "assistant",
        text: "",
        calls: [{ id: step[0], name: step[1], arguments: JSON.stringify(step[2]) }],
      },
      usage: { input: 1, output: 1 },
    };
  });
}

async function start(mode: "off" | "shadow" | "on", provider = scripted()) {
  t = await startTestServer({ provider, app: { allowWrite: true } });
  await mkdir(join(t.root, "config"), { recursive: true });
  await writeFile(
    join(t.root, "config", "config.json"),
    JSON.stringify({ context: { governor: mode, elide: { minAgeTurns: 2, epochMessages: 0 } } }),
  );
  await writeFile(join(t.workspace, "a.ts"), A_TS);
  await writeFile(join(t.workspace, "b.ts"), "export const b = 1;\n");
  return (await newSession(t, { preset: "full-access" })).id;
}

async function runSession(id: string) {
  const run = (
    await server().api.post(`/api/sessions/${id}/prompts`, { requestId: "r1", text: "go" })
  ).json<{ runId: string }>();
  await settled(server(), id, run.runId);
}
const reportOf = async (id: string) =>
  (await server().api.get(reportPath(id))).json<ContextReport>();
async function governedEvents(id: string): Promise<ContextGovernedData[]> {
  const text = (await server().api.get(`/api/sessions/${id}/export`)).text;
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { type: string; data?: ContextGovernedData })
    .filter((e) => e.type === "context_governed" && e.data)
    .map((e) => e.data as ContextGovernedData);
}

describe("GET /api/sessions/:sid/context/report", () => {
  it("refuses a request without the session cookie and 404s an unknown session", async () => {
    const id = await start("shadow");
    expect((await raw(server().server.port, reportPath(id))).status).toBe(401);
    expect((await server().api.get(reportPath("nope"))).status).toBe(404);
  });

  it("is empty and says so when the governor is off", async () => {
    const id = await start("off");
    await runSession(id);
    expect(await reportOf(id)).toMatchObject({
      sessionId: id,
      mode: "off",
      segments: [],
      elided: 0,
      invariants: { count: 0, omitted: 0, byKind: {} },
    });
    expect(await governedEvents(id)).toEqual([]);
  });

  it("explains the superseded read in shadow mode, agreeing with the context_governed events", async () => {
    const id = await start("shadow");
    await runSession(id);
    const report = await reportOf(id);
    expect(report.mode).toBe("shadow");
    const elided = report.segments.filter((s) => s.elided);
    expect(elided.map((s) => [s.callId, s.elided?.reason, s.elided?.replacedBy])).toEqual([
      ["r1", "superseded_read", "w1"],
    ]);
    // Same reasons and ids as the durable events of the run (the JSONL the CLI prints).
    const events = await governedEvents(id);
    expect(events.length).toBeGreaterThan(0);
    const last = events.at(-1) as ContextGovernedData;
    expect(last.byReason).toEqual(report.byReason);
    expect(last.elided).toBe(report.elided);
    expect(events.flatMap((e) => e.elidedCallIds ?? [])).toEqual(["r1"]);
    expect(report.request).toBe(last.request);
    // Before a compaction the request carries no invariants; the report has counts, never text.
    expect(report.invariants).toEqual({ count: 0, omitted: 0, byKind: {} });
  });

  it("matches what the provider received in on mode, without any content in the report", async () => {
    const provider = scripted();
    const id = await start("on", provider);
    await runSession(id);
    const report = await reportOf(id);
    expect(report.mode).toBe("on");
    expect(report.segments.some((s) => s.callId === "r1" && s.elided)).toBe(true);
    const sent = JSON.stringify(provider.calls.at(-1)?.messages);
    expect(sent).toContain("[elided: read_file");
    const body = JSON.stringify(report);
    expect(body).not.toContain(FILE_TEXT);
    expect(body).not.toContain("[elided:");
  });

  it("leaves the context ring route (estimate and budget) as it was", async () => {
    const id = await start(
      "shadow",
      fakeProvider(() => reply("ok")),
    );
    const res = await server().api.get(`/api/sessions/${id}/context`);
    expect(res.status).toBe(200);
    expect(res.json<SessionContextUsage>().estimated).toBeGreaterThan(0);
  });
});
