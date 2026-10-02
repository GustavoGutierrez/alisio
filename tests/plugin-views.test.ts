import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  definePlugin,
  type Plugin,
  type PluginAPI,
  type ViewDefinition,
  ViewParamsError,
} from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { PluginHost, ViewRunError } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import { openDatabase } from "../packages/core/src/runtime/sqlite.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";

const state = () => ({ getState: () => undefined, setState: () => {} });
const newHost = () => new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
const plugin = (id: string, setup: Plugin["setup"]): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup });
/** The error a promise rejects with (fails the test when it resolves). */
const rejection = async (promise: Promise<unknown>): Promise<ViewRunError> => {
  try {
    await promise;
  } catch (error) {
    return error as ViewRunError;
  }
  throw new Error("expected the promise to reject");
};

const context = { sessionId: "s1", workspace: "/w", signal: new AbortController().signal };

describe("plugin data views: registration", () => {
  it("registers named views per plugin and lists them without the handler", async () => {
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        api.views?.register({
          id: "items",
          description: "Items of the session",
          params: {
            type: "object",
            properties: { limit: { type: "integer", minimum: 1, maximum: 5 } },
          },
          handler: () => ({ ok: true }),
        });
      }),
      ".",
    );
    expect(host.viewsOf("demo")).toEqual([
      expect.objectContaining({ id: "items", description: "Items of the session" }),
    ]);
    expect(host.viewsOf("demo")[0]).not.toHaveProperty("handler");
    expect(host.viewsOf("other")).toEqual([]);
  });

  it("rejects invalid ids, empty descriptions, bad handlers and unsafe schemas", async () => {
    const attempts: Array<() => void> = [];
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        const base = { description: "d", handler: () => 1 };
        attempts.push(
          () => api.views?.register({ ...base, id: "Bad Id" }),
          () => api.views?.register({ ...base, id: "ok", description: " " }),
          () => api.views?.register({ id: "ok", description: "d", handler: "x" as never }),
          () =>
            api.views?.register({
              ...base,
              id: "ok",
              params: { type: "object", properties: { a: { $ref: "#/x" } } },
            }),
          () =>
            api.views?.register({
              ...base,
              id: "ok",
              params: { type: "object", properties: { a: { type: "array" } } },
            }),
          () => api.views?.register({ ...base, id: "ok", params: { type: "string" } }),
        );
      }),
      ".",
    );
    for (const attempt of attempts) expect(attempt).toThrow();
    expect(host.viewsOf("demo")).toEqual([]);
  });

  it("refuses a duplicate view id inside one plugin and allows the same id in another", async () => {
    const host = newHost();
    const reg = (api: PluginAPI) =>
      api.views?.register({ id: "same", description: "d", handler: () => 1 });
    await host.activate(
      plugin("one", (api) => {
        reg(api);
        expect(() => reg(api)).toThrow(/Duplicate view/);
      }),
      ".",
    );
    await host.activate(
      plugin("two", (api) => void reg(api)),
      ".",
    );
    expect(host.viewsOf("two")).toHaveLength(1);
  });

  it("drops the views of a plugin whose setup fails (registrations are rolled back)", async () => {
    const host = newHost();
    await expect(
      host.activate(
        plugin("broken", (api) => {
          api.views?.register({ id: "v", description: "d", handler: () => 1 });
          throw new Error("boom");
        }),
        ".",
      ),
    ).rejects.toThrow("boom");
    expect(host.viewsOf("broken")).toEqual([]);
  });

  it("returns an unregister function", async () => {
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        const off = api.views?.register({ id: "v", description: "d", handler: () => 1 });
        off?.();
      }),
      ".",
    );
    expect(host.viewsOf("demo")).toEqual([]);
  });
});

describe("plugin data views: running", () => {
  const withView = async (handler: ViewDefinition["handler"]) => {
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        api.views?.register({
          id: "v",
          description: "d",
          params: {
            type: "object",
            properties: {
              n: { type: "integer", minimum: 1, maximum: 5, default: 2 },
              q: { type: "string", maxLength: 5 },
              flag: { type: "boolean" },
            },
          },
          handler,
        });
      }),
      ".",
    );
    return host;
  };

  it("coerces query strings through the declared schema and passes the session context", async () => {
    const seen: unknown[] = [];
    const host = await withView((params: unknown, ctx: unknown) => {
      seen.push(params, ctx);
      return { fine: true };
    });
    await expect(host.runView("demo", "v", { n: "4", flag: "true" }, context)).resolves.toEqual({
      fine: true,
    });
    expect(seen[0]).toEqual({ n: 4, flag: true });
    expect(seen[1]).toMatchObject({ sessionId: "s1", workspace: "/w" });
  });

  it("applies schema defaults", async () => {
    let params: unknown;
    const host = await withView((p: unknown) => {
      params = p;
      return null;
    });
    await host.runView("demo", "v", {}, context);
    expect(params).toEqual({ n: 2 });
  });

  it.each([
    ["an out-of-range value", { n: "9" }],
    ["a non-numeric value", { n: "abc" }],
    ["an over-long string", { q: "toolong" }],
    ["an unknown key", { extra: "1" }],
  ])("rejects %s with fields only, never values", async (_label, query) => {
    const host = await withView(() => 1);
    const error = await rejection(host.runView("demo", "v", query, context));
    expect(error).toBeInstanceOf(ViewRunError);
    expect(error.code).toBe("invalid_params");
    expect(JSON.stringify(error.fields)).not.toMatch(/toolong|abc|"9"/);
  });

  it("maps ViewParamsError from the handler to invalid_params and other errors to failed", async () => {
    const bad = await withView(() => {
      throw new ViewParamsError("Malformed cursor");
    });
    await expect(bad.runView("demo", "v", {}, context)).rejects.toMatchObject({
      code: "invalid_params",
      message: "Malformed cursor",
    });
    const broken = await withView(() => {
      throw new Error("secret detail");
    });
    const error = await rejection(broken.runView("demo", "v", {}, context));
    expect(error.code).toBe("failed");
    expect(error.message).not.toContain("secret detail");
    expect(error.cause).toBeInstanceOf(Error);
  });

  it("reports unknown plugins and views as not_found", async () => {
    const host = await withView(() => 1);
    await expect(host.runView("demo", "nope", {}, context)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(host.runView("ghost", "v", {}, context)).rejects.toMatchObject({
      code: "not_found",
    });
  });
});

describe("plugin data views: older core without api.views", () => {
  it("lets the memory plugin set up when the host API has no views", async () => {
    const noop = () => () => {};
    // A host API that predates `api.views`: it has every other member the plugin uses.
    const api = {
      tools: { register: noop },
      commands: { register: noop },
      context: { register: noop },
      compaction: { register: noop },
      session: { onStart: noop, onEnd: noop },
      ui: { status: () => {} },
      storage: { sqlite: (path: string) => openDatabase(path) },
    };
    expect("views" in api).toBe(false);
    const root = await mkdtemp(join(tmpdir(), "alisio-views-old-"));
    try {
      const memory = createMemoryPlugin({}, { workspace: root, stateHome: root, configDir: root });
      await expect(memory.setup(api as unknown as PluginAPI)).resolves.toBeUndefined();
      await memory.dispose?.();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
