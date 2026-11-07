import { join } from "node:path";

export interface HostSpawnInput {
  /** The executable: the Electron binary in the app, plain `node` in tests. */
  execPath: string;
  hostEntry: string;
  parentEnv: NodeJS.ProcessEnv;
  webRoot?: string;
  /** Flags placed before the entry file (tests pass `--conditions=alisio-source`). */
  nodeArgs?: string[];
  /**
   * The bundled npm (`resolveNpmCli`), when the runtime ships one: plugin install and uninstall
   * run it through the host instead of looking for a system npm.
   */
  npmCli?: string;
}

/**
 * Exit code of a host that asked to be restarted (`POST /api/server/restart`). It mirrors
 * `RESTART_EXIT_CODE` of `@alisio/server` (75, `EX_TEMPFAIL`); a test keeps the two equal.
 */
export const HOST_RESTART_EXIT_CODE = 75;

/** What main does when the host process ends. */
export function hostExitAction(
  code: number | null,
  state: { quitting: boolean; current: boolean },
): "ignore" | "restart" | "recover" {
  if (state.quitting || !state.current) return "ignore";
  return code === HOST_RESTART_EXIT_CODE ? "restart" : "recover";
}

/** `npm-cli.js` of the npm bundled into the runtime tree (`node_modules/npm`). */
export const resolveNpmCli = (runtimeDir: string): string =>
  join(runtimeDir, "node_modules", "npm", "bin", "npm-cli.js");

export interface HostSpawn {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

/**
 * How to start the host. The Electron binary only behaves as Node when `ELECTRON_RUN_AS_NODE=1`,
 * so that variable is always forced; the rest of the environment is inherited so the host sees the
 * same config homes, PATH and credentials as the CLI would. `ALISIO_SUPERVISED=1` lets the UI
 * restart the host, and `ALISIO_NPM_CLI` points plugin installs at the bundled npm.
 */
export function buildHostSpawn(input: HostSpawnInput): HostSpawn {
  return {
    command: input.execPath,
    args: [
      ...(input.nodeArgs ?? []),
      input.hostEntry,
      ...(input.webRoot ? ["--web-root", input.webRoot] : []),
    ],
    env: {
      ...input.parentEnv,
      ELECTRON_RUN_AS_NODE: "1",
      // A supervisor (this app) respawns the host when it exits asking for a restart.
      ALISIO_SUPERVISED: "1",
      ...(input.npmCli ? { ALISIO_NPM_CLI: input.npmCli } : {}),
    },
  };
}

/** Host argv: `--web-root <dir>` overrides the server's bundled web build. */
export function parseHostArgs(argv: string[]): { webRoot?: string } {
  const index = argv.indexOf("--web-root");
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value ? { webRoot: value } : {};
}

export interface RuntimePathsInput {
  packaged: boolean;
  /** The Electron app directory (`app.getAppPath()`, or this package in development). */
  appDir: string;
  /** `process.resourcesPath`; required when packaged. */
  resourcesPath?: string;
}

/**
 * Where the host's node tree lives: this package in development, `resources/runtime` (outside the
 * asar, so worker processes can run real files) when packaged.
 */
export function resolveRuntimePaths(input: RuntimePathsInput): {
  runtimeDir: string;
  hostEntry: string;
} {
  if (input.packaged && !input.resourcesPath)
    throw new Error("A packaged app needs process.resourcesPath to locate its runtime");
  const runtimeDir =
    input.packaged && input.resourcesPath ? join(input.resourcesPath, "runtime") : input.appDir;
  return { runtimeDir, hostEntry: join(runtimeDir, "dist", "host.js") };
}
