import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ALISIO_RUNTIME_FILES } from "../packages/core/src/analysis/python/sources.ts";

const dir = resolve("packages/core/src/analysis/python/alisio_runtime");

describe("embedded alisio_runtime", () => {
  it("matches the Python sources (regenerate with scripts/analysis-runtime-sources.ts)", () => {
    const sources = Object.fromEntries(
      readdirSync(dir)
        .filter((name) => /\.(py|js|txt)$/.test(name))
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
      ]),
    );
  });
});
