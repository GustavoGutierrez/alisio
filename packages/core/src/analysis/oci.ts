/**
 * Optional container runtime for `python_run` (`analysis.runtime: "oci"`): Docker or Podman with a
 * digest-pinned image. Nothing is built or pulled during a run (`alisio analysis setup --oci` pulls
 * once); the run only starts `<engine> run --rm …`. The isolation is partial and documented: the
 * container sees only the job folders, has no network, a read-only root, no capabilities and
 * memory/CPU/process limits, but a container is not a boundary against a hostile kernel exploit.
 *
 * Every argument goes in an array (no shell), so paths with spaces and non-ASCII names are fine.
 * Host paths that the engine would parse as mount syntax (a `:` outside a Windows drive prefix) are
 * refused with a clear message instead of being passed through.
 */
import { readFile } from "node:fs/promises";
import { OCI_IMAGE_PATTERN } from "../config.ts";
import { which } from "../runtime/fs.ts";
import { type ProcessResult, runProcess } from "../runtime/process.ts";

export type OciEngine = "docker" | "podman";

export interface OciSettings {
  engine: OciEngine;
  /** `name@sha256:<digest>`; required to run. */
  image?: string;
  memoryMb: number;
  cpus: number;
}

/** The job folders mounted into the container (host paths). */
export interface OciMounts {
  script: string;
  input: string;
  work: string;
  staging: string;
}

/** Paths inside the container (spec §8.3). */
export const CONTAINER = {
  script: "/job/script",
  input: "/job/input",
  work: "/job/work",
  out: "/job/out",
} as const;

export const PIDS_LIMIT = 256;
export const TMPFS_SIZE = "256m";

/** `alisio-exec_01J…`: the container of one execution. */
export function containerName(executionId: string): string {
  const safe = executionId.replace(/[^a-zA-Z0-9_.-]/g, "-");
  return `alisio-${safe}`;
}

export interface OciHost {
  platform: NodeJS.Platform;
  uid?: number;
  gid?: number;
  /** The engine runs without root privileges (rootless Docker or Podman). */
  rootless?: boolean;
  /** SELinux is enforcing: bind mounts need a relabel option on the host. */
  selinux?: boolean;
}

/** Windows drive prefix (`C:\` or `C:/`), which a `-v` source may legitimately contain. */
const DRIVE = /^[A-Za-z]:[\\/]/;

/** A host path that can be passed to `-v`; throws when the engine would misparse it. */
export function mountSource(path: string, platform: NodeJS.Platform): string {
  const rest = platform === "win32" && DRIVE.test(path) ? path.slice(2) : path;
  if (rest.includes(":") || /[\r\n\0]/.test(path))
    throw new Error(
      `The job folder ${path} contains a character the container runtime cannot mount (":"). ` +
        "Move the Alisio state folder (ALISIO_STATE_HOME or --db) to a path without it, or use the managed runtime.",
    );
  return path;
}

/**
 * `<engine> run` arguments for one execution (spec §8.3). The container name is
 * `alisio-<executionId>` so a cancellation can `kill` it by name.
 */
