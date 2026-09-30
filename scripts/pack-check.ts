/**
 * Packs every publishable package with pnpm (which applies publishConfig and rewrites
 * workspace: ranges), then checks tarball contents and manifests. Prints a size table.
 * Usage: node --experimental-strip-types scripts/pack-check.ts [--keep <dir>]
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const keepIndex = process.argv.indexOf("--keep");
const out =
  keepIndex > 0
    ? resolve(process.argv[keepIndex + 1] ?? "packs")
    : mkdtempSync(join(tmpdir(), "alisio-pack-"));
mkdirSync(out, { recursive: true });
const packages = [
  "sdk",
  "core",
  "plugin-memory",
  "plugin-openai-compatible",
  "plugin-subagents",
  "server",
  "cli",
];
const rows: string[] = [];
try {
  for (const name of packages) {
    const dir = resolve("packages", name);
    const before = new Set(readdirSync(out, { withFileTypes: false }).map(String));
    execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "pipe" });
    const tarball = readdirSync(out).find((f) => f.endsWith(".tgz") && !before.has(f));
    assert.ok(tarball, `no tarball for ${name}`);
    const path = join(out, tarball);
    const files = execFileSync("tar", ["-tzf", path]).toString().trim().split("\n");
    const manifest = JSON.parse(
      execFileSync("tar", ["-xzOf", path, "package/package.json"]).toString(),
    );
    // The server also ships the web UI build under dist/web (copied there by the web build).
    const allowed =
      name === "server"
        ? /^package\/(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts)|dist\/web\/.+)$/
        : /^package\/(package\.json|README\.md|LICENSE|dist\/.+\.(js|d\.ts))$/;
    for (const file of files) assert.match(file, allowed, `${name}: unexpected file ${file}`);
    for (const required of ["package/package.json", "package/README.md", "package/LICENSE"])
      assert.ok(files.includes(required), `${name}: missing ${required}`);
    const text = JSON.stringify(manifest);
    assert.doesNotMatch(text, /workspace:/, `${name}: workspace protocol leaked`);
    assert.doesNotMatch(text, /alisio-source|\.\/src\//, `${name}: source export leaked`);
    assert.equal(manifest.private, undefined, `${name}: must not be private`);
    assert.equal(manifest.license, "MIT");
    assert.ok(manifest.exports?.["."]?.import?.startsWith("./dist/"), `${name}: exports`);
    if (name === "cli") assert.equal(manifest.bin?.alisio, "./dist/main.js");
    const size = statSync(path).size;
    const unpacked = execFileSync("tar", ["-tzvf", path])
      .toString()
      .trim()
      .split("\n")
      .reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[2] ?? 0), 0);
    rows.push(
      `${manifest.name.padEnd(24)} ${String(files.length).padStart(4)} files ${(size / 1024).toFixed(1).padStart(8)} kB packed ${(unpacked / 1024).toFixed(1).padStart(8)} kB unpacked  ${tarball}`,
    );
  }
  console.log(`Tarballs in ${out}\n${rows.join("\n")}`);
} finally {
  if (keepIndex < 0) rmSync(out, { recursive: true, force: true });
}
