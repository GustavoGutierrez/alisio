import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fallback used when neither the build-time injection nor the package manifest is readable.
 * A development marker, never a publish literal: it cannot silently desync from the package.
 */
const FALLBACK = "dev";

/**
 * How many parent directories the loader walks up before giving up. Bounded so a missing
 * manifest can never make the lookup climb an unbounded path.
 */
const MAX_PARENT_HOPS = 8;

/**
 * Walks up from `dir` looking for a package manifest. Returns the version of the nearest
 * manifest that declares a string `version`. `undefined` when no manifest with a version is
 * reached within the bound.
 */
function findManifestVersion(dir: string): string | undefined {
  let nearest: string | undefined;
  let current = dir;
  for (let hop = 0; hop <= MAX_PARENT_HOPS; hop++) {
    try {
      const parsed = JSON.parse(readFileSync(join(current, "package.json"), "utf8")) as {
        version?: unknown;
      };
      if (typeof parsed.version === "string" && parsed.version) nearest ??= parsed.version;
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
 * Reads the @alisio/core package version at runtime so the MCP client metadata stays in sync
 * with the published package. The manifest is resolved by walking UP from the module directory
 * until a package.json with a string `version` is found (bounded, any depth: module, then up to
 * 8 parents), so a deeply nested call site like `src/mcp/connector.ts` resolves the same
 * manifest as `src/version.ts`. Standalone binaries inject ALISIO_PACKAGE_VERSION at build time
 * (scripts/binary-build.ts).
 */
export function loadVersion(fromHere: string): string {
  if (process.env.ALISIO_PACKAGE_VERSION) return process.env.ALISIO_PACKAGE_VERSION;
  try {
    return findManifestVersion(dirname(fileURLToPath(fromHere))) ?? FALLBACK;
  } catch {
    return FALLBACK;
  }
}
