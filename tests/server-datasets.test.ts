import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  DatasetDetailWire,
  DatasetRef,
  DatasetRowsPage,
  ProviderEvent,
  ServerFrame,
} from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { bigCsv, pythonCommand } from "./data-helpers.ts";
import {
  fakeProvider,
  newSession,
  openStream,
  raw,
  reply,
  settled,
  startTestServer,
  type TestServer,
} from "./server-helpers.ts";
import { buildXlsx } from "./xlsx-helpers.ts";

let t: TestServer | undefined;
const streams: Array<{ close(): void }> = [];
afterEach(async () => {
  for (const s of streams.splice(0)) s.close();
  await t?.close();
  t = undefined;
});

const stream = (sessions: string[]) => {
  if (!t) throw new Error("no server");
  const s = openStream(t.server.port, t.cookie, sessions, {});
  streams.push(s);
  return s;
};
const frame =
  <T extends ServerFrame["t"]>(type: T) =>
  (e: { frame: ServerFrame }) =>
    e.frame.t === type;

/** Raw upload of a dataset file, like the web client does. */
function upload(
  server: TestServer,
  sessionId: string,
  name: string,
  body: string | Buffer,
  headers: Record<string, string | undefined> = {},
) {
  return raw(server.server.port, `/api/sessions/${sessionId}/datasets`, {
    method: "POST",
    body,
    headers: {
      Cookie: server.cookie,
      Origin: `http://127.0.0.1:${server.server.port}`,
      "Content-Type": "application/octet-stream",
      "X-File-Name": encodeURIComponent(name),
      ...headers,
    },
  });
}

