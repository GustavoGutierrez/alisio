import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AskQuestionsRequest,
  type DecisionActivationResult,
  definePlugin,
  type ModelProvider,
  type PluginAPI,
} from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type BuiltinPlugin, createApplication } from "../packages/core/src/index.ts";
import { fakeProvider } from "./fixtures/decision-provider.ts";

const silent: ModelProvider = {
  id: "silent",
  defaultModel: "m",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
} as never;

const PROMPT =
  "Plugin engine wants to become the decision provider. Dashboards will send your request goal and column names, never values, to it. Activate it?";

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-activation-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const globalFile = () => join(root, "config", "config.json");

async function start(
  options: {
    global?: string | object;
    project?: object;
    answer?: string | "none" | "headless";
  } = {},
) {
  if (options.global !== undefined)
    await writeFile(
      globalFile(),
      typeof options.global === "string" ? options.global : JSON.stringify(options.global, null, 2),
    );
  if (options.project)
    await writeFile(join(workspace, ".alisio", "config.json"), JSON.stringify(options.project));
  const calls: string[] = [];
  const provider = fakeProvider({ id: "engine" });
  Object.assign(provider, {
    activate: async () => {
      calls.push("activate");
    },
  });
  let api: PluginAPI | undefined;
  const builtins: BuiltinPlugin[] = [
    {
      id: "engine",
      description: "engine",
      create: () =>
        definePlugin({
          id: "engine",
          version: "1.0.0",
          apiVersion: 1,
          setup: (a) => {
            api = a;
            a.decisions?.registerProvider(provider);
          },
        }),
    },
    {
      id: "other",
      description: "other",
      create: () =>
        definePlugin({
          id: "other",
          version: "1.0.0",
          apiVersion: 1,
          setup: (a) => {
            a.decisions?.registerProvider(fakeProvider({ id: "foreign" }));
          },
        }),
    },
  ];
  const app = await createApplication({
    cwd: workspace,
    db: join(root, "state", "sessions.sqlite"),
    noHerdr: true,
    provider: silent,
    builtins,
  });
  apps.push(app);
  const asked: AskQuestionsRequest[] = [];
  if (options.answer !== "headless")
    app.plugins.setInteractiveUI({
      select: async () => undefined,
      askQuestions: async (request) => {
        asked.push(request);
        const id = request.questions[0]?.id as string;
        return { [id]: options.answer === "none" ? undefined : (options.answer ?? "yes") };
      },
      open: () => false,
    });
  const activate = (id = "engine", options?: unknown): Promise<DecisionActivationResult> => {
    const fn = api?.decisions?.activate as
      | ((id: string, options?: unknown) => Promise<DecisionActivationResult>)
      | undefined;
    if (!fn) throw new Error("activate is not offered");
    return fn.call(api?.decisions, id, options);
  };
  return { app, activate, asked, calls };
}

const raw = () => readFile(globalFile(), "utf8");

