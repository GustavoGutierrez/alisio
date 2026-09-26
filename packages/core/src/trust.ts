/**
 * One-time, per-directory project trust, replacing `--trust-project` for the common interactive
 * case. Trusting a workspace lets Alisio load `.alisio/config.json` (which can redirect the
 * provider endpoint/API key), `.alisio/plugins` (executable code), and project agents/skills/
 * prompts — exactly the same things `--trust-project`/`--config` already unlock for one run. This
 * module only decides and persists the yes/no; it never itself prompts (that is a CLI/TUI concern,
 * since only an interactive caller has someone to ask) and it never mutates policy.
 *
 * Never used for a `--trust-project`/`--config` invocation: that flag is already explicit, one-run
 * trust and must not be persisted as though it were an interactive grant.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { stateHome } from "./config.ts";

export interface TrustEntry {
  trusted: boolean;
  /** sha256 of `.alisio/config.json`'s content, or null when that file does not exist. */
  configHash: string | null;
  updatedAt: number;
}
interface TrustStoreFile {
  version: 1;
  entries: Record<string, TrustEntry>;
}
export interface TrustListing extends TrustEntry {
  workspace: string;
}
/** Resolving a workspace's trust, without ever prompting. */
export interface TrustResolution {
  /** Whether the workspace's project resources should currently load. */
  trusted: boolean;
  /** Whether there is anything here needing a trust decision in the first place. */
  hasProjectResources: boolean;
  /** True when the caller should ask (no stored decision, or the config changed since). */
  needsPrompt: boolean;
  configHash: string | null;
}

export function trustStorePath(): string {
  return join(stateHome(), "trust.json");
}
/** Project-level resources that today require `--trust-project`/`--config` to load. */
const PROJECT_RESOURCE_RELATIVE_PATHS = [
  ".alisio/config.json",
  ".alisio/plugins",
  ".alisio/agents",
  ".agents/agents",
  ".alisio/skills",
  ".alisio/prompts",
];
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
export async function hasProjectResources(workspace: string): Promise<boolean> {
  for (const relative of PROJECT_RESOURCE_RELATIVE_PATHS)
    if (await pathExists(join(workspace, relative))) return true;
  return false;
}
export async function hashProjectConfig(workspace: string): Promise<string | null> {
  try {
    const content = await readFile(join(workspace, ".alisio", "config.json"), "utf8");
    return createHash("sha256").update(content).digest("hex");
  } catch {
    return null;
  }
}
async function readStore(): Promise<TrustStoreFile> {
  try {
    const raw = JSON.parse(await readFile(trustStorePath(), "utf8"));
    if (raw && typeof raw === "object" && raw.entries && typeof raw.entries === "object")
      return { version: 1, entries: raw.entries };
  } catch {
    /* Missing or corrupt: start fresh rather than fail the whole CLI over a trust cache. */
  }
  return { version: 1, entries: {} };
}
async function writeStore(store: TrustStoreFile): Promise<void> {
  const path = trustStorePath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}
/** The raw stored decision for a workspace, or undefined when none exists yet. */
export async function getTrust(workspace: string): Promise<TrustEntry | undefined> {
  return (await readStore()).entries[workspace];
}
export async function setTrust(
  workspace: string,
  trusted: boolean,
  configHash: string | null,
): Promise<void> {
  const store = await readStore();
  store.entries[workspace] = { trusted, configHash, updatedAt: Date.now() };
  await writeStore(store);
}
/** Returns whether an entry actually existed to remove. */
export async function revokeTrust(workspace: string): Promise<boolean> {
  const store = await readStore();
  if (!(workspace in store.entries)) return false;
  delete store.entries[workspace];
  await writeStore(store);
  return true;
}
export async function listTrust(): Promise<TrustListing[]> {
  const store = await readStore();
  return Object.entries(store.entries)
    .map(([workspace, entry]) => ({ workspace, ...entry }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
/**
 * Read-only resolution: never prompts. `needsPrompt` tells an interactive caller it must ask
 * (nothing stored yet, or `.alisio/config.json` changed since the last decision — a changed file
 * is never trusted silently). A headless caller should treat `needsPrompt` the same as untrusted.
 */
export async function resolveTrust(workspace: string): Promise<TrustResolution> {
  const hasResources = await hasProjectResources(workspace);
  const configHash = await hashProjectConfig(workspace);
  if (!hasResources)
    return { trusted: false, hasProjectResources: false, needsPrompt: false, configHash };
  const stored = await getTrust(workspace);
  if (!stored || stored.configHash !== configHash)
    return { trusted: false, hasProjectResources: true, needsPrompt: true, configHash };
  return { trusted: stored.trusted, hasProjectResources: true, needsPrompt: false, configHash };
}
