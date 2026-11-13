/**
 * The last mile of Settings → MCP (specs/030 phase 4): the isolated connection check with its stages
 * and recovery actions (UX-07/08), the settings form with write-only keys (UX-06), the sign-in of a
 * remote service (OAuth) and the update of an installed package. The views are hook-free so the web
 * tests can walk them; the `*Panel` components are the thin stateful shells. All of it lives in a
 * lazy chunk: nothing here is in the initial bundle.
 */
import type {
  McpBindingConfiguration,
  McpBindingInfo,
  McpConnectionTestResult,
  McpInstallJob,
  McpInstallPlan,
  McpServerWire,
} from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale } from "../../../i18n/index.ts";
import { api } from "../../../store/app.ts";
import { Icon } from "../../icons.tsx";
import { ageLabel } from "../catalog-model.ts";
import { JobView } from "../mcp-install/InstallPanel.tsx";
import css from "../mcp-install/install.module.css";
import { type FieldErrorKey } from "../mcp-install/model.ts";
import { ms } from "../mcp-install/strings.ts";
import styles from "../settings.module.css";
import { errorMessage } from "../shared.tsx";
import {
  configDraftOf,
  configFieldsOf,
  configInitialValues,
  configPatchOf,
  type TestView,
  testViewOf,
  type UpdateView as UpdateViewModel,
  updateViewOf,
  validateConfig,
} from "./model.ts";

export * from "./SignIn.tsx";

import { countText, type ManageStringKey, mgs } from "./strings.ts";

const age = (iso: string) => ageLabel(Date.parse(iso), Date.now(), locale.value);

// ---- connection check ------------------------------------------------------------------------

export interface TestPanelViewProps {
  view: TestView;
  title: string;
  onRun: () => void;
  onCancel: () => void;
  onAction: (action: string) => void;
  onClose?: () => void;
}

const STAGE_ICON = { passed: "check", failed: "alert", skipped: undefined, pending: undefined };

