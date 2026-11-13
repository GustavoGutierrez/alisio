/**
 * Which runtime launches a managed npm MCP server (specs/030 O9, §19.6). The configuration keeps the
 * portable pair `node <script>`; the real executable is chosen when the server connects: the
 * system Node when one is on the PATH, otherwise the runtime Alisio itself runs on (the desktop app
 * is Electron acting as Node through `ELECTRON_RUN_AS_NODE`, exactly like its host and its bundled
 * npm). The chosen path is never persisted.
 */
import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join } from "node:path";

export interface RuntimeEnvironment {
  env?: Record<string, string | undefined>;
  platform?: NodeJS.Platform;
  versions?: Record<string, string | undefined>;
  execPath?: string;
  /** Test seam: whether a path is an executable file. */
  isExecutable?: (path: string) => boolean;
}

function executable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** First executable called `name` on the PATH (with the PATHEXT suffixes on Windows). */
export function findOnPath(name: string, options: RuntimeEnvironment = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const test = options.isExecutable ?? ((path: string) => executable(path, platform));
  const suffixes =
    platform === "win32" ? (env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((s) => s) : [""];
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    for (const suffix of suffixes) {
      const candidate = join(dir, `${name}${suffix}`);
      if (test(candidate)) return candidate;
    }
  }
  return undefined;
}

export interface NodeRuntime {
  /** `system`: Node found on the PATH. `bundled`: the runtime Alisio is running on. */
  kind: "system" | "bundled";
  command: string;
  /** Extra environment the child needs (`ELECTRON_RUN_AS_NODE=1` for the Electron runtime). */
  env: Record<string, string>;
}

/** System Node first, then the runtime that is running Alisio. */
export function resolveNodeRuntime(options: RuntimeEnvironment = {}): NodeRuntime {
  const system = findOnPath("node", options);
  if (system) return { kind: "system", command: system, env: {} };
  const versions = options.versions ?? process.versions;
  return {
    kind: "bundled",
    command: options.execPath ?? process.execPath,
    env: versions.electron ? { ELECTRON_RUN_AS_NODE: "1" } : {},
  };
}

/** Whether npm can be run: Alisio's bundled npm (`ALISIO_NPM_CLI`) or one on the PATH. */
export function npmAvailable(options: RuntimeEnvironment = {}): boolean {
  const env = options.env ?? process.env;
  const test =
    options.isExecutable ??
    ((path: string) => executable(path, options.platform ?? process.platform));
  if (env.ALISIO_NPM_CLI && test(env.ALISIO_NPM_CLI)) return true;
  return findOnPath("npm", options) !== undefined;
}
