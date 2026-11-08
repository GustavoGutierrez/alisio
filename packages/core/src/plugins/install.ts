/**
 * Installer for npm plugin packages: `alisio install npm:<package>[@<version>]`.
 *
 * One shared routine (`installPlugin`) backs both the CLI command (`cliInstall`) and the
 * host-owned `plugin_install` tool for the agent, so the two can never drift apart. The install
 * target is the GLOBAL plugins directory `<configHome>/plugins` (default `~/.config/alisio/plugins`),
 * installed with `npm install --prefix`; the package NAME is persisted in the global configuration
 * `plugins` array (never the resolved filesystem path), keeping entries portable. Loading the plugin
 * still follows the existing executable-plugin policy: it runs in-process wherever it is loaded and
 * is disabled entirely under `--read-only`.
 */
import { chmod, mkdir, open, readdir, rename, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ToolDefinition, textResult } from "@alisio/sdk";
import { configHome } from "../config.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { readJson } from "../runtime/fs.ts";
import { PLUGIN_KEYWORD } from "../runtime/modules.ts";
import type { ProcessResult } from "../runtime/process.ts";
import { runNpm } from "./npm-runner.ts";

/** npm package name: scope (optional) followed by the name; both start with an alphanumeric. */
const PACKAGE_PART = "[A-Za-z0-9][A-Za-z0-9._-]*";
const NAME_RE = new RegExp(`^(?:@${PACKAGE_PART}\\/)?${PACKAGE_PART}$`);
/** Version specifier: npm's `@<version>` part, restricted to the same safe character set. */
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PluginSpec {
  name: string;
  version?: string;
}

/**
 * Validates an install spec without touching the network: `npm:<package>[@<version>]` (canonical),
 * a bare package name (same resolution), and nothing else. Rejects shell metacharacters, `..` /
 * absolute paths, and unknown prefixes (`registry:`, `git:`, `file:`, URLs) with a clear error.
 */
export function parsePluginSpec(spec: string): PluginSpec {
  if (!spec || !spec.trim())
    throw new Error(
      "Plugin spec is empty: use npm:<package>[@<version>] or a bare package name, for example npm:plugin-openrouter",
    );
  const trimmed = spec.trim();
  let rest = trimmed;
  if (trimmed.startsWith("npm:")) rest = trimmed.slice(4);
  else {
    const colon = trimmed.indexOf(":");
    if (colon >= 0)
      throw new Error(
        `Unsupported plugin spec prefix "${trimmed.slice(0, colon)}:": only npm:<package>[@<version>] ` +
          `or a bare package name is supported (registry:/git:/file:/http: specs are not)` +
          (trimmed.startsWith("registry:")
            ? "; pass the package name directly instead of a registry URL"
            : ""),
      );
  }
  if (!rest) throw new Error(`Plugin spec "${spec}" has no package name`);
  const at = rest.lastIndexOf("@");
  let name = rest;
  let version: string | undefined;
  if (at > 0) {
    name = rest.slice(0, at);
    version = rest.slice(at + 1);
  }
  if (name.length > 214) throw new Error(`Invalid plugin spec "${spec}": package name is too long`);
  if (!NAME_RE.test(name) || name.includes(".."))
    throw new Error(
      `Invalid plugin package name "${name}" in spec "${spec}": allowed characters are letters, ` +
        `digits, dot, underscore and dash, with "/" only for a scoped name and "@" only for a version; ` +
        `names may not start with "." or "_" and may not contain ".."`,
    );
  if (version !== undefined && !VERSION_RE.test(version))
    throw new Error(
      `Invalid plugin version "${version}" in spec "${spec}": versions may contain only letters, ` +
        `digits, dot, underscore and dash (for example 1.2.3, 1.2.3-beta.1 or latest)`,
    );
  return { name, version };
}

/** The npm argument for a spec: `name`, `name@<version>` or `name@latest` for `--update`. */
export function npmInstallTarget(name: string, version?: string, update = false): string {
  return update ? `${name}@latest` : version ? `${name}@${version}` : name;
}

/**
 * Injectable process runner so tests can substitute a fake `npm` without a network or a PATH shim.
 * The default runs the real npm with a generous timeout and bounded output.
 */
export type InstallRunner = (
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; env?: Record<string, string> },
) => Promise<ProcessResult>;

