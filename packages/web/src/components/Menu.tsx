import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import styles from "./menu.module.css";

export interface MenuItem {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  checked?: boolean;
}

export interface MenuGroup {
  label?: string;
  items: MenuItem[];
  onSelect: (id: string) => void;
}

/**
 * A button with a popover of radio items (WAI-ARIA menu button): arrows move, Enter/Space
 * select, Esc closes and returns focus to the button, clicks outside close.
 */
export function Menu(props: {
  groups: MenuGroup[];
  children: ComponentChildren;
  label: string;
  class?: string;
  disabled?: boolean;
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const items = [...(list.current?.querySelectorAll<HTMLElement>("[role=menuitemradio]") ?? [])];
    (
      items.find(
        (i) => i.getAttribute("aria-checked") === "true" && !i.hasAttribute("aria-disabled"),
      ) ?? items.find((i) => !i.hasAttribute("aria-disabled"))
    )?.focus();
    const outside = (event: MouseEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) button.current?.focus();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    const items = [
      ...(list.current?.querySelectorAll<HTMLElement>(
        "[role=menuitemradio]:not([aria-disabled])",
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      items[(index + step + items.length) % items.length]?.focus();
    } else if (event.key === "Home") {
      event.preventDefault();
      items[0]?.focus();
    } else if (event.key === "End") {
      event.preventDefault();
      items.at(-1)?.focus();
    } else if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") close(false);
  };

  return (
    <div class={styles.root} ref={root}>
      <button
        ref={button}
        type="button"
        class={props.class ?? styles.trigger}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={props.label}
        title={props.label}
        disabled={props.disabled}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowDown") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        {props.children}
      </button>
      {open ? (
        <div
          ref={list}
          class={styles.popover}
          data-align={props.align ?? "start"}
          role="menu"
          aria-label={props.label}
          onKeyDown={onKeyDown}
        >
          {props.groups.map((group, g) => (
            <div key={g} role="group" aria-label={group.label} class={styles.group}>
              {group.label ? (
                <div class={styles.groupLabel} aria-hidden="true">
                  {group.label}
                </div>
              ) : null}
              {group.items.map((item) => (
                <div
                  key={item.id}
                  role="menuitemradio"
                  tabIndex={-1}
                  aria-checked={!!item.checked}
                  aria-disabled={item.disabled ? "true" : undefined}
                  class={styles.item}
                  onClick={() => {
                    if (item.disabled) return;
                    group.onSelect(item.id);
                    close();
                  }}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && !item.disabled) {
                      event.preventDefault();
                      group.onSelect(item.id);
                      close();
                    }
                  }}
                >
                  <span class={styles.check} aria-hidden="true">
                    {item.checked ? "✓" : ""}
                  </span>
                  <span class={styles.itemText}>
                    <span class={styles.itemLabel}>{item.label}</span>
                    {item.description ? (
                      <span class={styles.itemDescription}>{item.description}</span>
                    ) : null}
                  </span>
                </div>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
