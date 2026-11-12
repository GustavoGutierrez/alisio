/**
 * One creator project: header with status, the run (steps and feed), the actions (build, install
 * or update, ask for changes, download, share, delete) and the Overview / Stats / Files / Data
 * sections. Every mutating action is disabled in read-only mode and while a run is going on.
 */
import type { PluginCreatorIssue, PluginCreatorProjectEntry } from "@alisio/sdk";
import { useEffect, useRef, useState } from "preact/hooks";
import { locale } from "../../i18n/index.ts";
import { formatSize } from "../../util/artifacts.ts";
import { Icon, type IconName } from "../icons.tsx";
import { ConfirmDialog } from "../settings/ConfirmDialog.tsx";
import styles from "./creator.module.css";
import { FilesView } from "./FilesView.tsx";
import { failureMessage } from "./failures.ts";
import {
  creatorFailure,
  fixList,
  formatDuration,
  installBlock,
  lastBuildFailure,
  statusBadge,
} from "./model.ts";
import { ProjectIcon, StatusBadge } from "./ProjectList.tsx";
import { RunPanel } from "./RunPanel.tsx";
import { SchemaView } from "./SchemaView.tsx";
import { ShareDialog } from "./ShareDialog.tsx";
import {
  activationFailures,
  buildingId,
  buildProject,
  deleteProject,
  feed,
  installing,
  installProject,
  lastBuild,
  packageUrl,
  readOnly,
  running,
  startRun,
  toastText,
  watch,
} from "./store.ts";
import { type CrKey, cr, issueText } from "./strings.ts";

