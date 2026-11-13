/**
 * The install flow of one catalog entry (specs/030 phase 3, UX-04/05/06/07/08): plan, a single
 * compact form that asks only what cannot be decided (secret fields as password inputs, the
 * existing MCP consent integrated without preselecting permanent consent), then a job with clear
 * steps, cancel and a result with a next action. The parts are hook-free (`InstallForm`,
 * `JobView`) so the web tests can walk them; `InstallPanel` is the thin stateful shell. It lives in
 * a lazy chunk: nothing here is in the initial bundle.
 */
import type {
  McpCatalogItem,
  McpInstallInputInfo,
  McpInstallJob,
  McpInstallPlan,
} from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { api } from "../../../store/app.ts";
import { Icon } from "../../icons.tsx";
import { SignInPanel } from "../mcp-manage/SignIn.tsx";
import styles from "../settings.module.css";
import { errorMessage } from "../shared.tsx";
import css from "./install.module.css";
import {
  answersOf,
  draftOf,
  errorGuidance,
  type FieldErrorKey,
  fieldIssue,
  jobOutcome,
  jobSteps,
  type NextAction,
  type Scope,
  submitKey,
  validateInputs,
} from "./model.ts";
import { type InstallStringKey, ms } from "./strings.ts";

export interface PanelWorkspace {
  id: string;
  name: string;
}

// ---- hook-free parts ---------------------------------------------------------------------------

export interface InstallFormProps {
  plan: McpInstallPlan;
  values: Record<string, string>;
  errors: Record<string, FieldErrorKey>;
  revealed: Record<string, boolean>;
  consent: { allow: boolean; remember: boolean };
  showOptional: boolean;
  submitting: boolean;
  /** The text of the scope the entry will be added to (project name or all projects). */
  where: string;
  onValue: (id: string, value: string) => void;
  onBlur: (id: string) => void;
  onReveal: (id: string) => void;
  onConsent: (patch: Partial<{ allow: boolean; remember: boolean }>) => void;
  onToggleOptional: () => void;
  onSubmit: () => void;
  onCancel: () => void;
}