export const INSTALL_TIMEOUT_MS = 300_000;
export const defaultInstallRunner: InstallRunner = (command, args, options) =>
  runNpm(command, args, options, { timeoutMs: INSTALL_TIMEOUT_MS, maxBytes: 64_000 });

export interface InstallPluginInput {
  /** `npm:<package>[@<version>]` or a bare package name. */
  spec: string;
  /** Defaults to `configHome()` (ALISIO_CONFIG_HOME, else ~/.config/alisio). */
  configHome?: string;
  /** Refresh an already-installed package to `@latest`, keeping the npm name in the config. */
  update?: boolean;
  /**
   * Run npm even when the package is already installed, at exactly `spec`'s version (an explicit
   * reinstall or downgrade from the catalog). `update` instead takes `@latest`.
   */
  force?: boolean;
  /** Refuse immediately; loading and installing executable plugins is disabled under --read-only. */
  readOnly?: boolean;
  signal?: AbortSignal;
  /** Injected installer for tests (fake npm); defaults to the real npm. */
  runner?: InstallRunner;
}

export interface InstallPluginResult {
  packageName: string;
  /** Version read back from the installed package.json, or "unknown". */
  installedVersion: string;
  /** `<configHome>/plugins/node_modules/<name>` (a directory). */
  path: string;
  /** The npm name persisted in the global configuration `plugins` array. */
  configEntry: string;
  /** The global configuration file that received the entry. */
  configFile: string;
  pluginsDir: string;
  /** Already present in the global plugins directory before this call (no npm run performed). */
  alreadyInstalled: boolean;
  /** Version that was installed before this call, when there was one. */
  previousVersion?: string;
  /** Refreshed (to `@latest`, or reinstalled at the requested version) by this call. */
  updated: boolean;
  /** Plain-text remark about where the plugin loads and how project trust applies. */
  trustRemark: string;
}

/**
 * Redacts probable secrets from npm output (auth tokens, JWTs, bearer credentials, userinfo in
 * URLs) and caps the size, so a failing install never echoes credentials to the user.
 */
export function sanitizeNpmError(text: string, maxLength = 4000): string {
  const MAX = Math.max(1, maxLength);
  let cleaned = text.replace(
    /(eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+|\bbearer\s+[A-Za-z0-9._~+/-]{12,}=*\b|\b(?:npm_?authToken|_authToken|NODE_AUTH_TOKEN|NPM_TOKEN|authToken|password|secret)\b\s*(?:=|:)\s*\S+|\b(?:npm_?authToken|_authToken|NODE_AUTH_TOKEN|NPM_TOKEN|authToken|password|secret)\b\s+\S+)/gi,
    "[redacted]",
  );
  cleaned = cleaned.replace(/([a-z][a-z0-9+.-]*):\/\/[^@\s/]+@/gi, "$1://[redacted]@");
  if (cleaned.length > MAX) cleaned = `${cleaned.slice(0, MAX)}\n…[npm output truncated]`;
  return cleaned;
}

/** True when npm's output is a dependency-resolution (peer conflict) failure. */
export function isPeerConflict(output: string): boolean {
  return /\bERESOLVE\b|Conflicting peer dependency|Could not resolve dependency/.test(output);
}

/**
 * Package names from the global config `plugins` array that are really installed under
 * `<pluginsDir>/node_modules` (names only; file/directory entries are ignored).
 */
export async function installedGlobalPluginPackages(home: string): Promise<string[]> {
  const config = (await readJson(join(home, "config.json"))) as { plugins?: unknown } | undefined;
  const entries = Array.isArray(config?.plugins) ? (config.plugins as unknown[]) : [];
  const names: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== "string" || !NAME_RE.test(entry) || entry.includes("..")) continue;
    if (names.includes(entry)) continue;
    const manifest = (await readJson(
      join(home, "plugins", "node_modules", entry, "package.json"),
    )) as { version?: string } | undefined;
    if (manifest?.version) names.push(entry);
  }
  return names;
}

/**
 * A failed `npm install` of plugin packages. `peerConflict` is detected structurally (npm's
 * `code ERESOLVE` line, with the older phrases as a fallback) so callers can react to it without
 * matching message text. The message is sanitized (no credentials) and bounded.
 */
export class NpmInstallError extends Error {
  readonly peerConflict: boolean;
  /** npm's own error code (`ERESOLVE`, `E404`, ...) when its output carried one. */
  readonly npmCode?: string;
  readonly exitCode: number | null;

