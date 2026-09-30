import { chmod, mkdir, open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderConfigurationValue } from "@alisio/sdk";
import { configHome } from "../config.ts";

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
interface ProviderCredentials {
  schemaVersion: 1;
  providers: Record<string, Record<string, string>>;
}

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
  private credentials(): Promise<ProviderCredentials> {
    return read(this.credentialsPath, emptyCredentials()).then(async (value) => {
      await chmod(this.credentialsPath, 0o600).catch(() => {});
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
    const [settings, credentials] = await Promise.all([this.load(), this.credentials()]);
    settings.active = name;
    settings.profiles[name] = profile;
    credentials.providers[name] = { ...(credentials.providers[name] ?? {}), ...secrets };
    // Credentials first: an interrupted update can leave an unused secret, never an active profile without it.
    await atomicJson(this.credentialsPath, credentials, 0o600);
    await atomicJson(this.profilesPath, settings, 0o600);
  }
  /** Stores or replaces a profile's non-secret values without changing the active profile. */
  async saveProfile(name: string, profile: ProviderProfile): Promise<void> {
    const settings = await this.load();
    settings.profiles[name] = profile;
    await atomicJson(this.profilesPath, settings, 0o600);
  }
  /** Merges secrets into a profile's stored credentials (write-only: nothing is returned). */
  async setCredentials(name: string, secrets: Record<string, string>): Promise<void> {
    const credentials = await this.credentials();
    credentials.providers[name] = { ...(credentials.providers[name] ?? {}), ...secrets };
    await atomicJson(this.credentialsPath, credentials, 0o600);
  }
  /** Removes every stored credential of a profile; false when it had none. */
  async deleteCredentials(name: string): Promise<boolean> {
    const credentials = await this.credentials();
    if (!credentials.providers[name] || !Object.keys(credentials.providers[name]).length)
      return false;
    delete credentials.providers[name];
    await atomicJson(this.credentialsPath, credentials, 0o600);
    return true;
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
