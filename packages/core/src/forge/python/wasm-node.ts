/**
 * The `node` that runs Pyodide for the `wasm` backend (Python spec §8.2) and the facts about it:
 * which binary (the running Node, or under Bun the first supported `node` on PATH (absolute entries only), or the configured
 * one), the Permission Model flags it is started with, and the network self-probe (D-32). The
 * probe starts the REAL child with the same flags and tries to connect to a local port: whether
 * the network is denied is observed, never deduced from a version number.
 */
import { execFile, spawn } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createServer } from "node:net";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * The first release of each line that fixes CVE-2025-55130 (December 2025 security releases): the
 * Permission Model could be escaped with crafted symlinks, and this backend depends on it. Lines
 * not listed (23.x, never fixed, and everything older) are refused; newer majors are accepted.
 * Source: https://nodejs.org/en/blog/vulnerability/december-2025-security-releases
 */
const FIXED_LINES: Readonly<Record<number, number>> = { 22: 22, 24: 13, 25: 3 };
export const MIN_NODE = { major: 22, minor: 22 } as const;
const MIN_TEXT = "22.22, 24.13, 25.3 or 26+";
const CVE_NOTE = "earlier releases have the Permission Model symlink bypass CVE-2025-55130";

export type NodeResolution =
  | { ok: true; path: string; version: string }
  | { ok: false; reason: string };

export interface NodeEnvironment {
  /** Running under Bun (the standalone binary): `process.execPath` is not a Node. */
  isBun: boolean;
  execPath: string;
  /** `process.version` of the running Node. */
  version: string;
  /** The `PATH` to search under Bun. */
  pathEnv: string;
  platform: NodeJS.Platform;
}

export const currentNodeEnvironment = (): NodeEnvironment => ({
  isBun: !!process.versions.bun,
  execPath: process.execPath,
  version: process.version,
  pathEnv: process.env.PATH ?? "",
  platform: process.platform,
});

/** `v22.22.0` -> true: at least the release of its line that fixed CVE-2025-55130. */
export function isSupportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  if (major > 25) return true;
  const fixed = FIXED_LINES[major];
  return fixed !== undefined && minor >= fixed;
}

function versionOf(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(binary, ["--version"], { timeout: 5000, env: {}, windowsHide: true }, (error, out) =>
      resolve(error ? undefined : String(out).trim()),
    );
  });
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const cache = new Map<string, NodeResolution & { ok: true }>();

