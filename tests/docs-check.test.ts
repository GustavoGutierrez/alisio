import { describe, expect, it } from "vitest";
import { anchorKey, countLevels, parseMarkdown, slugify } from "../scripts/docs-check.ts";

describe("docs-check slugify", () => {
  it("matches VitePress slugs for headings with spaces and punctuation", () => {
    expect(slugify("Terminal UI")).toBe("terminal-ui");
    expect(slugify("Settings menu (`/settings`)")).toBe("settings-menu-settings");
    expect(slugify("Paste: text and images")).toBe("paste-text-and-images");
    expect(slugify("Turn limit")).toBe("turn-limit");
  });

  it("strips accents the way VitePress does, so `Ruta rápida` is `ruta-rapida`", () => {
    expect(slugify("Ruta rápida")).toBe("ruta-rapida");
    expect(slugify("Disposición")).toBe("disposicion");
  });

  it("prefixes a leading digit and trims separators (matches VitePress output)", () => {
    // Built site: docs/.vitepress/dist/quick-start.html has id="_1-create-a-configuration-file".
    expect(slugify("1. Create a configuration file")).toBe("_1-create-a-configuration-file");
    expect(slugify("  spaced  ")).toBe("spaced");
  });
});

describe("docs-check anchorKey", () => {
  it("is exact (not accent-insensitive) so a broken accented anchor is not hidden", () => {
    expect(anchorKey("ruta-rápida")).not.toBe(anchorKey("ruta-rapida"));
  });

  it("normalizes percent-encoding and case", () => {
    expect(anchorKey("Ask%20user")).toBe("ask user");
    expect(anchorKey("MCP")).toBe("mcp");
  });
});

describe("docs-check parseMarkdown", () => {
  const page = parseMarkdown(
    "docs/sample.md",
    [
      "# Title",
      "",
      "Text with [a link](/tools#mcp) and ![shot](/assets/x.png).",
      "",
      "```md",
      "# Not a heading",
      "[not a link](/nope)",
      "```",
      "",
      "## Child {#child-sessions}",
      "",
      "### Auto slug",
      "",
    ].join("\n"),
  );

  it("collects headings, honouring explicit {#id} and the auto slug", () => {
    expect(page.headings).toEqual([
      { level: 1, id: "title" },
      { level: 2, id: "child-sessions" },
      { level: 3, id: "auto-slug" },
    ]);
  });

  it("ignores headings, links and images inside fenced code", () => {
    expect(page.links).toEqual([
      { raw: "/tools#mcp", line: 3, image: false },
      { raw: "/assets/x.png", line: 3, image: true },
    ]);
  });

  it("counts fenced blocks and reports heading levels for parity", () => {
    expect(page.fences).toBe(1);
    expect(countLevels(page)).toBe("h1=1 h2=1 h3=1");
  });
});
