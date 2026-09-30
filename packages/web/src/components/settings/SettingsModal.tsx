import { useEffect, useRef, useState } from "preact/hooks";
import { LOCALES, locale, setLocale, t } from "../../i18n/index.ts";
import { settingsOpen } from "../../store/app.ts";
import {
  type Density,
  density,
  setDensity,
  setTheme,
  type ThemePref,
  theme,
} from "../../store/prefs.ts";
import { Icon } from "../icons.tsx";
import styles from "./settings.module.css";

type Page = "general" | "appearance";

function Choice<T extends string>(props: {
  legend: string;
  value: T;
  options: Array<{ id: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset class={styles.fieldset}>
      <legend class={styles.legend}>{props.legend}</legend>
      <div class={styles.choices}>
        {props.options.map((option) => (
          <label key={option.id} class={styles.choice}>
            <input
              type="radio"
              name={props.legend}
              checked={props.value === option.id}
              onChange={() => props.onChange(option.id)}
            />
            <span>{option.label}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

/**
 * Settings (phase 3 subset): language, theme and density. Models, plugins, skills, MCP and agent
 * presets arrive in phase 5 (RF-14) in this same modal.
 */
export function SettingsModal() {
  const [page, setPage] = useState<Page>("general");
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLElement>("button, input")?.focus();
    return () => previous?.focus();
  }, []);
  const close = () => {
    settingsOpen.value = false;
  };
  return (
    <div
      class={styles.backdrop}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close();
      }}
    >
      <div
        ref={dialog}
        class={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
        onKeyDown={(event) => {
          if (event.key === "Escape") close();
          if (event.key === "Tab") {
            const focusable = [
              ...(dialog.current?.querySelectorAll<HTMLElement>("button, input") ?? []),
            ];
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
        <nav class={styles.nav}>
          <h2 id="settings-title" class={styles.heading}>
            {t("settings.title")}
          </h2>
          {(["general", "appearance"] as const).map((id) => (
            <button
              key={id}
              type="button"
              class={styles.navItem}
              aria-current={page === id ? "page" : undefined}
              onClick={() => setPage(id)}
            >
              <Icon name={id === "general" ? "settings" : "sparkle"} size={17} />
              {t(`settings.${id}`)}
            </button>
          ))}
        </nav>
        <div class={styles.content}>
          <button
            type="button"
            class={`icon-btn ${styles.close}`}
            aria-label={t("common.close")}
            onClick={close}
          >
            <Icon name="x" size={18} />
          </button>
          <h3 class={styles.pageTitle}>{t(`settings.${page}`)}</h3>
          {page === "general" ? (
            <>
              <Choice
                legend={t("settings.language")}
                value={locale.value}
                options={LOCALES.map((id) => ({ id, label: t(`language.${id}`) }))}
                onChange={setLocale}
              />
              <p class={styles.note}>{t("settings.more")}</p>
            </>
          ) : (
            <>
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
          )}
        </div>
      </div>
    </div>
  );
}
