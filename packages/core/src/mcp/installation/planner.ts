/**
 * The install plan (specs/030 INST-01): a validated, NON-executable description of what an install
 * would do, built from the catalog entry (data, never commands) and the target. Nothing here
 * downloads, writes or starts anything. A plan has a digest over everything that matters, a ten
 * minute lifetime and the exact inputs the user still has to provide; the job re-validates it
 * (entry digest, configuration revision, alias) before it touches anything.
 */
import { createHash } from "node:crypto";
import { mcpIdentity } from "../alias.ts";
import type {
  CatalogEntry,
  CatalogInput,
  CatalogPackage,
  CatalogRemote,
} from "../catalog/source.ts";
import { assertProjectWritable, McpConfigError, type McpConfigTarget } from "../config-writer.ts";
import { type UrlGuard, UrlRejectedError } from "../net-guard.ts";
import { npmAvailable, type RuntimeEnvironment, resolveNodeRuntime } from "../runtime.ts";
import { isAsked, type PlanInput, toPlanInput } from "./entry.ts";
import { McpInstallError, type UnsupportedReason } from "./errors.ts";

export const PLAN_TTL_MS = 10 * 60_000;
const NPMJS = "https://registry.npmjs.org";
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const NPM_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

export interface PlanRequest {
  name: string;
  version?: string;
  scope: "global" | "project";
  /** The authorized workspace of the request; required for project scope. */
  workspace?: { path: string; sessionTrusted?: boolean };
  alias?: string;
  method?: "npm" | "remote";
  /** Which executable to use when the package declares several (advanced option). */
  bin?: string;
  runtimePermission: "granted" | "not-granted" | "read-only";
}

export interface InstallPlan {
  planId: string;
  digest: string;
  expiresAt: string;
  kind: "install" | "update";
  alias: string;
  scope: "global" | "project";
  registryName: string;
  registryVersion: string;
  title?: string;
  method: "npm" | "remote";
  execution: "local" | "remote";
  package?: { identifier: string; version: string };
  /** Scheme and host of a remote service (a path or query may carry a token). */
  origin?: string;
  requiredInputs: PlanInput[];
  /** Inputs with a safe default or optional: collapsed in the form, never required. */
  optionalInputs: PlanInput[];
  prerequisites: { runtime: "system" | "bundled"; npm: boolean };
  /** Running the server needs the existing MCP consent, which is not granted yet. */
  requiresConsent: boolean;
  /** Update plans: the binding being updated and the version it has now. */
  bindingId?: string;
  fromVersion?: string;
}

/** What the job needs; never leaves the server. */
export interface StoredPlan {
  plan: InstallPlan;
  entryDigest: string;
  sourceId: string;
  workspacePath?: string;
  sessionTrusted: boolean;
  /** Revision of the target configuration file when the plan was made. */
  targetRevision: string;
  package?: { identifier: string; version: string; args: string[]; inputs: CatalogInput[] };
  remote?: { url: string; inputs: CatalogInput[] };
  bin?: string;
  expiresAtMs: number;
}

export interface PlannerDeps {
  entries: { entry(name: string, version?: string): CatalogEntry | undefined };
  guard: UrlGuard;
  runtime: RuntimeEnvironment;
  now: () => Date;
  ttlMs?: number;
  /** Names already used by the configuration the new entry would join. */
  takenAliases(scope: "global" | "project", workspacePath?: string): Promise<Set<string>>;
  configRevision(target: McpConfigTarget): Promise<string>;
}

const unsupported = (reason: UnsupportedReason, message: string) =>
  new McpInstallError("mcp_method_unsupported", message, { reason });

/** Structured arguments of a package, or `undefined` when one cannot be filled in automatically. */
function argsOf(pkg: CatalogPackage): string[] | undefined {
  const out: string[] = [];
  for (const arg of pkg.args) {
    const value = arg.value;
    if (value !== undefined && value.includes("{")) {
      if (arg.isRequired) return undefined;
      continue;
    }
    if (arg.type === "named") {
      if (!arg.name || (value === undefined && arg.isRequired)) return undefined;
      if (value === undefined) continue;
      out.push(arg.name, value);
    } else {
      if (value === undefined) {
        if (arg.isRequired) return undefined;
        continue;
      }
      out.push(value);
    }
  }
  return out;
}

interface Eligible {
  npm?: { pkg: CatalogPackage; args: string[] };
  remote?: CatalogRemote;
  reasons: UnsupportedReason[];
}

