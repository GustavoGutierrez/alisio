import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fileSize, readHead, readJson, readText, which } from "../packages/core/src/runtime/fs.ts";
import { isPathSpec, resolvePluginSpec } from "../packages/core/src/runtime/modules.ts";
import { runProcess } from "../packages/core/src/runtime/process.ts";
import { isSqliteExperimentalWarning, openDatabase } from "../packages/core/src/runtime/sqlite.ts";

const root = await mkdtemp(join(tmpdir(), "alisio-runtime-"));
afterAll(() => rm(root, { recursive: true, force: true }));

describe("sqlite adapter (node:sqlite)", () => {
  it("returns plain rows, undefined for no row, and creates private files", async () => {
    const path = join(root, "db", "a.sqlite");
    const db = openDatabase(path);
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT)");
    expect(db.prepare("INSERT INTO t(v) VALUES(?) RETURNING id").get("x")).toEqual({ id: 1 });
    const row = db.prepare("SELECT v FROM t WHERE id=?").get(1);
    expect(Object.getPrototypeOf(row)).toBe(Object.prototype);
    expect(db.prepare("SELECT v FROM t WHERE id=?").get(99)).toBeUndefined();
    expect(db.prepare("INSERT INTO t(v) VALUES(?)").run("y").changes).toBe(1);
    expect(db.prepare("SELECT v FROM t ORDER BY id").all()).toEqual([{ v: "x" }, { v: "y" }]);
    db.close();
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("commits, rolls back and tolerates nested transactions", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE TABLE t(v TEXT)");
    db.transaction(() => {
      db.prepare("INSERT INTO t VALUES(?)").run("a");
      db.transaction(() => db.prepare("INSERT INTO t VALUES(?)").run("b"));
    });
    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t VALUES(?)").run("c");
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 2 });
    db.close();
  });

  it("supports FTS5 with the trigram tokenizer and BM25", () => {
    const db = openDatabase(":memory:");
    db.exec("CREATE VIRTUAL TABLE f USING fts5(a, tokenize='trigram')");
    db.prepare("INSERT INTO f VALUES(?)").run("hello world");
    expect(db.prepare("SELECT bm25(f) AS s FROM f WHERE f MATCH ?").all('"wor"')).toHaveLength(1);
    db.close();
  });

  it("filters only the SQLite experimental warning", () => {
    expect(
      isSqliteExperimentalWarning("SQLite is an experimental feature", "ExperimentalWarning"),
    ).toBe(true);
    expect(isSqliteExperimentalWarning("Fetch is experimental", "ExperimentalWarning")).toBe(false);
    expect(
      isSqliteExperimentalWarning("SQLite is an experimental feature", "DeprecationWarning"),
    ).toBe(false);
  });
});

describe("filesystem helpers", () => {
  it("reads text, JSON, heads and sizes; missing files are undefined", async () => {
    const file = join(root, "f.json");
    await writeFile(file, JSON.stringify({ a: 1 }));
    expect(await readJson(file)).toEqual({ a: 1 });
    expect(await readJson(join(root, "missing.json"))).toBeUndefined();
    expect(await fileSize(file)).toBe(7);
    expect(await fileSize(join(root, "missing"))).toBeUndefined();
    expect(await readText(file)).toBe('{"a":1}');
    expect(await readHead(file, 3)).toBe('{"a');
    await expect(readText(file, 3)).rejects.toThrow(/exceeds/);
  });

  it("finds executables on PATH", async () => {
    expect(await which("node")).toMatch(/node(\.exe)?$/);
    expect(await which("definitely-not-a-command-xyz")).toBeUndefined();
  });
});

