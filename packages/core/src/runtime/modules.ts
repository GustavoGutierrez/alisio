/** Resolution of explicitly trusted plugins given as a path or an npm package name. */
import { dirname, isAbsolute, join, resolve } from "node:path";
import { configHome } from "../config.ts";
import { readJson } from "./fs.ts";

export const PLUGIN_KEYWORD = "alisio-plugin";
/** Paths start with `.`, are absolute, use `\`, end in a JS/TS extension or contain `/` unscoped. */
export function isPathSpec(spec: string): boolean {
  return (
    spec.startsWith(".") ||
    isAbsolute(spec) ||
    /^[A-Za-z]:[\\/]/.test(spec) ||
    spec.includes("\\") ||
    /\.(?:[cm]?[jt]s|tsx|jsx)$/.test(spec) ||
    (!spec.startsWith("@") && spec.includes("/"))
  );
}
/** Global package roots: NODE_PATH entries, the prefix of the running Node/npm, and the
 * Alisio global plugins directory (`<configHome>/plugins`), where `alisio install` puts npm
 * plugin packages. */
export function defaultGlobalRoots(): string[] {
  const prefix =
    process.env.npm_config_prefix ?? process.env.PREFIX ?? dirname(dirname(process.execPath));
  return [
    ...(process.env.NODE_PATH ?? "")
      .split(process.platform === "win32" ? ";" : ":")
      .filter(Boolean),
    process.platform === "win32"
      ? join(prefix, "node_modules")
      : join(prefix, "lib", "node_modules"),
    join(configHome(), "plugins"),
  ];
}
interface Manifest {
  name?: string;
  keywords?: unknown;
  exports?: unknown;
  main?: string;
}
function entryOf(manifest: Manifest): string {
  const exp = manifest.exports;
  const pick = (value: unknown): string | undefined => {
    if (typeof value === "string") return value;
    if (value && typeof value === "object") {
      const record = value as Record<string, unknown>;
      for (const key of ["import", "node", "default"]) {
        const found = pick(record[key]);
        if (found) return found;
      }
    }
    return undefined;
  };
  const root =
    exp && typeof exp === "object" && !Array.isArray(exp) && "." in (exp as object)
      ? (exp as Record<string, unknown>)["."]
      : exp;
  return pick(root) ?? manifest.main ?? "./index.js";
}
/**
 * Returns the file to import (or the directory holding an alisio-plugin.json manifest).
 * Packages are looked up from `from` upwards, then in global roots, and must declare the
 * `alisio-plugin` keyword so a typo cannot load an unrelated package.
 */
export async function resolvePluginSpec(
  spec: string,
  options: { from: string; globalRoots?: string[] },
): Promise<string> {
  if (isPathSpec(spec)) return resolve(options.from, spec);
  const searched: string[] = [];
  const candidates: string[] = [];
  for (let dir = resolve(options.from); ; dir = dirname(dir)) {
    candidates.push(join(dir, "node_modules", spec));
    if (dirname(dir) === dir) break;
  }
  for (const rootDir of options.globalRoots ?? defaultGlobalRoots()) {
    candidates.push(join(rootDir, spec));
    // `alisio install` writes npm packages under <root>/node_modules/<spec>.
    candidates.push(join(rootDir, "node_modules", spec));
  }
  for (const dir of candidates) {
    searched.push(dir);
    const manifest = (await readJson(join(dir, "package.json"))) as Manifest | undefined;
    if (!manifest) continue;
    const keywords = Array.isArray(manifest.keywords) ? manifest.keywords : [];
    if (!keywords.includes(PLUGIN_KEYWORD))
      throw new Error(
        `Package ${spec} is not an Alisio plugin (missing "${PLUGIN_KEYWORD}" keyword)`,
      );
    if (await readJson(join(dir, "alisio-plugin.json"))) return dir;
    return resolve(dir, entryOf(manifest));
  }
  throw new Error(
    `Plugin package ${spec} not found (searched ${searched.length} locations from ${options.from})`,
  );
}
