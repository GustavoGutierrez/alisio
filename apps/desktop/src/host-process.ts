import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { type HostMessage, parseHostLine, parseHostMessage } from "./host-protocol.ts";
import { type PrintRequest, type PrintResult, parsePrintRequest } from "./print-protocol.ts";

export interface LaunchOptions {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
  /** How long to wait for the `ready` message before giving up (default 30 s). */
  timeoutMs?: number;
  /** Grace before SIGKILL when stopping (default 5 s). */
  killAfterMs?: number;
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
  /** SIGTERM, then SIGKILL after the grace period. Resolves with the exit code. */
  stop(): Promise<number | null>;
  /** Resolves when the host exits for any reason. */
  exited: Promise<number | null>;
}

/** Stops `child` with SIGTERM and falls back to SIGKILL; resolves with its exit code. */
function terminate(child: ChildProcess, exited: Promise<number | null>, killAfterMs: number) {
  if (child.exitCode !== null || child.signalCode !== null) return exited;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), killAfterMs);
  timer.unref();
  return exited.finally(() => clearTimeout(timer));
}

/**
 * Spawns the host and resolves once it reports `ready` (IPC message, or a JSON stdout line when
 * the channel is unavailable). Rejects on an `error` message, an early exit or the timeout; in
 * every rejection the child is stopped.
 */
export function launchHost(options: LaunchOptions): Promise<RunningHost> {
  const killAfterMs = options.killAfterMs ?? 5_000;
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
      void terminate(child, exited, killAfterMs);
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
        stop: () => terminate(child, exited, killAfterMs),
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
