/** Runtime i18n: flat dictionaries, a locale signal and `t()` (no library, spec §10.9). */
import { signal } from "@preact/signals";
import { readPref, writePref } from "../store/storage.ts";
import { en, type MessageKey } from "./en.ts";
import { format } from "./format.ts";

export type Locale = "en" | "es";
export const LOCALES: Locale[] = ["en", "es"];
/**
 * English is the fallback and ships in the initial bundle; the other dictionary is its own chunk,
 * loaded when that language is chosen (the initial bundle has a size budget). Until a dictionary
 * has loaded, `t()` answers in English.
 */
const DICTIONARIES: Partial<Record<Locale, Record<MessageKey, string>>> = { en };
const LOADERS: Record<Locale, () => Promise<Record<MessageKey, string>>> = {
  en: () => Promise.resolve(en),
  es: () => import("./es.ts").then((m) => m.es),
};

/** Loads the dictionary of `next` (a no-op when it is already there). */
export async function loadLocale(next: Locale): Promise<void> {
  if (DICTIONARIES[next]) return;
  DICTIONARIES[next] = await LOADERS[next]();
}

const detect = (): Locale => {
  const stored = readPref("alisio.locale");
  if (stored === "en" || stored === "es") return stored;
  const nav = typeof navigator !== "undefined" ? navigator.language : "en";
  return nav.toLowerCase().startsWith("es") ? "es" : "en";
};

export const locale = signal<Locale>(detect());

/** Switches the language; a dictionary that is not loaded yet is fetched first. */
export function setLocale(next: Locale): Promise<void> | void {
  const apply = () => {
    locale.value = next;
    writePref("alisio.locale", next);
    document.documentElement.lang = next;
  };
  if (DICTIONARIES[next]) return apply();
  return loadLocale(next).then(apply, () => {});
}

/** Translates `key` in the current locale (reading the signal subscribes the component). */
export const t = (key: MessageKey, params?: Record<string, string | number>): string =>
  format(DICTIONARIES[locale.value]?.[key] ?? en[key] ?? key, params);

export type { MessageKey };
