import { definePlugin, type Plugin, type PluginAppDefinition } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { PluginAppError } from "../packages/core/src/plugins/apps.ts";
import { PluginHost } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";

const newHost = () =>
  new PluginHost(
    new ToolRegistry(),
    { getState: () => undefined, setState: () => {} },
    {},
    new ProviderRegistry(),
  );
const plugin = (id: string, setup: Plugin["setup"]): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup });
const app = (extra: Partial<PluginAppDefinition> = {}): PluginAppDefinition => ({
  id: "studio",
  label: { en: "Studio", es: "Estudio" },
  html: () => "<p>hi</p>",
  ...extra,
});
const context = { sessionId: "s1", workspace: "/w" };
const readOnly = { write: false, process: false, external: false };
const rejection = async (promise: Promise<unknown>): Promise<PluginAppError> => {
  try {
    await promise;
  } catch (error) {
    return error as PluginAppError;
  }
  throw new Error("expected the promise to reject");
};

describe("plugin apps: registration", () => {
  it("lists the apps of a plugin with per-locale labels and no handlers", async () => {
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        api.apps?.register(app());
        api.apps?.register(app({ id: "plain", label: "Plain" }));
      }),
      ".",
    );
    expect(host.apps.appsOf("demo")).toEqual([
      { plugin: "demo", id: "plain", label: { en: "Plain" } },
      { plugin: "demo", id: "studio", label: { en: "Studio", es: "Estudio" } },
    ]);
    expect(host.apps.appsOf("other")).toEqual([]);
    expect(await host.apps.html("demo", "studio")).toBe("<p>hi</p>");
  });

  it("rejects bad ids, labels, html, action names, effects and unsafe schemas", async () => {
    const host = newHost();
    const attempts: Array<() => void> = [];
    await host.activate(
      plugin("demo", (api) => {
        const schema = { type: "object" };
        const ok = { effect: "read" as const, inputSchema: schema, handler: () => 1 };
        attempts.push(
          () => api.apps?.register(app({ id: "Bad Id" })),
          () => api.apps?.register(app({ label: " " })),
          () => api.apps?.register(app({ label: {} })),
          () => api.apps?.register(app({ html: "x" as never })),
          () => api.apps?.register(app({ busy: "x" as never })),
          () => api.apps?.register(app({ actions: { "bad name": ok } })),
          () =>
            api.apps?.register(app({ actions: { go: { ...ok, effect: "external" as never } } })),
          () => api.apps?.register(app({ actions: { go: { ...ok, handler: "x" as never } } })),
          () =>
            api.apps?.register(
              app({ actions: { go: { ...ok, inputSchema: { type: "string" } } } }),
            ),
          () =>
            api.apps?.register(
              app({
                actions: {
                  go: {
                    ...ok,
                    inputSchema: { type: "object", properties: { a: { $ref: "#/x" } } },
                  },
                },
              }),
            ),
        );
      }),
      ".",
    );
    for (const attempt of attempts) expect(attempt).toThrow();
    expect(host.apps.appsOf("demo")).toEqual([]);
  });

  it("rejects a duplicate id within a plugin but allows the same id in another plugin", async () => {
    const host = newHost();
    await host.activate(
      plugin("one", (api) => void api.apps?.register(app())),
      ".",
    );
    await host.activate(
      plugin("two", (api) => void api.apps?.register(app())),
      ".",
    );
    expect(host.apps.appsOf("one")).toHaveLength(1);
    expect(host.apps.appsOf("two")).toHaveLength(1);
    await expect(
      host.activate(
        plugin("three", (api) => {
          api.apps?.register(app());
          api.apps?.register(app());
        }),
        ".",
      ),
    ).rejects.toThrow(/Duplicate app/);
  });

  it("unregister removes the app and disposes it exactly once", async () => {
    const host = newHost();
    let disposed = 0;
    let off = () => {};
    await host.activate(
      plugin("demo", (api) => {
        off = api.apps?.register(app({ dispose: () => disposed++ })) ?? off;
      }),
      ".",
    );
    off();
    off();
    expect(host.apps.appsOf("demo")).toEqual([]);
    await host.close();
    expect(disposed).toBe(1);
  });

  it("rolls back and disposes the apps of a plugin whose setup fails", async () => {
    const host = newHost();
    let disposed = 0;
    await expect(
      host.activate(
        plugin("demo", (api) => {
          api.apps?.register(app({ dispose: () => disposed++ }));
          throw new Error("boom");
        }),
        ".",
      ),
    ).rejects.toThrow("boom");
    expect(host.apps.appsOf("demo")).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("removes and disposes apps when the host closes, even if dispose throws", async () => {
    const host = newHost();
    let disposed = 0;
    await host.activate(
      plugin("demo", (api) => {
        api.apps?.register(app({ dispose: () => disposed++ }));
        api.apps?.register(
          app({
            id: "other",
            dispose: () => {
              throw new Error("nope");
            },
          }),
        );
      }),
      ".",
    );
    await host.close();
    expect(host.apps.appsOf("demo")).toEqual([]);
    expect(disposed).toBe(1);
  });

  it("reports busy while any app has background work", async () => {
    const host = newHost();
    let working = false;
    await host.activate(
      plugin("demo", (api) => {
        api.apps?.register(app({ busy: () => working }));
        api.apps?.register(
          app({
            id: "broken",
            busy: () => {
              throw new Error("x");
            },
          }),
        );
      }),
      ".",
    );
    expect(host.apps.busy()).toBe(false);
    working = true;
    expect(host.apps.busy()).toBe(true);
  });
});

