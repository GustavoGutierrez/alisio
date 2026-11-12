import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  type AppMessage,
  DESKTOP_FORCE_GRACE_MS,
  DESKTOP_KILL_WAIT_MS,
  DESKTOP_SHUTDOWN_WAIT_MS,
  type HostMessage,
  parseHostLine,
  parseHostMessage,
} from "./host-protocol.ts";
import { type PrintRequest, type PrintResult, parsePrintRequest } from "./print-protocol.ts";

export interface LaunchOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long to wait for the `ready` message before giving up (default 30 s). */
  timeoutMs?: number;
  /** How long `stop()` waits for the host to exit after the shutdown request (budget default). */
  shutdownWaitMs?: number;
  /** POSIX fallback: grace between SIGTERM and SIGKILL of the host (budget default). */
  forceGraceMs?: number;
  /** How long `stop()` still waits after the fallback before giving up (budget default). */
  killWaitMs?: number;
  /** Platform whose fallback applies (tests); defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** Runs the Windows tree kill (tests replace it); defaults to a bounded `spawnSync`. */
  runTaskkill?: (command: string, args: string[]) => void;
  /** Receives the host's stderr lines (diagnostics only). */
  onLog?: (line: string) => void;
  /** Serves the host's print requests (spec 026 D7); requests outside `root` are ignored. */
  print?: {
    root: string;
    run: (request: PrintRequest) => Promise<PrintResult>;
    cancel: (id: string) => void;
  };
}

export interface RunningHost {
  child: ChildProcess;
  launchUrl: string;
  /**
   * Asks the host to shut down (IPC), then kills its tree if it does not exit in time. Always
   * resolves within the budget of `host-protocol.ts`: with the exit code, or `null` when killed.
   */
  stop(): Promise<number | null>;
  /** Resolves when the host exits for any reason. */
  exited: Promise<number | null>;
}

/** How the app kills a host that did not exit in time. */
export type HostFallbackPlan =
  | { kind: "taskkill"; command: "taskkill"; args: string[] }
  /** POSIX: SIGTERM (a stopping host exits at once, running its exit hook), then SIGKILL. */
  | { kind: "signals" };

/**
 * The fallback for `platform`. On Windows a signal is TerminateProcess of the host alone, which
 * would skip its cleanup and leave its children running, so the whole tree goes at once.
 */
export function hostFallbackPlan(pid: number, platform: NodeJS.Platform): HostFallbackPlan {
  return platform === "win32"
    ? { kind: "taskkill", command: "taskkill", args: ["/PID", String(pid), "/T", "/F"] }
    : { kind: "signals" };
}

/** How long a host that failed to start gets to exit on its own before the fallback. */
const FAILED_START_WAIT_MS = 2_000;

const defaultTaskkill = (command: string, args: string[]) => {
  spawnSync(command, args, { stdio: "ignore", windowsHide: true, timeout: 5_000 });
};

/** Resolves true when `exited` settles within `ms`, false otherwise. */
function within(exited: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    void exited.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

/**
 * Stops the host: the IPC shutdown request when the channel is up (SIGTERM on POSIX otherwise),
 * then the platform fallback if it is still running after `shutdownWaitMs`. Bounded.
 */
async function terminate(
  child: ChildProcess,
  exited: Promise<number | null>,
  options: LaunchOptions,
): Promise<number | null> {
  const isDone = () => child.exitCode !== null || child.signalCode !== null;
  if (isDone()) return exited;
  const platform = options.platform ?? process.platform;
  let requested = false;
  if (child.connected) {
    try {
      child.send({ type: "shutdown" } satisfies AppMessage);
      requested = true;
    } catch {
      /* the channel closed meanwhile: fall through */
    }
  }
  if (!requested && platform !== "win32") {
    child.kill("SIGTERM");
    requested = true;
  }
  if (requested && (await within(exited, options.shutdownWaitMs ?? DESKTOP_SHUTDOWN_WAIT_MS)))
    return exited;
  if (isDone()) return exited;
  const plan = hostFallbackPlan(child.pid ?? 0, platform);
  if (plan.kind === "taskkill") {
    if (child.pid !== undefined) {
      try {
        (options.runTaskkill ?? defaultTaskkill)(plan.command, plan.args);
      } catch {
        /* nothing more to try than the wait below */
      }
    }
  } else {
    child.kill("SIGTERM");
    if (!(await within(exited, options.forceGraceMs ?? DESKTOP_FORCE_GRACE_MS)))
      child.kill("SIGKILL");
  }
  return (await within(exited, options.killWaitMs ?? DESKTOP_KILL_WAIT_MS)) ? exited : null;
}

/**
 * Spawns the host and resolves once it reports `ready` (IPC message, or a JSON stdout line when
 * the channel is unavailable). Rejects on an `error` message, an early exit or the timeout; in
 * every rejection the child is stopped.
 */
export function launchHost(options: LaunchOptions): Promise<RunningHost> {
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => resolve(code));
    child.once("error", () => resolve(null));
  });
  return new Promise<RunningHost>((resolve, reject) => {
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A host that failed or hangs in its startup gets a short wait before the fallback.
      void terminate(child, exited, {
        ...options,
        shutdownWaitMs: Math.min(
          options.shutdownWaitMs ?? FAILED_START_WAIT_MS,
          FAILED_START_WAIT_MS,
        ),
      });
      reject(error);
    };
    const handle = (message: HostMessage | undefined) => {
      if (!message || settled) return;
      if (message.type === "error") return fail(new Error(message.message));
      settled = true;
      clearTimeout(timer);
      resolve({
        child,
        launchUrl: message.launchUrl,
        exited,
        stop: () => terminate(child, exited, options),
      });
    };
    const timer = setTimeout(
      () => fail(new Error("The Alisio host did not become ready in time")),
      options.timeoutMs ?? 30_000,
    );
    child.on("message", (raw) => {
      handle(parseHostMessage(raw));
      const print = options.print;
      if (!print || !raw || typeof raw !== "object") return;
      const type = (raw as { type?: unknown }).type;
      if (type === "print-cancel") {
        const id = (raw as { id?: unknown }).id;
        if (typeof id === "string") print.cancel(id);
        return;
      }
      const request = type === "print" ? parsePrintRequest(raw, print.root) : undefined;
      if (!request) return;
      void print
        .run(request)
        .catch(
          (error: unknown): PrintResult => ({
            type: "print-result",
            id: request.id,
            ok: false,
            error: error instanceof Error ? error.message.slice(0, 500) : "print failed",
          }),
        )
        .then((result) => {
          if (child.connected) child.send(result);
        });
    });
    if (child.stdout) {
      createInterface({ input: child.stdout }).on("line", (line) => handle(parseHostLine(line)));
    }
    if (child.stderr && options.onLog) {
      createInterface({ input: child.stderr }).on("line", options.onLog);
    }
    child.once("error", (error) =>
      fail(new Error(`Could not start the Alisio host: ${error.message}`)),
    );
    child.once("exit", (code, signal) =>
      fail(new Error(`The Alisio host exited before it was ready (${signal ?? code})`)),
    );
  });
}
