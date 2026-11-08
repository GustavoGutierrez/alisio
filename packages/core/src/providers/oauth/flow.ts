import { randomUUID } from "node:crypto";
import type {
  CredentialStatus,
  ProviderAuthContext,
  ProviderAuthFlowView,
  ProviderAuthLoopback,
  ProviderAuthLoopbackOptions,
  ProviderAuthMethod,
  ProviderAuthPrompt,
  ProviderAuthStep,
  ProviderOAuthCredential,
} from "@alisio/sdk";
import { redactCredentials, type SecretRegistry, sharedSecrets } from "../redaction.ts";
import type { ProviderSettingsStore } from "../settings.ts";
import { LOOPBACK_MAX_MS, openLoopback } from "./loopback.ts";

/** A sign-in not finished by then is over (D5). */
export const FLOW_TTL_MS = 900_000;
/** A finished flow stays readable this long so the web can read its outcome, then it is swept. */
export const FLOW_RETAIN_MS = 120_000;
/** Flows that may be active at once in one process. */
export const FLOW_MAX_ACTIVE = 4;
/** Steps kept per flow (the oldest are dropped), and the longest text and URL of a step. */
export const FLOW_MAX_STEPS = 50;
export const FLOW_MAX_TEXT = 2_048;
export const FLOW_MAX_URL = 4_096;

export type AuthFlowStatus = ProviderAuthFlowView["status"];
type FlowError = NonNullable<ProviderAuthFlowView["error"]>;

/** Schedules `fn` after `ms` and returns the function that cancels it (a clock seam for tests). */
export type Schedule = (fn: () => void, ms: number) => () => void;
const defaultSchedule: Schedule = (fn, ms) => {
  const timer = setTimeout(fn, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
};

/** The fifth active flow was refused (D5); the server answers `validation_failed` for `flows`. */
export class AuthFlowLimitError extends Error {
  readonly code = "flow_limit";
  constructor() {
    super(`At most ${FLOW_MAX_ACTIVE} sign-in flows can run at once`);
    this.name = "AuthFlowLimitError";
  }
}

const TERMINAL: ReadonlySet<AuthFlowStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
]);
/** Legal transitions of the state machine (a terminal state is final). */
const TRANSITIONS: Record<AuthFlowStatus, readonly AuthFlowStatus[]> = {
  running: ["awaiting_input", "succeeded", "failed", "cancelled", "expired"],
  awaiting_input: ["running", "succeeded", "failed", "cancelled", "expired"],
  succeeded: [],
  failed: [],
  cancelled: [],
  expired: [],
};

/** `https:`, or `http:` on `127.0.0.1` or `localhost`; no user info, bounded length (D25). */
export function isSafeStepUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length === 0 || value.length > FLOW_MAX_URL) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
}

