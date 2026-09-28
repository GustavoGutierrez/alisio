import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { definePlugin, type Plugin } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type BuiltinPlugin,
  createApplication,
  PluginHost,
  ProviderRegistry,
  setProjectPluginEnabled,
  ToolRegistry,
} from "../packages/core/src/index.ts";

afterEach(() => vi.unstubAllEnvs());

const state = () => ({ getState: () => undefined, setState: () => {} });
const builtin = (id: string, provider = false): BuiltinPlugin => ({
  id,
  name: id === "notes" ? "Project Notes" : "Safe Model",
  description: id === "notes" ? "Adds project note commands" : "Provides a test model catalog",
  ...(provider ? { categories: ["model-provider" as const] } : {}),
  create: () =>
    definePlugin({
      id,
      name: id === "notes" ? "Project Notes" : "Safe Model",
      description: id === "notes" ? "Adds project note commands" : "Provides a test model catalog",
      ...(provider ? { categories: ["model-provider" as const] } : {}),
      version: "1.0.0",
      apiVersion: 1,
      setup(api) {
        if (provider)
          api.providers.register({
            id,
            name: "Safe Model",
            fields: [],
            create: () => ({
              id,
              model: "safe-model",
              async *stream() {
                yield {
                  type: "completed" as const,
                  message: { role: "assistant" as const, text: "", calls: [] },
                };
              },
            }),
          });
      },
    }),
});

async function project(config: Record<string, unknown>) {
  const root = await mkdtemp(join(tmpdir(), "alisio-plugins-manager-"));
  await mkdir(join(root, ".alisio"), { recursive: true });
  await writeFile(join(root, ".alisio", "config.json"), `${JSON.stringify(config, null, 2)}\n`);
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "global-config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  return root;
}

describe("project plugin manager", () => {
  it("lists active and inactive built-ins and configured external plugins with metadata", async () => {
    const root = await project({
      schemaVersion: 1,
      plugins: ["./active.mjs", "./disabled.mjs"],
      builtinPlugins: { notes: { enabled: false } },
      pluginOverrides: { "external-disabled": { enabled: false } },
    });
    await writeFile(
      join(root, ".alisio", "active.mjs"),
      `export default {id:"external-active",name:"External Active",description:"Active project extension",version:"1.0.0",apiVersion:1,categories:[],setup(){}};`,
    );
    await writeFile(
      join(root, ".alisio", "disabled.mjs"),
      `export default {id:"external-disabled",name:"External Disabled",description:"Disabled project extension",version:"1.0.0",apiVersion:1,categories:[],setup(){}};`,
    );
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: [builtin("notes"), builtin("safe-provider", true)],
      noHerdr: true,
    });
    try {
      expect(app.pluginCatalog()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ name: "Project Notes", builtin: true, status: "inactive" }),
          expect.objectContaining({
            name: "Safe Model",
            builtin: true,
            status: "active",
            categories: ["model-provider"],
          }),
          expect.objectContaining({ name: "External Active", builtin: false, status: "active" }),
          expect.objectContaining({ name: "External Disabled", status: "inactive" }),
        ]),
      );
      expect(JSON.stringify(app.pluginCatalog())).not.toContain(root);
    } finally {
      await app.close();
    }
  });

  it("persists a restart-required override and preserves unrelated project configuration", async () => {
    const root = await project({
      schemaVersion: 1,
      skills: ["./skills"],
      customFutureField: { keep: true },
      builtinPlugins: { notes: { customOption: "keep" } },
    });
    await setProjectPluginEnabled({
      workspace: root,
      id: "notes",
      enabled: false,
      builtin: true,
      trusted: true,
    });
    const raw = JSON.parse(await readFile(join(root, ".alisio", "config.json"), "utf8"));
    expect(raw).toMatchObject({
      skills: ["./skills"],
      customFutureField: { keep: true },
      builtinPlugins: { notes: { customOption: "keep", enabled: false } },
    });
    await expect(
      setProjectPluginEnabled({
        workspace: root,
        id: "other",
        enabled: true,
        builtin: false,
        trusted: false,
      }),
    ).rejects.toThrow("Trust this project");
  });

  it("rolls back partial activation and reports a safe failure", async () => {
    const root = await project({ schemaVersion: 1, plugins: ["./broken.mjs"] });
    await writeFile(
      join(root, ".alisio", "broken.mjs"),
      `export default {id:"broken",name:"Broken",description:"Fails safely",version:"1.0.0",apiVersion:1,setup(api){api.commands.register("leaked",async()=>"bad");throw new Error("secret /absolute/path");}};`,
    );
    const app = await createApplication({ cwd: root, trustProject: true, noHerdr: true });
    try {
      expect(app.plugins.commands.has("broken:leaked")).toBe(false);
      expect(app.pluginCatalog()).toContainEqual(
        expect.objectContaining({
          id: "broken",
          status: "failed",
          diagnostic: "Activation failed; registrations were rolled back",
        }),
      );
      expect(JSON.stringify(app.pluginCatalog())).not.toMatch(/absolute|secret/);
    } finally {
      await app.close();
    }
  });

  it("keeps runtime registrations active and truthfully marks persisted changes for restart", async () => {
    const root = await project({ schemaVersion: 1 });
    const available = [builtin("notes"), builtin("extra-provider", true)];
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: available,
      noHerdr: true,
    });
    try {
      const changed = await app.setPluginEnabled("extra-provider", false);
      expect(changed.status).toBe("restart-required");
      const reverted = await app.setPluginEnabled("extra-provider", true);
      expect(reverted).toMatchObject({ enabled: true, status: "active" });
      expect(reverted.diagnostic).toBeUndefined();
      const changedAgain = await app.setPluginEnabled("extra-provider", false);
      expect(changedAgain.status).toBe("restart-required");
      expect(app.plugins.metadata().map((entry) => entry.id)).toContain("extra-provider");
      expect(
        app.plugins.metadata().filter((entry) => entry.categories?.includes("model-provider")),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
    const restarted = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: available,
      noHerdr: true,
    });
    try {
      expect(restarted.pluginCatalog()).toContainEqual(
        expect.objectContaining({ id: "extra-provider", status: "inactive" }),
      );
      expect(
        restarted.plugins
          .metadata()
          .filter((entry) => entry.categories?.includes("model-provider")),
      ).toHaveLength(0);
    } finally {
      await restarted.close();
    }
  });

  it("clears restart-required when an initially disabled plugin returns to disabled", async () => {
    const root = await project({
      schemaVersion: 1,
      builtinPlugins: { notes: { enabled: false } },
    });
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: [builtin("notes")],
      noHerdr: true,
    });
    try {
      expect(await app.setPluginEnabled("notes", true)).toMatchObject({
        enabled: true,
        status: "restart-required",
      });
      const reverted = await app.setPluginEnabled("notes", false);
      expect(reverted).toMatchObject({ enabled: false, status: "inactive" });
      expect(reverted.diagnostic).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("blocks disabling a provider retained by a routed session after the global provider changes", async () => {
    const root = await project({ schemaVersion: 1, provider: { model: "safe-model" } });
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: [
        { ...builtin("first-provider", true), defaultProvider: true },
        builtin("second-provider", true),
      ],
      noHerdr: true,
    });
    try {
      await app.createSession();
      await app.activateProvider("second-provider", {}, {}, "safe-model");
      await expect(app.setPluginEnabled("first-provider", false)).rejects.toThrow(
        "live routed session still uses this provider plugin",
      );
    } finally {
      await app.close();
    }
  });

  it("blocks disabling the active model provider and plugins with live session resources", async () => {
    const root = await project({ schemaVersion: 1, provider: { model: "safe-model" } });
    const live: BuiltinPlugin = {
      ...builtin("live"),
      create: () =>
        definePlugin({
          id: "live",
          name: "Live",
          description: "Owns a session hook",
          version: "1.0.0",
          apiVersion: 1,
          setup(api) {
            api.session.onEnd(async () => {});
          },
        }),
    };
    const app = await createApplication({
      cwd: root,
      trustProject: true,
      builtins: [{ ...builtin("safe-provider", true), defaultProvider: true }, live],
      noHerdr: true,
    });
    try {
      await expect(app.setPluginEnabled("safe-provider", false)).rejects.toThrow(
        "Switch to a model from another provider",
      );
      await expect(app.setPluginEnabled("live", false, { liveSession: true })).rejects.toThrow(
        "owns resources used by the current session",
      );
    } finally {
      await app.close();
    }
  });

  it("PluginHost activation cleanup removes every registration on failure", async () => {
    const tools = new ToolRegistry();
    const providers = new ProviderRegistry();
    const host = new PluginHost(tools, state(), {}, providers);
    await expect(
      host.activate(
        definePlugin({
          id: "rollback",
          version: "1.0.0",
          apiVersion: 1,
          setup(api) {
            api.commands.register("test", async () => "");
            api.tools.register({
              name: "test",
              description: "test",
              inputSchema: { type: "object", properties: {}, additionalProperties: false },
              async execute() {
                return { content: [] };
              },
            });
            api.ui.status("test", "test");
            throw new Error("fail");
          },
        }),
        ".",
      ),
    ).rejects.toThrow("fail");
    expect(host.commands.size).toBe(0);
    expect(host.status.size).toBe(0);
    expect(tools.list()).toEqual([]);
  });
});

