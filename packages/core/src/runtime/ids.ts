import { randomBytes } from "node:crypto";

/** Crockford base32 (no I, L, O, U), the ULID alphabet. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID (26 characters, lexicographically sortable by creation time): 48 bits of milliseconds
 * and 80 random bits. No dependency and no monotonic counter; two ids created in the same
 * millisecond sort arbitrarily, which is fine for row ids and folder names.
 */
export function ulid(now: number = Date.now()): string {
  let time = "";
  let t = Math.max(0, Math.floor(now));
  for (let i = 0; i < 10; i++) {
    time = ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(10);
  let random = "";
  // 80 bits → 16 characters of 5 bits each.
  let buffer = 0,
    bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      random += ALPHABET[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  return time + random;
}

/** A prefixed id such as `art_01J…` or `exec_01J…`. */
export const newId = (prefix: string, now?: number): string => `${prefix}_${ulid(now)}`;
