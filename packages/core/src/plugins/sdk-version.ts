import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadVersion } from "../version.ts";

/**
 * Version of the `@alisio/sdk` this process runs, read from the nearest `package.json` of the
 * package it resolves. When it cannot be resolved (a standalone binary), the core's own version is
 * used: the packages are released in lockstep. `undefined` when neither is a release version.
 */
export function installedSdkVersion(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.resolve("@alisio/sdk")));
    for (let depth = 0; depth < 6; depth++) {
      try {
        const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === "@alisio/sdk" && manifest.version) return manifest.version;
      } catch {
        /* keep walking up */
      }
      dir = dirname(dir);
    }
  } catch {
    /* not resolvable here */
  }
  const own = loadVersion(import.meta.url);
  return /^\d+\.\d+\.\d+/.test(own) ? own : undefined;
}
