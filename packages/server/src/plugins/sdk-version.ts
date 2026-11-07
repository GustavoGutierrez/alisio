import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Version of the installed `@alisio/sdk`, read from the nearest `package.json` of the package the
 * server itself resolves. `undefined` when it cannot be found (a standalone binary, say): the
 * catalog then reports every plugin as compatible instead of guessing.
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
        if (manifest.name === "@alisio/sdk") return manifest.version;
      } catch {
        /* keep walking up */
      }
      dir = dirname(dir);
    }
  } catch {
    /* not resolvable here */
  }
  return undefined;
}
