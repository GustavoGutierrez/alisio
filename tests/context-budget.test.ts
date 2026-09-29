import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpenAICompatiblePlugin } from "@alisio/plugin-openai-compatible";
import type { ModelInfo, ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApplication } from "../packages/core/src/application.ts";
import { ProviderSettingsStore } from "../packages/core/src/providers/settings.ts";

afterEach(() => vi.unstubAllEnvs());

const openaiCompatibleBuiltin = {
  id: "openai-compatible",
  description: "test",
  defaultProvider: true,
  create: createOpenAICompatiblePlugin,
};

/** Hermetic provider/home stubs shared by the saved-profile tests below. */
const savedProfileEnv = (cwd: string) => {
  vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
  vi.stubEnv("OPENAI_BASE_URL", "");
  vi.stubEnv("ALISIO_API_MODE", "");
  vi.stubEnv("ALISIO_MODEL", "");
};

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
            { id: "wide-flash", contextWindow: 1_000_000 },
            { id: "small", contextWindow: 8_000 },
          ] as ModelInfo[];
        },
      }),
    });
    try {
      // Before any catalog load the budget is honestly unknown.
      expect(app.contextBudget("wide-flash").basis).toBe("unknown");
      expect(app.contextBudget("wide-flash").total).toBeUndefined();
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextBudget("wide-flash")).toEqual({
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

  it("maps provider catalog context_window metadata into the bar's window", async () => {
    const cwd = await root();
    vi.stubEnv("ALISIO_CONFIG_HOME", join(cwd, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(cwd, "state"));
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider: provider({
        id: "catalog:fixture",
        model: "wide-flash",
        async listModels() {
          return [
            { id: "wide-flash", contextWindow: 1_000_000, maxOutputTokens: 64000 },
          ] as ModelInfo[];
        },
      }),
    });
    try {
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextWindow("wide-flash")).toBe(1_000_000);
      expect(app.contextBudget("wide-flash")).toEqual({
        total: 1_000_000,
        basis: "window",
        compactionAt: 85,
      });
    } finally {
      await app.close();
    }
  });

  it("honors a saved profile's contextWindow override for its model (local servers) across restarts", async () => {
    const cwd = await root();
    savedProfileEnv(cwd);
    // /connect with a local server (llama.cpp): the catalog omits context_window, so the user pins
    // the real window; saveActive is exactly what the flow persists after activation.
    await new ProviderSettingsStore(join(cwd, "config")).saveActive(
      "llama",
      {
        provider: "openai-compatible",
        values: { baseURL: "http://127.0.0.1:1/v1", auth: "none", contextWindow: 131_072 },
        model: "gemma-4-e4b",
      },
      {},
    );
    const app = await createApplication({
      cwd,
      noHerdr: true,
      builtins: [openaiCompatibleBuiltin],
    });
    try {
      expect(app.providerInfo).toMatchObject({ id: "openai-compatible", persisted: true });
      expect(app.contextBudget("gemma-4-e4b")).toEqual({
        total: 131_072,
        basis: "window",
        compactionAt: 85,
      });
    } finally {
      await app.close();
    }
    // A restart restores the same override from providers.json; no catalog is even contacted.
    const restarted = await createApplication({
      cwd,
      noHerdr: true,
      builtins: [openaiCompatibleBuiltin],
    });
    try {
      expect(restarted.contextBudget("gemma-4-e4b").total).toBe(131_072);
    } finally {
      await restarted.close();
    }
  });

  it("parses a string contextWindow override from hand-edited providers.json", async () => {
    const cwd = await root();
    savedProfileEnv(cwd);
    await new ProviderSettingsStore(join(cwd, "config")).saveActive(
      "llama",
      {
        provider: "openai-compatible",
        values: { baseURL: "http://127.0.0.1:1/v1", auth: "none", contextWindow: "131072" },
        model: "gemma-4-e4b",
      },
      {},
    );
    const app = await createApplication({
      cwd,
      noHerdr: true,
      builtins: [openaiCompatibleBuiltin],
    });
    try {
      expect(app.contextBudget("gemma-4-e4b").total).toBe(131_072);
    } finally {
      await app.close();
    }
  });

  it("lets the profile override win over the catalog, persist, and never leak to other models", async () => {
    const cwd = await root();
    savedProfileEnv(cwd);
    const app = await createApplication({ cwd, noHerdr: true });
    try {
      app.providers.register(
        {
          id: "fixture",
          name: "Fixture",
          fields: [],
          create: (request) =>
            provider({
              id: "fixture",
              model: request.profile.model as string,
              async listModels() {
                return [
                  { id: "gemma-4-e4b", contextWindow: 200_000 },
                  { id: "other", contextWindow: 64_000 },
                ] as ModelInfo[];
              },
            }),
        },
        { plugin: "test", builtin: false },
      );
      // The /connect surrogate: activation persists the profile values (including the optional
      // contextWindow input) and exposes them as the active profile.
      await app.activateProvider("fixture", { contextWindow: 131_072 }, {}, "gemma-4-e4b");
      expect(app.contextBudget("gemma-4-e4b")).toEqual({
        total: 131_072,
        basis: "window",
        compactionAt: 85,
      });
      // The override wins over the discovered catalog (user intent), also after a catalog reload.
      await app.loadModels(AbortSignal.timeout(5_000));
      expect(app.contextBudget("gemma-4-e4b").total).toBe(131_072);
      // It never leaks: other catalog models keep their catalog window; unknowns stay honest `?`.
      expect(app.contextBudget("other")).toEqual({
        total: 64_000,
        basis: "window",
        compactionAt: 85,
      });
      expect(app.contextBudget("unknown-model").basis).toBe("unknown");
      // The optional input is persisted into providers.json.
      const saved = JSON.parse(await readFile(join(cwd, "config", "providers.json"), "utf8")) as {
        profiles: Record<
          string,
          { provider: string; values: Record<string, unknown>; model: string }
        >;
      };
      expect(saved.profiles.fixture).toEqual({
        provider: "fixture",
        values: { contextWindow: 131_072 },
        model: "gemma-4-e4b",
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
