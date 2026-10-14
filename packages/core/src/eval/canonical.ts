/**
 * Canonical JSON of the reliability lab (specs/010 D10): equal values give equal text, so the same
 * text can be hashed for the configuration hash, argument keys and cassette fingerprints.
 *
 * Rules: object keys sorted by UTF-16 code unit (the default string order), `undefined` members
 * dropped (in arrays they become `null`, as `JSON.stringify` does), `null` kept, `-0` written as
 * `0`, non-finite numbers rejected (JSON cannot carry them), string VALUES normalized to NFC
 * (keys are left as written).
 */

import { createHash } from "node:crypto";

function normalize(value: unknown): unknown {
  if (typeof value === "string") return value.normalize("NFC");
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError(`Cannot canonicalize a non-finite number (${value}).`);
    return value === 0 ? 0 : value;
  }
  if (Array.isArray(value))
    return value.map((item) => (item === undefined ? null : normalize(item)));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const member = (value as Record<string, unknown>)[key];
      if (member !== undefined) out[key] = normalize(member);
    }
    return out;
  }
  return value;
}

/** JSON text with the canonical rules above. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export const sha256Hex = (data: string | Buffer): string =>
  createHash("sha256").update(data).digest("hex");

/** `sha256:<64 hex>` of the canonical JSON of `value`. */
export function hashCanonical(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJson(value))}`;
}
