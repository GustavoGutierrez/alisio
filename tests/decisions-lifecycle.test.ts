import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type BuiltinPlugin,
  createApplication,
  DecisionMetrics,
  DecisionRegistry,
  DecisionService,
  type DecisionsConfig,
} from "../packages/core/src/index.ts";
import { fakeProvider } from "./fixtures/decision-provider.ts";

type Calls = string[];
function lifecycleProvider(
  id: string,
  calls: Calls,
  behavior: { activate?: "ok" | "throw" | "hang"; deactivate?: "ok" | "throw" | "hang" } = {},
) {
  const provider = fakeProvider({ id });
  const run = (phase: "activate" | "deactivate", mode: string | undefined) => async () => {
    calls.push(`${phase}:${id}`);
    if (mode === "throw") throw new Error(`${phase} failed`);
    if (mode === "hang") await new Promise<void>(() => {});
  };
  Object.assign(provider, {
    activate: run("activate", behavior.activate),
    deactivate: run("deactivate", behavior.deactivate),
  });
  return provider;
}

function setup(config: Partial<DecisionsConfig> = {}, timeoutMs = 15_000) {
  const registry = new DecisionRegistry();
  const cfg: DecisionsConfig = {
    enabled: true,
    provider: null,
    timeoutMs: 1500,
    minConfidence: 0.6,
    telemetry: true,
    ...config,
  };
  const logs: string[] = [];
  const service = new DecisionService({
    registry,
    config: () => cfg,
    metrics: new DecisionMetrics(),
    lifecycle: { timeoutMs: () => timeoutMs, log: (message) => logs.push(message) },
  });
  return { registry, cfg, service, logs };
}
const flush = () => vi.advanceTimersByTimeAsync(0);

describe("provider lifecycle (service)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("activates the configured provider once, on the first sync, and never at registration", async () => {
    const calls: Calls = [];
    const { registry, service } = setup({ provider: "a" });
    registry.register("t", lifecycleProvider("a", calls));
    await flush();
    expect(calls).toEqual([]);
    service.syncActive();
    await flush();
    service.syncActive();
    await flush();
    expect(calls).toEqual(["activate:a"]);
  });

  it("does not activate a registered provider the configuration does not name", async () => {
    const calls: Calls = [];
    const { registry, service } = setup({ provider: null });
    registry.register("t", lifecycleProvider("a", calls));
    service.syncActive();
    await flush();
    expect(calls).toEqual([]);
  });

  it("deactivates the old and activates the new provider on a live change, in order", async () => {
    const calls: Calls = [];
    const { registry, service, cfg } = setup({ provider: "a" });
    registry.register("t", lifecycleProvider("a", calls));
    registry.register("t", lifecycleProvider("b", calls));
    service.syncActive();
    await flush();
    cfg.provider = "b";
    service.syncActive();
    await flush();
    expect(calls).toEqual(["activate:a", "deactivate:a", "activate:b"]);
  });

  it("enabled:false deactivates, enabled:true activates again", async () => {
    const calls: Calls = [];
    const { registry, service, cfg } = setup({ provider: "a" });
    registry.register("t", lifecycleProvider("a", calls));
    service.syncActive();
    cfg.enabled = false;
    service.syncActive();
    cfg.enabled = true;
    service.syncActive();
    await flush();
    expect(calls).toEqual(["activate:a", "deactivate:a", "activate:a"]);
  });

  it("a late registration of a provider already named by the configuration activates it", async () => {
    const calls: Calls = [];
    const { registry, service } = setup({ provider: "late" });
    service.syncActive();
    await flush();
    expect(calls).toEqual([]);
    registry.register("t", lifecycleProvider("late", calls));
    await flush();
    expect(calls).toEqual(["activate:late"]);
  });

  it("unregistering the active provider deactivates it", async () => {
    const calls: Calls = [];
    const { registry, service } = setup({ provider: "a" });
    const off = registry.register("t", lifecycleProvider("a", calls));
    service.syncActive();
    await flush();
    off();
    await flush();
    expect(calls).toEqual(["activate:a", "deactivate:a"]);
    expect(service.available()).toBe(false);
  });

  it("serializes transitions of one provider: deactivate waits for a slow activate", async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    let release: () => void = () => {};
    const provider = fakeProvider({ id: "a" });
    Object.assign(provider, {
      activate: () =>
        new Promise<void>((resolve) => {
          order.push("activate:start");
          release = () => {
            order.push("activate:end");
            resolve();
          };
        }),
      deactivate: async () => {
        order.push("deactivate");
      },
    });
    const { registry, service, cfg } = setup({ provider: "a" });
    registry.register("t", provider);
    service.syncActive();
    cfg.provider = null;
    service.syncActive();
    await flush();
    expect(order).toEqual(["activate:start"]);
    release();
    await flush();
    expect(order).toEqual(["activate:start", "activate:end", "deactivate"]);
  });

  it("bounds a hanging activate, records lastLifecycleError and keeps serving", async () => {
    vi.useFakeTimers();
    const calls: Calls = [];
    const { registry, service, logs } = setup({ provider: "a" }, 1000);
    registry.register("t", lifecycleProvider("a", calls, { activate: "hang" }));
    service.syncActive();
    await vi.advanceTimersByTimeAsync(999);
    expect((await service.status()).lastLifecycleError).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    const status = await service.status();
    expect(status.lastLifecycleError).toMatchObject({ provider: "a", phase: "activate" });
    expect(status.lastLifecycleError?.message).toMatch(/timed out/i);
    expect(logs.join("\n")).toMatch(/activate/);
    expect(service.available()).toBe(true);
  });

  it("a throwing activate or deactivate is captured, never thrown", async () => {
    const calls: Calls = [];
    const { registry, service, cfg } = setup({ provider: "a" });
    registry.register(
      "t",
      lifecycleProvider("a", calls, { activate: "throw", deactivate: "throw" }),
    );
    service.syncActive();
    await flush();
    expect((await service.status()).lastLifecycleError).toMatchObject({
      phase: "activate",
      message: "activate failed",
    });
    cfg.provider = null;
    expect(() => service.syncActive()).not.toThrow();
    await flush();
    expect((await service.status()).lastLifecycleError).toMatchObject({ phase: "deactivate" });
  });

  it("a provider without hooks is fine", async () => {
    const { registry, service } = setup({ provider: "plain" });
    registry.register("t", fakeProvider({ id: "plain" }));
    expect(() => service.syncActive()).not.toThrow();
    await flush();
    expect((await service.status()).lastLifecycleError).toBeUndefined();
  });

  it("shutdown deactivates the active provider within its limit and stops further syncs", async () => {
    vi.useFakeTimers();
    const calls: Calls = [];
    const { registry, service, cfg } = setup({ provider: "a" });
    registry.register("t", lifecycleProvider("a", calls, { deactivate: "hang" }));
    service.syncActive();
    await flush();
    const done = vi.fn();
    void service.shutdown(500).then(done);
    await vi.advanceTimersByTimeAsync(499);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toHaveBeenCalled();
    expect(calls).toEqual(["activate:a", "deactivate:a"]);
    cfg.provider = "a";
    service.syncActive();
    await flush();
    expect(calls).toEqual(["activate:a", "deactivate:a"]);
  });
});

