/**
 * `/connect` sign-in for providers whose registration declares `auth` (specs/025 §5.7): the method
 * picker, the conductor that runs one flow in process, and sign out. The conductor talks to the
 * terminal only through `ConnectOAuthUi`, so it is tested without a terminal. Nothing here knows a
 * concrete provider: the only provider text shown is what the plugin supplies (labels, the prompt
 * message, step instructions), always as plain text.
 */
import { type ProviderSettingsStore, redactCredentials, runAuthFlow } from "@alisio/core";
import type {
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderAuthStep,
  ProviderConfigurationField,
} from "@alisio/sdk";

/** Fixed host notice shown before an unofficial method starts (generic: no provider named). */
export const UNOFFICIAL_NOTICE =
  "This sign-in method is not officially authorized by the provider. The service may change without notice and your account could be restricted.";

export interface ConnectChoice {
  value: string;
  label: string;
  description?: string;
}

/** What the conductor needs from the terminal. */
export interface ConnectOAuthUi {
  /** One masked or plain text field; resolves `undefined` on Esc. `signal` aborts it when the flow ends. */
  askInput(
    input: { label: string; secret: boolean; placeholder: string; hint?: string },
    signal: AbortSignal,
  ): Promise<string | undefined>;
  askChoice(title: string, choices: ConnectChoice[]): Promise<string | undefined>;
  /** Appends plain text lines to the transcript. */
  notice(text: string): void;
  /** Shows a "waiting, Esc cancels" affordance; `cancelled` resolves on Esc, `close()` removes it. */
  beginWait(): { cancelled: Promise<void>; close(): void };
}

export type ConnectMethodChoice =
  | { kind: "sign_in"; method: ProviderAuthMethod }
  | { kind: "api_key" }
  | { kind: "sign_out" };

interface ConnectRegistration {
  name: string;
  fields: ProviderConfigurationField[];
  auth?: ProviderAuthMethod[];
}

/**
 * Asks how to connect. A provider without sign-in methods goes straight to the API key flow. With
 * methods: "Sign in" (one entry per method), "Enter API key" only when the provider has a secret
 * field, and "Sign out" when a session is stored.
 */
export async function pickConnectMethod(input: {
  registration: ConnectRegistration;
  session?: { state: "ok" | "needs_sign_in" };
  ui: Pick<ConnectOAuthUi, "askChoice">;
}): Promise<ConnectMethodChoice | undefined> {
  const { registration, session, ui } = input;
  const methods = registration.auth ?? [];
  if (methods.length === 0) return { kind: "api_key" };
  const again = session?.state === "needs_sign_in";
  const choices: ConnectChoice[] = methods.map((method) => ({
    value: `sign_in:${method.id}`,
    label: `${again ? "Sign in again" : "Sign in"} · ${method.label}${method.unofficial ? " (unofficial)" : ""}`,
    ...(method.description ? { description: method.description } : {}),
  }));
  if (registration.fields.some((field) => field.kind === "secret"))
    choices.push({ value: "api_key", label: "Enter API key" });
  if (session) choices.push({ value: "sign_out", label: "Sign out" });
  const picked = await ui.askChoice(`${registration.name} · How do you want to connect?`, choices);
  if (!picked) return undefined;
  if (picked === "api_key") return { kind: "api_key" };
  if (picked === "sign_out") return { kind: "sign_out" };
  const method = methods.find((candidate) => `sign_in:${candidate.id}` === picked);
  return method ? { kind: "sign_in", method } : undefined;
}

/** The fields `/connect` still asks for: signing in never asks for (nor requires) a secret. */
export function connectFieldsFor(
  registration: { fields: ProviderConfigurationField[] },
  choice: ConnectMethodChoice,
): ProviderConfigurationField[] {
  return choice.kind === "sign_in"
    ? registration.fields.filter((field) => field.kind !== "secret")
    : registration.fields;
}

/** Plugin text as one safe line: control characters (terminal escapes included) become spaces. */
const plain = (value: string): string =>
  value
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/ {2,}/g, " ")
    .trim();

