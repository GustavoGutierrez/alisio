/**
 * Settings → Appearance: theme and process-row density (stored in this browser) plus the icon
 * theme of the web dock (`web.iconTheme`, a global setting served by the server). The theme list
 * comes from the installed `icon-theme` plugins, so the page also works with none installed.
 */
import { t } from "../../i18n/index.ts";
import { api, showToast } from "../../store/app.ts";
import { loadIconTheme, resetIconTheme } from "../../store/icon-theme.ts";
import {
  type Density,
  density,
  setDensity,
  setTheme,
  type ThemePref,
  theme,
} from "../../store/prefs.ts";
import styles from "./settings.module.css";
import { Choice, errorMessage, PageIntro, Status, settingsWorkspace, useLoad } from "./shared.tsx";

export function AppearancePage() {
  const workspace = settingsWorkspace();
  const overview = useLoad(workspace ? () => api.settings(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const catalog = useLoad(workspace ? () => api.iconThemes(workspace.id) : undefined, [
    workspace?.id,
  ]);
  const current =
    (overview.data?.settings.find((setting) => setting.key === "web.iconTheme")?.value as
      | string
      | undefined) ?? "none";
  const themes = catalog.data?.themes ?? [];
  const choose = async (id: string) => {
    if (!workspace || !overview.data) return;
    try {
      await api.setSetting(workspace.id, "web.iconTheme", id);
      overview.set({
        ...overview.data,
        settings: overview.data.settings.map((setting) =>
          setting.key === "web.iconTheme" ? { ...setting, value: id } : setting,
        ),
      });
      // The dock memoizes the manifest per workspace: drop it and reload with the new theme.
      resetIconTheme();
      void loadIconTheme(workspace.id);
    } catch (error) {
      showToast(errorMessage(error));
    }
  };
  return (
    <>
      <PageIntro title={t("settings.appearance")} body={t("appearance.lead")} />
      <Choice<ThemePref>
        legend={t("settings.theme")}
        value={theme.value}
        options={(["dark", "light", "system"] as const).map((id) => ({
          id,
          label: t(`theme.${id}`),
        }))}
        onChange={setTheme}
      />
      <Choice<Density>
        legend={t("settings.density")}
        value={density.value}
        options={(["compact", "detailed"] as const).map((id) => ({
          id,
          label: t(`density.${id}`),
        }))}
        onChange={setDensity}
      />
      <Status
        loading={catalog.loading && !catalog.data}
        error={catalog.error}
        empty={!workspace ? "settings.noWorkspace" : undefined}
      />
      {catalog.data ? (
        <>
          <Choice
            legend={t("appearance.iconTheme")}
            value={current}
            options={[
              { id: "none", label: t("appearance.iconTheme.none") },
              ...themes.map((item) => ({ id: item.id, label: item.label })),
            ]}
            onChange={(id) => void choose(id)}
          />
          {themes.length === 0 ? (
            <p class={styles.note}>{t("appearance.iconTheme.empty")}</p>
          ) : null}
        </>
      ) : null}
    </>
  );
}
