import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderConfigurationValue, ProviderOAuthCredential } from "@alisio/sdk";
import { configHome } from "../config.ts";
import { type FileLockOptions, withFileLock } from "./oauth/lock.ts";

export interface ProviderProfile {
  provider: string;
  values: Record<string, ProviderConfigurationValue>;
  model: string;
}
export interface ProviderSettings {
  schemaVersion: 1;
  active?: string;
  profiles: Record<string, ProviderProfile>;
}
/** A sign-in session as stored under `oauth[profile]` (D6). */
export interface StoredOAuthCredential extends ProviderOAuthCredential {
  /** Id of the sign-in method that created it (selects its `refresh`). */
  method: string;
  /** Id of the provider registration that created it; no other registration may read it (D21). */
  provider: string;
  /** Monotonic counter taken from `oauthSeq`; guards every write made after a wait (D22). */
  generation: number;
  state?: "ok" | "needs_sign_in";
}
interface ProviderCredentials {
  schemaVersion: 1;
  providers: Record<string, Record<string, string>>;
  oauthSeq?: number;
  oauth?: Record<string, StoredOAuthCredential>;
  /** Unknown top-level keys are kept as they are when the file is rewritten. */
  [unknown: string]: unknown;
}
/** Condition checked under the lock after re-reading, for a write that follows a wait (D22). */
export interface OAuthWriteCondition {
  /** The entry must exist and still carry this generation (renewal). */
  expectedGeneration?: number;
  /** Evaluated under the lock; `false` discards the write (a flow that already ended). */
  guard?: () => boolean;
}

/** Maximum wait for `credentials.json.lock`: held for milliseconds by ordinary writes. */
const CREDENTIALS_LOCK_WAIT_MS = 5_000;

const emptySettings = (): ProviderSettings => ({ schemaVersion: 1, profiles: {} });
const emptyCredentials = (): ProviderCredentials => ({ schemaVersion: 1, providers: {} });

async function read<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw error;
  }
}