  constructor(
    message: string,
    details: { peerConflict: boolean; npmCode?: string; exitCode: number | null },
  ) {
    super(message);
    this.name = "NpmInstallError";
    this.peerConflict = details.peerConflict;
    if (details.npmCode) this.npmCode = details.npmCode;
    this.exitCode = details.exitCode;
  }
}

/** The code on npm's `npm error code <CODE>` (or `npm ERR! code <CODE>`) line. */
function npmErrorCode(output: string): string | undefined {
  return /^npm (?:error|ERR!) code ([A-Z][A-Z0-9_]*)\s*$/m.exec(output)?.[1];
}

function npmInstallError(
  label: string,
  targets: string[],
  pluginsDir: string,
  result: ProcessResult,
  installed: string[],
  /** Single-package install the user typed (shows the `alisio install` alternative). */
  single?: string,
): NpmInstallError {
  const raw = [result.stdout, result.stderr].filter(Boolean).join("\n");
  const detail = sanitizeNpmError(raw);
  const head = `npm install failed for ${label} (exit ${result.exitCode}).\n${detail || "no output"}\n`;
  const npmCode = npmErrorCode(raw);
  const peerConflict = npmCode === "ERESOLVE" || isPeerConflict(raw);
  const details = { peerConflict, ...(npmCode ? { npmCode } : {}), exitCode: result.exitCode };
  if (peerConflict) {
    const involved = installed.filter((name) => raw.includes(`from ${name}@`));
    const list = involved.length > 0 ? involved : installed;
    const next = single
      ? `Update them all first (or uninstall the ones that have no newer release), then run the install again:\n  alisio install --update\n  alisio install npm:${single}`
      : `Even updating them together did not resolve it: at least one plugin listed above has no ` +
        `release that works with the newer @alisio/sdk yet. Uninstall it or wait for its update, ` +
        `then try again.`;
    return new NpmInstallError(
      `${head}The install failed because plugins you already have installed require an older ` +
        `@alisio/sdk than the one this package needs, so npm cannot satisfy both at once.\n` +
        (list.length > 0 ? `Installed plugins involved: ${list.join(", ")}\n` : "") +
        next,
      details,
    );
  }
  const retry = `npm install --prefix ${pluginsDir} ${targets.join(" ")}`;
  return new NpmInstallError(
    `${head}Retry with: ${retry}` +
      (single ? `\n(or: alisio install npm:${single})` : "\n(or: alisio install --update)"),
    details,
  );
}

/**
 * Atomically rewrites the global configuration `plugins` array through `update`, preserving every
 * other field. Returns the file path and whether the array changed (no write when it did not).
 */
