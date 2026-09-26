import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActiveProvider,
  type BuiltinPlugin,
  createApplication,
  ProviderRegistry,
  ProviderSettingsStore,
} from "@alisio/core";
import { createDeepSeekPlugin } from "@alisio/plugin-deepseek";
import { createOpenAICompatiblePlugin } from "@alisio/plugin-openai-compatible";
import { definePlugin, type ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";

const provider = (id: string, model = "m", dispose?: () => void): ModelProvider => ({
  id,
  model,
  async *stream() {},
  dispose,
});
const builtin: BuiltinPlugin = {
  id: "openai-compatible",
  description: "test",
  defaultProvider: true,
  create: createOpenAICompatiblePlugin,
};
afterEach(() => vi.unstubAllEnvs());

describe("provider registry", () => {
  it("keeps multiple providers and registration undo removes only its owner", () => {
    const registry = new ProviderRegistry();
    const undoA = registry.register(
      { id: "a", name: "A", fields: [], create: () => provider("a") },
      { plugin: "one", builtin: true },
    );
    registry.register(
      { id: "b", name: "B", fields: [], create: () => provider("b") },
      { plugin: "two", builtin: false },
    );
    expect(registry.list().map((x) => x.id)).toEqual(["a", "b"]);
    undoA();
    expect(registry.list().map((x) => x.id)).toEqual(["b"]);
  });

  it("disposes the previous provider on a successful replacement", async () => {
    let disposed = false;
    const active = new ActiveProvider(provider("old", "old-model", () => (disposed = true)));
    await active.replace(provider("new", "new-model"));
    expect(active.id).toBe("new");
    expect(disposed).toBe(true);
  });
});

describe("provider settings", () => {
  it("separates secrets, protects credentials, and never writes a key to profiles", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-providers-"));
    await chmod(root, 0o755);
    const store = new ProviderSettingsStore(root);
    await store.saveActive(
      "openai-compatible",
      { provider: "openai-compatible", values: { baseURL: "https://example.test/v1" }, model: "m" },
      { apiKey: "secret-value" },
    );
    expect(await readFile(store.profilesPath, "utf8")).not.toContain("secret-value");
    expect(await readFile(store.credentialsPath, "utf8")).toContain("secret-value");
    if (process.platform !== "win32") {
      expect((await stat(store.credentialsPath)).mode & 0o777).toBe(0o600);
      expect((await stat(root)).mode & 0o777).toBe(0o700);
    }
    const loaded = await store.active();
    expect(loaded?.profile.model).toBe("m");
    expect(loaded?.credentials.apiKey).toBe("secret-value");
  });
});

