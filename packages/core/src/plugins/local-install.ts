/**
 * Installs a plugin from a local `.tgz` (`npm pack` / `pnpm pack`): private plugins that are never
 * published. The validated tarball is copied into `<pluginsDir>/local-packages/` and npm installs
 * FROM THAT COPY, so the `file:` dependency npm records in `<pluginsDir>/package.json` is stable
 * and self-contained: moving or deleting the original file cannot break a later install of
 * another plugin. Any failure rolls back (stored copy, partial package, config entry).
 */
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { configHome } from "../config.ts";
import { readJson } from "../runtime/fs.ts";
import {
  defaultInstallRunner,
  INSTALL_TIMEOUT_MS,
  type InstallRunner,
  LOCAL_PACKAGES_DIR,
  persistGlobalPluginEntry,
  pluginDependencySpec,
  removeGlobalPluginEntry,
  sanitizeNpmError,
  storedTarballOf,
} from "./install.ts";
import { inspectPluginTarball, type PluginTarballInfo } from "./tarball.ts";

export type LocalInstallPhase = "validating" | "copying" | "installing" | "registering";

export interface InstallLocalPluginInput {
  tarballPath: string;
  configHome?: string;
  readOnly?: boolean;
  signal?: AbortSignal;
  runner?: InstallRunner;
  /** Called as each phase starts. */
  onPhase?: (phase: LocalInstallPhase) => void;
}

export interface InstallLocalPluginResult {
  packageName: string;
  installedVersion: string;
  previousVersion?: string;
  /** A version of the package was installed before this call. */
  alreadyInstalled: boolean;
  updated: boolean;
  storedPath: string;
  /** The dependency spec npm records, relative to the plugins directory. */
  spec: string;
  pluginsDir: string;
  configFile: string;
  info: PluginTarballInfo;
}

/** An install failure that carries the tail of npm's output for the UI. */
export class LocalInstallError extends Error {
  constructor(
    message: string,
    readonly logTail?: string,
  ) {
    super(message);
  }
}

const TAIL_CHARS = 1500;
const safePart = (text: string): string => text.replace(/[^A-Za-z0-9._-]/g, "_");
export const storedTarballName = (name: string, version: string): string =>
  `${safePart(name.replace(/^@/, "").replace(/\//g, "-"))}-${safePart(version)}.tgz`;

export async function installLocalPluginTarball(
  input: InstallLocalPluginInput,
): Promise<InstallLocalPluginResult> {
  if (input.readOnly)
    throw new Error(
      "Installing a plugin from a file is unavailable under --read-only: it runs npm and writes your global configuration. Run without --read-only.",
    );
  input.onPhase?.("validating");
  const info = await inspectPluginTarball(input.tarballPath);
  if (!info.isAlisioPlugin || !info.name || !info.version)
    throw new Error(`This file is not a valid Alisio plugin package: ${info.reasons.join("; ")}`);
  const name = info.name;
  const version = info.version;
  const home = resolve(input.configHome ?? configHome());
  const pluginsDir = join(home, "plugins");
  const localDir = join(pluginsDir, LOCAL_PACKAGES_DIR);
  const packageDir = join(pluginsDir, "node_modules", name);
  const run = input.runner ?? defaultInstallRunner;
  const signal = input.signal ?? AbortSignal.timeout(INSTALL_TIMEOUT_MS);

  const previous = (await readJson(join(packageDir, "package.json"))) as
    | { version?: string }
    | undefined;
  const previousSpec = await pluginDependencySpec(pluginsDir, name);
  const previousStored = storedTarballOf(pluginsDir, previousSpec);
  // What to reinstall from if an update fails half-way: our stored copy, or the external file a
  // plugin installed by hand still points at.
  const previousSource =
    previousStored ??
    (previousSpec?.startsWith("file:") ? resolve(pluginsDir, previousSpec.slice(5)) : undefined);
  const snapshot = async (file: string) => readFile(file, "utf8").catch(() => undefined);
  const manifestFiles = ["package.json", "package-lock.json"].map((f) => join(pluginsDir, f));
  const snapshots = await Promise.all(manifestFiles.map(snapshot));
  const configBefore = (await readJson(join(home, "config.json"))) as
    | { plugins?: unknown }
    | undefined;
  const inConfig = Array.isArray(configBefore?.plugins) && configBefore.plugins.includes(name);

  input.onPhase?.("copying");
  await mkdir(localDir, { recursive: true, mode: 0o700 });
  const storedPath = join(localDir, storedTarballName(name, version));
  const backup = `${storedPath}.bak`;
  const hadStored = await rename(storedPath, backup).then(
    () => true,
    () => false,
  );
  try {
    await copyFile(input.tarballPath, storedPath);
    await chmod(storedPath, 0o600);
    input.onPhase?.("installing");
    const result = await run("npm", ["install", "--prefix", pluginsDir, storedPath], {
      cwd: pluginsDir,
      signal,
    });
    if (result.exitCode !== 0) {
      const tail = sanitizeNpmError(
        [result.stdout, result.stderr].filter(Boolean).join("\n"),
        100_000,
      ).slice(-TAIL_CHARS);
      throw new LocalInstallError(
        `npm install failed for plugin "${name}" (exit ${result.exitCode}).\n${tail || "no output"}`,
        tail || undefined,
      );
    }
    input.onPhase?.("registering");
    const configFile = await persistGlobalPluginEntry(home, name);
    await rm(backup, { force: true });
    if (previousStored && previousStored !== storedPath) await rm(previousStored, { force: true });
    const manifest = (await readJson(join(packageDir, "package.json"))) as
      | { version?: string }
      | undefined;
    return {
      packageName: name,
      installedVersion: manifest?.version ?? version,
      ...(previous?.version ? { previousVersion: previous.version } : {}),
      alreadyInstalled: previous !== undefined,
      updated: previous !== undefined,
      storedPath,
      spec: `file:${LOCAL_PACKAGES_DIR}/${storedTarballName(name, version)}`,
      pluginsDir,
      configFile,
      info,
    };
  } catch (error) {
    await rm(storedPath, { force: true }).catch(() => {});
    if (hadStored) await rename(backup, storedPath).catch(() => {});
    if (previous !== undefined && previousSource) {
      // An update that broke the package: put the previous version back.
      const current = (await readJson(join(packageDir, "package.json")).catch(() => undefined)) as
        | { version?: string }
        | undefined;
      if (current?.version !== previous.version)
        await run("npm", ["install", "--prefix", pluginsDir, previousSource], {
          cwd: pluginsDir,
          signal: AbortSignal.timeout(INSTALL_TIMEOUT_MS),
        }).catch(() => undefined);
    }
    // npm rewrites the dependency spec; a spec pointing at the copy we just removed would break
    // every later install.
    await Promise.all(
      manifestFiles.map((file, i) => {
        const before = snapshots[i];
        return before === undefined ? rm(file, { force: true }) : writeFile(file, before);
      }),
    ).catch(() => {});
    if (previous === undefined) {
      // A package that was not there before must not be left half-installed.
      if (await readJson(join(packageDir, "package.json")).catch(() => undefined)) {
        await run("npm", ["uninstall", "--prefix", pluginsDir, name], {
          cwd: pluginsDir,
          signal: AbortSignal.timeout(60_000),
        }).catch(() => undefined);
        await rm(packageDir, { recursive: true, force: true }).catch(() => {});
      }
      if (!inConfig) await removeGlobalPluginEntry(home, name).catch(() => false);
    }
    throw error;
  }
}
