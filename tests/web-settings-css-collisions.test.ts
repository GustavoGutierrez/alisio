/**
 * settings.module.css is shared by every Settings page, and CSS modules give one hashed name per
 * class per file. A later section that redefines a generic class (`.row`, `.rowMain`, ...) silently
 * restyles every other page that uses it (the 0.11.2 catalog broke the Models page this way).
 * The web tests have no DOM, so this checks the CSS source: a plain class selector must not set a
 * different base `display` in two separate commented sections.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("packages/web/src/components/settings/settings.module.css", "utf8");

interface Section {
  title: string;
  body: string;
}

const sections = (): Section[] => {
  const parts = source.split(/^\/\* ---- (.*?) ---- \*\/$/m);
  const result: Section[] = [{ title: "(top)", body: parts[0] ?? "" }];
  for (let i = 1; i < parts.length; i += 2) {
    result.push({ title: parts[i] ?? "", body: parts[i + 1] ?? "" });
  }
  return result;
};

/** Base `display` per plain top-level class (no pseudo, attribute or descendant parts). */
const displays = (body: string) => {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/^((?:\.[A-Za-z0-9_]+,?\s*)+)\{([^}]*)\}/gm)) {
    const display = /(?:^|[\s;])display:\s*([^;]+);/.exec(match[2] ?? "")?.[1]?.trim();
    if (!display) continue;
    for (const name of (match[1] ?? "").match(/\.[A-Za-z0-9_]+/g) ?? []) found.set(name, display);
  }
  return found;
};

describe("settings.module.css class collisions", () => {
  it("does not redefine a class's base display in another section", () => {
    const seen = new Map<string, { section: string; display: string }>();
    const clashes: string[] = [];
    for (const section of sections()) {
      for (const [name, display] of displays(section.body)) {
        const before = seen.get(name);
        if (before && before.display !== display) {
          clashes.push(
            `${name}: "${before.display}" in "${before.section}" vs "${display}" in "${section.title}"`,
          );
        }
        seen.set(name, { section: section.title, display });
      }
    }
    expect(clashes).toEqual([]);
  });

  it("keeps the plugin catalog on its own class names", () => {
    const catalog = sections().find((section) => section.title === "Compact catalog rows");
    expect(catalog, "catalog section").toBeDefined();
    const defined = (catalog?.body.match(/^\.[A-Za-z0-9_]+/gm) ?? []).map((x) => x.slice(1));
    const generic = ["row", "rowMain", "rowActions", "rowTitle"];
    expect(defined.filter((name) => generic.includes(name))).toEqual([]);
  });
});
