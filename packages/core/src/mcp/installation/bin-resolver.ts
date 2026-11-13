/**
 * Reads what an npm install left on disk (specs/030 §19.6): which executable the package declares
 * and whether any package in the resolved tree wants lifecycle scripts. Pure functions over the
 * parsed `package.json` / `package-lock.json`; the installer does the file access.
 */
import { isAbsolute, normalize, sep } from "node:path";

export type BinResolution =
  | { ok: true; name: string; path: string }
  | { ok: false; reason: "no_bin" | "ambiguous" | "unknown_bin" | "unsafe_bin"; choices: string[] };

const unscoped = (packageName: string) => packageName.split("/").pop() ?? packageName;

function binMap(pkg: unknown, packageName: string): Record<string, string> {
  const bin = (pkg as { bin?: unknown } | undefined)?.bin;
  if (typeof bin === "string") return { [unscoped(packageName)]: bin };
  if (bin && typeof bin === "object" && !Array.isArray(bin)) {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(bin as Record<string, unknown>))
      if (typeof value === "string") out[key] = value;
    return out;
  }
  return {};
}

/** A relative path that stays inside the package directory (no absolute path, no `..`). */
function safeRelative(path: string): string | undefined {
  if (!path || isAbsolute(path) || path.includes("\0")) return undefined;
  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith(`..${sep}`) || isAbsolute(normalized))
    return undefined;
  return normalized;
}

/**
 * Chooses the executable: the only one declared, or (with several) the one named like the package
 * without its scope. Anything else is ambiguous and needs an explicit choice (`requested`), which
 * must be one of the declared names; the choice is never guessed.
 */
export function resolveBin(
  packageJson: unknown,
  packageName: string,
  requested?: string,
): BinResolution {
  const map = binMap(packageJson, packageName);
  const names = Object.keys(map);
  if (!names.length) return { ok: false, reason: "no_bin", choices: [] };
  let chosen: string | undefined;
  if (requested !== undefined) {
    if (!(requested in map)) return { ok: false, reason: "unknown_bin", choices: names };
    chosen = requested;
  } else if (names.length === 1) chosen = names[0];
  else if (unscoped(packageName) in map) chosen = unscoped(packageName);
  if (chosen === undefined) return { ok: false, reason: "ambiguous", choices: names };
  const path = safeRelative(map[chosen] as string);
  if (!path) return { ok: false, reason: "unsafe_bin", choices: names };
  return { ok: true, name: chosen, path };
}

export interface LockfileFacts {
  /** Names of packages whose lockfile entry declares `hasInstallScript`. */
  installScripts: string[];
  /** The `integrity` of the root dependency, when present. */
  integrity?: string;
}

/** Facts from a `package-lock.json` (lockfileVersion 2/3) of the generated one-dependency project. */
export function readLockfile(lock: unknown, packageName: string): LockfileFacts {
  const packages = (lock as { packages?: Record<string, Record<string, unknown>> } | undefined)
    ?.packages;
  const installScripts: string[] = [];
  for (const [key, value] of Object.entries(packages ?? {})) {
    if (!key || value?.hasInstallScript !== true) continue;
    installScripts.push(key.replace(/^.*node_modules\//, "") || key);
  }
  const root = packages?.[`node_modules/${packageName}`];
  const integrity = typeof root?.integrity === "string" ? root.integrity : undefined;
  return { installScripts, ...(integrity ? { integrity } : {}) };
}
