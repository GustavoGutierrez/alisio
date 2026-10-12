/**
 * The scratchpad over HTTP (Forja spec §9.4, §11.1, FJ-AC-35 API part): list, download and empty a
 * session's scratch folder without ever exposing a host path, following a symlink, or touching a
 * folder while a Forja execution runs.
 */

import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { ScratchListing } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureSessionDir } from "../packages/core/src/forge/session-dir.ts";
import { workspaceKey } from "../packages/core/src/index.ts";
import { newSession, startTestServer, type TestServer } from "./server-helpers.ts";

let t: TestServer | undefined;
const dirs: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

/** A server whose volatile session folders live inside its own temp root. */
async function start(options: Parameters<typeof startTestServer>[0] = {}, noPad = false) {
  const tmp = await mkdtemp(join(tmpdir(), "alisio-scratch-root-"));
  dirs.push(tmp);
  vi.stubEnv("ALISIO_TMPDIR", tmp);
  t = await startTestServer(options);
  const session = await newSession(t);
  // The scratchpad folder appears when the model first writes there; listing never creates it.
  if (!noPad) await makePad(tmp, session.id, t.workspace);
  return { t, session, tmp };
}

/** What the model's first write into the scratchpad does. */
async function makePad(tmp: string, sid: string, workspace: string): Promise<string> {
  const dir = await ensureSessionDir({
    rootSessionId: sid,
    workspace,
    workspaceKey: workspaceKey(workspace),
    stateHome: join(tmp, "state"),
    env: { ALISIO_TMPDIR: tmp },
  });
  return dir.scratchpad;
}

/** The real scratchpad folder of `sid` under `tmp` (`<tmp>/alisio-<uid>/<slug>/<sid>/scratchpad`). */
async function padOf(tmp: string, sid: string): Promise<string> {
  for (const base of await readdir(tmp))
    for (const slug of await readdir(join(tmp, base)).catch(() => []))
      for (const id of await readdir(join(tmp, base, slug)).catch(() => []))
        if (id === sid) return join(tmp, base, slug, id, "scratchpad");
  throw new Error("scratchpad not found");
}

const listing = async (server: TestServer, sid: string) =>
  (await server.api.get(`/api/sessions/${sid}/scratch`)).json<ScratchListing>();

describe("GET /api/sessions/:sid/scratch", () => {
  it("is empty for a new session and reports the quota", async () => {
    const { t, session } = await start();
    expect(await listing(t, session.id)).toEqual({
      available: true,
      files: [],
      usedBytes: 0,
      quotaBytes: 256 * 1024 * 1024,
    });
  });

  it("lists relative names, sizes and mtimes, skips symlinks, and never leaks a host path", async () => {
    const { t, session, tmp } = await start();
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await writeFile(join(pad, "b.js"), "1234567");
    await mkdir(join(pad, "sub"));
    await writeFile(join(pad, "sub", "a.py"), "print(1)\n");
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(pad, "link.txt"));
    const res = await t.api.get(`/api/sessions/${session.id}/scratch`);
    const body = res.json<ScratchListing>();
    expect(body.files.map((f) => [f.name, f.size])).toEqual([
      ["b.js", 7],
      ["sub/a.py", 9],
    ]);
    expect(body.files[0]?.mtime).toBeGreaterThan(0);
    // The quota counts a symlink as a link (its target path), never what it points at.
    expect(body.usedBytes).toBe(16 + Buffer.byteLength(outside));
    expect(res.text).not.toContain(tmp);
    expect(res.text).not.toContain(t.root);
  });

  it("answers 404 for an unknown session", async () => {
    const { t } = await start();
    expect((await t.api.get("/api/sessions/nope/scratch")).status).toBe(404);
  });

  it("reports the scratchpad as unavailable when Forja's JavaScript engine is off", async () => {
    const cfg = await mkdtemp(join(tmpdir(), "alisio-scratch-cfg-"));
    dirs.push(cfg);
    await writeFile(
      join(cfg, "config.json"),
      JSON.stringify({ forge: { javascript: { enabled: false } } }),
    );
    const { t, session } = await start({ app: { config: join(cfg, "config.json") } });
    expect(await listing(t, session.id)).toMatchObject({ available: false, files: [] });
  });
});

