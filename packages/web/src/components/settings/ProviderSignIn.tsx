/**
 * Settings → Models: the sign-in block of a provider profile whose type declares `auth`
 * (specs/025 §5.7). `SignInView` is hook-free and presentational; `ProviderSignIn` wires it to a
 * controller (`store/provider-signin.ts`) that starts the flow, polls it and cancels it.
 *
 * Everything the plugin sends (labels, descriptions, instructions, prompt messages, codes) is
 * rendered as a text node. Links are never rendered as anchors: they open through a button with
 * `window.open(url, "_blank", "noopener,noreferrer")`, and only when they are `https:` or loopback.
 * The host adds no provider-specific wording: only generic buttons and states.
 */
import type { CredentialStatus, ProviderAuthMethodInfo } from "@alisio/sdk";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type MessageKey, t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import {
  createSignInController,
  initialSignIn,
  isOpenableUrl,
  openExternal,
  type SignInController,
  type SignInFailure,
  type SignInState,
  type SignInStep,
  signInStatus,
} from "../../store/provider-signin.ts";
import { copyText } from "../../util/clipboard.ts";
import styles from "./settings.module.css";
import { errorMessage } from "./shared.tsx";

export interface SignInHandlers {
  onBegin: (method: ProviderAuthMethodInfo) => void;
  onConfirm: () => void;
  onDismiss: () => void;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  onOpen: (url: string) => void;
  onCopy: (text: string) => void;
  onSignOut: () => void;
}

const FAILURE_TEXT: Record<string, MessageKey> = {
  start: "models.signIn.startFailed",
  network: "models.signIn.networkFailed",
  cancel: "models.signIn.cancelFailed",
  expired: "models.signIn.expiredFlow",
  cancelled: "models.signIn.cancelled",
  unsafe_url: "models.signIn.unsafeUrl",
  loopback_unavailable: "models.signIn.loopbackUnavailable",
  unsupported: "models.signIn.unsupported",
};

const lastOf = <T extends SignInStep["type"]>(steps: SignInStep[], type: T) =>
  [...steps].reverse().find((step) => step.type === type) as
    | Extract<SignInStep, { type: T }>
    | undefined;

function methodText(method: ProviderAuthMethodInfo): string {
  return method.unofficial ? `${method.label} (${t("models.signIn.unofficialTag")})` : method.label;
}

function Failure(props: { failure?: SignInFailure }) {
  const code = props.failure?.code ?? "auth_failed";
  const message = code === "unsafe_url" ? undefined : props.failure?.message;
  return (
    <p class={styles.errorText} role="alert" data-role="failure">
      {t(FAILURE_TEXT[code] ?? "models.signIn.failed")}
      {message ? ` ${message}` : ""}
    </p>
  );
}

/** A link the user may open or copy; one that fails the URL policy is replaced by a notice. */
function Link(props: { url: string; label: string; copyLabel?: string; handlers: SignInHandlers }) {
  if (!isOpenableUrl(props.url))
    return (
      <p class={styles.errorText} data-role="blocked">
        {t("models.signIn.linkBlocked")}
      </p>
    );
  return (
    <div class={styles.signInActions}>
      <button
        type="button"
        class={styles.primary}
        data-role="open"
        onClick={() => props.handlers.onOpen(props.url)}
      >
        {props.label}
      </button>
      {props.copyLabel ? (
        <button
          type="button"
          class={styles.secondary}
          data-role="copy"
          onClick={() => props.handlers.onCopy(props.url)}
        >
          {props.copyLabel}
        </button>
      ) : null}
    </div>
  );
}

