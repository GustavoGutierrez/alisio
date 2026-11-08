/**
 * Provider sign-in on the web (specs/025 §5.5, §5.7): the state machine of one sign-in block, kept
 * free of Preact so it is testable without a DOM. A controller starts a flow, polls its view every
 * second, accumulates the steps, answers the one pending prompt, cancels, and tells its owner when
 * the flow reached an end so the page can fetch the profile again (a late cancel does not undo a
 * write that already passed its guard, so the local state is never trusted after a flow).
 *
 * Nothing here ever holds a token: a flow view carries steps, the pending prompt and an outcome.
 * Provider text (labels, instructions, prompt messages) is data for text nodes only.
 */
import type {
  CredentialStatus,
  ProviderAuthFlowStarted,
  ProviderAuthFlowView,
  ProviderAuthMethodInfo,
  ProviderAuthPrompt,
  ProviderAuthStep,
  ProviderProfileInfo,
  ProviderTypeInfo,
} from "@alisio/sdk";
import { ApiRequestError } from "../net/api.ts";

/** The slice of the API client the controller needs. */
export interface SignInApi {
  startProviderAuth(
    profile: string,
    methodId: string,
    workspace: string,
  ): Promise<ProviderAuthFlowStarted>;
  providerAuthFlow(profile: string, flowId: string, after?: number): Promise<ProviderAuthFlowView>;
  providerAuthInput(
    profile: string,
    flowId: string,
    promptId: string,
    value: string,
  ): Promise<ProviderAuthFlowView>;
  cancelProviderAuth(profile: string, flowId: string): Promise<ProviderAuthFlowView>;
}

export type SignInStep = ProviderAuthStep & { n: number };
export type SignInPhase = "idle" | "confirm" | "starting" | "running" | "failed" | "interrupted";

/** Why a sign-in ended badly: a flow error code, or one of the web's own (`start`, `network`, `cancel`). */
export interface SignInFailure {
  code: string;
  /** Provider- or server-supplied text: show it as text only. */
  message?: string;
}

export interface SignInState {
  phase: SignInPhase;
  /** The method being confirmed, started or restarted. */
  method?: ProviderAuthMethodInfo;
  flowId?: string;
  steps: SignInStep[];
  prompt?: ProviderAuthPrompt & { id: string };
  failure?: SignInFailure;
}

export const initialSignIn: SignInState = { phase: "idle", steps: [] };

/** The server keeps 50 steps per flow; so does the page. */
const MAX_STEPS = 50;
/** One poll per second while a flow is active (spec §5.7). */
export const POLL_INTERVAL_MS = 1_000;
/** Consecutive failed polls (network) before the page gives up. */
const MAX_POLL_FAILURES = 5;

type FlowEnd = "succeeded" | "failed" | "cancelled" | "expired";
const ENDED = new Set<string>(["succeeded", "failed", "cancelled", "expired"]);

/** Folds a polled view into the state: new steps, the pending prompt, and the outcome. */
export function applyView(state: SignInState, view: ProviderAuthFlowView): SignInState {
  const seen = state.steps.reduce((max, step) => Math.max(max, step.n), 0);
  const fresh = view.steps.filter((step) => step.n > seen);
  const steps = [...state.steps, ...fresh].slice(-MAX_STEPS);
  if (view.status === "succeeded") return initialSignIn;
  if (ENDED.has(view.status))
    return {
      phase: "failed",
      method: state.method,
      steps,
      failure: {
        code: view.error?.code ?? (view.status === "failed" ? "auth_failed" : view.status),
        message: view.error?.message,
      },
    };
  return {
    ...state,
    phase: "running",
    steps,
    prompt: view.status === "awaiting_input" ? view.prompt : undefined,
  };
}

