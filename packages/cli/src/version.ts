import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Fallback used when package.json is not readable (e.g. standalone binaries). */
const FALLBACK = "0.1.0-alpha.1";

/**
 * Reads the package version at runtime so --version, doctor and MCP client metadata
 * stay in sync with the published package without a build-time constant to update.
 * Standalone binaries inject the version at build time via ALISIO_PACKAGE_VERSION.
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
