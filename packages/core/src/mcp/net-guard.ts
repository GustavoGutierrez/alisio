/**
 * SSRF guard for destinations that come from a catalog card (specs/030 D20, §13). A catalog entry
 * is untrusted data: before Alisio stores or contacts a remote URL it must be HTTPS, carry no
 * credentials and resolve only to public addresses. Manual, user-typed MCP URLs (a service on the
 * intranet, a local process) are NOT subject to this guard: the user chose them on purpose.
 *
 * Limits: the DNS answer is checked at planning time, not pinned to the later connection, so a
 * hostile resolver could still answer differently later (rebinding). Redirects are not followed at
 * connection time for bindings with secret headers (see the connector), which closes the redirect
 * route; the rebinding window remains and is documented in `docs/implementation-status.md`.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlRejection =
  | "scheme"
  | "credentials"
  | "private_address"
  | "unresolvable"
  | "invalid";

export class UrlRejectedError extends Error {
  constructor(
    readonly reason: UrlRejection,
    message: string,
  ) {
    super(message);
    this.name = "UrlRejectedError";
  }
}

export type HostResolver = (host: string) => Promise<string[]>;

export interface UrlGuard {
  /** Throws `UrlRejectedError` when the URL must not be used for a catalog-initiated request. */
  check(url: string | URL): Promise<URL>;
}

const defaultResolver: HostResolver = async (host) =>
  (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);

function v4Private(ip: string): boolean {
  const [a = 0, b = 0, c = 0] = ip.split(".").map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

/** Whether an IP literal is loopback, private, link-local, multicast, reserved or unspecified. */
export function isPrivateAddress(address: string): boolean {
  const ip = address.replace(/^\[|\]$/g, "").toLowerCase();
  const family = isIP(ip);
  if (family === 4) return v4Private(ip);
  if (family !== 6) return true;
  if (ip === "::" || ip === "::1") return true;
  const mapped = ip.match(/^(?:::ffff:|::)(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return v4Private(mapped[1] as string);
  const hex = ip.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hex) {
    const hi = Number.parseInt(hex[1] as string, 16);
    const lo = Number.parseInt(hex[2] as string, 16);
    return v4Private(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  const first = Number.parseInt(ip.split(":")[0] || "0", 16);
  return (
    (first & 0xfe00) === 0xfc00 || // unique local fc00::/7
    (first & 0xffc0) === 0xfe80 || // link-local fe80::/10
    (first & 0xff00) === 0xff00 || // multicast
    ip.startsWith("64:ff9b:") || // NAT64
    ip.startsWith("2001:db8:") // documentation
  );
}

const INTERNAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan", ".home.arpa"];

export function createUrlGuard(
  options: { resolve?: HostResolver; allowHttp?: boolean } = {},
): UrlGuard {
  const resolve = options.resolve ?? defaultResolver;
  return {
    async check(input) {
      let url: URL;
      try {
        url = new URL(input);
      } catch {
        throw new UrlRejectedError("invalid", "The address is not a valid URL");
      }
      const httpOk = options.allowHttp && url.protocol === "http:";
      if (url.protocol !== "https:" && !httpOk)
        throw new UrlRejectedError("scheme", "The service address must use HTTPS");
      if (url.username || url.password)
        throw new UrlRejectedError("credentials", "The service address must not embed credentials");
      const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
      if (!host) throw new UrlRejectedError("invalid", "The address has no host");
      if (host === "localhost" || INTERNAL_SUFFIXES.some((suffix) => host.endsWith(suffix)))
        throw new UrlRejectedError("private_address", "The service address is not public");
      if (isIP(host)) {
        if (isPrivateAddress(host))
          throw new UrlRejectedError("private_address", "The service address is not public");
        return url;
      }
      let addresses: string[];
      try {
        addresses = await resolve(host);
      } catch {
        throw new UrlRejectedError("unresolvable", "The service address could not be resolved");
      }
      if (!addresses.length)
        throw new UrlRejectedError("unresolvable", "The service address could not be resolved");
      if (addresses.some(isPrivateAddress))
        throw new UrlRejectedError("private_address", "The service address is not public");
      return url;
    },
  };
}

/** A guard that accepts everything: only for tests that talk to a local fixture. */
export const permissiveUrlGuard: UrlGuard = {
  async check(input) {
    return new URL(input);
  },
};
