import { mkdir, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadVersion as loadCliVersion } from "../packages/cli/src/version.ts";
import { loadVersion as loadCoreVersion } from "../packages/core/src/version.ts";
import { createMemoryPlugin } from "../packages/plugin-memory/src/index.ts";
import { loadVersion as loadMemoryVersion } from "../packages/plugin-memory/src/version.ts";
import { createOpenAICompatiblePlugin } from "../packages/plugin-openai-compatible/src/index.ts";
import { loadVersion as loadOpenAICompatibleVersion } from "../packages/plugin-openai-compatible/src/version.ts";
import { createSubagentsPlugin } from "../packages/plugin-subagents/src/index.ts";
import { loadVersion as loadSubagentsVersion } from "../packages/plugin-subagents/src/version.ts";

afterEach(() => vi.unstubAllEnvs());

describe("package version loading", () => {
  it("honors the ALISIO_PACKAGE_VERSION build-time injection before the manifest", () => {
    // The real manifests of these packages are readable; the injected env still wins.
    vi.stubEnv("ALISIO_PACKAGE_VERSION", "9.8.7-injected");
    expect(loadCliVersion(import.meta.url)).toBe("9.8.7-injected");
    expect(loadCoreVersion(import.meta.url)).toBe("9.8.7-injected");
  });

  it("reads the version from the package manifest next to the module", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-version-manifest-"));
    await writeJson(join(dir, "package.json"), { version: "7.6.5-manifest" });
    // `fromHere` points into the temp package; `../package.json` resolves to that manifest.
    const fromHere = pathToFileURL(join(dir, "src", "loader.ts")).href;
    expect(loadCliVersion(fromHere)).toBe("7.6.5-manifest");
    expect(loadCoreVersion(fromHere)).toBe("7.6.5-manifest");
  });

  it("walks up to a manifest several levels above a nested module (TUI depth)", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-version-nested-"));
    // A module at <root>/src/tui/app.ts must still resolve <root>/package.json, two levels up —
    // the depth of packages/cli/src/tui/app.ts in the real tree (the regression that made the
    // TUI header show "vdev" when the single-level lookup missed).
    await writeJson(join(root, "package.json"), { version: "6.4.2-nested" });
    const fromHere = pathToFileURL(join(root, "src", "tui", "app.ts")).href;
    expect(loadCliVersion(fromHere)).toBe("6.4.2-nested");
    expect(loadCoreVersion(fromHere)).toBe("6.4.2-nested");
  });

  it("prefers the CLI manifest name when several manifests are hit", async () => {
    const root = await mkdtemp(join(tmpdir(), "alisio-version-monorepo-"));
    // Monorepo shape: a versioned repo-root manifest plus a real CLI package manifest deeper in
    // the tree. The CLI loader must return the @alisio/alisio-code manifest, not the root one.
    await writeJson(join(root, "package.json"), { name: "alisio-monorepo", version: "1.1.1-mono" });
    await mkdir(join(root, "packages", "cli"), { recursive: true });
    await writeJson(join(root, "packages", "cli", "package.json"), {
      name: "@alisio/alisio-code",
      version: "7.7.7-cli",
    });
    const fromHere = pathToFileURL(join(root, "packages", "cli", "src", "tui", "app.ts")).href;
    expect(loadCliVersion(fromHere)).toBe("7.7.7-cli");
  });

  it("returns dev when no manifest is reachable within the walk bound", async () => {
    vi.stubEnv("ALISIO_PACKAGE_VERSION", "");
    const root = await mkdtemp(join(tmpdir(), "alisio-version-bound-"));
    // A versioned manifest exists at <root>, but the module is 9 directories deep: the loader
    // walks the module dir plus 8 parents and never reaches <root>, so every loader falls back.
    // The deep path also keeps the walk inside the temp subtree (it never scans shared dirs).
    await writeJson(join(root, "package.json"), { version: "9.9.9-out-of-reach" });
    let deep = root;
    for (let depth = 0; depth < 9; depth++) deep = join(deep, `d${depth}`);
    const missing = pathToFileURL(join(deep, "loader.ts")).href;
    for (const load of [
      loadCliVersion,
      loadCoreVersion,
      loadMemoryVersion,
      loadOpenAICompatibleVersion,
      loadSubagentsVersion,
    ])
      expect(load(missing)).toBe("dev");
  });
});

describe("plugin metadata version source", () => {
  it("exposes each plugin's runtime version as its metadata version", async () => {
    // Metadata now derives from the loader; a stale literal would never reach here. The
    // expectation follows each package's manifest so it stays in sync forever.
    const manifestVersion = async (packageDir: string) =>
      (
        JSON.parse(
          await readFile(join(repoRoot(), "packages", packageDir, "package.json"), "utf8"),
        ) as { version?: string }
      ).version ?? "dev";
    expect(createOpenAICompatiblePlugin().version).toBe(
      await manifestVersion("plugin-openai-compatible"),
    );
    expect(createMemoryPlugin({}, { workspace: ".", stateHome: ".", configDir: "." }).version).toBe(
      await manifestVersion("plugin-memory"),
    );
    expect(
      createSubagentsPlugin(
        {},
        {
          workspace: ".",
          stateHome: ".",
          configHome: ".",
          configDir: ".",
          home: ".",
          trusted: false,
        },
      ).version,
    ).toBe(await manifestVersion("plugin-subagents"));
  });
});

describe("no stale version literals in package sources", () => {
  it("keeps every packages/*/src file free of publish-version literals", async () => {
    // Regression: plugin metadata versions, user-agent defaults and the MCP client used to
    // hardcode "0.1.0-alpha.1" / "0.1.0", silently desyncing from the published packages.
    // Only version.ts-compatible loaders may carry versions, and they do not: their only
    // fallback is the development marker "dev". Any future literal match fails this test.
    const root = resolve(import.meta.dirname ?? ".", "..", "packages");
    const offenders: string[] = [];
    for (const name of await readdir(root)) {
      const src = join(root, name, "src");
      for (const file of await walkTs(src)) {
        const text = await readFile(file, "utf8");
        const line = text.split("\n").find((line) => /0\.1\.0(-alpha\.\d+)?/.test(line));
        if (line) offenders.push(`${relative(root, file)}: ${line.trim()}`);
      }
    }
    expect(offenders.join("\n") || "no stale version literals").toBe("no stale version literals");
  });
});

/** Repository root (parent of tests/). */
function repoRoot(): string {
  return resolve(import.meta.dirname ?? ".", "..");
}

/** Recursively lists TypeScript files under a directory (empty when it does not exist). */
async function walkTs(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walkTs(path)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(path);
  }
  return files;
}
const writeJson = (path: string, value: unknown) =>
  import("node:fs/promises").then(({ writeFile }) => writeFile(path, JSON.stringify(value)));
