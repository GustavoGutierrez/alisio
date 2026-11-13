/**
 * Pure model of the last mile of Settings → MCP (specs/030 phase 4): the connection test view and
 * its recovery actions (UX-07/08), the settings form with write-only keys (UX-06), the sign-in
 * view (OAuth) and the update view. No DOM and no store: tested in `tests/web-mcp-manage.test.ts`.
 * Validation reuses the install form's rules, which mirror the server's (the server validates again).
 */
import type {
  McpBindingConfiguration,
  McpBindingInfo,
  McpConnectionTestResult,
  McpInstallInputInfo,
  McpInstallPlan,
  McpRecoveryAction,
  McpSignInFlow,
} from "@alisio/sdk";
import { type FieldErrorKey, fieldIssue, type ValidationResult } from "../mcp-install/model.ts";
import type { ManageStringKey } from "./strings.ts";

// ---- connection test -----------------------------------------------------------------------------

export type TestState = "none" | "running" | "passed" | "failed" | "cancelled";
export type StageState = "passed" | "failed" | "skipped" | "pending";

export interface RecoveryButton {
  action: McpRecoveryAction;
  labelKey: ManageStringKey;
}

const RECOVERY_LABEL: Record<McpRecoveryAction, ManageStringKey> = {
  "sign-in": "recovery.signIn",
  "change-key": "recovery.changeKey",
  retry: "recovery.retry",
  "install-runtime": "recovery.recheck",
  configure: "recovery.configure",
  "turn-on": "recovery.turnOn",
};

/** A recovery action as a button, or `undefined` when there is nothing to do. */
export function recoveryOf(action: McpRecoveryAction | undefined): RecoveryButton | undefined {
  return action ? { action, labelKey: RECOVERY_LABEL[action] } : undefined;
}

/** What to do next: the cause's own action, with a plain retry beside it where that makes sense. */
function recoveryButtons(action: McpRecoveryAction | undefined): RecoveryButton[] {
  const primary = recoveryOf(action);
  if (!primary) return [];
  if (action === "retry" || action === "install-runtime" || action === "turn-on") return [primary];
  return [primary, { action: "retry", labelKey: "recovery.retry" }];
}

export interface TestView {
  state: TestState;
  headlineKey: ManageStringKey;
  steps: Array<{ id: string; labelKey: ManageStringKey; state: StageState }>;
  stale: boolean;
  message?: string;
  counts?: { tools: number; resources: number; prompts: number };
  recovery: RecoveryButton[];
  finishedAt?: string;
  lastPassedAt?: string;
}

const STAGES = ["prepare", "connect", "authenticate", "discover"] as const;
const stageKey = (id: string) => `stage.${id}` as ManageStringKey;

export function testViewOf(
  result: McpConnectionTestResult | undefined,
  running: boolean,
): TestView {
  if (running)
    return {
      state: "running",
      headlineKey: "test.running",
      // No stage is marked as active: the server does not stream progress, so none is invented.
      steps: STAGES.map((id) => ({ id, labelKey: stageKey(id), state: "pending" as const })),
      stale: false,
      recovery: [],
    };
  if (!result)
    return { state: "none", headlineKey: "test.none", steps: [], stale: false, recovery: [] };
  const byId = new Map(result.steps.map((step) => [step.id, step.status]));
  return {
    state: result.status,
    headlineKey:
      result.status === "passed"
        ? result.stale
          ? "test.headline.stale"
          : "test.headline.passed"
        : result.status === "cancelled"
          ? "test.headline.cancelled"
          : "test.headline.failed",
    steps: STAGES.map((id) => ({
      id,
      labelKey: stageKey(id),
      state: (byId.get(id) ?? "skipped") as StageState,
    })),
    stale: result.stale,
    message: result.safeMessage,
    counts: result.counts,
    recovery: result.status === "passed" ? [] : recoveryButtons(result.recoveryAction),
    finishedAt: result.finishedAt,
    ...(result.lastPassedAt ? { lastPassedAt: result.lastPassedAt } : {}),
  };
}

// ---- settings form -----------------------------------------------------------------------------

/** The server's form as the shared field model (so the install form's validation applies). */
export function configFieldsOf(config: McpBindingConfiguration): McpInstallInputInfo[] {
  return config.fields.map((field) => ({
    id: field.id,
    kind: field.kind,
    name: field.name,
    secret: field.secret,
    required: field.required,
    ...(field.description ? { description: field.description } : {}),
    ...(field.format ? { format: field.format } : {}),
    ...(field.choices ? { choices: field.choices } : {}),
  }));
}

