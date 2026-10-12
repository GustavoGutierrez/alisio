/**
 * Forja's JavaScript engine inside the Application (spec D6, §8.1, §8.5, FJ-AC-19, FJ-AC-20):
 * `js_run` replaces `execute` only while the engine is enabled, the routing rule exists only with
 * `js_run`, the prompt otherwise stays as it was, and a real call works end to end.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider } from "@alisio/sdk";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRoutingRule,
  ROUTING_RULE_MAX_CHARS,
} from "../packages/core/src/forge/routing-rule.ts";
import { createApplication } from "../packages/core/src/index.ts";
import { FORGE_GUIDE_DESCRIPTION_MAX_CHARS } from "../packages/core/src/tools/forge-guide.ts";
import { JS_RUN_DESCRIPTION } from "../packages/core/src/tools/js-run.ts";

let root: string;
let workspace: string;
const apps: Array<{ close(): Promise<void> }> = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "alisio-forge-wiring-"));
  workspace = join(root, "ws");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const silent: ModelProvider = {
  id: "fake-provider",
  model: "fake-model",
  async *stream() {
    yield { type: "completed", message: { role: "assistant", text: "ok", calls: [] } };
  },
};

async function app(enabled: boolean, options: Parameters<typeof createApplication>[0] = {}) {
  await writeFile(
    join(root, "config", "config.json"),
    JSON.stringify({ forge: { javascript: { enabled }, scratch: { root: join(root, "tmp") } } }),
  );
  const created = await createApplication({
    cwd: workspace,
    db: join(root, "state", "sessions.sqlite"),
    noHerdr: true,
    provider: silent,
    ...options,
  });
  apps.push(created);
  return created;
}
const names = (a: Awaited<ReturnType<typeof app>>) => a.registry.list().map((t) => t.name);

describe("tool registration (D6)", () => {
  it("enabled: js_run is offered and execute is gone, with no fallback to it", async () => {
    const a = await app(true);
    expect(names(a)).toContain("js_run");
    expect(names(a)).toContain("forge_guide");
    expect(names(a)).not.toContain("execute");
    expect(a.forge.runtime.jsReady).toBe(true);
    const status = await a.forge.runtime.status();
    expect(status.engines[0]).toMatchObject({ id: "javascript-quickjs", ready: true });
    expect(status.javascript.wasmSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("disabled: execute is registered exactly as before and js_run does not exist", async () => {
    const a = await app(false);
    expect(names(a)).toContain("execute");
    expect(names(a)).not.toContain("js_run");
    expect(names(a)).not.toContain("forge_guide");
    expect(a.forge.runtime.jsReady).toBe(false);
    const status = await a.forge.runtime.status();
    expect(status.engines[0]).toMatchObject({
      ready: false,
      reason: expect.stringMatching(/disabled by config/),
    });
  });

  it("--read-only still offers js_run (it composes reads) and never execute", async () => {
    const a = await app(true, { readOnly: true });
    expect(names(a)).toContain("js_run");
    expect(names(a)).not.toContain("execute");
  });
});

describe("the system prompt", () => {
  it("FJ-AC-19: with the engine off the prompt carries nothing of Forja", async () => {
    const a = await app(false);
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const prompt = await a.context.instructions(session);
    expect(prompt).not.toMatch(/js_run|Code execution|scratchpad/i);
  });

  it("with the engine on, the only change is the routing rule, with this session's scratchpad", async () => {
    const off = await app(false);
    const offSession = off.store.create(workspace, "fake-provider", "fake-model").id;
    const baseline = await off.context.instructions(offSession);
    const on = await app(true);
    const session = on.store.create(workspace, "fake-provider", "fake-model").id;
    const prompt = await on.context.instructions(session);
    const pad = await on.forge.scratchpad?.(session);
    expect(pad).toBeTruthy();
    expect(prompt).toContain(pad);
    const ruleText = buildRoutingRule({
      javascript: true,
      python: names(on).includes("python_run"),
      guide: names(on).includes("forge_guide"),
      scratchpad: pad,
    });
    expect(prompt.replace(`\n\n${ruleText}`, "")).toBe(baseline);
    expect(ruleText.length).toBeLessThanOrEqual(ROUTING_RULE_MAX_CHARS);
    expect(ruleText).toMatch(/js_run/);
    expect(ruleText).toMatch(/python_run/);
    expect(ruleText).toMatch(/forge_guide/);
  });

  it("FJ-AC-19: with the engine off there is no forge_guide, no js_run and no execute rule either", async () => {
    const a = await app(false);
    expect(names(a)).not.toContain("forge_guide");
    expect(names(a)).not.toContain("js_run");
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    expect(await a.context.instructions(session)).not.toMatch(/forge_guide/);
  });

  it("forge.guides.enabled=false keeps js_run but registers no forge_guide and no pointer to it", async () => {
    await writeFile(
      join(root, "config", "config.json"),
      JSON.stringify({
        forge: {
          javascript: { enabled: true },
          guides: { enabled: false },
          scratch: { root: join(root, "tmp") },
        },
      }),
    );
    const a = await createApplication({
      cwd: workspace,
      db: join(root, "state", "sessions.sqlite"),
      noHerdr: true,
      provider: silent,
    });
    apps.push(a);
    expect(names(a)).toContain("js_run");
    expect(names(a)).not.toContain("forge_guide");
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    expect(await a.context.instructions(session)).not.toMatch(/forge_guide/);
  });

  it("FJ-AC-20: the prompt plus the tool descriptions Forja adds grow by at most 1200 characters", async () => {
    const off = await app(false);
    const offSession = off.store.create(workspace, "fake-provider", "fake-model").id;
    const baseline = (await off.context.instructions(offSession)).length;
    const on = await app(true);
    const session = on.store.create(workspace, "fake-provider", "fake-model").id;
    const growth = (await on.context.instructions(session)).length - baseline;
    const guide = on.registry.list().find((tool) => tool.name === "forge_guide");
    expect(guide?.description.length).toBeLessThanOrEqual(FORGE_GUIDE_DESCRIPTION_MAX_CHARS);
    expect(JS_RUN_DESCRIPTION.length).toBeLessThanOrEqual(400);
    // The rule, js_run's and forge_guide's descriptions are what Forja adds (spec §8.5). `execute`
    // leaves, so its description is not counted against the budget.
    const total = growth + JS_RUN_DESCRIPTION.length + (guide?.description.length ?? 0);
    expect(total).toBeLessThanOrEqual(1200);
  });
});

describe("end to end", () => {
  it("runs a script that reads a workspace file through the gate, journals it and keeps the state", async () => {
    await writeFile(join(workspace, "data.json"), JSON.stringify({ items: [3, 4, 5] }));
    const a = await app(true);
    const session = a.store.create(workspace, "fake-provider", "fake-model").id;
    const first = await a.runner.runToolCall(session, "js_run", {
      code: `const file = await tools.call('read_file', { path: 'data.json' });
             state.set('seen', true);
             return JSON.stringify(file).length > 10;`,
    });
    expect(first.result.isError ?? false).toBe(false);
    const text = (r: typeof first) =>
      r.result.content.map((p) => (p.type === "text" ? p.text : "")).join("");
    expect(text(first)).toMatch(/value: true/);
    const [row] = a.forge.journal.listByRoot(session);
    expect(row).toMatchObject({ status: "succeeded", engine: "javascript-quickjs" });
    expect(a.forge.journal.calls(row?.id ?? "")[0]).toMatchObject({
      toolName: "read_file",
      effect: "read",
      status: "succeeded",
    });
    const second = await a.runner.runToolCall(session, "js_run", {
      code: "return state.get('seen');",
    });
    expect(text(second)).toMatch(/value: true/);
  });
});
