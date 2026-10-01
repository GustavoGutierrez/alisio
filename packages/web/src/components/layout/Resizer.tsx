import { useRef } from "preact/hooks";
import { t } from "../../i18n/index.ts";
import { clampPanelWidth, type PanelBounds, resizeStep } from "../../util/panel.ts";
import styles from "./resizer.module.css";

/**
 * The vertical handle between the chat and the right slot (Dock or artifact panel), spec §15.3:
 * pointer drag (captured; iframes ignore the pointer meanwhile), double click to reset, and a
 * keyboard separator (←/→ ±16 px, Shift ±64 px, Home/End, Enter resets). `onChange` receives
 * `commit = true` when the width should be persisted (release, key, reset).
 */
export function Resizer(props: {
  width: number;
  bounds: PanelBounds;
  reset: number;
  controls?: string;
  onChange: (width: number | undefined, commit: boolean) => void;
}) {
  const drag = useRef<{ x: number; width: number; last: number } | undefined>(undefined);
  const end = (event: PointerEvent) => {
    const state = drag.current;
    if (!state) return;
    drag.current = undefined;
    document.documentElement.removeAttribute("data-resizing");
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
    props.onChange(state.last, true);
  };
  return (
    <div
      class={styles.handle}
      role="separator"
      aria-orientation="vertical"
      aria-label={t("artifactPanel.resize")}
      aria-valuenow={Math.round(props.width)}
      aria-valuemin={props.bounds.min}
      aria-valuemax={props.bounds.max}
      aria-controls={props.controls}
      tabIndex={0}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
        drag.current = { x: event.clientX, width: props.width, last: props.width };
        // Iframes would swallow the pointer while it crosses them.
        document.documentElement.setAttribute("data-resizing", "true");
      }}
      onPointerMove={(event) => {
        const state = drag.current;
        if (!state) return;
        // The handle is on the panel's left edge: moving left widens the panel.
        state.last = clampPanelWidth(state.width + (state.x - event.clientX), props.bounds);
        props.onChange(state.last, false);
      }}
      onPointerUp={end}
      onPointerCancel={end}
      onDblClick={() => props.onChange(undefined, true)}
      onKeyDown={(event) => {
        const next = resizeStep({
          key: event.key,
          shift: event.shiftKey,
          width: props.width,
          bounds: props.bounds,
          reset: props.reset,
        });
        if (next === undefined) return;
        event.preventDefault();
        props.onChange(event.key === "Enter" ? undefined : next, true);
      }}
    />
  );
}
