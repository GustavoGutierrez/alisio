import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import {
  findWorkspace,
  inspectPluginTarball,
  isPluginCreatorPath,
  PluginCreatorError,
  PluginCreatorProjects,
} from "../packages/core/src/index.ts";

let home: string;
let projects: PluginCreatorProjects;
let clock = 1_000;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "alisio-creator-"));
  clock = 1_000;
  projects = new PluginCreatorProjects({
    home,
    sdkRange: "^0.11.0",
    sdkVersion: "0.11.7",
    now: () => clock,
  });
});

const code = (error: unknown) => (error as PluginCreatorError).code;

async function edit(id: string, rel: string, text: string) {
  const file = join(projects.dir(id), rel);
  await mkdir(join(file, ".."), { recursive: true });
  await writeFile(file, text);
}

async function manifest(id: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(join(projects.dir(id), "package.json"), "utf8"));
}

describe("PluginCreatorProjects: create, list, get, delete", () => {
  it("creates a project from a request with the starter template and a metadata record", async () => {
    // The config home inside a git repository (dotfiles) must not swallow the project folder.
    await mkdir(join(home, ".git"));
    const project = await projects.create({ request: "A tool that counts words in a text" });
    expect(project).toMatchObject({
      version: "1.0.0",
      requests: [{ kind: "create", text: "A tool that counts words in a text", at: 1_000 }],
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(project.id).toMatch(/^[a-f0-9]{12}$/);
    expect(project.packageName).toMatch(/^alisio-plugin-local-[a-z0-9-]+$/);
    expect(project.pluginId).toMatch(/^local\.[a-z0-9-]+$/);
    expect(project.displayName.length).toBeGreaterThan(0);
    const pkg = await manifest(project.id);
    expect(pkg).toMatchObject({
      name: project.packageName,
      version: "1.0.0",
      type: "module",
      peerDependencies: { "@alisio/sdk": "^0.11.0" },
    });
    expect(pkg.dependencies).toBeUndefined();
    const files = (await projects.listFiles(project.id)).files.map((f) => f.path);
    expect(files).toEqual(
      expect.arrayContaining(["package.json", "src/index.js", "test/plugin.test.js"]),
    );
    // The project folder is its own workspace root, even inside a git repository.
    expect(await findWorkspace(projects.dir(project.id))).toBe(projects.dir(project.id));
    expect(isPluginCreatorPath(projects.dir(project.id), home)).toBe(true);
    expect(isPluginCreatorPath(join(home, "elsewhere"), home)).toBe(false);
  });

  it("lists projects newest first and gets one by id; unknown ids are not found", async () => {
    const a = await projects.create({ request: "First plugin", displayName: "First" });
    clock = 2_000;
    const b = await projects.create({ request: "Second plugin", displayName: "Second" });
    expect((await projects.list()).map((p) => p.id)).toEqual([b.id, a.id]);
    expect((await projects.get(a.id)).displayName).toBe("First");
    await expect(projects.get("ffffffffffff")).rejects.toSatisfy(
      (e) => code(e) === "plugin_project_not_found",
    );
    await expect(projects.get("../../etc")).rejects.toSatisfy(
      (e) => code(e) === "plugin_project_not_found",
    );
  });

  it("rejects an empty or oversized request", async () => {
    await expect(projects.create({ request: "   " })).rejects.toSatisfy(
      (e) => code(e) === "validation_failed",
    );
    await expect(projects.create({ request: "x".repeat(9000) })).rejects.toSatisfy(
      (e) => code(e) === "validation_failed",
    );
  });

  it("records modification requests, the session and progress steps", async () => {
    const project = await projects.create({ request: "Count words" });
    clock = 5_000;
    await projects.addRequest(project.id, "Also count lines", "modify");
    await projects.setSession(project.id, "session-1");
    await projects.recordProgress(project.id, "tests", "running", "Writing the first test");
    await projects.recordProgress(project.id, "tests", "done");
    const got = await projects.get(project.id);
    expect(got.requests.map((r) => r.kind)).toEqual(["create", "modify"]);
    expect(got.sessionId).toBe("session-1");
    expect(got.progress?.steps.find((s) => s.id === "tests")).toMatchObject({ status: "done" });
    expect(got.progress?.steps.map((s) => s.id)).toEqual([
      "plan",
      "tests",
      "code",
      "run_tests",
      "package",
    ]);
  });

  it("deletes the project folder, its record and its builds", async () => {
    const project = await projects.create({ request: "Count words" });
    await projects.delete(project.id);
    expect(await projects.list()).toEqual([]);
    await expect(readFile(join(projects.dir(project.id), "package.json"))).rejects.toThrow();
  });
});

describe("PluginCreatorProjects: files", () => {
  it("reads project files and refuses paths that escape the project", async () => {
    const project = await projects.create({ request: "Count words" });
    const file = await projects.readFile(project.id, "package.json");
    expect(file).toMatchObject({ path: "package.json", binary: false, truncated: false });
    expect(JSON.parse(file.text ?? "")).toMatchObject({ name: project.packageName });
    for (const path of ["../x", "/etc/passwd", "src/../../x", ".alisio-workspace"])
      await expect(projects.readFile(project.id, path)).rejects.toSatisfy(
        (e) => code(e) === "path_outside_workspace" || code(e) === "not_found",
      );
    await symlink("/etc/hosts", join(projects.dir(project.id), "src", "link.js"));
    await expect(projects.readFile(project.id, "src/link.js")).rejects.toSatisfy(
      (e) => code(e) === "path_outside_workspace",
    );
    expect((await projects.listFiles(project.id)).files.map((f) => f.path)).not.toContain(
      "src/link.js",
    );
  });
});

describe("PluginCreatorProjects: validate", () => {
  it("accepts the starter template", async () => {
    const project = await projects.create({ request: "Count words" });
    const result = await projects.validate(project.id);
    expect(result.issues.filter((i) => i.severity === "error")).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("reports stable codes for manifest problems", async () => {
    const project = await projects.create({ request: "Count words" });
    const pkg = await manifest(project.id);
    await edit(
      project.id,
      "package.json",
      JSON.stringify({
        ...pkg,
        type: "commonjs",
        dependencies: { lodash: "1.0.0" },
        peerDependencies: { "@alisio/sdk": "^0.11.0", react: "18.0.0" },
        scripts: { postinstall: "curl evil" },
        exports: { ".": "./src/missing.js" },
      }),
    );
    const codes = (await projects.validate(project.id)).issues.map((i) => i.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        "type_not_module",
        "dependencies_forbidden",
        "peer_extra",
        "lifecycle_scripts_forbidden",
        "entry_missing",
      ]),
    );
  });

  it("refuses runtime imports of the Alisio core or of packages", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(project.id, "src/extra.js", 'import { x } from "@alisio/core";\nexport { x };\n');
    await edit(project.id, "src/other.js", 'import _ from "lodash";\nexport default _;\n');
    const codes = (await projects.validate(project.id)).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["forbidden_import"]));
    expect((await projects.validate(project.id)).ok).toBe(false);
  });

  it("requires tests", async () => {
    const project = await projects.create({ request: "Count words" });
    await rm(join(projects.dir(project.id), "test", "plugin.test.js"));
    expect((await projects.validate(project.id)).issues.map((i) => i.code)).toContain(
      "tests_missing",
    );
  });
});