describe("plugin apps: actions", () => {
  const withAction = async (
    action: Partial<NonNullable<PluginAppDefinition["actions"]>[string]> = {},
  ) => {
    const host = newHost();
    await host.activate(
      plugin("demo", (api) => {
        api.apps?.register(
          app({
            actions: {
              echo: {
                effect: "read",
                inputSchema: {
                  type: "object",
                  properties: { n: { type: "integer" } },
                  required: ["n"],
                  additionalProperties: false,
                },
                handler: (input, ctx) => ({
                  input,
                  session: ctx.sessionId,
                  key: ctx.idempotencyKey,
                }),
                ...action,
              },
            },
          }),
        );
      }),
      ".",
    );
    return host;
  };

  it("validates the input, runs the handler and passes the context", async () => {
    const host = await withAction();
    const result = await host.apps.run(
      "demo",
      "studio",
      "echo",
      { n: 2 },
      { ...context, idempotencyKey: "k1" },
      { policy: readOnly },
    );
    expect(result).toEqual({ input: { n: 2 }, session: "s1", key: "k1" });
    const bad = await rejection(
      host.apps.run("demo", "studio", "echo", { n: "secret-value" }, context, { policy: readOnly }),
    );
    expect(bad.code).toBe("invalid_input");
    expect(bad.message).not.toContain("secret-value");
  });

  it("answers not_found for unknown plugins, apps and actions", async () => {
    const host = await withAction();
    for (const [p, a, n] of [
      ["ghost", "studio", "echo"],
      ["demo", "ghost", "echo"],
      ["demo", "studio", "ghost"],
    ] as const)
      expect(
        (await rejection(host.apps.run(p, a, n, {}, context, { policy: readOnly }))).code,
      ).toBe("not_found");
  });

  it("rejects effects the session policy does not grant, without asking", async () => {
    const host = await withAction({ effect: "write" });
    const denied = await rejection(
      host.apps.run("demo", "studio", "echo", { n: 1 }, context, { policy: readOnly }),
    );
    expect(denied.code).toBe("not_permitted");
    const allowed = await host.apps.run("demo", "studio", "echo", { n: 1 }, context, {
      policy: { ...readOnly, write: true },
    });
    expect(allowed).toMatchObject({ session: "s1" });
    const process = await withAction({ effect: "process" });
    expect(
      (
        await rejection(
          process.apps.run("demo", "studio", "echo", { n: 1 }, context, {
            policy: { ...readOnly, write: true },
          }),
        )
      ).code,
    ).toBe("not_permitted");
  });

  it("times out, aborts the signal and hides handler internals on failure", async () => {
    let aborted = false;
    const slow = await withAction({
      handler: (_input, ctx) =>
        new Promise(() => {
          ctx.signal.addEventListener("abort", () => {
            aborted = true;
          });
        }),
    });
    const timeout = await rejection(
      slow.apps.run("demo", "studio", "echo", { n: 1 }, context, {
        policy: readOnly,
        timeoutMs: 20,
      }),
    );
    expect(timeout.code).toBe("timeout");
    expect(aborted).toBe(true);
    const broken = await withAction({
      handler: () => {
        throw new Error("SELECT secret FROM private_table");
      },
    });
    const failed = await rejection(
      broken.apps.run("demo", "studio", "echo", { n: 1 }, context, { policy: readOnly }),
    );
    expect(failed.code).toBe("failed");
    expect(failed.message).not.toMatch(/secret|private_table/);
  });
});
