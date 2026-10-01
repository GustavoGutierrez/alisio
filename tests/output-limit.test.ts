import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, ProviderEvent, RunEvent } from "@alisio/sdk";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_OUTPUT_TOKENS,
  describeOutputLimitSource,
  MAX_AUTO_OUTPUT_TOKENS,
  resolveMaxOutputTokens,
} from "../packages/core/src/core/output-limit.ts";
import { ToolRegistry } from "../packages/core/src/core/registry.ts";
import { AgentRunner } from "../packages/core/src/core/runner.ts";
import { ProjectContext } from "../packages/core/src/resources/context.ts";
import { SQLiteStore } from "../packages/core/src/runtime/store.ts";

describe("resolveMaxOutputTokens", () => {
  it("lets an explicit value win, even above what the model declares", () => {
    expect(resolveMaxOutputTokens({ explicit: 20_000, declared: 8_000 })).toEqual({
      value: 20_000,
      source: "user",
    });
    expect(resolveMaxOutputTokens({ explicit: 500_000, declared: 8_000 }).value).toBe(500_000);
  });

  it("uses the model's declared maximum below the ceiling", () => {
    expect(resolveMaxOutputTokens({ declared: 40_000 })).toEqual({
      value: 40_000,
      source: "model",
    });
    expect(resolveMaxOutputTokens({ declared: 8_192 })).toEqual({ value: 8_192, source: "model" });
  });

  it("caps a derived value at the ceiling", () => {
    expect(MAX_AUTO_OUTPUT_TOKENS).toBe(65_536);
    expect(resolveMaxOutputTokens({ declared: 393_216 })).toEqual({
      value: MAX_AUTO_OUTPUT_TOKENS,
      source: "model",
    });
  });

  it("falls back to 16384 without a declaration, and ignores invalid values", () => {
    expect(DEFAULT_MAX_OUTPUT_TOKENS).toBe(16_384);
    expect(resolveMaxOutputTokens({})).toEqual({ value: 16_384, source: "default" });
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY, 0.5]) {
      expect(resolveMaxOutputTokens({ declared: bad })).toEqual({
        value: 16_384,
        source: "default",
      });
      expect(resolveMaxOutputTokens({ explicit: bad, declared: 40_000 })).toEqual({
        value: 40_000,
        source: "model",
      });
    }
    expect(resolveMaxOutputTokens({ fallback: 4_096 }).value).toBe(4_096);
  });

  it("names the source in plain words", () => {
    expect(describeOutputLimitSource("user")).toBe("set by you");
    expect(describeOutputLimitSource("model")).toBe("from the model catalog");
    expect(describeOutputLimitSource("default")).toBe("default");
  });
});

async function harness(
  settings: {
    maxOutputTokens?: number;
    declared?: Record<string, number>;
    asyncCatalog?: boolean;
  } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "alisio-outlimit-"));
  const store = new SQLiteStore(join(root, "store.sqlite"));
  const seen: Array<{ model?: string; maxOutputTokens: number }> = [];
  const events: RunEvent[] = [];
  const provider = {
    id: "fake",
    model: "model-a",
    async *stream(request: {
      model?: string;
      maxOutputTokens: number;
    }): AsyncGenerator<ProviderEvent> {
      seen.push({ model: request.model, maxOutputTokens: request.maxOutputTokens });
      yield {
        type: "completed",
        message: { role: "assistant", text: "ok", calls: [] } satisfies Extract<
          Message,
          { role: "assistant" }
        >,
      };
    },
  };
  const runner = new AgentRunner({
    provider: provider as never,
    registry: new ToolRegistry(),
    store,
    context: new ProjectContext(root),
    workspace: root,
    policy: { write: false, process: false, external: false },
    onEvent: (event) => events.push(event),
    fallbackMaxOutputTokens: DEFAULT_MAX_OUTPUT_TOKENS,
    modelOutputLimit: (model) =>
      settings.asyncCatalog
        ? new Promise((resolve) => setTimeout(() => resolve(settings.declared?.[model]), 5))
        : settings.declared?.[model],
    ...(settings.maxOutputTokens !== undefined
      ? { maxOutputTokens: settings.maxOutputTokens }
      : {}),
  });
  const session = store.create(root, "fake", "model-a");
  return {
    runner,
    store,
    seen,
    events,
    session,
    async close() {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

describe("effective output budget of a request", () => {
  it("sends the model's declared limit when the user set none", async () => {
    const fx = await harness({ declared: { "model-a": 40_000 } });
    try {
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.seen.map((r) => r.maxOutputTokens)).toEqual([40_000]);
    } finally {
      await fx.close();
    }
  });

  it("waits for a catalog that is still loading before the first request", async () => {
    const fx = await harness({ declared: { "model-a": 30_000 }, asyncCatalog: true });
    try {
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.seen[0]?.maxOutputTokens).toBe(30_000);
    } finally {
      await fx.close();
    }
  });

  it("uses the explicit value even when the model declares another", async () => {
    const fx = await harness({ maxOutputTokens: 20_000, declared: { "model-a": 40_000 } });
    try {
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.seen.map((r) => r.maxOutputTokens)).toEqual([20_000]);
    } finally {
      await fx.close();
    }
  });

  it("a per-run option beats the runner setting and the catalog", async () => {
    const fx = await harness({ maxOutputTokens: 20_000, declared: { "model-a": 40_000 } });
    try {
      await fx.runner.run(fx.session.id, "hi", undefined, { maxOutputTokens: 7_000 });
      expect(fx.seen[0]?.maxOutputTokens).toBe(7_000);
    } finally {
      await fx.close();
    }
  });

  it("falls back to 16384 for a model without a declaration", async () => {
    const fx = await harness({ declared: { other: 1_000 } });
    try {
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.seen[0]?.maxOutputTokens).toBe(16_384);
    } finally {
      await fx.close();
    }
  });

  it("recomputes the budget for the model of each request after a model switch", async () => {
    const fx = await harness({ declared: { "model-a": 40_000, "model-b": 393_216 } });
    try {
      await fx.runner.run(fx.session.id, "one");
      fx.runner.setModel(fx.session.id, "model-b");
      await fx.runner.run(fx.session.id, "two");
      fx.runner.setModel(fx.session.id, "model-c");
      await fx.runner.run(fx.session.id, "three");
      expect(fx.seen).toEqual([
        { model: "model-a", maxOutputTokens: 40_000 },
        { model: "model-b", maxOutputTokens: 65_536 },
        { model: "model-c", maxOutputTokens: 16_384 },
      ]);
    } finally {
      await fx.close();
    }
  });

  it("clearing the explicit value (applySettings undefined) returns to the catalog limit", async () => {
    const fx = await harness({ maxOutputTokens: 20_000, declared: { "model-a": 40_000 } });
    try {
      fx.runner.applySettings({ maxOutputTokens: undefined });
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.seen[0]?.maxOutputTokens).toBe(40_000);
    } finally {
      await fx.close();
    }
  });

  it("reports the effective value and its source when a response is cut", async () => {
    const fx = await harness({ declared: { "model-a": 40_000 } });
    try {
      // Replace the provider behavior: a truncated answer with usable text.
      const original = fx.runner as unknown as { options: { provider: { stream: unknown } } };
      original.options.provider.stream = async function* (): AsyncGenerator<ProviderEvent> {
        yield {
          type: "completed",
          message: { role: "assistant", text: "partial", calls: [], truncated: true },
        };
      };
      await fx.runner.run(fx.session.id, "hi");
      expect(fx.events.find((e) => e.type === "response_truncated")?.data).toMatchObject({
        maxOutputTokens: 40_000,
        source: "model",
      });
    } finally {
      await fx.close();
    }
  });
});

