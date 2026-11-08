/**
 * The project color picker: a radio group of colored circles. Lazy chunk (loaded when the user
 * picks "Color" in a project menu); its texts live here, not in the always-loaded dictionary.
 * `PALETTE_IDS` mirrors the SDK's `WORKSPACE_COLOR_IDS`, which the server validates against.
 */
import { useEffect, useRef } from "preact/hooks";
import { format } from "../../i18n/format.ts";
import { locale } from "../../i18n/index.ts";
import { colorName, names, nextColorIndex, paletteOptions } from "./palette.ts";
import styles from "./sidebar.module.css";

export function ColorPalette(props: {
  name: string;
  current?: string;
  onPick: (color: string | null) => void;
  onClose: () => void;
  /** Shown inside a dialog: no focus grab, no Escape handling (the dialog owns both). */
  inline?: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const options = paletteOptions(props.current);
  const selected = options.findIndex((o) => o.checked);
  const radios = () => [...(root.current?.querySelectorAll<HTMLElement>("[role=radio]") ?? [])];
  const close = () => {
    props.onClose();
    root.current?.closest("section")?.querySelector<HTMLElement>('[aria-haspopup="menu"]')?.focus();
  };

  useEffect(() => {
    if (props.inline) return;
    const frame = requestAnimationFrame(() => radios()[selected]?.focus());
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <div
      ref={root}
      class={props.inline ? `${styles.palette} ${styles.paletteInline}` : styles.palette}
      role="radiogroup"
      aria-label={format(names[locale.value === "es" ? "es" : "en"].label, { name: props.name })}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !props.inline) {
          event.preventDefault();
          close();
          return;
        }
        const items = radios();
        const next = nextColorIndex(
          event.key,
          items.indexOf(document.activeElement as HTMLElement),
          items.length,
        );
        if (next < 0) return;
        event.preventDefault();
        items[next]?.focus();
      }}
    >
      {options.map(({ id, name, checked, tabIndex }) => (
        <button
          key={id ?? "none"}
          type="button"
          role="radio"
          class={styles.swatch}
          data-color={id}
          aria-checked={checked}
          aria-label={name}
          title={name}
          tabIndex={tabIndex}
          onClick={() => {
            props.onPick(id ?? null);
            close();
          }}
        >
          {checked ? "✓" : ""}
        </button>
      ))}
    </div>
  );
}
