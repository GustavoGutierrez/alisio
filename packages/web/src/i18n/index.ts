/** Runtime i18n: flat dictionaries, a locale signal and `t()` (no library, spec §10.9). */
import { signal } from "@preact/signals";
import { readPref, writePref } from "../store/storage.ts";
import { en, type MessageKey } from "./en.ts";
import { es } from "./es.ts";
import { format } from "./format.ts";

export type Locale = "en" | "es";
export const LOCALES: Locale[] = ["en", "es"];
const DICTIONARIES: Record<Locale, Record<MessageKey, string>> = { en, es };

const detect = (): Locale => {
  const stored = readPref("alisio.locale");
  if (stored === "en" || stored === "es") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
};

export const locale = signal<Locale>(detect());

export function setLocale(next: Locale): void {
  locale.value = next;
  writePref("alisio.locale", next);
  document.documentElement.lang = next;
}

/** Translates `key` in the current locale (reading the signal subscribes the component). */
export const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  format(DICTIONARIES[locale.value][key] ?? en[key] ?? key, params);

export type { MessageKey };
