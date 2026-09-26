import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelInfo, ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/application.ts";
import { DeepSeekProvider } from "../packages/plugin-deepseek/src/provider.ts";

afterEach(() => vi.unstubAllEnvs());

/** Minimal provider: no model discovery (catalog absent) unless `listModels` is provided. */
const provider = (over: Partial<ModelProvider> = {}): ModelProvider => ({
  id: "fixture",
  model: "fixture-model",
  stream: async function* () {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } } as const;
  },
  ...over,
});

const root = () => mkdtemp(join(tmpdir(), "alisio-context-budget-"));

describe("honest context budget", () => {
  it("reports an unknown basis (no fabricated total) when no catalog can exist", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const app = await createApplication({ cwd, provider: provider(), noHerdr: true });
    try {
      expect(app.contextBudget("fixture-model")).toEqual({
        total: undefined,
        basis: "unknown",
        compactionAt: 100,
      });
    } finally {
      await app.close();
    }
  });

  it("uses the provider catalog once loaded (lazy GET /models), not a 40k stand-in", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider: provider({
        async listModels() {
          return [
            { id: "deepseek-flash", contextWindow: 1_000_000 },
            { id: "small", contextWindow: 8_000 },
          ] as ModelInfo[];
        },
      }),
    });
    try {
      // Before any catalog load the budget is honestly unknown.
      expect(app.contextBudget("deepseek-flash").basis).toBe("unknown");
      expect(app.contextBudget("deepseek-flash").total).toBeUndefined();
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextBudget("deepseek-flash")).toEqual({
        total: 1_000_000,
        basis: "window",
        compactionAt: 85,
      });
      expect(app.contextBudget("small")).toEqual({
        total: 8_000,
        basis: "window",
        compactionAt: 85,
      });
      expect(app.contextBudget("unknown-model").basis).toBe("unknown");
    } finally {
      await app.close();
    }
  });

  it("refreshes the window when the catalog changes (model switch reload)", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    let catalog: ModelInfo[] = [{ id: "m", contextWindow: 128_000 }];
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider: provider({
        async listModels() {
          return catalog;
        },
      }),
    });
    try {
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextBudget("m").total).toBe(128_000);
      // A provider/model switch swaps the catalog; the TUI reloads it and the bar recomputes.
      catalog = [{ id: "m", contextWindow: 1_000_000 }];
      expect(app.contextBudget("m").total).toBe(128_000); // stale until reload
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextBudget("m")).toEqual({
        total: 1_000_000,
        basis: "window",
        compactionAt: 85,
      });
    } finally {
      await app.close();
    }
  });

  it("lets the explicit provider.contextWindow override win for the configured model", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const app = await createApplication({
      cwd,
      noHerdr: true,
      config: await fixtureConfig(cwd),
      provider: provider({ id: "openai-compatible", model: "legacy-model" }),
    });
    try {
      expect(app.contextBudget("legacy-model")).toEqual({
        total: 96_000,
        basis: "window",
        compactionAt: 85,
      });
    } finally {
      await app.close();
    }
  });

  it("maps DeepSeek official context_window metadata into the bar's window", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const deepseek = new DeepSeekProvider(
      {
        baseURL: "https://api.deepseek.com",
        apiKey: "fixture-key",
        apiKeyEnv: "UNUSED",
        model: "deepseek-flash",
        apiMode: "chat",
        auth: "bearer",
        tokenParameter: "max_tokens",
        streamUsage: true,
      },
      {
        models: {
          async *list() {
            yield {
              id: "deepseek-flash",
              object: "model",
              owned_by: "deepseek",
              context_window: 1_000_000,
              max_output_tokens: 64000,
            };
          },
        },
      } as never,
    );
    const app = await createApplication({ cwd, noHerdr: true, provider: deepseek });
    try {
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextWindow("deepseek-flash")).toBe(1_000_000);
      expect(app.contextBudget("deepseek-flash")).toEqual({
        total: 1_000_000,
        basis: "window",
        compactionAt: 85,
      });
    } finally {
      await app.close();
    }
  });
});

async function fixtureConfig(cwd: string): Promise<string> {
  const { writeFile } = await import("node:fs/promises");
  const file = join(cwd, "fixture-config.json");
  await writeFile(
    file,
    JSON.stringify({
      schemaVersion: 1,
      provider: { model: "legacy-model", contextWindow: 96_000, auth: "none" },
    }),
  );
  return file;
}
