/**
 * Publish the Alisio npm packages in dependency-safe order.
 *
 * Usage (from the repository root):
 *   pnpm run publish -- --all
 *   pnpm run publish -- --all --dry-run
 *   pnpm run publish -- --all --version 0.1.1
 *   pnpm run publish -- --all --version 0.2.0-rc.1
 *   pnpm run publish -- --package sdk --package core --version 0.2.0 --no-build
 *
 * pnpm forwards a literal `--` separator to the script (`pnpm run publish -- <flags>`); the
 * parser skips any `--` it sees, so the same flags work when invoking the script directly.
 *
 * Flags:
 *   --all              publish every publishable package (sdk, core, plugins, cli), in order
 *   --package <name>   publish one package (repeatable); requires --all or at least one --package
 *   --version <v>      atomically set this version in every selected package.json before packing
 *   --dry-run          print exactly what would be published (names, versions, tarballs, order)
 *                      and exit without building, bumping, packing or publishing
 *   --build            build first (default ON); pass --no-build to skip the build
 *
 * The script packs each selected package with pnpm (which applies publishConfig and rewrites
 * workspace: ranges), runs the same leak check as pack-check on the packed manifest, and
 * publishes every tarball with `npm publish <tarball> --access public` (plus `--tag latest` for a
 * stable version; a prerelease keeps npm's default tag) in dependency-safe order
 * (sdk -> core -> plugins -> cli) so consumers never resolve a broken range mid-publish.
 * npm may prompt interactively for an OTP; the operator must enter it. On failure the script
 * stops, names the failing package and exits non-zero; it never silently skips a package.
 * Secrets are never printed: keys and tokens live in your npm configuration, not in this repo.
 *
 * The pure logic (flag parsing, ordering, version handling, leak check, publish plan) is exported
 * for tests and must not hit the network or depend on a pnpm/npm install.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Every publishable package by its CLI-resolvable name -> directory under packages/. */
export const PACKAGE_DIRS: Record<string, string> = {
  sdk: "sdk",
  core: "core",
  "plugin-memory": "plugin-memory",
  "plugin-subagents": "plugin-subagents",
  "plugin-openai-compatible": "plugin-openai-compatible",
  server: "server",
  cli: "cli",
};

/**
 * Dependency-safe publish rank: sdk (no deps) -> core (depends on sdk) -> plugins (peer-dep on
 * sdk) and server (depends on core and sdk) -> cli (depends on core, plugins, server and sdk). Publishing within a rank is deterministic
 * (alphabetical). Unknown names are rejected at parse time.
 */
const RANK: Record<string, number> = {
  sdk: 0,
  core: 1,
  "plugin-memory": 2,
  "plugin-subagents": 2,
  "plugin-openai-compatible": 2,
  server: 2,
  cli: 3,
};

export const PUBLISH_ORDER: string[] = Object.keys(RANK).sort(
  (a, b) => (RANK[a] ?? 2) - (RANK[b] ?? 2) || a.localeCompare(b),
);

/** Topologically orders the selected packages (deduplicated) by the dependency rank above. */
export function publishOrder(packages: string[]): string[] {
  return [...new Set(packages)].sort(
    (a, b) => (RANK[a] ?? 2) - (RANK[b] ?? 2) || a.localeCompare(b),
  );
}

const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Whether `version` is a stable release (no prerelease identifier, e.g. `0.1.0`, not `0.1.0-rc.1`). */
export function isStableVersion(version: string): boolean {
  return SEMVER.test(version) && !/^\d+\.\d+\.\d+-/.test(version);
}

/**
 * The npm dist-tag passed explicitly to `npm publish`: `latest` for a stable version. A prerelease
 * returns `undefined`, so the script keeps passing no `--tag` and npm applies its own default
 * (this predates the stable release and is kept as is).
 */
export function distTag(version: string): string | undefined {
  return isStableVersion(version) ? "latest" : undefined;
}

/** Arguments of `npm publish` for a packed tarball. */
export function npmPublishArgs(tarball: string, version: string): string[] {
  const tag = distTag(version);
  return ["publish", tarball, "--access", "public", ...(tag ? ["--tag", tag] : [])];
}

