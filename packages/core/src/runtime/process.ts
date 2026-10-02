import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, type WriteStream } from "node:fs";
export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
}
/**
 * Detect a spawn failure caused by a missing executable (`ENOENT`), so tools can explain how to
 * install the dependency instead of surfacing the raw OS error.
 */
export function isMissingCommand(error: unknown): boolean {
  return (
    !!error &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
/** Per-platform install commands for the ripgrep dependency. */
export const RIPGREP_INSTALL_HINT =
  "Install ripgrep (rg): `sudo apt install ripgrep` (Debian/Ubuntu), " +
  "`brew install ripgrep` (macOS), `winget install BurntSushi.ripgrep.MSVC` or " +
  "`scoop install ripgrep` (Windows). It powers the search_text and list_files tools.";
/** Human-readable detection status for `alisio doctor`. */
export function ripgrepDiagnostic(found: boolean): string | undefined {
  return found ? undefined : RIPGREP_INSTALL_HINT;
}
/** Whether a process id belongs to a live process (EPERM still means alive). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
/**
 * Kills a spawned process and everything it started: the process group on POSIX (children are
 * spawned with `detached`, so the pid leads its own group) and `taskkill /T /F` on Windows.
 * Synchronous, so it is also safe inside a `process.on("exit")` handler. Never throws.
 */
export function killProcessTree(pid: number, fallback?: () => void): void {
  try {
    if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
    else spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore" });
  } catch {
    try {
      fallback?.();
    } catch {
      /* already gone */
    }
  }
}
export async function runProcess(
  command: string,
  args: string[],
  options: {
    cwd: string;
    signal: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    env?: Record<string, string>;
    onData?: (chunk: string) => void;
    /** On cancellation: SIGTERM the process group, then SIGKILL after this grace (default 5s). */
    killGraceMs?: number;
    /**
     * What happens when a stream exceeds `maxBytes`: `kill` (default) stops the process; `truncate`
     * lets it run and keeps only the LAST `maxBytes` of each stream (the result is `truncated`).
     */
    onOverflow?: "kill" | "truncate";
    /** Full stdout/stderr copies (up to `maxLogBytes` each), independent of `maxBytes`. */
    logFiles?: { stdout: string; stderr: string };
    /** Cap of each log file (default 10 MiB); a marker line notes the cut. */
    maxLogBytes?: number;
    /** Called once with the pid of the spawned process (it leads its own group on POSIX). */
    onSpawn?: (pid: number) => void;
  },
): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
  ]);
  const child = spawn(command, args, {
    cwd: options.cwd,
    env:
      options.env ??
      Object.fromEntries(
        ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot", "COMSPEC", "LANG"].flatMap(
          (k) => (process.env[k] ? [[k, process.env[k] as string]] : []),
        ),
      ),
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  if (child.pid !== undefined) options.onSpawn?.(child.pid);
  const exited = new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("close", (code, sig) => resolveExit(code ?? (sig ? 128 : 1)));
  });
  let finished = false;
  exited.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  /** Graceful stop for cancellations: SIGTERM the group, SIGKILL if still alive after the grace. */
  const terminate = () => {
    if (finished || child.pid === undefined) return;
    if (process.platform === "win32") return kill();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      return kill();
    }
    graceTimer = setTimeout(kill, options.killGraceMs ?? 5_000);
  };
  const kill = () => {
    if (finished || child.pid === undefined) return;
    killProcessTree(child.pid, () => child.kill("SIGKILL"));
    if (process.platform === "win32") child.kill();
  };
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  let size = 0,
    truncated = false;
  const max = options.maxBytes ?? 32_000;
  const tailMode = options.onOverflow === "truncate";
  const maxLog = options.maxLogBytes ?? 10 * 1024 * 1024;
  const logs: WriteStream[] = [];
  const logger = (path: string | undefined) => {
    if (!path) return undefined;
    const out = createWriteStream(path, { flags: "w" });
    out.on("error", () => {
      /* A log write failure never fails the process run. */
    });
    logs.push(out);
    let written = 0,
      cut = false;
    return (chunk: Buffer) => {
      if (cut) return;
      const room = maxLog - written;
      if (chunk.byteLength > room) {
        out.write(chunk.subarray(0, Math.max(0, room)));
        out.write(Buffer.from("\n[log truncated]\n"));
        cut = true;
        written = maxLog;
        return;
      }
      out.write(chunk);
      written += chunk.byteLength;
    };
  };
  const consume = (stream: NodeJS.ReadableStream, logPath?: string) =>
    new Promise<string>((resolveText, reject) => {
      const decoder = new TextDecoder();
      const log = logger(logPath);
      let text = "",
        done = false;
      // Tail mode keeps raw buffers and decodes once at the end (a cut may split a character).
      const tail: Buffer[] = [];
      let tailBytes = 0;
      const finish = () => {
        if (done) return;
        done = true;
        if (tailMode) {
          const joined = Buffer.concat(tail);
          text = new TextDecoder().decode(joined).replace(/^\uFFFD+/, "");
        } else text += decoder.decode();
        resolveText(text);
      };
      stream.on("data", (value: Buffer) => {
        if (done) return;
        log?.(value);
        if (tailMode) {
          const live = decoder.decode(value, { stream: true });
          if (live) options.onData?.(live);
          tail.push(value);
          tailBytes += value.byteLength;
          while (tailBytes > max && tail.length) {
            const first = tail[0] as Buffer;
            const excess = tailBytes - max;
            if (first.byteLength <= excess) {
              tail.shift();
              tailBytes -= first.byteLength;
            } else {
              tail[0] = first.subarray(excess);
              tailBytes -= excess;
            }
            truncated = true;
          }
          return;
        }
        const remaining = Math.max(0, max - size),
          slice = value.subarray(0, remaining);
        size += slice.byteLength;
        const chunk = decoder.decode(slice, { stream: true });
        text += chunk;
        if (chunk) options.onData?.(chunk);
        if (value.byteLength > remaining) {
          truncated = true;
          kill();
          finish();
        }
      });
      stream.once("end", finish);
      stream.once("close", finish);
      stream.once("error", reject);
    });
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      consume(child.stdout as NodeJS.ReadableStream, options.logFiles?.stdout),
      consume(child.stderr as NodeJS.ReadableStream, options.logFiles?.stderr),
      exited,
    ]);
    signal.throwIfAborted();
    return { stdout, stderr, exitCode, truncated };
  } finally {
    signal.removeEventListener("abort", terminate);
    clearTimeout(graceTimer);
    kill();
    await Promise.all(
      logs.map((out) => new Promise<void>((resolveLog) => out.end(() => resolveLog()))),
    );
  }
}