describe("output budget through the application (catalog from the provider's /models)", () => {
  const appWith = async (limits?: { maxOutputTokens: number }) => {
    const { createApplication } = await import("../packages/core/src/application.ts");
    const cwd = await mkdtemp(join(tmpdir(), "alisio-outlimit-app-"));
    const previous = { home: process.env.ALISIO_CONFIG_HOME, state: process.env.ALISIO_STATE_HOME };
    process.env.ALISIO_CONFIG_HOME = join(cwd, "config");
    process.env.ALISIO_STATE_HOME = join(cwd, "state");
    if (limits) {
      await mkdir(join(cwd, "config"), { recursive: true });
      await writeFile(join(cwd, "config", "config.json"), JSON.stringify({ limits }));
    }
    const requests: number[] = [];
    // What the DeepSeek plugin does: `max_output_tokens` of GET /models becomes ModelInfo.
    const catalog = [
      { id: "flash", max_output_tokens: 393_216 },
      { id: "small", max_output_tokens: 8_000 },
      { id: "undeclared" },
    ];
    const app = await createApplication({
      cwd,
      noHerdr: true,
      provider: {
        id: "fixture",
        model: "flash",
        async listModels() {
          return catalog.map((m) => ({
            id: m.id,
            ...(m.max_output_tokens ? { maxOutputTokens: m.max_output_tokens } : {}),
          }));
        },
        async *stream(request: { maxOutputTokens: number }): AsyncGenerator<ProviderEvent> {
          requests.push(request.maxOutputTokens);
          yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
        },
      } as never,
    });
    return {
      app,
      requests,
      async close() {
        await app.close();
        process.env.ALISIO_CONFIG_HOME = previous.home as string;
        process.env.ALISIO_STATE_HOME = previous.state as string;
        await rm(cwd, { recursive: true, force: true });
      },
    };
  };

  it("sends min(declared, 65536) for the active model, and follows a model switch", async () => {
    const fx = await appWith();
    try {
      const session = await fx.app.createSession();
      await fx.app.runner.run(session.id, "one");
      fx.app.runner.setModel(session.id, "small");
      await fx.app.runner.run(session.id, "two");
      fx.app.runner.setModel(session.id, "undeclared");
      await fx.app.runner.run(session.id, "three");
      expect(fx.requests).toEqual([65_536, 8_000, 16_384]);
    } finally {
      await fx.close();
    }
  });

  it("an explicit limits.maxOutputTokens wins over the catalog", async () => {
    const fx = await appWith({ maxOutputTokens: 20_000 });
    try {
      const session = await fx.app.createSession();
      await fx.app.runner.run(session.id, "one");
      expect(fx.requests).toEqual([20_000]);
    } finally {
      await fx.close();
    }
  });
});
