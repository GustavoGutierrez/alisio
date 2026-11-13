/**
 * Pure model of installing and managing MCP servers from Settings (specs/030 phase 3): the default
 * scope, form validation that mirrors the server's rules (the server always validates again), the
 * answers and the secret-free draft, job progress and outcome, the two badge dimensions of D13 and
 * the scope-aware removal. No DOM and no store: tested in `tests/web-mcp-install.test.ts`.
 */
import type { McpInstallInputInfo, McpInstallJob, McpServerWire } from "@alisio/sdk";
import type { InstallStringKey } from "./strings.ts";

export type Scope = "global" | "project";
export type Execution = "local" | "remote";

export const defaultScope = (hasWorkspace: boolean): Scope => (hasWorkspace ? "project" : "global");

export interface ScopeOption {
  id: Scope;
  labelKey: InstallStringKey;
  hintKey: InstallStringKey;
  params?: { name: string };
}

/** «Solo este proyecto» first (preselected, D4) and «Todos mis proyectos»; only global without one. */
export function scopeOptions(workspaceName: string | undefined): ScopeOption[] {
  const global: ScopeOption = {
    id: "global",
    labelKey: "scope.global",
    hintKey: "scope.hintGlobal",
  };
  return workspaceName
    ? [
        {
          id: "project",
          labelKey: "scope.project",
          hintKey: "scope.hintProject",
          params: { name: workspaceName },
        },
        global,
      ]
    : [global];
}

export const actionKey = (execution: Execution | string): InstallStringKey =>
  execution === "remote" ? "action.connect" : "action.install";
export const submitKey = (execution: Execution | string): InstallStringKey =>
  execution === "remote" ? "form.submitConnect" : "form.submitInstall";

// ---- form ----------------------------------------------------------------------------------

const CONTROL = /[\u0000-\u001f\u007f]/;
const MAX_VALUE = 4096;
const MAX_SECRET = 8192;

export type FieldErrorKey =
  | "err.required"
  | "err.choice"
  | "err.number"
  | "err.boolean"
  | "err.control"
  | "err.spaces"
  | "err.long";

/** The first problem with one value, or `undefined`. Same rules as the server; never shows a value. */
export function fieldIssue(field: McpInstallInputInfo, value: string): FieldErrorKey | undefined {
  if (value.length === 0) return field.required ? "err.required" : undefined;
  if (value.length > (field.secret ? MAX_SECRET : MAX_VALUE)) return "err.long";
  if (CONTROL.test(value)) return "err.control";
  if (field.secret && value !== value.trim()) return "err.spaces";
  if (field.choices?.length && !field.choices.includes(value)) return "err.choice";
  const format = field.format?.toLowerCase();
  if (format === "number" && !Number.isFinite(Number(value))) return "err.number";
  if (format === "boolean" && value !== "true" && value !== "false") return "err.boolean";
  return undefined;
}

/** Non-secret values are trimmed (accidental spaces); a secret is never altered silently. */
const clean = (field: McpInstallInputInfo, value: string): string =>
  field.secret ? value : value.trim();

export interface ValidationResult {
  errors: Array<{ id: string; key: FieldErrorKey }>;
  /** The first field with an error, to move focus to it. */
  first?: string;
}

export function validateInputs(
  fields: McpInstallInputInfo[],
  values: Record<string, string>,
): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  for (const field of fields) {
    const key = fieldIssue(field, clean(field, values[field.id] ?? ""));
    if (key) errors.push({ id: field.id, key });
  }
  return { errors, ...(errors[0] ? { first: errors[0].id } : {}) };
}

/** What is sent: non-empty answers only, cleaned as above. */
export function answersOf(
  fields: McpInstallInputInfo[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields) {
    const value = clean(field, values[field.id] ?? "");
    if (value !== "") out[field.id] = value;
  }
  return out;
}

/** What survives a cancelled or failed attempt: never a secret. */
export function draftOf(
  fields: McpInstallInputInfo[],
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of fields)
    if (!field.secret && values[field.id]) out[field.id] = values[field.id] as string;
  return out;
}

// ---- unsupported methods and errors --------------------------------------------------------

const UNSUPPORTED = new Set([
  "pypi",
  "oci",
  "mcpb",
  "sse",
  "unversioned",
  "registry",
  "lifecycle_scripts",
  "bin_ambiguous",
  "no_bin",
  "requires_arguments",
  "unsafe_address",
  "deprecated",
  "deleted",
  "npm_missing",
  "no_method",
]);

/** The honest "not supported yet" text for a reason code (with manual guidance where it exists). */
export const unsupportedKey = (reason: string | undefined): InstallStringKey =>
  reason && UNSUPPORTED.has(reason)
    ? (`unsupported.${reason}` as InstallStringKey)
    : "unsupported.other";

export type NextAction = "retry" | "replan" | "choose-global" | "recheck" | "manual" | "none";

/** A plain cause and the next action for an API error code (UX-08). */
export function errorGuidance(
  code: string,
  reason?: string,
): { textKey: InstallStringKey; action: NextAction } {
  switch (code) {
    case "mcp_scope_untrusted":
      return { textKey: "error.untrusted", action: "choose-global" };
    case "mcp_config_conflict":
      return { textKey: "error.conflict", action: "replan" };
    case "mcp_plan_expired":
      return { textKey: "error.expired", action: "replan" };
    case "mcp_runtime_missing":
      return { textKey: "error.runtime", action: "recheck" };
    case "mcp_method_unsupported":
      return { textKey: unsupportedKey(reason), action: "manual" };
    case "mcp_not_permitted":
      return { textKey: "error.readOnly", action: "none" };
    case "not_found":
      return { textKey: "error.notFound", action: "none" };
    case "mcp_input_required":
    case "validation_failed":
      return { textKey: "error.input", action: "retry" };
    case "mcp_install_failed":
    case "internal":
      return { textKey: "error.failed", action: "retry" };
    default:
      return { textKey: "error.generic", action: "retry" };
  }
}

