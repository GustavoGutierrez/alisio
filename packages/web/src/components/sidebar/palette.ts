/** Palette ids, names and keyboard math of the project color picker (lazy with `ColorPalette`).
 * `PALETTE_IDS` mirrors the SDK's `WORKSPACE_COLOR_IDS`, which the server validates against. */
import { locale } from "../../i18n/index.ts";

export const names = {
  en: {
    label: "Color of {name}",
    none: "Default",
    red: "Red",
    orange: "Orange",
    amber: "Amber",
    green: "Green",
    teal: "Teal",
    blue: "Blue",
    indigo: "Indigo",
    purple: "Purple",
    pink: "Pink",
    gray: "Gray",
  },
  es: {
    label: "Color de {name}",
    none: "Predeterminado",
    red: "Rojo",
    orange: "Naranja",
    amber: "Ámbar",
    green: "Verde",
    teal: "Verde azulado",
    blue: "Azul",
    indigo: "Índigo",
    purple: "Morado",
    pink: "Rosa",
    gray: "Gris",
  },
} as const;

export const PALETTE_IDS = [
  "red",
  "orange",
  "amber",
  "green",
  "teal",
  "blue",
  "indigo",
  "purple",
  "pink",
  "gray",
] as const;

/** Accessible name of a palette option (`undefined` is the default, no color). */
export function colorName(id: string | undefined, lang: "en" | "es" = locale.value): string {
  const table = names[lang === "es" ? "es" : "en"];
  return id ? ((table as Record<string, string>)[id] ?? id) : table.none;
}

/** Index the arrow keys move to inside the radio group (wrapping), or -1 for other keys. */
export function nextColorIndex(key: string, index: number, count: number): number {
  if (key === "ArrowRight" || key === "ArrowDown") return (index + 1) % count;
  if (key === "ArrowLeft" || key === "ArrowUp") return (index - 1 + count) % count;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  return -1;
}

/** The radios in order: Default first, then the palette; exactly one is checked and tabbable. */
export function paletteOptions(current: string | undefined, lang: "en" | "es" = locale.value) {
  const ids: Array<string | undefined> = [undefined, ...PALETTE_IDS];
  const selected = Math.max(0, ids.indexOf(current));
  return ids.map((id, index) => ({
    id,
    name: colorName(id, lang),
    checked: index === selected,
    tabIndex: index === selected ? 0 : -1,
  }));
}
