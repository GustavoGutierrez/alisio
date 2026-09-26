import { spawn, spawnSync } from "node:child_process";
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
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else {
        spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        child.kill();
      }
    } catch {
      child.kill("SIGKILL");
    }
  };
  signal.addEventListener("abort", terminate, { once: true });
  if (signal.aborted) terminate();
  let size = 0,
    truncated = false;
  const max = options.maxBytes ?? 32_000;
  const consume = (stream: NodeJS.ReadableStream) =>
    new Promise<string>((resolveText, reject) => {
      const decoder = new TextDecoder();
      let text = "",
        done = false;
      const finish = () => {
        if (done) return;
        done = true;
        text += decoder.decode();
        resolveText(text);
      };
      stream.on("data", (value: Buffer) => {
        if (done) return;
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
      consume(child.stdout as NodeJS.ReadableStream),
      consume(child.stderr as NodeJS.ReadableStream),
      exited,
    ]);
    signal.throwIfAborted();
    return { stdout, stderr, exitCode, truncated };
  } finally {
    signal.removeEventListener("abort", terminate);
    clearTimeout(graceTimer);
    kill();
  }
}
