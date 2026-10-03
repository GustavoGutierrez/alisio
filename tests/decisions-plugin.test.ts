import { definePlugin, type Plugin, type PluginAPI } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import {
  DecisionMetrics,
  DecisionRegistry,
  DecisionService,
  type DecisionsConfig,
} from "../packages/core/src/decisions/index.ts";
import { PluginHost } from "../packages/core/src/plugins/host.ts";
import { ProviderRegistry } from "../packages/core/src/providers/registry.ts";
import { fakeProvider, sampleRequest } from "./fixtures/decision-provider.ts";

const state = () => ({ getState: () => undefined, setState: () => {} });
const newHost = () => new PluginHost(new ToolRegistry(), state(), {}, new ProviderRegistry());
const plugin = (id: string, setup: Plugin["setup"], extra: Partial<Plugin> = {}): Plugin =>
  definePlugin({ id, version: "1.0.0", apiVersion: 1, setup, ...extra });

function withDecisions(config: Partial<DecisionsConfig> = {}) {
  const registry = new DecisionRegistry();
  const cfg: DecisionsConfig = {
    enabled: true,
    provider: "fake",
    timeoutMs: 1500,
    minConfidence: 0.6,
    telemetry: true,
    ...config,
  };
  const service = new DecisionService({
    registry,
    config: () => cfg,
    metrics: new DecisionMetrics(),
  });
  const host = newHost();
  host.setDecisions({ registry, service });
  return { host, registry, service, cfg };
}

describe("api.decisions in PluginHost", () => {
  it("a plugin registers a provider and tryDecide uses it", async () => {
    const { host, service } = withDecisions();
    const provider = fakeProvider();
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.decisions?.registerProvider(provider);
      }),
      ".",
    );
    expect(api?.decisions?.available()).toBe(true);
    expect(api?.decisions?.activeProvider()).toEqual({ id: "fake", name: "Fake provider" });
    const response = await api?.decisions?.tryDecide(sampleRequest());
    expect(response?.provider).toBe("fake");
    expect(provider.decideCalls).toHaveLength(1);
    expect(service.available()).toBe(true);
  });

  it("registering does not activate: without configuration the provider is unused", async () => {
    const { host } = withDecisions({ provider: null });
    const provider = fakeProvider();
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.decisions?.registerProvider(provider);
      }),
      ".",
    );
    expect(api?.decisions?.available()).toBe(false);
    expect(await api?.decisions?.tryDecide(sampleRequest())).toBeNull();
    expect(provider.decideCalls).toHaveLength(0);
  });

  it("unloading the plugin removes its provider and available() turns false", async () => {
    const { host, registry } = withDecisions();
    let api: PluginAPI | undefined;
    await host.activate(
      plugin("engine", (a) => {
        api = a;
        a.decisions?.registerProvider(fakeProvider());
      }),
      ".",
    );
    expect(api?.decisions?.available()).toBe(true);
    await host.close();
    expect(registry.get("fake")).toBeUndefined();
    expect(api?.decisions?.available()).toBe(false);
  });

  it("a failed setup undoes the registration", async () => {
    const { host, registry } = withDecisions();
    await expect(
      host.activate(
        plugin("engine", (a) => {
          a.decisions?.registerProvider(fakeProvider());
          throw new Error("setup failed");
        }),
        ".",
      ),
    ).rejects.toThrow("setup failed");
    expect(registry.get("fake")).toBeUndefined();
  });

  it("rejects a duplicate provider id from another plugin", async () => {
    const { host } = withDecisions();
    await host.activate(
      plugin("a", (api) => void api.decisions?.registerProvider(fakeProvider())),
      ".",
    );
    await expect(
      host.activate(
        plugin("b", (api) => void api.decisions?.registerProvider(fakeProvider())),
        ".",
      ),
    ).rejects.toThrow(/Duplicate decision provider/);
  });

  it("is feature-detectable: absent when the host has no decision service", async () => {
    const host = newHost();
    let seen: unknown = "unset";
    await host.activate(
      plugin("old-core-friendly", (api) => {
        seen = api.decisions;
        // A plugin written for the feature keeps working when it is absent.
        api.decisions?.registerProvider(fakeProvider());
      }),
      ".",
    );
    expect(seen).toBeUndefined();
  });

  it("accepts the 'decisions' plugin category", async () => {
    const { host } = withDecisions();
    await expect(
      host.activate(
        plugin("cat", () => {}, { categories: ["decisions"] }),
        ".",
      ),
    ).resolves.toBeUndefined();
    await expect(
      host.activate(
        plugin("bad", () => {}, { categories: ["nope" as never] }),
        ".",
      ),
    ).rejects.toThrow();
  });
});