async function updateGlobalPluginEntries(
  configHomeDir: string,
  update: (current: unknown[]) => unknown[],
  options: { createIfMissing: boolean },
): Promise<{ file: string; changed: boolean }> {
  const file = join(configHomeDir, "config.json");
  const existing = await readJson(file);
  let raw: Record<string, unknown>;
  if (existing === undefined) {
    if (!options.createIfMissing) return { file, changed: false };
    raw = {};
  } else if (typeof existing === "object" && !Array.isArray(existing))
    raw = existing as Record<string, unknown>;
  else throw new Error(`Global Alisio configuration must be a JSON object: ${file}`);
  const current = Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : [];
  const next = update(current);
  const changed = next.length !== current.length || next.some((entry, i) => entry !== current[i]);
  if (!changed && existing !== undefined) return { file, changed: false };
  raw.plugins = next;
  raw.schemaVersion ??= 1;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(raw, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { file, changed: true };
}

/** Atomically adds `packageName` to the global configuration `plugins` array, preserving all other fields. */
export async function persistGlobalPluginEntry(
  configHomeDir: string,
  packageName: string,
): Promise<string> {
  const { file } = await updateGlobalPluginEntries(
    configHomeDir,
    (current) => (current.includes(packageName) ? current : [...current, packageName]),
    { createIfMissing: true },
  );
  return file;
}

/** Atomically removes `packageName` from the global configuration `plugins` array. */
export async function removeGlobalPluginEntry(
  configHomeDir: string,
  packageName: string,
): Promise<boolean> {
  const { changed } = await updateGlobalPluginEntries(
    configHomeDir,
    (current) => current.filter((entry) => entry !== packageName),
    { createIfMissing: false },
  );
  return changed;
}

/** The dependency spec npm recorded for `name` in `<pluginsDir>/package.json`, if any. */
export async function pluginDependencySpec(
  pluginsDir: string,
  name: string,
): Promise<string | undefined> {
  const manifest = (await readJson(join(pluginsDir, "package.json")).catch(() => undefined)) as
    | { dependencies?: Record<string, unknown> }
    | undefined;
  const spec = manifest?.dependencies?.[name];
  return typeof spec === "string" ? spec : undefined;
}

export const LOCAL_PACKAGES_DIR = "local-packages";

/**
 * The stored tarball a `file:` dependency spec points at, only when it lives inside
 * `<pluginsDir>/local-packages` (anything else, including `..` escapes, is never deleted by us).
 */
export function storedTarballOf(pluginsDir: string, spec: string | undefined): string | undefined {
  if (!spec?.startsWith("file:")) return undefined;
  const target = resolve(pluginsDir, spec.slice(5));
  const root = join(pluginsDir, LOCAL_PACKAGES_DIR);
  if (dirname(target) !== root || !/\.(tgz|tar\.gz)$/.test(target)) return undefined;
  return target;
}

/** The shared install routine used by both the CLI command and the `plugin_install` tool. */
export async function installPlugin(input: InstallPluginInput): Promise<InstallPluginResult> {
  const parsed = parsePluginSpec(input.spec);
  if (input.readOnly)
    throw new Error(
      `Installing npm plugin "${parsed.name}" is unavailable under --read-only: installation runs npm and writes your global configuration. Run without --read-only.`,
    );
  const home = resolve(input.configHome ?? configHome());
  const pluginsDir = join(home, "plugins");
  // npm creates the prefix directory itself, but the subprocess cwd must already exist for spawn.
  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  const packageDir = join(pluginsDir, "node_modules", parsed.name);
  const installedManifest = (await readJson(join(packageDir, "package.json"))) as
    | { version?: string }
    | undefined;
  const alreadyInstalled = !!installedManifest?.version;
  let updated = false;
  if (!alreadyInstalled || input.update || input.force) {
    const signal = input.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS);
    const run = input.runner ?? defaultInstallRunner;
    const npmResult = await run(
      "npm",
      [
        "install",
        "--prefix",
        pluginsDir,
        npmInstallTarget(parsed.name, parsed.version, input.update),
      ],
      { cwd: pluginsDir, signal },
    );
    if (npmResult.exitCode !== 0)
      throw npmInstallError(
        `plugin "${parsed.name}"`,
        [npmInstallTarget(parsed.name, parsed.version, input.update)],
        pluginsDir,
        npmResult,
        await installedGlobalPluginPackages(home),
        npmInstallTarget(parsed.name, parsed.version),
      );
    updated = (!!input.update || !!input.force) && alreadyInstalled;
  }
  const manifest = (await readJson(join(packageDir, "package.json"))) as
    | { version?: string }
    | undefined;
  const installedVersion = manifest?.version ?? "unknown";
  const configFile = await persistGlobalPluginEntry(home, parsed.name);
  return {
    packageName: parsed.name,
    installedVersion,
    path: packageDir,
    configEntry: parsed.name,
    configFile,
    pluginsDir,
    alreadyInstalled,
    ...(installedManifest?.version ? { previousVersion: installedManifest.version } : {}),
    updated,
    trustRemark: pluginTrustRemark(parsed.name),
  };
}

/** Globally installed plugin packages (configured and present on disk) with their versions. */
export async function installedGlobalPlugins(
  home: string,
): Promise<Array<{ name: string; version: string }>> {
  const result: Array<{ name: string; version: string }> = [];
  for (const name of await installedGlobalPluginPackages(home)) {
    const manifest = (await readJson(
      join(home, "plugins", "node_modules", name, "package.json"),
    )) as { version?: string } | undefined;
    result.push({ name, version: manifest?.version ?? "unknown" });
  }
  return result;
}

export interface UninstallPluginInput {
  /** The npm package name (no `npm:` prefix, no version). */
  packageName: string;
  /** Defaults to `configHome()` (ALISIO_CONFIG_HOME, else ~/.config/alisio). */
  configHome?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  /** Injected npm for tests; defaults to the real (or bundled) npm. */
  runner?: InstallRunner;
}

export interface UninstallPluginResult {
  packageName: string;
  /** The package was installed or configured before this call (false = nothing to do). */
  removed: boolean;
  pluginsDir: string;
  configFile: string;
}

