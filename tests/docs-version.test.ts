import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ALISIO_VERSION,
  substituteTokens,
  substituteVersion,
  VERSION_TOKEN,
} from "../docs/.vitepress/version.ts";

const CLI_VERSION = (
  JSON.parse(readFileSync(resolve("packages/cli/package.json"), "utf8")) as {
    version: string;
  }
).version;

/** A stale `0.1.0-alpha.1` in a status line or heading; SDK example ranges are allowed. */
const STALE_STATUS = /0\.1\.0-alpha\.1\b/;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name.startsWith(".") ? [] : markdownFiles(full);
    return entry.name.endsWith(".md") ? [full] : [];
  });
}

describe("docs version helper", () => {
  it("resolves the real CLI version from packages/cli/package.json", () => {
    expect(ALISIO_VERSION).toBe(CLI_VERSION);
    expect(ALISIO_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("substitutes the token in plain text", () => {
    expect(substituteVersion(`Alisio ${VERSION_TOKEN} is alpha`, "1.2.3")).toBe(
      "Alisio 1.2.3 is alpha",
    );
    expect(substituteVersion(`Alisio ${VERSION_TOKEN} is alpha`)).toBe(
      `Alisio ${ALISIO_VERSION} is alpha`,
    );
  });

  it("substitutes the token in the raw content of inline, fenced and code-block tokens", () => {
    const tokens = [
      { type: "inline" as const, content: `Alisio ${VERSION_TOKEN} is a functional alpha.` },
      { type: "fence" as const, content: `"@alisio/sdk": "^${VERSION_TOKEN}"` },
      { type: "code_block" as const, content: `echo ${VERSION_TOKEN}` },
      { type: "paragraph_open" as const, content: "untouched" },
    ];
    substituteTokens(tokens);
    expect(tokens[0]?.content).toBe(`Alisio ${ALISIO_VERSION} is a functional alpha.`);
    expect(tokens[1]?.content).toBe(`"@alisio/sdk": "^${ALISIO_VERSION}"`);
    expect(tokens[2]?.content).toBe(`echo ${ALISIO_VERSION}`);
    expect(tokens[3]?.content).toBe("untouched");
  });

  it("keeps tokens without a version untouched", () => {
    const tokens = [
      { type: "inline" as const, content: "plain" },
      { type: "fence" as const, content: "code" },
    ];
    expect(substituteTokens(tokens)).toBe(tokens);
    expect(tokens[0]?.content).toBe("plain");
    expect(tokens[1]?.content).toBe("code");
  });
});

describe("stable release wording", () => {
  it("states the 0.x policy in both publishing pages and no page calls the project alpha", () => {
    expect(readFileSync("docs/publishing.md", "utf8")).toContain("## Stability and versioning");
    expect(readFileSync("docs/es/publishing.md", "utf8")).toContain("## Estabilidad y versionado");
    for (const file of ["docs/index.md", "docs/es/index.md", "docs/limitations.md", "SECURITY.md"])
      expect(readFileSync(file, "utf8"), file).not.toMatch(
        /\b(is|es) (a|an|una)( functional)? \*{0,2}alpha\b/i,
      );
  });

  it("keeps plugin and example SDK ranges on the stable ^0.1.0", () => {
    for (const file of ["docs/plugins.md", "docs/es/plugins.md"])
      expect(readFileSync(file, "utf8"), file).not.toMatch(/@alisio\/sdk": "\^0\.1\.0-alpha/);
    for (const name of ["custom-mascot", "custom-websearch"]) {
      const manifest = JSON.parse(
        readFileSync(join("examples", "plugins", name, "package.json"), "utf8"),
      ) as { peerDependencies: Record<string, string>; devDependencies: Record<string, string> };
      expect(manifest.peerDependencies["@alisio/sdk"], name).toBe("^0.1.0");
      expect(manifest.devDependencies["@alisio/sdk"], name).toBe("^0.1.0");
    }
  });
});

describe("no stale hardcoded versions in docs", () => {
  const files = [resolve("README.md"), ...markdownFiles(resolve("docs"))];

  it("status lines and headings use the version token, never a literal 0.1.0-alpha.1", () => {
    for (const file of files) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      for (const line of lines) {
        if (!STALE_STATUS.test(line)) continue;
        // Intentional: SDK dependency examples in the plugins guides show a concrete range.
        const sdkExample =
          line.includes("@alisio/sdk") &&
          (file.endsWith("docs/plugins.md") || file.endsWith("docs/es/plugins.md"));
        expect(sdkExample, `${file}: ${line}`).toBe(true);
      }
    }
  });

  it("uses the version token in the status pages", () => {
    for (const file of [
      "docs/limitations.md",
      "docs/index.md",
      "docs/es/index.md",
      "docs/implementation-status.md",
    ]) {
      expect(readFileSync(file, "utf8"), file).toContain(VERSION_TOKEN);
    }
  });

  it("README status omits a literal version and points at the npm badge", () => {
    const readme = readFileSync("README.md", "utf8");
    expect(readme).not.toMatch(STALE_STATUS);
    expect(readme).toContain("https://img.shields.io/npm/v/@alisio/alisio-code");
    expect(readme).toMatch(
      /Status: Usable, tested and documented\. First stable release \(0\.1\.0\)/,
    );
    expect(readme).toMatch(/minors? .*break|0\.x semver/is);
    expect(readme).not.toMatch(/still alpha/i);
  });
});
