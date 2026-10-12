/**
 * `ProcessIsolateHost` (spec §6.3, D-20, D-21): the VM runs in a child process of the same
 * executable (Bun, where `worker.terminate()` cannot be trusted to stop WASM).
 *
 * The child gets an EMPTY environment but `ALISIO_FORGE_ISOLATE=1` (see `isolateEnv`), no inherited descriptors
 * (stdin and stdout are the frame channel, stderr is dropped) and a private working directory.
 * There is no shared memory with it, so:
 *  - a user cancellation is `SIGKILL` at once;
 *  - a deadline relies on the guest's own interrupt handler, with `SIGKILL` as a backstop 500 ms
 *    after the deadline passed.
 * The stop is only "confirmed" when the child's `exit` is seen.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  IsolateExit,
  IsolateHost,
  IsolateSession,
  TerminationReason,
  TerminationReport,
} from "../../ports.ts";
import { MAX_MESSAGE_BYTES } from "../../protocol.ts";
import { encodeFrame, FrameDecoder, FrameStreamError } from "./framing.ts";

export const PROCESS_KILL_BACKSTOP_MS = 500;
const EXIT_CONFIRM_MS = 2_000;

/**
 * The isolate's whole environment: the marker, and on Windows `SystemRoot` and nothing else (the
 * runtime cannot start without it). No other variable of the parent ever reaches the guest process.
 */
export function isolateEnv(
  platform: NodeJS.Platform = process.platform,
  parent: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = { ALISIO_FORGE_ISOLATE: "1" };
  if (platform === "win32" && parent.SystemRoot) env.SystemRoot = parent.SystemRoot;
  return env;
}

export interface IsolateCommand {
  execPath: string;
  args: string[];
}

/** Whether this process is a binary compiled by `bun build --compile`. */
export function isBunCompiled(argv1: string | undefined = process.argv[1]): boolean {
  return !!process.versions.bun && /^(\/\$bunfs\/|[A-Za-z]:[\\/]+~BUN[\\/])/.test(argv1 ?? "");
}

/**
 * How to start an isolate process. A compiled binary re-runs itself with the hidden
 * `__forge-isolate` command (its virtual files cannot be spawned); otherwise the process entry file
 * next to this one runs directly (`.ts` through type stripping, `.js` from `dist`).
 */
export function resolveIsolateCommand(
  options: { compiled?: boolean; base?: string; execPath?: string } = {},
): IsolateCommand {
  const execPath = options.execPath ?? process.execPath;
  if (options.compiled ?? isBunCompiled()) return { execPath, args: ["__forge-isolate"] };
  const base = options.base ?? import.meta.url;
  const typescript = base.endsWith(".ts");
  const entry = fileURLToPath(new URL(`./process-entry.${typescript ? "ts" : "js"}`, base));
  const stripFlags =
    typescript && !process.versions.bun
      ? ["--experimental-strip-types", "--disable-warning=ExperimentalWarning"]
      : [];
  return { execPath, args: [...stripFlags, entry] };
}

export interface ProcessHostOptions {
  command?: IsolateCommand;
  backstopMs?: number;
}

export class ProcessIsolateHost implements IsolateHost {
  readonly kind = "process" as const;
  readonly #options: ProcessHostOptions;

  constructor(options: ProcessHostOptions = {}) {
    this.#options = options;
  }

  start(): IsolateSession {
    const command = this.#options.command ?? resolveIsolateCommand();
    const backstopMs = this.#options.backstopMs ?? PROCESS_KILL_BACKSTOP_MS;
    const cwd = mkdtempSync(join(tmpdir(), "alisio-forge-"));
    const child: ChildProcess = spawn(command.execPath, command.args, {
      cwd,
      env: isolateEnv(),
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let messageHandler: (raw: unknown) => void = () => {};
    let streamErrorHandler: (reason: string) => void = () => {};
    let exitState: IsolateExit | undefined;
    let spawnError: string | undefined;
    const exited = new Promise<IsolateExit>((resolve) => {
      let settled = false;
      const finish = (exit: IsolateExit) => {
        if (settled) return;
        settled = true;
        exitState = exit;
        try {
          rmSync(cwd, { recursive: true, force: true });
        } catch {
          /* A leftover empty directory in the temporary folder is harmless. */
        }
        resolve(exit);
      };
      child.once("error", (error) => {
        spawnError = error.message;
        finish({ code: null, signal: null, error: error.message });
      });
      child.once("exit", (code, signal) =>
        finish({ code, signal, ...(spawnError ? { error: spawnError } : {}) }),
      );
    });
    const decoder = new FrameDecoder(MAX_MESSAGE_BYTES + 4096);
    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        for (const message of decoder.push(chunk)) messageHandler(message);
      } catch (error) {
        if (error instanceof FrameStreamError) {
          streamErrorHandler(error.message);
          child.kill("SIGKILL");
          return;
        }
        throw error;
      }
    });
    // The child may be killed while a frame is being written.
    child.stdin?.on("error", () => {});
    child.stdout?.on("error", () => {});

    const waitExit = async (): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const confirmed = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), EXIT_CONFIRM_MS);
        }),
      ]);
      clearTimeout(timer);
      return confirmed;
    };

    return {
      kind: "process",
      onMessage(handler) {
        messageHandler = handler;
      },
      onStreamError(handler) {
        streamErrorHandler = handler;
      },
      send(message) {
        if (!exitState && child.stdin?.writable) child.stdin.write(encodeFrame(message));
      },
      exited,
      async stop(reason: TerminationReason): Promise<TerminationReport> {
        const started = performance.now();
        if (exitState) return { confirmed: true, method: "kill", elapsedMs: 0 };
        let backstop: ReturnType<typeof setTimeout> | undefined;
        if (reason === "timeout") {
          // The guest's own deadline should end it first; this is the backstop.
          backstop = setTimeout(() => child.kill("SIGKILL"), backstopMs);
        } else child.kill("SIGKILL");
        const confirmed = await waitExit();
        clearTimeout(backstop);
        if (!confirmed) child.kill("SIGKILL");
        return {
          confirmed,
          method: "kill",
          elapsedMs: Math.round(performance.now() - started),
          ...(confirmed ? {} : { settled: exited.then(() => undefined) }),
        };
      },
    };
  }
}