describe("api.decisions.activate", () => {
  it("accepting persists only decisions.provider, activates live and asks once", async () => {
    const original = `${JSON.stringify(
      {
        schemaVersion: 1,
        tui: { paddingX: 2 },
        decisions: { timeoutMs: 900 },
        limits: { maxTurns: 7 },
      },
      null,
      2,
    )}\n`;
    const { app, activate, asked, calls } = await start({ global: original });
    const result = await activate();
    expect(result).toEqual({ status: "activated", active: "engine" });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.questions[0]?.question).toBe(PROMPT);
    expect(asked[0]?.questions[0]?.options.map((o) => o.value)).toEqual(["yes", "no"]);
    expect(JSON.parse(await raw())).toEqual({
      schemaVersion: 1,
      tui: { paddingX: 2 },
      decisions: { timeoutMs: 900, provider: "engine" },
      limits: { maxTurns: 7 },
    });
    expect((await raw()).endsWith("}\n")).toBe(true);
    expect(app.config.decisions.provider).toBe("engine");
    await vi.waitFor(() => expect(calls).toEqual(["activate"]));
    expect(app.decisions.service.activeProvider()?.id).toBe("engine");
  });

  it("works without an existing global file", async () => {
    const { activate } = await start();
    expect((await activate()).status).toBe("activated");
    expect(JSON.parse(await raw())).toEqual({
      schemaVersion: 1,
      decisions: { provider: "engine" },
    });
  });

  it("declining or skipping changes nothing", async () => {
    for (const answer of ["no", "none"]) {
      const original = `${JSON.stringify({ tui: { paddingX: 2 } }, null, 2)}\n`;
      const { app, activate, asked, calls } = await start({ global: original, answer });
      expect(await activate()).toEqual({ status: "declined" });
      expect(asked).toHaveLength(1);
      expect(await raw()).toBe(original);
      expect(app.config.decisions.provider).toBeNull();
      expect(calls).toEqual([]);
    }
  });

  it("headless (no interactive UI) needs confirmation and changes nothing", async () => {
    const original = `${JSON.stringify({ tui: { paddingX: 2 } }, null, 2)}\n`;
    const { app, activate, calls } = await start({ global: original, answer: "headless" });
    expect((await activate()).status).toBe("needs_confirmation");
    expect(await raw()).toBe(original);
    expect(app.config.decisions.provider).toBeNull();
    expect(calls).toEqual([]);
  });

  it("already_active leaves the file byte-identical and never asks", async () => {
    const original = '{"decisions":{"provider":"engine"}}';
    const { activate, asked } = await start({ global: original });
    expect(await activate()).toEqual({ status: "already_active", active: "engine" });
    expect(asked).toHaveLength(0);
    expect(await raw()).toBe(original);
  });

  it("other_provider_active never overwrites a user's choice and never asks", async () => {
    const original = '{"decisions":{"provider":"foreign"}}';
    const { app, activate, asked } = await start({ global: original });
    const result = await activate();
    expect(result.status).toBe("other_provider_active");
    expect(result.active).toBe("foreign");
    expect(asked).toHaveLength(0);
    expect(await raw()).toBe(original);
    expect(app.config.decisions.provider).toBe("foreign");
  });

  it("decisions.enabled=false reports disabled without asking or writing", async () => {
    const original = '{"decisions":{"enabled":false}}';
    const { activate, asked } = await start({ global: original });
    expect((await activate()).status).toBe("disabled");
    expect(asked).toHaveLength(0);
    expect(await raw()).toBe(original);
  });

  it("refuses ids that this plugin did not register, without asking", async () => {
    const { activate, asked } = await start();
    expect((await activate("foreign")).status).toBe("unavailable");
    expect((await activate("missing")).status).toBe("unavailable");
    expect(asked).toHaveLength(0);
  });

  it("a write failure is unavailable, sanitized, and leaves the live state untouched", async () => {
    const { app, activate, calls } = await start();
    await writeFile(globalFile(), "{ not json");
    const result = await activate();
    expect(result.status).toBe("unavailable");
    expect(result.message).toBeTypeOf("string");
    expect(result.message).not.toContain(root);
    expect(app.config.decisions.provider).toBeNull();
    expect(app.decisions.service.available()).toBe(false);
    expect(calls).toEqual([]);
    expect(await raw()).toBe("{ not json");
  });

  it("a project config cannot be the target: the global file is written, the project file untouched", async () => {
    const project = { decisions: { provider: "foreign" } };
    const { app, activate } = await start({ project });
    expect(app.config.decisions.provider).toBeNull();
    expect((await activate()).status).toBe("activated");
    expect(JSON.parse(await raw()).decisions).toEqual({ provider: "engine" });
    expect(await readFile(join(workspace, ".alisio", "config.json"), "utf8")).toBe(
      JSON.stringify(project),
    );
  });

  it("recommend: true marks Yes (recommended) first and keeps the rest of the question", async () => {
    const { activate, asked } = await start();
    expect((await activate("engine", { recommend: true })).status).toBe("activated");
    const question = asked[0]?.questions[0];
    expect(question?.question).toBe(PROMPT);
    expect(question?.options.map((o) => [o.value, o.label, !!o.recommended])).toEqual([
      ["yes", "Yes", true],
      ["no", "No", false],
    ]);
    expect(question?.options.map((o) => o.description)).toEqual([
      "Save it in your global configuration.",
      "Keep decisions unchanged.",
    ]);
  });

  it("without the hint, or with an invalid one, No stays the recommended option", async () => {
    for (const options of [
      undefined,
      {},
      { recommend: false },
      { recommend: "true" },
      1,
      "x",
      null,
      [true],
    ]) {
      const { activate, asked } = await start({ answer: "no" });
      await activate("engine", options);
      expect(asked[0]?.questions[0]?.options.map((o) => [o.label, !!o.recommended])).toEqual([
        ["Yes", false],
        ["No", true],
      ]);
      await apps.pop()?.close();
    }
  });

  it("recommend: true still follows the answer: no or skip declines, headless needs confirmation", async () => {
    for (const answer of ["no", "none"]) {
      const { activate, calls } = await start({ answer });
      expect(await activate("engine", { recommend: true })).toEqual({ status: "declined" });
      expect(calls).toEqual([]);
    }
    const { activate, asked } = await start({ answer: "headless" });
    expect((await activate("engine", { recommend: true })).status).toBe("needs_confirmation");
    expect(asked).toEqual([]);
  });

  it("recommend: true never skips the other rules", async () => {
    const own = await start({ global: { decisions: { provider: "engine" } } });
    expect((await own.activate("engine", { recommend: true })).status).toBe("already_active");
    const other = await start({ global: { decisions: { provider: "x" } } });
    expect((await other.activate("engine", { recommend: true })).status).toBe(
      "other_provider_active",
    );
    expect(own.asked).toEqual([]);
    expect(other.asked).toEqual([]);
  });

  it("is feature-detected: absent on a host without the decision service wiring", async () => {
    const { PluginHost } = await import("../packages/core/src/plugins/host.ts");
    const { ToolRegistry } = await import("../packages/core/src/core/registry.ts");
    const { ProviderRegistry } = await import("../packages/core/src/providers/registry.ts");
    const { DecisionMetrics, DecisionRegistry, DecisionService } = await import(
      "../packages/core/src/decisions/index.ts"
    );
    const registry = new DecisionRegistry();
    const service = new DecisionService({
      registry,
      config: () => ({
        enabled: true,
        provider: null,
        timeoutMs: 1500,
        minConfidence: 0.6,
        telemetry: true,
      }),
      metrics: new DecisionMetrics(),
    });
    const host = new PluginHost(
      new ToolRegistry(),
      { getState: () => undefined, setState: () => {} },
      {},
      new ProviderRegistry(),
    );
    host.setDecisions({ registry, service });
    let api: PluginAPI | undefined;
    await host.activate(
      definePlugin({ id: "x", version: "1.0.0", apiVersion: 1, setup: (a) => void (api = a) }),
      ".",
    );
    expect(api?.decisions).toBeDefined();
    expect(api?.decisions?.activate).toBeUndefined();
  });
});
