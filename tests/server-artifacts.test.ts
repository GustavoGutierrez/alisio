import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { ArtifactRef, ProviderEvent } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
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
let side: SQLiteStore | undefined;
afterEach(async () => {
  side?.close();
  side = undefined;
  await t?.close();
  t = undefined;
});

/** Each run calls artifact_create once with `args`, then answers "done". */
const createProvider = (args: Record<string, unknown>) =>
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
        calls: [{ id: `a${call}`, name: "artifact_create", arguments: JSON.stringify(args) }],
      },
    };
  });

/** Entry names and inflated bytes of a ZIP (central directory). */
function unzip(zip: Buffer): Record<string, string> {
  const end = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < count; i++) {
    const size = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const start = local + 30 + zip.readUInt16LE(local + 26);
    out[name] = inflateRawSync(zip.subarray(start, start + size)).toString("utf8");
    at += 46 + nameLength;
  }
  return out;
}

async function rawBytes(port: number, path: string, cookie: string) {
  const { request } = await import("node:http");
  return new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>(
    (resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, headers: { Cookie: cookie } }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      });
      req.on("error", reject);
      req.end();
    },
  );
}

describe("artifact routes", () => {
  it("lists a session's artifacts and downloads one with a UTF-8 filename*", async () => {
    t = await startTestServer({
      provider: createProvider({ fileName: "informe año 2026.md", text: "# Informe\n" }),
    });
    const session = await newSession(t);
    const run = (
      await t.api.post(`/api/sessions/${session.id}/prompts`, { requestId: "r1", text: "go" })
    ).json<{ runId: string }>();
    await settled(t, session.id, run.runId);
    const list = await t.api.get(`/api/sessions/${session.id}/artifacts`);
    expect(list.status).toBe(200);
    expect(list.headers["x-content-type-options"]).toBe("nosniff");
    const { items } = list.json<{ items: ArtifactRef[] }>();
    expect(items).toHaveLength(1);
    const [artifact] = items as [ArtifactRef];
    expect(artifact).toMatchObject({
      fileName: "informe año 2026.md",
      kind: "document",
      status: "ready",
      sessionId: session.id,
    });
    expect(JSON.stringify(artifact)).not.toContain(t.root);

    const detail = await t.api.get(`/api/artifacts/${artifact.id}`);
    expect(detail.json()).toMatchObject({
      id: artifact.id,
      files: [{ path: "informe año 2026.md", bytes: 10 }],
      provenance: { sessionId: session.id, callId: "a0" },
    });
    expect(detail.text).not.toContain(t.root);
    expect(detail.text).not.toContain("sourcePath");

    const download = await rawBytes(
      t.server.port,
      `/api/artifacts/${artifact.id}/download`,
      t.cookie,
    );
    expect(download.status).toBe(200);
    expect(download.body.toString()).toBe("# Informe\n");
    expect(download.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(download.headers["x-content-type-options"]).toBe("nosniff");
    expect(download.headers["content-disposition"]).toBe(
      "attachment; filename=\"informe a_o 2026.md\"; filename*=UTF-8''informe%20a%C3%B1o%202026.md",
    );
  });

  it("requires the session cookie, scopes lists to the session and 404s unknown ids", async () => {
    t = await startTestServer();
    const a = await newSession(t);
    const b = await newSession(t);
    side = new SQLiteStore(t.db);
    const store = new ArtifactStore({ root: join(t.root, "state"), db: side.db });
    const published = await store.publishText(
      { fileName: "a.md", text: "x" },
      { sessionId: a.id, rootSessionId: a.id, workspace: t.workspace },
    );
    expect((await raw(t.server.port, `/api/sessions/${a.id}/artifacts`)).status).toBe(401);
    expect(
      (await raw(t.server.port, `/api/artifacts/${published.artifact.id}/download`)).status,
    ).toBe(401);
    expect((await t.api.get(`/api/sessions/${b.id}/artifacts`)).json()).toEqual({ items: [] });
    const missing = await t.api.get("/api/artifacts/art_nope");
    expect(missing.status).toBe(404);
    expect(missing.json()).toMatchObject({ error: { code: "artifact_not_found" } });
    expect((await t.api.get("/api/sessions/nope/artifacts")).status).toBe(404);
  });

  it("downloads a multi-file dashboard as a ZIP with exactly its files; deleted ones 404", async () => {
    t = await startTestServer();
    const session = await newSession(t);
    side = new SQLiteStore(t.db);
    const store = new ArtifactStore({ root: join(t.root, "state"), db: side.db });
    const staging = join(t.root, "staging");
    await mkdir(join(staging, "site", "assets"), { recursive: true });
    await writeFile(join(staging, "site", "index.html"), '<script src="assets/a.js"></script>');
    await writeFile(join(staging, "site", "assets", "a.js"), "console.log(1)");
    const [published] = await store.publishOutputs(staging, {
      sessionId: session.id,
      rootSessionId: session.id,
      workspace: t.workspace,
    });
    const id = published?.artifact.id ?? "";
    const zip = await rawBytes(t.server.port, `/api/artifacts/${id}/download`, t.cookie);
    expect(zip.status).toBe(200);
    expect(zip.headers["content-type"]).toBe("application/zip");
    expect(zip.headers["content-disposition"]).toContain("filename*=UTF-8''site.zip");
    expect(unzip(zip.body)).toEqual({
      "assets/a.js": "console.log(1)",
      "index.html": '<script src="assets/a.js"></script>',
    });
    const withManifest = await rawBytes(
      t.server.port,
      `/api/artifacts/${id}/download?manifest=1`,
      t.cookie,
    );
    expect(Object.keys(unzip(withManifest.body))).toContain("manifest.json");

    await store.delete(id);
    const items = (await t.api.get(`/api/sessions/${session.id}/artifacts`)).json<{
      items: ArtifactRef[];
    }>().items;
    expect(items[0]).toMatchObject({ id, status: "deleted" });
    expect((await t.api.get(`/api/artifacts/${id}/download`)).status).toBe(404);
  });
});
