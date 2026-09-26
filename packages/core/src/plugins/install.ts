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
import { chmod, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type ToolDefinition, textResult } from "@alisio/sdk";
import { configHome } from "../config.ts";
import type { ToolRegistry } from "../core/registry.ts";
import { readJson } from "../runtime/fs.ts";
import { PLUGIN_KEYWORD } from "../runtime/modules.ts";
import { type ProcessResult, runProcess } from "../runtime/process.ts";

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
const defaultRunner: InstallRunner = (command, args, options) =>
  runProcess(command, args, { ...options, timeoutMs: INSTALL_TIMEOUT_MS, maxBytes: 64_000 });

export interface InstallPluginInput {
  /** `npm:<package>[@<version>]` or a bare package name. */
  spec: string;
  /** Defaults to `configHome()` (ALISIO_CONFIG_HOME, else ~/.config/alisio). */
  configHome?: string;
  /** Refresh an already-installed package to `@latest`, keeping the npm name in the config. */
  update?: boolean;
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
  /** Refreshed to `@latest` by this call. */
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

function npmInstallError(
  name: string,
  version: string | undefined,
  update: boolean | undefined,
  pluginsDir: string,
  result: ProcessResult,
): Error {
  const detail = sanitizeNpmError([result.stdout, result.stderr].filter(Boolean).join("\n"));
  const retry = `npm install --prefix ${pluginsDir} ${npmInstallTarget(name, version, update)}`;
  return new Error(
    `npm install failed for plugin "${name}" (exit ${result.exitCode}).\n${detail || "no output"}\n` +
      `Retry with: ${retry}\n(or: alisio install npm:${npmInstallTarget(name, version)})`,
  );
}

/** Atomically adds `packageName` to the global configuration `plugins` array, preserving all other fields. */
async function persistGlobalPluginEntry(
  configHomeDir: string,
  packageName: string,
): Promise<string> {
  const file = join(configHomeDir, "config.json");
  const existing = await readJson(file);
  let raw: Record<string, unknown>;
  if (existing === undefined) raw = {};
  else if (typeof existing === "object" && !Array.isArray(existing))
    raw = existing as Record<string, unknown>;
  else throw new Error(`Global Alisio configuration must be a JSON object: ${file}`);
  const current = Array.isArray(raw.plugins) ? (raw.plugins as unknown[]) : [];
  if (!current.includes(packageName)) raw.plugins = [...current, packageName];
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
  return file;
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
  if (!alreadyInstalled || input.update) {
    const signal = input.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS);
    const run = input.runner ?? defaultRunner;
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
      throw npmInstallError(parsed.name, parsed.version, input.update, pluginsDir, npmResult);
    updated = !!input.update && alreadyInstalled;
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
    updated,
    trustRemark: pluginTrustRemark(parsed.name),
  };
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
