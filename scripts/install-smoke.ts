/**
 * Proves npm packaging end to end without publishing: packs every package, serves the
 * tarballs from a throwaway local registry (other packages are proxied to registry.npmjs.org),
 * installs `@alisio/alisio-code` globally into a temporary prefix with npm and runs its
 * `alisio` binary.
 * Usage: node --experimental-strip-types scripts/install-smoke.ts
 */
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const upstream = "https://registry.npmjs.org";
const work = mkdtempSync(join(tmpdir(), "alisio-install-"));
const packs = join(work, "packs");
const manifestVersion = String(
  JSON.parse(readFileSync(resolve("packages/cli/package.json"), "utf8")).version,
);
execFileSync(process.execPath, [
  "--experimental-strip-types",
  "--disable-warning=ExperimentalWarning",
  resolve("scripts/pack-check.ts"),
  "--keep",
  packs,
]);
const local = new Map<string, { manifest: Record<string, unknown>; file: string; data: Buffer }>();
for (const file of readdirSync(packs).filter((f) => f.endsWith(".tgz"))) {
  const path = join(packs, file);
  const manifest = JSON.parse(
    execFileSync("tar", ["-xzOf", path, "package/package.json"]).toString(),
  );
  local.set(manifest.name, { manifest, file, data: readFileSync(path) });
}
const server = createServer(async (req, res) => {
  const url = decodeURIComponent(req.url ?? "/");
  const tarball = /^\/-\/(.+\.tgz)$/.exec(url)?.[1];
  const hit = [...local.values()].find((p) => p.file === tarball);
  if (hit) {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    return res.end(hit.data);
  }
  const name = url.slice(1);
  const pkg = local.get(name);
  if (pkg) {
    const { port } = server.address() as AddressInfo;
    const version = String(pkg.manifest.version);
    const body = {
      name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          ...pkg.manifest,
          dist: {
            tarball: `http://127.0.0.1:${port}/-/${pkg.file}`,
            integrity: `sha512-${createHash("sha512").update(pkg.data).digest("base64")}`,
          },
        },
      },
    };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(body));
  }
  // Everything else comes from the public registry.
  const response = await fetch(`${upstream}${req.url}`, {
    headers: { accept: req.headers.accept ?? "application/json" },
  });
  res.writeHead(response.status, {
    "content-type": response.headers.get("content-type") ?? "application/json",
  });
  res.end(Buffer.from(await response.arrayBuffer()));
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const registry = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
const prefix = join(work, "prefix");
try {
  // Must be asynchronous: the registry above is served by this same process.
  await execFileAsync(
    "npm",
    [
      "install",
      "-g",
      "--prefix",
      prefix,
      "--registry",
      registry,
      "--no-audit",
      "--no-fund",
      `@alisio/alisio-code@${manifestVersion}`,
    ],
    { timeout: 600_000, env: { ...process.env, npm_config_cache: join(work, "cache") } },
  );
  const bin = join(prefix, process.platform === "win32" ? "alisio.cmd" : "bin/alisio");
  const help = execFileSync(bin, ["--help"]).toString();
  assert.match(help, /Usage: alisio/);
  assert.match(help, /--disable-plugin/);
  const installed = readdirSync(
    join(prefix, "lib", "node_modules", "@alisio", "alisio-code", "node_modules", "@alisio"),
  );
  console.log(
    JSON.stringify({
      ok: true,
      bin,
      installed: installed.map((n) => `@alisio/${n}`),
      help: help.split("\n")[0],
    }),
  );
} finally {
  server.close();
  rmSync(work, { recursive: true, force: true });
}
