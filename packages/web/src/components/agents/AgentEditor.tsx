/**
 * Agent editor (Agents › New agent / Agents › <name>): Setup and Sessions tabs. Setup has the
 * definition and capability-driven model settings on the left, and the live "Agent config"
 * request plus the getting-started steps on the right. "Create with Alisio" lets the ACTIVE
 * model write (or refine) the instructions, then a new agent is saved and can be tried at once.
 */
import type { AgentDefinitionsOverview, AgentModelOption, AgentScope } from "@alisio/sdk";
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { type MessageKey, t } from "../../i18n/index.ts";
import {
  type AgentForm,
  agentConfigSnippet,
  canSave,
  capabilitiesFor,
  dismissGettingStarted,
  fitForm,
  formFromDefinition,
  formFromDraft,
  formKey,
  formToInput,
  gettingStartedDismissed,
  gettingStartedSteps,
  nameError,
  SUMMARIES,
  scopeDirLabel,
  TEXT_FORMATS,
  tokenize,
  VERBOSITIES,
} from "../../store/agents.ts";
import {
  agentsOpen,
  api,
  openSession,
  reloadSidebar,
  setWorkspaceTrust,
  showToast,
  startSessionWithAgent,
} from "../../store/app.ts";
import { errorText } from "../../store/errors.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import { Status, useLoad } from "../settings/shared.tsx";
import styles from "./agents.module.css";

const LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh"]);
const levelLabel = (level: string) =>
  LEVELS.has(level) ? t(`agentsWin.level.${level}` as MessageKey) : level;

function Section(props: { title: string; children: ComponentChildren }) {
  const [open, setOpen] = useState(true);
  return (
    <section class={styles.section}>
      <button
        type="button"
        class={styles.sectionHead}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={15} />
        {props.title}
      </button>
      {open ? <div class={styles.sectionBody}>{props.children}</div> : null}
    </section>
  );
}

function Field(props: {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: ComponentChildren;
}) {
  return (
    <label class={styles.field}>
      <span class={styles.fieldLabel}>
        {props.label}
        {props.hint ? <span class={styles.fieldHint}>{props.hint}</span> : null}
      </span>
      {props.children}
      {props.error ? <span class={styles.fieldError}>{props.error}</span> : null}
    </label>
  );
}

function ConfigPanel(props: { text: string }) {
  const lines = props.text.split("\n");
  return (
    <section class={styles.code} aria-label={t("agentsWin.config")}>
      <div class={styles.codeHead}>
        <span>{t("agentsWin.config")}</span>
        <CopyButton text={() => props.text} label={t("agentsWin.configCopy")} />
      </div>
      <p class={settings.note} style={{ margin: "8px 16px 0" }}>
        {t("agentsWin.configLead")}
      </p>
      <pre class={styles.codeBody}>
        <code>
          {lines.map((line, index) => (
            <span key={index} class={styles.codeLine}>
              <span class={styles.lineNo} aria-hidden="true">
                {index + 1}
              </span>
              <span>
                {tokenize(line).map((token, i) => (
                  <span key={i} class={styles[`tok-${token.kind}`]}>
                    {token.text}
                  </span>
                ))}
              </span>
            </span>
          ))}
        </code>
      </pre>
    </section>
  );
}

