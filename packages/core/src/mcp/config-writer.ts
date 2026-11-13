/**
 * The one writer of MCP entries in Alisio configuration files (D16). It replaces the copy-pasted
 * "temporary file + rename" blocks for MCP changes with a single path that:
 *
 * - holds a per-file lock (`<file>.lock`) so concurrent writers never lose an entry;
 * - re-reads the file inside the lock and merges onto the latest content, so an external edit is
 *   never reverted; a caller that holds a revision gets `mcp_config_conflict` when it is stale;
 * - preserves every unrelated field and the canonical (`mcp.servers`) / alias (`mcpServers`) form
 *   an entry already uses;
 * - refuses to write a project file whose trust is not stored or one-run (`mcp_scope_untrusted`),
 *   and re-seals the stored trust (the sha256 of `.alisio/config.json`) in the same operation, so a
 *   trusted project does not turn into `needsPrompt` because Alisio itself changed its config.
 *
 * Callers never pass a file path from a client: the target is the global user config, the
 * workspace's own `.alisio/config.json` or an explicit layer file the host already chose.
 */
import { createHash } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import {
  configHome,
  isValidMcpServerName,
  type McpServerSource,
  parseMcpServerEntry,
} from "../config.ts";
import { FileLockTimeoutError, withFileLock } from "../providers/oauth/lock.ts";
import { getTrust, hashProjectConfig, setTrust } from "../trust.ts";

export type McpConfigErrorCode =
  | "mcp_config_conflict"
  | "mcp_scope_untrusted"
  | "mcp_config_invalid";

/** A refused MCP configuration change; `code` is a stable API error code (`ApiErrorCode`). */
export class McpConfigError extends Error {
  constructor(
    readonly code: McpConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "McpConfigError";
  }
}

export type McpConfigTarget =
  | { scope: "global" }
  | {
      scope: "project";
      workspace: string;
      /** The project is trusted for this run only (`--trust-project`): write without sealing. */
      sessionTrusted?: boolean;
    }
  | { scope: "file"; file: string };

export interface McpConfigWriteResult {
  file: string;
  /** Revision (sha256 of the content) before the write; `"absent"` when the file did not exist. */
  previousRevision: string;
  /** Revision after the write (equal to `previousRevision` when nothing changed). */
  revision: string;
  changed: boolean;
}

type Form = "canonical" | "alias";
const LOCK_WAIT_MS = 10_000;

export function mcpConfigFile(target: McpConfigTarget): string {
  switch (target.scope) {
    case "global":
      return join(configHome(), "config.json");
    case "project":
      return join(target.workspace, ".alisio", "config.json");
    case "file":
      return resolve(target.file);
  }
}

const revisionOf = (text: string | undefined): string =>
  text === undefined ? "absent" : createHash("sha256").update(text).digest("hex");

