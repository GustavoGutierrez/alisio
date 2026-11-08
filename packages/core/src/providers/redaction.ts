import { redactSecrets } from "../eval/secrets.ts";

/** Exact values shorter than this are never registered: they would match ordinary text. */
const MIN_EXACT_LENGTH = 8;

/** Three base64url segments starting with a JWT header (`eyJ…`). */
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;

/**
 * Exact secret values this process has seen: live and rotated access and refresh tokens,
 * authorization codes, PKCE verifiers and every `prompt` answer of 8 or more characters. Values
 * are never removed, so a rotated token keeps being redacted for the life of the process (D26).
 * Growth is bounded by the renewal cadence (about one per hour and profile).
 */
export class SecretRegistry {
  private known = new Set<string>();
  /** Registers a value; ignored when empty, not a string or shorter than 8 characters. */
  add(value: string | undefined): void {
    if (typeof value === "string" && value.length >= MIN_EXACT_LENGTH) this.known.add(value);
  }
  values(): string[] {
    return [...this.known];
  }
}

/** The registry the host uses by default (one per process). */
export const sharedSecrets = new SecretRegistry();

/** Registers a value in the process-wide registry. */
export function registerSecret(value: string | undefined): void {
  sharedSecrets.add(value);
}

/** Every exact secret value known to the process, for the eval cassette and export scans (D26b). */
export function knownSecretValues(): string[] {
  return sharedSecrets.values();
}

/**
 * `redactSecrets` (the eval rule table, unchanged) plus the JWT rule and every exact value the
 * process knows. Best effort: it does not replace never logging the value (D8).
 */
export function redactCredentials(
  text: string,
  exact: readonly string[] = [],
  registry: SecretRegistry = sharedSecrets,
): string {
  // Longest first so a value that contains another one is removed whole.
  const values = [...new Set([...registry.values(), ...exact])].sort((a, b) => b.length - a.length);
  return redactSecrets(text, values).replace(JWT, "[redacted]");
}

/**
 * `data` of a run event with its `error` text redacted (shallow copy), or `data` itself when it
 * carries none. The exit point for run failures and the SQLite event journal (D26a).
 */
export function redactEventData<T>(data: T): T {
  if (!data || typeof data !== "object") return data;
  const error = (data as { error?: unknown }).error;
  if (typeof error !== "string") return data;
  const clean = redactCredentials(error);
  return clean === error ? data : ({ ...data, error: clean } as T);
}

/**
 * `value` with every string inside it redacted (`redactCredentials`), copying only what changed:
 * the same reference comes back when nothing matched. Used on JSON-shaped output (SSE frames, log
 * fields, `--json` events) where redacting the serialized text could cut through the JSON syntax.
 */
export function redactDeep<T>(value: T, registry: SecretRegistry = sharedSecrets, depth = 0): T {
  if (typeof value === "string") {
    // Nothing shorter than the shortest rule or exact value can match.
    if (value.length < MIN_EXACT_LENGTH) return value;
    const clean = redactCredentials(value, [], registry);
    return (clean === value ? value : clean) as T;
  }
  if (!value || typeof value !== "object" || depth > 64) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const clean = redactDeep(item, registry, depth + 1);
      if (clean !== item) changed = true;
      return clean;
    });
    return (changed ? next : value) as T;
  }
  let copy: Record<string, unknown> | undefined;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const clean = redactDeep(item, registry, depth + 1);
    if (clean !== item) {
      copy ??= { ...(value as Record<string, unknown>) };
      copy[key] = clean;
    }
  }
  return (copy ?? value) as T;
}