// ---- job -----------------------------------------------------------------------------------

export type StepId = "prepare" | "configure" | "connect";

export function jobSteps(
  job: Pick<McpInstallJob, "state">,
): Array<{ id: StepId; state: "done" | "active" | "pending" }> {
  const order: StepId[] = ["prepare", "configure", "connect"];
  const active: StepId | undefined =
    job.state === "installing" || job.state === "planned" || job.state === "awaiting-consent"
      ? "prepare"
      : job.state === "configuring"
        ? "configure"
        : job.state === "connecting"
          ? "connect"
          : undefined;
  const finished = job.state === "completed";
  return order.map((id, index) => ({
    id,
    state: finished
      ? "done"
      : active === undefined
        ? "pending"
        : index < order.indexOf(active)
          ? "done"
          : id === active
            ? "active"
            : "pending",
  }));
}

export type JobAction = "cancel" | "close" | "retry" | "test" | "sign-in";
export interface Outcome {
  kind:
    | "waiting-consent"
    | "running"
    | "connected"
    | "needs-attention"
    | "sign-in"
    | "failed"
    | "cancelled";
  actions: JobAction[];
}

export function jobOutcome(job: McpInstallJob): Outcome {
  switch (job.state) {
    case "awaiting-consent":
      return { kind: "waiting-consent", actions: ["cancel"] };
    case "completed":
      if (job.result?.connected) return { kind: "connected", actions: ["close"] };
      if (job.result?.signIn === "available")
        return { kind: "sign-in", actions: ["sign-in", "close"] };
      return { kind: "needs-attention", actions: ["test", "close"] };
    case "failed":
      return { kind: "failed", actions: ["retry", "close"] };
    case "cancelled":
      return { kind: "cancelled", actions: ["close"] };
    default:
      return { kind: "running", actions: ["cancel"] };
  }
}

// ---- badges and removal (D13, UX-02, UX-09) ---------------------------------------------------

export interface Badges {
  execution: { key: InstallStringKey; icon: "computer" | "cloud" };
  scope: { key: InstallStringKey; params?: { name: string } };
  install: InstallStringKey;
  test: InstallStringKey;
  /** When the last test ran (ISO), if any. */
  testedAt?: string;
}

export function badgesOf(
  server: McpServerWire,
  workspaceName: string,
  options: { serverHost?: boolean } = {},
): Badges {
  const execution: Execution =
    server.binding?.execution ??
    server.execution ??
    (server.transport === "http" ? "remote" : "local");
  const scopeKind = server.binding?.scope ?? (server.source === "project" ? "project" : "global");
  const test = server.binding?.lastTest;
  return {
    execution:
      execution === "remote"
        ? { key: "badge.remote", icon: "cloud" }
        : {
            // A web or headless server runs the program on ITS computer, not the browser's (UX-02).
            key: options.serverHost ? "badge.localServer" : "badge.local",
            icon: "computer",
          },
    scope:
      scopeKind === "project"
        ? { key: "badge.scopeProject", params: { name: workspaceName } }
        : { key: "badge.scopeGlobal" },
    install:
      server.status === "connected"
        ? "state.connected"
        : server.status === "needs-authentication" && server.auth
          ? "state.signInNeeded"
          : server.status === "failed" || server.status === "needs-authentication"
            ? "state.pending"
            : "state.installed",
    test: !test
      ? "test.unchecked"
      : test.stale
        ? "test.stale"
        : test.status === "passed" && server.status === "connected"
          ? "test.ready"
          : "test.attention",
    ...(test ? { testedAt: test.at } : {}),
  };
}

export interface Removal {
  scope: Scope;
  bindingId: string;
  titleKey: InstallStringKey;
  bodyKey: InstallStringKey;
  params: { name: string };
  confirmKey: InstallStringKey;
  buttonKey: InstallStringKey;
  /** The integration has saved keys: offer deleting them (a separate, explicit choice). */
  secretsOption: boolean;
  revealsGlobal: boolean;
  remote: boolean;
}

/** What removing this server does, in its own scope; `undefined` when the installer does not own it. */
export function removalOf(server: McpServerWire, workspaceName: string): Removal | undefined {
  const binding = server.binding;
  if (!binding) return undefined;
  const remote = binding.execution === "remote";
  const label = server.displayName;
  return {
    scope: binding.scope,
    bindingId: binding.id,
    titleKey: remote ? "remove.titleDisconnect" : "remove.title",
    bodyKey: binding.scope === "global" ? "remove.bodyGlobal" : "remove.bodyProject",
    params: { name: binding.scope === "project" ? workspaceName : label },
    confirmKey: remote ? "remove.confirmDisconnect" : "remove.confirm",
    buttonKey: remote ? "remove.buttonDisconnect" : "remove.button",
    secretsOption: binding.hasSavedKeys,
    revealsGlobal: !!binding.revealsGlobal,
    remote,
  };
}

/** The reason code behind a blocked catalog item, for its manual-setup guidance. */
export function blockedReason(item: {
  blocked?: { reason: string; detail?: string };
  methods?: string[];
}): string | undefined {
  const blocked = item.blocked;
  if (!blocked) return undefined;
  if (blocked.reason === "deprecated" || blocked.reason === "deleted") return blocked.reason;
  const methods = item.methods ?? [];
  for (const method of ["pypi", "oci", "mcpb"]) if (methods.includes(method)) return method;
  if (blocked.detail?.includes("exact version")) return "unversioned";
  if (blocked.detail?.includes("sse")) return "sse";
  return undefined;
}