export function ociRunArgs(input: {
  settings: OciSettings & { image: string };
  executionId: string;
  mounts: OciMounts;
  host: OciHost;
  /** Extra environment variables for the script (the ALISIO_* ones are always set). */
  env?: Record<string, string>;
}): string[] {
  const { settings, host } = input;
  const mount = (source: string, target: string, mode: "ro" | "rw") =>
    `${mountSource(source, host.platform)}:${target}:${mode}${host.selinux ? ",z" : ""}`;
  const args = [
    "run",
    "--rm",
    "--name",
    containerName(input.executionId),
    "--label",
    "alisio=analysis",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--pids-limit=${PIDS_LIMIT}`,
    `--memory=${settings.memoryMb}m`,
    `--memory-swap=${settings.memoryMb}m`,
    `--cpus=${settings.cpus}`,
  ];
  // Files the script writes must belong to the user on Linux. Docker Desktop (macOS, Windows)
  // maps ownership itself, so `--user` is omitted there; a rootless engine already maps the user
  // to root inside the container (Podman needs keep-id to keep the owner on the mounts).
  if (host.platform === "linux" && host.uid !== undefined && host.gid !== undefined) {
    if (settings.engine === "podman" && host.rootless && host.uid !== 0)
      args.push("--userns=keep-id", "--user", `${host.uid}:${host.gid}`);
    else if (!host.rootless && host.uid !== 0) args.push("--user", `${host.uid}:${host.gid}`);
  }
  args.push(
    "-v",
    mount(input.mounts.script, CONTAINER.script, "ro"),
    "-v",
    mount(input.mounts.input, CONTAINER.input, "ro"),
    "-v",
    mount(input.mounts.work, CONTAINER.work, "rw"),
    "-v",
    mount(input.mounts.staging, CONTAINER.out, "rw"),
    "--tmpfs",
    `/tmp:size=${TMPFS_SIZE}`,
  );
  const env: Record<string, string> = {
    ALISIO_INPUT_DIR: CONTAINER.input,
    ALISIO_OUTPUT_DIR: CONTAINER.out,
    ALISIO_WORK_DIR: CONTAINER.work,
    ALISIO_EXECUTION_ID: input.executionId,
    HOME: CONTAINER.work,
    TMPDIR: "/tmp",
    MPLCONFIGDIR: `${CONTAINER.work}/.matplotlib`,
    MPLBACKEND: "Agg",
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    PYTHONNOUSERSITE: "1",
    PYTHONIOENCODING: "utf-8",
    ...input.env,
  };
  for (const [key, value] of Object.entries(env)) args.push("-e", `${key}=${value}`);
  args.push(
    "-w",
    CONTAINER.work,
    settings.image,
    "python",
    "-E",
    "-s",
    "-B",
    "-u",
    "-X",
    "utf8",
    `${CONTAINER.script}/main.py`,
  );
  return args;
}

/** Collaborators of the runtime, replaceable in tests (a fake container CLI). */
export interface OciDeps {
  /** Resolves the engine executable; `undefined` when it is not installed. */
  locate(engine: OciEngine): Promise<string | undefined>;
  /** Arguments placed before the engine's own (test launchers only). */
  prefixArgs?: string[];
  host(): Promise<OciHost>;
  /** Runs one engine command to completion. */
  exec(
    command: string,
    args: string[],
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
}

async function selinuxEnforcing(): Promise<boolean> {
  try {
    return (await readFile("/sys/fs/selinux/enforce", "utf8")).trim() === "1";
  } catch {
    return false;
  }
}

export function defaultOciDeps(): OciDeps {
  return {
    locate: (engine) => which(engine),
    async host() {
      return {
        platform: process.platform,
        ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
        ...(typeof process.getgid === "function" ? { gid: process.getgid() } : {}),
        ...(process.platform === "linux" ? { selinux: await selinuxEnforcing() } : {}),
      };
    },
    async exec(command, args, options) {
      const result = await runProcess(command, args, {
        cwd: process.cwd(),
        signal: options.signal,
        timeoutMs: options.timeoutMs,
        maxBytes: 256 * 1024,
        onOverflow: "truncate",
      });
      return { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode };
    },
  };
}

export type OciStatus =
  | {
      ok: true;
      engine: OciEngine;
      path: string;
      version: string;
      rootless: boolean;
    }
  | {
      ok: false;
      engine: OciEngine;
      reason: string;
      /** The other engine is installed: switching `analysis.oci.engine` is a way out. */
      alternative?: OciEngine;
    };

const other = (engine: OciEngine): OciEngine => (engine === "docker" ? "podman" : "docker");

/** Container runtime of `python_run`; all engine calls go through `OciDeps`. */
export class OciRuntime {
  readonly deps: OciDeps;

  constructor(
    readonly settings: OciSettings,
    deps: Partial<OciDeps> = {},
  ) {
    this.deps = { ...defaultOciDeps(), ...deps };
  }

  private async command(): Promise<string | undefined> {
    return this.deps.locate(this.settings.engine);
  }

  private async call(args: string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}) {
    const command = await this.command();
    if (!command) throw new Error(`${this.settings.engine} is not installed`);
    return this.deps.exec(command, [...(this.deps.prefixArgs ?? []), ...args], {
      signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
      timeoutMs: options.timeoutMs ?? 30_000,
    });
  }

  /**
   * Is the engine installed and its daemon reachable? Optional by design: a missing engine is a
   * status, not an error of Alisio. Also reports rootless mode, which changes the `--user` flags.
   */
  async status(signal?: AbortSignal): Promise<OciStatus> {
    const engine = this.settings.engine;
    const path = await this.command();
    if (!path) {
      const alternative = (await this.deps.locate(other(engine))) ? other(engine) : undefined;
      return {
        ok: false,
        engine,
        reason: `${engine} was not found on PATH`,
        ...(alternative ? { alternative } : {}),
      };
    }
    try {
      const version = await this.call(
        ["version", "--format", engine === "docker" ? "{{.Server.Version}}" : "{{.Version}}"],
        signal ? { signal } : {},
      );
      if (version.exitCode !== 0)
        return {
          ok: false,
          engine,
          reason: `${engine} is installed but not usable: ${(version.stderr || version.stdout).trim().split(/\r?\n/)[0] ?? "no answer"}`,
        };
      let rootless = false;
      try {
        const info = await this.call(
          [
            "info",
            "--format",
            engine === "docker" ? "{{json .SecurityOptions}}" : "{{.Host.Security.Rootless}}",
          ],
          signal ? { signal } : {},
        );
        rootless =
          info.exitCode === 0 &&
          (engine === "docker" ? /name=rootless/.test(info.stdout) : info.stdout.trim() === "true");
      } catch {
        /* Rootless detection is best effort; the default flags are the rootful ones. */
      }
      return { ok: true, engine, path, version: version.stdout.trim(), rootless };
    } catch (error) {
      return {
        ok: false,
        engine,
        reason: `${engine} did not answer: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /** The reason a run cannot start (`undefined` = ready), checked before any job is created. */
  async unavailable(signal?: AbortSignal): Promise<string | undefined> {
    const { image } = this.settings;
    if (!image)
      return (
        'analysis.runtime is "oci" but analysis.oci.image is not set. Put a digest-pinned image ' +
        "(name@sha256:…) in your user configuration; `alisio analysis setup --oci --image <name>` prints the value."
      );
    if (!OCI_IMAGE_PATTERN.test(image)) return "analysis.oci.image must be pinned by digest";
    const status = await this.status(signal);
    if (!status.ok)
      return `${status.reason}${status.alternative ? `; ${status.alternative} is installed (set analysis.oci.engine to "${status.alternative}")` : ""}. The container runtime is optional: remove analysis.runtime "oci" to use managed Python.`;
    return undefined;
  }

  /**
   * Runs the job's script in a container. Cancelling or timing out `kills` the container by name
   * (killing the client process does not always stop it) and no `alisio-*` container is left.
   */
  async run(input: {
    executionId: string;
    mounts: OciMounts;
    signal: AbortSignal;
    timeoutMs: number;
    maxBytes: number;
    onData?: (chunk: string) => void;
    logFiles: { stdout: string; stderr: string };
    maxLogBytes: number;
  }): Promise<ProcessResult & { containerName: string }> {
    const image = this.settings.image;
    if (!image) throw new Error("analysis.oci.image is not set");
    const command = await this.command();
    if (!command) throw new Error(`${this.settings.engine} is not installed`);
    const status = await this.status(input.signal);
    const host = await this.deps.host();
    const args = ociRunArgs({
      settings: { ...this.settings, image },
      executionId: input.executionId,
      mounts: input.mounts,
      host: { ...host, rootless: status.ok ? status.rootless : false },
    });
    const name = containerName(input.executionId);
    const stop = AbortSignal.any([input.signal, AbortSignal.timeout(input.timeoutMs)]);
    const onAbort = () => void this.kill(name);
    stop.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await runProcess(command, [...(this.deps.prefixArgs ?? []), ...args], {
        cwd: input.mounts.work,
        signal: input.signal,
        timeoutMs: input.timeoutMs,
        maxBytes: input.maxBytes,
        onOverflow: "truncate",
        logFiles: input.logFiles,
        maxLogBytes: input.maxLogBytes,
        // The engine client only needs to find its own daemon: no variables of the script.
        env: engineEnv(),
        ...(input.onData ? { onData: input.onData } : {}),
      });
      return { ...result, containerName: name };
    } finally {
      stop.removeEventListener("abort", onAbort);
      // After an abort the client may have exited before the daemon stopped the container.
      if (stop.aborted) await this.kill(name);
    }
  }

  /** `<engine> kill <name>`; a container that is already gone is not an error. */
  async kill(name: string): Promise<void> {
    try {
      await this.call(["kill", name], { timeoutMs: 15_000 });
    } catch {
      /* Already gone, or the engine stopped answering: nothing else to do. */
    }
  }

  /** Names of the `alisio-*` containers that still exist (running or not). */
  async leftovers(): Promise<string[]> {
    const result = await this.call([
      "ps",
      "-a",
      "--filter",
      "label=alisio=analysis",
      "--format",
      "{{.Names}}",
    ]);
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Pulls the image (once, from `alisio analysis setup --oci`); a digest reference verifies itself. */
  async pull(image: string, signal: AbortSignal): Promise<{ digest?: string }> {
    const pulled = await this.call(["pull", image], { signal, timeoutMs: 30 * 60_000 });
    if (pulled.exitCode !== 0)
      throw new Error(
        `${this.settings.engine} pull ${image} failed: ${(pulled.stderr || pulled.stdout).trim().slice(-2000)}`,
      );
    const inspected = await this.call(
      ["image", "inspect", "--format", "{{json .RepoDigests}}", image],
      { signal },
    );
    const digests = parseDigests(inspected.stdout);
    return { ...(digests[0] ? { digest: digests[0] } : {}) };
  }

  /** True when the image is already in the local store (so a run never needs the network). */
  async hasImage(image: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.call(
        ["image", "inspect", "--format", "{{.Id}}", image],
        signal ? { signal } : {},
      );
      return result.exitCode === 0;
    } catch {
      return false;
    }
  }
}

/** `["repo@sha256:…"]` → `["repo@sha256:…"]` (JSON from `--format {{json .RepoDigests}}`). */
export function parseDigests(output: string): string[] {
  try {
    const value = JSON.parse(output.trim()) as unknown;
    return Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string" && OCI_IMAGE_PATTERN.test(v))
      : [];
  } catch {
    return [];
  }
}

/** The environment of the engine client: where to find the daemon, nothing else. */
function engineEnv(): Record<string, string> {
  const keep = [
    "PATH",
    "HOME",
    "USERPROFILE",
    "TMPDIR",
    "TEMP",
    "SystemRoot",
    "COMSPEC",
    "LANG",
    "DOCKER_HOST",
    "DOCKER_CONTEXT",
    "DOCKER_CONFIG",
    "XDG_RUNTIME_DIR",
    "CONTAINER_HOST",
    "APPDATA",
    "LOCALAPPDATA",
    "ProgramData",
    "ProgramFiles",
    "DBUS_SESSION_BUS_ADDRESS",
  ];
  return Object.fromEntries(
    keep.flatMap((key) => (process.env[key] ? [[key, process.env[key] as string]] : [])),
  );
}