function Field(props: {
  input: McpInstallInputInfo;
  value: string;
  error?: FieldErrorKey;
  revealed: boolean;
  onValue: (value: string) => void;
  onBlur: () => void;
  onReveal: () => void;
}) {
  const { input, error } = props;
  const id = `mcp-field-${input.id}`;
  const describedBy = [input.description ? `${id}-help` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    class: css.control,
    "aria-required": input.required ? ("true" as const) : undefined,
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby": describedBy || undefined,
    onBlur: props.onBlur,
  };
  let control: preact.JSX.Element;
  if (input.choices?.length)
    control = (
      <select
        {...shared}
        class={css.select}
        value={props.value}
        onChange={(event) => props.onValue((event.target as HTMLSelectElement).value)}
      >
        <option value="" />
        {input.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  else if (input.format?.toLowerCase() === "boolean")
    control = (
      <select
        {...shared}
        class={css.select}
        value={props.value}
        onChange={(event) => props.onValue((event.target as HTMLSelectElement).value)}
      >
        <option value="" />
        <option value="true">true</option>
        <option value="false">false</option>
      </select>
    );
  else if (input.secret)
    control = (
      <div class={css.secretRow}>
        <input
          {...shared}
          type={props.revealed ? "text" : "password"}
          autocomplete="off"
          spellcheck={false}
          value={props.value}
          onInput={(event) => props.onValue((event.target as HTMLInputElement).value)}
        />
        <button
          type="button"
          class={css.reveal}
          aria-pressed={props.revealed}
          aria-controls={id}
          onClick={props.onReveal}
        >
          {props.revealed ? ms("form.hide") : ms("form.show")}
        </button>
      </div>
    );
  else
    control = (
      <input
        {...shared}
        type={input.format?.toLowerCase() === "number" ? "number" : "text"}
        autocomplete="off"
        value={props.value}
        onInput={(event) => props.onValue((event.target as HTMLInputElement).value)}
      />
    );
  return (
    <div class={css.field}>
      <label class={css.label} for={id}>
        {input.name}
        {input.required ? (
          <span class={css.required} aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {input.description ? (
        <p id={`${id}-help`} class={css.hint}>
          {input.description}
        </p>
      ) : null}
      {control}
      {error ? (
        <p id={`${id}-error`} class={css.error} role="alert">
          {ms(error)}
        </p>
      ) : null}
    </div>
  );
}

/** One compact form: required fields, optional ones collapsed, consent when it is missing. */
export function InstallForm(props: InstallFormProps) {
  const { plan } = props;
  const hasSecret = plan.requiredInputs.some((i) => i.secret);
  const title = plan.title ?? plan.registryName;
  const consentMissing = plan.requiresConsent && !props.consent.allow;
  return (
    <form
      class={css.form}
      noValidate
      aria-labelledby="mcp-install-title"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <h4 id="mcp-install-title" class={css.title}>
        {ms("form.title", { name: title })}
      </h4>
      <p class={css.summary}>
        {plan.execution === "remote" && plan.origin
          ? ms("form.summaryRemote", { origin: plan.origin })
          : ms("form.summaryLocal")}
        {" · "}
        {ms("form.addedTo", { where: props.where })}
      </p>
      {plan.requiredInputs.length ? <p class={css.lead}>{ms("form.lead")}</p> : null}
      {plan.requiredInputs.map((input) => (
        <Field
          key={input.id}
          input={input}
          value={props.values[input.id] ?? ""}
          {...(props.errors[input.id] ? { error: props.errors[input.id] as FieldErrorKey } : {})}
          revealed={!!props.revealed[input.id]}
          onValue={(value) => props.onValue(input.id, value)}
          onBlur={() => props.onBlur(input.id)}
          onReveal={() => props.onReveal(input.id)}
        />
      ))}
      {hasSecret ? <p class={css.hint}>{ms("form.secretHint")}</p> : null}
      {plan.optionalInputs.length ? (
        <div>
          <button
            type="button"
            class={styles.secondary}
            aria-expanded={props.showOptional}
            aria-controls="mcp-install-optional"
            onClick={props.onToggleOptional}
          >
            {ms("form.optional")}
          </button>
          {props.showOptional ? (
            <div id="mcp-install-optional" class={css.form}>
              {plan.optionalInputs.map((input) => (
                <Field
                  key={input.id}
                  input={input}
                  value={props.values[input.id] ?? input.default ?? ""}
                  {...(props.errors[input.id]
                    ? { error: props.errors[input.id] as FieldErrorKey }
                    : {})}
                  revealed={!!props.revealed[input.id]}
                  onValue={(value) => props.onValue(input.id, value)}
                  onBlur={() => props.onBlur(input.id)}
                  onReveal={() => props.onReveal(input.id)}
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
      {plan.requiresConsent ? (
        <fieldset class={css.fieldset}>
          <legend class={css.legend}>{ms("form.consentWhy")}</legend>
          <label class={css.choice}>
            <input
              id="mcp-install-consent"
              type="checkbox"
              checked={props.consent.allow}
              onChange={(event) =>
                props.onConsent({
                  allow: (event.target as HTMLInputElement).checked,
                  ...((event.target as HTMLInputElement).checked ? {} : { remember: false }),
                })
              }
            />
            <span>{ms("form.consentCheck")}</span>
          </label>
          {props.consent.allow ? (
            <label class={css.choice}>
              <input
                type="checkbox"
                checked={props.consent.remember}
                onChange={(event) =>
                  props.onConsent({ remember: (event.target as HTMLInputElement).checked })
                }
              />
              <span>{ms("form.consentRemember")}</span>
            </label>
          ) : null}
        </fieldset>
      ) : null}
      {Object.keys(props.errors).length ? (
        <p class={css.error} role="alert">
          {ms("form.fix")}
        </p>
      ) : null}
      <div class={css.actions}>
        <button
          type="submit"
          class={styles.primary}
          disabled={props.submitting || consentMissing}
          aria-disabled={props.submitting || consentMissing}
        >
          {ms(submitKey(plan.execution))}
        </button>
        <button type="button" class={styles.secondary} onClick={props.onCancel}>
          {ms("action.cancel")}
        </button>
      </div>
    </form>
  );
}

export interface JobViewProps {
  job: McpInstallJob;
  /** The label of the item being added. */
  title: string;
  /** The result of an extra "check connection" (null while it runs). */
  retest?: { status: string; diagnostic?: string } | null;
  onCancel: () => void;
  onClose: () => void;
  onRetry: () => void;
  onTest: () => void;
  onConsent: () => void;
  /** Starts the sign-in of a remote service that asked for one (OAuth). */
  onSignIn?: () => void;
  action?: { key: InstallStringKey; run: () => void };
}

/** Steps while it runs, then exactly one result with its next actions. */
export function JobView(props: JobViewProps) {
  const { job } = props;
  const outcome = jobOutcome(job);
  const done = outcome.kind !== "running" && outcome.kind !== "waiting-consent";
  const tone =
    outcome.kind === "connected"
      ? "ok"
      : outcome.kind === "failed"
        ? "danger"
        : outcome.kind === "cancelled"
          ? "info"
          : "warn";
  const counts = job.result?.counts;
  const failure = job.error ? errorGuidance(job.error.code, undefined) : undefined;
  const headline =
    outcome.kind === "connected"
      ? ms("outcome.connected", {
          tools: counts?.tools ?? 0,
          resources: counts?.resources ?? 0,
          prompts: counts?.prompts ?? 0,
        })
      : outcome.kind === "needs-attention"
        ? ms("outcome.needsAttention")
        : outcome.kind === "sign-in"
          ? ms("outcome.signIn")
          : outcome.kind === "cancelled"
            ? ms("outcome.cancelled")
            : outcome.kind === "failed"
              ? ms("outcome.failed")
              : "";
  const detail =
    outcome.kind === "failed"
      ? (job.error?.message ?? (failure ? ms(failure.textKey) : ""))
      : outcome.kind === "needs-attention"
        ? (job.result?.diagnostic ?? "")
        : "";
  return (
    <div class={css.panel} role="group" aria-label={props.title}>
      <h4 class={css.title}>{props.title}</h4>
      {!done ? (
        <>
          <ol class={css.steps} aria-label={ms("step.label")}>
            {jobSteps(job).map((step) => (
              <li key={step.id} class={css.step} data-state={step.state}>
                <span class={css.mark}>
                  {step.state === "done" ? <Icon name="check" size={14} /> : null}
                  {step.state === "active" ? <Icon name="refresh" size={14} /> : null}
                </span>
                {ms(`step.${step.id}` as InstallStringKey)}
              </li>
            ))}
          </ol>
          <p class={css.hint} role="status" aria-live="polite">
            {outcome.kind === "waiting-consent"
              ? ms("progress.waitingConsent")
              : ms("progress.working")}
          </p>
        </>
      ) : (
        <div class={css.result} data-tone={tone} role="status" aria-live="polite">
          <p class={css.headline}>{headline}</p>
          {detail ? <p class={css.details}>{detail}</p> : null}
          {props.retest ? (
            <p class={css.details}>
              {props.retest.status === "passed"
                ? ms("test.ready")
                : (props.retest.diagnostic ?? ms("test.attention"))}
            </p>
          ) : null}
          {props.action ? <p class={css.hint}>{ms(props.action.key)}</p> : null}
        </div>
      )}
      <div class={css.actions}>
        {outcome.actions.includes("cancel") ? (
          <button type="button" class={styles.secondary} onClick={props.onCancel}>
            {ms("action.cancel")}
          </button>
        ) : null}
        {outcome.kind === "waiting-consent" ? (
          <button type="button" class={styles.primary} onClick={props.onConsent}>
            {ms("form.consentCheck")}
          </button>
        ) : null}
        {outcome.actions.includes("test") ? (
          <button type="button" class={styles.primary} onClick={props.onTest}>
            {ms("action.test")}
          </button>
        ) : null}
        {outcome.actions.includes("sign-in") && props.onSignIn ? (
          <button type="button" class={styles.primary} onClick={props.onSignIn}>
            {ms("outcome.signInAction")}
          </button>
        ) : null}
        {outcome.actions.includes("retry") ? (
          <button type="button" class={styles.primary} onClick={props.onRetry}>
            {ms("action.retry")}
          </button>
        ) : null}
        {outcome.actions.includes("close") ? (
          <button type="button" class={styles.secondary} onClick={props.onClose}>
            {ms("action.close")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

// ---- stateful shell ----------------------------------------------------------------------------

type State =
  | { phase: "planning" }
  | {
      phase: "form";
      plan: McpInstallPlan;
      errors: Record<string, FieldErrorKey>;
      submitting: boolean;
    }
  | { phase: "running"; plan?: McpInstallPlan; job: McpInstallJob }
  | { phase: "error"; code: string; reason?: string; message: string };

interface ApiFailure {
  code: string;
  message: string;
  details?: { fields?: string[]; reason?: string };
}

/** The API error behind a thrown request (the client wraps it in an `Error` with the body). */
function failureOf(error: unknown): ApiFailure {
  const raw = error as { code?: string; details?: ApiFailure["details"]; message?: string };
  return {
    code: raw.code ?? "internal",
    message: raw.message ?? errorMessage(error),
    ...(raw.details ? { details: raw.details } : {}),
  };
}

// An install keeps running when the panel closes: coming back to the card resumes its progress.
const running = new Map<string, string>();

export interface InstallPanelProps {
  item: McpCatalogItem;
  scope: Scope;
  workspace: PanelWorkspace | undefined;
  /** The text of the scope shown in the form (project name or all projects). */
  where: string;
  onClose: () => void;
  onChooseGlobal: () => void;
}

export function InstallPanel(props: InstallPanelProps) {
  const { item, scope, workspace } = props;
  const key = `${item.name}|${scope}|${workspace?.id ?? ""}`;
  const [state, setState] = useState<State>({ phase: "planning" });
  const [values, setValues] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [consent, setConsent] = useState({ allow: false, remember: false });
  const [showOptional, setShowOptional] = useState(false);
  const [retest, setRetest] = useState<
    { status: string; diagnostic?: string } | null | undefined
  >();
  const [attempt, setAttempt] = useState(0);
  const [signingIn, setSigningIn] = useState(false);
  const idempotency = useRef<string>(crypto.randomUUID());
  const drafts = useRef<Record<string, string>>({});
  const root = useRef<HTMLDivElement>(null);

  const fail = (error: unknown) => {
    const failure = failureOf(error);
    setState({
      phase: "error",
      code: failure.code,
      ...(failure.details?.reason ? { reason: failure.details.reason } : {}),
      message: failure.message,
    });
  };

  const workspaceId = workspace?.id ?? "";

  // 1. Plan (or resume a job that is still running for this card).
  useEffect(() => {
    let alive = true;
    const resumed = running.get(key);
    if (resumed) {
      api.request<McpInstallJob>("GET", `/api/mcp/install/jobs/${resumed}`).then(
        (job) => alive && setState({ phase: "running", job }),
        () => {
          running.delete(key);
          if (alive) setAttempt((n) => n + 1);
        },
      );
      return () => {
        alive = false;
      };
    }
    setState({ phase: "planning" });
    api
      .request<McpInstallPlan>("POST", "/api/mcp/install/plans", {
        workspace: workspaceId,
        name: item.name,
        version: item.version,
        scope,
      })
      .then(
        (plan) => {
          if (!alive) return;
          idempotency.current = crypto.randomUUID();
          const initial: Record<string, string> = { ...drafts.current };
          for (const input of plan.optionalInputs)
            if (input.default !== undefined && initial[input.id] === undefined)
              initial[input.id] = input.default;
          setValues(initial);
          // Nothing to ask and nothing to authorize: one click is enough (UX-04).
          if (!plan.requiredInputs.length && !plan.requiresConsent) {
            setState({ phase: "form", plan, errors: {}, submitting: true });
            void start(plan, initial, { allow: false, remember: false });
          } else setState({ phase: "form", plan, errors: {}, submitting: false });
        },
        (error: unknown) => alive && fail(error),
      );
    return () => {
      alive = false;
    };
  }, [key, attempt]);

  // 2. Follow a running job until it ends.
  const jobId = state.phase === "running" ? state.job.id : undefined;
  const terminal =
    state.phase === "running" && ["completed", "failed", "cancelled"].includes(state.job.state);
  useEffect(() => {
    if (!jobId || terminal) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const job = await api.request<McpInstallJob>("GET", `/api/mcp/install/jobs/${jobId}`);
        if (!alive) return;
        setState((current) => (current.phase === "running" ? { ...current, job } : current));
        if (["completed", "failed", "cancelled"].includes(job.state)) {
          running.delete(key);
          return;
        }
      } catch {
        /* a missed poll is retried */
      }
      timer = setTimeout(tick, 700);
    };
    timer = setTimeout(tick, 400);
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, terminal]);

  // Focus moves to the panel when it changes phase (keyboard and screen-reader users).
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("input, select, button, h4")?.focus?.();
  }, [state.phase]);

  async function start(
    plan: McpInstallPlan,
    answers: Record<string, string>,
    allow: { allow: boolean; remember: boolean },
  ) {
    try {
      const fields = [...plan.requiredInputs, ...plan.optionalInputs];
      const job = await api.request<McpInstallJob>("POST", "/api/mcp/install/jobs", {
        workspace: workspaceId,
        planId: plan.planId,
        digest: plan.digest,
        idempotencyKey: idempotency.current,
        inputs: answersOf(fields, answers),
        ...(plan.requiresConsent && allow.allow
          ? { consent: { confirmed: true, ...(allow.remember ? { remember: true } : {}) } }
          : {}),
      });
      running.set(key, job.id);
      setState({ phase: "running", plan, job });
    } catch (error) {
      const failure = failureOf(error);
      if (failure.code === "mcp_input_required" && failure.details?.fields) {
        const errors: Record<string, FieldErrorKey> = {};
        for (const id of failure.details.fields) errors[id] = "err.required";
        setState({ phase: "form", plan, errors, submitting: false });
        return;
      }
      fail(error);
    }
  }

  const submit = () => {
    if (state.phase !== "form") return;
    const { plan } = state;
    const fields = [...plan.requiredInputs, ...plan.optionalInputs];
    const result = validateInputs(fields, values);
    if (result.errors.length) {
      setState({
        ...state,
        errors: Object.fromEntries(result.errors.map((e) => [e.id, e.key])),
      });
      queueMicrotask(() => document.getElementById(`mcp-field-${result.first}`)?.focus());
      return;
    }
    drafts.current = draftOf(fields, values);
    setState({ ...state, errors: {}, submitting: true });
    void start(plan, values, consent);
  };

  const change = (id: string, value: string) => {
    setValues((current) => ({ ...current, [id]: value }));
    // No error while typing: it is cleared now and judged again when the field is left.
    setState((current) => {
      if (current.phase !== "form" || !current.errors[id]) return current;
      const { [id]: _gone, ...rest } = current.errors;
      return { ...current, errors: rest };
    });
  };

  const blur = (id: string) => {
    if (state.phase !== "form") return;
    const field = [...state.plan.requiredInputs, ...state.plan.optionalInputs].find(
      (i) => i.id === id,
    );
    if (!field) return;
    const issue = fieldIssue(field, values[id] ?? "");
    setState((current) => {
      if (current.phase !== "form") return current;
      const { [id]: _gone, ...rest } = current.errors;
      return { ...current, errors: issue ? { ...rest, [id]: issue } : rest };
    });
  };

  const cancelJob = async () => {
    if (state.phase !== "running") return;
    try {
      const job = await api.request<McpInstallJob>(
        "POST",
        `/api/mcp/install/jobs/${state.job.id}/cancel`,
        { workspace: workspaceId },
      );
      running.delete(key);
      setState({ ...state, job });
    } catch (error) {
      fail(error);
    }
  };

  const allowRunning = async () => {
    if (state.phase !== "running") return;
    try {
      const job = await api.request<McpInstallJob>(
        "POST",
        `/api/mcp/install/jobs/${state.job.id}/consent`,
        { workspace: workspaceId, confirmed: true },
      );
      setState({ ...state, job });
    } catch (error) {
      fail(error);
    }
  };

  const test = async () => {
    if (state.phase !== "running" || !state.job.bindingId) return;
    setRetest(null);
    try {
      const wire = await api.request<{
        binding?: { lastTest?: { status: string; diagnostic?: string } };
      }>("POST", `/api/mcp/bindings/${state.job.bindingId}/test`, { workspace: workspaceId });
      setRetest(wire.binding?.lastTest ?? { status: "failed" });
    } catch (error) {
      setRetest({ status: "failed", diagnostic: errorMessage(error) });
    }
  };

  const title = item.title ?? item.name;

  return (
    <div ref={root} class={css.panel}>
      {state.phase === "planning" ? (
        <p class={css.hint} role="status">
          {ms("progress.working")}
        </p>
      ) : null}
      {state.phase === "form" ? (
        <InstallForm
          plan={state.plan}
          values={values}
          errors={state.errors}
          revealed={revealed}
          consent={consent}
          showOptional={showOptional}
          submitting={state.submitting}
          where={props.where}
          onValue={change}
          onBlur={blur}
          onReveal={(id) => setRevealed((current) => ({ ...current, [id]: !current[id] }))}
          onConsent={(patch) => setConsent((current) => ({ ...current, ...patch }))}
          onToggleOptional={() => setShowOptional((v) => !v)}
          onSubmit={submit}
          onCancel={props.onClose}
        />
      ) : null}
      {state.phase === "running" && signingIn && state.job.bindingId && workspace ? (
        <SignInPanel
          workspaceId={workspace.id}
          bindingId={state.job.bindingId}
          name={title}
          autoStart
          onClose={() => {
            setSigningIn(false);
            props.onClose();
          }}
          onFinished={() => undefined}
        />
      ) : state.phase === "running" ? (
        <JobView
          job={state.job}
          title={title}
          retest={retest}
          onCancel={() => void cancelJob()}
          onClose={props.onClose}
          onRetry={() => {
            running.delete(key);
            idempotency.current = crypto.randomUUID();
            setAttempt((n) => n + 1);
          }}
          onTest={() => void test()}
          onConsent={() => void allowRunning()}
          onSignIn={() => setSigningIn(true)}
        />
      ) : null}
      {state.phase === "error" ? (
        <ErrorView
          code={state.code}
          {...(state.reason ? { reason: state.reason } : {})}
          message={state.message}
          onClose={props.onClose}
          onAction={(action: NextAction) => {
            if (action === "choose-global") props.onChooseGlobal();
            else if (action !== "manual" && action !== "none") {
              running.delete(key);
              setAttempt((n) => n + 1);
            }
          }}
        />
      ) : null}
    </div>
  );
}

const ACTION_LABEL: Record<Exclude<NextAction, "manual" | "none">, InstallStringKey> = {
  retry: "action.retry",
  replan: "action.review",
  "choose-global": "action.global",
  recheck: "action.recheck",
};

export function ErrorView(props: {
  code: string;
  reason?: string;
  message: string;
  onClose: () => void;
  onAction: (action: NextAction) => void;
}) {
  const guidance = errorGuidance(props.code, props.reason);
  return (
    <div class={css.result} data-tone="danger" role="alert">
      <p class={css.headline}>{ms("outcome.failed")}</p>
      <p class={css.details}>{ms(guidance.textKey)}</p>
      <div class={css.actions}>
        {guidance.action !== "manual" && guidance.action !== "none" ? (
          <button
            type="button"
            class={styles.primary}
            onClick={() => props.onAction(guidance.action)}
          >
            {ms(ACTION_LABEL[guidance.action])}
          </button>
        ) : null}
        <button type="button" class={styles.secondary} onClick={props.onClose}>
          {ms("action.close")}
        </button>
      </div>
    </div>
  );
}
