/**
 * Plugin creator delivery gates: a creator build only packages a plugin that the REAL host can
 * activate from the installed copy of the package, whose tools compile, dispose cleanly, activate
 * twice, survive one smoke call each and are covered by the plugin's own tests.
 */
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  gateCommand,
  gateEnvironment,
  PLUGIN_CREATOR_SKILL_FILES,
  PluginCreatorProjects,
  sampleInput,
  sanitizePluginDiagnostic,
} from "../packages/core/src/index.ts";

let home: string;
let projects: PluginCreatorProjects;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alisio-creator-gates-"));
  projects = new PluginCreatorProjects({
    home,
    sdkRange: "^0.11.0",
    sdkVersion: "0.11.7",
    gateTimeoutMs: 8_000,
  });
});

async function edit(id: string, rel: string, text: string) {
  const file = join(projects.dir(id), rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

/** A project whose plugin is `body` (the plugin object literal) with one test naming `tools`. */
async function pluginProject(body: string, tools: string[] = [], extra = ""): Promise<string> {
  const project = await projects.create({ request: "Track the expenses of the month" });
  await edit(
    project.id,
    "src/index.js",
    [
      'import { createRequire } from "node:module";',
      'const { version } = createRequire(import.meta.url)("../package.json");',
      `export const PLUGIN_ID = ${JSON.stringify(project.pluginId)};`,
      "const text = (t, isError = false) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });",
      extra,
      `export default { id: PLUGIN_ID, version, apiVersion: 1, name: "Expenses", ${body} };`,
      "",
    ].join("\n"),
  );
  // Tests that load the plugin and name every tool, without a harness (so only the gates judge).
  await edit(
    project.id,
    "test/plugin.test.js",
    [
      'import test from "node:test";',
      'import assert from "node:assert/strict";',
      'import plugin from "../src/index.js";',
      ...(tools.length ? tools : ["loads"]).map(
        (name) => `test(${JSON.stringify(name)}, () => assert.equal(plugin.apiVersion, 1));`,
      ),
      "",
    ].join("\n"),
  );
  return project.id;
}

const codes = (issues: Array<{ code: string; severity: string }>) =>
  issues.filter((i) => i.severity === "error").map((i) => i.code);

const tool = (name: string, schema: string, execute: string) =>
  `api.tools.register({ name: ${JSON.stringify(name)}, description: "d", effect: "write", inputSchema: ${schema}, async execute(input) { ${execute} } });`;

describe("plugin creator gates: real host activation", () => {
  it("blocks a tool schema the host's strict Ajv rejects, with the ajv reason and no home paths", async () => {
    const id = await pluginProject(
      `setup(api) { ${tool(
        "add_expense",
        '{ type: "object", properties: { amount: { type: ["number", "string"] } }, required: ["amount"], additionalProperties: false }',
        'return text("ok");',
      )} }`,
      ["add_expense"],
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const issue = build.issues.find((i) => i.code === "activation_failed");
    expect(issue?.severity).toBe("error");
    expect(issue?.message).toMatch(/allowUnionTypes/);
    expect(issue?.message).not.toContain(homedir());
    expect(issue?.message).not.toContain(home);
    expect(await projects.packagePath(id)).toBeUndefined();
  });

  it("reports a setup that throws as an activation failure", async () => {
    const id = await pluginProject('setup() { throw new Error("no database here"); }');
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const issue = build.issues.find((i) => i.code === "activation_failed");
    expect(issue?.message).toContain("no database here");
  });

  it("stops a setup that never finishes", async () => {
    const id = await pluginProject(
      "setup() { return new Promise(() => setInterval(() => {}, 1000)); }",
    );
    const slow = new PluginCreatorProjects({ home, sdkVersion: "0.11.7", gateTimeoutMs: 3_000 });
    const build = await slow.build(id);
    expect(build.ok).toBe(false);
    expect(codes(build.issues)).toContain("activation_failed");
    expect(build.issues.find((i) => i.code === "activation_failed")?.message).toMatch(/too long/);
  });

  it("checks dispose and a second activation", async () => {
    const disposing = await pluginProject(
      'setup() {}, dispose() { throw new Error("cannot close"); }',
    );
    expect(codes((await projects.build(disposing)).issues)).toContain("dispose_failed");
    const once = await pluginProject(
      'setup() { if (globalThis.__ran) throw new Error("already set up"); globalThis.__ran = true; }',
    );
    expect(codes((await projects.build(once)).issues)).toContain("reactivate_failed");
  });
});

describe("plugin creator gates: the installed package", () => {
  it("catches a relative import that the package's files list leaves out", async () => {
    const id = await pluginProject(
      'setup(api) { api.tools.register({ name: "hi", description: "d", effect: "read", inputSchema: { type: "object", properties: {}, additionalProperties: false }, async execute() { return text(helper()); } }); }',
      ["hi"],
      'import { helper } from "./helper.js";',
    );
    await edit(id, "src/helper.js", 'export const helper = () => "hi";\n');
    const pkg = JSON.parse(await readFile(join(projects.dir(id), "package.json"), "utf8"));
    await edit(
      id,
      "package.json",
      JSON.stringify({ ...pkg, files: ["src/index.js", "assets", "README.md"] }, null, 2),
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    expect(codes(build.issues)).toContain("import_not_packed");
    expect(codes(build.issues)).toContain("activation_failed");
  });

  it("refuses shipped files that are not plain JavaScript modules", async () => {
    const id = await pluginProject("setup() {}", [], 'import { n } from "./typed.js";');
    await edit(id, "src/typed.js", "export const n: number = 1;\n");
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    expect(codes(build.issues)).toContain("syntax_error");
  });
});

describe("plugin creator gates: smoke calls and test coverage", () => {
  const schema =
    '{ type: "object", properties: { title: { type: "string", minLength: 2 }, n: { type: "integer", minimum: 3 } }, required: ["title", "n"], additionalProperties: false }';

  it("fails a tool that throws or does not return a tool result, accepts a handled error", async () => {
    const id = await pluginProject(
      `setup(api) {
        ${tool("boom", schema, 'throw new Error("crash on " + input.title);')}
        ${tool("plain", schema, 'return "just a string";')}
        ${tool("handled", schema, 'return text("Please give a real title", true);')}
      }`,
      ["boom", "plain", "handled"],
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const smoke = build.issues.filter((i) => i.code === "tool_smoke_failed");
    expect(smoke.map((i) => i.message).join("\n")).toMatch(/boom/);
    expect(smoke.map((i) => i.message).join("\n")).toMatch(/plain/);
    expect(smoke.map((i) => i.message).join("\n")).not.toMatch(/handled/);
  });

  it("requires a test that names every tool", async () => {
    const id = await pluginProject(
      `setup(api) { ${tool("covered", schema, 'return text("ok");')} ${tool("forgotten", schema, 'return text("ok");')} }`,
      ["covered"],
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const untested = build.issues.filter((i) => i.code === "tool_untested");
    expect(untested.map((i) => i.message).join(" ")).toContain("forgotten");
    expect(untested.map((i) => i.message).join(" ")).not.toContain("covered");
  });

  it("passes the starter template through every gate", async () => {
    const project = await projects.create({ request: "Greet people" });
    const build = await projects.build(project.id);
    expect(build.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(build.ok).toBe(true);
    expect(await projects.packagePath(project.id)).toBeDefined();
  });
});

describe("plugin creator gates: helpers", () => {
  it("builds a minimal schema-valid input from required fields only", () => {
    expect(
      sampleInput({
        type: "object",
        properties: {
          title: { type: "string", minLength: 3 },
          kind: { type: "string", enum: ["a", "b"] },
          count: { type: "integer", minimum: 2 },
          price: { type: "number", exclusiveMinimum: 0 },
          ok: { type: "boolean" },
          tags: { type: "array", items: { type: "string" }, minItems: 1 },
          when: { type: "string", default: "2026-01-01" },
          nested: {
            type: "object",
            properties: { a: { type: "string" } },
            required: ["a"],
          },
          optional: { type: "string" },
        },
        required: ["title", "kind", "count", "price", "ok", "tags", "when", "nested"],
      }),
    ).toEqual({
      title: "aaa",
      kind: "a",
      count: 2,
      price: 1,
      ok: false,
      tags: ["a"],
      when: "2026-01-01",
      nested: { a: "a" },
    });
  });

  it("removes absolute paths from diagnostics and bounds them", () => {
    const text = sanitizePluginDiagnostic(
      `Cannot find module '${homedir()}/x/src/a.js' imported from /tmp/alisio-gate-1/plugins/b.js\n\tat C:\\Users\\ana\\c.js and file:///opt/d.js`,
    );
    expect(text).not.toContain(homedir());
    expect(text).not.toMatch(/\/tmp|C:\\|\/opt|\n/);
    expect(text).toContain("<path>");
    expect(sanitizePluginDiagnostic("x".repeat(2_000)).length).toBeLessThanOrEqual(500);
    expect(sanitizePluginDiagnostic('strict mode at "#/properties/monto"')).toBe(
      'strict mode at "#/properties/monto"',
    );
  });

  it("gives the gate child throwaway homes and none of the parent's secrets", async () => {
    vi.stubEnv("ALISIO_SECRET_TOKEN", "do-not-pass");
    try {
      const root = await mkdtemp(join(tmpdir(), "alisio-gate-env-"));
      const env = gateEnvironment(root, {});
      expect(env.ALISIO_PLUGIN_GATE).toBe("1");
      for (const key of ["HOME", "ALISIO_CONFIG_HOME", "ALISIO_STATE_HOME", "TMPDIR"])
        expect(env[key]?.startsWith(root)).toBe(true);
      expect(Object.values(env)).not.toContain("do-not-pass");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe("plugin creator gates: fail closed when the gate cannot run", () => {
  it("refuses the build with gate_unavailable when the runtime cannot be started", async () => {
    const project = await projects.create({ request: "Greet people" });
    const broken = new PluginCreatorProjects({
      home,
      sdkVersion: "0.11.7",
      gateCommand: { command: join(home, "no-such-runtime"), args: [], env: {} },
    });
    const build = await broken.build(project.id);
    expect(build.ok).toBe(false);
    expect(codes(build.issues)).toContain("gate_unavailable");
    expect(await broken.packagePath(project.id)).toBeUndefined();
  });

  it("refuses the build when the gate entry is missing from the packaged runtime", async () => {
    const project = await projects.create({ request: "Greet people" });
    const command = gateCommand({ base: pathToFileURL(join(home, "gone", "x.js")).href });
    const broken = new PluginCreatorProjects({ home, sdkVersion: "0.11.7", gateCommand: command });
    const build = await broken.build(project.id);
    expect(codes(build.issues)).toContain("gate_unavailable");
    expect(build.issues.find((i) => i.code === "gate_unavailable")?.message).not.toContain(home);
  });

  it("refuses the build when the runtime starts but is not a gate (unknown hidden command)", async () => {
    const project = await projects.create({ request: "Greet people" });
    // A runtime that exits at once without the gate handshake (like an old binary).
    const broken = new PluginCreatorProjects({
      home,
      sdkVersion: "0.11.7",
      gateCommand: { command: process.execPath, args: ["-e", "process.exit(1)"], env: {} },
    });
    const build = await broken.build(project.id);
    expect(codes(build.issues)).toContain("gate_unavailable");
    expect(codes(build.issues)).not.toContain("activation_failed");
  });

  it("still blames the plugin when it kills the gate after the handshake", async () => {
    // Only under the real-host gate (the fake-API probe would otherwise catch it first).
    const id = await pluginProject(
      "setup() { if (process.env.ALISIO_PLUGIN_GATE) process.exit(3); }",
    );
    const build = await projects.build(id);
    expect(codes(build.issues)).toContain("activation_failed");
    expect(codes(build.issues)).not.toContain("gate_unavailable");
  });
});

describe("plugin creator gates: how each runtime starts the gate", () => {
  it("re-runs the compiled binary, runs the dist entry with Electron as Node, or the source", () => {
    expect(gateCommand({ compiled: true, execPath: "/opt/alisio" })).toEqual({
      command: "/opt/alisio",
      args: ["__plugin-gate"],
      env: {},
    });
    const desktop = gateCommand({
      compiled: false,
      electron: true,
      execPath: "/opt/Alisio/alisio",
      base: "file:///opt/Alisio/resources/runtime/node_modules/@alisio/core/dist/plugins/creator/gate-runner.js",
    });
    expect(desktop.command).toBe("/opt/Alisio/alisio");
    expect(desktop.env).toEqual({ ELECTRON_RUN_AS_NODE: "1" });
    expect(desktop.args).toEqual([desktop.entry]);
    expect(desktop.entry).toMatch(/resources\/runtime\/.*\/creator\/gate-entry\.js$/);
  });
});

describe("plugin creator gates: plugin apps", () => {
  const page = (script: string, extra = "") =>
    JSON.stringify(
      `<!doctype html><html><head><meta charset="utf-8"><style>:root{color-scheme:light dark}</style></head><body>${extra}${script}</body></html>`,
    );
  const nonced = '<script nonce="__ALISIO_NONCE__">document.body.dataset.ready = "1";</script>';
  /** `api.apps.register` of an app `id` whose html() returns `html` (an expression). */
  const app = (id: string, html: string, actions = "{}") =>
    `api.apps.register({ id: ${JSON.stringify(id)}, label: { en: "List", es: "Lista" }, html: () => ${html}, actions: ${actions} });`;
  const action = (effect: string, schema: string, body: string) =>
    `{ effect: ${JSON.stringify(effect)}, inputSchema: ${schema}, handler(input) { ${body} } }`;
  const empty = '{ type: "object", properties: {}, additionalProperties: false }';

  it("passes a correct app: nonce scripts, data script blocks, actions that answer JSON", async () => {
    const actions = `{ list_items: ${action("read", empty, "return { items: [] };")}, add_item: ${action(
      "write",
      '{ type: "object", properties: { name: { type: "string", minLength: 1 } }, required: ["name"], additionalProperties: false }',
      "return { ok: true, name: input.name };",
    )}, run_report: ${action("process", empty, 'throw new Error("never called by the gate");')} }`;
    const html = page(`<script type="application/json" id="seed">{"items":[]}</script>${nonced}`);
    const id = await pluginProject(`setup(api) { ${app("shopping-list", html, actions)} }`, [
      "list_items",
      "add_item",
      "run_report",
    ]);
    const build = await projects.build(id);
    expect(build.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(build.ok).toBe(true);
  });

  it("fails app pages the frame could not run: throw, empty, too large, scripts without nonce, inline handlers, outside files", async () => {
    const id = await pluginProject(
      `setup(api) {
        ${app("throws", '(() => { throw new Error("no page"); })()')}
        ${app("blank", '"   "')}
        ${app("huge", '"<p>" + "x".repeat(8 * 1024 * 1024 + 1) + "</p>"')}
        ${app("bare", page("<script>document.title = 'x';</script>"))}
        ${app("handler", page(nonced, '<button onclick="go()">Go</button>'))}
        ${app("remote", page(nonced, '<script nonce="__ALISIO_NONCE__" src="https://cdn.example.com/x.js"></script>'))}
      }`,
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const byCode = (code: string) =>
      build.issues
        .filter((i) => i.code === code)
        .map((i) => i.message)
        .join("\n");
    expect(byCode("app_html_failed")).toMatch(/throws/);
    expect(byCode("app_html_failed")).toMatch(/blank/);
    expect(byCode("app_html_too_large")).toMatch(/huge/);
    expect(byCode("app_script_nonce_missing")).toMatch(/bare/);
    expect(byCode("app_inline_handler")).toMatch(/handler/);
    expect(byCode("app_external_resource")).toMatch(/remote/);
    expect(await projects.packagePath(id)).toBeUndefined();
  });

  it("calls every app action once: a throw or data that is not JSON fails, and each action needs a test", async () => {
    const id = await pluginProject(
      `setup(api) { ${app(
        "notes",
        page(nonced),
        `{ crash: ${action("write", empty, 'throw new Error("no table");')}, big: ${action(
          "read",
          empty,
          "return { n: 1n };",
        )}, fine: ${action("read", empty, "return { ok: false, error: 'empty' };")}, lonely: ${action("read", empty, "return 1;")} }`,
      )} }`,
      ["crash", "big", "fine"],
    );
    const build = await projects.build(id);
    expect(build.ok).toBe(false);
    const failed = build.issues
      .filter((i) => i.code === "app_action_failed")
      .map((i) => i.message)
      .join("\n");
    expect(failed).toMatch(/crash/);
    expect(failed).toMatch(/big/);
    expect(failed).not.toMatch(/fine/);
    const untested = build.issues.filter((i) => i.code === "app_action_untested");
    expect(untested.map((i) => i.message).join(" ")).toContain("lonely");
    expect(untested.map((i) => i.message).join(" ")).not.toContain("fine");
  });

  it("passes the skill's own app example (page, protocol, actions and its tests) through every gate", async () => {
    const apps = PLUGIN_CREATOR_SKILL_FILES["references/apps.md"] ?? "";
    const [code, testCode] = [...apps.matchAll(/```js\n([\s\S]*?)```/g)].map((m) => m[1] ?? "");
    const id = await pluginProject(
      "setup(api) { registerListApp(api); }",
      [],
      'import { registerListApp } from "./app.js";',
    );
    await edit(id, "src/app.js", code ?? "");
    await edit(
      id,
      "test/app.test.js",
      [
        'import assert from "node:assert/strict";',
        'import { test } from "node:test";',
        'import plugin from "../src/index.js";',
        'import { createFakeApi } from "./harness.js";',
        testCode,
      ].join("\n"),
    );
    await projects.declarePlan(id, { needsApp: true });
    const build = await projects.build(id);
    expect(build.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(build.ok).toBe(true);
  });

  it("fails a plan that declared an app when the plugin registers none; legacy records pass", async () => {
    const body = `setup(api) { ${tool("note", '{ type: "object", properties: {}, additionalProperties: false }', 'return text("ok");')} }`;
    const declared = await pluginProject(body, ["note"]);
    await projects.declarePlan(declared, { needsApp: true });
    expect((await projects.get(declared)).needsApp).toBe(true);
    const build = await projects.build(declared);
    expect(build.ok).toBe(false);
    expect(codes(build.issues)).toContain("app_missing");

    const legacy = await pluginProject(body, ["note"]);
    expect((await projects.get(legacy)).needsApp).toBeUndefined();
    expect((await projects.build(legacy)).ok).toBe(true);
  });
});
