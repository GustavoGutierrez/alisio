import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, Plugin } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/application.ts";

afterEach(() => vi.unstubAllEnvs());

const root = () => mkdtemp(join(tmpdir(), "alisio-exit-speed-"));
/** Minimal provider that never hangs: responds instantly. */
const fastProvider: ModelProvider = {
  id: "fast",
  model: "fast-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } } as const;
  },
};
const hanging = () => new Promise<void>(() => {});

describe("fast exit", () => {
  it("app.close() returns promptly when provider and plugin disposal hang", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    let providerDisposed = false;
    let pluginDisposed = false;
    const provider: ModelProvider = {
      ...fastProvider,
      dispose: () => {
        providerDisposed = true;
        return hanging(); // never resolves: exit must not wait for it
      },
    };
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider,
      builtins: [
        {
          id: "slow-teardown",
          description: "disposal hangs on purpose",
          create: () =>
            ({
              id: "slow-teardown",
              version: "1.0.0",
              apiVersion: 1,
              name: "Slow teardown",
              description: "disposal hangs on purpose",
              setup() {},
              dispose: () => {
                pluginDisposed = true;
                return hanging();
              },
            }) as Plugin,
        },
      ],
    });
    const start = Date.now();
    await app.close();
    const elapsed = Date.now() - start;
    // Teardown stages are capped at 2500ms each (herdr+mcp, then provider+plugins); a hang
    // can add at most that, and neither awaited dispose may stall the caller.
    expect(elapsed).toBeLessThan(6_000);
    expect(providerDisposed).toBe(true);
    expect(pluginDisposed).toBe(true);
  }, 10_000);

  it("app.endSession is bounded by pluginHooks.sessionEndTimeoutMs (the /clear bound)", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const configDir = join(cwd, "config");
    await mkdir(configDir, { recursive: true });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      join(configDir, "config.json"),
      JSON.stringify({ pluginHooks: { sessionEndTimeoutMs: 200 } }),
    );
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider: fastProvider,
      config: join(configDir, "config.json"),
      builtins: [
        {
          id: "slow-end",
          description: "session-end hook hangs on purpose",
          create: () =>
            ({
              id: "slow-end",
              version: "1.0.0",
              apiVersion: 1,
              name: "Slow end",
              description: "session-end hook hangs on purpose",
              setup(api) {
                api.session.onEnd(async () => {
                  await hanging();
                });
              },
            }) as Plugin,
        },
      ],
    });
    try {
      expect(app.plugins.hasSessionEndHooks).toBe(true);
      const session = app.store.create(cwd, "fast", "fast-model").id;
      const start = Date.now();
      const result = await app.endSession(session, "clear");
      const elapsed = Date.now() - start;
      // The host aborts the hook at sessionEndTimeoutMs (200ms here); endSession never waits
      // for the hook itself. The TUI further caps this during exit (see tui/exit.ts).
      expect(elapsed).toBeLessThan(2_000);
      expect(result.failures).toHaveLength(1);
      expect(result.failures[0]?.source).toBe("slow-end");
    } finally {
      await app.close();
    }
  }, 10_000);
});