/**
 * Removes a package from the global plugins directory (`npm uninstall --prefix`) and its name from
 * the global configuration `plugins` array. Idempotent: an absent package only cleans a stale
 * config entry. The config is untouched when npm fails.
 */
export async function uninstallPlugin(input: UninstallPluginInput): Promise<UninstallPluginResult> {
  const parsed = parsePluginSpec(input.packageName);
  if (parsed.version !== undefined || input.packageName.trim().startsWith("npm:"))
    throw new Error(
      `Invalid package name "${input.packageName}": pass the bare npm package name, without "npm:" or a version`,
    );
  if (input.readOnly)
    throw new Error(
      `Uninstalling npm plugin "${parsed.name}" is unavailable under --read-only: it runs npm and writes your global configuration. Run without --read-only.`,
    );
  const home = resolve(input.configHome ?? configHome());
  const pluginsDir = join(home, "plugins");
  const packageDir = join(pluginsDir, "node_modules", parsed.name);
  const manifest = (await readJson(join(packageDir, "package.json"))) as
    | { version?: string }
    | undefined;
  const present = manifest !== undefined;
  const dependency = await pluginDependencySpec(pluginsDir, parsed.name);
  const stored = storedTarballOf(pluginsDir, dependency);
  if (present || dependency !== undefined) {
    const signal = input.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS);
    const run = input.runner ?? defaultInstallRunner;
    const result = await run("npm", ["uninstall", "--prefix", pluginsDir, parsed.name], {
      cwd: pluginsDir,
      signal,
    });
    if (result.exitCode !== 0) {
      const detail = sanitizeNpmError([result.stdout, result.stderr].filter(Boolean).join("\n"));
      throw new Error(
        `npm uninstall failed for plugin "${parsed.name}" (exit ${result.exitCode}).\n${detail || "no output"}`,
      );
    }
  }
  const { file, changed } = await updateGlobalPluginEntries(
    home,
    (current) => current.filter((entry) => entry !== parsed.name),
    { createIfMissing: false },
  );
  // The copy kept for a local-file install goes with the package.
  if (stored) await rm(stored, { force: true });
  return {
    packageName: parsed.name,
    removed: present || changed || stored !== undefined,
    pluginsDir,
    configFile: file,
  };
}

export interface UpdateAllPluginsInput {
  configHome?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  runner?: InstallRunner;
}

export interface UpdateAllPluginsResult {
  /** Packages refreshed to `@latest` in one npm call (empty when none were installed). */
  packages: Array<{ name: string; version: string }>;
  pluginsDir: string;
}

/**
 * Refreshes every plugin package installed in the global plugins directory in ONE
 * `npm install --prefix <plugins> <pkg>@latest ...` call, which lets npm resolve all peer ranges
 * together (updating one by one keeps hitting the same peer conflict).
 */
export async function updateAllPlugins(
  input: UpdateAllPluginsInput,
): Promise<UpdateAllPluginsResult> {
  if (input.readOnly)
    throw new Error(
      "Updating npm plugins is unavailable under --read-only: it runs npm. Run without --read-only.",
    );
  const home = resolve(input.configHome ?? configHome());
  const names = await installedGlobalPluginPackages(home);
  const result = await installPluginsTogether({
    configHome: home,
    packages: names.map((name) => ({ name })),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  });
  return {
    packages: result.packages.map(({ name, version }) => ({ name, version })),
    pluginsDir: result.pluginsDir,
  };
}

export interface InstallTogetherInput {
  /** Packages to install in one call; no `version` means `@latest`. */
  packages: Array<{ name: string; version?: string }>;
  configHome?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  runner?: InstallRunner;
}

export interface InstalledTogether {
  name: string;
  /** Version read back from the installed package.json, or "unknown". */
  version: string;
  /** Version installed before this call, when there was one. */
  previousVersion?: string;
}

export interface InstallTogetherResult {
  packages: InstalledTogether[];
  pluginsDir: string;
}

/**
 * Installs or updates several plugin packages in ONE `npm install --prefix <plugins> a b ...`
 * call, so npm resolves every `@alisio/sdk` peer range together. Never forces or relaxes peers
 * (no `--force`, no `--legacy-peer-deps`). The names are persisted in the global config.
 */
