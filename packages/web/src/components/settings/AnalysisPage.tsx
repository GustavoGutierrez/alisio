/**
 * Settings → Data analysis (spec §18): the runtime state read only (mode, Python found or how to
 * install it, optional packages, container engine and image) and the settings that can be edited:
 * the switch, the execution timeout and the retention. Python needs no configuration; nothing here
 * is required to run an analysis.
 */
import type { AnalysisStatus, SettingInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import {
  type AnalysisKey,
  analysisSetting,
  extrasLabel,
  msToSeconds,
  parseWhole,
  RETENTION_DAYS,
  secondsToMs,
  TIMEOUT_SECONDS,
} from "../../util/analysis.ts";
import styles from "./settings.module.css";
import {
  errorMessage,
  PageIntro,
  Pill,
  Status,
  Switch,
  settingsWorkspace,
  useLoad,
} from "./shared.tsx";

/** A whole-number field committed on blur or Enter; an invalid entry reverts. */
function NumberRow(props: {
  id: string;
  label: string;
  keyName: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onSave: (value: number) => Promise<void>;
  /** Shown value ↔ stored value (the timeout is shown in seconds). */
  parse?: (text: string) => number | undefined;
}) {
  const [draft, setDraft] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const commit = async () => {
    if (draft === undefined) return;
    const value = props.parse ? props.parse(draft) : parseWhole(draft, props.min, props.max);
    setDraft(undefined);
    if (value === undefined) return;
    setBusy(true);
    try {
      await props.onSave(value);
    } catch {
      /* The page already showed the error; the field keeps the saved value. */
    } finally {
      setBusy(false);
    }
  };
  return (
    <li class={styles.settingRow}>
      <label class={styles.settingLabel} for={props.id}>
        <span>{props.label}</span>
        <code class={styles.settingKey}>{props.keyName}</code>
      </label>
      <input
        id={props.id}
        class={styles.input}
        type="number"
        inputMode="numeric"
        min={props.min}
        max={props.max}
        step={1}
        disabled={props.disabled || busy}
        value={draft ?? String(props.value)}
        onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === "Enter") void commit();
          if (event.key === "Escape" && draft !== undefined) {
            event.stopPropagation();
            setDraft(undefined);
          }
        }}
      />
    </li>
  );
}

function RuntimeFacts(props: { status: AnalysisStatus }) {
  const { status } = props;
  const { python, oci } = status;
  return (
    <>
      <h4 class={styles.sectionTitle}>{t("settings.analysis.status")}</h4>
      <dl class={styles.facts} data-testid="analysis-status">
        <dt>{t("settings.analysis.mode")}</dt>
        <dd>
          <Pill tone={status.mode === "oci" ? "ok" : "warn"}>
            {t(
              status.mode === "oci"
                ? "settings.analysis.mode.oci"
                : "settings.analysis.mode.managed",
            )}
          </Pill>
        </dd>
        <dt>{t("settings.analysis.runtime")}</dt>
        <dd>
          {python.found ? (
            t("settings.analysis.detected", { version: python.version, path: python.path })
          ) : (
            <span>{t("settings.analysis.notFound")}</span>
          )}
        </dd>
        {python.found && python.runtimeVersion ? (
          <>
            <dt>{t("settings.analysis.runtimeVersion")}</dt>
            <dd>
              <code>{python.runtimeVersion}</code>
            </dd>
          </>
        ) : null}
        <dt>{t("settings.analysis.extras")}</dt>
        <dd>
          {python.found && python.extras.length
            ? t("settings.analysis.extras.installed", { extras: extrasLabel(python.extras) })
            : t("settings.analysis.extras.none")}
        </dd>
        <dt>{t("settings.analysis.oci")}</dt>
        <dd>
          {status.mode === "managed" && !oci.image && oci.available === undefined ? (
            t("settings.analysis.oci.unused")
          ) : (
            <>
              <span>
                {oci.engine} ·{" "}
                {t("settings.analysis.oci.limits", { memory: oci.memoryMb, cpus: oci.cpus })}
              </span>
              <br />
              {oci.image ? <code>{oci.image}</code> : t("settings.analysis.oci.noImage")}
              {oci.available !== undefined ? (
                <>
                  <br />
                  {oci.available
                    ? t("settings.analysis.oci.available", { version: oci.version ?? "" })
                    : t("settings.analysis.oci.unavailable", { reason: oci.reason ?? "" })}
                </>
              ) : null}
            </>
          )}
        </dd>
      </dl>
      <p class={styles.note} role="note">
        {t(
          status.mode === "oci"
            ? "settings.analysis.containerNote"
            : "settings.analysis.managedNote",
        )}
      </p>
      {python.found ? (
        <p class={styles.note}>{t("settings.analysis.extras.hint")}</p>
      ) : (
        <div role="group" aria-label={t("settings.analysis.installHint.title")}>
          <h4 class={styles.sectionTitle}>{t("settings.analysis.installHint.title")}</h4>
          <p class={styles.note}>
            {python.hints.system}
            {python.hints.heading ? ` · ${python.hints.heading}` : ""}
          </p>
          <pre class={styles.note}>
            <code>{python.hints.primary}</code>
          </pre>
          {python.hints.alternatives.map((alternative) => (
            <p key={alternative} class={styles.note}>
              {alternative}
            </p>
          ))}
          {python.hints.notes.map((note) => (
            <p key={note} class={styles.note}>
              {note}
            </p>
          ))}
          <p class={styles.note}>{t("settings.analysis.installHint.afterInstall")}</p>
        </div>
      )}
    </>
  );
}

