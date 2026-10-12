import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { PYODIDE_RUNNER_SOURCE } from "../packages/core/src/forge/python/pyodide-runner-source.ts";

describe("embedded Pyodide runner", () => {
  it("matches pyodide-runner.mjs (regenerate with scripts/pyodide-runner-source.ts)", () => {
    const file = resolve("packages/core/src/forge/python/pyodide-runner.mjs");
    expect(PYODIDE_RUNNER_SOURCE).toBe(readFileSync(file, "utf8"));
  });

  it("applies the shims before it loads Pyodide (D-32)", () => {
    const at = (needle: string) => PYODIDE_RUNNER_SOURCE.indexOf(needle);
    const load = at("loadPyodide({");
    expect(load).toBeGreaterThan(0);
    for (const shim of ['"fetch"', "process.binding = ", '"_kill"']) {
      expect(at(shim)).toBeGreaterThan(0);
      expect(at(shim)).toBeLessThan(load);
    }
  });
});
