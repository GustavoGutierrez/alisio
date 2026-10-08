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
 * Reads this plugin package's version at runtime so plugin metadata stays in sync with the
 * published package without a build-time constant to update. The manifest is resolved relative
 * to the module (`src/version.ts` → `../package.json` in the source tree; `dist/version.js` →
 * `../package.json` of the installed package). Standalone binaries inject the version at build
 * time via ALISIO_PACKAGE_VERSION (scripts/binary-build.ts).
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
