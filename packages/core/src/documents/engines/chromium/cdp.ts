/**
 * Dependency-free Chrome DevTools Protocol driver (spec 026 D6, D-22): `--remote-debugging-pipe`
 * on Node, loopback `--remote-debugging-port` + `DevToolsActivePort` + global `WebSocket` on Bun
 * (the pipe stalls after about eight launches there) or when the pipe does not answer.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";

export class CdpError extends Error {}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  sessionId?: string;
  result?: any;
  error?: { message?: string };
}
export type CdpEvent = { method: string; params: Record<string, any>; sessionId?: string };

interface Transport {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function browserArgs(profileDir: string, transport: "pipe" | "port"): string[] {
  const args = [
    "--headless=new",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-gpu",
    "--hide-scrollbars",
    "--mute-audio",
    "--font-render-hinting=none",
    "--host-resolver-rules=MAP * ~NOTFOUND",
    transport === "pipe" ? "--remote-debugging-pipe" : "--remote-debugging-port=0",
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.push("--no-sandbox");
  return [...args, "about:blank"];
}

/** Minimal environment of the browser: no API keys or tokens (spec §5.7.6). */
function browserEnv(): NodeJS.ProcessEnv {
  const keep = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_RUNTIME_DIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "SYSTEMROOT",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "TEMP",
    "TMP",
  ];
  const env: NodeJS.ProcessEnv = { DISPLAY: "" };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

class PipeTransport implements Transport {
  private buffer = Buffer.alloc(0);
  private readonly child: ChildProcess;
  constructor(child: ChildProcess) {
    this.child = child;
    // A killed browser resets its pipes: that is expected, not an error to surface.
    (child.stdio[3] as Writable).on("error", () => {});
    (child.stdio[4] as Readable).on("error", () => {});
  }
  onMessage(cb: (text: string) => void): void {
    (this.child.stdio[4] as Readable).on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      for (let i = this.buffer.indexOf(0); i !== -1; i = this.buffer.indexOf(0)) {
        const raw = this.buffer.subarray(0, i).toString("utf8");
        this.buffer = this.buffer.subarray(i + 1);
        if (raw.trim()) cb(raw);
      }
    });
  }
  onClose(cb: () => void): void {
    this.child.on("exit", cb);
  }
  send(text: string): void {
    (this.child.stdio[3] as Writable).write(`${text}\0`);
  }
  close(): void {}
}

class SocketTransport implements Transport {
  private readonly ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
  }
  onMessage(cb: (text: string) => void): void {
    this.ws.addEventListener("message", (e: MessageEvent) => cb(String(e.data)));
  }
  onClose(cb: () => void): void {
    this.ws.addEventListener("close", () => cb());
  }
  send(text: string): void {
    this.ws.send(text);
  }
  close(): void {
    try {
      this.ws.close();
    } catch {}
  }
}

export class CdpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private readonly listeners = new Set<(event: CdpEvent) => void>();
  private closed = false;

  private readonly transport: Transport;

  constructor(transport: Transport) {
    this.transport = transport;
    transport.onMessage((text) => this.onText(text));
    transport.onClose(() => this.fail("The browser connection closed"));
  }

  private fail(message: string) {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new CdpError(message));
    this.pending.clear();
  }

  private onText(text: string) {
    let msg: CdpMessage;
    try {
      msg = JSON.parse(text) as CdpMessage;
    } catch {
      return;
    }
    if (msg.id !== undefined) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new CdpError(msg.error.message ?? "CDP error"));
      else p.resolve(msg.result);
    } else if (msg.method) {
      const event: CdpEvent = {
        method: msg.method,
        params: msg.params ?? {},
        ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
      };
      for (const l of this.listeners) l(event);
    }
  }

  on(listener: (event: CdpEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new CdpError("The browser connection is closed"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.transport.send(
        JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }),
      );
    });
  }

  close() {
    this.fail("closed");
    this.transport.close();
  }
}

export interface LaunchOptions {
  executable: string;
  /** Directory the browser profile lives in (created, removed on close). */
  profileDir: string;
  transport?: "auto" | "pipe" | "port";
}

export interface BrowserProcess {
  connection: CdpConnection;
  transport: "pipe" | "port";
  pid: number | undefined;
  /** Resolves when the process exits. */
  exited: Promise<void>;
  kill(): Promise<void>;
}

async function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32" && child.pid !== undefined) {
    await new Promise<void>((resolve) => {
      const k = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      k.on("exit", () => resolve());
      k.on("error", () => resolve());
    });
  } else child.kill("SIGKILL");
}

async function launchOnce(
  opts: LaunchOptions,
  transport: "pipe" | "port",
): Promise<BrowserProcess> {
  await mkdir(opts.profileDir, { recursive: true, mode: 0o700 });
  const child = spawn(opts.executable, browserArgs(opts.profileDir, transport), {
    stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    env: browserEnv(),
  });
  const exited = new Promise<void>((resolve) => {
    child.once("exit", () => resolve());
    child.once("error", () => resolve());
  });
  const kill = async () => {
    await killTree(child);
    await Promise.race([exited, wait(3000)]);
    await rm(opts.profileDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    let conn: CdpConnection;
    if (transport === "pipe") conn = new CdpConnection(new PipeTransport(child));
    else {
      const portFile = join(opts.profileDir, "DevToolsActivePort");
      let url: string | undefined;
      for (let i = 0; i < 100 && !url; i++) {
        try {
          const [port, path] = (await readFile(portFile, "utf8")).split("\n");
          if (port && path) url = `ws://127.0.0.1:${port.trim()}${path.trim()}`;
        } catch {}
        if (!url) await wait(50);
        if (child.exitCode !== null) throw new CdpError("The browser exited during start-up");
      }
      if (!url) throw new CdpError("The browser did not publish its debugging port");
      const ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        ws.addEventListener("open", () => resolve());
        ws.addEventListener("error", () =>
          reject(new CdpError("Could not connect to the browser")),
        );
      });
      conn = new CdpConnection(new SocketTransport(ws));
    }
    await Promise.race([
      conn.send("Browser.getVersion"),
      wait(transport === "pipe" ? 8000 : 15_000).then(() => {
        throw new CdpError("The browser did not answer");
      }),
    ]);
    return { connection: conn, transport, pid: child.pid, exited, kill };
  } catch (error) {
    await kill();
    throw error;
  }
}

/** Starts a browser: pipe on Node, loopback port on Bun, falling back to the port on failure. */
export async function launchBrowser(opts: LaunchOptions): Promise<BrowserProcess> {
  const mode = opts.transport ?? "auto";
  if (mode === "pipe") return launchOnce(opts, "pipe");
  if (mode === "port" || process.versions.bun) return launchOnce(opts, "port");
  try {
    return await launchOnce(opts, "pipe");
  } catch {
    return launchOnce(opts, "port");
  }
}