/** Stages, then one result announced politely, with the next action for a failure. */
export function TestPanelView(props: TestPanelViewProps) {
  const { view } = props;
  const tone =
    view.state === "passed" && !view.stale
      ? "ok"
      : view.state === "failed"
        ? "danger"
        : view.state === "none" || view.state === "running"
          ? "info"
          : "warn";
  const counts = view.counts;
  return (
    <div class={css.panel} role="group" aria-label={props.title}>
      <h4 class={css.title}>{mgs("test.title")}</h4>
      <p class={css.hint}>{mgs("test.note")}</p>
      {view.steps.length ? (
        <ol class={css.steps} aria-label={mgs("test.stages")}>
          {view.steps.map((step) => (
            <li
              key={step.id}
              class={css.step}
              data-state={step.state === "passed" ? "done" : step.state}
            >
              <span class={css.mark}>
                {STAGE_ICON[step.state] ? (
                  <Icon name={STAGE_ICON[step.state] as "check" | "alert"} size={14} />
                ) : null}
              </span>
              {mgs(step.labelKey)}
              {" · "}
              <span>{mgs(`stage.${step.state}` as ManageStringKey)}</span>
            </li>
          ))}
        </ol>
      ) : null}
      <div class={css.result} data-tone={tone} role="status" aria-live="polite">
        <p class={css.headline}>{mgs(view.headlineKey)}</p>
        {view.state === "failed" && view.message ? <p class={css.details}>{view.message}</p> : null}
        {counts && view.state === "passed" ? (
          <p class={css.details}>
            {mgs("test.found", {
              tools: countText("tool", counts.tools),
              resources: countText("resource", counts.resources),
              prompts: countText("prompt", counts.prompts),
            })}
          </p>
        ) : null}
        {view.finishedAt ? (
          <p class={css.checked}>{mgs("test.checkedAt", { age: age(view.finishedAt) })}</p>
        ) : null}
        {view.state !== "passed" && view.lastPassedAt ? (
          <p class={css.checked}>{mgs("test.lastPassed", { age: age(view.lastPassedAt) })}</p>
        ) : null}
      </div>
      {view.state === "passed" ? <p class={css.hint}>{mgs("test.disclaimer")}</p> : null}
      <div class={css.actions}>
        {view.state === "running" ? (
          <button type="button" class={styles.secondary} onClick={props.onCancel}>
            {mgs("test.cancel")}
          </button>
        ) : (
          <>
            {view.recovery.map((button) => (
              <button
                key={button.action}
                type="button"
                class={styles.primary}
                onClick={() =>
                  button.action === "retry" ? props.onRun() : props.onAction(button.action)
                }
              >
                {mgs(button.labelKey)}
              </button>
            ))}
            {view.state === "none" || view.state === "passed" || view.state === "cancelled" ? (
              <button
                type="button"
                class={view.state === "none" ? styles.primary : styles.secondary}
                onClick={props.onRun}
              >
                {view.state === "none" ? mgs("test.run") : mgs("test.rerun")}
              </button>
            ) : null}
          </>
        )}
        {props.onClose ? (
          <button type="button" class={styles.secondary} onClick={props.onClose}>
            {mgs("test.close")}
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface TestPanelProps {
  workspaceId: string;
  /** Run the check as soon as the panel opens (the user pressed "Check connection"). */
  autoRun?: boolean;
  bindingId: string;
  name: string;
  /** The server's wire after a run (the row and its badges update). */
  onWire: (server: McpServerWire) => void;
  /** A recovery action that is not "try again" (sign in, change the key, configure, turn on). */
  onAction: (action: string) => void;
  onClose: () => void;
}

export function TestPanel(props: TestPanelProps) {
  const [result, setResult] = useState<McpConnectionTestResult | undefined>();
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const root = useRef<HTMLDivElement>(null);
  const q = `workspace=${encodeURIComponent(props.workspaceId)}`;
  const load = async () => {
    try {
      setResult(
        await api.request<McpConnectionTestResult>(
          "GET",
          `/api/mcp/bindings/${props.bindingId}/test?${q}`,
        ),
      );
    } catch {
      setResult(undefined);
    }
  };
  useEffect(() => {
    root.current?.querySelector<HTMLElement>("h4")?.focus();
    if (props.autoRun) void run();
    else void load();
  }, [props.bindingId]);
  const run = async () => {
    setRunning(true);
    setError(undefined);
    try {
      props.onWire(
        await api.request<McpServerWire>("POST", `/api/mcp/bindings/${props.bindingId}/test`, {
          workspace: props.workspaceId,
        }),
      );
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setRunning(false);
    }
  };
  const cancel = () =>
    void api
      .request("POST", `/api/mcp/bindings/${props.bindingId}/test/cancel`, {
        workspace: props.workspaceId,
      })
      .catch(() => undefined);
  return (
    <div ref={root}>
      <TestPanelView
        view={testViewOf(result, running)}
        title={props.name}
        onRun={() => void run()}
        onCancel={cancel}
        onAction={props.onAction}
        onClose={props.onClose}
      />
      {error ? (
        <p class={css.error} role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}

// ---- settings form ---------------------------------------------------------------------------

type ConfigError = FieldErrorKey | "err.server";

export interface ConfigureFormProps {
  config: McpBindingConfiguration;
  values: Record<string, string>;
  errors: Record<string, ConfigError>;
  revealed: Record<string, boolean>;
  /** Saved keys the user chose to replace (the password input is shown). */
  replacing: Record<string, boolean>;
  /** Saved keys that will be removed on save. */
  cleared?: string[];
  saving: boolean;
  conflict: boolean;
  /** Friendly name shown in the title (defaults to the alias). */
  name?: string;
  onValue: (id: string, value: string) => void;
  onBlur: (id: string) => void;
  onReveal: (id: string) => void;
  onReplace: (id: string) => void;
  onClearKey: (id: string) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onReload: () => void;
}

const errorText = (key: ConfigError) =>
  key === "err.server" ? mgs("config.serverField") : ms(key);

function ConfigField(props: {
  field: McpBindingConfiguration["fields"][number];
  value: string;
  error?: ConfigError;
  revealed: boolean;
  replacing: boolean;
  cleared: boolean;
  onValue: (value: string) => void;
  onBlur: () => void;
  onReveal: () => void;
  onReplace: () => void;
  onClearKey: () => void;
}) {
  const { field, error } = props;
  const id = `mcp-config-${field.id}`;
  const describedBy = [field.description ? `${id}-help` : "", error ? `${id}-error` : ""]
    .filter(Boolean)
    .join(" ");
  const shared = {
    id,
    class: css.control,
    "aria-required": field.required ? ("true" as const) : undefined,
    "aria-invalid": error ? ("true" as const) : undefined,
    "aria-describedby": describedBy || undefined,
    onBlur: props.onBlur,
  };
  let control: preact.JSX.Element;
  if (field.secret && field.configured && !props.replacing)
    control = (
      <div class={css.secretRow}>
        <span id={id} role="status">
          {props.cleared ? mgs("config.removed") : mgs("config.keySaved")}
        </span>
        <button type="button" class={css.reveal} onClick={props.onReplace}>
          {mgs("config.replace")}
        </button>
        {!field.required && !props.cleared ? (
          <button type="button" class={css.reveal} onClick={props.onClearKey}>
            {mgs("config.remove")}
          </button>
        ) : null}
      </div>
    );
  else if (field.secret)
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
          {props.revealed ? mgs("config.hide") : mgs("config.show")}
        </button>
        {field.configured ? (
          <button type="button" class={css.reveal} onClick={props.onReplace}>
            {mgs("config.keep")}
          </button>
        ) : null}
      </div>
    );
  else if (field.choices?.length)
    control = (
      <select
        {...shared}
        class={css.select}
        value={props.value}
        onChange={(event) => props.onValue((event.target as HTMLSelectElement).value)}
      >
        <option value="" />
        {field.choices.map((choice) => (
          <option key={choice} value={choice}>
            {choice}
          </option>
        ))}
      </select>
    );
  else
    control = (
      <input
        {...shared}
        type={field.format?.toLowerCase() === "number" ? "number" : "text"}
        autocomplete="off"
        value={props.value}
        onInput={(event) => props.onValue((event.target as HTMLInputElement).value)}
      />
    );
  return (
    <div class={css.field}>
      <label class={css.label} for={id}>
        {field.name}
        {field.required ? (
          <span class={css.required} aria-hidden="true">
            *
          </span>
        ) : (
          <span class={css.hint}> · {mgs("config.optional")}</span>
        )}
      </label>
      {field.description ? (
        <p id={`${id}-help`} class={css.hint}>
          {field.description}
        </p>
      ) : null}
      {control}
      {error ? (
        <p id={`${id}-error`} class={css.error} role="alert">
          {errorText(error)}
        </p>
      ) : null}
    </div>
  );
}

export function ConfigureForm(props: ConfigureFormProps) {
  const { config } = props;
  return (
    <form
      class={css.form}
      noValidate
      aria-labelledby="mcp-config-title"
      onSubmit={(event) => {
        event.preventDefault();
        props.onSubmit();
      }}
    >
      <h4 id="mcp-config-title" class={css.title} tabIndex={-1}>
        {mgs("config.title", { name: props.name ?? config.alias })}
      </h4>
      {config.fields.length ? (
        <p class={css.lead}>{mgs("config.lead")}</p>
      ) : (
        <p class={css.lead}>{mgs("config.nothing")}</p>
      )}
      {props.conflict ? (
        <div class={css.result} data-tone="warn" role="alert">
          <p class={css.headline}>{mgs("config.conflict")}</p>
          <button type="button" class={styles.secondary} onClick={props.onReload}>
            {mgs("config.reload")}
          </button>
        </div>
      ) : null}
      {config.fields.map((field) => (
        <ConfigField
          key={field.id}
          field={field}
          value={props.values[field.id] ?? ""}
          {...(props.errors[field.id] ? { error: props.errors[field.id] as ConfigError } : {})}
          revealed={!!props.revealed[field.id]}
          replacing={!!props.replacing[field.id]}
          cleared={!!props.cleared?.includes(field.id)}
          onValue={(value) => props.onValue(field.id, value)}
          onBlur={() => props.onBlur(field.id)}
          onReveal={() => props.onReveal(field.id)}
          onReplace={() => props.onReplace(field.id)}
          onClearKey={() => props.onClearKey(field.id)}
        />
      ))}
      {Object.keys(props.errors).length ? (
        <p class={css.error} role="alert">
          {mgs("config.fix")}
        </p>
      ) : null}
      <div class={css.actions}>
        <button
          type="submit"
          class={styles.primary}
          disabled={props.saving}
          aria-disabled={props.saving}
        >
          {props.saving ? mgs("config.saving") : mgs("config.save")}
        </button>
        <button type="button" class={styles.secondary} onClick={props.onCancel}>
          {mgs("config.cancel")}
        </button>
      </div>
    </form>
  );
}

export interface ConfigurePanelProps {
  workspaceId: string;
  name?: string;
  bindingId: string;
  onClose: () => void;
  /** Saved: the row refreshes and the connection is checked again. */
  onSaved: () => void;
}

export function ConfigurePanel(props: ConfigurePanelProps) {
  const [config, setConfig] = useState<McpBindingConfiguration | undefined>();
  const [values, setValues] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, ConfigError>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});
  const [cleared, setCleared] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [failure, setFailure] = useState<string | undefined>();
  const [loadFailed, setLoadFailed] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const draft = useRef<Record<string, string>>({});
  const q = `workspace=${encodeURIComponent(props.workspaceId)}`;
  const url = `/api/mcp/bindings/${props.bindingId}/configuration`;
  const load = async (keepDraft: boolean) => {
    try {
      const loaded = await api.request<McpBindingConfiguration>("GET", `${url}?${q}`);
      setConfig(loaded);
      setValues({ ...configInitialValues(loaded), ...(keepDraft ? draft.current : {}) });
      setErrors({});
      setReplacing({});
      setCleared([]);
      setConflict(false);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  };
  useEffect(() => {
    void load(false);
  }, [props.bindingId]);
  useEffect(() => {
    if (config) root.current?.querySelector<HTMLElement>("h4")?.focus();
  }, [config?.bindingId]);

  if (loadFailed)
    return (
      <p class={css.error} role="alert">
        {mgs("config.loadFailed")}
      </p>
    );
  if (!config) return <p class={css.hint}>{mgs("detail.loading")}</p>;

  const validate = (id?: string) => {
    const result = validateConfig(config, values);
    setErrors((current) => {
      if (!id) return Object.fromEntries(result.errors.map((e) => [e.id, e.key]));
      const next = { ...current };
      const found = result.errors.find((e) => e.id === id);
      if (found) next[id] = found.key;
      else delete next[id];
      return next;
    });
    return result;
  };
  const submit = async () => {
    const result = validate();
    if (result.first) {
      // Move focus to the first problem, keep every entry.
      queueMicrotask(() => document.getElementById(`mcp-config-${result.first}`)?.focus());
      return;
    }
    setSaving(true);
    setFailure(undefined);
    try {
      await api.request<McpBindingConfiguration>("PATCH", url, {
        workspace: props.workspaceId,
        revision: config.revision,
        ...configPatchOf(config, values, cleared),
      });
      props.onSaved();
    } catch (error) {
      const raw = error as { code?: string; details?: { fields?: string[] } };
      draft.current = configDraftOf(config, values);
      if (raw.code === "mcp_config_conflict") setConflict(true);
      else if (raw.details?.fields?.length)
        setErrors(Object.fromEntries(raw.details.fields.map((f) => [f, "err.server" as const])));
      else setFailure(errorMessage(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <div ref={root}>
      <ConfigureForm
        config={config}
        values={values}
        errors={errors}
        revealed={revealed}
        replacing={replacing}
        cleared={cleared}
        saving={saving}
        conflict={conflict}
        {...(props.name ? { name: props.name } : {})}
        onValue={(id, value) => setValues((current) => ({ ...current, [id]: value }))}
        onBlur={(id) => validate(id)}
        onReveal={(id) => setRevealed((current) => ({ ...current, [id]: !current[id] }))}
        onReplace={(id) => {
          setCleared((current) => current.filter((x) => x !== id));
          setReplacing((current) => ({ ...current, [id]: !current[id] }));
          setValues((current) => ({ ...current, [id]: "" }));
        }}
        onClearKey={(id) => setCleared((current) => [...current, id])}
        onSubmit={() => void submit()}
        onCancel={props.onClose}
        onReload={() => void load(true)}
      />
      {failure ? (
        <p class={css.error} role="alert">
          {failure}
        </p>
      ) : null}
    </div>
  );
}

// ---- update ----------------------------------------------------------------------------------

export interface UpdateViewProps {
  view: UpdateViewModel;
  name: string;
  consentNeeded: boolean;
  consent: boolean;
  busy: boolean;
  failed: boolean;
  onConsent: (allow: boolean) => void;
  onApply: () => void;
  onClose: () => void;
}

export function UpdateView(props: UpdateViewProps) {
  const { view } = props;
  const applyBlocked = props.busy || (props.consentNeeded && !props.consent);
  return (
    <div class={css.panel} role="group" aria-label={mgs("update.title", { name: props.name })}>
      <h4 class={css.title} tabIndex={-1}>
        {mgs("update.title", { name: props.name })}
      </h4>
      <div
        class={css.result}
        data-tone={props.failed ? "danger" : "info"}
        role="status"
        aria-live="polite"
      >
        {view.kind === "check" ? <p class={css.headline}>{mgs("update.checking")}</p> : null}
        {view.kind === "unavailable" ? <p class={css.headline}>{mgs("update.remote")}</p> : null}
        {view.kind === "up-to-date" ? (
          <p class={css.headline}>{mgs("update.upToDate", { version: view.version })}</p>
        ) : null}
        {view.kind === "available" ? (
          <p class={css.headline}>{mgs("update.available", { from: view.from, to: view.to })}</p>
        ) : null}
        {props.failed ? <p class={css.details}>{mgs("update.failed")}</p> : null}
      </div>
      {view.kind === "available" ? (
        <>
          <p class={css.hint}>{mgs("update.what")}</p>
          {props.consentNeeded ? (
            <label class={css.choice}>
              <input
                type="checkbox"
                checked={props.consent}
                onChange={(event) => props.onConsent((event.target as HTMLInputElement).checked)}
              />
              <span>{mgs("update.needConsent")}</span>
            </label>
          ) : null}
        </>
      ) : null}
      <div class={css.actions}>
        {view.kind === "available" ? (
          <button
            type="button"
            class={styles.primary}
            disabled={applyBlocked}
            aria-disabled={applyBlocked}
            onClick={props.onApply}
          >
            {props.busy ? mgs("update.working") : mgs("update.apply")}
          </button>
        ) : null}
        <button type="button" class={styles.secondary} onClick={props.onClose}>
          {mgs("update.close")}
        </button>
      </div>
    </div>
  );
}

export interface UpdatePanelProps {
  workspaceId: string;
  binding: McpBindingInfo;
  name: string;
  granted: boolean;
  onClose: () => void;
  onDone: () => void;
}

export function UpdatePanel(props: UpdatePanelProps) {
  const [plan, setPlan] = useState<McpInstallPlan | undefined>();
  const [job, setJob] = useState<McpInstallJob | undefined>();
  const [consent, setConsent] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const key = useRef(crypto.randomUUID());
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (props.binding.method !== "npm") return;
    void api
      .request<McpInstallPlan>("POST", `/api/mcp/bindings/${props.binding.id}/update-plan`, {
        workspace: props.workspaceId,
      })
      .then(setPlan)
      .catch(() => setFailed(true));
    root.current?.querySelector<HTMLElement>("h4")?.focus();
  }, [props.binding.id]);
  // Follow the job until it ends; the list refreshes when it does.
  useEffect(() => {
    if (!job || ["completed", "failed", "cancelled"].includes(job.state)) return;
    const timer = setInterval(() => {
      void api
        .request<McpInstallJob>("GET", `/api/mcp/install/jobs/${job.id}`)
        .then((next) => {
          setJob(next);
          if (["completed", "failed", "cancelled"].includes(next.state)) {
            setBusy(false);
            props.onDone();
          }
        })
        .catch(() => undefined);
    }, 800);
    return () => clearInterval(timer);
  }, [job?.id, job?.state]);
  const apply = async () => {
    if (!plan) return;
    setBusy(true);
    setFailed(false);
    try {
      setJob(
        await api.request<McpInstallJob>("POST", "/api/mcp/install/jobs", {
          workspace: props.workspaceId,
          planId: plan.planId,
          digest: plan.digest,
          idempotencyKey: key.current,
          ...(plan.requiresConsent && consent ? { consent: { confirmed: true } } : {}),
        }),
      );
    } catch {
      setFailed(true);
      setBusy(false);
    }
  };
  if (job)
    return (
      <JobView
        job={job}
        title={mgs("update.title", { name: props.name })}
        onCancel={() =>
          void api.request("POST", `/api/mcp/install/jobs/${job.id}/cancel`, {
            workspace: props.workspaceId,
          })
        }
        onClose={props.onClose}
        onRetry={() => {
          setJob(undefined);
          key.current = crypto.randomUUID();
        }}
        onTest={props.onClose}
        onConsent={() => setConsent(true)}
      />
    );
  return (
    <div ref={root}>
      <UpdateView
        view={updateViewOf(props.binding, plan)}
        name={props.name}
        consentNeeded={!!plan?.requiresConsent}
        consent={consent}
        busy={busy}
        failed={failed}
        onConsent={setConsent}
        onApply={() => void apply()}
        onClose={props.onClose}
      />
    </div>
  );
}