describe("PluginCreatorProjects: minimal scaffold and dead weight", () => {
  it("scaffolds only the core every plugin needs", async () => {
    const project = await projects.create({ request: "Count words" });
    expect((await projects.listFiles(project.id)).files.map((f) => f.path)).toEqual([
      "README.md",
      "assets/cover.svg",
      "assets/icon.svg",
      "package.json",
      "src/index.js",
      "test/harness.js",
      "test/plugin.test.js",
    ]);
    const index = await readFile(join(projects.dir(project.id), "src", "index.js"), "utf8");
    expect(index).not.toMatch(/storage|views|commands\.register|i18n/);
  });

  it("warns (never fails) on dead weight: unused files, empty files, the example left in", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(project.id, "src/unused.js", "export const x = 1;\n");
    await edit(project.id, "src/schema.js", "// nothing yet\n");
    const result = await projects.validate(project.id);
    expect(result.ok).toBe(true);
    const warnings = result.issues.filter((i) => i.severity === "warning");
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unused_file", file: "src/unused.js" }),
        expect.objectContaining({ code: "empty_file", file: "src/schema.js" }),
        expect.objectContaining({ code: "template_example" }),
      ]),
    );
  });
});

describe("PluginCreatorProjects: compatibility with the running SDK", () => {
  it("fails when the @alisio/sdk peer range does not accept the running SDK", async () => {
    const project = await projects.create({ request: "Count words" });
    const pkg = await manifest(project.id);
    await edit(
      project.id,
      "package.json",
      JSON.stringify({ ...pkg, peerDependencies: { "@alisio/sdk": "^0.12.0" } }),
    );
    const result = await projects.validate(project.id);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain("sdk_incompatible");
  });

  it("fails when the declared Node engine is not the running one", async () => {
    const project = await projects.create({ request: "Count words" });
    const pkg = await manifest(project.id);
    await edit(project.id, "package.json", JSON.stringify({ ...pkg, engines: { node: ">=99" } }));
    expect((await projects.validate(project.id)).issues.map((i) => i.code)).toContain(
      "engine_unsupported",
    );
  });

  it("fails the build when setup uses a PluginAPI member the running SDK does not have", async () => {
    const project = await projects.create({ request: "Count words" });
    const index = await readFile(join(projects.dir(project.id), "src", "index.js"), "utf8");
    await edit(
      project.id,
      "src/index.js",
      index.replace("  setup(api) {\n", "  setup(api) {\n    api.telepathy?.listen();\n"),
    );
    const build = await projects.build(project.id);
    expect(build.ok).toBe(false);
    expect(build.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "api_member_unknown",
          message: expect.stringContaining("api.telepathy"),
        }),
      ]),
    );
  });

  it("accepts feature-detected optional members that exist in the SDK", async () => {
    const project = await projects.create({ request: "Count words" });
    const index = await readFile(join(projects.dir(project.id), "src", "index.js"), "utf8");
    await edit(
      project.id,
      "src/index.js",
      index.replace(
        "  setup(api) {\n",
        '  setup(api) {\n    api.views?.register({ id: "summary", description: "d", handler: () => ({}) });\n',
      ),
    );
    expect((await projects.build(project.id)).ok).toBe(true);
  });
});

