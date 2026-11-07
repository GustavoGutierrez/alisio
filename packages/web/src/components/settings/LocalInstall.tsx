/**
 * Settings → Plugins → Install from file: pick or drop a `.tgz`, inspect it on the server, show
 * the validation card and, once confirmed, follow the install job phase by phase.
 */
import { useEffect, useReducer, useRef, useState } from "preact/hooks";
import { api, showToast } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import { ConfirmDialog } from "./ConfirmDialog.tsx";
import { cs } from "./catalog-strings.ts";
import {
  acceptsFile,
  formatBytes,
  inspectVerdict,
  type JobStateView,
  type LocalInspectView,
  localReducer,
  type PhaseId,
  phaseSteps,
} from "./local-model.ts";
import { sessionPrefs, working } from "./plugin-ops.ts";
import styles from "./settings.module.css";
import { errorMessage, Pill } from "./shared.tsx";

const POLL_MS = 500;

async function uploadForInspection(file: File): Promise<LocalInspectView> {
  let res: Response;
  try {
    res = await fetch("/api/plugins/local/inspect", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/gzip", Accept: "application/json" },
      body: file,
    });
  } catch (error) {
    throw new Error(errorMessage(error));
  }
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  if (!res.ok)
    throw new Error(
      (parsed as { error?: { message?: string } } | undefined)?.error?.message ??
        `HTTP ${res.status}`,
    );
  return parsed as LocalInspectView;
}

function Stepper(props: { job?: JobStateView }) {
  return (
    <ol class={styles.stepper} aria-label={cs("file.progress", { name: "" }).trim()}>
      {phaseSteps(props.job).map((step) => (
        <li
          key={step.id}
          data-status={step.status}
          aria-current={step.status === "running" ? "step" : undefined}
        >
          <span class={styles.stepIcon} aria-hidden="true">
            {step.status === "done" ? (
              <Icon name="check" size={14} />
            ) : step.status === "running" ? (
              <span class={styles.spinner} />
            ) : step.status === "failed" ? (
              <Icon name="x" size={14} />
            ) : null}
          </span>
          <span>{cs(`phase.${step.id}` as `phase.${PhaseId}`)}</span>
          <span class={styles.srOnly}> — {cs(`phase.${step.status}`)}</span>
        </li>
      ))}
    </ol>
  );
}

function Fact(props: { label: string; children: preact.ComponentChildren }) {
  return (
    <>
      <dt>{props.label}</dt>
      <dd>{props.children}</dd>
    </>
  );
}

