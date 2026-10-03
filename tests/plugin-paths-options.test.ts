import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type ModelProvider, type Plugin, type PluginAPI } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  configSchema,
  createApplication,
  discoverPlugins,
  loadConfigWithProvenance,
  PluginHost,
  ProviderRegistry,
  setProjectPluginEnabled,
  ToolRegistry,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

const state = () => ({ getState: () => undefined, setState: () => {} });
const plugin = (id: string, setup: Plugin["setup"]): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup });
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "alisio-paths-"));
  await mkdir(join(dir, "config"), { recursive: true });
  await mkdir(join(dir, "ws"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(dir, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(dir, "state"));
  return dir;
}
const silent: ModelProvider = {
  id: "silent",
  defaultModel: "m",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
} as never;

describe("api.paths and api.options in PluginHost", () => {
  it("are absent until the host is given its environment (an older core)", async () => {
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("p1", (a) => void (api = a)),
      ".",
    );
    expect(api?.paths).toBeUndefined();
    expect(api?.options).toBeUndefined();
  });

  it("resolves the three directories lazily, creates them 0700 on first read, per plugin id", async () => {
    const dir = await root();
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    host.setPluginEnvironment({
      stateRoot: join(dir, "state"),
      configHome: join(dir, "config"),
      options: () => ({}),
    });
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("my.engine", (a) => void (api = a)),
      ".",
    );
    const paths = api?.paths;
    expect(paths).toBeDefined();
    await expect(stat(join(dir, "state", "plugins", "my.engine"))).rejects.toThrow();
    const state_ = paths?.state as string;
    const config = paths?.config as string;
    const cache = paths?.cache as string;
    expect(state_).toBe(join(dir, "state", "plugins", "my.engine"));
    expect(config).toBe(join(dir, "config", "plugins", "my.engine"));
    expect(cache).toBe(join(dir, "state", "plugins", "my.engine", "cache"));
    for (const path of [state_, config, cache]) {
      const info = await stat(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    }
    expect({ ...paths }).toEqual({ state: state_, config, cache });
  });

  it("api.options is {} without configuration, a frozen snapshot otherwise", async () => {
    const dir = await root();
    const host = new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
    const live = { device: "cpu", nested: { n: 1 } };
    host.setPluginEnvironment({
      stateRoot: join(dir, "state"),
      configHome: join(dir, "config"),
      options: (id) => (id === "configured" ? live : {}),
    });
    const seen: Record<string, PluginAPI["options"]> = {};
    for (const id of ["configured", "plain"])
      await host.activate(
        plugin(id, (a) => void (seen[id] = a.options)),
        ".",
      );
    expect(seen.plain).toEqual({});
    expect(seen.configured).toEqual({ device: "cpu", nested: { n: 1 } });
    live.device = "cuda";
    live.nested.n = 2;
    expect(seen.configured).toEqual({ device: "cpu", nested: { n: 1 } });
    expect(Object.isFrozen(seen.configured)).toBe(true);
    expect(() => {
      (seen.configured as Record<string, unknown>).device = "x";
    }).toThrow();
  });
});