async function readText(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseObject(text: string | undefined): Record<string, unknown> {
  if (text === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpConfigError("mcp_config_invalid", "The configuration file is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
    throw new McpConfigError("mcp_config_invalid", "Alisio configuration must be a JSON object");
  return parsed as Record<string, unknown>;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

function containers(raw: Record<string, unknown>) {
  const canonical = isObject(raw.mcp) && isObject(raw.mcp.servers) ? raw.mcp.servers : undefined;
  const alias = isObject(raw.mcpServers) ? raw.mcpServers : undefined;
  return { canonical, alias };
}

/** The current revision of a target's file, for callers that want conflict detection. */
export async function readMcpConfigRevision(target: McpConfigTarget): Promise<string> {
  return revisionOf(await readText(mcpConfigFile(target)));
}

/** The raw `mcp.servers`/`mcpServers` entries of one file with the form each one uses. */
export async function readMcpServers(
  target: McpConfigTarget,
): Promise<Record<string, { raw: unknown; form: Form }>> {
  const raw = parseObject(await readText(mcpConfigFile(target)));
  const { canonical, alias } = containers(raw);
  return {
    ...Object.fromEntries(
      Object.entries(alias ?? {}).map(([n, v]) => [n, { raw: v, form: "alias" as const }]),
    ),
    ...Object.fromEntries(
      Object.entries(canonical ?? {}).map(([n, v]) => [n, { raw: v, form: "canonical" as const }]),
    ),
  };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

interface Edit {
  changed: boolean;
}

/**
 * Whether a project target may be written, and whether the stored trust must be re-sealed
 * afterwards. Throws `mcp_scope_untrusted` for a project whose trust is not stored (or whose stored
 * hash no longer matches) unless it is trusted for this run only.
 */
export async function assertProjectWritable(
  workspace: string,
  sessionTrusted = false,
): Promise<{ seal: boolean }> {
  const stored = await getTrust(workspace);
  const seal = !!stored?.trusted && stored.configHash === (await hashProjectConfig(workspace));
  if (!seal && !sessionTrusted)
    throw new McpConfigError(
      "mcp_scope_untrusted",
      "This project is not trusted: trust it before changing its MCP configuration",
    );
  return { seal };
}

async function mutate(
  target: McpConfigTarget,
  expectedRevision: string | undefined,
  edit: (raw: Record<string, unknown>) => Edit,
): Promise<McpConfigWriteResult> {
  const file = mcpConfigFile(target);
  try {
    return await withFileLock(`${file}.lock`, { waitMs: LOCK_WAIT_MS }, async () => {
      // Trust is decided before touching the file: a refused write leaves no trace.
      let seal = false;
      if (target.scope === "project")
        seal = (await assertProjectWritable(target.workspace, target.sessionTrusted)).seal;
      const text = await readText(file);
      const previousRevision = revisionOf(text);
      if (expectedRevision !== undefined && expectedRevision !== previousRevision)
        throw new McpConfigError(
          "mcp_config_conflict",
          "The configuration changed since it was read; reload it and try again",
        );
      const raw = parseObject(text);
      if (!edit(raw).changed)
        return { file, previousRevision, revision: previousRevision, changed: false };
      if (text === undefined) raw.schemaVersion ??= 1;
      const next = `${JSON.stringify(raw, null, 2)}\n`;
      await writeAtomic(file, next);
      if (seal && target.scope === "project")
        await setTrust(target.workspace, true, revisionOf(next));
      return { file, previousRevision, revision: revisionOf(next), changed: true };
    });
  } catch (error) {
    if (error instanceof FileLockTimeoutError)
      throw new McpConfigError(
        "mcp_config_conflict",
        "Another change to the MCP configuration is in progress; try again in a moment",
      );
    throw error;
  }
}

function assertServer(name: string, server: unknown): void {
  if (!isValidMcpServerName(name))
    throw new McpConfigError(
      "mcp_config_invalid",
      "The MCP name must start with a letter or digit and use only letters, digits, dots, dashes and underscores",
    );
  try {
    parseMcpServerEntry(server);
  } catch (error) {
    // Only field paths: the schema message can quote a value the caller supplied.
    const paths = (error as { issues?: Array<{ path: Array<string | number> }> }).issues?.map((i) =>
      i.path.join("."),
    );
    throw new McpConfigError(
      "mcp_config_invalid",
      `The MCP server definition is invalid${paths?.length ? ` (${[...new Set(paths)].join(", ")})` : ""}`,
    );
  }
}

/**
 * Adds or replaces one entry. An existing entry keeps its form (`mcp.servers` or `mcpServers`); a
 * new one goes to `mcp.servers`, unless the file only uses the alias form.
 */
export async function writeMcpServer(input: {
  target: McpConfigTarget;
  name: string;
  server: Record<string, unknown>;
  form?: Form;
  expectedRevision?: string;
  /** Refuse to replace an entry that already exists (`mcp_config_conflict`): used by installs. */
  create?: boolean;
}): Promise<McpConfigWriteResult> {
  assertServer(input.name, input.server);
  return mutate(input.target, input.expectedRevision, (raw) => {
    const { canonical, alias } = containers(raw);
    if (input.create && ((canonical && input.name in canonical) || (alias && input.name in alias)))
      throw new McpConfigError(
        "mcp_config_conflict",
        `An MCP server named "${input.name}" already exists in this configuration`,
      );
    if (canonical && alias && input.name in canonical && input.name in alias)
      throw new McpConfigError(
        "mcp_config_invalid",
        `MCP server "${input.name}" is defined in both mcp.servers and mcpServers`,
      );
    const form: Form =
      alias && input.name in alias
        ? "alias"
        : canonical && input.name in canonical
          ? "canonical"
          : (input.form ?? (alias && !canonical ? "alias" : "canonical"));
    if (form === "alias") {
      raw.mcpServers = { ...(alias ?? {}), [input.name]: input.server };
    } else {
      const mcp = isObject(raw.mcp) ? raw.mcp : {};
      raw.mcp = { ...mcp, servers: { ...(canonical ?? {}), [input.name]: input.server } };
    }
    return { changed: true };
  });
}

/** Removes one entry from whichever form holds it; a missing entry is a no-op, not an error. */
export function removeMcpServer(input: {
  target: McpConfigTarget;
  name: string;
  expectedRevision?: string;
}): Promise<McpConfigWriteResult & { removed: boolean }> {
  let removed = false;
  return mutate(input.target, input.expectedRevision, (raw) => {
    const { canonical, alias } = containers(raw);
    if (canonical && input.name in canonical) {
      const { [input.name]: _gone, ...rest } = canonical;
      raw.mcp = { ...(raw.mcp as Record<string, unknown>), servers: rest };
      removed = true;
    }
    if (alias && input.name in alias) {
      const { [input.name]: _gone, ...rest } = alias;
      raw.mcpServers = rest;
      removed = true;
    }
    return { changed: removed };
  }).then((result) => ({ ...result, removed }));
}

/**
 * Atomically toggles one MCP server in the form and file that defined it (legacy entry point of
 * the enable switch). Project entries need the workspace (derived from the file when omitted) so
 * trust is checked and re-sealed.
 */
export async function setMcpServerEnabled(input: {
  source: McpServerSource;
  name: string;
  enabled: boolean;
  workspace?: string;
  sessionTrusted?: boolean;
  expectedRevision?: string;
}): Promise<string> {
  if (!input.source.file) throw new Error("This MCP server is managed by its registering plugin");
  const file = input.source.file;
  const workspace =
    input.workspace ?? (basename(dirname(file)) === ".alisio" ? dirname(dirname(file)) : undefined);
  const target: McpConfigTarget =
    input.source.kind === "project" && workspace
      ? { scope: "project", workspace, sessionTrusted: input.sessionTrusted ?? false }
      : { scope: "file", file };
  const missing = `MCP server "${input.name}" is no longer present in its defining configuration`;
  await mutate(target, input.expectedRevision, (raw) => {
    const container = input.source.form === "alias" ? raw.mcpServers : containers(raw).canonical;
    if (!isObject(container)) throw new Error(missing);
    const current = container[input.name];
    if (!isObject(current)) throw new Error(missing);
    container[input.name] = { ...current, enabled: input.enabled };
    return { changed: true };
  });
  return file;
}