export function AnalysisPage() {
  const workspace = settingsWorkspace();
  const status = useLoad(workspace ? () => api.analysis(workspace.id) : undefined, [workspace?.id]);
  const overview = useLoad(workspace ? () => api.settings(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const [busy, setBusy] = useState(false);
  const readOnly = !!overview.data?.readOnly;
  const settings: SettingInfo[] = overview.data?.settings ?? [];
  const save = async (key: AnalysisKey, value: number | boolean) => {
    if (!workspace || !overview.data) return;
    try {
      await api.setSetting(workspace.id, key, value);
      overview.set({
        ...overview.data,
        settings: overview.data.settings.map((s) => (s.key === key ? { ...s, value } : s)),
      });
      status.reload();
    } catch (error) {
      showToast(errorMessage(error));
      throw error;
    }
  };
  const enabled = analysisSetting(settings, "analysis.enabled");
  const number = (key: AnalysisKey, fallback: number) => {
    const value = analysisSetting(settings, key);
    return typeof value === "number" ? value : fallback;
  };
  const sweep = status.data?.retention.lastSweep;
  return (
    <>
      <PageIntro title={t("settings.analysis.title")} body={t("settings.analysis.lead")} />
      <Status
        loading={(overview.loading && !overview.data) || (status.loading && !status.data)}
        error={overview.error ?? status.error}
        empty={!workspace ? "settings.noWorkspace" : undefined}
      />
      {status.data?.readOnly ? (
        <p class={styles.note}>{t("settings.analysis.readOnlyRuntime")}</p>
      ) : enabled === false ? (
        <p class={styles.note}>{t("settings.analysis.disabled")}</p>
      ) : null}
      {status.data ? <RuntimeFacts status={status.data} /> : null}
      {overview.data ? (
        <>
          {readOnly ? <p class={styles.note}>{t("settings.readOnly")}</p> : null}
          <ul class={styles.settingList}>
            <li class={styles.settingRow}>
              <label class={styles.settingLabel} for="analysis-enabled">
                <span>{t("settings.analysis.enabled")}</span>
                <code class={styles.settingKey}>analysis.enabled</code>
              </label>
              <Switch
                checked={enabled !== false}
                label={t("settings.analysis.enabled")}
                disabled={readOnly}
                busy={busy}
                onChange={(value) => {
                  setBusy(true);
                  save("analysis.enabled", value)
                    .catch(() => undefined)
                    .finally(() => setBusy(false));
                }}
              />
            </li>
            <NumberRow
              id="analysis-timeout"
              label={t("settings.analysis.timeout")}
              keyName="analysis.limits.timeoutMs"
              value={msToSeconds(number("analysis.limits.timeoutMs", 120_000))}
              min={TIMEOUT_SECONDS.min}
              max={TIMEOUT_SECONDS.max}
              disabled={readOnly}
              parse={secondsToMs}
              onSave={(ms) => save("analysis.limits.timeoutMs", ms)}
            />
          </ul>
          <p class={styles.note}>{t("settings.analysis.enabledHint")}</p>
          <h4 class={styles.sectionTitle}>{t("settings.analysis.retention")}</h4>
          <p class={styles.note}>{t("settings.analysis.retention.lead")}</p>
          <ul class={styles.settingList}>
            {(
              [
                ["analysis.retention.jobsDays", "settings.analysis.retention.jobs", 30],
                [
                  "analysis.retention.intermediateDays",
                  "settings.analysis.retention.intermediate",
                  7,
                ],
                ["analysis.retention.artifactsDays", "settings.analysis.retention.artifacts", 0],
              ] as const
            ).map(([key, label, fallback]) => (
              <NumberRow
                key={key}
                id={`analysis-${key}`}
                label={t(label)}
                keyName={key}
                value={number(key, fallback)}
                min={RETENTION_DAYS.min}
                max={RETENTION_DAYS.max}
                disabled={readOnly}
                onSave={(value) => save(key, value)}
              />
            ))}
          </ul>
          <p class={styles.note}>
            {sweep !== undefined
              ? t("settings.analysis.retention.lastSweep", {
                  time: new Date(sweep).toLocaleString(),
                })
              : t("settings.analysis.retention.never")}
          </p>
        </>
      ) : null}
    </>
  );
}
