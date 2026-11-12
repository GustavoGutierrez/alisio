import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";

/**
 * Minimal overlay scrollbars (OverlayScrollbars) as progressive enhancement. This module stays in
 * the initial bundle and is tiny: the library and its CSS are a lazy chunk loaded after the first
 * paint (effects run after paint). Until it loads, or if it fails, the CSS-only thin scrollbars
 * in `styles/scrollbars.css` apply. The element itself stays the scrolling viewport, so refs,
 * `scrollTop` math and scroll listeners (chat autoscroll) keep working unchanged.
 */
let lib: Promise<typeof import("./scrollbars-lazy.ts")> | undefined;
const load = () => (lib ??= import("./scrollbars-lazy.ts"));

/**
 * Attach overlay scrollbars to the element behind `ref`. Follows the element when it is
 * conditionally rendered (re-attaches to a new node), never initializes twice and destroys the
 * instance on unmount.
 */
export function useOverlayScrollbars(ref: RefObject<HTMLElement | null>): void {
  const state = useRef<{ el?: HTMLElement | null; off?: () => void }>({});
  useEffect(() => {
    const s = state.current;
    const el = ref.current;
    if (el === s.el) return;
    s.off?.();
    s.off = undefined;
    s.el = el;
    if (el)
      load().then(
        (m) => {
          if (s.el === el) s.off = m.attachScrollbars(el);
        },
        () => {}, // stay on the CSS fallback
      );
  });
  useEffect(
    () => () => {
      state.current.off?.();
      state.current.el = null;
    },
    [],
  );
}
