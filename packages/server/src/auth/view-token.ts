/**
 * Signed view tokens of the isolated artifact viewer (spec §14.2): `base64url(artifactId ·
 * expiresAt · HMAC-SHA256(secret, artifactId‖expiresAt))`. A token names one artifact, expires
 * after a short time and is useless with any other secret (a fresh one per server process).
 */
import { createHmac } from "node:crypto";
import { safeEqual } from "./token.ts";

/** Default lifetime of a view link (renewable with another `POST /api/artifacts/:aid/view`). */
export const VIEW_TOKEN_TTL_MS = 10 * 60_000;

const ID = /^[A-Za-z0-9_-]{1,64}$/;

const mac = (secret: string, artifactId: string, expiresAt: number) =>
  createHmac("sha256", secret).update(`${artifactId}\n${expiresAt}`).digest("base64url");

/** A token for `artifactId` valid until `expiresAt` (epoch ms). */
export function signViewToken(secret: string, artifactId: string, expiresAt: number): string {
  if (!ID.test(artifactId)) throw new Error("Invalid artifact id");
  return Buffer.from(
    `${artifactId}.${expiresAt}.${mac(secret, artifactId, expiresAt)}`,
    "utf8",
  ).toString("base64url");
}

export type ViewTokenCheck =
  | { ok: true; artifactId: string; expiresAt: number }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

/** Verifies a token's signature (constant time) and expiry. */
export function verifyViewToken(secret: string, token: string, now = Date.now()): ViewTokenCheck {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(token)) return { ok: false, reason: "malformed" };
  const parts = Buffer.from(token, "base64url").toString("utf8").split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [artifactId = "", expires = "", signature = ""] = parts;
  const expiresAt = Number(expires);
  if (!ID.test(artifactId) || !/^\d{1,16}$/.test(expires) || !Number.isSafeInteger(expiresAt))
    return { ok: false, reason: "malformed" };
  if (!safeEqual(signature, mac(secret, artifactId, expiresAt)))
    return { ok: false, reason: "signature" };
  if (now >= expiresAt) return { ok: false, reason: "expired" };
  return { ok: true, artifactId, expiresAt };
}

/** A request path with the view token replaced, for logs (tokens are never logged). */
export const redactViewPath = (pathname: string): string =>
  pathname.replace(/^\/artifact-view\/[^/]*/, "/artifact-view/[token]");
