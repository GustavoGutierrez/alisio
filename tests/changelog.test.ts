import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  changelogNews,
  compareVersions,
  formatChangelogMarkdown,
  isVersion,
  loadChangelog,
  parseChangelog,
  selectEntries,
} from "../packages/core/src/changelog/index.ts";

const SAMPLE = `# Changelog

Intro text that belongs to no entry.

## [Unreleased]

### Added

- Next thing.

## [0.1.0-alpha.10] - 2026-09-26

### Fixed

- Fixed a crash that happened when the model
  answered with an empty message.

### Changed
- Tweaked a default.

## [0.1.0-alpha.9] - 2026-09-26

- A bullet without a section.

## 0.1.0-alpha.2 - 2026-09-25

### Added

* Star bullets work too.
`;

describe("parseChangelog", () => {
  const entries = parseChangelog(SAMPLE);

  it("reads versions, dates and the unreleased entry in file order", () => {
    expect(entries.map((e) => e.version)).toEqual([
      "Unreleased",
      "0.1.0-alpha.10",
      "0.1.0-alpha.9",
      "0.1.0-alpha.2",
    ]);
    expect(entries[0]).toMatchObject({ unreleased: true, sections: [{ title: "Added" }] });
    expect(entries[1]?.date).toBe("2026-09-26");
    expect(entries[3]?.date).toBe("2026-09-25");
  });

  it("joins continuation lines, accepts star bullets and sectionless bullets", () => {
    expect(entries[1]?.sections).toEqual([
      {
        title: "Fixed",
        items: ["Fixed a crash that happened when the model answered with an empty message."],
      },
      { title: "Changed", items: ["Tweaked a default."] },
    ]);
    expect(entries[2]?.sections).toEqual([
      { title: "Changes", items: ["A bullet without a section."] },
    ]);
    expect(entries[3]?.sections[0]?.items).toEqual(["Star bullets work too."]);
  });

  it("returns nothing for an empty or entry-less file", () => {
    expect(parseChangelog("")).toEqual([]);
    expect(parseChangelog("# Changelog\n\nJust prose.\n")).toEqual([]);
    expect(parseChangelog("## [1.0.0]\n\n### Added\n\n")).toEqual([
      { version: "1.0.0", sections: [] },
    ]);
  });

  it("handles Windows line endings", () => {
    expect(parseChangelog(SAMPLE.replace(/\n/g, "\r\n"))).toEqual(entries);
  });
});

describe("version order", () => {
  it("compares prerelease numbers numerically and Unreleased above everything", () => {
    expect(compareVersions("0.1.0-alpha.10", "0.1.0-alpha.9")).toBe(1);
    expect(compareVersions("0.1.0-alpha.2", "0.1.0-alpha.10")).toBe(-1);
    expect(compareVersions("0.1.0", "0.1.0-alpha.28")).toBe(1);
    expect(compareVersions("0.2.0-alpha.1", "0.1.9")).toBe(1);
    expect(compareVersions("v0.1.0-alpha.3", "0.1.0-alpha.3")).toBe(0);
    expect(compareVersions("Unreleased", "99.0.0")).toBe(1);
    expect(compareVersions("dev", "0.1.0")).toBe(-1);
    expect(isVersion("0.1.0-alpha.28")).toBe(true);
    expect(isVersion("dev")).toBe(false);
  });

  it("sorts a stable release above every one of its own prereleases", () => {
    for (const pre of ["0.1.0-alpha.1", "0.1.0-alpha.9", "0.1.0-alpha.28", "0.1.0-rc.1"]) {
      expect(compareVersions("0.1.0", pre), pre).toBe(1);
      expect(compareVersions(pre, "0.1.0"), pre).toBe(-1);
    }
    // ...but stays below the next prerelease line, and below Unreleased.
    expect(compareVersions("0.1.0", "0.2.0-alpha.1")).toBe(-1);
    expect(compareVersions("0.1.1", "0.1.0")).toBe(1);
    expect(compareVersions("0.1.0-rc.1", "0.1.0-alpha.28")).toBe(1);
  });
});

describe("stable release ordering and news", () => {
  const release = parseChangelog(`# Changelog

## [0.1.0] - 2026-10-02

### Added

- First stable release.

## [0.1.0-alpha.28] - 2026-10-01

### Added

- Last alpha.

## [0.1.0-alpha.9] - 2026-09-26

### Fixed

- An older alpha.
`);

  it("lists the stable release first in /changelog, even when it is written below its alphas", () => {
    expect(selectEntries(release).entries.map((e) => e.version)).toEqual([
      "0.1.0",
      "0.1.0-alpha.28",
      "0.1.0-alpha.9",
    ]);
    const shuffled = [...release].reverse();
    expect(selectEntries(shuffled, { limit: 1 }).entries[0]?.version).toBe("0.1.0");
    expect(selectEntries(shuffled, { version: "v0.1.0" }).entries[0]?.version).toBe("0.1.0");
  });

  it("shows the what's new note for 0.1.0 after any 0.1.0-alpha.N", () => {
    for (const lastSeen of ["0.1.0-alpha.9", "0.1.0-alpha.28"]) {
      const news = changelogNews({ entries: release, current: "0.1.0", lastSeen });
      expect(news.show, lastSeen).toBe(true);
      expect(news.latest, lastSeen).toBe("0.1.0");
      expect(news.versions[0], lastSeen).toBe("0.1.0");
    }
    expect(
      changelogNews({ entries: release, current: "0.1.0", lastSeen: "0.1.0-alpha.9" }).versions,
    ).toEqual(["0.1.0", "0.1.0-alpha.28"]);
  });

  it("does not repeat the note on 0.1.0 and treats going back to an alpha as a silent downgrade", () => {
    expect(changelogNews({ entries: release, current: "0.1.0", lastSeen: "0.1.0" }).show).toBe(
      false,
    );
    expect(
      changelogNews({ entries: release, current: "0.1.0-alpha.28", lastSeen: "0.1.0" }),
    ).toEqual({ show: false, versions: [], record: true });
  });
});

