import { changelogNews, loadChangelog, selectEntries } from "@alisio/core";
import type { ChangelogView } from "@alisio/sdk";
import { HttpError } from "../http/errors.ts";
import type { Router } from "../http/router.ts";

const MAX_QUERY = 100;

/**
 * `GET /api/changelog?version=&lastSeen=`: the shipped `CHANGELOG.md` entries (offline, parsed at
 * build time), the newest five or the one `version` names, plus `news` when `lastSeen` is older
 * than the running version. Same auth, Host and Origin rules as every other `/api` route.
 */
export function registerChangelogRoutes(router: Router, options: { version: string }): void {
  router.get("/api/changelog", ({ url }) => {
    const text = (name: string): string | undefined => {
      const value = url.searchParams.get(name)?.trim();
      if (value && value.length > MAX_QUERY)
        throw new HttpError("validation_failed", "Invalid query parameter", { fields: [name] });
      return value || undefined;
    };
    const version = text("version");
    const lastSeen = text("lastSeen");
    const entries = loadChangelog();
    const selected = selectEntries(entries, { ...(version ? { version } : {}), limit: 5 });
    const news = changelogNews({ entries, current: options.version, lastSeen });
    const body: ChangelogView = {
      current: options.version,
      entries: selected.entries,
      found: selected.found,
      ...(news.show && news.latest
        ? { news: { latest: news.latest, versions: news.versions } }
        : {}),
    };
    return { body };
  });
}
