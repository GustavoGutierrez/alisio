import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALISIO_RUNTIME_FILES } from "../packages/core/src/analysis/python/sources.ts";

const dir = resolve("packages/core/src/analysis/python/alisio_runtime");

describe("embedded alisio_runtime", () => {
  it("matches the Python sources (regenerate with scripts/analysis-runtime-sources.ts)", () => {
    const sources = Object.fromEntries(
      readdirSync(dir)
        .filter((name) => /\.(py|js|txt|css)$/.test(name))
        .map((name) => [name, readFileSync(join(dir, name), "utf8")]),
    );
    expect(ALISIO_RUNTIME_FILES).toEqual(sources);
    expect(Object.keys(sources)).toEqual(
      expect.arrayContaining([
        "__init__.py",
        "outputs.py",
        "html.py",
        "svg.py",
        "datasets.py",
        "charts.py",
        "chart.umd.min.js",
        "charts.css",
        "charts-boot.js",
        "html-base.css",
      ]),
    );
  });

  it("ships the dashboard assets as files, not as Python constants", () => {
    expect(ALISIO_RUNTIME_FILES["charts-boot.js"]).toContain("figure[data-ac-chart]");
    expect(ALISIO_RUNTIME_FILES["charts.css"]).toContain("--ac-c1");
    expect(ALISIO_RUNTIME_FILES["html-base.css"]).toContain("font-family");
    const charts = ALISIO_RUNTIME_FILES["charts.py"] as string;
    expect(charts).toContain('_asset("charts.css")');
    expect(charts).toContain('_asset("charts-boot.js")');
    expect(charts).not.toContain("function build(fig)");
    expect(ALISIO_RUNTIME_FILES["html.py"]).toContain('_asset("html-base.css")');
  });
});
