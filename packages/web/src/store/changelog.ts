/** Pure helpers of the web changelog: the discreet "updated" toast and `lastSeenVersion`. */
import type { ChangelogView } from "@alisio/sdk";

/** localStorage key of the last version whose changelog the viewer was told about. */
export const LAST_SEEN_KEY = "alisio.lastSeenVersion";

export interface NewsAction {
  /** Version to mention in the one discreet toast (undefined: say nothing). */
  toast?: string;
  /** Version to store as the new `lastSeenVersion` (undefined: keep what is stored). */
  record?: string;
}

/**
 * What to do with the answer of `GET /api/changelog?lastSeen=…`: the server reports `news` only for
 * a real upgrade with entries in between. A first visit stays silent and records; the same version
 * does nothing; a downgrade or an upgrade without entries records silently; a development build
 * (`dev`) never records, so the next real version is not mistaken for news.
 */
export function newsAction(lastSeen: string | undefined, view: ChangelogView): NewsAction {
  if (view.current === "dev" || view.current === lastSeen) return {};
  return {
    ...(view.news ? { toast: view.news.latest } : {}),
    record: view.current,
  };
}
