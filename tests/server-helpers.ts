/** Test helpers for @alisio/server: raw node:http requests (full header control) and login. */
import { request as httpRequest } from "node:http";

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
