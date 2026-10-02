/**
 * The Alisio version shown in the UI. It is the SERVER's (the CLI's) version from `/api/health`,
 * never the web package's own number; a missing, empty or non-string field means "unknown".
 */
export function normalizeVersion(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const version = raw.trim();
  return version || undefined;
}
