/** Compact relative time for sidebar rows ("4 min", "3 h"); "—" when unknown (legacy rows). */
export function relativeTime(at: number | undefined, now: number, locale: "en" | "es"): string {
  if (at === undefined || !Number.isFinite(at)) return "—";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return locale === "es" ? "ahora" : "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d`;
  const weeks = Math.floor(days / 7);
  if (weeks < 9) return `${weeks} ${locale === "es" ? "sem" : "wk"}`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} ${locale === "es" ? "mes" : "mo"}`;
  return `${Math.floor(days / 365)} ${locale === "es" ? "a" : "y"}`;
}
