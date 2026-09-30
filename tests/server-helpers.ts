/** Test helpers for @alisio/server: raw node:http requests (full header control) and login. */
import { mkdir, mkdtemp } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelProvider, ProviderEvent } from "@alisio/sdk";
import { vi } from "vitest";
import {
  type RunningServer,
  type ServerOptions,
  startServer,
} from "../packages/server/src/index.ts";
import { createLogger } from "../packages/server/src/log.ts";

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
  json<T = unknown>(): T;
}

export interface RequestInit {
  method?: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

/** Sends one request to `127.0.0.1:port`; `headers` values set to undefined are omitted. */
export function raw(port: number, path: string, init: RequestInit = {}): Promise<RawResponse> {
  const method = init.method ?? "GET";
  const payload =
    init.body === undefined
      ? undefined
      : typeof init.body === "string" || Buffer.isBuffer(init.body)
        ? init.body
        : JSON.stringify(init.body);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(init.headers ?? {}))
    if (value !== undefined) headers[key] = value;
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers,
        setHost: !("Host" in (init.headers ?? {})),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            text,
            json: <T>() => JSON.parse(text) as T,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

/** Exchanges the launch token for the session cookie; returns the `Cookie` header value. */
export async function login(port: number, token: string): Promise<string> {
  const res = await raw(port, `/?token=${encodeURIComponent(token)}`);
  if (res.status !== 303) throw new Error(`login failed: ${res.status} ${res.text}`);
  const set = res.headers["set-cookie"];
  const cookie = (Array.isArray(set) ? set[0] : set)?.split(";")[0];
  if (!cookie) throw new Error("login: no cookie");
  return cookie;
}

/** An authenticated JSON client bound to one server. */
export function client(port: number, cookie: string) {
  const origin = `http://127.0.0.1:${port}`;
  const call = (method: string, path: string, body?: unknown, headers = {}) =>
    raw(port, path, {
      method,
      body,
      headers: {
        Cookie: cookie,
        ...(method === "GET" ? {} : { Origin: origin, "Content-Type": "application/json" }),
        ...headers,
      },
    });
  return {
    get: (path: string, headers?: Record<string, string>) => call("GET", path, undefined, headers),
    post: (path: string, body: unknown = {}, headers?: Record<string, string>) =>
      call("POST", path, body, headers),
    patch: (path: string, body: unknown = {}, headers?: Record<string, string>) =>
      call("PATCH", path, body, headers),
  };
}

// ---------------------------------------------------------------------------------------------
// A real server on an ephemeral port with an isolated state/config home and a fake provider.
// ---------------------------------------------------------------------------------------------

type Turn = Parameters<ModelProvider["stream"]>[0];

/** A provider whose every stream call is answered by `turn` (call index from 0). */
export function fakeProvider(
  turn: (request: Turn, call: number) => AsyncGenerator<ProviderEvent>,
): ModelProvider & { calls: Turn[] } {
  const calls: Turn[] = [];
  return {
    id: "fake",
    model: "fake-model",
    calls,
    stream(request) {
      calls.push(request);
      return turn(request, calls.length - 1);
    },
  };
}

/** One assistant turn streaming `text` in two deltas, then completing without tool calls. */
export async function* reply(text: string): AsyncGenerator<ProviderEvent> {
  const half = Math.ceil(text.length / 2);
  yield { type: "text_delta", delta: text.slice(0, half) };
  yield { type: "text_delta", delta: text.slice(half) };
  yield { type: "completed", message: { role: "assistant", text, calls: [] } };
}

/** A promise with its resolver exposed. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Waits until `check` returns a truthy value (polling), or fails after `ms`. */
export async function until<T>(check: () => T | Promise<T>, ms = 5_000): Promise<T> {
  const end = Date.now() + ms;
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("until: timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

export interface TestServer {
  server: RunningServer;
  api: ReturnType<typeof client>;
  cookie: string;
  root: string;
  workspace: string;
  db: string;
  close(): Promise<void>;
}

/** Starts a server with a temp database/state/config and a default workspace directory. */
export async function startTestServer(
  options: Partial<ServerOptions> & { provider?: ModelProvider } = {},
): Promise<TestServer> {
  const root = await mkdtemp(join(tmpdir(), "alisio-server-"));
  const workspace = join(root, "ws");
  await mkdir(workspace);
  vi.stubEnv("ALISIO_CONFIG_HOME", join(root, "config"));
  vi.stubEnv("ALISIO_STATE_HOME", join(root, "state"));
  vi.stubEnv("HERDR_ENV", "0");
  const db = join(root, "state", "sessions.sqlite");
  const { provider, app, ...rest } = options;
  const server = await startServer({
    port: 0,
    logger: createLogger("silent"),
    defaultWorkspace: workspace,
    ...rest,
    app: {
      db,
      noHerdr: true,
      ...(provider ? { provider } : { provider: fakeProvider(() => reply("ok")) }),
      ...app,
    },
  });
  const cookie = await login(server.port, server.token);
  return {
    server,
    api: client(server.port, cookie),
    cookie,
    root,
    workspace,
    db,
    close: async () => {
      await server.close();
      vi.unstubAllEnvs();
    },
  };
}

/** Resolves with `promise`, or rejects with the signal's reason once it aborts. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    promise.then(resolve, reject);
  });
}

/**
 * A provider whose turns stream "wor", then wait for `release()` (or abort) before finishing
 * with "working done". `started` resolves on each call.
 */
export function gatedProvider() {
  let gate = deferred();
  let started = deferred();
  const provider = fakeProvider(async function* (request) {
    const mine = gate;
    started.resolve();
    yield { type: "text_delta", delta: "wor" };
    await abortable(mine.promise, request.signal);
    yield { type: "text_delta", delta: "king done" };
    yield {
      type: "completed",
      message: { role: "assistant", text: "working done", calls: [] },
    };
  });
  return {
    provider,
    get started() {
      return started.promise;
    },
    /** Lets the waiting turn(s) finish; later turns wait again. */
    release() {
      const current = gate;
      gate = deferred();
      started = deferred();
      current.resolve();
    },
  };
}

/** Creates a session in the test server's default workspace; returns its id. */
export async function newSession(t: TestServer, body: Record<string, unknown> = {}) {
  const res = await t.api.post("/api/sessions", { workspace: t.workspace, ...body });
  if (res.status !== 201) throw new Error(`newSession: ${res.status} ${res.text}`);
  return res.json<import("@alisio/sdk").SessionDetail>();
}

/** Waits until the latest run of a session reaches a terminal status; returns it. */
export async function settled(t: TestServer, sessionId: string, runId?: string) {
  return until(async () => {
    const runs = (await t.api.get(`/api/sessions/${sessionId}/runs`)).json<
      Array<{ id: string; status: string }>
    >();
    const run = runId ? runs.find((r) => r.id === runId) : runs[0];
    return run && run.status !== "queued" && run.status !== "running" ? run : undefined;
  });
}
