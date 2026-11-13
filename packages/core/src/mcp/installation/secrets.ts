/**
 * Protected storage of MCP secrets (specs/030 D7, D17, O8). The configuration files only ever hold
 * a REFERENCE (`{ "secret": "<id>" }` or `{ "env": "<NAME>" }`); the value lives behind the
 * `SecretStore` port. Today's adapter is a dedicated 0600 file next to `credentials.json` with the
 * same lock: protected by the user's file permissions, NOT encrypted. The port exists so an
 * adapter backed by Electron `safeStorage` (or an OS keyring) can replace it without touching the
 * installer, the connector or the routes.
 *
 * Values are never logged and never returned by any wire DTO: only the installer and the connector
 * call `get`.
 */
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configHome } from "../../config.ts";
import { withFileLock } from "../../providers/oauth/lock.ts";

export interface SecretStore {
  /** Which adapter holds the values (`file`, `memory`, later `safe-storage`). */
  readonly kind: string;
  get(id: string): Promise<string | undefined>;
  has(id: string): Promise<boolean>;
  set(id: string, value: string): Promise<void>;
  /** All values or none: used when one install stores several inputs. */
  setMany(entries: Record<string, string>): Promise<void>;
  delete(id: string): Promise<void>;
  deleteMany(ids: string[]): Promise<void>;
}

/** A reference to a secret held outside the configuration file (see `config.ts`). */
export type SecretReference = { secret: string } | { env: string };

/** The value a reference points to, or `undefined` when it is not available. */
export async function resolveSecretReference(
  reference: SecretReference,
  store: SecretStore,
  env: Record<string, string | undefined> = process.env,
): Promise<string | undefined> {
  if ("secret" in reference) return store.get(reference.secret);
  const value = env[reference.env];
  return value ? value : undefined;
}

/** The id under which a binding's input is stored. Unique per binding, so never shared. */
export const secretId = (bindingId: string, kind: "env" | "header", name: string): string =>
  `mcp:${bindingId}:${kind}.${kind === "header" ? name.toLowerCase() : name}`;

/** In-memory adapter for tests and for hosts that must not touch the disk. */
export class MemorySecretStore implements SecretStore {
  readonly kind = "memory";
  private values = new Map<string, string>();
  async get(id: string) {
    return this.values.get(id);
  }
  async has(id: string) {
    return this.values.has(id);
  }
  async set(id: string, value: string) {
    this.values.set(id, value);
  }
  async setMany(entries: Record<string, string>) {
    for (const [id, value] of Object.entries(entries)) this.values.set(id, value);
  }
  async delete(id: string) {
    this.values.delete(id);
  }
  async deleteMany(ids: string[]) {
    for (const id of ids) this.values.delete(id);
  }
}

interface SecretFile {
  schemaVersion: 1;
  secrets: Record<string, string>;
}

const LOCK_WAIT_MS = 5_000;

/**
 * `<configHome>/mcp-secrets.json`, mode 0600, rewritten atomically (temporary file, fsync, rename)
 * under `mcp-secrets.json.lock` so concurrent writers never lose a value.
 */
export class FileSecretStore implements SecretStore {
  readonly kind = "file";
  readonly path: string;
  constructor(root: string = configHome()) {
    this.path = join(root, "mcp-secrets.json");
  }
  private async read(): Promise<SecretFile> {
    try {
      const parsed = JSON.parse(await readFile(this.path, "utf8")) as Partial<SecretFile>;
      const secrets =
        parsed.secrets && typeof parsed.secrets === "object" && !Array.isArray(parsed.secrets)
          ? (parsed.secrets as Record<string, string>)
          : {};
      return { schemaVersion: 1, secrets };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schemaVersion: 1, secrets: {} };
      throw error;
    }
  }
  private async write(file: SecretFile): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(file, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
    } catch (error) {
      await unlink(temporary).catch(() => {});
      throw error;
    }
  }
  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return withFileLock(`${this.path}.lock`, { waitMs: LOCK_WAIT_MS }, fn);
  }
  async get(id: string) {
    const value = (await this.read()).secrets[id];
    return typeof value === "string" ? value : undefined;
  }
  async has(id: string) {
    return typeof (await this.read()).secrets[id] === "string";
  }
  set(id: string, value: string) {
    return this.setMany({ [id]: value });
  }
  setMany(entries: Record<string, string>) {
    return this.locked(async () => {
      const file = await this.read();
      Object.assign(file.secrets, entries);
      await this.write(file);
    });
  }
  delete(id: string) {
    return this.deleteMany([id]);
  }
  deleteMany(ids: string[]) {
    return this.locked(async () => {
      const file = await this.read();
      let changed = false;
      for (const id of ids)
        if (id in file.secrets) {
          delete file.secrets[id];
          changed = true;
        }
      if (changed) await this.write(file);
    });
  }
}