describe("PluginCreatorProjects: icon and cover", () => {
  it("scaffolds an SVG icon and a 16:9 cover carrying the escaped display name", async () => {
    const project = await projects.create({
      request: "Notes",
      displayName: 'Tom & Jerry <"notes">',
    });
    const pkg = await manifest(project.id);
    expect(pkg.alisio).toMatchObject({ icon: "assets/icon.svg", cover: "assets/cover.svg" });
    expect(pkg.files).toEqual(expect.arrayContaining(["src", "assets"]));
    const cover = await readFile(join(projects.dir(project.id), "assets", "cover.svg"), "utf8");
    expect(cover).toContain('viewBox="0 0 1280 720"');
    expect(cover).toContain("Tom &amp; Jerry &lt;&quot;notes&quot;&gt;");
    expect(cover).not.toContain("<script");
    const icon = await readFile(join(projects.dir(project.id), "assets", "icon.svg"), "utf8");
    expect(icon).toContain('viewBox="0 0 64 64"');
    expect((await projects.validate(project.id)).ok).toBe(true);
  });

  it("shortens a long display name on the cover", async () => {
    const project = await projects.create({ request: "x", displayName: "A".repeat(80) });
    const cover = await readFile(join(projects.dir(project.id), "assets", "cover.svg"), "utf8");
    expect(cover).toContain("…");
    expect(cover).not.toContain("A".repeat(41));
  });

  it("packs the icon and cover", async () => {
    const project = await projects.create({ request: "Count words" });
    expect((await projects.build(project.id)).ok).toBe(true);
    const files = (await projects.get(project.id)).lastBuild;
    expect(files?.files).toBe(5);
  });

  it.each([
    ["<script>alert(1)</script>", "svg_unsafe"],
    ['<rect onload="x()" width="1" height="1"/>', "svg_unsafe"],
    ['<image href="https://evil.example/x.png"/>', "svg_unsafe"],
    ['<use xlink:href="http://evil.example/a.svg#x"/>', "svg_unsafe"],
    ["<foreignObject><div/></foreignObject>", "svg_unsafe"],
    ['<rect style="fill:url(https://evil.example/a)"/>', "svg_unsafe"],
  ])("rejects an unsafe icon: %s", async (inner, expected) => {
    const project = await projects.create({ request: "Count words" });
    await edit(
      project.id,
      "assets/icon.svg",
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">${inner}</svg>`,
    );
    const result = await projects.validate(project.id);
    expect(result.ok).toBe(false);
    expect(result.issues.map((i) => i.code)).toContain(expected);
  });

  it("accepts internal references and reports missing, wrong-format or oversized assets", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(
      project.id,
      "assets/icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="64" height="64"/><use href="#g"/></svg>',
    );
    expect((await projects.validate(project.id)).ok).toBe(true);
    await rm(join(projects.dir(project.id), "assets", "cover.svg"));
    await edit(project.id, "assets/icon.svg", "not an image at all");
    let codes = (await projects.validate(project.id)).issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["asset_missing", "asset_format"]));
    await edit(
      project.id,
      "assets/icon.svg",
      `<svg xmlns="http://www.w3.org/2000/svg">${" ".repeat(300 * 1024)}</svg>`,
    );
    codes = (await projects.validate(project.id)).issues.map((i) => i.code);
    expect(codes).toContain("asset_too_large");
    const pkg = await manifest(project.id);
    await edit(
      project.id,
      "package.json",
      JSON.stringify({ ...pkg, alisio: { ...(pkg.alisio as object), icon: "../outside.svg" } }),
    );
    expect((await projects.validate(project.id)).issues.map((i) => i.code)).toContain(
      "asset_outside",
    );
  });
});

