/**
 * Ownership-safe cleanup of what the installer put on disk (specs/030 LIFE-02, LIFE-03, D10, and the
 * crash recovery of the risk table). Everything here only ever deletes paths under the managed
 * artifacts directory, only entries the installer recorded, and only after resolving symlinks:
 * when in doubt an artifact is kept. Rollback is idempotent so the same code undoes a failed job
 * and an interrupted one found after a restart.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import {
  McpConfigError,
  type McpConfigTarget,
  readMcpServers,
  removeMcpServer,
  writeMcpServer,
} from "../config-writer.ts";
import type { SecretStore } from "./secrets.ts";
import type { InstallStore, JobRecord } from "./store.ts";

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;

/** Deterministic id of an npm artifact: readable slug plus a hash of `name@version`. */
export function artifactIdFor(packageName: string, version: string): string {
  const slug =
    `${packageName.replace(/^@/, "").replace(/[^a-z0-9]+/gi, "-")}-${version.replace(/[^a-z0-9.-]+/gi, "-")}`
      .toLowerCase()
      .replace(/^-+|-+$/g, "")
      .slice(0, 60)
      .replace(/-+$/g, "");
  const hash = createHash("sha256")
    .update(`npm:${packageName}@${version}`)
    .digest("hex")
    .slice(0, 8);
  return `${slug || "pkg"}-${hash}`;
}

export const isManagedArtifactId = (id: string): boolean => SAFE_ID.test(id) && !id.startsWith(".");

export function artifactPath(root: string, id: string): string {
  return join(root, id);
}

/**
 * Deletes one managed artifact directory. Refuses (returns false, deletes nothing) when the id is
 * not an installer id, the path is a symlink, or its real path leaves the artifacts root.
 */
export async function removeArtifactDir(root: string, id: string): Promise<boolean> {
  if (!isManagedArtifactId(id)) return false;
  const path = artifactPath(root, id);
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    const [realRoot, realPath] = await Promise.all([realpath(root), realpath(path)]);
    const inside = relative(realRoot, realPath);
    if (!inside || inside.startsWith("..") || inside.includes(`..${sep}`)) return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  await rm(path, { recursive: true, force: true });
  return true;
}

/** Removes a temporary directory (`.tmp-*`) of this installer under `root`; never anything else. */
export async function removeTempDir(root: string, dir: string): Promise<void> {
  const inside = relative(root, dir);
  const name = inside.split(sep)[0] ?? "";
  if (!name.startsWith(".tmp-") || inside !== name) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

/**
 * Drops an artifact when no binding references it any more (reference counting, D10). Returns
 * what happened: the artifact stays when another binding still uses it or when its directory
 * could not be proven to belong to the installer.
 */
export async function releaseArtifact(
  store: InstallStore,
  root: string,
  artifactId: string | undefined,
): Promise<"none" | "kept" | "deleted" | "orphaned"> {
  if (!artifactId) return "none";
  if (store.references(artifactId) > 0) return "kept";
  if (!(await removeArtifactDir(root, artifactId))) return "orphaned";
  store.deleteArtifact(artifactId);
  return "deleted";
}

export const configTarget = (
  scope: "global" | "project",
  workspacePath: string | undefined,
  sessionTrusted = false,
): McpConfigTarget =>
  scope === "global"
    ? { scope: "global" }
    : {
        scope: "project",
        workspace: workspacePath as string,
        ...(sessionTrusted ? { sessionTrusted: true } : {}),
      };

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export interface RollbackHooks {
  detach?: (name: string) => Promise<void>;
  attach?: (
    name: string,
    entry: unknown,
    context: { scope: "global" | "project"; workspacePath?: string },
  ) => Promise<void>;
}

/**
 * Undoes whatever a job did: restores or removes its configuration entry (only when the entry is
 * exactly what the job wrote), drops its binding and secrets, and releases the artifact it
 * created. Safe to run twice and on a job that stopped at any step.
 */
export async function rollbackJob(
  deps: { store: InstallStore; secrets: SecretStore; artifactsRoot: string },
  job: JobRecord,
  hooks: RollbackHooks = {},
  sessionTrusted = false,
): Promise<void> {
  const { journal } = job;
  const config = journal.config;
  if (config) {
    const target = configTarget(config.scope, config.workspace, sessionTrusted);
    try {
      const current = (await readMcpServers(target))[config.alias]?.raw;
      // An entry identical to ours is only ours when this job's write is confirmed, or when no
      // binding claims the alias (an interruption between the write and the record): a concurrent
      // job that lost the race wrote nothing and must not remove the winner's identical entry.
      const ours =
        config.written || !deps.store.bindingByAlias(config.alias, config.scope, config.workspace);
      if (config.previousEntry !== undefined) {
        // An update: put the previous entry back unless someone changed it since.
        if (config.written && current !== undefined && sameJson(current, config.entry))
          await writeMcpServer({
            target,
            name: config.alias,
            server: config.previousEntry as Record<string, unknown>,
          });
        await hooks.attach?.(config.alias, config.previousEntry, {
          scope: config.scope,
          ...(config.workspace ? { workspacePath: config.workspace } : {}),
        });
      } else if (ours && current !== undefined && sameJson(current, config.entry)) {
        await removeMcpServer({ target, name: config.alias });
        await hooks.detach?.(config.alias);
      } else if (current === undefined) await hooks.detach?.(config.alias);
    } catch (error) {
      // An untrusted or unreadable project cannot be edited: leave the file alone, never force it.
      if (!(error instanceof McpConfigError) && (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
  if (journal.bindingId && job.kind === "install") {
    const binding = deps.store.binding(journal.bindingId);
    if (binding) deps.store.deleteBinding(binding.id);
  }
  if (journal.bindingId && job.kind === "update" && journal.previous) {
    const binding = deps.store.binding(journal.bindingId);
    if (binding)
      deps.store.putBinding(
        {
          ...binding,
          registryVersion: journal.previous.version,
          ...(journal.previous.artifactId ? { artifactId: journal.previous.artifactId } : {}),
          updatedAt: new Date().toISOString(),
        },
        { replace: true },
      );
  }
  if (journal.secretIds?.length) await deps.secrets.deleteMany(journal.secretIds).catch(() => {});
  if (journal.newArtifactId)
    await releaseArtifact(deps.store, deps.artifactsRoot, journal.newArtifactId);
  if (journal.tmpDir) await removeTempDir(deps.artifactsRoot, journal.tmpDir);
}

/** Directories under the artifacts root that are neither recorded nor a live job's temporary dir. */
export async function strayEntries(
  store: InstallStore,
  root: string,
  liveTemp: ReadonlySet<string>,
): Promise<{ orphans: string[]; temporary: string[] }> {
  const known = new Set(store.artifacts().map((a) => a.id));
  const orphans: string[] = [];
  const temporary: string[] = [];
  let names: string[] = [];
  try {
    names = await readdir(root);
  } catch {
    return { orphans, temporary };
  }
  for (const name of names) {
    if (name.startsWith(".tmp-")) {
      if (!liveTemp.has(join(root, name))) temporary.push(name);
    } else if (isManagedArtifactId(name) && !known.has(name)) orphans.push(name);
  }
  return { orphans, temporary };
}
