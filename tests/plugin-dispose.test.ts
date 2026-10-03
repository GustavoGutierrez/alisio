import { definePlugin, type Plugin } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginHost, ProviderRegistry, ToolRegistry } from "../packages/core/src/index.ts";

const state = () => ({ getState: () => undefined, setState: () => {} });
const plugin = (id: string, dispose?: Plugin["dispose"], setup: Plugin["setup"] = () => {}) =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup, ...(dispose ? { dispose } : {}) });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("PluginHost.close", () => {
  it("a never-resolving dispose does not block the dispose of the others nor exceed its limit", async () => {
    const host = new PluginHost(
      new ToolRegistry(),
      state(),
      { disposeTimeoutMs: 800 },
      new ProviderRegistry(),
    );
    const disposed: string[] = [];
    await host.activate(
      plugin("hung", () => new Promise<void>(() => {})),
      ".",
    );
    await host.activate(
      plugin("quick", async () => {
        disposed.push("quick");
      }),
      ".",
    );
    await host.activate(
      plugin("slow", async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        disposed.push("slow");
      }),
      ".",
    );
    const settled = vi.fn();
    const closing = host.close().then(
      () => settled("ok"),
      (error) => settled(error),
    );
    // Parallel: the quick one finished immediately and the 300 ms one needs no wait for the hung.
    await vi.advanceTimersByTimeAsync(0);
    expect(disposed).toEqual(["quick"]);
    await vi.advanceTimersByTimeAsync(300);
    expect(disposed).toEqual(["quick", "slow"]);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    await closing;
    // The hung plugin is reported, the others are not blocked by it.
    expect(settled).toHaveBeenCalledTimes(1);
    const error = settled.mock.calls[0]?.[0] as AggregateError;
    expect(error).toBeInstanceOf(AggregateError);
    expect(error.errors).toHaveLength(1);
    expect(String((error.errors[0] as Error).message)).toMatch(/hung.*timed out after 800ms/);
  });

  it("a throwing dispose does not stop the others and its registrations are still undone", async () => {
    const tools = new ToolRegistry();
    const host = new PluginHost(tools, state(), {}, new ProviderRegistry());
    const disposed: string[] = [];
    await host.activate(
      plugin(
        "boom",
        () => {
          throw new Error("nope");
        },
        (api) => {
          api.tools.register({
            name: "t",
            description: "d",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
            async execute() {
              return { content: [] };
            },
          });
        },
      ),
      ".",
    );
    await host.activate(
      plugin("fine", async () => void disposed.push("fine")),
      ".",
    );
    await expect(host.close()).rejects.toBeInstanceOf(AggregateError);
    expect(disposed).toEqual(["fine"]);
    expect(host.metadata()).toEqual([]);
    expect(tools.list()).toEqual([]);
  });

  it("the limit follows the live setting and defaults to 2 s", async () => {
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    await host.activate(
      plugin("hung", () => new Promise<void>(() => {})),
      ".",
    );
    const done = vi.fn();
    void host.close().catch(done);
    await vi.advanceTimersByTimeAsync(1999);
    expect(done).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(done).toHaveBeenCalled();

    const live = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    live.applyTimeoutSettings({ disposeTimeoutMs: 100 });
    await live.activate(
      plugin("hung2", () => new Promise<void>(() => {})),
      ".",
    );
    const liveDone = vi.fn();
    void live.close().catch(liveDone);
    await vi.advanceTimersByTimeAsync(101);
    expect(liveDone).toHaveBeenCalled();
  });

  it("close with no plugins resolves", async () => {
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    await expect(host.close()).resolves.toBeUndefined();
  });
});

describe("createApplication().close", () => {
  it("disposes every plugin even when one hangs, within the configured limit", async () => {
    vi.useRealTimers();
    const { mkdir, mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { createApplication } = await import("../packages/core/src/index.ts");
    const dir = await mkdtemp(join(tmpdir(), "alisio-dispose-"));
    await mkdir(join(dir, "config"), { recursive: true });
    await mkdir(join(dir, "ws"), { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", join(dir, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(dir, "state"));
    await writeFile(
      join(dir, "config", "config.json"),
      JSON.stringify({ pluginHooks: { disposeTimeoutMs: 200 } }),
    );
    const disposed: string[] = [];
    const builtin = (id: string, dispose: () => Promise<void>) => ({
      id,
      description: id,
      create: () => plugin(id, dispose),
    });
    const app = await createApplication({
      cwd: join(dir, "ws"),
      db: join(dir, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: {
        id: "p",
        defaultModel: "m",
        async *stream() {},
      } as never,
      builtins: [
        builtin("hangs", () => new Promise<void>(() => {})),
        builtin("fine", async () => void disposed.push("fine")),
      ],
    });
    const started = Date.now();
    await app.close();
    expect(disposed).toEqual(["fine"]);
    expect(Date.now() - started).toBeLessThan(2400);
    vi.unstubAllEnvs();
  });
});