export interface SignInControllerOptions {
  api: SignInApi;
  profile: string;
  workspace: string;
  onState: (state: SignInState) => void;
  /** A flow ended (any way): fetch the profile again instead of trusting local state. */
  onFinished: (status: FlowEnd) => void;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface SignInController {
  /** An official method starts at once; an unofficial one waits for `confirm()`. */
  begin(method: ProviderAuthMethodInfo): Promise<void>;
  confirm(): Promise<void>;
  dismiss(): void;
  submit(value: string): Promise<void>;
  cancel(): Promise<void>;
  /** Stops polling; late answers change nothing. */
  dispose(): void;
}

const isNotFound = (error: unknown) =>
  error instanceof ApiRequestError && error.code === "not_found";
const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function createSignInController(options: SignInControllerOptions): SignInController {
  const { api, profile, workspace } = options;
  const setTimer = options.setTimer ?? ((run, ms) => setTimeout(run, ms));
  const clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer as number));
  let state = initialSignIn;
  /** Bumped whenever polling must stop or restart: anything started under an older value is stale. */
  let epoch = 0;
  let timer: unknown;
  let failures = 0;

  const set = (next: SignInState) => {
    state = next;
    options.onState(next);
  };
  const stop = (): number => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    return ++epoch;
  };

  /** Applies a view; true when the flow ended. */
  const consume = (view: ProviderAuthFlowView): boolean => {
    set(applyView(state, view));
    if (!ENDED.has(view.status)) return false;
    stop();
    options.onFinished(view.status as FlowEnd);
    return true;
  };
  const interrupted = () => {
    stop();
    set({ ...state, phase: "interrupted", prompt: undefined });
  };

  const schedule = (mine: number) => {
    timer = setTimer(() => {
      timer = undefined;
      void poll(mine);
    }, POLL_INTERVAL_MS);
  };
  const poll = async (mine: number): Promise<void> => {
    const flowId = state.flowId;
    if (mine !== epoch || !flowId) return;
    const after = state.steps.reduce((max, step) => Math.max(max, step.n), 0);
    let view: ProviderAuthFlowView;
    try {
      view = await api.providerAuthFlow(profile, flowId, after);
    } catch (error) {
      if (mine !== epoch) return;
      if (isNotFound(error)) return interrupted();
      failures += 1;
      if (failures >= MAX_POLL_FAILURES) {
        stop();
        set({
          ...state,
          phase: "failed",
          prompt: undefined,
          failure: { code: "network", message: messageOf(error) },
        });
        return;
      }
      return schedule(mine);
    }
    if (mine !== epoch) return;
    failures = 0;
    if (!consume(view)) schedule(mine);
  };

  const launch = async (method: ProviderAuthMethodInfo): Promise<void> => {
    const mine = stop();
    failures = 0;
    set({ ...initialSignIn, phase: "starting", method });
    let flowId: string;
    try {
      flowId = (await api.startProviderAuth(profile, method.id, workspace)).flowId;
    } catch (error) {
      if (mine !== epoch) return;
      set({
        ...initialSignIn,
        phase: "failed",
        method,
        failure: { code: "start", message: messageOf(error) },
      });
      return;
    }
    if (mine !== epoch) return;
    set({ ...initialSignIn, phase: "running", method, flowId });
    await poll(mine);
  };

  return {
    async begin(method) {
      if (!method.unofficial) return launch(method);
      stop();
      set({ ...initialSignIn, phase: "confirm", method });
    },
    async confirm() {
      if (state.phase !== "confirm" || !state.method) return;
      await launch(state.method);
    },
    dismiss() {
      stop();
      set(initialSignIn);
    },
    async submit(value) {
      const flowId = state.flowId;
      const prompt = state.prompt;
      if (!flowId || !prompt) return;
      const mine = epoch;
      set({ ...state, prompt: undefined });
      try {
        const view = await api.providerAuthInput(profile, flowId, prompt.id, value);
        if (mine === epoch) consume(view);
      } catch (error) {
        if (mine !== epoch) return;
        // Anything else: the next poll shows the prompt again if it is still pending.
        if (isNotFound(error)) interrupted();
      }
    },
    async cancel() {
      const flowId = state.flowId;
      stop();
      if (!flowId) return set(initialSignIn);
      try {
        await api.cancelProviderAuth(profile, flowId);
      } catch (error) {
        if (!isNotFound(error)) {
          set({
            ...state,
            phase: "failed",
            failure: { code: "cancel", message: messageOf(error) },
          });
          return;
        }
      }
      set(initialSignIn);
      options.onFinished("cancelled");
    },
    dispose() {
      stop();
    },
  };
}

/**
 * Only `https:` and `http:` on `localhost`/`127.0.0.1`, without embedded credentials, are ever
 * opened or shown as a link (D25). The server enforces the same rule; a manipulated view must not
 * get past the page either.
 */
export function isOpenableUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username || parsed.password) return false;
  if (parsed.protocol === "https:") return true;
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost")
  );
}

type Opener = (url: string, target: string, features: string) => unknown;

/**
 * Opens an authorization link in a new tab, detached from this page (`noopener,noreferrer`).
 * Never navigates this window. Returns whether the URL passed the policy and was handed over.
 */
export function openExternal(
  url: string,
  open: Opener = (...args) => window.open(...args),
): boolean {
  if (!isOpenableUrl(url)) return false;
  open(url, "_blank", "noopener,noreferrer");
  return true;
}

/**
 * The credential rows of a profile card. A sign-in-only provider (sign-in declared, no required
 * secret field) has none; the synthetic `oauth` entry is the session, never a pasted value.
 */
export function credentialRows(
  profile: ProviderProfileInfo,
  type: ProviderTypeInfo | undefined,
): Array<[string, CredentialStatus]> {
  const signInOnly =
    !!type?.auth?.length && !type.fields.some((field) => field.kind === "secret" && field.required);
  if (signInOnly) return [];
  return Object.entries(profile.credentials).filter(([field]) => field !== "oauth");
}

/** The stored session of a profile, as the card shows it. */
export function signInStatus(
  status: CredentialStatus | undefined,
): "none" | "ok" | "needs_sign_in" {
  if (!status?.configured) return "none";
  return status.state === "needs_sign_in" ? "needs_sign_in" : "ok";
}