function analyze(entry: CatalogEntry): Eligible {
  const reasons: UnsupportedReason[] = [];
  let npm: Eligible["npm"];
  for (const pkg of entry.packages) {
    if (pkg.method !== "npm") {
      reasons.push(
        pkg.method === "pypi"
          ? "pypi"
          : pkg.method === "oci"
            ? "oci"
            : pkg.method === "mcpb"
              ? "mcpb"
              : "other_method",
      );
      continue;
    }
    if (pkg.transport !== "stdio") {
      reasons.push("other_method");
      continue;
    }
    if (!pkg.version || !EXACT_VERSION.test(pkg.version) || !NPM_NAME.test(pkg.identifier)) {
      reasons.push("unversioned");
      continue;
    }
    if (pkg.registryBaseUrl && pkg.registryBaseUrl.replace(/\/+$/, "") !== NPMJS) {
      reasons.push("registry");
      continue;
    }
    const args = argsOf(pkg);
    if (!args) {
      reasons.push("requires_arguments");
      continue;
    }
    npm ??= { pkg, args };
  }
  let remote: CatalogRemote | undefined;
  for (const candidate of entry.remotes) {
    if (candidate.transport === "streamable-http") remote ??= candidate;
    else reasons.push(candidate.transport === "sse" ? "sse" : "other_method");
  }
  return { ...(npm ? { npm } : {}), ...(remote ? { remote } : {}), reasons };
}

const REASON_ORDER: UnsupportedReason[] = [
  "unversioned",
  "registry",
  "requires_arguments",
  "sse",
  "pypi",
  "oci",
  "mcpb",
  "other_method",
];
const REASON_TEXT: Record<string, string> = {
  unversioned: "This package does not pin an exact version, so Alisio will not install it",
  registry: "This package comes from a registry other than npm, which is not supported yet",
  requires_arguments:
    "This server needs command-line arguments that cannot be filled in automatically",
  sse: "This service uses the legacy SSE transport, which is not supported yet",
  pypi: "Python (PyPI) servers cannot be installed automatically yet",
  oci: "Container (OCI) servers cannot be installed automatically yet",
  mcpb: "MCPB bundles cannot be installed automatically yet",
  other_method: "This installation method is not supported yet",
  no_method: "This entry has no package or remote service to install",
};

const digestOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function planTarget(request: Pick<PlanRequest, "scope" | "workspace">): McpConfigTarget {
  if (request.scope === "global") return { scope: "global" };
  if (!request.workspace)
    throw new McpInstallError("validation_failed", "A project install needs a workspace", {
      fields: ["workspace"],
    });
  return {
    scope: "project",
    workspace: request.workspace.path,
    ...(request.workspace.sessionTrusted ? { sessionTrusted: true } : {}),
  };
}

