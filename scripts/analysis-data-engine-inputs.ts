/**
 * The source files that make up the data engine bundle and the hash that ties the generated
 * `engine-source.ts` to them (checked by `tests/analysis-data-engine-sources.test.ts`).
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const ENGINE_DIR = "packages/core/src/analysis/data";
/** Every module the engine process imports (the entry first). */
export const ENGINE_INPUTS = [
  "engine-entry.ts",
  "engine-types.ts",
  "csv.ts",
  "infer.ts",
  "ingest-worker.ts",
  "json.ts",
  "query-worker.ts",
  "sql-guard.ts",
  "stats.ts",
];

/**
 * Hash of the inputs with all whitespace removed, so that reformatting (Biome) alone never makes
 * the bundle look stale; any other change does.
 */
export function engineInputsHash(root: string): string {
  const hash = createHash("sha256");
  for (const name of ENGINE_INPUTS) {
    hash.update(name);
    hash.update("\0");
    hash.update(readFileSync(join(root, ENGINE_DIR, name), "utf8").replace(/\s+/g, ""));
    hash.update("\0");
  }
  return hash.digest("hex");
}
