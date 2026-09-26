import { readdir, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const packagesRoot = new URL("../packages/", import.meta.url);

describe("plugin package boundaries", () => {
  it("prevents dependencies on core or another Alisio plugin", async () => {
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    for (const entry of entries.filter(
      (value) => value.isDirectory() && value.name.startsWith("plugin-"),
    )) {
      const manifest = JSON.parse(
        await readFile(new URL(`${entry.name}/package.json`, packagesRoot), "utf8"),
      ) as Record<string, Record<string, string> | undefined>;
      for (const section of [
        "dependencies",
        "devDependencies",
        "peerDependencies",
        "optionalDependencies",
      ]) {
        const names = Object.keys(manifest[section] ?? {});
        expect(
          names.filter((name) => name === "@alisio/core" || name.startsWith("@alisio/plugin-")),
        ).toEqual([]);
      }
    }
  });

  it("prevents source imports from core or another Alisio plugin", async () => {
    const entries = await readdir(packagesRoot, { withFileTypes: true });
    const violations: string[] = [];
    for (const entry of entries.filter(
      (value) => value.isDirectory() && value.name.startsWith("plugin-"),
    )) {
      const sourceRoot = new URL(`${entry.name}/src/`, packagesRoot);
      for (const file of await readdir(sourceRoot, { recursive: true })) {
        if (!/\.(?:[cm]?[jt]s|tsx)$/.test(file)) continue;
        const source = await readFile(new URL(file, sourceRoot), "utf8");
        if (/(?:from\s+|import\s*(?:\(\s*)?)["']@alisio\/(?:core|plugin-)/.test(source))
          violations.push(join(entry.name, "src", file));
        const packageRoot = resolve(new URL(`${entry.name}/`, packagesRoot).pathname);
        const sourcePath = resolve(new URL(file, sourceRoot).pathname);
        for (const match of source.matchAll(
          /(?:from\s+|import\s*(?:\(\s*)?)["'](\.\.?\/[^"']+)/g,
        )) {
          const specifier = match[1];
          if (!specifier) continue;
          const target = resolve(dirname(sourcePath), specifier);
          const escaped = relative(packageRoot, target);
          if (
            escaped === ".." ||
            escaped.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)
          )
            violations.push(`${join(entry.name, "src", file)} -> ${specifier}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
