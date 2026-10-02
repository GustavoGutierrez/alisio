import type { ComponentType } from "preact";
import { useEffect, useState } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { permissionsOpen } from "../../store/app.ts";
import { Icon } from "../icons.tsx";
import styles from "./header.module.css";

/**
 * The permissions popover (modes, status and saved permissions) is its own chunk: it loads the
 * first time the header button or `/permission` opens it, keeping the initial bundle small.
 */
function PermissionsPopover() {
  const [View, setView] = useState<ComponentType | undefined>();
  useEffect(() => {
    let alive = true;
    void import("./PermissionsMenu.tsx").then((m) => {
      if (alive) setView(() => m.PermissionsMenu);
    });
    return () => {
      alive = false;
    };
  }, []);
  return View ? <View /> : null;
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
