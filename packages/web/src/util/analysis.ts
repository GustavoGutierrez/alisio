/**
 * Pure helpers of Settings → Data analysis: the five editable keys, number parsing with the same
 * bounds the configuration schema enforces (the server validates again), and the seconds shown
 * for `analysis.limits.timeoutMs`. The page itself is `components/settings/AnalysisPage.tsx`.
 */
import type { SettingInfo } from "@alisio/sdk";

export const ANALYSIS_KEYS = [
  "analysis.enabled",
  "analysis.smartDashboard",
  "analysis.limits.timeoutMs",
  "analysis.retention.jobsDays",
  "analysis.retention.intermediateDays",
  "analysis.retention.artifactsDays",
] as const;
export type AnalysisKey = (typeof ANALYSIS_KEYS)[number];

/** Keys of the data-analysis page: the General page leaves them out. */
export const isAnalysisKey = (key: string): boolean => key.startsWith("analysis.");

export const TIMEOUT_SECONDS = { min: 1, max: 900 } as const;
export const RETENTION_DAYS = { min: 0, max: 3650 } as const;

/** A whole number inside `[min, max]`, or undefined (empty, fractional, out of range). */
export function parseWhole(text: string, min: number, max: number): number | undefined {
  const trimmed = text.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  return value >= min && value <= max ? value : undefined;
}

/** Seconds typed in the timeout field → the milliseconds the config stores. */
export function secondsToMs(text: string): number | undefined {
  const seconds = parseWhole(text, TIMEOUT_SECONDS.min, TIMEOUT_SECONDS.max);
  return seconds === undefined ? undefined : seconds * 1000;
}

export const msToSeconds = (ms: number): number => Math.round(ms / 1000);

/** The value of one analysis key in `GET /api/settings`. */
export function analysisSetting(
  settings: SettingInfo[],
  key: AnalysisKey,
): string | number | boolean | undefined {
  return settings.find((setting) => setting.key === key)?.value;
}

/** `Python 3.12.1 · /usr/bin/python3` is detected; the install hint shows otherwise. */
export function extrasLabel(extras: string[]): string {
  return extras.join(", ");
}