/** The values shown when the form opens: public values only, never a secret. */
export function configInitialValues(config: McpBindingConfiguration): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of config.fields)
    if (!field.secret && field.value !== undefined) out[field.id] = field.value;
  return out;
}

const cleaned = (secret: boolean, value: string) => (secret ? value : value.trim());

/**
 * Same rules as the server. A saved key may stay empty (it means "keep"); a required key that was
 * never saved must be typed; spaces around a key are reported, never trimmed silently.
 */
export function validateConfig(
  config: McpBindingConfiguration,
  values: Record<string, string>,
): ValidationResult {
  const errors: ValidationResult["errors"] = [];
  const fields = configFieldsOf(config);
  for (const [index, field] of fields.entries()) {
    const source = config.fields[index];
    const value = cleaned(field.secret, values[field.id] ?? "");
    let key: FieldErrorKey | undefined;
    if (field.secret && source?.configured && value === "") key = undefined;
    else key = fieldIssue(field, value);
    if (key) errors.push({ id: field.id, key });
  }
  return { errors, ...(errors[0] ? { first: errors[0].id } : {}) };
}

/** Only what changed: edited public values, a new key, and the explicit removals. */
export function configPatchOf(
  config: McpBindingConfiguration,
  values: Record<string, string>,
  cleared: string[],
): { values: Record<string, string>; clear: string[] } {
  const patch: Record<string, string> = {};
  const initial = configInitialValues(config);
  for (const field of config.fields) {
    if (cleared.includes(field.id)) continue;
    const value = cleaned(field.secret, values[field.id] ?? "");
    if (field.secret) {
      if (value !== "") patch[field.id] = value;
    } else if (value !== (initial[field.id] ?? "")) patch[field.id] = value;
  }
  return { values: patch, clear: [...cleared] };
}

/** What survives a conflict or a reload: the non-secret draft. */
export function configDraftOf(
  config: McpBindingConfiguration,
  values: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of config.fields)
    if (!field.secret && values[field.id] !== undefined) out[field.id] = values[field.id] as string;
  return out;
}

// ---- sign in (OAuth) --------------------------------------------------------------------------

/**
 * The only addresses the browser is sent to: https, or http on this machine (a local service), and
 * never credentials in the address or a script/data scheme.
 */
export function safeAuthUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (url.username || url.password) return undefined;
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  if (url.protocol === "https:" || (url.protocol === "http:" && loopback)) return url.href;
  return undefined;
}

export type SignInState =
  | "idle"
  | "starting"
  | "awaiting"
  | "completing"
  | "done"
  | "failed"
  | "cancelled";
export interface SignInViewModel {
  state: SignInState;
  link?: string;
  messageKey?: ManageStringKey;
}

export function signInViewOf(flow: McpSignInFlow | undefined, starting: boolean): SignInViewModel {
  if (!flow) return { state: starting ? "starting" : "idle" };
  switch (flow.state) {
    case "awaiting-browser": {
      const link = safeAuthUrl(flow.authorizationUrl);
      return { state: "awaiting", ...(link ? { link } : {}) };
    }
    case "completing":
      return { state: "completing" };
    case "completed":
      return { state: "done" };
    case "cancelled":
      return { state: "cancelled", messageKey: "signin.cancelled" };
    default:
      return {
        state: "failed",
        messageKey:
          flow.error?.code === "access_denied"
            ? "signin.denied"
            : flow.error?.code === "timeout"
              ? "signin.timeout"
              : "signin.failed",
      };
  }
}

// ---- update ------------------------------------------------------------------------------------

export type UpdateView =
  | { kind: "unavailable" }
  | { kind: "check" }
  | { kind: "up-to-date"; version: string }
  | { kind: "available"; from: string; to: string };

/** Only an installed package updates; a remote service changes on its own. */
export function updateViewOf(
  binding: Pick<McpBindingInfo, "method" | "registryVersion">,
  plan: Pick<McpInstallPlan, "registryVersion"> | undefined,
): UpdateView {
  if (binding.method !== "npm") return { kind: "unavailable" };
  if (!plan) return { kind: "check" };
  return plan.registryVersion === binding.registryVersion
    ? { kind: "up-to-date", version: plan.registryVersion }
    : { kind: "available", from: binding.registryVersion, to: plan.registryVersion };
}
