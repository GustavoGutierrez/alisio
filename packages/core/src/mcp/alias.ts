import { createHash } from "node:crypto";

/** Same pattern as the configuration schema's server-name check (`config.ts`). */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG_LIMIT = 40;
const MIN_HASH = 6;
const MAX_HASH = 32;

export interface McpIdentity {
  /** The full upstream name (it may contain `/`). Identity of the catalog entry, never an alias. */
  registryName: string;
  /** The internal name used in the configuration; it is NOT a security identity. */
  alias: string;
}

const slugOf = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_LIMIT)
    .replace(/-+$/g, "");

const digest = (registryName: string): string =>
  createHash("sha256").update(registryName).digest("hex");

export function isValidMcpAlias(alias: string): boolean {
  return ALIAS.test(alias);
}

/**
 * Derives the internal alias of a registry entry: a readable slug of the title (or of the last
 * segment of the registry name) plus a short stable hash of the FULL registry name, so two
 * upstream names that slugify the same never collide. A manual `alias` is honoured when valid and
 * free. Existing aliases (`taken`) are never reused or renamed: the hash grows deterministically
 * until the alias is free.
 */
export function mcpIdentity(
  registryName: string,
  options: { title?: string; alias?: string; taken?: Iterable<string> } = {},
): McpIdentity {
  const taken = new Set(options.taken ?? []);
  if (options.alias !== undefined) {
    if (!isValidMcpAlias(options.alias))
      throw new Error(
        "The alias must start with a letter or digit and use only letters, digits, dots, dashes and underscores",
      );
    if (taken.has(options.alias)) throw new Error(`The alias "${options.alias}" is already in use`);
    return { registryName, alias: options.alias };
  }
  const last = registryName.split("/").pop() ?? registryName;
  const slug = slugOf(options.title ?? "") || slugOf(last) || "mcp";
  const hash = digest(registryName);
  for (let length = MIN_HASH; length <= MAX_HASH; length += 2) {
    const alias = `${slug}-${hash.slice(0, length)}`;
    if (!taken.has(alias)) return { registryName, alias };
  }
  throw new Error("Could not derive a free alias");
}
