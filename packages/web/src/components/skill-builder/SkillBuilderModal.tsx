/**
 * The Skill Builder window (sidebar, above Settings; also "New skill" in Settings → Skills):
 * describe → generate → review and save. It reuses the Settings modal shell (backdrop, dialog,
 * focus trap, Escape, maximize). Loaded lazily on first open.
 */
import type { AgentModelOption, SkillDraft, SkillWriteScope } from "@alisio/sdk";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  settingsOpen,
  settingsPage,
  setWorkspaceTrust,
  sidebar,
  skillBuilderOpen,
} from "../../store/app.ts";
import { errorText } from "../../store/errors.ts";
import { readPref, writePref } from "../../store/storage.ts";
import { useOverlayScrollbars } from "../../util/scrollbars.ts";
import { Icon } from "../icons.tsx";
import settings from "../settings/settings.module.css";
import { settingsWorkspace, useLoad } from "../settings/shared.tsx";
import { DescribeStep } from "./DescribeStep.tsx";
import { GeneratingStep } from "./GeneratingStep.tsx";
import {
  buildRequest,
  type DescribeForm,
  describeProblem,
  draftIsDirty,
  emptyDescribe,
  type GenerationPhase,
  type SkillBuilderStep,
  saveFailure,
} from "./model.ts";
import { ReviewStep, type SaveProblem } from "./ReviewStep.tsx";
import { SavedStep } from "./SavedStep.tsx";
import styles from "./skill-builder.module.css";
import { sb } from "./strings.ts";

const MAXIMIZED_PREF = "alisio.skillBuilder.maximized";
const FOCUSABLE =
  "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex='0']";

const STEP_ORDER: SkillBuilderStep[] = ["describe", "generating", "review"];