describe("process runner (node:child_process)", () => {
  const signal = () => AbortSignal.timeout(10_000);
  it("captures output and exit codes", async () => {
    const r = await runProcess(
      process.execPath,
      ["-e", "console.log('out'); console.error('err'); process.exit(3)"],
      {
        cwd: root,
        signal: signal(),
      },
    );
    expect(r).toEqual({ stdout: "out\n", stderr: "err\n", exitCode: 3, truncated: false });
  });
  it("truncates large output and kills the process", async () => {
    const r = await runProcess(
      process.execPath,
      ["-e", "setInterval(()=>process.stdout.write('x'.repeat(1000)),1)"],
      {
        cwd: root,
        signal: signal(),
        maxBytes: 5_000,
      },
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(5_000);
  });
  it("aborts on timeout", async () => {
    await expect(
      runProcess(process.execPath, ["-e", "setTimeout(()=>{},10000)"], {
        cwd: root,
        signal: signal(),
        timeoutMs: 200,
      }),
    ).rejects.toThrow();
  });
});

describe("process cancellation grace", () => {
  it("sends SIGTERM first so well-behaved processes can exit", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM',()=>{console.log('bye');process.exit(0)});setInterval(()=>{},1000)",
      ],
      { cwd: root, signal: controller.signal, killGraceMs: 5_000 },
    );
    setTimeout(() => controller.abort(new Error("stop")), 300);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(3_000);
  });
  it("escalates to SIGKILL after the grace period", async () => {
    const controller = new AbortController();
    const started = Date.now();
    const pending = runProcess(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
      { cwd: root, signal: controller.signal, killGraceMs: 400 },
    );
    setTimeout(() => controller.abort(new Error("stop")), 300);
    await expect(pending).rejects.toThrow();
    expect(Date.now() - started).toBeGreaterThanOrEqual(650);
  });
});

describe("plugin specs", () => {
  it("distinguishes paths from package names", () => {
    for (const s of ["./p.ts", "../p.js", "/abs/p.js", "plugins/p.ts", "p.mjs", "C:\\p\\x.js"])
      expect(isPathSpec(s)).toBe(true);
    for (const s of ["alisio-plugin-foo", "@scope/alisio-plugin-bar"])
      expect(isPathSpec(s)).toBe(false);
  });

  it("resolves packages from the project, then global roots, requiring the alisio-plugin keyword", async () => {
    const project = join(root, "project", "sub");
    const pkg = async (base: string, name: string, manifest: Record<string, unknown>) => {
      const dir = join(base, "node_modules", name);
      await mkdir(join(dir, "dist"), { recursive: true });
      await writeFile(join(dir, "package.json"), JSON.stringify({ name, ...manifest }));
      await writeFile(join(dir, "dist", "index.js"), "export default {}");
      return dir;
    };
    await mkdir(project, { recursive: true });
    const local = await pkg(join(root, "project"), "alisio-plugin-local", {
      keywords: ["alisio-plugin"],
      exports: { ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } },
    });
    const globalBase = join(root, "global");
    const globalRoot = join(globalBase, "node_modules");
    const global = await pkg(globalBase, "@acme/alisio-plugin-global", {
      keywords: ["alisio-plugin"],
      main: "./dist/index.js",
    });
    await pkg(join(root, "project"), "not-a-plugin", { main: "./dist/index.js" });
    expect(
      await resolvePluginSpec("alisio-plugin-local", { from: project, globalRoots: [globalRoot] }),
    ).toBe(join(local, "dist", "index.js"));
    expect(
      await resolvePluginSpec("@acme/alisio-plugin-global", {
        from: project,
        globalRoots: [globalRoot],
      }),
    ).toBe(join(global, "dist", "index.js"));
    await expect(
      resolvePluginSpec("not-a-plugin", { from: project, globalRoots: [] }),
    ).rejects.toThrow(/alisio-plugin/);
    await expect(
      resolvePluginSpec("alisio-plugin-missing", { from: project, globalRoots: [globalRoot] }),
    ).rejects.toThrow(/not found/);
    expect(await resolvePluginSpec("./x/p.ts", { from: project, globalRoots: [] })).toBe(
      join(project, "x", "p.ts"),
    );
  });
});