/** Finds the node to run Pyodide with; only successes are remembered. */
export async function resolveNode(
  configured: string | null | undefined,
  environment: NodeEnvironment = currentNodeEnvironment(),
): Promise<NodeResolution> {
  const key = `${configured ?? ""}|${environment.isBun}|${environment.execPath}|${environment.pathEnv}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const found = await (async (): Promise<NodeResolution> => {
    if (configured) {
      const version = await versionOf(configured);
      if (!version)
        return { ok: false, reason: `analysis.wasm.nodePath (${configured}) did not run` };
      return isSupportedNode(version)
        ? { ok: true, path: configured, version }
        : {
            ok: false,
            reason: `analysis.wasm.nodePath is Node ${version}; Pyodide needs Node ${MIN_TEXT} (${CVE_NOTE})`,
          };
    }
    if (!environment.isBun) {
      return isSupportedNode(environment.version)
        ? { ok: true, path: environment.execPath, version: environment.version }
        : {
            ok: false,
            reason: `Pyodide needs Node ${MIN_TEXT} (running ${environment.version}; ${CVE_NOTE})`,
          };
    }
    const names = environment.platform === "win32" ? ["node.exe"] : ["node"];
    let seen: string | undefined;
    // A relative entry (`.`, `bin`) would run whatever the current folder holds.
    for (const dir of environment.pathEnv.split(delimiter).filter(isAbsolute)) {
      for (const name of names) {
        const candidate = join(dir, name);
        if (!executable(candidate)) continue;
        const version = await versionOf(candidate);
        if (!version) continue;
        if (isSupportedNode(version)) return { ok: true, path: candidate, version };
        seen ??= version;
      }
    }
    return {
      ok: false,
      reason: seen
        ? `the only node on PATH is ${seen}; Pyodide needs Node ${MIN_TEXT} (${CVE_NOTE}; or set analysis.wasm.nodePath)`
        : `Pyodide runs in a Node child process and no node ${MIN_TEXT} was found on PATH (install Node.js or set analysis.wasm.nodePath)`,
    };
  })();
  if (found.ok) cache.set(key, found);
  return found;
}

/** Clears remembered resolutions and probes (tests, and a changed PATH). */
export function resetNodeCaches(): void {
  cache.clear();
  probes.clear();
}

/**
 * The flags of the restricted child: the Permission Model with ONE flag per path (a comma list is
 * invalid in Node 22), reading only the distribution and the job, writing only `work/` and `out/`.
 * No `--allow-child-process`, `--allow-worker`, `--allow-addons` or `--allow-wasi`; on Node >= 25
 * `--allow-net` is likewise left out.
 */
export function permissionArgs(paths: {
  read: readonly string[];
  write: readonly string[];
}): string[] {
  return [
    "--permission",
    "--no-warnings",
    ...paths.read.map((p) => `--allow-fs-read=${p}`),
    ...paths.write.map((p) => `--allow-fs-write=${p}`),
  ];
}

/** Environment of the child: nothing but the job's `ALISIO_*` variables. */
export function childEnv(
  vars: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) if (key.startsWith("ALISIO_")) env[key] = value;
  // Windows cannot start a process without these.
  if (platform === "win32" && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
  return env;
}

export interface NetworkProbeResult {
  /**
   * The Permission Model refused the connection (`ERR_ACCESS_DENIED`). `false` also when the probe
   * was not conclusive: any other failure (refused, unreachable, no route) says nothing about it.
   */
  denied: boolean;
  detail: string;
  /** The child gave an answer that settles the question (connected, or refused by the Permission Model). */
  conclusive?: boolean;
}

const probes = new Map<string, Promise<NetworkProbeResult>>();

const PROBE_SCRIPT = `
import net from "node:net";
const denied = (e) => { console.log("DENIED " + (e && e.code)); process.exit(0); };
try {
  const socket = net.connect(Number(process.argv[1]), "127.0.0.1");
  socket.on("connect", () => { console.log("CONNECTED"); process.exit(0); });
  socket.on("error", denied);
} catch (e) { denied(e); }
setTimeout(() => { console.log("TIMEOUT"); process.exit(0); }, 4000);
`;

/**
 * Starts `node` with the real flags and tries to reach a port of ours. Remembered per binary and
 * version (the flags do not change what the network flag does). Inconclusive means "not denied".
 */
export function probeNetwork(
  node: { path: string; version: string },
  args: readonly string[],
): Promise<NetworkProbeResult> {
  const key = `${node.path}@${node.version}`;
  let probe = probes.get(key);
  if (!probe) {
    probe = runProbe(node.path, args);
    probes.set(key, probe);
    // Only a conclusive answer is remembered: an inconclusive one is asked again next time.
    void probe.then((result) => {
      if (!result.conclusive && probes.get(key) === probe) probes.delete(key);
    });
  }
  return probe;
}

async function runProbe(path: string, args: readonly string[]): Promise<NetworkProbeResult> {
  let hits = 0;
  const server = createServer((socket) => {
    hits++;
    socket.destroy();
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const output = await new Promise<string>((resolve) => {
      const child = spawn(
        path,
        [...args, "--input-type=module", "-e", PROBE_SCRIPT, String(port)],
        { env: childEnv({}), stdio: ["ignore", "pipe", "ignore"], windowsHide: true },
      );
      let text = "";
      child.stdout.on("data", (chunk) => {
        text += chunk;
      });
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      timer.unref?.();
      child.once("error", () => resolve(""));
      child.once("close", () => {
        clearTimeout(timer);
        resolve(text.trim());
      });
    });
    if (hits > 0)
      return {
        denied: false,
        conclusive: true,
        detail: "a connection to 127.0.0.1 from the child succeeded",
      };
    const code = /^DENIED (\S+)/.exec(output)?.[1];
    if (code === "ERR_ACCESS_DENIED")
      return { denied: true, conclusive: true, detail: `the Permission Model refused (${output})` };
    return {
      denied: false,
      conclusive: false,
      detail: `probe inconclusive: ${code ?? (output || "the child did not answer")}`,
    };
  } catch (error) {
    return {
      denied: false,
      conclusive: false,
      detail: `probe inconclusive: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    server.close();
  }
}