/** Problems when the selected packages do not all share one version (they release together). */
export function versionSyncProblems(plan: PublishPlanEntry[]): string[] {
  const versions = new Set(plan.map((entry) => entry.version));
  return versions.size > 1
    ? [`packages are out of sync: ${plan.map((e) => `${e.name}@${e.version}`).join(", ")}`]
    : [];
}

export interface PublishOptions {
  all: boolean;
  packages: string[];
  version?: string;
  dryRun: boolean;
  build: boolean;
}

/** Parses CLI flags. Rejects unknown packages, missing selectors and malformed flags. */
export function parsePublishArgs(argv: string[]): PublishOptions {
  const options: PublishOptions = { all: false, packages: [], dryRun: false, build: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--all":
        options.all = true;
        break;
      case "--package": {
        const name = argv[++i];
        if (!name) throw new Error("--package requires a package name");
        if (!(name in PACKAGE_DIRS)) throw new Error(`Unknown package: ${name}`);
        options.packages.push(name);
        break;
      }
      case "--version": {
        const version = argv[++i];
        if (!version) throw new Error("--version requires a version");
        if (!SEMVER.test(version)) throw new Error(`Invalid version: ${version}`);
        options.version = version;
        break;
      }
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--build":
        options.build = true;
        break;
      case "--no-build":
        options.build = false;
        break;
      case "--":
        // `pnpm run publish -- <flags>` forwards a literal `--` separator; skip it as a no-op.
        break;
      default:
        throw new Error(`Unknown flag: ${arg}`);
    }
  }
  if (!options.all && options.packages.length === 0)
    throw new Error("Nothing selected: pass --all or at least one --package <name>");
  return options;
}