function Building(props: { model: string; started: number; onCancel: () => void }) {
  const [now, setNow] = useState(Date.now());
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    cancel.current?.focus();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div
      class={styles.overlay}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="building-title"
      aria-describedby="building-body"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onCancel();
        }
      }}
    >
      <div class={styles.overlayCard}>
        <div class={styles.spinner} aria-hidden="true" />
        <h3 class={styles.overlayTitle} id="building-title">
          {t("agentsWin.building")}
        </h3>
        <p class={settings.note} id="building-body" role="status">
          {t("agentsWin.buildingBody", { model: props.model })}
        </p>
        <div class={styles.progress} aria-hidden="true">
          <div class={styles.progressBar} />
        </div>
        <p class={settings.meta}>
          {t("agentsWin.buildingElapsed", {
            seconds: Math.max(0, Math.round((now - props.started) / 1000)),
          })}
        </p>
        <div class={styles.overlayActions}>
          <button ref={cancel} type="button" class={settings.secondary} onClick={props.onCancel}>
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Created(props: { name: string; live: boolean; onTry: () => void; onStay: () => void }) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => first.current?.focus(), []);
  return (
    <div
      class={styles.overlay}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="created-title"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          props.onStay();
        }
      }}
    >
      <div class={styles.overlayCard}>
        <h3 class={styles.overlayTitle} id="created-title">
          {t("agentsWin.createdTitle", { name: props.name })}
        </h3>
        <p class={settings.note}>
          {props.live ? t("agentsWin.createdBody") : t("agentsWin.createdRestart")}
        </p>
        <div class={styles.overlayActions}>
          {props.live ? (
            <button ref={first} type="button" class={settings.primary} onClick={props.onTry}>
              {t("agentsWin.tryIt")}
            </button>
          ) : null}
          <button
            ref={props.live ? undefined : first}
            type="button"
            class={settings.secondary}
            onClick={props.onStay}
          >
            {t("agentsWin.stay")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function AgentEditor(props: {
  initial: AgentForm;
  saved?: AgentForm;
  assist: boolean;
  workspace: { id: string; path: string } | undefined;
  overview: AgentDefinitionsOverview | undefined;
  models: AgentModelOption[] | undefined;
  modelsError: string | undefined;
  onDirty: (dirty: boolean) => void;
  onSaved: (form: AgentForm) => void;
  /** The workspace was trusted from the editor: reload what depends on it. */
  onTrusted: () => void;
}) {
  const { workspace, models } = props;
  const [form, setForm] = useState<AgentForm>(props.initial);
  const [saved, setSaved] = useState<AgentForm | undefined>(props.saved);
  const [tab, setTab] = useState<"setup" | "sessions">("setup");
  const [assistText, setAssistText] = useState("");
  const [building, setBuilding] = useState<
    { controller: AbortController; started: number } | undefined
  >();
  const [buildError, setBuildError] = useState<string | undefined>();
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<{ form: AgentForm; live: boolean } | undefined>();
  const [guide, setGuide] = useState(!gettingStartedDismissed());

  // A new form starts on the active model once the model list arrives.
  useEffect(() => {
    if (!form.model && models?.length) {
      const active = models.find((m) => m.active) ?? models[0];
      if (active) setForm((f) => fitForm({ ...f, model: active.reference }, active.capabilities));
    }
  }, [models]);
  const dirty = !saved || formKey(form) !== formKey(saved);
  useEffect(() => props.onDirty(dirty && !!saved), [dirty, saved]);

  const caps = capabilitiesFor(models, form.model);
  const sessions = useLoad(
    saved?.id ? () => api.agentSessions(saved.id as string) : undefined,
    [saved?.id],
    ["agents"],
  );
  const scopes: AgentScope[] =
    props.overview?.scopes ?? (workspace ? ["project", "global"] : ["global"]);
  const set = (patch: Partial<AgentForm>) => setForm((f) => ({ ...f, ...patch }));
  const snippet = useMemo(
    () =>
      agentConfigSnippet(form, {
        origin: typeof location !== "undefined" ? location.origin : "http://127.0.0.1:4096",
        ...(workspace ? { workspace: workspace.id } : {}),
      }),
    [form, workspace?.id],
  );
  const activeModelName = models?.find((m) => m.active)?.id ?? "Alisio";
  const refine = !!form.instructions.trim();

  const save = async (next: AgentForm): Promise<void> => {
    setSaving(true);
    try {
      const body = {
        ...formToInput(next),
        scope: next.scope,
        ...(workspace ? { workspace: workspace.id } : {}),
      };
      const result = next.id ? await api.updateAgent(next.id, body) : await api.createAgent(body);
      const stored = formFromDefinition(result.agent);
      setForm(stored);
      setSaved(stored);
      props.onSaved(stored);
      // A first project agent can make the workspace show "untrusted" in the sidebar.
      if (next.scope === "project") void reloadSidebar();
      showToast(t(result.live ? "agentsWin.saved" : "agentsWin.savedRestart"));
      if (!next.id) setCreated({ form: stored, live: result.live });
    } catch (error) {
      showToast(t("agentsWin.saveFailed", { message: errorText(error) }));
    } finally {
      setSaving(false);
    }
  };

  /** "Building with Alisio": draft or refine with the active model; a new agent is then saved. */
  const build = async () => {
    if (!workspace) return;
    const controller = new AbortController();
    setBuildError(undefined);
    setBuilding({ controller, started: Date.now() });
    let next: AgentForm | undefined;
    try {
      const draft = await api.draftAgent(
        {
          workspace: workspace.id,
          description: assistText.trim(),
          ...(refine
            ? {
                base: {
                  name: form.name,
                  description: form.description,
                  instructions: form.instructions,
                },
              }
            : {}),
        },
        controller.signal,
      );
      next = fitForm(formFromDraft(form, draft), caps);
      setForm(next);
      setAssistText("");
      showToast(t("agentsWin.buildDone", { model: draft.generatedBy, guidance: draft.guidance }));
    } catch (error) {
      if (!controller.signal.aborted) setBuildError(errorText(error));
    } finally {
      setBuilding(undefined);
    }
    // Creating: the drafted agent is saved right away, then it can be tried.
    if (next && !next.id && canSave(next, undefined)) await save(next);
  };

  const nameProblem = nameError(form.name);
  const steps = gettingStartedSteps({
    saved: !!saved?.id,
    workspace: !!workspace,
    sessions: sessions.data?.items ?? [],
  });
  const stepText: Record<string, [MessageKey, MessageKey]> = {
    define: ["agentsWin.step.define", "agentsWin.step.defineBody"],
    runtime: ["agentsWin.step.runtime", "agentsWin.step.runtimeBody"],
    session: ["agentsWin.step.session", "agentsWin.step.sessionBody"],
    events: ["agentsWin.step.events", "agentsWin.step.eventsBody"],
  };
  const tryIt = async (target: AgentForm) => {
    if (!workspace || !target.id) return;
    const ok = await startSessionWithAgent(workspace.id, target.id, target.model || undefined);
    if (ok) agentsOpen.value = false;
  };

  return (
    <div style={{ position: "relative" }}>
      <div class={settings.tabs} role="tablist" aria-label={t("agentsWin.title")}>
        {(["setup", "sessions"] as const).map((id) => (
          <button
            key={id}
            type="button"
            role="tab"
            class={settings.tab}
            aria-selected={tab === id}
            onClick={() => setTab(id)}
          >
            {t(`agentsWin.${id}`)}
          </button>
        ))}
      </div>
      {tab === "sessions" ? (
        <div role="tabpanel">
          {!saved?.id ? (
            <p class={settings.note}>{t("agentsWin.sessionsUnsaved")}</p>
          ) : (
            <>
              <Status loading={sessions.loading && !sessions.data} error={sessions.error} />
              {sessions.data && !sessions.data.items.length ? (
                <p class={settings.note}>{t("agentsWin.sessionsEmpty")}</p>
              ) : null}
              <ul class={settings.rows}>
                {(sessions.data?.items ?? []).map((session) => (
                  <li key={session.id} class={settings.row}>
                    <button
                      type="button"
                      class={styles.rowButton}
                      onClick={() => {
                        agentsOpen.value = false;
                        void openSession(session.id);
                      }}
                    >
                      <span class={settings.cardName}>
                        {session.title ?? t("agentsWin.untitled")}
                      </span>
                      <p class={settings.meta}>
                        {session.model} · {session.workspace}
                      </p>
                    </button>
                  </li>
                ))}
              </ul>
              {workspace ? (
                <button
                  type="button"
                  class={`${settings.primary} ${settings.addButton}`}
                  onClick={() => void tryIt(saved)}
                >
                  {t("agentsWin.startSession")}
                </button>
              ) : (
                <p class={settings.note}>{t("agentsWin.noWorkspace")}</p>
              )}
            </>
          )}
        </div>
      ) : (
        <div class={styles.columns} role="tabpanel">
          <div class={styles.column}>
            {workspace ? (
              <section class={styles.assist} aria-labelledby="assist-title">
                <h4 class={styles.assistTitle} id="assist-title">
                  <Icon name="sparkle" size={16} />
                  {refine ? t("agentsWin.assistRefine") : t("agentsWin.assistTitle")}
                </h4>
                <p class={settings.note}>
                  {refine ? t("agentsWin.assistRefineLead") : t("agentsWin.assistLead")}
                </p>
                <textarea
                  class={styles.control}
                  style={{ minHeight: "64px" }}
                  value={assistText}
                  placeholder={t("agentsWin.assistPlaceholder")}
                  aria-label={t("agentsWin.assistTitle")}
                  maxLength={2000}
                  onInput={(event) => setAssistText((event.target as HTMLTextAreaElement).value)}
                />
                {buildError ? (
                  <p class={settings.errorText} role="alert">
                    {t("agentsWin.buildFailed", { message: buildError })}
                  </p>
                ) : null}
                <div class={styles.assistActions}>
                  <button
                    type="button"
                    class={settings.primary}
                    disabled={!!building || (!refine && !assistText.trim())}
                    onClick={() => void build()}
                  >
                    {refine ? t("agentsWin.assistRefine") : t("agentsWin.assistCreate")}
                  </button>
                </div>
              </section>
            ) : null}
            <Section title={t("agentsWin.definition")}>
              <Field
                label={t("agentsWin.name")}
                error={nameProblem ? t(`agentsWin.nameError.${nameProblem}`) : undefined}
              >
                <input
                  class={styles.control}
                  value={form.name}
                  maxLength={80}
                  aria-invalid={nameProblem ? "true" : undefined}
                  onInput={(event) => set({ name: (event.target as HTMLInputElement).value })}
                />
              </Field>
              <Field label={t("agentsWin.description")}>
                <input
                  class={styles.control}
                  value={form.description}
                  maxLength={300}
                  placeholder={t("agentsWin.descriptionPlaceholder")}
                  onInput={(event) =>
                    set({ description: (event.target as HTMLInputElement).value })
                  }
                />
              </Field>
              <Field
                label={t("agentsWin.instructions")}
                hint={`${form.instructions.length} / 24000`}
              >
                <textarea
                  class={styles.control}
                  value={form.instructions}
                  maxLength={24_000}
                  placeholder={t("agentsWin.instructionsPlaceholder")}
                  onInput={(event) =>
                    set({ instructions: (event.target as HTMLTextAreaElement).value })
                  }
                />
              </Field>
              {!form.id && scopes.length > 1 ? (
                <Field label={t("agentsWin.scope")} hint={t("agentsWin.scopeHint")}>
                  <select
                    class={styles.control}
                    value={form.scope}
                    title={props.overview?.dirs[form.scope] ?? ""}
                    onChange={(event) =>
                      set({ scope: (event.target as HTMLSelectElement).value as AgentScope })
                    }
                  >
                    {scopes.map((scope) => (
                      <option key={scope} value={scope} title={props.overview?.dirs[scope] ?? ""}>
                        {t(`agentsWin.scope.${scope}`)}
                        {props.overview?.dirs[scope]
                          ? ` — ${scopeDirLabel(scope, props.overview.dirs[scope])}`
                          : ""}
                      </option>
                    ))}
                  </select>
                </Field>
              ) : (
                <p class={settings.meta}>
                  {t("agentsWin.scope")}: {t(`agentsWin.scope.${form.scope}`)}
                </p>
              )}
              {form.scope === "project" && props.overview && !props.overview.trusted ? (
                <div class={settings.callout} role="note">
                  <Icon name="shield" size={16} />
                  <div class={settings.stack}>
                    <span>{t("agentsWin.scopeUntrusted")}</span>
                    {workspace ? (
                      <button
                        type="button"
                        class={settings.secondary}
                        style={{ justifySelf: "start" }}
                        onClick={async () => {
                          if (await setWorkspaceTrust(workspace, true)) props.onTrusted();
                        }}
                      >
                        {t("trust.grant")}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </Section>
            <Section title={t("agentsWin.modelSection")}>
              <Field label={t("agentsWin.model")}>
                <select
                  class={styles.control}
                  value={form.model}
                  onChange={(event) => {
                    const model = (event.target as HTMLSelectElement).value;
                    setForm((f) => fitForm({ ...f, model }, capabilitiesFor(models, model)));
                  }}
                >
                  <option value="" disabled>
                    {t("agentsWin.chooseModel")}
                  </option>
                  {form.model && !models?.some((m) => m.reference === form.model) ? (
                    <option value={form.model}>{form.model}</option>
                  ) : null}
                  {(models ?? []).map((m) => (
                    <option key={m.reference} value={m.reference}>
                      {m.active
                        ? t("agentsWin.modelActive", { name: m.name ?? m.id })
                        : (m.name ?? m.id)}{" "}
                      · {m.providerName}
                      {m.labels.length ? ` — ${m.labels.join(" · ")}` : ""}
                    </option>
                  ))}
                </select>
              </Field>
              {props.modelsError ? (
                <p class={settings.errorText}>{props.modelsError}</p>
              ) : !caps.known ? (
                <p class={styles.fieldHint}>{t("agentsWin.capsUnknown")}</p>
              ) : null}
              <div class={styles.settingsGrid}>
                <Field label={t("agentsWin.textFormat")}>
                  <select
                    class={styles.control}
                    value={form.format}
                    onChange={(event) =>
                      set({
                        format: (event.target as HTMLSelectElement).value as AgentForm["format"],
                      })
                    }
                  >
                    {TEXT_FORMATS.filter((f) => caps.textFormats.includes(f)).map((f) => (
                      <option key={f} value={f}>
                        {t(`agentsWin.format.${f}`)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("agentsWin.effort")}
                  hint={caps.reasoning ? undefined : t("agentsWin.unsupported")}
                >
                  <select
                    class={styles.control}
                    value={form.effort}
                    disabled={!caps.reasoning}
                    onChange={(event) => set({ effort: (event.target as HTMLSelectElement).value })}
                  >
                    <option value="">
                      {t("agentsWin.modelDefault")}
                      {caps.defaultEffort ? ` (${levelLabel(caps.defaultEffort)})` : ""}
                    </option>
                    {caps.effortLevels.map((level) => (
                      <option key={level} value={level}>
                        {levelLabel(level)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("agentsWin.verbosity")}
                  hint={caps.verbosity ? undefined : t("agentsWin.unsupported")}
                >
                  <select
                    class={styles.control}
                    value={form.verbosity}
                    disabled={!caps.verbosity}
                    onChange={(event) =>
                      set({
                        verbosity: (event.target as HTMLSelectElement)
                          .value as AgentForm["verbosity"],
                      })
                    }
                  >
                    <option value="">{t("agentsWin.modelDefault")}</option>
                    {VERBOSITIES.map((v) => (
                      <option key={v} value={v}>
                        {levelLabel(v)}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field
                  label={t("agentsWin.summary")}
                  hint={caps.summary ? undefined : t("agentsWin.unsupported")}
                >
                  <select
                    class={styles.control}
                    value={form.summary}
                    disabled={!caps.summary}
                    onChange={(event) =>
                      set({
                        summary: (event.target as HTMLSelectElement).value as AgentForm["summary"],
                      })
                    }
                  >
                    <option value="">{t("agentsWin.modelDefault")}</option>
                    {SUMMARIES.map((s) => (
                      <option key={s} value={s}>
                        {t(`agentsWin.summary.${s}`)}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
            </Section>
            <button
              type="button"
              class={`${settings.primary} ${styles.saveButton}`}
              disabled={saving || !!building || !canSave(form, saved)}
              onClick={() => void save(form)}
            >
              {t("agentsWin.save")}
            </button>
          </div>
          <div class={styles.column}>
            <ConfigPanel text={snippet} />
            {guide ? (
              <section class={styles.stepper} aria-labelledby="getting-started">
                <h4 class={styles.stepperHead} id="getting-started">
                  {t("agentsWin.gettingStarted")}
                  <button
                    type="button"
                    class="icon-btn"
                    aria-label={t("agentsWin.dismiss")}
                    title={t("agentsWin.dismiss")}
                    onClick={() => {
                      dismissGettingStarted();
                      setGuide(false);
                    }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                </h4>
                <ol class={styles.steps}>
                  {steps.map((step, index) => {
                    const [title, body] = stepText[step.id] as [MessageKey, MessageKey];
                    return (
                      <li key={step.id} class={styles.step} data-done={step.done}>
                        <span class={styles.stepNode} aria-hidden="true">
                          {step.done ? "✓" : index + 1}
                        </span>
                        <div>
                          <p class={styles.stepTitle}>
                            {t(title)}
                            <span class="sr-only">{step.done ? " ✓" : ""}</span>
                          </p>
                          <p class={styles.stepText}>{t(body)}</p>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              </section>
            ) : null}
          </div>
        </div>
      )}
      {building ? (
        <Building
          model={activeModelName}
          started={building.started}
          onCancel={() => building.controller.abort()}
        />
      ) : null}
      {created ? (
        <Created
          name={created.form.name}
          live={created.live && !!workspace}
          onTry={() => {
            const target = created.form;
            setCreated(undefined);
            void tryIt(target);
          }}
          onStay={() => setCreated(undefined)}
        />
      ) : null}
    </div>
  );
}
