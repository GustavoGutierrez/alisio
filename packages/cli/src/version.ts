import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fallback used when neither the build-time injection nor the package manifest is readable
 * (e.g. an unpackaged embed). Keep it a development marker, never a publish literal, so it
 * cannot silently desync from the published package.
 */
const FALLBACK = "dev";

/**
 * How many parent directories the loader walks up before giving up. Bounded so a missing
 * manifest can never make the lookup climb an unbounded path.
 */
const MAX_PARENT_HOPS = 8;

/** Manifests whose `name` identifies the CLI package; preferred when several are hit. */
const CLI_MANIFEST_NAMES = new Set(["@alisio/alisio-code", "alisio"]);

/**
 * Walks up from `dir` looking for a package manifest. Returns the version of the nearest
 * manifest that declares a string `version`, preferring a manifest whose `name` identifies the
 * CLI package (`@alisio/alisio-code`/`alisio`) when several are hit — e.g. running from source
 * inside the monorepo, where the repo-root manifest is also a candidate. `undefined` when no
 * manifest with a version is reached within the bound.
 */
function findManifestVersion(dir: string): string | undefined {
  let nearest: string | undefined;
  let current = dir;
  for (let hop = 0; hop <= MAX_PARENT_HOPS; hop++) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version) {
        if (typeof parsed.name === "string" && CLI_MANIFEST_NAMES.has(parsed.name))
          return parsed.version;
        nearest ??= parsed.version;
      }
    } catch {
      // No manifest here; keep walking up.
    }
    const parent = dirname(current);
    if (parent === current) break; // Filesystem root.
    current = parent;
  }
  return nearest;
}

/**
 * Reads the package version at runtime so --version, the TUI header, doctor, plugin metadata and
 * MCP client metadata stay in sync with the published package without a build-time constant to
 * update. The manifest is resolved by walking UP from the module directory until a package.json
 * with a string `version` is found (bounded, any depth: module, then up to 8 parents), so deeply
 * nested call sites like `src/tui/app.ts` and compiled `dist/*` resolve the same manifest as
 * `src/main.ts`. Standalone binaries inject the version at build time via
 * ALISIO_PACKAGE_VERSION (scripts/binary-build.ts).
 */
export function loadVersion(fromHere: string): string {
  if (process.env.ALISIO_PACKAGE_VERSION) return process.env.ALISIO_PACKAGE_VERSION;
  try {
    return findManifestVersion(dirname(fileURLToPath(fromHere))) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
