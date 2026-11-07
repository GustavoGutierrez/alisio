import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import styles from "./settings.module.css";

/**
 * A modal confirmation: focus lands on the safe button, Escape cancels, Tab stays inside. Used for
 * installs (security warning) and uninstalls.
 */
export function ConfirmDialog(props: {
  title: string;
  children: ComponentChildren;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  checkbox?: { label: string; checked: boolean; onChange: (checked: boolean) => void };
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  const confirm = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    (props.danger ? cancel : confirm).current?.focus();
  }, []);
  const keys = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      props.onCancel();
      return;
    }
    if (event.key !== "Tab") return;
    const items = [...(root.current?.querySelectorAll<HTMLElement>("button, input") ?? [])];
    const first = items[0];
    const last = items.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };
  return (
    <div class={styles.dialogScrim} onKeyDown={keys}>
      <div
        ref={root}
        class={styles.confirmDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="plugin-dialog-title"
      >
        <h4 id="plugin-dialog-title" class={styles.dialogTitle}>
          {props.title}
        </h4>
        <div class={styles.dialogBody}>{props.children}</div>
        {props.checkbox ? (
          <label class={styles.checkLine}>
            <input
              type="checkbox"
              checked={props.checkbox.checked}
              onChange={(event) =>
                props.checkbox?.onChange((event.target as HTMLInputElement).checked)
              }
            />
            <span>{props.checkbox.label}</span>
          </label>
        ) : null}
        <div class={styles.dialogActions}>
          <button type="button" ref={cancel} class={styles.ghostButton} onClick={props.onCancel}>
            {props.cancelLabel}
          </button>
          <button
            type="button"
            ref={confirm}
            class={props.danger ? styles.dangerButton : styles.primaryButton}
            onClick={props.onConfirm}
          >
            {props.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
