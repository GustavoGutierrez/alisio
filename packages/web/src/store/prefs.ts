/** UI preferences (spec §10.3 `ui.ts`): theme, density and the collapsed sidebar. */
import { signal } from "@preact/signals";
import { readPref, writePref } from "./storage.ts";

export type ThemePref = "dark" | "light" | "system";
export type Density = "compact" | "detailed";

const storedTheme = readPref("alisio.theme");
export const theme = signal<ThemePref>(
  storedTheme === "light" || storedTheme === "system" ? storedTheme : "dark",
);
export const density = signal<Density>(
  readPref("alisio.density") === "detailed" ? "detailed" : "compact",
);
/** The theme actually shown (`system` resolved); heavy renderers such as Mermaid follow it. */
export const resolvedTheme = signal<"dark" | "light">("dark");
export const sidebarCollapsed = signal(readPref("alisio.sidebar") === "collapsed");

const media = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: light)") : undefined;

/** Resolves `system` and sets `data-theme` (the inline bootstrap did this before first paint). */
export function applyTheme(pref: ThemePref = theme.value): void {
  const resolved =
    pref === "system" ? (media()?.matches ? "light" : "dark") : pref === "light" ? "light" : "dark";
  document.documentElement.setAttribute("data-theme", resolved);
  resolvedTheme.value = resolved;
}

export function setTheme(pref: ThemePref): void {
  theme.value = pref;
  writePref("alisio.theme", pref);
  applyTheme(pref);
}

export function watchSystemTheme(): void {
  media()?.addEventListener("change", () => {
    if (theme.value === "system") applyTheme("system");
  });
}

export function setDensity(value: Density): void {
  density.value = value;
  writePref("alisio.density", value);
}

export function setSidebarCollapsed(value: boolean): void {
  sidebarCollapsed.value = value;
  writePref("alisio.sidebar", value ? "collapsed" : undefined);
}