describe("dataset routes", () => {
  it("ingests an upload in the background, announces it and serves schema and pages", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const s = stream([session.id]);
    const res = await upload(
      t,
      session.id,
      "sales año.csv",
      "region,revenue\nWest,10\nEast,20\nWest,5\n",
    );
    expect(res.status).toBe(202);
    expect(res.json()).toEqual({ dataset: null, pending: true });
    const ready = (await s.next(frame("dataset_ready"))).frame as Extract<
      ServerFrame,
      { t: "dataset_ready" }
    >;
    expect(ready.sessionId).toBe(session.id);
    const ref: DatasetRef = ready.dataset;
    expect(ref).toMatchObject({
      name: "sales año.csv",
      format: "csv",
      sheets: [{ name: "data", table: "data", rows: 3, columns: 2 }],
    });
    expect(JSON.stringify(ref)).not.toMatch(/sqlite|\/state\//);

    const list = (await t.api.get(`/api/sessions/${session.id}/datasets`)).json<{
      items: DatasetRef[];
    }>();
    expect(list.items.map((d) => d.id)).toEqual([ref.id]);
    const detail = (await t.api.get(`/api/datasets/${ref.id}`)).json<DatasetDetailWire>();
    expect(detail.sheetDetails[0]?.columns.map((c) => [c.name, c.type])).toEqual([
      ["region", "text"],
      ["revenue", "integer"],
    ]);
    expect(detail.maxInteractiveRows).toBe(1_000_000);

    const page = (await t.api.get(`/api/datasets/${ref.id}/rows?limit=2`)).json<DatasetRowsPage>();
    expect(page).toMatchObject({ total: 3, interactive: true, rowids: [1, 2] });
    expect(page.rows).toEqual([
      ["West", 10],
      ["East", 20],
    ]);
    const second = (
      await t.api.get(`/api/datasets/${ref.id}/rows?limit=2&after=${page.next}`)
    ).json<DatasetRowsPage>();
    expect(second.rows).toEqual([["West", 5]]);
    expect(second.next).toBeUndefined();
    const sorted = (
      await t.api.get(`/api/datasets/${ref.id}/rows?sort=revenue&dir=desc`)
    ).json<DatasetRowsPage>();
    expect(sorted.rows.map((r) => r[1])).toEqual([20, 10, 5]);
    const filtered = (
      await t.api.get(`/api/datasets/${ref.id}/rows?filter=wes&column=region`)
    ).json<DatasetRowsPage>();
    expect(filtered).toMatchObject({ matched: 2 });
  });

  it("answers the same content immediately and validates every input", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const first = await upload(t, session.id, "a.csv", "x\n1\n");
    expect(first.status).toBe(202);
    const s = stream([session.id]);
    await s.next(frame("dataset_ready"));
    const again = await upload(t, session.id, "b.csv", "x\n1\n");
    expect(again.status).toBe(200);
    expect(again.json<{ dataset: DatasetRef; pending: boolean }>().pending).toBe(false);

    expect((await upload(t, session.id, "a.csv", "x", { "Content-Type": "text/csv" })).status).toBe(
      415,
    );
    const unsupported = await upload(t, session.id, "a.parquet", "x");
    expect(unsupported.status).toBe(415);
    expect(unsupported.json<{ error: { code: string } }>().error.code).toBe("dataset_unsupported");
    expect((await upload(t, session.id, "a.csv", "")).status).toBe(400);
    expect(
      (await upload(t, session.id, "a.csv", "x\n1\n", { Origin: "http://evil.example" })).status,
    ).toBe(403);
    expect((await upload(t, session.id, "a.csv", "x\n1\n", { Cookie: undefined })).status).toBe(
      401,
    );
    expect((await upload(t, "missing", "a.csv", "x\n1\n")).status).toBe(404);
    expect((await t.api.get("/api/datasets/ds_missing")).status).toBe(404);
    const id = first.json<{ dataset: null }>().dataset;
    expect(id).toBeNull();
    const [dataset] = (await t.api.get(`/api/sessions/${session.id}/datasets`)).json<{
      items: DatasetRef[];
    }>().items;
    expect((await t.api.get(`/api/datasets/${dataset?.id}/rows?dir=sideways`)).status).toBe(400);
    expect((await t.api.get(`/api/datasets/${dataset?.id}/rows?after=%21%21`)).status).toBe(400);
    expect((await t.api.get(`/api/datasets/${dataset?.id}/rows?sort=nope`)).status).toBe(400);
    expect((await t.api.get(`/api/datasets/${dataset?.id}/rows?limit=-1`)).status).toBe(400);
    // The raw upload route stays out of reach for another session's data.
    const other = await newSession(t);
    expect(
      (await t.api.get(`/api/sessions/${other.id}/datasets`)).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it("enforces analysis.data limits with no partial dataset", async () => {
    t = await startTestServer();
    await mkdir(join(t.root, "config"), { recursive: true });
    await writeFile(
      join(t.root, "config", "config.json"),
      JSON.stringify({ analysis: { data: { maxUploadBytes: 100, maxRows: 3 } } }),
    );
    const session = await newSession(t);
    const s = stream([session.id]);
    const tooBig = await upload(t, session.id, "big.csv", `x\n${"1\n".repeat(100)}`);
    expect(tooBig.status).toBe(413);
    const tooMany = await upload(t, session.id, "rows.csv", "x\n1\n2\n3\n4\n5\n");
    expect(tooMany.status).toBe(202);
    const failed = (await s.next(frame("dataset_failed"))).frame as Extract<
      ServerFrame,
      { t: "dataset_failed" }
    >;
    expect(failed).toMatchObject({
      name: "rows.csv",
      error: expect.stringMatching(/more than 3 rows/),
    });
    expect(
      (await t.api.get(`/api/sessions/${session.id}/datasets`)).json<{ items: unknown[] }>().items,
    ).toEqual([]);
  });

  it("ingests a spreadsheet artifact the first time it is opened", async () => {
    t = await startTestServer({
      provider: fakeProvider(async function* (request, call): AsyncGenerator<ProviderEvent> {
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
                name: "artifact_create",
                arguments: JSON.stringify({ fileName: "report.csv", text: "a;b\n1;2\n3;4\n" }),
              },
            ],
          },
        };
      }),
    });
    const session = await newSession(t);
    const run = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r1",
      text: "go",
    });
    await settled(t, session.id, run.json<{ runId: string }>().runId);
    const [artifact] = (await t.api.get(`/api/sessions/${session.id}/artifacts`)).json<{
      items: Array<{ id: string }>;
    }>().items;
    const res = await t.api.post(`/api/artifacts/${artifact?.id}/dataset`);
    expect(res.status).toBe(200);
    const { dataset } = res.json<{ dataset: DatasetRef }>();
    expect(dataset).toMatchObject({ name: "report.csv", format: "csv" });
    expect(
      (await t.api.post(`/api/artifacts/${artifact?.id}/dataset`)).json<{ dataset: DatasetRef }>()
        .dataset.id,
    ).toBe(dataset.id);
    const page = (await t.api.get(`/api/datasets/${dataset.id}/rows`)).json<DatasetRowsPage>();
    expect(page.rows).toEqual([
      [1, 2],
      [3, 4],
    ]);
  });

  it("attaches datasets to a prompt: the model reads a bounded summary, the UI keeps the chips", async () => {
    const provider = fakeProvider(() => reply("ok"));
    t = await startTestServer({ provider });
    const session = await newSession(t);
    const s = stream([session.id]);
    await upload(t, session.id, "sales.csv", "region,revenue\nWest,10\nEast,20\n");
    const ready = (await s.next(frame("dataset_ready"))).frame as Extract<
      ServerFrame,
      { t: "dataset_ready" }
    >;
    const sent = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r2",
      text: "what is in it?",
      datasets: [ready.dataset.id],
    });
    expect(sent.status).toBe(202);
    await settled(t, session.id, sent.json<{ runId: string }>().runId);
    const user = provider.calls[0]?.messages.find((m) => m.role === "user");
    expect(user?.role === "user" && user.text).toMatch(
      /^what is in it\?\n\n\[Attached Dataset ds_\w+ "sales\.csv"/,
    );
    expect(user?.role === "user" && user.text.length).toBeLessThanOrEqual(
      "what is in it?".length + 2 + 4096,
    );
    expect(user?.role === "user" && user.text).toContain("West | 10");
    const messages = (await t.api.get(`/api/sessions/${session.id}/messages`)).json<{
      items: Array<{
        message: { role: string; text: string; display?: string; datasets?: DatasetRef[] };
      }>;
    }>().items;
    const stored = messages.map((m) => m.message).find((m) => m.role === "user");
    expect(stored?.display).toBe("what is in it?");
    expect(stored?.datasets?.[0]?.id).toBe(ready.dataset.id);
    const bad = await t.api.post(`/api/sessions/${session.id}/prompts`, {
      requestId: "r3",
      text: "x",
      datasets: ["ds_nope"],
    });
    expect(bad.status).toBe(400);
  });
});