/** Packs the tarball filename npm/pnpm produce for a scoped package, e.g. `@alisio/sdk` -> `alisio-sdk-1.2.3.tgz`. */
export function tarballName(name: string, version: string): string {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/**
 * The same leak check pack-check applies to a packed manifest: no `workspace:`, no `alisio-source`
 * / `./src/` exports, exports must point at `./dist/`, and the package must not be private.
 * Returns a list of problems (empty when the manifest is publishable).
 */
export function manifestProblems(manifest: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const text = JSON.stringify(manifest);
  if (text.includes("workspace:")) problems.push("manifest leaks the workspace: protocol");
  if (/alisio-source|\.\/src\//.test(text))
    problems.push("manifest leaks a source export (alisio-source or ./src/)");
  const exportsDot = (manifest.exports as Record<string, Record<string, unknown>> | undefined)?.[
    "."
  ];
  const importPath = typeof exportsDot?.import === "string" ? exportsDot.import : undefined;
  if (typeof importPath !== "string" || !importPath.startsWith("./dist/"))
    problems.push("manifest exports must point at ./dist/");
  if (manifest.private === true) problems.push("manifest must not be private");
  return problems;
}

/**
 * Atomically sets `version` in every listed package.json: all files are read and validated before
 * any write, and a failure during the writes or the restore restores every touched file, so a
 * partial bump never ships. Keeps all unrelated fields intact.
 */
export function bumpVersions(files: string[], version: string): void {
  const originals = files.map((file) => readFileSync(file, "utf8"));
  const write = (value: string) => {
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (!file) throw new Error(`Invalid package.json path at index ${i}`);
      const manifest = JSON.parse(originals[i] ?? "{}") as Record<string, unknown>;
      if (typeof manifest.name !== "string") throw new Error(`Invalid package.json: ${file}`);
      manifest.version = value;
      writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    }
  };
  try {
    write(version);
  } catch (error) {
    files.forEach((file, i) => {
      const original = originals[i];
      if (original !== undefined && file) writeFileSync(file, original);
    });
    throw error;
  }
}

export interface PublishPlanEntry {
  /** Directory under the repo root (`packages/<dir>`). */
  dir: string;
  /** npm package name from package.json. */
  name: string;
  /** Version that would be published (the bumped one when --version is given, current otherwise). */
  version: string;
  /** Tarball filename that `pnpm pack` produces for this package/version. */
  tarball: string;
}

/**
 * Reads the selected packages from disk and returns the ordered publish plan without changing
 * anything (no build, no version bump, no pack, no publish). Dry runs and tests rely on this.
 */
export function planPublish(options: PublishOptions, root = process.cwd()): PublishPlanEntry[] {
  const selected = options.all ? [...PUBLISH_ORDER] : options.packages;
  return publishOrder(selected).map((name) => {
    const dir = PACKAGE_DIRS[name];
    if (!dir) throw new Error(`Unknown package: ${name}`);
    const file = join(root, "packages", dir, "package.json");
    if (!existsSync(file)) throw new Error(`Missing package.json for ${name}: ${file}`);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string")
      throw new Error(`Invalid package.json for ${name}`);
    const version = options.version ?? (manifest.version as string);
    return { dir, name: manifest.name, version, tarball: tarballName(manifest.name, version) };
  });
}

async function main(): Promise<void> {
  const options = parsePublishArgs(process.argv.slice(2));
  const root = process.cwd();
  const plan = planPublish(options, root);
  const describe = `==> ${plan.map((p) => `${p.name}@${p.version}`).join("\n==> ")}`;
  if (options.dryRun) {
    console.log(`[dry-run] would publish ${plan.length} package(s) in this order:\n${describe}`);
    console.log(
      `[dry-run] tarballs: ${plan.map((p) => `${p.name}@${p.version} -> ${p.tarball}`).join(", ")}`,
    );
    const tags = [...new Set(plan.map((p) => distTag(p.version) ?? "(npm default)"))];
    console.log(`[dry-run] npm dist-tag: ${tags.join(", ")}`);
    const drift = versionSyncProblems(plan);
    if (drift.length) console.log(`[dry-run] warning: ${drift.join("; ")}`);
    console.log("[dry-run] no build, no version bump, no pack and no publish were performed.");
    return;
  }
  if (options.all) {
    const drift = versionSyncProblems(plan);
    if (drift.length) throw new Error(`--all releases every package at one version: ${drift[0]}`);
  }
  if (options.version) {
    const targets = plan.map((p) => join(root, "packages", p.dir, "package.json"));
    bumpVersions(targets, options.version);
    console.log(`Bumped version to ${options.version} in ${targets.length} package.json file(s).`);
  }
  if (options.build) {
    console.log("Building packages (pnpm build)...");
    execFileSync("pnpm", ["build"], { cwd: root, stdio: "inherit" });
  }
  console.log(`Publishing ${plan.length} package(s) in this order:\n${describe}`);
  const out = mkdtempSync(join(tmpdir(), "alisio-publish-"));
  try {
    for (const entry of plan) {
      const dir = join(root, "packages", entry.dir);
      const before = new Set(readdirSync(out).map(String));
      try {
        execFileSync("pnpm", ["pack", "--pack-destination", out], { cwd: dir, stdio: "pipe" });
        const packed = readdirSync(out).find((f) => f.endsWith(".tgz") && !before.has(f));
        if (!packed) throw new Error(`pnpm pack produced no tarball for ${entry.name}`);
        const tarball = join(out, packed);
        const manifest = JSON.parse(
          execFileSync("tar", ["-xzOf", tarball, "package/package.json"]).toString(),
        ) as Record<string, unknown>;
        const problems = manifestProblems(manifest);
        if (problems.length)
          throw new Error(`packed manifest failed the leak check: ${problems.join("; ")}`);
        console.log(`publishing ${entry.name}@${entry.version} (${packed})`);
        execFileSync("npm", npmPublishArgs(tarball, entry.version), { stdio: "inherit" });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        console.error(`Failed: ${entry.name}@${entry.version} (${reason})`);
        console.error("Stopping: remaining packages were not published.");
        process.exitCode = 1;
        return;
      }
    }
    console.log(`Done: published ${plan.length} package(s).`);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invoked)
  main().catch((error) => {
    console.error(`publish: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
