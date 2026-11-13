/**
 * Editing an installed integration (specs/030 §12.1 "Configurar", MCP-CAT-19/24): a typed form of
 * the fields the catalog card asked for, the current PUBLIC values, and a save that validates every
 * answer on the server, keeps what was left empty, replaces a key without ever returning it and
 * writes the entry under the revision the form was read from (a change made meanwhile is a
 * conflict, never overwritten). Secrets stay behind the `SecretStore` port: the form only says
 * whether one is saved.
 */
import type { CatalogEntry, CatalogInput } from "../catalog/source.ts";
import { readMcpConfigRevision, readMcpServers, writeMcpServer } from "../config-writer.ts";
import { headerValue, inputId, type PlanInput, toPlanInput, validateAnswer } from "./entry.ts";
import { McpInstallError } from "./errors.ts";
import { configTarget } from "./lifecycle.ts";
import { type SecretStore, secretId } from "./secrets.ts";
import type { BindingRecord } from "./store.ts";

export interface ConfigurationField {
  id: string;
  kind: "env" | "header";
  name: string;
  description?: string;
  secret: boolean;
  required: boolean;
  format?: string;
  choices?: string[];
  value?: string;
  configured: boolean;
}

export interface BindingConfiguration {
  bindingId: string;
  alias: string;
  scope: "global" | "project";
  revision: string;
  fields: ConfigurationField[];
}

export interface ConfigurationPatch {
  /** The revision the form was read from. */
  revision: string;
  /** Field id → new value. An empty string means "keep" for a secret and "remove" for an optional field. */
  values: Record<string, string>;
  /** Field ids to remove outright (optional fields and saved keys). */
  clear?: string[];
}

export interface ConfigurationDeps {
  secrets: SecretStore;
  entries: { entry(name: string, version?: string): CatalogEntry | undefined };
  binding(id: string): BindingRecord | undefined;
  /** Serializes the write with every other write to the same file. */
  locked<T>(key: string, fn: () => Promise<T>): Promise<T>;
  saveBinding(binding: BindingRecord): void;
  bumpCredentialRevision(id: string): void;
}

export interface ConfigurationContext {
  workspacePath?: string;
  sessionTrusted?: boolean;
}

interface RawEntry {
  env?: Record<string, string>;
  secretEnv?: Record<string, { secret?: string }>;
  headers?: Record<string, { secret?: string }>;
  [key: string]: unknown;
}

/** The inputs a binding's card asks for, or those implied by its saved entry when the card is gone. */
function inputsOf(
  binding: BindingRecord,
  entry: CatalogEntry | undefined,
  raw: RawEntry,
): CatalogInput[] {
  const fromCard: CatalogInput[] | undefined = entry
    ? binding.method === "npm"
      ? entry.packages.find((p) => p.method === "npm")?.inputs
      : entry.remotes[0]?.inputs
    : undefined;
  if (fromCard)
    return fromCard.filter((input) => input.kind === (binding.method === "npm" ? "env" : "header"));
  return [
    ...Object.keys(raw.env ?? {}).map((name) => ({
      name,
      kind: "env" as const,
      isRequired: false,
      isSecret: false,
    })),
    ...Object.keys(raw.secretEnv ?? {}).map((name) => ({
      name,
      kind: "env" as const,
      isRequired: false,
      isSecret: true,
    })),
    ...Object.keys(raw.headers ?? {}).map((name) => ({
      name,
      kind: "header" as const,
      isRequired: false,
      isSecret: true,
    })),
  ];
}

const secretRef = (raw: RawEntry, input: Pick<CatalogInput, "kind" | "name">) =>
  (input.kind === "env" ? raw.secretEnv?.[input.name] : raw.headers?.[input.name])?.secret;

async function load(deps: ConfigurationDeps, bindingId: string, context: ConfigurationContext) {
  const binding = deps.binding(bindingId);
  if (!binding) throw new McpInstallError("not_found", "MCP binding not found");
  if (binding.scope === "project" && binding.workspacePath !== context.workspacePath)
    throw new McpInstallError("not_found", "MCP binding not found");
  const target = configTarget(binding.scope, binding.workspacePath, context.sessionTrusted);
  const [revision, servers] = await Promise.all([
    readMcpConfigRevision(target),
    readMcpServers(target),
  ]);
  const found = servers[binding.alias];
  if (!found) throw new McpInstallError("not_found", "MCP binding not found");
  const raw = found.raw as RawEntry;
  const inputs = inputsOf(
    binding,
    deps.entries.entry(binding.registryName, binding.registryVersion),
    raw,
  );
  return { binding, target, revision, raw, form: found.form, inputs };
}