describe("application provider selection", () => {
  it("discovers every stored plugin profile independently and switches by profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-provider-catalogs-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const makeBuiltin = (id: string, fails = false): BuiltinPlugin => ({
      id,
      description: "test",
      create: () =>
        definePlugin({
          id,
          version: "1.0.0",
          apiVersion: 1,
          setup(api) {
            api.providers.register({
              id,
              name: id === "healthy" ? "Healthy Provider" : "Unavailable Provider",
              fields: [],
              create(request) {
                return {
                  ...provider(`${id}:runtime`, String(request.profile.model ?? "")),
                  async listModels() {
                    if (fails) throw new Error("secret fake-key must not escape");
                    return [{ id: "healthy-model", name: "Healthy Model" }];
                  },
                };
              },
            });
          },
        }),
    });
    const settings = new ProviderSettingsStore(join(root, "config"));
    await settings.saveActive(
      "healthy-work",
      { provider: "healthy", values: {}, model: "old" },
      {},
    );
    await settings.saveActive(
      "unavailable",
      { provider: "unavailable", values: {}, model: "broken" },
      { apiKey: "fake-key" },
    );
    const app = await createApplication({
      cwd: root,
      builtins: [makeBuiltin("healthy"), makeBuiltin("unavailable", true)],
      noHerdr: true,
    });
    try {
      expect(await app.configuredProviderCatalogs(AbortSignal.timeout(1000))).toEqual([
        {
          profile: "healthy-work",
          provider: "healthy",
          title: "Healthy Provider",
          configuredModel: "old",
          models: [{ id: "healthy-model", name: "Healthy Model" }],
          unavailable: false,
        },
        {
          profile: "unavailable",
          provider: "unavailable",
          title: "Unavailable Provider",
          configuredModel: "broken",
          models: [],
          unavailable: true,
        },
      ]);
      expect(await app.activateProviderProfile("healthy-work", "healthy-model")).toBe(true);
      expect(app.provider.id).toBe("healthy:runtime");
      expect(app.provider.model).toBe("healthy-model");
      expect(await app.activateProviderProfile("healthy-work", "healthy-model")).toBe(false);
      expect((await settings.load()).active).toBe("healthy-work");
      expect((await settings.active())?.profile).toMatchObject({
        provider: "healthy",
        model: "healthy-model",
      });
    } finally {
      await app.close();
    }
  });

  it("persists and restores a dedicated provider selection globally", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-dedicated-persistence-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const deepseek: BuiltinPlugin = {
      id: "deepseek",
      description: "test",
      create: createDeepSeekPlugin,
    };
    const first = await createApplication({ cwd: root, builtins: [deepseek], noHerdr: true });
    try {
      await first.activateProvider(
        "deepseek",
        { baseURL: "https://api.deepseek.com", apiMode: "chat" },
        { apiKey: "fake-test-key" },
        "deepseek-flash",
      );
      expect(first.provider.id).toBe("deepseek:chat:https://api.deepseek.com");
    } finally {
      await first.close();
    }
    const second = await createApplication({ cwd: root, builtins: [deepseek], noHerdr: true });
    try {
      expect(second.provider.id).toBe("deepseek:chat:https://api.deepseek.com");
      expect(second.provider.model).toBe("deepseek-flash");
      expect(second.providerInfo).toMatchObject({ id: "deepseek", persisted: true });
    } finally {
      await second.close();
    }
  });

  it("propagates the opaque persisted session id to provider requests", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-provider-session-"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const seen: string[] = [];
    const capture: ModelProvider = {
      id: "capture",
      model: "m",
      async *stream(request) {
        if (request.sessionId) seen.push(request.sessionId);
        yield {
          type: "completed",
          message: { role: "assistant", text: "ok", calls: [] },
        } as const;
      },
    };
    const app = await createApplication({ cwd: root, provider: capture, noHerdr: true });
    try {
      const session = app.store.create(app.workspace, capture.id, capture.model);
      await app.runner.run(session.id, "hello");
      const child = app.plugins.sessions.spawn({
        parentId: session.id,
        title: "child",
        agent: "test",
      });
      await app.plugins.sessions.run(child.id, "hello from child");
      expect(seen).toEqual([session.id, child.id]);
    } finally {
      await app.close();
    }
  });

  it("keeps a saved global model when CLI and environment model values are blank", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-saved-model-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    vi.stubEnv("ALISIO_MODEL", "   ");
    await new ProviderSettingsStore(join(root, "config")).saveActive(
      "openai-compatible",
      {
        provider: "openai-compatible",
        values: { baseURL: "https://example.test/v1", auth: "none" },
        model: "saved-model",
      },
      {},
    );
    const app = await createApplication({
      cwd: root,
      builtins: [builtin],
      model: "",
      noHerdr: true,
    });
    try {
      expect(app.provider.model).toBe("saved-model");
      expect(app.providerInfo?.persisted).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("keeps explicit legacy endpoint selection distinct from a saved global profile", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-explicit-legacy-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    vi.stubEnv("ALISIO_MODEL", "legacy-model");
    vi.stubEnv("OPENAI_API_KEY", "fake-test-key");
    await new ProviderSettingsStore(join(root, "config")).saveActive(
      "openai-compatible",
      {
        provider: "openai-compatible",
        values: { baseURL: "https://saved.example.test/v1", auth: "none" },
        model: "saved-model",
      },
      {},
    );
    const app = await createApplication({
      cwd: root,
      builtins: [builtin],
      baseURL: "https://explicit.example.test/v1",
      noHerdr: true,
    });
    try {
      expect(app.provider.id).toContain("explicit.example.test");
      expect(app.providerInfo).toMatchObject({ persisted: false });
      expect(app.providerInfo?.profile.baseURL).toBe("https://explicit.example.test/v1");
      expect((await app.providerSettings.active())?.profile.model).toBe("saved-model");
      expect(await app.configuredProviderCatalogs(AbortSignal.timeout(1000))).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it("keeps the active provider when activateProvider candidate creation fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-failed-activation-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    vi.stubEnv("ALISIO_MODEL", "legacy-model");
    const failingBuiltin: BuiltinPlugin = {
      id: "candidate-test",
      description: "test",
      defaultProvider: true,
      create: () =>
        definePlugin({
          id: "candidate-test",
          version: "1.0.0",
          apiVersion: 1,
          setup(api) {
            api.providers.register({
              id: "candidate-test",
              name: "Candidate test",
              fields: [],
              create(request) {
                if (request.profile.fail === true) throw new Error("candidate failed");
                return provider(
                  "candidate-test:active",
                  String(request.profile.model ?? request.legacy?.model ?? "legacy"),
                );
              },
            });
          },
        }),
    };
    const app = await createApplication({ cwd: root, builtins: [failingBuiltin], noHerdr: true });
    try {
      expect(app.provider.id).toBe("candidate-test:active");
      await expect(
        app.activateProvider("candidate-test", { fail: true }, {}, "next"),
      ).rejects.toThrow("candidate failed");
      expect(app.provider.id).toBe("candidate-test:active");
      expect(app.provider.model).toBe("legacy-model");
      expect(await app.providerSettings.active()).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("starts unconfigured so an interactive client can reach onboarding", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-unconfigured-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    vi.stubEnv("ALISIO_MODEL", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    const app = await createApplication({ cwd: root, builtins: [builtin], noHerdr: true });
    try {
      expect(app.provider.id).toBe("unconfigured");
      expect(app.providers.list().map((x) => x.id)).toEqual(["openai-compatible"]);
    } finally {
      await app.close();
    }
  });

  it("adapts legacy environment configuration without rewriting it", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-legacy-provider-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    vi.stubEnv("ALISIO_MODEL", "legacy-model");
    vi.stubEnv("OPENAI_API_KEY", "test-only-key");
    const app = await createApplication({ cwd: root, builtins: [builtin], noHerdr: true });
    try {
      expect(app.provider.id).toBe("openai-compatible:chat:https://api.openai.com/v1");
      expect(app.provider.model).toBe("legacy-model");
      expect(
        await readFile(join(root, "config", "config.json"), "utf8").catch(() => "missing"),
      ).toBe("missing");
    } finally {
      await app.close();
    }
  });
});