export async function installPluginsTogether(
  input: InstallTogetherInput,
): Promise<InstallTogetherResult> {
  if (input.readOnly)
    throw new Error(
      "Installing npm plugins is unavailable under --read-only: it runs npm and writes your global configuration. Run without --read-only.",
    );
  const home = resolve(input.configHome ?? configHome());
  const pluginsDir = join(home, "plugins");
  const seen = new Set<string>();
  const specs = input.packages.map(({ name, version }) => {
    const parsed = parsePluginSpec(version ? `${name}@${version}` : name);
    if (seen.has(parsed.name))
      throw new Error(`Plugin package "${parsed.name}" is listed more than once`);
    seen.add(parsed.name);
    return parsed;
  });
  if (specs.length === 0) return { packages: [], pluginsDir };
  await mkdir(pluginsDir, { recursive: true, mode: 0o700 });
  const versionOf = async (name: string) =>
    (
      (await readJson(join(pluginsDir, "node_modules", name, "package.json"))) as
        | { version?: string }
        | undefined
    )?.version;
  const previous = new Map<string, string | undefined>();
  for (const spec of specs) previous.set(spec.name, await versionOf(spec.name));
  const targets = specs.map((spec) =>
    spec.version
      ? npmInstallTarget(spec.name, spec.version)
      : npmInstallTarget(spec.name, undefined, true),
  );
  const signal = input.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS);
  const run = input.runner ?? defaultInstallRunner;
  const npmResult = await run("npm", ["install", "--prefix", pluginsDir, ...targets], {
    cwd: pluginsDir,
    signal,
  });
  if (npmResult.exitCode !== 0)
    throw npmInstallError(
      specs.length === 1 ? `plugin "${specs[0]?.name}"` : "the selected plugins",
      targets,
      pluginsDir,
      npmResult,
      await installedGlobalPluginPackages(home),
    );
  const packages: InstalledTogether[] = [];
  for (const spec of specs) {
    await persistGlobalPluginEntry(home, spec.name);
    const before = previous.get(spec.name);
    packages.push({
      name: spec.name,
      version: (await versionOf(spec.name)) ?? "unknown",
      ...(before ? { previousVersion: before } : {}),
    });
  }
  return { packages, pluginsDir };
}

export interface InstallResolvingPeersInput {
  /** The package the user chose to install or update (`version` absent = `@latest`). */
  target: { name: string; version?: string };
  /**
   * Other installed plugins that have a newer release. Only used when npm reports a peer
   * conflict: they are then installed in the same single npm call as the target.
   */
  companions: Array<{ name: string; version?: string }>;
  configHome?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  runner?: InstallRunner;
}

export interface InstallResolvingPeersResult extends InstallPluginResult {
  /** Other plugins updated in the same npm call because the single install had a peer conflict. */
  coUpdated: InstalledTogether[];
}

/**
 * Installs `target` at its version, replacing an installed copy. If npm answers with a peer
 * conflict (ERESOLVE) and there are companions, it retries exactly ONCE as one combined install
 * of the target plus the companions; any other failure, or a conflict that survives the retry, is
 * thrown as a `NpmInstallError`. Peers are never forced.
 */
export async function installPluginResolvingPeers(
  input: InstallResolvingPeersInput,
): Promise<InstallResolvingPeersResult> {
  const { target } = input;
  const common = {
    ...(input.configHome ? { configHome: input.configHome } : {}),
    ...(input.readOnly ? { readOnly: true } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.runner ? { runner: input.runner } : {}),
  };
  try {
    const single = await installPlugin({
      ...common,
      spec: `npm:${target.name}${target.version ? `@${target.version}` : ""}`,
      force: true,
    });
    return { ...single, coUpdated: [] };
  } catch (error) {
    const companions = input.companions.filter((item) => item.name !== target.name);
    if (!(error instanceof NpmInstallError) || !error.peerConflict || companions.length === 0)
      throw error;
    const together = await installPluginsTogether({
      ...common,
      packages: [target, ...companions],
    });
    const home = resolve(input.configHome ?? configHome());
    const primary = together.packages.find((item) => item.name === target.name);
    return {
      packageName: target.name,
      installedVersion: primary?.version ?? "unknown",
      path: join(together.pluginsDir, "node_modules", target.name),
      configEntry: target.name,
      configFile: join(home, "config.json"),
      pluginsDir: together.pluginsDir,
      alreadyInstalled: !!primary?.previousVersion,
      ...(primary?.previousVersion ? { previousVersion: primary.previousVersion } : {}),
      updated: !!primary?.previousVersion,
      trustRemark: pluginTrustRemark(target.name),
      coUpdated: together.packages.filter((item) => item.name !== target.name),
    };
  }
}