export function SkillBuilderModal() {
  const workspace = settingsWorkspace();
  const info = sidebar.value.workspaces.find((w) => w.id === workspace?.id);
  const trusted = info?.trusted ?? false;
  const hasProject = !!workspace;
  const [step, setStep] = useState<SkillBuilderStep>("describe");
  const [form, setForm] = useState<DescribeForm>(() =>
    emptyDescribe(hasProject && trusted ? "project" : "global"),
  );
  const [draft, setDraft] = useState<SkillDraft | undefined>();
  const [generated, setGenerated] = useState<SkillDraft | undefined>();
  const [previous, setPrevious] = useState<SkillDraft | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [notice, setNotice] = useState<string | undefined>();
  const [phase, setPhase] = useState<GenerationPhase>("waiting");
  const [elapsed, setElapsed] = useState(0);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<SaveProblem | undefined>();
  const [saved, setSaved] = useState<import("@alisio/sdk").SkillCreateResult | undefined>();
  const [maximized, setMaximized] = useState(() => readPref(MAXIMIZED_PREF) === "1");
  const dialog = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  useOverlayScrollbars(scroll);
  const controller = useRef<AbortController | undefined>(undefined);
  const refining = useRef(false);
  const models = useLoad<AgentModelOption[]>(
    workspace ? () => api.agentModels(workspace.id) : undefined,
    [workspace?.id],
  );
  const skills = useLoad(
    workspace ? () => api.skills(workspace.id) : undefined,
    [workspace?.id],
    ["skills"],
  );
  const existingNames = useMemo(
    () => (skills.data ?? []).filter((s) => s.effective).map((s) => s.name),
    [skills.data],
  );
  const active = models.data?.find((m) => m.active);
  const model = active ? (active.name ?? active.id) : undefined;

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    return () => {
      controller.current?.abort();
      previousFocus?.focus();
    };
  }, []);
  // Focus follows the step: the idea field on the first one, the step title on the others.
  useEffect(() => {
    const target = dialog.current?.querySelector<HTMLElement>(
      step === "describe" ? "#sb-idea" : "#sb-step-title",
    );
    target?.focus();
  }, [step]);
  useEffect(() => {
    if (step !== "generating") return;
    const started = Date.now();
    setElapsed(0);
    const timer = setInterval(() => setElapsed(Date.now() - started), 500);
    return () => clearInterval(timer);
  }, [step]);

  const generate = async (feedback?: string) => {
    if (!workspace || (!feedback && describeProblem(form))) return;
    const refine = draft && feedback !== undefined ? { previous: draft, feedback } : undefined;
    const run = new AbortController();
    controller.current = run;
    refining.current = !!refine;
    setError(undefined);
    setNotice(undefined);
    setPhase("waiting");
    setStep("generating");
    try {
      const result = await api.draftSkill(workspace.id, buildRequest(form, refine), run.signal);
      // The real check: the same shared validation that runs again when saving.
      setPhase("validating");
      if (refine) setPrevious(refine.previous);
      setDraft(result.draft);
      setGenerated(result.draft);
      setProblem(undefined);
      setPhase("done");
      setStep("review");
    } catch (failure) {
      if (run.signal.aborted) {
        setNotice(sb("cancelled"));
      } else {
        setError(errorText(failure));
      }
      setStep(refine ? "review" : "describe");
    } finally {
      if (controller.current === run) controller.current = undefined;
    }
  };

  const cancel = () => controller.current?.abort();
  const dirty = !!draft && !!generated && draftIsDirty(generated, draft);
  const confirmDiscard = () => step !== "review" || !dirty || window.confirm(sb("unsavedLeave"));
  const close = () => {
    if (step === "generating") return cancel();
    if (!confirmDiscard()) return;
    skillBuilderOpen.value = false;
  };
  const back = () => {
    if (!confirmDiscard()) return;
    setProblem(undefined);
    setStep("describe");
  };
  const save = async (overwrite = false, scope: SkillWriteScope = form.scope) => {
    if (!workspace || !draft) return;
    setSaving(true);
    setProblem(undefined);
    try {
      setSaved(
        await api.createSkill(workspace.id, {
          scope,
          draft,
          ...(overwrite ? { overwrite: true } : {}),
        }),
      );
      setStep("saved");
    } catch (failure) {
      setProblem({ kind: saveFailure(failure), message: errorText(failure) });
    } finally {
      setSaving(false);
    }
  };
  const openModels = () => {
    settingsPage.value = "models";
    skillBuilderOpen.value = false;
    settingsOpen.value = true;
  };
  const viewSkills = () => {
    settingsPage.value = "skills";
    skillBuilderOpen.value = false;
    settingsOpen.value = true;
  };
  const another = () => {
    setForm(emptyDescribe(form.scope));
    setDraft(undefined);
    setGenerated(undefined);
    setPrevious(undefined);
    setSaved(undefined);
    setProblem(undefined);
    setStep("describe");
  };

  const currentIndex = STEP_ORDER.indexOf(step === "saved" ? "review" : step);
  const stepLabels = [sb("stepDescribe"), sb("stepGenerate"), sb("stepReview")];
  return (
    <div
      class={settings.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        class={`${settings.dialog} ${styles.shell}${maximized ? ` ${styles.maximized}` : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="sb-dialog-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !event.defaultPrevented) {
            event.preventDefault();
            close();
          }
          if (event.key === "Tab") {
            const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
            const first = focusable[0];
            const last = focusable.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <div ref={scroll} class={`${settings.content} ${styles.scroll}`}>
          <div class={settings.topBar}>
            <div class={styles.titleBar}>
              <span id="sb-dialog-title" class={styles.titleText}>
                {sb("title")}
              </span>
              <ol class={styles.steps} aria-label={sb("stepsLabel")}>
                {stepLabels.map((label, index) => (
                  <li
                    key={label}
                    class={`${styles.step}${index < currentIndex || step === "saved" ? ` ${styles.stepDone}` : ""}`}
                    aria-current={index === currentIndex && step !== "saved" ? "step" : undefined}
                  >
                    <span class={styles.stepNumber} aria-hidden="true">
                      {index + 1}
                    </span>
                    <span class={styles.stepLabel}>{label}</span>
                  </li>
                ))}
              </ol>
            </div>
            <button
              type="button"
              class="icon-btn"
              aria-label={sb(maximized ? "restore" : "maximize")}
              title={sb(maximized ? "restore" : "maximize")}
              aria-pressed={maximized}
              onClick={() => {
                const next = !maximized;
                setMaximized(next);
                writePref(MAXIMIZED_PREF, next ? "1" : undefined);
              }}
            >
              <Icon name={maximized ? "shrink" : "expand"} size={16} />
            </button>
            <button type="button" class="icon-btn" aria-label={sb("close")} onClick={close}>
              <Icon name="x" size={18} />
            </button>
          </div>
          {step === "describe" ? (
            <DescribeStep
              form={form}
              onChange={setForm}
              hasProject={hasProject}
              trusted={trusted}
              model={model}
              modelsLoading={models.loading && !models.data && !models.error}
              error={error}
              notice={notice}
              onGenerate={() => void generate()}
              onOpenModels={openModels}
            />
          ) : null}
          {step === "generating" ? (
            <GeneratingStep elapsedMs={elapsed} phase={phase} onCancel={cancel} />
          ) : null}
          {step === "review" && draft ? (
            <ReviewStep
              draft={draft}
              onChange={setDraft}
              existingNames={existingNames}
              scope={form.scope}
              onScope={(scope) => {
                setForm({ ...form, scope });
                setProblem(undefined);
              }}
              hasProject={hasProject}
              model={model}
              error={notice ? undefined : error}
              canRestore={!!previous}
              onRestore={() => {
                if (!previous) return;
                setDraft(previous);
                setPrevious(undefined);
              }}
              onRegenerate={(feedback) => void generate(feedback)}
              onBack={back}
              saving={saving}
              problem={problem}
              onSave={() => void save()}
              onOverwrite={() => void save(true)}
              onTrust={() => {
                if (!workspace) return;
                void setWorkspaceTrust(workspace, true).then((ok) => {
                  if (ok) void save();
                });
              }}
              onSaveGlobally={() => {
                setForm({ ...form, scope: "global" });
                void save(false, "global");
              }}
              onDismissProblem={() => setProblem(undefined)}
            />
          ) : null}
          {step === "saved" && saved ? (
            <SavedStep
              result={saved}
              workspaceId={workspace?.id}
              onViewSkills={viewSkills}
              onAnother={another}
              onClose={() => {
                skillBuilderOpen.value = false;
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
