/**
 * How Alisio spawns npm for plugin install and uninstall.
 *
 * A system npm is the default. The desktop app ships without Node.js on the user's PATH, so it
 * bundles npm and points `ALISIO_NPM_CLI` at its `bin/npm-cli.js`: npm then runs through the
 * executable that is already running (Node, or the Electron binary acting as Node), with no
 * system npm needed.
 */
import { isMissingCommand, type ProcessResult, runProcess } from "../runtime/process.ts";

export const NPM_NOT_FOUND_MESSAGE =
  "npm was not found: install Node.js, or use the desktop app, which bundles it";

/** Env keys the npm child inherits (the default runner env plus what npm needs for its cache/proxy). */
const NPM_ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "COMSPEC",
  "LANG",
  "APPDATA",
  "LOCALAPPDATA",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
];

export interface NpmInvocation {
  command: string;
  args: string[];
  /** Present only when the child needs an explicit environment (bundled npm). */
  env?: Record<string, string>;
}

/**
 * Maps `npm <args>` to the process to spawn. With `ALISIO_NPM_CLI` set, that script runs through
 * `execPath`, and `ELECTRON_RUN_AS_NODE=1` is added when that executable is Electron.
 */
export function resolveNpmInvocation(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  versions: Record<string, string | undefined> = process.versions,
  execPath: string = process.execPath,
): NpmInvocation {
  const cli = env.ALISIO_NPM_CLI;
  if (command !== "npm" || !cli) return { command, args };
  const childEnv: Record<string, string> = {};
  for (const key of NPM_ENV_KEYS) {
    const value = env[key];
    if (value) childEnv[key] = value;
  }
  if (versions.electron) childEnv.ELECTRON_RUN_AS_NODE = "1";
  return { command: execPath, args: [cli, ...args], env: childEnv };
}

/** The default install runner: bounded time and output, bundled npm aware, clear ENOENT error. */
export async function runNpm(
  command: string,
  args: string[],
  options: { cwd: string; signal: AbortSignal; env?: Record<string, string> },
  limits: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<ProcessResult> {
  const spec = resolveNpmInvocation(command, args);
  try {
    return await runProcess(spec.command, spec.args, {
      cwd: options.cwd,
      signal: options.signal,
      ...(spec.env || options.env ? { env: { ...spec.env, ...options.env } } : {}),
      ...limits,
    });
  } catch (error) {
    if (command === "npm" && isMissingCommand(error)) throw new Error(NPM_NOT_FOUND_MESSAGE);
    throw error;
  }
}
