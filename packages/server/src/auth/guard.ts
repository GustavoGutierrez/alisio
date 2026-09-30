import type { IncomingMessage } from "node:http";
import { isIP } from "node:net";
import { HttpError } from "../http/errors.ts";
import { newSecret, parseCookies, safeEqual } from "./token.ts";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);

/** Whether a bind address only accepts local connections. */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "");
  return LOOPBACK.has(bare) || /^127\.\d+\.\d+\.\d+$/.test(bare);
}

const WILDCARD = new Set(["0.0.0.0", "::", "[::]"]);

/**
 * Launch-token authentication plus the Host/Origin checks of §11.1. The launch token is only
 * accepted once per browser (exchanged for a cookie holding a separate secret); cookies are
 * named per port because browsers do not isolate cookies by port.
 */
export class AuthGuard {
  readonly token: string;
  readonly cookieName: string;
  private readonly secret = newSecret();
  private readonly hosts: Set<string>;
  private readonly wildcard: boolean;

  constructor(options: { token?: string; host: string; port: number }) {
    this.token = options.token ?? newSecret();
    this.cookieName = `alisio_session_${options.port}`;
    const port = options.port;
    const explicit =
      options.host.includes(":") && !options.host.startsWith("[")
        ? `[${options.host}]`
        : options.host;
    this.hosts = new Set([
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`,
      `${explicit}:${port}`,
    ]);
    this.wildcard = WILDCARD.has(options.host);
  }

  /**
   * DNS-rebinding defense: the `Host` header must name this server. When bound to a wildcard
   * address (`--allow-remote`), any IP-literal host on the right port is accepted too, since a
   * rebinding attack needs a DNS name.
   */
  checkHost(req: IncomingMessage): void {
    const host = (req.headers.host ?? "").toLowerCase();
    if (this.hosts.has(host)) return;
    if (this.wildcard) {
      const match = /^(\[[^\]]+\]|[^:]+):(\d+)$/.exec(host);
      const name = match?.[1]?.replace(/^\[|\]$/g, "");
      if (match && name && isIP(name) && [...this.hosts].some((h) => h.endsWith(`:${match[2]}`)))
        return;
    }
    throw new HttpError("forbidden_host", "Host not allowed");
  }

  /**
   * CSRF defense: requests with side effects need an `Origin` equal to this server's origin; any
   * request that carries a foreign `Origin` is refused.
   */
  checkOrigin(req: IncomingMessage): void {
    const origin = req.headers.origin;
    const expected = `http://${req.headers.host ?? ""}`;
    const effectful = !["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET");
    if (origin === undefined) {
      if (effectful) throw new HttpError("forbidden_origin", "Origin header required");
      return;
    }
    if (origin.toLowerCase() !== expected.toLowerCase())
      throw new HttpError("forbidden_origin", "Origin not allowed");
  }

  /** Whether the request carries this process's session cookie. */
  authenticated(req: IncomingMessage): boolean {
    const value = parseCookies(req.headers.cookie)[this.cookieName];
    return value !== undefined && safeEqual(value, this.secret);
  }

  /** Whether `candidate` is the launch token (constant time). */
  validToken(candidate: string | null): boolean {
    return candidate !== null && safeEqual(candidate, this.token);
  }

  /** The `Set-Cookie` value issued after a successful token exchange. */
  sessionCookie(): string {
    return `${this.cookieName}=${this.secret}; HttpOnly; SameSite=Strict; Path=/`;
  }
}
