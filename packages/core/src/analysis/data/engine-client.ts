/**
 * Host side of the data engine (spec §17): runs ingestion and read-only queries in a child
 * process with the current JavaScript runtime and talks to it in newline-delimited JSON. A child
 * process, not a `worker_thread`, because `worker.terminate()` cannot interrupt a native SQLite
 * call (verified on Node 22.19 and Bun 1.4.2: a recursive CTE keeps the thread alive), while a
 * killed process always stops. Portable: `process.execPath` is `node`, `bun`, or the compiled
 * binary, which acts as `bun` with `BUN_BE_BUN=1`. The engine script is written once to the state
 * folder (content-addressed) because the bundled binary has no loose files to point a child to.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ENGINE_SOURCE } from "./engine-source.ts";
import type {
  CloseRequest,
  EngineRequest,
  EngineResponse,
  FinalizeRequest,
  IngestRequest,
  IngestResult,
  QueryRequest,
  QueryResult,
} from "./engine-types.ts";
import { LineSplitter } from "./json.ts";

export type DataErrorCode =
  | "dataset_unsupported"
  | "query_rejected"
  | "query_timeout"
  | "not_found"
  | "ingest_limit"
  | "ingest_invalid"
  | "sql_error"
  | "engine_error"
  | "cancelled";

/** A failure with a stable code that tools and routes map to their own error shapes. */
export class DataError extends Error {
  constructor(
    readonly code: DataErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** The engine script on disk (`<root>/analysis/engine/data-engine-<hash>.mjs`). */
export async function ensureEngineScript(root: string): Promise<string> {
  const hash = createHash("sha256").update(ENGINE_SOURCE).digest("hex").slice(0, 12);
  const dir = join(root, "analysis", "engine");
  const file = join(dir, `data-engine-${hash}.mjs`);
  try {
    if ((await stat(file)).isFile()) return file;
  } catch {
    /* write it below */
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, ENGINE_SOURCE, { mode: 0o600 });
  await rename(temp, file).catch(async (error) => {
    await rm(temp, { force: true });
    // Another process may have written the same file first (Windows refuses to replace it).
    if (
      !(await stat(file)
        .then((s) => s.isFile())
        .catch(() => false))
    )
      throw error;
  });
  return file;
}

const ENV_KEYS = [
  "PATH",
  "HOME",
  "USERPROFILE",
  "TMPDIR",
  "TEMP",
  "TMP",
  "SystemRoot",
  "SYSTEMROOT",
  "WINDIR",
  "LANG",
];

interface Waiting {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  onProgress?: (rows: number) => void;
}

/** One engine child process and its pending request. */
class EngineProcess {
  private child: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, Waiting>();
  private stderr = "";
  dead = false;
  private exitError: Error | undefined;

  constructor(script: string, memoryMb: number) {
    const bun = !!process.versions.bun;
    this.child = spawn(
      process.execPath,
      [
        ...(bun
          ? []
          : [`--max-old-space-size=${memoryMb}`, "--disable-warning=ExperimentalWarning"]),
        script,
      ],
      {
        env: {
          ...Object.fromEntries(
            ENV_KEYS.flatMap((k) => (process.env[k] ? [[k, process.env[k] as string]] : [])),
          ),
          BUN_BE_BUN: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
    const lines = new LineSplitter((line) => this.onLine(line));
    this.child.stdout?.setEncoding("utf8");
    this.child.stdout?.on("data", (text: string) => lines.write(text));
    this.child.stderr?.setEncoding("utf8");
    this.child.stderr?.on("data", (text: string) => {
      this.stderr = `${this.stderr}${text}`.slice(-2000);
    });
    this.child.stdin?.on("error", () => {
      /* the exit handler reports a dead process */
    });
    this.child.once("error", (error) => this.fail(error));
    this.child.once("close", (code, signal) =>
      this.fail(
        new DataError(
          "engine_error",
          `The data engine stopped unexpectedly (${signal ?? `exit code ${code}`})${
            this.stderr.trim() ? `: ${this.stderr.trim().split("\n").at(-1)}` : ""
          }`,
        ),
      ),
    );
  }

  private fail(error: Error): void {
    this.dead = true;
    this.exitError ??= error;
    for (const waiting of this.pending.values()) waiting.reject(this.exitError);
    this.pending.clear();
  }

  private onLine(line: string): void {
    let message: EngineResponse;
    try {
      message = JSON.parse(line) as EngineResponse;
    } catch {
      return;
    }
    const waiting = this.pending.get(message.id);
    if (!waiting) return;
    if (message.type === "progress") {
      waiting.onProgress?.(message.rows);
      return;
    }
    this.pending.delete(message.id);
    if (message.type === "result") waiting.resolve(message.result);
    else waiting.reject(new DataError(asCode(message.code), message.message));
  }

  request<T>(request: Omit<EngineRequest, "id">, onProgress?: (rows: number) => void): Promise<T> {
    if (this.dead)
      return Promise.reject(
        this.exitError ?? new DataError("engine_error", "The data engine is not running"),
      );
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        ...(onProgress ? { onProgress } : {}),
      });
      this.child.stdin?.write(`${JSON.stringify({ ...request, id })}\n`, (error) => {
        if (error) this.fail(new DataError("engine_error", "The data engine is not running"));
      });
    });
  }

  /** Stops the process for good (a stuck statement, a cancelled ingestion, shutdown). */
  kill(): void {
    this.dead = true;
    this.exitError ??= new DataError("cancelled", "The data engine was stopped");
    try {
      this.child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }

  /** Lets the process finish what it is doing and exit by itself. */
  end(): void {
    this.dead = true;
    this.child.stdin?.end();
  }
}

function asCode(code: string): DataErrorCode {
  return ["query_rejected", "ingest_limit", "ingest_invalid", "sql_error"].includes(code)
    ? (code as DataErrorCode)
    : "engine_error";
}

export interface DataEngineOptions {
  /** State folder (`<root>/analysis/engine/…` holds the script). */
  root: string;
  /** Heap limit of the child process (Node only), in MiB. */
  memoryMb?: number;
  /** A persistent query process exits after this much inactivity. */
  idleMs?: number;
  /** Ingestions running at once. */
  concurrency?: number;
}

/** Ingestion and query access to dataset files through the engine process. */
export class DataEngine {
  private script: Promise<string> | undefined;
  private query: EngineProcess | undefined;
  private queryQueue: Promise<unknown> = Promise.resolve();
  private idle: ReturnType<typeof setTimeout> | undefined;
  private running = new Set<EngineProcess>();
  private waiting: Array<() => void> = [];
  private active = 0;
  private closed = false;

  constructor(private readonly options: DataEngineOptions) {}

  private scriptPath(): Promise<string> {
    this.script ??= ensureEngineScript(this.options.root);
    return this.script;
  }

  private memory(): number {
    return this.options.memoryMb ?? 1024;
  }

  private async slot(signal?: AbortSignal): Promise<() => void> {
    const limit = this.options.concurrency ?? 2;
    while (this.active >= limit) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.push(resolve);
        signal?.addEventListener("abort", () => reject(new DataError("cancelled", "Cancelled")), {
          once: true,
        });
      });
      signal?.throwIfAborted();
    }
    this.active++;
    return () => {
      this.active--;
      this.waiting.shift()?.();
    };
  }

  /** Runs one request in a fresh process (ingestion and finalization). */
  private async oneShot<T>(
    request: Omit<IngestRequest | FinalizeRequest, "id">,
    options: { signal?: AbortSignal; onProgress?: (rows: number) => void; timeoutMs?: number },
  ): Promise<T> {
    if (this.closed) throw new DataError("cancelled", "The data engine is closed");
    options.signal?.throwIfAborted();
    const release = await this.slot(options.signal);
    const child = new EngineProcess(await this.scriptPath(), this.memory());
    this.running.add(child);
    const stop = () => child.kill();
    options.signal?.addEventListener("abort", stop, { once: true });
    const timer = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    try {
      return await child.request<T>(request, options.onProgress);
    } catch (error) {
      if (options.signal?.aborted) throw new DataError("cancelled", "Cancelled");
      throw error;
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      child.end();
      // A process that does not exit by itself shortly after must not linger.
      setTimeout(() => child.kill(), 2000).unref();
      this.running.delete(child);
      release();
    }
  }

  ingest(
    request: Omit<IngestRequest, "id" | "op">,
    options: { signal?: AbortSignal; onProgress?: (rows: number) => void } = {},
  ): Promise<IngestResult> {
    return this.oneShot<IngestResult>({ op: "ingest", ...request }, options);
  }

  finalize(
    request: Omit<FinalizeRequest, "id" | "op">,
    options: { signal?: AbortSignal } = {},
  ): Promise<IngestResult> {
    return this.oneShot<IngestResult>({ op: "finalize", ...request }, options);
  }

  /**
   * Runs one read-only statement. Requests are served one at a time by a persistent process;
   * exceeding `timeoutMs` kills it (the next request starts a new one) and fails with
   * `query_timeout`.
   */
  runQuery(
    request: Omit<QueryRequest, "id" | "op">,
    options: { timeoutMs: number; signal?: AbortSignal },
  ): Promise<QueryResult> {
    const run = async (): Promise<QueryResult> => {
      if (this.closed) throw new DataError("cancelled", "The data engine is closed");
      options.signal?.throwIfAborted();
      clearTimeout(this.idle);
      if (!this.query || this.query.dead) {
        this.query = new EngineProcess(await this.scriptPath(), this.memory());
      }
      const child = this.query;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, options.timeoutMs);
      const abort = () => child.kill();
      options.signal?.addEventListener("abort", abort, { once: true });
      try {
        return await child.request<QueryResult>({ op: "query", ...request });
      } catch (error) {
        if (timedOut)
          throw new DataError(
            "query_timeout",
            `The query took longer than ${options.timeoutMs} ms and was stopped; simplify it or use python_run`,
          );
        if (options.signal?.aborted) throw new DataError("cancelled", "Cancelled");
        throw error;
      } finally {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", abort);
        this.armIdle();
      }
    };
    const next = this.queryQueue.then(run, run);
    this.queryQueue = next.catch(() => undefined);
    return next;
  }

  private armIdle(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.query?.end();
      this.query = undefined;
    }, this.options.idleMs ?? 30_000);
    this.idle.unref();
  }

  /** Closes the engine's connection to a file (before the host deletes or replaces it). */
  async closeFile(db?: string): Promise<void> {
    const child = this.query;
    if (!child || child.dead) return;
    const request: Omit<CloseRequest, "id"> = { op: "close", ...(db ? { db } : {}) };
    await this.queryQueue.then(() => child.request(request)).catch(() => undefined);
  }

  /** Kills every process; later requests fail. */
  close(): void {
    this.closed = true;
    clearTimeout(this.idle);
    this.query?.kill();
    this.query = undefined;
    for (const child of this.running) child.kill();
    this.running.clear();
  }
}