function Steps(props: { steps: SignInStep[]; handlers: SignInHandlers }) {
  const { steps, handlers } = props;
  const url = lastOf(steps, "auth_url");
  const device = lastOf(steps, "device_code");
  const progress = steps.filter((step) => step.type === "progress").slice(-4);
  // The pre-filled address is preferred when it passes the policy too.
  const openTarget =
    device?.verificationUriComplete && isOpenableUrl(device.verificationUriComplete)
      ? device.verificationUriComplete
      : (device?.verificationUri ?? "");
  return (
    <>
      {url ? (
        <div class={styles.signInStep} data-role="auth-url">
          {url.instructions ? <p class={styles.note}>{url.instructions}</p> : null}
          <Link
            url={url.url}
            label={t("models.signIn.openLink")}
            copyLabel={t("models.signIn.copyAddress")}
            handlers={handlers}
          />
        </div>
      ) : null}
      {device ? (
        <div class={styles.signInStep} data-role="device-code">
          <span class={styles.meta}>{t("models.signIn.userCode")}</span>
          <div class={styles.signInActions}>
            <code class={styles.signInCode}>{device.userCode}</code>
            <button
              type="button"
              class={styles.secondary}
              data-role="copy"
              aria-label={t("models.signIn.copyCode")}
              onClick={() => handlers.onCopy(device.userCode)}
            >
              {t("models.signIn.copy")}
            </button>
          </div>
          <span class={styles.meta}>{t("models.signIn.address")}</span>
          {isOpenableUrl(device.verificationUri) ? (
            <div class={styles.signInActions}>
              <span class={styles.signInAddress}>{device.verificationUri}</span>
              <button
                type="button"
                class={styles.secondary}
                data-role="copy"
                aria-label={t("models.signIn.copyAddress")}
                onClick={() => handlers.onCopy(device.verificationUri)}
              >
                {t("models.signIn.copy")}
              </button>
              <button
                type="button"
                class={styles.primary}
                data-role="open"
                onClick={() => handlers.onOpen(openTarget)}
              >
                {t("models.signIn.openLink")}
              </button>
            </div>
          ) : (
            <p class={styles.errorText} data-role="blocked">
              {t("models.signIn.linkBlocked")}
            </p>
          )}
        </div>
      ) : null}
      {progress.map((step) => (
        <p key={step.n} class={styles.note} data-role="progress">
          {step.type === "progress" ? step.message : ""}
        </p>
      ))}
    </>
  );
}

function PromptForm(props: {
  profile: string;
  prompt: NonNullable<SignInState["prompt"]>;
  handlers: SignInHandlers;
}) {
  const { prompt, handlers } = props;
  const id = `signin-${props.profile}-${prompt.id}`;
  return (
    <form
      class={styles.signInStep}
      data-role="prompt"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget as HTMLFormElement;
        const field = form.elements.namedItem("value") as HTMLInputElement | null;
        const value = field?.value.trim() ?? "";
        if (!value) return;
        handlers.onSubmit(value);
        form.reset();
      }}
    >
      <label for={id} class={styles.settingLabel} data-role="prompt-label">
        {prompt.message}
      </label>
      <div class={styles.credentialForm}>
        <input
          id={id}
          name="value"
          data-role="prompt-input"
          class={styles.input}
          type={prompt.secret ? "password" : "text"}
          autocomplete="off"
          spellcheck={false}
          placeholder={prompt.placeholder}
        />
        <button type="submit" class={styles.primary} data-role="prompt-submit">
          {t("models.signIn.send")}
        </button>
      </div>
    </form>
  );
}

