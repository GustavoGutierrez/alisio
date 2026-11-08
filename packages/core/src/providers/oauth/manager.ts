import type { ProviderAuthMethod, ProviderOAuthCredential, ProviderOAuthHandle } from "@alisio/sdk";
import { redactCredentials, type SecretRegistry, sharedSecrets } from "../redaction.ts";
import type { ProviderSettingsStore, StoredOAuthCredential } from "../settings.ts";
import { type FileLockOptions, withFileLock } from "./lock.ts";

/** The access token is renewed when it expires within this margin. */
export const REFRESH_MARGIN_MS = 300_000;
/** Time limit of the shared renewal (its own, never a caller's signal, D23). */
export const REFRESH_TIMEOUT_MS = 10_000;
/** Longest wait for `credentials.json.refresh.lock`: above the longest realistic hold (~16 s, D24d). */
export const REFRESH_LOCK_WAIT_MS = 20_000;

export type OAuthErrorCode =
  | "OAUTH_SIGN_IN_REQUIRED"
  | "OAUTH_REFRESH_BUSY"
  | "OAUTH_REFRESH_FAILED";

/** Failure of `get()`; `code` is a stable string, the message never carries a token. */
export class OAuthError extends Error {
  constructor(
    readonly code: OAuthErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

/** The part of the provider registry the manager needs (resolved live at every call, D28). */
export interface OAuthRegistrations {
  get(id: string): { auth?: ProviderAuthMethod[] } | undefined;
}

export interface OAuthManagerOptions {
  store: ProviderSettingsStore;
  registry: OAuthRegistrations;
  /** Clock seam, epoch milliseconds. */
  now?: () => number;
  /** Seam for the renewal's own time limit. */
  refreshTimeoutMs?: number;
  /** Timing seam of `credentials.json.refresh.lock` (clock, sleep, stale threshold, wait). */
  refreshLockTiming?: Partial<FileLockOptions>;
  /** Where exact token values are recorded for redaction; defaults to the process-wide one. */
  secrets?: SecretRegistry;
}

/**
 * Pure decision (D7, D27): renew when the access token expires within `margin`, or when the caller
 * saw this exact access token rejected. A token without `expires` renews only after a rejection.
 * `earliestRefreshAt` is advisory metadata and never takes part.
 */
export function needsRefresh(
  credential: { access: string; expires?: number },
  now: number,
  margin = REFRESH_MARGIN_MS,
  rejectedAccess?: string,
): boolean {
  if (credential.expires !== undefined && credential.expires - now <= margin) return true;
  return rejectedAccess !== undefined && rejectedAccess === credential.access;
}

/** Rejects like `signal` when it aborts first; the shared promise itself is untouched. */
function raceSignal<T>(shared: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return shared;
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error("Aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    shared.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function toCredential(entry: StoredOAuthCredential): ProviderOAuthCredential {
  return {
    type: "oauth",
    access: entry.access,
    ...(entry.refresh !== undefined ? { refresh: entry.refresh } : {}),
    ...(entry.expires !== undefined ? { expires: entry.expires } : {}),
    ...(entry.metadata ? { metadata: { ...entry.metadata } } : {}),
  };
}

/**
 * Custodian of provider sign-in sessions (D4): reads the stored session, renews it when due with
 * one renewal per profile in the process (single-flight) and one across processes (file lock plus
 * a re-read), persists a rotated refresh token before returning it, and never falls back to any
 * other credential source. Convenience session management, not encryption or isolation.
 */
/** Single-flight and rejection state belong to a profile AND the registration that owns it (R2-07). */
const flightKey = (profile: string, registrationId: string) => `${profile}\0${registrationId}`;

export class OAuthManager {
  private readonly store: ProviderSettingsStore;
  private readonly registry: OAuthRegistrations;
  private readonly now: () => number;
  private readonly refreshTimeoutMs: number;
  private readonly refreshLockTiming: Partial<FileLockOptions>;
  private readonly secrets: SecretRegistry;
  private readonly inFlight = new Map<string, Promise<ProviderOAuthCredential>>();
  private readonly rejected = new Map<string, string>();

  constructor(options: OAuthManagerOptions) {
    this.store = options.store;
    this.registry = options.registry;
    this.now = options.now ?? Date.now;
    this.refreshTimeoutMs = options.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    this.refreshLockTiming = options.refreshLockTiming ?? {};
    this.secrets = options.secrets ?? sharedSecrets;
  }

  /** The handle a registration receives as `request.oauth`, bound to one profile (D19, D21). */
  handleFor(profile: string, registrationId: string): ProviderOAuthHandle {
    return {
      get: (signal) => this.get(profile, registrationId, signal),
      invalidate: (reason) => this.invalidate(profile, registrationId, reason),
    };
  }

  /** Every exact token value this process manages (live and rotated), for cassette and export scans (D26b). */
  async exactSecrets(): Promise<string[]> {
    // Also pick up sessions stored by other processes, so a scan never misses a live token.
    try {
      const entries = await this.store.listOAuthEntries();
      for (const entry of entries) this.track(entry);
    } catch {
      /* A missing or unreadable file only means there is nothing more to add. */
    }
    return this.secrets.values();
  }

  private track(credential: { access: string; refresh?: string }): void {
    this.secrets.add(credential.access);
    this.secrets.add(credential.refresh);
  }

  private signInRequired(profile: string): OAuthError {
    return new OAuthError(
      "OAUTH_SIGN_IN_REQUIRED",
      redactCredentials(
        `Profile "${profile}" needs a sign-in. Sign in again from Settings > Models or /connect.`,
        [],
        this.secrets,
      ),
    );
  }

  /** The stored session when `registrationId` may use it; rejects when it must count as absent (D21, D28). */
  private async usable(profile: string, registrationId: string): Promise<StoredOAuthCredential> {
    const entry = await this.store.getOAuthEntry(profile);
    if (!entry || entry.provider !== registrationId) throw this.signInRequired(profile);
    this.track(entry);
    if (entry.state === "needs_sign_in") throw this.signInRequired(profile);
    const registration = this.registry.get(registrationId);
    if (!registration || !registration.auth?.some((method) => method.id === entry.method))
      throw this.signInRequired(profile);
    return entry;
  }

  async get(
    profile: string,
    registrationId: string,
    signal?: AbortSignal,
  ): Promise<ProviderOAuthCredential> {
    if (signal?.aborted) throw signal.reason ?? new Error("Aborted");
    return raceSignal(this.resolveCredential(profile, registrationId), signal);
  }

  private async resolveCredential(
    profile: string,
    registrationId: string,
  ): Promise<ProviderOAuthCredential> {
    const entry = await this.usable(profile, registrationId);
    const key = flightKey(profile, registrationId);
    if (!needsRefresh(entry, this.now(), REFRESH_MARGIN_MS, this.rejected.get(key)))
      return toCredential(entry);
    let shared = this.inFlight.get(key);
    if (!shared) {
      shared = this.renew(profile, registrationId).finally(() => this.inFlight.delete(key));
      this.inFlight.set(key, shared);
    }
    return shared;
  }

  /** The one renewal shared by every caller of this profile; it never sees a caller's signal (D23). */
  private renew(profile: string, registrationId: string): Promise<ProviderOAuthCredential> {
    return withFileLock(
      this.store.refreshLockPath,
      {
        waitMs: REFRESH_LOCK_WAIT_MS,
        timeoutCode: "OAUTH_REFRESH_BUSY",
        ...this.refreshLockTiming,
      },
      () => this.renewLocked(profile, registrationId),
    ).catch((error) => {
      // Waiting for the lock ran out: transient, the session is untouched.
      if ((error as { code?: string }).code === "OAUTH_REFRESH_BUSY")
        throw new OAuthError("OAUTH_REFRESH_BUSY", (error as Error).message, true);
      throw error;
    });
  }

  private async renewLocked(
    profile: string,
    registrationId: string,
  ): Promise<ProviderOAuthCredential> {
    // Double check under the lock: another process may have renewed while we waited.
    const entry = await this.usable(profile, registrationId);
    if (
      !needsRefresh(
        entry,
        this.now(),
        REFRESH_MARGIN_MS,
        this.rejected.get(flightKey(profile, registrationId)),
      )
    )
      return toCredential(entry);
    const generation = entry.generation;
    const method = this.registry
      .get(registrationId)
      ?.auth?.find((candidate) => candidate.id === entry.method);
    if (!method?.refresh || !entry.refresh) {
      await this.store.markOAuthState(profile, "needs_sign_in", generation);
      throw this.signInRequired(profile);
    }
    let next: ProviderOAuthCredential;
    try {
      next = await this.callRefresh(method, toCredential(entry));
    } catch (error) {
      if ((error as { retryable?: unknown }).retryable === true)
        throw new OAuthError(
          "OAUTH_REFRESH_FAILED",
          redactCredentials(
            `Renewing the sign-in of profile "${profile}" failed: ${(error as Error).message}`,
            [],
            this.secrets,
          ),
          true,
        );
      // Permanent: keep the credential, never fall back to an environment variable (D7e).
      await this.store.markOAuthState(profile, "needs_sign_in", generation);
      throw this.signInRequired(profile);
    }
    this.track(next);
    const merged: ProviderOAuthCredential = {
      type: "oauth",
      access: next.access,
      // A response without a new refresh token keeps the one we hold.
      ...((next.refresh ?? entry.refresh) !== undefined
        ? { refresh: next.refresh ?? entry.refresh }
        : {}),
      ...(next.expires !== undefined ? { expires: next.expires } : {}),
      ...(entry.metadata || next.metadata
        ? { metadata: { ...(entry.metadata ?? {}), ...(next.metadata ?? {}) } }
        : {}),
    };
    // Persisted before it is returned (D7d), and only when the entry is still the one we renewed (D22a).
    const written = await this.store.setOAuth(
      profile,
      merged,
      { method: entry.method, provider: entry.provider },
      { expectedGeneration: generation },
    );
    if (written !== false) {
      this.rejected.delete(flightKey(profile, registrationId));
      return merged;
    }
    // The entry changed while we renewed (deleted, signed in again, marked): drop our result.
    const current = await this.usable(profile, registrationId);
    return toCredential(current);
  }

  /** Runs `method.refresh` with the renewal's own time limit, whatever the plugin does with the signal. */
  private callRefresh(
    method: ProviderAuthMethod,
    credential: ProviderOAuthCredential,
  ): Promise<ProviderOAuthCredential> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        const failure = Object.assign(new Error("The renewal timed out"), { retryable: true });
        controller.abort(failure);
        reject(failure);
      }, this.refreshTimeoutMs);
    });
    const run = Promise.resolve().then(() => method.refresh?.(credential, controller.signal));
    return Promise.race([run as Promise<ProviderOAuthCredential>, timeout]).finally(() =>
      clearTimeout(timer),
    );
  }

  /**
   * `invalidate()` records the rejected access token (D27); any `reason` marks the session as
   * needing a new sign-in at once (D20; unknown reasons count as `"sign_in_required"`).
   */
  async invalidate(profile: string, registrationId: string, reason?: string): Promise<void> {
    const entry = await this.store.getOAuthEntry(profile);
    if (!entry || entry.provider !== registrationId) return;
    this.track(entry);
    if (reason !== undefined) {
      await this.store.markOAuthState(profile, "needs_sign_in", entry.generation);
      return;
    }
    this.rejected.set(flightKey(profile, registrationId), entry.access);
  }
}