/** A finding with its localized sentence, its file and (folded) the exact reason. */
function IssueList({ issues }: { issues: PluginCreatorIssue[] }) {
  return (
    <ul class={styles.issues}>
      {issues.map((issue, i) => (
        <li key={`${issue.code}-${issue.file ?? ""}-${i}`}>
          {issueText(issue.code)}
          {issue.file ? (
            <span class={styles.muted}>
              {" "}
              (<code>{issue.file}</code>)
            </span>
          ) : null}
          {issue.message ? (
            <details class={styles.reason}>
              <summary>{cr("activationReason")}</summary>
              <code>{issue.message}</code>
            </details>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** "Installed but it could not start" (or "…so the install was undone"), the reason and a fix. */
function ActivationFailed(props: {
  rolledBack: boolean;
  message: string;
  disabled: boolean;
  onFix?: () => void;
}) {
  return (
    <div class={styles.callout} data-tone="danger" role="alert">
      <Icon name="alert" size={16} />
      <div>
        <strong>{cr(props.rolledBack ? "activationRolledBackTitle" : "activationTitle")}</strong>
        <p>{cr(props.rolledBack ? "activationRolledBackBody" : "activationBody")}</p>
        <details class={styles.reason}>
          <summary>{cr("activationReason")}</summary>
          <code>{props.message}</code>
        </details>
        {props.onFix ? (
          <p class={styles.spaced}>
            <button
              type="button"
              class={styles.ghost}
              disabled={props.disabled}
              onClick={props.onFix}
            >
              <Icon name="wand" size={15} />
              {cr("activationFix")}
            </button>
          </p>
        ) : null}
      </div>
    </div>
  );
}

type Tab = "overview" | "stats" | "files" | "data";
type DialogKind = "install" | "delete" | "share" | undefined;

const dateTime = (at: number) =>
  new Intl.DateTimeFormat(locale.value, { dateStyle: "medium", timeStyle: "short" }).format(at);

function Overview({ entry }: { entry: PluginCreatorProjectEntry }) {
  const { project, status } = entry;
  const sentence = status.updateAvailable
    ? cr("statusUpdate", { installed: status.installedVersion ?? "?", version: project.version })
    : status.installed
      ? cr("statusInstalled", { version: status.installedVersion ?? project.version })
      : cr("statusNotInstalled");
  return (
    <div>
      <h3 class={styles.sectionTitle}>{cr("statusTitle")}</h3>
      <p>
        {sentence}{" "}
        <span class={styles.badge} data-badge={status.packageReady ? "installed" : undefined}>
          {status.packageReady ? cr("packageReady") : cr("packageNotReady")}
        </span>
      </p>
      {!project.lastBuild ? <p class={styles.muted}>{cr("noBuild")}</p> : null}
      <h3 class={styles.sectionTitle}>{cr("descriptionTitle")}</h3>
      <p class={styles.historyText}>{project.description}</p>
      <h3 class={styles.sectionTitle}>{cr("historyTitle")}</h3>
      <ol class={styles.history}>
        {[...project.requests].reverse().map((request) => (
          <li key={request.id}>
            <div class={styles.historyHead}>
              <strong>
                {request.kind === "create" ? cr("historyCreate") : cr("historyModify")}
              </strong>
              <span>{dateTime(request.at)}</span>
            </div>
            <p class={styles.historyText}>{request.text}</p>
          </li>
        ))}
      </ol>
    </div>
  );
}

function Stats({ entry }: { entry: PluginCreatorProjectEntry }) {
  const build = entry.project.lastBuild;
  if (!build) return <p class={styles.muted}>{cr("statsNone")}</p>;
  const items: Array<[CrKey, string, string?]> = [
    ...(build.generationMs !== undefined
      ? [["statsGeneration", formatDuration(build.generationMs)] as [CrKey, string]]
      : []),
    ["statsBuild", formatDuration(build.durationMs)],
    ["statsFiles", String(build.files)],
    ["statsSize", formatSize(build.bytes)],
    ...(build.tarballBytes !== undefined
      ? [["statsPackage", formatSize(build.tarballBytes)] as [CrKey, string]]
      : []),
    ["statsPassed", String(build.testsPassed), "ok"],
    ["statsFailed", String(build.testsFailed), build.testsFailed ? "danger" : undefined],
  ];
  return (
    <div>
      <dl class={styles.kv}>
        {items.map(([key, value, tone]) => (
          <div key={key} class={styles.stat} data-tone={tone}>
            <dt>{cr(key)}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      <p class={`${styles.muted} ${styles.small}`}>
        {cr("statsWhen", { when: dateTime(build.at) })}
      </p>
    </div>
  );
}

function Tabs(props: {
  tabs: Array<[Tab, CrKey, IconName]>;
  active: Tab;
  onSelect: (t: Tab) => void;
}) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  return (
    <div class={styles.tabs} role="tablist" aria-label={cr("tabsLabel")}>
      {props.tabs.map(([id, label, icon], index) => (
        <button
          key={id}
          ref={(el) => {
            refs.current[index] = el;
          }}
          type="button"
          role="tab"
          id={`creator-tab-${id}`}
          class={styles.tab}
          aria-selected={props.active === id}
          aria-controls="creator-tabpanel"
          tabIndex={props.active === id ? 0 : -1}
          onClick={() => props.onSelect(id)}
          onKeyDown={(event) => {
            const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!step) return;
            event.preventDefault();
            const next = (index + step + props.tabs.length) % props.tabs.length;
            const tab = props.tabs[next];
            if (tab) props.onSelect(tab[0]);
            refs.current[next]?.focus();
          }}
        >
          <Icon name={icon} size={15} />
          {cr(label)}
        </button>
      ))}
    </div>
  );
}

/** Starts a download of the package (building it first when the sources changed). */
async function download(entry: PluginCreatorProjectEntry): Promise<void> {
  if (!entry.status.packageReady) {
    if (readOnly.value) return toastText(cr("notBuilt"));
    if (!(await buildProject(entry.project.id))) return;
  }
  const link = document.createElement("a");
  link.href = packageUrl(entry.project.id);
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  toastText(`${cr("downloadStarted")} ${cr("downloadHint")}`);
}

export function ProjectView(props: { entry: PluginCreatorProjectEntry; workspace?: string }) {
  const { entry } = props;
  const { project, status } = entry;
  const [tab, setTab] = useState<Tab>("overview");
  const [dialog, setDialog] = useState<DialogKind>();
  const [uninstall, setUninstall] = useState(false);
  const [modifying, setModifying] = useState(false);
  const [change, setChange] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | undefined>();

  // The stream follows this project's creator session while it is on screen.
  useEffect(() => watch(project.sessionId), [project.id, project.sessionId]);

  const active = running.value && !!project.sessionId;
  const locked = readOnly.value;
  const buildingNow = buildingId.value === project.id;
  const installingNow = installing.value === project.id;
  const blocked = locked || active || buildingNow || installingNow;
  const build = lastBuild.value?.id === project.id ? lastBuild.value : undefined;
  const failure = build && !build.ok ? creatorFailure(build.error) : undefined;
  // A failed build from an earlier visit or from the agent (the record keeps its findings).
  const stored = !build && !active ? lastBuildFailure(entry) : undefined;
  const activationError = status.installed ? status.activationError : undefined;
  const rolledBack = activationFailures.value[project.id];
  const blockedInstall = installBlock(entry);
  const hasSchema = !!project.schema?.tables.length;
  const showRun =
    !!project.sessionId &&
    (active ||
      feed.value.entries.length > 0 ||
      !!project.progress?.steps.some((s) => s.status !== "pending"));

  const tabs: Array<[Tab, CrKey, IconName]> = [
    ["overview", "tabOverview", "info"],
    ["stats", "tabStats", "fileChart"],
    ["files", "tabFiles", "folder"],
    ...(hasSchema ? [["data", "tabDatabase", "database"] as [Tab, CrKey, IconName]] : []),
  ];
  const shownTab = tab === "data" && !hasSchema ? "overview" : tab;

  const askAlisio = async (text: string, request: boolean) => {
    setSending(true);
    setError(undefined);
    try {
      await startRun(project.id, text, request ? { request: true } : {});
      return true;
    } catch (failed) {
      const why = creatorFailure(failed);
      if (why.kind === "readOnly") readOnly.value = true;
      setError(cr("sessionFailed", { message: failureMessage(why) }));
      return false;
    } finally {
      setSending(false);
    }
  };

  const install = async () => {
    setDialog(undefined);
    setError(undefined);
    const name = project.displayName;
    try {
      const job = await installProject(project.id, props.workspace);
      const result = job.result;
      if (result?.activationError) {
        activationFailures.value = {
          ...activationFailures.value,
          [project.id]: result.activationError,
        };
        return toastText(cr("installActivationFailed", { name }));
      }
      if (job.error) return toastText(cr("installFailed", { message: job.error }));
      if (activationFailures.value[project.id]) {
        const { [project.id]: _gone, ...rest } = activationFailures.value;
        activationFailures.value = rest;
      }
      if (result?.enableError)
        toastText(cr("installEnableFailed", { name, message: result.enableError }));
      else if (result?.restartRequired || result?.restartPending)
        toastText(cr("installDoneRestart", { name }));
      else toastText(cr("installDone", { name }));
    } catch (failed) {
      const why = creatorFailure(failed);
      if (why.kind === "tests" || why.kind === "invalid")
        lastBuild.value = { id: project.id, ok: false, error: failed };
      if (why.kind === "readOnly") readOnly.value = true;
      toastText(cr("installFailed", { message: failureMessage(why) }));
    }
  };

  const remove = async () => {
    setDialog(undefined);
    const name = project.displayName;
    try {
      const result = await deleteProject(project.id, status.installed && uninstall);
      toastText(result.restartPending ? cr("deletedRestart", { name }) : cr("deleted", { name }));
    } catch (failed) {
      toastText(failureMessage(creatorFailure(failed)));
    }
  };

  const action = (
    icon: IconName,
    label: string,
    onClick: () => void,
    options: { primary?: boolean; danger?: boolean; disabled?: boolean; busy?: boolean } = {},
  ) => (
    <button
      type="button"
      class={options.primary ? styles.primary : options.danger ? styles.danger : styles.ghost}
      disabled={options.disabled}
      aria-busy={options.busy}
      onClick={onClick}
    >
      {options.busy ? (
        <span class={styles.spinner} aria-hidden="true" />
      ) : (
        <Icon name={icon} size={15} />
      )}
      {label}
    </button>
  );

  return (
    <div>
      <div class={styles.card}>
        <div class={styles.projectHead}>
          <ProjectIcon entry={entry} />
          <div class={styles.projectTitle}>
            <h2>{project.displayName}</h2>
            <div class={styles.projectLine}>
              <span>{cr("version", { version: project.version })}</span>
              <StatusBadge badge={statusBadge(entry, active)} />
            </div>
          </div>
        </div>
        <p class={styles.lead}>{project.description}</p>
      </div>

      {showRun ? <RunPanel entry={entry} /> : null}

      <div class={styles.card}>
        <div class={styles.actions} role="group" aria-label={cr("actionsLabel")}>
          {action(
            "check",
            buildingNow ? cr("building") : cr("build"),
            () => void buildProject(project.id),
            {
              disabled: blocked,
              busy: buildingNow,
            },
          )}
          {status.updateAvailable
            ? action(
                "refresh",
                installingNow ? cr("installing") : cr("update"),
                () => setDialog("install"),
                {
                  primary: true,
                  disabled: blocked || !!blockedInstall,
                  busy: installingNow,
                },
              )
            : status.installed
              ? null
              : action(
                  "download",
                  installingNow ? cr("installing") : cr("install"),
                  () => setDialog("install"),
                  {
                    primary: true,
                    disabled: blocked || !!blockedInstall,
                    busy: installingNow,
                  },
                )}
          {action("edit", cr("modify"), () => setModifying(!modifying), { disabled: blocked })}
          {action("download", cr("download"), () => void download(entry), {
            disabled: buildingNow || (locked && !status.packageReady),
          })}
          {action("share", cr("share"), () => setDialog("share"))}
          {action("trash", cr("delete"), () => setDialog("delete"), {
            danger: true,
            disabled: blocked,
          })}
        </div>
        {blockedInstall && !status.installed && !buildingNow && !installingNow ? (
          <p class={`${styles.muted} ${styles.small}`}>{cr(blockedInstall)}</p>
        ) : null}
        {activationError || rolledBack ? (
          <ActivationFailed
            rolledBack={!activationError}
            message={activationError ?? rolledBack ?? ""}
            disabled={blocked || sending}
            {...(locked
              ? {}
              : {
                  onFix: () =>
                    void askAlisio(
                      cr("activationFixPrompt", { message: activationError ?? rolledBack ?? "" }),
                      true,
                    ),
                })}
          />
        ) : null}
        {stored ? (
          <div class={styles.callout} data-tone="danger" role="alert">
            <Icon name="alert" size={16} />
            <div>
              {stored.gaveUp ? (
                <>
                  <strong>{cr("gaveUpTitle")}</strong>
                  <p>{cr("gaveUpBody")}</p>
                </>
              ) : (
                cr("lastBuildFailedTitle")
              )}
              <IssueList issues={stored.issues} />
              {!locked ? (
                <p class={styles.spaced}>
                  <button
                    type="button"
                    class={styles.ghost}
                    disabled={blocked || sending}
                    onClick={() =>
                      void askAlisio(
                        stored.gaveUp
                          ? cr("retryPrompt", { list: fixList(stored.issues) })
                          : cr("fixPrompt", { list: fixList(stored.issues) }),
                        stored.gaveUp,
                      )
                    }
                  >
                    <Icon name={stored.gaveUp ? "refresh" : "wand"} size={15} />
                    {cr(stored.gaveUp ? "tryAgain" : "buildFixWithAlisio")}
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {error ? (
          <p class={styles.callout} data-tone="danger" role="alert">
            <Icon name="alert" size={16} />
            <span>{error}</span>
          </p>
        ) : null}
        {build?.ok ? (
          <p class={styles.callout} data-tone="ok" role="status">
            <Icon name="check" size={16} />
            <span>{cr("buildOk")}</span>
          </p>
        ) : failure ? (
          <div class={styles.callout} data-tone="danger" role="alert">
            <Icon name="alert" size={16} />
            <div>
              {failure.kind === "invalid" ? (
                <>
                  {cr("buildFailedInvalid")}
                  <IssueList issues={failure.issues} />
                </>
              ) : (
                failureMessage(failure)
              )}
              {(failure.kind === "invalid" || failure.kind === "tests") && !locked ? (
                <p class={styles.spaced}>
                  <button
                    type="button"
                    class={styles.ghost}
                    disabled={blocked || sending}
                    onClick={() =>
                      void askAlisio(
                        cr("fixPrompt", {
                          list:
                            failure.kind === "invalid"
                              ? fixList(failure.issues)
                              : failureMessage(failure),
                        }),
                        false,
                      )
                    }
                  >
                    <Icon name="wand" size={15} />
                    {cr("buildFixWithAlisio")}
                  </button>
                </p>
              ) : null}
            </div>
          </div>
        ) : null}
        {modifying ? (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              if (!change.trim()) return;
              if (await askAlisio(change.trim(), true)) {
                setChange("");
                setModifying(false);
              }
            }}
          >
            <div class={styles.field}>
              <label class={styles.label} for="creator-change">
                {cr("modifyLabel")}
              </label>
              <textarea
                id="creator-change"
                class={styles.textarea}
                placeholder={cr("modifyPlaceholder")}
                value={change}
                disabled={sending}
                onInput={(event) => setChange((event.target as HTMLTextAreaElement).value)}
              />
            </div>
            <div class={styles.actions}>
              <button type="submit" class={styles.primary} disabled={sending || !change.trim()}>
                {sending ? (
                  <span class={styles.spinner} aria-hidden="true" />
                ) : (
                  <Icon name="wand" size={15} />
                )}
                {cr("modifySend")}
              </button>
              <button type="button" class={styles.ghost} onClick={() => setModifying(false)}>
                {cr("cancel")}
              </button>
            </div>
          </form>
        ) : null}

        <Tabs tabs={tabs} active={shownTab} onSelect={setTab} />
        <div id="creator-tabpanel" role="tabpanel" aria-labelledby={`creator-tab-${shownTab}`}>
          {shownTab === "overview" ? (
            <Overview entry={entry} />
          ) : shownTab === "stats" ? (
            <Stats entry={entry} />
          ) : shownTab === "files" ? (
            <FilesView id={project.id} version={`${project.version}-${project.updatedAt}`} />
          ) : project.schema ? (
            <SchemaView schema={project.schema} />
          ) : null}
        </div>
      </div>

      {dialog === "install" ? (
        <ConfirmDialog
          title={
            status.updateAvailable
              ? cr("updateTitle", { name: project.displayName })
              : cr("installTitle", { name: project.displayName })
          }
          icon={<ProjectIcon entry={entry} />}
          confirmLabel={status.updateAvailable ? cr("updateConfirm") : cr("installConfirm")}
          cancelLabel={cr("cancel")}
          onConfirm={() => void install()}
          onCancel={() => setDialog(undefined)}
        >
          {status.updateAvailable ? (
            <p>{cr("updateBody")}</p>
          ) : (
            <>
              <p>{cr("installBody")}</p>
              <p>{cr("installBody2")}</p>
            </>
          )}
        </ConfirmDialog>
      ) : null}
      {dialog === "delete" ? (
        <ConfirmDialog
          title={cr("deleteTitle", { name: project.displayName })}
          confirmLabel={cr("deleteConfirm")}
          cancelLabel={cr("cancel")}
          danger
          {...(status.installed
            ? {
                checkbox: {
                  label: cr("deleteUninstall"),
                  checked: uninstall,
                  onChange: setUninstall,
                },
              }
            : {})}
          onConfirm={() => void remove()}
          onCancel={() => setDialog(undefined)}
        >
          <p>{cr("deleteBody")}</p>
          {status.installed ? <p class={styles.muted}>{cr("deleteUninstallHint")}</p> : null}
        </ConfirmDialog>
      ) : null}
      {dialog === "share" ? (
        <ShareDialog
          dir={project.dir}
          onDownload={() => void download(entry)}
          onClose={() => setDialog(undefined)}
        />
      ) : null}
    </div>
  );
}
