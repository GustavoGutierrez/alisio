/**
 * The pure path rules of the session directory (spec §9.4, D19): which temporary root wins, the
 * workspace slug, which ids are safe folder names, when an existing folder is private enough and
 * what a scratchpad-relative path may point at.
 */
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ForgeError } from "../packages/core/src/forge/errors.ts";
import {
  isSafeSegment,
  MAX_SLUG_CHARS,
  privateDirProblem,
  resolveWithin,
  scratchBaseName,
  tmpRootChoice,
  workspaceSlug,
} from "../packages/core/src/forge/session-path.ts";

function codeOf(action: () => unknown): string | undefined {
  try {
    action();
  } catch (error) {
    return (error as ForgeError).code;
  }
  return undefined;
}

describe("temporary root choice", () => {
  it("prefers ALISIO_TMPDIR, then forge.scratch.root, then the system temp", () => {
    expect(tmpRootChoice({ env: "/env", config: "/cfg", os: "/os" })).toBe("/env");
    expect(tmpRootChoice({ env: undefined, config: "/cfg", os: "/os" })).toBe("/cfg");
    expect(tmpRootChoice({ env: undefined, config: null, os: "/os" })).toBe("/os");
    // An empty value is not a choice.
    expect(tmpRootChoice({ env: "", config: "", os: "/os" })).toBe("/os");
  });

  it("names the per-user folder `alisio-<uid>`, and plain `alisio` on Windows", () => {
    expect(scratchBaseName("linux", 1000)).toBe("alisio-1000");
    expect(scratchBaseName("darwin", 501)).toBe("alisio-501");
    expect(scratchBaseName("win32", undefined)).toBe("alisio");
  });
});

describe("workspace slug", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(workspaceSlug("/home/ana/my project", "0123456789abcdef")).toBe("-home-ana-my-project");
    expect(workspaceSlug("C:\\Users\\Ana", "0123456789abcdef")).toBe("C--Users-Ana");
    expect(workspaceSlug("/ñandú", "0123456789abcdef")).toBe("--and-");
  });

  it("keeps exactly 80 characters and shortens longer ones with the workspace key", () => {
    const eighty = "a".repeat(MAX_SLUG_CHARS);
    expect(workspaceSlug(eighty, "0123456789abcdef")).toBe(eighty);
    const longer = workspaceSlug(`${eighty}b`, "0123456789abcdef");
    expect(longer).toBe(`${eighty}-01234567`);
    // Two long paths with the same prefix get different folders through their keys.
    expect(workspaceSlug(`${eighty}b`, "fedcba9876543210")).not.toBe(longer);
  });
});

describe("session id as a folder name", () => {
  it("accepts ids made of letters, digits, dot, dash and underscore, and nothing that climbs", () => {
    expect(isSafeSegment("6f1c2d3e-aaaa-bbbb-cccc-0123456789ab")).toBe(true);
    expect(isSafeSegment("ses_01J.x")).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a b", "a\0"])
      expect(isSafeSegment(bad), JSON.stringify(bad)).toBe(false);
  });
});

describe("private directory check (POSIX)", () => {
  const ok = { isDirectory: true, isSymbolicLink: false, uid: 1000, mode: 0o40700 };
  it("accepts an own directory without group or other bits", () => {
    expect(privateDirProblem(ok, 1000)).toBeUndefined();
    expect(privateDirProblem({ ...ok, mode: 0o40500 }, 1000)).toBeUndefined();
  });

  it("names the problem for a symlink, a file, another owner and wide permissions", () => {
    expect(privateDirProblem({ ...ok, isSymbolicLink: true }, 1000)).toMatch(/symlink/);
    expect(privateDirProblem({ ...ok, isDirectory: false }, 1000)).toMatch(/not a directory/);
    expect(privateDirProblem({ ...ok, uid: 0 }, 1000)).toMatch(/owner/);
    expect(privateDirProblem({ ...ok, mode: 0o40750 }, 1000)).toMatch(/group or other/);
    expect(privateDirProblem({ ...ok, mode: 0o40701 }, 1000)).toMatch(/group or other/);
    expect(privateDirProblem({ ...ok, mode: 0o40770 }, 1000)).toMatch(/group or other/);
  });
});

describe("path confinement", () => {
  const base = resolve("/scratch/pad");

  it("resolves relative and absolute paths that stay inside", () => {
    expect(resolveWithin(base, "a.js")).toBe(join(base, "a.js"));
    expect(resolveWithin(base, "sub/../a.js")).toBe(join(base, "a.js"));
    expect(resolveWithin(base, join(base, "sub", "b.py"))).toBe(join(base, "sub", "b.py"));
  });

  it("rejects `..`, absolute escapes, the root itself, empty input and null bytes as INVALID_INPUT", () => {
    expect(codeOf(() => resolveWithin(base, "../x"))).toBe("INVALID_INPUT");
    expect(codeOf(() => resolveWithin(base, "sub/../../x"))).toBe("INVALID_INPUT");
    expect(codeOf(() => resolveWithin(base, resolve("/etc/passwd")))).toBe("INVALID_INPUT");
    // A sibling whose name starts with the base's name is outside.
    expect(codeOf(() => resolveWithin(base, `${base}-evil/x`))).toBe("INVALID_INPUT");
    expect(codeOf(() => resolveWithin(base, "."))).toBe("INVALID_INPUT");
    // The parent folder itself.
    expect(codeOf(() => resolveWithin(base, ".."))).toBe("INVALID_INPUT");
    expect(codeOf(() => resolveWithin(base, ""))).toBe("INVALID_INPUT");
    expect(codeOf(() => resolveWithin(base, "a\0b"))).toBe("INVALID_INPUT");
  });
});
