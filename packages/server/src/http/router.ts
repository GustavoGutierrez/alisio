import type { IncomingMessage, ServerResponse } from "node:http";

/** Everything a route handler receives for one request. */
export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  params: Record<string, string>;
  /** `X-Request-Id` of the request (validated or generated); also the run correlation id. */
  correlationId: string;
}

/**
 * A route returns a JSON-serializable value (sent with `status`, 200 by default), or
 * `undefined` after writing the response itself (e.g. an SSE stream).
 */
export type RouteResult = { status?: number; body: unknown } | undefined;
export type RouteHandler = (ctx: RouteContext) => Promise<RouteResult> | RouteResult;

interface Route {
  method: string;
  segments: string[];
  handler: RouteHandler;
}

/** Minimal method + path router with `:param` segments (no regex, no wildcards). */
export class Router {
  private routes: Route[] = [];

  add(method: string, path: string, handler: RouteHandler): this {
    this.routes.push({ method, segments: path.split("/").filter(Boolean), handler });
    return this;
  }
  get(path: string, handler: RouteHandler): this {
    return this.add("GET", path, handler);
  }
  post(path: string, handler: RouteHandler): this {
    return this.add("POST", path, handler);
  }
  patch(path: string, handler: RouteHandler): this {
    return this.add("PATCH", path, handler);
  }

  /**
   * The handler and params for a request, `"method"` when the path exists with another method,
   * or `undefined` when no route matches the path.
   */
  match(
    method: string,
    pathname: string,
  ): { handler: RouteHandler; params: Record<string, string> } | "method" | undefined {
    const parts = pathname.split("/").filter(Boolean);
    let pathMatched = false;
    for (const route of this.routes) {
      const params = matchSegments(route.segments, parts);
      if (!params) continue;
      if (route.method === method) return { handler: route.handler, params };
      pathMatched = true;
    }
    return pathMatched ? "method" : undefined;
  }
}

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | undefined {
  if (pattern.length !== parts.length) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const expected = pattern[i] as string;
    const actual = parts[i] as string;
    if (expected.startsWith(":")) {
      let decoded: string;
      try {
        decoded = decodeURIComponent(actual);
      } catch {
        return undefined;
      }
      params[expected.slice(1)] = decoded;
    } else if (expected !== actual) return undefined;
  }
  return params;
}