describe("plugin category validation", () => {
  const categoryHost = () =>
    new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());

  const categoryPlugin = (
    id: string,
    categories: Plugin["categories"],
    setup: Plugin["setup"] = () => {},
  ): Plugin => ({ id, version: "1.0.0", apiVersion: 1, categories, setup });

  it("activates a plugin that declares the methodology-harness category", async () => {
    const host = categoryHost();
    await host.activate(categoryPlugin("methodology", ["methodology-harness"]), ".");
    expect(host.metadata()).toEqual([
      {
        id: "methodology",
        version: "1.0.0",
        builtin: false,
        categories: ["methodology-harness"],
      },
    ]);
  });

  it("activates a plugin that declares both accepted categories", async () => {
    const host = categoryHost();
    await host.activate(categoryPlugin("both", ["methodology-harness", "model-provider"]), ".");
    expect(host.metadata()).toContainEqual(
      expect.objectContaining({
        id: "both",
        categories: ["methodology-harness", "model-provider"],
      }),
    );
  });

  it("rejects an unknown category instead of accepting free-form strings", async () => {
    const host = categoryHost();
    const invalid = {
      id: "unknown-category",
      version: "1.0.0",
      apiVersion: 1,
      categories: ["not-a-category"],
      setup() {},
    } as unknown as Plugin;
    await expect(host.activate(invalid, ".")).rejects.toThrow();
    expect(host.metadata()).toEqual([]);
  });

  it("keeps deriving model-provider from provider registrations", async () => {
    const host = categoryHost();
    await host.activate(
      categoryPlugin("provider", ["methodology-harness"], (api) => {
        api.providers.register({
          id: "provider",
          name: "Provider",
          fields: [],
          create: () => ({ id: "provider", model: "m", async *stream() {} }),
        });
      }),
      ".",
    );
    expect(host.metadata()).toEqual([
      {
        id: "provider",
        version: "1.0.0",
        builtin: false,
        categories: ["methodology-harness", "model-provider"],
      },
    ]);
  });
});