describe("createApplication wiring", () => {
  it("gives external plugins their options and paths (respecting --db) and built-ins theirs", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "config", "config.json"),
      JSON.stringify({
        pluginOverrides: { ext: { options: { model: "multilingual", preload: true } } },
        builtinPlugins: { inner: { enabled: true, mode: "fast" } },
      }),
    );
    const pluginFile = join(dir, "ext.mjs");
    await writeFile(
      pluginFile,
      `export default { id: "ext", version: "1.0.0", apiVersion: 1, setup(api) { globalThis.__extSeen = { options: api.options, state: api.paths?.state }; } };`,
    );
    let inner: unknown;
    const db = join(dir, "custom", "sessions.sqlite");
    await mkdir(join(dir, "custom"), { recursive: true });
    const app = await createApplication({
      cwd: join(dir, "ws"),
      db,
      noHerdr: true,
      provider: silent,
      plugin: [pluginFile],
      builtins: [
        {
          id: "inner",
          description: "d",
          create: () =>
            plugin("inner", (a) => {
              inner = { options: a.options, state: a.paths?.state };
            }),
        },
      ],
    });
    try {
      const seen = (globalThis as unknown as { __extSeen: { options: unknown; state: string } })
        .__extSeen;
      expect(seen.options).toEqual({ model: "multilingual", preload: true });
      expect(seen.state).toBe(join(dir, "custom", "plugins", "ext"));
      expect(inner).toEqual({
        options: { mode: "fast" },
        state: join(dir, "custom", "plugins", "inner"),
      });
    } finally {
      await app.close();
    }
  });

  it("a configuration directory made for a plugin is not mistaken for a plugin to load", async () => {
    const dir = await root();
    await mkdir(join(dir, "config", "plugins", "engine"), { recursive: true });
    await writeFile(join(dir, "config", "plugins", "engine", "settings.json"), "{}");
    expect(await discoverPlugins(join(dir, "config", "plugins"))).toEqual([]);
    await mkdir(join(dir, "config", "plugins", "real"), { recursive: true });
    await writeFile(join(dir, "config", "plugins", "real", "alisio-plugin.json"), "{}");
    expect(await discoverPlugins(join(dir, "config", "plugins"))).toEqual([
      join(dir, "config", "plugins", "real"),
    ]);
  });
});

describe("pluginOverrides schema and layers", () => {
  it("keeps {enabled} and {} valid and validates options", () => {
    const ok = (pluginOverrides: unknown) => configSchema.safeParse({ pluginOverrides }).success;
    expect(ok({ a: { enabled: false } })).toBe(true);
    expect(ok({ a: {} })).toBe(true);
    expect(ok({ a: { options: { model: "x", n: [1, { k: null }] } } })).toBe(true);
    expect(ok({ a: { options: { "9bad": 1 } } })).toBe(false);
    expect(ok({ a: { options: { fn: undefined, big: "x".repeat(9000) } } })).toBe(false);
    expect(ok({ a: { options: "x" } })).toBe(false);
    expect(ok({ a: { enabled: true, extra: 1 } })).toBe(false);
  });

  it("a project layer cannot set or change options, keeps its enabled, and is told so", async () => {
    const dir = await root();
    await writeFile(
      join(dir, "config", "config.json"),
      JSON.stringify({ pluginOverrides: { a: { options: { device: "cpu" } } } }),
    );
    await mkdir(join(dir, "ws", ".alisio"), { recursive: true });
    await writeFile(
      join(dir, "ws", ".alisio", "config.json"),
      JSON.stringify({
        pluginOverrides: {
          a: { enabled: false, options: { device: "evil" } },
          b: { options: { x: 1 } },
        },
      }),
    );
    const { config, provenance } = await loadConfigWithProvenance(join(dir, "ws"), {
      trustProject: true,
    });
    expect(config.pluginOverrides.a).toEqual({ enabled: false, options: { device: "cpu" } });
    expect(config.pluginOverrides.b?.options).toBeUndefined();
    expect(provenance.ignored).toEqual(["pluginOverrides.a.options", "pluginOverrides.b.options"]);
  });

  it("setPluginEnabled keeps the options of the entry", async () => {
    const dir = await root();
    const ws = join(dir, "ws");
    await mkdir(join(ws, ".alisio"), { recursive: true });
    await writeFile(
      join(ws, ".alisio", "config.json"),
      JSON.stringify({ pluginOverrides: { ext: { enabled: true, options: { keep: "me" } } } }),
    );
    await setProjectPluginEnabled({
      workspace: ws,
      id: "ext",
      enabled: false,
      builtin: false,
      trusted: true,
    });
    await setProjectPluginEnabled({
      workspace: ws,
      id: "fresh",
      enabled: true,
      builtin: false,
      trusted: true,
    });
    const saved = JSON.parse(await readFile(join(ws, ".alisio", "config.json"), "utf8"));
    expect(saved.pluginOverrides.ext).toEqual({ enabled: false, options: { keep: "me" } });
    expect(saved.pluginOverrides.fresh).toEqual({ enabled: true });
  });
});