describe.skipIf(!pythonCommand)("XLSX uploads", () => {
  it("ingest through the Python helper", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    const s = stream([session.id]);
    const bytes = await buildXlsx([
      {
        name: "S",
        rows: [
          ["a", "b"],
          [1, "x"],
          [2, "y"],
        ],
      },
    ]);
    expect((await upload(t, session.id, "book.xlsx", bytes)).status).toBe(202);
    const ready = (await s.next(frame("dataset_ready"))).frame as Extract<
      ServerFrame,
      { t: "dataset_ready" }
    >;
    expect(ready.dataset.sheets).toEqual([{ name: "S", table: "s_s", rows: 2, columns: 2 }]);
  });
});

describe("XLSX without Python", () => {
  it("fails with the remedy and leaves no dataset", async () => {
    t = await startTestServer({ app: { python: join("/nonexistent", "python") } });
    const session = await newSession(t);
    const s = stream([session.id]);
    const bytes = await buildXlsx([{ name: "S", rows: [["a"], [1]] }]);
    expect((await upload(t, session.id, "book.xlsx", bytes)).status).toBe(202);
    const failed = (await s.next(frame("dataset_failed"))).frame as Extract<
      ServerFrame,
      { t: "dataset_failed" }
    >;
    expect(failed.error).toContain("Export the sheet as CSV, or install Python 3.10+.");
  });
});

describe("responsiveness during a large ingestion", () => {
  it("keeps health under 100 ms and the SSE heartbeat steady while 1 000 000 rows are read", async () => {
    t = await startTestServer({ heartbeatMs: 100 });
    const session = await newSession(t);
    const s = stream([session.id]);
    const csv = Buffer.from(bigCsv(1_000_000));
    const res = await upload(t, session.id, "million.csv", csv);
    expect(res.status).toBe(202);
    const start = Date.now();
    let worst = 0;
    let samples = 0;
    let done = false;
    s.next(frame("dataset_ready"), 0, 170_000).then(() => {
      done = true;
    });
    while (!done) {
      const before = performance.now();
      const health = await raw(t.server.port, "/api/health");
      worst = Math.max(worst, performance.now() - before);
      expect(health.status).toBe(200);
      samples++;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(samples).toBeGreaterThan(5);
    expect(worst).toBeLessThan(100);
    // The heartbeat kept ticking for the whole ingestion (about every 100 ms).
    const elapsed = Date.now() - start;
    expect(s.comments.length).toBeGreaterThan(Math.min(elapsed / 100, 40) * 0.5);
    const ready = s.frames().find((f) => f.t === "dataset_ready") as Extract<
      ServerFrame,
      { t: "dataset_ready" }
    >;
    expect(ready.dataset.sheets[0]?.rows).toBe(1_000_000);
    const page = (
      await t.api.get(`/api/datasets/${ready.dataset.id}/rows?offset=999990&limit=3`)
    ).json<DatasetRowsPage>();
    expect(page.rowids).toEqual([999991, 999992, 999993]);
  }, 200_000);
});
