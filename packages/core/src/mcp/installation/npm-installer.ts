/**
 * Private npm installation of one MCP package (specs/030 §19.6, INST-02, D8). The package goes into
 * its own directory under `<stateHome>/mcp/artifacts`, with a generated one-dependency project,
 * the exact version, `--ignore-scripts` and no global install, no `npx`. After the install the
 * lockfile is read: any package in the tree that declares install scripts makes the entry
 * unsupported (the protection is never relaxed), and the executable is taken from `package.json`,
 * never guessed. Neither `--ignore-scripts` nor the private directory is a sandbox for the code
 * once it runs.
 */
import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { runNpm } from "../../plugins/npm-runner.ts";
import { readLockfile, resolveBin } from "./bin-resolver.ts";
import { McpInstallError } from "./errors.ts";

export type NpmRunner = typeof runNpm;

export interface NpmInstallInput {
  /** Directory to install into (created here; the caller moves it into place afterwards). */
  dir: string;
  packageName: string;
  version: string;
  signal: AbortSignal;
  run?: NpmRunner;
  timeoutMs: number;
  /** Executable to use when the package declares several. */
  bin?: string;
}

export interface NpmInstallResult {
  /** The entry script, relative to `dir`. */
  bin: string;
  integrity?: string;
}

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

export async function installNpmPackage(input: NpmInstallInput): Promise<NpmInstallResult> {
  const run = input.run ?? runNpm;
  await mkdir(input.dir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(input.dir, "package.json"),
    `${JSON.stringify(
      {
        name: "alisio-mcp-artifact",
        private: true,
        version: "0.0.0",
        dependencies: { [input.packageName]: input.version },
      },
      null,
      2,
    )}\n`,
  );
  let result: Awaited<ReturnType<NpmRunner>>;
  try {
    result = await run(
      "npm",
      [
        "install",
        "--prefix",
        input.dir,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--save-exact",
        "--omit=dev",
        "--package-lock=true",
        `${input.packageName}@${input.version}`,
      ],
      { cwd: input.dir, signal: input.signal },
      { timeoutMs: input.timeoutMs, maxBytes: 64_000 },
    );
  } catch (error) {
    if (input.signal.aborted) throw error;
    const text = error instanceof Error ? error.message : "";
    if (/npm was not found/i.test(text))
      throw new McpInstallError("mcp_runtime_missing", text, { reason: "npm_missing" });
    throw new McpInstallError("mcp_install_failed", "npm could not be run to install the package");
  }
  input.signal.throwIfAborted();
  if (result.exitCode !== 0)
    throw new McpInstallError(
      "mcp_install_failed",
      "npm could not download or install the package (check the connection and try again)",
    );
  let lock: ReturnType<typeof readLockfile>;
  try {
    lock = readLockfile(await readJson(join(input.dir, "package-lock.json")), input.packageName);
  } catch {
    throw new McpInstallError("mcp_install_failed", "The install did not produce a lockfile");
  }
  if (lock.installScripts.length)
    throw new McpInstallError(
      "mcp_method_unsupported",
      "This package needs install scripts, which Alisio never runs automatically",
      { reason: "lifecycle_scripts" },
    );
  const packageDir = join(input.dir, "node_modules", ...input.packageName.split("/"));
  let manifest: unknown;
  try {
    manifest = await readJson(join(packageDir, "package.json"));
  } catch {
    throw new McpInstallError("mcp_install_failed", "The installed package could not be read");
  }
  if ((manifest as { version?: unknown }).version !== input.version)
    throw new McpInstallError(
      "mcp_install_failed",
      "npm installed a different version than requested",
    );
  const bin = resolveBin(manifest, input.packageName, input.bin);
  if (!bin.ok) {
    if (bin.reason === "no_bin")
      throw new McpInstallError(
        "mcp_method_unsupported",
        "This package does not declare a program to run",
        {
          reason: "no_bin",
        },
      );
    throw new McpInstallError(
      "mcp_method_unsupported",
      bin.reason === "ambiguous"
        ? "This package offers several programs: choose one in the advanced options"
        : "The program the package declares is not valid",
      { reason: "bin_ambiguous", choices: bin.choices },
    );
  }
  // The script must exist and stay inside the artifact after symlinks are resolved.
  const absolute = join(packageDir, bin.path);
  const root = await realpath(input.dir);
  const real = await realpath(absolute).catch(() => undefined);
  const inside = real ? relative(root, real) : undefined;
  if (!real || inside === undefined || inside.startsWith(`..${sep}`) || inside === "..")
    throw new McpInstallError(
      "mcp_install_failed",
      "The program of the package could not be found",
    );
  if (!(await stat(real)).isFile())
    throw new McpInstallError("mcp_install_failed", "The program of the package is not a file");
  return {
    bin: relative(input.dir, absolute),
    ...(lock.integrity ? { integrity: lock.integrity } : {}),
  };
}
