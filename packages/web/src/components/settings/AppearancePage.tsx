/** Settings → Appearance: theme and process-row density (stored in this browser). */
import { t } from "../../i18n/index.ts";
import {
  type Density,
  density,
  setDensity,
  setTheme,
  type ThemePref,
  theme,
} from "../../store/prefs.ts";
import { Choice, PageIntro } from "./shared.tsx";

export function AppearancePage() {
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
    </>
  );
}
