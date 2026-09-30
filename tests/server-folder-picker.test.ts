import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DirectoryListing, HealthInfo } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { createNativePicker, type PickerRun } from "../packages/server/src/host/folder-picker.ts";
import { deferred, startTestServer, type TestServer } from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
});

/** A picker over a fake zenity: never opens a real dialog. */
function fakePicker(run: PickerRun) {
  return createNativePicker({
    strategy: { tool: "zenity", file: "/usr/bin/zenity", platform: "linux" },
    run,
  });
}

describe("native folder picker route", () => {
  it("advertises the capability and returns the folder chosen in the dialog", async () => {
    const calls: string[][] = [];
    let chosen = "";
    t = await startTestServer({
      folderPicker: fakePicker(async (_file, args) => {
        calls.push(args);
        return { code: 0, stdout: `${chosen}\n` };
      }),
    });
    chosen = await realpath(t.workspace);
    const health = (await t.api.get("/api/health")).json<HealthInfo>();
    expect(health.capabilities).toMatchObject({ nativePicker: true, folderBrowser: true });
    const picked = await t.api.post("/api/workspaces/pick", { start: t.root });
    expect(picked.status).toBe(200);
    expect(picked.json()).toEqual({ path: chosen });
    expect(calls[0]).toContain(`--filename=${t.root}/`);
  });

  it("reports a cancelled dialog and validates the start directory", async () => {
    t = await startTestServer({ folderPicker: fakePicker(async () => ({ code: 1, stdout: "" })) });
    expect((await t.api.post("/api/workspaces/pick", {})).json()).toEqual({ cancelled: true });
    const relative = await t.api.post("/api/workspaces/pick", { start: "rel" });
    expect(relative.status).toBe(400);
    const missing = await t.api.post("/api/workspaces/pick", { start: join(t.root, "nope") });
    expect(missing.status).toBe(400);
  });

  it("allows one dialog at a time (409 picker_busy)", async () => {
    const gate = deferred<void>();
    t = await startTestServer({
      folderPicker: fakePicker(async () => {
        await gate.promise;
        return { code: 1, stdout: "" };
      }),
    });
    const first = t.api.post("/api/workspaces/pick", {});
    await new Promise((r) => setTimeout(r, 50));
    const second = await t.api.post("/api/workspaces/pick", {});
    expect(second.status).toBe(409);
    expect(second.json()).toMatchObject({ error: { code: "picker_busy" } });
    gate.resolve();
    expect((await first).status).toBe(200);
  });

  it("is unavailable without a dialog tool (503) and when bound for remote access", async () => {
    t = await startTestServer({ folderPicker: createNativePicker({ strategy: undefined }) });
    expect((await t.api.get("/api/health")).json<HealthInfo>().capabilities).toMatchObject({
      nativePicker: false,
      folderBrowser: true,
    });
    const res = await t.api.post("/api/workspaces/pick", {});
    expect(res.status).toBe(503);
    expect(res.json()).toMatchObject({ error: { code: "picker_unavailable" } });
    await t.close();
    // A dialog would open on the server machine, not the viewer's: both are off remotely.
    t = await startTestServer({
      host: "0.0.0.0",
      allowRemote: true,
      folderPicker: fakePicker(async () => ({ code: 0, stdout: "/x\n" })),
    });
    expect((await t.api.get("/api/health")).json<HealthInfo>().capabilities).toMatchObject({
      nativePicker: false,
      folderBrowser: false,
    });
    expect((await t.api.post("/api/workspaces/pick", {})).status).toBe(503);
    expect((await t.api.get("/api/fs/dirs")).status).toBe(503);
  });
});

describe("folder browser route", () => {
  it("lists subdirectory names only, hidden ones on request, with breadcrumbs", async () => {
    t = await startTestServer({ folderPicker: createNativePicker({ strategy: undefined }) });
    const root = await realpath(t.root);
    await mkdir(join(root, "alpha"));
    await mkdir(join(root, ".hidden"));
    await writeFile(join(root, "file.txt"), "secret");
    const listing = (
      await t.api.get(`/api/fs/dirs?path=${encodeURIComponent(root)}`)
    ).json<DirectoryListing>();
    const names = listing.entries.map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(["alpha", "ws"]));
    expect(names).not.toContain("file.txt");
    expect(names).not.toContain(".hidden");
    expect(JSON.stringify(listing)).not.toContain("secret");
    expect(listing.path).toBe(root);
    expect(listing.segments.at(-1)).toEqual({ name: root.split("/").at(-1), path: root });
    expect(listing.parent).toBe(join(root, ".."));
    const withHidden = (
      await t.api.get(`/api/fs/dirs?path=${encodeURIComponent(root)}&hidden=true`)
    ).json<DirectoryListing>();
    expect(withHidden.entries.find((e) => e.name === ".hidden")).toMatchObject({ hidden: true });
  });

  it("starts at home, answers 404/403/400 cleanly and requires the session cookie", async () => {
    t = await startTestServer();
    const home = (await t.api.get("/api/fs/dirs")).json<DirectoryListing>();
    expect(home.path).toBe(home.home);
    const missing = await t.api.get(`/api/fs/dirs?path=${encodeURIComponent(join(t.root, "no"))}`);
    expect(missing.status).toBe(404);
    const file = join(t.root, "f.txt");
    await writeFile(file, "x");
    expect((await t.api.get(`/api/fs/dirs?path=${encodeURIComponent(file)}`)).status).toBe(404);
    expect((await t.api.get("/api/fs/dirs?path=relative")).status).toBe(400);
    if (process.getuid?.() !== 0) {
      const locked = join(t.root, "locked");
      await mkdir(locked);
      await chmod(locked, 0o000);
      const denied = await t.api.get(`/api/fs/dirs?path=${encodeURIComponent(locked)}`);
      expect(denied.status).toBe(403);
      expect(denied.json()).toMatchObject({ error: { code: "permission_denied" } });
      await chmod(locked, 0o700);
    }
    const anonymous = await fetch(`${t.server.url}/api/fs/dirs`);
    expect(anonymous.status).toBe(401);
  });
});
