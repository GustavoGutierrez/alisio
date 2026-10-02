import { useEffect, useRef, useState } from "preact/hooks";
import { type MessageKey, t } from "../../i18n/index.ts";
import { currentId, detail, permissionsOpen, setPreset } from "../../store/app.ts";
import { grants, liveGrants, revokeGrant } from "../../store/artifacts.ts";
import { needsFullAccessConfirm } from "../../store/modes.ts";
import { modeChoices } from "../../store/permission-modes.ts";
import { Icon } from "../icons.tsx";
import styles from "./header.module.css";

const LABELS: Record<string, Parameters<typeof t>[0]> = {
  "analysis.run": "permissions.analysisRun",
};

/** Ask and Full access reuse the preset names; Auto is the mode name of `workspace-write`. */
const modeLabel = (mode: string, preset: string): string =>
  mode === "auto" ? t("mode.auto") : t(`preset.${preset}` as MessageKey);

const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * The permissions popover (also opened by `/permission`, alias `/permissions`): the three
 * permission modes (Ask, Auto, Full access), the status of the session and, behind "Manage saved
 * permissions…", the saved grants of the session (for example Python analysis allowed for this
 * session) with Revoke. Grants refresh on `capabilities_changed`.
 */
export function PermissionsMenu() {
  const panel = useRef<HTMLDivElement>(null);
  const [manage, setManage] = useState(false);
  const session = detail.value;
  const choices = session ? modeChoices(session.presets, session.preset) : [];
  const current = choices.find((choice) => choice.checked);
  const sessionId = currentId.value;
  const state = grants.value?.sessionId === sessionId ? grants.value : undefined;
  const items = state ? liveGrants(state.items) : [];
  useEffect(() => {
    panel.current?.focus();
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== "Escape") return;
      if (event instanceof MouseEvent && panel.current?.contains(event.target as Node)) return;
      permissionsOpen.value = false;
    };
    document.addEventListener("keydown", close);
    document.addEventListener("mousedown", close);
    return () => {
      document.removeEventListener("keydown", close);
      document.removeEventListener("mousedown", close);
    };
  }, []);
  return (
    <div
      ref={panel}
      class={styles.popover}
      role="dialog"
      aria-label={t("permissions.title")}
      tabIndex={-1}
    >
      <p class={styles.popoverTitle}>{t("modes.title")}</p>
      <ul class={styles.modes} role="radiogroup" aria-label={t("modes.title")}>
        {choices.map((choice) => (
          <li key={choice.mode}>
            <button
              type="button"
              role="radio"
              aria-checked={choice.checked}
              disabled={!choice.available}
              class={styles.mode}
              data-checked={choice.checked ? "true" : undefined}
              onClick={() => {
                if (!session || choice.checked) return;
                // Full access is not a sandbox: confirm before switching it on.
                if (
                  needsFullAccessConfirm(choice.preset, session.preset) &&
                  !window.confirm(t("modes.fullConfirm"))
                )
                  return;
                void setPreset(choice.preset);
              }}
            >
              <strong>{modeLabel(choice.mode, choice.preset)}</strong>
              <span class={styles.grantMeta}>
                {choice.reason ?? t(`presetHint.${choice.preset}` as MessageKey)}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <p class={styles.modeStatus} role="status">
        {current
          ? t("modes.status", { mode: modeLabel(current.mode, current.preset) })
          : t("modes.statusReadOnly")}
      </p>
      <button
        type="button"
        class={styles.manage}
        aria-expanded={manage}
        onClick={() => setManage(!manage)}
      >
        {t("modes.manage")}
      </button>
      {!manage ? null : !state ? (
        <p class={styles.popoverEmpty}>{t("common.loading")}</p>
      ) : state.error ? (
        <p class={styles.popoverEmpty}>{t("permissions.loadFailed")}</p>
      ) : !items.length ? (
        <p class={styles.popoverEmpty}>{t("permissions.none")}</p>
      ) : (
        <ul class={styles.grants}>
          {items.map((grant) => (
            <li key={grant.id} class={styles.grant}>
              <span>
                <strong>{t(LABELS[grant.capability] ?? "permissions.analysisRun")}</strong>
                <span class={styles.grantMeta}>
                  {t("permissions.allowedSession", { time: time(grant.createdAt) })}
                </span>
              </span>
              <button
                type="button"
                class={styles.revoke}
                onClick={() => sessionId && void revokeGrant(sessionId, grant.id)}
              >
                {t("permissions.revoke")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
