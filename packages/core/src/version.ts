import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Fallback used when neither the build-time injection nor the package manifest is readable.
 * A development marker, never a publish literal: it cannot silently desync from the package.
 */
const FALLBACK = "dev";

/**
 * Reads the @alisio/core package version at runtime so the MCP client metadata stays in sync
 * with the published package. Resolves the manifest relative to the module (`src/version.ts` →
 * `../package.json` in the source tree; `dist/version.js` → `../package.json` when installed).
 * Standalone binaries inject ALISIO_PACKAGE_VERSION at build time (scripts/binary-build.ts).
 */
export function loadVersion(fromHere: string): string {
  if (process.env.ALISIO_PACKAGE_VERSION) return process.env.ALISIO_PACKAGE_VERSION;
  try {
    const manifest = join(dirname(fileURLToPath(fromHere)), "..", "package.json");
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" && parsed.version ? parsed.version : FALLBACK;
  } catch {
    return FALLBACK;
  }
}
