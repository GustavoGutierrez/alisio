/**
 * Browser storage for per-viewer conveniences (theme, language, drafts, history). Every access
 * is wrapped: storage may be unavailable (private windows, blocked site data) and the UI must
 * work without it.
 */
export function readPref(key: string): string | undefined {
  try {
    return globalThis.localStorage?.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
}

export function writePref(key: string, value: string | undefined): void {
  try {
    if (value === undefined) globalThis.localStorage?.removeItem(key);
    else globalThis.localStorage?.setItem(key, value);
  } catch {
    /* storage unavailable: keep the in-memory value only */
  }
}

export function readJson<T>(key: string, fallback: T): T {
  const raw = readPref(key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
