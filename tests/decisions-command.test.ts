/**
 * `/decisions` (spec §9.1): a read-only core command on every surface. The text comes from the
 * `CommandCatalog` handler, which reads `host.decisions` (the application's service + metrics).
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  CommandCatalog,
  type CommandHost,
} from "../packages/core/src/commands/catalog.ts";
import {
  DecisionMetrics,
  DecisionRegistry,
  DecisionService,
  type DecisionsConfig,
} from "../packages/core/src/decisions/index.ts";
import { fakeProvider } from "./fixtures/decision-provider.ts";

function setup(config: Partial<DecisionsConfig> = {}, withHost = true) {
  const registry = new DecisionRegistry();
  const cfg: DecisionsConfig = {
    enabled: true,
    provider: null,
    timeoutMs: 1500,
    minConfidence: 0.6,
    telemetry: true,
    ...config,
  };
  const metrics = new DecisionMetrics(() => Date.UTC(2026, 9, 3, 12, 4, 31));
  const service = new DecisionService({ registry, config: () => cfg, metrics });
  const host = {
    workspace: "/w",
    provider: { id: "p" },
    config: { agents: {}, decisions: cfg },
    ...(withHost ? { decisions: { service, metrics } } : {}),
  } as unknown as CommandHost;
  const run = async () =>
    (await new CommandCatalog(host).execute("decisions", "", { sessionId: "s1" })).text ?? "";
  return { registry, cfg, metrics, service, run };
}

const completed = (latencyMs: number, pack = "smart-dashboard-v1") => ({
  status: "completed" as const,
  decisionId: "smart-dashboard-v1",
  pack: { id: pack, version: 1 },
  provider: "fake",
  latencyMs,
  decisionCount: 1,
  rejectedCount: 0,
  confidenceMin: 0.9,
});

describe("/decisions descriptor", () => {
  it("is a core built-in on every surface", () => {
    const d = BUILTIN_COMMANDS.find((c) => c.name === "decisions");
    expect(d).toMatchObject({ execution: "core", surfaces: ["tui", "web", "api"] });
    expect(new CommandCatalog().list("web").some((c) => c.name === "decisions")).toBe(true);
  });
});

describe("/decisions output", () => {
  it("reports no provider configured", async () => {
    const text = await setup().run();
    expect(text).toContain("**Decision Intelligence**");
    expect(text).toContain("Status: enabled · no provider configured (set decisions.provider)");
    expect(text).toContain("Timeout: 1500 ms · min confidence: 0.6 · telemetry: on");
    expect(text).not.toContain("Capabilities");
  });

  it("reports a configured id that is not registered", async () => {
    const text = await setup({ provider: "x" }).run();
    expect(text).toContain('Status: enabled · provider "x" is not registered');
  });

  it("reports disabled", async () => {
    const text = await setup({ enabled: false, telemetry: false }).run();
    expect(text).toContain("Status: disabled");
    expect(text).toContain("telemetry: off");
  });

  it("shows an active ready provider with capabilities and circuit", async () => {
    const s = setup({ provider: "fake" });
    s.registry.register("t", fakeProvider({ name: "Fake local" }));
    const text = await s.run();
    expect(text).toContain("Status: enabled · provider: fake (Fake local) · health: ready");
    expect(text).toContain("Capabilities: select, boolean, ordinal");
    expect(text).toContain("Circuit: closed");
    expect(text).toContain("No decisions yet in this process.");
  });

  it("shows a starting provider with its detail", async () => {
    const s = setup({ provider: "fake" });
    const provider = fakeProvider();
    provider.health = async () => ({ status: "starting", detail: "loading model" });
    s.registry.register("t", provider);
    expect(await s.run()).toContain("health: starting (loading model)");
  });

  it("shows an unavailable provider when health throws", async () => {
    const s = setup({ provider: "fake" });
    const provider = fakeProvider();
    provider.health = async () => {
      throw new Error("connection refused");
    };
    s.registry.register("t", provider);
    expect(await s.run()).toContain("health: unavailable (connection refused)");
  });

  it("shows health unknown when the provider has no health()", async () => {
    const s = setup({ provider: "fake" });
    const provider = fakeProvider();
    delete (provider as { health?: unknown }).health;
    s.registry.register("t", provider);
    expect(await s.run()).toContain("health: unknown");
  });

  it("shows the last activate/deactivate failure", async () => {
    const s = setup({ provider: "fake" });
    const provider = fakeProvider();
    Object.assign(provider, {
      activate: async () => {
        throw new Error("port busy");
      },
    });
    s.registry.register("t", provider);
    s.service.syncActive();
    await new Promise((r) => setTimeout(r, 10));
    expect(await s.run()).toContain("Lifecycle error: activate of fake failed: port busy");
  });

  it("shows session and process metrics, latency, last fallback and packs", async () => {
    const s = setup({ provider: "fake" });
    s.registry.register("t", fakeProvider());
    s.metrics.record(completed(40), "s1");
    s.metrics.record(completed(60), "s1");
    s.metrics.record(completed(80), "other");
    s.metrics.record(
      {
        status: "fallback",
        decisionId: "smart-dashboard-v1",
        pack: { id: "smart-dashboard-v1", version: 1 },
        provider: "fake",
        latencyMs: 1500,
        reason: "timeout",
      },
      "s1",
    );
    const text = await s.run();
    expect(text).toContain("| This session | 3 | 2 | 1 |");
    expect(text).toContain("| Process | 4 | 3 | 1 |");
    expect(text).toContain("Latency: session avg 50 ms · p95 60 ms; process avg 60 ms · p95 80 ms");
    expect(text).toContain("Last fallback: timeout (smart-dashboard-v1) at 12:04:31 UTC");
    expect(text).toContain("Packs: smart-dashboard-v1 (3)");
    // Each summary line is its own list item, so Markdown does not merge them into one paragraph.
    expect(text).toContain("\n- Latency: ");
    expect(text).toContain("\n- Last fallback: ");
    expect(text).toContain("\n- Packs: ");
  });

  it("works without an application host", async () => {
    const s = setup({}, false);
    expect(await s.run()).toContain("Decision Intelligence is unavailable here");
  });
});
