import { OverlayScrollbars } from "overlayscrollbars";
import "overlayscrollbars/overlayscrollbars.css";

/**
 * The lazy half of `scrollbars.ts`: OverlayScrollbars initialized with the element as its own
 * viewport (`elements.viewport`), so no wrapper is inserted and the element that scrolls is the
 * same one the component holds. The theme (`os-theme-alisio`) lives in `styles/scrollbars.css`.
 * Its observers keep the scrollbars in sync with content and size changes.
 */
export function attachScrollbars(el: HTMLElement): () => void {
  // Never initialize twice: an element that already has an instance keeps it.
  if (OverlayScrollbars(el)) return () => {};
  const instance = OverlayScrollbars(
    { target: el, elements: { viewport: el }, cancel: { nativeScrollbarsOverlaid: true } },
    {
      scrollbars: {
        theme: "os-theme-alisio",
        autoHide: "move",
        autoHideDelay: 900,
        clickScroll: true,
      },
    },
  );
  return () => instance.destroy();
}