export function SignInView(props: {
  profile: string;
  methods: ProviderAuthMethodInfo[];
  status?: CredentialStatus;
  state: SignInState;
  handlers: SignInHandlers;
}) {
  const { profile, methods, status, state, handlers } = props;
  const session = signInStatus(status);
  const statusText =
    session === "ok"
      ? status?.expires
        ? `${t("models.signIn.signedIn")} · ${t("models.signIn.expires", { date: new Date(status.expires).toLocaleString() })}`
        : t("models.signIn.signedIn")
      : session === "needs_sign_in"
        ? t("models.signIn.expired")
        : t("models.signIn.notSignedIn");
  const again = session === "needs_sign_in";
  const label = (method: ProviderAuthMethodInfo) =>
    again
      ? methods.length === 1
        ? t("models.signIn.again")
        : `${t("models.signIn.again")} · ${methodText(method)}`
      : methodText(method);
  const working = state.phase === "starting" || state.phase === "running";
  return (
    <section class={styles.signIn} aria-label={t("models.signIn.title")} data-role="signin">
      <div class={styles.settingLabel}>
        <span>{t("models.signIn.title")}</span>
        <span class={styles.meta} data-configured={session === "ok"} data-role="status">
          {statusText}
        </span>
      </div>
      {state.phase === "idle" ? (
        <>
          <ul class={styles.signInMethods} aria-label={t("models.signIn.methods")}>
            {methods.map((method) => (
              <li key={method.id} class={styles.signInStep}>
                <div class={styles.signInActions}>
                  <button
                    type="button"
                    class={again ? styles.primary : styles.secondary}
                    data-role="method"
                    onClick={() => handlers.onBegin(method)}
                  >
                    {label(method)}
                  </button>
                </div>
                {method.description ? <span class={styles.meta}>{method.description}</span> : null}
              </li>
            ))}
          </ul>
          {session !== "none" ? (
            <div class={styles.signInActions}>
              <button
                type="button"
                class={styles.linkButton}
                data-role="signout"
                onClick={handlers.onSignOut}
              >
                {t("models.signIn.signOut")}
              </button>
            </div>
          ) : null}
        </>
      ) : null}
      {state.phase === "confirm" && state.method ? (
        <>
          <p class={styles.banner} data-tone="warn" role="alert" data-role="risk">
            {t("models.signIn.riskNotice")}
          </p>
          <div class={styles.signInActions}>
            <button
              type="button"
              class={styles.primary}
              data-role="confirm"
              onClick={handlers.onConfirm}
            >
              {t("models.signIn.riskConfirm")}
            </button>
            <button
              type="button"
              class={styles.secondary}
              data-role="dismiss"
              onClick={handlers.onDismiss}
            >
              {t("models.signIn.cancel")}
            </button>
          </div>
        </>
      ) : null}
      {working ? (
        <>
          <p class={styles.meta} role="status" data-role="waiting">
            {state.phase === "starting" ? t("models.signIn.starting") : t("models.signIn.waiting")}
          </p>
          <Steps steps={state.steps} handlers={handlers} />
          {state.prompt ? (
            <PromptForm
              key={state.prompt.id}
              profile={profile}
              prompt={state.prompt}
              handlers={handlers}
            />
          ) : null}
          <div class={styles.signInActions}>
            <button
              type="button"
              class={styles.secondary}
              data-role="cancel"
              onClick={handlers.onCancel}
            >
              {t("models.signIn.cancel")}
            </button>
          </div>
        </>
      ) : null}
      {state.phase === "interrupted" || state.phase === "failed" ? (
        <>
          {state.phase === "interrupted" ? (
            <p class={styles.errorText} role="alert" data-role="interrupted">
              {t("models.signIn.interrupted")}
            </p>
          ) : (
            <Failure failure={state.failure} />
          )}
          <div class={styles.signInActions}>
            {state.method ? (
              <button
                type="button"
                class={styles.primary}
                data-role="restart"
                onClick={() => state.method && handlers.onBegin(state.method)}
              >
                {t("models.signIn.startAgain")}
              </button>
            ) : null}
            <button
              type="button"
              class={styles.secondary}
              data-role="dismiss"
              onClick={handlers.onDismiss}
            >
              {t("models.signIn.dismiss")}
            </button>
          </div>
        </>
      ) : null}
    </section>
  );
}

export function ProviderSignIn(props: {
  profile: string;
  workspace: string;
  methods: ProviderAuthMethodInfo[];
  status?: CredentialStatus;
  /** The profile may have changed (a flow ended, the session was closed): fetch it again. */
  onChanged: () => void;
}) {
  const [state, setState] = useState<SignInState>(initialSignIn);
  const changed = useRef(props.onChanged);
  changed.current = props.onChanged;
  const controller = useMemo<SignInController>(
    () =>
      createSignInController({
        api,
        profile: props.profile,
        workspace: props.workspace,
        onState: setState,
        onFinished: (status) => {
          if (status === "succeeded") showToast(t("models.signIn.signedInToast"));
          // Fetch the profile again whatever the outcome: a late cancel does not undo a write.
          changed.current();
        },
      }),
    [props.profile, props.workspace],
  );
  useEffect(() => () => controller.dispose(), [controller]);
  const handlers: SignInHandlers = {
    onBegin: (method) => void controller.begin(method),
    onConfirm: () => void controller.confirm(),
    onDismiss: () => controller.dismiss(),
    onCancel: () => void controller.cancel(),
    onSubmit: (value) => void controller.submit(value),
    onOpen: (url) => {
      openExternal(url);
    },
    onCopy: (text) => {
      void copyText(text).then((ok) => ok && showToast(t("common.copied")));
    },
    onSignOut: () => {
      void api
        .deleteCredentials(props.profile)
        .then(() => showToast(t("models.signIn.signedOut")))
        .catch((error) => showToast(errorMessage(error)))
        .finally(() => changed.current());
    },
  };
  return (
    <SignInView
      profile={props.profile}
      methods={props.methods}
      status={props.status}
      state={state}
      handlers={handlers}
    />
  );
}
