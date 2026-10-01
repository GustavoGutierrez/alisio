/**
 * The single right slot shared by the Dock and the artifact panel (ADR-07, spec §15.3): which one
 * is open, its width (persisted per viewer, tolerant of broken storage), the expanded artifact
 * panel and the narrow-screen mode. The pure rules live in `util/panel.ts`.
 */
import { computed, effect, signal } from "@preact/signals";
import {
  EXPANDED_PREF,
  nextRightPanel,
  type PanelBounds,
  panelBounds,
  storedPanelWidth,
  WIDTH_PREF,
} from "../util/panel.ts";
import { artifactPanel } from "./artifacts.ts";
import { dockOpen } from "./dock.ts";
import { readPref, writePref } from "./storage.ts";

/** Which panel occupies the right slot. */
export const rightPanel = computed<"dock" | "artifact" | null>(() =>
  artifactPanel.value ? "artifact" : dockOpen.value ? "dock" : null,
);

/** Stored width (px); undefined = the default `clamp(360px, 42vw, 880px)`. */
export const panelWidth = signal<number | undefined>(storedPanelWidth());

/** Viewport width, updated on resize (drives the bounds and the narrow mode). */
export const viewport = signal(typeof window === "undefined" ? 1280 : window.innerWidth);

/** The artifact panel takes the whole chat column (the sidebar stays). */
export const panelExpanded = signal(readPref(EXPANDED_PREF) === "1");

const narrowQuery =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(max-width: 900px)")
    : undefined;
/** Below 900 px (same breakpoint as the sidebar and the Dock). */
export const narrowScreen = signal(!!narrowQuery?.matches);

if (typeof window !== "undefined") {
  window.addEventListener("resize", () => {
    viewport.value = window.innerWidth;
  });
  narrowQuery?.addEventListener?.("change", (event) => {
    narrowScreen.value = event.matches;
  });
}

/** Width of the sidebar next to the chat (the chat column's left edge). */
export function sidebarWidth(): number {
  if (typeof document === "undefined") return 0;
  return document.querySelector("main")?.getBoundingClientRect().left ?? 0;
}

export const currentBounds = (): PanelBounds => panelBounds(viewport.value, sidebarWidth());

/** Sets the width; `commit` persists it (on release, not on every pointer move). */
export function setPanelWidth(width: number | undefined, commit: boolean): void {
  panelWidth.value = width;
  if (commit) writePref(WIDTH_PREF, width === undefined ? undefined : String(Math.round(width)));
}

export function setPanelExpanded(expanded: boolean): void {
  panelExpanded.value = expanded;
  writePref(EXPANDED_PREF, expanded ? "1" : undefined);
}

// Exclusivity: whichever side opens last wins (opening the artifact panel closes the Dock in
// `openArtifact`; opening the Dock from anywhere closes the artifact panel here).
let wasDock = dockOpen.value;
effect(() => {
  const dock = dockOpen.value;
  if (dock && !wasDock && artifactPanel.peek()) {
    const next = nextRightPanel(
      { dock: false, artifact: artifactPanel.peek()?.id },
      { dock: true },
    );
    if (!next.artifact) artifactPanel.value = null;
  }
  wasDock = dock;
});
