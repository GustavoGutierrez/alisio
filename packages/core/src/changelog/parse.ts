/**
 * Pure parser and version helpers of `CHANGELOG.md` (Keep a Changelog, reduced). No I/O and no
 * runtime imports, so the build script can load it with `node --experimental-strip-types`.
 *
 * Format: `## [Unreleased]` or `## [<version>] - <date>`, then `### Added|Changed|Fixed`
 * sections of `- ` bullets (a continuation line indented under a bullet extends it). Anything
 * outside an entry (the title, the introduction) is ignored; entries keep the file order.
 */
import type { ChangelogEntry, ChangelogSection } from "@alisio/sdk";

const ENTRY_HEADING = /^##\s+\[?([^\]\s]+)\]?(?:\s*[-–—·]\s*(\d{4}-\d{2}-\d{2}))?\s*$/;
const SECTION_HEADING = /^###\s+(.+?)\s*$/;
const BULLET = /^\s{0,3}[-*]\s+(.*\S)\s*$/;
const DEFAULT_SECTION = "Changes";
export const UNRELEASED = "Unreleased";

export function parseChangelog(markdown: string): ChangelogEntry[] {
  const entries: ChangelogEntry[] = [];
  let entry: ChangelogEntry | undefined;
  let section: ChangelogSection | undefined;
  let item = -1;
  const openSection = (title: string) => {
    section = { title, items: [] };
    entry?.sections.push(section);
    item = -1;
  };
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = ENTRY_HEADING.exec(raw);
    if (heading?.[1]) {
      const version = heading[1].replace(/^v(?=\d)/, "");
      const unreleased = version.toLowerCase() === UNRELEASED.toLowerCase();
      entry = {
        version: unreleased ? UNRELEASED : version,
        ...(heading[2] ? { date: heading[2] } : {}),
        ...(unreleased ? { unreleased: true } : {}),
        sections: [],
      };
      entries.push(entry);
      section = undefined;
      item = -1;
      continue;
    }
    if (!entry) continue;
    const sectionHeading = SECTION_HEADING.exec(raw);
    if (sectionHeading?.[1]) {
      openSection(sectionHeading[1]);
      continue;
    }
    const bullet = BULLET.exec(raw);
    if (bullet?.[1]) {
      if (!section) openSection(DEFAULT_SECTION);
      section?.items.push(bullet[1]);
      item = (section?.items.length ?? 0) - 1;
      continue;
    }
    // A non-blank, indented continuation extends the previous bullet.
    if (section && item >= 0 && /^\s{2,}\S/.test(raw))
      section.items[item] = `${section.items[item]} ${raw.trim()}`;
  }
  return entries.map((e) => ({ ...e, sections: e.sections.filter((s) => s.items.length) }));
}

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(text: string): ParsedVersion | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

/** Whether `text` is a semantic version (`1.2.3-alpha.4`, with an optional leading `v`). */
export const isVersion = (text: string): boolean => parseVersion(text) !== undefined;

/**
 * Semver order with numeric prerelease identifiers (`alpha.9` < `alpha.10`; a release is above its
 * prereleases). `Unreleased` is above every version; an unparseable text sorts below all of them.
 */
export function compareVersions(a: string, b: string): number {
  const unreleasedA = a === UNRELEASED,
    unreleasedB = b === UNRELEASED;
  if (unreleasedA || unreleasedB) return Number(unreleasedA) - Number(unreleasedB);
  const left = parseVersion(a),
    right = parseVersion(b);
  if (!left || !right) return Math.sign(Number(!!left) - Number(!!right));
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] ?? 0) - (right.core[i] ?? 0);
    if (diff) return Math.sign(diff);
  }
  if (!left.pre.length || !right.pre.length) return Math.sign(right.pre.length - left.pre.length);
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i],
      y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const numeric = /^\d+$/.test(x) && /^\d+$/.test(y);
    if (numeric) {
      const diff = Number(x) - Number(y);
      if (diff) return Math.sign(diff);
    } else if (/^\d+$/.test(x) !== /^\d+$/.test(y)) return /^\d+$/.test(x) ? -1 : 1;
    else if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

export interface SelectedEntries {
  entries: ChangelogEntry[];
  /** `false` when a version was asked for and no entry has it. */
  found: boolean;
}

/**
 * The entries to show: the `limit` newest (default 5), or the one named by `version` (`alpha.4`,
 * `1.2.3-alpha.4` and `v1.2.3-alpha.4` all match). Entries come back newest first.
 */
export function selectEntries(
  entries: ChangelogEntry[],
  options: { version?: string; limit?: number } = {},
): SelectedEntries {
  const sorted = [...entries].sort((a, b) => compareVersions(b.version, a.version));
  const asked = options.version?.trim();
  if (!asked) return { entries: sorted.slice(0, Math.max(1, options.limit ?? 5)), found: true };
  const wanted = asked.replace(/^v(?=\d)/, "").toLowerCase();
  const hit = sorted.find(
    (entry) =>
      entry.version.toLowerCase() === wanted ||
      entry.version.toLowerCase().endsWith(`-${wanted}`) ||
      entry.version.toLowerCase().endsWith(`.${wanted}`),
  );
  return hit ? { entries: [hit], found: true } : { entries: [], found: false };
}

export interface NewsDecision {
  /** Show the one-line "updated" notice. */
  show: boolean;
  /** Versions newer than `lastSeen` up to `current`, newest first. */
  versions: string[];
  latest?: string;
  /** The viewer should now store `current` as its last seen version. */
  record: boolean;
}

/**
 * Decides the discreet "Alisio updated" line. A first run (no `lastSeen`) stays silent and records;
 * the same version does nothing; a downgrade or an upgrade without entries records silently;
 * an upgrade with entries in `(lastSeen, current]` shows. `Unreleased` never counts as news and an
 * unparseable `current` (a development build) does nothing.
 */
export function changelogNews(input: {
  entries: ChangelogEntry[];
  current: string;
  lastSeen?: string | undefined;
}): NewsDecision {
  const { entries, current, lastSeen } = input;
  const none: NewsDecision = { show: false, versions: [], record: false };
  if (!isVersion(current)) return none;
  if (!lastSeen || !isVersion(lastSeen)) return { ...none, record: true };
  const order = compareVersions(current, lastSeen);
  if (order === 0) return none;
  if (order < 0) return { ...none, record: true };
  const versions = entries
    .filter(
      (entry) =>
        !entry.unreleased &&
        compareVersions(entry.version, lastSeen) > 0 &&
        compareVersions(entry.version, current) <= 0,
    )
    .map((entry) => entry.version)
    .sort((a, b) => compareVersions(b, a));
  return versions.length
    ? { show: true, versions, latest: versions[0] as string, record: true }
    : { ...none, record: true };
}

/** Markdown for the entries (one `##` heading per version, bold section titles, bullets). */
export function formatChangelogMarkdown(entries: ChangelogEntry[]): string {
  if (!entries.length) return "No changelog entries.";
  return entries
    .map((entry) =>
      [
        `## ${entry.version}${entry.date ? ` · ${entry.date}` : ""}${entry.unreleased ? " (not released yet)" : ""}`,
        ...entry.sections.flatMap((section) => [
          "",
          `**${section.title}**`,
          "",
          ...section.items.map((item) => `- ${item}`),
        ]),
      ].join("\n"),
    )
    .join("\n\n");
}
