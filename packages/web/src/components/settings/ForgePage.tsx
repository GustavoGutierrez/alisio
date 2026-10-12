/**
 * Settings → Forja (Forja spec §11.2, Python spec §9.4): where the agent runs code. The JavaScript
 * engine (state, version, WASM hash, host, limits, switch), the Python backends and the runtime
 * state the Data analysis page used to show (`PythonSection`), the scratchpad settings and the
 * guides switch. Only the switches and the analysis numbers are editable here; every other value
 * is read only and shows the configuration key that changes it.
 */
import type { ForgeOverview } from "@alisio/sdk";
import { Fragment } from "preact";
import { useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import type { AnalysisKey } from "../../util/analysis.ts";
import { formatSize } from "../../util/artifacts.ts";
import { type ForgeKey, javascriptFacts } from "../../util/forge-page.ts";
import { PythonSection } from "./PythonSection.tsx";
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

function SwitchRow(props: {
  id: string;
  label: string;
  keyName: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <li class={styles.settingRow}>
      <label class={styles.settingLabel} for={props.id}>
        <span>{props.label}</span>
        <code class={styles.settingKey}>{props.keyName}</code>
      </label>
      <Switch
        checked={props.checked}
        label={props.label}
        disabled={props.disabled}
        busy={busy}
        onChange={(value) => {
          setBusy(true);
          props
            .onChange(value)
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}
      />
    </li>
  );
}

function JavascriptSection(props: {
  forge: ForgeOverview;
  enabled: boolean;
  readOnly: boolean;
  save: (key: ForgeKey, value: boolean) => Promise<void>;
}) {
  const facts = javascriptFacts(props.forge);
  const { scratch } = props.forge;
  return (
    <>
      <h4 class={styles.sectionTitle}>{t("forge.javascript")}</h4>
      <p class={styles.lead}>{t("forge.javascript.lead")}</p>
      <dl class={styles.facts} data-testid="forge-javascript">
        <dt>{t("forge.status")}</dt>
        <dd>
          <Pill tone={!props.enabled ? "off" : facts.verified ? "ok" : "danger"}>
            {t(
              !props.enabled
                ? "forge.js.off"
                : facts.verified
                  ? "forge.js.ready"
                  : "forge.js.unverified",
            )}
          </Pill>
          {facts.verification ? <> {facts.verification}</> : null}
        </dd>
        <dt>{t("forge.js.engine")}</dt>
        <dd>
          <code>{facts.version}</code>
        </dd>
        <dt>{t("forge.js.hash")}</dt>
        <dd>
          <code title={props.forge.javascript.wasmSha256}>{facts.hash}…</code>
        </dd>
        <dt>{t("forge.js.host")}</dt>
        <dd>
          {t(`forge.host.${facts.host}`)}{" "}
          <code class={styles.settingKey}>forge.javascript.host={facts.hostSetting}</code>
        </dd>
        {facts.limits.map((limit) => (
          <Fragment key={limit.id}>
            <dt>{t(`forge.limit.${limit.id}`)}</dt>
            <dd>{limit.value}</dd>
          </Fragment>
        ))}
        <dt>{t("forge.scratch")}</dt>
        <dd>
          {scratch.enabled
            ? t("forge.scratchValue", {
                size: formatSize(scratch.maxBytes),
                days: scratch.retentionDays,
              })
            : t("forge.scratchOff")}
        </dd>
      </dl>
      <ul class={styles.settingList}>
        <SwitchRow
          id="forge-javascript-enabled"
          label={t("forge.js.enable")}
          keyName="forge.javascript.enabled"
          checked={props.enabled}
          disabled={props.readOnly}
          onChange={(value) => props.save("forge.javascript.enabled", value)}
        />
      </ul>
      <p class={styles.note}>{t("forge.js.enableHint")}</p>
      <p class={styles.note}>{t("forge.limitsHint")}</p>
    </>
  );
}

export function ForgePage() {
  const workspace = settingsWorkspace();
  const forge = useLoad(workspace ? () => api.forge(workspace.id) : undefined, [workspace?.id]);
  const status = useLoad(workspace ? () => api.analysis(workspace.id) : undefined, [workspace?.id]);
  const overview = useLoad(workspace ? () => api.settings(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const readOnly = !!overview.data?.readOnly;
  const settings = overview.data?.settings;
  const save = async (key: ForgeKey | AnalysisKey, value: number | boolean) => {
    if (!workspace || !overview.data) return;
    try {
      await api.setSetting(workspace.id, key, value);
      overview.set({
        ...overview.data,
        settings: overview.data.settings.map((s) => (s.key === key ? { ...s, value } : s)),
      });
      // The workspace application is rebuilt after its runs: read the engines again.
      forge.reload();
      status.reload();
    } catch (error) {
      showToast(errorMessage(error));
      throw error;
    }
  };
  const flag = (key: ForgeKey, fallback: boolean): boolean => {
    const value = settings?.find((s) => s.key === key)?.value;
    return typeof value === "boolean" ? value : fallback;
  };
  return (
    <>
      <PageIntro title={t("settings.forge.title")} body={t("settings.forge.lead")} />
      <Status
        loading={
          (overview.loading && !overview.data) ||
          (status.loading && !status.data) ||
          (forge.loading && !forge.data)
        }
        error={overview.error ?? status.error ?? forge.error}
        empty={!workspace ? "settings.noWorkspace" : undefined}
      />
      {readOnly ? <p class={styles.note}>{t("settings.readOnly")}</p> : null}
      {forge.data ? (
        <JavascriptSection
          forge={forge.data}
          enabled={flag("forge.javascript.enabled", forge.data.javascript.enabled)}
          readOnly={readOnly}
          save={save}
        />
      ) : null}
      <PythonSection status={status.data} settings={settings} readOnly={readOnly} save={save} />
      {forge.data ? (
        <>
          <h4 class={styles.sectionTitle}>{t("forge.guides")}</h4>
          <ul class={styles.settingList}>
            <SwitchRow
              id="forge-guides-enabled"
              label={t("forge.guides.enable")}
              keyName="forge.guides.enabled"
              checked={flag("forge.guides.enabled", forge.data.guides.enabled)}
              disabled={readOnly}
              onChange={(value) => save("forge.guides.enabled", value)}
            />
          </ul>
          <p class={styles.note}>{t("forge.guides.hint")}</p>
        </>
      ) : null}
    </>
  );
}