/** Final remark about loading and project trust, printed by the CLI and returned by the tool. */
export function pluginTrustRemark(name: string): string {
  return (
    `The plugin "${name}" is installed globally for your user; it loads as trusted personal code ` +
    `wherever global plugins load — use \`alisio --trust-project\` or accept the one-time trust prompt ` +
    `in a project so its configuration and project plugins load too. \`--read-only\` keeps the plugin ` +
    `from loading. Run \`alisio plugins list\` to inspect.`
  );
}

const PREINSTALL_WARNING =
  `Warning: "npm install" may run the package's lifecycle scripts (preinstall, install, postinstall) ` +
  `with your user privileges. Alisio does not sandbox plugin installation or plugin code; the plugin ` +
  `runs in-process if it is loaded. Only install packages you trust.`;

export interface CliInstallOptions {
  spec: string;
  configHome?: string;
  /** `--yes`/`--trust-plugin`: skip the interactive pre-install confirmation. */
  yes?: boolean;
  update?: boolean;
  readOnly?: boolean;
  /** True when the CLI can prompt (interactive TTY, not --json). */
  interactive?: boolean;
  /** Print the result as JSON instead of human lines. */
  json?: boolean;
  signal?: AbortSignal;
  runner?: InstallRunner;
  /** Injectable confirmation for the interactive path (tests); defaults to a readline prompt. */
  confirm?: () => Promise<boolean>;
}

export async function cliInstall(options: CliInstallOptions): Promise<InstallPluginResult> {
  // Validate the spec before any network operation or prompt.
  const parsed = parsePluginSpec(options.spec);
  if (options.readOnly)
    throw new Error(
      `Refusing to install npm plugin "${parsed.name}" under --read-only: installing runs npm and writes your global configuration. Run the command without --read-only.`,
    );
  if (options.yes) {
    // Explicit opt-in: no warning, no prompt.
  } else if (options.interactive) {
    process.stderr.write(`\n${PREINSTALL_WARNING}\n`);
    const confirmed = await (options.confirm ?? defaultConfirm)();
    if (!confirmed)
      throw new Error(
        `Install of plugin "${parsed.name}" cancelled; nothing was installed or configured.`,
      );
  } else {
    // Headless (including --json): never prompt, fail with an actionable error.
    throw new Error(
      `Refusing to install npm plugin "${parsed.name}" without confirmation: npm install may run ` +
        `lifecycle scripts from the package. Re-run with --yes (or --trust-plugin) to confirm, for ` +
        `example: alisio install npm:${npmInstallTarget(parsed.name, parsed.version)} --yes`,
    );
  }
  const result = await installPlugin({
    spec: options.spec,
    configHome: options.configHome,
    update: options.update,
    signal: options.signal,
    runner: options.runner,
  });
  printInstallResult(result, { json: !!options.json });
  return result;
}

/** `alisio install --update` without a spec: refresh ALL installed plugins in one npm call. */
export async function cliUpdateAll(
  options: Omit<CliInstallOptions, "spec" | "update">,
): Promise<void> {
  if (options.readOnly)
    throw new Error(
      "Refusing to update npm plugins under --read-only: updating runs npm. Run the command without --read-only.",
    );
  const home = resolve(options.configHome ?? configHome());
  const names = await installedGlobalPluginPackages(home);
  if (names.length === 0) {
    if (options.json) process.stdout.write(`${JSON.stringify({ updated: [] }, null, 2)}\n`);
    else
      console.log("No plugins are installed in the global plugins directory; nothing to update.");
    return;
  }
  if (options.yes) {
    // Explicit opt-in: no warning, no prompt.
  } else if (options.interactive) {
    process.stderr.write(`\n${PREINSTALL_WARNING}\n`);
    if (!(await (options.confirm ?? defaultConfirm)()))
      throw new Error("Update of installed plugins cancelled; nothing was changed.");
  } else {
    throw new Error(
      `Refusing to update npm plugins without confirmation: npm install may run lifecycle scripts ` +
        `from the packages. Re-run with --yes (or --trust-plugin) to confirm, for example: ` +
        `alisio install --update --yes`,
    );
  }
  const result = await updateAllPlugins({
    configHome: options.configHome,
    signal: options.signal,
    runner: options.runner,
  });
  if (options.json)
    process.stdout.write(`${JSON.stringify({ updated: result.packages }, null, 2)}\n`);
  else {
    for (const pkg of result.packages)
      console.log(`Updated plugin "${pkg.name}" to v${pkg.version}.`);
    console.log("You can now run your original `alisio install npm:<package>` again.");
  }
}

