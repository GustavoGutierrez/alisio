import { useEffect, useRef } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { currentId, permissionsOpen } from "../../store/app.ts";
import { grants, liveGrants, revokeGrant } from "../../store/artifacts.ts";
import { Icon } from "../icons.tsx";
import styles from "./header.module.css";

const LABELS: Record<string, Parameters<typeof t>[0]> = {
  "analysis.run": "permissions.analysisRun",
};

const time = (at: number) =>
  new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

/**
 * "Session permissions" (spec §15.5): the saved grants of the session (for example Python
 * analysis allowed for this session) with Revoke. Refreshed on `capabilities_changed`.
 */
export function PermissionsPopover() {
  const panel = useRef<HTMLDivElement>(null);
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
      <p class={styles.popoverTitle}>{t("permissions.title")}</p>
      {!state ? (
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

/** The header button that toggles the popover. */
export function PermissionsButton() {
  return (
    <span class={styles.permissions}>
      <button
        type="button"
        class="icon-btn"
        aria-haspopup="dialog"
        aria-expanded={permissionsOpen.value}
        aria-label={t("permissions.title")}
        title={t("permissions.title")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={() => {
          permissionsOpen.value = !permissionsOpen.value;
        }}
      >
        <Icon name="key" size={16} />
      </button>
      {permissionsOpen.value ? <PermissionsPopover /> : null}
    </span>
  );
}