function stepLines(step: ProviderAuthStep): string[] {
  switch (step.type) {
    case "auth_url":
      return [
        "Open this URL in your browser to sign in:",
        plain(step.url),
        ...(step.instructions ? [plain(step.instructions)] : []),
      ];
    case "device_code":
      return [
        `Open ${plain(step.verificationUri)} and enter the code ${plain(step.userCode)}`,
        ...(step.verificationUriComplete
          ? [`Or open this URL directly: ${plain(step.verificationUriComplete)}`]
          : []),
        `The code expires in ${Math.max(1, Math.round(step.expiresInSeconds / 60))} min.`,
      ];
    case "progress":
      return [plain(step.message)];
    default:
      return [];
  }
}

/** True in an SSH session, where the terminal's machine is not the browser's (D16, a heuristic). */
export const isSshSession = (env: Record<string, string | undefined>): boolean =>
  Boolean(env.SSH_CONNECTION || env.SSH_TTY);

export interface ConnectOAuthResult {
  status: "succeeded" | "failed" | "cancelled" | "expired";
  /** User-facing, already redacted; present unless the flow succeeded. */
  message?: string;
}

/** Runs one sign-in method in process and stores the session under `profile` when it succeeds. */
export async function runConnectOAuth(input: {
  store: ProviderSettingsStore;
  profile: string;
  registration: { id: string; name: string };
  method: ProviderAuthMethod;
  ui: ConnectOAuthUi;
  env?: Record<string, string | undefined>;
}): Promise<ConnectOAuthResult> {
  const { ui, method } = input;
  if (method.unofficial) {
    const answer = await ui.askChoice(UNOFFICIAL_NOTICE, [
      { value: "yes", label: "Yes, I understand the risk and want to continue" },
      { value: "no", label: "No, cancel" },
    ]);
    if (answer !== "yes") return { status: "cancelled", message: "Sign-in cancelled." };
  }
  let wait: ReturnType<ConnectOAuthUi["beginWait"]> | undefined;
  const endWait = () => {
    wait?.close();
    wait = undefined;
  };
  // The waiting picker is on screen whenever no prompt is: Esc there cancels the flow.
  const startWait = () => {
    if (wait || flow.terminal) return;
    const current = ui.beginWait();
    wait = current;
    void current.cancelled.then(() => {
      if (wait === current) flow.cancel();
    });
  };
  const askPrompt = async (request: ProviderAuthPrompt, signal: AbortSignal) => {
    endWait();
    const value = await ui.askInput(
      {
        label: plain(request.message),
        secret: request.secret === true,
        placeholder: request.placeholder ? plain(request.placeholder) : "",
        ...(request.secret ? { hint: "Input is masked and never added to command history" } : {}),
      },
      signal,
    );
    if (value === undefined) flow.cancel();
    else startWait();
    return value;
  };
  const flow = runAuthFlow({
    store: input.store,
    profile: input.profile,
    providerId: input.registration.id,
    method,
    loopback: isSshSession(input.env ?? process.env) ? false : "declared",
    onStep: (step) => {
      const lines = stepLines(step).filter(Boolean);
      if (lines.length) ui.notice(lines.join("\n"));
    },
    onPrompt: askPrompt,
  });
  startWait();
  try {
    await flow.done;
  } catch {
    /* The outcome is read from the view below. */
  } finally {
    endWait();
  }
  const view = flow.view(Number.MAX_SAFE_INTEGER);
  if (view.status === "succeeded") return { status: "succeeded" };
  const status = view.status === "failed" || view.status === "expired" ? view.status : "cancelled";
  return {
    status,
    message: redactCredentials(view.error?.message ?? "Sign-in did not finish."),
  };
}

/** Removes the stored session of `profile` (API keys stay); false when there was none. */
export async function signOut(input: {
  store: ProviderSettingsStore;
  profile: string;
  ui: Pick<ConnectOAuthUi, "notice">;
}): Promise<boolean> {
  const removed = await input.store.deleteOAuth(input.profile);
  input.ui.notice(
    removed
      ? "Signed out. The saved session was removed from this computer; you can also revoke access in the provider's account settings."
      : "Not signed in: there is no saved session for this provider.",
  );
  return removed;
}

/** An error as the TUI may print it: text with JWTs and every known secret removed (P-03). */
export function describeFailure(cause: unknown, exact: readonly string[] = []): string {
  return redactCredentials(cause instanceof Error ? cause.message : String(cause), exact);
}

/** One plugin-hook diagnostic line of `/stats`, its error redacted (P-03). */
export function hookFailureLine(d: {
  type: string;
  source: string;
  hook: string;
  error: string;
}): string {
  return `${d.type} ${d.source} ${d.hook}: ${redactCredentials(d.error)}`;
}
