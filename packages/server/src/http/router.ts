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

/**
 * Minimal method + path router with `:param` segments and an optional trailing `*` segment that
 * captures the rest of the path (at least one segment) in `params["*"]`. No regex.
 */
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
  put(path: string, handler: RouteHandler): this {
    return this.add("PUT", path, handler);
  }
  delete(path: string, handler: RouteHandler): this {
    return this.add("DELETE", path, handler);
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

const decode = (segment: string): string | undefined => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

function matchSegments(pattern: string[], parts: string[]): Record<string, string> | undefined {
  const wildcard = pattern.at(-1) === "*";
  const fixed = wildcard ? pattern.length - 1 : pattern.length;
  if (wildcard ? parts.length <= fixed : parts.length !== fixed) return undefined;
  const params: Record<string, string> = {};
  for (let i = 0; i < fixed; i++) {
    const expected = pattern[i] as string;
    const actual = parts[i] as string;
    if (expected.startsWith(":")) {
      const decoded = decode(actual);
      if (decoded === undefined) return undefined;
      params[expected.slice(1)] = decoded;
    } else if (expected !== actual) return undefined;
  }
  if (wildcard) {
    // Each segment is decoded on its own and the rest is joined with "/": confinement of the
    // resulting path is the handler's job (it may contain "..").
    const rest: string[] = [];
    for (const part of parts.slice(fixed)) {
      const decoded = decode(part);
      if (decoded === undefined) return undefined;
      rest.push(decoded);
    }
    params["*"] = rest.join("/");
  }
  return params;
}
