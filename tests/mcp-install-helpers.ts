/**
 * Fixtures for the MCP installer tests (specs/030 phase 3): isolated config/state homes, catalog
 * entries built in memory, a fake `npm` that writes what a real install would leave (a package
 * directory, its `package.json`, a lockfile) and recording job hooks. No network, no real npm.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import type { CatalogEntry, CatalogInput } from "../packages/core/src/mcp/catalog/source.ts";
import type {
  ConnectResult,
  JobHooks,
  McpInstallerOptions,
} from "../packages/core/src/mcp/installation/index.ts";
import type { ProcessResult } from "../packages/core/src/runtime/process.ts";
import { hashProjectConfig, setTrust } from "../packages/core/src/trust.ts";

export interface InstallFixture {
  root: string;
  global: string;
  state: string;
  workspace: string;
  artifacts: string;
  dbPath: string;
  globalFile: string;
  projectFile: string;
}

export async function installFixture(): Promise<InstallFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "alisio-mcp-install-")));
  const global = join(root, "global");
  const state = join(root, "state");
  const workspace = join(root, "workspace");
  await mkdir(join(workspace, ".alisio"), { recursive: true });
  await mkdir(global, { recursive: true });
  vi.stubEnv("ALISIO_CONFIG_HOME", global);
  vi.stubEnv("ALISIO_STATE_HOME", state);
  return {
    root,
    global,
    state,
    workspace,
    artifacts: join(state, "mcp", "artifacts"),
    dbPath: join(state, "mcp", "installations.sqlite"),
    globalFile: join(global, "config.json"),
    projectFile: join(workspace, ".alisio", "config.json"),
  };
}

export async function trustWorkspace(workspace: string): Promise<void> {
  await setTrust(workspace, true, await hashProjectConfig(workspace));
}

export const sha = (value: string) => createHash("sha256").update(value).digest("hex");

export function npmEntry(
  over: {
    name?: string;
    title?: string;
    version?: string;
    identifier?: string;
    pkgVersion?: string | null;
    inputs?: CatalogInput[];
    args?: CatalogEntry["packages"][number]["args"];
    status?: CatalogEntry["status"];
    registryBaseUrl?: string;
    runtimeHint?: string;
  } = {},
): CatalogEntry {
  const name = over.name ?? "io.example/files";
  const version = over.version ?? "1.0.0";
  const identifier = over.identifier ?? "@example/mcp-files";
  const pkgVersion = over.pkgVersion === null ? undefined : (over.pkgVersion ?? version);
  return {
    sourceId: "fake",
    name,
    ...(over.title ? { title: over.title } : { title: "Files" }),
    description: "Reads files",
    version,
    status: over.status ?? "active",
    isLatest: true,
    packages: [
      {
        method: "npm",
        identifier,
        ...(pkgVersion ? { version: pkgVersion } : {}),
        ...(over.registryBaseUrl ? { registryBaseUrl: over.registryBaseUrl } : {}),
        ...(over.runtimeHint ? { runtimeHint: over.runtimeHint } : {}),
        transport: "stdio",
        inputs: over.inputs ?? [],
        args: over.args ?? [],
      },
    ],
    remotes: [],
    provenance: {
      sourceId: "fake",
      schemaVersion: "test",
      rawDigest: sha(`${name}@${version}:${JSON.stringify(over)}`),
      rawJson: "{}",
    },
  };
}

export function remoteEntry(
  over: {
    name?: string;
    version?: string;
    url?: string;
    inputs?: CatalogInput[];
    transport?: "streamable-http" | "sse";
  } = {},
): CatalogEntry {
  const name = over.name ?? "io.example/cloud";
  const version = over.version ?? "2.0.0";
  return {
    sourceId: "fake",
    name,
    title: "Cloud",
    description: "A remote service",
    version,
    status: "active",
    isLatest: true,
    packages: [],
    remotes: [
      {
        transport: over.transport ?? "streamable-http",
        url: over.url ?? "https://mcp.example.com/v1",
        inputs: over.inputs ?? [],
      },
    ],
    provenance: {
      sourceId: "fake",
      schemaVersion: "test",
      rawDigest: sha(`${name}@${version}:${JSON.stringify(over)}`),
      rawJson: "{}",
    },
  };
}

/** A catalog index of entries by name and version (`entry(name)` returns the highest listed). */
export function entryIndex(...entries: CatalogEntry[]) {
  const list = [...entries];
  return {
    add(entry: CatalogEntry) {
      list.push(entry);
    },
    entry(name: string, version?: string): CatalogEntry | undefined {
      const matches = list.filter((e) => e.name === name);
      if (version) return [...matches].reverse().find((e) => e.version === version);
      return [...matches].reverse().find((e) => e.isLatest) ?? matches.at(-1);
    },
  };
}

