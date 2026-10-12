/**
 * Settings → Forja, Python section (spec §18 of the analysis feature, Python spec §9.4): the runtime
 * state read only (mode, Python found or how to install it, optional packages, container engine
 * and image), one card per backend (readiness, isolation, profiles, reason, setup command), the
 * isolation policy and the runtime in use (read only, with the key that changes them), and the
 * settings that can be edited: the switches, the execution timeout and the retention. Python needs
 * no configuration; nothing here is required to run an analysis.
 */
import type { AnalysisStatus, SettingInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
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
import {
  type BackendCard,
  backendCards,
  effectiveBackend,
  modeLabelKey,
} from "../../util/forge-page.ts";
import { CopyButton } from "../CopyButton.tsx";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";
import { Pill, Switch } from "./shared.tsx";

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

/** The backend that runs scripts now, or the configured mode when the server lists no backends. */
function effectiveMode(status: AnalysisStatus): "oci" | "wasm" | "managed" {
  const current = effectiveBackend(status.mode, status.isolation, status.backends ?? []);
  if (current) return current;
  return status.mode === "auto" ? "managed" : status.mode;
}

/** Green only when the code would run isolated; the host is a warning, nothing ready is off. */
function modeTone(status: AnalysisStatus): "ok" | "warn" | "off" {
  if (!status.backends?.length) return status.mode === "oci" ? "ok" : "warn";
  const current = effectiveBackend(status.mode, status.isolation, status.backends);
  return current === undefined ? "off" : current === "managed" ? "warn" : "ok";
}

function BackendCardView({ card }: { card: BackendCard }) {
  return (
    <li class={styles.backend} data-ready={card.ready ? "true" : "false"}>
      <div class={styles.backendHead}>
        <h5 class={styles.backendName}>{t(`forge.backend.${card.id}`)}</h5>
        <Pill tone={card.ready ? "ok" : "off"}>
          {t(card.ready ? "forge.ready" : "forge.notReady")}
        </Pill>
        {card.current ? <span class={styles.chip}>{t("forge.inUse")}</span> : null}
      </div>
      <p class={styles.isolation} data-sandboxed={card.sandboxed ? "true" : "false"}>
        <Icon name={card.icon} size={14} />
        {t(card.isolationKey)}
      </p>
      {card.profiles.length ? (
        <p class={styles.profiles}>
          {t("forge.profiles")}{" "}
          {card.profiles.map((profile) => (
            <span key={profile} class={styles.chip}>
              {profile}
            </span>
          ))}
        </p>
      ) : null}
      {card.reason ? <p class={styles.reasonText}>{card.reason}</p> : null}
      {card.setup ? (
        <div class={styles.command}>
          <code>{card.setup}</code>
          <CopyButton text={() => card.setup ?? ""} label={t("forge.copyCommand")} />
        </div>
      ) : null}
    </li>
  );
}

/** One card per backend plus the policy and runtime that choose between them (read only). */
function Backends({ status }: { status: AnalysisStatus }) {
  const cards = backendCards(status);
  const current = cards.find((card) => card.current);
  return (
    <>
      <h4 class={styles.sectionTitle}>{t("forge.backends")}</h4>
      {cards.length ? (
        <ul class={styles.backendList} aria-label={t("forge.backends")}>
          {cards.map((card) => (
            <BackendCardView key={card.id} card={card} />
          ))}
        </ul>
      ) : null}
      <dl class={styles.facts} data-testid="forge-policy">
        <dt>{t("forge.runtimeSetting")}</dt>
        <dd>
          <code>{status.mode}</code> <code class={styles.settingKey}>analysis.runtime</code>
        </dd>
        <dt>{t("forge.isolationPolicy")}</dt>
        <dd>
          <code>{status.isolation ?? "preferred"}</code>{" "}
          <code class={styles.settingKey}>analysis.isolation</code>
        </dd>
        <dt>{t("forge.runsOn")}</dt>
        <dd>{current ? t(`forge.backend.${current.id}`) : t("forge.noneReady")}</dd>
      </dl>
      <p class={styles.note}>
        {t("forge.policyHint", { policy: status.isolation ?? "preferred" })}
      </p>
    </>
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
          <Pill tone={modeTone(status)}>{t(modeLabelKey(status.mode))}</Pill>
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
          effectiveMode(status) === "oci"
            ? "settings.analysis.containerNote"
            : effectiveMode(status) === "wasm"
              ? "settings.analysis.wasmNote"
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

/** The Python half of Settings → Forja; the page loads the data and owns the saving. */
export function PythonSection(props: {
  status: AnalysisStatus | undefined;
  /** The workspace's settings; absent while they load. */
  settings: SettingInfo[] | undefined;
  readOnly: boolean;
  save: (key: AnalysisKey, value: number | boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const { readOnly, status, save } = props;
  const settings = props.settings ?? [];
  const enabled = analysisSetting(settings, "analysis.enabled");
  const smartDashboard = analysisSetting(settings, "analysis.smartDashboard");
  const number = (key: AnalysisKey, fallback: number) => {
    const value = analysisSetting(settings, key);
    return typeof value === "number" ? value : fallback;
  };
  const sweep = status?.retention.lastSweep;
  return (
    <>
      <h4 class={styles.sectionTitle}>{t("forge.python")}</h4>
      <p class={styles.lead}>{t("settings.analysis.lead")}</p>
      {status?.readOnly ? (
        <p class={styles.note}>{t("settings.analysis.readOnlyRuntime")}</p>
      ) : enabled === false ? (
        <p class={styles.note}>{t("settings.analysis.disabled")}</p>
      ) : null}
      {status ? <Backends status={status} /> : null}
      {status ? <RuntimeFacts status={status} /> : null}
      {props.settings ? (
        <>
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
            <li class={styles.settingRow}>
              <label class={styles.settingLabel} for="analysis-smart-dashboard">
                <span>{t("settings.analysis.smartDashboard")}</span>
                <code class={styles.settingKey}>analysis.smartDashboard</code>
              </label>
              <Switch
                checked={smartDashboard !== false}
                label={t("settings.analysis.smartDashboard")}
                disabled={readOnly}
                busy={busy}
                onChange={(value) => {
                  setBusy(true);
                  save("analysis.smartDashboard", value)
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
          <p class={styles.note}>{t("settings.analysis.smartDashboardHint")}</p>
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