async function atomicJson(path: string, value: unknown, mode: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700).catch(() => {});
  const temporary = `${path}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, mode);
  await rename(temporary, path);
  await chmod(path, mode);
}

/**
 * Display form of a secret: its last three characters behind an ellipsis, and nothing at all for
 * secrets shorter than 16 characters (a tail would reveal too much of them).
 */
export function maskSecret(secret: string): string | undefined {
  return secret.length >= 16 ? `…${secret.slice(-3)}` : undefined;
}

export class ProviderSettingsStore {
  readonly profilesPath: string;
  readonly credentialsPath: string;
  constructor(root = configHome()) {
    this.profilesPath = join(root, "providers.json");
    this.credentialsPath = join(root, "credentials.json");
  }
  load(): Promise<ProviderSettings> {
    return read(this.profilesPath, emptySettings());
  }
  /** `credentials.json.lock`: guards every read-modify-write of the credentials file (D15). */
  get lockPath(): string {
    return `${this.credentialsPath}.lock`;
  }
  /** `credentials.json.refresh.lock`: held across a token renewal; used by the OAuth manager only. */
  get refreshLockPath(): string {
    return `${this.credentialsPath}.refresh.lock`;
  }
  /** Test seam: timing of the credentials lock (clock, sleep, stale threshold). */
  lockTiming: Partial<FileLockOptions> = {};
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(
      this.lockPath,
      { waitMs: CREDENTIALS_LOCK_WAIT_MS, ...this.lockTiming },
      fn,
    );
  }
  private credentials(): Promise<ProviderCredentials> {
    return read(this.credentialsPath, emptyCredentials()).then(async (value) => {
      await chmod(this.credentialsPath, 0o600).catch(() => {});
      // A file with `oauth` but no `providers` is valid (D6): normalize instead of failing later.
      if (!value.providers || typeof value.providers !== "object") value.providers = {};
      return value;
    });
  }
  async active(): Promise<
    { name: string; profile: ProviderProfile; credentials: Record<string, string> } | undefined
  > {
    const settings = await this.load();
    if (!settings.active) return undefined;
    const profile = settings.profiles[settings.active];
    if (!profile) return undefined;
    const credentials = await this.credentials();
    return {
      name: settings.active,
      profile,
      credentials: credentials.providers[settings.active] ?? {},
    };
  }
  /** Resolves one stored plugin profile for host use. Display layers must not call this. */
  async resolve(
    name: string,
  ): Promise<
    { name: string; profile: ProviderProfile; credentials: Record<string, string> } | undefined
  > {
    const settings = await this.load();
    const profile = settings.profiles[name];
    if (!profile) return undefined;
    const credentials = await this.credentials();
    return { name, profile, credentials: credentials.providers[name] ?? {} };
  }
  async saveActive(
    name: string,
    profile: ProviderProfile,
    secrets: Record<string, string>,
  ): Promise<void> {
    await this.locked(async () => {
      const [settings, credentials] = await Promise.all([this.load(), this.credentials()]);
      // A different provider type must not inherit the sign-in session of the old one (D21b).
      if (settings.profiles[name] && settings.profiles[name].provider !== profile.provider)
        delete credentials.oauth?.[name];
      settings.active = name;
      settings.profiles[name] = profile;
      credentials.providers[name] = { ...(credentials.providers[name] ?? {}), ...secrets };
      // Credentials first: an interrupted update can leave an unused secret, never an active profile without it.
      await atomicJson(this.credentialsPath, credentials, 0o600);
      await atomicJson(this.profilesPath, settings, 0o600);
    });
  }
  /**
   * Stores or replaces a profile's non-secret values without changing the active profile. Changing
   * the provider type of a profile drops its sign-in session in the same critical section (D21b).
   */
  async saveProfile(name: string, profile: ProviderProfile): Promise<void> {
    await this.locked(async () => {
      const settings = await this.load();
      const previous = settings.profiles[name];
      if (previous && previous.provider !== profile.provider) {
        const credentials = await this.credentials();
        if (credentials.oauth?.[name]) {
          delete credentials.oauth[name];
          await atomicJson(this.credentialsPath, credentials, 0o600);
        }
      }
      settings.profiles[name] = profile;
      await atomicJson(this.profilesPath, settings, 0o600);
    });
  }
  /** Merges secrets into a profile's stored credentials (write-only: nothing is returned). */
  async setCredentials(name: string, secrets: Record<string, string>): Promise<void> {
    await this.locked(async () => {
      const credentials = await this.credentials();
      credentials.providers[name] = { ...(credentials.providers[name] ?? {}), ...secrets };
      await atomicJson(this.credentialsPath, credentials, 0o600);
    });
  }
  /** Removes every stored credential of a profile, API keys and sign-in session; false when it had none. */
  async deleteCredentials(name: string): Promise<boolean> {
    return this.locked(async () => {
      const credentials = await this.credentials();
      const hadKeys =
        !!credentials.providers[name] && Object.keys(credentials.providers[name]).length > 0;
      const hadOAuth = !!credentials.oauth?.[name];
      if (!hadKeys && !hadOAuth) return false;
      delete credentials.providers[name];
      if (credentials.oauth) delete credentials.oauth[name];
      await atomicJson(this.credentialsPath, credentials, 0o600);
      return true;
    });
  }
  /** The stored sign-in session of a profile, whatever registration created it (host-internal). */
  async getOAuthEntry(name: string): Promise<StoredOAuthCredential | undefined> {
    return (await this.credentials()).oauth?.[name];
  }
  /** Every stored sign-in session by profile (host-internal, for redaction bookkeeping). */
  async listOAuthEntries(): Promise<StoredOAuthCredential[]> {
    return Object.values((await this.credentials()).oauth ?? {});
  }
  /** Access and refresh values of every stored session: exact secrets for cassette and export scans (D26b). */
  async oauthSecretValues(): Promise<string[]> {
    return (await this.listOAuthEntries()).flatMap((entry) =>
      entry.refresh ? [entry.access, entry.refresh] : [entry.access],
    );
  }
  /** The sign-in session of a profile only when `providerId` is the registration that created it (D21). */
  async getOAuth(name: string, providerId: string): Promise<StoredOAuthCredential | undefined> {
    const entry = await this.getOAuthEntry(name);
    return entry && entry.provider === providerId ? entry : undefined;
  }
  /**
   * Writes the sign-in session of a profile with a fresh `generation` (from `oauthSeq`, which never
   * goes back). Under the credentials lock it re-reads and checks `condition`; when the condition
   * fails nothing is written and the result is `false`. Resolves the new generation otherwise.
   */
  async setOAuth(
    name: string,
    credential: ProviderOAuthCredential,
    binding: { method: string; provider: string },
    condition: OAuthWriteCondition = {},
  ): Promise<number | false> {
    return this.locked(async () => {
      const credentials = await this.credentials();
      if (condition.expectedGeneration !== undefined) {
        const current = credentials.oauth?.[name];
        if (!current || current.generation !== condition.expectedGeneration) return false;
      }
      if (condition.guard && !condition.guard()) return false;
      const generation = (credentials.oauthSeq ?? 0) + 1;
      credentials.oauthSeq = generation;
      credentials.oauth = {
        ...(credentials.oauth ?? {}),
        [name]: {
          type: "oauth",
          access: credential.access,
          ...(credential.refresh !== undefined ? { refresh: credential.refresh } : {}),
          ...(credential.expires !== undefined ? { expires: credential.expires } : {}),
          ...(credential.metadata ? { metadata: { ...credential.metadata } } : {}),
          method: binding.method,
          provider: binding.provider,
          generation,
          state: "ok",
        },
      };
      await atomicJson(this.credentialsPath, credentials, 0o600);
      return generation;
    });
  }
  /**
   * Sets the state of a stored session when it still carries `expectedGeneration`. The generation
   * moves forward too, so a renewal that started earlier cannot overwrite the new state (D22c).
   */
  async markOAuthState(
    name: string,
    state: "ok" | "needs_sign_in",
    expectedGeneration: number,
  ): Promise<boolean> {
    return this.locked(async () => {
      const credentials = await this.credentials();
      const current = credentials.oauth?.[name];
      if (!current || current.generation !== expectedGeneration) return false;
      const generation = (credentials.oauthSeq ?? 0) + 1;
      credentials.oauthSeq = generation;
      (credentials.oauth as Record<string, StoredOAuthCredential>)[name] = {
        ...current,
        state,
        generation,
      };
      await atomicJson(this.credentialsPath, credentials, 0o600);
      return true;
    });
  }
  /** Removes only the sign-in session of a profile; false when there was none. */
  async deleteOAuth(name: string): Promise<boolean> {
    return this.locked(async () => {
      const credentials = await this.credentials();
      if (!credentials.oauth?.[name]) return false;
      delete credentials.oauth[name];
      await atomicJson(this.credentialsPath, credentials, 0o600);
      return true;
    });
  }
  /** Which credentials a profile has stored, masked (`maskSecret`); never the values. */
  async credentialStatus(name: string): Promise<Record<string, { tail?: string }>> {
    const stored = (await this.credentials()).providers[name] ?? {};
    return Object.fromEntries(
      Object.entries(stored)
        .filter(([, value]) => typeof value === "string" && value.length > 0)
        .map(([key, value]) => {
          const tail = maskSecret(value);
          return [key, tail ? { tail } : {}];
        }),
    );
  }
}