export async function readConfiguration(
  deps: ConfigurationDeps,
  bindingId: string,
  context: ConfigurationContext,
): Promise<BindingConfiguration> {
  const { binding, revision, raw, inputs } = await load(deps, bindingId, context);
  const fields: ConfigurationField[] = [];
  for (const input of inputs) {
    const secret = input.isSecret || input.kind === "header";
    const reference = secretRef(raw, input);
    const configured = secret
      ? !!reference && (await deps.secrets.has(reference))
      : raw.env?.[input.name] !== undefined;
    fields.push({
      id: inputId(input),
      kind: input.kind as "env" | "header",
      name: input.name,
      ...(input.description ? { description: input.description } : {}),
      secret,
      required: input.isRequired,
      ...(input.format ? { format: input.format } : {}),
      ...(input.choices?.length ? { choices: input.choices } : {}),
      ...(!secret && raw.env?.[input.name] !== undefined
        ? { value: raw.env[input.name] as string }
        : {}),
      configured,
    });
  }
  return { bindingId: binding.id, alias: binding.alias, scope: binding.scope, revision, fields };
}

export interface ConfigurationSaved {
  configuration: BindingConfiguration;
  /** The entry now in the configuration file, to attach to the live connector. */
  entry: Record<string, unknown>;
  form: "canonical" | "alias";
  credentialsChanged: boolean;
}

export async function saveConfiguration(
  deps: ConfigurationDeps,
  bindingId: string,
  patch: ConfigurationPatch,
  context: ConfigurationContext,
): Promise<ConfigurationSaved> {
  const loaded = await load(deps, bindingId, context);
  const { binding, target, raw, inputs } = loaded;
  const byId = new Map(inputs.map((input) => [inputId(input), input]));
  const clear = new Set(patch.clear ?? []);
  const problems = new Set<string>();
  for (const id of [...Object.keys(patch.values), ...clear]) if (!byId.has(id)) problems.add(id);

  const env = { ...(raw.env ?? {}) };
  const secretEnv = { ...(raw.secretEnv ?? {}) };
  const headers = { ...(raw.headers ?? {}) };
  const newSecrets: Record<string, string> = {};
  const removeSecretIds: string[] = [];
  const touched = new Set<string>();

  for (const input of inputs) {
    const id = inputId(input);
    const planInput: PlanInput = toPlanInput(input);
    const secret = input.isSecret || input.kind === "header";
    const wantsClear = clear.has(id);
    const value = patch.values[id];
    if (wantsClear) {
      if (input.isRequired) problems.add(id);
      else if (secret) {
        const ref = secretRef(raw, input);
        if (ref) removeSecretIds.push(ref);
        if (input.kind === "env") delete secretEnv[input.name];
        else delete headers[input.name];
        touched.add(id);
      } else {
        delete env[input.name];
        touched.add(id);
      }
      continue;
    }
    if (value === undefined) continue;
    if (value === "") {
      // Empty keeps a secret; for a plain field it removes an optional value and is an error otherwise.
      if (secret) continue;
      if (input.isRequired) problems.add(id);
      else {
        delete env[input.name];
        touched.add(id);
      }
      continue;
    }
    const message = validateAnswer(planInput, value);
    if (message) {
      problems.add(id);
      continue;
    }
    if (secret) {
      const ref =
        secretRef(raw, input) ?? secretId(binding.id, input.kind as "env" | "header", input.name);
      newSecrets[ref] = input.kind === "header" ? headerValue(input.name, value) : value;
      if (input.kind === "env") secretEnv[input.name] = { secret: ref };
      else headers[input.name] = { secret: ref };
    } else env[input.name] = value;
    touched.add(id);
  }
  if (problems.size)
    throw new McpInstallError("mcp_input_required", "Some information is missing or not valid", {
      fields: [...problems].sort(),
    });

  const entry: Record<string, unknown> = { ...raw };
  const assign = (key: "env" | "secretEnv" | "headers", value: Record<string, unknown>) => {
    if (Object.keys(value).length) entry[key] = value;
    else delete entry[key];
  };
  assign("env", env);
  assign("secretEnv", secretEnv);
  assign("headers", headers);

  const credentialsChanged = Object.keys(newSecrets).length > 0 || removeSecretIds.length > 0;
  await deps.locked(`config:${binding.scope}:${binding.workspacePath ?? ""}`, async () => {
    // Secrets first (all or none); if the write is refused, the previous values come back.
    const previous = new Map<string, string | undefined>();
    for (const id of Object.keys(newSecrets)) previous.set(id, await deps.secrets.get(id));
    if (Object.keys(newSecrets).length) await deps.secrets.setMany(newSecrets);
    try {
      await writeMcpServer({
        target,
        name: binding.alias,
        server: entry,
        form: loaded.form,
        expectedRevision: patch.revision,
      });
    } catch (error) {
      for (const [id, old] of previous)
        if (old === undefined) await deps.secrets.delete(id).catch(() => {});
        else await deps.secrets.set(id, old).catch(() => {});
      throw error;
    }
    if (removeSecretIds.length) await deps.secrets.deleteMany(removeSecretIds).catch(() => {});
  });
  const known = new Set(binding.secretIds);
  const added = Object.keys(newSecrets).filter((id) => !known.has(id));
  if (added.length)
    deps.saveBinding({
      ...binding,
      secretIds: [...binding.secretIds, ...added],
      updatedAt: new Date().toISOString(),
    });
  if (credentialsChanged) deps.bumpCredentialRevision(binding.id);
  return {
    configuration: await readConfiguration(deps, bindingId, context),
    entry,
    form: loaded.form,
    credentialsChanged,
  };
}
