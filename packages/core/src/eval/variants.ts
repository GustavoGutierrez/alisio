/**
 * Configuration variants of the reliability lab (specs/010 D15, section 7). A variant is a set of
 * dotted-key overrides over the effective configuration. Keys are validated against the REAL
 * config schema (strict objects: an unknown key is rejected and named), never applied as code.
 * The overrides are applied BEFORE `runTask`, which hashes what it writes, so a variant gets its
 * own `configHash`.
 */

import { readFileSync } from "node:fs";
import { z } from "zod";
import { type Config, configSchema } from "../config.ts";
import { CONFIG_HASH_COVERAGE } from "./engine.ts";

export class EvalVariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvalVariantError";
  }
}

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function knownKeysAt(root: Record<string, unknown>, path: string[]): string[] {
  let cursor: unknown = root;
  for (const segment of path) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) return [];
    cursor = cursor[segment];
  }
  return isRecord(cursor) ? Object.keys(cursor).sort() : [];
}

function unknownKey(
  key: string,
  base: Record<string, unknown>,
  parent: string[],
): EvalVariantError {
  const siblings = knownKeysAt(base, parent);
  const where = parent.length > 0 ? `section "${parent.join(".")}"` : "the configuration";
  return new EvalVariantError(
    `Unknown config key "${key}". ${
      siblings.length > 0
        ? `Known keys in ${where}: ${siblings.join(", ")}.`
        : `Use a dotted key of the Alisio configuration, for example "compaction.threshold".`
    }`,
  );
}

/**
 * `base` with `overrides` applied (dotted keys, e.g. `{"compaction.threshold": 0.6}`); `base` is
 * not modified. Throws `EvalVariantError` naming the key for an unknown key, a value the schema
 * refuses, or a key the lab never measures (provider, plugins, MCP, paths: they are outside the
 * configuration hash, so overriding them would change behavior without changing `configHash`).
 */
export function applyConfigOverrides(base: Config, overrides: Record<string, unknown>): Config {
  const { mcpSources: _sources, ...plain } = base as Config & { mcpSources?: unknown };
  const draft = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>;
  const reference = JSON.parse(JSON.stringify(plain)) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    const segments = key.split(".");
    if (segments.some((s) => s === "" || FORBIDDEN_SEGMENTS.has(s)))
      throw unknownKey(key, reference, []);
    const top = segments[0] as string;
    if (!Object.hasOwn(CONFIG_HASH_COVERAGE, top)) throw unknownKey(key, reference, []);
    if (CONFIG_HASH_COVERAGE[top as keyof typeof CONFIG_HASH_COVERAGE] === "excluded")
      throw new EvalVariantError(
        `Config key "${key}" cannot be overridden by a variant: "${top}" is not part of the measured configuration (it holds endpoints, secrets, plugins or paths), so the change would not show up in configHash. Compare models with --model instead.`,
      );
    let cursor = draft;
    for (const [index, segment] of segments.slice(0, -1).entries()) {
      const next = Object.hasOwn(cursor, segment) ? cursor[segment] : undefined;
      if (next === undefined) cursor[segment] = {};
      else if (!isRecord(next)) throw unknownKey(key, reference, segments.slice(0, index + 1));
      cursor = cursor[segment] as Record<string, unknown>;
    }
    cursor[segments[segments.length - 1] as string] = JSON.parse(JSON.stringify(value ?? null));
  }
  const parsed = configSchema.safeParse(draft);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    if (issue && issue.code === "unrecognized_keys") {
      const parent = issue.path.map(String);
      const bad = issue.keys[0] as string;
      throw unknownKey([...parent, bad].join("."), reference, parent);
    }
    const path = issue?.path.map(String).join(".") ?? "";
    throw new EvalVariantError(
      `Invalid value for config key "${path}": ${issue?.message ?? "rejected by the configuration schema"}.`,
    );
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// compare.json
// ---------------------------------------------------------------------------------------------

export interface VariantsFile {
  suite: string;
  variants: Array<{ id: string; overrides: Record<string, unknown> }>;
}

const variantsSchema = z
  .object({
    suite: z.string().min(1),
    variants: z
      .array(
        z
          .object({
            id: z
              .string()
              .regex(
                /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
                "variant ids use letters, digits, dot, underscore or dash",
              ),
            overrides: z.record(z.string(), z.unknown()).default({}),
          })
          .strict(),
      )
      .min(2, "a variants file needs at least two variants (a baseline and a candidate)"),
  })
  .strict();

/** Reads and validates a `compare.json` (`{ suite, variants: [{ id, overrides }] }`). */
export function loadVariantsFile(path: string): VariantsFile {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new EvalVariantError(
      `Cannot read the variants file "${path}": ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new EvalVariantError(`The variants file "${path}" is not valid JSON.`);
  }
  const parsed = variantsSchema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue?.path.length ? ` at "${issue.path.join(".")}"` : "";
    throw new EvalVariantError(
      `Invalid variants file "${path}"${where}: ${issue?.message ?? "invalid"}.`,
    );
  }
  const ids = parsed.data.variants.map((v) => v.id);
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index);
  if (duplicate)
    throw new EvalVariantError(
      `Invalid variants file "${path}": duplicate variant id "${duplicate}".`,
    );
  return parsed.data as VariantsFile;
}

/**
 * Applies every variant's overrides to `base`, all-or-nothing: one bad key rejects the file before
 * anything runs, and the error names the variant and the key.
 */
export function resolveVariants(
  file: VariantsFile,
  base: Config,
): Array<{ id: string; config: Config }> {
  return file.variants.map((variant) => {
    try {
      return { id: variant.id, config: applyConfigOverrides(base, variant.overrides) };
    } catch (error) {
      if (error instanceof EvalVariantError)
        throw new EvalVariantError(`Variant "${variant.id}": ${error.message}`);
      throw error;
    }
  });
}