export async function buildPlan(
  deps: PlannerDeps,
  request: PlanRequest,
  update?: { bindingId: string; alias: string; fromVersion: string },
): Promise<StoredPlan> {
  const entry = deps.entries.entry(request.name, request.version);
  if (!entry) throw new McpInstallError("not_found", "MCP catalog entry not found");
  if (entry.status === "deprecated" || entry.status === "deleted")
    throw unsupported(
      entry.status,
      entry.status === "deprecated"
        ? "Its publisher marked this server as deprecated: it cannot be installed"
        : "Its publisher removed this server: it cannot be installed",
    );
  if (request.runtimePermission === "read-only")
    throw new McpInstallError("mcp_not_permitted", "MCP changes are unavailable under --read-only");
  const eligible = analyze(entry);
  const wanted = request.method ?? (eligible.npm ? "npm" : "remote");
  if (wanted === "npm" ? !eligible.npm : !eligible.remote) {
    const reason = REASON_ORDER.find((r) => eligible.reasons.includes(r)) ?? "no_method";
    throw unsupported(reason, REASON_TEXT[reason] as string);
  }
  const target = planTarget(request);
  if (target.scope === "project")
    await assertProjectWritable(target.workspace, target.sessionTrusted).catch((error) => {
      if (error instanceof McpConfigError)
        throw new McpInstallError(error.code as "mcp_scope_untrusted", error.message);
      throw error;
    });
  const workspacePath = request.workspace?.path;
  let alias: string;
  if (update) alias = update.alias;
  else {
    try {
      alias = mcpIdentity(entry.name, {
        ...(entry.title ? { title: entry.title } : {}),
        ...(request.alias ? { alias: request.alias } : {}),
        taken: await deps.takenAliases(request.scope, workspacePath),
      }).alias;
    } catch (error) {
      throw new McpInstallError("validation_failed", (error as Error).message, {
        fields: ["alias"],
      });
    }
  }
  const runtime = resolveNodeRuntime(deps.runtime);
  const hasNpm = npmAvailable(deps.runtime);
  let inputs: CatalogInput[];
  let method: "npm" | "remote";
  let packageInfo: StoredPlan["package"];
  let remoteInfo: StoredPlan["remote"];
  let origin: string | undefined;
  if (wanted === "npm") {
    const npm = eligible.npm as NonNullable<Eligible["npm"]>;
    if (!hasNpm)
      throw new McpInstallError(
        "mcp_runtime_missing",
        "Alisio needs Node.js (npm) to install this server: install Node.js, or use the desktop app, which includes it",
        { reason: "npm_missing" },
      );
    method = "npm";
    inputs = npm.pkg.inputs.filter((i) => i.kind === "env");
    packageInfo = {
      identifier: npm.pkg.identifier,
      version: npm.pkg.version as string,
      args: npm.args,
      inputs,
    };
  } else {
    const remote = eligible.remote as CatalogRemote;
    method = "remote";
    inputs = remote.inputs;
    if (inputs.some((i) => i.kind === "variable" && i.isSecret))
      throw unsupported(
        "other_method",
        "This service asks for a secret inside its address, which is not supported",
      );
    if (!/\{[^}]+\}/.test(remote.url)) {
      try {
        origin = (await deps.guard.check(remote.url)).origin;
      } catch (error) {
        if (error instanceof UrlRejectedError)
          throw unsupported("unsafe_address", `The service address was refused: ${error.message}`);
        throw error;
      }
    } else {
      try {
        origin = new URL(remote.url.replace(/\{[^}]+\}/g, "placeholder")).origin;
      } catch {
        throw unsupported("unsafe_address", "The service address is not valid");
      }
    }
    remoteInfo = { url: remote.url, inputs };
  }
  const requiredInputs = inputs.filter(isAsked).map(toPlanInput);
  const optionalInputs = inputs
    .filter((i) => !isAsked(i) && !(i.value !== undefined && !i.isSecret))
    .map(toPlanInput);
  const requiresConsent = request.runtimePermission !== "granted";
  const targetRevision = await deps.configRevision(target);
  const now = deps.now();
  const core = {
    kind: update ? ("update" as const) : ("install" as const),
    alias,
    scope: request.scope,
    registryName: entry.name,
    registryVersion: entry.version,
    method,
    ...(packageInfo
      ? { package: { identifier: packageInfo.identifier, version: packageInfo.version } }
      : {}),
    ...(origin ? { origin } : {}),
    ...(update ? { bindingId: update.bindingId, fromVersion: update.fromVersion } : {}),
  };
  const digest = digestOf({
    ...core,
    entryDigest: entry.provenance.rawDigest,
    workspacePath: workspacePath ?? null,
    targetRevision,
    inputs: inputs.map((i) => `${i.kind}.${i.name}`),
    args: packageInfo?.args ?? [],
    bin: request.bin ?? null,
  });
  const plan: InstallPlan = {
    planId: `plan_${crypto.randomUUID()}`,
    digest,
    expiresAt: new Date(now.getTime() + (deps.ttlMs ?? PLAN_TTL_MS)).toISOString(),
    ...core,
    ...(entry.title ? { title: entry.title } : {}),
    execution: method === "npm" ? "local" : "remote",
    requiredInputs,
    optionalInputs,
    prerequisites: { runtime: runtime.kind, npm: hasNpm },
    requiresConsent,
  };
  return {
    plan,
    entryDigest: entry.provenance.rawDigest,
    sourceId: entry.sourceId,
    ...(workspacePath ? { workspacePath } : {}),
    sessionTrusted: !!request.workspace?.sessionTrusted,
    targetRevision,
    ...(packageInfo ? { package: packageInfo } : {}),
    ...(remoteInfo ? { remote: remoteInfo } : {}),
    ...(request.bin ? { bin: request.bin } : {}),
    expiresAtMs: now.getTime() + (deps.ttlMs ?? PLAN_TTL_MS),
  };
}

/** Plans held in memory until they expire or are used (they never contain an answer). */
export class PlanStore {
  private plans = new Map<string, StoredPlan>();
  constructor(private max = 200) {}
  put(plan: StoredPlan, now: Date): void {
    for (const [id, stored] of this.plans)
      if (stored.expiresAtMs <= now.getTime()) this.plans.delete(id);
    while (this.plans.size >= this.max) {
      const oldest = this.plans.keys().next().value;
      if (oldest === undefined) break;
      this.plans.delete(oldest);
    }
    this.plans.set(plan.plan.planId, plan);
  }
  take(planId: string, digest: string, now: Date): StoredPlan {
    const stored = this.plans.get(planId);
    if (!stored) throw new McpInstallError("not_found", "The install plan was not found");
    if (stored.expiresAtMs <= now.getTime()) {
      this.plans.delete(planId);
      throw new McpInstallError("mcp_plan_expired", "The install plan expired: review it again");
    }
    if (stored.plan.digest !== digest)
      throw new McpInstallError("validation_failed", "The install plan does not match", {
        fields: ["digest"],
      });
    return stored;
  }
  drop(planId: string): void {
    this.plans.delete(planId);
  }
}