describe("provider lifecycle (application)", () => {
  afterEach(() => vi.unstubAllEnvs());
  const silent: ModelProvider = {
    id: "silent",
    defaultModel: "m",
    async *stream() {
      yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
    },
  } as never;

  async function start(provider: ReturnType<typeof lifecycleProvider>, decisions: unknown) {
    const root = await mkdtemp(join(tmpdir(), "alisio-lifecycle-"));
    await mkdir(join(root, "config"), { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(root, "config", "config.json"), JSON.stringify({ decisions }));
    const builtin: BuiltinPlugin = {
      id: "engine",
      description: "test engine",
      create: () =>
        definePlugin({
          id: "engine",
          version: "1.0.0",
          apiVersion: 1,
          setup: (api) => {
            api.decisions?.registerProvider(provider);
          },
        }),
    };
    const workspace = join(root, "ws");
    await mkdir(workspace, { recursive: true });
    return createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: silent,
      builtins: [builtin],
    });
  }

  it("starts without waiting for a hanging activate", async () => {
    const calls: Calls = [];
    const provider = lifecycleProvider("hangs", calls, { activate: "hang" });
    const started = Date.now();
    const app = await start(provider, { provider: "hangs" });
    expect(Date.now() - started).toBeLessThan(3000);
    await vi.waitFor(() => expect(calls).toEqual(["activate:hangs"]));
    expect(app.decisions.service.available()).toBe(true);
    await app.close();
  });

  it("activates on startup, follows live provider changes and deactivates on close", async () => {
    const calls: Calls = [];
    const provider = lifecycleProvider("engine-a", calls);
    const app = await start(provider, { provider: "engine-a" });
    await vi.waitFor(() => expect(calls).toEqual(["activate:engine-a"]));
    await app.updateSetting("decisions.provider", "unknown-engine");
    await vi.waitFor(() => expect(calls).toEqual(["activate:engine-a", "deactivate:engine-a"]));
    await app.updateSetting("decisions.provider", "engine-a");
    await vi.waitFor(() => expect(calls.at(-1)).toBe("activate:engine-a"));
    await app.close();
    expect(calls.at(-1)).toBe("deactivate:engine-a");
  });
});
