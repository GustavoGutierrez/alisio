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
}
