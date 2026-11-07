import { afterEach, describe, expect, it, vi } from "vitest";
import { RESTART_EXIT_CODE } from "../packages/server/src/index.ts";
import { raw, startTestServer, type TestServer } from "./server-helpers.ts";

let t: TestServer | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  vi.unstubAllEnvs();
});

describe("POST /api/server/restart", () => {
  it("exits with the restart code after responding when a supervisor is present", async () => {
    const exit = vi.fn();
    t = await startTestServer({ restart: { supervised: true, exit } });
    expect((await t.api.get("/api/server/restart")).json()).toEqual({ available: true });
    const res = await t.api.post("/api/server/restart", { confirmed: true });
    expect(res.status).toBe(200);
    expect(res.json()).toEqual({ restarting: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(RESTART_EXIT_CODE));
    expect(RESTART_EXIT_CODE).toBe(75);
  });

  it("is refused when nothing supervises the server", async () => {
    const exit = vi.fn();
    t = await startTestServer({ restart: { supervised: false, exit } });
    expect((await t.api.get("/api/server/restart")).json()).toEqual({ available: false });
    const res = await t.api.post("/api/server/restart", { confirmed: true });
    expect(res.status).toBe(403);
    expect(res.json<{ error: { code: string } }>().error.code).toBe("not_manageable");
    await new Promise((r) => setTimeout(r, 150));
    expect(exit).not.toHaveBeenCalled();
  });

  it("reads ALISIO_SUPERVISED when no option is given", async () => {
    vi.stubEnv("ALISIO_SUPERVISED", "1");
    t = await startTestServer({ restart: { exit: vi.fn() } });
    expect((await t.api.get("/api/server/restart")).json()).toEqual({ available: true });
  });

  it("requires confirmed, refuses under --read-only and without a matching Origin", async () => {
    const exit = vi.fn();
    t = await startTestServer({ restart: { supervised: true, exit } });
    expect((await t.api.post("/api/server/restart", {})).status).toBe(400);
    const bad = await raw(t.server.port, "/api/server/restart", {
      method: "POST",
      body: { confirmed: true },
      headers: {
        Cookie: t.cookie,
        "Content-Type": "application/json",
        Origin: "http://evil.example",
      },
    });
    expect(bad.status).toBe(403);
    await t.close();
    t = await startTestServer({ restart: { supervised: true, exit }, app: { readOnly: true } });
    expect((await t.api.get("/api/server/restart")).json()).toEqual({ available: false });
    const ro = await t.api.post("/api/server/restart", { confirmed: true });
    expect(ro.status).toBe(403);
    expect(ro.json<{ error: { code: string } }>().error.code).toBe("capability_ceiling");
    expect(exit).not.toHaveBeenCalled();
  });
});