export function LocalInstall(props: {
  /** "Update from file…": the package this file is expected to be. */
  scope?: string;
  sdkVersion?: string;
  onChanged: () => void;
  onShowInstalled: () => void;
}) {
  const [flow, dispatch] = useReducer(localReducer, { step: "idle" });
  const [dragging, setDragging] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [skip, setSkip] = useState(false);
  const [problem, setProblem] = useState<string | undefined>();
  const alive = useRef(true);
  const staged = useRef<string | undefined>();
  const input = useRef<HTMLInputElement>(null);

  const discard = () => {
    const id = staged.current;
    staged.current = undefined;
    if (id) void api.request("DELETE", `/api/plugins/local/staged/${id}`).catch(() => {});
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      // Leaving the tab with an upload that was never installed removes it from the server.
      if (working.value === undefined) discard();
    };
  }, []);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    setProblem(undefined);
    if (!acceptsFile(file.name)) return setProblem(cs("file.invalidType"));
    discard();
    dispatch({ type: "pick", fileName: file.name });
    try {
      const info = await uploadForInspection(file);
      if (!alive.current) return;
      staged.current = info.stagingId;
      dispatch({ type: "inspected", info });
    } catch (error) {
      if (alive.current) {
        setProblem(cs("file.uploadFailed", { message: errorMessage(error) }));
        dispatch({ type: "reset" });
      }
    }
  };

  const startInstall = async (info: LocalInspectView) => {
    if (!info.stagingId) return;
    dispatch({ type: "start" });
    working.value = `local:${info.package ?? ""}`;
    try {
      const { jobId } = await api.request<{ jobId: string }>("POST", "/api/plugins/local/install", {
        stagingId: info.stagingId,
        confirmed: true,
      });
      staged.current = undefined;
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        const job = await api.request<JobStateView>("GET", `/api/plugins/jobs/${jobId}`);
        if (alive.current) dispatch({ type: "progress", job });
        if (job.done) {
          if (!job.error) props.onChanged();
          break;
        }
      }
    } catch (error) {
      showToast(errorMessage(error));
      if (alive.current) dispatch({ type: "error", message: errorMessage(error) });
    } finally {
      working.value = undefined;
    }
  };

  const reset = () => {
    discard();
    setProblem(undefined);
    dispatch({ type: "reset" });
  };

  const info = "info" in flow ? flow.info : undefined;
  const verdict = info ? inspectVerdict(info, props.scope) : undefined;
  const busy = working.value !== undefined && flow.step !== "installing";
  const verb = info?.installed?.relation;

  return (
    <div class={styles.stack}>
      <p class={styles.note}>{cs("file.lead")}</p>
      {props.scope ? (
        <p class={styles.callout}>
          <Icon name="info" size={16} />
          <span>{cs("file.scope", { name: props.scope })}</span>
        </p>
      ) : null}
      {flow.step === "idle" || flow.step === "inspecting" ? (
        <label
          class={styles.dropZone}
          data-dragging={dragging}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            void pick(event.dataTransfer?.files?.[0]);
          }}
        >
          <Icon name="download" size={28} />
          <strong>
            {flow.step === "inspecting"
              ? cs("file.inspecting", { name: flow.fileName })
              : cs("file.drop")}
          </strong>
          <span class={styles.note}>{cs("file.dropHint")}</span>
          <input
            ref={input}
            type="file"
            class={styles.fileInput}
            accept=".tgz,.tar.gz,application/gzip,application/x-gzip"
            disabled={flow.step === "inspecting" || busy}
            aria-label={cs("file.choose")}
            onChange={(event) => {
              const el = event.target as HTMLInputElement;
              void pick(el.files?.[0]);
              el.value = "";
            }}
          />
          <span class={styles.ghostButton} aria-hidden="true">
            {cs("file.choose")}
          </span>
        </label>
      ) : null}
      {problem ? (
        <p class={styles.errorText} role="alert">
          {problem}
        </p>
      ) : null}

      {flow.step === "inspected" && info && verdict ? (
        <section
          class={styles.validation}
          aria-label={cs(info.isAlisioPlugin ? "file.valid" : "file.invalid")}
        >
          <header class={styles.validationHead}>
            <h4>{info.package ?? flow.fileName}</h4>
            <Pill tone={verdict.canInstall ? "ok" : "danger"}>
              {cs(info.isAlisioPlugin ? "file.valid" : "file.invalid")}
            </Pill>
          </header>
          {info.description ? <p class={styles.cardText}>{info.description}</p> : null}
          <dl class={styles.facts}>
            {info.package ? (
              <Fact label={cs("file.package")}>
                <code>{info.package}</code>
              </Fact>
            ) : null}
            {info.version ? <Fact label={cs("file.version")}>v{info.version}</Fact> : null}
            {info.author ? <Fact label={cs("file.author")}>{info.author}</Fact> : null}
            {info.license ? <Fact label={cs("file.license")}>{info.license}</Fact> : null}
            <Fact label={cs("file.sdk")}>{info.sdkRange ?? cs("file.sdkNone")}</Fact>
            <Fact label={cs("file.size")}>{formatBytes(info.size)}</Fact>
          </dl>
          {info.sdkRange && !info.compatible ? (
            <p class={styles.warning} role="note">
              <Icon name="alert" size={16} />
              <span>
                {cs("file.sdkWarn", { range: info.sdkRange, sdk: props.sdkVersion ?? "?" })}
              </span>
            </p>
          ) : null}
          {info.sdkRange && info.compatible && props.sdkVersion ? (
            <p class={styles.note}>{cs("file.sdkOk", { sdk: props.sdkVersion })}</p>
          ) : null}
          {info.lifecycleScripts.length ? (
            <p class={styles.warning} role="note">
              <Icon name="alert" size={16} />
              <span>{cs("file.lifecycle", { scripts: info.lifecycleScripts.join(", ") })}</span>
            </p>
          ) : null}
          {verdict.existing ? (
            <p class={styles.note}>
              {cs(`file.existing.${verdict.existing.relation}` as "file.existing.same", {
                installed: verdict.existing.version,
                version: info.version ?? "",
              })}
            </p>
          ) : null}
          {verdict.scopeMismatch && props.scope ? (
            <p class={styles.warning} role="note">
              <Icon name="alert" size={16} />
              <span>
                {cs("file.scopeMismatch", { scope: props.scope, name: info.package ?? "?" })}
              </span>
            </p>
          ) : null}
          {!info.isAlisioPlugin ? (
            <div>
              <h5 class={styles.listTitle}>{cs("file.rejected")}</h5>
              <ul class={styles.reasons}>
                {info.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div class={styles.dialogActions}>
            <button type="button" class={styles.ghostButton} onClick={reset}>
              {cs("file.another")}
            </button>
            {verdict.canInstall ? (
              <button
                type="button"
                class={styles.primaryButton}
                disabled={busy}
                onClick={() => {
                  if (verb !== "downgrade" && sessionPrefs.skipInstallWarning)
                    void startInstall(info);
                  else {
                    setSkip(false);
                    setConfirm(true);
                  }
                }}
              >
                {verb === "update"
                  ? cs("file.installUpdate")
                  : verb === "same"
                    ? cs("file.installReinstall")
                    : verb === "downgrade"
                      ? cs("file.installDowngrade")
                      : cs("file.install")}
              </button>
            ) : null}
          </div>
        </section>
      ) : null}

      {flow.step === "installing" || flow.step === "done" || flow.step === "failed" ? (
        <section class={styles.validation} aria-live="polite">
          <header class={styles.validationHead}>
            <h4>{cs("file.progress", { name: info?.package ?? "" })}</h4>
            {flow.step === "done" ? <Pill tone="ok">{cs("phase.done")}</Pill> : null}
            {flow.step === "failed" ? <Pill tone="danger">{cs("phase.failed")}</Pill> : null}
          </header>
          <Stepper job={"job" in flow ? flow.job : undefined} />
          {flow.step === "done" ? (
            <>
              <p class={styles.note}>
                {cs("file.done", {
                  name: flow.info.package ?? "",
                  version: flow.job.result?.installedVersion ?? "",
                })}
              </p>
              {flow.job.result?.restartRequired ? (
                <p class={styles.warning} role="status">
                  <Icon name="alert" size={16} />
                  <span>
                    {cs("install.restartNeeded", {
                      name: flow.info.package ?? "",
                      version: flow.job.result.installedVersion,
                    })}
                  </span>
                </p>
              ) : flow.job.result?.restartPending ? (
                <p class={styles.note}>
                  {cs("install.deferred", { name: flow.info.package ?? "" })}
                </p>
              ) : null}
              <div class={styles.dialogActions}>
                <button type="button" class={styles.ghostButton} onClick={reset}>
                  {cs("file.another")}
                </button>
                <button type="button" class={styles.primaryButton} onClick={props.onShowInstalled}>
                  {cs("file.openInstalled")}
                </button>
              </div>
            </>
          ) : null}
          {flow.step === "failed" ? (
            <>
              <p class={styles.errorText} role="alert">
                {cs("file.failed")} {flow.error.split("\n")[0]}
              </p>
              {flow.logTail ? (
                <details open>
                  <summary>{cs("file.logTail")}</summary>
                  <pre class={styles.logTail}>{flow.logTail}</pre>
                </details>
              ) : null}
              <div class={styles.dialogActions}>
                <button type="button" class={styles.ghostButton} onClick={reset}>
                  {cs("file.another")}
                </button>
              </div>
            </>
          ) : null}
        </section>
      ) : null}

      {confirm && info ? (
        <ConfirmDialog
          title={cs(
            verb === "downgrade"
              ? "install.downgradeTitle"
              : verb === "same"
                ? "install.reinstallTitle"
                : verb === "update"
                  ? "install.updateTitle"
                  : "install.title",
            { name: info.package ?? "" },
          )}
          confirmLabel={cs("install.confirm")}
          cancelLabel={cs("install.cancel")}
          checkbox={
            verb === "downgrade"
              ? undefined
              : { label: cs("install.skip"), checked: skip, onChange: setSkip }
          }
          onCancel={() => setConfirm(false)}
          onConfirm={() => {
            if (skip) sessionPrefs.skipInstallWarning = true;
            setConfirm(false);
            void startInstall(info);
          }}
        >
          <p>{cs("install.warning")}</p>
          <p>
            <code>
              {cs("install.package", { package: info.package ?? "", version: info.version ?? "" })}
            </code>
          </p>
          {info.installed ? (
            <p>
              {cs("install.replaces", { from: info.installed.version, to: info.version ?? "" })}
            </p>
          ) : null}
          {verb === "downgrade" && info.installed ? (
            <p class={styles.diagnostic}>
              {cs("install.downgradeWarning", {
                from: info.installed.version,
                to: info.version ?? "",
              })}
            </p>
          ) : null}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