describe("selectEntries", () => {
  const entries = parseChangelog(SAMPLE);

  it("lists the newest entries first and honors the limit", () => {
    expect(selectEntries(entries).entries.map((e) => e.version)).toEqual([
      "Unreleased",
      "0.1.0-alpha.10",
      "0.1.0-alpha.9",
      "0.1.0-alpha.2",
    ]);
    expect(selectEntries(entries, { limit: 2 }).entries).toHaveLength(2);
  });

  it("finds a version by full name, short name or with a leading v", () => {
    for (const asked of ["0.1.0-alpha.9", "alpha.9", "v0.1.0-alpha.9"])
      expect(selectEntries(entries, { version: asked })).toMatchObject({
        found: true,
        entries: [{ version: "0.1.0-alpha.9" }],
      });
    // `alpha.1` must not match `alpha.10`.
    expect(selectEntries(entries, { version: "alpha.1" })).toEqual({ entries: [], found: false });
    expect(selectEntries(entries, { version: "9.9.9" })).toEqual({ entries: [], found: false });
  });

  it("formats Markdown with a heading per version", () => {
    const text = formatChangelogMarkdown(selectEntries(entries, { limit: 2 }).entries);
    expect(text).toContain("## Unreleased (not released yet)");
    expect(text).toContain("## 0.1.0-alpha.10 · 2026-09-26");
    expect(text).toContain("**Fixed**");
    expect(formatChangelogMarkdown([])).toBe("No changelog entries.");
  });
});

describe("changelogNews (lastSeenVersion)", () => {
  const entries = parseChangelog(SAMPLE);

  it("stays silent on a first run and records the version", () => {
    expect(changelogNews({ entries, current: "0.1.0-alpha.10" })).toEqual({
      show: false,
      versions: [],
      record: true,
    });
  });

  it("does nothing when the version is unchanged", () => {
    expect(
      changelogNews({ entries, current: "0.1.0-alpha.10", lastSeen: "0.1.0-alpha.10" }),
    ).toEqual({ show: false, versions: [], record: false });
  });

  it("shows one notice after an upgrade, listing the entries in between", () => {
    expect(
      changelogNews({ entries, current: "0.1.0-alpha.10", lastSeen: "0.1.0-alpha.2" }),
    ).toEqual({
      show: true,
      versions: ["0.1.0-alpha.10", "0.1.0-alpha.9"],
      latest: "0.1.0-alpha.10",
      record: true,
    });
  });

  it("records silently on a downgrade, an upgrade without entries or a development build", () => {
    expect(
      changelogNews({ entries, current: "0.1.0-alpha.2", lastSeen: "0.1.0-alpha.10" }),
    ).toEqual({ show: false, versions: [], record: true });
    expect(
      changelogNews({ entries, current: "0.1.0-alpha.11", lastSeen: "0.1.0-alpha.10" }),
    ).toEqual({ show: false, versions: [], record: true });
    expect(changelogNews({ entries, current: "dev", lastSeen: "0.1.0-alpha.2" })).toEqual({
      show: false,
      versions: [],
      record: false,
    });
  });

  it("never counts Unreleased as news and treats a corrupt lastSeen as a first run", () => {
    expect(
      changelogNews({ entries, current: "0.1.0-alpha.10", lastSeen: "0.1.0-alpha.9" }).versions,
    ).toEqual(["0.1.0-alpha.10"]);
    expect(changelogNews({ entries, current: "0.1.0-alpha.10", lastSeen: "garbage" })).toEqual({
      show: false,
      versions: [],
      record: true,
    });
  });
});

describe("shipped changelog", () => {
  it("embeds exactly what CHANGELOG.md says (regenerate with scripts/changelog-data.ts)", async () => {
    const source = await readFile(join(process.cwd(), "CHANGELOG.md"), "utf8");
    expect(loadChangelog()).toEqual(parseChangelog(source));
  });

  it("has curated entries for the published alphas and the stable releases on top", () => {
    const entries = loadChangelog();
    expect(entries.length).toBeGreaterThan(10);
    expect(entries.some((e) => e.version === "0.1.0-alpha.28")).toBe(true);
    expect(selectEntries(entries, { limit: 3 }).entries.map((e) => e.version)).toEqual([
      "0.4.0",
      "0.3.0",
      "0.2.1",
    ]);
    for (const entry of entries) {
      expect(entry.sections.length, entry.version).toBeGreaterThan(0);
      for (const section of entry.sections)
        for (const item of section.items) expect(item, entry.version).not.toMatch(/\/home\/|C:\\/);
    }
  });

  it("works from a missing file: the parser of nothing is empty", async () => {
    const dir = await mkdtemp(join(tmpdir(), "alisio-changelog-"));
    try {
      expect(
        parseChangelog(await readFile(join(dir, "CHANGELOG.md"), "utf8").catch(() => "")),
      ).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
