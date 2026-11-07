import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertSelfContainedRuntime,
  findRuntimeViolations,
  removeBinDirectories,
} from "../apps/desktop/scripts/runtime-tree.ts";

const roots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "alisio-runtime-tree-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("desktop runtime tree checks", () => {
  it("accepts a tree of plain files and directories", () => {
    const root = makeRoot();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "export {};\n");
    expect(findRuntimeViolations(root)).toEqual([]);
    expect(() => assertSelfContainedRuntime(root)).not.toThrow();
  });

  it("reports a symlink that stays inside the tree", () => {
    const root = makeRoot();
    mkdirSync(join(root, "a"));
    writeFileSync(join(root, "a", "file.js"), "");
    symlinkSync(join(root, "a"), join(root, "link"), "dir");
    const violations = findRuntimeViolations(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe("link");
    expect(violations[0]?.escapes).toBe(false);
  });

  it("reports a symlink that points outside the tree, like the pnpm deploy self-link", () => {
    const root = makeRoot();
    const outside = makeRoot();
    mkdirSync(join(root, "node_modules", "@alisio"), { recursive: true });
    symlinkSync(outside, join(root, "node_modules", "@alisio", "desktop"), "dir");
    const violations = findRuntimeViolations(root);
    expect(violations.map((v) => [v.path, v.escapes])).toEqual([
      [join("node_modules", "@alisio", "desktop"), true],
    ]);
    expect(() => assertSelfContainedRuntime(root)).toThrow(/node_modules.*desktop/);
  });

  it("reports a dangling symlink without following it", () => {
    const root = makeRoot();
    symlinkSync(join(root, "missing"), join(root, "dangling"));
    expect(findRuntimeViolations(root).map((v) => v.path)).toEqual(["dangling"]);
  });

  it("removes every node_modules/.bin directory, which only holds symlink shims", () => {
    const root = makeRoot();
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "node_modules", "pkg", "cli.js"), "");
    mkdirSync(join(root, "node_modules", ".bin"));
    symlinkSync(
      join(root, "node_modules", "pkg", "cli.js"),
      join(root, "node_modules", ".bin", "cli"),
    );
    mkdirSync(join(root, "node_modules", "pkg", "node_modules", ".bin"), { recursive: true });
    symlinkSync("../../cli.js", join(root, "node_modules", "pkg", "node_modules", ".bin", "x"));
    removeBinDirectories(root);
    expect(findRuntimeViolations(root)).toEqual([]);
  });
});
