export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
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
  },
): Promise<ProcessResult> {
  options.signal.throwIfAborted();
  const signal = AbortSignal.any([
    options.signal,
    AbortSignal.timeout(options.timeoutMs ?? 30_000),
  ]);
  const child = Bun.spawn([command, ...args], {
    cwd: options.cwd,
    env:
      options.env ??
      Object.fromEntries(
        ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "SystemRoot", "COMSPEC", "LANG"].flatMap(
          (k) => (process.env[k] ? [[k, process.env[k] as string]] : []),
        ),
      ),
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    detached: process.platform !== "win32",
  });
  const kill = () => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
      else {
        Bun.spawnSync(["taskkill", "/PID", String(child.pid), "/T", "/F"], {
          stdout: "ignore",
          stderr: "ignore",
        });
        child.kill();
      }
    } catch {
      child.kill();
    }
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  let size = 0,
    truncated = false;
  const max = options.maxBytes ?? 32_000;
  const consume = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader(),
      decoder = new TextDecoder();
    let text = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        const remaining = Math.max(0, max - size),
          slice = value.subarray(0, remaining);
        size += slice.byteLength;
        const chunk = decoder.decode(slice, { stream: true });
        text += chunk;
        if (chunk) options.onData?.(chunk);
        if (value.byteLength > remaining) {
          truncated = true;
          kill();
          break;
        }
      }
      text += decoder.decode();
      return text;
    } finally {
      reader.releaseLock();
    }
  };
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      consume(child.stdout),
      consume(child.stderr),
      child.exited,
    ]);
    signal.throwIfAborted();
    return { stdout, stderr, exitCode, truncated };
  } finally {
    signal.removeEventListener("abort", kill);
    kill();
  }
}