describe("PluginCreatorProjects: tests, build, package and status", () => {
  it("runs the template's node:test suite and counts the results", async () => {
    const project = await projects.create({ request: "Count words" });
    const run = await projects.runTests(project.id);
    expect(run.ok).toBe(true);
    expect(run.passed).toBeGreaterThan(0);
    expect(run.failed).toBe(0);
  });

  it("reports failing tests without throwing", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(
      project.id,
      "test/broken.test.js",
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fails", () => assert.equal(1, 2));\n',
    );
    const run = await projects.runTests(project.id);
    expect(run.ok).toBe(false);
    expect(run.failed).toBe(1);
  });

  it("stops a hanging test run at the timeout", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(
      project.id,
      "test/hang.test.js",
      'import test from "node:test";\ntest("hangs", () => new Promise(() => setInterval(() => {}, 1000)));\n',
    );
    const run = await projects.runTests(project.id, { timeoutMs: 1_500 });
    expect(run).toMatchObject({ ok: false, timedOut: true });
  });

  it("builds a valid, installable tarball with stats and a schema", async () => {
    const project = await projects.create({ request: "Save notes in a table" });
    await edit(
      project.id,
      "src/schema.js",
      [
        "export const SCHEMA = `",
        "CREATE TABLE IF NOT EXISTS notebooks (id INTEGER PRIMARY KEY, title TEXT NOT NULL);",
        "CREATE TABLE notes (",
        "  id INTEGER PRIMARY KEY AUTOINCREMENT,",
        "  notebook_id INTEGER NOT NULL REFERENCES notebooks(id),",
        "  body TEXT,",
        "  FOREIGN KEY (notebook_id) REFERENCES notebooks(id)",
        ");`;",
      ].join("\n"),
    );
    clock = 9_000;
    const build = await projects.build(project.id);
    expect(build.ok).toBe(true);
    expect(build.stats).toMatchObject({ ok: true, testsFailed: 0, at: 9_000, generationMs: 8_000 });
    expect(build.stats.testsPassed).toBeGreaterThan(0);
    expect(build.stats.files).toBeGreaterThan(1);
    expect(build.stats.bytes).toBeGreaterThan(0);
    const tarball = await projects.packagePath(project.id);
    expect(tarball).toBeDefined();
    expect(await inspectPluginTarball(tarball as string)).toMatchObject({
      isAlisioPlugin: true,
      name: project.packageName,
      version: "1.0.0",
    });
    const got = await projects.get(project.id);
    expect(got.lastBuild?.ok).toBe(true);
    expect(got.schema?.tables.map((t) => t.name)).toEqual(["notebooks", "notes"]);
    const notes = got.schema?.tables.find((t) => t.name === "notes");
    expect(notes?.columns.find((c) => c.name === "id")).toMatchObject({ pk: true });
    expect(notes?.columns.find((c) => c.name === "notebook_id")).toMatchObject({
      type: "INTEGER",
      notNull: true,
      fk: { table: "notebooks", column: "id" },
    });
  });

  it("does not package a project whose tests fail, and records the failed build", async () => {
    const project = await projects.create({ request: "Count words" });
    await edit(
      project.id,
      "test/broken.test.js",
      'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("fails", () => assert.equal(1, 2));\n',
    );
    const build = await projects.build(project.id);
    expect(build).toMatchObject({ ok: false, error: { code: "plugin_tests_failed" } });
    expect(await projects.packagePath(project.id)).toBeUndefined();
    expect((await projects.get(project.id)).lastBuild?.ok).toBe(false);
  });

  it("refuses a plugin whose exported version differs from package.json", async () => {
    const project = await projects.create({ request: "Count words" });
    const index = await readFile(join(projects.dir(project.id), "src", "index.js"), "utf8");
    await edit(project.id, "src/index.js", index.replace("  version,\n", '  version: "9.9.9",\n'));
    // Tests that do not check the version: the probe still catches it.
    await edit(
      project.id,
      "test/plugin.test.js",
      'import test from "node:test";\ntest("loads", async () => { await import("../src/index.js"); });\n',
    );
    const build = await projects.build(project.id);
    expect(build.ok).toBe(false);
    expect(build.issues.map((i) => i.code)).toContain("version_mismatch");
  });

  it("treats a package as stale once the sources change after the build", async () => {
    const project = await projects.create({ request: "Count words" });
    expect((await projects.build(project.id)).ok).toBe(true);
    expect(await projects.packagePath(project.id)).toBeDefined();
    await edit(project.id, "src/extra.js", "export const extra = 1;\n");
    expect(await projects.packagePath(project.id)).toBeUndefined();
  });

  it("detects the installed version from the real plugins directory", async () => {
    const project = await projects.create({ request: "Count words" });
    expect(await projects.status(project.id)).toMatchObject({
      installed: false,
      projectVersion: "1.0.0",
      updateAvailable: false,
    });
    // Install by hand: config entry + package in the plugins directory.
    const pkgDir = join(home, "plugins", "node_modules", project.packageName);
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: project.packageName, version: "1.0.0" }),
    );
    await writeFile(join(home, "config.json"), JSON.stringify({ plugins: [project.packageName] }));
    expect(await projects.status(project.id)).toMatchObject({
      installed: true,
      installedVersion: "1.0.0",
      updateAvailable: false,
    });
    const pkg = await manifest(project.id);
    await edit(project.id, "package.json", JSON.stringify({ ...pkg, version: "1.0.1" }));
    expect(await projects.status(project.id)).toMatchObject({
      installed: true,
      installedVersion: "1.0.0",
      projectVersion: "1.0.1",
      updateAvailable: true,
    });
    // Metadata alone never claims an install.
    await rm(pkgDir, { recursive: true });
    await projects.recordInstall(project.id, "1.0.1");
    expect((await projects.status(project.id)).installed).toBe(false);
  });

  it("throws typed errors for unknown projects", async () => {
    await expect(projects.build("aaaaaaaaaaaa")).rejects.toBeInstanceOf(PluginCreatorError);
  });
});