async function defaultConfirm(): Promise<boolean> {
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = (await rl.question("Install this plugin package globally? [y/N] "))
      .trim()
      .toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

export function printInstallResult(
  result: InstallPluginResult,
  options: { json?: boolean } = {},
): void {
  if (options.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          packageName: result.packageName,
          installedVersion: result.installedVersion,
          path: result.path,
          configEntry: result.configEntry,
          configFile: result.configFile,
          alreadyInstalled: result.alreadyInstalled,
          updated: result.updated,
          trustRemark: result.trustRemark,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (result.alreadyInstalled && !result.updated)
    console.log(
      `Plugin "${result.packageName}" is already installed (v${result.installedVersion}). Use --update to refresh it to the latest version and keep its name.`,
    );
  else if (result.updated)
    console.log(`Updated plugin "${result.packageName}" to v${result.installedVersion}.`);
  else console.log(`Installed plugin "${result.packageName}" v${result.installedVersion}.`);
  console.log(`  path: ${result.path}`);
  console.log(`  config: "plugins" entry "${result.configEntry}" in ${result.configFile}`);
  console.log(result.trustRemark);
}

/**
 * Registers the host-owned `plugin_install` tool (agent capability). It has process effect so it
 * goes through the existing write/process/external permission gate (TUI approval or
 * `--allow-process`; never available under `--read-only`, where it is not registered at all).
 */
export function registerPluginInstallTool(
  registry: ToolRegistry,
  options: { readOnly?: boolean; configHome?: string; runner?: InstallRunner } = {},
): void {
  if (options.readOnly) return;
  const tool: ToolDefinition = {
    name: "plugin_install",
    effect: "process",
    description:
      "Install an npm plugin package into Alisio's global plugins directory " +
      "(<configHome>/plugins, for example ~/.config/alisio/plugins) and add its npm name to the " +
      'global configuration "plugins" array so it can load across projects. Accepts "npm:<package>' +
      "[@<version>]\" or a bare package name. npm may run the package's lifecycle scripts with your " +
      "privileges, so this tool goes through the process permission gate like any subprocess; the " +
      "installed plugin runs in-process wherever it is loaded and is disabled under --read-only.",
    inputSchema: {
      type: "object",
      properties: { spec: { type: "string", minLength: 1 } },
      required: ["spec"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const result = await installPlugin({
        spec: String(input.spec),
        configHome: options.configHome,
        runner: options.runner,
        signal: context.signal,
      });
      return textResult(
        JSON.stringify({
          packageName: result.packageName,
          installedVersion: result.installedVersion,
          path: result.path,
          configEntry: result.configEntry,
          configFile: result.configFile,
          alreadyInstalled: result.alreadyInstalled,
          updated: result.updated,
          trustRemark: result.trustRemark,
        }),
      );
    },
  };
  registry.register(tool);
}

/**
 * Lists npm packages installed under `<root>/node_modules` that declare the `alisio-plugin`
 * keyword — the same packages `plugins`-array entries resolve to. Used by `alisio plugins list`
 * so an installed package shows up alongside file/directory plugins.
 */
export async function installedNpmPlugins(root: string): Promise<string[]> {
  const packagesDir = join(root, "node_modules");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(packagesDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const result: string[] = [];
  const consider = async (dir: string) => {
    const manifest = (await readJson(join(dir, "package.json"))) as
      | { keywords?: unknown }
      | undefined;
    if (manifest && Array.isArray(manifest.keywords) && manifest.keywords.includes(PLUGIN_KEYWORD))
      result.push(dir);
  };
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    if (entry.name.startsWith("@")) {
      const scoped = await readdir(join(packagesDir, entry.name), { withFileTypes: true }).catch(
        () => [] as import("node:fs").Dirent[],
      );
      for (const scope of scoped)
        if (scope.isDirectory()) await consider(join(packagesDir, entry.name, scope.name));
    } else {
      await consider(join(packagesDir, entry.name));
    }
  }
  return result.sort();
}
