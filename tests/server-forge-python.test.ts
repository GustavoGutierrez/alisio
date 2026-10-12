/**
 * Python backends over HTTP (Python spec §9.3): `GET /api/analysis` gains `isolation` and
 * `backends`, and `GET /api/forge` lists the JavaScript engine followed by the Python backends.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AnalysisStatus, ForgeOverview } from "@alisio/sdk";
import { afterEach, describe, expect, it } from "vitest";
import { AnalysisRuntimeManager } from "../packages/core/src/analysis/runtime-manager.ts";
import { fakeInterpreter } from "./analysis-run-helpers.ts";
import { fakeProvider, reply, startTestServer, type TestServer } from "./server-helpers.ts";

let t: TestServer | undefined;
const scratch: string[] = [];
afterEach(async () => {
  await t?.close();
  t = undefined;
  for (const dir of scratch.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function start() {
  const dir = await mkdtemp(join(tmpdir(), "alisio-fake-runtime-"));
  scratch.push(dir);
  t = await startTestServer({
    provider: fakeProvider(async function* () {
      yield* reply("ok");
    }),
    app: {
      analysisRuntime: Object.assign(new AnalysisRuntimeManager({ stateDir: dir }), {
        interpreter: fakeInterpreter,
      }),
      trustProject: true,
    },
  });
  const wid = (await t.api.get("/api/workspaces")).json<Array<{ id: string }>>()[0]?.id ?? "";
  return { server: t, wid };
}

describe("GET /api/analysis: the backends table", () => {
  it("reports the policy and one descriptor per Python backend, most isolated first", async () => {
    const { server, wid } = await start();
    const status = (await server.api.get(`/api/analysis?workspace=${wid}`)).json<AnalysisStatus>();
    expect(status.isolation).toBe("preferred");
    expect(status.backends?.map((b) => [b.id, b.isolation, b.ready])).toEqual([
      ["python-oci", "os-container", false],
      ["python-wasm", "wasm-process", false],
      ["python-managed", "none", true],
    ]);
    const wasm = status.backends?.find((b) => b.id === "python-wasm");
    expect(wasm).toMatchObject({
      // Not installed, or (on a Node without the CVE-2025-55130 fix) the Node itself is refused.
      reason: expect.stringMatching(/^Pyodide (is not installed|needs Node )/),
      capabilities: { hardTermination: true, hardMemoryLimit: false, networkDeniedByOS: false },
      profiles: [],
    });
    expect(status.backends?.find((b) => b.id === "python-oci")?.reason).toContain(
      "no container image is set",
    );
    // The managed backend is never presented as isolated.
    expect(status.backends?.find((b) => b.id === "python-managed")?.reason).toBeUndefined();
  });
});

describe("GET /api/forge", () => {
  it("lists the JavaScript engine and the Python descriptors, with the state of the services", async () => {
    const { server, wid } = await start();
    const res = await server.api.get(`/api/forge?workspace=${wid}`);
    expect(res.status).toBe(200);
    const forge = res.json<ForgeOverview>();
    expect(forge.engines.map((e) => e.id)).toEqual([
      "javascript-quickjs",
      "python-oci",
      "python-wasm",
      "python-managed",
    ]);
    expect(forge.engines.find((e) => e.id === "python-wasm")).toMatchObject({
      language: "python",
      ready: false,
    });
    expect(forge.javascript.limits.timeoutMs).toBeGreaterThan(0);
    expect(forge.state).toEqual({ enabled: expect.any(Boolean) });
  });
});