describe("GET /api/sessions/:sid/scratch/files/*", () => {
  it("downloads a file as an attachment, nested paths included", async () => {
    const { t, session, tmp } = await start();
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await mkdir(join(pad, "sub"));
    await writeFile(join(pad, "sub", "a.py"), "print(1)\n");
    const res = await t.api.get(`/api/sessions/${session.id}/scratch/files/sub/a.py`);
    expect(res.status).toBe(200);
    expect(res.text).toBe("print(1)\n");
    expect(res.headers["content-disposition"]).toMatch(/^attachment; filename="a\.py"/);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("answers 404 for a missing file, a directory, a traversal and a symlink out", async () => {
    const { t, session, tmp } = await start();
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await mkdir(join(pad, "sub"));
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(pad, "link.txt"));
    await symlink(tmp, join(pad, "dirlink"));
    const get = (path: string) => t.api.get(`/api/sessions/${session.id}/scratch/files/${path}`);
    for (const path of [
      "missing.txt",
      "sub",
      "%2e%2e/outside.txt",
      "..%2foutside.txt",
      "link.txt",
      "dirlink/outside.txt",
    ]) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(res.text, path).not.toContain("secret");
    }
  });
});

describe("DELETE /api/sessions/:sid/scratch", () => {
  it("empties the scratchpad, keeps the folder and leaves what a symlink pointed at alone", async () => {
    const { t, session, tmp } = await start();
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await mkdir(join(pad, "sub"));
    await writeFile(join(pad, "sub", "a.py"), "print(1)\n");
    await writeFile(join(pad, "b.js"), "1234567");
    const outside = join(tmp, "outside.txt");
    await writeFile(outside, "secret");
    await symlink(outside, join(pad, "link.txt"));
    const res = await t.api.delete(`/api/sessions/${session.id}/scratch`);
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ removed: 3, freedBytes: 16 + Buffer.byteLength(outside) });
    expect(await readdir(pad)).toEqual([]);
    expect(await readFile(outside, "utf8")).toBe("secret");
    expect(await listing(t, session.id)).toMatchObject({ files: [], usedBytes: 0 });
  });

  it("answers 409 runs_active while a Forja execution of the session is running", async () => {
    const { t, session, tmp } = await start();
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await writeFile(join(pad, "keep.js"), "x");
    const db = new DatabaseSync(t.db);
    db.prepare(
      `INSERT INTO forge_executions(id,root_session_id,session_id,tool_call_id,engine,isolation,
         selection_reason,status,code_sha256,started_at,owner_pid)
       VALUES('fx1',?,?,'c1','javascript-quickjs','wasm-isolate','test','running','h',1,?)`,
    ).run(session.id, session.id, process.pid);
    db.close();
    const res = await t.api.delete(`/api/sessions/${session.id}/scratch`);
    expect(res.status).toBe(409);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("runs_active");
    expect(await readdir(pad)).toEqual(["keep.js"]);
  });
});

describe("read-only servers", () => {
  it("refuse to empty the scratchpad", async () => {
    const { t, session, tmp } = await start({ app: { readOnly: true } });
    await listing(t, session.id);
    const pad = await padOf(tmp, session.id);
    await writeFile(join(pad, "keep.js"), "x");
    const res = await t.api.delete(`/api/sessions/${session.id}/scratch`);
    expect(res.status).toBe(403);
    expect(await readdir(pad)).toEqual(["keep.js"]);
  });
});

describe("the gate of the scratchpad routes (L2)", () => {
  it("a listing does not create the folder of a session that never wrote there", async () => {
    const { t, session, tmp } = await start({}, true);
    expect(await listing(t, session.id)).toMatchObject({
      available: true,
      files: [],
      usedBytes: 0,
    });
    expect((await t.api.get(`/api/sessions/${session.id}/scratch/files/a.js`)).status).toBe(404);
    expect((await t.api.delete(`/api/sessions/${session.id}/scratch`)).json()).toEqual({
      removed: 0,
      freedBytes: 0,
    });
    await expect(padOf(tmp, session.id)).rejects.toThrow("scratchpad not found");
  });

  it("--read-only reports the scratchpad as unavailable even when a folder exists, and serves nothing from it", async () => {
    const { t, session, tmp } = await start({ app: { readOnly: true } });
    const pad = await padOf(tmp, session.id);
    await writeFile(join(pad, "plan.js"), "1");
    expect(await listing(t, session.id)).toMatchObject({ available: false, files: [] });
    expect((await t.api.get(`/api/sessions/${session.id}/scratch/files/plan.js`)).status).toBe(404);
  });
});