describe("PluginCreatorProjects: folder and icon for the web UI", () => {
  it("reports the source folder and the declared icon path", async () => {
    const project = await projects.create({ request: "Count words" });
    const got = await projects.get(project.id);
    expect(got.dir).toBe(projects.dir(project.id));
    expect(got.icon).toBe("assets/icon.svg");
    // Derived fields are never written into the stored record.
    const record = JSON.parse(
      await readFile(join(projects.paths.records, `${project.id}.json`), "utf8"),
    );
    expect(record.dir).toBeUndefined();
  });

  it("serves the icon only when it is a safe image inside the project", async () => {
    const project = await projects.create({ request: "Count words" });
    const icon = await projects.icon(project.id);
    expect(icon?.type).toBe("svg");
    expect(icon?.data.toString("utf8")).toContain("<svg");
    await edit(
      project.id,
      "assets/icon.svg",
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    );
    expect(await projects.icon(project.id)).toBeUndefined();
    const pkg = await manifest(project.id);
    await edit(
      project.id,
      "package.json",
      JSON.stringify({ ...pkg, alisio: { ...(pkg.alisio as object), icon: "../outside.svg" } }),
    );
    expect(await projects.icon(project.id)).toBeUndefined();
    expect((await projects.get(project.id)).icon).toBeUndefined();
  });
});
