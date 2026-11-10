import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  type ModelProvider,
  type Plugin,
  type PluginAPI,
  type SemanticActivationResult,
  type ToolContext,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { PluginHost } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import {
  type SemanticConfig,
  SemanticRegistry,
  SemanticService,
} from "../packages/core/src/semantic/index.ts";
import { memoryEmbedding, memoryStore } from "./fixtures/memory-semantic.ts";

const state = () => ({ getState: () => undefined, setState: () => {} });
const plugin = (id: string, setup: Plugin["setup"]): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup });

function withSemantic(config: Partial<SemanticConfig> = {}, persist = vi.fn(async () => {})) {
  const registry = new SemanticRegistry();
  const cfg: SemanticConfig = {
    enabled: true,
    embedding: "mem-embed",
    store: "mem-store",
    embedTimeoutMs: 1000,
    queryTimeoutMs: 1000,
    ...config,
  };
  const service = new SemanticService({ registry, config: () => cfg });
  const tools = new ToolRegistry();
  const host = new PluginHost(tools, state(), {}, new ProviderRegistry());
  host.setSemantic({ registry, service, activation: { config: () => cfg, persist } });
  const store = memoryStore();
  return { host, registry, service, tools, cfg, persist, store };
}

describe("api.semantic and ctx.semantic in PluginHost", () => {
  it("a plugin tool's ctx.semantic operates in the namespace of its own plugin (SE-AC-14)", async () => {
    const { host, registry, tools, store } = withSemantic();
    registry.registerEmbedding("provider", memoryEmbedding());
    registry.registerStore("provider", store);
    await host.activate(
      plugin("notes", (api) => {
        api.tools.register({
          name: "save",
          description: "d",
          inputSchema: { type: "object" },
          effect: "read",
          execute: async (_input: unknown, ctx: ToolContext) => {
            await ctx.semantic?.index("memos", [{ id: "a", text: "hello world" }]);
            return { content: [{ type: "text", text: "ok" }] };
          },
        } as never);
      }),
      ".",
    );
    const tool = tools.list().find((t) => t.name.endsWith("_save"));
    // A forged context from the runner cannot choose the namespace.
    const forged = { semantic: { index: async () => {} } } as unknown as ToolContext;
    await tool?.execute({}, forged);
    expect([...store.collectionsByName.keys()]).toEqual(["notes/memos"]);
  });

  it("a plugin registers both ports through api.semantic and index/search work", async () => {
    const { host } = withSemantic();
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.semantic?.registerEmbedding(memoryEmbedding());
        a.semantic?.registerStore(memoryStore());
      }),
      ".",
    );
    expect(api?.semantic?.available()).toBe(true);
    await api?.semantic?.index("c", [{ id: "x", text: "alpha beta" }]);
    expect((await api?.semantic?.search("c", "alpha"))?.[0]?.id).toBe("x");
  });

  it("closing the host unregisters providers and available() turns false", async () => {
    const { host, registry } = withSemantic();
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.semantic?.registerEmbedding(memoryEmbedding());
        a.semantic?.registerStore(memoryStore());
      }),
      ".",
    );
    await host.close();
    expect(registry.getEmbedding("mem-embed")).toBeUndefined();
    expect(api?.semantic?.available()).toBe(false);
  });

  it("is absent on a host without the semantic service (feature detection)", async () => {
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    let seen: unknown = "unset";
    await host.activate(
      plugin("old", (a) => void (seen = a.semantic)),
      ".",
    );
    expect(seen).toBeUndefined();
  });
});

describe("api.semantic.activate", () => {
  const run = async (host: PluginHost, ids: { embedding?: string; store?: string }) => {
    let result: SemanticActivationResult | undefined;
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.semantic?.registerEmbedding(memoryEmbedding());
        a.semantic?.registerStore(memoryStore());
      }),
      ".",
    );
    result = await api?.semantic?.activate?.(ids);
    return result;
  };

  it("without an interactive surface returns needs_confirmation and changes nothing (SE-AC-15)", async () => {
    const { host, cfg, persist } = withSemantic({ embedding: null, store: null });
    expect(await run(host, { embedding: "mem-embed", store: "mem-store" })).toEqual({
      status: "needs_confirmation",
    });
    expect(persist).not.toHaveBeenCalled();
    expect(cfg.embedding).toBeNull();
    expect(cfg.store).toBeNull();
  });

  it("asks once and persists only the pending ids when the user accepts", async () => {
    const { host, persist } = withSemantic({ embedding: null, store: null });
    const asked: unknown[] = [];
    host.setInteractiveUI({
      select: async () => undefined,
      askQuestions: async (request) => {
        asked.push(request);
        return { activate: "yes" };
      },
      open: () => false,
    });
    expect(await run(host, { embedding: "mem-embed", store: "mem-store" })).toEqual({
      status: "activated",
      active: { embedding: "mem-embed", store: "mem-store" },
    });
    expect(asked).toHaveLength(1);
    expect(persist).toHaveBeenCalledWith({ embedding: "mem-embed", store: "mem-store" });
  });

  it("never overwrites another configured provider and rejects foreign or unknown ids", async () => {
    const other = withSemantic({ store: "someone-else" });
    expect(await run(other.host, { store: "mem-store" })).toEqual({
      status: "other_provider_active",
      active: { store: "someone-else" },
    });
    const foreign = withSemantic({ embedding: null });
    expect((await run(foreign.host, { embedding: "nope" }))?.status).toBe("unavailable");
    const empty = withSemantic({ embedding: null });
    expect((await run(empty.host, {}))?.status).toBe("unavailable");
    expect(foreign.persist).not.toHaveBeenCalled();
    expect(empty.persist).not.toHaveBeenCalled();
  });

  it("reports already_active and disabled without asking", async () => {
    expect((await run(withSemantic().host, { embedding: "mem-embed" }))?.status).toBe(
      "already_active",
    );
    expect((await run(withSemantic({ enabled: false }).host, { store: "mem-store" }))?.status).toBe(
      "disabled",
    );
  });
});

describe("semantic activation persists globally through the application", () => {
  let root: string;
  const apps: Array<{ close(): Promise<void> }> = [];
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "alisio-semantic-activation-"));
    await mkdir(join(root, "ws"), { recursive: true });
    await mkdir(join(root, "config"), { recursive: true });
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  });
  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  it("writes semantic.embedding and semantic.store to the global file and applies them live", async () => {
    let api: PluginAPI | undefined;
    const silent = {
      id: "silent",
      defaultModel: "m",
      async *stream() {},
    } as unknown as ModelProvider;
    const app = await createApplication({
      cwd: join(root, "ws"),
      db: join(root, "state", "s.sqlite"),
      noHerdr: true,
      provider: silent,
      builtins: [
        {
          id: "engine",
          description: "engine",
          create: () =>
            plugin("engine", (a) => {
              api = a;
              a.semantic?.registerEmbedding(memoryEmbedding());
              a.semantic?.registerStore(memoryStore());
            }),
        },
      ],
    });
    apps.push(app);
    app.plugins.setInteractiveUI({
      select: async () => undefined,
      askQuestions: async () => ({ activate: "yes" }),
      open: () => false,
    });
    expect(api?.semantic?.available()).toBe(false);
    const result = await api?.semantic?.activate?.({ embedding: "mem-embed", store: "mem-store" });
    expect(result?.status).toBe("activated");
    expect(
      JSON.parse(await readFile(join(root, "config", "config.json"), "utf8")).semantic,
    ).toEqual({
      embedding: "mem-embed",
      store: "mem-store",
    });
    expect(api?.semantic?.available()).toBe(true);
  });
});
