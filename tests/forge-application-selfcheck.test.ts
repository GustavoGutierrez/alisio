/**
 * L9: the scratchpad is an authorized write root only while the JavaScript engine is actually
 * READY. With Forja enabled in the config but the engine failing its self-check (a WASM that does
 * not verify), `js_run` is not offered, and the scratchpad must not stay a free write root either.
 */
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApprovalRequest } from "../packages/core/src/core/contracts.ts";
import { createApplication } from "../packages/core/src/index.ts";

vi.mock("../packages/core/src/forge/javascript/wasm.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../packages/core/src/forge/javascript/wasm.ts")>()),
  loadQuickJsModule: () => Promise.reject(new Error("quickjs.wasm hash does not match")),
}));

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-forge-selfcheck-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};

describe("scratchpad write root needs a ready engine (L9)", () => {
  it("a failing self-check leaves the scratchpad an ordinary directory: writes ask like before", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({
        forge: {
          javascript: { enabled: true },
          scratch: { enabled: true, root: join(root, "tmp") },
        },
      }),
    );
    const effects: string[] = [];
    const dirs: string[] = [];
    const a = await createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: silent,
      approve: async (request: ApprovalRequest) => {
        effects.push(request.effect);
        return "once";
      },
      approveExternalDirectory: async (request) => {
        dirs.push(request.path);
        return "once";
      },
    });
    apps.push(a);
    expect(a.forge.runtime.jsReady).toBe(false);
    expect(a.registry.list().some((tool) => tool.name === "js_run")).toBe(false);
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const pad = await a.forge.scratchpad?.(session);
    const target = join(pad ?? join(root, "tmp", "x"), "plan.js");
    await mkdir(join(target, ".."), { recursive: true });
    await a.runner.runToolCall(session, "write_file", {
      path: target,
      content: "console.log(1)",
      expectedHash: null,
    });
    expect(dirs).toEqual([target]);
    expect(effects).toEqual(["write"]);
  });

  it("L2: the HTTP view of the scratchpad is unavailable too, and looking never creates the folder", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({
        forge: {
          javascript: { enabled: true },
          scratch: { enabled: true, root: join(root, "tmp") },
        },
      }),
    );
    const a = await createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: silent,
    });
    apps.push(a);
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    expect(await a.forge.scratchpad?.(session)).toBeUndefined();
    expect(await a.forge.scratchpadView?.(session)).toEqual({ available: false });
    await expect(readdir(join(root, "tmp"))).rejects.toThrow();
  });
});
