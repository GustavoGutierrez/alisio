import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type BuiltinPlugin,
  createApplication,
  ProviderSettingsStore,
  resolveProviderModel,
} from "@alisio/core";
import { definePlugin, type Message, type ModelProvider } from "@alisio/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BUILTIN_PLUGINS } from "../packages/cli/src/builtin.ts";
import { parseAgentDefinition } from "../packages/plugin-subagents/src/definitions.ts";

const catalogs = [
  {
    profile: "alpha-work",
    provider: "alpha",
    title: "Alpha",
    models: [{ id: "shared" }, { id: "alpha-only" }],
    unavailable: false,
  },
  {
    profile: "beta-work",
    provider: "beta",
    title: "Beta",
    models: [{ id: "shared" }, { id: "beta-only" }],
    unavailable: false,
  },
];

describe("provider model references", () => {
  it("resolves canonical and unique bare references and fails closed", () => {
    expect(resolveProviderModel(catalogs, "alpha/shared")).toMatchObject({
      provider: "alpha",
      model: { id: "shared" },
    });
    expect(resolveProviderModel(catalogs, "beta-only").reference).toBe("beta/beta-only");
    expect(() => resolveProviderModel(catalogs, "shared")).toThrow(
      /ambiguous.*alpha\/shared.*beta\/shared/i,
    );
    expect(() => resolveProviderModel(catalogs, "missing")).toThrow(
      /not available.*Available provider\/model choices/i,
    );
  });

  it("reports unavailable catalogs without leaking their cause", () => {
    expect(() =>
      resolveProviderModel([{ ...catalogs[0]!, models: [], unavailable: true }], "alpha/shared"),
    ).toThrow('Configured provider "alpha" is unavailable');
  });

  it("keeps provider/model syntax in agent definitions", () => {
    expect(
      parseAgentDefinition(
        "---\nname: routed\ndescription: routed agent\nmodel: beta/beta-only\n---\nWork.",
        { source: "test" },
      ).definition?.model,
    ).toBe("beta/beta-only");
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("session-scoped routing", () => {
  it("routes parent and child concurrently, isolates continuation, and supports the task selector", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-routing-"));
    vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
    vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
    const seen: Array<{
      provider: string;
      session: string;
      model: string | undefined;
      continuation: unknown[];
    }> = [];
    const builtin = (id: "alpha" | "beta", models: string[]): BuiltinPlugin => ({
      id,
      description: id,
      create: () =>
        definePlugin({
          id,
          version: "1.0.0",
          apiVersion: 1,
          setup(api) {
            api.providers.register({
              id,
              name: id.toUpperCase(),
              fields: [],
              create(request) {
                const provider: ModelProvider = {
                  id,
                  model: String(request.profile.model ?? ""),
                  async listModels() {
                    return models.map((model) => ({ id: model }));
                  },
                  async *stream(call) {
                    seen.push({
                      provider: id,
                      session: call.sessionId ?? "",
                      model: call.model,
                      continuation: call.messages.flatMap((message) =>
                        message.role === "assistant" ? (message.providerData ?? []) : [],
                      ),
                    });
                    yield {
                      type: "completed",
                      message: {
                        role: "assistant",
                        text: `${id}:${call.model}`,
                        calls: [],
                        providerData: [{ owner: id }],
                      },
                    } as const;
                  },
                };
                return provider;
              },
            });
          },
        }),
    });
    const settings = new ProviderSettingsStore(join(root, "config"));
    await settings.saveActive("beta-work", { provider: "beta", values: {}, model: "shared" }, {});
    await settings.saveActive("alpha-work", { provider: "alpha", values: {}, model: "shared" }, {});
    const subagents = BUILTIN_PLUGINS.find((plugin) => plugin.id === "subagents");
    if (!subagents) throw new Error("subagents builtin missing");
    const app = await createApplication({
      cwd: root,
      db: join(root, "sessions.sqlite"),
      builtins: [
        builtin("alpha", ["shared", "alpha-only"]),
        builtin("beta", ["shared", "beta-only"]),
        subagents,
      ],
      noHerdr: true,
    });
    let resumedChild = "";
    try {
      expect((await app.listAvailableModels()).map((entry) => entry.reference)).toEqual([
        "alpha/alpha-only",
        "alpha/shared",
        "beta/beta-only",
        "beta/shared",
      ]);
      expect((await app.resolveModel("beta-only")).reference).toBe("beta/beta-only");
      const parent = await app.createSession("alpha/alpha-only");
      const child = await app.plugins.sessions.create({
        parentId: parent.id,
        title: "routed",
        agent: "test",
        model: "beta/beta-only",
      });
      resumedChild = child.id;
      await Promise.all([
        app.runner.run(parent.id, "parent one"),
        app.plugins.sessions.run(child.id, "child one"),
      ]);
      await app.runner.run(parent.id, "parent two");
      await app.plugins.sessions.run(child.id, "child two");
      expect(app.store.get(parent.id)).toMatchObject({ provider: "alpha", model: "alpha-only" });
      expect(app.store.get(child.id)).toMatchObject({ provider: "beta", model: "beta-only" });
      expect(
        new Set(seen.filter((call) => call.provider === "alpha").map((call) => call.session)),
      ).toEqual(new Set([parent.id]));
      expect(
        new Set(seen.filter((call) => call.provider === "beta").map((call) => call.session)),
      ).toEqual(new Set([child.id]));
      expect(
        seen.find((call) => call.provider === "alpha" && call.continuation.length)?.continuation,
      ).toEqual([{ owner: "alpha" }]);
      expect(
        seen.find((call) => call.provider === "beta" && call.continuation.length)?.continuation,
      ).toEqual([{ owner: "beta" }]);

      const task = app.registry.get("task");
      await task.execute(
        {
          description: "routed task",
          prompt: "child task",
          subagent_type: "general",
          model: "beta/beta-only",
        },
        {
          signal: AbortSignal.timeout(2_000),
          workspace: app.workspace,
          session: parent.id,
          emit() {},
        },
      );
      const routedTask = app.store.children(parent.id).at(-1);
      expect(routedTask).toMatchObject({ provider: "beta", model: "beta-only" });
      expect(app.store.get(parent.id)).toMatchObject({ provider: "alpha", model: "alpha-only" });
    } finally {
      await app.close();
    }
    const resumed = await createApplication({
      cwd: root,
      db: join(root, "sessions.sqlite"),
      builtins: [
        builtin("alpha", ["shared", "alpha-only"]),
        builtin("beta", ["shared", "beta-only"]),
        subagents,
      ],
      noHerdr: true,
    });
    try {
      expect((await resumed.plugins.sessions.run(resumedChild, "child after restart")).text).toBe(
        "beta:beta-only",
      );
      expect(seen.at(-1)).toMatchObject({ provider: "beta", session: resumedChild });
    } finally {
      await resumed.close();
    }
  });
});
