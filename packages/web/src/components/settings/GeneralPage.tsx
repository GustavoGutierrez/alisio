/**
 * Settings → General: the UI language (this browser) and the agent settings of the workspace
 * application (`SettableSettingKey`, written to the global config file). Terminal-only (`tui.*`),
 * agent-selection (`agents.*`), data-analysis and web (`web.*`, shown in Appearance) keys live
 * elsewhere.
 */
import type { SettingInfo } from "@alisio/sdk";
import { useState } from "preact/hooks";
import { LOCALES, locale, setLocale, t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { settingLabel } from "./labels.ts";
import styles from "./settings.module.css";
import {
  Choice,
  errorMessage,
  PageIntro,
  Status,
  Switch,
  settingsWorkspace,
  useLoad,
} from "./shared.tsx";

const HIDDEN = /^(tui|agents|analysis|web)\./;

function SettingRow(props: {
  setting: SettingInfo;
  disabled: boolean;
  onSave: (value: string | number | boolean | null) => Promise<void>;
}) {
  const { setting } = props;
  const [draft, setDraft] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const save = async (value: string | number | boolean | null) => {
    setBusy(true);
    try {
      await props.onSave(value);
      setDraft(undefined);
    } finally {
      setBusy(false);
    }
  };
  const label = settingLabel(setting.key, locale.value);
  const id = `setting-${setting.key}`;
  const commitText = () => {
    if (draft === undefined) return;
    if (setting.kind === "number") {
      const value = Number(draft);
      if (draft.trim() === "" || !Number.isFinite(value)) return setDraft(undefined);
      void save(value);
    } else void save(draft.trim() === "" ? null : draft);
  };
  return (
    <li class={styles.settingRow}>
      <label class={styles.settingLabel} for={id}>
        <span>{label}</span>
        <code class={styles.settingKey}>{setting.key}</code>
      </label>
      {setting.kind === "boolean" ? (
        <Switch
          checked={setting.value === true}
          label={label}
          disabled={props.disabled}
          busy={busy}
          onChange={(value) => void save(value)}
        />
      ) : setting.kind === "enum" ? (
        <select
          id={id}
          class={styles.input}
          disabled={props.disabled || busy}
          value={typeof setting.value === "string" ? setting.value : ""}
          onChange={(event) => {
            const value = (event.target as HTMLSelectElement).value;
            void save(value === "" ? null : value);
          }}
        >
          <option value="">{t("settings.default")}</option>
          {(setting.options ?? []).map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : (
        <input
          id={id}
          class={styles.input}
          type={setting.kind === "number" ? "number" : "text"}
          disabled={props.disabled || busy}
          value={draft ?? (setting.value === undefined ? "" : String(setting.value))}
          onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
          onBlur={commitText}
          onKeyDown={(event) => {
            if (event.key === "Enter") commitText();
            if (event.key === "Escape" && draft !== undefined) {
              event.stopPropagation();
              setDraft(undefined);
            }
          }}
        />
      )}
    </li>
  );
}

export function GeneralPage() {
  const workspace = settingsWorkspace();
  const overview = useLoad(workspace ? () => api.settings(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const save = async (key: string, value: string | number | boolean | null) => {
    if (!workspace || !overview.data) return;
    try {
      await api.setSetting(workspace.id, key, value);
      overview.set({
        ...overview.data,
        settings: overview.data.settings.map((s) =>
          s.key === key ? { ...s, ...(value === null ? { value: undefined } : { value }) } : s,
        ),
      });
    } catch (error) {
      showToast(errorMessage(error));
      throw error;
    }
  };
  const settings = (overview.data?.settings ?? []).filter((s) => !HIDDEN.test(s.key));
  return (
    <>
      <PageIntro title={t("settings.general")} />
      <Choice
        legend={t("settings.language")}
        value={locale.value}
        options={LOCALES.map((id) => ({ id, label: t(`language.${id}`) }))}
        onChange={setLocale}
      />
      <h4 class={styles.sectionTitle}>{t("settings.agentSettings")}</h4>
      <p class={styles.note}>
        {t("settings.agentSettingsLead")}
        {overview.data ? (
          <>
            {" "}
            <code>{overview.data.settingsPath}</code>
          </>
        ) : null}
      </p>
      <Status
        loading={overview.loading && !overview.data}
        error={overview.error}
        empty={!workspace ? "settings.noWorkspace" : undefined}
      />
      {overview.data?.readOnly ? <p class={styles.note}>{t("settings.readOnly")}</p> : null}
      <ul class={styles.settingList}>
        {settings.map((setting) => (
          <SettingRow
            key={setting.key}
            setting={setting}
            disabled={!!overview.data?.readOnly}
            onSave={(value) => save(setting.key, value)}
          />
        ))}
      </ul>
    </>
  );
}
