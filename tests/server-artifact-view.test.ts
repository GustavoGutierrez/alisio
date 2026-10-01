/**
 * The isolated artifact viewer (spec §14.2) and the panel routes of phase 2: `POST …/view` issues
 * a signed, expiring link; `/artifact-view/<token>/*` serves only that artifact's files, without
 * the cookie, with its own CSP (`sandbox`, `connect-src 'none'`); `files/*` serves previewable
 * files to the panel; `sources` and `DELETE` are explicit user actions.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalysisJobs } from "../packages/core/src/analysis/jobs.ts";
import { ArtifactStore } from "../packages/core/src/artifacts/store.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";
import { createLogger } from "../packages/server/src/log.ts";
import { newSession, raw, startTestServer, type TestServer } from "./server-helpers.ts";

let t: TestServer | undefined;
let side: SQLiteStore | undefined;
afterEach(async () => {
  vi.useRealTimers();
  side?.close();
  side = undefined;
  await t?.close();
  t = undefined;
});

const DASHBOARD = `<!doctype html><title>Sales</title><link rel="stylesheet" href="assets/app.css">
<script src="assets/app.js"></script><h1>Sales</h1>`;

async function setup(options: Parameters<typeof startTestServer>[0] = {}) {
  t = await startTestServer(options);
  const session = await newSession(t);
  side = new SQLiteStore(t.db);
  const state = join(t.root, "state");
  const store = new ArtifactStore({ root: state, db: side.db });
  const owner = { sessionId: session.id, rootSessionId: session.id, workspace: t.workspace };
  const staging = join(t.root, "staging");
  await mkdir(join(staging, "sales", "assets"), { recursive: true });
  await writeFile(join(staging, "sales", "index.html"), DASHBOARD);
  await writeFile(join(staging, "sales", "assets", "app.js"), "document.title = 'x';");
  await writeFile(join(staging, "sales", "assets", "app.css"), "h1 { color: red }");
  await writeFile(join(staging, "report.md"), "# Report\n![chart](chart.svg)\n");
  await writeFile(join(staging, "doc.pdf"), "%PDF-1.4\n%%EOF\n");
  const published = await store.publishOutputs(staging, owner);
  const byName = (name: string) =>
    published.find((p) => p.artifact.fileName === name)?.artifact.id ?? "";
  return {
    session,
    store,
    owner,
    state,
    dashboard: byName("sales.zip"),
    report: byName("report.md"),
    pdf: byName("doc.pdf"),
  };
}

const view = async (id: string) => (t as TestServer).api.post(`/api/artifacts/${id}/view`, {});

describe("POST /api/artifacts/:aid/view", () => {
  it("issues a 10-minute link for dashboards and PDFs only", async () => {
    const { dashboard, report, pdf } = await setup();
    const before = Date.now();
    const res = await view(dashboard);
    expect(res.status).toBe(200);
    const body = res.json<{ url: string; expiresAt: number }>();
    expect(body.url).toMatch(/^\/artifact-view\/[A-Za-z0-9_-]+\/index\.html$/);
    expect(body.expiresAt - before).toBeGreaterThanOrEqual(10 * 60_000 - 1000);
    expect(body.expiresAt - before).toBeLessThanOrEqual(10 * 60_000 + 1000);
    expect((await view(pdf)).json<{ url: string }>().url).toMatch(/\/doc\.pdf$/);
    expect((await view(report)).status).toBe(400);
    expect((await raw(t?.server.port ?? 0, `/api/artifacts/${dashboard}/view`)).status).toBe(401);
  });
});

describe("GET /artifact-view/:token/*", () => {
  it("serves the dashboard with the viewer headers, without the cookie", async () => {
    const { dashboard } = await setup();
    const { url } = (await view(dashboard)).json<{ url: string }>();
    const port = t?.server.port ?? 0;
    const res = await raw(port, url);
    expect(res.status).toBe(200);
    expect(res.text).toBe(DASHBOARD);
    expect(res.headers["content-type"]).toBe("text/html; charset=utf-8");
    const token = url.split("/")[2] as string;
    const origin = `http://127.0.0.1:${port}`;
    const base = `${origin}/artifact-view/${token}/`;
    expect(res.headers["content-security-policy"]).toBe(
      `default-src 'none'; script-src ${base} 'unsafe-inline'; style-src ${base} 'unsafe-inline'; img-src ${base} data: blob:; font-src ${base} data:; media-src ${base} data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-ancestors ${origin}; sandbox allow-scripts allow-downloads`,
    );
    expect(res.headers["x-frame-options"]).toBeUndefined();
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["cache-control"]).toBe("private, no-store");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["set-cookie"]).toBeUndefined();
    // Its own scripts and styles keep their real types (nosniff would block them otherwise).
    const script = await raw(port, url.replace("index.html", "assets/app.js"));
    expect(script.status).toBe(200);
    expect(script.headers["content-type"]).toBe("text/javascript; charset=utf-8");
    expect(script.headers["content-security-policy"]).toContain("sandbox allow-scripts");
    const css = await raw(port, url.replace("index.html", "assets/app.css"));
    expect(css.headers["content-type"]).toBe("text/css; charset=utf-8");
    expect((await raw(port, url, { method: "HEAD" })).status).toBe(200);
    // The app keeps refusing to be framed.
    const app = await raw(port, "/");
    expect(app.headers["x-frame-options"]).toBe("DENY");
    expect(app.headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  });

  it("serves a PDF with the minimal CSP (no sandbox directive)", async () => {
    const { pdf } = await setup();
    const { url } = (await view(pdf)).json<{ url: string }>();
    const port = t?.server.port ?? 0;
    const res = await raw(port, url);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("application/pdf");
    expect(res.headers["content-security-policy"]).toBe(
      `default-src 'none'; frame-ancestors http://127.0.0.1:${port}`,
    );
  });

  it("rejects expired and forged tokens, other artifacts, traversal, bad hosts and writes", async () => {
    const { dashboard, report } = await setup();
    const port = t?.server.port ?? 0;
    const { url } = (await view(dashboard)).json<{ url: string }>();
    const token = url.split("/")[2] as string;
    const prefix = `/artifact-view/${token}`;
    // Another artifact's files are not reachable with this token.
    expect((await raw(port, `${prefix}/report.md`)).status).toBe(404);
    for (const path of [
      "../manifest.json",
      "%2e%2e%2fmanifest.json",
      "assets/%2e%2e/%2e%2e/manifest.json",
      "%2Fetc%2Fpasswd",
      "C:%5CWindows%5Cwin.ini",
    ])
      expect((await raw(port, `${prefix}/${path}`)).status, path).toBe(404);
    expect((await raw(port, `/artifact-view/${token.slice(0, -2)}xx/index.html`)).status).toBe(403);
    expect((await raw(port, "/artifact-view/garbage/index.html")).status).toBe(403);
    expect((await raw(port, url, { headers: { Host: "evil.example:80" } })).status).toBe(403);
    expect((await raw(port, url, { method: "POST", body: "{}" })).status).toBe(404);
    expect(report).toBeTruthy();

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    const expired = await raw(port, url);
    expect(expired.status).toBe(403);
    expect(expired.headers["x-frame-options"]).toBe("DENY");
  });

  it("never writes view tokens to the server logs", async () => {
    const lines: string[] = [];
    const { dashboard } = await setup({
      logger: createLogger("debug", (line) => lines.push(line)),
    });
    const { url } = (await view(dashboard)).json<{ url: string }>();
    const token = url.split("/")[2] as string;
    await raw(t?.server.port ?? 0, url);
    await raw(t?.server.port ?? 0, `/artifact-view/${token}/missing.html`);
    expect(lines.join("\n")).toContain("/artifact-view/[token]/");
    expect(lines.join("\n")).not.toContain(token);
  });

  it("stops serving a deleted artifact", async () => {
    const { dashboard } = await setup();
    const { url } = (await view(dashboard)).json<{ url: string }>();
    const deleted = await t?.api.delete(`/api/artifacts/${dashboard}`);
    expect(deleted?.status).toBe(200);
    expect((await raw(t?.server.port ?? 0, url)).status).toBe(404);
    expect((await t?.api.delete(`/api/artifacts/${dashboard}`))?.status).toBe(404);
    expect((await t?.api.get(`/api/artifacts/${dashboard}`))?.json()).toMatchObject({
      status: "deleted",
    });
  });
});

describe("GET /api/artifacts/:aid/files/*", () => {
  it("serves previewable files inline to the panel and HTML only as an attachment", async () => {
    const { report, dashboard } = await setup();
    const md = await t?.api.get(`/api/artifacts/${report}/files/report.md`);
    expect(md?.status).toBe(200);
    expect(md?.text).toBe("# Report\n![chart](chart.svg)\n");
    expect(md?.headers["content-type"]).toBe("text/markdown; charset=utf-8");
    expect(md?.headers["content-disposition"]).toMatch(/^inline/);
    expect(md?.headers["content-security-policy"]).toContain("sandbox");
    const html = await t?.api.get(`/api/artifacts/${dashboard}/files/index.html`);
    expect(html?.headers["content-disposition"]).toMatch(/^attachment/);
    const js = await t?.api.get(`/api/artifacts/${dashboard}/files/assets/app.js`);
    expect(js?.headers["content-type"]).toBe("text/plain; charset=utf-8");
    for (const path of ["../manifest.json", "%2e%2e%2fmanifest.json", "nope.md"])
      expect((await t?.api.get(`/api/artifacts/${report}/files/${path}`))?.status, path).toBe(404);
    expect(
      (await raw(t?.server.port ?? 0, `/api/artifacts/${report}/files/report.md`)).status,
    ).toBe(401);
  });
});

describe("GET /api/artifacts/:aid/sources", () => {
  it("returns the script and job.json, and the logs only with ?logs=1", async () => {
    const { state, owner, session } = await setup();
    const jobs = new AnalysisJobs({ root: state, db: (side as SQLiteStore).db });
    const job = await jobs.create({ ...owner, code: "print('hi')\n", runtime: "managed" });
    await writeFile(join(job.logs, "stdout.log"), "hi\n");
    await writeFile(join(job.staging, "out.csv"), "a\n1\n");
    const store = new ArtifactStore({ root: state, db: (side as SQLiteStore).db });
    const [published] = await store.publishOutputs(job.staging, {
      ...owner,
      executionId: job.id,
    });
    const id = published?.artifact.id ?? "";
    const unzipNames = (buffer: Buffer) => {
      const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
      const count = buffer.readUInt16LE(end + 10);
      let at = buffer.readUInt32LE(end + 16);
      const out: Record<string, string> = {};
      for (let i = 0; i < count; i++) {
        const size = buffer.readUInt32LE(at + 20);
        const nameLength = buffer.readUInt16LE(at + 28);
        const local = buffer.readUInt32LE(at + 42);
        const name = buffer.subarray(at + 46, at + 46 + nameLength).toString("utf8");
        const start = local + 30 + buffer.readUInt16LE(local + 26);
        out[name] = inflateRawSync(buffer.subarray(start, start + size)).toString("utf8");
        at += 46 + nameLength;
      }
      return out;
    };
    const fetchZip = async (query: string) => {
      const res = await fetch(`${t?.server.url}/api/artifacts/${id}/sources${query}`, {
        headers: { Cookie: t?.cookie ?? "" },
      });
      return { res, files: unzipNames(Buffer.from(await res.arrayBuffer())) };
    };
    const plain = await fetchZip("");
    expect(plain.res.status).toBe(200);
    expect(plain.res.headers.get("content-disposition")).toMatch(/^attachment/);
    expect(Object.keys(plain.files).sort()).toEqual(["job.json", "script/main.py"]);
    expect(plain.files["script/main.py"]).toBe("print('hi')\n");
    const withLogs = await fetchZip("?logs=1");
    expect(Object.keys(withLogs.files).sort()).toEqual([
      "job.json",
      "logs/stdout.log",
      "script/main.py",
    ]);
    // Artifacts that python_run did not produce have no sources.
    const text = await store.publishText({ fileName: "n.md", text: "n" }, owner);
    const none = await t?.api.get(`/api/artifacts/${text.artifact.id}/sources`);
    expect(none?.status).toBe(404);
    expect(session.id).toBeTruthy();
  });
});
