import { randomBytes, timingSafeEqual } from "node:crypto";

/** A fresh 256-bit secret, base64url encoded. Never written to disk. */
export const newSecret = (): string => randomBytes(32).toString("base64url");

/** Constant-time string comparison (unequal lengths compare as different). */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Parses a `Cookie` header into name → value (first occurrence wins). */
export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;
    const name = part.slice(0, index).trim();
    if (name && !(name in cookies)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}