/** Values of the query and fragment parameters of a URL-shaped (or bare `a=b&c=d`) answer. */
function urlParamValues(answer: string): string[] {
  const text = answer.trim();
  if (text.length === 0 || text.length > FLOW_MAX_URL * 4) return [];
  let query: string[] = [];
  try {
    const url = new URL(text);
    query = [url.search, url.hash.replace(/^#/, "")];
  } catch {
    if (text.includes("=")) query = [text.slice(text.indexOf("?") + 1)];
  }
  const values: string[] = [];
  for (const part of query)
    for (const [, value] of new URLSearchParams(part.replace(/^\?/, ""))) values.push(value);
  return values;
}

const KNOWN_FAILURES: ReadonlySet<string> = new Set(["loopback_unavailable", "unsupported"]);

export interface RunAuthFlowOptions {
  store: ProviderSettingsStore;
  /** Profile the session is stored under. */
  profile: string;
  /** Id of the provider registration that owns the method (stored as the session's `provider`, D21). */
  providerId: string;
  method: ProviderAuthMethod;
  /** Identity of the registration, to cancel the flow when it is removed (D28a). */
  registrationKey?: unknown;
  /** Whether `ctx.loopback` is offered and why (D16): `declared` by the host, or `assumed` from a loopback bind. */
  loopback?: "declared" | "assumed" | false;
  /** No way to ask the user (headless): `prompt` resolves `undefined` and there is no loopback (D13). */
  headless?: boolean;
  /** In-process prompt handler (the TUI); without it prompts queue for `input()` (the web). */
  onPrompt?: (request: ProviderAuthPrompt, signal: AbortSignal) => Promise<string | undefined>;
  /** In-process step listener (the TUI), called with each accepted step. */
  onStep?: (step: ProviderAuthStep) => void;
  ttlMs?: number;
  now?: () => number;
  schedule?: Schedule;
  /** Where exact secret values are recorded for redaction; the process-wide registry by default. */
  secrets?: SecretRegistry;
}

const clip = (text: string, secrets: SecretRegistry): string =>
  redactCredentials(String(text), [], secrets).slice(0, FLOW_MAX_TEXT);

/**
 * One sign-in flow: the state machine behind `running -> awaiting_input -> succeeded | failed |
 * cancelled | expired` (D5). It is created and driven by `runAuthFlow`; callers read `view()`,
 * answer `input()` and `cancel()`.
 */
export class AuthFlow {
  readonly id = randomUUID();
  readonly profile: string;
  readonly providerId: string;
  readonly registrationKey: unknown;
  /** Resolves when the flow reached a terminal state and its method settled. */
  readonly done: Promise<void>;
  finishedAt: number | undefined;

  private state: AuthFlowStatus = "running";
  private steps: Array<ProviderAuthStep & { n: number }> = [];
  private counter = 0;
  private failure: FlowError | undefined;
  private stored: CredentialStatus | undefined;
  private committing = false;
  private readonly controller = new AbortController();
  private readonly loopbacks = new Set<ProviderAuthLoopback>();
  private readonly prompts: Array<{
    id: string;
    request: ProviderAuthPrompt;
    resolve: (value: string | undefined) => void;
    /** Whether `input()` answers it (the web) or an in-process handler does. */
    queued: boolean;
  }> = [];
  private cancelTimer: (() => void) | undefined;
  private readonly offered: "declared" | "assumed" | false;
  private readonly options: RunAuthFlowOptions;
  private readonly now: () => number;
  private readonly secrets: SecretRegistry;

  constructor(options: RunAuthFlowOptions) {
    this.options = options;
    this.profile = options.profile;
    this.providerId = options.providerId;
    this.registrationKey = options.registrationKey;
    this.now = options.now ?? Date.now;
    this.secrets = options.secrets ?? sharedSecrets;
    this.offered = options.headless ? false : (options.loopback ?? false);
    this.cancelTimer = (options.schedule ?? defaultSchedule)(
      () => this.expire(),
      options.ttlMs ?? FLOW_TTL_MS,
    );
    this.done = this.run();
  }

  get status(): AuthFlowStatus {
    return this.state;
  }
  /** Whether the credential is being committed: a cancel is too late (R2-05). */
  get isCommitting(): boolean {
    return this.committing && !this.terminal;
  }
  get terminal(): boolean {
    return TERMINAL.has(this.state);
  }

  /** What the web polls: steps above `after`, the pending prompt, the outcome. Never a secret. */
  view(after = 0): ProviderAuthFlowView {
    const pending = this.prompts.find((p) => p.queued);
    return {
      status: this.state,
      steps: this.steps.filter((step) => step.n > after).map((step) => ({ ...step })),
      ...(pending && !this.terminal
        ? {
            prompt: {
              id: pending.id,
              message: pending.request.message,
              ...(pending.request.placeholder !== undefined
                ? { placeholder: pending.request.placeholder }
                : {}),
              ...(pending.request.secret ? { secret: true } : {}),
            },
          }
        : {}),
      ...(this.failure ? { error: { ...this.failure } } : {}),
      ...(this.stored ? { credential: { ...this.stored } } : {}),
      ...(this.offered ? { loopback: this.offered } : {}),
    };
  }

  /** Answers the pending prompt with id `promptId`. */
  input(promptId: string, value: string): "accepted" | "no_prompt" | "mismatch" {
    const pending = this.prompts.find((p) => p.queued);
    if (!pending || this.terminal) return "no_prompt";
    if (pending.id !== promptId) return "mismatch";
    this.settlePrompt(pending, value);
    return "accepted";
  }

  /**
   * Cancels the flow. True only when this call really cancelled it: false when it was already
   * over, or too late because the credential is being committed (R2-05).
   */
  cancel(): boolean {
    if (this.committing) return false;
    return this.finish("cancelled", { code: "cancelled", message: "The sign-in was cancelled" });
  }

  private expire(): void {
    if (this.committing) return;
    this.finish("expired", { code: "expired", message: "The sign-in took too long and expired" });
  }

  private move(to: AuthFlowStatus): boolean {
    if (!TRANSITIONS[this.state].includes(to)) return false;
    this.state = to;
    return true;
  }

  /** Ends the flow once: aborts the method (unless it succeeded), closes listeners, frees prompts. */
  private finish(to: AuthFlowStatus, error?: FlowError, credential?: CredentialStatus): boolean {
    if (!this.move(to)) return false;
    this.finishedAt = this.now();
    this.cancelTimer?.();
    if (error) this.failure = error;
    if (credential) this.stored = credential;
    for (const loopback of this.loopbacks) loopback.close();
    this.loopbacks.clear();
    for (const prompt of this.prompts.splice(0)) prompt.resolve(undefined);
    if (to !== "succeeded") this.controller.abort(new Error(`Sign-in ${to}`));
    return true;
  }

  private fail(code: FlowError["code"], message: string): void {
    this.finish("failed", { code, message: clip(message, this.secrets) });
  }

  private settlePrompt(prompt: AuthFlow["prompts"][number], value: string | undefined): void {
    const index = this.prompts.indexOf(prompt);
    if (index >= 0) this.prompts.splice(index, 1);
    // Every answer of 8 or more characters is redacted from then on, secret or not (D26c).
    if (value !== undefined) {
      this.secrets.add(value);
      // A pasted redirect URL carries the code and state: each parameter is a secret too (R2-06).
      for (const param of urlParamValues(value)) this.secrets.add(param);
    }
    if (!this.terminal) this.move(this.prompts.length ? "awaiting_input" : "running");
    prompt.resolve(value);
  }

  private show(step: ProviderAuthStep): void {
    if (this.terminal) return;
    const clean = this.sanitize(step);
    if (!clean) return;
    this.steps.push({ ...clean, n: ++this.counter });
    if (this.steps.length > FLOW_MAX_STEPS)
      this.steps.splice(0, this.steps.length - FLOW_MAX_STEPS);
    try {
      this.options.onStep?.(clean);
    } catch {
      /* A listener's failure never stops the sign-in. */
    }
  }

  /** A fresh step with only the known fields, texts redacted and bounded; undefined when it was refused. */
  private sanitize(step: ProviderAuthStep): ProviderAuthStep | undefined {
    const raw = step as unknown as Record<string, unknown>;
    switch (raw?.type) {
      case "auth_url": {
        if (!isSafeStepUrl(raw.url)) return this.unsafe();
        return {
          type: "auth_url",
          url: new URL(raw.url as string).href,
          ...(typeof raw.instructions === "string"
            ? { instructions: clip(raw.instructions, this.secrets) }
            : {}),
        };
      }
      case "device_code": {
        if (!isSafeStepUrl(raw.verificationUri)) return this.unsafe();
        if (
          raw.verificationUriComplete !== undefined &&
          !isSafeStepUrl(raw.verificationUriComplete)
        )
          return this.unsafe();
        if (typeof raw.userCode !== "string" || typeof raw.expiresInSeconds !== "number")
          throw new TypeError("device_code needs userCode and expiresInSeconds");
        return {
          type: "device_code",
          verificationUri: raw.verificationUri as string,
          userCode: String(raw.userCode).slice(0, FLOW_MAX_TEXT),
          expiresInSeconds: raw.expiresInSeconds,
          ...(raw.verificationUriComplete !== undefined
            ? { verificationUriComplete: raw.verificationUriComplete as string }
            : {}),
          ...(typeof raw.intervalSeconds === "number"
            ? { intervalSeconds: raw.intervalSeconds }
            : {}),
        };
      }
      case "progress":
        return { type: "progress", message: clip(String(raw.message ?? ""), this.secrets) };
      default:
        throw new TypeError("Unknown sign-in step type");
    }
  }

  /** Refuses a step whose URL is not allowed: no step, the signal aborts, the flow fails (D25). */
  private unsafe(): undefined {
    this.fail(
      "unsafe_url",
      "The sign-in method produced a link that is not allowed (only https: or a local http: address)",
    );
    return undefined;
  }

  private prompt(request: ProviderAuthPrompt): Promise<string | undefined> {
    if (this.terminal || this.options.headless) return Promise.resolve(undefined);
    const clean: ProviderAuthPrompt = {
      message: clip(request.message, this.secrets),
      ...(request.placeholder !== undefined
        ? { placeholder: clip(request.placeholder, this.secrets) }
        : {}),
      ...(request.secret ? { secret: true } : {}),
    };
    return new Promise<string | undefined>((resolve) => {
      const prompt = { id: randomUUID(), request: clean, resolve, queued: !this.options.onPrompt };
      this.prompts.push(prompt);
      this.move("awaiting_input");
      if (this.options.onPrompt)
        this.options.onPrompt(clean, this.controller.signal).then(
          (value) => this.settlePrompt(prompt, value),
          () => this.settlePrompt(prompt, undefined),
        );
    });
  }

  private async openLoopback(options: ProviderAuthLoopbackOptions): Promise<ProviderAuthLoopback> {
    if (this.terminal) throw new Error("The sign-in is over");
    const loopback = await openLoopback({
      ...options,
      timeoutMs: Math.min(options.timeoutMs ?? LOOPBACK_MAX_MS, LOOPBACK_MAX_MS),
      signal: this.controller.signal,
    });
    if (this.terminal) {
      loopback.close();
      throw new Error("The sign-in is over");
    }
    this.loopbacks.add(loopback);
    return {
      redirectUri: loopback.redirectUri,
      // The authorization code and every other redirect parameter are exact secrets from here on.
      wait: () =>
        loopback.wait().then((params) => {
          for (const value of Object.values(params)) this.secrets.add(value);
          return params;
        }),
      close: () => loopback.close(),
    };
  }

  private context(previous: Readonly<Record<string, string>> | undefined): ProviderAuthContext {
    return {
      signal: this.controller.signal,
      show: (step) => this.show(step),
      prompt: (request) => this.prompt(request),
      ...(this.offered ? { loopback: (options) => this.openLoopback(options) } : {}),
      ...(previous ? { previousMetadata: previous } : {}),
    };
  }

  private async run(): Promise<void> {
    let credential: ProviderOAuthCredential;
    try {
      // Metadata only, and only of a session that this very registration created (D4, D21).
      const entry = await this.options.store
        .getOAuth(this.profile, this.providerId)
        .catch(() => undefined);
      const previous =
        entry?.metadata && Object.keys(entry.metadata).length
          ? Object.freeze({ ...entry.metadata })
          : undefined;
      if (this.terminal) return;
      credential = await this.options.method.start(this.context(previous));
    } catch (error) {
      if (this.terminal) return;
      const code = (error as { code?: unknown } | null)?.code;
      this.finish("failed", {
        code:
          typeof code === "string" && KNOWN_FAILURES.has(code)
            ? (code as FlowError["code"])
            : "auth_failed",
        message: clip(error instanceof Error ? error.message : "The sign-in failed", this.secrets),
      });
      return;
    }
    if (this.terminal) return;
    await this.commit(credential);
  }

  /** Stores the credential under the credentials lock, only while the flow is still live (D22b). */
  private async commit(raw: ProviderOAuthCredential): Promise<void> {
    const credential = this.clean(raw);
    if (!credential) {
      this.fail("auth_failed", "The sign-in method did not return a usable credential");
      return;
    }
    this.secrets.add(credential.access);
    this.secrets.add(credential.refresh);
    try {
      const generation = await this.options.store.setOAuth(
        this.profile,
        credential,
        { method: this.options.method.id, provider: this.providerId },
        {
          // Evaluated under `credentials.json.lock`: a flow cancelled, replaced or expired while
          // it waited for the lock discards the credential. Past this point a cancel is too late.
          guard: () => {
            if (this.terminal) return false;
            this.committing = true;
            return true;
          },
        },
      );
      if (generation === false) return;
      this.finish("succeeded", undefined, {
        configured: true,
        source: "file",
        kind: "oauth",
        state: "ok",
        ...(credential.expires !== undefined ? { expires: credential.expires } : {}),
      });
    } catch (error) {
      this.committing = false;
      this.fail(
        "auth_failed",
        `The sign-in could not be stored: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }
  }

  /** A credential with only the known fields, or undefined when it has no access token. */
  private clean(raw: ProviderOAuthCredential): ProviderOAuthCredential | undefined {
    const value = raw as unknown as Record<string, unknown> | undefined;
    if (!value || typeof value.access !== "string" || value.access.length === 0) return undefined;
    const metadata = Object.fromEntries(
      Object.entries((value.metadata as Record<string, unknown> | undefined) ?? {}).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
    return {
      type: "oauth",
      access: value.access,
      ...(typeof value.refresh === "string" && value.refresh ? { refresh: value.refresh } : {}),
      ...(typeof value.expires === "number" && Number.isFinite(value.expires)
        ? { expires: value.expires }
        : {}),
      ...(Object.keys(metadata).length ? { metadata } : {}),
    };
  }
}

/** Starts a flow and returns it at once; the method runs in the background (D5). */
export function runAuthFlow(options: RunAuthFlowOptions): AuthFlow {
  return new AuthFlow(options);
}

export interface AuthFlowRegistryOptions {
  store: ProviderSettingsStore;
  ttlMs?: number;
  retainMs?: number;
  maxActive?: number;
  now?: () => number;
  schedule?: Schedule;
  secrets?: SecretRegistry;
}

/** What `AuthFlowRegistry.start` needs on top of the registry's own settings. */
export type StartFlowInput = Omit<
  RunAuthFlowOptions,
  "store" | "ttlMs" | "now" | "schedule" | "secrets"
>;

/**
 * The in-memory registry of flows of one process (precedent: `InstallJobs`): at most one active
 * flow per profile (a new `start` replaces the old one), at most four active flows overall,
 * finished flows kept for two minutes. Nothing is persisted: a restart loses every flow, which
 * the web reports as an interrupted sign-in (D28d).
 */
export class AuthFlowRegistry {
  private readonly flows = new Map<string, AuthFlow>();
  private readonly options: AuthFlowRegistryOptions;
  private readonly now: () => number;

  constructor(options: AuthFlowRegistryOptions) {
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  private sweep(): void {
    const retain = this.options.retainMs ?? FLOW_RETAIN_MS;
    for (const [id, flow] of this.flows)
      if (flow.terminal && flow.finishedAt !== undefined && this.now() - flow.finishedAt >= retain)
        this.flows.delete(id);
  }

  /** Number of flows that are not finished. */
  get activeCount(): number {
    return [...this.flows.values()].filter((flow) => !flow.terminal).length;
  }

  /** Starts a flow, cancelling the profile's previous one; refuses a fifth active flow. */
  start(input: StartFlowInput): AuthFlow {
    this.sweep();
    for (const flow of this.flows.values())
      if (flow.profile === input.profile && !flow.terminal) flow.cancel();
    if (this.activeCount >= (this.options.maxActive ?? FLOW_MAX_ACTIVE))
      throw new AuthFlowLimitError();
    const flow = runAuthFlow({
      ...input,
      store: this.options.store,
      ...(this.options.ttlMs !== undefined ? { ttlMs: this.options.ttlMs } : {}),
      ...(this.options.now ? { now: this.options.now } : {}),
      ...(this.options.schedule ? { schedule: this.options.schedule } : {}),
      ...(this.options.secrets ? { secrets: this.options.secrets } : {}),
    });
    this.flows.set(flow.id, flow);
    return flow;
  }

  /** The flow with this id, or undefined when unknown or swept. */
  get(id: string): AuthFlow | undefined {
    this.sweep();
    return this.flows.get(id);
  }

  /** Cancels the active flow of a profile; returns how many it cancelled. */
  cancelProfile(profile: string): number {
    let count = 0;
    for (const flow of this.flows.values())
      if (flow.profile === profile && !flow.terminal && flow.cancel()) count++;
    return count;
  }

  /**
   * Resolves when the flows of `profile` that are past the point of no return (committing, so
   * `cancel()` refused) have stored their credential. A caller that then deletes the session
   * removes it instead of racing the write (R2-05).
   */
  async settleCommits(profile: string): Promise<void> {
    await Promise.all(
      [...this.flows.values()]
        .filter((flow) => flow.profile === profile && flow.isCommitting)
        .map((flow) => flow.done.catch(() => undefined)),
    );
  }

  /** Cancels every active flow started for a registration that was removed (D28a). */
  cancelRegistration(key: unknown): number {
    let count = 0;
    for (const flow of this.flows.values())
      if (flow.registrationKey === key && !flow.terminal && flow.cancel()) count++;
    return count;
  }

  /** Cancels everything (shutdown). */
  cancelAll(): void {
    for (const flow of this.flows.values()) if (!flow.terminal) flow.cancel();
  }
}