export interface FakeNpmOptions {
  /** Packages whose lockfile entry declares install scripts. */
  installScripts?: boolean;
  /** `bin` field written to package.json (string or map). */
  bin?: string | Record<string, string>;
  /** Wait for the abort signal instead of finishing (a hung download). */
  hang?: boolean;
  exitCode?: number;
  /** Contents of every bin file (default: a comment). */
  binSource?: string;
  /** Replaces the whole run (e.g. a real process). */
  run?: McpInstallerOptions["runNpm"];
}

export interface FakeNpm {
  run: NonNullable<McpInstallerOptions["runNpm"]>;
  calls: Array<{ command: string; args: string[]; cwd: string }>;
}

export function fakeNpm(options: FakeNpmOptions = {}): FakeNpm {
  const calls: FakeNpm["calls"] = [];
  const run: FakeNpm["run"] = async (command, args, opts, limits) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    if (options.run) return options.run(command, args, opts, limits);
    if (options.hang)
      await new Promise<void>((_, reject) =>
        opts.signal.addEventListener("abort", () => reject(opts.signal.reason), { once: true }),
      );
    const spec = args[args.length - 1] as string;
    const at = spec.lastIndexOf("@");
    const name = spec.slice(0, at);
    const version = spec.slice(at + 1);
    const prefix = args[args.indexOf("--prefix") + 1] as string;
    const dir = join(prefix, "node_modules", ...name.split("/"));
    await mkdir(join(dir, "dist"), { recursive: true });
    const bin = options.bin ?? "dist/server.js";
    await writeFile(join(dir, "package.json"), JSON.stringify({ name, version, bin }));
    for (const file of typeof bin === "string" ? [bin] : Object.values(bin)) {
      await mkdir(join(dir, file, ".."), { recursive: true });
      await writeFile(join(dir, file), options.binSource ?? "// fake server\n");
    }
    await writeFile(
      join(prefix, "package-lock.json"),
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          "": {},
          [`node_modules/${name}`]: {
            version,
            integrity: `sha512-${sha(spec).slice(0, 24)}`,
            ...(options.installScripts ? { hasInstallScript: true } : {}),
          },
        },
      }),
    );
    const result: ProcessResult = {
      stdout: "",
      stderr: "",
      exitCode: options.exitCode ?? 0,
      truncated: false,
    };
    return result;
  };
  return { run, calls };
}

export interface RecordingHooks extends JobHooks {
  attached: Array<{ name: string; entry: unknown }>;
  detached: string[];
  connects: string[];
  permission: "granted" | "not-granted" | "read-only";
}

export function recordingHooks(
  options: {
    permission?: RecordingHooks["permission"];
    connect?: (name: string, signal: AbortSignal) => Promise<ConnectResult>;
  } = {},
): RecordingHooks {
  const hooks: RecordingHooks = {
    attached: [],
    detached: [],
    connects: [],
    permission: options.permission ?? "granted",
    runtimePermission: () => hooks.permission,
    async attach(name, entry) {
      hooks.attached.push({ name, entry });
    },
    async detach(name) {
      hooks.detached.push(name);
    },
    async connect(name, signal) {
      hooks.connects.push(name);
      if (options.connect) return options.connect(name, signal);
      return {
        status: "connected",
        capabilities: ["tools"],
        counts: { tools: 2, resources: 0, prompts: 0 },
      };
    },
  };
  return hooks;
}

export const failedConnect =
  (
    status: ConnectResult["status"] = "failed",
  ): NonNullable<Parameters<typeof recordingHooks>[0]>["connect"] =>
  async () => ({
    status,
    diagnostic: "Connection failed; inspect the server separately for details",
    capabilities: [],
    counts: { tools: 0, resources: 0, prompts: 0 },
  });
