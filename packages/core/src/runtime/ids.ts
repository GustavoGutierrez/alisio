import { createHash, randomBytes, randomUUID } from "node:crypto";

/** Crockford base32 (no I, L, O, U), the ULID alphabet. */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * A ULID (26 characters, lexicographically sortable by creation time): 48 bits of milliseconds
 * and 80 random bits. No dependency and no monotonic counter; two ids created in the same
 * millisecond sort arbitrarily, which is fine for row ids and folder names.
 */
export function ulid(now: number = Date.now()): string {
  if (installed) return installed.ulid(now);
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

/**
 * A replacement for the random identifiers the runtime generates (session ids, plan ids, forge
 * execution ids, `ulid`-based ids). The reliability lab installs a seeded one while it records or
 * replays a cassette so the requests a run sends do not depend on fresh randomness. Nothing
 * installs one in normal use, and then every function here behaves exactly as before.
 */
export interface IdSource {
  /** A UUID (the shape of `crypto.randomUUID()`). */
  uuid(): string;
  /** The 26-character body of a `ulid` (the argument is the caller's clock, which a source may ignore). */
  ulid(now?: number): string;
}

let installed: IdSource | undefined;

/** Installs (or, with `undefined`, removes) the process-wide id source. */
export function setIdSource(source?: IdSource): void {
  installed = source;
}

/** A random v4 UUID, or the next one of the installed id source. */
export const newUuid = (): string => (installed ? installed.uuid() : randomUUID());

/**
 * A deterministic source: the n-th UUID (and the n-th ULID) depends only on `seed`. UUIDs are
 * v4-shaped; ULIDs carry a counter in their time part, so they stay sortable by creation order.
 */
export function seededIdSource(seed: string): IdSource {
  let uuids = 0;
  let ulids = 0;
  const digest = (kind: string, n: number) =>
    createHash("sha256").update(`${seed}\0${kind}\0${n}`).digest();
  return {
    uuid() {
      const bytes = digest("uuid", uuids++).subarray(0, 16);
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
      const hex = bytes.toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
    ulid() {
      let time = "";
      let t = ulids;
      for (let i = 0; i < 10; i++) {
        time = (ALPHABET[t % 32] ?? "0") + time;
        t = Math.floor(t / 32);
      }
      const bytes = digest("ulid", ulids++);
      let random = "";
      for (let i = 0; i < 16; i++) random += ALPHABET[(bytes[i] ?? 0) & 31];
      return time + random;
    },
  };
}
