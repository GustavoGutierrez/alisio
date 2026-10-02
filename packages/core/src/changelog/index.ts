/** The shipped changelog: parsed from `CHANGELOG.md` at build time, available offline. */
import type { ChangelogEntry } from "@alisio/sdk";
import { CHANGELOG_DATA } from "./data.ts";

export {
  changelogNews,
  compareVersions,
  formatChangelogMarkdown,
  isVersion,
  type NewsDecision,
  parseChangelog,
  type SelectedEntries,
  selectEntries,
  UNRELEASED,
} from "./parse.ts";

/** Every entry of the shipped changelog, newest first as written in the file. */
export function loadChangelog(): ChangelogEntry[] {
  const data = CHANGELOG_DATA as { schema?: number; entries?: unknown };
  return data.schema === 1 && Array.isArray(data.entries) ? (data.entries as ChangelogEntry[]) : [];
}
